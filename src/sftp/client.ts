import SftpClientLib from "ssh2-sftp-client";
import { readFileSync } from "fs";
import type { SftpSyncSettings } from "../settings";
import type { KnownHostsStore } from "../state/known-hosts-store";

export class SftpClient {
  private client: SftpClientLib;
  private connected = false;

  constructor(
    private settings: SftpSyncSettings,
    private knownHosts?: KnownHostsStore,
  ) {
    this.client = new SftpClientLib();
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (!this.settings.host) throw new Error("Host is empty");
    if (!this.settings.username) throw new Error("Username is empty");
    if (!this.settings.remoteRoot) throw new Error("Remote root is empty");

    const host = this.settings.host;
    const port = this.settings.port || 22;

    // Capture host-key state from the verifier callback so we can act on it
    // after `client.connect()` resolves or throws.
    let mismatch: { stored: string; observed: string } | undefined;
    let newlyTrusted: string | undefined;

    const config: Parameters<SftpClientLib["connect"]>[0] = {
      host,
      port,
      username: this.settings.username,
      readyTimeout: 15000,
      // Receive the host key already hashed as a hex SHA-256 string.
      hostHash: "sha256",
      hostVerifier: (hashedKey: string | Buffer, callback?: (valid: boolean) => void): boolean | void => {
        const fp = typeof hashedKey === "string" ? hashedKey : Buffer.from(hashedKey).toString("hex");
        const known = this.knownHosts?.get(host, port);
        let ok: boolean;
        if (!this.knownHosts) {
          ok = true; // verification disabled (no store wired)
        } else if (!known) {
          newlyTrusted = fp;
          ok = true;  // TOFU: accept on first contact, remember after connect succeeds
        } else if (known.fingerprint === fp) {
          ok = true;
        } else {
          mismatch = { stored: known.fingerprint, observed: fp };
          ok = false;
        }
        if (callback) callback(ok);
        return ok;
      },
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

    try {
      await this.client.connect(config);
    } catch (err) {
      if (mismatch) {
        throw new Error(
          `Host fingerprint MISMATCH for ${host}:${port}.\n` +
          `Stored:   sha256:${mismatch.stored}\n` +
          `Observed: sha256:${mismatch.observed}\n` +
          `If this change is expected (e.g. server reinstall), run "Forget remembered host fingerprint" and reconnect.`,
        );
      }
      throw err;
    }

    if (newlyTrusted && this.knownHosts) {
      try {
        await this.knownHosts.remember(host, port, newlyTrusted);
      } catch (err) {
        console.warn("Vault Bridge: failed to persist host fingerprint", err);
      }
    }
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
