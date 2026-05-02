import type { DataAdapter } from "obsidian";
import { SftpClient } from "./client";
import { remotePathOf, parentDir } from "../sync/path-utils";

/** Cache of remote directories already known to exist within a single sync transaction.
 *  Concurrency-safe: every ancestor along a path is ensured top-down through the same
 *  in-flight promise map, so parallel uploads sharing a common prefix
 *  (e.g. many files under `.obsidian/plugins/`) cannot race on `mkdir` of that prefix. */
export class RemoteDirCache {
  private known: Set<string>;
  private inFlight: Map<string, Promise<void>>;

  constructor(remoteRoot: string) {
    this.known = new Set([remoteRoot.replace(/\/+$/, "")]);
    this.inFlight = new Map();
  }

  async ensureParentOf(client: SftpClient, remoteFilePath: string): Promise<void> {
    const parent = parentDir(remoteFilePath);
    if (!parent) return;
    await this.ensureDir(client, parent);
  }

  private async ensureDir(client: SftpClient, dir: string): Promise<void> {
    if (this.known.has(dir)) return;

    const existing = this.inFlight.get(dir);
    if (existing) {
      await existing;
      return;
    }

    const promise = this.createChain(client, dir);
    this.inFlight.set(dir, promise);
    await promise;
  }

  private async createChain(client: SftpClient, dir: string): Promise<void> {
    // First make sure the parent exists. Recursion is bounded by remoteRoot
    // (seeded into `known` in the constructor) — once we reach it, ensureDir returns.
    const grand = parentDir(dir);
    if (grand) await this.ensureDir(client, grand);

    // Parent is now guaranteed to exist; create this directory non-recursively.
    // Tolerate a benign race where the directory was created between exists() and mkdir()
    // (e.g. by a concurrent recursive mkdir on a sibling path from an earlier sync attempt,
    // or a server returning EACCES instead of EEXIST on mkdir-of-existing-dir).
    if ((await client.raw.exists(dir)) === false) {
      try {
        await client.raw.mkdir(dir, false);
      } catch (err) {
        if ((await client.raw.exists(dir)) !== "d") throw err;
      }
    }
    this.known.add(dir);
  }
}

/** Atomic remote upload of an in-memory buffer: put → posix-rename onto target. */
export async function uploadBuffer(
  client: SftpClient,
  remoteRoot: string,
  vaultPath: string,
  content: Buffer,
  dirs: RemoteDirCache,
): Promise<void> {
  const remotePath = remotePathOf(remoteRoot, vaultPath);
  await dirs.ensureParentOf(client, remotePath);

  const tmp = `${remotePath}.tmp.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  await client.raw.put(content, tmp);
  try {
    await client.raw.posixRename(tmp, remotePath);
  } catch {
    if ((await client.raw.exists(remotePath)) !== false) {
      await client.raw.delete(remotePath);
    }
    await client.raw.rename(tmp, remotePath);
  }
}

/** Read a local vault file as a Buffer. */
export async function readLocalAsBuffer(adapter: DataAdapter, vaultPath: string): Promise<Buffer> {
  const ab = await adapter.readBinary(vaultPath);
  return Buffer.from(ab);
}

/** Read a remote file as a Buffer (full content in memory). */
export async function downloadToBuffer(
  client: SftpClient,
  remoteRoot: string,
  vaultPath: string,
): Promise<Buffer> {
  const remotePath = remotePathOf(remoteRoot, vaultPath);
  const buf = (await client.raw.get(remotePath)) as Buffer;
  return buf;
}

/** Write a Buffer into the vault at `vaultPath`, atomically via the given tmp directory.
 *  The caller (engine) provides `tmpDir` because it owns the path layout. */
export async function writeBufferToVault(
  adapter: DataAdapter,
  vaultPath: string,
  buf: Buffer,
  tmpDir: string,
): Promise<void> {
  const parent = parentDir(vaultPath);
  if (parent && (await adapter.exists(parent)) === false) {
    await adapter.mkdir(parent);
  }
  if ((await adapter.exists(tmpDir)) === false) {
    await adapter.mkdir(tmpDir);
  }
  const tmp = `${tmpDir}/dl.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  await adapter.writeBinary(tmp, ab);
  try {
    if ((await adapter.exists(vaultPath)) === true) {
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

/** Delete a file on the remote. No-op if it doesn't exist. */
export async function deleteRemoteFile(
  client: SftpClient,
  remoteRoot: string,
  vaultPath: string,
): Promise<void> {
  const remotePath = remotePathOf(remoteRoot, vaultPath);
  if ((await client.raw.exists(remotePath)) !== false) {
    await client.raw.delete(remotePath);
  }
}

/** Delete a file inside the vault. No-op if it doesn't exist. */
export async function deleteLocalFile(
  adapter: DataAdapter,
  vaultPath: string,
): Promise<void> {
  if ((await adapter.exists(vaultPath)) === true) {
    await adapter.remove(vaultPath);
  }
}
