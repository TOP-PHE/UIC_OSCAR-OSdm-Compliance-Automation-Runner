#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# CI only (#1147, .github/workflows/ci-kubernetes.yml, job "k3s on one
# machine"): the monitoring of monitoring/stack and monitoring/oscar on a
# real k3s, once a scenario ran (ci/smoke.sh). Needs curl, jq and kubectl.
#
#   NODE_IP             the runner's address, where Traefik listens
#   SMOKE_ACCOUNT_FILE  what ci/smoke.sh wrote: the administrator's and the
#                       Test Manager's sign-in
set -euo pipefail

: "${NODE_IP:?}" "${SMOKE_ACCOUNT_FILE:?}"
root=$(cd "$(dirname "$0")/../../.." && pwd)
host=oscar.example.org
svc=monitoring.svc.cluster.local
work=$(mktemp -d)
forwards=()
cleanup() {
  for p in "${forwards[@]}"; do kill "$p" 2> /dev/null || true; done
  kubectl -n oscar-runs delete pod memory-probe memory-hog --ignore-not-found --wait=false > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "── $*"; }
# within SECONDS COMMAND...: true once COMMAND is, tried each second.
within() {
  local seconds=$1
  shift
  for _ in $(seq 1 "$seconds"); do
    if "$@"; then return 0; fi
    sleep 1
  done
  "$@"
}

# Prometheus, Loki and Alertmanager are reached through port-forwards: their
# network policies hold every pod but Grafana's and their own.
forward() {
  kubectl -n monitoring port-forward "service/$1" "$2" > "$work/forward-$1.log" 2>&1 &
  forwards+=("$!")
}
forward kube-prometheus-stack-prometheus 9090:9090
forward loki 3100:3100
forward kube-prometheus-stack-alertmanager 9093:9093
answers() { curl -s -o /dev/null "http://127.0.0.1:$1/"; }
for port in 9090 3100 9093; do within 30 answers "$port"; done

query() { curl -fsS --get --data-urlencode "query=$1" http://127.0.0.1:9090/api/v1/query; }
found() { test "$(query "$1" | jq '.data.result | length')" -gt 0; }

# Two pods shaped like runs (namespace oscar-runs, container "run", as the
# dispatcher makes them): the scenario's own pod lasted less than the 15 s
# between two readings.
run_pod() {
  local overrides
  overrides=$(jq -n --arg m "$2" --arg s "$3" '{
    spec: {
      restartPolicy: "Never",
      serviceAccountName: "oscar-run",
      automountServiceAccountToken: false,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "run",
        image: "local/oscar-run:ci",
        imagePullPolicy: "Never",
        command: ["node", "-e", $s],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: $m } }
      }]
    }
  }')
  kubectl -n oscar-runs run "$1" --image=local/oscar-run:ci --restart=Never \
    --labels=app.kubernetes.io/name=oscar-run --overrides="$overrides" > /dev/null
}
step "two pods shaped like runs: one holds 64 MB for two minutes, one goes past its limit"
run_pod memory-probe 256Mi 'const keep = Buffer.alloc(64 * 1024 * 1024, 1); setTimeout(() => keep.length, 120000);'
run_pod memory-hog 128Mi 'const kept = []; setInterval(() => kept.push(Buffer.alloc(16 * 1024 * 1024, 1)), 50);'

step "Prometheus reads OSCAR, the simulator relay, the machine, the kubelet and kube-state-metrics"
up=""
targets_up() {
  up=$(curl -fsS 'http://127.0.0.1:9090/api/v1/targets?state=active' \
    | jq -r '[.data.activeTargets[] | select(.health == "up") | .labels.job] | unique | join(" ")')
  local job
  for job in oscar-server osdm-simulator node-exporter kubelet kube-state-metrics; do
    [[ " $up " == *" $job "* ]] || return 1
  done
}
if ! within 180 targets_up; then
  curl -fsS 'http://127.0.0.1:9090/api/v1/targets?state=active' \
    | jq '[.data.activeTargets[] | {job: .labels.job, health, lastError}]'
  fail "a target is not up"
fi
echo "up: $up"

step "the VPS's alerts and the cluster's are loaded and evaluate"
rules=""
rules_ok() {
  rules=$(curl -fsS http://127.0.0.1:9090/api/v1/rules)
  local group
  for group in oscar.app oscar.host oscar.run-pods osdm-simulator oscar.kubernetes; do
    jq -e --arg g "$group" '.data.groups | any(.name == $g)' <<< "$rules" > /dev/null || return 1
  done
  jq -e '[.data.groups[] | select(.name | test("^(oscar|osdm)")) | .rules[].health] | all(. == "ok")' <<< "$rules" > /dev/null
}
if ! within 120 rules_ok; then
  jq '[.data.groups[] | select(.name | test("^(oscar|osdm)")) | .rules[] | {name, health, lastError}]' <<< "$rules"
  fail "OSCAR's rules"
fi

step "a run pod's memory and limit, OSCAR's own figures"
within 120 found 'container_memory_working_set_bytes{namespace="oscar-runs", container="run", pod="memory-probe"}' \
  || fail "no memory figure for the run-shaped pod (cAdvisor)"
within 60 found 'kube_pod_container_resource_limits{namespace="oscar-runs", container="run", pod="memory-probe", resource="memory"}' \
  || fail "no memory limit for it (kube-state-metrics)"
found 'oscar_run_pods_ended_total{job="oscar-server"}' || fail "OSCAR's figures of the scenario's run pod"
found 'container_memory_working_set_bytes{namespace="oscar", container="oscar"}' || fail "no memory figure for OSCAR's server"

step "a run pod past its memory limit fires OscarRunPodOutOfMemory"
firing() {
  curl -fsS http://127.0.0.1:9090/api/v1/alerts \
    | jq -e '.data.alerts | any(.labels.alertname == "OscarRunPodOutOfMemory" and .labels.pod == "memory-hog" and .state == "firing")' > /dev/null
}
if ! within 180 firing; then
  kubectl -n oscar-runs get pod memory-hog -o jsonpath='{.status.containerStatuses[0].state}'
  echo
  fail "the alert did not fire"
fi

step "every query of the dashboards is one Prometheus takes; the cluster's all answer"
for f in "$root/OSCAR_Deploy/grafana/dashboards/oscar-overview.json" "$root/OSCAR_Deploy/grafana/dashboards/osdm-simulator.json" \
  "$root/OSCAR_Deploy/kubernetes/monitoring/oscar/dashboards/oscar-kubernetes.json"; do
  jq -r '.. | objects | select(has("expr")) | .expr' "$f" | while IFS= read -r e; do
    e=${e//\$__range/1h}
    e=${e//\$__rate_interval/1m}
    e=${e//\$__interval/1m}
    answer=$(query "$e") || { echo "Prometheus refused: $e" >&2; exit 1; }
    if [[ "$f" == */oscar-kubernetes.json ]] && [ "$(jq '.data.result | length' <<< "$answer")" = 0 ]; then
      echo "no answer: $e" >&2
      exit 1
    fi
  done
done

step "Grafana, at /grafana/, for OSCAR's administrators only"
grafana() { curl -sk -o "$work/grafana.out" -w '%{http_code}' --resolve "$host:443:$NODE_IP" "$@"; }
sign_in() {
  jq -n --arg e "$1" --arg p "$2" '{email: $e, password: $p}' > "$work/login.json"
  curl -fsSk -o /dev/null -c "$3" --resolve "$host:443:$NODE_IP" -H 'Content-Type: application/json' \
    --data-binary "@$work/login.json" "https://$host/v1/auth/login"
  rm "$work/login.json"
}
admin=$(jq -r .admin_email "$SMOKE_ACCOUNT_FILE")
sign_in "$admin" "$(jq -r .admin_password "$SMOKE_ACCOUNT_FILE")" "$work/admin.jar"
sign_in "$(jq -r .tm_email "$SMOKE_ACCOUNT_FILE")" "$(jq -r .tm_password "$SMOKE_ACCOUNT_FILE")" "$work/tm.jar"
code=$(grafana "https://$host/grafana/api/health")
echo "nobody signed in: $code"
test "$code" = 401
code=$(grafana -H "X-User-Email: $admin" "https://$host/grafana/api/user")
echo "an administrator's e-mail, sent by hand: $code"
test "$code" = 401
code=$(grafana -b "$work/tm.jar" "https://$host/grafana/api/user")
echo "a Test Manager, signed in: $code"
test "$code" = 401
code=$(grafana -b "$work/admin.jar" -H 'X-User-Email: someone-else@example.org' "https://$host/grafana/api/user")
echo "an administrator, signed in, sending another e-mail: $code"
test "$code" = 200
jq -e --arg e "$admin" '.login == $e' "$work/grafana.out" > /dev/null || { cat "$work/grafana.out"; fail "Grafana took the e-mail sent"; }
dashboards() {
  test "$(grafana -b "$work/admin.jar" "https://$host/grafana/api/search?type=dash-db")" = 200 || return 1
  local uid
  for uid in oscar-overview oscar-logs osdm-simulator oscar-kubernetes; do
    jq -e --arg u "$uid" 'any(.[]; .uid == $u)' "$work/grafana.out" > /dev/null || return 1
  done
}
within 90 dashboards || { cat "$work/grafana.out"; fail "a dashboard is missing"; }

step "OSCAR's pod reaches none of Grafana, Prometheus, Alertmanager and Loki"
reach() {
  kubectl -n oscar exec deploy/oscar -c oscar -- node -e "
    const s = require('node:net').connect($2, '$1');
    s.setTimeout(5000, () => { console.log('closed'); process.exit(0); });
    s.on('connect', () => { console.log('open'); process.exit(0); });
    s.on('error', () => { console.log('closed'); process.exit(0); });"
}
# A pod no policy holds is reached: the names and the network are right.
seen=$(reach "kube-prometheus-stack-kube-state-metrics.$svc" 8080)
echo "kube-state-metrics from OSCAR's pod: $seen"
test "$seen" = open
for target in "kube-prometheus-stack-grafana.$svc:80" "kube-prometheus-stack-prometheus.$svc:9090" \
  "kube-prometheus-stack-alertmanager.$svc:9093" "loki.$svc:3100"; do
  seen=$(reach "${target%:*}" "${target##*:}")
  echo "$target from OSCAR's pod: $seen"
  test "$seen" = closed
done

step "Loki holds OSCAR's logs, never a run pod's"
start="$(( $(date +%s) - 3600 ))000000000"
logs() {
  local n
  n=$(curl -fsS --get --data-urlencode 'query={namespace="oscar", container="oscar"}' --data-urlencode 'limit=10' \
    --data-urlencode "start=$start" http://127.0.0.1:3100/loki/api/v1/query_range | jq '[.data.result[].values[]] | length')
  test "$n" -gt 0
}
within 120 logs || fail "no log line of OSCAR's server in Loki"
curl -fsS --get --data-urlencode "start=$start" http://127.0.0.1:3100/loki/api/v1/label/namespace/values \
  | jq -e '(.data // []) | (index("oscar") != null) and (index("oscar-runs") == null)' > /dev/null \
  || fail "Loki's namespaces are not oscar alone"

step "Alertmanager reads the Secret oscar-alertmanager"
curl -fsS http://127.0.0.1:9093/api/v2/status | jq -e '.config.original | contains("oscar-ci")' > /dev/null \
  || fail "Alertmanager's configuration is not the Secret's"

# What the stack costs the machine (k3s's metrics-server), for the guide's
# figure; not a check.
step "memory of the monitoring pods"
kubectl top pods -n monitoring --sum 2>&1 || true

echo "OK: monitoring on k3s"
