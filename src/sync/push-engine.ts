import type { App, DataAdapter } from "obsidian";
import { SftpClient } from "../sftp/client";
import { RemoteState, RemoteManifest, ManifestEntry } from "../sftp/remote-state";
import { remotePathOf, parentDir } from "./path-utils";
import type { IndexStore, IndexEntry } from "./index-store";
import type { LastSyncedStore } from "./last-synced";
import type { Scanner } from "./scanner";
import type { DeviceStore } from "../state/device-store";
import type { SftpSyncSettings } from "../settings";

export interface PushProgress {
  processed: number;     // files considered so far (uploaded + skipped)
  uploaded: number;      // files actually transferred
  skipped: number;       // files unchanged vs remote manifest
  total: number;
  currentFile: string | null;
  bytesUploaded: number;
}

export type PushProgressFn = (p: PushProgress) => void;

export interface PushOptions {
  /** Re-upload every file regardless of remote manifest. Use after manifest corruption. */
  forceUpload?: boolean;
  onProgress?: PushProgressFn;
}

export interface PushResult {
  uploaded: number;       // files actually transferred
  skipped: number;        // unchanged files that were not re-uploaded
  totalBytes: number;     // bytes of UPLOADED files (skipped don't count)
  generation: number;
  took: number;
}

/**
 * Phase 4: "Save All" — upload every file in the local index to the remote root.
 * Holds the remote lock for the duration. On success, writes a fresh manifest
 * with bumped generation and saves the matching local snapshot.
 */
export class PushEngine {
  constructor(
    private app: App,
    private settings: SftpSyncSettings,
    private deviceStore: DeviceStore,
    private index: IndexStore,
    private scanner: Scanner,
    private lastSynced: LastSyncedStore,
  ) {}

  async pushAll(opts: PushOptions = {}): Promise<PushResult> {
    const t0 = Date.now();
    const adapter: DataAdapter = this.app.vault.adapter;
    const onProgress = opts.onProgress;
    const force = opts.forceUpload === true;

    // Make sure the index is current. Cheap if nothing changed.
    await this.scanner.fullScan();
    const localEntries = this.index.all;

    if (localEntries.length === 0) {
      throw new Error("Local index is empty — nothing to push.");
    }

    const client = new SftpClient(this.settings);
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

      // Acquire lock; throws on contention.
      return await remote.withLock(async () => {
        const oldManifest = await remote.readManifest();
        const remoteEntries = oldManifest.entries;

        // Decide which local files actually need uploading.
        // sha1 match against the remote manifest = file is identical → skip transfer
        // but still include it in the new manifest. mtime/size are NOT used here
        // because mtime is set by the SFTP server on upload and never matches local.
        const toUpload: IndexEntry[] = [];
        const toSkip: IndexEntry[] = [];
        for (const e of localEntries) {
          const remoteEntry = remoteEntries[e.path];
          if (!force && remoteEntry && remoteEntry.sha1 === e.sha1) {
            toSkip.push(e);
          } else {
            toUpload.push(e);
          }
        }

        const newManifest: RemoteManifest = {
          schemaVersion: 1,
          generation: oldManifest.generation + 1,
          lastWriter: this.deviceStore.id,
          lastWriterLabel: this.deviceStore.label,
          updatedAt: Date.now(),
          entries: {},
        };
        // Carry over skipped entries unchanged.
        for (const e of toSkip) {
          newManifest.entries[e.path] = { mtime: e.mtime, size: e.size, sha1: e.sha1 };
        }

        const total = localEntries.length;
        let uploaded = 0;
        const skipped = toSkip.length;
        let totalBytes = 0;
        const ensuredDirs = new Set<string>();
        ensuredDirs.add(this.settings.remoteRoot.replace(/\/+$/, ""));

        // Initial progress tick — already shows skipped count.
        onProgress?.({
          processed: skipped,
          uploaded: 0,
          skipped,
          total,
          currentFile: null,
          bytesUploaded: 0,
        });

        for (const entry of toUpload) {
          onProgress?.({
            processed: skipped + uploaded,
            uploaded,
            skipped,
            total,
            currentFile: entry.path,
            bytesUploaded: totalBytes,
          });

          await this.uploadOne(client, adapter, entry, ensuredDirs);

          newManifest.entries[entry.path] = {
            mtime: entry.mtime,
            size: entry.size,
            sha1: entry.sha1,
          };
          uploaded++;
          totalBytes += entry.size;
        }

        // Final progress tick.
        onProgress?.({
          processed: skipped + uploaded,
          uploaded,
          skipped,
          total,
          currentFile: null,
          bytesUploaded: totalBytes,
        });

        // Only bump generation + rewrite manifest if anything actually changed.
        // (Saves a write and avoids spurious gen-bumps on no-op syncs.)
        const changed = uploaded > 0 || Object.keys(remoteEntries).length !== Object.keys(newManifest.entries).length;
        if (changed) {
          await remote.writeManifest(newManifest);
        } else {
          newManifest.generation = oldManifest.generation;
          newManifest.updatedAt = oldManifest.updatedAt || Date.now();
        }

        // Persist local snapshot S regardless (cheap; reflects current truth).
        await this.lastSynced.save({
          schemaVersion: 1,
          generation: newManifest.generation,
          syncedAt: newManifest.updatedAt,
          entries: { ...newManifest.entries },
        });

        return {
          uploaded,
          skipped,
          totalBytes,
          generation: newManifest.generation,
          took: Date.now() - t0,
        };
      });
    } finally {
      await client.end();
    }
  }

  private async uploadOne(
    client: SftpClient,
    adapter: DataAdapter,
    entry: IndexEntry,
    ensuredDirs: Set<string>,
  ): Promise<void> {
    const remotePath = remotePathOf(this.settings.remoteRoot, entry.path);
    await this.ensureRemoteParents(client, remotePath, ensuredDirs);

    let buf: Buffer;
    try {
      const ab = await adapter.readBinary(entry.path);
      buf = Buffer.from(ab);
    } catch (err) {
      throw new Error(`Cannot read local ${entry.path}: ${(err as Error).message}`);
    }

    const tmp = `${remotePath}.tmp.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
    await client.raw.put(buf, tmp);
    try {
      await client.raw.posixRename(tmp, remotePath);
    } catch {
      // Some servers don't support posix-rename; fall back to delete+rename.
      if ((await client.raw.exists(remotePath)) !== false) {
        await client.raw.delete(remotePath);
      }
      await client.raw.rename(tmp, remotePath);
    }
  }

  private async ensureRemoteParents(
    client: SftpClient,
    remoteFilePath: string,
    ensured: Set<string>,
  ): Promise<void> {
    const parent = parentDir(remoteFilePath);
    if (!parent || ensured.has(parent)) return;
    // Climb up until we hit a known-existing dir, then create the chain top-down via mkdir(true).
    if ((await client.raw.exists(parent)) === false) {
      await client.raw.mkdir(parent, true);
    }
    ensured.add(parent);
    // Mark parents-of-parent as ensured too — they must exist if mkdir succeeded.
    let p = parent;
    while (true) {
      const grand = parentDir(p);
      if (!grand || ensured.has(grand)) break;
      ensured.add(grand);
      p = grand;
    }
  }
}
