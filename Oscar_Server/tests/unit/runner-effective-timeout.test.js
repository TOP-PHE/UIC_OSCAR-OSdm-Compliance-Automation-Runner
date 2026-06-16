/**
 * runner-effective-timeout.test.js — regression test for #204 / PR fix
 *
 * The expired-booking timer (#204) relies on the runner extending its SIGTERM
 * to cover a scenario's `expiredBookingMaxWaitMinutes` opt-in. The original
 * implementation read the datafile with plain `fs.readFile` + JSON.parse —
 * which silently failed because, since OSCAR v1.11.0 (Phase 2 of issue #60),
 * the datafile on disk is AES-256-GCM encrypted under the OSCAR1 envelope.
 * `JSON.parse(ciphertext)` threw, the catch block silently swallowed the
 * error, and the helper fell back to the base RUN_TIMEOUT_MS — so every
 * scenario that opted into a longer wait got SIGTERMed at 10 min regardless.
 *
 * This test pins the contract: with an encrypted datafile carrying a
 * scenario that has `expiredBookingTest: 'on'` and
 * `expiredBookingMaxWaitMinutes: 30`, the helper must return an extended
 * effectiveMs (clamped to RUN_HARD_MAX_TIMEOUT_MS).
 */
'use strict';

const fs     = require('node:fs');
const path   = require('node:path');
const crypto = require('node:crypto');

const { computeEffectiveRunTimeoutMs } = require('../../src/worker/runner');
const { encryptToFileAsync }           = require('../../src/utils/at-rest');

// CRITICAL: writes MUST go under the project's data/artifacts/ tree — the
// at-rest helper's `_assertWritablePath` refuses anything outside data/artifacts
// or data/datafiles (this is exactly what bit the first version of this test
// in CI). Tests use a per-suite random subdir for isolation; cleanup wipes it.
const SCRATCH = path.resolve(__dirname, '../../data/artifacts',
                             `_test_${crypto.randomBytes(16).toString('hex')}`);
fs.mkdirSync(SCRATCH, { mode: 0o700, recursive: true });

let _counter = 0;
function tmpFile(name) {
  return path.join(SCRATCH, `${name}-${++_counter}.json`);
}

async function writeEncryptedDatafile(content) {
  const p = tmpFile('encrypted-datafile');
  await encryptToFileAsync(Buffer.from(JSON.stringify(content), 'utf8'), p);
  return p;
}

function makeScenario(code, overrides = {}) {
  return {
    code,
    collection: 'OTST',
    loggingType: 'INFO',
    scenarioType: 'SALE',
    scenarioAction: '',
    osdmVersion: '3.5',
    overruleCode: '',
    tripRequirementId: 1,
    passengersListId: 1,
    requestedFulfillmentOptionsListId: 1,
    expiredBookingTest: 'off',
    ...overrides,
  };
}

describe('computeEffectiveRunTimeoutMs (#204 datafile-decrypt regression guard)', () => {
  afterAll(() => {
    // Best-effort wipe of the whole scratch dir.
    try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  });

  test('extends timeout for an in-scope scenario that opts into a longer wait (the #204 happy path)', async () => {
    const datafile = {
      scenariosToRun: ['SC_BKTIMEOUT'],
      scenarios: [makeScenario('SC_BKTIMEOUT', {
        expiredBookingTest: 'on',
        expiredBookingMaxWaitMinutes: 20,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_BKTIMEOUT');

    // 20 minutes + 60s buffer = 1260000 ms
    expect(r.requestedMs).toBe(20 * 60 * 1000 + 60000);
    // Effective should be the requested value (well under the 30 min server cap)
    expect(r.effectiveMs).toBe(r.requestedMs);
    expect(r.helperError).toBeNull();
    expect(r.clamped).toBe(false);
    expect(r.source).toMatch(/expiredBookingMaxWaitMinutes/);
    expect(r.source).toMatch(/SC_BKTIMEOUT/);
  });

  test('falls back to base RUN_TIMEOUT_MS for a scenario with expiredBookingTest=off (sanity)', async () => {
    const datafile = {
      scenariosToRun: ['SC_NORMAL'],
      scenarios: [makeScenario('SC_NORMAL', {
        expiredBookingTest: 'off',
        expiredBookingMaxWaitMinutes: 30,  // value set, but expiredBookingTest is off
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_NORMAL');

    expect(r.requestedMs).toBe(0);
    expect(r.effectiveMs).toBe(r.baseMs);
    expect(r.helperError).toBeNull();
    expect(r.source).toMatch(/RUN_TIMEOUT_MS/);
    expect(r.scenariosInScope).toBe(1);
  });

  test('clamps to RUN_HARD_MAX_TIMEOUT_MS when scenario asks for more than the server cap', async () => {
    // Wizard caps at 60 min in the input; helper clamp is what matters server-side.
    // RUN_HARD_MAX_TIMEOUT_MS defaults to 1800000 (30 min); 45 min request gets clamped.
    const datafile = {
      scenariosToRun: ['SC_LONG'],
      scenarios: [makeScenario('SC_LONG', {
        expiredBookingTest: 'on',
        expiredBookingMaxWaitMinutes: 45,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_LONG');

    expect(r.requestedMs).toBe(45 * 60 * 1000 + 60000);
    expect(r.effectiveMs).toBe(r.hardMaxMs);
    expect(r.clamped).toBe(true);
    expect(r.source).toMatch(/clamped/);
  });

  test('captures helperError when the datafile is missing/unreadable (no silent fallback)', async () => {
    const missing = tmpFile('does-not-exist');
    const r = await computeEffectiveRunTimeoutMs(missing, 'ANY');

    expect(r.requestedMs).toBe(0);
    expect(r.effectiveMs).toBe(r.baseMs);
    expect(r.helperError).toBeTruthy();
    expect(r.source).toMatch(/FAILED/);
  });

  test('reads a legacy PLAINTEXT datafile (no OSCAR1 envelope) — back-compat', async () => {
    // Some installs may still have legacy plaintext datafiles. decryptFromFileAsync
    // passes them through unchanged (no OSCAR1 magic header detected). The helper
    // must therefore read them just as well as encrypted ones.
    const datafile = {
      scenariosToRun: ['SC_LEGACY'],
      scenarios: [makeScenario('SC_LEGACY', {
        expiredBookingTest: 'on',
        expiredBookingMaxWaitMinutes: 15,
      })],
    };
    const p = tmpFile('legacy-plaintext');
    fs.writeFileSync(p, JSON.stringify(datafile), 'utf8');

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_LEGACY');

    expect(r.helperError).toBeNull();
    expect(r.requestedMs).toBe(15 * 60 * 1000 + 60000);
  });

  test('accepts boolean true / "true" / "on" / "yes" for expiredBookingTest', async () => {
    const variants = [true, 'true', 'on', 'YES']; // covers case-insensitive string forms too
    for (const v of variants) {
      const datafile = {
        scenariosToRun: ['SC_V'],
        scenarios: [makeScenario('SC_V', {
          expiredBookingTest: v,
          expiredBookingMaxWaitMinutes: 5,
        })],
      };
      const p = await writeEncryptedDatafile(datafile);
        const r = await computeEffectiveRunTimeoutMs(p, 'SC_V');
      expect(r.requestedMs).toBe(5 * 60 * 1000 + 60000);
    }
  });

  test('honours scenariosToRun="ALL" when no scenarioOverride is given', async () => {
    const datafile = {
      scenariosToRun: 'ALL',
      scenarios: [
        makeScenario('A', { expiredBookingTest: 'on', expiredBookingMaxWaitMinutes: 10 }),
        makeScenario('B', { expiredBookingTest: 'off' }),
      ],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, null);

    expect(r.requestedMs).toBe(10 * 60 * 1000 + 60000);
    expect(r.scenariosInScope).toBe(2);
  });

  // ── Phase 2: expiredOfferTest must drive the SAME auto-extension path ─────
  test('extends timeout for an in-scope scenario that opts into a longer expiredOfferMaxWaitMinutes', async () => {
    const datafile = {
      scenariosToRun: ['SC_OFFERTIMEOUT'],
      scenarios: [makeScenario('SC_OFFERTIMEOUT', {
        expiredOfferTest: 'on',
        expiredOfferMaxWaitMinutes: 12,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_OFFERTIMEOUT');

    expect(r.requestedMs).toBe(12 * 60 * 1000 + 60000);
    expect(r.effectiveMs).toBe(r.requestedMs);
    expect(r.helperError).toBeNull();
    expect(r.clamped).toBe(false);
    expect(r.source).toMatch(/expiredOfferMaxWaitMinutes/);
    expect(r.source).toMatch(/SC_OFFERTIMEOUT/);
  });

  test('PR B: SUMS booking + offer timers within one scenario (was MAX in v1.11.94)', async () => {
    // PR #305 / #307 took the max within a scenario; PR B (this PR) changes
    // the semantic to SUM because the scenario auto-expands into N sub-runs
    // run sequentially. 17 + 8 = 25 min, +2 sub-runs × 60s buffer = 1,620,000 ms.
    const datafile = {
      scenariosToRun: ['SC_BOTH'],
      scenarios: [makeScenario('SC_BOTH', {
        expiredBookingTest: 'on',
        expiredBookingMaxWaitMinutes: 8,
        expiredOfferTest: 'on',
        expiredOfferMaxWaitMinutes: 17,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_BOTH');

    expect(r.requestedMs).toBe((17 + 8) * 60 * 1000 + 2 * 60000);
    // Source line names the count + the labels when more than one timer
    expect(r.source).toMatch(/2 timers summed/);
  });

  test('expiredOfferTest off (with a wait set) is a no-op', async () => {
    const datafile = {
      scenariosToRun: ['SC_OFFER_NOOP'],
      scenarios: [makeScenario('SC_OFFER_NOOP', {
        expiredOfferTest: 'off',
        expiredOfferMaxWaitMinutes: 25,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_OFFER_NOOP');

    expect(r.requestedMs).toBe(0);
    expect(r.effectiveMs).toBe(r.baseMs);
  });

  // ── PR A (Phases 3+4+5): each of the 4 new timers must auto-extend ────
  // Same parametric shape as the booking + offer cases above. EXPIRED_FLOW_TIMERS
  // is the single source of truth in the runner; one passing case per timer
  // proves the new entries are picked up by the scan loop.
  test.each([
    ['expiredAddReservationOfferTest', 'expiredAddReservationOfferMaxWaitMinutes', /expiredAddReservationOfferMaxWaitMinutes/],
    ['expiredAddAncillaryOfferTest',   'expiredAddAncillaryOfferMaxWaitMinutes',   /expiredAddAncillaryOfferMaxWaitMinutes/],
    ['expiredRefundOfferTest',         'expiredRefundOfferMaxWaitMinutes',         /expiredRefundOfferMaxWaitMinutes/],
    ['expiredExchangeOfferTest',       'expiredExchangeOfferMaxWaitMinutes',       /expiredExchangeOfferMaxWaitMinutes/],
  ])('extends the run budget when %s is on with a per-scenario Max wait', async (flag, wait, srcRe) => {
    const datafile = {
      scenariosToRun: ['SC_X'],
      scenarios: [makeScenario('SC_X', { [flag]: 'on', [wait]: 14 })],
    };
    const p = await writeEncryptedDatafile(datafile);
    const r = await computeEffectiveRunTimeoutMs(p, 'SC_X');

    expect(r.requestedMs).toBe(14 * 60 * 1000 + 60000);
    expect(r.effectiveMs).toBe(r.requestedMs);
    expect(r.helperError).toBeNull();
    expect(r.source).toMatch(srcRe);
  });

  // ── PR B: auto-expansion budget = SUM within scenario, MAX across ──────
  // The per-scenario budget is the sum of armed-timer max-waits because the
  // scenario runs N sub-runs sequentially. Across scenarios the max wins
  // (worker only runs one scenario at a time).
  test('PR B: sums armed-timer max-waits WITHIN a scenario (auto-expansion budget)', async () => {
    const datafile = {
      scenariosToRun: ['SC_TRIPLE'],
      scenarios: [makeScenario('SC_TRIPLE', {
        expiredRefundOfferTest:       'on', expiredRefundOfferMaxWaitMinutes:        5,
        expiredExchangeOfferTest:     'on', expiredExchangeOfferMaxWaitMinutes:     11,
        expiredAddAncillaryOfferTest: 'on', expiredAddAncillaryOfferMaxWaitMinutes:  7,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);
    const r = await computeEffectiveRunTimeoutMs(p, 'SC_TRIPLE');

    // 5 + 11 + 7 = 23 min, each plus 60 s buffer (3 * 60000 ms = 180000)
    const expectedMs = (5 + 11 + 7) * 60 * 1000 + 3 * 60000;
    expect(r.requestedMs).toBe(expectedMs);
    // Multi-timer source line includes the count + the timer labels
    expect(r.source).toMatch(/3 timers summed/);
  });

  test('PR B: takes the LARGEST sum ACROSS scenarios (one sub-run at a time)', async () => {
    const datafile = {
      scenariosToRun: 'ALL',
      scenarios: [
        // Scenario A: single timer at 20 min → sum = 20 min + 60s
        makeScenario('A', { expiredOfferTest: 'on', expiredOfferMaxWaitMinutes: 20 }),
        // Scenario B: two timers at 8 + 7 min → sum = 15 min + 2*60s
        makeScenario('B', {
          expiredOfferTest:   'on', expiredOfferMaxWaitMinutes:   8,
          expiredBookingTest: 'on', expiredBookingMaxWaitMinutes: 7,
        }),
      ],
    };
    const p = await writeEncryptedDatafile(datafile);
    const r = await computeEffectiveRunTimeoutMs(p, null);

    // A's budget is 20*60_000+60_000 = 1_260_000 ms
    // B's budget is (8+7)*60_000 + 2*60_000 = 1_020_000 ms
    // Max = A's = 1_260_000
    expect(r.requestedMs).toBe(20 * 60 * 1000 + 60000);
    expect(r.source).toMatch(/A/);   // triggered by 'A'
  });

  test('PR B: clamps at RUN_HARD_MAX_TIMEOUT_MS when summed timers exceed cap', async () => {
    // 3 timers at 20 min each = 60 min + 3*60s buffer ≫ 30 min default cap
    const datafile = {
      scenariosToRun: ['SC_OVER'],
      scenarios: [makeScenario('SC_OVER', {
        expiredOfferTest:               'on', expiredOfferMaxWaitMinutes:               20,
        expiredBookingTest:             'on', expiredBookingMaxWaitMinutes:             20,
        expiredAddReservationOfferTest: 'on', expiredAddReservationOfferMaxWaitMinutes: 20,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);
    const r = await computeEffectiveRunTimeoutMs(p, 'SC_OVER');

    const expectedSum = 60 * 60 * 1000 + 3 * 60000;
    expect(r.requestedMs).toBe(expectedSum);
    expect(r.effectiveMs).toBe(r.hardMaxMs);
    expect(r.clamped).toBe(true);
    expect(r.source).toMatch(/clamped/);
  });
});
