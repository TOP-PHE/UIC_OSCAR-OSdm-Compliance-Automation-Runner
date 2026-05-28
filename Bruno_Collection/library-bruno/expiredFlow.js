'use strict';

/**
 * expiredFlow.js — shared helper for "expired X" negative tests.
 *
 * Extracted from the per-resource expired-booking test (#204) so the same
 * pattern can be reused for offers, refund offers, exchange offers, and any
 * other OSDM resource that carries a deadline (`validUntil`,
 * `confirmationTimeLimit`, `preBookableUntil`, …).
 *
 * The pattern, in three steps:
 *   1. PLAN     — `planExpiredFlow({ deadlineRaw, maxWaitMinutes, resourceLabel })`
 *                 reads the response-supplied deadline, computes how long we
 *                 must sleep to be safely past it, and checks the wait fits
 *                 the run budget (per-scenario Max wait → server's
 *                 `runHardDeadlineMs` → conservative 8-min fallback).
 *   2. WAIT     — `runExpiredFlowWait({ plan, scenarioLabel })` sleeps for
 *                 plan.waitMs, then **forces an OAuth token refresh** via
 *                 the auth-helper so the post-wait request authenticates
 *                 against a fresh token (#204 round 5).
 *   3. GRADE    — `gradeExpiredFlowResponse({ res, scenarioLabel })`
 *                 categorises the after-response:
 *                   • 401/403  → WARN: token problem, NOT booking-expiry;
 *                   • 2xx     → ERROR: provider accepted an expired request;
 *                   • 4xx     → INFO if the body indicates expiry; else WARN
 *                                "rejected but not clearly an expiry message".
 *
 * The constants and budget arithmetic are byte-identical to the original
 * `06. POST … Fulfillments.yml` so the existing #204 expiredBookingTest
 * behaviour is preserved across the refactor.
 */

const { validationLogger } = require('./displays.js');
const { refreshAccessTokenIfNeeded } = require('./auth.js');

const BUFFER_MS       = 15000;  // wait 15s past deadline to be safely expired
const POST_MARGIN_MS  = 45000;  // budget headroom for fulfillment + GET + report

/**
 * Plan the wait-then-fire flow for an expired-X test.
 *
 * @param {object} opts
 * @param {string} opts.deadlineRaw      ISO datetime from the response (or empty/null)
 * @param {number} opts.maxWaitMinutes   per-scenario Max wait (0 = use server budget)
 * @param {string} opts.resourceLabel    short noun for diagnostics: 'booking confirmation', 'offer', etc.
 *
 * @returns {{ armed:boolean, waitMs:number, budgetSource:string, reason:string }}
 *   - armed=true    → caller MUST call runExpiredFlowWait then fire the request
 *   - armed=false   → SKIP the test; `reason` is a human-readable WARNING message
 */
function planExpiredFlow(opts) {
  opts = opts || {};
  const deadlineRaw    = opts.deadlineRaw;
  const maxWaitMinutes = Number(opts.maxWaitMinutes) || 0;
  const resourceLabel  = String(opts.resourceLabel || 'resource');

  if (!deadlineRaw) {
    return { armed: false, waitMs: 0, budgetSource: '', reason: `provider returned no ${resourceLabel} deadline — cannot deterministically test expiry. Proceeding without the expiry assertion.` };
  }
  const nowMs   = Date.now();
  const limitMs = new Date(deadlineRaw).getTime();
  if (isNaN(limitMs)) {
    return { armed: false, waitMs: 0, budgetSource: '', reason: `${resourceLabel} deadline '${deadlineRaw}' is not a valid date — skipping the expiry assertion.` };
  }
  const wakeAtMs = limitMs + BUFFER_MS;
  const waitMs   = wakeAtMs - nowMs;
  if (waitMs <= 0) {
    return { armed: true, waitMs: 0, budgetSource: 'already past', reason: '' };
  }

  // Budget: per-scenario Max wait → server runHardDeadlineMs → conservative 8 min.
  const hardDeadlineMs         = parseInt(bru.getEnvVar('runHardDeadlineMs') || '0', 10) || 0;
  const perScenarioBudgetEndMs = maxWaitMinutes > 0 ? (nowMs + maxWaitMinutes * 60 * 1000) : 0;
  const budgetEndMs            = perScenarioBudgetEndMs || hardDeadlineMs || (nowMs + 480000);
  const budgetSource           = perScenarioBudgetEndMs
    ? `scenario maxWaitMinutes=${maxWaitMinutes}`
    : (hardDeadlineMs ? 'server RUN_TIMEOUT_MS' : 'conservative 8-min fallback');

  if ((wakeAtMs + POST_MARGIN_MS) > budgetEndMs) {
    const needS   = Math.ceil((wakeAtMs + POST_MARGIN_MS - nowMs) / 1000);
    const needMin = Math.ceil(needS / 60);
    const hint    = perScenarioBudgetEndMs
      ? `Raise the scenario's Max wait to >= ${needMin} min and re-run.`
      : `Set the scenario's Max wait to >= ${needMin} min (or raise RUN_TIMEOUT_MS to >= ${needS}s) and re-run.`;
    return {
      armed: false, waitMs, budgetSource,
      reason: `waiting ~${Math.ceil(waitMs/1000)}s until past the ${resourceLabel} deadline (${deadlineRaw}) would exceed this run's budget (source: ${budgetSource}). ${hint}`,
    };
  }
  return { armed: true, waitMs, budgetSource, reason: '' };
}

/**
 * Sleep for plan.waitMs, then force-refresh the access token. Idempotent —
 * waitMs<=0 means "already past deadline, fire immediately" so no sleep.
 *
 * @param {{ plan: object, scenarioLabel: string }} opts
 */
async function runExpiredFlowWait(opts) {
  opts = opts || {};
  const plan          = opts.plan || {};
  const scenarioLabel = String(opts.scenarioLabel || 'expired-flow test');
  const deadlineRaw   = opts.deadlineRaw;

  if (plan.waitMs > 0) {
    validationLogger(`[INFO] ${scenarioLabel}: waiting ~${Math.ceil(plan.waitMs/1000)}s until just past the deadline${deadlineRaw ? ` (${deadlineRaw})` : ''} before firing the request... (budget source: ${plan.budgetSource})`);
    await new Promise(function (r) { setTimeout(r, plan.waitMs); });
    validationLogger(`[INFO] ${scenarioLabel}: wait complete — refreshing access token before firing the request.`);
  } else {
    validationLogger(`[INFO] ${scenarioLabel}: deadline already passed${deadlineRaw ? ` (${deadlineRaw})` : ''} — firing request now, expecting rejection.`);
  }
  try {
    await refreshAccessTokenIfNeeded({ force: true, callerLabel: scenarioLabel });
  } catch (e) {
    const msg = (e && e.message) ? e.message : String(e);
    validationLogger(`[WARNING] ${scenarioLabel}: token-refresh helper threw (${msg}) — request will use the original (possibly expired) token. If the provider 401/403s, that's why.`);
  }
}

/**
 * Grade an after-response when the expired flow was armed.
 *
 * @param {object} opts
 * @param {object} opts.res              Bruno response object
 * @param {string} opts.scenarioLabel    short label for log lines
 * @returns {{
 *   status:number,
 *   isClientError:boolean,
 *   isAuthFailure:boolean,
 *   hasProblemBody:boolean,
 *   expiryKeywordFound:boolean,
 *   body:object|null
 * }}
 */
function gradeExpiredFlowResponse(opts) {
  opts = opts || {};
  const res           = opts.res;
  const scenarioLabel = String(opts.scenarioLabel || 'expired-flow test');

  let status = 0;
  try { status = res.getStatus(); } catch (_e) { /* leave 0 */ }
  let body = null;
  try { body = res.getBody(); } catch (_e) { /* non-JSON / empty */ }

  const isAuthFailure       = status === 401 || status === 403;
  const isClientError       = status >= 400 && status < 500;
  const isObj               = body !== null && typeof body === 'object';
  const hasProblemBody      = isObj && !!(body.title || body.detail || body.code);
  const blob                = isObj ? JSON.stringify(body).toLowerCase() : '';
  const expiryKeywordFound  = /expir|time ?limit|deadline|too late|no longer|timed? ?out/.test(blob);

  if (isAuthFailure) {
    validationLogger(`[WARNING] ${scenarioLabel}: provider returned ${status} (auth error) — this typically means the access token expired during the long wait, not that the request was rejected for being expired. Look for an earlier "[WARNING] auth: refresh-access-token ..." line; if the refresh failed, the OSCAR loopback endpoint at /v1/runs/{id}/refresh-access-token did not return a fresh token. Distinguishing this from a genuine expiry rejection requires a re-run with a successful refresh.`);
  } else if (status >= 200 && status < 300) {
    validationLogger(`[ERROR] ${scenarioLabel}: provider returned ${status} and may have ACCEPTED an expired request — this should have been rejected.`);
  } else if (expiryKeywordFound) {
    validationLogger(`[INFO] ${scenarioLabel}: the error message indicates expiry.`);
  } else if (isClientError) {
    validationLogger(`[WARNING] ${scenarioLabel}: the provider rejected the request but the error does not clearly indicate expiry — recommended for diagnosability.`);
  } else {
    validationLogger(`[WARNING] ${scenarioLabel}: unexpected status ${status} — cannot confirm expiry behaviour.`);
  }

  return { status, isClientError, isAuthFailure, hasProblemBody, expiryKeywordFound, body };
}

module.exports = { planExpiredFlow, runExpiredFlowWait, gradeExpiredFlowResponse, BUFFER_MS, POST_MARGIN_MS };

// Expose to globalThis for the eval/require loader path (matches other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] expiredFlow globalThis exposure skipped: ' + (e && e.message));
}
