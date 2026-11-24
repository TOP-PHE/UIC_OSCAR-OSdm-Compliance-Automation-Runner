#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0

# refresh-collection.sh — Moves the monorepo on the VPS to the latest release
# and, when the promotion names one, starts the server image it built.
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
# What the caller sends is data, never a command. sshd puts it in
# SSH_ORIGINAL_COMMAND; run by hand, it is the first argument. Accepted:
# nothing, this script's installed path, and either of those followed by one
# image digest (sha256: and 64 hex digits). Anything else is refused before
# anything moves.
#
# Behaviour:
#   - Fast-forwards the local clone to the latest release-* tag that is on
#     origin/main, never to main's head: the collection runs inside the
#     server's container, so what reaches it is what was released, not
#     whatever was last merged.
#   - With a digest (sent by promote-release.yml, behind the "production"
#     environment): pulls ghcr.io/top-phe/oscar-server@<digest>, writes it as
#     OSCAR_IMAGE_DIGEST in OSCAR_Deploy/.env, which docker-compose.yml
#     requires, and creates the server again from the compose files that made
#     the running one. Production runs that digest: no tag that a registry
#     can move decides what runs.
#   - Waits for the server to be healthy on that image, and fails when it is
#     not (the workflow then goes red).
#   - Logs to syslog so you can audit deploys with `journalctl -t oscar-deploy`.

set -euo pipefail

# OSCAR_REPO and the two timings exist for the tests. sshd passes no such
# variable to a key's command (no AcceptEnv for them, no PermitUserEnvironment).
REPO="${OSCAR_REPO:-/opt/OSCAR}"
HEALTH_WAIT_SECONDS="${OSCAR_HEALTH_WAIT_SECONDS:-300}"
HEALTH_POLL_SECONDS="${OSCAR_HEALTH_POLL_SECONDS:-5}"
INSTALLED=/usr/local/sbin/oscar-refresh-collection
IMAGE=ghcr.io/top-phe/oscar-server
DEPLOY_DIR="$REPO/OSCAR_Deploy"
ENV_FILE="$DEPLOY_DIR/.env"
LOG_TAG=oscar-deploy
CHECKOUT_COPY="$DEPLOY_DIR/scripts/refresh-collection.sh"
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

# ── What is asked ───────────────────────────────────────────────────────────
REQUEST="${1:-${SSH_ORIGINAL_COMMAND:-}}"
DIGEST=""
if [ -n "$REQUEST" ] && [ "$REQUEST" != "$INSTALLED" ]; then
  if [[ "$REQUEST" =~ ^($INSTALLED[[:space:]]+)?(sha256:[0-9a-f]{64})$ ]]; then
    DIGEST="${BASH_REMATCH[2]}"
  else
    # The request is not repeated: it is the caller's text.
    log "FAIL: the request is not an image digest (${#REQUEST} characters): refused, nothing moved."
    exit 2
  fi
fi

trap note_installed_copy EXIT

# ── The checkout ────────────────────────────────────────────────────────────
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
else
  CHANGED_FILES=$(git diff --name-only "$BEFORE" "$AFTER" | head -20 | tr '\n' ',' | sed 's/,$//')
  log "moved $BEFORE → $AFTER ($TAG; changed: $CHANGED_FILES)"
fi

if [ -z "$DIGEST" ]; then
  exit 0
fi

# ── The image ───────────────────────────────────────────────────────────────
# Docker and the .env file as this user when it may use both, else through
# sudo without a password; with neither, the log says so.
USE_SUDO=0
if docker info >/dev/null 2>&1 && [ -r "$ENV_FILE" ] && [ -w "$ENV_FILE" ]; then
  USE_SUDO=0
elif sudo -n true 2>/dev/null; then
  USE_SUDO=1
else
  log "FAIL: this user can use neither docker and $ENV_FILE nor sudo without a password: image $DIGEST not deployed."
  exit 1
fi
as_needed() { if [ "$USE_SUDO" = 1 ]; then sudo -n "$@"; else "$@"; fi; }

if ! as_needed test -f "$ENV_FILE"; then
  log "FAIL: no $ENV_FILE: image $DIGEST not deployed."
  exit 1
fi

# The compose files and project that made the running server: created again
# from the base file alone, it would lose what an overlay adds (the
# monitoring stack's volume, for one). installation-guide.md reads them the
# same way.
label() { as_needed docker inspect oscar --format "{{ index .Config.Labels \"$1\" }}" 2>/dev/null || true; }
FILES=$(label com.docker.compose.project.config_files)
PROJECT=$(label com.docker.compose.project)
if [ -z "$FILES" ] || [ -z "$PROJECT" ] || [ "$FILES" = "<no value>" ] || [ "$PROJECT" = "<no value>" ]; then
  log "FAIL: no running oscar container made by docker compose to take the compose files from: image $DIGEST not deployed (start it by hand, auto-deploy-setup.md)."
  exit 1
fi
COMPOSE_ARGS=(-p "$PROJECT")
IFS=, read -r -a FILE_LIST <<< "$FILES"
for f in "${FILE_LIST[@]}"; do
  if ! as_needed test -f "$f"; then
    log "FAIL: compose file $f, named by the running oscar container, is not there: image $DIGEST not deployed."
    exit 1
  fi
  COMPOSE_ARGS+=(-f "$f")
done
SERVICES=(oscar)
# The runner agent, when the isolated profile runs one, takes the same image.
if as_needed docker inspect oscar-runner >/dev/null 2>&1; then
  SERVICES+=(oscar-runner)
fi

PREVIOUS=$(as_needed grep -E '^OSCAR_IMAGE_DIGEST=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)

# OSCAR_IMAGE_DIGEST=<digest> in .env: the line replaced, else added on a
# line of its own. Only a checked digest ever reaches it.
set_digest() {
  if as_needed grep -qE '^OSCAR_IMAGE_DIGEST=' "$ENV_FILE"; then
    as_needed sed -i "s|^OSCAR_IMAGE_DIGEST=.*|OSCAR_IMAGE_DIGEST=$1|" "$ENV_FILE"
  else
    if [ -n "$(as_needed tail -c 1 "$ENV_FILE")" ]; then
      printf '\n' | as_needed tee -a "$ENV_FILE" >/dev/null
    fi
    printf 'OSCAR_IMAGE_DIGEST=%s\n' "$1" | as_needed tee -a "$ENV_FILE" >/dev/null
  fi
}

if ! as_needed docker pull --quiet "$IMAGE@$DIGEST" >/dev/null; then
  log "FAIL: docker pull $IMAGE@$DIGEST failed: nothing changed."
  exit 1
fi
WANT_ID=$(as_needed docker image inspect --format '{{.Id}}' "$IMAGE@$DIGEST")

set_digest "$DIGEST"
if ! (cd "$DEPLOY_DIR" && as_needed docker compose "${COMPOSE_ARGS[@]}" up -d --no-deps "${SERVICES[@]}"); then
  if [ -n "$PREVIOUS" ]; then
    set_digest "$PREVIOUS"
    log "FAIL: docker compose up failed for $DIGEST; .env names the previous image again ($PREVIOUS). Check the containers by hand."
  else
    log "FAIL: docker compose up failed for $DIGEST. Check the containers by hand."
  fi
  exit 1
fi
log "starting ${SERVICES[*]} on $IMAGE@$DIGEST (before: ${PREVIOUS:-none})"

# Healthy, on the image just pulled, within the wait.
WAITED=0
RUNNING_ID=""
STATE=""
while :; do
  RUNNING_ID=$(as_needed docker inspect --format '{{.Image}}' oscar 2>/dev/null || true)
  STATE=$(as_needed docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no health check{{end}}' oscar 2>/dev/null || true)
  if [ "$RUNNING_ID" = "$WANT_ID" ] && [ "$STATE" = "healthy" ]; then
    log "deployed $IMAGE@$DIGEST: oscar is healthy (after ${WAITED} s)"
    exit 0
  fi
  if [ "$WAITED" -ge "$HEALTH_WAIT_SECONDS" ]; then
    break
  fi
  sleep "$HEALTH_POLL_SECONDS"
  # A poll of 0 s (the tests) still ends.
  WAITED=$((WAITED + (HEALTH_POLL_SECONDS > 0 ? HEALTH_POLL_SECONDS : 1)))
done
if [ "$RUNNING_ID" != "$WANT_ID" ]; then
  log "FAIL: after ${HEALTH_WAIT_SECONDS} s, oscar does not run $IMAGE@$DIGEST."
else
  log "FAIL: oscar runs $IMAGE@$DIGEST but is not healthy after ${HEALTH_WAIT_SECONDS} s (${STATE:-no state})."
fi
exit 1
