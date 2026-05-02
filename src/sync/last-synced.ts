import type { App, DataAdapter } from "obsidian";
import { pluginPaths, PluginPaths } from "../state/paths";
import type { ManifestEntry } from "../sftp/remote-state";

/** Snapshot S — what the world looked like at the end of the last successful sync. */
export interface LastSyncedSnapshot {
  schemaVersion: 1;
  generation: number;
  syncedAt: number;
  entries: Record<string, ManifestEntry>;
}

const EMPTY: LastSyncedSnapshot = {
  schemaVersion: 1,
  generation: 0,
  syncedAt: 0,
  entries: {},
};

export class LastSyncedStore {
  private adapter: DataAdapter;
  private paths: PluginPaths;
  private data: LastSyncedSnapshot = structuredClone(EMPTY);

  constructor(app: App) {
    this.adapter = app.vault.adapter;
    this.paths = pluginPaths(app.vault.configDir);
  }

  get snapshot(): LastSyncedSnapshot {
    return this.data;
  }

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.paths.lastSynced))) {
        this.data = structuredClone(EMPTY);
        return;
      }
      const raw = await this.adapter.read(this.paths.lastSynced);
      const parsed = JSON.parse(raw) as LastSyncedSnapshot;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported schema");
      this.data = parsed;
    } catch (err) {
      console.warn("Vault Bridge: cannot read last-synced snapshot, starting fresh", err);
      this.data = structuredClone(EMPTY);
    }
  }

  async save(snapshot: LastSyncedSnapshot): Promise<void> {
    this.data = snapshot;
    if (!(await this.adapter.exists(this.paths.stateDir))) {
      await this.adapter.mkdir(this.paths.stateDir);
    }
    await this.adapter.write(this.paths.lastSynced, JSON.stringify(this.data));
  }
}
