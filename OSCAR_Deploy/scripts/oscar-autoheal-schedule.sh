#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-autoheal-schedule.sh - install (or remove) the restarts of unhealthy
# containers on the host (#1434).
#
# Copies oscar-autoheal.sh to /usr/local/sbin/oscar-autoheal (owned by root,
# outside the checkout: a checkout that moves never changes what root runs)
# and installs a systemd timer that runs it every 30 s. Run it as root, or as
# a user with sudo.
#
#   oscar-autoheal-schedule.sh install   # install or update, start the timer
#   oscar-autoheal-schedule.sh remove    # stop the timer, remove the files
#   oscar-autoheal-schedule.sh status    # the timer, and the last restarts
#
# Run "install" again after a release that changes oscar-autoheal.sh.
set -euo pipefail

ACTION="${1:-status}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/oscar-autoheal.sh"
TARGET=/usr/local/sbin/oscar-autoheal
UNIT=/etc/systemd/system/oscar-autoheal.service
TIMER=/etc/systemd/system/oscar-autoheal.timer

if [ "$(id -u)" -ne 0 ]; then SUDO=sudo; else SUDO=""; fi

case "$ACTION" in
  install) ;;
  remove|off)
    $SUDO systemctl disable --now oscar-autoheal.timer > /dev/null 2>&1 || true
    $SUDO rm -f "$UNIT" "$TIMER" "$TARGET"
    $SUDO systemctl daemon-reload
    echo "removed: nothing restarts unhealthy containers on this host any more."
    exit 0 ;;
  status)
    systemctl list-timers oscar-autoheal.timer --all --no-pager 2> /dev/null || echo "no timer installed"
    echo "last restarts:"
    journalctl -t oscar-autoheal --since "-7 days" --no-pager 2> /dev/null | tail -n 10 || true
    exit 0 ;;
  *) echo "usage: $(basename "$0") <install|remove|status>" >&2; exit 2 ;;
esac

[ -f "$SOURCE" ] || { echo "not found: $SOURCE" >&2; exit 1; }
command -v docker > /dev/null || { echo "docker is not installed on this host" >&2; exit 1; }

$SUDO install -m 0755 -o root -g root "$SOURCE" "$TARGET"

$SUDO tee "$UNIT" > /dev/null <<EOF
[Unit]
Description=OSCAR: restart the containers Docker reports unhealthy
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=$TARGET
SyslogIdentifier=oscar-autoheal
# Its lines at "notice"; systemd's own "Starting/Finished" every 30 s, at
# "info", are left out of the journal.
SyslogLevel=notice
LogLevelMax=notice
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ProtectHome=read-only
TimeoutStartSec=120
EOF

$SUDO tee "$TIMER" > /dev/null <<EOF
[Unit]
Description=OSCAR: look for unhealthy containers every 30 s

[Timer]
OnBootSec=60s
OnUnitActiveSec=30s
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now oscar-autoheal.timer
echo "installed: $TARGET, run every 30 s by oscar-autoheal.timer"
echo "its restarts:  journalctl -t oscar-autoheal"

# The sidecar of earlier versions: it holds the Docker socket until removed.
if docker ps --all --quiet --filter name='^oscar-autoheal$' 2> /dev/null | grep -q .; then
  echo "NOTE: the container oscar-autoheal of earlier versions is still there."
  echo "      Remove it: cd to OSCAR_Deploy, then docker compose up -d --remove-orphans"
fi
systemctl list-timers oscar-autoheal.timer --all --no-pager 2> /dev/null || true
