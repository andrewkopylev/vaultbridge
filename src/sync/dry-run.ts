import type { App } from "obsidian";
import { SftpClient } from "../sftp/client";
import { RemoteState } from "../sftp/remote-state";
import { buildPlan, SyncPlan } from "./diff";
import type { IndexStore, IndexEntry } from "./index-store";
import type { LastSyncedStore } from "./last-synced";
import type { Scanner } from "./scanner";
import type { ExcludeMatcher } from "./exclude";
import type { DeviceStore } from "../state/device-store";
import type { KnownHostsStore } from "../state/known-hosts-store";
import type { SftpSyncSettings } from "../settings";

export interface DryRunReport {
  plan: SyncPlan;
  localCount: number;
  remoteCount: number;
  snapshotCount: number;
  remoteGeneration: number;
  snapshotGeneration: number;
}

/** Compute the sync plan without executing anything. Useful for diagnostics. */
export async function dryRun(
  _app: App,
  settings: SftpSyncSettings,
  deviceStore: DeviceStore,
  index: IndexStore,
  scanner: Scanner,
  exclude: ExcludeMatcher,
  lastSynced: LastSyncedStore,
  knownHosts: KnownHostsStore,
): Promise<DryRunReport> {
  await scanner.fullScan();

  const client = new SftpClient(settings, knownHosts);
  await client.connect();
  try {
    await client.ensureRemoteRoot();
    const remote = new RemoteState(
      client,
      settings.remoteRoot,
      deviceStore.id,
      deviceStore.label,
    );
    await remote.ensureSyncDir();

    const manifest = await remote.readManifest();
    const snapshot = lastSynced.snapshot;

    const localMap = new Map<string, IndexEntry>();
    for (const e of index.all) localMap.set(e.path, e);

    const plan = buildPlan(
      localMap,
      manifest.entries,
      snapshot.entries,
      (p) => exclude.isExcluded(p),
    );

    return {
      plan,
      localCount: localMap.size,
      remoteCount: Object.keys(manifest.entries).length,
      snapshotCount: Object.keys(snapshot.entries).length,
      remoteGeneration: manifest.generation,
      snapshotGeneration: snapshot.generation,
    };
  } finally {
    await client.end();
  }
}
