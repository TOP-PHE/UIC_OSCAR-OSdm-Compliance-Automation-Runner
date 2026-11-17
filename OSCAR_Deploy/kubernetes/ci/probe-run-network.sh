#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# From a pod made as a run pod is (namespace oscar-runs, its label and
# service account, no token, restricted), says whether <host>:<port> answers:
# prints "open" or "closed". Used by ci-kubernetes.yml to check the run pods'
# network policy (run isolation option 4, #1130).
#
#   OSCAR_Deploy/kubernetes/ci/probe-run-network.sh <pod name> <host> <port>
#
# It tries for PROBE_SECONDS (10 by default), every half second: "open" as
# soon as one try connects, "closed" when none did. A pod's traffic follows
# the policy only once the node has taken the pod's address into its rules, a
# moment after the pod starts. One try at the pod's start was refused before
# that moment on k3s (#1308: the try at 17:18:30.3, the rule at 17:18:30.9),
# and proved nothing when it read "closed".
set -euo pipefail
name=$1
host=$2
port=$3
seconds=${PROBE_SECONDS:-10}
case "$seconds" in ''|*[!0-9]*) echo "PROBE_SECONDS is not a whole number" >&2; exit 2 ;; esac

script="const net=require('node:net');const end=Date.now()+${seconds}*1000;(function attempt(){const s=net.connect(${port},'${host}');let over=false;const next=()=>{if(over)return;over=true;s.destroy();if(Date.now()>=end)process.exit(1);setTimeout(attempt,500);};s.setTimeout(2000,next);s.on('connect',()=>process.exit(0));s.on('error',next);})();"
overrides=$(jq -n --arg n "$name" --arg s "$script" '{
  spec: {
    restartPolicy: "Never",
    serviceAccountName: "oscar-run",
    automountServiceAccountToken: false,
    securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
    containers: [{
      name: $n,
      image: "local/oscar-run:ci",
      imagePullPolicy: "Never",
      command: ["node", "-e", $s],
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "200m", memory: "128Mi" } }
    }]
  }
}')
kubectl -n oscar-runs run "$name" --image=local/oscar-run:ci --restart=Never \
  --labels=app.kubernetes.io/name=oscar-run --overrides="$overrides" > /dev/null
phase=""
for _ in $(seq 1 90); do
  phase=$(kubectl -n oscar-runs get pod "$name" -o jsonpath='{.status.phase}')
  case "$phase" in Succeeded|Failed) break ;; esac
  sleep 1
done
kubectl -n oscar-runs delete pod "$name" --wait=false > /dev/null
if [ "$phase" = Succeeded ]; then echo open; else echo closed; fi
