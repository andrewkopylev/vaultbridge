import { App, Modal } from "obsidian";

export type ServerResetChoice = "force-push" | "reset-snapshot" | "cancel";

export interface ServerResetInfo {
  lastSnapshotGeneration: number;
  snapshotFileCount: number;
  remoteGeneration: number;
  remoteFileCount: number;
}

export class ServerResetModal extends Modal {
  private decision: ServerResetChoice = "cancel";
  resolveFn?: (decision: ServerResetChoice) => void;

  constructor(app: App, private info: ServerResetInfo) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Server reset detected" });

    const p = contentEl.createEl("p");
    p.appendText("The remote manifest looks like it has been wiped or recreated.");
    p.createEl("br");
    p.appendText(
      `Last successful sync from this device was generation ${this.info.lastSnapshotGeneration} ` +
      `(${this.info.snapshotFileCount} files). Server now reports generation ${this.info.remoteGeneration} ` +
      `(${this.info.remoteFileCount} files).`,
    );

    const warn = contentEl.createEl("p", { cls: "vbsftp-modal-warning" });
    warn.appendText(
      "If we proceed with a normal sync, the engine will see your local files as \"deleted on remote\" and try to delete them locally.",
    );
    warn.createEl("br");
    warn.appendText("This is almost certainly the wrong outcome — pick one of the safe options below.");

    const ul = contentEl.createEl("ul", { cls: "vbsftp-modal-list" });

    const liA = ul.createEl("li");
    liA.createEl("strong", { text: "Force push from local" });
    liA.appendText(" — re-upload all local files to server, rewriting the manifest. Use if you trust the local copy as the source of truth.");

    const liB = ul.createEl("li");
    liB.createEl("strong", { text: "Reset local snapshot only" });
    liB.appendText(" — clear this device's idea of \"last sync\" so a normal sync treats local files as fresh additions. Useful if other devices have already pushed up-to-date content.");

    const liC = ul.createEl("li");
    liC.createEl("strong", { text: "Cancel" });
    liC.appendText(" — investigate manually before doing anything.");

    const buttons = contentEl.createDiv({ cls: "vbsftp-modal-buttons" });

    const cancelBtn = buttons.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => { this.decision = "cancel"; this.close(); });

    const resetBtn = buttons.createEl("button", { text: "Reset snapshot" });
    resetBtn.addEventListener("click", () => { this.decision = "reset-snapshot"; this.close(); });

    const pushBtn = buttons.createEl("button", { text: "Force push from local" });
    pushBtn.addClass("mod-cta");
    pushBtn.addEventListener("click", () => { this.decision = "force-push"; this.close(); });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn?.(this.decision);
  }
}

export function askServerResetDecision(
  app: App,
  info: ServerResetInfo,
): Promise<ServerResetChoice> {
  return new Promise((resolve) => {
    const modal = new ServerResetModal(app, info);
    modal.resolveFn = resolve;
    modal.open();
  });
}
