// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

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
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, run: dbRun, decrypt, colEncrypt, getConfig } = require('../db/db');
const { copyAndEncryptFileAsync, decryptFromFileAsync } = require('../utils/at-rest');
const log = require('../utils/logger').child({ module: 'runner' });
const { resolveAccessToken } = require('./access-token');
const { safeJoinUuid } = require('../utils/paths');

// Inline UUID regex (see comment in reports/diff.js). Sonar's taint
// analyzer (jssecurity:S6549) requires the regex to live in the same
// module as each filesystem call for the sanitiser to be recognised.
const RUN_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Config ────────────────────────────────────────────────────────────────────
const COLLECTION_PATH = process.env.COLLECTION_PATH || '';
const BRU_CMD         = process.env.BRU_CMD || 'bru.cmd';
// v1.11.115: default to the schema OSCAR serves itself (loopback — Bruno
// runs inside the same container as the server). Previously an unset
// JSON_SCHEMA_URL produced an empty json_schema env var and every run
// failed datafile validation with "Missing env var json_schema". The
// loopback route exists since v1.11.112 and always matches the running
// collection, so it is the correct out-of-the-box value.
const JSON_SCHEMA_URL = process.env.JSON_SCHEMA_URL ||
  `http://127.0.0.1:${process.env.PORT || 3001}/json_validator/datafile.schema.json`;
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

// ── Active Bruno child processes — runId → ChildProcess ──────────────────────
// Lets the API forcibly terminate an in-flight run (emergency stop). Populated
// when bru.cmd is spawned, cleared on close/error. killRun() escalates SIGTERM
// → SIGKILL so a wedged scenario dies "hard but sure". The runner's own final
// status write is guarded with `AND status = 'RUNNING'`, so a row already moved
// to CANCELLED by the emergency-stop route is never resurrected to FAILED.
const _activeProcs = new Map();   // runId → ChildProcess

/**
 * Forcibly terminate the Bruno child process for a run, if one is alive.
 * SIGTERM first, then SIGKILL after a short grace period if it hasn't exited.
 * @param {string} runId
 * @returns {boolean} true if a live process was found and signalled
 */
function killRun(runId) {
  const proc = _activeProcs.get(runId);
  if (!proc) return false;
  try {
    proc.kill('SIGTERM');
    setTimeout(() => {
      // Still tracked ⇒ it never emitted 'close' ⇒ escalate.
      if (_activeProcs.has(runId)) {
        try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }
    }, 3000).unref();
  } catch (_) {
    return false;
  }
  return true;
}

// ── Async FS helpers ──────────────────────────────────────────────────────────
/** Non-throwing async equivalent of fs.existsSync(). */
async function fsExists(p) {
  try { await fs.promises.access(p); return true; } catch { return false; }
}

// ── Log helper — writes to run_events with optional structured metadata ───────
// #341 followup (v1.11.117): pass ts explicitly with millisecond precision.
// The schema default — datetime('now') — is SECOND-precision ("2026-06-09
// 21:25:16"), so the v1.11.113 dashboard change to slice(11,23) could never
// show milliseconds: they were never stored. new Date().toISOString() gives
// "2026-06-10T07:42:13.123Z" — same UTC storage convention, ms included.
// Old rows keep the second-precision format; the dashboard slice degrades
// gracefully on them (shows HH:MM:SS).
function logEvent(runId, level, message, meta) {
  const lineCount = _incrementAndCheck(runId);
  if (lineCount === MAX_LOG_LINES_PER_RUN + 1) {
    // Emit one final warning and then start dropping
    try {
      dbRun(
        `INSERT INTO run_events (run_id, ts, level, message, event_kind) VALUES (?, ?, ?, ?, ?)`,
        [runId, new Date().toISOString(), 'warn', colEncrypt(`[runner] Log line cap reached (${MAX_LOG_LINES_PER_RUN}). Further events dropped to prevent DB bloat.`), 'log']
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
    // Phase 2 of issue #60: encrypt log message content (only the message
    // body — metadata columns like category/phase/suite_name/http_status
    // remain plaintext so the structured-log filtering UI keeps working
    // without per-row decrypt/comparison cost).
    dbRun(
      `INSERT INTO run_events (run_id, ts, level, message,
         category, phase, suite_name, request_name, http_status,
         event_kind, attempt_index, attempt_total, scenario_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, new Date().toISOString(), level, colEncrypt(String(message).slice(0, 4000)),
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
      // #353: two guards keep the folder/request matcher from eating library
      // output, which created garbage per-area sections in the dashboard:
      //  - a line carrying an explicit [LEVEL] tag is library narration
      //    ("[DEBUG] 📊 Report updated → /app/…/report.html (39 assertions)"
      //    matches the text/text-(parens) shape), never a Bruno CLI row;
      //  - assertion rows are checked FIRST and include ✕ (U+2715 — what the
      //    Bruno CLI actually prints, distinct from ✗): "✕ GET
      //    /passenger-categories → … (HTTP 501 …)" also matches that shape.
      const hasLevelTag = /^\[(DEBUG|INFO|WARN(?:ING)?|ERROR)\]/i.test(trimmed);
      const isAssertionRow = /^\s*[✓✔✗✕×]/.test(trimmed) || /^\s*(pass|fail)\b/i.test(trimmed);
      // Bruno CLI prints request execution lines like:
      //   "01-System Infos Requests\00. GET System Version Check (404 Not Found) - 302 ms"
      const folderReqMatch = !hasLevelTag && !isAssertionRow
        && trimmed.match(/^([^()\\\/]+)[\\/]([^()]+?)\s+\(([^)]+)\)/);
      if (isAssertionRow) {
        category = 'assertion';
      } else if (folderReqMatch) {
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
/**
 * Compute the effective run timeout (ms) for a run, taking into account
 * per-scenario expired-flow tester-timer opt-ins:
 *   • `expiredBookingTest` + `expiredBookingMaxWaitMinutes`  (#204)
 *   • `expiredOfferTest`   + `expiredOfferMaxWaitMinutes`    (Phase 2)
 * Any future expired-X flow that follows the same `<flag>` / `<maxWait>` shape
 * can be added to the EXPIRED_FLOW_TIMERS table below without touching the
 * scan loop or the budget arithmetic.
 *
 *   baseMs    = RUN_TIMEOUT_MS env (default 600000 = 10 min)
 *   hardMaxMs = RUN_HARD_MAX_TIMEOUT_MS env (default 1800000 = 30 min)
 *
 * The datafile (already known to exist by the caller) is parsed; for every
 * scenario in scope (matching `scenarioOverride` if set, else
 * `scenariosToRun`), each registered timer is inspected. When BOTH the flag
 * is on AND its max-wait field is in 1..60, a requested ms (minutes*60_000 +
 * 60s buffer) is computed.
 *
 * Within a single scenario the per-timer requests are SUMMED (PR B: when 2+
 * timers are armed on the same scenario, OSCAR runs N sub-runs sequentially,
 * one per timer, so the wall-clock budget = sum of waits). ACROSS scenarios
 * the largest single-scenario sum wins (the worker only runs one scenario at
 * a time). The effective timeout is `min(hardMaxMs, max(baseMs, maxSum))`.
 *
 * Returns: { effectiveMs, baseMs, hardMaxMs, requestedMs, clamped, source }.
 * Never throws — datafile read/parse errors fall back to baseMs.
 */
const EXPIRED_FLOW_TIMERS = [
  { flag: 'expiredBookingTest',             wait: 'expiredBookingMaxWaitMinutes',             label: 'expiredBookingMaxWaitMinutes'             },
  { flag: 'expiredOfferTest',               wait: 'expiredOfferMaxWaitMinutes',               label: 'expiredOfferMaxWaitMinutes'               },
  { flag: 'expiredAddReservationOfferTest', wait: 'expiredAddReservationOfferMaxWaitMinutes', label: 'expiredAddReservationOfferMaxWaitMinutes' },
  { flag: 'expiredAddAncillaryOfferTest',   wait: 'expiredAddAncillaryOfferMaxWaitMinutes',   label: 'expiredAddAncillaryOfferMaxWaitMinutes'   },
  { flag: 'expiredRefundOfferTest',         wait: 'expiredRefundOfferMaxWaitMinutes',         label: 'expiredRefundOfferMaxWaitMinutes'         },
  { flag: 'expiredExchangeOfferTest',       wait: 'expiredExchangeOfferMaxWaitMinutes',       label: 'expiredExchangeOfferMaxWaitMinutes'       },
];
async function computeEffectiveRunTimeoutMs(datafilePath, scenarioOverride) {
  const baseMs    = parseInt(getConfig('RUN_TIMEOUT_MS',          '600000'),  10) || 600000;
  const hardMaxMs = parseInt(getConfig('RUN_HARD_MAX_TIMEOUT_MS', '1800000'), 10) || 1800000;
  let requestedMs = 0;
  let triggeringScenario = null;
  let triggeringTimer    = null;   // which expired-X timer drove the extension
  let helperError = null;
  let scenariosConsidered = 0;
  let scenariosInScope = 0;
  try {
    // CRITICAL: since OSCAR v1.11.0 (Phase 2 of issue #60) the datafile on disk
    // is AES-256-GCM encrypted under the OSCAR1 envelope. Plain fs.readFile here
    // returns the CIPHERTEXT and the subsequent JSON.parse throws on the magic
    // header — which was the actual cause of the #204 extension silently failing:
    // the helper hit its catch block, fell back to baseMs, and the worker SIGTERMed
    // the wait at the default 10 min RUN_TIMEOUT_MS.
    //
    // decryptFromFileAsync handles BOTH the encrypted form AND legacy plaintext
    // datafiles (it detects the OSCAR1 magic header). Same pattern as the
    // /v1/runs POST handler in api/routes/runs.js.
    const buf = await decryptFromFileAsync(datafilePath);
    const data = JSON.parse(buf.toString('utf8'));
    const scenarios     = Array.isArray(data.scenarios) ? data.scenarios : [];
    scenariosConsidered = scenarios.length;
    const scenariosToRun = data.scenariosToRun;
    const isInScope = (code) => {
      if (scenarioOverride) return String(code) === String(scenarioOverride);
      if (scenariosToRun === undefined || scenariosToRun === 'ALL' || scenariosToRun === '*') return true;
      if (Array.isArray(scenariosToRun)) return scenariosToRun.map(String).includes(String(code));
      if (typeof scenariosToRun === 'string') return scenariosToRun.split(/[,\s]+/).filter(Boolean).map(String).includes(String(code));
      return false;
    };
    for (const s of scenarios) {
      if (!s || !isInScope(s.code)) continue;
      scenariosInScope++;
      // PR B (auto-expansion): when a scenario has 2+ expired-X timers armed,
      // OSCAR runs that scenario N times (one sub-run per timer). The worker
      // SIGTERM must cover the SUM of the timers' max-waits inside one
      // scenario, not the max — running 3 timers of 15 min each takes 45 min
      // of wall-clock, not 15. Across scenarios we still take the MAX (only
      // one scenario runs at a time per worker). The +60s buffer is added
      // once per armed timer (one buffer per sub-run's request + assertions).
      let scenarioBudgetMs = 0;
      const armedInScenario = [];
      for (const timer of EXPIRED_FLOW_TIMERS) {
        const flagVal = s[timer.flag];
        const isOn = flagVal === true || (typeof flagVal === 'string' && ['true', 'on', 'yes'].includes(flagVal.toLowerCase()));
        if (!isOn) continue;
        const m = Number(s[timer.wait]);
        if (Number.isFinite(m) && m >= 1 && m <= 60) {
          scenarioBudgetMs += Math.ceil(m * 60 * 1000) + 60000;
          armedInScenario.push(timer.label);
        }
      }
      if (scenarioBudgetMs > requestedMs) {
        requestedMs        = scenarioBudgetMs;
        triggeringScenario = s.code || null;
        triggeringTimer    = armedInScenario.length > 1
          ? `${armedInScenario.length} timers summed (${armedInScenario.join(' + ')})`
          : (armedInScenario[0] || 'expired-flow timer');
      }
    }
  } catch (err) {
    // Capture (don't swallow) — the caller logs this so the operator can tell
    // why an expected extension didn't fire.
    helperError = err && err.message ? err.message : String(err);
  }
  const desired   = Math.max(baseMs, requestedMs);
  const effective = Math.min(desired, hardMaxMs);
  const clamped   = desired > hardMaxMs;
  let source;
  if (requestedMs > 0) {
    const _timerLbl = triggeringTimer || 'expired-flow timer';
    source = clamped
      ? `scenario ${_timerLbl} (clamped at RUN_HARD_MAX_TIMEOUT_MS, triggered by '${triggeringScenario}')`
      : `scenario ${_timerLbl} (triggered by '${triggeringScenario}')`;
  } else if (helperError) {
    source = `RUN_TIMEOUT_MS (datafile decrypt/parse FAILED — fell back to base; error: ${helperError})`;
  } else {
    source = `RUN_TIMEOUT_MS (no in-scope scenario requested an extension; ${scenariosConsidered} scenarios in datafile, ${scenariosInScope} matched the run scope)`;
  }
  return { effectiveMs: effective, baseMs, hardMaxMs, requestedMs, clamped, source, helperError, scenariosConsidered, scenariosInScope };
}

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
  // Inline path-traversal guard (Sonar S6549). runId originates from
  // uuid.v4() at /v1/runs POST time; the inline regex check makes the
  // sanitisation visible to Sonar's per-function analyzer.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error('createWorkspace: invalid runId format');
  }
  const workspaceDir = safeJoinUuid(WORKSPACES_DIR, runId);
  if (!workspaceDir) throw new Error('createWorkspace: invalid runId format');
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
    if (await fsExists(src)) {
      await fs.promises.cp(src, dest, { recursive: true });
    }
  }));

  // Copy collection-level files
  const copyFiles = ['opencollection.yml', '.gitignore'];
  await Promise.all(copyFiles.map(async (file) => {
    const src = path.join(COLLECTION_PATH, file);
    if (await fsExists(src)) {
      await fs.promises.copyFile(src, path.join(workspaceDir, file));
    }
  }));

  return workspaceDir;
}

async function cleanupWorkspace(runId) {
  // Inline path-traversal guard (Sonar S6549). Recursive remove on a
  // tainted path is the most dangerous filesystem operation in this
  // codebase — keep the sanitiser inline so the analyser sees it.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    log.error({ runId }, 'cleanupWorkspace: invalid runId format, refusing to remove');
    return;
  }
  const workspaceDir = safeJoinUuid(WORKSPACES_DIR, runId);
  if (!workspaceDir) {
    log.error({ runId }, 'cleanupWorkspace: invalid runId format, refusing to remove');
    return;
  }
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

  // 2. Prepare artifact directory — inline path-traversal guard (Sonar S6549)
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error('executeRun: invalid runId format');
  }
  const runArtifactDir = safeJoinUuid(ARTIFACTS_DIR, runId);
  if (!runArtifactDir) throw new Error('executeRun: invalid runId format');
  await fs.promises.mkdir(runArtifactDir, { recursive: true });

  // 3. Resolve access token (per-tester credentials, per-tester token cache).
  //    The oauth2/bearer logic + token cache live in access-token.js so the
  //    Timetable Discovery endpoint reuses the exact same path (issue #157).
  let accessToken;
  try {
    accessToken = await resolveAccessToken(userRow, _authLogger(runId));
    if (userRow.auth_mode !== 'oauth2') {
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
  if (!datafilePath || !(await fsExists(datafilePath))) {
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
  // #204: inject the run's HARD DEADLINE (epoch ms ≈ when the runner SIGTERMs
  // the run, i.e. now + effective timeout) as a read-only env var. The
  // expired-booking test uses it to decide whether waiting until the booking's
  // confirmation deadline fits the run budget — if not, it skips with a
  // WARNING instead of being killed mid-wait.
  //
  // Tester timer (#204 + Phase 2): if any in-scope scenario sets a per-scenario
  // expired-flow max-wait — currently `expiredBookingMaxWaitMinutes` or
  // `expiredOfferMaxWaitMinutes` (see EXPIRED_FLOW_TIMERS) — the effective
  // timeout is auto-extended to cover the largest request (clamped to
  // RUN_HARD_MAX_TIMEOUT_MS). The SAME value drives both this env injection
  // and the SIGTERM setTimeout below — they MUST agree.
  const _runBudget = await computeEffectiveRunTimeoutMs(datafilePath, scenarioOverride || null);
  // Always emit the chosen budget so the operator can tell exactly what the
  // runner decided — whether the extension fired, fell back silently, or hit
  // an error during datafile decrypt/parse. Previously this only logged when
  // the extension actually fired, which silently masked the #204 extension
  // failure (the datafile read returned ciphertext, JSON.parse threw, the
  // catch swallowed the error, and the run got SIGTERMed at the default 10
  // min).
  logEvent(runId, 'info',
    `[runner] Effective RUN_TIMEOUT_MS = ${_runBudget.effectiveMs}ms (${Math.round(_runBudget.effectiveMs / 1000)}s); base=${_runBudget.baseMs}ms hardMax=${_runBudget.hardMaxMs}ms; source: ${_runBudget.source}`);
  if (_runBudget.helperError) {
    logEvent(runId, 'warn',
      `[runner] computeEffectiveRunTimeoutMs hit an error reading the datafile (${_runBudget.helperError}) — fell back to base RUN_TIMEOUT_MS. Expired-flow tests (expiredBookingTest / expiredOfferTest / ...) will NOT get their requested extension; investigate above.`);
  }
  if (_runBudget.clamped) {
    logEvent(runId, 'warn',
      `[runner] expired-flow per-scenario max-wait requested ${_runBudget.requestedMs}ms but RUN_HARD_MAX_TIMEOUT_MS clamps to ${_runBudget.hardMaxMs}ms. Raise RUN_HARD_MAX_TIMEOUT_MS on the server if you need a longer wait.`);
  }
  // #204: inject the runId so 06.yml can call the loopback refresh-access-token
  // endpoint after the wait. The endpoint validates that the requested runId
  // exists and only refreshes the token bound to that run.
  const envYmlOut  = envYml
    + `  - name: runHardDeadlineMs\n    value: "${Date.now() + _runBudget.effectiveMs}"\n`
    + `  - name: __runId\n    value: "${runId}"\n`
    + `  - name: oscar_loopback_base\n    value: "http://127.0.0.1:${process.env.PORT || 3001}"\n`;
  const envsDir    = workspaceDir ? path.join(workspaceDir, 'environments') : ENVS_DIR;
  const envFilePath = path.join(envsDir, `${envName}.yml`);

  try {
    await fs.promises.mkdir(envsDir, { recursive: true });
    await fs.promises.writeFile(envFilePath, envYmlOut, { mode: 0o600, encoding: 'utf8' });
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

  await fs.promises.mkdir(valDir, { recursive: true });
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
    // Shell mode is only required when BRU_CMD points at a Windows
    // batch wrapper (.cmd / .bat) — direct execve cannot launch those.
    // On Linux / macOS / Windows-with-.exe we use shell: false so
    // arguments cannot be reinterpreted by sh -c (closes Sonar S4721
    // command-injection hotspot). args remains an array either way; the
    // change only affects whether the shell wraps the invocation.
    const needsShell = process.platform === 'win32'
      && /\.(cmd|bat)$/i.test(BRU_CMD);
    const proc = spawn(BRU_CMD, args, {
      cwd:   runCwd,
      shell: needsShell,
      env:   safeEnv
    });
    // Register for emergency-stop (killRun). Cleared in close/error below.
    _activeProcs.set(runId, proc);

    // Use the SAME effective timeout we just injected as runHardDeadlineMs.
    // Falling back to RUN_TIMEOUT_MS would let the worker get SIGTERMed mid-
    // wait when a scenario opted into a longer expired-flow per-scenario
    // max-wait (expiredBookingMaxWaitMinutes, expiredOfferMaxWaitMinutes, …).
    const runTimeoutMs = _runBudget.effectiveMs;
    const timeout = setTimeout(() => {
      logEvent(runId, 'error', `[runner] Run timed out after ${runTimeoutMs}ms — killing process.`);
      proc.kill('SIGTERM');
    }, runTimeoutMs);

    // #204 token-watchdog (Piece 3 / defense-in-depth): periodically refresh
    // the per-tester cached access token while the run is in flight, so the
    // server-side cache never expires under an in-flight Bruno process. The
    // ticker calls resolveAccessToken with forceRefresh:false; resolve's own
    // safety-margin check decides whether to refetch or no-op against cache.
    // This is BELT to the BRACES of (a) 01.yml's per-scenario refresh-on-start
    // (Piece 2) and (b) 06.yml's force-refresh after the expired-booking wait.
    //
    // Skipped for bearer-auth runs (no cache to keep warm). Skipped when
    // userRow is null (probably an admin/run-as-other context that hit the
    // run already). Tick interval = TOKEN_WATCHDOG_INTERVAL_MS env / config,
    // default 300000 (5 min).
    let tokenWatchdog = null;
    if (userRow && userRow.auth_mode === 'oauth2') {
      const tickMs = parseInt(getConfig('TOKEN_WATCHDOG_INTERVAL_MS', '300000'), 10) || 300000;
      // Disabled when set to 0 (operator opt-out).
      if (tickMs > 0) {
        tokenWatchdog = setInterval(async () => {
          try {
            await resolveAccessToken(
              userRow,
              { info: (m) => logEvent(runId, 'info', `[token-watchdog] ${m}`),
                error: (m) => logEvent(runId, 'error', `[token-watchdog] ${m}`) }
              // no forceRefresh — let the safety-margin check decide
            );
          } catch (err) {
            logEvent(runId, 'warn',
              `[token-watchdog] tick failed: ${err && err.message ? err.message : err} — Bruno can still get a fresh token via /v1/runs/${runId}/refresh-access-token at scenario start.`);
          }
        }, tickMs);
        logEvent(runId, 'info', `[runner] Token watchdog armed (tick every ${tickMs}ms = ${Math.round(tickMs/1000)}s). Disable with TOKEN_WATCHDOG_INTERVAL_MS=0.`);
      }
    }
    function stopTokenWatchdog() {
      if (tokenWatchdog) { clearInterval(tokenWatchdog); tokenWatchdog = null; }
    }

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

    // #336 (v1.11.113): infer the actual log level from the line content
    // instead of storing the literal stream name as the level. The
    // dashboard's level filter (Info / Warn / Error) and the per-level
    // CSS colouring rely on event.level — previously every Bruno line had
    // level='stdout' so the filter was a no-op on Bruno output.
    //
    // Inference order:
    //   1) explicit [LEVEL] tag from library-bruno emitters → that level
    //   2) Bruno CLI native test markers (✓ pass / ✕ fail) → info / error
    //   3) JS stack-trace shapes (AssertionError, "Error: ", "at /…:N:N") → error
    //   4) Known harmless platform noise (OpenSSL warn-once) → warn
    //   5) stderr stream with no other signal → error (Bruno emits real
    //      failures there; "stderr" alone is not a useful level)
    //   6) stdout stream with no other signal → info (sensible default —
    //      keeps the level-filter working without spamming "debug")
    function inferLevel(line, streamFallback) {
      // 1) explicit tag
      if (/\[ERROR]/i.test(line))                                 return 'error';
      if (/\[WARN(?:ING)?]/i.test(line))                          return 'warn';
      if (/\[INFO]/i.test(line))                                  return 'info';
      if (/\[DEBUG]/i.test(line))                                 return 'debug';
      // 2) Bruno CLI markers (assertion pass/fail rows in stdout)
      if (/^\s*✕\s/.test(line))                                   return 'error';
      if (/^\s*✓\s/.test(line))                                   return 'info';
      // 3) JS stack-trace shapes. The "Error:" MESSAGE line stays error —
      //    that's the content. The "at …" STACK FRAMES are demoted to debug
      //    (log-audit round 2): Bruno prints ~10 frames after every failed
      //    assertion (testCapture.js → @usebruno internals → node:vm), pure
      //    developer detail that tripled the visual size of each failure in
      //    the dashboard. They remain one debug-filter click away.
      if (/^\s*(?:Error|AssertionError|TypeError|ReferenceError):/i.test(line)) return 'error';
      if (/^\s*at\s+\S+\s*\(.*:\d+:\d+\)\s*$/.test(line))         return 'debug';
      if (/^\s*at\s+\/.*:\d+:\d+\s*$/.test(line))                 return 'debug';
      if (/^\s*at\s+Array\.forEach\b/.test(line))                 return 'debug';
      // 4) Known platform noise
      if (/Cannot open directory \/etc\/ssl\/certs/.test(line))   return 'warn';
      // 4b) Bruno CLI's own skip echo (one per request the smart run filter
      //     skips — e.g. the 6 vendor token requests at the top of every
      //     OSCAR run). Routine plumbing the tester doesn't act on → debug,
      //     matching the [DEBUG] tag on the library's own skip line.
      if (/\(request skipped via pre-request script\)\s*$/.test(line)) return 'debug';
      // 5/6) stream-based fallback
      return streamFallback;
    }

    proc.stdout.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        const level = inferLevel(line, 'info');
        logEvent(runId, level, line, meta);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });
    proc.stderr.on('data', chunk => {
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        const level = inferLevel(line, 'error');
        logEvent(runId, level, line, meta);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });

    proc.on('close', code => {
      clearTimeout(timeout);
      stopTokenWatchdog();
      _activeProcs.delete(runId);
      resolve(code ?? 1);
    });
    proc.on('error', err => {
      clearTimeout(timeout);
      stopTokenWatchdog();
      _activeProcs.delete(runId);
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
        await fs.promises.unlink(envFilePath);
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
    const entries = await fs.promises.readdir(valDir);
    const statResults = await Promise.all(
      entries
        .filter(f => f.startsWith(prefix) && f.endsWith('_Report.html') && f !== mergeReportName)
        .map(async f => {
          const st = await fs.promises.stat(path.join(valDir, f));
          return { name: f, mtime: st.mtimeMs };
        })
    );
    const candidates = statResults
      .filter(r => r.mtime >= runStartTime)    // only files from THIS run
      .sort((a, b) => b.mtime - a.mtime);      // most recent first

    if (candidates.length > 0) {
      // Link ALL scenario reports — one artifact per scenario in multi-scenario runs.
      // Filename format from reportGenerator.js: {prefix}_{SCENARIO_CODE}_Report.html
      // We store each as report_{SCENARIO_CODE}.html so filenames are distinct.
      await Promise.all(candidates.map(async (cand) => {
        const scenarioCode = cand.name
          .slice(prefix.length + 1)           // strip "{prefix}_"
          .replace(/_Report\.html$/i, '')      // strip "_Report.html"
          .replace(/[^a-zA-Z0-9_-]/g, '_');   // S6: whitelist safe chars (prevent path traversal)
        const artifactFilename = `report_${scenarioCode}.html`;
        const srcHtml  = path.join(valDir, cand.name);
        const destHtml = path.join(runArtifactDir, artifactFilename);
        // Encrypt at write — Phase 2 of issue #60. Plaintext source is
        // read once, ciphertext written via atomic temp+rename. Anyone
        // running `cat <destHtml>` from SSH sees the OSCAR1 envelope only.
        await copyAndEncryptFileAsync(srcHtml, destHtml);
        dbRun(
          `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', ?, ?)`,
          [uuidv4(), runId, artifactFilename, destHtml]
        );
        logEvent(runId, 'info', `[runner] HTML report artifact linked (${cand.name}).`);
      }));
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
  if (await fsExists(mergeReportJs) && await fsExists(bruJsonAbsPath)) {
    logEvent(runId, 'info', '[runner] Running mergeReport.js...');

    // mergeReport.js expects .bru_results.json by convention (hardcoded name).
    // Copy our run-specific JSON to the standard name so mergeReport.js can find it.
    const stdJsonPath = path.join(valDir, '.bru_results.json');
    try { await fs.promises.copyFile(bruJsonAbsPath, stdJsonPath); } catch (_) {}

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
    try { await fs.promises.unlink(stdJsonPath); } catch (_) {}

    // Fallback: if reportGenerator.js report was not found, use mergeReport.js output
    if (!htmlArtifactLinked && htmlExitCode === 0) {
      const mergeHtmlPath = path.join(valDir, mergeReportName);
      if (await fsExists(mergeHtmlPath)) {
        const destHtml = path.join(runArtifactDir, `report.html`);
        await copyAndEncryptFileAsync(mergeHtmlPath, destHtml);
        dbRun(
          `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', 'report.html', ?)`,
          [uuidv4(), runId, destHtml]
        );
        logEvent(runId, 'info', `[runner] HTML report artifact linked (mergeReport fallback).`);
      }
    }

    // Copy the raw JSON results into the run artifact dir, then clean up source
    if (await fsExists(bruJsonAbsPath)) {
      const destJson = path.join(runArtifactDir, '.bru_results.json');
      await copyAndEncryptFileAsync(bruJsonAbsPath, destJson);
      dbRun(
        `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'json_results', '.bru_results.json', ?)`,
        [uuidv4(), runId, destJson]
      );
      // Remove run-specific JSON from Validation_Reports to avoid accumulation
      try { await fs.promises.unlink(bruJsonAbsPath); } catch (_) {}
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

  // 11. Update run record.
  // Guard with `AND status = 'RUNNING'`: if the run was emergency-stopped
  // (POST /v1/runs/stop-all set it to CANCELLED) while bru.cmd was being
  // killed, this write must NOT resurrect it to COMPLETED/FAILED.
  const finalStatus = exitCode === 0 ? 'COMPLETED' : 'FAILED';
  const finalUpd = dbRun(
    `UPDATE runs SET status = ?, exit_code = ?, completed_at = datetime('now') WHERE id = ? AND status = 'RUNNING'`,
    [finalStatus, exitCode, runId]
  );
  if (finalUpd && Number(finalUpd.changes) === 0) {
    // Row was already terminal (e.g. CANCELLED by emergency stop) — leave it.
    logEvent(runId, 'info', '[runner] Final status not written — run already in a terminal state (likely cancelled).');
    _resetLineCounter(runId);
    return { exitCode };
  }

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

module.exports = { executeRun, killRun, computeEffectiveRunTimeoutMs };
