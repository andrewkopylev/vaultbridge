import type { App, DataAdapter } from "obsidian";
import { SftpClient } from "../sftp/client";
import { RemoteState, RemoteManifest, ManifestEntry } from "../sftp/remote-state";
import {
  RemoteDirCache,
  uploadBuffer,
  readLocalAsBuffer,
  downloadToBuffer,
  writeBufferToVault,
  deleteRemoteFile,
  deleteLocalFile,
} from "../sftp/transfer";
import { buildPlan, conflictCopyName, SyncOp, SyncPlan } from "./diff";
import { runWithLimit } from "./concurrency";
import type { IndexStore, IndexEntry } from "./index-store";
import type { LastSyncedStore } from "./last-synced";
import type { Scanner } from "./scanner";
import type { ExcludeMatcher } from "./exclude";
import type { DeviceStore } from "../state/device-store";
import type { KnownHostsStore } from "../state/known-hosts-store";
import { STATE_PATHS } from "../state/paths";
import type { SftpSyncSettings } from "../settings";

export interface SyncProgress {
  processed: number;
  total: number;
  currentPath: string | null;
  currentAction: string | null;
}

export type SyncProgressFn = (p: SyncProgress) => void;

export type BulkDeleteDecision = "continue" | "skip-deletes" | "cancel";

export interface BulkDeleteInfo {
  outgoingDeletes: SyncOp[];
  incomingDeletes: SyncOp[];
  totalFiles: number;
}

export interface SyncOptions {
  onProgress?: SyncProgressFn;
  /**
   * Called when the plan would delete a large number of files.
   * Resolve with "continue" to proceed as planned, "skip-deletes" to drop deletes,
   * or "cancel" to abort the sync entirely.
   */
  confirmBulkDelete?: (info: BulkDeleteInfo) => Promise<BulkDeleteDecision>;
  /** Trigger confirmation when one side's delete count >= this absolute threshold. Default 20. */
  bulkDeleteAbsThreshold?: number;
  /** Trigger confirmation when one side's delete count / totalFiles >= this fraction. Default 0.05. */
  bulkDeleteRelThreshold?: number;
}

export interface ServerResetInfo {
  lastSnapshotGeneration: number;
  snapshotFileCount: number;
  remoteGeneration: number;
  remoteFileCount: number;
}

export interface SyncOutcome {
  generation: number;
  took: number;
  counts: SyncPlan["counts"];
  conflictCopies: string[];   // paths of conflict-copy files created
  noChanges: boolean;         // true if nothing happened
  cancelled?: boolean;        // user picked "cancel" — no work performed
  deletesSkipped?: boolean;   // user picked "skip-deletes" — deletes filtered out
  serverReset?: ServerResetInfo;  // server manifest looks reset/wiped — engine refused to proceed
  selfHealedMissing?: string[];   // paths whose remote-side download 404'd; manifest entry dropped
}

/**
 * Phase 6: bidirectional sync via 3-way diff (L vs S, R vs S).
 * Holds the remote lock for the duration. Updates remote manifest + local snapshot atomically at the end.
 */
export class SyncEngine {
  constructor(
    private app: App,
    private settings: SftpSyncSettings,
    private deviceStore: DeviceStore,
    private index: IndexStore,
    private scanner: Scanner,
    private exclude: ExcludeMatcher,
    private lastSynced: LastSyncedStore,
    private knownHosts: KnownHostsStore,
  ) {}

  async syncBoth(opts: SyncOptions = {}): Promise<SyncOutcome> {
    const t0 = Date.now();
    const adapter: DataAdapter = this.app.vault.adapter;
    const onProgress = opts.onProgress;

    // Make sure local index reflects current disk state.
    await this.scanner.fullScan();

    const client = new SftpClient(this.settings, this.knownHosts);
    await client.connect();
    try {
      await client.ensureRemoteRoot();
      const remote = new RemoteState(
        client,
        this.settings.remoteRoot,
        this.deviceStore.id,
        this.deviceStore.label,
      );
      await remote.ensureSyncDir();

      return await remote.withLock(async () => {
        const manifest = await remote.readManifest();
        const snapshot = this.lastSynced.snapshot;

        // ⚠ Server-reset detection: if this device successfully synced before (S.gen > 0)
        // but the remote manifest is empty (gen 0), someone wiped the server. Refuse to
        // proceed — otherwise we'd happily delete every local file.
        if (manifest.generation === 0 && snapshot.generation > 0) {
          console.warn("Vault Bridge: server-reset detected", {
            snapshotGeneration: snapshot.generation,
            snapshotFileCount: Object.keys(snapshot.entries).length,
          });
          return {
            generation: 0,
            took: Date.now() - t0,
            counts: emptyCounts(),
            conflictCopies: [],
            noChanges: false,
            cancelled: true,
            serverReset: {
              lastSnapshotGeneration: snapshot.generation,
              snapshotFileCount: Object.keys(snapshot.entries).length,
              remoteGeneration: manifest.generation,
              remoteFileCount: Object.keys(manifest.entries).length,
            },
          };
        }

        // Build the plan.
        const localMap = new Map<string, IndexEntry>();
        for (const e of this.index.all) localMap.set(e.path, e);
        const plan = buildPlan(
          localMap,
          manifest.entries,
          snapshot.entries,
          (p) => this.exclude.isExcluded(p),
        );

        // Diagnostics: show what we decided to do.
        console.log("Vault Bridge plan:", {
          counts: plan.counts,
          localCount: localMap.size,
          remoteCount: Object.keys(manifest.entries).length,
          snapshotCount: Object.keys(snapshot.entries).length,
          remoteGeneration: manifest.generation,
          snapshotGeneration: snapshot.generation,
          ioActions: plan.ops.filter(o =>
            o.action !== "skip" && o.action !== "drop-from-snapshot" && o.action !== "merge-converged"
          ).map(o => ({ path: o.path, action: o.action, L: o.localState, R: o.remoteState })),
        });

        // Bulk-delete safeguard.
        let deletesSkipped = false;
        const totalFiles = Math.max(
          localMap.size,
          Object.keys(manifest.entries).length,
          Object.keys(snapshot.entries).length,
        );
        const absThreshold = opts.bulkDeleteAbsThreshold ?? 20;
        const relThreshold = opts.bulkDeleteRelThreshold ?? 0.05;
        const trippedAbs =
          plan.counts.deleteRemote >= absThreshold || plan.counts.deleteLocal >= absThreshold;
        const trippedRel =
          totalFiles > 0 &&
          (plan.counts.deleteRemote / totalFiles >= relThreshold ||
            plan.counts.deleteLocal / totalFiles >= relThreshold);

        if ((trippedAbs || trippedRel) && opts.confirmBulkDelete) {
          const outgoing = plan.ops.filter((o) => o.action === "delete-remote");
          const incoming = plan.ops.filter((o) => o.action === "delete-local");
          console.log(
            "Vault Bridge: bulk-delete threshold tripped — asking user",
            { outgoing: outgoing.length, incoming: incoming.length, totalFiles },
          );
          const decision = await opts.confirmBulkDelete({
            outgoingDeletes: outgoing,
            incomingDeletes: incoming,
            totalFiles,
          });
          if (decision === "cancel") {
            return {
              generation: manifest.generation,
              took: Date.now() - t0,
              counts: plan.counts,
              conflictCopies: [],
              noChanges: false,
              cancelled: true,
            };
          }
          if (decision === "skip-deletes") {
            deletesSkipped = true;
            // Convert all delete-* ops to skip; entry retention falls out of the existing skip handler:
            //   delete-remote → op.remote is defined → server entry preserved (re-prompt next sync)
            //   delete-local  → op.local is defined → manifest entry preserved (server inconsistency
            //                   that next sync will catch and re-prompt — safe but noisy)
            for (const op of plan.ops) {
              if (op.action === "delete-remote" || op.action === "delete-local") {
                op.action = "skip";
              }
            }
            // Adjust counts so the result reflects what we actually did.
            plan.counts.skip += plan.counts.deleteRemote + plan.counts.deleteLocal;
            plan.counts.ioOps -= plan.counts.deleteRemote + plan.counts.deleteLocal;
            plan.counts.deleteRemote = 0;
            plan.counts.deleteLocal = 0;
          }
        }

        const noChanges =
          plan.counts.ioOps === 0 &&
          plan.counts.dropped === 0 &&
          plan.counts.converged === 0 &&
          // also no entries to migrate from snapshot to new manifest? still need to write S=manifest
          plan.counts.skip === Object.keys(snapshot.entries).length;

        // We always rebuild the new manifest entries from the plan + local index.
        const newEntries: Record<string, ManifestEntry> = {};
        const dirs = new RemoteDirCache(this.settings.remoteRoot);
        const conflictCopies: string[] = [];
        const selfHealedMissing: string[] = [];

        // Pre-create the local download staging dir once. writeBufferToVault otherwise
        // races on `mkdir(state/tmp)` when several download workers run concurrently.
        if ((await adapter.exists(STATE_PATHS.tmp)) === false) {
          await adapter.mkdir(STATE_PATHS.tmp);
        }

        // Phase A: bookkeeping-only ops (no I/O) — execute synchronously. Order doesn't matter.
        const ioOps: SyncOp[] = [];
        for (const op of plan.ops) {
          if (op.action === "skip") {
            // entry survives unchanged — pick local if present, else remote, else snapshot
            const e = op.local ?? op.remote ?? op.snapshot;
            if (e) newEntries[op.path] = manifestEntryOf(e);
            continue;
          }
          if (op.action === "merge-converged") {
            const e = op.local!; // both sides agree, local is fine
            newEntries[op.path] = manifestEntryOf(e);
            continue;
          }
          if (op.action === "drop-from-snapshot") {
            // entry gone — do nothing (not added to newEntries)
            continue;
          }
          ioOps.push(op);
        }

        // Phase B: parallel I/O. Each op operates on a distinct path, so writes to
        // newEntries / conflictCopies / selfHealedMissing don't collide. RemoteDirCache
        // is concurrency-safe; the IndexStore mutates per-path entries only.
        let processed = 0;
        const total = plan.counts.ioOps;

        await runWithLimit(ioOps, this.settings.concurrency, async (op) => {
          onProgress?.({ processed, total, currentPath: op.path, currentAction: op.action });
          try {
            await this.executeOp(client, adapter, op, dirs, newEntries, conflictCopies);
          } catch (err) {
            // Self-heal: if the missing file is on a pull-side action, drop it from the manifest
            // and continue. The local filesystem is left alone — next sync will re-evaluate.
            if (
              isRemoteFileMissing(err) &&
              (op.action === "pull" || op.action === "restore-keep-remote")
            ) {
              console.warn(
                `Vault Bridge: ${op.path} missing on server — dropping manifest entry (self-heal)`,
              );
              selfHealedMissing.push(op.path);
              processed++;
              return;
            }
            throw new Error(`Vault Bridge: failed on ${op.action} ${op.path} — ${(err as Error).message}`);
          }
          processed++;
        });

        // Final progress tick.
        onProgress?.({ processed, total, currentPath: null, currentAction: null });

        // Write the new manifest only if anything actually changed.
        const anythingChanged =
          plan.counts.ioOps > 0 ||
          plan.counts.dropped > 0 ||
          plan.counts.converged > 0 ||
          // safety: always write if entry sets differ
          Object.keys(newEntries).length !== Object.keys(manifest.entries).length;

        const newManifest: RemoteManifest = {
          schemaVersion: 1,
          generation: anythingChanged ? manifest.generation + 1 : manifest.generation,
          lastWriter: this.deviceStore.id,
          lastWriterLabel: this.deviceStore.label,
          updatedAt: Date.now(),
          entries: newEntries,
        };
        if (anythingChanged) {
          await remote.writeManifest(newManifest);
        } else {
          // keep generation, but reflect updatedAt for visibility
          newManifest.updatedAt = manifest.updatedAt || Date.now();
        }

        // Save local snapshot.
        await this.lastSynced.save({
          schemaVersion: 1,
          generation: newManifest.generation,
          syncedAt: newManifest.updatedAt,
          entries: { ...newEntries },
        });

        return {
          generation: newManifest.generation,
          took: Date.now() - t0,
          counts: plan.counts,
          conflictCopies,
          noChanges,
          deletesSkipped,
          selfHealedMissing: selfHealedMissing.length > 0 ? selfHealedMissing : undefined,
        };
      });
    } finally {
      await client.end();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────

  private async executeOp(
    client: SftpClient,
    adapter: DataAdapter,
    op: SyncOp,
    dirs: RemoteDirCache,
    newEntries: Record<string, ManifestEntry>,
    conflictCopies: string[],
  ): Promise<void> {
    switch (op.action) {
      case "push":
      case "restore-keep-local": {
        // Local has the truth; upload to remote.
        const buf = await readLocalAsBuffer(adapter, op.path);
        await uploadBuffer(client, this.settings.remoteRoot, op.path, buf, dirs);
        newEntries[op.path] = manifestEntryOf(op.local!);
        return;
      }

      case "pull":
      case "restore-keep-remote": {
        // Remote has the truth; download to local.
        const buf = await downloadToBuffer(client, this.settings.remoteRoot, op.path);
        await writeBufferToVault(adapter, op.path, buf);
        await this.scanner.refreshOne(op.path);
        // Use the freshly-rescanned local entry — sha1 must match remote, but mtime is now-local.
        const fresh = this.index.get(op.path);
        newEntries[op.path] = fresh ? manifestEntryOf(fresh) : { ...op.remote! };
        return;
      }

      case "delete-remote": {
        await deleteRemoteFile(client, this.settings.remoteRoot, op.path);
        // entry NOT added to newEntries
        return;
      }

      case "delete-local": {
        await deleteLocalFile(adapter, op.path);
        this.index.remove(op.path);
        // entry NOT added to newEntries
        return;
      }

      case "conflict": {
        await this.resolveConflict(client, adapter, op, dirs, newEntries, conflictCopies);
        return;
      }

      default:
        // skip / merge-converged / drop-from-snapshot handled by caller
        return;
    }
  }

  /**
   * Conflict resolution: keep the winner at `path`, save the loser as a conflict-copy.
   * Both files end up at both sides (local + server). Winner is the one with the newer mtime.
   */
  private async resolveConflict(
    client: SftpClient,
    adapter: DataAdapter,
    op: SyncOp,
    dirs: RemoteDirCache,
    newEntries: Record<string, ManifestEntry>,
    conflictCopies: string[],
  ): Promise<void> {
    const winnerIsLocal = op.winner === "local";
    const loserDeviceLabel = winnerIsLocal
      ? "remote" /* unknown — could be any device */
      : this.deviceStore.label;
    const copyPath = conflictCopyName(op.path, loserDeviceLabel, Date.now());
    conflictCopies.push(copyPath);

    if (winnerIsLocal) {
      // Local wins → keep local on `path`. Loser content (remote) becomes the conflict-copy.
      const remoteBuf = await downloadToBuffer(client, this.settings.remoteRoot, op.path);
      // Save loser locally as the conflict-copy.
      await writeBufferToVault(adapter, copyPath, remoteBuf);
      await this.scanner.refreshOne(copyPath);
      // Push conflict-copy to remote so other devices see it.
      await uploadBuffer(client, this.settings.remoteRoot, copyPath, remoteBuf, dirs);
      // Push winner (local) to remote (overwrite).
      const localBuf = await readLocalAsBuffer(adapter, op.path);
      await uploadBuffer(client, this.settings.remoteRoot, op.path, localBuf, dirs);

      newEntries[op.path] = manifestEntryOf(op.local!);
      const copyEntry = this.index.get(copyPath);
      if (copyEntry) newEntries[copyPath] = manifestEntryOf(copyEntry);
    } else {
      // Remote wins → keep remote on `path`. Loser content (local) becomes the conflict-copy.
      const localBuf = await readLocalAsBuffer(adapter, op.path);
      // Save loser locally as the conflict-copy.
      await writeBufferToVault(adapter, copyPath, localBuf);
      await this.scanner.refreshOne(copyPath);
      // Push conflict-copy to remote so other devices see it.
      await uploadBuffer(client, this.settings.remoteRoot, copyPath, localBuf, dirs);
      // Pull winner (remote) into local (overwrite).
      const remoteBuf = await downloadToBuffer(client, this.settings.remoteRoot, op.path);
      await writeBufferToVault(adapter, op.path, remoteBuf);
      await this.scanner.refreshOne(op.path);

      const winnerEntry = this.index.get(op.path);
      newEntries[op.path] = winnerEntry ? manifestEntryOf(winnerEntry) : { ...op.remote! };
      const copyEntry = this.index.get(copyPath);
      if (copyEntry) newEntries[copyPath] = manifestEntryOf(copyEntry);
    }
  }
}

function manifestEntryOf(e: { mtime: number; size: number; sha1: string }): ManifestEntry {
  return { mtime: e.mtime, size: e.size, sha1: e.sha1 };
}

/** Detect a "remote file missing" SFTP error across the various error shapes that ssh2 emits. */
function isRemoteFileMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "number" && e.code === 2 /* SFTP_STATUS_NO_SUCH_FILE */) return true;
  if (typeof e.code === "string" && (e.code === "ENOENT" || e.code === "ERR_NO_SUCH_FILE")) return true;
  const msg = String(e.message ?? "").toLowerCase();
  return msg.includes("no such file") || msg.includes("not found");
}

function emptyCounts(): SyncPlan["counts"] {
  return {
    push: 0, pull: 0,
    deleteRemote: 0, deleteLocal: 0,
    conflict: 0, restore: 0,
    converged: 0, skip: 0, dropped: 0,
    ioOps: 0,
  };
}
