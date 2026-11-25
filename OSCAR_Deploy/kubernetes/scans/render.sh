#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# render.sh - what an operator applies, as files a scanner reads (#1438).
#
#   render.sh <folder>
#
# Writes into <folder> one file per set of manifests, as Kustomize renders it
# (kubectl kustomize): the overlays kubernetes, openshift and k3s, the runs'
# namespace (runs/), monitoring (monitoring/stack, monitoring/oscar); and a
# run pod's Job and a kept pod's Job as the dispatcher makes them
# (src/run-dispatcher/jobSpec.js), which no manifest holds. The ci/ overlays
# are the CI's own and are left out. Run from anywhere in the repository.
set -euo pipefail

OUT="${1:?usage: render.sh <folder>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
K8S="$ROOT/OSCAR_Deploy/kubernetes"
mkdir -p "$OUT"

for target in overlays/kubernetes overlays/openshift overlays/k3s runs monitoring/stack monitoring/oscar; do
  name="${target//\//-}"
  kubectl kustomize "$K8S/$target" > "$OUT/$name.yaml"
  echo "$name: $(grep -c '^kind:' "$OUT/$name.yaml") objects"
done

# The run pods as the k3s overlay has the dispatcher make them.
RUN_POD_USER=$(sed -n 's/^  RUN_POD_USER: "\{0,1\}\([0-9:]*\)"\{0,1\}$/\1/p' "$OUT/overlays-k3s.yaml" | head -n 1)
[ -n "$RUN_POD_USER" ] || { echo "the k3s overlay names no RUN_POD_USER" >&2; exit 1; }
RUN_POD_USER="$RUN_POD_USER" node "$K8S/scans/run-pods.js" "$OUT"
