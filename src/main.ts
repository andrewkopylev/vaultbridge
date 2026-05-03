import { Notice, Plugin, TAbstractFile, TFile, debounce } from "obsidian";
import { DEFAULT_SETTINGS, SftpSyncSettings, SftpSyncSettingTab, isConnectionConfigured } from "./settings";
import { SftpClient } from "./sftp/client";
import { RemoteState } from "./sftp/remote-state";
import { IndexStore } from "./sync/index-store";
import { Scanner } from "./sync/scanner";
import { ExcludeMatcher } from "./sync/exclude";
import { DeviceStore } from "./state/device-store";
import { SecretStore } from "./state/secret-store";
import { KnownHostsStore } from "./state/known-hosts-store";
import { LastSyncedStore } from "./sync/last-synced";
import { PushEngine } from "./sync/push-engine";
import { PullEngine } from "./sync/pull-engine";
import { SyncEngine } from "./sync/sync-engine";
import { askBulkDeleteDecision } from "./ui/bulk-delete-modal";
import { askServerResetDecision } from "./ui/server-reset-modal";
import { rebuildRemoteManifest } from "./sync/manifest-rebuilder";
import { pluginPaths, PluginPaths } from "./state/paths";

export default class SftpSyncPlugin extends Plugin {
  settings!: SftpSyncSettings;
  index!: IndexStore;
  exclude!: ExcludeMatcher;
  scanner!: Scanner;
  deviceStore!: DeviceStore;
  lastSynced!: LastSyncedStore;
  secretStore!: SecretStore;
  knownHosts!: KnownHostsStore;
  paths!: PluginPaths;

  private statusBar: HTMLElement | null = null;
  private syncInProgress = false;
  private startupComplete = false;

  // Per-file debounced refresh queue. Prevents thrashing on rapid edits.
  private pendingRefresh = new Map<string, ReturnType<typeof debounce>>();
  // Global debounced auto-sync trigger. Re-created when debounce setting changes.
  private autoSyncDebouncer: ReturnType<typeof debounce> | null = null;

  async onload() {
    this.paths = pluginPaths(this.app.vault.configDir);

    // SecretStore must be ready before loadSettings — encrypted secrets are decrypted on load.
    this.secretStore = new SecretStore(this.app);
    await this.secretStore.load();

    this.knownHosts = new KnownHostsStore(this.app);
    await this.knownHosts.load();

    await this.loadSettings();

    this.deviceStore = new DeviceStore(this.app);
    await this.deviceStore.load();

    this.index = new IndexStore(this.app);
    await this.index.load();

    this.lastSynced = new LastSyncedStore(this.app);
    await this.lastSynced.load();

    this.exclude = new ExcludeMatcher(this.app, this.settings);
    this.scanner = new Scanner(this.app, this.index, this.exclude);

    this.statusBar = this.addStatusBarItem();
    this.setStatus("idle");
    this.statusBar.addEventListener("click", () => { void this.syncNow(); });

    this.addSettingTab(new SftpSyncSettingTab(this.app, this));

    this.addCommand({
      id: "test-connection",
      name: "Test connection",
      callback: () => { void this.testConnection(); },
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => { void this.syncNow(); },
    });

    this.addCommand({
      id: "rebuild-index",
      name: "Rebuild local index",
      callback: () => { void this.rebuildIndex(); },
    });

    this.addCommand({
      id: "index-stats",
      name: "Show index stats",
      callback: () => { this.showIndexStats(); },
    });

    this.addCommand({
      id: "inspect-remote",
      name: "Inspect remote state (manifest + lock)",
      callback: () => { void this.inspectRemoteState(); },
    });

    this.addCommand({
      id: "force-release-lock",
      name: "Force-release remote sync lock",
      callback: () => { void this.forceReleaseLock(); },
    });

    this.addCommand({
      id: "force-push",
      name: "Force push everything (re-upload all files)",
      callback: () => { void this.forcePush(); },
    });

    this.addCommand({
      id: "pull",
      name: "Pull from server",
      callback: () => { void this.pullNow(); },
    });

    this.addCommand({
      id: "force-pull",
      name: "Force pull everything (re-download all files)",
      callback: () => { void this.pullNow({ forceDownload: true }); },
    });

    this.addCommand({
      id: "rebuild-remote-manifest",
      name: "Rebuild remote manifest (walk server, re-hash)",
      callback: () => { void this.rebuildRemoteManifestCmd(); },
    });

    this.addCommand({
      id: "reset-snapshot",
      name: "Reset local snapshot (treat next sync as fresh)",
      callback: () => { void this.resetLocalSnapshot(); },
    });

    this.addCommand({
      id: "forget-host-fingerprint",
      name: "Forget remembered host fingerprint",
      callback: () => { void this.forgetHostFingerprint(); },
    });

    // (e) Manual trigger: ribbon icon (in addition to the status bar click).
    this.addRibbonIcon("refresh-cw", "Sync now", () => { void this.syncNow(); });

    // (a) Startup: initial scan, then auto-sync if enabled.
    this.app.workspace.onLayoutReady(() => {
      void this.startupRoutine();
    });

    this.registerVaultEvents();
    this.rebuildAutoSyncDebouncer();
  }

  onunload(): void {
    // Synchronous teardown the base class expects.
    // Async work (best-effort quit-push, index flush) is fire-and-forget.
    void this.runOnUnload();
  }

  private async runOnUnload(): Promise<void> {
    if (
      this.startupComplete &&
      this.settings?.autoSyncOnQuit &&
      isConnectionConfigured(this.settings)
    ) {
      try {
        await this.bestEffortQuitPush(5000);
      } catch (err) {
        console.warn("Vault Bridge: quit-time push failed (ignoring)", err);
      }
    }
    // Force a final flush so we don't lose recent updates.
    if (this.index) {
      try {
        await this.index.flush();
      } catch { /* ignore — best-effort on shutdown */ }
    }
    // Clean up any pending debounced calls.
    for (const fn of this.pendingRefresh.values()) fn.cancel?.();
    this.pendingRefresh.clear();
    this.autoSyncDebouncer?.cancel?.();
  }

  async loadSettings() {
    const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;

    // Migration: drop fields that older versions wrote but no longer belong here.
    // (deviceId/deviceLabel moved to state/device.json so they don't sync between machines.)
    delete raw.deviceId;
    delete raw.deviceLabel;

    // Migration: workspace.json is now handled by the syncWorkspaceJson toggle, not the
    // user-editable exclude list. Strip the auto-added entries so the toggle actually works.
    const cfg = this.app.vault.configDir;
    const RETIRED_AUTO_PATTERNS = new Set([
      `${cfg}/workspace.json`,
      `${cfg}/workspace-mobile.json`,
    ]);
    if (Array.isArray(raw.excludePatterns)) {
      raw.excludePatterns = (raw.excludePatterns as string[]).filter(
        (p) => !RETIRED_AUTO_PATTERNS.has(p),
      );
    }

    // Decrypt encrypted secrets, flag plaintext leftovers for one-time re-encryption.
    let needsResaveEncrypted = false;
    for (const field of ["password", "passphrase"] as const) {
      const v = raw[field];
      if (typeof v !== "string" || v.length === 0) continue;
      if (this.secretStore.isEncrypted(v)) {
        try {
          raw[field] = this.secretStore.decrypt(v);
        } catch (err) {
          console.warn(`Vault Bridge: cannot decrypt ${field} — falling back to empty`, err);
          new Notice(
            `Vault Bridge: stored ${field} could not be decrypted (state/secret.key may be missing). Re-enter it in settings.`,
            8000,
          );
          raw[field] = "";
        }
      } else {
        // Plaintext from a pre-encryption install — keep as-is in memory, flag to re-save encrypted.
        needsResaveEncrypted = true;
      }
    }

    // Keep only fields declared in DEFAULT_SETTINGS — drops any other unknown keys.
    const known: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      if (k in raw) known[k] = raw[k];
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, known);

    if (needsResaveEncrypted) {
      await this.persistSettings();
    }
  }

  /** Write settings to data.json with sensitive fields encrypted. No side effects on matchers. */
  private async persistSettings(): Promise<void> {
    const toSave: Record<string, unknown> = { ...this.settings };
    for (const field of ["password", "passphrase"] as const) {
      const v = toSave[field];
      if (typeof v === "string" && v.length > 0) {
        toSave[field] = this.secretStore.encrypt(v);
      }
    }
    await this.saveData(toSave);
  }

  async saveSettings() {
    await this.persistSettings();
    // Re-build matcher when settings change (toggles, exclude patterns).
    if (this.exclude) {
      this.exclude = new ExcludeMatcher(this.app, this.settings);
      this.scanner = new Scanner(this.app, this.index, this.exclude);
    }
    // Re-create the debouncer so a changed delay takes effect.
    this.rebuildAutoSyncDebouncer();
  }

  private rebuildAutoSyncDebouncer(): void {
    this.autoSyncDebouncer?.cancel?.();
    const delayMs = Math.max(2, this.settings?.autoSyncDebounceSeconds ?? 10) * 1000;
    this.autoSyncDebouncer = debounce(
      () => { void this.autoSync("change"); },
      delayMs,
      false,
    );
  }

  /** Schedule the on-change auto-sync (does nothing if (c) trigger is disabled). */
  private scheduleAutoSync(): void {
    if (!this.startupComplete) return;       // ignore events during startup
    if (this.syncInProgress) return;         // engine updates index directly
    if (!this.settings.autoSyncOnChange) return;
    if (!isConnectionConfigured(this.settings)) return;  // no creds → don't even queue
    this.autoSyncDebouncer?.();
  }

  private async startupRoutine(): Promise<void> {
    await this.initialScan();
    this.startupComplete = true;
    if (this.settings.autoSyncOnStartup) {
      // Brief delay so any open files settle before we start poking the network.
      activeWindow.setTimeout(() => { void this.autoSync("startup"); }, 1000);
    }
  }

  /** Auto-sync: like syncNow, but quieter and auto-cancels bulk-delete prompts. */
  private async autoSync(reason: "startup" | "change"): Promise<void> {
    if (this.syncInProgress) {
      console.debug(`Vault Bridge: auto-sync (${reason}) skipped — already running`);
      return;
    }
    if (!isConnectionConfigured(this.settings)) {
      console.debug(`Vault Bridge: auto-sync (${reason}) skipped — connection not configured`);
      return;
    }
    this.syncInProgress = true;
    this.setStatus("syncing");
    console.debug(`Vault Bridge: auto-sync triggered (${reason})`);
    try {
      const engine = new SyncEngine(
        this.app, this.settings, this.deviceStore,
        this.index, this.scanner, this.exclude, this.lastSynced, this.knownHosts,
      );
      const result = await engine.syncBoth({
        onProgress: (p) => {
          this.setStatus(p.total === 0 ? "syncing" : `syncing ${p.processed}/${p.total}`);
        },
        // For unattended syncs we never want to block on a modal — auto-cancel and tell the user.
        confirmBulkDelete: (info) => {
          new Notice(
            `Auto-sync paused — ${info.outgoingDeletes.length + info.incomingDeletes.length} pending deletions need review. Run "Sync now" manually.`,
            10000,
          );
          return Promise.resolve("cancel");
        },
      });

      const c = result.counts;
      const secs = (result.took / 1000).toFixed(1);
      // Quiet: only show Notice if something actually changed or we hit a special state.
      if (result.cancelled) {
        // Bulk-delete cancellation already showed its own Notice; nothing more.
      } else if (c.ioOps > 0 || result.conflictCopies.length > 0) {
        const parts: string[] = [];
        if (c.push) parts.push(`pushed ${c.push}`);
        if (c.pull) parts.push(`pulled ${c.pull}`);
        if (c.deleteRemote) parts.push(`del-remote ${c.deleteRemote}`);
        if (c.deleteLocal) parts.push(`del-local ${c.deleteLocal}`);
        if (c.conflict) parts.push(`conflicts ${c.conflict}`);
        if (c.restore) parts.push(`restored ${c.restore}`);
        let msg = `Auto-sync (${reason}): ${parts.join(", ")} (${secs}s)`;
        if (result.conflictCopies.length) {
          msg += `\nConflict copies: ${result.conflictCopies.length}`;
        }
        new Notice(msg, 6000);
      }
      // For "nothing to do" we don't spam the user; just status bar.
      this.setStatus("ok");
    } catch (err) {
      console.error(`Vault Bridge: auto-sync (${reason}) failed`, err);
      new Notice(`Auto-sync failed — ${(err as Error).message}`, 8000);
      this.setStatus("error");
    } finally {
      this.syncInProgress = false;
    }
  }

  /** (b) On quit: push-only with hard timeout. No prompts, no pulls. */
  private async bestEffortQuitPush(timeoutMs: number): Promise<void> {
    const work = (async () => {
      const engine = new PushEngine(
        this.app, this.settings, this.deviceStore,
        this.index, this.scanner, this.lastSynced, this.knownHosts,
      );
      await engine.pushAll();
    })();
    const timeout = new Promise<never>((_, reject) =>
      activeWindow.setTimeout(() => reject(new Error(`quit-push timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    await Promise.race([work, timeout]);
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async initialScan(): Promise<void> {
    // First-ever load: empty index → full scan and hash everything.
    // Subsequent loads: index exists → cheap mtime check.
    const isFirstScan = this.index.size() === 0;
    if (isFirstScan) {
      new Notice("Building initial index…", 3000);
    }
    try {
      const { entries, took } = await this.scanner.fullScan();
      console.debug(`Vault Bridge: scan finished — ${entries.length} files in ${took}ms`);
      if (isFirstScan) {
        new Notice(`Indexed ${entries.length} files (${took}ms)`, 4000);
      }
    } catch (err) {
      console.error("Vault Bridge: initial scan failed", err);
      new Notice(`Initial scan failed — ${(err as Error).message}`, 8000);
    }
  }

  private registerVaultEvents(): void {
    // Vault events fire only for files Obsidian tracks (markdown, canvas, attachments).
    // Changes inside .obsidian/ are caught at sync time via a re-scan, not here.
    this.registerEvent(
      this.app.vault.on("create", (f) => {
        this.queueRefresh(f);
        this.scheduleAutoSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        this.queueRefresh(f);
        this.scheduleAutoSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (f) => {
        if (this.exclude.isExcluded(f.path)) return;
        // Cancel any pending refresh — file is gone.
        this.pendingRefresh.get(f.path)?.cancel?.();
        this.pendingRefresh.delete(f.path);
        this.index.remove(f.path);
        this.scheduleAutoSync();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath: string) => {
        if (this.exclude.isExcluded(f.path) && this.exclude.isExcluded(oldPath)) return;
        this.pendingRefresh.get(oldPath)?.cancel?.();
        this.pendingRefresh.delete(oldPath);
        if (this.exclude.isExcluded(f.path)) {
          this.index.remove(oldPath);
        } else {
          this.index.rename(oldPath, f.path);
          // mtime/size unchanged on rename, but queue a verify in case.
          this.queueRefresh(f);
        }
        this.scheduleAutoSync();
      }),
    );
  }

  private queueRefresh(f: TAbstractFile): void {
    if (!(f instanceof TFile)) return;
    // Don't react to our own writes during a sync. The engines update the index directly.
    if (this.syncInProgress) return;
    if (this.exclude.isExcluded(f.path)) return;

    let fn = this.pendingRefresh.get(f.path);
    if (!fn) {
      fn = debounce(
        () => {
          this.pendingRefresh.delete(f.path);
          void this.scanner.refreshOne(f.path).catch((err) =>
            console.warn(`Vault Bridge: refresh failed for ${f.path}`, err),
          );
        },
        2000,
        true,
      );
      this.pendingRefresh.set(f.path, fn);
    }
    fn();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Commands

  async testConnection(): Promise<void> {
    const client = new SftpClient(this.settings, this.knownHosts);
    try {
      await client.connect();
      await client.ensureRemoteRoot();
      new Notice("Connection OK", 4000);
    } catch (err) {
      console.error("Vault Bridge: connection failed", err);
      new Notice(`Connection FAILED — ${(err as Error).message}`, 8000);
    } finally {
      await client.end();
    }
  }

  /** Bidirectional sync — the everyday command. Uses SyncEngine (3-way diff). */
  async syncNow(): Promise<void> {
    if (this.syncInProgress) {
      new Notice("Already running", 3000);
      return;
    }
    this.syncInProgress = true;
    this.setStatus("syncing");
    try {
      const engine = new SyncEngine(
        this.app,
        this.settings,
        this.deviceStore,
        this.index,
        this.scanner,
        this.exclude,
        this.lastSynced,
        this.knownHosts,
      );
      const result = await engine.syncBoth({
        onProgress: (p) => {
          if (p.total === 0) {
            this.setStatus("syncing");
          } else {
            this.setStatus(`syncing ${p.processed}/${p.total}`);
          }
        },
        confirmBulkDelete: (info) => askBulkDeleteDecision(this.app, info),
      });

      const c = result.counts;
      const secs = (result.took / 1000).toFixed(1);

      // Server-reset path: hand off to a recovery dialog instead of any normal Notice.
      if (result.serverReset) {
        await this.handleServerReset(result.serverReset);
        this.setStatus("idle");
        return;
      }

      if (result.cancelled) {
        new Notice(
          `Cancelled by user (no changes made, ${secs}s)`,
          5000,
        );
      } else if (result.noChanges || c.ioOps === 0) {
        new Notice(
          `Already in sync (gen=${result.generation}, ${secs}s)`,
          5000,
        );
      } else {
        const parts: string[] = [];
        if (c.push) parts.push(`pushed ${c.push}`);
        if (c.pull) parts.push(`pulled ${c.pull}`);
        if (c.deleteRemote) parts.push(`del-remote ${c.deleteRemote}`);
        if (c.deleteLocal) parts.push(`del-local ${c.deleteLocal}`);
        if (c.conflict) parts.push(`conflicts ${c.conflict}`);
        if (c.restore) parts.push(`restored ${c.restore}`);

        let msg = `${parts.join(", ")} (gen=${result.generation}, ${secs}s)`;
        if (result.deletesSkipped) {
          msg += "\nDeletes were skipped at user request — re-run sync to address them.";
        }
        if (result.conflictCopies.length) {
          msg += `\nConflict copies created:\n  ${result.conflictCopies.join("\n  ")}`;
        }
        if (result.selfHealedMissing?.length) {
          msg += `\n${result.selfHealedMissing.length} file(s) were missing on server — dropped from manifest.`;
        }
        new Notice(msg, 10000);
      }

      this.setStatus("ok");
    } catch (err) {
      console.error("Vault Bridge: sync failed", err);
      new Notice(`Sync FAILED — ${(err as Error).message}`, 10000);
      this.setStatus("error");
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Coordinate the server-reset recovery flow via a modal dialog. */
  private async handleServerReset(info: NonNullable<Awaited<ReturnType<SyncEngine["syncBoth"]>>["serverReset"]>): Promise<void> {
    const choice = await askServerResetDecision(this.app, info);
    if (choice === "cancel") {
      new Notice("Server-reset cancelled — no changes made.", 5000);
      return;
    }
    if (choice === "force-push") {
      // syncInProgress is already true here (from syncNow), so call the inner method
      // directly — wrapping forcePush() would short-circuit on its in-progress guard.
      new Notice("Forcing push from local…", 3000);
      try {
        await this._runForcePush();
      } catch {
        // Already reported by _runForcePush; nothing more to do.
      }
      return;
    }
    if (choice === "reset-snapshot") {
      await this.resetLocalSnapshot({ silent: true });
      new Notice(
        "Local snapshot reset. Next sync will treat all files as fresh additions.",
        6000,
      );
    }
  }

  /** Wipe state/last-synced.json. Used by server-reset modal and as a manual recovery command. */
  async resetLocalSnapshot(opts: { silent?: boolean } = {}): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if ((await adapter.exists(this.paths.lastSynced)) === true) {
        await adapter.remove(this.paths.lastSynced);
      }
      await this.lastSynced.load(); // re-loads as empty
      if (!opts.silent) {
        new Notice("Local snapshot reset.", 5000);
      }
    } catch (err) {
      console.error("Vault Bridge: snapshot reset failed", err);
      new Notice(`Snapshot reset failed — ${(err as Error).message}`, 8000);
    }
  }

  /** Walk the remote vault, hash every file, rewrite manifest.json. Recovery for scenario 1. */
  async rebuildRemoteManifestCmd(): Promise<void> {
    if (this.syncInProgress) {
      new Notice("Another operation is running, try again later", 4000);
      return;
    }
    this.syncInProgress = true;
    this.setStatus("rebuilding");
    try {
      new Notice("Walking server and rebuilding manifest — this can take a while…", 4000);
      const result = await rebuildRemoteManifest(
        this.settings,
        this.deviceStore,
        this.exclude,
        this.knownHosts,
        (p) => {
          if (p.total != null) this.setStatus(`rebuild ${p.scanned}/${p.total}`);
          else this.setStatus("rebuild …");
        },
      );
      const mb = (result.totalBytes / (1024 * 1024)).toFixed(2);
      const secs = (result.took / 1000).toFixed(1);
      new Notice(
        `Manifest rebuilt — ${result.filesIndexed} files (${mb} MB) in ${secs}s (gen=${result.generation}). Run "Sync now" to reconcile locally.`,
        8000,
      );
      this.setStatus("ok");
    } catch (err) {
      console.error("Vault Bridge: rebuild failed", err);
      new Notice(`Rebuild FAILED — ${(err as Error).message}`, 10000);
      this.setStatus("error");
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Force-push: re-upload everything without 3-way diff. Use after manifest corruption. */
  async forcePush(): Promise<void> {
    if (this.syncInProgress) {
      new Notice("Already running", 3000);
      return;
    }
    this.syncInProgress = true;
    try {
      await this._runForcePush();
    } finally {
      this.syncInProgress = false;
    }
  }

  /** Inner force-push body (no syncInProgress handling). Reused by handleServerReset. */
  private async _runForcePush(): Promise<void> {
    this.setStatus("force-pushing");
    try {
      const engine = new PushEngine(
        this.app,
        this.settings,
        this.deviceStore,
        this.index,
        this.scanner,
        this.lastSynced,
        this.knownHosts,
      );
      const result = await engine.pushAll({
        forceUpload: true,
        onProgress: (p) => {
          const toUpload = p.total - p.skipped;
          this.setStatus(`force-push ${p.uploaded}/${toUpload}`);
        },
      });
      const mb = (result.totalBytes / (1024 * 1024)).toFixed(2);
      const secs = (result.took / 1000).toFixed(1);
      new Notice(
        `Force-pushed ${result.uploaded} files (${mb} MB) in ${secs}s (gen=${result.generation})`,
        6000,
      );
      this.setStatus("ok");
    } catch (err) {
      console.error("Vault Bridge: force-push failed", err);
      new Notice(`Force-push FAILED — ${(err as Error).message}`, 10000);
      this.setStatus("error");
      throw err;
    }
  }

  async pullNow(opts: { forceDownload?: boolean } = {}): Promise<void> {
    if (this.syncInProgress) {
      new Notice("Already running", 3000);
      return;
    }
    this.syncInProgress = true;
    this.setStatus(opts.forceDownload ? "force-pulling" : "pulling");
    try {
      const engine = new PullEngine(
        this.app,
        this.settings,
        this.deviceStore,
        this.index,
        this.scanner,
        this.exclude,
        this.lastSynced,
        this.knownHosts,
      );
      const result = await engine.pullAll({
        forceDownload: opts.forceDownload,
        onProgress: (p) => {
          const toDownload = p.total - p.skipped;
          this.setStatus(`pulling ${p.downloaded}/${toDownload}`);
        },
      });
      const mb = (result.totalBytes / (1024 * 1024)).toFixed(2);
      const secs = (result.took / 1000).toFixed(1);
      const msg =
        result.downloaded === 0
          ? `Nothing to pull (${result.skipped} already up to date, ${secs}s, gen=${result.generation})`
          : `Pulled ${result.downloaded} files (${mb} MB), skipped ${result.skipped} up-to-date, in ${secs}s (gen=${result.generation})`;
      new Notice(msg, 6000);
      this.setStatus("ok");
    } catch (err) {
      console.error("Vault Bridge: pull failed", err);
      new Notice(`Pull FAILED — ${(err as Error).message}`, 10000);
      this.setStatus("error");
    } finally {
      this.syncInProgress = false;
    }
  }

  private setStatus(s: string): void {
    if (!this.statusBar) return;
    const icon =
      s === "idle" ? "↻" :
      s === "ok" ? "✓" :
      s === "error" ? "✗" :
      "⟳";
    this.statusBar.setText(`SFTP ${icon} ${s}`);
  }

  async rebuildIndex(): Promise<void> {
    new Notice("Rebuilding local index…", 3000);
    try {
      const { entries, took } = await this.scanner.fullScan({ forceRehash: true });
      new Notice(`Rebuilt — ${entries.length} files (${took}ms)`, 4000);
    } catch (err) {
      console.error("Vault Bridge: rebuild failed", err);
      new Notice(`Rebuild failed — ${(err as Error).message}`, 8000);
    }
  }

  showIndexStats(): void {
    const n = this.index.size();
    const mb = (this.index.totalBytes() / (1024 * 1024)).toFixed(2);
    const last = this.index.lastScannedAt();
    const ago = last === 0 ? "never" : `${Math.round((Date.now() - last) / 1000)}s ago`;
    new Notice(`${n} files, ${mb} MB, last full scan: ${ago}`, 6000);
  }

  /** Connect, read manifest + lock, print summary. Used to verify Phase 3. */
  async inspectRemoteState(): Promise<void> {
    const client = new SftpClient(this.settings, this.knownHosts);
    try {
      await client.connect();
      await client.ensureRemoteRoot();
      const remote = new RemoteState(
        client,
        this.settings.remoteRoot,
        this.deviceStore.id,
        this.deviceStore.label,
      );
      await remote.ensureSyncDir();

      const manifest = await remote.readManifest();
      const lock = await remote.readLock();

      const manifestSummary = manifest.generation === 0
        ? "manifest: empty (no sync yet)"
        : `manifest: gen=${manifest.generation}, ${Object.keys(manifest.entries).length} files, last writer: ${manifest.lastWriterLabel} at ${new Date(manifest.updatedAt).toLocaleString()}`;

      const lockSummary = lock
        ? `lock: HELD by ${lock.deviceLabel} (${lock.deviceId.slice(0, 6)}), age ${Math.round((Date.now() - lock.acquiredAt) / 1000)}s`
        : "lock: free";

      new Notice(`Remote state\n${manifestSummary}\n${lockSummary}`, 10000);
      console.debug("Vault Bridge remote state", { manifest, lock });
    } catch (err) {
      console.error("Vault Bridge: inspect failed", err);
      new Notice(`Inspect failed — ${(err as Error).message}`, 8000);
    } finally {
      await client.end();
    }
  }

  /** Manually break the lock (only ours; foreign locks are refused). Use after a crash. */
  async forceReleaseLock(): Promise<void> {
    const client = new SftpClient(this.settings, this.knownHosts);
    try {
      await client.connect();
      const remote = new RemoteState(
        client,
        this.settings.remoteRoot,
        this.deviceStore.id,
        this.deviceStore.label,
      );
      const before = await remote.readLock();
      if (!before) {
        new Notice("No lock to release", 4000);
        return;
      }
      if (before.deviceId !== this.deviceStore.id) {
        new Notice(
          `Lock is held by ${before.deviceLabel}, not us. Won't touch it. (Wait until it goes stale, ~5min.)`,
          8000,
        );
        return;
      }
      await remote.releaseLock();
      new Notice("Lock released", 4000);
    } catch (err) {
      console.error("Vault Bridge: force release failed", err);
      new Notice(`Force release failed — ${(err as Error).message}`, 8000);
    } finally {
      await client.end();
    }
  }

  /** Drop the remembered SHA-256 fingerprint for the configured host:port.
   *  Use after a deliberate server reinstall so the next connect re-runs TOFU. */
  async forgetHostFingerprint(): Promise<void> {
    if (!this.settings.host) {
      new Notice("No host configured", 4000);
      return;
    }
    const port = this.settings.port || 22;
    const removed = await this.knownHosts.forget(this.settings.host, port);
    if (removed) {
      new Notice(
        `Forgot fingerprint for ${this.settings.host}:${port}. Next connection will trust the new server key on first contact.`,
        6000,
      );
    } else {
      new Notice(`No remembered fingerprint for ${this.settings.host}:${port}`, 5000);
    }
  }
}
