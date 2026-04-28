import type { App, DataAdapter } from "obsidian";
import { randomBytes } from "crypto";
import { STATE_PATHS } from "./paths";

interface DeviceInfo {
  id: string;
  label: string;
}

/**
 * Per-device identity. Lives in state/device.json so it is NEVER synced —
 * each machine must have its own id even when the rest of data.json is shared.
 */
export class DeviceStore {
  private adapter: DataAdapter;
  private info: DeviceInfo = { id: "", label: "" };

  constructor(app: App) {
    this.adapter = app.vault.adapter;
  }

  get id(): string { return this.info.id; }
  get label(): string { return this.info.label; }

  async load(): Promise<void> {
    let needSave = false;
    try {
      if (await this.adapter.exists(STATE_PATHS.device)) {
        const raw = await this.adapter.read(STATE_PATHS.device);
        this.info = JSON.parse(raw);
      }
    } catch (err) {
      console.warn("Vault Bridge: failed to load device info, regenerating", err);
      this.info = { id: "", label: "" };
    }
    if (!this.info.id) {
      this.info.id = randomBytes(8).toString("hex");
      needSave = true;
    }
    if (!this.info.label) {
      this.info.label = `device-${this.info.id.slice(0, 6)}`;
      needSave = true;
    }
    if (needSave) await this.save();
  }

  async setLabel(label: string): Promise<void> {
    const trimmed = label.trim();
    this.info.label = trimmed || `device-${this.info.id.slice(0, 6)}`;
    await this.save();
  }

  private async save(): Promise<void> {
    if (!(await this.adapter.exists(STATE_PATHS.dir))) {
      await this.adapter.mkdir(STATE_PATHS.dir);
    }
    await this.adapter.write(STATE_PATHS.device, JSON.stringify(this.info, null, 2));
  }
}
