#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

# refresh-collection.sh — Moves the monorepo on the VPS to the latest release.
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
#   - Fast-forwards the local clone to the latest release-* tag that is on
#     origin/main, never to main's head: the collection runs inside the
#     server's container, so what reaches it is what was released (a release
#     tag is pushed by the release workflow, behind the "production"
#     environment), not whatever was last merged.
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
# A failed fetch is said, not silent (its output is kept for that: a tag that moved
# on the remote is refused, "would clobber existing tag").
if ! FETCH_OUT=$(git fetch --tags origin main 2>&1); then
  log "FAIL: git fetch failed — nothing deployed: $(printf '%s' "$FETCH_OUT" | tr '\n' ' ' | cut -c1-400)"
  exit 1
fi
# The newest release tag that main holds (release-YYYY.NNN, by version order).
TAG=$(git tag --list 'release-*' --merged origin/main --sort=-v:refname | grep -E '^release-[0-9]{4}\.[0-9]+$' | head -n 1 || true)
if [ -z "$TAG" ]; then
  log "FAIL: no release tag on origin/main — nothing deployed."
  exit 1
fi
git merge --ff-only --quiet "refs/tags/$TAG"
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  log "no-op: already at $AFTER ($TAG)"
  exit 0
fi

CHANGED_FILES=$(git diff --name-only "$BEFORE" "$AFTER" | head -20 | tr '\n' ',' | sed 's/,$//')
log "moved $BEFORE → $AFTER ($TAG; changed: $CHANGED_FILES)"
