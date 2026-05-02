import type { App, DataAdapter } from "obsidian";
import { SftpClient } from "../sftp/client";
import { RemoteState } from "../sftp/remote-state";
import { remotePathOf, parentDir } from "./path-utils";
import { runWithLimit } from "./concurrency";
import type { IndexStore } from "./index-store";
import type { LastSyncedStore } from "./last-synced";
import type { Scanner } from "./scanner";
import type { ExcludeMatcher } from "./exclude";
import type { DeviceStore } from "../state/device-store";
import type { KnownHostsStore } from "../state/known-hosts-store";
import type { SftpSyncSettings } from "../settings";
import { pluginPaths, PluginPaths } from "../state/paths";

export interface PullProgress {
  processed: number;     // files considered so far (downloaded + skipped)
  downloaded: number;    // files actually transferred
  skipped: number;       // already-correct local files
  total: number;         // total entries in remote manifest (after exclude filter)
  currentFile: string | null;
  bytesDownloaded: number;
}

export type PullProgressFn = (p: PullProgress) => void;

export interface PullOptions {
  /** Re-download every file even if local sha1 matches. Used after local-index corruption. */
  forceDownload?: boolean;
  onProgress?: PullProgressFn;
}

export interface PullResult {
  downloaded: number;
  skipped: number;
  totalBytes: number;
  generation: number;
  took: number;
}

/**
 * Phase 5: pull-only — apply the remote manifest to the local vault.
 * Conservative semantics: ADDs and UPDATEs only. Local-only files are NOT deleted.
 * Wholesale reconciliation including deletes is the job of Phase 6 bidirectional sync.
 */
export class PullEngine {
  private paths: PluginPaths;

  constructor(
    private app: App,
    private settings: SftpSyncSettings,
    private deviceStore: DeviceStore,
    private index: IndexStore,
    private scanner: Scanner,
    private exclude: ExcludeMatcher,
    private lastSynced: LastSyncedStore,
    private knownHosts: KnownHostsStore,
  ) {
    this.paths = pluginPaths(app.vault.configDir);
  }

  async pullAll(opts: PullOptions = {}): Promise<PullResult> {
    const t0 = Date.now();
    const adapter: DataAdapter = this.app.vault.adapter;
    const onProgress = opts.onProgress;
    const force = opts.forceDownload === true;

    // Refresh local index so our diff is accurate.
    await this.scanner.fullScan();

    const client = new SftpClient(this.settings, this.knownHosts);
    await client.connect();
    try {
      await client.ensureRemoteRoot();
      const remote = new RemoteState(
        client,
        this.settings.remoteRoot,
        this.deviceStore.id,
        this.deviceStore.label,
      );
      await remote.ensureSyncDir();

      return await remote.withLock(async () => {
        const manifest = await remote.readManifest();
        if (manifest.generation === 0) {
          throw new Error("Remote has no manifest yet — push from another device first.");
        }

        // Decide what needs downloading. sha1 mismatch (or absence locally) → download.
        // Excluded paths are skipped (e.g. our own state/ if it somehow appeared there).
        const toDownload: Array<[string, { mtime: number; size: number; sha1: string }]> = [];
        let alreadyOk = 0;
        let totalConsidered = 0;

        for (const [path, mEntry] of Object.entries(manifest.entries)) {
          if (this.exclude.isExcluded(path)) continue;
          totalConsidered++;
          const local = this.index.get(path);
          if (!force && local && local.sha1 === mEntry.sha1) {
            alreadyOk++;
            continue;
          }
          toDownload.push([path, mEntry]);
        }

        // Initial progress tick — already shows skipped count.
        onProgress?.({
          processed: alreadyOk,
          downloaded: 0,
          skipped: alreadyOk,
          total: totalConsidered,
          currentFile: null,
          bytesDownloaded: 0,
        });

        let downloaded = 0;
        let totalBytes = 0;
        await this.ensureLocalDir(adapter, this.paths.tmp);

        // Parallel pool of downloads on the same SFTP session.
        // ssh2 multiplexes RPC requests over the channel; this hides RTT
        // for many small files. Order of completion is not preserved.
        await runWithLimit(toDownload, this.settings.concurrency, async ([path, mEntry]) => {
          onProgress?.({
            processed: alreadyOk + downloaded,
            downloaded,
            skipped: alreadyOk,
            total: totalConsidered,
            currentFile: path,
            bytesDownloaded: totalBytes,
          });

          await this.downloadOne(client, adapter, path);
          // Refresh the index entry so any late-firing vault event becomes a no-op.
          await this.scanner.refreshOne(path);
          downloaded++;
          totalBytes += mEntry.size;
        });

        // Final progress tick.
        onProgress?.({
          processed: alreadyOk + downloaded,
          downloaded,
          skipped: alreadyOk,
          total: totalConsidered,
          currentFile: null,
          bytesDownloaded: totalBytes,
        });

        // Snapshot S now reflects what we just pulled — generation matches the manifest's.
        await this.lastSynced.save({
          schemaVersion: 1,
          generation: manifest.generation,
          syncedAt: Date.now(),
          entries: { ...manifest.entries },
        });

        return {
          downloaded,
          skipped: alreadyOk,
          totalBytes,
          generation: manifest.generation,
          took: Date.now() - t0,
        };
      });
    } finally {
      await client.end();
    }
  }

  private async downloadOne(
    client: SftpClient,
    adapter: DataAdapter,
    vaultPath: string,
  ): Promise<void> {
    const remotePath = remotePathOf(this.settings.remoteRoot, vaultPath);

    // Get full file content. ssh2-sftp-client.get returns a Buffer when no stream destination is given.
    let buf: Buffer;
    try {
      buf = (await client.raw.get(remotePath)) as Buffer;
    } catch (err) {
      throw new Error(`Cannot fetch remote ${remotePath}: ${(err as Error).message}`);
    }

    // Make sure local parent dirs exist (vault-relative).
    const parent = parentDir(vaultPath);
    if (parent) await this.ensureLocalDir(adapter, parent);

    // Download to a tmp staging file in our state/tmp/, then rename in place.
    // This avoids leaving a corrupted file at the target if writeBinary is interrupted.
    const tmp = `${this.paths.tmp}/dl.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    // adapter.writeBinary expects ArrayBuffer; Buffer.buffer + slice gives a fresh ArrayBuffer copy.
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    await adapter.writeBinary(tmp, ab);
    try {
      if ((await adapter.exists(vaultPath)) === true) {
        // adapter.rename may not overwrite on Windows — be explicit.
        await adapter.remove(vaultPath);
      }
      await adapter.rename(tmp, vaultPath);
    } catch (err) {
      // Best-effort cleanup of the staging file; never let cleanup errors mask the rename failure.
      try {
        await adapter.remove(tmp);
      } catch (_cleanupErr) { /* ignore */ }
      throw err;
    }
  }

  private async ensureLocalDir(adapter: DataAdapter, dir: string): Promise<void> {
    if ((await adapter.exists(dir)) === false) {
      await adapter.mkdir(dir);
    }
  }
}
