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
set -euo pipefail
name=$1
host=$2
port=$3

script="const s=require('node:net').connect(${port},'${host}');s.setTimeout(5000,()=>process.exit(2));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));"
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
