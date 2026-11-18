#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# CI only (#1324, .github/workflows/ci-kubernetes.yml). With RUN_KEPT_PODS=on
# (set by the step before, on deploy/oscar), the runs of one batch go to a pod
# kept for them (#1309): three gamma scenarios, one at a time (one session per
# company by default), all in ONE pod. Needs curl, jq and kubectl, and the
# account ci/smoke.sh wrote.
#
#   OSCAR_URL           where this script reaches OSCAR (a port-forward)
#   SMOKE_ACCOUNT_FILE  ci/smoke.sh's account file: the Test Manager
#   METRICS_TOKEN       METRICS_TOKEN of the Secret oscar-secrets
#   OSCAR_NAMESPACE     optional, the namespace of deploy/oscar (oscar by default)
#   RUNS_NAMESPACE      optional, the runs' namespace (oscar-runs by default)
set -euo pipefail
OSCAR_NAMESPACE=${OSCAR_NAMESPACE:-oscar}
RUNS_NAMESPACE=${RUNS_NAMESPACE:-oscar-runs}

: "${OSCAR_URL:?}" "${SMOKE_ACCOUNT_FILE:?}" "${METRICS_TOKEN:?}"
root=$(cd "$(dirname "$0")/../../.." && pwd)
scenarios='["SIM_SALE_SEARCH_1ADT_38","SIM_SALE_SEARCH_2ADT_SAVER_38","SIM_SALE_CARD_25_1ADT_38"]'
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "── $*"; }

# call METHOD PATH [TOKEN] [BODY_FILE]: prints the HTTP status; the answer is in $work/out.
call() {
  local method=$1 path=$2 token=${3:-} body=${4:-}
  local args=(-sS -o "$work/out" -w '%{http_code}' -X "$method")
  if [ -n "$token" ]; then
    local auth
    auth=$(printf 'Authorization: Bearer %s' "$token")
    args+=(-H "$auth")
  fi
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  curl "${args[@]}" "$OSCAR_URL$path"
}
expect() {
  if [ "$3" != "$2" ]; then
    echo "Answer: $(head -c 600 "$work/out")" >&2
    fail "$1: expected HTTP $2, got $3"
  fi
}
dispatcher_count() { kubectl -n "$OSCAR_NAMESPACE" logs deploy/oscar-dispatcher | grep -c "started $1" || true; }

step "RUN_KEPT_PODS is on"
test "$(kubectl -n "$OSCAR_NAMESPACE" exec deploy/oscar -c oscar -- printenv RUN_KEPT_PODS)" = on \
  || fail "RUN_KEPT_PODS is not on in deploy/oscar"

step "the Test Manager signs in"
jq '{email: .tm_email, password: .tm_password}' "$SMOKE_ACCOUNT_FILE" > "$work/login.json"
code=$(call POST /v1/auth/login "" "$work/login.json")
expect "login" 200 "$code"
tm_token=$(jq -r .token "$work/out")

step "a batch of three scenarios"
datafile="$root/Bruno_Collection/data_base/simulator_datafile.json"
jq --argjson s "$scenarios" '.scenariosToRun = $s' "$datafile" > "$work/datafile.json"
code=$(call PUT /v1/company/datafile/json "$tm_token" "$work/datafile.json")
expect "data file" 200 "$code"
kept_before=$(dispatcher_count oscar-pod-)
runs_before=$(dispatcher_count oscar-run-)
echo '{}' > "$work/empty.json"
code=$(call POST /v1/runs "$tm_token" "$work/empty.json")
expect "launch" 202 "$code"
mapfile -t run_ids < <(jq -r '.runs[].id' "$work/out")
[ "${#run_ids[@]}" = 3 ] || fail "expected 3 runs, got: $(cat "$work/out")"

for run_id in "${run_ids[@]}"; do
  status=QUEUED
  for _ in $(seq 1 120); do
    code=$(call GET "/v1/runs/$run_id" "$tm_token")
    expect "run status" 200 "$code"
    status=$(jq -r .status "$work/out")
    case "$status" in QUEUED|RUNNING) sleep 5 ;; *) break ;; esac
  done
  code=$(call GET "/v1/runs/$run_id/assertions" "$tm_token")
  expect "checks" 200 "$code"
  summary=$(jq -c .summary "$work/out")
  call GET "/v1/runs/$run_id/logs" "$tm_token" > /dev/null
  if ! jq -e '[.events[]?.message] | any(test("goes to a pod kept for its batch"))' "$work/out" > /dev/null; then
    fail "run $run_id did not go to a kept pod"
  fi
  echo "run $run_id: $status, checks $summary"
  if [ "$status" != COMPLETED ]; then
    jq -r '.events[]? | "\(.level) \(.message)"' "$work/out" | tail -n 60 >&2 || true
    fail "run $run_id ended $status"
  fi
  [ "$(jq -r '.failed // 0' <<< "$summary")" = 0 ] || fail "run $run_id failed checks: $summary"
  [ "$(jq -r '.total // 0' <<< "$summary")" -ge 20 ] || fail "run $run_id did not run through: $summary"
done

step "one kept pod for the three runs, no pod of a single run"
kept=$(( $(dispatcher_count oscar-pod-) - kept_before ))
single=$(( $(dispatcher_count oscar-run-) - runs_before ))
echo "kept pods started: $kept; pods of a single run started: $single"
[ "$kept" = 1 ] || fail "expected 1 kept pod for the batch, the dispatcher started $kept"
[ "$single" = 0 ] || fail "the dispatcher started $single pod(s) of a single run during the batch"

step "the runs that went to a pod that ran before"
code=$(call GET /metrics "$METRICS_TOKEN")
expect "GET /metrics" 200 "$code"
again=$(awk '/^oscar_kept_pod_runs_total\{pod="again"\}/ { print $2 }' "$work/out")
first=$(awk '/^oscar_kept_pod_runs_total\{pod="first"\}/ { print $2 }' "$work/out")
echo "first: ${first:-0}, again: ${again:-0}"
[ "${first:-0}" = 1 ] && [ "${again:-0}" = 2 ] || fail "expected 1 first run and 2 runs again in the kept pod"

step "the pod ends with its batch, and nothing is left"
left=1
for _ in $(seq 1 45); do
  left=$(kubectl -n "$RUNS_NAMESPACE" get jobs,pods,secrets -l app.kubernetes.io/managed-by=oscar-dispatcher -o name | wc -l)
  if [ "$left" = 0 ]; then break; fi
  sleep 2
done
[ "$left" = 0 ] || { kubectl -n "$RUNS_NAMESPACE" get jobs,pods,secrets -o wide >&2 || true; fail "$left object(s) left in $RUNS_NAMESPACE"; }
echo "OK: three runs of a batch in one kept pod"
