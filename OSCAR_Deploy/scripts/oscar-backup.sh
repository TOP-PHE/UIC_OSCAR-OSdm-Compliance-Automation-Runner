#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-backup.sh - Disaster-recovery backup (issue #543, tracker S13.1).
#
# Produces ONE self-contained, encrypted archive of everything OSCAR needs to
# come back on another host:
#   - a consistent snapshot of the SQLite DB (users, companies, frameworks,
#     findings, run history) taken with SQLite's online-backup API (safe on a
#     live DB - no container stop, no torn copy),
#   - data/datafiles/  (per-company scenarios, already AES-256-GCM at rest),
#   - data/artifacts/  (past run reports, already encrypted at rest),
#   - the .env          (so ENCRYPTION_KEY travels with the data - see SECURITY),
#   - a manifest.json   (versions, schema_version, counts, for restore checks).
# The tar is then symmetrically encrypted with GnuPG (AES-256). The passphrase
# is read from a file and is NEVER written into the archive.
#
# SECURITY. The archive is self-contained (it holds .env, i.e. ENCRYPTION_KEY),
# so it is a crown-jewel: its only protection is the GPG passphrase. Therefore:
#   - keep the passphrase ONLY in a password manager (and in the 0600 pass file
#     this script reads); never beside the archive,
#   - move the archive OFF this host immediately (a backup that lives only on
#     the box it backs up dies with the box). This script reminds you how.
#
# Paths are AUTO-DISCOVERED from the running container (the host location of the
# /app/data bind-mount and the compose working dir), so this works regardless of
# where the deployment lives. Override with env vars if the container is down.
#
# Usage:
#   OSCAR_BACKUP_PASSPHRASE_FILE=/root/.oscar-backup-pass ./oscar-backup.sh
# Env (all optional except the passphrase file):
#   OSCAR_CONTAINER            container name                 (default: oscar)
#   OSCAR_BACKUP_PASSPHRASE_FILE  0600 file holding the passphrase (REQUIRED)
#   OSCAR_BACKUP_DIR           where to write archives        (default: ~/oscar-backups)
#   OSCAR_BACKUP_KEEP          how many archives to retain    (default: 6)
#   OSCAR_DATA_DIR             host path of data/   (override auto-discovery)
#   OSCAR_ENV_FILE             host path of .env    (override auto-discovery)
set -euo pipefail

CONT="${OSCAR_CONTAINER:-oscar}"
KEEP="${OSCAR_BACKUP_KEEP:-6}"
OUT_DIR="${OSCAR_BACKUP_DIR:-$HOME/oscar-backups}"
PASS_FILE="${OSCAR_BACKUP_PASSPHRASE_FILE:-}"

log(){ printf '%s  %s\n' "$(date -Is)" "$*"; command -v logger >/dev/null 2>&1 && logger -t oscar-backup -- "$*" || true; }
die(){ log "FAIL: $*"; exit 1; }

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not installed - run: sudo apt-get install -y sqlite3"
command -v gpg     >/dev/null 2>&1 || die "gpg not installed - run: sudo apt-get install -y gnupg"
command -v docker  >/dev/null 2>&1 || die "docker not found"
[ -n "$PASS_FILE" ] && [ -f "$PASS_FILE" ] || die "set OSCAR_BACKUP_PASSPHRASE_FILE to a 0600 file holding the backup passphrase"

# --- discover data dir and .env from the running container -------------------
DATA_DIR="${OSCAR_DATA_DIR:-}"
ENV_FILE="${OSCAR_ENV_FILE:-}"
if [ -z "$DATA_DIR" ] || [ -z "$ENV_FILE" ]; then
  docker inspect "$CONT" >/dev/null 2>&1 || die "container '$CONT' not found; set OSCAR_DATA_DIR and OSCAR_ENV_FILE to back up while it is down"
  [ -z "$DATA_DIR" ] && DATA_DIR="$(docker inspect "$CONT" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}')"
  if [ -z "$ENV_FILE" ]; then
    WD="$(docker inspect "$CONT" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
    [ -n "$WD" ] && ENV_FILE="$WD/.env"
  fi
fi
[ -n "$DATA_DIR" ] && [ -f "$DATA_DIR/oscar.db" ] || die "could not locate data dir (oscar.db); set OSCAR_DATA_DIR"
[ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ] || die "could not locate .env; set OSCAR_ENV_FILE"
log "data dir : $DATA_DIR"
log ".env     : $ENV_FILE"

TS="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUT_DIR" "$STAGE/data"

# --- 1) consistent SQLite snapshot (online backup API) -----------------------
sqlite3 "$DATA_DIR/oscar.db" ".backup '$STAGE/data/oscar.db'" || die "sqlite backup failed"

# --- 2) encrypted-at-rest artefacts, copied verbatim (they are ciphertext) ---
if [ -d "$DATA_DIR/datafiles" ]; then cp -a "$DATA_DIR/datafiles" "$STAGE/data/"; else mkdir -p "$STAGE/data/datafiles"; fi
if [ -d "$DATA_DIR/artifacts" ]; then cp -a "$DATA_DIR/artifacts" "$STAGE/data/"; else mkdir -p "$STAGE/data/artifacts"; fi

# --- 3) .env (holds ENCRYPTION_KEY - archive is encrypted, see SECURITY) ------
cp -a "$ENV_FILE" "$STAGE/.env"

# --- 4) manifest -------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "$ENV_FILE")/.." 2>/dev/null && pwd || echo "")"
coll_ver="unknown"; rel_tag="unknown"
[ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/Bruno_Collection/VERSION" ] && coll_ver="$(tr -d ' \n' < "$REPO_DIR/Bruno_Collection/VERSION")"
[ -n "$REPO_DIR" ] && rel_tag="$(git -C "$REPO_DIR" describe --tags --match 'release-*' --abbrev=0 2>/dev/null || echo unknown)"
schema_ver="$(sqlite3 "$STAGE/data/oscar.db" 'SELECT MAX(version) FROM schema_version' 2>/dev/null || echo unknown)"
users="$(sqlite3 "$STAGE/data/oscar.db" 'SELECT COUNT(*) FROM users' 2>/dev/null || echo 0)"
companies="$(sqlite3 "$STAGE/data/oscar.db" 'SELECT COUNT(*) FROM companies' 2>/dev/null || echo 0)"
health_ver="$(docker exec "$CONT" sh -c 'echo "${npm_package_version:-}"' 2>/dev/null || true)"
printf '{\n  "created_at": "%s",\n  "release_tag": "%s",\n  "collection_version": "%s",\n  "schema_version": "%s",\n  "users": %s,\n  "companies": %s\n}\n' \
  "$(date -Is)" "$rel_tag" "$coll_ver" "$schema_ver" "$users" "$companies" > "$STAGE/manifest.json"

# --- 5) tar + gpg (AES-256) --------------------------------------------------
PLAIN="$STAGE/oscar-backup-$TS.tar.gz"
tar -C "$STAGE" -czf "$PLAIN" data .env manifest.json
ARCHIVE="$OUT_DIR/oscar-backup-$TS.tar.gz.gpg"
gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" -o "$ARCHIVE" "$PLAIN"
chmod 600 "$ARCHIVE"
sha256sum "$ARCHIVE" | awk '{print $1}' > "$ARCHIVE.sha256"
log "backup OK: $(basename "$ARCHIVE")  size=$(du -h "$ARCHIVE" | cut -f1)  users=$users companies=$companies schema=$schema_ver release=$rel_tag"

# --- 6) retention: keep the newest $KEEP ------------------------------------
# shellcheck disable=SC2012
ls -1t "$OUT_DIR"/oscar-backup-*.tar.gz.gpg 2>/dev/null | tail -n +"$((KEEP+1))" | while IFS= read -r old; do
  rm -f "$old" "$old.sha256"; log "pruned: $(basename "$old")"
done

HOST="$(hostname -f 2>/dev/null || hostname)"
log "OFF-HOST: move this archive off the box now (it is not safe to keep only here)."
log "   from your PC:  scp <user>@$HOST:$ARCHIVE ."
