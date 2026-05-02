import type { App, DataAdapter } from "obsidian";
import { randomBytes } from "crypto";
import { pluginPaths, PluginPaths } from "./paths";

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
  private paths: PluginPaths;
  private info: DeviceInfo = { id: "", label: "" };

  constructor(app: App) {
    this.adapter = app.vault.adapter;
    this.paths = pluginPaths(app.vault.configDir);
  }

  get id(): string { return this.info.id; }
  get label(): string { return this.info.label; }

  async load(): Promise<void> {
    let needSave = false;
    try {
      if (await this.adapter.exists(this.paths.device)) {
        const raw = await this.adapter.read(this.paths.device);
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const obj = parsed as Partial<DeviceInfo>;
          this.info = {
            id: typeof obj.id === "string" ? obj.id : "",
            label: typeof obj.label === "string" ? obj.label : "",
          };
        }
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
    if (!(await this.adapter.exists(this.paths.stateDir))) {
      await this.adapter.mkdir(this.paths.stateDir);
    }
    await this.adapter.write(this.paths.device, JSON.stringify(this.info, null, 2));
  }
}
