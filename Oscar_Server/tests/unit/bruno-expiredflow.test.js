// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-expiredflow.test.js — unit tests for the shared expired-flow helper
 * (Bruno_Collection/library-bruno/expiredFlow.js), introduced in Phase 1 of
 * the expired-flow generalization (#204 → expired-offer + future expired-X).
 *
 * Three exported functions, three test groups:
 *   - planExpiredFlow         — armed/skip logic + budget arithmetic
 *   - gradeExpiredFlowResponse — response categorisation (auth / 2xx / 4xx)
 *   - runExpiredFlowWait      — sleep + force token refresh (smoke only;
 *                                the helper is exercised end-to-end by the
 *                                Bruno integration runs)
 *
 * Harness mirrors bruno-envutils / bruno-scenarioparser: mock `bru` and the
 * validationLogger BEFORE requiring the module under test so its globalThis
 * exposure runs against the mocks.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};
// displays.js is required by expiredFlow.js at load (`const { validationLogger }
// = require('./displays.js')`). Mock it to capture the log lines emitted by the
// helper rather than letting the real implementation hit console.log / bru.getVar.
// (The real implementation honours loggingType filtering and also pushes into a
// __rptLogs var — neither is relevant to grading-logic assertions here.)
//
// Babel-jest's `jest.mock` factory only allows references to variables whose
// NAME is prefixed with `mock` (case-insensitive); any other out-of-scope var
// triggers `ReferenceError: Invalid variable access`. So the capture array MUST
// be named `mockLogCalls`, not `_logCalls`.
const mockLogCalls = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (msg) => { mockLogCalls.push(String(msg)); },
}));

// auth.js is transitively required by expiredFlow; mock it so runExpiredFlowWait
// does not try to hit the OSCAR loopback endpoint during tests.
jest.mock('../../../Bruno_Collection/library-bruno/auth.js', () => ({
  refreshAccessTokenIfNeeded: jest.fn().mockResolvedValue({ ok: true }),
}));

const {
  planExpiredFlow,
  gradeExpiredFlowResponse,
  runExpiredFlowWait,
  BUFFER_MS,
  buildAndArmExpiredFlowQueue,
  advanceExpiredFlowQueueOrFinish,
  nhfTestPrefix,
} = require('../../../Bruno_Collection/library-bruno/expiredFlow.js');

// Bruno's `runner.setNextRequest` doesn't exist in the unit-test harness — stub
// it so advanceExpiredFlowQueueOrFinish can route without throwing.
const mockSetNextRequest = jest.fn();
global.bru.runner = { setNextRequest: mockSetNextRequest };

beforeEach(() => {
  envStore = {};
  mockLogCalls.length = 0;
});

// ──────────────────────────────────────────────────────────────────────────
// planExpiredFlow
// ──────────────────────────────────────────────────────────────────────────
describe('planExpiredFlow', () => {
  test('skips with a clear reason when no deadlineRaw is supplied', () => {
    const r = planExpiredFlow({ deadlineRaw: '', resourceLabel: 'offer' });
    expect(r.armed).toBe(false);
    expect(r.waitMs).toBe(0);
    expect(r.reason).toMatch(/no offer deadline/);
  });

  test('skips when the deadline string is not a parseable date', () => {
    const r = planExpiredFlow({ deadlineRaw: 'not-a-date', resourceLabel: 'offer' });
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/not a valid date/);
  });

  test('arms with waitMs=0 when the deadline is already in the past', () => {
    const past = new Date(Date.now() - 60000).toISOString();
    const r = planExpiredFlow({ deadlineRaw: past, resourceLabel: 'offer' });
    expect(r.armed).toBe(true);
    expect(r.waitMs).toBe(0);
    expect(r.budgetSource).toMatch(/already past/);
  });

  test('arms with a positive waitMs when the deadline is in the future (within budget)', () => {
    // 30s in the future — wait will be ~30s + BUFFER_MS, well within budget.
    const future = new Date(Date.now() + 30000).toISOString();
    envStore.runHardDeadlineMs = String(Date.now() + 30 * 60 * 1000); // 30 min budget
    const r = planExpiredFlow({ deadlineRaw: future, resourceLabel: 'offer' });
    expect(r.armed).toBe(true);
    expect(r.waitMs).toBeGreaterThan(0);
    expect(r.waitMs).toBeLessThanOrEqual(30000 + BUFFER_MS + 1000); // small slack
    expect(r.budgetSource).toMatch(/RUN_TIMEOUT_MS|maxWaitMinutes|fallback/);
  });

  test('skips (with a budget hint) when waiting until the deadline would overrun the per-scenario Max wait', () => {
    // 10 min in the future, per-scenario budget of just 2 minutes → can't wait.
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const r = planExpiredFlow({
      deadlineRaw:    future,
      maxWaitMinutes: 2,
      resourceLabel:  'offer',
    });
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/exceed this run's budget/);
    // Hint must tell the user how to raise the budget.
    expect(r.reason).toMatch(/Raise the scenario's Max wait to >= \d+ min/);
    expect(r.budgetSource).toMatch(/scenario maxWaitMinutes=2/);
  });

  test('skips with the server-budget hint when no per-scenario Max wait is set', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    // No runHardDeadlineMs → conservative 8-min fallback kicks in → way too short.
    const r = planExpiredFlow({ deadlineRaw: future, resourceLabel: 'booking confirmation' });
    expect(r.armed).toBe(false);
    expect(r.budgetSource).toMatch(/8-min fallback/);
    expect(r.reason).toMatch(/RUN_TIMEOUT_MS/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// gradeExpiredFlowResponse
// ──────────────────────────────────────────────────────────────────────────
function fakeRes(status, body) {
  return {
    getStatus: () => status,
    getBody:   () => body,
  };
}

describe('gradeExpiredFlowResponse', () => {
  test('401 → isAuthFailure=true + a WARNING (token, not expiry)', () => {
    const g = gradeExpiredFlowResponse({
      res: fakeRes(401, { title: 'unauthorized' }),
      scenarioLabel: 'Expired offer',
    });
    expect(g.status).toBe(401);
    expect(g.isAuthFailure).toBe(true);
    expect(g.isClientError).toBe(true);
    expect(mockLogCalls.join('\n')).toMatch(/\[WARNING\] Expired offer: provider returned 401/);
  });

  test('403 → isAuthFailure=true (same path as 401)', () => {
    const g = gradeExpiredFlowResponse({ res: fakeRes(403, null), scenarioLabel: 'Expired booking' });
    expect(g.isAuthFailure).toBe(true);
    expect(g.isClientError).toBe(true);
  });

  test('2xx → ERROR log (provider accepted an expired request)', () => {
    const g = gradeExpiredFlowResponse({ res: fakeRes(200, { ok: true }), scenarioLabel: 'Expired offer' });
    expect(g.status).toBe(200);
    expect(g.isClientError).toBe(false);
    expect(g.isAuthFailure).toBe(false);
    expect(mockLogCalls.join('\n')).toMatch(/\[ERROR\] Expired offer: provider returned 200/);
  });

  test('4xx + Problem body with expiry keyword → INFO log + hasProblemBody=true', () => {
    const body = {
      title:  'Offer expired',
      detail: 'The offer is no longer valid (validUntil passed).',
      code:   'OFFER_EXPIRED',
    };
    const g = gradeExpiredFlowResponse({
      res: fakeRes(422, body),
      scenarioLabel: 'Expired offer',
    });
    expect(g.status).toBe(422);
    expect(g.isClientError).toBe(true);
    expect(g.isAuthFailure).toBe(false);
    expect(g.hasProblemBody).toBe(true);
    expect(g.expiryKeywordFound).toBe(true);
    expect(mockLogCalls.join('\n')).toMatch(/\[INFO\] Expired offer: the error message indicates expiry/);
  });

  test('4xx + Problem body without expiry keyword → WARNING (rejected but unclear)', () => {
    const body = { title: 'Bad request', detail: 'something went wrong', code: 'BAD' };
    const g = gradeExpiredFlowResponse({ res: fakeRes(400, body), scenarioLabel: 'Expired offer' });
    expect(g.expiryKeywordFound).toBe(false);
    expect(g.hasProblemBody).toBe(true);
    expect(mockLogCalls.join('\n')).toMatch(/\[WARNING\] Expired offer: the provider rejected the request but the error does not clearly indicate expiry/);
  });

  test('4xx with no body → no Problem body, still graded as client error', () => {
    const g = gradeExpiredFlowResponse({ res: fakeRes(400, null), scenarioLabel: 'Expired offer' });
    expect(g.hasProblemBody).toBe(false);
    expect(g.isClientError).toBe(true);
  });

  test('5xx → WARNING (unexpected status)', () => {
    const g = gradeExpiredFlowResponse({ res: fakeRes(503, null), scenarioLabel: 'Expired offer' });
    expect(g.isClientError).toBe(false);
    expect(mockLogCalls.join('\n')).toMatch(/\[WARNING\] Expired offer: unexpected status 503/);
  });

  test('detects expiry keyword in any case ("Time limit exceeded", "timed out", "no longer", ...)', () => {
    const cases = [
      'Time limit exceeded',
      'request timed out',
      'this offer is no longer available',
      'past the deadline',
      'too late — try again',
    ];
    for (const detail of cases) {
      mockLogCalls.length = 0;
      const g = gradeExpiredFlowResponse({
        res: fakeRes(422, { title: 'rejected', detail }),
        scenarioLabel: 'Expired offer',
      });
      expect(g.expiryKeywordFound).toBe(true);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runExpiredFlowWait
// ──────────────────────────────────────────────────────────────────────────
describe('runExpiredFlowWait', () => {
  test('waitMs<=0 short-circuits and still triggers a token refresh', async () => {
    const { refreshAccessTokenIfNeeded } = require('../../../Bruno_Collection/library-bruno/auth.js');
    refreshAccessTokenIfNeeded.mockClear();

    await runExpiredFlowWait({
      plan: { armed: true, waitMs: 0, budgetSource: 'already past', reason: '' },
      scenarioLabel: 'unit-test (no-wait)',
    });

    expect(refreshAccessTokenIfNeeded).toHaveBeenCalledTimes(1);
    expect(refreshAccessTokenIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, callerLabel: 'unit-test (no-wait)' }),
    );
    // The "deadline already passed" log line tells the operator we're firing now.
    expect(mockLogCalls.join('\n')).toMatch(/deadline already passed/);
  });

  test('a refresh throw degrades to a warning but still resolves (request will use the old token)', async () => {
    const { refreshAccessTokenIfNeeded } = require('../../../Bruno_Collection/library-bruno/auth.js');
    refreshAccessTokenIfNeeded.mockClear();
    refreshAccessTokenIfNeeded.mockRejectedValueOnce(new Error('boom'));

    await expect(runExpiredFlowWait({
      plan: { armed: true, waitMs: 0, budgetSource: 'already past', reason: '' },
      scenarioLabel: 'unit-test (throw)',
    })).resolves.toBeUndefined();

    expect(mockLogCalls.join('\n')).toMatch(/\[WARNING\] unit-test \(throw\): token-refresh helper threw \(boom\)/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// PR B: auto-expansion — buildAndArmExpiredFlowQueue / advance / nhfTestPrefix
// ──────────────────────────────────────────────────────────────────────────
describe('buildAndArmExpiredFlowQueue', () => {
  test('single armed timer → queue = [that timer], flag stays on', () => {
    envStore.expiredOfferTest = 'true';
    envStore.expiredBookingTest = 'false';
    const q = buildAndArmExpiredFlowQueue();
    expect(q).toHaveLength(1);
    expect(q[0].code).toBe('OTO');
    // Flag remains armed (it's queue[0]) so 02.yml's gate fires.
    expect(envStore.expiredOfferTest).toBe('true');
    // Queue + index persisted to env.
    expect(JSON.parse(envStore.__expiredFlowQueue)[0].code).toBe('OTO');
    expect(envStore.__expiredFlowQueueIndex).toBe('0');
  });

  test('two armed timers → queue holds both in flow order; only queue[0]\'s flag stays on', () => {
    envStore.expiredOfferTest = 'true';
    envStore.expiredBookingTest = 'true';
    const q = buildAndArmExpiredFlowQueue();
    expect(q.map(t => t.code)).toEqual(['OTO', 'BTO']);
    // queue[0] (OTO) flag is ON; the rest are explicitly disarmed.
    expect(envStore.expiredOfferTest).toBe('true');
    expect(envStore.expiredBookingTest).toBe('false');
  });

  test('refund timer on a SALE scenario → dropped from queue with WARNING (gate fails)', () => {
    envStore.expiredRefundOfferTest = 'true';
    envStore.scenarioType = 'SALE'; // gate requires REFUND
    const q = buildAndArmExpiredFlowQueue();
    expect(q).toHaveLength(0);
    expect(envStore.expiredRefundOfferTest).toBe('false'); // disarmed defensively
    expect(mockLogCalls.join('\n')).toMatch(/expiredRefundOfferTest is on but its gated request will not fire/);
  });

  test('exchange timer on EXCHANGE scenario → queued', () => {
    envStore.expiredExchangeOfferTest = 'true';
    envStore.scenarioType = 'EXCHANGE';
    const q = buildAndArmExpiredFlowQueue();
    expect(q.map(t => t.code)).toEqual(['ETO']);
  });

  test('add-reservation requires both salesFlow_placeSelection AND ADD_TO_BOOKING', () => {
    envStore.expiredAddReservationOfferTest = 'true';
    envStore.salesFlow_placeSelection = 'true';
    envStore.placeSelectionMode = 'SEATMAP_AT_OFFER'; // wrong mode
    const q1 = buildAndArmExpiredFlowQueue();
    expect(q1).toHaveLength(0);

    envStore.expiredAddReservationOfferTest = 'true';
    envStore.placeSelectionMode = 'ADD_TO_BOOKING';
    const q2 = buildAndArmExpiredFlowQueue();
    expect(q2.map(t => t.code)).toEqual(['ARO']);
  });

  test('order is OTO → BTO → ARO → ATO → RTO → ETO (in-flow), regardless of scenario field order', () => {
    envStore.expiredExchangeOfferTest = 'true'; envStore.scenarioType = 'EXCHANGE';
    envStore.expiredBookingTest = 'true';
    envStore.expiredOfferTest = 'true';
    const q = buildAndArmExpiredFlowQueue();
    expect(q.map(t => t.code)).toEqual(['OTO', 'BTO', 'ETO']);
    // First-in-flow is armed.
    expect(envStore.expiredOfferTest).toBe('true');
    expect(envStore.expiredBookingTest).toBe('false');
    expect(envStore.expiredExchangeOfferTest).toBe('false');
  });

  test('no armed timers → empty queue; flags untouched (apart from explicit disarms)', () => {
    envStore.expiredOfferTest = 'false';
    const q = buildAndArmExpiredFlowQueue();
    expect(q).toEqual([]);
    expect(envStore.__expiredFlowQueue).toBe('[]');
    expect(envStore.__expiredFlowQueueIndex).toBe('0');
  });
});

describe('advanceExpiredFlowQueueOrFinish', () => {
  beforeEach(() => { mockSetNextRequest.mockClear(); });

  test('queue of 1 → returns false (no advance); caller runs cross-scenario tail', () => {
    envStore.__expiredFlowQueue = JSON.stringify([{ code: 'OTO', flag: 'expiredOfferTest', wait: 'expiredOfferMaxWaitMinutes', label: 'Expired offer' }]);
    envStore.__expiredFlowQueueIndex = '0';
    expect(advanceExpiredFlowQueueOrFinish({ scenarioLabel: 'test' })).toBe(false);
    expect(mockSetNextRequest).not.toHaveBeenCalled();
  });

  test('queue of 2, idx=0 → advances: disarm current, arm next, set pending flag, route to 01', () => {
    envStore.__expiredFlowQueue = JSON.stringify([
      { code: 'OTO', flag: 'expiredOfferTest',   wait: 'expiredOfferMaxWaitMinutes',   label: 'Expired offer' },
      { code: 'BTO', flag: 'expiredBookingTest', wait: 'expiredBookingMaxWaitMinutes', label: 'Expired booking' },
    ]);
    envStore.__expiredFlowQueueIndex = '0';
    envStore.expiredOfferTest = 'true';
    envStore.expiredBookingTest = 'false';

    const advanced = advanceExpiredFlowQueueOrFinish({ scenarioLabel: 'Expired offer' });

    expect(advanced).toBe(true);
    expect(envStore.expiredOfferTest).toBe('false');
    expect(envStore.expiredBookingTest).toBe('true');
    expect(envStore.__expiredFlowQueueIndex).toBe('1');
    expect(envStore.__expiredFlowSubRunPending).toBe('true');
    expect(mockSetNextRequest).toHaveBeenCalledWith('01. POST Get Offer');
  });

  test('queue of 2, idx=1 (last) → returns false (no further advance)', () => {
    envStore.__expiredFlowQueue = JSON.stringify([
      { code: 'OTO', flag: 'expiredOfferTest',   wait: 'expiredOfferMaxWaitMinutes',   label: 'Expired offer' },
      { code: 'BTO', flag: 'expiredBookingTest', wait: 'expiredBookingMaxWaitMinutes', label: 'Expired booking' },
    ]);
    envStore.__expiredFlowQueueIndex = '1';
    expect(advanceExpiredFlowQueueOrFinish({ scenarioLabel: 'Expired booking' })).toBe(false);
  });
});

describe('nhfTestPrefix', () => {
  test('returns empty string for queue length 0', () => {
    envStore.__expiredFlowQueue = '[]';
    expect(nhfTestPrefix()).toBe('');
  });

  test('returns empty string for single-timer queue (legacy assertion names)', () => {
    envStore.__expiredFlowQueue = JSON.stringify([{ code: 'OTO' }]);
    envStore.__expiredFlowQueueIndex = '0';
    expect(nhfTestPrefix()).toBe('');
  });

  test('returns [NHF_<code>_<scenario>] for multi-timer queue', () => {
    envStore.__expiredFlowQueue = JSON.stringify([{ code: 'OTO' }, { code: 'BTO' }]);
    envStore.__expiredFlowQueueIndex = '0';
    envStore.scenarioCode = 'SC_PARIS_LYON';
    expect(nhfTestPrefix()).toBe('[NHF_OTO_SC_PARIS_LYON] ');
    envStore.__expiredFlowQueueIndex = '1';
    expect(nhfTestPrefix()).toBe('[NHF_BTO_SC_PARIS_LYON] ');
  });

  test('strips leading NHF_ from scenario code (no double prefix)', () => {
    envStore.__expiredFlowQueue = JSON.stringify([{ code: 'OTO' }, { code: 'BTO' }]);
    envStore.__expiredFlowQueueIndex = '0';
    envStore.scenarioCode = 'NHF_SC_FOO';
    expect(nhfTestPrefix()).toBe('[NHF_OTO_SC_FOO] ');
  });

  test('falls back to "SC" when scenarioCode is unset', () => {
    envStore.__expiredFlowQueue = JSON.stringify([{ code: 'RTO' }, { code: 'OTO' }]);
    envStore.__expiredFlowQueueIndex = '0';
    delete envStore.scenarioCode;
    expect(nhfTestPrefix()).toBe('[NHF_RTO_SC] ');
  });
});
