import type { App } from "obsidian";
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { pluginPaths, PluginPaths } from "./paths";

const ENC_PREFIX = "enc:v1:";
const KEY_BYTES = 32;   // AES-256
const IV_BYTES = 12;    // 96-bit IV recommended for GCM

/**
 * Per-device secret used to encrypt sensitive fields in data.json
 * (password, passphrase). The key file lives under state/, which is
 * never synced — so a leaked data.json on the SFTP server cannot be
 * decrypted without local filesystem access to the original device.
 *
 * This is defense-in-depth, not protection against malware running
 * locally with the user's privileges.
 */
export class SecretStore {
  private paths: PluginPaths;
  private secretPath: string;
  private key: Buffer | null = null;

  constructor(private app: App) {
    this.paths = pluginPaths(app.vault.configDir);
    this.secretPath = `${this.paths.stateDir}/secret.key`;
  }

  async load(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if ((await adapter.exists(this.secretPath)) === true) {
      const ab = await adapter.readBinary(this.secretPath);
      const buf = Buffer.from(ab);
      if (buf.length !== KEY_BYTES) {
        throw new Error(`Vault Bridge: ${this.secretPath} has unexpected length ${buf.length}`);
      }
      this.key = buf;
      return;
    }

    if ((await adapter.exists(this.paths.stateDir)) === false) {
      await adapter.mkdir(this.paths.stateDir);
    }
    const fresh = randomBytes(KEY_BYTES);
    const ab = fresh.buffer.slice(fresh.byteOffset, fresh.byteOffset + fresh.byteLength);
    await adapter.writeBinary(this.secretPath, ab);
    this.key = fresh;
  }

  isEncrypted(blob: string): boolean {
    return typeof blob === "string" && blob.startsWith(ENC_PREFIX);
  }

  encrypt(plaintext: string): string {
    if (!plaintext) return "";
    if (!this.key) throw new Error("SecretStore not loaded");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
  }

  /** Decrypt a blob produced by `encrypt`. Throws on malformed input or wrong key. */
  decrypt(blob: string): string {
    if (!blob) return "";
    if (!this.isEncrypted(blob)) return blob;  // legacy plaintext — return as-is
    if (!this.key) throw new Error("SecretStore not loaded");
    const parts = blob.slice(ENC_PREFIX.length).split(":");
    if (parts.length !== 3) throw new Error("malformed encrypted blob");
    const iv = Buffer.from(parts[0], "base64");
    const ct = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}
