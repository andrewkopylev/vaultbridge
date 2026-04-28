import type { DataAdapter } from "obsidian";
import { SftpClient } from "./client";
import { remotePathOf, parentDir } from "../sync/path-utils";
import { STATE_PATHS } from "../state/paths";

/** Cache of remote directories already known to exist within a single sync transaction. */
export class RemoteDirCache {
  private known: Set<string>;

  constructor(remoteRoot: string) {
    this.known = new Set([remoteRoot.replace(/\/+$/, "")]);
  }

  async ensureParentOf(client: SftpClient, remoteFilePath: string): Promise<void> {
    const parent = parentDir(remoteFilePath);
    if (!parent || this.known.has(parent)) return;
    if ((await client.raw.exists(parent)) === false) {
      await client.raw.mkdir(parent, true);
    }
    this.known.add(parent);
    // mark ancestors as ensured too — mkdir(..., recursive) created them
    let p = parent;
    while (true) {
      const grand = parentDir(p);
      if (!grand || this.known.has(grand)) break;
      this.known.add(grand);
      p = grand;
    }
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

/** Write a Buffer into the vault at `vaultPath`, atomically via state/tmp/. */
export async function writeBufferToVault(
  adapter: DataAdapter,
  vaultPath: string,
  buf: Buffer,
): Promise<void> {
  const parent = parentDir(vaultPath);
  if (parent && (await adapter.exists(parent)) === false) {
    await adapter.mkdir(parent);
  }
  if ((await adapter.exists(STATE_PATHS.tmp)) === false) {
    await adapter.mkdir(STATE_PATHS.tmp);
  }
  const tmp = `${STATE_PATHS.tmp}/dl.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  await adapter.writeBinary(tmp, ab);
  try {
    if ((await adapter.exists(vaultPath)) === true) {
      await adapter.remove(vaultPath);
    }
    await adapter.rename(tmp, vaultPath);
  } catch (err) {
    try { await adapter.remove(tmp); } catch {}
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
