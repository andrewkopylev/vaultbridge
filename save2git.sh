#!/usr/bin/env bash
# save2git.sh — stage, commit, and push the current state of the plugin to GitHub.
# Usage:
#   ./save2git.sh                       # commit message defaults to "Update"
#   ./save2git.sh "Your commit message"
#
# Idempotent: safe to run repeatedly. Initializes git on first run, sets the remote,
# stages and commits if there are changes, and pushes to origin/main.

set -euo pipefail

REPO_URL="https://github.com/andrewkopylev/vaultbridge.git"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# 1. Init git if the repo doesn't exist yet.
if [ ! -d .git ]; then
  echo "→ Initializing git repository on branch 'main'…"
  git init -b main
fi

# 2. Configure or update the 'origin' remote.
if git remote get-url origin >/dev/null 2>&1; then
  CURRENT_URL="$(git remote get-url origin)"
  if [ "$CURRENT_URL" != "$REPO_URL" ]; then
    echo "→ Updating origin URL: $CURRENT_URL → $REPO_URL"
    git remote set-url origin "$REPO_URL"
  fi
else
  echo "→ Adding origin = $REPO_URL"
  git remote add origin "$REPO_URL"
fi

# 3. Stage everything respecting .gitignore (node_modules, main.js, data.json are excluded).
git add -A

# 4. Commit if there are staged changes.
if git diff --cached --quiet; then
  echo "→ Working tree clean — no new commit."
else
  MSG="${*:-Update}"
  echo "→ Committing: $MSG"
  git commit -m "$MSG"
fi

# 5. Push to origin/main. -u sets upstream on the first push; harmless thereafter.
echo "→ Pushing to origin/main…"
git push -u origin main

echo ""
echo "✓ Done. Repository: $REPO_URL"
