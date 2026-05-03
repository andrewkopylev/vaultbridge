import { App, PluginSettingTab, Setting } from "obsidian";
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

  concurrency: number;                   // parallel transfers per sync (1-20). Default 8.
}
// NOTE: deviceId / deviceLabel are NOT here — they live in state/device.json
// so that data.json can be safely shared across devices via sync.

// Default soft excludes — user can edit these.
// workspace.json is handled by a separate toggle, NOT listed here.
export const DEFAULT_SOFT_EXCLUDES = [
  ".trash/**",
];

/**
 * True when the user has filled enough settings to even attempt an SFTP connection.
 * Used to gate auto-sync triggers — opening Obsidian with a fresh install must not
 * try to connect and surface a "Host is empty" error.
 */
export function isConnectionConfigured(s: SftpSyncSettings): boolean {
  if (!s.host || !s.username || !s.remoteRoot) return false;
  if (s.authMethod === "password") return s.password.length > 0;
  return s.privateKeyPath.length > 0;
}

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
  concurrency: 8,
};

export const MAX_CONCURRENCY = 20;
export const MIN_CONCURRENCY = 1;

export class SftpSyncSettingTab extends PluginSettingTab {
  plugin: SftpSyncPlugin;

  constructor(app: App, plugin: SftpSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ─── Connection ───────────────────────────────────────────────────────
    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Host")
      .setDesc("SFTP server hostname or IP address.")
      .addText((t) =>
        t
          .setPlaceholder("Example.com")
          .setValue(this.plugin.settings.host)
          .onChange((v) => {
            this.plugin.settings.host = v.trim();
            void this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Default 22.")
      .addText((t) =>
        t
          .setPlaceholder("22")
          .setValue(String(this.plugin.settings.port))
          .onChange((v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.port = Number.isFinite(n) && n > 0 ? n : 22;
            void this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Username")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.username)
          .onChange((v) => {
            this.plugin.settings.username = v.trim();
            void this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Authentication")
      .setDesc("Password or SSH private key. The server's SSH host key is pinned on first connect; subsequent mismatches refuse to connect. Run the \"forget remembered host fingerprint\" command after a deliberate server reinstall.")
      .addDropdown((d) =>
        d
          .addOption("password", "Password")
          .addOption("key", "Private key")
          .setValue(this.plugin.settings.authMethod)
          .onChange((v) => {
            this.plugin.settings.authMethod = v as AuthMethod;
            void this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.authMethod === "password") {
      new Setting(containerEl)
        .setName("Password")
        .setDesc("Encrypted at rest (AES-256-GCM) with a per-device key in the plugin state directory. State never syncs, so a leaked data.json on the SFTP server cannot be decrypted without local access. SSH keys are still preferred on shared machines.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.password).onChange((v) => {
            this.plugin.settings.password = v;
            void this.plugin.saveSettings();
          });
        });
    } else {
      new Setting(containerEl)
        .setName("Private key path")
        .setDesc("Absolute filesystem path to your SSH private key.")
        .addText((t) =>
          t
            .setValue(this.plugin.settings.privateKeyPath)
            .onChange((v) => {
              this.plugin.settings.privateKeyPath = v.trim();
              void this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName("Key passphrase")
        .setDesc("Empty if the key is unencrypted.")
        .addText((t) => {
          t.inputEl.type = "password";
          t.setValue(this.plugin.settings.passphrase).onChange((v) => {
            this.plugin.settings.passphrase = v;
            void this.plugin.saveSettings();
          });
        });
    }

    new Setting(containerEl)
      .setName("Remote root")
      .setDesc("Absolute path on the server. Created if it doesn't exist.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.remoteRoot)
          .onChange((v) => {
            this.plugin.settings.remoteRoot = v.trim();
            void this.plugin.saveSettings();
          }),
      );

    // ─── Sync scope ───────────────────────────────────────────────────────
    new Setting(containerEl).setName("Sync scope").setHeading();

    new Setting(containerEl)
      .setName("Sync the Obsidian config folder too")
      .setDesc("When enabled, plugins/themes/snippets/hotkeys are synced so all devices look identical.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncEverything).onChange((v) => {
          this.plugin.settings.syncEverything = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync workspace.json")
      .setDesc("Off by default. Workspace files describe open tabs/panels for this specific device. Turning this on will cause flapping if you work on two devices at once.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncWorkspaceJson).onChange((v) => {
          this.plugin.settings.syncWorkspaceJson = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Exclude patterns")
      .setDesc("One pattern per line. Gitignore-style. The plugin's own state/ directory is always excluded regardless.")
      .addTextArea((t) => {
        t.inputEl.rows = 6;
        t.inputEl.addClass("vbsftp-textarea-full");
        t.setValue(this.plugin.settings.excludePatterns.join("\n")).onChange((v) => {
          this.plugin.settings.excludePatterns = v
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          void this.plugin.saveSettings();
        });
      });

    // ─── Auto-sync triggers ───────────────────────────────────────────────
    new Setting(containerEl).setName("Auto-sync").setHeading();

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run a full bidirectional sync once Obsidian finishes loading.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnStartup).onChange((v) => {
          this.plugin.settings.autoSyncOnStartup = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync on quit")
      .setDesc("Best-effort push when Obsidian closes (5s timeout, push-only — no prompts).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnQuit).onChange((v) => {
          this.plugin.settings.autoSyncOnQuit = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync after changes")
      .setDesc("Debounced sync triggered by vault edits (create / modify / delete / rename).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSyncOnChange).onChange((v) => {
          this.plugin.settings.autoSyncOnChange = v;
          void this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Debounce delay (seconds)")
      .setDesc("How long to wait after the last edit before auto-syncing. Lower = more sync traffic.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.autoSyncDebounceSeconds))
          .onChange((v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.autoSyncDebounceSeconds =
              Number.isFinite(n) && n >= 2 && n <= 600 ? n : 10;
            void this.plugin.saveSettings();
          }),
      );

    // ─── Performance ──────────────────────────────────────────────────────
    new Setting(containerEl).setName("Performance").setHeading();

    new Setting(containerEl)
      .setName("Concurrent transfers")
      .setDesc(`How many uploads / downloads run in parallel inside a single SFTP connection. Higher = faster on high-RTT links, but heavier server load. Range ${MIN_CONCURRENCY}-${MAX_CONCURRENCY}. Default 8.`)
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.concurrency))
          .onChange((v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.concurrency =
              Number.isFinite(n) && n >= MIN_CONCURRENCY && n <= MAX_CONCURRENCY ? n : 8;
            void this.plugin.saveSettings();
          }),
      );

    // ─── Actions ──────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Actions").setHeading();

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
      .setDesc("Run a full sync immediately.")
      .addButton((b) =>
        b.setButtonText("Sync now").onClick(() => { void this.plugin.syncNow(); }),
      );

    // ─── Device ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Device (local only, not synced)").setHeading();

    new Setting(containerEl)
      .setName("Device label")
      .setDesc("Used in conflict-copy filenames so you can tell which device the conflicting edit came from. Lives in state/device.json — each machine has its own.")
      .addText((t) =>
        t
          .setPlaceholder("Home laptop")
          .setValue(this.plugin.deviceStore.label)
          .onChange((v) => {
            void this.plugin.deviceStore.setLabel(v);
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
