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

const path = require('path');
const fs   = require('fs');
const { EventEmitter } = require('events');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('child_process');
const { spawn } = require('child_process');

jest.mock('../../src/worker/access-token');
const { resolveAccessToken } = require('../../src/worker/access-token');

// The real module. viewForTester is wrapped so that one test can make it throw.
jest.mock('../../src/utils/datafileOwnership', () => {
  const real = jest.requireActual('../../src/utils/datafileOwnership');
  return { ...real, viewForTester: jest.fn(real.viewForTester) };
});
const { viewForTester } = require('../../src/utils/datafileOwnership');

const { run, get, colDecrypt } = require('../../src/db/db');
const { executeRun, killRun } = require('../../src/worker/runner');
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

    const writeFileSpy = jest.spyOn(fs.promises, 'writeFile').mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const result = await executeRun({ runId, companyId, userId });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/Failed to write env file/);
    expect(getRunRow(runId).status).toBe('FAILED');
    expect(spawn).not.toHaveBeenCalled();

    writeFileSpy.mockRestore();
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
    run(`UPDATE users SET subscription_key_enc = ?, oauth_extra_enc = ? WHERE id = ?`,
      [encrypt('subkey-secret-456'), encrypt('basic-extra-789'), userId]);
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
  async function runWithReportScript({ scenarioOverride, platform, datafile } = {}) {
    const { encrypt } = require('../../src/db/db');
    const { companyId, userId } = seedCompanyUser();
    if (scenarioOverride !== undefined) useDatafile(companyId, datafile || datafileFor(scenarioOverride));
    run(`UPDATE users SET subscription_key_enc = ?, oauth_extra_enc = ? WHERE id = ?`,
      [encrypt('subkey-secret-456'), encrypt('basic-extra-789'), userId]);
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
      mainProc.emit('close', 0);
      await waitForSpawnCalls(2);
      mergeProc.emit('close', 0);
      await runPromise;
      return { runId, envName, envFile, cwd, bruno: spawn.mock.calls[0], report: spawn.mock.calls[1] };
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
        'runHardDeadlineMs', '__runId', 'oscar_loopback_base',
      ]);
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
      expect(file.variables).toHaveLength(9);
    });

    test('single braces, and a code with no template, still run', async () => {
      for (const code of ['OTST_SALE_1ADT_1LEG', 'with {one} brace pair', 'a } then a {']) {
        const { envFile } = await runWithReportScript({ scenarioOverride: code, platform });
        expect(valueIn(readEnvYml(envFile), 'scenario_override')).toBe(code);
        jest.clearAllMocks();
      }
    });
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
