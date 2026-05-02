import type { App } from "obsidian";
import { STATE_PATHS } from "./paths";

const KNOWN_HOSTS_PATH = `${STATE_PATHS.dir}/known-hosts.json`;

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
  private hosts: Record<string, KnownHostEntry> = {};

  constructor(private app: App) {}

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if ((await adapter.exists(KNOWN_HOSTS_PATH)) === false) {
      this.hosts = {};
      return;
    }
    try {
      const raw = await adapter.read(KNOWN_HOSTS_PATH);
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
    if ((await adapter.exists(STATE_PATHS.dir)) === false) {
      await adapter.mkdir(STATE_PATHS.dir);
    }
    const file: KnownHostsFile = { schemaVersion: 1, hosts: this.hosts };
    await adapter.write(KNOWN_HOSTS_PATH, JSON.stringify(file, null, 2));
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
