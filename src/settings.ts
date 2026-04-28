import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type SftpSyncPlugin from "./main";

export type AuthMethod = "password" | "key";

export interface SftpSyncSettings {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password: string;
  privateKeyPath: string;
  passphrase: string;
  remoteRoot: string;

  syncEverything: boolean;       // sync .obsidian/ too (default ON, per user request)
  syncWorkspaceJson: boolean;    // sync workspace.json (default OFF — flapping risk)
  excludePatterns: string[];     // gitignore-style, user-editable

  autoSyncOnStartup: boolean;            // (a) full sync after Obsidian opens
  autoSyncOnQuit: boolean;               // (b) push on close (best-effort, with timeout)
  autoSyncOnChange: boolean;             // (c) debounced sync after vault changes
  autoSyncDebounceSeconds: number;       // debounce window for (c). Default 10.
}
// NOTE: deviceId / deviceLabel are NOT here — they live in state/device.json
// so that data.json can be safely shared across devices via sync.

// Default soft excludes — user can edit these.
// workspace.json is handled by a separate toggle, NOT listed here.
export const DEFAULT_SOFT_EXCLUDES = [
  ".trash/**",
];

export const DEFAULT_SETTINGS: SftpSyncSettings = {
  host: "",
  port: 22,
  username: "",
  authMethod: "password",
  password: "",
  privateKeyPath: "",
  passphrase: "",
  remoteRoot: "",
  syncEverything: true,
  syncWorkspaceJson: false,
  excludePatterns: [...DEFAULT_SOFT_EXCLUDES],
  autoSyncOnStartup: true,
  autoSyncOnQuit: true,
  autoSyncOnChange: true,
  autoSyncDebounceSeconds: 10,
};

export class SftpSyncSettingTab extends PluginSettingTab {
  plugin: SftpSyncPlugin;

  constructor(app: App, plugin: SftpSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Bridge SFTP" });

    // ─── Connection ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Host")
      .setDesc("SFTP server hostname or IP address.")
      .addText((t) =>
        t
          .setPlaceholder("example.com")
          .setValue(this.plugin.settings.host)
          .onChange(async (v) => {
            this.plugin.settings.host = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Default 22.")
      .addText((t) =>
        t
          .setPlaceholder("22")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.port = Number.isFinite(n) && n > 0 ? n : 22;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Username")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.username)
          .onChange(async (v) => {
            this.plugin.settings.username = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Authentication")
      .setDesc("Password or SSH private key. Host fingerprint is NOT verified by user request.")
      .addDropdown((d) =>
        d
          .addOption("password", "Password")
          .addOption("key", "Private key")
          .setValue(this.plugin.settings.authMethod)
          .onChange(async (v) => {
            this.plugin.settings.authMethod = v as AuthMethod;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.authMethod === "password") {
      new Setting(containerEl)
        .setName("Password")
        .setDesc("Stored in plain text inside data.json — be aware on shared machines.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.password).onChange(async (v) => {
            this.plugin.settings.password = v;
            await this.plugin.saveSettings();
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Private key path")
        .setDesc("Absolute filesystem path, e.g. /home/user/.ssh/id_ed25519.")
        .addText((t) =>
          t
            .setPlaceholder("/home/user/.ssh/id_ed25519")
            .setValue(this.plugin.settings.privateKeyPath)
            .onChange(async (v) => {
              this.plugin.settings.privateKeyPath = v.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Key passphrase")
        .setDesc("Empty if the key is unencrypted.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.passphrase).onChange(async (v) => {
            this.plugin.settings.passphrase = v;
            await this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Remote root")
      .setDesc("Absolute path on the server, e.g. /home/user/obsidian-vault. Created if it doesn't exist.")
      .addText((t) =>
        t
          .setPlaceholder("/home/user/obsidian-vault")
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (v) => {
            this.plugin.settings.remoteRoot = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ─── Sync scope ───────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Sync scope" });

    new Setting(containerEl)
      .setName("Sync everything (.obsidian too)")
      .setDesc("When ON, plugins/themes/snippets/hotkeys are synced so all devices look identical.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncEverything).onChange(async (v) => {
          this.plugin.settings.syncEverything = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync workspace.json")
      .setDesc("OFF by default. Workspace files describe open tabs/panels for this specific device. Turning this ON will cause flapping if you work on two devices at once.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncWorkspaceJson).onChange(async (v) => {
          this.plugin.settings.syncWorkspaceJson = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("One pattern per line. Gitignore-style. The plugin's own state/ directory is ALWAYS excluded regardless.")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        t.setValue(this.plugin.settings.excludePatterns.join("\n")).onChange(async (v) => {
          this.plugin.settings.excludePatterns = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
        });
      });

    // ─── Auto-sync triggers ───────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Auto-sync" });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a full bidirectional sync once Obsidian finishes loading.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnStartup).onChange(async (v) => {
          this.plugin.settings.autoSyncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on quit")
      .setDesc("Best-effort push when Obsidian closes (5s timeout, push-only — no prompts).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnQuit).onChange(async (v) => {
          this.plugin.settings.autoSyncOnQuit = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync after changes")
      .setDesc("Debounced sync triggered by vault edits (create / modify / delete / rename).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnChange).onChange(async (v) => {
          this.plugin.settings.autoSyncOnChange = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Debounce delay (seconds)")
      .setDesc("How long to wait after the last edit before auto-syncing. Lower = more sync traffic.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoSyncDebounceSeconds))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.autoSyncDebounceSeconds =
              Number.isFinite(n) && n >= 2 && n <= 600 ? n : 10;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Actions ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Connect, create the remote root if missing, then disconnect.")
      .addButton((b) =>
        b
          .setButtonText("Test connection")
          .setCta()
          .onClick(async () => {
            b.setDisabled(true).setButtonText("Testing…");
            try {
              await this.plugin.testConnection();
            } finally {
              b.setDisabled(false).setButtonText("Test connection");
            }
          }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Run a full sync immediately. (Available once Phase 4+ ships.)")
      .addButton((b) =>
        b.setButtonText("Sync now").onClick(() => this.plugin.syncNow()),
      );

    // ─── Device ───────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Device (local only, not synced)" });

    new Setting(containerEl)
      .setName("Device label")
      .setDesc("Used in conflict-copy filenames so you can tell which device the conflicting edit came from. Lives in state/device.json — each machine has its own.")
      .addText((t) =>
        t
          .setPlaceholder("home-desktop")
          .setValue(this.plugin.deviceStore.label)
          .onChange(async (v) => {
            await this.plugin.deviceStore.setLabel(v);
          }),
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Random per-device identifier. Read-only.")
      .addText((t) => {
        t.setValue(this.plugin.deviceStore.id);
        t.setDisabled(true);
      });
  }
}
