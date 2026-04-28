import SftpClientLib from "ssh2-sftp-client";
import { readFileSync } from "fs";
import type { SftpSyncSettings } from "../settings";

export class SftpClient {
  private client: SftpClientLib;
  private connected = false;

  constructor(private settings: SftpSyncSettings) {
    this.client = new SftpClientLib();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.settings.host) throw new Error("Host is empty");
    if (!this.settings.username) throw new Error("Username is empty");
    if (!this.settings.remoteRoot) throw new Error("Remote root is empty");

    const config: Parameters<SftpClientLib["connect"]>[0] = {
      host: this.settings.host,
      port: this.settings.port || 22,
      username: this.settings.username,
      readyTimeout: 15000,
      // No host fingerprint check — by user request.
    };

    if (this.settings.authMethod === "password") {
      if (!this.settings.password) throw new Error("Password is empty");
      config.password = this.settings.password;
    } else {
      if (!this.settings.privateKeyPath) throw new Error("Private key path is empty");
      try {
        config.privateKey = readFileSync(this.settings.privateKeyPath);
      } catch (err) {
        throw new Error(`Cannot read private key at ${this.settings.privateKeyPath}: ${(err as Error).message}`);
      }
      if (this.settings.passphrase) config.passphrase = this.settings.passphrase;
    }

    await this.client.connect(config);
    this.connected = true;
  }

  async end(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.end();
    } catch {
      // ignore — we're tearing down
    }
    this.connected = false;
  }

  /** Create remote root directory if it doesn't already exist. */
  async ensureRemoteRoot(): Promise<void> {
    const root = this.settings.remoteRoot;
    const exists = await this.client.exists(root);
    if (exists === false) {
      await this.client.mkdir(root, true);
    } else if (exists !== "d") {
      throw new Error(`Remote path ${root} exists but is not a directory (type=${exists})`);
    }
  }

  /** Direct access to the underlying ssh2-sftp-client. Used by sync engine in later phases. */
  get raw(): SftpClientLib {
    return this.client;
  }
}
