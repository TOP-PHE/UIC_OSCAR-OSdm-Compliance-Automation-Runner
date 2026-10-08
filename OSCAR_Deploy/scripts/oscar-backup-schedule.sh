#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-backup-schedule.sh - choose the DR backup frequency (issue #543).
#
# Installs (or removes) a systemd timer that runs oscar-backup.sh at the chosen
# cadence. Run it as the user that can reach Docker and the data dir (the deploy
# user), with sudo available for writing the systemd units.
#
#   oscar-backup-schedule.sh daily      # every day   02:30
#   oscar-backup-schedule.sh weekly     # every Monday 02:30
#   oscar-backup-schedule.sh monthly    # the 1st      02:30   (Patrick's baseline)
#   oscar-backup-schedule.sh on-demand  # remove the timer; run backups by hand
#                                        # (use this for a DR drill)
#   oscar-backup-schedule.sh status     # show the current timer
#
# Config baked into the timer (override via env before running):
#   OSCAR_BACKUP_PASSPHRASE_FILE  (default: $HOME/.oscar-backup-pass)
#   OSCAR_BACKUP_DIR              (default: $HOME/oscar-backups)
#   OSCAR_BACKUP_KEEP             (default: 6)
#   OSCAR_BACKUP_USER            run the backup as this user (default: current)
set -euo pipefail

FREQ="${1:-status}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="$SCRIPT_DIR/oscar-backup.sh"
RUN_USER="${OSCAR_BACKUP_USER:-$(id -un)}"
PASS_FILE="${OSCAR_BACKUP_PASSPHRASE_FILE:-$HOME/.oscar-backup-pass}"
OUT_DIR="${OSCAR_BACKUP_DIR:-$HOME/oscar-backups}"
KEEP="${OSCAR_BACKUP_KEEP:-6}"
UNIT=/etc/systemd/system/oscar-backup.service
TIMER=/etc/systemd/system/oscar-backup.timer

if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; else SUDO=""; fi

case "$FREQ" in
  daily)   CAL="*-*-* 02:30:00" ;;
  weekly)  CAL="Mon *-*-* 02:30:00" ;;
  monthly) CAL="*-*-01 02:30:00" ;;
  on-demand|off|none)
    $SUDO systemctl disable --now oscar-backup.timer >/dev/null 2>&1 || true
    $SUDO rm -f "$UNIT" "$TIMER"
    $SUDO systemctl daemon-reload
    echo "on-demand: timer removed."
    echo "run a backup by hand:  OSCAR_BACKUP_PASSPHRASE_FILE=$PASS_FILE $BACKUP_SH"
    exit 0 ;;
  status)
    systemctl list-timers oscar-backup.timer --all --no-pager 2>/dev/null || echo "no timer installed (on-demand)"
    exit 0 ;;
  *) echo "usage: $(basename "$0") <daily|weekly|monthly|on-demand|status>" >&2; exit 2 ;;
esac

[ -f "$BACKUP_SH" ] || { echo "backup script not found: $BACKUP_SH" >&2; exit 1; }
chmod +x "$BACKUP_SH" 2>/dev/null || true

$SUDO tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=OSCAR DR backup
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
User=$RUN_USER
Environment=OSCAR_BACKUP_PASSPHRASE_FILE=$PASS_FILE
Environment=OSCAR_BACKUP_DIR=$OUT_DIR
Environment=OSCAR_BACKUP_KEEP=$KEEP
ExecStart=$BACKUP_SH
EOF

$SUDO tee "$TIMER" >/dev/null <<EOF
[Unit]
Description=OSCAR DR backup ($FREQ)

[Timer]
OnCalendar=$CAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now oscar-backup.timer
echo "installed: oscar-backup.timer ($FREQ, OnCalendar='$CAL'), runs as $RUN_USER"
echo "passphrase: $PASS_FILE | archives: $OUT_DIR | keep: $KEEP"
echo "NOTE: ensure $PASS_FILE exists (chmod 600) and $RUN_USER can reach Docker."
systemctl list-timers oscar-backup.timer --all --no-pager 2>/dev/null || true
