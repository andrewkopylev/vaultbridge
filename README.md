# Vault Bridge SFTP

Sync your Obsidian vault across desktops through **your own** SSH/SFTP server. No cloud, no proxy services, no subscriptions — your notes go straight between your machines and your server.

## What it does

A bidirectional sync engine for [Obsidian](https://obsidian.md/) vaults that uses SFTP/SSH as transport. It does proper 3-way diffing (so it can tell "you edited" from "they deleted"), preserves both versions on conflict, and protects you from catastrophic operations.

## Features

- **Bidirectional sync** with 3-way diff (local + remote manifest + last-synced snapshot). Pulls others' changes, pushes yours, in one operation.
- **Conflict-copy resolution** — when the same file was edited on two devices, both versions are kept. The newer mtime wins on the original path; the loser becomes `notes/foo (conflict from device-A 2026-04-28 14-30).md`.
- **Multi-device safe** — server-side lock prevents two devices syncing simultaneously; manifest generation counter detects out-of-order writes.
- **Bandwidth-efficient** — SHA-1 per file decides what actually changed; identical files are skipped.
- **Bulk-delete protection** — if a sync would delete more than 5% of files (or 20+), a modal lists them and offers Continue / Skip-deletes / Cancel.
- **Server-reset detection** — if the remote manifest is wiped (manual `rm`, server restored from backup), the plugin refuses to interpret that as "delete everything locally" and offers safe recovery options.
- **Self-heal** — if a file in the manifest is missing from the server's filesystem, the plugin drops the entry instead of crashing.
- **Auto-sync triggers** (all toggleable): on Obsidian start, on quit (push-only, best-effort), and after vault changes (debounced, default 10s).
- **Atomic transfers** — every upload and download goes through a temp file + rename, so an interrupted sync never corrupts a target.
- **Password or SSH key** authentication, with passphrase support.

## When to use this

Good fit if:
- You have your own server, VPS, NAS, or home machine reachable via SSH.
- You want multi-device sync without paying for Obsidian Sync.
- You don't want Dropbox / Google Drive / iCloud touching your notes.
- You want a transparent sync — open-source, plain JSON manifest, plain SHA-1 hashes; nothing proprietary.

Not a good fit if:
- You need mobile sync. Mobile Obsidian (iOS/Android) cannot open raw SSH sockets — this plugin is **desktop only**. Use Obsidian Sync or an OS-level sync (Syncthing) for mobile.
- You only have one device. Just back up your vault folder.
- You don't have an SSH server.

## Installation

### From source

```sh
git clone https://github.com/andrewkopylev/vaultbridge.git
cd vaultbridge
npm install
npm run build
./install.sh /path/to/your/vault
```

Then in Obsidian → Settings → Community plugins → enable **Vault Bridge SFTP**.

### Manual install (after a release is published)

1. Download `main.js` and `manifest.json` from the latest [release](https://github.com/andrewkopylev/vaultbridge/releases).
2. Create `<vault>/.obsidian/plugins/vault-bridge-sftp/` and place both files inside.
3. In Obsidian: Settings → Community plugins → enable **Vault Bridge SFTP**.

### From the Obsidian Community Plugin store

*Coming soon — see [RELEASING.md](RELEASING.md) for submission status.*

## Quick start

1. Open Settings → Vault Bridge SFTP.
2. Fill in:
   - **Host / Port / Username** — your SSH server.
   - **Authentication** — Password OR Private key (with optional passphrase).
   - **Remote root** — absolute path on the server, e.g. `/home/me/obsidian-vault`. Created if it doesn't exist.
3. Click **Test connection**. The plugin will create the remote root and an empty `.sync/` directory inside it.
4. Click **Sync now** (or `Ctrl+P → Vault Bridge: Sync now`). The first sync uploads your full vault — expect this to take a while; later syncs only transfer what actually changed.

## Settings reference

| Setting | Description |
|---|---|
| Host / Port / Username | SSH connection info. |
| Authentication | Password or Private key (with optional passphrase). No host fingerprint verification. |
| Remote root | Absolute path on the server. Created on first connect if missing. |
| Sync everything (`.obsidian` too) | When ON, plugins/themes/snippets/hotkeys are synced so all devices look identical. The plugin's own `state/` directory is always excluded regardless. Default: ON. |
| Sync workspace.json | When OFF, panel-layout files stay device-specific (recommended — turning it ON causes flapping when working on two devices at once). Default: OFF. |
| Exclude patterns | Gitignore-style. One per line. |
| Sync on startup | Run a full bidirectional sync after Obsidian loads. Default: ON. |
| Sync on quit | Best-effort push when Obsidian closes (5-second timeout, push-only — no prompts). Default: ON. |
| Sync after changes | Debounced sync triggered by vault edits. Default: ON. |
| Debounce delay | Seconds to wait after the last edit before auto-syncing. Default: 10. |
| Device label | Human-readable name used in conflict-copy filenames. Per-device, not synced. |

## Commands reference

All commands are accessible via Command Palette (`Ctrl+P` / `Cmd+P`):

### Daily use

| Command | What it does |
|---|---|
| `Vault Bridge: Sync now` | Bidirectional sync. Pulls changes, pushes yours, handles conflicts. The everyday command. Also bound to the ribbon icon and the status bar click. |
| `Vault Bridge: Test connection` | Verify SSH credentials and create remote root if missing. |

### One-way operations

| Command | What it does |
|---|---|
| `Vault Bridge: Pull from server` | Download additions and updates only. Never modifies the server. Useful for refreshing a fresh device. |
| `Vault Bridge: Force push everything` | Re-upload every local file regardless of remote state. Rewrites manifest. Use after manifest corruption. |
| `Vault Bridge: Force pull everything` | Re-download every file from the manifest, even if local sha1 matches. Use after local index corruption. |

### Maintenance

| Command | What it does |
|---|---|
| `Vault Bridge: Inspect remote state` | Show server-side manifest generation, file count, last writer, lock status. |
| `Vault Bridge: Force-release remote sync lock` | Release a stuck lock that belongs to *this* device (foreign locks are not touched). |
| `Vault Bridge: Rebuild remote manifest` | Walk the actual server filesystem, hash every file, rewrite the manifest. Use after manual file changes on the server. |
| `Vault Bridge: Reset local snapshot` | Wipe this device's "last sync" record. Next sync treats every local file as a fresh addition. |
| `Vault Bridge: Rebuild local index` | Force a re-scan and re-hash of every local file. |
| `Vault Bridge: Show index stats` | Quick stats: file count, total size, last full scan timestamp. |

## How sync works

The engine compares three sources for every path on every sync:

- **L** — local index (current vault state with SHA-1 hashes)
- **R** — remote manifest (`<remoteRoot>/.sync/manifest.json` on the server)
- **S** — last-synced snapshot (the manifest from the last successful sync, kept locally)

Decision matrix per path:

| L vs S | R vs S | Action |
|---|---|---|
| unchanged | unchanged | skip |
| changed / added | unchanged | push |
| unchanged | changed / added | pull |
| changed (same content as R) | changed (same content as L) | record, no I/O |
| changed | changed (different) | conflict-copy + winner by mtime |
| deleted | unchanged | delete on server |
| unchanged | deleted | delete locally |
| deleted | changed | restore from remote |
| changed | deleted | restore from local (push back) |
| deleted | deleted | drop from snapshot |

### Server-side metadata

In `<remoteRoot>/.sync/`:
- `manifest.json` — `{generation, entries: {path: {mtime, size, sha1}}}`. Each successful sync bumps `generation`.
- `lock.json` — held during a sync. Stale locks (>5 min) are taken automatically.

### Local per-device metadata

In `<vault>/.obsidian/plugins/vault-bridge-sftp/state/` (never synced):
- `index.json` — current local index
- `last-synced.json` — snapshot S
- `device.json` — per-device id and label

## Multi-device guide

### Adding a second device

1. On device A, install the plugin, fill in server settings, run **Sync now** to seed the server.
2. On device B (empty vault), install the plugin and fill in the same server settings.
3. On device B, run **Vault Bridge: Pull from server**. The vault gets populated.
4. From now on, run **Sync now** on either device. They stay in sync.

### Conflicts in practice

If both devices edit `notes/foo.md` before either has synced, the second to sync gets:
- `notes/foo.md` — winner (newer mtime)
- `notes/foo (conflict from device-XYZ 2026-04-28 14-30).md` — loser, preserved next to the original

You decide what to do (merge, keep one, etc.) in your editor.

## Recovery scenarios

### "I deleted a file directly on the server via SSH"

The manifest still has the entry, so the next sync sees nothing changed. To propagate the deletion:

1. Run **Vault Bridge: Rebuild remote manifest** — re-walks the server filesystem and rewrites the manifest based on reality.
2. Run **Sync now** — the diff now sees "remote deleted file", proposes deleting locally (bulk-delete modal will appear if many files).

### "I wiped the server folder by accident"

When the server manifest is empty (gen=0) but your local snapshot has gen > 0, the plugin detects this and shows the **Server Reset** dialog with three options:

- **Force push from local** — re-upload every file from this device, rebuild the manifest.
- **Reset snapshot** — clear this device's snapshot so the next sync treats local files as fresh additions.
- **Cancel** — investigate before doing anything.

This blocks the catastrophic "treat empty manifest as N deletions" path before the bulk-delete modal even runs.

### "Sync says lock is held by another device"

If a device crashed mid-sync, its lock will go stale after 5 minutes and the next sync will take it. To break it sooner, run **Force-release remote sync lock** *on the device that holds it* (foreign locks are intentionally untouched).

### "Local index seems wrong"

Run **Rebuild local index** — full re-scan and re-hash. Cheap on small vaults.

## Excluding files

Default soft excludes:
- `.trash/**` (Obsidian's local trash)
- `.obsidian/workspace.json`, `workspace-mobile.json` — only when "Sync workspace.json" is OFF (recommended)

Hardcoded excludes (cannot be turned off):
- `.obsidian/plugins/vault-bridge-sftp/state/**` — the plugin's own state. Recursive sync would corrupt the index.

You can add gitignore-style patterns in **Exclude patterns** in settings:

```
node_modules/**
*.tmp
private/secrets.md
```

## Security notes

- **Password is stored in plain text** in `data.json` inside the vault. If you sync `.obsidian` (the default), the password is pushed to the server too. Prefer SSH key authentication on shared machines.
- **No host fingerprint verification.** This plugin trusts whatever server is at the configured host:port. Use only on networks you control or via a VPN to mitigate man-in-the-middle risk.
- **No end-to-end encryption.** Files on the server are stored as-is. If you have sensitive notes, encrypt the server's filesystem.
- **`.sync/` directory is world-readable** by default. Lock down permissions if you store the vault on a multi-user server.

## Limitations

- **Desktop only** (`isDesktopOnly: true`). Mobile Obsidian cannot open raw SSH sockets.
- **No rename detection by hash yet.** A renamed large file is currently re-uploaded. Planned for a future release.
- **Conflict resolution by mtime** assumes device clocks are roughly in sync.
- **Single SFTP connection per sync** — operations are serial. For thousands of files, throughput is RTT-bound.
- **External edits to server files** (outside the plugin) require **Rebuild remote manifest** to re-establish consistency.

## Development

```sh
git clone https://github.com/andrewkopylev/vaultbridge.git
cd vaultbridge
npm install
npm run dev          # esbuild watch mode
npm run build        # production build → main.js
./install.sh <vault> # copy main.js + manifest.json into <vault>/.obsidian/plugins/vault-bridge-sftp/
```

Source layout:
```
src/
├── main.ts                    # plugin entry, command wiring, vault events, triggers
├── settings.ts                # settings schema + UI tab
├── sftp/
│   ├── client.ts              # ssh2-sftp-client wrapper
│   ├── remote-state.ts        # manifest + lock management on the server
│   └── transfer.ts            # atomic upload/download primitives
├── sync/
│   ├── diff.ts                # 3-way diff — pure function
│   ├── sync-engine.ts         # bidirectional orchestrator
│   ├── push-engine.ts         # one-way push (force-push)
│   ├── pull-engine.ts         # one-way pull (additive)
│   ├── manifest-rebuilder.ts  # walk server, hash, rewrite manifest
│   ├── exclude.ts             # gitignore-style matcher
│   ├── hash.ts                # sha1
│   ├── index-store.ts         # local file index
│   ├── last-synced.ts         # snapshot S
│   └── scanner.ts             # walk vault, build index
├── state/
│   ├── paths.ts               # state-dir path constants
│   └── device-store.ts        # per-device id/label
└── ui/
    ├── bulk-delete-modal.ts   # 5%/20-file deletion confirmation
    └── server-reset-modal.ts  # gen=0 vs S>0 recovery dialog
```

## License

MIT — see [LICENSE](LICENSE).
