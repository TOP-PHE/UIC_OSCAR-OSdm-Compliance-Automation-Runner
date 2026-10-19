#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-backup-status.sh - what the Admin Dashboard shows of disaster recovery
# (issue #572).
#
# Writes data/backup-status.json, read by the server's read-only
# GET /v1/admin/backup-status. METADATA ONLY: dates, a size, counts, the
# frequency. Never a path, a file name, a host name, the passphrase or anything
# from the archive. The panel reflects the host's backups; it cannot start,
# change or download one (see #572), so nothing here is read back by a script.
#
#   oscar-backup-status.sh backup-ok <archive>   called by oscar-backup.sh
#   oscar-backup-status.sh backup-failed         called by oscar-backup.sh
#   oscar-backup-status.sh schedule              called by oscar-backup-schedule.sh
#   oscar-backup-status.sh drill [YYYY-MM-DD]    record a restore drill (by hand,
#                                                on this host, after a drill
#                                                elsewhere; default: today)
#   oscar-backup-status.sh show                  print the file
#
# Env (optional):
#   OSCAR_CONTAINER        container name (default: oscar), to find data/
#   OSCAR_DATA_DIR         host path of data/ (overrides the discovery)
#   OSCAR_BACKUP_DIR       where the archives are (default: ~/oscar-backups)
#   OSCAR_BACKUP_KEEP      how many archives are kept (default: 6)
#   OSCAR_BACKUP_TIMER_FILE  the systemd timer (default: /etc/systemd/system/oscar-backup.timer)
set -euo pipefail

CMD="${1:-show}"
CONT="${OSCAR_CONTAINER:-oscar}"
OUT_DIR="${OSCAR_BACKUP_DIR:-$HOME/oscar-backups}"
KEEP="${OSCAR_BACKUP_KEEP:-6}"
TIMER_FILE="${OSCAR_BACKUP_TIMER_FILE:-/etc/systemd/system/oscar-backup.timer}"

DATA_DIR="${OSCAR_DATA_DIR:-}"
if [ -z "$DATA_DIR" ] && command -v docker >/dev/null 2>&1; then
  DATA_DIR="$(docker inspect "$CONT" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)"
fi
[ -n "$DATA_DIR" ] && [ -d "$DATA_DIR" ] || { echo "oscar-backup-status: data dir not found; set OSCAR_DATA_DIR" >&2; exit 1; }
STATUS="$DATA_DIR/backup-status.json"

if [ "$CMD" = "show" ]; then
  if [ -f "$STATUS" ]; then cat "$STATUS"; else echo "no status yet"; fi
  exit 0
fi

# A value the file already holds (one key per line, as this script writes it).
prev(){
  local v=""
  [ -f "$STATUS" ] && v="$(sed -n "s/^  \"$1\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$STATUS" | head -1)"
  [ "$v" = "null" ] && v=""
  printf '%s' "$v"
}
iso(){ date -u -d "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true; }
now(){ date -u +%Y-%m-%dT%H:%M:%SZ; }
digits(){ case "$1" in ''|*[!0-9]*) echo "";; *) echo "$1";; esac; }

last_backup_at="$(prev last_backup_at)"
last_backup_ok="$(prev last_backup_ok)"
last_backup_size="$(prev last_backup_size_bytes)"
last_success_at="$(prev last_success_at)"
last_failure_at="$(prev last_failure_at)"
last_drill_at="$(prev last_restore_drill_at)"

case "$CMD" in
  backup-ok)
    ARCHIVE="${2:-}"
    [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] || { echo "usage: $(basename "$0") backup-ok <archive>" >&2; exit 2; }
    last_backup_at="$(now)"; last_success_at="$last_backup_at"; last_backup_ok=true
    last_backup_size="$(stat -c %s "$ARCHIVE" 2>/dev/null || wc -c < "$ARCHIVE" | tr -d ' ')" ;;
  backup-failed)
    last_backup_at="$(now)"; last_failure_at="$last_backup_at"; last_backup_ok=false; last_backup_size="" ;;
  schedule) ;;
  drill)
    day="${2:-$(date -u +%Y-%m-%d)}"
    case "$day" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "usage: $(basename "$0") drill [YYYY-MM-DD]" >&2; exit 2;; esac
    last_drill_at="$(iso "$day")"
    [ -n "$last_drill_at" ] || { echo "not a date: $day" >&2; exit 2; } ;;
  *) echo "usage: $(basename "$0") <backup-ok <archive>|backup-failed|schedule|drill [YYYY-MM-DD]|show>" >&2; exit 2 ;;
esac

# Frequency: what the timer says; no timer = on-demand.
frequency="on-demand"; next_run=""
if [ -f "$TIMER_FILE" ]; then
  cal="$(sed -n 's/^OnCalendar=//p' "$TIMER_FILE" | head -1)"
  case "$cal" in
    "*-*-* 02:30:00")     frequency="daily" ;;
    "Mon *-*-* 02:30:00") frequency="weekly" ;;
    "*-*-01 02:30:00")    frequency="monthly" ;;
    *)                    frequency="custom" ;;
  esac
  if command -v systemctl >/dev/null 2>&1; then
    raw="$(systemctl show oscar-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null || true)"
    [ -n "$raw" ] && [ "$raw" != "n/a" ] && next_run="$(iso "$raw")"
  fi
fi

archives=0
if [ -d "$OUT_DIR" ]; then
  archives="$(find "$OUT_DIR" -maxdepth 1 -name 'oscar-backup-*.tar.gz.gpg' -type f 2>/dev/null | wc -l | tr -d ' ')"
fi

str(){ if [ -n "$1" ]; then printf '"%s"' "$1"; else printf 'null'; fi; }
# Only a UTC instant as this script writes it is kept; anything else is null.
dt(){ case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) printf '"%s"' "$1";; *) printf 'null';; esac; }
num(){ local d; d="$(digits "$1")"; if [ -n "$d" ]; then printf '%s' "$d"; else printf 'null'; fi; }
bool(){ case "$1" in true|false) printf '%s' "$1";; *) printf 'null';; esac; }

TMP="$(mktemp "$DATA_DIR/.backup-status.XXXXXX")"
{
  printf '{\n'
  printf '  "format": 1,\n'
  printf '  "updated_at": %s,\n' "$(dt "$(now)")"
  printf '  "frequency": %s,\n' "$(str "$frequency")"
  printf '  "next_run": %s,\n' "$(dt "$next_run")"
  printf '  "retention_keep": %s,\n' "$(num "$KEEP")"
  printf '  "archives_present": %s,\n' "$(num "$archives")"
  printf '  "last_backup_at": %s,\n' "$(dt "$last_backup_at")"
  printf '  "last_backup_ok": %s,\n' "$(bool "$last_backup_ok")"
  printf '  "last_backup_size_bytes": %s,\n' "$(num "$last_backup_size")"
  printf '  "last_success_at": %s,\n' "$(dt "$last_success_at")"
  printf '  "last_failure_at": %s,\n' "$(dt "$last_failure_at")"
  printf '  "last_restore_drill_at": %s\n' "$(dt "$last_drill_at")"
  printf '}\n'
} > "$TMP"
chmod 644 "$TMP"
mv -f "$TMP" "$STATUS"
