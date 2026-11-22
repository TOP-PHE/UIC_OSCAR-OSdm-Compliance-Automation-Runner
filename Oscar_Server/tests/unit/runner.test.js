// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runner.test.js — unit tests for src/worker/runner.js (executeRun, killRun).
 *
 * runner.js spawns the real Bruno CLI and writes real report artifacts, so
 * this file NEVER lets a real child process run: `child_process.spawn` is
 * fully mocked (jest.mock at the top). Every test drives a fake, in-memory
 * child process (an EventEmitter with `.stdout`/`.stderr`/`.kill`) instead.
 *
 * Filesystem notes:
 *  - COLLECTION_PATH is already a shared dummy dir set up by tests/setup.js
 *    (`os.tmpdir()/oscar-test-collection`) — reused as-is, no new temp-dir
 *    pattern introduced here.
 *  - ARTIFACTS_DIR is NOT env-overridable (hardcoded to
 *    `<repo>/data/artifacts` relative to runner.js's own __dirname), so
 *    executeRun() really does mkdir a `data/artifacts/<runId>/` folder on
 *    disk for every test. Every test's runId-scoped artifact dir is removed
 *    in afterEach — never touch anything else under data/artifacts/.
 *  - The mergeReport.js "file exists?" check is satisfied with an EMPTY
 *    placeholder file: spawn is mocked, so its real content is never
 *    executed — only its existence matters to fsExists().
 */

const { credentialsAsMigrated } = require('../helpers/credentials');
const path = require('path');
const fs   = require('fs');
const { EventEmitter } = require('events');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('child_process');
const { spawn } = require('child_process');

// Isolated mode (option 2b): the runner agent's client, replaced by a fake.
jest.mock('../../src/worker/remoteProcess', () => ({ RemoteProcess: jest.fn() }));
const { RemoteProcess } = require('../../src/worker/remoteProcess');

jest.mock('../../src/worker/access-token');
const { resolveAccessToken, dropCachedToken } = require('../../src/worker/access-token');

// The real module. viewForTester is wrapped so that one test can make it throw.
jest.mock('../../src/utils/datafileOwnership', () => {
  const real = jest.requireActual('../../src/utils/datafileOwnership');
  return { ...real, viewForTester: jest.fn(real.viewForTester) };
});
const { viewForTester } = require('../../src/utils/datafileOwnership');

const { run, get, colDecrypt, colEncrypt } = require('../../src/db/db');
const { executeRun, killRun, runIdleLimitMs } = require('../../src/worker/runner');
const runSecrets = require('../../src/utils/runSecrets');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const COLLECTION_PATH = process.env.COLLECTION_PATH; // set by tests/setup.js
const ENVS_DIR = path.join(COLLECTION_PATH, 'environments');
const VAL_DIR  = path.join(COLLECTION_PATH, 'Validation_Reports');
const MERGE_REPORT_JS = path.join(COLLECTION_PATH, 'library-bruno', 'mergeReport.js');

// ── Fake child_process helper ────────────────────────────────────────────────
// A minimal stand-in for Node's ChildProcess: real EventEmitters for
// stdout/stderr and the process itself (so `.on('close', cb)` works exactly
// like the real thing), plus a jest.fn() kill() so tests can assert it was
// (or wasn't) signalled.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = jest.fn();
  return proc;
}

let createdRunIds = [];
function trackRunId(id) { createdRunIds.push(id); return id; }

// executeRun does several real `await fs.promises.*` operations (mkdir, an
// env-yml write, computeEffectiveRunTimeoutMs's own datafile read, ...)
// BEFORE it ever calls spawn() — a fixed number of setImmediate/tick waits
// is not reliable timing for that. Poll for the Nth spawn() call to actually
// have happened before emitting events on the fake proc it returned;
// otherwise the emit fires before executeRun has attached its 'close'/'error'
// listeners and the event is silently lost — hanging the test forever.
async function waitForSpawnCalls(times, timeoutMs = 4000) {
  const start = Date.now();
  while (spawn.mock.calls.length < times) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for spawn() to be called ${times} time(s); got ${spawn.mock.calls.length}.`);
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// Same reasoning as waitForSpawnCalls: a fixed sleep-then-assert around a
// real (short) setTimeout is exactly the kind of margin that goes flaky
// under CI/full-suite CPU contention (a "short" 80ms configured timeout can
// easily slip past a 150ms fixed wait when the process is busy). Poll for
// the actual kill() call instead of guessing how long it takes to fire.
async function waitForKillCall(fakeProc, timeoutMs = 4000) {
  const start = Date.now();
  while (fakeProc.kill.mock.calls.length === 0) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for proc.kill() to be called.');
    }
    await new Promise(r => setTimeout(r, 5));
  }
}

// Every seeded company gets a datafile the runner can read: since NEW-10 it reads
// the file before any run, and one it cannot read refuses the run. (The file
// used to be this test file itself, "any file that exists".)
const SEED_DATAFILE_DIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runner-seed-datafile-'));
const SEED_DATAFILE = path.join(SEED_DATAFILE_DIR, 'datafile.json');
fs.writeFileSync(SEED_DATAFILE, JSON.stringify({ scenariosToRun: 'ALL', scenarios: [{ code: 'SEED_SCENARIO' }] }));
afterAll(() => { try { fs.rmSync(SEED_DATAFILE_DIR, { recursive: true, force: true }); } catch (_) {} });

function seedCompanyUser({ authMode = 'bearer', extraHeaders = null, role = 'test_manager' } = {}) {
  const companyId = uuidv4();
  const userId = uuidv4();
  run(
    `INSERT INTO companies (id, name, slug, api_base, datafile_path, extra_headers) VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, 'Runner Test Co', `runner-test-${companyId.slice(0, 8)}`, 'https://vendor.example/osdm', SEED_DATAFILE, extraHeaders]
  );
  run(
    `INSERT INTO users (id, company_id, email, password_hash, role, auth_mode) VALUES (?, ?, ?, 'x', ?, ?)`,
    [userId, companyId, `runner-${userId.slice(0, 8)}@runner-test.com`, role, authMode]
  );
  credentialsAsMigrated(userId);
  return { companyId, userId };
}

function seedRun(companyId, userId) {
  const runId = trackRunId(uuidv4());
  run(
    `INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, 'QUEUED')`,
    [runId, companyId, userId]
  );
  return runId;
}

function getRunRow(runId) {
  return get('SELECT * FROM runs WHERE id = ?', [runId]);
}

function getDecryptedEvents(runId) {
  const rows = require('../../src/db/db').all('SELECT level, message FROM run_events WHERE run_id = ? ORDER BY id ASC', [runId]);
  return rows.map(r => ({ level: r.level, message: colDecrypt(r.message) }));
}

// #1312: how many times each step of a run was observed, the steps observed
// once more between two readings, and the line a run's log gets.
const runTimeline = require('../../src/worker/runTimeline');
const stepMetrics = require('../../src/utils/metrics');
async function stepCounts() {
  const values = (await stepMetrics.runStepSeconds.get()).values;
  return Object.fromEntries(values.filter((v) => v.metricName === 'oscar_run_step_seconds_count').map((v) => [v.labels.step, v.value]));
}
const stepsMoved = (before, after) => stepMetrics.RUN_STEPS.filter((step) => (after[step] || 0) === (before[step] || 0) + 1);
const timeLines = (runId) => getDecryptedEvents(runId).map((e) => e.message).filter((m) => m.includes('Where this run\'s time went'));
// Bruno's own times of the requests, as the run's results store them.
function storeRequestTimes(runId, ms) {
  run(`INSERT INTO run_suites (run_id, company_id, suite_name, duration_ms) VALUES (?, ?, 'suite', ?)`, [runId, getRunRow(runId).company_id, ms]);
}

// The fake Bruno writes no results: unless a test says otherwise, the run
// stored one check, as a real run does (a run with none ends FAILED).
const structureResults = require('../../src/reports/structureResults');
const extractSpy = jest.spyOn(structureResults, 'extractStructuredResults');
beforeEach(() => { extractSpy.mockReturnValue({ suites: 1, requests: 1, assertions: 1 }); });

beforeAll(() => {
  fs.mkdirSync(ENVS_DIR, { recursive: true });
  fs.mkdirSync(VAL_DIR, { recursive: true });
  // Disable the token watchdog interval for every test by default — a stray
  // live setInterval would otherwise keep Jest's process alive.
  run(`INSERT OR IGNORE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '0')`);
});

afterEach(() => {
  jest.clearAllMocks();
  // Remove ONLY this test's runId-scoped artifact directories — never touch
  // anything else under the real data/artifacts/ folder.
  for (const runId of createdRunIds) {
    try { fs.rmSync(path.join(ARTIFACTS_DIR, runId), { recursive: true, force: true }); } catch (_) {}
  }
  createdRunIds = [];
  // Remove any mergeReport.js placeholder + Validation_Reports leftovers so
  // the "no mergeReport" default behaviour is restored for the next test.
  try { fs.rmSync(MERGE_REPORT_JS, { force: true }); } catch (_) {}
  for (const f of fs.readdirSync(VAL_DIR)) {
    try { fs.rmSync(path.join(VAL_DIR, f), { force: true }); } catch (_) {}
  }
});

// ── #540: run, endpoint and credentials of one company ────────────────────────
describe('executeRun — provider scope (#540)', () => {
  // A distributor (from seedCompanyUser, with a tester) and a provider of it.
  function seedProviderRun({ granted }) {
    const { companyId: distributorId, userId } = seedCompanyUser({ role: 'company_user' });
    const providerId = uuidv4();
    run(`INSERT INTO companies (id, name, slug, api_base, datafile_path, parent_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [providerId, 'Provider Co', `runner-prov-${providerId.slice(0, 8)}`, 'https://provider.example/osdm', SEED_DATAFILE, distributorId]);
    if (granted) run('INSERT INTO provider_access (company_id, user_id) VALUES (?, ?)', [providerId, userId]);
    return { distributorId, providerId, userId, runId: seedRun(providerId, userId) };
  }

  test('a job naming another company than the run\'s is refused before any token', async () => {
    const { distributorId, userId, runId } = seedProviderRun({ granted: true });
    const result = await executeRun({ runId, companyId: distributorId, userId });
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/does not belong to the company/);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test('a tester whose access was withdrawn while queued is refused before any token', async () => {
    const { providerId, userId, runId } = seedProviderRun({ granted: false });
    const result = await executeRun({ runId, companyId: providerId, userId });
    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/may no longer use this company/);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(resolveAccessToken).not.toHaveBeenCalled();
  });

  test('a granted tester\'s run uses their credentials for the provider, not the distributor', async () => {
    const { providerId, userId, runId } = seedProviderRun({ granted: true });
    run(`INSERT INTO tester_credentials (user_id, company_id, auth_mode, access_token_enc) VALUES (?, ?, 'bearer', 'enc-provider')`,
      [userId, providerId]);
    resolveAccessToken.mockRejectedValueOnce(new Error('stop here'));
    await executeRun({ runId, companyId: providerId, userId });
    expect(resolveAccessToken).toHaveBeenCalledTimes(1);
    const creds = resolveAccessToken.mock.calls[0][0];
    expect(creds.company_id).toBe(providerId);
    expect(creds.user_id).toBe(userId);
    expect(creds.access_token_enc).toBe('enc-provider');
  });
});

// ── Early-exit branches (no spawn reached) ────────────────────────────────────
describe('executeRun — early-exit branches', () => {
  test('throws when the run or company row is missing', async () => {
    await expect(executeRun({ runId: uuidv4(), companyId: uuidv4(), userId: uuidv4() }))
      .rejects.toThrow(/not found/i);
  });

  test('FAILED status when resolveAccessToken rejects', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockRejectedValueOnce(new Error('bad credentials'));

    const result = await executeRun({ runId, companyId, userId });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/bad credentials/);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('FAILED status when the company has no datafile on disk', async () => {
    const companyId = uuidv4();
    const userId = uuidv4();
    run(`INSERT INTO companies (id, name, slug, api_base, datafile_path) VALUES (?, ?, ?, ?, ?)`,
      [companyId, 'No Datafile Co', `no-datafile-${companyId.slice(0, 8)}`, 'https://vendor.example', '/does/not/exist.json']);
    run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode) VALUES (?, ?, ?, 'x', 'test_manager', 'bearer')`,
      [userId, companyId, `nodf-${userId.slice(0, 8)}@runner-test.com`]);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-123');

    const result = await executeRun({ runId, companyId, userId });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/No data file/i);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ── Happy-path + exit-code / artifact-linking branches ────────────────────────
describe('executeRun — spawn happy paths', () => {
  test('COMPLETED on exit code 0, no HTML report present (warns, does not fail)', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    // Let executeRun reach the point of registering listeners before closing.
    await waitForSpawnCalls(1);
    fakeProc.stdout.emit('data', Buffer.from('✓ some assertion passed\n'));
    fakeProc.emit('close', 0);

    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(getRunRow(runId).status).toBe('COMPLETED');
    expect(spawn).toHaveBeenCalledTimes(1); // no mergeReport.js on disk → single spawn
    const events = getDecryptedEvents(runId);
    expect(events.some(e => /No reportGenerator HTML found/i.test(e.message))).toBe(true);
  });

  // A run whose results never arrived, or that made no check, checked nothing.
  async function runEndingWith(exitCode) {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', exitCode);
    await p;
    return runId;
  }

  test('exit code 0 with no check stored is FAILED (NO_CHECKS), the reason in the log', async () => {
    extractSpy.mockReturnValue({ suites: 0, requests: 0, assertions: 0 });
    const runId = await runEndingWith(0);
    const row = getRunRow(runId);
    expect(row.status).toBe('FAILED');
    expect(row.exit_code).toBe(0);
    expect(row.error_message).toBe('NO_CHECKS');
    const events = getDecryptedEvents(runId);
    expect(events.some(e => e.level === 'error' && /No check was recorded for this run/.test(e.message))).toBe(true);
    expect(events.some(e => /Run finished — status=FAILED exit=0/.test(e.message))).toBe(true);
  });

  test('checks that could not be read leave the run as Bruno ended it', async () => {
    extractSpy.mockImplementation(() => { throw new Error('unreadable results'); });
    const runId = await runEndingWith(0);
    expect(getRunRow(runId).status).toBe('COMPLETED');
    expect(getRunRow(runId).error_message).toBeNull();
  });

  test('the run page has a banner of its own for NO_CHECKS (not the OAuth2 one)', () => {
    const page = fs.readFileSync(path.join(__dirname, '../../public/run-detail.html'), 'utf8');
    expect(page).toContain("const isNoChecks      = run.error_message === 'NO_CHECKS';");
    expect(page).toMatch(/isOAuthError\s+= [^;]*!isNoChecks/);
    expect(page).toContain('No check was recorded — the run is marked failed');
  });

  test('a failed Bruno with no check stored stays FAILED without NO_CHECKS', async () => {
    extractSpy.mockReturnValue({ suites: 0, requests: 0, assertions: 0 });
    const runId = await runEndingWith(1);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(getRunRow(runId).error_message).toBeNull();
  });

  // #1272: a run whose process was refused or lost (the dispatcher could not
  // make its pod) is not a test result, and says so.
  test('a process error is FAILED with RUN_PROCESS_ERROR, the reason in the log', async () => {
    extractSpy.mockReturnValue({ suites: 0, requests: 0, assertions: 0 });
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.emit('error', new Error('the runner agent refused: the run could not be dispatched: the Kubernetes API did not answer for 120 s'));
    await p;
    const row = getRunRow(runId);
    expect(row.status).toBe('FAILED');
    expect(row.error_message).toBe('RUN_PROCESS_ERROR');
    const events = getDecryptedEvents(runId);
    expect(events.some(e => e.level === 'error' && /Process error: .*did not answer for 120 s/.test(e.message))).toBe(true);
    expect(events.some(e => e.level === 'error' && /The run did not go to its end/.test(e.message))).toBe(true);
  });

  test('a run that ended without a process error has no RUN_PROCESS_ERROR', async () => {
    extractSpy.mockReturnValue({ suites: 0, requests: 0, assertions: 0 });
    const runId = await runEndingWith(2);
    // Bruno's 2 is not a test result (#1287), but the process was not lost.
    expect(getRunRow(runId).error_message).toBe('RUN_NOT_FINISHED');
  });

  // #1287: Bruno ends a run with 0 or 1; any other code is not a test result.
  // Seen on k3s: a cluster restart made runs end with 255 partway, every check
  // passed, and they read as FAILED like a provider's defect.
  test('exit 255 with checks stored is FAILED with RUN_NOT_FINISHED, the code and its meaning in the log', async () => {
    extractSpy.mockReturnValue({ suites: 2, requests: 19, assertions: 303 });
    const runId = await runEndingWith(255);
    const row = getRunRow(runId);
    expect(row.status).toBe('FAILED');
    expect(row.exit_code).toBe(255);
    expect(row.error_message).toBe('RUN_NOT_FINISHED');
    const events = getDecryptedEvents(runId);
    expect(events.some(e => e.level === 'error'
      && /The run did not go to its end \(exit 255\): Bruno stopped on an unexpected error/.test(e.message)
      && /This is not a result of the test/.test(e.message))).toBe(true);
  });

  test.each([[1, 'FAILED'], [0, 'COMPLETED']])('exit %i with checks stored is a test result: %s, no error message', async (code, status) => {
    extractSpy.mockReturnValue({ suites: 1, requests: 5, assertions: 40 });
    const runId = await runEndingWith(code);
    expect(getRunRow(runId).status).toBe(status);
    expect(getRunRow(runId).error_message).toBeNull();
  });

  test.each([3, 6, 124, 125, 137, 143, 7])('exit %i is not a test result either', async (code) => {
    extractSpy.mockReturnValue({ suites: 1, requests: 5, assertions: 40 });
    const runId = await runEndingWith(code);
    expect(getRunRow(runId).error_message).toBe('RUN_NOT_FINISHED');
  });

  test('a 401 in the log still names the token, whatever the exit code', async () => {
    extractSpy.mockReturnValue({ suites: 1, requests: 5, assertions: 40 });
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.stdout.emit('data', Buffer.from('Wrong response status: 401\n'));
    fakeProc.emit('close', 255);
    await p;
    expect(getRunRow(runId).error_message).toBe('TOKEN_AUTH_ERROR');
  });

  test('the run page has a banner of its own for RUN_NOT_FINISHED, with the code and its meaning', () => {
    const page = fs.readFileSync(path.join(__dirname, '../../public/run-detail.html'), 'utf8');
    expect(page).toContain('const isNotFinished   = run.error_message === OscarRunExit.NOT_FINISHED;');
    expect(page).toMatch(/isOAuthError\s+= [^;]*!isNotFinished/);
    expect(page).toMatch(/showBanner\s+= [^;]*isNotFinished/);
    expect(page).toContain('banner.innerHTML = notFinishedBannerHtml(run.exit_code);');
    // The shared module is loaded before the page's own script uses it.
    expect(page.indexOf('<script src="/js/run-exit.js"></script>')).toBeGreaterThan(-1);
    expect(page.indexOf('<script src="/js/run-exit.js"></script>')).toBeLessThan(page.indexOf('OscarRunExit.NOT_FINISHED'));
  });

  // #1291: auth_mode_used is written when a run is queued, so a run a restart
  // cancelled before it started read as an OAuth2 failure.
  test('the run page has a banner of its own for a run a server restart failed (not the OAuth2 one)', () => {
    const page = fs.readFileSync(path.join(__dirname, '../../public/run-detail.html'), 'utf8');
    expect(page).toContain('const isRestarted     = OscarRunExit.isRestarted(run.error_message);');
    expect(page).toMatch(/isOAuthError\s+= [^;]*!isRestarted/);
    expect(page).toMatch(/showBanner\s+= [^;]*isRestarted/);
    expect(page).toContain('banner.innerHTML = restartedBannerHtml(run.error_message);');
  });

  test('the run page has a banner of its own for RUN_PROCESS_ERROR (not the OAuth2 one)', () => {
    const page = fs.readFileSync(path.join(__dirname, '../../public/run-detail.html'), 'utf8');
    expect(page).toContain("const isProcessError  = run.error_message === 'RUN_PROCESS_ERROR';");
    expect(page).toMatch(/isOAuthError\s+= [^;]*!isProcessError/);
    expect(page).toMatch(/showBanner\s+= [^;]*isProcessError/);
    expect(page).toContain('The run did not go to its end — this is not a test result');
  });

  test('FAILED on a non-zero exit code', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', 1);

    const result = await runPromise;

    expect(result.exitCode).toBe(1);
    expect(getRunRow(runId).status).toBe('FAILED');
  });

  // S8-loopback: the child is handed a per-run secret bound to the run's
  // company, and the secret is revoked once the child exits.
  test('hands the Bruno child a per-run secret and revokes it on close', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    const childEnv = spawn.mock.calls[0][2].env;
    const secret = childEnv.OSCAR_RUN_SECRET;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(childEnv).not.toHaveProperty('ENCRYPTION_KEY');          // still never inherited
    // Valid while the child runs, and scoped to this run's company.
    expect(runSecrets.verify(runId, secret)).toBe(companyId);

    fakeProc.emit('close', 0);
    await runPromise;

    // Gone once the child is gone.
    expect(runSecrets.verify(runId, secret)).toBeNull();
  });

  test("resolves exitCode 1 and logs an error when the process itself errors (e.g. ENOENT)", async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.emit('error', new Error('spawn bru-test-stub ENOENT'));

    const result = await runPromise;

    expect(result.exitCode).toBe(1);
    expect(getRunRow(runId).status).toBe('FAILED');
    const events = getDecryptedEvents(runId);
    expect(events.some(e => /Process error/i.test(e.message))).toBe(true);
  });

  test('links a reportGenerator HTML artifact when one is present', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    // Drop a report file matching the {dateStr}_{envShort}_{SCENARIO}_Report.html
    // shape the linking step scans for, timestamped after runStartTime.
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const slug = get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug;
    const envShort = `${slug}_${runId.slice(0, 8)}`;
    const reportName = `${dateStr}_${envShort}_MY_SCENARIO_Report.html`;
    fs.writeFileSync(path.join(VAL_DIR, reportName), '<html>report</html>');

    fakeProc.emit('close', 0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    const artifacts = require('../../src/db/db').all('SELECT * FROM run_artifacts WHERE run_id = ?', [runId]);
    expect(artifacts.some(a => a.type === 'html_report' && a.filename === 'report_MY_SCENARIO.html')).toBe(true);
    // The linked file was written (encrypted) into the real per-run artifact dir.
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, runId, 'report_MY_SCENARIO.html'))).toBe(true);
  });

  test('runs mergeReport.js as a second spawn when it exists, and copies the raw JSON artifact', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    // fsExists() only needs the file to exist — spawn is mocked, so its
    // content is never actually executed.
    fs.mkdirSync(path.dirname(MERGE_REPORT_JS), { recursive: true });
    fs.writeFileSync(MERGE_REPORT_JS, '// stub, never executed (spawn is mocked)');

    const mainProc = makeFakeProc();
    const mergeProc = makeFakeProc();
    spawn.mockReturnValueOnce(mainProc).mockReturnValueOnce(mergeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    // The raw bru results JSON the run is expected to have produced —
    // required for both the mergeReport.js gate and the JSON-artifact copy.
    const runIdShort = runId.slice(0, 8);
    const bruJsonPath = path.join(VAL_DIR, `.bru_results_${runIdShort}.json`);
    fs.writeFileSync(bruJsonPath, JSON.stringify({ results: [] }));

    mainProc.emit('close', 0);
    await waitForSpawnCalls(2);
    mergeProc.emit('close', 0);

    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(2);
    // Second spawn call is `node mergeReport.js <envName>`.
    expect(spawn.mock.calls[1][0]).toBe(process.execPath);
    expect(spawn.mock.calls[1][1][0]).toBe(MERGE_REPORT_JS);

    const artifacts = require('../../src/db/db').all('SELECT * FROM run_artifacts WHERE run_id = ?', [runId]);
    expect(artifacts.some(a => a.type === 'json_results' && a.filename === '.bru_results.json')).toBe(true);
  });

  test('links the mergeReport.js HTML as a fallback when reportGenerator produced none', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    fs.mkdirSync(path.dirname(MERGE_REPORT_JS), { recursive: true });
    fs.writeFileSync(MERGE_REPORT_JS, '// stub, never executed (spawn is mocked)');

    const mainProc = makeFakeProc();
    const mergeProc = makeFakeProc();
    spawn.mockReturnValueOnce(mainProc).mockReturnValueOnce(mergeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    const runIdShort = runId.slice(0, 8);
    fs.writeFileSync(path.join(VAL_DIR, `.bru_results_${runIdShort}.json`), JSON.stringify({ results: [] }));

    mainProc.emit('close', 0); // no reportGenerator HTML written → htmlArtifactLinked stays false
    await waitForSpawnCalls(2);

    // mergeReport.js's own exact-name output — the fallback source.
    const slug = get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug;
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const envShort = `${slug}_${runIdShort}`;
    fs.writeFileSync(path.join(VAL_DIR, `${dateStr}_${envShort}_Report.html`), '<html>merged</html>');

    mergeProc.emit('close', 0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    const artifacts = require('../../src/db/db').all('SELECT * FROM run_artifacts WHERE run_id = ?', [runId]);
    expect(artifacts.some(a => a.type === 'html_report' && a.filename === 'report.html')).toBe(true);
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, runId, 'report.html'))).toBe(true);
  });

  test("logs an error (but does not crash) when the mergeReport.js process itself errors", async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    fs.mkdirSync(path.dirname(MERGE_REPORT_JS), { recursive: true });
    fs.writeFileSync(MERGE_REPORT_JS, '// stub, never executed (spawn is mocked)');

    const mainProc = makeFakeProc();
    const mergeProc = makeFakeProc();
    spawn.mockReturnValueOnce(mainProc).mockReturnValueOnce(mergeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fs.writeFileSync(path.join(VAL_DIR, `.bru_results_${runId.slice(0, 8)}.json`), JSON.stringify({ results: [] }));
    mainProc.emit('close', 0);
    await waitForSpawnCalls(2);
    mergeProc.emit('error', new Error('spawn node ENOENT'));

    const result = await runPromise;

    // The main run's own exit code (0) still wins — mergeReport is best-effort.
    expect(result.exitCode).toBe(0);
    const events = getDecryptedEvents(runId);
    expect(events.some(e => /spawn node ENOENT/.test(e.message))).toBe(true);
  });

  test('FAILED status when writing the ephemeral env file fails', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    // The env file is the first file the run opens (runFolder.js writeRunFile).
    const openSpy = jest.spyOn(fs.promises, 'open').mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const result = await executeRun({ runId, companyId, userId });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/Failed to write env file/);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(spawn).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });
});

// ── S5: a run is refused when the company api_base is not a public https target ─
describe('executeRun — S5 api_base policy', () => {
  const PRIOR = process.env.ALLOW_PRIVATE_TARGETS;
  beforeEach(() => { process.env.ALLOW_PRIVATE_TARGETS = ''; });   // suite runs with it on; off here
  afterEach(() => { process.env.ALLOW_PRIVATE_TARGETS = PRIOR; });

  // Structural blocks need no DNS (this file does not mock dns).
  test.each([
    'https://127.0.0.1/osdm',          // loopback
    'http://vendor.example/osdm',       // not https
    'https://grafana:3000/osdm',        // a Docker service name
    'https://169.254.169.254/latest',   // cloud metadata
  ])('refuses a run whose api_base is %s, before a token or a spawn', async (bad) => {
    const { companyId, userId } = seedCompanyUser();
    run('UPDATE companies SET api_base = ? WHERE id = ?', [bad, companyId]);
    const runId = seedRun(companyId, userId);

    const out = await executeRun({ runId, companyId, userId });

    expect(out.exitCode).toBe(1);
    expect(out.error).toContain('public host');
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(spawn).not.toHaveBeenCalled();
    expect(resolveAccessToken).not.toHaveBeenCalled();   // refused before the token step
  });

  test('a public api_base (literal IP, no DNS) still runs', async () => {
    const { companyId, userId } = seedCompanyUser();
    run('UPDATE companies SET api_base = ? WHERE id = ?', ['https://8.8.8.8/osdm', companyId]);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', 0);
    const out = await p;

    expect(out.exitCode).toBe(0);
    expect(getRunRow(runId).status).toBe('COMPLETED');
  });
});

// ── S6: encrypted dedicated headers are decrypted into the run env ────────────
describe('executeRun — S6 dedicated-header decryption', () => {
  test('an encrypted extra_headers row is decrypted and written to the run env', async () => {
    const enc = colEncrypt(JSON.stringify([{ name: 'X-Dedicated', value: 'dedicated-secret-xyz' }]));
    const { companyId, userId } = seedCompanyUser({ extraHeaders: enc });
    expect(enc.startsWith('enc:v1:')).toBe(true);     // genuinely stored encrypted
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    // The env file is written before the spawn and deleted after the run ends,
    // so read it now (between spawn and close).
    const envFile = fs.readdirSync(ENVS_DIR).find(f => f.includes(runId.slice(0, 8)));
    const envText = fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8');
    expect(envText).toContain('__extraHeaders');
    expect(envText).toContain('X-Dedicated');
    expect(envText).toContain('dedicated-secret-xyz');   // decrypted, not the enc:v1 blob
    expect(envText).not.toContain('enc:v1:');

    fakeProc.emit('close', 0);
    await p;
  });
});

// ── #1070: the Test Framework's W3C trace context reaches the run ─────────────
describe('executeRun — W3C trace context', () => {
  async function envOfRun(framework) {
    const { companyId, userId } = seedCompanyUser();
    if (framework) {
      run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)',
        [require('node:crypto').randomUUID(), companyId, colEncrypt(JSON.stringify(framework))]);
    }
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    const { readEnvYml, valueIn } = require('../helpers/env-yml');
    const envFile = fs.readdirSync(ENVS_DIR).find(f => f.includes(runId.slice(0, 8)));
    const value = valueIn(readEnvYml(fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8')), '__traceContext');
    fakeProc.emit('close', 0);
    await p;
    return JSON.parse(value);
  }

  test('the framework\'s settings, the tracestate parsed', async () => {
    expect(await envOfRun({ osdmVersion: '3.8', traceContext: { sampled: false, tracestate: 'processid={{uuid}}' } }))
      .toEqual({ send: true, flags: '00', tracestate: [['t', 'processid='], ['v', 'uuid']] });
  });

  test('no framework: the defaults', async () => {
    expect(await envOfRun(null)).toEqual({ send: true, flags: '01', tracestate: [] });
  });
});

// The run's copy takes values from the Test Framework: one holding "{{" refuses the run.
// Option 2b: in isolated mode the runner agent starts bru, in a working folder
// of its own, with the run's credentials only; nothing is spawned here.
describe('executeRun — RUN_ISOLATION=isolated', () => {
  const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_WORKSPACES_DIR'];
  const saved = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    process.env.RUN_ISOLATION = 'isolated';
    process.env.RUN_AGENT_TOKEN = 't'.repeat(40);
    process.env.RUN_WORKSPACES_DIR = path.resolve(__dirname, '../../data/workspaces');
  });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('bru goes through the agent, always in a working folder, with the run\'s credentials only', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);           // no scenario: a local run would use the collection folder
    resolveAccessToken.mockResolvedValueOnce('tok-isolated');
    spawn.mockClear();
    const calls = [];
    RemoteProcess.mockImplementation(function FakeRemote(agent, request) {
      const proc = makeFakeProc();
      calls.push({ agent, request, proc });
      return proc;
    });
    const p = executeRun({ runId, companyId, userId });
    const start = Date.now();
    while (calls.length === 0 && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    const { agent, request, proc } = calls[0];
    expect(agent).toMatchObject({ host: '127.0.0.1', port: 3002, token: 't'.repeat(40) });
    expect(request.kind).toBe('bru');
    expect(path.dirname(request.cwd)).toBe(path.resolve(__dirname, '../../data/workspaces'));
    expect(path.basename(request.cwd)).toBe(runId);
    expect(Object.keys(request.env).sort()).toEqual(['OSCAR_ACCESS_TOKEN', 'OSCAR_RUN_SECRET']);
    expect(request.env.OSCAR_ACCESS_TOKEN).toBe('tok-isolated');
    expect(spawn).not.toHaveBeenCalled();
    proc.emit('close', 0);
    await p;
    RemoteProcess.mockReset();
  });
});

// Option 4 (#1130): each run in a pod of its own, which the dispatcher makes.
// The run is one request; nothing is started or written here; the pod's
// results come back through the internal port (utils/runResults.js).
describe('executeRun — RUN_ISOLATION=pod (#1130)', () => {
  const runSecrets = require('../../src/utils/runSecrets');
  const runResults = require('../../src/utils/runResults');
  const { readEnvYml, valueIn } = require('../helpers/env-yml');
  const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_AGENT_HOST', 'RUN_SERVER_URL', 'INTERNAL_PORT', 'JSON_SCHEMA_URL'];
  const saved = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    Object.assign(process.env, {
      RUN_ISOLATION: 'pod', RUN_AGENT_TOKEN: 't'.repeat(40), RUN_AGENT_HOST: 'oscar-dispatcher',
      RUN_SERVER_URL: 'http://oscar-internal:3003', INTERNAL_PORT: '3003',
    });
    delete process.env.JSON_SCHEMA_URL;
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    RemoteProcess.mockReset();
  });

  async function startPodRun() {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-pod');
    spawn.mockClear();
    const calls = [];
    RemoteProcess.mockImplementation(function FakeRemote(agent, request) {
      const proc = makeFakeProc();
      calls.push({ agent, request, proc });
      return proc;
    });
    const done = executeRun({ runId, companyId, userId });
    const start = Date.now();
    while (calls.length === 0 && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    return { runId, done, ...calls[0] };
  }
  const shortEnv = (envName) => envName.replace(/^OTST_/, '').replace(/_Env$/, '');

  test('one run request to the dispatcher: the environment file, the deadline and the run\'s credentials; nothing here', async () => {
    const { runId, agent, request, proc, done } = await startPodRun();
    expect(agent).toMatchObject({ host: 'oscar-dispatcher', port: 3002, token: 't'.repeat(40) });
    expect(request).toMatchObject({ kind: 'run', runId, deadlineSeconds: 600 });
    const file = readEnvYml(Buffer.from(request.envYml, 'base64').toString('utf8'));
    expect(file.name).toBe(request.envName);
    expect(valueIn(file, 'data_base')).toMatch(/^http:\/\/oscar-internal:3003\/data\/runner-test-[0-9a-f]{8}-datafile\.json$/);
    expect(valueIn(file, 'json_schema')).toBe('http://oscar-internal:3003/json_validator/datafile.schema.json');
    expect(valueIn(file, 'oscar_loopback_base')).toBe('http://oscar-internal:3003');
    expect(valueIn(file, '__runId')).toBe(runId);
    expect(Object.keys(request.env).sort()).toEqual(['OSCAR_ACCESS_TOKEN', 'OSCAR_RUN_SECRET']);
    expect(request.env.OSCAR_ACCESS_TOKEN).toBe('tok-pod');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ENVS_DIR, `${request.envName}.yml`))).toBe(false);
    expect(fs.existsSync(path.join(path.resolve(__dirname, '../../data/workspaces'), runId))).toBe(false);
    proc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
  });

  test('a JSON_SCHEMA_URL on the loopback (the old deployment files) still gives the pod the internal port', async () => {
    process.env.JSON_SCHEMA_URL = 'http://127.0.0.1:3001/json_validator/datafile.schema.json';
    const { request, proc, done } = await startPodRun();
    const file = readEnvYml(Buffer.from(request.envYml, 'base64').toString('utf8'));
    expect(valueIn(file, 'json_schema')).toBe('http://oscar-internal:3003/json_validator/datafile.schema.json');
    proc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
  });

  test('the run\'s secret is bound to its pod\'s address', async () => {
    const { runId, request, proc, done } = await startPodRun();
    proc.emit('pod', '10.1.0.9');
    expect(runSecrets.verify(runId, request.env.OSCAR_RUN_SECRET)).not.toBeNull();
    expect(runSecrets.fromRunAddress(runId, '::ffff:10.1.0.9')).toBe(true);
    expect(runSecrets.fromRunAddress(runId, '10.1.0.10')).toBe(false);
    proc.emit('close', 0);
    await done;
  });

  test('a secret already used from another address is withdrawn, and the run stopped', async () => {
    const { runId, request, proc, done } = await startPodRun();
    expect(runSecrets.fromRunAddress(runId, '10.9.9.9')).toBe(true);     // the first caller with the secret
    proc.emit('pod', '10.1.0.9');                                         // the dispatcher names another
    expect(runSecrets.verify(runId, request.env.OSCAR_RUN_SECRET)).toBeNull();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    proc.emit('close', 143);
    await done;
    expect(getDecryptedEvents(runId).some((e) => e.level === 'error' && /not its pod's/.test(e.message))).toBe(true);
  });

  // #1336: a kept pod took a run and stalled before Bruno; with the silence
  // limit off (production's setting), the run held its slot for an hour.
  describe('the pod\'s first line within a bounded time (#1336)', () => {
    const setConfig = (key, value) => run(`INSERT INTO server_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
    const clearConfig = (...keys) => keys.forEach((k) => run('DELETE FROM server_config WHERE key = ?', [k]));
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const NO_LINE = /The run's pod wrote no line \d+ s after it took the run: the run is stopped and its pod given up\./;
    afterEach(() => clearConfig('RUN_FIRST_LINE_TIMEOUT_MS', 'RUN_IDLE_TIMEOUT_MS'));

    test('no line after the pod took the run: stopped, and the log says why, even with the silence limit off', async () => {
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '80');
      setConfig('RUN_IDLE_TIMEOUT_MS', '0');
      const { runId, proc, done } = await startPodRun();
      proc.emit('pod', '10.1.0.9');
      await waitForKillCall(proc);
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      proc.emit('close', 143);
      await done;
      expect(getDecryptedEvents(runId).some((e) => e.level === 'error' && NO_LINE.test(e.message))).toBe(true);
    });

    test('the pod\'s first line disarms it', async () => {
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '80');
      setConfig('RUN_IDLE_TIMEOUT_MS', '0');
      const { runId, proc, done } = await startPodRun();
      proc.emit('pod', '10.1.0.9');
      proc.stdout.emit('data', Buffer.from('[run-pod] started bru\n'));
      await wait(300);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await done;
      expect(getDecryptedEvents(runId).some((e) => NO_LINE.test(e.message))).toBe(false);
    });

    test('not armed before a pod holds the run: the wait for a pod has its own limits', async () => {
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '80');
      setConfig('RUN_IDLE_TIMEOUT_MS', '0');
      const { proc, done } = await startPodRun();
      await wait(300);
      expect(proc.kill).not.toHaveBeenCalled();
      proc.emit('close', 0);
      await done;
    });

    test('the dispatcher\'s own words (stderr) are not the pod\'s first line', async () => {
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '80');
      setConfig('RUN_IDLE_TIMEOUT_MS', '0');
      const { proc, done } = await startPodRun();
      proc.emit('pod', '10.1.0.9');
      proc.stderr.emit('data', Buffer.from('[run-dispatcher] The kept pod\'s log was cut; it is read again.\n'));
      await waitForKillCall(proc);
      proc.emit('close', 143);
      await done;
    });

    test('a run that ends first disarms it; 0 turns it off', async () => {
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '80');
      const first = await startPodRun();
      first.proc.emit('pod', '10.1.0.9');
      first.proc.emit('close', 1);
      await first.done;
      await wait(300);
      expect(first.proc.kill).not.toHaveBeenCalled();

      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '0');
      setConfig('RUN_IDLE_TIMEOUT_MS', '0');
      const second = await startPodRun();
      second.proc.emit('pod', '10.1.0.9');
      await wait(300);
      expect(second.proc.kill).not.toHaveBeenCalled();
      second.proc.emit('close', 0);
      await second.done;
    });

    test('runFirstLineLimitMs: three minutes by default, off at 0, the default for what is not a number', () => {
      const { runFirstLineLimitMs } = require('../../src/worker/runner');
      clearConfig('RUN_FIRST_LINE_TIMEOUT_MS');
      expect(runFirstLineLimitMs()).toBe(180000);
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '0');
      expect(runFirstLineLimitMs()).toBe(0);
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', '45000');
      expect(runFirstLineLimitMs()).toBe(45000);
      setConfig('RUN_FIRST_LINE_TIMEOUT_MS', 'soon');
      expect(runFirstLineLimitMs()).toBe(180000);
    });
  });

  test('the results the pod sent are linked as the run\'s artifacts, then removed', async () => {
    const { runId, request, proc, done } = await startPodRun();
    const env = shortEnv(request.envName);
    await runResults.storeRunResult(runId, `20261107_${env}_SIM_SALE_1ADT_Report.html`, Buffer.from('<html>scenario</html>'));
    await runResults.storeRunResult(runId, `20261107_${env}_Report.html`, Buffer.from('<html>merged</html>'));
    await runResults.storeRunResult(runId, `.bru_results_${runId.slice(0, 8)}.json`, Buffer.from('{"results":[]}'));
    proc.emit('close', 0);
    await done;
    const artifacts = require('../../src/db/db').all('SELECT type, filename FROM run_artifacts WHERE run_id = ?', [runId]);
    expect(artifacts.map((a) => `${a.type}:${a.filename}`).sort()).toEqual(['html_report:report_SIM_SALE_1ADT.html', 'json_results:.bru_results.json']);
    expect(await runResults.listRunResults(runId)).toEqual([]);
  });

  test('without a scenario report, mergeReport.js\'s is linked; with nothing sent, the run says so', async () => {
    const first = await startPodRun();
    await runResults.storeRunResult(first.runId, `20261107_${shortEnv(first.request.envName)}_Report.html`, Buffer.from('<html>merged</html>'));
    first.proc.emit('close', 0);
    await first.done;
    const linked = require('../../src/db/db').all('SELECT filename FROM run_artifacts WHERE run_id = ?', [first.runId]);
    expect(linked.map((a) => a.filename)).toEqual(['report.html']);

    const second = await startPodRun();
    second.proc.emit('close', 1);
    await second.done;
    expect(getDecryptedEvents(second.runId).some((e) => e.level === 'warn' && /sent no result file/.test(e.message))).toBe(true);
  });

  describe('metrics', () => {
    const metrics = require('../../src/utils/metrics');
    const ended = async (outcome) => (await metrics.runPodsEnded.get()).values.find((v) => v.labels.outcome === outcome)?.value || 0;
    const started = async () => (await metrics.runPodStart.get()).values.find((v) => v.metricName === 'oscar_run_pod_start_seconds_count')?.value || 0;

    test('a run\'s pod start time once its pod is named, and its outcome once, when it ends', async () => {
      const [before, deadline, refused] = [await started(), await ended('deadline'), await ended('refused')];
      const { proc, done } = await startPodRun();
      proc.emit('pod', '10.1.0.9');
      proc.emit('pod', '10.1.0.9');
      expect(await started()).toBe(before + 1);
      proc.emit('close', 124);
      proc.emit('error', new Error('late'));
      await done;
      expect(await ended('deadline')).toBe(deadline + 1);
      expect(await ended('refused')).toBe(refused);
    });

    test('a run refused by the dispatcher, or lost, counts as refused; no pod named, no start time', async () => {
      const [before, refused] = [await started(), await ended('refused')];
      const { proc, done } = await startPodRun();
      proc.emit('error', new Error('the runner agent refused: too many runs'));
      await done;
      expect(await ended('refused')).toBe(refused + 1);
      expect(await started()).toBe(before);
    });

    test('the outcomes are the dispatcher\'s exit codes, else Bruno ran', () => {
      const D = require('../../src/run-dispatcher/dispatcher');
      const { podOutcomeOf } = require('../../src/worker/runner');
      expect([0, 1, D.EXIT_TIMEOUT, D.EXIT_NOT_STARTED, D.EXIT_STOPPED, null].map(podOutcomeOf))
        .toEqual(['ran', 'ran', 'deadline', 'not_started', 'stopped', 'ran']);
      for (const code of [0, 2, 124, 125, 127, 143]) expect(metrics.RUN_POD_OUTCOMES).toContain(podOutcomeOf(code));
    });
  });

  // #1312: the moments the server sees for a pod run, and the steps between them.
  describe('the run\'s time, step by step', () => {
    test('a pod run gives its eleven steps once each, and one line in its log', async () => {
      const before = await stepCounts();
      const { runId, proc, done } = await startPodRun();
      proc.emit('started');
      proc.emit('started');
      proc.emit('pod', '10.1.0.9');
      proc.stdout.emit('data', Buffer.from('[run-pod] started bru\n'));
      expect(runTimeline._marksOf(runId)).toEqual(['slot', 'launched', 'job', 'pod', 'output']);
      // What the run's routes note once its secret is verified (internal-run-port.test.js).
      runTimeline.mark(runId, 'call');
      runTimeline.mark(runId, 'upload');
      runTimeline.markAgain(runId, 'uploaded');
      storeRequestTimes(runId, 0);
      proc.emit('close', 0);
      await done;
      expect(stepsMoved(before, await stepCounts()))
        .toEqual(['prepare', 'job', 'pod', 'folder', 'bruno_start', 'requests', 'reports', 'send', 'end', 'link', 'store']);
      const lines = timeLines(runId);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[runner\] Where this run's time went \(\d+\.\d s from its slot to its final status\): preparing the run \d+\.\d s, asking for its pod \d+\.\d s, waiting for its pod \d+\.\d s, its pod preparing the work folder \d+\.\d s, Bruno starting \d+\.\d s, the requests 0\.0 s, the reports \d+\.\d s, sending the results \d+\.\d s, its pod ending \d+\.\d s, linking the reports \d+\.\d s, storing the checks \d+\.\d s\.$/);
      expect(runTimeline.stepsOf(runId).steps).toEqual([]);     // the run ended: nothing is kept
    });

    test('what the dispatcher writes of itself is not the pod\'s first line', async () => {
      const before = await stepCounts();
      const { proc, done } = await startPodRun();
      proc.emit('started');
      proc.emit('pod', '10.1.0.9');
      proc.stderr.emit('data', Buffer.from('[run-dispatcher] The run\'s log was cut\n'));
      proc.emit('close', 1);
      await done;
      expect(stepsMoved(before, await stepCounts())).toEqual(['prepare', 'job', 'pod', 'link', 'store']);
    });

    test('a run the dispatcher refused gives what was seen: it was prepared, then stored', async () => {
      const before = await stepCounts();
      const { runId, proc, done } = await startPodRun();
      proc.emit('error', new Error('the runner agent refused: too many runs'));
      await done;
      expect(stepsMoved(before, await stepCounts())).toEqual(['prepare', 'link', 'store']);
      expect(timeLines(runId)).toHaveLength(1);
    });
  });

  test('a mode set to pod without its settings starts nothing', async () => {
    delete process.env.RUN_SERVER_URL;
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    RemoteProcess.mockClear();
    const result = await executeRun({ runId, companyId, userId });
    expect(result.exitCode).toBe(1);
    expect(RemoteProcess).not.toHaveBeenCalled();
    expect(getRunRow(runId).error_message).toMatch(/RUN_SERVER_URL/);
  });
});

// #1322: with RUN_KEPT_PODS=on, the runs of a batch go to pods kept for it.
describe('executeRun — RUN_KEPT_PODS=on (#1322)', () => {
  const runSecrets = require('../../src/utils/runSecrets');
  const keptRunPool = require('../../src/worker/keptRunPool');
  const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_AGENT_HOST', 'RUN_SERVER_URL', 'INTERNAL_PORT', 'RUN_KEPT_PODS'];
  const saved = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    Object.assign(process.env, {
      RUN_ISOLATION: 'pod', RUN_AGENT_TOKEN: 't'.repeat(40), RUN_AGENT_HOST: 'oscar-dispatcher',
      RUN_SERVER_URL: 'http://oscar-internal:3003', INTERNAL_PORT: '3003', RUN_KEPT_PODS: 'on',
    });
  });
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    RemoteProcess.mockReset();
    // Only this block's own spies: the file's stub of the results' extraction stays.
    for (const name of ['announce', 'release', 'launchKeptRun']) keptRunPool[name].mockRestore?.();
  });

  async function waitFor(check) {
    const start = Date.now();
    while (!check() && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 10));
  }

  test('a run of a batch goes to the pool, said on its way first and released at its end; nothing to the dispatcher for it', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    const batchId = uuidv4();
    run('UPDATE runs SET batch_id = ? WHERE id = ?', [batchId, runId]);
    resolveAccessToken.mockResolvedValueOnce('tok-kept');
    const announce = jest.spyOn(keptRunPool, 'announce');
    const release = jest.spyOn(keptRunPool, 'release');
    const calls = [];
    jest.spyOn(keptRunPool, 'launchKeptRun').mockImplementation((args) => {
      const proc = makeFakeProc();
      calls.push({ args, proc });
      return proc;
    });
    const done = executeRun({ runId, companyId, userId });
    await waitFor(() => calls.length > 0);
    expect(calls).toHaveLength(1);
    const { args, proc } = calls[0];
    expect(args.batch).toEqual({ companyId, userId, batchId });
    expect(args.run).toMatchObject({ runId, deadlineSeconds: 600 });
    expect(Buffer.from(args.run.envYml, 'base64').toString('utf8')).toContain(args.run.envName);
    expect(args.run.env.OSCAR_ACCESS_TOKEN).toBe('tok-kept');
    expect(runSecrets.verify(runId, args.run.env.OSCAR_RUN_SECRET)).toBe(companyId);
    expect(announce).toHaveBeenCalledWith(runId, { companyId, userId, batchId });
    expect(RemoteProcess).not.toHaveBeenCalled();
    proc.emit('pod', '10.1.0.9');
    expect(runSecrets.fromRunAddress(runId, '10.1.0.10')).toBe(false);
    proc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
    expect(release).toHaveBeenCalledWith(runId);
    expect(getDecryptedEvents(runId).some((e) => /goes to a pod kept for its batch/.test(e.message))).toBe(true);
  });

  test('a run alone keeps a pod of its own', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-alone');
    const launchKept = jest.spyOn(keptRunPool, 'launchKeptRun');
    const announce = jest.spyOn(keptRunPool, 'announce');
    const procs = [];
    RemoteProcess.mockImplementation(function FakeRemote(agent, request) {
      const proc = makeFakeProc();
      procs.push({ request, proc });
      return proc;
    });
    const done = executeRun({ runId, companyId, userId });
    await waitFor(() => procs.length > 0);
    expect(procs[0].request).toMatchObject({ kind: 'run', runId });
    expect(launchKept).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
    procs[0].proc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
  });

  test('a run refused before it needs a pod is released all the same', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    run('UPDATE runs SET batch_id = ? WHERE id = ?', [uuidv4(), runId]);
    process.env.RUN_KEPT_PODS = 'maybe';
    const release = jest.spyOn(keptRunPool, 'release');
    const out = await executeRun({ runId, companyId, userId });
    expect(out.error).toMatch(/^RUN_KEPT_PODS="maybe" is neither on nor off/);
    expect(release).toHaveBeenCalledWith(runId);
  });
});

// Option 2b: a mode the server does not know starts no run, and spawns nothing.
describe('executeRun — RUN_ISOLATION', () => {
  test('an unknown mode refuses the run before a token is asked for', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    spawn.mockClear();
    resolveAccessToken.mockClear();
    const saved = process.env.RUN_ISOLATION;
    process.env.RUN_ISOLATION = 'nonsense';
    try {
      const out = await executeRun({ runId, companyId, userId });
      expect(out.exitCode).toBe(1);
      expect(out.error).toMatch(/^RUN_ISOLATION="nonsense" is not a mode this server knows/);
      expect(resolveAccessToken).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.RUN_ISOLATION; else process.env.RUN_ISOLATION = saved;
    }
  });
});

describe('executeRun — a Test Framework holding "{{"', () => {
  test('the run is refused before a token is asked for or Bruno started', async () => {
    const { companyId, userId } = seedCompanyUser();
    run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)',
      [require('node:crypto').randomUUID(), companyId, colEncrypt(JSON.stringify({ products: [{ code: '{{access_token}}' }] }))]);
    const runId = seedRun(companyId, userId);
    spawn.mockClear();
    resolveAccessToken.mockClear();
    const out = await executeRun({ runId, companyId, userId });
    expect(out.exitCode).toBe(1);
    expect(out.error).toContain('Test Framework holds text that contains "{{"');
    expect(out.error).toContain('products[0].code');
    expect(resolveAccessToken).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});

// 1.11.478: an intrusion line is acted on only with the run's own tag, which
// the runner wrote in the environment file; a line a scenario prints is not.
describe('executeRun — intrusion lines carry the run\'s tag', () => {
  test('a forged line records nothing; the tagged one suspends the endpoint', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    const { readEnvYml, valueIn } = require('../helpers/env-yml');
    const envFile = fs.readdirSync(ENVS_DIR).find(f => f.includes(runId.slice(0, 8)));
    const tag = valueIn(readEnvYml(fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8')), '__intrusionTag');
    const events = () => get('SELECT COUNT(*) AS n FROM security_event WHERE run_id = ?', [runId]).n;

    fakeProc.stdout.emit('data', Buffer.from('Running scenario X [INTRUSION] kind=template step=01. POST Get Offer\n'));
    fakeProc.stdout.emit('data', Buffer.from(`[INTRUSION] tag=${'0'.repeat(32)} kind=template step=01. POST Get Offer\n`));
    expect(events()).toBe(0);
    fakeProc.stdout.emit('data', Buffer.from(`[INTRUSION] tag=${tag} kind=template step=01. POST Get Offer [ERROR] x\n`));
    expect(events()).toBe(1);
    expect(get('SELECT endpoint_suspended_at FROM companies WHERE id = ?', [companyId]).endpoint_suspended_at).toBeTruthy();

    fakeProc.emit('close', 0);
    await p;
    run('DELETE FROM security_event WHERE run_id = ?', [runId]);
  });
});

// #1327: the collection renews the run's first token before it expires, from
// the expiry the runner writes when OSCAR knows it.
describe('executeRun — the first token\'s expiry', () => {
  async function envOfRun(resolve) {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockImplementationOnce(resolve);
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const p = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    const { readEnvYml } = require('../helpers/env-yml');
    const envFile = fs.readdirSync(ENVS_DIR).find(f => f.includes(runId.slice(0, 8)));
    const file = readEnvYml(fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8'));
    fakeProc.emit('close', 0);
    await p;
    return file;
  }

  test('written in ms since the epoch when OSCAR knows it', async () => {
    const { valueIn } = require('../helpers/env-yml');
    const file = await envOfRun(async (_row, _log, opts) => { opts.onExpiry('2026-11-18T20:30:00.000Z'); return 'tok'; });
    expect(valueIn(file, '__tokenExpiresAt')).toBe(String(Date.parse('2026-11-18T20:30:00.000Z')));
  });

  test('left out when it is not known (a static token)', async () => {
    const { valueIn } = require('../helpers/env-yml');
    const file = await envOfRun(async () => 'tok');
    expect(valueIn(file, '__tokenExpiresAt')).toBeUndefined();
  });
});

// ── Detected auth/format errors surfaced onto the run row ─────────────────────
describe('executeRun — auth/token-format error detection from CLI output', () => {
  test('sets error_message = TOKEN_AUTH_ERROR when a 401 appears in stdout', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.stdout.emit('data', Buffer.from('Wrong response status: 401\n'));
    fakeProc.emit('close', 1);
    await runPromise;

    expect(getRunRow(runId).error_message).toBe('TOKEN_AUTH_ERROR');
  });

  // #680: the refused token is taken out of the cache, through dropCachedToken
  // (its own rule is tested against the database in access-token-drop.test.js).
  async function runWithStdout(text, drop) {
    const { companyId, userId } = seedCompanyUser({ authMode: 'oauth2' });
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-refused');
    dropCachedToken.mockReset();
    if (drop) dropCachedToken.mockImplementationOnce(drop);
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.stdout.emit('data', Buffer.from(text));
    fakeProc.emit('close', 1);
    await runPromise;
    return { runId, userId, companyId, messages: getDecryptedEvents(runId).map(e => e.message) };
  }
  const DROPPED = 'The cached token was refused (401); it is dropped';

  test('a 401 drops the token the run used from the cache, and says so (#680)', async () => {
    const r = await runWithStdout('Wrong response status: 401\n', () => true);
    expect(dropCachedToken).toHaveBeenCalledTimes(1);
    const [row, token] = dropCachedToken.mock.calls[0];
    expect([row.user_id, row.company_id, token]).toEqual([r.userId, r.companyId, 'tok-refused']);
    expect(getRunRow(r.runId).error_message).toBe('TOKEN_AUTH_ERROR');
    expect(r.messages.some(m => m.includes(DROPPED))).toBe(true);
  });

  test('a 401 with a token the cache no longer holds says nothing more (#680)', async () => {
    const r = await runWithStdout('Wrong response status: 401\n', () => false);
    expect(dropCachedToken).toHaveBeenCalledTimes(1);
    expect(getRunRow(r.runId).error_message).toBe('TOKEN_AUTH_ERROR');
    expect(r.messages.some(m => m.includes('HTTP 401 detected'))).toBe(true);
    expect(r.messages.some(m => m.includes(DROPPED))).toBe(false);
  });

  test('a run without 401 keeps the cache (#680)', async () => {
    const r = await runWithStdout('all good\n', () => true);
    expect(dropCachedToken).not.toHaveBeenCalled();
    expect(r.messages.some(m => m.includes(DROPPED))).toBe(false);
  });

  test('a cache that cannot be cleared does not change the run\'s outcome (#680)', async () => {
    const r = await runWithStdout('Wrong response status: 401\n', () => { throw new Error('db locked'); });
    expect(getRunRow(r.runId).error_message).toBe('TOKEN_AUTH_ERROR');
    expect(r.messages.some(m => m.includes('could not be dropped from the cache: db locked'))).toBe(true);
    expect(r.messages.some(m => m.includes('Run finished'))).toBe(true);
  });

  test('sets error_message = TOKEN_FORMAT_ERROR when a YAML parse error appears in stderr', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    fakeProc.stderr.emit('data', Buffer.from('YAMLParseError: bad scalar\n'));
    fakeProc.emit('close', 1);
    await runPromise;

    expect(getRunRow(runId).error_message).toBe('TOKEN_FORMAT_ERROR');
  });
});

// ── Terminal-state guard (emergency-stop race) ─────────────────────────────────
describe('executeRun — does not resurrect an already-terminal run', () => {
  test('leaves a CANCELLED run untouched when the process closes afterward', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    // Simulate an emergency stop racing with the in-flight run.
    run(`UPDATE runs SET status = 'CANCELLED' WHERE id = ?`, [runId]);

    fakeProc.emit('close', 0);
    const result = await runPromise;

    expect(result.exitCode).toBe(0);
    expect(getRunRow(runId).status).toBe('CANCELLED'); // NOT overwritten to COMPLETED
  });
});

// ── #1312: a run's time, step by step, outside pod mode ───────────────────────
describe('executeRun — the run\'s time, step by step (#1312)', () => {
  async function startRun() {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    return { runId, fakeProc, done };
  }

  test('a run started here: prepared, Bruno\'s start, the requests and the reports, then linked and stored', async () => {
    const before = await stepCounts();
    const { runId, fakeProc, done } = await startRun();
    fakeProc.stdout.emit('data', Buffer.from('Running Tests...\n'));
    // Outside pod mode a first line is Bruno's own, not a moment of the run:
    // Bruno's start is counted from the launch.
    expect(runTimeline._marksOf(runId)).toEqual(['slot', 'launched']);
    runTimeline.mark(runId, 'call');
    storeRequestTimes(runId, 0);
    fakeProc.emit('close', 0);
    await done;
    expect(stepsMoved(before, await stepCounts())).toEqual(['prepare', 'bruno_start', 'requests', 'reports', 'link', 'store']);
    expect(timeLines(runId)).toHaveLength(1);
    expect(timeLines(runId)[0]).not.toMatch(/pod/);
  });

  test('a run whose results were not stored: the requests and the reports as one step', async () => {
    const before = await stepCounts();
    const { runId, fakeProc, done } = await startRun();
    runTimeline.mark(runId, 'call');
    fakeProc.emit('close', 1);
    await done;
    expect(stepsMoved(before, await stepCounts())).toEqual(['prepare', 'bruno_start', 'scenario', 'link', 'store']);
    expect(timeLines(runId)[0]).toMatch(/the requests and the reports \d+\.\d s/);
  });

  test('a run refused before it starts, or stopped by an emergency stop, gives no step and no line', async () => {
    const before = await stepCounts();
    const going = runTimeline._going();

    const { companyId, userId } = seedCompanyUser();
    run(`UPDATE companies SET datafile_path = NULL WHERE id = ?`, [companyId]);
    const refused = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    expect((await executeRun({ runId: refused, companyId, userId })).exitCode).toBe(1);

    const { runId, fakeProc, done } = await startRun();
    run(`UPDATE runs SET status = 'CANCELLED' WHERE id = ?`, [runId]);
    fakeProc.emit('close', 0);
    await done;

    expect(stepsMoved(before, await stepCounts())).toEqual([]);
    expect([...timeLines(refused), ...timeLines(runId)]).toEqual([]);
    expect(runTimeline._going()).toBe(going);          // nothing is kept of a run that ended
  });

  test('a measure that fails never stops a run', async () => {
    const observe = jest.spyOn(stepMetrics.runStepSeconds, 'observe').mockImplementation(() => { throw new Error('no metric'); });
    try {
      const { runId, fakeProc, done } = await startRun();
      fakeProc.emit('close', 0);
      expect((await done).exitCode).toBe(0);
      expect(getRunRow(runId).status).toBe('COMPLETED');
      expect(observe).toHaveBeenCalled();
    } finally {
      observe.mockRestore();
    }
  });
});

// ── Real (short) timeout-kill path — deliberately never emits 'close' ─────────
describe('executeRun — timeout kill', () => {
  test('kills the process and the run still resolves once close eventually fires', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    // Real (not fake-timer) short timeout — avoids the fragility of mixing
    // jest fake timers with an async Promise executor.
    run(`INSERT INTO server_config (key, value) VALUES ('RUN_TIMEOUT_MS', '80')
         ON CONFLICT(key) DO UPDATE SET value = '80'`);

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });

    // Poll for the real setTimeout to actually fire proc.kill() — never
    // assume a fixed wait is enough margin over the configured budget.
    await waitForKillCall(fakeProc);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    // The run only resolves once 'close' actually fires (real bru would exit
    // after receiving SIGTERM) — simulate that now so the test can finish.
    fakeProc.emit('close', 143);
    const result = await runPromise;
    expect(result.exitCode).toBe(143);

    run(`DELETE FROM server_config WHERE key = 'RUN_TIMEOUT_MS'`);
  }, 10000);
});

// ── A provider that stops answering (#646) ─────────────────────────────────────
describe('executeRun — a silent Bruno is stopped', () => {
  const setConfig = (key, value) => run(`INSERT INTO server_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  const clearConfig = (...keys) => keys.forEach((k) => run('DELETE FROM server_config WHERE key = ?', [k]));

  test('no output for RUN_IDLE_TIMEOUT_MS: the run is stopped and the log says why', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    setConfig('RUN_IDLE_TIMEOUT_MS', '80');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId });
    await waitForKillCall(fakeProc);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
    fakeProc.emit('close', 143);
    await runPromise;
    expect(getDecryptedEvents(runId).some((e) => /No output from Bruno for \d+s: run stopped\. Most often a request to the provider got no answer/.test(e.message))).toBe(true);
    clearConfig('RUN_IDLE_TIMEOUT_MS');
  }, 10000);

  test('a Bruno that keeps writing is not stopped', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    // Output every 50 ms for longer than the limit: silent for longer than the
    // limit only if a step stalls for 1.45 s. A loaded CI runner stalled past
    // 100 ms with a 120 ms limit, and past 270 ms with a 300 ms one (#712).
    setConfig('RUN_IDLE_TIMEOUT_MS', '1500');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    for (let i = 0; i < 40; i++) {
      fakeProc.stdout.emit('data', Buffer.from(`request ${i}\n`));
      await new Promise((r) => setTimeout(r, 50));
    }
    const killed = fakeProc.kill.mock.calls.length;
    fakeProc.emit('close', 0);
    await runPromise;
    clearConfig('RUN_IDLE_TIMEOUT_MS');
    expect(killed).toBe(0);
  }, 10000);

  // #656: the scenario waits for its booking to expire; with no max wait the
  // collection's budget is the run timeout, and it prints nothing meanwhile.
  test('an expiry test armed without a max wait is not stopped for silence', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runner-armed-'));
    const file = path.join(dir, 'datafile.json');
    fs.writeFileSync(file, JSON.stringify({ scenariosToRun: 'ALL', scenarios: [{ code: 'WAITS', expiredBookingTest: 'on', expiredBookingMaxWaitMinutes: '' }] }));
    run('UPDATE companies SET datafile_path = ? WHERE id = ?', [file, companyId]);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    setConfig('RUN_IDLE_TIMEOUT_MS', '80');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);
    await new Promise((r) => setTimeout(r, 400));
    const killed = fakeProc.kill.mock.calls.length;
    fakeProc.emit('close', 0);
    await runPromise;
    clearConfig('RUN_IDLE_TIMEOUT_MS');
    fs.rmSync(dir, { recursive: true, force: true });
    expect(killed).toBe(0);
    expect(getDecryptedEvents(runId).some((e) => /No stop on silence for this run: 1 expiry test/.test(e.message))).toBe(true);
  }, 10000);

  test('a process that ignores SIGTERM at the timeout gets SIGKILL', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');
    setConfig('RUN_TIMEOUT_MS', '80');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId });
    await waitForKillCall(fakeProc);
    const start = Date.now();
    while (!fakeProc.kill.mock.calls.some((c) => c[0] === 'SIGKILL') && Date.now() - start < 6000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fakeProc.kill.mock.calls.map((c) => c[0])).toEqual(['SIGTERM', 'SIGKILL']);
    fakeProc.emit('close', 137);
    await runPromise;
    clearConfig('RUN_TIMEOUT_MS');
  }, 12000);

  test('runIdleLimitMs: five minutes by default, off at 0, off when a scenario waits on purpose', () => {
    clearConfig('RUN_IDLE_TIMEOUT_MS');
    expect(runIdleLimitMs({ requestedMs: 0 })).toBe(300000);
    expect(runIdleLimitMs({ requestedMs: 2460000 })).toBe(0);
    // #656: an expiry test armed without a max wait still waits.
    expect(runIdleLimitMs({ requestedMs: 0, armedTimers: 1 })).toBe(0);
    expect(runIdleLimitMs({ requestedMs: 0, armedTimers: 0 })).toBe(300000);
    setConfig('RUN_IDLE_TIMEOUT_MS', '0');
    expect(runIdleLimitMs({ requestedMs: 0 })).toBe(0);
    clearConfig('RUN_IDLE_TIMEOUT_MS');
  });
});

// ── killRun() ──────────────────────────────────────────────────────────────────
describe('killRun', () => {
  test('returns false when there is no active process for the runId', () => {
    expect(killRun(uuidv4())).toBe(false);
  });

  test('SIGTERMs the tracked process and returns true while a run is in flight', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1); // let executeRun register the proc

    expect(killRun(runId)).toBe(true);
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');

    fakeProc.emit('close', 143);
    await runPromise;
  });
});

// ── #306 — secretless env yml (credentials travel via the process env) ────────
describe('executeRun — #306 credential transport', () => {
  test('the ephemeral env yml carries no credentials; the spawn env does', async () => {
    const { encrypt } = require('../../src/db/db');
    const { companyId, userId } = seedCompanyUser();
    run(`UPDATE tester_credentials SET subscription_key_enc = ?, oauth_extra_enc = ? WHERE user_id = ? AND company_id = ?`,
      [encrypt('subkey-secret-456'), encrypt('basic-extra-789'), userId, companyId]);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-secret-123');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    // Read the env yml while it is still on disk (unlinked after 'close').
    const slug = get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug;
    const envFile = path.join(ENVS_DIR, `OTST_${slug}_${runId.slice(0, 8)}_Env.yml`);
    const yml = fs.readFileSync(envFile, 'utf8');
    const spawnEnv = spawn.mock.calls[0][2].env;
    // Let the run end before asserting. An assertion that fails while the fake
    // process is still open leaves executeRun waiting on its 10-minute timeout,
    // and Jest then reports the failure but does not exit until that timer.
    fakeProc.emit('close', 0);
    await runPromise;

    // Neither the secret values nor even the variable names may appear.
    expect(yml).not.toContain('tok-secret-123');
    expect(yml).not.toContain('subkey-secret-456');
    expect(yml).not.toContain('basic-extra-789');
    expect(yml).not.toContain('access_token');
    expect(yml).not.toContain('Ocp-Apim-Subscription-Key');
    expect(yml).not.toContain('oauth_extra');
    expect(yml).not.toContain('auth_key_secret');
    // Non-secret plumbing is still written to the file.
    expect(yml).toContain('api_base');
    expect(yml).toContain('__runId');

    // Credentials travel via the child process environment instead.
    expect(spawnEnv.OSCAR_ACCESS_TOKEN).toBe('tok-secret-123');
    expect(spawnEnv.OSCAR_SUBSCRIPTION_KEY).toBe('subkey-secret-456');
    expect(spawnEnv.OSCAR_OAUTH_EXTRA).toBe('basic-extra-789');
    // The server's own secret env is still never forwarded (allowlist).
    expect(spawnEnv).not.toHaveProperty('ENCRYPTION_KEY');
    expect(spawnEnv).not.toHaveProperty('JWT_SECRET');
  });

  test('optional credential env vars are absent when the tester has none configured', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-abc');

    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);

    const runPromise = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(1);

    const spawnEnv = spawn.mock.calls[0][2].env;
    fakeProc.emit('close', 0);                       // end the run first, as above
    await runPromise;

    expect(spawnEnv.OSCAR_ACCESS_TOKEN).toBe('tok-abc');
    expect(spawnEnv).not.toHaveProperty('OSCAR_SUBSCRIPTION_KEY');
    expect(spawnEnv).not.toHaveProperty('OSCAR_OAUTH_EXTRA');
  });
});

// ── PR-03 — what the two child processes are handed ──────────────────────────
// NEW-01: the Bruno spawn passed an allowlisted environment, but the second
// child, `node mergeReport.js`, was started with no `env` option at all and so
// inherited process.env whole: ENCRYPTION_KEY, JWT_SECRET, the SMTP password.
// mergeReport.js is a file of the bind-mounted collection, not of the server.
// NEW-02: the environment file is checked here as executeRun writes it, with
// the three variables executeRun adds itself.
describe('executeRun — PR-03: child processes and the environment file', () => {
  const { CHILD_ENV_ALLOWLIST } = require('../../src/worker/runner');
  const { readEnvYml, valueIn } = require('../helpers/env-yml');
  const RUN_CREDENTIALS = ['OSCAR_ACCESS_TOKEN', 'OSCAR_SUBSCRIPTION_KEY', 'OSCAR_OAUTH_EXTRA'];
  const SERVER_SECRETS = {
    JWT_SECRET: 'jwt-secret-for-pr03',
    SMTP_HOST: 'smtp.example.test',
    SMTP_USER: 'mailer@example.test',
    SMTP_PASS: 'smtp-password-for-pr03',
    DATABASE_URL: 'postgres://user:pw@db.example.test/x',
    SOME_FUTURE_API_KEY: 'a-secret-nobody-listed-yet',
  };
  let saved;

  beforeEach(() => {
    saved = {};
    for (const [k, v] of Object.entries(SERVER_SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
  });
  afterEach(() => {
    for (const k of Object.keys(SERVER_SECRETS)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  // Where the runner works depends on the machine. On Windows it is the
  // collection folder. Elsewhere, a run that names a scenario gets a copy of
  // the collection of its own (data/workspaces/<runId>), and the environment
  // file, the results and mergeReport.js are the ones in that copy. A test that
  // looks in the collection folder only passes on Windows, so the folder is
  // read from what the runner hands to spawn, and both modes are run on any
  // machine: `platform` is what process.platform reads as during the run.
  const WORKSPACES_DIR = path.resolve(__dirname, '../../data/workspaces');
  const MODES = [['in the collection folder', 'win32'], ['in a workspace of its own', 'linux']];

  afterEach(() => {
    for (const runId of createdRunIds) {
      try { fs.rmSync(path.join(WORKSPACES_DIR, runId), { recursive: true, force: true }); } catch (_) {}
    }
  });

  // A run that names its scenario reads the company's datafile before it starts
  // (NEW-10), so such a run is given a real one: this scenario, and the entries
  // it points to. `datafile` replaces it for a test that needs something else.
  const os = require('node:os');
  const datafileDirs = [];
  afterAll(() => {
    for (const dir of datafileDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  });
  function datafileFor(code) {
    return {
      scenariosToRun: 'ALL',
      scenarios: [
        { code, tripRequirementId: 1, passengersListId: 1, purchaserListId: 2 },
        { code: 'SOMEONE_ELSES', tripRequirementId: 2, passengersListId: 2, purchaserListId: 1 },
      ],
      tripRequirements: [{ id: 1, legs: [{ origin: 'urn:a' }] }, { id: 2, legs: [{ origin: 'urn:c' }] }],
      passengersList: [{ id: 1, passengers: [{ firstName: 'Ada' }] }, { id: 2, passengers: [{ firstName: 'Bob' }] }],
      purchaserList: [{ id: 1, purchaser: [{ firstName: 'Pat' }] }, { id: 2, purchaser: [{ firstName: 'Quinn' }] }],
    };
  }
  function useDatafile(companyId, content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-datafile-'));
    datafileDirs.push(dir);
    const file = path.join(dir, 'datafile.json');
    fs.writeFileSync(file, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content));
    run('UPDATE companies SET datafile_path = ? WHERE id = ?', [file, companyId]);
    return file;
  }

  // Starts a run that reaches the second spawn, and gives back both spawn calls.
  // `plant(cwd, runId, envName)` adds what the run leaves in its folder, before it ends.
  async function runWithReportScript({ scenarioOverride, platform, datafile, plant } = {}) {
    const { encrypt } = require('../../src/db/db');
    const { companyId, userId } = seedCompanyUser();
    if (scenarioOverride !== undefined) useDatafile(companyId, datafile || datafileFor(scenarioOverride));
    run(`UPDATE tester_credentials SET subscription_key_enc = ?, oauth_extra_enc = ? WHERE user_id = ? AND company_id = ?`,
      [encrypt('subkey-secret-456'), encrypt('basic-extra-789'), userId, companyId]);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-secret-123');
    fs.mkdirSync(path.dirname(MERGE_REPORT_JS), { recursive: true });
    fs.writeFileSync(MERGE_REPORT_JS, '// stub, never executed (spawn is mocked)');

    const mainProc = makeFakeProc();
    const mergeProc = makeFakeProc();
    spawn.mockReturnValueOnce(mainProc).mockReturnValueOnce(mergeProc);

    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platform) Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
    try {
      const runPromise = executeRun({ runId, companyId, userId, scenarioOverride });
      await waitForSpawnCalls(1);
      const cwd = spawn.mock.calls[0][2].cwd;          // the folder the runner works in for this run
      const slug = get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug;
      const envName = `OTST_${slug}_${runId.slice(0, 8)}_Env`;
      const envFile = fs.readFileSync(path.join(cwd, 'environments', `${envName}.yml`), 'utf8');
      fs.mkdirSync(path.join(cwd, 'Validation_Reports'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'Validation_Reports', `.bru_results_${runId.slice(0, 8)}.json`), JSON.stringify({ results: [] }));
      if (plant) plant(cwd, runId, envName);
      mainProc.emit('close', 0);
      await waitForSpawnCalls(2);
      // What mergeReport.js was given, read while it "runs".
      const stdJson = path.join(cwd, 'Validation_Reports', '.bru_results.json');
      let mergeInput = null;
      try {
        const text = fs.readFileSync(stdJson, 'utf8');
        mergeInput = { link: fs.lstatSync(stdJson).isSymbolicLink(), text };
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      mergeProc.emit('close', 0);
      await runPromise;
      return { runId, envName, envFile, cwd, mergeInput, bruno: spawn.mock.calls[0], report: spawn.mock.calls[1] };
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }
  }

  test('the report script is started with an environment of its own, not the server\'s', async () => {
    const { report } = await runWithReportScript();
    expect(report[0]).toBe(process.execPath);
    expect(report[1][0]).toBe(MERGE_REPORT_JS);
    const env = report[2].env;
    expect(env).toBeDefined();                       // no `env` option means "inherit everything"
    expect(env).not.toBe(process.env);
    expect(env).not.toHaveProperty('ENCRYPTION_KEY');
    for (const secret of Object.keys(SERVER_SECRETS)) expect(env).not.toHaveProperty(secret);
    for (const value of [process.env.ENCRYPTION_KEY, ...Object.values(SERVER_SECRETS)]) {
      expect(Object.values(env)).not.toContain(value);
    }
  });

  test('the report script gets none of the run\'s credentials either', async () => {
    const { report } = await runWithReportScript();
    for (const name of RUN_CREDENTIALS) expect(report[2].env).not.toHaveProperty(name);
    expect(report[2].env).not.toHaveProperty('OSCAR_RUN_SECRET');        // S8-loopback: the secret is Bruno's alone
    expect(Object.values(report[2].env)).not.toContain('tok-secret-123');
    expect(JSON.stringify(report[1])).not.toContain('tok-secret-123');   // nor on its command line
  });

  test('both children receive only allowlisted variables, so a new server secret is not passed on', async () => {
    const { bruno, report } = await runWithReportScript();
    const allowed = new Set(CHILD_ENV_ALLOWLIST);
    // S8-loopback: Bruno also gets the per-run secret; the report script does not.
    const brunoExtras = [...RUN_CREDENTIALS, 'OSCAR_RUN_SECRET'].sort();
    expect(Object.keys(report[2].env).filter(k => !allowed.has(k))).toEqual([]);
    expect(Object.keys(bruno[2].env).filter(k => !allowed.has(k)).sort()).toEqual(brunoExtras);
    expect(report[2].env.PATH).toBe(process.env.PATH);                   // it can still find what it needs
    expect(report[2].shell).toBe(false);
  });

  describe.each(MODES)('a run that names its scenario, %s', (_where, platform) => {
    test('the runner works where expected, and the report script it starts is the one there', async () => {
      const { runId, cwd, bruno, report } = await runWithReportScript({ scenarioOverride: 'OTST_SALE_1ADT_1LEG', platform });
      expect(cwd).toBe(platform === 'win32' ? COLLECTION_PATH : path.join(WORKSPACES_DIR, runId));
      expect(bruno[2].cwd).toBe(cwd);
      expect(report[2].cwd).toBe(cwd);
      expect(report[1][0]).toBe(path.join(cwd, 'library-bruno', 'mergeReport.js'));
      const allowed = new Set(CHILD_ENV_ALLOWLIST);
      expect(Object.keys(report[2].env).filter(k => !allowed.has(k))).toEqual([]);
      expect(Object.keys(bruno[2].env).filter(k => !allowed.has(k)).sort()).toEqual([...RUN_CREDENTIALS, 'OSCAR_RUN_SECRET'].sort());
    });

    test('the environment file on disk, with the variables executeRun adds, holds values only', async () => {
      const { runId, envName, envFile } = await runWithReportScript({ scenarioOverride: 'OTST_SALE_1ADT_1LEG', platform });
      const file = readEnvYml(envFile);               // throws on any line that is not a name or a quoted value
      expect(file.name).toBe(envName);
      expect(file.variables.map(v => v.name)).toEqual([
        'api_base', 'library_base', 'data_base', 'json_schema', 'scenariosToRunIndex', 'scenario_override',
        '__traceContext', 'runHardDeadlineMs', '__runId', '__intrusionTag', 'oscar_loopback_base',
      ]);
      expect(valueIn(file, '__intrusionTag')).toMatch(/^[0-9a-f]{32}$/);
      expect(valueIn(file, 'api_base')).toBe('https://vendor.example/osdm');
      expect(valueIn(file, 'scenario_override')).toBe('OTST_SALE_1ADT_1LEG');
      expect(valueIn(file, '__runId')).toBe(runId);
      expect(valueIn(file, 'runHardDeadlineMs')).toMatch(/^\d{13}$/);
      expect(valueIn(file, 'oscar_loopback_base')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    test('a crafted scenario code reaches the file as one value: one endpoint, the company\'s', async () => {
      const crafted = 'X"\n  - name: api_base\n    value: "https://elsewhere.example/collect';
      const { envFile } = await runWithReportScript({ scenarioOverride: crafted, platform });
      const file = readEnvYml(envFile);
      expect(valueIn(file, 'api_base')).toBe('https://vendor.example/osdm');   // valueIn throws on a second one
      expect(valueIn(file, 'scenario_override')).toBe(crafted);
      expect(file.variables).toHaveLength(11);   // #1070: __traceContext; 1.11.478: __intrusionTag
    });

    test('single braces, and a code with no template, still run', async () => {
      for (const code of ['OTST_SALE_1ADT_1LEG', 'with {one} brace pair', 'a } then a {']) {
        const { envFile } = await runWithReportScript({ scenarioOverride: code, platform });
        expect(valueIn(readEnvYml(envFile), 'scenario_override')).toBe(code);
        jest.clearAllMocks();
      }
    });
  });

  // The run writes its own folder (with RUN_ISOLATION=isolated, from another
  // container). The server reads and writes there without following a link
  // (src/worker/runFolder.js); a file that is not a plain file of the folder is
  // left out with a line in the log. tests/unit/run-folder.test.js holds the
  // rules; these check that the runner goes through them.
  describe('the files a run leaves in its folder are read only as plain files of it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-outside-'));
    afterAll(() => { fs.rmSync(outside, { recursive: true, force: true }); });
    // A link to a file needs Developer Mode on Windows; CI runs these tests.
    const canLink = (() => {
      try {
        fs.writeFileSync(path.join(outside, 'probe'), 'x');
        fs.symlinkSync(path.join(outside, 'probe'), path.join(outside, 'probe-link'), 'file');
        return true;
      } catch {
        return false;
      }
    })();
    const linkTest = canLink ? test : test.skip;

    function serverFile(name, content) {
      const file = path.join(outside, name);
      fs.writeFileSync(file, content);
      return file;
    }
    const prefixOf = (envName) => `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}_${envName.replace(/^OTST_/, '').replace(/_Env$/, '')}`;
    const artifactsOf = (runId) => require('../../src/db/db').all('SELECT type, filename FROM run_artifacts WHERE run_id = ?', [runId]);
    const SCENARIO = 'OTST_SALE_1ADT_1LEG';

    describe.each(MODES)('%s', (_where, platform) => {
      linkTest('a report that is a link is left out; a plain one is linked; what the link names is not read', async () => {
        const secret = serverFile(`db-${platform}`, 'SERVER-SECRET');
        const { runId } = await runWithReportScript({
          scenarioOverride: SCENARIO, platform,
          plant: (cwd, _id, envName) => {
            const reports = path.join(cwd, 'Validation_Reports');
            fs.writeFileSync(path.join(reports, `${prefixOf(envName)}_PLAIN_Report.html`), '<html>plain</html>');
            fs.symlinkSync(secret, path.join(reports, `${prefixOf(envName)}_LINKED_Report.html`), 'file');
          },
        });
        const files = artifactsOf(runId).map(a => a.filename);
        expect(files).toContain('report_PLAIN.html');
        expect(files).not.toContain('report_LINKED.html');
        expect(fs.existsSync(path.join(ARTIFACTS_DIR, runId, 'report_LINKED.html'))).toBe(false);
        expect(getDecryptedEvents(runId).some(e => e.level === 'error' && /_LINKED_Report\.html left out/.test(e.message))).toBe(true);
      });

      linkTest('a link where the results copy goes is replaced, and what it names is not written', async () => {
        const secret = serverFile(`target-${platform}`, 'SERVER-SECRET');
        const { runId, mergeInput } = await runWithReportScript({
          scenarioOverride: SCENARIO, platform,
          plant: (cwd) => fs.symlinkSync(secret, path.join(cwd, 'Validation_Reports', '.bru_results.json'), 'file'),
        });
        expect(fs.readFileSync(secret, 'utf8')).toBe('SERVER-SECRET');
        expect(mergeInput).toEqual({ link: false, text: JSON.stringify({ results: [] }) });
        expect(artifactsOf(runId).some(a => a.type === 'json_results')).toBe(true);
      });

      linkTest('results that are a link are left out, and the report script is not started', async () => {
        const secret = serverFile(`results-${platform}`, '{"secret":true}');
        const { runId } = await runWithReportScriptNoMerge({
          scenarioOverride: SCENARIO, platform,
          plant: (cwd, id) => {
            const results = path.join(cwd, 'Validation_Reports', `.bru_results_${id.slice(0, 8)}.json`);
            fs.rmSync(results);
            fs.symlinkSync(secret, results, 'file');
          },
        });
        expect(artifactsOf(runId).some(a => a.type === 'json_results')).toBe(false);
        expect(getDecryptedEvents(runId).some(e => /\.bru_results_[0-9a-f]{8}\.json left out/.test(e.message))).toBe(true);
      });
    });

    test('in a workspace, a reports folder swapped for a link is not read at all', async () => {
      const server = fs.mkdtempSync(path.join(outside, 'server-'));
      const { runId } = await runWithReportScriptNoMerge({
        scenarioOverride: SCENARIO, platform: 'linux',
        plant: (cwd, id, envName) => {
          const reports = path.join(cwd, 'Validation_Reports');
          fs.writeFileSync(path.join(server, `${prefixOf(envName)}_X_Report.html`), 'SERVER');
          fs.writeFileSync(path.join(server, `.bru_results_${id.slice(0, 8)}.json`), '{"server":true}');
          fs.rmSync(reports, { recursive: true });
          fs.symlinkSync(server, reports, 'junction');
        },
      });
      expect(artifactsOf(runId)).toEqual([]);
      expect(getDecryptedEvents(runId).some(e => /not the run's own folder/.test(e.message))).toBe(true);
      expect(fs.readdirSync(server).sort()).toHaveLength(2);       // nothing added or removed there
    });

    // Like runWithReportScript, for a run whose results are not there to read:
    // the report script is never started.
    async function runWithReportScriptNoMerge({ scenarioOverride, platform, plant }) {
      const { companyId, userId } = seedCompanyUser();
      useDatafile(companyId, datafileFor(scenarioOverride));
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-secret-123');
      fs.mkdirSync(path.dirname(MERGE_REPORT_JS), { recursive: true });
      fs.writeFileSync(MERGE_REPORT_JS, '// stub, never executed (spawn is mocked)');
      const mainProc = makeFakeProc();
      spawn.mockReturnValueOnce(mainProc);
      const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
      try {
        const runPromise = executeRun({ runId, companyId, userId, scenarioOverride });
        await waitForSpawnCalls(1);
        const cwd = spawn.mock.calls[0][2].cwd;
        const slug = get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug;
        fs.mkdirSync(path.join(cwd, 'Validation_Reports'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'Validation_Reports', `.bru_results_${runId.slice(0, 8)}.json`), JSON.stringify({ results: [] }));
        plant(cwd, runId, `OTST_${slug}_${runId.slice(0, 8)}_Env`);
        mainProc.emit('close', 0);
        await runPromise;
        expect(spawn).toHaveBeenCalledTimes(1);
        return { runId, cwd };
      } finally {
        Object.defineProperty(process, 'platform', realPlatform);
      }
    }
  });

  // Escaping keeps a code from adding to the file. Bruno then does one more
  // thing with a value: it fills in {{...}} when a script reads it, and
  // {{process.env.OSCAR_ACCESS_TOKEN}} is the token of whoever started the run
  // (checked with Bruno CLI 4.2.1). The collection would then report that
  // "code" as not found, in a run log every member of the company can read.
  // There is no way to write {{ so that Bruno leaves it alone, so such a run
  // is refused before anything is started.
  describe('a scenario code holding a template, or one that is not text, is not run', () => {
    const OPEN = '{'.repeat(2);
    const CLOSE = '}'.repeat(2);

    test.each([
      [`${OPEN}process.env.OSCAR_ACCESS_TOKEN${CLOSE}`],
      [`OTST_${OPEN}access_token${CLOSE}_1ADT`],
      [`${OPEN}$guid${CLOSE}`],
      [`unclosed ${OPEN} is refused too`],
    ])('%s: FAILED, no token asked for, no file written, nothing started', async (code) => {
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-secret-123');
      const before = fs.readdirSync(ENVS_DIR);
      // If the refusal were ever removed, the run would go on to spawn. Let
      // that child end at once, so this test fails on its assertions instead
      // of hanging. The event is sent from inside spawn(), after which the
      // runner attaches its listeners in the same tick.
      spawn.mockImplementation(() => {
        const proc = makeFakeProc();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });

      const result = await executeRun({ runId, companyId, userId, scenarioOverride: code });
      const started = spawn.mock.calls.length;         // read before the mock is put back
      spawn.mockReset();

      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/scenario code/i);
      expect(getRunRow(runId).status).toBe('FAILED');
      expect(getRunRow(runId).error_message).toBe(result.error);
      expect(started).toBe(0);
      expect(resolveAccessToken).not.toHaveBeenCalled();
      expect(fs.readdirSync(ENVS_DIR)).toEqual(before);
      const events = getDecryptedEvents(runId);
      expect(events.some(e => e.level === 'error' && /scenario code/i.test(e.message))).toBe(true);
      expect(JSON.stringify(events)).not.toContain('tok-secret-123');
      resolveAccessToken.mockReset();
    });

    // A code is whatever JSON was stored. An object that cannot become a string
    // made the runner throw after the run was marked RUNNING, and a run that
    // throws is never marked FAILED: it stayed RUNNING until the next restart.
    test.each([
      ['an object', { toString: 1 }],
      ['an object with no prototype', Object.create(null)],
      ['a list', ['OTST_SALE_1ADT_1LEG']],
      ['a number', 42],
      ['true', true],
    ])('a code that is %s: FAILED with a reason, not left RUNNING', async (_what, code) => {
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      spawn.mockImplementation(() => {
        const proc = makeFakeProc();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });

      let result;
      let thrown = null;
      try { result = await executeRun({ runId, companyId, userId, scenarioOverride: code }); } catch (e) { thrown = e; }
      const started = spawn.mock.calls.length;
      spawn.mockReset();

      expect(thrown).toBeNull();
      expect(result.exitCode).toBe(1);
      expect(result.error).toMatch(/scenario code is not text/i);
      expect(getRunRow(runId).status).toBe('FAILED');
      expect(started).toBe(0);
      expect(resolveAccessToken).not.toHaveBeenCalled();
    });

    test('the rule on its own: what is refused, and what is not', () => {
      const { refusedScenarioCode } = require('../../src/worker/runner');
      for (const none of [null, undefined, '']) expect(refusedScenarioCode(none)).toBeNull();
      for (const fine of ['OTST_SALE_1ADT_1LEG', 'a {single} brace', '} {', 'x"\ny', 'é 🚆', ' ']) {
        expect(refusedScenarioCode(fine)).toBeNull();
      }
      for (const template of [OPEN, `a${OPEN}b`, `${OPEN}x${CLOSE}`, `${CLOSE}${OPEN}`]) {
        expect(refusedScenarioCode(template)).toMatch(/replace with the value of a variable/);
      }
      for (const notText of [0, 42, false, true, [], ['A'], {}, { toString: 1 }, Object.create(null), Symbol('s'), 10n, () => 'A']) {
        expect(refusedScenarioCode(notText)).toMatch(/not text/);
      }
    });
  });

  // ── NEW-10: the text of the datafile, not only the scenario's code ──────────
  // Before every run the collection hands the WHOLE datafile to Bruno, which
  // fills in every double-brace template in it; it then copies the scenario
  // being run into the variables requests are built from. A template naming the
  // run's token, typed into any scenario of the company, showed the token of
  // whoever ran anything (checked with Bruno CLI 4.2.1). The rule itself is
  // tested in datafile-templates.test.js; here, what the runner does with it.
  describe('a run is not started while the datafile holds a template (NEW-10)', () => {
    const OPEN = '{'.repeat(2);
    const CLOSE = '}'.repeat(2);
    const TOKEN = `${OPEN}process.env.OSCAR_ACCESS_TOKEN${CLOSE}`;
    const CODE = 'OTST_SALE_1ADT_1LEG';

    // Runs to the end whatever the runner decides: if it went on to spawn, the
    // fake children end at once, so a missing refusal fails on its assertions.
    // `datafile` may be a function of the runner's email, for a file that
    // holds a scenario private to the person running.
    async function attempt(datafile, { role = 'test_manager', scenarioOverride = CODE } = {}) {
      const { companyId, userId } = seedCompanyUser({ role });
      const email = get('SELECT email FROM users WHERE id = ?', [userId]).email;
      const file = useDatafile(companyId, typeof datafile === 'function' ? datafile(email) : datafile);
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-secret-123');
      spawn.mockImplementation(() => {
        const proc = makeFakeProc();
        setImmediate(() => proc.emit('close', 0));
        return proc;
      });
      const envFilesBefore = fs.readdirSync(ENVS_DIR);
      let result;
      let thrown = null;
      try { result = await executeRun({ runId, companyId, userId, scenarioOverride }); } catch (e) { thrown = e; }
      const out = {
        result, thrown, runId, file,
        started: spawn.mock.calls.length,
        tokenAsked: resolveAccessToken.mock.calls.length,
        envFilesAdded: fs.readdirSync(ENVS_DIR).filter(f => !envFilesBefore.includes(f)),
        row: getRunRow(runId),
        events: getDecryptedEvents(runId),
      };
      spawn.mockReset();
      resolveAccessToken.mockReset();
      return out;
    }

    function expectRefused(out, where) {
      expect(out.thrown).toBeNull();
      expect(out.result.exitCode).toBe(1);
      expect(out.result.error).toContain('was not started');
      expect(out.result.error).toContain(where);
      expect(out.result.error).not.toContain('OSCAR_ACCESS_TOKEN');   // says where, never repeats the text
      expect(out.row.status).toBe('FAILED');
      expect(out.row.error_message).toBe(out.result.error);
      expect(out.started).toBe(0);
      expect(out.tokenAsked).toBe(0);
      expect(out.envFilesAdded).toEqual([]);
      expect(out.events.some(e => e.level === 'error' && e.message.includes(where))).toBe(true);
      expect(JSON.stringify(out.events)).not.toContain('tok-secret-123');
    }

    function expectStarted(out) {
      expect(out.thrown).toBeNull();
      expect(out.result.exitCode).toBe(0);
      expect(out.started).toBeGreaterThan(0);
      expect(out.tokenAsked).toBe(1);
    }

    test('a clean datafile: the run starts', async () => {
      expectStarted(await attempt(datafileFor(CODE)));
    });

    // #785: the version goes in every request's Content-Type.
    test('an OSDM version that is not one: refused before any token, saying where to correct it', async () => {
      const df = datafileFor(CODE);
      df.scenarios[0].osdmVersion = '3..0.5';
      const out = await attempt(df);
      expect(out.result.error).toContain('The OSDM version "3..0.5" is not a version');
      expect(out.result.error).toContain('Correct it in the scenario');
      expect([out.row.status, out.started, out.tokenAsked]).toEqual(['FAILED', 0, 0]);
      df.scenarios[0].osdmVersion = '3.0.5';
      expectStarted(await attempt(df));
    });

    test('in the scenario being run', async () => {
      const df = datafileFor(CODE);
      df.scenarios[0].label = `Paris ${TOKEN}`;
      expectRefused(await attempt(df), `scenario "${CODE}": label`);
    });

    test.each([
      ['a passenger', df => { df.passengersList[0].passengers[0].firstName = TOKEN; }, 'passengersList, entry 1: passengers[0].firstName'],
      ['a trip', df => { df.tripRequirements[0].legs[0].origin = TOKEN; }, 'tripRequirements, entry 1: legs[0].origin'],
      ['a purchaser', df => { df.purchaserList[1].purchaser[0].firstName = TOKEN; }, 'purchaserList, entry 2: purchaser[0].firstName'],
      ['an entry no scenario uses', df => { df.passengersList.push({ id: 99, passengers: [{ firstName: TOKEN }] }); }, 'passengersList, entry 3: passengers[0].firstName'],
      ['the name of a field', df => { df.scenarios[0][`${OPEN}k`] = 'v'; }, '(the name of the field)'],
      ['a root key a tester may set on a first save', df => { df.osdmVersion = TOKEN; }, 'osdmVersion: (the value itself)'],
    ])('in %s', async (_what, plant, where) => {
      const df = datafileFor(CODE);
      plant(df);
      expectRefused(await attempt(df), where);
    });

    // The schema check reads the whole file back through Bruno and prints the
    // value of a field that is not on its list of allowed values: a template in
    // SOMEONE ELSE'S scenario showed the token of the person running this one.
    test('in another scenario: refused too, and a Test Manager is told which', async () => {
      const df = datafileFor(CODE);
      df.scenarios[1].scenarioType = TOKEN;
      expectRefused(await attempt(df), 'scenario "SOMEONE_ELSES": scenarioType');
    });

    test('in someone else\'s private scenario, run by a tester: refused, and told nothing about it', async () => {
      const df = datafileFor(CODE);
      df.scenarios[1].created_by = 'someone.else@runner-test.com';   // private to another tester
      df.scenarios[1].scenarioType = TOKEN;
      df.tripRequirements[1].secretField = TOKEN;                    // an entry only that scenario uses
      const out = await attempt(df, { role: 'company_user' });
      expectRefused(out, 'a part of the data file that you cannot see');
      for (const hidden of ['SOMEONE_ELSES', 'scenarioType', 'secretField', 'tripRequirements', 'entry', 'Where:']) {
        expect(out.result.error).not.toContain(hidden);
        expect(JSON.stringify(out.events)).not.toContain(hidden);
      }
    });

    test('the same file, run by the Test Manager: both places are named', async () => {
      const df = datafileFor(CODE);
      df.scenarios[1].created_by = 'someone.else@runner-test.com';
      df.scenarios[1].scenarioType = TOKEN;
      df.tripRequirements[1].secretField = TOKEN;
      const out = await attempt(df);
      expectRefused(out, 'scenario "SOMEONE_ELSES": scenarioType');
      expect(out.result.error).toContain('tripRequirements, entry 2: secretField');
      expect(out.result.error).not.toContain('cannot see');
    });

    test('a tester is told the code of the scenario they are running', async () => {
      const df = datafileFor(CODE);
      df.scenarios[0].label = TOKEN;
      expectRefused(await attempt(df, { role: 'company_user' }), `scenario "${CODE}": label`);
    });

    test('a tester is told the place in a private scenario of their own, and in the entries it uses', async () => {
      const out = await attempt((email) => {
        const df = datafileFor(CODE);
        df.scenarios[0].created_by = email;                          // private to the person running
        df.scenarios[0].label = TOKEN;
        df.passengersList[0].passengers[0].firstName = TOKEN;
        return df;
      }, { role: 'company_user' });
      expectRefused(out, `scenario "${CODE}": label`);
      expect(out.result.error).toContain('passengersList, entry 1: passengers[0].firstName');
      expect(out.result.error).not.toContain('cannot see');
    });

    test('a run that names no scenario is looked at as well', async () => {
      const df = datafileFor(CODE);
      df.scenarios[1].label = TOKEN;
      const out = await attempt(df, { scenarioOverride: undefined });
      expectRefused(out, 'scenario "SOMEONE_ELSES": label');
    });

    test('the two root keys only a Test Manager writes do not stop a run', async () => {
      const df = datafileFor(CODE);
      df.systemInfoParameters = { note: TOKEN };
      df.knownDeviations = [{ step: 'x', expectedStatus: 400, note: TOKEN }];
      expectStarted(await attempt(df));
    });

    test('single braces do not stop a run', async () => {
      const df = datafileFor(CODE);
      df.scenarios[0].label = 'a {single} brace, } and {';
      df.passengersList[0].passengers[0].firstName = '{';
      df.passengersList[0].passengers[0].lastName = '{x}';
      expectStarted(await attempt(df));
    });

    test('an encrypted datafile, as stored in production, is read the same way', async () => {
      const { encryptBuffer } = require('../../src/utils/at-rest');
      const df = datafileFor(CODE);
      df.passengersList[0].passengers[0].firstName = TOKEN;
      const stored = encryptBuffer(Buffer.from(JSON.stringify(df), 'utf8'));
      expect(stored.toString('latin1')).not.toContain('firstName');        // it really is the envelope
      expectRefused(await attempt(stored), 'passengersList, entry 1: passengers[0].firstName');
    });

    test('10,000 templates in one datafile: refused at once, three places named', async () => {
      const df = datafileFor(CODE);
      df.scenarios[0].many = Array.from({ length: 10000 }, () => TOKEN);
      const began = Date.now();
      const out = await attempt(df);
      expect(Date.now() - began).toBeLessThan(5000);
      expectRefused(out, `scenario "${CODE}": many[0]`);
      expect(out.result.error).toContain('and many more');
      expect(out.result.error.length).toBeLessThan(700);
    });

    // A Test Manager's save can store a null among the scenarios. Working out
    // what a tester sees threw on it, and a run whose executeRun throws is never
    // marked as failed.
    test('a null among the scenarios: a tester\'s run starts when the file is clean, and is refused when it is not', async () => {
      const clean = datafileFor(CODE);
      clean.scenarios.push(null);
      expectStarted(await attempt(clean, { role: 'company_user' }));

      const holds = email => {
        const df = datafileFor(CODE);
        df.scenarios[0].created_by = email;
        df.scenarios[0].label = TOKEN;
        df.scenarios.push(null);
        return df;
      };
      expectRefused(await attempt(holds, { role: 'company_user' }), `scenario "${CODE}": label`);
    });

    test('a datafile that cannot be read: the run is refused, not started unchecked', async () => {
      const out = await attempt('this is not JSON');
      expect(out.thrown).toBeNull();
      expect(out.result.exitCode).toBe(1);
      expect(out.result.error).toMatch(/data file could not be read/i);
      expect(out.row.status).toBe('FAILED');
      expect(out.started).toBe(0);
      expect(out.tokenAsked).toBe(0);
    });

    test('whatever goes wrong while the file is checked ends as a refusal, never as a thrown error', async () => {
      viewForTester.mockImplementationOnce(() => { throw new Error('something nobody thought of'); });
      const out = await attempt(datafileFor(CODE), { role: 'company_user' });
      expect(viewForTester).toHaveBeenCalled();
      expect(out.thrown).toBeNull();
      expect(out.result.exitCode).toBe(1);
      expect(out.result.error).toMatch(/data file could not be read/i);
      expect(out.result.error).not.toContain('nobody thought of');
      expect(out.row.status).toBe('FAILED');
      expect(out.started).toBe(0);
      expect(out.tokenAsked).toBe(0);
    });

    test('no datafile at all is left to the step that already reports it', async () => {
      const { companyId, userId } = seedCompanyUser();
      run('UPDATE companies SET datafile_path = ? WHERE id = ?', ['/does/not/exist.json', companyId]);
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-abc');
      const result = await executeRun({ runId, companyId, userId, scenarioOverride: CODE });
      expect(result.error).toMatch(/No data file/i);
      expect(spawn).not.toHaveBeenCalled();
      resolveAccessToken.mockReset();
    });
  });
});

// #956: what a run is made with, for the coverage report's "to run again".
describe('executeRun — records its versions and the scenario it ran (#956)', () => {
  test('the server version, the collection version read now and the scenario hash', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-versions');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId, scenarioOverride: 'SEED_SCENARIO' });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', 0);
    await runPromise;
    const row = getRunRow(runId);
    expect(row.server_version).toBe(require('../../package.json').version);
    expect(row.scenario_hash).toBe(require('../../src/utils/frameworkCoverage').scenarioHash({ code: 'SEED_SCENARIO' }));
    expect(row.collection_version).toBe(require('../../src/utils/versionInfo').currentCollectionVersion());
  });

  test('a scenario the data file does not hold leaves the hash empty and the run going', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-versions-2');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const runPromise = executeRun({ runId, companyId, userId, scenarioOverride: 'NOT_THERE' });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', 0);
    expect((await runPromise).exitCode).toBe(0);
    expect(getRunRow(runId).scenario_hash).toBeNull();
  });
});

// ── #1390: the stages of a run that no test above reaches ─────────────────────
// Each was a line no test ran, found by coverage and by putting one fault at
// a time in runSteps() before it was split by stage.
describe('executeRun — the stages no other test reaches (#1390)', () => {
  const allEvents = (runId) => require('../../src/db/db')
    .all('SELECT level, message, scenario_name FROM run_events WHERE run_id = ? ORDER BY id ASC', [runId])
    .map((r) => ({ level: r.level, message: colDecrypt(r.message), scenario: r.scenario_name }));

  // A run of a company of its own, started, with its fake process.
  async function startedRun({ company = {}, job = {} } = {}) {
    const { companyId, userId } = seedCompanyUser(company);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId, userId, ...job });
    await waitForSpawnCalls(1);
    return { runId, companyId, userId, fakeProc, done };
  }

  test('a run whose id is not an id is not run: nothing is asked for, nothing is started', async () => {
    const { companyId, userId } = seedCompanyUser();
    run(`INSERT INTO runs (id, company_id, user_id, status) VALUES ('not-a-run-id', ?, ?, 'QUEUED')`, [companyId, userId]);
    try {
      await expect(executeRun({ runId: 'not-a-run-id', companyId, userId })).rejects.toThrow('executeRun: invalid runId format');
      expect(resolveAccessToken).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      run(`DELETE FROM run_events WHERE run_id = 'not-a-run-id'`);
      run(`DELETE FROM runs WHERE id = 'not-a-run-id'`);
    }
  });

  test('dedicated headers that cannot be read are left out with a warning, and the run goes on', async () => {
    const { runId, fakeProc, done } = await startedRun({ company: { extraHeaders: colEncrypt('{ not json') } });
    const envFile = fs.readdirSync(ENVS_DIR).find((f) => f.includes(runId.slice(0, 8)));
    const yml = fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8');
    fakeProc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
    expect(getRunRow(runId).status).toBe('COMPLETED');
    expect(allEvents(runId).filter((e) => e.level === 'warn' && e.message.startsWith('[runner] Ignoring malformed company extra_headers: '))).toHaveLength(1);
    // No header is written: the environment file has no dedicated-header variable.
    expect(yml).not.toContain('__extraHeaders');
  });

  test('dedicated headers stored as something else than a list are left out, without a word', async () => {
    const { runId, fakeProc, done } = await startedRun({ company: { extraHeaders: colEncrypt(JSON.stringify({ name: 'X-One', value: 'v' })) } });
    const envFile = fs.readdirSync(ENVS_DIR).find((f) => f.includes(runId.slice(0, 8)));
    const yml = fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8');
    fakeProc.emit('close', 0);
    await done;
    expect(yml).not.toContain('__extraHeaders');
    expect(yml).not.toContain('X-One');
    expect(allEvents(runId).filter((e) => /extra_headers/.test(e.message))).toEqual([]);
  });

  test('a process that cannot be started: the run is FAILED and marked as not a result, its secret withdrawn', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    spawn.mockImplementationOnce(() => { throw new Error('spawn bru ENOENT'); });

    const result = await executeRun({ runId, companyId, userId });

    expect(result).toEqual({ exitCode: 1 });
    const row = getRunRow(runId);
    expect([row.status, row.exit_code, row.error_message]).toEqual(['FAILED', 1, 'RUN_PROCESS_ERROR']);
    const events = allEvents(runId);
    expect(events.filter((e) => e.level === 'error' && e.message === '[runner] Process error: spawn bru ENOENT')).toHaveLength(1);
    expect(events.filter((e) => e.level === 'error' && e.message.includes('The run did not go to its end: its process could not be started'))).toHaveLength(1);
    expect(events.some((e) => e.message === '[runner] Run finished — status=FAILED exit=1')).toBe(true);
    // The secret the process was to have is no longer good, and the run is not one that can be stopped.
    const secret = spawn.mock.calls[0][2].env.OSCAR_RUN_SECRET;
    expect(secret).toEqual(expect.any(String));
    expect(runSecrets.verify(runId, secret)).toBeNull();
    expect(killRun(runId)).toBe(false);
  });

  test('an environment file that cannot be deleted is tried three times, then left, and the run ends as it was', async () => {
    const { runId, fakeProc, done } = await startedRun();
    const realUnlink = fs.promises.unlink;
    const unlink = jest.spyOn(fs.promises, 'unlink').mockImplementation((file) => (
      String(file).endsWith('_Env.yml') ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : realUnlink(file)));
    try {
      fakeProc.emit('close', 0);
      expect((await done).exitCode).toBe(0);
    } finally {
      unlink.mockRestore();
    }
    expect(getRunRow(runId).status).toBe('COMPLETED');
    const messages = allEvents(runId).map((e) => `${e.level}: ${e.message}`);
    const about = messages.filter((m) => /[Ee]nv file/.test(m) && !m.includes('written'));
    expect(about).toEqual([
      'warn: [runner] Env file deletion attempt 1 failed: EBUSY',
      'warn: [runner] Env file deletion attempt 2 failed: EBUSY',
      'warn: [runner] Env file deletion attempt 3 failed: EBUSY',
      'warn: [runner] Failed to delete ephemeral env file after 3 attempts. The file carries no credentials (#306); leftover is cosmetic.',
      'info: [runner] Ephemeral env file DELETION FAILED.',
    ]);
    for (const f of fs.readdirSync(ENVS_DIR).filter((name) => name.includes(runId.slice(0, 8)))) fs.rmSync(path.join(ENVS_DIR, f), { force: true });
  });

  test('an environment file deleted at the second try says so once', async () => {
    const { runId, fakeProc, done } = await startedRun();
    const realUnlink = fs.promises.unlink;
    let refusals = 1;
    const unlink = jest.spyOn(fs.promises, 'unlink').mockImplementation((file) => {
      if (String(file).endsWith('_Env.yml') && refusals > 0) { refusals -= 1; return Promise.reject(Object.assign(new Error('busy'), { code: 'EPERM' })); }
      return realUnlink(file);
    });
    try {
      fakeProc.emit('close', 0);
      await done;
    } finally {
      unlink.mockRestore();
    }
    const about = allEvents(runId).map((e) => `${e.level}: ${e.message}`).filter((m) => /[Ee]nv file/.test(m) && !m.includes('written'));
    expect(about).toEqual([
      'warn: [runner] Env file deletion attempt 1 failed: EPERM',
      'info: [runner] Ephemeral env file deleted.',
    ]);
    expect(fs.readdirSync(ENVS_DIR).filter((name) => name.includes(runId.slice(0, 8)))).toEqual([]);
  });

  test('without a scenario named by the job, the lines of the run carry the scenario of its row; a job\'s scenario comes first', async () => {
    const first = await startedRun();
    // No scenario on the row either: the lines carry none.
    first.fakeProc.stdout.emit('data', Buffer.from('a line of the run\n'));
    first.fakeProc.emit('close', 0);
    await first.done;
    expect(allEvents(first.runId).find((e) => e.message === 'a line of the run').scenario).toBeNull();

    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    run(`UPDATE runs SET scenario_code = 'ROW_SCENARIO' WHERE id = ?`, [runId]);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId, userId });
    await waitForSpawnCalls(2);
    fakeProc.stdout.emit('data', Buffer.from('a line of the run\n'));
    fakeProc.stderr.emit('data', Buffer.from('a line on the other stream\n'));
    fakeProc.emit('close', 0);
    await done;
    const events = allEvents(runId);
    expect(events.find((e) => e.message === 'a line of the run')).toMatchObject({ level: 'info', scenario: 'ROW_SCENARIO' });
    expect(events.find((e) => e.message === 'a line on the other stream')).toMatchObject({ level: 'error', scenario: 'ROW_SCENARIO' });
  });

  test('a wait asked beyond the server\'s longest run is cut to it, and said', async () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'runner-1390-'));
    const datafile = path.join(dir, 'datafile.json');
    fs.writeFileSync(datafile, JSON.stringify({ scenariosToRun: 'ALL', scenarios: [{ code: 'LONG_WAIT', expiredOfferTest: true, expiredOfferMaxWaitMinutes: 60 }] }));
    try {
      const { companyId, userId } = seedCompanyUser();
      run('UPDATE companies SET datafile_path = ? WHERE id = ?', [datafile, companyId]);
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-1390');
      const fakeProc = makeFakeProc();
      spawn.mockReturnValueOnce(fakeProc);
      const done = executeRun({ runId, companyId, userId, scenarioOverride: 'LONG_WAIT' });
      await waitForSpawnCalls(1);
      fakeProc.emit('close', 0);
      await done;
      const events = allEvents(runId);
      // 60 minutes and one more asked, 30 minutes at most.
      expect(events.filter((e) => e.level === 'info' && e.message.startsWith('[runner] Effective RUN_TIMEOUT_MS = 1800000ms (1800s); base=600000ms hardMax=1800000ms; source: scenario '))).toHaveLength(1);
      expect(events.filter((e) => e.level === 'warn' && e.message.startsWith('[runner] expired-flow per-scenario max-wait requested 3660000ms but RUN_HARD_MAX_TIMEOUT_MS clamps to 1800000ms.'))).toHaveLength(1);
      expect(events.filter((e) => /computeEffectiveRunTimeoutMs hit an error/.test(e.message))).toEqual([]);
      // One expiry test armed: the run is not stopped for its silence.
      expect(events.filter((e) => e.message.startsWith('[runner] No stop on silence for this run: 1 expiry test(s) armed'))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a run with no wait asked says its time limit and nothing more about it', async () => {
    const { runId, fakeProc, done } = await startedRun();
    fakeProc.emit('close', 0);
    await done;
    const events = allEvents(runId);
    expect(events.filter((e) => e.message.startsWith('[runner] Effective RUN_TIMEOUT_MS = 600000ms (600s); base=600000ms hardMax=1800000ms; source: RUN_TIMEOUT_MS (no in-scope scenario requested an extension'))).toHaveLength(1);
    expect(events.filter((e) => /clamps to|hit an error|No stop on silence/.test(e.message))).toEqual([]);
  });

  test('the results are stored through the three measures the run gives, and their count is said', async () => {
    const observed = jest.spyOn(stepMetrics.runResultsBytes, 'observe');
    let given = null;
    extractSpy.mockImplementation(async (runId, companyId, measures) => {
      given = {
        runId,
        companyId,
        read: measures.timeRead(() => 'what the read gave'),
        slice: measures.timeSlice(() => 'what the slice gave'),
      };
      measures.onFileRead(4321);
      return { suites: 2, requests: 5, assertions: 7 };
    });
    const { runId, companyId, fakeProc, done } = await startedRun();
    fakeProc.emit('close', 0);
    await done;
    expect(given).toEqual({ runId, companyId, read: 'what the read gave', slice: 'what the slice gave' });
    expect(observed).toHaveBeenCalledWith(4321);
    observed.mockRestore();
    expect(allEvents(runId).filter((e) => e.level === 'info' && e.message === '[runner] Stored 7 assertions across 2 suites and 5 requests.')).toHaveLength(1);
  });

  test('a slice that fails is still counted, and the failure is the store\'s', async () => {
    extractSpy.mockImplementation(async (runId, companyId, measures) => {
      measures.timeSlice(() => { throw new Error('a slice failed'); });
      return { suites: 0, requests: 0, assertions: 0 };
    });
    const { runId, fakeProc, done } = await startedRun();
    fakeProc.emit('close', 0);
    await done;
    expect(allEvents(runId).filter((e) => e.level === 'error' && e.message === '[runner] Failed to store structured results: a slice failed')).toHaveLength(1);
    // Bruno ended well and the checks could not be read: the run stays as Bruno ended it.
    expect(getRunRow(runId).status).toBe('COMPLETED');
  });

  describe('the token kept fresh while the run goes', () => {
    beforeEach(() => { run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '30')`); });
    afterEach(() => { run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '0')`); });

    async function waitForTokenCalls(times) {
      const start = Date.now();
      while (resolveAccessToken.mock.calls.length < times) {
        if (Date.now() - start > 4000) throw new Error(`the token was asked ${resolveAccessToken.mock.calls.length} time(s), not ${times}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    test('an OAuth run asks for its token again at each tick, says what the token source says, and stops asking when it ends', async () => {
      const { companyId, userId } = seedCompanyUser({ authMode: 'oauth2' });
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockImplementation(async (user, logger) => {
        const nth = resolveAccessToken.mock.calls.length;
        if (nth === 2) { logger.info('the cached token is still good'); logger.error('a word of error'); }
        if (nth === 3) throw new Error('the token source is away');
        return 'tok-oauth';
      });
      const fakeProc = makeFakeProc();
      spawn.mockReturnValueOnce(fakeProc);
      const done = executeRun({ runId, companyId, userId });
      await waitForSpawnCalls(1);
      await waitForTokenCalls(4);
      fakeProc.emit('close', 0);
      await done;
      const asked = resolveAccessToken.mock.calls.length;
      await new Promise((r) => setTimeout(r, 120));
      expect(resolveAccessToken.mock.calls.length).toBe(asked);

      // A tick asks with the run's user and no forced refresh.
      expect(resolveAccessToken.mock.calls[1]).toHaveLength(2);
      expect(resolveAccessToken.mock.calls[1][0]).toBe(resolveAccessToken.mock.calls[0][0]);
      const events = allEvents(runId);
      expect(events.filter((e) => e.level === 'info' && e.message === '[runner] Token watchdog armed (tick every 30ms = 0s). Disable with TOKEN_WATCHDOG_INTERVAL_MS=0.')).toHaveLength(1);
      expect(events.filter((e) => e.level === 'info' && e.message === '[token-watchdog] the cached token is still good')).toHaveLength(1);
      expect(events.filter((e) => e.level === 'error' && e.message === '[token-watchdog] a word of error')).toHaveLength(1);
      expect(events.filter((e) => e.level === 'warn' && e.message === `[token-watchdog] tick failed: the token source is away — Bruno can still get a fresh token via /v1/runs/${runId}/refresh-access-token at scenario start.`)).toHaveLength(1);
      expect(getRunRow(runId).status).toBe('COMPLETED');
    });

    test('a run with a static token has no watchdog', async () => {
      const { runId, fakeProc, done } = await startedRun();
      await new Promise((r) => setTimeout(r, 100));
      fakeProc.emit('close', 0);
      await done;
      expect(resolveAccessToken).toHaveBeenCalledTimes(1);
      expect(allEvents(runId).filter((e) => /Token watchdog armed/.test(e.message))).toEqual([]);
    });
  });

  describe('RUN_ISOLATION=isolated', () => {
    const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_WORKSPACES_DIR'];
    const saved = {};
    beforeEach(() => {
      for (const k of keys) saved[k] = process.env[k];
      process.env.RUN_ISOLATION = 'isolated';
      process.env.RUN_AGENT_TOKEN = 't'.repeat(40);
      process.env.RUN_WORKSPACES_DIR = path.resolve(__dirname, '../../data/workspaces');
    });
    afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

    test('a working folder that cannot be made: the run is FAILED with the reason, and nothing is started', async () => {
      const { WORKSPACES_DIR } = require('../../src/worker/runner');
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-1390');
      const realRealpath = fs.promises.realpath;
      const realpath = jest.spyOn(fs.promises, 'realpath').mockImplementation((p, ...rest) => (
        path.resolve(String(p)) === path.resolve(WORKSPACES_DIR) ? Promise.reject(new Error('the folders are away')) : realRealpath(p, ...rest)));
      let result;
      try {
        result = await executeRun({ runId, companyId, userId });
      } finally {
        realpath.mockRestore();
      }
      const reason = "The run's working folder could not be made: the folders are away";
      expect(result).toEqual({ exitCode: 1, error: reason });
      const row = getRunRow(runId);
      expect([row.status, row.error_message, row.exit_code]).toEqual(['FAILED', reason, null]);
      expect(allEvents(runId).filter((e) => e.level === 'error' && e.message === `[runner] ${reason}`)).toHaveLength(1);
      expect(RemoteProcess).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(WORKSPACES_DIR, runId))).toBe(false);
    });
  });
});

// ── #1390: what a run leaves behind when it ends, and what it is started with ──
// Found by putting one fault at a time in the stages of a run: each of these
// held no test.
describe('executeRun — the ends of a run and what it is started with (#1390)', () => {
  const { flushRunLogs } = require('../../src/worker/runLog');
  const setConfig = (key, value) => run(`INSERT INTO server_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
  const clearConfig = (...keys) => keys.forEach((k) => run('DELETE FROM server_config WHERE key = ?', [k]));
  const allEvents = (runId) => {
    flushRunLogs();
    return require('../../src/db/db')
      .all('SELECT level, message, scenario_name FROM run_events WHERE run_id = ? ORDER BY id ASC', [runId])
      .map((r) => ({ level: r.level, message: colDecrypt(r.message), scenario: r.scenario_name }));
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function startedRun({ company = {}, job = {} } = {}) {
    const { companyId, userId } = seedCompanyUser(company);
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId, userId, ...job });
    await waitForSpawnCalls(1);
    return { runId, companyId, userId, fakeProc, done };
  }

  test('a job that names no user runs as the user of its run', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId });
    await waitForSpawnCalls(1);
    fakeProc.emit('close', 0);
    expect((await done).exitCode).toBe(0);
    const email = get('SELECT email FROM users WHERE id = ?', [userId]).email;
    expect(resolveAccessToken.mock.calls[0][0].email).toBe(email);
    expect(allEvents(runId)[0].message).toBe(`[runner] Run started — company=${get('SELECT slug FROM companies WHERE id = ?', [companyId]).slug} user=${email} auth_mode=bearer`);
  });

  test('a run without its company, and a company without the run, are both an error', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    await expect(executeRun({ runId, companyId: uuidv4(), userId })).rejects.toThrow('Run or company not found in DB.');
    await expect(executeRun({ runId: uuidv4(), companyId, userId })).rejects.toThrow('Run or company not found in DB.');
    expect(getRunRow(runId).status).toBe('QUEUED');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('the tester\'s requestor is written in the environment file; without one, none is', async () => {
    const { encrypt } = require('../../src/db/db');
    const { readEnvYml, valueIn } = require('../helpers/env-yml');
    const ymlOf = async (requestor) => {
      const { companyId, userId } = seedCompanyUser();
      if (requestor) run('UPDATE tester_credentials SET requestor_enc = ? WHERE user_id = ? AND company_id = ?', [encrypt(requestor), userId, companyId]);
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-1390');
      const fakeProc = makeFakeProc();
      spawn.mockReturnValueOnce(fakeProc);
      const done = executeRun({ runId, companyId, userId });
      await waitForSpawnCalls(spawn.mock.calls.length + 1);
      const envFile = fs.readdirSync(ENVS_DIR).find((f) => f.includes(runId.slice(0, 8)));
      const text = fs.readFileSync(path.join(ENVS_DIR, envFile), 'utf8');
      fakeProc.emit('close', 0);
      await done;
      return text;
    };
    expect(valueIn(readEnvYml(await ymlOf('the-requestor-1390')), 'requestor')).toBe('the-requestor-1390');
    expect(await ymlOf(null)).not.toContain('requestor');
  });

  test('the folders of the environment files and of the reports are made when they are not there', async () => {
    fs.rmSync(ENVS_DIR, { recursive: true, force: true });
    fs.rmSync(VAL_DIR, { recursive: true, force: true });
    try {
      const { runId, fakeProc, done } = await startedRun();
      const written = fs.readdirSync(ENVS_DIR).filter((f) => f.includes(runId.slice(0, 8)));
      expect(written).toHaveLength(1);
      expect(fs.existsSync(VAL_DIR)).toBe(true);
      // The environment file is its owner's to read and write, no one else's (Windows keeps no such mode).
      if (process.platform !== 'win32') expect(fs.statSync(path.join(ENVS_DIR, written[0])).mode % 512).toBe(384);
      fakeProc.emit('close', 0);
      expect((await done).exitCode).toBe(0);
    } finally {
      fs.mkdirSync(ENVS_DIR, { recursive: true });
      fs.mkdirSync(VAL_DIR, { recursive: true });
    }
  });

  test('the lines of a run carry the scenario its job names, before the one of its row', async () => {
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    run(`UPDATE runs SET scenario_code = 'ROW_SCENARIO' WHERE id = ?`, [runId]);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    const fakeProc = makeFakeProc();
    spawn.mockReturnValueOnce(fakeProc);
    const done = executeRun({ runId, companyId, userId, scenarioOverride: 'SEED_SCENARIO' });
    await waitForSpawnCalls(1);
    fakeProc.stdout.emit('data', Buffer.from('a line of the run\n'));
    fakeProc.emit('close', 0);
    await done;
    expect(allEvents(runId).find((e) => e.message === 'a line of the run').scenario).toBe('SEED_SCENARIO');
  });

  describe('once the process has ended', () => {
    afterEach(() => clearConfig('RUN_TIMEOUT_MS', 'RUN_IDLE_TIMEOUT_MS'));

    test('by itself: the run cannot be stopped any more, and its time limit and its silence no longer count', async () => {
      setConfig('RUN_TIMEOUT_MS', '300');
      setConfig('RUN_IDLE_TIMEOUT_MS', '200');
      const { runId, fakeProc, done } = await startedRun();
      fakeProc.emit('close', 0);
      expect((await done).exitCode).toBe(0);
      expect(killRun(runId)).toBe(false);
      await sleep(700);
      expect(fakeProc.kill).not.toHaveBeenCalled();
      expect(allEvents(runId).filter((e) => /Run timed out|No output from Bruno/.test(e.message))).toEqual([]);
      expect(getRunRow(runId).status).toBe('COMPLETED');
    });

    test('lost (an error of the process): the same, and its secret is withdrawn', async () => {
      setConfig('RUN_TIMEOUT_MS', '300');
      setConfig('RUN_IDLE_TIMEOUT_MS', '200');
      const { runId, fakeProc, done } = await startedRun();
      const secret = spawn.mock.calls[0][2].env.OSCAR_RUN_SECRET;
      expect(runSecrets.verify(runId, secret)).toEqual(expect.any(String));
      fakeProc.emit('error', new Error('the process was lost'));
      expect((await done).exitCode).toBe(1);
      expect(runSecrets.verify(runId, secret)).toBeNull();
      expect(killRun(runId)).toBe(false);
      await sleep(700);
      expect(fakeProc.kill).not.toHaveBeenCalled();
      const events = allEvents(runId);
      expect(events.filter((e) => /Run timed out|No output from Bruno/.test(e.message))).toEqual([]);
      expect(events.filter((e) => e.level === 'error' && e.message === '[runner] Process error: the process was lost')).toHaveLength(1);
      expect(getRunRow(runId).error_message).toBe('RUN_PROCESS_ERROR');
    });

    test('a process that ends without an exit code is a failed run, exit 1', async () => {
      const { runId, fakeProc, done } = await startedRun();
      fakeProc.emit('close', null);
      expect(await done).toEqual({ exitCode: 1 });
      const row = getRunRow(runId);
      expect([row.status, row.exit_code]).toEqual(['FAILED', 1]);
    });

    test('a silent run is stopped once, not at every look', async () => {
      setConfig('RUN_IDLE_TIMEOUT_MS', '80');
      const { runId, fakeProc, done } = await startedRun();
      await waitForKillCall(fakeProc);
      // The process is slow to die: several looks go by before it ends.
      await sleep(300);
      expect(fakeProc.kill).toHaveBeenCalledTimes(1);
      fakeProc.emit('close', 143);
      await done;
      expect(allEvents(runId).filter((e) => /No output from Bruno for \d+s: run stopped/.test(e.message))).toHaveLength(1);
    });
  });

  describe('an OAuth run and its token', () => {
    afterEach(() => { run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '0')`); });

    test('a lost process ends the asking for a token too', async () => {
      run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '30')`);
      const { companyId, userId } = seedCompanyUser({ authMode: 'oauth2' });
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValue('tok-oauth');
      const fakeProc = makeFakeProc();
      spawn.mockReturnValueOnce(fakeProc);
      const done = executeRun({ runId, companyId, userId });
      await waitForSpawnCalls(1);
      const start = Date.now();
      while (resolveAccessToken.mock.calls.length < 3 && Date.now() - start < 4000) await sleep(5);
      fakeProc.emit('error', new Error('the process was lost'));
      await done;
      const asked = resolveAccessToken.mock.calls.length;
      expect(asked).toBeGreaterThanOrEqual(3);
      await sleep(150);
      expect(resolveAccessToken.mock.calls.length).toBe(asked);
    });

    test('the tick of the watchdog is said in seconds, rounded', async () => {
      run(`INSERT OR REPLACE INTO server_config (key, value) VALUES ('TOKEN_WATCHDOG_INTERVAL_MS', '1500')`);
      const { companyId, userId } = seedCompanyUser({ authMode: 'oauth2' });
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValue('tok-oauth');
      const fakeProc = makeFakeProc();
      spawn.mockReturnValueOnce(fakeProc);
      const done = executeRun({ runId, companyId, userId });
      await waitForSpawnCalls(1);
      fakeProc.emit('close', 0);
      await done;
      expect(allEvents(runId).filter((e) => e.message === '[runner] Token watchdog armed (tick every 1500ms = 2s). Disable with TOKEN_WATCHDOG_INTERVAL_MS=0.')).toHaveLength(1);
      expect(resolveAccessToken).toHaveBeenCalledTimes(1);
    });
  });

  test('an environment file that will not go is tried again after half a second, twice', async () => {
    const { fakeProc, done, runId } = await startedRun();
    const realUnlink = fs.promises.unlink;
    const unlink = jest.spyOn(fs.promises, 'unlink').mockImplementation((file) => (
      String(file).endsWith('_Env.yml') ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : realUnlink(file)));
    const timers = jest.spyOn(global, 'setTimeout');
    let waits;
    try {
      fakeProc.emit('close', 0);
      await done;
      waits = timers.mock.calls.filter((call) => call[1] === 500).length;
    } finally {
      timers.mockRestore();
      unlink.mockRestore();
    }
    expect(waits).toBe(2);
    for (const f of fs.readdirSync(ENVS_DIR).filter((name) => name.includes(runId.slice(0, 8)))) fs.rmSync(path.join(ENVS_DIR, f), { force: true });
  });

  describe('the measures of the results\' storing', () => {
    // Each clock the run asks for, with what was done to it.
    function watchedClocks() {
      const clocks = {};
      const spy = jest.spyOn(stepMetrics, 'runWorkClock').mockImplementation((kind) => {
        clocks[kind] = { timed: 0, done: 0 };
        return { time: (fn) => { clocks[kind].timed += 1; return fn(); }, done: () => { clocks[kind].done += 1; } };
      });
      return { clocks, restore: () => spy.mockRestore() };
    }

    test('a file read and two slices: both clocks are closed once, each slice\'s own time is observed', async () => {
      const watched = watchedClocks();
      const slices = jest.spyOn(stepMetrics.resultsSliceSeconds, 'observe');
      extractSpy.mockImplementation(async (runId, companyId, measures) => {
        measures.timeRead(() => 1);
        measures.onFileRead(10);
        measures.timeSlice(() => 2);
        measures.timeSlice(() => 3);
        return { suites: 1, requests: 1, assertions: 1 };
      });
      try {
        const { fakeProc, done } = await startedRun();
        fakeProc.emit('close', 0);
        await done;
        expect(watched.clocks).toEqual({ results_read: { timed: 1, done: 1 }, results_store: { timed: 2, done: 1 } });
        expect(slices).toHaveBeenCalledTimes(2);
        for (const call of slices.mock.calls) {
          expect(call[0]).toBeGreaterThanOrEqual(0);
          expect(call[0]).toBeLessThan(5);
        }
      } finally {
        slices.mockRestore();
        watched.restore();
      }
    });

    test('no file read: the read\'s clock is left open, the store\'s is closed, even when the storing fails', async () => {
      const watched = watchedClocks();
      extractSpy.mockImplementation(async () => { throw new Error('nothing to read'); });
      try {
        const { fakeProc, done } = await startedRun();
        fakeProc.emit('close', 0);
        await done;
        expect(watched.clocks).toEqual({ results_read: { timed: 0, done: 0 }, results_store: { timed: 0, done: 1 } });
      } finally {
        watched.restore();
      }
    });
  });

  describe('RUN_ISOLATION=isolated', () => {
    const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_WORKSPACES_DIR'];
    const saved = {};
    beforeEach(() => {
      for (const k of keys) saved[k] = process.env[k];
      process.env.RUN_ISOLATION = 'isolated';
      process.env.RUN_AGENT_TOKEN = 't'.repeat(40);
      process.env.RUN_WORKSPACES_DIR = path.resolve(__dirname, '../../data/workspaces');
    });
    afterEach(() => {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      RemoteProcess.mockReset();
    });

    test('a run that ends leaves no working folder', async () => {
      const { WORKSPACES_DIR } = require('../../src/worker/runner');
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-1390');
      const calls = [];
      RemoteProcess.mockImplementation(function FakeRemote(agent, request) {
        const proc = makeFakeProc();
        calls.push({ request, proc });
        return proc;
      });
      const done = executeRun({ runId, companyId, userId });
      const start = Date.now();
      while (calls.length === 0 && Date.now() - start < 4000) await sleep(10);
      expect(calls).toHaveLength(1);
      expect(fs.existsSync(path.join(WORKSPACES_DIR, runId, 'environments'))).toBe(true);
      calls[0].proc.emit('close', 0);
      await done;
      expect(fs.existsSync(path.join(WORKSPACES_DIR, runId))).toBe(false);
      expect(allEvents(runId).filter((e) => e.message === '[runner] Workspace cleaned up.')).toHaveLength(1);
    });

    test('a working folder half made is removed when the run is refused', async () => {
      const { WORKSPACES_DIR } = require('../../src/worker/runner');
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-1390');
      const realMkdir = fs.promises.mkdir;
      let made = false;
      // The folder of the run is made; the folder of its environment files is refused, a moment later.
      const mkdir = jest.spyOn(fs.promises, 'mkdir').mockImplementation((dir, ...rest) => {
        if (path.basename(String(dir)) === 'environments' && String(dir).includes(runId)) {
          made = fs.existsSync(path.join(WORKSPACES_DIR, runId));
          return new Promise((resolve, reject) => { setTimeout(() => reject(new Error('no room left')), 60); });
        }
        return realMkdir(dir, ...rest);
      });
      let result;
      try {
        result = await executeRun({ runId, companyId, userId });
      } finally {
        mkdir.mockRestore();
      }
      expect(made).toBe(true);
      expect(result).toEqual({ exitCode: 1, error: "The run's working folder could not be made: no room left" });
      expect(fs.existsSync(path.join(WORKSPACES_DIR, runId))).toBe(false);
      expect(RemoteProcess).not.toHaveBeenCalled();
    });
  });

  describe('RUN_ISOLATION=pod', () => {
    const podMetrics = require('../../src/utils/metrics');
    const refusedPods = async () => (await podMetrics.runPodsEnded.get()).values.find((v) => v.labels.outcome === 'refused')?.value || 0;
    const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_AGENT_HOST', 'RUN_SERVER_URL', 'INTERNAL_PORT', 'JSON_SCHEMA_URL'];
    const saved = {};
    beforeEach(() => {
      for (const k of keys) saved[k] = process.env[k];
      Object.assign(process.env, {
        RUN_ISOLATION: 'pod', RUN_AGENT_TOKEN: 't'.repeat(40), RUN_AGENT_HOST: 'oscar-dispatcher',
        RUN_SERVER_URL: 'http://oscar-internal:3003', INTERNAL_PORT: '3003',
      });
      delete process.env.JSON_SCHEMA_URL;
    });
    afterEach(() => {
      for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      RemoteProcess.mockReset();
      clearConfig('RUN_TIMEOUT_MS');
    });

    async function podRequest(change = () => {}) {
      const { companyId, userId } = seedCompanyUser();
      change(companyId);
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-pod');
      const calls = [];
      RemoteProcess.mockImplementation(function FakeRemote(agent, request) {
        const proc = makeFakeProc();
        calls.push({ request, proc });
        return proc;
      });
      const done = executeRun({ runId, companyId, userId, scenarioOverride: 'SEED_SCENARIO' });
      const start = Date.now();
      while (calls.length === 0 && Date.now() - start < 4000) await sleep(10);
      expect(calls).toHaveLength(1);
      calls[0].proc.emit('close', 0);
      await done;
      return calls[0].request;
    }

    test('the pod\'s deadline is the run\'s time limit in whole seconds, a minute at least', async () => {
      setConfig('RUN_TIMEOUT_MS', '30000');
      expect((await podRequest()).deadlineSeconds).toBe(60);
      setConfig('RUN_TIMEOUT_MS', '90500');
      expect((await podRequest()).deadlineSeconds).toBe(91);
      setConfig('RUN_TIMEOUT_MS', '1700000');
      expect((await podRequest()).deadlineSeconds).toBe(1700);
    });

    test('nothing is made here for a pod run: no folder of environment files, none of reports', async () => {
      fs.rmSync(ENVS_DIR, { recursive: true, force: true });
      fs.rmSync(VAL_DIR, { recursive: true, force: true });
      try {
        await podRequest();
        expect(fs.existsSync(ENVS_DIR)).toBe(false);
        expect(fs.existsSync(VAL_DIR)).toBe(false);
      } finally {
        fs.mkdirSync(ENVS_DIR, { recursive: true });
        fs.mkdirSync(VAL_DIR, { recursive: true });
      }
    });

    test('a run that cannot be handed to the dispatcher is counted as refused, and marked as not a result', async () => {
      const before = await refusedPods();
      const { companyId, userId } = seedCompanyUser();
      const runId = seedRun(companyId, userId);
      resolveAccessToken.mockResolvedValueOnce('tok-pod');
      RemoteProcess.mockImplementation(() => { throw new Error('the dispatcher is away'); });
      const result = await executeRun({ runId, companyId, userId });
      expect(result).toEqual({ exitCode: 1 });
      expect(getRunRow(runId).error_message).toBe('RUN_PROCESS_ERROR');
      expect(allEvents(runId).filter((e) => e.message === '[runner] Process error: the dispatcher is away')).toHaveLength(1);
      expect(await refusedPods()).toBe(before + 1);
    });
  });

  test('a run started here that cannot be started is not counted among the pods refused', async () => {
    const podMetrics = require('../../src/utils/metrics');
    const refusedPods = async () => (await podMetrics.runPodsEnded.get()).values.find((v) => v.labels.outcome === 'refused')?.value || 0;
    const before = await refusedPods();
    const { companyId, userId } = seedCompanyUser();
    const runId = seedRun(companyId, userId);
    resolveAccessToken.mockResolvedValueOnce('tok-1390');
    spawn.mockImplementationOnce(() => { throw new Error('spawn bru ENOENT'); });
    await executeRun({ runId, companyId, userId });
    expect(await refusedPods()).toBe(before);
  });
});
