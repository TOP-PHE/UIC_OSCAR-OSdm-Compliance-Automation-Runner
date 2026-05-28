#!/usr/bin/env bash
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# push-tag-with-retry.sh
#
# Issue #298: harden the auto-tag workflow against transient GitHub remote
# failures (notably `remote: fatal error in commit_refs`) that have been
# intermittently failing the `Push server tag` / `Push release tag` steps,
# requiring manual `gh run rerun <id> --failed`.
#
# Strategy: 3 attempts with 5 s / 15 s / 30 s backoff (50 s total upper
# bound), with two safety features layered on:
#
#   1. **Idempotency.** After a failed `git push`, query origin for the
#      tag. If the tag IS at origin, treat the "failure" as success — a
#      previous attempt actually pushed the tag but we lost the success
#      signal (race / connection drop / proxy buffering).
#   2. **Transient-only retry.** Match the push output against a known set
#      of transient error patterns (`commit_refs`, RPC failed, early EOF,
#      remote hung up, HTTP 5xx, connection reset/timeout, TLS handshake).
#      Anything else — permission denied, non-fast-forward, hook rejection
#      — fails fast without burning 50 s on a real bug.
#
# Usage (sourced from a workflow step):
#
#   source .github/workflows/lib/push-tag-with-retry.sh
#   push_tag_with_retry "server-v1.2.3"
#
# Exits 0 on success (push landed, or tag already at origin); exits 1 on
# all-attempts-exhausted or a non-transient failure.

push_tag_with_retry() {
  local tag="$1"
  local -ar SLEEPS=(5 15 30)
  local -ir MAX_ATTEMPTS=${#SLEEPS[@]}

  # Patterns that have empirically been transient on github.com. Anything
  # NOT matching is treated as a hard error (fail fast).
  local -r TRANSIENT_PATTERN='commit_refs|RPC failed|early EOF|the remote end hung up|HTTP/[0-9.]+ 5[0-9][0-9]|connection (reset|timed out)|TLS handshake|HTTP 5[0-9][0-9]|502 Bad Gateway|503 Service Unavailable|504 Gateway'

  local attempt=0
  local log
  while [[ $attempt -lt $MAX_ATTEMPTS ]]; do
    attempt=$((attempt + 1))
    log=$(mktemp)

    if git push origin "$tag" >"$log" 2>&1; then
      cat "$log"
      echo "::notice::Tag ${tag} pushed successfully on attempt ${attempt}/${MAX_ATTEMPTS}."
      rm -f "$log"
      return 0
    fi

    # Surface what just happened in the workflow log.
    cat "$log"

    # Idempotency: a previous attempt may have actually landed the tag even
    # though the response signal was lost (connection drop, proxy buffering,
    # …). If the tag IS at origin, treat as success.
    if git ls-remote --tags origin "refs/tags/${tag}" \
         | grep -q "refs/tags/${tag}$"; then
      echo "::notice::Push attempt ${attempt} reported failure but tag ${tag} is already at origin — treating as success (idempotency)."
      rm -f "$log"
      return 0
    fi

    # Transient-only retry. Hard failures (auth, non-fast-forward, hook
    # rejection, …) exit fast — no point burning 50 s on a real bug.
    if ! grep -qE "$TRANSIENT_PATTERN" "$log"; then
      echo "::error::Tag ${tag} push failed on attempt ${attempt} with a non-transient error (see log above). Failing fast."
      rm -f "$log"
      return 1
    fi

    if [[ $attempt -lt $MAX_ATTEMPTS ]]; then
      local sleep_s=${SLEEPS[$((attempt - 1))]}
      echo "::warning::Tag ${tag} push attempt ${attempt}/${MAX_ATTEMPTS} hit a transient remote error. Sleeping ${sleep_s}s before retry."
      rm -f "$log"
      sleep "$sleep_s"
      continue
    fi

    # Exhausted the retry budget on transient errors.
    rm -f "$log"
  done

  echo "::error::Tag ${tag} push failed after ${MAX_ATTEMPTS} attempts (all transient — see logs above). Issue #298. Re-run the workflow manually if needed: \`gh run rerun <run-id> --failed\`."
  return 1
}
