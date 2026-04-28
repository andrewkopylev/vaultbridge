import type { App, DataAdapter } from "obsidian";
import { STATE_PATHS } from "../state/paths";

export interface IndexEntry {
  path: string;     // vault-relative, forward slashes
  mtime: number;    // ms since epoch
  size: number;     // bytes
  sha1: string;     // content hash, lowercase hex
}

export interface Index {
  entries: Record<string, IndexEntry>;
  lastScannedAt: number;
  schemaVersion: 1;
}

const EMPTY_INDEX: Index = { entries: {}, lastScannedAt: 0, schemaVersion: 1 };

export class IndexStore {
  private data: Index = structuredClone(EMPTY_INDEX);
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private adapter: DataAdapter;

  constructor(app: App) {
    this.adapter = app.vault.adapter;
  }

  get all(): IndexEntry[] {
    return Object.values(this.data.entries);
  }

  get(path: string): IndexEntry | undefined {
    return this.data.entries[path];
  }

  /** Bulk replace (used after a full rescan). */
  replaceAll(entries: IndexEntry[]): void {
    const map: Record<string, IndexEntry> = {};
    for (const e of entries) map[e.path] = e;
    this.data.entries = map;
    this.data.lastScannedAt = Date.now();
    this.markDirty();
  }

  upsert(entry: IndexEntry): void {
    this.data.entries[entry.path] = entry;
    this.markDirty();
  }

  remove(path: string): void {
    if (path in this.data.entries) {
      delete this.data.entries[path];
      this.markDirty();
    }
  }

  rename(oldPath: string, newPath: string): void {
    const e = this.data.entries[oldPath];
    if (!e) return;
    delete this.data.entries[oldPath];
    this.data.entries[newPath] = { ...e, path: newPath };
    this.markDirty();
  }

  size(): number {
    return Object.keys(this.data.entries).length;
  }

  totalBytes(): number {
    let n = 0;
    for (const e of Object.values(this.data.entries)) n += e.size;
    return n;
  }

  lastScannedAt(): number {
    return this.data.lastScannedAt;
  }

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(STATE_PATHS.index))) {
        this.data = structuredClone(EMPTY_INDEX);
        return;
      }
      const raw = await this.adapter.read(STATE_PATHS.index);
      const parsed = JSON.parse(raw) as Index;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported schema");
      this.data = parsed;
      this.dirty = false;
    } catch (err) {
      console.warn("Vault Bridge: failed to load index, starting fresh", err);
      this.data = structuredClone(EMPTY_INDEX);
    }
  }

  /** Force-write index to disk, regardless of dirty flag. Cancels any pending debounced flush. */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.ensureStateDir();
    await this.adapter.write(STATE_PATHS.index, JSON.stringify(this.data));
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        void this.flush().catch((err) => console.error("Vault Bridge: index flush failed", err));
      }
    }, 5000);
  }

  private async ensureStateDir(): Promise<void> {
    if (!(await this.adapter.exists(STATE_PATHS.dir))) {
      await this.adapter.mkdir(STATE_PATHS.dir);
    }
  }
}
