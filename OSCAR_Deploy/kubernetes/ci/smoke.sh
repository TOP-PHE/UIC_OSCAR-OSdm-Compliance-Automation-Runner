#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# CI only (#1059, .github/workflows/ci-kubernetes.yml). Drives an OSCAR
# deployed on a cluster through its public API, as the first users of a new
# installation would, then runs one scenario against the OSDM simulator and
# expects it to pass. Needs curl and jq.
#
#   OSCAR_URL        where this script reaches OSCAR (a port-forward)
#   SIM_BASE         where OSCAR reaches the simulator, without the provider
#   SIM_SECRET       the secret of gamma.tstmgr01 in the simulator's clients file
#   BOOTSTRAP_TOKEN  PLATFORM_BOOTSTRAP_TOKEN of the Secret oscar-secrets
#   METRICS_TOKEN    METRICS_TOKEN of the same Secret
#   SCENARIO         optional, SIM_SALE_SEARCH_1ADT_38 by default
set -euo pipefail

: "${OSCAR_URL:?}" "${SIM_BASE:?}" "${SIM_SECRET:?}" "${BOOTSTRAP_TOKEN:?}" "${METRICS_TOKEN:?}"
root=$(cd "$(dirname "$0")/../../.." && pwd)
scenario=${SCENARIO:-SIM_SALE_SEARCH_1ADT_38}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "── $*"; }

# call METHOD PATH [TOKEN] [BODY_FILE] [EXTRA_HEADER]
# Prints the HTTP status; the answer is in $work/out.
call() {
  local method=$1 path=$2 token=${3:-} body=${4:-} extra=${5:-}
  local args=(-sS -o "$work/out" -w '%{http_code}' -X "$method")
  if [ -n "$token" ]; then
    local auth
    auth=$(printf 'Authorization: Bearer %s' "$token")
    args+=(-H "$auth")
  fi
  if [ -n "$body" ]; then args+=(-H 'Content-Type: application/json' --data-binary "@$body"); fi
  if [ -n "$extra" ]; then args+=(-H "$extra"); fi
  curl "${args[@]}" "$OSCAR_URL$path"
}

# expect WHAT WANTED GOT
expect() {
  if [ "$3" != "$2" ]; then
    echo "Answer: $(head -c 600 "$work/out")" >&2
    fail "$1: expected HTTP $2, got $3"
  fi
}

json() { jq -n "$@" > "$work/body.json"; echo "$work/body.json"; }

password() { printf 'Ci-%sA1' "$(openssl rand -hex 12)"; }

step "health"
code=$(call GET /health)
expect "GET /health" 200 "$code"
jq -e '.status == "ok"' "$work/out" > /dev/null || fail "health is not ok: $(cat "$work/out")"
jq -e '.compatibility_status == "tested"' "$work/out" > /dev/null \
  || fail "the server and collection in the image are not a release of compatibility.json: $(jq -c '{server_version, collection_version, compatibility_status}' "$work/out")"
want_collection=$(tr -d '[:space:]' < "$root/Bruno_Collection/VERSION")
jq -e --arg v "$want_collection" '.collection_version == $v' "$work/out" > /dev/null \
  || fail "the image holds collection $(jq -r .collection_version "$work/out"), the checkout $want_collection"
jq -c '{server_version, collection_version, release_label}' "$work/out"

step "/metrics asks for its token"
code=$(call GET /metrics)
expect "GET /metrics without the token" 404 "$code"
code=$(call GET /metrics "$METRICS_TOKEN")
expect "GET /metrics with the token" 200 "$code"
grep -q '^oscar_' "$work/out" || fail "no oscar_ metric in /metrics"

step "first administrator"
admin_email=admin@ci-smoke.example.org
admin_password=$(password)
body=$(json --arg e "$admin_email" --arg p "$admin_password" '{email: $e, password: $p}')
code=$(call POST /v1/auth/bootstrap/platform-user "" "$body" "x-platform-bootstrap-token: $BOOTSTRAP_TOKEN")
expect "bootstrap" 201 "$code"

login() {
  local b c
  b=$(json --arg e "$1" --arg p "$2" '{email: $e, password: $p}')
  c=$(call POST /v1/auth/login "" "$b")
  expect "login of $1" 200 "$c"
  jq -r .token "$work/out"
}
admin_token=$(login "$admin_email" "$admin_password")

step "company and Test Manager"
code=$(call POST /v1/admin/companies "$admin_token" "$(json '{name: "CI smoke", slug: "ci-smoke"}')")
expect "create company" 201 "$code"
company_id=$(jq -r .company.id "$work/out")
tm_email=tm@ci-smoke.example.org
tm_password=$(password)
body=$(json --arg e "$tm_email" --arg p "$tm_password" --arg c "$company_id" \
  '{email: $e, password: $p, role: "test_manager", company_id: $c}')
code=$(call POST /v1/admin/users "$admin_token" "$body")
expect "create Test Manager" 201 "$code"
tm_token=$(login "$tm_email" "$tm_password")

step "endpoint, credentials, data file (simulator gamma)"
code=$(call PATCH /v1/company "$tm_token" "$(json --arg a "$SIM_BASE/gamma" '{api_base: $a}')")
expect "endpoint" 200 "$code"
body=$(json --arg t "$SIM_BASE/gamma/oauth/token" --arg s "$SIM_SECRET" \
  '{auth_mode: "oauth2", oauth_profile: "oauth2_basic", token_url: $t, client_id: "gamma.tstmgr01", client_secret: $s}')
code=$(call PATCH /v1/me/credentials "$tm_token" "$body")
expect "credentials" 200 "$code"
datafile="$root/Bruno_Collection/data_base/simulator_datafile.json"
jq -e --arg s "$scenario" 'any(.scenarios[]; .code == $s)' "$datafile" > /dev/null \
  || fail "no scenario $scenario in the simulator's data file"
jq --arg s "$scenario" '.scenariosToRun = [$s]' "$datafile" > "$work/datafile.json"
code=$(call PUT /v1/company/datafile/json "$tm_token" "$work/datafile.json")
expect "data file" 200 "$code"

step "run $scenario"
code=$(call POST /v1/runs "$tm_token" "$(json '{}')")
expect "launch" 202 "$code"
run_id=$(jq -r '.runs[0].id' "$work/out")
[ -n "$run_id" ] && [ "$run_id" != null ] || fail "no run in $(cat "$work/out")"
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
echo "run $run_id: $status, checks $summary"

show_log() {
  call GET "/v1/runs/$run_id/logs" "$tm_token" > /dev/null || true
  jq -r '.events[]? | "\(.level) \(.request_name // "-") \(.message)"' "$work/out" | tail -n 80 >&2 || true
}
if [ "$status" != COMPLETED ]; then show_log; fail "the run ended $status"; fi
failed=$(jq -r '.failed // 0' <<< "$summary")
total=$(jq -r '.total // 0' <<< "$summary")
if [ "$failed" != 0 ]; then show_log; fail "$failed of $total checks failed"; fi
if [ "$total" -lt 20 ]; then show_log; fail "only $total checks: the scenario did not run through"; fi
echo "OK: $scenario passed $total checks on the cluster"
