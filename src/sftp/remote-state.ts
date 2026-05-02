import type { SftpClient } from "./client";

const SYNC_DIR_NAME = ".sync";
const MANIFEST_NAME = "manifest.json";
const LOCK_NAME = "lock.json";

const STALE_LOCK_MS = 5 * 60 * 1000;     // 5 minutes
const RACE_VERIFY_MS = 500;              // re-read after writing lock to detect contention

export interface ManifestEntry {
  mtime: number;
  size: number;
  sha1: string;
}

export interface RemoteManifest {
  schemaVersion: 1;
  generation: number;
  lastWriter: string;       // deviceId
  lastWriterLabel: string;  // human-readable
  updatedAt: number;
  entries: Record<string, ManifestEntry>;
}

export interface SyncLock {
  deviceId: string;
  deviceLabel: string;
  acquiredAt: number;
  pid?: number;
}

export const EMPTY_MANIFEST: RemoteManifest = {
  schemaVersion: 1,
  generation: 0,
  lastWriter: "",
  lastWriterLabel: "",
  updatedAt: 0,
  entries: {},
};

/** Helper: build paths inside .sync/ on the remote. */
function syncPaths(remoteRoot: string) {
  const root = remoteRoot.replace(/\/+$/, "");
  return {
    syncDir: `${root}/${SYNC_DIR_NAME}`,
    manifest: `${root}/${SYNC_DIR_NAME}/${MANIFEST_NAME}`,
    lock: `${root}/${SYNC_DIR_NAME}/${LOCK_NAME}`,
  };
}

export class RemoteState {
  constructor(
    private sftp: SftpClient,
    private remoteRoot: string,
    private deviceId: string,
    private deviceLabel: string,
  ) {}

  /** Make sure the remoteRoot/.sync/ directory exists. */
  async ensureSyncDir(): Promise<void> {
    const { syncDir } = syncPaths(this.remoteRoot);
    const ex = await this.sftp.raw.exists(syncDir);
    if (ex === false) {
      await this.sftp.raw.mkdir(syncDir, true);
    } else if (ex !== "d") {
      throw new Error(`Remote ${syncDir} exists but is not a directory`);
    }
  }

  // ─── Manifest ───────────────────────────────────────────────────────────

  async readManifest(): Promise<RemoteManifest> {
    const { manifest } = syncPaths(this.remoteRoot);
    const ex = await this.sftp.raw.exists(manifest);
    if (ex === false) return { ...EMPTY_MANIFEST };
    try {
      const buf = (await this.sftp.raw.get(manifest)) as Buffer;
      const parsed = JSON.parse(buf.toString("utf8")) as RemoteManifest;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported manifest schema");
      return parsed;
    } catch (err) {
      throw new Error(`Cannot read remote manifest at ${manifest}: ${(err as Error).message}`);
    }
  }

  /** Write a new manifest atomically (tmp + rename). Caller is responsible for bumping generation. */
  async writeManifest(m: RemoteManifest): Promise<void> {
    await this.ensureSyncDir();
    const { manifest } = syncPaths(this.remoteRoot);
    const tmp = `${manifest}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const json = JSON.stringify(m);
    const buf = Buffer.from(json, "utf8");
    await this.sftp.raw.put(buf, tmp);
    // ssh2-sftp-client's posixRename is atomic when both paths are on the same filesystem.
    // Fallback to delete+rename if posixRename isn't supported.
    try {
      await this.sftp.raw.posixRename(tmp, manifest);
    } catch {
      if (await this.sftp.raw.exists(manifest)) {
        await this.sftp.raw.delete(manifest);
      }
      await this.sftp.raw.rename(tmp, manifest);
    }
  }

  // ─── Lock ───────────────────────────────────────────────────────────────

  async readLock(): Promise<SyncLock | null> {
    const { lock } = syncPaths(this.remoteRoot);
    if ((await this.sftp.raw.exists(lock)) === false) return null;
    try {
      const buf = (await this.sftp.raw.get(lock)) as Buffer;
      return JSON.parse(buf.toString("utf8")) as SyncLock;
    } catch {
      return null;
    }
  }

  /**
   * Try to acquire the sync lock.
   * Returns the lock we wrote on success; null on contention.
   * Stale locks (older than STALE_LOCK_MS) are forcibly broken.
   */
  async acquireLock(): Promise<SyncLock | null> {
    await this.ensureSyncDir();
    const { lock: lockPath } = syncPaths(this.remoteRoot);

    const existing = await this.readLock();
    if (existing) {
      const age = Date.now() - existing.acquiredAt;
      const isOurs = existing.deviceId === this.deviceId;
      const isStale = age >= STALE_LOCK_MS;

      if (!isOurs && !isStale) {
        // Active lock held by another device.
        return null;
      }
      if (isStale && !isOurs) {
        console.warn(
          `Vault Bridge: breaking stale lock from "${existing.deviceLabel}" (age ${Math.round(age / 1000)}s)`,
        );
      }
      // Either ours (re-entry) or stale — fall through to overwrite.
    }

    const our: SyncLock = {
      deviceId: this.deviceId,
      deviceLabel: this.deviceLabel,
      acquiredAt: Date.now(),
      pid: typeof process !== "undefined" ? process.pid : undefined,
    };
    await this.sftp.raw.put(Buffer.from(JSON.stringify(our), "utf8"), lockPath);

    // Race verification: pause briefly then re-read to make sure no other client
    // wrote on top of us during the window.
    await new Promise((r) => activeWindow.setTimeout(r, RACE_VERIFY_MS));
    const after = await this.readLock();
    if (!after || after.deviceId !== our.deviceId || after.acquiredAt !== our.acquiredAt) {
      return null;
    }
    return our;
  }

  /** Release the lock — only if it still belongs to us. */
  async releaseLock(): Promise<void> {
    const { lock: lockPath } = syncPaths(this.remoteRoot);
    const existing = await this.readLock();
    if (!existing) return;
    if (existing.deviceId !== this.deviceId) {
      console.warn("Vault Bridge: refusing to release a lock owned by another device");
      return;
    }
    try {
      await this.sftp.raw.delete(lockPath);
    } catch (err) {
      console.warn("Vault Bridge: failed to delete lock", err);
    }
  }

  /** Convenience: run `fn` while holding the lock. Throws if the lock cannot be acquired. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const got = await this.acquireLock();
    if (!got) {
      const other = await this.readLock();
      const who = other ? `${other.deviceLabel} (${other.deviceId.slice(0, 6)})` : "another device";
      throw new Error(`Sync lock is held by ${who}; try again later.`);
    }
    try {
      return await fn();
    } finally {
      await this.releaseLock();
    }
  }
}
