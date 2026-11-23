# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# totp.sh — the code an authenticator app shows (RFC 6238: HMAC-SHA1 of the
# 30-second step, six digits), for the CI scripts that sign in as an
# administrator, whose second factor is required (#1414). Sourced, not run.
# Needs base32 (coreutils), od and openssl. TOTP_TIME (seconds) replaces the
# clock, for the test that holds it to the server's own computation
# (Oscar_Server/tests/unit/ci-totp.test.js).
#
#   totp <base32 secret> [steps after the current one]

totp() {
  local secret=$1 offset=${2:-0} now key counter hex start value
  now=${TOTP_TIME:-$(date +%s)}
  key=$(printf '%s' "$secret" | base32 -d | od -An -v -tx1 | tr -d ' \n')
  counter=$(printf '%016x' $(( now / 30 + offset )))
  # shellcheck disable=SC2059  # the format is the counter's bytes, \xHH each
  hex=$(printf "$(printf '%s' "$counter" | sed 's/../\\x&/g')" \
    | openssl dgst -sha1 -mac HMAC -macopt "hexkey:$key" -binary | od -An -v -tx1 | tr -d ' \n')
  start=$(( 16#${hex:39:1} * 2 ))
  value=$(( 16#${hex:start:8} & 0x7fffffff ))
  printf '%06d\n' $(( value % 1000000 ))
}
