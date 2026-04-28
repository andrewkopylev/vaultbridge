#!/usr/bin/env bash
# install.sh — copy the built plugin into an Obsidian vault.
# Usage:
#   ./install.sh /path/to/your/vault
#
# Copies main.js and manifest.json into <vault>/.obsidian/plugins/vault-bridge-sftp/.
# Existing data.json (your settings) and state/ (index, snapshot, deviceId) are preserved.

set -euo pipefail

PLUGIN_ID="vault-bridge-sftp"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

VAULT="${1:-}"
if [ -z "$VAULT" ]; then
  cat <<EOF
Usage: $0 <vault-path>

Example:
  $0 /home/user/Documents/MyVault

Copies main.js + manifest.json into:
  <vault>/.obsidian/plugins/$PLUGIN_ID/

Preserves: data.json, state/.
Removes any stale symlinks at the destination.
EOF
  exit 1
fi

VAULT="${VAULT%/}"  # strip trailing slash

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "Error: '$VAULT' does not look like an Obsidian vault (no .obsidian/ folder)." >&2
  exit 1
fi

if [ ! -f "$SRC_DIR/main.js" ]; then
  echo "Error: main.js not found at $SRC_DIR." >&2
  echo "Run 'npm run build' first." >&2
  exit 1
fi

if [ ! -f "$SRC_DIR/manifest.json" ]; then
  echo "Error: manifest.json not found at $SRC_DIR." >&2
  exit 1
fi

DEST_DIR="$VAULT/.obsidian/plugins/$PLUGIN_ID"
mkdir -p "$DEST_DIR"

# Replace any existing main.js / manifest.json (file or symlink). data.json + state/ stay put.
[ -e "$DEST_DIR/main.js" ] && rm -f "$DEST_DIR/main.js"
[ -e "$DEST_DIR/manifest.json" ] && rm -f "$DEST_DIR/manifest.json"

cp "$SRC_DIR/main.js" "$DEST_DIR/main.js"
cp "$SRC_DIR/manifest.json" "$DEST_DIR/manifest.json"

echo "✓ Installed Vault Bridge SFTP into:"
echo "  $DEST_DIR"
echo ""
echo "If Obsidian is currently running, reload the plugin:"
echo "  Settings → Community plugins → toggle Vault Bridge SFTP off, then on."
