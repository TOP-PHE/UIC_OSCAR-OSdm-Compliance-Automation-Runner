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
# SPACE. Only the database snapshot is copied first (in a temporary folder);
# the data files and reports are read where they are and go through tar and
# gpg straight into the archive. They are already encrypted, so the archive is
# about as large as the data: the free space needed is about the data's size
# plus the database's once more, plus OSCAR_BACKUP_MIN_FREE_MB left free. The
# script checks that before it starts and refuses otherwise, rather than fill
# the disk OSCAR writes to. The archive is written under a temporary name and
# renamed when complete, so a backup that stops leaves nothing that looks like
# an archive.
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
#   OSCAR_BACKUP_MIN_FREE_MB   free space to leave on the disk (default: 2048)
#   OSCAR_DATA_DIR             host path of data/   (override auto-discovery)
#   OSCAR_ENV_FILE             host path of .env    (override auto-discovery)
set -euo pipefail

CONT="${OSCAR_CONTAINER:-oscar}"
KEEP="${OSCAR_BACKUP_KEEP:-6}"
OUT_DIR="${OSCAR_BACKUP_DIR:-$HOME/oscar-backups}"
PASS_FILE="${OSCAR_BACKUP_PASSPHRASE_FILE:-}"
MIN_FREE_MB="${OSCAR_BACKUP_MIN_FREE_MB:-2048}"

log(){ printf '%s  %s\n' "$(date -Is)" "$*"; command -v logger >/dev/null 2>&1 && logger -t oscar-backup -- "$*" || true; }
die(){ log "FAIL: $*"; exit 1; }

# The Admin Dashboard's status (#572): metadata only, written at the end, ok or
# not. A failure to write it never fails the backup.
STATUS_SH="$(cd "$(dirname "$0")" && pwd)/oscar-backup-status.sh"
DATA_DIR=""
ARCHIVE=""
STAGE=""
PART=""
record_status(){
  local rc="$1" what=backup-failed
  [ -x "$STATUS_SH" ] || return 0
  [ "$rc" -eq 0 ] && [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] && what=backup-ok
  # data/ as found below, else the status script looks for it itself (a run
  # that failed before finding it is recorded too, when the container is up).
  if [ -n "$DATA_DIR" ] && [ -d "$DATA_DIR" ]; then export OSCAR_DATA_DIR="$DATA_DIR"; fi
  OSCAR_BACKUP_DIR="$OUT_DIR" OSCAR_BACKUP_KEEP="$KEEP" "$STATUS_SH" "$what" ${ARCHIVE:+"$ARCHIVE"} >/dev/null 2>&1 \
    || log "note: the Admin Dashboard status was not written"
  return 0
}
trap 'rc=$?; [ -n "$STAGE" ] && rm -rf "$STAGE"; [ -n "$PART" ] && rm -f "$PART"; record_status "$rc"' EXIT

case "$MIN_FREE_MB" in ''|*[!0-9]*) die "OSCAR_BACKUP_MIN_FREE_MB must be a number of MB" ;; esac

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
mkdir -p "$OUT_DIR" "$STAGE/data"

# --- 0) room for it, before anything is written ------------------------------
# The database once more in $STAGE, and an archive about as large as the data
# (the data files and reports are ciphertext: gzip does not shrink them).
kb_of(){ du -sk "$@" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }'; }
free_kb(){ df -Pk "$1" | awk 'NR == 2 { print $4 }'; }
room_for(){
  local dir="$1" need_kb="$2" have_kb
  have_kb="$(free_kb "$dir")"
  if [ $(( have_kb - need_kb )) -lt $(( MIN_FREE_MB * 1024 )) ]; then
    die "not enough free space: the backup needs about $(( need_kb / 1024 )) MB on the disk of $dir and leaves $MIN_FREE_MB MB free there (OSCAR_BACKUP_MIN_FREE_MB); $(( have_kb / 1024 )) MB are free. Move older archives off this host, or write elsewhere (OSCAR_BACKUP_DIR for the archive, TMPDIR for the database copy). Nothing was written."
  fi
}
FROM_DATA=()
for d in datafiles artifacts; do
  if [ -d "$DATA_DIR/$d" ]; then FROM_DATA+=("$d"); fi
done
log "measuring the data"
db_kb="$(kb_of "$DATA_DIR"/oscar.db*)"
files_kb=0
for d in "${FROM_DATA[@]}"; do files_kb=$(( files_kb + $(kb_of "$DATA_DIR/$d") )); done
if [ "$(stat -c %d "$STAGE")" = "$(stat -c %d "$OUT_DIR")" ]; then
  room_for "$OUT_DIR" $(( 2 * db_kb + files_kb ))
else
  room_for "$STAGE" "$db_kb"
  room_for "$OUT_DIR" $(( db_kb + files_kb ))
fi

# --- 1) consistent SQLite snapshot (online backup API) -----------------------
log "database snapshot: about $(( db_kb / 1024 )) MB"
sqlite3 "$DATA_DIR/oscar.db" ".backup '$STAGE/data/oscar.db'" || die "sqlite backup failed"

# --- 2) the data files and reports are read in place by tar (step 5): they
#        are ciphertext already, and a copy would need their size again.

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

# --- 5) tar + gpg (AES-256), streamed ----------------------------------------
# The same layout as ever (data/oscar.db, data/datafiles/, data/artifacts/,
# .env, manifest.json): the folders read in place are renamed under data/ in
# the archive. A folder OSCAR has not made yet goes in empty.
STAGED=(data/oscar.db .env manifest.json)
for d in datafiles artifacts; do
  if [ ! -d "$DATA_DIR/$d" ]; then mkdir -p "$STAGE/data/$d"; STAGED+=("data/$d"); fi
done
TAR_ARGS=(-C "$STAGE" "${STAGED[@]}")
if [ "${#FROM_DATA[@]}" -gt 0 ]; then
  TAR_ARGS+=(-C "$DATA_DIR" --transform 's,^\(datafiles\|artifacts\)\(/\|$\),data/\1\2,S' "${FROM_DATA[@]}")
fi
PART="$OUT_DIR/.oscar-backup-$TS.tar.gz.gpg.part"
log "writing the archive: about $(( (db_kb + files_kb) / 1024 )) MB to read"
# tar's own exit code is kept: 1 means a file changed while it was read (a run
# writing its report), which leaves the rest of the archive whole.
( umask 077
  { tar_rc=0; tar -czf - "${TAR_ARGS[@]}" || tar_rc=$?; echo "$tar_rc" > "$STAGE/tar.rc"; } \
    | gpg --batch --yes --symmetric --cipher-algo AES256 --compress-algo none --passphrase-file "$PASS_FILE" -o "$PART"
) || die "the archive could not be written (gpg, or the disk)"
tar_rc="$(cat "$STAGE/tar.rc" 2>/dev/null || echo unknown)"
case "$tar_rc" in
  0) ;;
  1) log "note: some files changed while they were read (a run was writing); the archive holds them as they were read" ;;
  *) die "tar failed (exit $tar_rc)" ;;
esac
ARCHIVE="$OUT_DIR/oscar-backup-$TS.tar.gz.gpg"
mv "$PART" "$ARCHIVE"
PART=""
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
