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

const { run, get, colDecrypt } = require('../../src/db/db');
const { executeRun, killRun } = require('../../src/worker/runner');

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

function seedCompanyUser({ authMode = 'bearer', extraHeaders = null } = {}) {
  const companyId = uuidv4();
  const userId = uuidv4();
  run(
    `INSERT INTO companies (id, name, slug, api_base, datafile_path, extra_headers) VALUES (?, ?, ?, ?, ?, ?)`,
    [companyId, 'Runner Test Co', `runner-test-${companyId.slice(0, 8)}`, 'https://vendor.example/osdm', __filename /* any file that exists, for fsExists() */, extraHeaders]
  );
  run(
    `INSERT INTO users (id, company_id, email, password_hash, role, auth_mode) VALUES (?, ?, ?, 'x', 'test_manager', ?)`,
    [userId, companyId, `runner-${userId.slice(0, 8)}@runner-test.com`, authMode]
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
    const spawnEnv = spawn.mock.calls[0][2].env;
    expect(spawnEnv.OSCAR_ACCESS_TOKEN).toBe('tok-secret-123');
    expect(spawnEnv.OSCAR_SUBSCRIPTION_KEY).toBe('subkey-secret-456');
    expect(spawnEnv.OSCAR_OAUTH_EXTRA).toBe('basic-extra-789');
    // The server's own secret env is still never forwarded (allowlist).
    expect(spawnEnv).not.toHaveProperty('ENCRYPTION_KEY');
    expect(spawnEnv).not.toHaveProperty('JWT_SECRET');

    fakeProc.emit('close', 0);
    await runPromise;
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
    expect(spawnEnv.OSCAR_ACCESS_TOKEN).toBe('tok-abc');
    expect(spawnEnv).not.toHaveProperty('OSCAR_SUBSCRIPTION_KEY');
    expect(spawnEnv).not.toHaveProperty('OSCAR_OAUTH_EXTRA');

    fakeProc.emit('close', 0);
    await runPromise;
  });
});
