import type { ManifestEntry } from "../sftp/remote-state";
import type { IndexEntry } from "./index-store";

export type SideChange = "unchanged" | "added" | "modified" | "deleted";

export type ActionType =
  | "skip"                  // both unchanged → no work, entry preserved in new manifest
  | "push"                  // local newer/added, remote unchanged → upload
  | "pull"                  // remote newer/added, local unchanged → download
  | "delete-remote"         // local deleted, remote unchanged → delete on server
  | "delete-local"          // remote deleted, local unchanged → delete locally
  | "conflict"              // both changed differently → conflict-copy + winner installed
  | "restore-keep-remote"   // local deleted, remote also changed → bring remote back locally
  | "restore-keep-local"    // remote deleted, local also changed → push local back
  | "merge-converged"       // both changed to identical content → just update snapshot
  | "drop-from-snapshot";   // both deleted → remove from snapshot

export interface SyncOp {
  path: string;
  action: ActionType;
  localState: SideChange;
  remoteState: SideChange;
  local?: IndexEntry;
  remote?: ManifestEntry;
  snapshot?: ManifestEntry;
  /** For action=conflict only: who wins by mtime (kept on `path`, loser becomes a conflict-copy). */
  winner?: "local" | "remote";
}

export interface PlanCounts {
  push: number;
  pull: number;
  deleteRemote: number;
  deleteLocal: number;
  conflict: number;
  restore: number;
  converged: number;
  skip: number;
  dropped: number;
  /** push + pull + delete* + conflict + restore — work that involves remote/local I/O. */
  ioOps: number;
}

export interface SyncPlan {
  ops: SyncOp[];
  counts: PlanCounts;
}

function classify(currentHash: string | undefined, snapshotHash: string | undefined): SideChange {
  if (currentHash !== undefined && snapshotHash !== undefined) {
    return currentHash === snapshotHash ? "unchanged" : "modified";
  }
  if (currentHash !== undefined) return "added";
  if (snapshotHash !== undefined) return "deleted";
  return "unchanged"; // not in current, not in snapshot — nothing to do
}

/**
 * 3-way diff: produce per-path actions from local index, remote manifest, and last-synced snapshot.
 * Pure function — no I/O.
 */
export function buildPlan(
  local: Map<string, IndexEntry>,
  remote: Record<string, ManifestEntry>,
  snapshot: Record<string, ManifestEntry>,
  isExcluded: (path: string) => boolean,
): SyncPlan {
  const allPaths = new Set<string>();
  for (const k of local.keys()) allPaths.add(k);
  for (const k of Object.keys(remote)) allPaths.add(k);
  for (const k of Object.keys(snapshot)) allPaths.add(k);

  const ops: SyncOp[] = [];
  const counts: PlanCounts = {
    push: 0, pull: 0,
    deleteRemote: 0, deleteLocal: 0,
    conflict: 0, restore: 0,
    converged: 0, skip: 0, dropped: 0,
    ioOps: 0,
  };

  for (const path of allPaths) {
    if (isExcluded(path)) continue;

    const lEntry = local.get(path);
    const rEntry = remote[path];
    const sEntry = snapshot[path];

    const localState = classify(lEntry?.sha1, sEntry?.sha1);
    const remoteState = classify(rEntry?.sha1, sEntry?.sha1);

    let action: ActionType = "skip";
    let winner: "local" | "remote" | undefined;

    if (localState === "unchanged" && remoteState === "unchanged") {
      action = "skip";
    } else if (localState === "deleted" && remoteState === "deleted") {
      action = "drop-from-snapshot";
    } else if ((localState === "added" || localState === "modified") && remoteState === "unchanged") {
      action = "push";
    } else if ((remoteState === "added" || remoteState === "modified") && localState === "unchanged") {
      action = "pull";
    } else if (localState === "deleted" && remoteState === "unchanged") {
      action = "delete-remote";
    } else if (remoteState === "deleted" && localState === "unchanged") {
      action = "delete-local";
    } else if (
      (localState === "added" || localState === "modified") &&
      (remoteState === "added" || remoteState === "modified")
    ) {
      if (lEntry && rEntry && lEntry.sha1 === rEntry.sha1) {
        action = "merge-converged";
      } else {
        const lMtime = lEntry?.mtime ?? 0;
        const rMtime = rEntry?.mtime ?? 0;
        winner = lMtime >= rMtime ? "local" : "remote";
        action = "conflict";
      }
    } else if (localState === "deleted" && (remoteState === "added" || remoteState === "modified")) {
      action = "restore-keep-remote";
    } else if ((localState === "added" || localState === "modified") && remoteState === "deleted") {
      action = "restore-keep-local";
    }

    ops.push({
      path, action, localState, remoteState,
      local: lEntry, remote: rEntry, snapshot: sEntry,
      winner,
    });

    switch (action) {
      case "push": counts.push++; counts.ioOps++; break;
      case "pull": counts.pull++; counts.ioOps++; break;
      case "delete-remote": counts.deleteRemote++; counts.ioOps++; break;
      case "delete-local": counts.deleteLocal++; counts.ioOps++; break;
      case "conflict": counts.conflict++; counts.ioOps++; break;
      case "restore-keep-remote":
      case "restore-keep-local": counts.restore++; counts.ioOps++; break;
      case "merge-converged": counts.converged++; break;
      case "drop-from-snapshot": counts.dropped++; break;
      default: counts.skip++; break;
    }
  }

  return { ops, counts };
}

/** Build a conflict-copy filename: `notes/foo.md` → `notes/foo (conflict from <device> 2026-04-28 14-30).md`. */
export function conflictCopyName(path: string, fromDevice: string, ts: number): string {
  const d = new Date(ts);
  const stamp =
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
    `${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}`;
  const slashIdx = path.lastIndexOf("/");
  const dotIdx = path.lastIndexOf(".");
  if (dotIdx > slashIdx && dotIdx !== -1) {
    return `${path.substring(0, dotIdx)} (conflict from ${fromDevice} ${stamp})${path.substring(dotIdx)}`;
  }
  return `${path} (conflict from ${fromDevice} ${stamp})`;
}
