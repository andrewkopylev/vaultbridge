import { App, Modal } from "obsidian";
import type { SyncOp } from "../sync/diff";

export type BulkDeleteDecision = "continue" | "skip-deletes" | "cancel";

export interface BulkDeleteWarning {
  outgoingDeletes: SyncOp[];   // delete-remote ops (files about to disappear from server)
  incomingDeletes: SyncOp[];   // delete-local ops (files about to disappear from local vault)
  totalFiles: number;
}

const PREVIEW_LIMIT = 15;

export class BulkDeleteConfirmModal extends Modal {
  private decision: BulkDeleteDecision = "cancel";
  resolveFn?: (decision: BulkDeleteDecision) => void;

  constructor(app: App, private warning: BulkDeleteWarning) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Bulk deletion warning" });

    const out = this.warning.outgoingDeletes.length;
    const inc = this.warning.incomingDeletes.length;
    const tot = this.warning.totalFiles;

    const summaryEl = contentEl.createEl("p");
    summaryEl.appendText("This sync would delete ");
    summaryEl.createEl("strong", { text: `${out} file(s) on the server` });
    summaryEl.appendText(" and ");
    summaryEl.createEl("strong", { text: `${inc} file(s) locally` });
    summaryEl.appendText(` (out of ${tot} tracked files). Please review before continuing.`);

    if (out > 0) {
      contentEl.createEl("h3", { text: `Files to be deleted on server (${out}):` });
      this.renderList(contentEl, this.warning.outgoingDeletes);
    }
    if (inc > 0) {
      contentEl.createEl("h3", { text: `Files to be deleted locally (${inc}):` });
      this.renderList(contentEl, this.warning.incomingDeletes);
    }

    const note = contentEl.createEl("p", { cls: "vbsftp-modal-note" });
    note.appendText(
      "Choosing \"Skip deletes\" will perform pushes/pulls/conflict-copies but leave deletions for review later — the next sync will re-detect them.",
    );

    const buttons = contentEl.createDiv({ cls: "vbsftp-modal-buttons" });

    const cancelBtn = buttons.createEl("button", { text: "Cancel sync" });
    cancelBtn.addEventListener("click", () => {
      this.decision = "cancel";
      this.close();
    });

    const skipBtn = buttons.createEl("button", { text: "Skip deletes" });
    skipBtn.addEventListener("click", () => {
      this.decision = "skip-deletes";
      this.close();
    });

    const continueBtn = buttons.createEl("button", { text: "Continue (delete)" });
    continueBtn.addClass("mod-warning");
    continueBtn.addEventListener("click", () => {
      this.decision = "continue";
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolveFn?.(this.decision);
  }

  private renderList(container: HTMLElement, ops: SyncOp[]): void {
    const ul = container.createEl("ul", { cls: "vbsftp-modal-file-list" });

    const shown = ops.slice(0, PREVIEW_LIMIT);
    for (const op of shown) {
      ul.createEl("li", { text: op.path });
    }
    if (ops.length > PREVIEW_LIMIT) {
      ul.createEl("li", {
        text: `… and ${ops.length - PREVIEW_LIMIT} more (full list in DevTools console)`,
      });
    }
  }
}

export function askBulkDeleteDecision(
  app: App,
  warning: BulkDeleteWarning,
): Promise<BulkDeleteDecision> {
  return new Promise((resolve) => {
    const modal = new BulkDeleteConfirmModal(app, warning);
    modal.resolveFn = resolve;
    modal.open();
  });
}
