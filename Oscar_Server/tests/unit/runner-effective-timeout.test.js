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

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { computeEffectiveRunTimeoutMs } = require('../../src/worker/runner');
const { encryptToFileAsync }           = require('../../src/utils/at-rest');

function tmpFile(name) {
  return path.join(os.tmpdir(), `oscar-runner-effective-timeout-${process.pid}-${Date.now()}-${name}.json`);
}

async function writeEncryptedDatafile(content) {
  const p = tmpFile('datafile');
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
  const cleanup = [];
  afterAll(() => {
    for (const p of cleanup) { try { fs.unlinkSync(p); } catch (_) { /* ignore */ } }
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
    cleanup.push(p);

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
    cleanup.push(p);

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
    cleanup.push(p);

    const r = await computeEffectiveRunTimeoutMs(p, 'SC_LONG');

    expect(r.requestedMs).toBe(45 * 60 * 1000 + 60000);
    expect(r.effectiveMs).toBe(r.hardMaxMs);
    expect(r.clamped).toBe(true);
    expect(r.source).toMatch(/clamped/);
  });

  test('captures helperError when the datafile is missing/unreadable (no silent fallback)', async () => {
    const missing = tmpFile('does-not-exist');
    // Don't push to cleanup — the file does not exist
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
    cleanup.push(p);

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
      cleanup.push(p);
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
    cleanup.push(p);

    const r = await computeEffectiveRunTimeoutMs(p, null);

    expect(r.requestedMs).toBe(10 * 60 * 1000 + 60000);
    expect(r.scenariosInScope).toBe(2);
  });
});
