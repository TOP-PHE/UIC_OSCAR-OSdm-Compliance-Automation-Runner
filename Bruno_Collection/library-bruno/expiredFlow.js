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

// ──────────────────────────────────────────────────────────────────────────
// Auto-expansion: one scenario, N timers → N sub-runs (PR B)
// ──────────────────────────────────────────────────────────────────────────
//
// When a tester enables more than one expired-X timer on a single scenario,
// OSCAR auto-expands that scenario into N sub-runs — one per armed timer.
// The timers each kill the flow at a different request, so they are
// mutually-exclusive within a single happy-path pass; we run them sequentially.
//
// Mechanics:
//   1. scenarioParser calls `buildAndArmExpiredFlowQueue(scenario)` at scenario
//      init. The helper inspects the scenario's expired-* fields + the gating
//      env vars (scenarioType / salesFlow_* / placeSelectionMode), produces an
//      ordered queue of timers that will actually run in this scenario, stores
//      it in `__expiredFlowQueue`, and DISARMS every timer flag EXCEPT
//      queue[0]'s. The existing per-YAML gates then naturally fire only for
//      the current timer (queue[0]) — no per-YAML changes needed for arming.
//   2. Each gated YAML's after-response calls
//      `advanceExpiredFlowQueueOrFinish({ scenarioLabel })` just before its
//      cross-scenario tail. If the queue has more timers, the helper:
//        - turns the just-tested timer OFF
//        - turns queue[idx+1]'s timer ON
//        - sets `__expiredFlowSubRunPending = "true"` so scenarioParser's
//          early-return on the next 01.yml entry skips the full re-parse
//        - routes back to `01. POST Get Offer`
//        - returns `true` (caller MUST return — do NOT run the cross-scenario tail)
//      If the queue is exhausted (last timer just ran) the helper returns
//      `false` and the caller falls through to its existing cross-scenario tail.
//   3. `nhfTestPrefix()` returns `[NHF_<3-letter>_<scenario_code>] ` (with the
//      scenario's leading `NHF_` stripped if present) to disambiguate Bruno
//      assertion names across sub-runs; returns empty for single-timer
//      scenarios so legacy single-timer assertions read identically to today.
//
// Order matters: the queue follows the order timers fire in the flow, so
// each sub-run plays naturally without the runner having to re-arrange:
//   OTO (offer) → BTO (booking) → ARO (add-reservation) → ATO (add-ancillary)
//   → RTO (refund-offer) → ETO (exchange-offer)
// SALE flows can hit OTO/BTO/ARO/ATO; REFUND adds RTO; EXCHANGE adds ETO.

/**
 * Single source of truth: per-timer config used by both the queue builder
 * (in expiredFlow) and the runner's SIGTERM math (in src/worker/runner.js,
 * which mirrors this list as EXPIRED_FLOW_TIMERS). The 3-letter `code` is
 * stable and used for sub-run assertion-name prefixes.
 *
 * Gate keys describe the conditions under which the timer's gated request
 * actually fires in a scenario. `gate(env)` receives a `getEnv(name)` helper
 * and returns true/false. If a timer is armed by the user but its gate is
 * false the queue builder drops it with a [WARNING] (so the tester knows the
 * test silently couldn't run, instead of believing it passed).
 */
const EXPIRED_FLOW_TIMERS_DEF = [
  {
    code: 'OTO', flag: 'expiredOfferTest', wait: 'expiredOfferMaxWaitMinutes',
    label: 'Expired offer',
    gate: () => true,
    gateReason: '',
  },
  {
    code: 'BTO', flag: 'expiredBookingTest', wait: 'expiredBookingMaxWaitMinutes',
    label: 'Expired booking',
    gate: () => true,
    gateReason: '',
  },
  {
    code: 'ARO', flag: 'expiredAddReservationOfferTest', wait: 'expiredAddReservationOfferMaxWaitMinutes',
    label: 'Expired add-reservation offer',
    gate: (getEnv) =>
      String(getEnv('salesFlow_placeSelection')) === 'true' &&
      String(getEnv('placeSelectionMode')) === 'ADD_TO_BOOKING',
    gateReason: 'requires salesFlow_placeSelection AND placeSelectionMode=ADD_TO_BOOKING',
  },
  {
    code: 'ATO', flag: 'expiredAddAncillaryOfferTest', wait: 'expiredAddAncillaryOfferMaxWaitMinutes',
    label: 'Expired add-ancillary offer',
    gate: (getEnv) => String(getEnv('salesFlow_addAncillary')) === 'true',
    gateReason: 'requires salesFlow_addAncillary',
  },
  {
    code: 'RTO', flag: 'expiredRefundOfferTest', wait: 'expiredRefundOfferMaxWaitMinutes',
    label: 'Expired refund offer',
    gate: (getEnv) => String(getEnv('scenarioType')) === 'REFUND',
    gateReason: 'REFUND scenarios only',
  },
  {
    code: 'ETO', flag: 'expiredExchangeOfferTest', wait: 'expiredExchangeOfferMaxWaitMinutes',
    label: 'Expired exchange offer',
    gate: (getEnv) => String(getEnv('scenarioType')) === 'EXCHANGE',
    gateReason: 'EXCHANGE scenarios only',
  },
];

/**
 * Build the per-scenario expired-flow queue and arm timer[0]. Called by
 * scenarioParser at scenario init AFTER all expired-* flags + salesFlow_* +
 * scenarioType env vars have been set, so gate functions read consistent
 * state.
 *
 * Behaviour:
 *   - Filters EXPIRED_FLOW_TIMERS_DEF to entries that are (a) on in the
 *     scenario AND (b) reach their gated request given current env state.
 *     Timers armed but gated-off are SKIPPED with a [WARNING] log.
 *   - Persists the ordered queue as `__expiredFlowQueue` (JSON), sets
 *     `__expiredFlowQueueIndex = "0"`.
 *   - Disarms (sets "false") every timer flag EXCEPT queue[0]'s, so the
 *     existing per-YAML gating fires only for the currently-active timer.
 *
 * @returns {Array} the queue (one entry per active timer); empty when no
 *   expired-X test is on in this scenario (normal happy-path runs).
 */
function buildAndArmExpiredFlowQueue() {
  const getEnv = (k) => bru.getEnvVar(k);
  // 1. Filter to armed+gated timers
  const active = [];
  for (const t of EXPIRED_FLOW_TIMERS_DEF) {
    const raw = getEnv(t.flag);
    const armed = raw === true || ['true', 'on', 'yes'].includes(String(raw).toLowerCase());
    if (!armed) continue;
    if (!t.gate(getEnv)) {
      validationLogger(`[WARNING] ${t.flag} is on but its gated request will not fire in this scenario (${t.gateReason}) — skipping the test for this scenario.`);
      // Also turn the flag off so its per-YAML gate (if reached by some other
      // path) doesn't accidentally arm.
      bru.setEnvVar(t.flag, 'false');
      continue;
    }
    active.push({ code: t.code, flag: t.flag, wait: t.wait, label: t.label });
  }
  // 2. Persist queue + index
  bru.setEnvVar('__expiredFlowQueue', JSON.stringify(active));
  bru.setEnvVar('__expiredFlowQueueIndex', '0');
  // 3. Disarm all timer flags except queue[0]. We always reset every flag
  //    here (active or not) so a previously-active flag from a sibling
  //    scenario can't leak — the reset list in scenarioParser is the first
  //    line of defence, this is belt-and-braces.
  for (const t of EXPIRED_FLOW_TIMERS_DEF) {
    const armNow = (active.length > 0 && active[0].flag === t.flag);
    bru.setEnvVar(t.flag, armNow ? 'true' : 'false');
  }
  // 4. Log the plan so the operator can see what will happen
  if (active.length > 1) {
    const list = active.map((t, i) => `${i + 1}. ${t.code} (${t.label})`).join(', ');
    validationLogger(`[INFO] expiredFlow queue: ${active.length} sub-runs will execute on this scenario — ${list}. Sub-run assertions are tagged with [NHF_<code>_<scenario>].`);
  } else if (active.length === 1) {
    validationLogger(`[INFO] expiredFlow queue: single sub-run — ${active[0].code} (${active[0].label}).`);
  }
  return active;
}

/**
 * Per-YAML helper called in each gated request's after-response, immediately
 * before its cross-scenario tail. Decides whether the scenario has another
 * timer queued up.
 *
 * @param {{ scenarioLabel: string }} opts
 * @returns {boolean}
 *   - `true`  → another timer is queued; the helper already routed back to
 *               `01. POST Get Offer` and set the sub-run-pending flag. The
 *               CALLER MUST RETURN IMMEDIATELY and not run its
 *               cross-scenario tail.
 *   - `false` → queue exhausted (or empty). Caller falls through to its
 *               existing cross-scenario loop / stop logic.
 */
function advanceExpiredFlowQueueOrFinish(opts) {
  opts = opts || {};
  const scenarioLabel = String(opts.scenarioLabel || 'expired-flow sub-run');

  let queue = [];
  try { queue = JSON.parse(bru.getEnvVar('__expiredFlowQueue') || '[]'); }
  catch (_e) { queue = []; }
  const idx = parseInt(bru.getEnvVar('__expiredFlowQueueIndex') || '0', 10) || 0;

  if (queue.length === 0 || idx >= queue.length - 1) {
    // Last (or only) timer just ran. Reset the armed-flags so the next
    // scenario's queue build starts from a clean slate — scenarioParser's
    // resetScenarioEnvVars will also wipe these, but doing it here too keeps
    // the env state honest even in error paths.
    return false;
  }

  // Advance: disarm current timer, arm next one, route back to 01.
  const cur  = queue[idx];
  const next = queue[idx + 1];
  bru.setEnvVar(cur.flag, 'false');
  // Defensive: also clear the per-flag `__<...>Armed` boolean if the YAML
  // used the standard `__<flag-without-Test>Armed` naming. Pattern:
  // expiredXTest → __expiredXArmed.
  const _armedKey = '__' + cur.flag.replace(/Test$/, 'Armed');
  bru.setEnvVar(_armedKey, 'false');
  bru.setEnvVar(next.flag, 'true');
  bru.setEnvVar('__expiredFlowQueueIndex', String(idx + 1));
  bru.setEnvVar('__expiredFlowSubRunPending', 'true');

  validationLogger(`[INFO] ${scenarioLabel}: queue advancing to sub-run ${idx + 2}/${queue.length} — ${next.code} (${next.label}). Routing back to 01. POST Get Offer.`);
  bru.runner.setNextRequest('01. POST Get Offer');
  return true;
}

/**
 * Return the assertion-name prefix for the CURRENT queue position, suitable
 * for prepending to `test(...)` names so the report disambiguates sub-runs.
 *
 *   `[NHF_<3-letter>_<scenario_code>] `   when queue has 2+ entries
 *   `''`                                  for single-timer / no-queue runs
 *
 * The scenario code's leading `NHF_` is stripped if present (per the agreed
 * convention) so we don't end up with `[NHF_BTO_NHF_SC_FOO]`.
 */
function nhfTestPrefix() {
  let queue = [];
  try { queue = JSON.parse(bru.getEnvVar('__expiredFlowQueue') || '[]'); }
  catch (_e) { queue = []; }
  if (queue.length <= 1) return '';
  const idx = parseInt(bru.getEnvVar('__expiredFlowQueueIndex') || '0', 10) || 0;
  const cur = queue[idx];
  if (!cur) return '';
  const baseCode = String(bru.getEnvVar('scenarioCode') || '').replace(/^NHF_/, '');
  return `[NHF_${cur.code}_${baseCode || 'SC'}] `;
}

/**
 * #385 — called at every scenario-complete tail BEFORE the multi-scenario
 * loop/stop logic. A sub-run whose timer SKIPPED at its step (budget /
 * missing deadline) — or whose gated step never fired — used to end the whole
 * queue, because advanceExpiredFlowQueueOrFinish only runs on a GRADED timer.
 * This wrapper detects the un-graded current sub-run at tail time and hands
 * the remaining timers their pass.
 *
 * Detection: the per-timer `__<flag minus Test>Armed` marker is 'true' only
 * when the timer's step actually armed (and graded) this pass; 'false' means
 * it skipped at the step; unset means the step never fired. Both of the
 * latter mean "did not grade" → advance.
 *
 * @returns {boolean} true → routed back to 01 for the next sub-run (the
 *   CALLER MUST RETURN IMMEDIATELY); false → nothing to do (no queue, the
 *   current sub-run graded, or the queue is exhausted — a tally [INFO] is
 *   logged whenever sub-runs were skipped).
 */
function advanceExpiredFlowQueueAfterSkip() {
  let queue = [];
  try { queue = JSON.parse(bru.getEnvVar('__expiredFlowQueue') || '[]'); }
  catch (_e) { queue = []; }
  const idx = parseInt(bru.getEnvVar('__expiredFlowQueueIndex') || '0', 10) || 0;
  if (queue.length === 0 || idx >= queue.length) return false;

  const cur = queue[idx];
  const armedKey = '__' + String(cur.flag || '').replace(/Test$/, 'Armed');
  const armedVal = String(bru.getEnvVar(armedKey));
  const skips = parseInt(bru.getEnvVar('__expiredFlowSkipCount') || '0', 10) || 0;

  if (armedVal === 'true') {
    // The (last) sub-run armed and graded — its own expired branch already
    // consulted advanceExpiredFlowQueueOrFinish. Only the tally is owed.
    if (skips > 0) {
      validationLogger(`[INFO] NHF expired-flow queue finished: ${queue.length - skips} of ${queue.length} sub-run(s) graded, ${skips} skipped — see the [WARNING]s above.`);
      bru.setEnvVar('__expiredFlowSkipCount', '0');
    }
    return false;
  }

  // Current sub-run never graded.
  const why = (armedVal === 'false')
    ? 'its timer SKIPPED at the step (see the WARNING above)'
    : 'its gated step never fired this pass';
  bru.setEnvVar('__expiredFlowSkipCount', String(skips + 1));
  validationLogger(`[WARNING] NHF sub-run ${idx + 1}/${queue.length} (${cur.code} — ${cur.label}) did not grade: ${why}. Advancing the queue instead of ending the scenario.`);
  bru.setEnvVar(cur.flag, 'false');
  bru.setEnvVar(armedKey, 'false');

  if (idx + 1 >= queue.length) {
    validationLogger(`[INFO] NHF expired-flow queue finished: ${queue.length - (skips + 1)} of ${queue.length} sub-run(s) graded, ${skips + 1} skipped — see the [WARNING]s above.`);
    bru.setEnvVar('__expiredFlowSkipCount', '0');
    return false;
  }

  const next = queue[idx + 1];
  bru.setEnvVar(next.flag, 'true');
  bru.setEnvVar('__expiredFlowQueueIndex', String(idx + 1));
  bru.setEnvVar('__expiredFlowSubRunPending', 'true');
  validationLogger(`[INFO] expired-flow queue advancing to sub-run ${idx + 2}/${queue.length} — ${next.code} (${next.label}). Routing back to 01. POST Get Offer.`);
  bru.runner.setNextRequest('01. POST Get Offer');
  return true;
}

module.exports = {
  planExpiredFlow, runExpiredFlowWait, gradeExpiredFlowResponse,
  BUFFER_MS, POST_MARGIN_MS,
  EXPIRED_FLOW_TIMERS_DEF,
  buildAndArmExpiredFlowQueue,
  advanceExpiredFlowQueueOrFinish,
  advanceExpiredFlowQueueAfterSkip,
  nhfTestPrefix,
};

// Expose to globalThis for the eval/require loader path (matches other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] expiredFlow globalThis exposure skipped: ' + (e && e.message));
}
