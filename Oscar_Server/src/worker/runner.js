'use strict';

/**
 * runner.js — Bruno execution worker
 *
 * For each run job this module:
 *  1. Loads and decrypts company credentials from DB
 *  2. Fetches OAuth2 token if auth_mode = 'oauth2'
 *  3. Generates an ephemeral Bruno environment .yml file
 *  4. Spawns bru.cmd via child_process (cwd = collection dir)
 *  5. Streams stdout/stderr to run_events table in real-time
 *  6. Invokes mergeReport.js to produce the HTML report
 *  7. Links produced artifacts to run_artifacts table
 *  8. Updates run status and cleans up temp env file
 */

const path        = require('path');
const fs          = require('fs');
const { spawn }   = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { get, run: dbRun, encrypt, decrypt, getConfig } = require('../db/db');
const log = require('../utils/logger').child({ module: 'runner' });
const { fetchToken } = require('./auth-profiles');

// ── Config ────────────────────────────────────────────────────────────────────
const COLLECTION_PATH = process.env.COLLECTION_PATH || '';
const BRU_CMD         = process.env.BRU_CMD || 'bru.cmd';
const JSON_SCHEMA_URL = process.env.JSON_SCHEMA_URL || '';
const ARTIFACTS_DIR   = path.resolve(__dirname, '../../data/artifacts');
const ENVS_DIR        = path.join(COLLECTION_PATH, 'environments');
const WORKSPACES_DIR  = path.resolve(__dirname, '../../data/workspaces');

// ── Stream backpressure — cap log events per run to prevent OOM/DB bloat ─────
// A pathological Bruno run could emit millions of log lines (e.g. infinite
// loop, runaway debug output). Each line triggers a synchronous DB INSERT.
// We cap per-run lines to a sane maximum and emit one final warning if hit.
const MAX_LOG_LINES_PER_RUN = 50000;
const _runLineCounters = new Map();   // runId → count
function _incrementAndCheck(runId) {
  const n = (_runLineCounters.get(runId) || 0) + 1;
  _runLineCounters.set(runId, n);
  return n;
}
function _resetLineCounter(runId) { _runLineCounters.delete(runId); }

// ── Log helper — writes to run_events with optional structured metadata ───────
function logEvent(runId, level, message, meta) {
  const lineCount = _incrementAndCheck(runId);
  if (lineCount === MAX_LOG_LINES_PER_RUN + 1) {
    // Emit one final warning and then start dropping
    try {
      dbRun(
        `INSERT INTO run_events (run_id, level, message, event_kind) VALUES (?, ?, ?, ?)`,
        [runId, 'warn', `[runner] Log line cap reached (${MAX_LOG_LINES_PER_RUN}). Further events dropped to prevent DB bloat.`, 'log']
      );
    } catch (_) { /* swallow */ }
    return;
  }
  if (lineCount > MAX_LOG_LINES_PER_RUN) return;  // drop silently after cap
  try {
    const {
      category, phase, suite_name, request_name, http_status,
      event_kind, attempt_index, attempt_total, scenario_name,
    } = meta || {};
    dbRun(
      `INSERT INTO run_events (run_id, level, message,
         category, phase, suite_name, request_name, http_status,
         event_kind, attempt_index, attempt_total, scenario_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, level, String(message).slice(0, 4000),
       category || null, phase || null, suite_name || null, request_name || null, http_status || null,
       event_kind || 'log',
       Number.isInteger(attempt_index) ? attempt_index : null,
       Number.isInteger(attempt_total) ? attempt_total : null,
       scenario_name || null]
    );
  } catch (_) { /* never block execution on log errors */ }
}

// ── Log parser — classifies Bruno stdout lines into structured metadata ───────
//
// Also detects scenario boundary milestones and retry attempts so the report
// UI can render explicit section dividers rather than inferring them from the
// message text. Bruno library scripts emit lines like:
//   "⏭  Skipping to next scenario [2/8]: OTST_EXCH_SRCH_CRIT_1ADT_1LEG"
//   "▶  Starting scenario [1/8]: OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG"
//   "⚠  No offers (attempt 2/3) — retrying..."
// We parse these and surface them as event_kind='scenario_*' / 'log' with
// attempt_index/attempt_total/scenario_name populated.
class LogParser {
  constructor() {
    this.currentSuite = null;
    this.currentRequest = null;
    this.currentScenario = null;
    this.attemptIndex = null;
    this.attemptTotal = null;
    this.phase = 'setup';
  }

  parse(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return {};

    let category = 'bruno';
    let httpStatus = null;
    let eventKind = 'log';

    // Scenario boundary detection — check before other patterns since these
    // lines can otherwise be misclassified as generic bruno output.
    // Match shape: "Skipping to next scenario [2/8]: OTST_FOO"
    const skipMatch = trimmed.match(/Skipping to next scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*:\s*([A-Za-z0-9_\-]+)/i);
    const startMatch = !skipMatch && trimmed.match(/(?:Starting|Running)\s+scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*:\s*([A-Za-z0-9_\-]+)/i);
    const endMatch = !skipMatch && !startMatch && trimmed.match(/scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*(?:completed|finished|done)\s*:\s*([A-Za-z0-9_\-]+)/i);
    const attemptMatch = trimmed.match(/\(attempt\s+(\d+)\s*\/\s*(\d+)\)/i);

    if (skipMatch) {
      this.attemptIndex = parseInt(skipMatch[1], 10);
      this.attemptTotal = parseInt(skipMatch[2], 10);
      this.currentScenario = skipMatch[3];
      this.currentSuite = null;
      this.currentRequest = null;
      eventKind = 'scenario_skipped';
      category = 'system';
    } else if (startMatch) {
      this.attemptIndex = parseInt(startMatch[1], 10);
      this.attemptTotal = parseInt(startMatch[2], 10);
      this.currentScenario = startMatch[3];
      this.currentSuite = null;
      this.currentRequest = null;
      this.phase = 'execution';
      eventKind = 'scenario_start';
      category = 'system';
    } else if (endMatch) {
      this.currentScenario = endMatch[3] || this.currentScenario;
      eventKind = 'scenario_end';
      category = 'system';
    } else if (attemptMatch) {
      // Retry marker on a scenario that was started earlier. We stamp the
      // attempt number onto this line AND every subsequent line until the
      // next attempt/scenario change, so the UI can group retries.
      this.attemptIndex = parseInt(attemptMatch[1], 10);
      this.attemptTotal = parseInt(attemptMatch[2], 10);
      eventKind = 'scenario_retry';
      category = 'system';
    }

    // Standard line classification (only if not already classified as milestone)
    if (eventKind === 'log') {
      // Bruno CLI prints request execution lines like:
      //   "01-System Infos Requests\00. GET System Version Check (404 Not Found) - 302 ms"
      const folderReqMatch = trimmed.match(/^([^()\\\/]+)[\\/]([^()]+?)\s+\(([^)]+)\)/);
      if (folderReqMatch) {
        this.currentSuite   = folderReqMatch[1].trim();
        this.currentRequest = folderReqMatch[2].trim();
        this.phase = 'execution';
        category = 'system';
        const httpInParen = folderReqMatch[3].match(/\b([1-5]\d{2})\b/);
        if (httpInParen) httpStatus = parseInt(httpInParen[1], 10);
      } else if (/^Running Folder\s+/i.test(trimmed)) {
        this.currentSuite = trimmed.replace(/^Running Folder\s+/i, '').trim();
        this.currentRequest = null;
        this.phase = 'execution';
        category = 'system';
      } else if (/^Running Request\s+/i.test(trimmed)) {
        this.currentRequest = trimmed.replace(/^Running Request\s+/i, '').trim();
        category = 'system';
      } else if (/^\s*[✓✗]/.test(trimmed) || /^\s*(pass|fail)/i.test(trimmed)) {
        category = 'assertion';
      } else if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+https?:\/\//i.test(trimmed)) {
        category = 'http';
        const m = trimmed.match(/\b([1-5]\d{2})\b/);
        if (m) httpStatus = parseInt(m[1], 10);
      } else if (/^\[runner\]/i.test(trimmed)) {
        category = 'system';
      } else if (/401|token|auth|oauth|login/i.test(trimmed)) {
        category = 'auth';
        const m = trimmed.match(/\b(401)\b/);
        if (m) httpStatus = 401;
      }
    }

    // Phase detection
    if (/mergeReport|reportGenerator|Report written/i.test(trimmed)) {
      this.phase = 'reporting';
    }

    return {
      category,
      phase: this.phase,
      suite_name: this.currentSuite,
      request_name: this.currentRequest,
      http_status: httpStatus,
      event_kind: eventKind,
      attempt_index: this.attemptIndex,
      attempt_total: this.attemptTotal,
      scenario_name: this.currentScenario,
    };
  }
}

// ── Token fetch — pluggable per-vendor profiles (see auth-profiles.js) ──────
// Builds the small `log` adapter that auth-profiles uses to write structured
// events into run_events with the right category/phase. Centralising this
// here keeps logEvent's signature private to runner.js.
function _authLogger(runId) {
  const base = { category: 'auth', phase: 'setup' };
  return {
    info:  (msg, meta) => logEvent(runId, 'info',  msg, { ...base, ...(meta || {}) }),
    error: (msg, meta) => logEvent(runId, 'error', msg, { ...base, ...(meta || {}) })
  };
}

// ── Generate Bruno environment .yml ──────────────────────────────────────────
// IMPORTANT: Do NOT use "secret: true" for any variable here.
// Bruno CLI does not read "value" from secret-flagged entries in .yml files —
// it expects secret values to be stored in a separate encrypted secrets store.
// Since this env file is ephemeral (deleted immediately after the run), there
// is no security risk in writing credentials as plain variables.
function buildEnvYml(envName, apiBase, accessToken, requestor, subscriptionKey, datafileUrl, scenarioOverride, oauthExtra) {
  // Escape backslashes then double-quotes so the token is safe inside a YAML double-quoted scalar.
  // A token with a trailing " (common typo) would otherwise produce invalid YAML and crash Bruno.
  const safeToken = accessToken.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = [
    `name: ${envName}`,
    `variables:`,
    `  - name: access_token`,
    `    value: "${safeToken}"`,
    `  - name: api_base`,
    `    value: "${apiBase}"`,
    `  - name: library_base`,
    `    value: "./library-bruno/"`,
    `  - name: data_base`,
    `    value: "${datafileUrl}"`,
    `  - name: json_schema`,
    `    value: "${JSON_SCHEMA_URL}"`,
    `  - name: scenariosToRunIndex`,
    `    value: "0"`,
  ];
  if (requestor) {
    lines.push(`  - name: requestor`);
    lines.push(`    value: "${requestor}"`);
  }
  if (subscriptionKey) {
    lines.push(`  - name: Ocp-Apim-Subscription-Key`);
    lines.push(`    value: "${subscriptionKey}"`);
  }
  if (oauthExtra) {
    // Sqills (and any other vendor) sometimes layers a Basic auth header on
    // top of the OAuth bearer token for OSDM API calls. The pre-encoded
    // Basic value lives encrypted in users.oauth_extra_enc; we surface it
    // to Bruno here so the request templates can reference it directly.
    // Exposed under both names for collection-template flexibility:
    //   - oauth_extra      (matches OSCAR's schema)
    //   - auth_key_secret  (matches the vendor-supplied Sqills templates)
    const safeExtra = String(oauthExtra).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    lines.push(`  - name: oauth_extra`);
    lines.push(`    value: "${safeExtra}"`);
    lines.push(`  - name: auth_key_secret`);
    lines.push(`    value: "${safeExtra}"`);
  }
  if (scenarioOverride) {
    lines.push(`  - name: scenario_override`);
    lines.push(`    value: "${scenarioOverride}"`);
  }
  return lines.join('\n') + '\n';
}

// ── Run-scoped workspace (Linux only) ────────────────────────────────────────
// Creates an isolated directory for each run. Bruno CLI does not follow
// symlinks, so we copy collection folders into the workspace. Async to avoid
// blocking the EventLoop while copying multi-MB directory trees.
async function createWorkspace(runId) {
  const workspaceDir = path.join(WORKSPACES_DIR, runId);
  await fs.promises.mkdir(workspaceDir, { recursive: true });

  // Real directories for write targets (env file, reports, results)
  await Promise.all([
    fs.promises.mkdir(path.join(workspaceDir, 'environments'), { recursive: true }),
    fs.promises.mkdir(path.join(workspaceDir, 'Validation_Reports'), { recursive: true }),
  ]);

  // Copy collection folders into workspace, in parallel for speed.
  const copyDirs = [
    '00-Access Token', '01-System Infos Requests', '02-Common Requests',
    '03-Refund', '04-Exchange', 'library-bruno', 'data_base'
  ];
  await Promise.all(copyDirs.map(async (item) => {
    const src  = path.join(COLLECTION_PATH, item);
    const dest = path.join(workspaceDir, item);
    if (fs.existsSync(src)) {
      await fs.promises.cp(src, dest, { recursive: true });
    }
  }));

  // Copy collection-level files
  const copyFiles = ['opencollection.yml', '.gitignore'];
  await Promise.all(copyFiles.map(async (file) => {
    const src = path.join(COLLECTION_PATH, file);
    if (fs.existsSync(src)) {
      await fs.promises.copyFile(src, path.join(workspaceDir, file));
    }
  }));

  return workspaceDir;
}

async function cleanupWorkspace(runId) {
  const workspaceDir = path.join(WORKSPACES_DIR, runId);
  try {
    await fs.promises.rm(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    log.error({ runId, err: err.message }, 'Failed to clean workspace');
  }
}

// ── Main execution function ────────────────────────────────────────────────────
async function executeRun({ runId, companyId, userId, scenarioOverride }) {
  // 1. Load run + company + user from DB. The user row carries the OSDM
  //    credentials (auth_mode, OAuth fields, bearer token, token cache) — see
  //    migration v12. The company row keeps api_base + datafile only.
  const runRow     = get('SELECT * FROM runs     WHERE id = ?', [runId]);
  const companyRow = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  // Prefer the userId from the queue job; fall back to the run's recorded
  // user_id (set at POST /v1/runs time) so legacy queue items still resolve.
  const effectiveUserId = userId || (runRow && runRow.user_id) || null;
  const userRow = effectiveUserId ? get('SELECT * FROM users WHERE id = ?', [effectiveUserId]) : null;

  if (!runRow || !companyRow) throw new Error('Run or company not found in DB.');
  if (!userRow)               throw new Error('User row not found for run — cannot resolve credentials.');

  // Mark as RUNNING
  dbRun(
    `UPDATE runs SET status = 'RUNNING', started_at = datetime('now') WHERE id = ?`,
    [runId]
  );
  logEvent(runId, 'info', `[runner] Run started — company=${companyRow.slug} user=${userRow.email} auth_mode=${userRow.auth_mode}`);

  // 2. Prepare artifact directory
  const runArtifactDir = path.join(ARTIFACTS_DIR, runId);
  if (!fs.existsSync(runArtifactDir)) fs.mkdirSync(runArtifactDir, { recursive: true });

  // 3. Resolve access token (per-tester credentials, per-tester token cache)
  let accessToken;
  try {
    if (userRow.auth_mode === 'oauth2') {
      const clientId     = decrypt(userRow.client_id_enc);
      const clientSecret = decrypt(userRow.client_secret_enc);
      const tokenUrl     = userRow.token_url;
      const profile      = userRow.oauth_profile || 'oauth2_basic';

      // Field-level "what's missing" message — operator doesn't have to play
      // guess-which-credential after fixing one and getting the same error.
      const missing = [];
      if (!tokenUrl)     missing.push('token_url');
      if (!clientId)     missing.push('client_id');
      if (!clientSecret) missing.push('client_secret');
      if (profile === 'sqills_extension' && !userRow.oauth_extra_enc) missing.push('extra credential (Basic auth value)');
      if (profile === 'custom' && !userRow.oauth_custom_template)     missing.push('custom request template');
      if (missing.length > 0) {
        throw new Error(`Auth profile "${profile}" is missing: ${missing.join(', ')}. Set ${missing.length > 1 ? 'them' : 'it'} in your profile (Profile → API Configuration).`);
      }

      const log = _authLogger(runId);

      // ── Cache check (per-tester since v12) ──────────────────────────────
      // Reuse a previously-fetched token if it still has at least
      // TOKEN_CACHE_SAFETY_MARGIN_S seconds left. Saves a round-trip to the
      // vendor's auth endpoint for back-to-back scenarios run by the same
      // tester. Cleared on any PATCH that touches that tester's auth config.
      const TOKEN_CACHE_SAFETY_MARGIN_S = 60;
      const now = new Date();
      const expIso = userRow.cached_token_expires_at;
      const cachedExp = expIso ? new Date(expIso) : null;
      const cachedValid = cachedExp && !isNaN(cachedExp) &&
        (cachedExp.getTime() - now.getTime() > TOKEN_CACHE_SAFETY_MARGIN_S * 1000);
      if (cachedValid && userRow.cached_token_enc) {
        const remainingS = Math.floor((cachedExp.getTime() - now.getTime()) / 1000);
        log.info(`[runner] Auth — using cached token (user=${userRow.email}, expires in ${remainingS}s, at ${expIso}).`);
        accessToken = decrypt(userRow.cached_token_enc);
      } else {
        if (cachedExp && !cachedValid) {
          log.info(`[runner] Auth — cached token expired or within safety margin (was: ${expIso}); refetching.`);
        }
        const result = await fetchToken(profile, {
          tokenUrl, clientId, clientSecret,
          scope:          userRow.oauth_scope || '',
          extra:          userRow.oauth_extra_enc ? decrypt(userRow.oauth_extra_enc) : '',
          customTemplate: userRow.oauth_custom_template || ''
        }, log);
        accessToken = result.token;

        // Persist the cache only when the vendor told us how long the token
        // is good for. Anything else risks reusing a token past its real
        // expiry, which would surface as a mid-run 401.
        if (result.expiresIn && result.expiresIn > 0) {
          const newExp = new Date(now.getTime() + result.expiresIn * 1000).toISOString();
          dbRun(
            'UPDATE users SET cached_token_enc = ?, cached_token_expires_at = ? WHERE id = ?',
            [encrypt(accessToken), newExp, userRow.id]
          );
          log.info(`[runner] Auth — token cached until ${newExp}.`);
        } else {
          // Clear any stale cache so we don't accidentally serve an old token.
          dbRun(
            'UPDATE users SET cached_token_enc = NULL, cached_token_expires_at = NULL WHERE id = ?',
            [userRow.id]
          );
        }
      }
    } else {
      accessToken = decrypt(userRow.access_token_enc);
      if (!accessToken) throw new Error('Bearer token not configured. Set it in your profile.');
      logEvent(runId, 'info', '[runner] Bearer token resolved.');
    }
  } catch (err) {
    dbRun(
      `UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`,
      [err.message, runId]
    );
    logEvent(runId, 'error', `[runner] Auth failed: ${err.message}`);
    return { exitCode: 1, error: err.message };
  }

  // 4. Resolve requestor (optional, per-tester since v12)
  const requestor = userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null;

  // 4b. Resolve Ocp-Apim-Subscription-Key (optional — Azure APIM sandboxes, per-tester since v12)
  const subscriptionKey = userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null;

  // 4c. Resolve OAuth "extra" credential — surfaced to Bruno as both
  // oauth_extra and auth_key_secret so collections that layer Basic auth
  // on top of the OAuth bearer (Sqills) can reference it directly. Used
  // only by the Bruno templates; the same value also feeds the
  // sqills_extension token-fetch profile (auth-profiles.js).
  const oauthExtra = userRow.oauth_extra_enc ? decrypt(userRow.oauth_extra_enc) : null;

  // 5. Validate data file exists
  const datafileUrl = `http://localhost:${process.env.PORT || 3001}/data/${companyRow.slug}-datafile.json`;
  const datafilePath = companyRow.datafile_path;
  if (!datafilePath || !fs.existsSync(datafilePath)) {
    const msg = 'No data file uploaded. Upload a data file in your company profile before running.';
    dbRun(`UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`, [msg, runId]);
    logEvent(runId, 'error', `[runner] ${msg}`);
    return { exitCode: 1, error: msg };
  }

  // 5b. Workspace isolation (Linux only — for parallel/concurrent runs)
  // Only create a workspace when scenarioOverride is set (parallel mode).
  // Sequential runs use COLLECTION_PATH directly — Bruno CLI may not follow symlinks.
  const useWorkspace = process.platform !== 'win32' && !!scenarioOverride;
  let workspaceDir = null;
  let runCwd = COLLECTION_PATH;

  if (useWorkspace) {
    workspaceDir = await createWorkspace(runId);
    runCwd = workspaceDir;
    logEvent(runId, 'info', `[runner] Workspace created → ${workspaceDir}`);
  }

  // 6. Generate ephemeral env file
  // Use a per-run unique env name to prevent file collisions when multiple
  // runs for the same company execute concurrently (MAX_CONCURRENT_RUNS > 1).
  // On Linux the workspace provides isolation, but on Windows (no workspace)
  // the unique name is essential. Harmless on Linux — just extra safety.
  // The clean label (without runId) is already stored in runs.env_name_used
  // at submission time for UI display purposes.
  const runIdShort = runId.slice(0, 8);
  const envName    = `OTST_${companyRow.slug}_${runIdShort}_Env`;
  const envYml     = buildEnvYml(envName, companyRow.api_base, accessToken, requestor, subscriptionKey, datafileUrl, scenarioOverride || null, oauthExtra);
  const envsDir    = workspaceDir ? path.join(workspaceDir, 'environments') : ENVS_DIR;
  const envFilePath = path.join(envsDir, `${envName}.yml`);

  try {
    if (!fs.existsSync(envsDir)) fs.mkdirSync(envsDir, { recursive: true });
    fs.writeFileSync(envFilePath, envYml, { mode: 0o600, encoding: 'utf8' });
    logEvent(runId, 'info', `[runner] Ephemeral env file written → ${envName}.yml` + (scenarioOverride ? ` (scenario_override: ${scenarioOverride})` : ''));
  } catch (err) {
    const msg = `Failed to write env file: ${err.message}`;
    dbRun(`UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`, [msg, runId]);
    logEvent(runId, 'error', `[runner] ${msg}`);
    return { exitCode: 1, error: msg };
  }

  // 7. Paths for Bruno output
  // Use a RELATIVE path for --reporter-json so bru.cmd resolves it from its own cwd.
  // runCwd is either the workspace (Linux) or COLLECTION_PATH (Windows).
  // Each run gets its own JSON file to prevent collisions under concurrent execution.
  const valDir         = path.join(runCwd, 'Validation_Reports');
  const bruJsonFile    = `.bru_results_${runIdShort}.json`;
  const bruJsonRel     = `Validation_Reports/${bruJsonFile}`;             // relative to cwd
  const bruJsonAbsPath = path.join(valDir, bruJsonFile);                  // absolute for post-processing

  if (!fs.existsSync(valDir)) fs.mkdirSync(valDir, { recursive: true });

  // 8. Spawn bru.cmd
  logEvent(runId, 'info', `[runner] Spawning bru.cmd — env=${envName} cwd=${runCwd}`);

  // Record wall-clock time before Bruno starts so we can later filter report
  // files by mtime — stale reports from previous runs (same day, same company)
  // must NOT be linked as artifacts for this run.
  const runStartTime = Date.now();

  // Detect auth/format failures in Bruno log output
  let authErrorDetected  = false;
  let tokenFormatError   = false;
  const AUTH_401_PATTERN    = /Wrong response status:\s*401|401\s+Unauthorized|HTTP\s+401/i;
  const TOKEN_FORMAT_PATTERN = /Error parsing environment|YAMLParseError|Unexpected scalar/i;

  const exitCode = await new Promise((resolve) => {
    const args = [
      'run',
      '--sandbox=developer',
      `--env`, envName,
      `--reporter-json`, bruJsonRel    // relative path — no spaces issue
    ];

    // Security: whitelist only the env vars Bruno CLI needs.
    // Do NOT pass process.env — it contains ENCRYPTION_KEY, JWT_SECRET,
    // and SMTP credentials that must never leak to child processes.
    // Windows requires ComSpec + PATHEXT for shell:true to find .cmd files.
    const safeEnv = {};
    const ALLOWED_ENV = [
      'PATH', 'PATHEXT', 'ComSpec', 'SystemRoot', 'SystemDrive',
      'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
      'TEMP', 'TMP', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
      'NODE_ENV', 'NODE_PATH',
    ];
    for (const key of ALLOWED_ENV) {
      if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
    }
    const proc = spawn(BRU_CMD, args, {
      cwd:   runCwd,
      shell: true,
      env:   safeEnv
    });

    const runTimeoutMs = parseInt(getConfig('RUN_TIMEOUT_MS', '600000'), 10);
    const timeout = setTimeout(() => {
      logEvent(runId, 'error', '[runner] Run timed out — killing process.');
      proc.kill('SIGTERM');
    }, runTimeoutMs);

    const logParser = new LogParser();
    // Seed the parser's scenario state from the run record. Single-scenario
    // runs (scenarioOverride set, or multi-scenario runs with one scenario_code)
    // carry the scenario name on the runs row; every event inherits it even
    // before Bruno emits its first scenario banner.
    if (scenarioOverride) {
      logParser.currentScenario = scenarioOverride;
    } else if (runRow && runRow.scenario_code) {
      logParser.currentScenario = runRow.scenario_code;
    }

    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        logEvent(runId, 'stdout', line, meta);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });
    proc.stderr.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        logEvent(runId, 'stderr', line, meta);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });

    proc.on('close', code => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
    proc.on('error', err => {
      clearTimeout(timeout);
      logEvent(runId, 'error', `[runner] Process error: ${err.message}`);
      resolve(1);
    });
  });

  // 9. Clean up ephemeral env file
  // When using workspace, the entire workspace directory is cleaned up later (step 10d).
  // Individual env file deletion is only needed on Windows (no workspace).
  if (!workspaceDir) {
    let envDeleted = false;
    for (let attempt = 1; attempt <= 3 && !envDeleted; attempt++) {
      try {
        fs.unlinkSync(envFilePath);
        envDeleted = true;
      } catch (err) {
        logEvent(runId, 'warn', `[runner] Env file deletion attempt ${attempt} failed: ${err.code}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 500));
      }
    }
    if (!envDeleted) {
      logEvent(runId, 'error', '[runner] CRITICAL: Failed to delete ephemeral env file after 3 attempts. Credentials may persist on disk.');
    }
    logEvent(runId, 'info', `[runner] Ephemeral env file ${envDeleted ? 'deleted' : 'DELETION FAILED'}.`);
  }

  // 10. Link HTML report artifact
  //
  // Two HTML files may exist in Validation_Reports after a run:
  //   A) {dateStr}_{envShort}_{SCENARIO_CODE}_Report.html   ← reportGenerator.js, written
  //      progressively DURING bru.cmd — contains all assertions, full detail.
  //   B) {dateStr}_{envShort}_Report.html                   ← mergeReport.js, written
  //      AFTER bru.cmd — merges .bru_results.json + .report_tmp.json.
  //
  // We always prefer (A) — it is the rich incremental report. We identify it by
  // excluding the exact {prefix}_Report.html name (which is mergeReport.js output).

  const dateStr  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const envShort = envName.replace(/^OTST_/i, '').replace(/_Env$/i, '');
  const prefix   = `${dateStr}_${envShort}`;
  const mergeReportName = `${prefix}_Report.html`;   // mergeReport.js exact output name

  let htmlArtifactLinked = false;

  try {
    // Look for reportGenerator.js output: has scenario code in name → longer than mergeReportName
    const candidates = fs.readdirSync(valDir)
      .filter(f =>
        f.startsWith(prefix) &&
        f.endsWith('_Report.html') &&
        f !== mergeReportName &&          // exclude mergeReport.js output
        fs.statSync(path.join(valDir, f)).mtimeMs >= runStartTime  // only files from THIS run
      )
      .map(f => ({ name: f, mtime: fs.statSync(path.join(valDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);  // most recent first (in case of multiple scenarios)

    if (candidates.length > 0) {
      // Link ALL scenario reports — one artifact per scenario in multi-scenario runs.
      // Filename format from reportGenerator.js: {prefix}_{SCENARIO_CODE}_Report.html
      // We store each as report_{SCENARIO_CODE}.html so filenames are distinct.
      candidates.forEach((cand) => {
        const scenarioCode = cand.name
          .slice(prefix.length + 1)           // strip "{prefix}_"
          .replace(/_Report\.html$/i, '')      // strip "_Report.html"
          .replace(/[^a-zA-Z0-9_-]/g, '_');   // S6: whitelist safe chars (prevent path traversal)
        const artifactFilename = `report_${scenarioCode}.html`;
        const srcHtml  = path.join(valDir, cand.name);
        const destHtml = path.join(runArtifactDir, artifactFilename);
        fs.copyFileSync(srcHtml, destHtml);
        dbRun(
          `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', ?, ?)`,
          [uuidv4(), runId, artifactFilename, destHtml]
        );
        logEvent(runId, 'info', `[runner] HTML report artifact linked (${cand.name}).`);
      });
      htmlArtifactLinked = true;
    } else {
      logEvent(runId, 'warn', `[runner] No reportGenerator HTML found (prefix=${prefix}, scenario code expected in name).`);
    }
  } catch (scanErr) {
    logEvent(runId, 'error', `[runner] Error scanning for HTML report: ${scanErr.message}`);
  }

  // 10b. Run mergeReport.js (produces a separate report with req/res bodies from .report_tmp.json).
  //      We run it for completeness; its output is used as fallback if reportGenerator.js produced nothing.
  const mergeReportJs = path.join(runCwd, 'library-bruno', 'mergeReport.js');
  if (fs.existsSync(mergeReportJs) && fs.existsSync(bruJsonAbsPath)) {
    logEvent(runId, 'info', '[runner] Running mergeReport.js...');

    // mergeReport.js expects .bru_results.json by convention (hardcoded name).
    // Copy our run-specific JSON to the standard name so mergeReport.js can find it.
    const stdJsonPath = path.join(valDir, '.bru_results.json');
    try { fs.copyFileSync(bruJsonAbsPath, stdJsonPath); } catch (_) {}

    const htmlExitCode = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [mergeReportJs, envName], {
        cwd:   runCwd,
        shell: false
      });
      proc.stdout.on('data', c => logEvent(runId, 'stdout', c.toString().trim()));
      proc.stderr.on('data', c => logEvent(runId, 'stderr', c.toString().trim()));
      proc.on('close', code => resolve(code ?? 0));
      proc.on('error', err  => { logEvent(runId, 'error', err.message); resolve(1); });
    });

    // Clean up the standard-name JSON copy after mergeReport finishes
    try { fs.unlinkSync(stdJsonPath); } catch (_) {}

    // Fallback: if reportGenerator.js report was not found, use mergeReport.js output
    if (!htmlArtifactLinked && htmlExitCode === 0) {
      const mergeHtmlPath = path.join(valDir, mergeReportName);
      if (fs.existsSync(mergeHtmlPath)) {
        const destHtml = path.join(runArtifactDir, `report.html`);
        fs.copyFileSync(mergeHtmlPath, destHtml);
        dbRun(
          `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', 'report.html', ?)`,
          [uuidv4(), runId, destHtml]
        );
        logEvent(runId, 'info', `[runner] HTML report artifact linked (mergeReport fallback).`);
      }
    }

    // Copy the raw JSON results into the run artifact dir, then clean up source
    if (fs.existsSync(bruJsonAbsPath)) {
      const destJson = path.join(runArtifactDir, '.bru_results.json');
      fs.copyFileSync(bruJsonAbsPath, destJson);
      dbRun(
        `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'json_results', '.bru_results.json', ?)`,
        [uuidv4(), runId, destJson]
      );
      // Remove run-specific JSON from Validation_Reports to avoid accumulation
      try { fs.unlinkSync(bruJsonAbsPath); } catch (_) {}
    }
  }

  // 10d. Clean up workspace (Linux only — includes env file)
  if (workspaceDir) {
    await cleanupWorkspace(runId);
    logEvent(runId, 'info', '[runner] Workspace cleaned up.');
  }

  // 10e. Extract structured assertion results into DB
  try {
    const { extractStructuredResults } = require('../reports/structureResults');
    const stats = extractStructuredResults(runId, companyRow.id);
    if (stats.assertions > 0) {
      logEvent(runId, 'info', `[runner] Stored ${stats.assertions} assertions across ${stats.suites} suites and ${stats.requests} requests.`);
    }
  } catch (err) {
    logEvent(runId, 'error', `[runner] Failed to store structured results: ${err.message}`);
  }

  // 11. Update run record
  const finalStatus = exitCode === 0 ? 'COMPLETED' : 'FAILED';
  dbRun(
    `UPDATE runs SET status = ?, exit_code = ?, completed_at = datetime('now') WHERE id = ?`,
    [finalStatus, exitCode, runId]
  );

  if (tokenFormatError) {
    dbRun(`UPDATE runs SET error_message = 'TOKEN_FORMAT_ERROR' WHERE id = ?`, [runId]);
    logEvent(runId, 'error',
      '[runner] ⚠️ YAML parse error — the API token contains invalid characters (e.g. a stray quote or whitespace). Please check and re-save your token.');
  } else if (authErrorDetected) {
    dbRun(`UPDATE runs SET error_message = 'TOKEN_AUTH_ERROR' WHERE id = ?`, [runId]);
    logEvent(runId, 'error',
      '[runner] ⚠️ HTTP 401 detected — the API token configured in your profile is invalid or has expired. Please update it.');
  }

  logEvent(runId, 'info', `[runner] Run finished — status=${finalStatus} exit=${exitCode}`);

  // Free the per-run line counter to prevent unbounded Map growth
  _resetLineCounter(runId);

  return { exitCode };
}

module.exports = { executeRun };
