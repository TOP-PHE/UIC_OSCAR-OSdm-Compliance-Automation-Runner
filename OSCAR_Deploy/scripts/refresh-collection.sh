#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

# refresh-collection.sh — Pulls the monorepo from origin/main on the VPS.
#
# Invoked exclusively by the refresh-collection.yml and promote-release.yml
# CI workflows over SSH. The matching authorized_keys entry on the VPS pins
# the deploy key to this script via command="...", so a leaked key cannot get
# a shell or run any other command.
#
# Installed once, by hand, OUTSIDE the checkout, as
# /usr/local/sbin/oscar-refresh-collection (see auto-deploy-setup.md, step 4,
# and "OSCAR - Server Hardening.md"), and that copy is the key's command. The
# script pulls the checkout it lives in: run from the checkout, a merge to
# main would change what the deploy key runs, as the `ubuntu` user, who has
# sudo. Re-copy it by hand only after reading it; when the checkout's version
# differs from the installed one, the script says so in its log.
#
# Behaviour:
#   - Fast-forwards the local clone to origin/main.
#   - Does NOT rebuild the OSCAR image (collection is bind-mounted; no
#     restart needed).
#   - Logs to syslog so you can audit deploys with `journalctl -t oscar-deploy`.

set -euo pipefail

REPO=/opt/OSCAR
LOG_TAG=oscar-deploy
CHECKOUT_COPY="$REPO/OSCAR_Deploy/scripts/refresh-collection.sh"
# Resolved before the `cd` below: $0 may be a relative path.
SELF=$(readlink -f "$0")

log() { logger -t "$LOG_TAG" -- "$1"; printf '%s\n' "$1"; }

# Says, after the pull, whether the installed copy is still the checkout's.
note_installed_copy() {
  if [ "$SELF" = "$(readlink -f "$CHECKOUT_COPY" || true)" ]; then
    log "NOTE: running from the checkout; install the copy outside it (auto-deploy-setup.md, step 4)."
  elif ! cmp -s "$SELF" "$CHECKOUT_COPY"; then
    log "NOTE: $CHECKOUT_COPY differs from the installed $SELF; read it, then copy it by hand."
  fi
}
trap note_installed_copy EXIT

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
