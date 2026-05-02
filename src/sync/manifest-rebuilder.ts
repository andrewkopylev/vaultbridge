import { SftpClient } from "../sftp/client";
import { RemoteState, RemoteManifest, ManifestEntry } from "../sftp/remote-state";
import { downloadToBuffer } from "../sftp/transfer";
import { sha1OfBuffer } from "./hash";
import type { ExcludeMatcher } from "./exclude";
import type { DeviceStore } from "../state/device-store";
import type { KnownHostsStore } from "../state/known-hosts-store";
import type { SftpSyncSettings } from "../settings";

export interface RebuildProgress {
  scanned: number;
  hashed: number;
  total: number | null;  // null while still discovering
  currentPath: string | null;
}

export interface RebuildResult {
  filesIndexed: number;
  totalBytes: number;
  generation: number;
  took: number;
}

/**
 * Walk the remote vault directory, download every file, compute sha1, and rewrite manifest.json.
 * Use this to recover after manual file changes on the server (the manifest gets out of sync
 * with the actual filesystem). Generation is bumped so other clients re-evaluate against truth.
 */
export async function rebuildRemoteManifest(
  settings: SftpSyncSettings,
  deviceStore: DeviceStore,
  exclude: ExcludeMatcher,
  knownHosts: KnownHostsStore,
  onProgress?: (p: RebuildProgress) => void,
): Promise<RebuildResult> {
  const t0 = Date.now();
  const client = new SftpClient(settings, knownHosts);
  await client.connect();
  try {
    await client.ensureRemoteRoot();
    const remote = new RemoteState(
      client,
      settings.remoteRoot,
      deviceStore.id,
      deviceStore.label,
    );
    await remote.ensureSyncDir();

    return await remote.withLock(async () => {
      const oldManifest = await remote.readManifest();

      // 1. Walk the remote directory tree.
      onProgress?.({ scanned: 0, hashed: 0, total: null, currentPath: null });
      const paths = await listRemoteFiles(client, settings.remoteRoot, exclude);

      // 2. Download + hash each file.
      const entries: Record<string, ManifestEntry> = {};
      let totalBytes = 0;
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        onProgress?.({ scanned: i, hashed: i, total: paths.length, currentPath: path });
        try {
          const buf = await downloadToBuffer(client, settings.remoteRoot, path);
          const sha1 = sha1OfBuffer(buf);
          entries[path] = {
            mtime: Date.now(),  // reset stamps — sha1 is what diff actually uses
            size: buf.length,
            sha1,
          };
          totalBytes += buf.length;
        } catch (err) {
          console.warn(`Vault Bridge: skipping ${path} during rebuild — ${(err as Error).message}`);
        }
      }
      onProgress?.({ scanned: paths.length, hashed: paths.length, total: paths.length, currentPath: null });

      // 3. Write the new manifest with bumped generation.
      const newManifest: RemoteManifest = {
        schemaVersion: 1,
        generation: oldManifest.generation + 1,
        lastWriter: deviceStore.id,
        lastWriterLabel: deviceStore.label,
        updatedAt: Date.now(),
        entries,
      };
      await remote.writeManifest(newManifest);

      return {
        filesIndexed: Object.keys(entries).length,
        totalBytes,
        generation: newManifest.generation,
        took: Date.now() - t0,
      };
    });
  } finally {
    await client.end();
  }
}

/** Walk the remote vault root, returning vault-relative paths of files (skipping `.sync/` and excludes). */
async function listRemoteFiles(
  client: SftpClient,
  remoteRoot: string,
  exclude: ExcludeMatcher,
): Promise<string[]> {
  const root = remoteRoot.replace(/\/+$/, "");
  const out: string[] = [];
  const stack: string[] = [""]; // relative to root, "" = root itself

  while (stack.length) {
    const rel = stack.pop()!;
    const dirAbs = rel ? `${root}/${rel}` : root;
    let listing;
    try {
      listing = await client.raw.list(dirAbs);
    } catch (err) {
      console.warn(`Vault Bridge: cannot list ${dirAbs} — ${(err as Error).message}`);
      continue;
    }
    for (const entry of listing) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      // Always skip our own metadata directory.
      if (childRel === ".sync" || childRel.startsWith(".sync/")) continue;
      if (exclude.isExcluded(childRel)) continue;
      if (entry.type === "d") {
        stack.push(childRel);
      } else if (entry.type === "-") {
        out.push(childRel);
      }
      // ignore symlinks, sockets, etc.
    }
  }
  return out;
}
