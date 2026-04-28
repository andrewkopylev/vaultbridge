// All paths returned here are vault-relative, suitable for app.vault.adapter.* calls.

export const PLUGIN_ID = "vault-bridge-sftp";

const STATE_DIR = `.obsidian/plugins/${PLUGIN_ID}/state`;

export const STATE_PATHS = {
  dir: STATE_DIR,
  index: `${STATE_DIR}/index.json`,
  lastSynced: `${STATE_DIR}/last-synced.json`,
  device: `${STATE_DIR}/device.json`,
  tmp: `${STATE_DIR}/tmp`,
  log: `${STATE_DIR}/log.jsonl`,
} as const;

/** Hard-coded path prefix that must NEVER be synced — recursion would corrupt the index. */
export const STATE_DIR_PREFIX = STATE_DIR + "/";
