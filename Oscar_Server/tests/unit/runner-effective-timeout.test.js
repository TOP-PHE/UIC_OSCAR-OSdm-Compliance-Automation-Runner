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

  test('takes the LARGEST request across booking and offer timers in one scenario', async () => {
    // A scenario can in theory enable both; the worker SIGTERM must cover the
    // longer of the two (the second timer is what actually runs).
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

    expect(r.requestedMs).toBe(17 * 60 * 1000 + 60000);
    // Source attribution names whichever timer drove the extension.
    expect(r.source).toMatch(/expiredOfferMaxWaitMinutes/);
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

  test('takes the LARGEST request across multiple new-PR timers on one scenario', async () => {
    // A tester *could* enable several timers in one scenario today; the wait
    // budget must cover the longest. (PR B's auto-expansion changes this to
    // a sum, but that's a separate behaviour.)
    const datafile = {
      scenariosToRun: ['SC_MIXED'],
      scenarios: [makeScenario('SC_MIXED', {
        expiredRefundOfferTest:           'on', expiredRefundOfferMaxWaitMinutes:           5,
        expiredExchangeOfferTest:         'on', expiredExchangeOfferMaxWaitMinutes:         22,
        expiredAddAncillaryOfferTest:     'on', expiredAddAncillaryOfferMaxWaitMinutes:     11,
      })],
    };
    const p = await writeEncryptedDatafile(datafile);
    const r = await computeEffectiveRunTimeoutMs(p, 'SC_MIXED');

    expect(r.requestedMs).toBe(22 * 60 * 1000 + 60000);
    expect(r.source).toMatch(/expiredExchangeOfferMaxWaitMinutes/);
  });
});
