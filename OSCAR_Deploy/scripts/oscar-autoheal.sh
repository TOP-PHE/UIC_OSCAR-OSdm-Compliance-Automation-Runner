#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# oscar-autoheal.sh - restart the containers Docker reports unhealthy (#1434).
#
# One pass: every running container labelled autoheal=true whose health check
# Docker reports "unhealthy" is restarted. A systemd timer runs it every 30 s
# (oscar-autoheal-schedule.sh install). It replaces the autoheal sidecar of
# earlier versions, which needed the Docker socket inside a container: here
# the host's own docker command does it, and no container holds the socket.
#
# A container is "unhealthy" only after its start period and three failed
# checks in a row (docker-compose.yml: 30 s apart), and reads "starting" again
# once restarted, so one pass never restarts it twice.
#
# Settings (environment, read at each pass):
#   OSCAR_AUTOHEAL_LABEL         the label to look for (default autoheal=true)
#   OSCAR_AUTOHEAL_STOP_TIMEOUT  seconds Docker waits before it kills the
#                                container it restarts (default 20)
#
# Exit status: 0 when every unhealthy container was restarted (or none was
# unhealthy), 1 when Docker could not be asked or a restart failed, 2 for a
# setting it refuses.
set -uo pipefail

LABEL="${OSCAR_AUTOHEAL_LABEL:-autoheal=true}"
STOP_TIMEOUT="${OSCAR_AUTOHEAL_STOP_TIMEOUT:-20}"

# Both go into docker's arguments: plain values only.
if ! [[ "$LABEL" =~ ^[A-Za-z0-9._-]+(=[A-Za-z0-9._-]+)?$ ]]; then
  echo "oscar-autoheal: OSCAR_AUTOHEAL_LABEL is not a label (name or name=value): refused" >&2
  exit 2
fi
if ! [[ "$STOP_TIMEOUT" =~ ^[0-9]{1,3}$ ]]; then
  echo "oscar-autoheal: OSCAR_AUTOHEAL_STOP_TIMEOUT is not a number of seconds (0-999): refused" >&2
  exit 2
fi

if ! ids=$(docker ps --quiet --no-trunc --filter "label=$LABEL" --filter health=unhealthy); then
  echo "oscar-autoheal: could not ask Docker for unhealthy containers" >&2
  exit 1
fi

status=0
for id in $ids; do
  # A container id is hexadecimal; anything else is not acted upon.
  if ! [[ "$id" =~ ^[0-9a-f]{12,64}$ ]]; then
    echo "oscar-autoheal: left out an answer that is not a container id" >&2
    status=1
    continue
  fi
  name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null) || name=""
  name="${name#/}"
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || name="${id:0:12}"
  # -t: "--time" in older Docker clients, "--timeout" in newer ones.
  if docker restart -t "$STOP_TIMEOUT" "$id" > /dev/null; then
    echo "oscar-autoheal: restarted $name (${id:0:12}): Docker reported it unhealthy"
  else
    echo "oscar-autoheal: could not restart $name (${id:0:12})" >&2
    status=1
  fi
done
exit "$status"
