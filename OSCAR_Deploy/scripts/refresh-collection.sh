#!/usr/bin/env bash
# refresh-collection.sh — Pulls the monorepo from origin/main on the VPS.
#
# Invoked exclusively by the refresh-collection.yml CI workflow over SSH.
# The matching authorized_keys entry on the VPS pins the deploy key to this
# script via command="...refresh-collection.sh", so a leaked key cannot get
# a shell or run any other command.
#
# Behaviour:
#   - Fast-forwards the local clone to origin/main.
#   - Does NOT rebuild the OSCAR image (collection is bind-mounted; no
#     restart needed).
#   - Logs to syslog so you can audit deploys with `journalctl -t oscar-deploy`.

set -euo pipefail

REPO=/opt/OSCAR
LOG_TAG=oscar-deploy

log() { logger -t "$LOG_TAG" -- "$1"; printf '%s\n' "$1"; }

cd "$REPO"

# Refuse to run if there are local edits — we never overwrite manual changes
# silently. If you genuinely need to reset, do it interactively.
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "FAIL: local working tree is dirty in $REPO — refusing to pull."
  exit 1
fi

BEFORE=$(git rev-parse HEAD)
git pull --ff-only origin main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  log "no-op: already at $AFTER"
  exit 0
fi

CHANGED_FILES=$(git diff --name-only "$BEFORE" "$AFTER" | head -20 | tr '\n' ',' | sed 's/,$//')
log "pulled $BEFORE → $AFTER (changed: $CHANGED_FILES)"
