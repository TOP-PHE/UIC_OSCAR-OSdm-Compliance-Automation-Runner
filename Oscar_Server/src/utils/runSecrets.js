// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runSecrets.js — per-run secrets for the two loopback routes (tracker
 * S8-loopback, v1.11.210).
 *
 * Bruno runs on the same host as the server and fetches two things from it
 * while a run is in flight: the company's datafile (GET /data/:filename) and,
 * for long scenarios, a fresh access token (POST
 * /v1/runs/:runId/refresh-access-token). Both used to be gated on nothing but
 * "the request came from 127.0.0.1 with no X-Forwarded-For". That turned any
 * process able to reach the port — and any fronting proxy that did not inject
 * X-Forwarded-For (an L4 TCP forwarder, a sidecar) — into a full read of ANY
 * company's decrypted datafile and a live vendor token, with no second factor.
 *
 * Now the runner issues a random secret when it spawns Bruno and revokes it
 * when the child exits. Bruno carries it (via its process environment, never
 * the env file on disk) and sends it as a header; the routes require it and
 * bind it to the run's own company. The loopback-IP test is gone.
 *
 * In memory on purpose: a secret only has to outlive the child it was minted
 * for, and that child dies with this process. Nothing is persisted, and
 * nothing is still valid after a restart — a run cannot survive one either.
 * The queue runs executeRun in this same process, so the runner and the
 * routes share this map.
 */

const crypto = require('node:crypto');

const _byRun = new Map();   // runId -> { secret, companyId }

/** Mint and store a fresh secret for a run; returns it. */
function issue(runId, companyId) {
  const secret = crypto.randomBytes(32).toString('hex');
  _byRun.set(runId, { secret, companyId });
  return secret;
}

/**
 * The run's companyId when `secret` is the one issued for `runId`, else null.
 * Constant-time, and null for anything missing or the wrong length — the
 * secret is always 64 hex characters, so a length difference is a forgery.
 * The caller still confirms the company may see what is asked.
 */
function verify(runId, secret) {
  if (!runId || typeof secret !== 'string') return null;
  const rec = _byRun.get(runId);
  if (!rec) return null;
  const want = Buffer.from(rec.secret, 'utf8');
  const got = Buffer.from(secret, 'utf8');
  if (want.length !== got.length) return null;
  if (!crypto.timingSafeEqual(want, got)) return null;
  return rec.companyId;
}

/** Drop a run's secret. Called when the Bruno child exits. Idempotent. */
function revoke(runId) {
  _byRun.delete(runId);
}

/** Tests only. */
function _clear() {
  _byRun.clear();
}

module.exports = { issue, verify, revoke, _clear };
