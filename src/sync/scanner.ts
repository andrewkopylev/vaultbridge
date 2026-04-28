import type { App, DataAdapter } from "obsidian";
import { ExcludeMatcher } from "./exclude";
import { IndexStore, IndexEntry } from "./index-store";
import { sha1OfBuffer } from "./hash";

export interface ScanProgress {
  scanned: number;
  hashed: number;
  total: number | null; // null while still discovering
}

export interface ScanOptions {
  /** If true, recompute hashes even when mtime/size match. Used by "Rebuild local index". */
  forceRehash?: boolean;
  onProgress?: (p: ScanProgress) => void;
}

export class Scanner {
  private adapter: DataAdapter;

  constructor(
    private app: App,
    private store: IndexStore,
    private exclude: ExcludeMatcher,
  ) {
    this.adapter = app.vault.adapter;
  }

  /**
   * Walk the entire vault, build a fresh index, replace the store contents.
   * Files whose (mtime,size) match the existing index keep their old hash — saves a lot of I/O on big vaults.
   */
  async fullScan(opts: ScanOptions = {}): Promise<{ entries: IndexEntry[]; took: number }> {
    const t0 = Date.now();
    const paths = await this.listAllFiles();
    const entries: IndexEntry[] = [];
    let hashed = 0;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const entry = await this.statAndMaybeHash(path, opts.forceRehash === true);
      if (entry) {
        entries.push(entry);
        if (this.didHash) hashed++;
      }
      opts.onProgress?.({ scanned: i + 1, hashed, total: paths.length });
    }

    this.store.replaceAll(entries);
    await this.store.flush();
    return { entries, took: Date.now() - t0 };
  }

  /** Update one path in the index from disk state (for vault events). */
  async refreshOne(path: string): Promise<void> {
    if (this.exclude.isExcluded(path)) return;
    if (!(await this.adapter.exists(path))) {
      this.store.remove(path);
      return;
    }
    const entry = await this.statAndMaybeHash(path, false);
    if (entry) this.store.upsert(entry);
  }

  /** Internal — set by statAndMaybeHash for progress accounting. */
  private didHash = false;

  private async statAndMaybeHash(path: string, force: boolean): Promise<IndexEntry | null> {
    this.didHash = false;
    let stat;
    try {
      stat = await this.adapter.stat(path);
    } catch {
      return null;
    }
    if (!stat || stat.type !== "file") return null;

    const existing = this.store.get(path);
    if (
      !force &&
      existing &&
      existing.mtime === stat.mtime &&
      existing.size === stat.size
    ) {
      return existing;
    }

    let hash: string;
    try {
      const buf = await this.adapter.readBinary(path);
      hash = sha1OfBuffer(buf);
      this.didHash = true;
    } catch (err) {
      console.warn(`Vault Bridge: cannot read ${path} for hashing`, err);
      return null;
    }
    return { path, mtime: stat.mtime, size: stat.size, sha1: hash };
  }

  /** Walk the vault, returning vault-relative file paths, applying excludes. */
  private async listAllFiles(): Promise<string[]> {
    const out: string[] = [];
    await this.walk("", out);
    return out;
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    let listing;
    try {
      listing = await this.adapter.list(dir);
    } catch (err) {
      console.warn(`Vault Bridge: list(${dir}) failed`, err);
      return;
    }
    for (const f of listing.files) {
      if (!this.exclude.isExcluded(f)) out.push(f);
    }
    for (const d of listing.folders) {
      if (this.exclude.isExcluded(d)) continue;
      await this.walk(d, out);
    }
  }
}
