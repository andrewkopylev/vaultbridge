import type { App } from "obsidian";
import { pluginPaths, PluginPaths } from "./paths";

export interface KnownHostEntry {
  fingerprint: string;   // SHA-256 of the server host key, base64
  addedAt: number;       // ms since epoch
}

interface KnownHostsFile {
  schemaVersion: 1;
  hosts: Record<string, KnownHostEntry>;   // key = "host:port"
}

/**
 * Per-device record of trusted server host-key fingerprints (TOFU).
 * Lives in state/, never synced — each device trusts hosts independently.
 * Used by SftpClient to refuse silent host-key changes that would otherwise
 * indicate a man-in-the-middle attack.
 */
export class KnownHostsStore {
  private paths: PluginPaths;
  private filePath: string;
  private hosts: Record<string, KnownHostEntry> = {};

  constructor(private app: App) {
    this.paths = pluginPaths(app.vault.configDir);
    this.filePath = `${this.paths.stateDir}/known-hosts.json`;
  }

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if ((await adapter.exists(this.filePath)) === false) {
      this.hosts = {};
      return;
    }
    try {
      const raw = await adapter.read(this.filePath);
      const parsed = JSON.parse(raw) as KnownHostsFile;
      if (parsed.schemaVersion !== 1) throw new Error("unsupported known-hosts schema");
      this.hosts = parsed.hosts ?? {};
    } catch (err) {
      console.warn("Vault Bridge: known-hosts file unreadable, starting empty", err);
      this.hosts = {};
    }
  }

  private async save(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if ((await adapter.exists(this.paths.stateDir)) === false) {
      await adapter.mkdir(this.paths.stateDir);
    }
    const file: KnownHostsFile = { schemaVersion: 1, hosts: this.hosts };
    await adapter.write(this.filePath, JSON.stringify(file, null, 2));
  }

  static keyFor(host: string, port: number): string {
    return `${host}:${port}`;
  }

  get(host: string, port: number): KnownHostEntry | undefined {
    return this.hosts[KnownHostsStore.keyFor(host, port)];
  }

  async remember(host: string, port: number, fingerprint: string): Promise<void> {
    this.hosts[KnownHostsStore.keyFor(host, port)] = { fingerprint, addedAt: Date.now() };
    await this.save();
  }

  async forget(host: string, port: number): Promise<boolean> {
    const key = KnownHostsStore.keyFor(host, port);
    if (!(key in this.hosts)) return false;
    delete this.hosts[key];
    await this.save();
    return true;
  }
}
