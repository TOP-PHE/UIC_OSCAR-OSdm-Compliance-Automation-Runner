#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-restore.sh - Disaster-recovery restore (issue #543, tracker S13.1).
#
# Brings OSCAR back on THIS host from one encrypted backup archive produced by
# oscar-backup.sh. Intended for a fresh or secondary VPS that already has
# Docker + the compose plugin, git, gpg (see the DR runbook for provisioning).
#
# What it does:
#   1. decrypts + extracts the archive (needs the SAME passphrase),
#   2. clones the monorepo at the archive's release tag (code + Bruno_Collection
#      + compose) if it is not already present,
#   3. drops the restored data/ (oscar.db, datafiles, artifacts) and .env into
#      the compose directory,
#   4. (optional) rewrites ALLOWED_ORIGINS / ALLOWED_REDIRECT_HOSTS for a drill
#      hostname,
#   5. docker compose up -d, waits for /health, and prints the expected counts.
#
# Because the archive restores the SAME ENCRYPTION_KEY, every user can log in
# (bcrypt hashes) AND test (their OSDM credentials and datafiles decrypt).
#
# Usage:
#   OSCAR_BACKUP_PASSPHRASE_FILE=~/.oscar-backup-pass \
#     ./oscar-restore.sh oscar-backup-YYYYMMDD-HHMMSS.tar.gz.gpg [--hostname drill.example] [--force]
set -euo pipefail
umask 022   # anything this script writes must stay readable/traversable by the container user

ARCHIVE="${1:-}"
[ $# -gt 0 ] && shift || true
REPO="${OSCAR_REPO:-/opt/OSCAR}"
PASS_FILE="${OSCAR_BACKUP_PASSPHRASE_FILE:-}"
REMOTE="${OSCAR_GIT_REMOTE:-https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git}"
HOSTNAME_OVERRIDE=""
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_OVERRIDE="${2:-}"; shift 2;;
    --force)    FORCE=1; shift;;
    --repo)     REPO="${2:-}"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

log(){ printf '%s  %s\n' "$(date -Is)" "$*"; }
die(){ log "FAIL: $*"; exit 1; }
json_get(){ grep -oE "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[0-9]+)" "$2" | head -1 | sed -E 's/.*:[[:space:]]*"?([^"]*)"?$/\1/'; }

[ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || die "usage: oscar-restore.sh <archive.tar.gz.gpg> [--hostname H] [--force]"
command -v docker >/dev/null 2>&1 || die "docker not installed (provision the host first - see the DR runbook)"
command -v git    >/dev/null 2>&1 || die "git not installed"
command -v gpg    >/dev/null 2>&1 || die "gpg not installed"
[ -n "$PASS_FILE" ] && [ -f "$PASS_FILE" ] || die "set OSCAR_BACKUP_PASSPHRASE_FILE to the 0600 passphrase file"

# Safety: never silently overwrite a running OSCAR (e.g. by mistake on prod).
if [ "$FORCE" -ne 1 ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx oscar; then
  die "an 'oscar' container is already running here. This would overwrite it. Re-run with --force only for a drill/failover."
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- 1) decrypt + extract ----------------------------------------------------
log "decrypting archive ..."
gpg --batch --yes --decrypt --passphrase-file "$PASS_FILE" -o "$STAGE/backup.tar.gz" "$ARCHIVE" || die "decryption failed (wrong passphrase or corrupt archive)"
tar -C "$STAGE" -xzf "$STAGE/backup.tar.gz"
[ -f "$STAGE/manifest.json" ] && [ -f "$STAGE/.env" ] && [ -f "$STAGE/data/oscar.db" ] || die "archive is missing expected contents"
REL_TAG="$(json_get release_tag "$STAGE/manifest.json")"; [ -n "$REL_TAG" ] || REL_TAG="unknown"
EXP_USERS="$(json_get users "$STAGE/manifest.json")"
EXP_COMPANIES="$(json_get companies "$STAGE/manifest.json")"
log "manifest: release=$REL_TAG users=$EXP_USERS companies=$EXP_COMPANIES"

# --- 2) repo clone at the matching release tag -------------------------------
if [ ! -d "$REPO/.git" ]; then
  log "cloning $REMOTE into $REPO ..."
  sudo mkdir -p "$REPO" && sudo chown "$(id -u):$(id -g)" "$REPO"
  git clone --quiet "$REMOTE" "$REPO"
fi
git -C "$REPO" fetch --tags --quiet origin || true
if [ "$REL_TAG" != "unknown" ] && git -C "$REPO" rev-parse -q --verify "refs/tags/$REL_TAG" >/dev/null 2>&1; then
  git -C "$REPO" checkout --quiet "$REL_TAG"
  log "checked out $REL_TAG"
else
  git -C "$REPO" checkout --quiet main && git -C "$REPO" reset --hard origin/main 2>/dev/null || true
  log "release tag unavailable - using main"
fi

COMPOSE_DIR="$REPO/OSCAR_Deploy"
[ -f "$COMPOSE_DIR/docker-compose.yml" ] || die "compose file not found at $COMPOSE_DIR"

# --- 3) place restored data + .env into the compose dir ----------------------
mkdir -p "$COMPOSE_DIR/data"
rm -rf "$COMPOSE_DIR/data/oscar.db" "$COMPOSE_DIR/data/datafiles" "$COMPOSE_DIR/data/artifacts"
cp -a "$STAGE/data/oscar.db"   "$COMPOSE_DIR/data/oscar.db"
cp -a "$STAGE/data/datafiles"  "$COMPOSE_DIR/data/datafiles"
cp -a "$STAGE/data/artifacts"  "$COMPOSE_DIR/data/artifacts"
cp -a "$STAGE/.env"            "$COMPOSE_DIR/.env"
chmod 600 "$COMPOSE_DIR/.env"

# --- 4) drill hostname -------------------------------------------------------
if [ -n "$HOSTNAME_OVERRIDE" ]; then
  for k in ALLOWED_ORIGINS ALLOWED_REDIRECT_HOSTS; do
    val="$HOSTNAME_OVERRIDE"; [ "$k" = "ALLOWED_ORIGINS" ] && val="https://$HOSTNAME_OVERRIDE"
    if grep -q "^$k=" "$COMPOSE_DIR/.env"; then
      sed -i -E "s|^$k=.*|$k=$val|" "$COMPOSE_DIR/.env"
    else
      printf '%s=%s\n' "$k" "$val" >> "$COMPOSE_DIR/.env"
    fi
  done
  log "drill hostname set: $HOSTNAME_OVERRIDE (ALLOWED_ORIGINS/ALLOWED_REDIRECT_HOSTS)"
fi

# --- 4b) ownership / permissions the container needs -------------------------
# The container runs as a non-root user that owns the restored files (the backup
# preserved its uid). A root-run restore, or a strict umask on the clone, would
# otherwise leave the data DIR root-owned and the collection unreadable, so the
# app cannot open the DB ("unable to open database file") or read the collection
# (version chip "unknown", runs fail). Realign the data dir to the restored DB's
# owner, and make the bind-mounted collection + matrix world-readable (public
# content). Idempotent; best-effort when not run as root.
DB_OWNER="$(stat -c '%u:%g' "$COMPOSE_DIR/data/oscar.db" 2>/dev/null || echo '')"
if [ -n "$DB_OWNER" ]; then
  chown -R "$DB_OWNER" "$COMPOSE_DIR/data" 2>/dev/null || log "WARN: could not chown $COMPOSE_DIR/data to $DB_OWNER (run restore as root)"
fi
chmod 755 "$COMPOSE_DIR/data" 2>/dev/null || true
chmod -R a+rX "$REPO/Bruno_Collection" "$REPO/compatibility.json" 2>/dev/null || true

# --- 5) bring up -------------------------------------------------------------
log "starting OSCAR ..."
( cd "$COMPOSE_DIR" && docker compose pull --quiet 2>/dev/null; docker compose up -d )

# --- 6) health + verify ------------------------------------------------------
PORT="$(grep -E '^PORT=' "$COMPOSE_DIR/.env" | head -1 | cut -d= -f2 | tr -d ' ')"; PORT="${PORT:-3001}"
log "waiting for /health on 127.0.0.1:$PORT ..."
H=""
for _ in $(seq 1 90); do
  H="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [ -n "$H" ] && break
  sleep 2
done
[ -n "$H" ] || die "no /health response after ~180s - check: (cd $COMPOSE_DIR && docker compose logs --tail=50)"
echo "$H" | grep -q '"status":"ok"' || die "health not ok: $H"
log "HEALTH OK: $H"
log "RESTORE COMPLETE. Expected users=$EXP_USERS companies=$EXP_COMPANIES."
log "Users can log in (bcrypt hashes restored) and test (same ENCRYPTION_KEY restored)."
log "Browser access on a drill host: front with nginx+TLS for the hostname, or SSH-tunnel 127.0.0.1:$PORT. See the DR runbook."
