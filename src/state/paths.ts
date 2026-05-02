// All paths returned here are vault-relative, suitable for app.vault.adapter.* calls.

export const PLUGIN_ID = "vault-bridge-sftp";

export interface PluginPaths {
  configDir: string;
  /** Per-device state directory; never synced. */
  stateDir: string;
  index: string;
  lastSynced: string;
  device: string;
  tmp: string;
  log: string;
  /** Hard-coded path prefix that must NEVER be synced — recursion would corrupt the index. */
  stateDirPrefix: string;
}

/** Build per-plugin paths rooted at the user's Obsidian config folder.
 *  Pass `app.vault.configDir` — Obsidian lets users rename ".obsidian", so this must be dynamic. */
export function pluginPaths(configDir: string): PluginPaths {
  const stateDir = `${configDir}/plugins/${PLUGIN_ID}/state`;
  return {
    configDir,
    stateDir,
    index: `${stateDir}/index.json`,
    lastSynced: `${stateDir}/last-synced.json`,
    device: `${stateDir}/device.json`,
    tmp: `${stateDir}/tmp`,
    log: `${stateDir}/log.jsonl`,
    stateDirPrefix: stateDir + "/",
  };
}
