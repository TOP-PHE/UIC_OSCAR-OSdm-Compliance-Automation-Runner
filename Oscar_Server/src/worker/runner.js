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

const path        = require('node:path');
const { tokenErrorText } = require('../utils/tokenErrors');
const fs          = require('node:fs');
const { launch, launchRun, launcherProblem, isolationMode } = require('./launcher');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, run: dbRun, decrypt, colEncrypt, colDecrypt, getConfig } = require('../db/db');
const { encryptToFileAsync, decryptFromFileAsync } = require('../utils/at-rest');
const {
  readRunFile, writeRunFile, removeRunFile, listRunFolder, makeRunFolder,
  copyIntoRunFolder, copyFileIntoRunFolder,
} = require('./runFolder');
const {
  COLLECTION_DIRS, COLLECTION_FILES, MERGE_RESULTS_NAME, bruResultsName, bruRunArgs,
} = require('../run-pod/runLayout');
const { listRunResults, readRunResult, removeRunResults } = require('../utils/runResults');
const metrics = require('../utils/metrics');
const log = require('../utils/logger').child({ module: 'runner' });
const { resolveAccessToken, dropCachedToken } = require('./access-token');
const { credentialsFor } = require('../utils/testerCredentials');
const { canUseCompany } = require('../api/helpers/provider-access');
const { normalizeRole } = require('../api/middleware/auth');
const { safeJoinUuid } = require('../utils/paths');
const { templatesForRunner, runRefusal, frameworkRunRefusal } = require('../utils/datafileTemplates');
const runSecrets = require('../utils/runSecrets');
const { usableUrlRefusal } = require('../utils/urlPolicy');
const { versionRefusal } = require('../utils/osdmVersion');
const { frameworkConfigOf } = require('../api/helpers/configurationStore');
const { runSettingsOf: traceRunSettingsOf } = require('../../public/js/trace-context');

// Inline UUID regex (see comment in reports/diff.js). Sonar's taint
// analyzer (jssecurity:S6549) requires the regex to live in the same
// module as each filesystem call for the sanitiser to be recognised.
const RUN_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ── Config ────────────────────────────────────────────────────────────────────
const COLLECTION_PATH = process.env.COLLECTION_PATH || '';
// v1.11.115: default to the schema OSCAR serves itself (loopback — Bruno
// runs inside the same container as the server). Previously an unset
// JSON_SCHEMA_URL produced an empty json_schema env var and every run
// failed datafile validation with "Missing env var json_schema". The
// loopback route exists since v1.11.112 and always matches the running
// collection, so it is the correct out-of-the-box value.
// Where Bruno reaches this server (data file, schema, token refresh): the
// loopback, as Bruno runs on this machine; with RUN_ISOLATION=isolated and
// RUN_SERVER_URL set, the server's address on the runner agent's network.
function withoutTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
function serverUrls() {
  const port = process.env.PORT || 3001;
  const isolatedBase = ['isolated', 'pod'].includes(isolationMode()) && process.env.RUN_SERVER_URL
    ? withoutTrailingSlashes(process.env.RUN_SERVER_URL) : '';
  const loopback = isolatedBase || `http://127.0.0.1:${port}`;
  return {
    data: isolatedBase || `http://localhost:${port}`,
    loopback,
    schema: process.env.JSON_SCHEMA_URL || `${loopback}/json_validator/datafile.schema.json`,
  };
}
const ARTIFACTS_DIR   = path.resolve(__dirname, '../../data/artifacts');
const ENVS_DIR        = path.join(COLLECTION_PATH, 'environments');
// A run's working folder (collection copy, env file, reports). RUN_WORKSPACES_DIR
// puts them outside data/, on a volume a runner agent shares (option 2b).
const WORKSPACES_DIR  = process.env.RUN_WORKSPACES_DIR
  ? path.resolve(process.env.RUN_WORKSPACES_DIR)
  : path.resolve(__dirname, '../../data/workspaces');

// ── What a child process may inherit (tracker NEW-01) ────────────────────────
// The list and childBaseEnv() live in worker/childEnv.js, shared with the
// runner agent, which must not load this module (it opens the database).
const { CHILD_ENV_ALLOWLIST, childBaseEnv } = require('./childEnv');

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
  } catch {
    // kill() threw, so nothing was signalled.
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

// "at fn (file:line:col)" stack frame. The two alternatives are the two ways the
// function token can end, at a "(" inside it or at whitespace before the "(",
// so the pattern has one way to match a line instead of many.
const STACK_FRAME_WITH_PARENS = /^\s*at\s+(?:\S[^\s(]*\(|\S+\s+\().*:\d+:\d+\)\s*$/;

// Bruno CLI request row: "<folder>/<request name> (<status text>)", with either
// slash. The request name is everything up to the whitespace before the first
// "(", written so the pattern cannot backtrack over that whitespace.
const OFFER_OPTIONS_MARK = '🧭';
const { onIntrusionLine, newIntrusionTag, INTRUSION_MARK, endpointSuspension } = require('../utils/intrusion');

const FOLDER_REQUEST_ROW = /^([^()\\/]+)[\\/]([^()]*[^()\s]|\s)\s+\(([^)]+)\)/;

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
  if (STACK_FRAME_WITH_PARENS.test(line))                     return 'debug';
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
  currentSuite = null;
  currentRequest = null;
  currentScenario = null;
  attemptIndex = null;
  attemptTotal = null;
  phase = 'setup';

  parse(line) {
    const trimmed = (line || '').trim();
    if (!trimmed) return {};

    let category = 'bruno';
    let httpStatus = null;
    let eventKind = 'log';

    // Scenario boundary detection — check before other patterns since these
    // lines can otherwise be misclassified as generic bruno output.
    // Match shape: "Skipping to next scenario [2/8]: OTST_FOO"
    const skipMatch = trimmed.match(/Skipping to next scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*:\s*([\w-]+)/i);
    const startMatch = !skipMatch && trimmed.match(/(?:Starting|Running)\s+scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*:\s*([\w-]+)/i);
    const endMatch = !skipMatch && !startMatch && trimmed.match(/scenario\s*\[(\d+)\s*\/\s*(\d+)\]\s*(?:completed|finished|done)\s*:\s*([\w-]+)/i);
    const attemptMatch = trimmed.match(/\(attempt\s+(\d+)\s*\/\s*(\d+)\)/i);

    if (skipMatch) {
      this.attemptIndex = Number.parseInt(skipMatch[1], 10);
      this.attemptTotal = Number.parseInt(skipMatch[2], 10);
      this.currentScenario = skipMatch[3];
      this.currentSuite = null;
      this.currentRequest = null;
      eventKind = 'scenario_skipped';
      category = 'system';
    } else if (startMatch) {
      this.attemptIndex = Number.parseInt(startMatch[1], 10);
      this.attemptTotal = Number.parseInt(startMatch[2], 10);
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
      this.attemptIndex = Number.parseInt(attemptMatch[1], 10);
      this.attemptTotal = Number.parseInt(attemptMatch[2], 10);
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
      // #355: the library's token-skip line fires in the PRE-request script —
      // BEFORE the Bruno CLI row that normally opens the 00-Access Token
      // suite — so the FIRST one (benerail) landed in the Runner section.
      // The line's home is known by construction (the token folder name is
      // fixed in the collection).
      if (/Skipping \[[^\]]*access token\]/i.test(trimmed)) {
        this.currentSuite = '00-Access Token';
        this.currentRequest = null;
      }
      // Bruno CLI prints request execution lines like:
      //   "01-System Infos Requests\00. GET System Version Check (404 Not Found) - 302 ms"
      const folderReqMatch = !hasLevelTag && !isAssertionRow
        && trimmed.match(FOLDER_REQUEST_ROW);
      if (isAssertionRow) {
        category = 'assertion';
      } else if (folderReqMatch) {
        this.currentSuite   = folderReqMatch[1].trim();
        this.currentRequest = folderReqMatch[2].trim();
        this.phase = 'execution';
        category = 'system';
        const httpInParen = folderReqMatch[3].match(/\b([1-5]\d{2})\b/);
        if (httpInParen) httpStatus = Number.parseInt(httpInParen[1], 10);
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
        if (m) httpStatus = Number.parseInt(m[1], 10);
      } else if (/^\[runner\]/i.test(trimmed)) {
        category = 'system';
      } else if (trimmed.includes(INTRUSION_MARK)) {
        // The collection met an answer meant to attack OSCAR (utils/intrusion.js).
        category = 'intrusion';
      } else if (hasLevelTag && trimmed.includes(OFFER_OPTIONS_MARK)) {
        // #227 part 3: the offer request options report, read back by the
        // Report Builder (utils/offerOptionReport.js) through this category.
        category = 'offer_options';
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
    info:  (msg, meta) => logEvent(runId, 'info',  msg, { ...base, ...meta }),
    error: (msg, meta) => logEvent(runId, 'error', msg, { ...base, ...meta })
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
 * Returns: { effectiveMs, baseMs, hardMaxMs, requestedMs, armedTimers, clamped, source }.
 * `armedTimers` counts the expiry tests switched on in scope, max wait or not.
 * Never throws — datafile read/parse errors fall back to baseMs.
 */
const EXPIRED_FLOW_TIMERS = [
  { flag: 'expiredBookingTest',             wait: 'expiredBookingMaxWaitMinutes',             label: 'expiredBookingMaxWaitMinutes'             },
  { flag: 'expiredOfferTest',               wait: 'expiredOfferMaxWaitMinutes',               label: 'expiredOfferMaxWaitMinutes'               },
  { flag: 'expiredAddReservationOfferTest', wait: 'expiredAddReservationOfferMaxWaitMinutes', label: 'expiredAddReservationOfferMaxWaitMinutes' },
  { flag: 'expiredAddAncillaryOfferTest',   wait: 'expiredAddAncillaryOfferMaxWaitMinutes',   label: 'expiredAddAncillaryOfferMaxWaitMinutes'   },
  { flag: 'expiredRefundOfferTest',         wait: 'expiredRefundOfferMaxWaitMinutes',         label: 'expiredRefundOfferMaxWaitMinutes'         },
  { flag: 'expiredExchangeOfferTest',       wait: 'expiredExchangeOfferMaxWaitMinutes',       label: 'expiredExchangeOfferMaxWaitMinutes'       },
  // #603: the refund receipt wait has no on/off flag; the wait alone arms it.
  { flag: null,                             wait: 'refundReceiptMaxWaitMinutes',              label: 'refundReceiptMaxWaitMinutes'              },
];
// How long Bruno may stay silent before the run is stopped as stalled
// (RUN_IDLE_TIMEOUT_MS, default 5 min, 0 = off). Off when a scenario in scope
// arms a timer: it waits on purpose, and may print nothing while it does.
// #656: armed is the flag, not the flag plus a max wait. Without a max wait
// the collection still waits, on the server's RUN_TIMEOUT_MS.
const IDLE_CHECK_EVERY_MS = 15000;
function runIdleLimitMs(runBudget) {
  if (runBudget && (runBudget.requestedMs > 0 || runBudget.armedTimers > 0)) return 0;
  const ms = Number.parseInt(getConfig('RUN_IDLE_TIMEOUT_MS', '300000'), 10);
  return Number.isInteger(ms) && ms > 0 ? ms : 0;
}

async function computeEffectiveRunTimeoutMs(datafilePath, scenarioOverride) {
  const baseMs    = Number.parseInt(getConfig('RUN_TIMEOUT_MS',          '600000'),  10) || 600000;
  const hardMaxMs = Number.parseInt(getConfig('RUN_HARD_MAX_TIMEOUT_MS', '1800000'), 10) || 1800000;
  let requestedMs = 0;
  let triggeringScenario = null;
  let triggeringTimer    = null;   // which expired-X timer drove the extension
  let helperError = null;
  let scenariosConsidered = 0;
  let scenariosInScope = 0;
  let armedTimers = 0;
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
        const flagVal = timer.flag ? s[timer.flag] : true;
        const isOn = flagVal === true || (typeof flagVal === 'string' && ['true', 'on', 'yes'].includes(flagVal.toLowerCase()));
        if (!isOn) continue;
        const m = Number(s[timer.wait]);
        if (timer.flag) armedTimers++;
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
    helperError = err?.message ? err.message : String(err);
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
  return { effectiveMs: effective, baseMs, hardMaxMs, requestedMs, armedTimers, clamped, source, helperError, scenariosConsidered, scenariosInScope };
}

// ── One way to write a value into the Bruno environment file (tracker NEW-02) ─
// The file is YAML, and a value used to be pasted between two double quotes as
// it came. A scenario code is free text a tester stores: one holding a quote
// and a line break closed its scalar and added variables of its own, a second
// api_base among them. Bruno uses the last one, so the run's requests, token
// included, went to an address the tester chose — and the run may be a
// colleague's, or the Test Manager's "run all".
//
// Every value now goes through yamlQuoted(). It writes a YAML double-quoted
// scalar on one line that holds printable ASCII only: JSON.stringify escapes
// the quote, the backslash and the control characters, and everything from DEL
// upwards is written as \uXXXX (some YAML parsers treat U+0085, U+2028 and
// U+2029 as line breaks). Each escape it uses is valid in YAML and reads back
// as the same character, so the value Bruno sees is exactly the one given. A
// value with nothing to escape is written byte for byte as before.
function yamlQuoted(value) {
  return JSON.stringify(String(value))
    .replaceAll(/[\u007f-\uffff]/g, (c) => String.raw`\u` + c.codePointAt(0).toString(16).padStart(4, '0'));
}

// The two lines of one variable. `name` is always a literal of this file.
function envVar(name, value) {
  return [`  - name: ${name}`, `    value: ${yamlQuoted(value)}`];
}

// ── Scenario codes that are not run ──────────────────────────────────────────
// Returns the reason, as a sentence for the person who started the run, or
// null when the code may run. No code at all (null, '') is not refused: that
// is a run of the datafile's own list.
//
// A code holding "{{". Escaping keeps a code from adding to the environment
// file, but Bruno then fills in {{...}} in a value when a script reads it
// (bru.getEnvVar), and {{process.env.OSCAR_ACCESS_TOKEN}} is the token of
// whoever started the run. The collection would print that "code" as not
// found, in a run log every member of the company can read; {{requestor}}
// could even make it name a colleague's private scenario. Bruno has no way to
// write "{{" literally.
//
// A code that is not text. It is whatever JSON was stored; an object without a
// usable toString() made String() throw here, and a run that throws stays
// RUNNING in the database.
function refusedScenarioCode(code) {
  if (code === null || code === undefined || code === '') return null;
  if (typeof code !== 'string') {
    return 'The scenario code is not text. Correct the scenario in Test Config, then run it again.';
  }
  if (code.includes('{{')) {
    return 'The scenario code contains "{{", which the test engine would replace with the value of a variable. Rename the scenario in Test Config, then run it again.';
  }
  return null;
}

// The same question for the text of the datafile (tracker NEW-10). The rule and
// its reasons are in utils/datafileTemplates.js; in short, the collection hands
// the WHOLE datafile to Bruno before every run, so a template anywhere in it is
// filled in with the variables of whoever runs anything. Returns the reason,
// or null when the run may go on. `runner` says whose run it is: a Test Manager
// is told every place, a tester only the places they can see in Test Config.
//
// A datafile that is missing is left to the step that already reports it. One
// that is there but cannot be read refuses the run: starting it would mean
// starting it unchecked.
async function refusedDatafileText(datafilePath, runner) {
  if (!datafilePath || !(await fsExists(datafilePath))) return null;
  // The check is inside the `try` on purpose: a run whose executeRun throws is
  // never marked FAILED, so whatever goes wrong here has to end as a refusal.
  try {
    const datafile = JSON.parse((await decryptFromFileAsync(datafilePath)).toString('utf8'));
    return runRefusal(templatesForRunner(datafile, runner));
  } catch {
    return 'The data file could not be read, so it could not be checked and the run was not started. Try again; if it happens again, ask your Test Manager to check the data file.';
  }
}

// The run's copy of the data file takes values from the Test Framework, so a
// framework holding "{{" refuses the run like a data file does.
function refusedFrameworkText(companyId) {
  try {
    const fwRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
    if (!fwRow?.config) return null;
    return frameworkRunRefusal(JSON.parse(colDecrypt(fwRow.config)));
  } catch {
    return 'The Test Framework could not be read, so it could not be checked and the run was not started. Try again; if it happens again, ask your Test Manager to check the Test Framework.';
  }
}

// #785: the OSDM version the scenario runs with (its own, else the Test
// Framework's) goes in every request's Content-Type; a run with one that is
// not a version is refused before anything is sent. A data file that cannot
// be read was already refused above; a missing one is left as it is.
async function refusedOsdmVersion(datafilePath, scenarioCode, companyId) {
  if (!datafilePath || !scenarioCode || !(await fsExists(datafilePath))) return null;
  try {
    const datafile = JSON.parse((await decryptFromFileAsync(datafilePath)).toString('utf8'));
    const fwRow = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
    let framework = {};
    try { framework = fwRow?.config ? JSON.parse(colDecrypt(fwRow.config)) : {}; } catch { framework = {}; }
    return versionRefusal(datafile, scenarioCode, framework.osdmVersion);
  } catch {
    return 'The data file could not be read, so its OSDM version could not be checked and the run was not started. Try again; if it happens again, ask your Test Manager to check the data file.';
  }
}

// #956: what this run is made with (server and collection versions, the
// scenario's content hash), for the coverage report's "to run again". Never
// throws: a run is not stopped for its bookkeeping.
async function recordRunVersions(runId, datafilePath, scenarioCode) {
  try {
    const { currentCollectionVersion, serverVersion } = require('../utils/versionInfo');
    let hash = null;
    if (datafilePath && scenarioCode && await fsExists(datafilePath)) {
      const datafile = JSON.parse((await decryptFromFileAsync(datafilePath)).toString('utf8'));
      const scenario = (Array.isArray(datafile?.scenarios) ? datafile.scenarios : []).find((s) => s && s.code === scenarioCode);
      hash = require('../utils/frameworkCoverage').scenarioHash(scenario);
    }
    dbRun('UPDATE runs SET server_version = ?, collection_version = ?, scenario_hash = ? WHERE id = ?',
      [serverVersion === 'unknown' ? null : serverVersion, currentCollectionVersion(), hash, runId]);
  } catch (err) {
    log.warn({ err, runId }, 'run versions not recorded');
  }
}

// S5: a run sends every OSDM request to the company api_base. Refuse to start
// one aimed at a non-public target (loopback, the private network, a Docker
// service name) before a token is resolved — with DNS, so a name that resolves
// inward is caught too. A company with no api_base yet is left to the step that
// already reports it. ALLOW_PRIVATE_TARGETS turns this off for a dev/self-host.
async function refusedApiBase(apiBase) {
  if (!apiBase) return null;
  const refusal = await usableUrlRefusal(apiBase, 'OSDM endpoint (API Config)');
  if (!refusal) return null;
  if (refusal.includes('could not be resolved within')) return `This run was not started. ${refusal}`;
  return `This run was not started. ${refusal} Ask your Test Manager to set a public https endpoint in API Config.`;
}

function buildEnvYml(envName, apiBase, requestor, datafileUrl, scenarioOverride, extraHeaders, traceSettings) {
  // #306: this file deliberately carries NO credentials. The access token,
  // Ocp-Apim-Subscription-Key and oauth_extra travel via the Bruno child
  // process's environment (OSCAR_* vars set at spawn time in executeRun) and
  // are seeded into Bruno's runtime vars by the collection's before-request
  // hook (opencollection.yml, bru.getProcessEnv) — so no secret ever touches
  // disk, even if the worker dies between the env-file write and cleanup.
  const lines = [
    `name: ${yamlQuoted(envName)}`,
    `variables:`,
    ...envVar('api_base', apiBase),
    ...envVar('library_base', './library-bruno/'),
    ...envVar('data_base', datafileUrl),
    ...envVar('json_schema', serverUrls().schema),
    ...envVar('scenariosToRunIndex', '0'),
  ];
  if (requestor) {
    lines.push(...envVar('requestor', requestor));
  }
  if (scenarioOverride) {
    lines.push(...envVar('scenario_override', scenarioOverride));
  }
  if (Array.isArray(extraHeaders) && extraHeaders.length > 0) {
    // Issue #426 — company-wide dedicated headers. Passed through as a JSON
    // string for the collection's before-request hook to parse + inject (the
    // hook resolves any {{var}} templates in the values).
    lines.push(...envVar('__extraHeaders', JSON.stringify(extraHeaders)));
  }
  if (traceSettings) {
    // #1070: the Test Framework's W3C trace context, its tracestate template
    // already parsed (runSettingsOf): Bruno would fill in a "{{" itself.
    lines.push(...envVar('__traceContext', JSON.stringify(traceSettings)));
  }
  return lines.join('\n') + '\n';
}

// ── Run-scoped workspace (Linux only) ────────────────────────────────────────
// Creates an isolated directory for each run. Bruno CLI does not follow
// symlinks, so we copy collection folders into the workspace. Async to avoid
// blocking the EventLoop while copying multi-MB directory trees.
// The folder is the run's: every folder and file of it is made new, without
// following a link (runFolder.js). Returns its path (the run's cwd) and its
// real path, against which its files are checked later.
async function createWorkspace(runId) {
  // Inline path-traversal guard (Sonar S6549). runId originates from
  // uuid.v4() at /v1/runs POST time; the inline regex check makes the
  // sanitisation visible to Sonar's per-function analyzer.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw new Error('createWorkspace: invalid runId format');
  }
  const workspaceDir = safeJoinUuid(WORKSPACES_DIR, runId);
  if (!workspaceDir) throw new Error('createWorkspace: invalid runId format');
  await fs.promises.mkdir(WORKSPACES_DIR, { recursive: true });
  const root = await fs.promises.realpath(WORKSPACES_DIR);
  // A folder left by an earlier attempt of this run goes first (a link in it
  // is removed, never followed).
  await fs.promises.rm(workspaceDir, { recursive: true, force: true });
  const realDir = await makeRunFolder(root, runId, { expectedDir: root });
  const inRunFolder = { expectedDir: realDir };

  // Real directories for write targets (env file, reports, results)
  await Promise.all([
    makeRunFolder(realDir, 'environments', inRunFolder),
    makeRunFolder(realDir, 'Validation_Reports', inRunFolder),
  ]);

  // Copy collection folders into workspace, in parallel for speed (the
  // lists are the run pod's too, run-pod/runLayout.js).
  await Promise.all(COLLECTION_DIRS.map(async (item) => {
    const src  = path.join(COLLECTION_PATH, item);
    if (await fsExists(src)) {
      await copyIntoRunFolder(src, realDir, item, inRunFolder);
    }
  }));

  // Copy collection-level files
  await Promise.all(COLLECTION_FILES.map((file) =>
    copyFileIntoRunFolder(path.join(COLLECTION_PATH, file), realDir, file, inRunFolder)));

  return { dir: workspaceDir, realDir };
}

// What a file of the run's folder `sub` is checked against (runFolder.js):
// its real path when the run has a workspace; the collection's own folder
// (no workspace) is not checked.
function runFolderCheck(runRealDir, sub) {
  return { expectedDir: runRealDir ? path.join(runRealDir, sub) : null };
}

// The log line for a file of Validation_Reports the runner leaves out.
function leftOutText(name, err) {
  const why = err?.code === 'ERUNFILE' ? err.message : String(err?.code || err?.message || err);
  return `[runner] Validation_Reports/${name} left out (${why}): a file of the run's folder is read only as a plain file of that folder.`;
}

// The plain file `name` of the run's report folder, or null: not there, or
// left out with a line in the log.
async function readReportFile(runId, valDir, name, reports) {
  try {
    return await readRunFile(valDir, name, reports);
  } catch (err) {
    if (err?.code !== 'ENOENT') logEvent(runId, 'error', leftOutText(name, err));
    return null;
  }
}

// Stores `content` as an encrypted artifact (Phase 2 of issue #60): anyone
// running `cat <dest>` from SSH sees the OSCAR1 envelope only. Returns whether
// it was stored.
async function storeArtifact(runId, content, dest) {
  try {
    await encryptToFileAsync(content, dest);
    return true;
  } catch (err) {
    logEvent(runId, 'error', `[runner] ${path.basename(dest)} could not be stored: ${err.message}`);
    return false;
  }
}

/**
 * 10. Links every scenario report of the run as an artifact.
 *
 * Two HTML files may exist in Validation_Reports after a run:
 *   A) {dateStr}_{envShort}_{SCENARIO_CODE}_Report.html   ← reportGenerator.js, written
 *      progressively DURING bru.cmd — contains all assertions, full detail.
 *   B) {dateStr}_{envShort}_Report.html                   ← mergeReport.js, written
 *      AFTER bru.cmd — merges .bru_results.json + .report_tmp.json.
 * We always prefer (A) — it is the rich incremental report. We identify it by
 * excluding the exact {prefix}_Report.html name (which is mergeReport.js output).
 * Returns whether one was linked.
 */
async function linkScenarioReports({ runId, valDir, prefix, mergeReportName, runStartTime, runArtifactDir, reports }) {
  try {
    const named = (await listRunFolder(valDir, reports))
      .filter(f => f.name.startsWith(prefix) && f.name.endsWith('_Report.html') && f.name !== mergeReportName);
    for (const f of named.filter(e => !e.plain)) logEvent(runId, 'error', leftOutText(f.name, 'not a plain file'));
    const candidates = named
      .filter(f => f.plain && f.mtimeMs >= runStartTime)   // only files from THIS run
      .sort((a, b) => b.mtimeMs - a.mtimeMs);              // most recent first
    if (candidates.length === 0) {
      logEvent(runId, 'warn', `[runner] No reportGenerator HTML found (prefix=${prefix}, scenario code expected in name).`);
      return false;
    }
    // Link ALL scenario reports — one artifact per scenario in multi-scenario runs.
    // We store each as report_{SCENARIO_CODE}.html so filenames are distinct.
    const linked = await Promise.all(candidates.map(async (cand) => {
      const scenarioCode = cand.name
        .slice(prefix.length + 1)           // strip "{prefix}_"
        .replace(/_Report\.html$/i, '')      // strip "_Report.html"
        .replaceAll(/[^a-zA-Z0-9_-]/g, '_'); // S6: whitelist safe chars (prevent path traversal)
      const artifactFilename = `report_${scenarioCode}.html`;
      const destHtml = path.join(runArtifactDir, artifactFilename);
      const content = await readReportFile(runId, valDir, cand.name, reports);
      if (content === null || !(await storeArtifact(runId, content, destHtml))) return false;
      dbRun(
        `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', ?, ?)`,
        [uuidv4(), runId, artifactFilename, destHtml]
      );
      logEvent(runId, 'info', `[runner] HTML report artifact linked (${cand.name}).`);
      return true;
    }));
    return linked.includes(true);
  } catch (scanErr) {
    logEvent(runId, 'error', `[runner] Error scanning for HTML report: ${scanErr.message}`);
    return false;
  }
}

// Runs the collection's mergeReport.js; resolves with its exit code.
function runMergeReport(runId, envName, runCwd) {
  return new Promise((resolve) => {
    // NEW-01: the same allowlist as the Bruno spawn, and none of the run's
    // credentials — the script reads its argument and two files, nothing else.
    let proc;
    try {
      proc = launch('merge', { args: [envName], cwd: runCwd, env: childBaseEnv() });
    } catch (err) {
      logEvent(runId, 'error', err.message);
      resolve(1);
      return;
    }
    proc.stdout.on('data', c => logEvent(runId, 'stdout', c.toString().trim()));
    proc.stderr.on('data', c => logEvent(runId, 'stderr', c.toString().trim()));
    proc.on('close', code => resolve(code ?? 0));
    proc.on('error', err  => { logEvent(runId, 'error', err.message); resolve(1); });
  });
}

/**
 * 10b. Runs mergeReport.js, whose report is the fallback when reportGenerator.js
 * gave none, then stores the raw results. The results file is read once, as a
 * plain file of the run's folder, and written again under the name mergeReport.js
 * expects (.bru_results.json, hardcoded there).
 */
async function mergeAndStoreResults({ runId, runCwd, valDir, bruJsonFile, envName, mergeReportName, htmlArtifactLinked, runArtifactDir, reports }) {
  const mergeReportJs = path.join(runCwd, 'library-bruno', 'mergeReport.js');
  if (!(await fsExists(mergeReportJs))) return;
  const results = await readReportFile(runId, valDir, bruJsonFile, reports);
  if (results === null) return;
  logEvent(runId, 'info', '[runner] Running mergeReport.js...');

  const stdJson = MERGE_RESULTS_NAME;
  try {
    await writeRunFile(valDir, stdJson, results, { ...reports, mode: 0o644 });
  } catch (err) {
    logEvent(runId, 'error', leftOutText(stdJson, err));
  }
  const htmlExitCode = await runMergeReport(runId, envName, runCwd);
  try {
    await removeRunFile(valDir, stdJson, reports);
  } catch { /* the copy is the run's; the workspace goes at 10d */ }

  // Fallback: if reportGenerator.js report was not found, use mergeReport.js output
  if (!htmlArtifactLinked && htmlExitCode === 0) {
    const destHtml = path.join(runArtifactDir, 'report.html');
    const html = await readReportFile(runId, valDir, mergeReportName, reports);
    if (html !== null && await storeArtifact(runId, html, destHtml)) {
      dbRun(
        `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'html_report', 'report.html', ?)`,
        [uuidv4(), runId, destHtml]
      );
      logEvent(runId, 'info', `[runner] HTML report artifact linked (mergeReport fallback).`);
    }
  }

  // The raw JSON results into the run artifact dir, then clean up the source
  const destJson = path.join(runArtifactDir, '.bru_results.json');
  if (await storeArtifact(runId, results, destJson)) {
    dbRun(
      `INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, 'json_results', '.bru_results.json', ?)`,
      [uuidv4(), runId, destJson]
    );
  }
  // Remove run-specific JSON from Validation_Reports to avoid accumulation
  try {
    await removeRunFile(valDir, bruJsonFile, reports);
  } catch { /* as above */ }
}

// ── Pod mode (run isolation, option 4, #1130) ────────────────────────────────
// The run's pod address, as the dispatcher reports it: the run's secret is
// bound to it. A secret already used from another address is withdrawn and
// the run stopped.
function onRunPodAddress(runId, address, proc) {
  if (runSecrets.bindAddress(runId, address)) {
    logEvent(runId, 'info', `[runner] The run's pod is at ${address}.`);
    return;
  }
  runSecrets.revoke(runId);
  logEvent(runId, 'error', `[runner] The run's secret was used from an address that is not its pod's (${address}): it is withdrawn and the run stopped.`);
  try { proc.kill('SIGTERM'); } catch { /* already gone */ }
}

// How a run's pod ended, from the exit code the dispatcher gives
// (run-dispatcher/dispatcher.js: 124 deadline, 125 never started, 143 stopped;
// any other code is Bruno's own). One of metrics.RUN_POD_OUTCOMES.
const POD_EXIT_OUTCOMES = new Map([[124, 'deadline'], [125, 'not_started'], [143, 'stopped']]);
function podOutcomeOf(code) {
  return POD_EXIT_OUTCOMES.get(code) || 'ran';
}

// The pod mode's two metrics for one run: its start time once the dispatcher
// names its pod, its outcome once it ends (or is refused), each once.
function watchRunPod(proc) {
  const askedAt = process.hrtime.bigint();
  let ended = false;
  proc.once('pod', () => metrics.runPodStart.observe(Number(process.hrtime.bigint() - askedAt) / 1e9));
  return (outcome) => {
    if (ended) return;
    ended = true;
    metrics.runPodsEnded.inc({ outcome });
  };
}

const REPORT_SUFFIX = '_Report.html';
// The scenario code a report's name gives ({date}_{envShort}_{code}_Report.html),
// '' for mergeReport.js's ({date}_{envShort}_Report.html), else null.
function reportCodeOf(name, envShort) {
  if (!name.endsWith(REPORT_SUFFIX) || !/^\d{8}_/.test(name)) return null;
  const middle = name.slice(9, -REPORT_SUFFIX.length);
  if (middle === envShort) return '';
  return middle.startsWith(`${envShort}_`) ? middle.slice(envShort.length + 1) : null;
}

// One file the run's pod sent, stored as an artifact of the run.
async function linkUploadedResult(runId, name, dest, type, filename) {
  let content;
  try {
    content = await readRunResult(runId, name);
  } catch (err) {
    logEvent(runId, 'error', `[runner] ${name}, sent by the run's pod, could not be read: ${err.message}`);
    return false;
  }
  if (!(await storeArtifact(runId, content, dest))) return false;
  dbRun(`INSERT INTO run_artifacts (id, run_id, type, filename, path) VALUES (?, ?, ?, ?, ?)`, [uuidv4(), runId, type, filename, dest]);
  return true;
}

/**
 * 10 (pod mode). Links what the run's pod sent (utils/runResults.js): every
 * scenario report, else mergeReport.js's, and Bruno's results; then removes
 * the files sent.
 */
async function linkUploadedResults({ runId, envShort, runArtifactDir }) {
  const names = await listRunResults(runId);
  if (names.length === 0) logEvent(runId, 'warn', '[runner] The run\'s pod sent no result file.');
  let linked = false;
  for (const name of names) {
    const code = reportCodeOf(name, envShort);
    if (!code) continue;
    const filename = `report_${code.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.html`;   // S6: safe characters only
    if (await linkUploadedResult(runId, name, path.join(runArtifactDir, filename), 'html_report', filename)) {
      linked = true;
      logEvent(runId, 'info', `[runner] HTML report artifact linked (${name}).`);
    }
  }
  const merged = names.find((n) => reportCodeOf(n, envShort) === '');
  if (!linked && merged && await linkUploadedResult(runId, merged, path.join(runArtifactDir, 'report.html'), 'html_report', 'report.html')) {
    logEvent(runId, 'info', '[runner] HTML report artifact linked (mergeReport fallback).');
  }
  const results = bruResultsName(runId);
  if (names.includes(results)) {
    await linkUploadedResult(runId, results, path.join(runArtifactDir, MERGE_RESULTS_NAME), 'json_results', MERGE_RESULTS_NAME);
  }
  await removeRunResults(runId);
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

// ── Run, endpoint and credentials of one company (#540) ──────────────────────
// The endpoint is the run's company's (companyRow.api_base) and the credentials
// are the user's for that company (credentialsFor), so both follow the company
// the job names. This checks that the job's company is the run's own, and that
// a member who started it may still act in it: a tester whose access to a
// provider was withdrawn while the run was queued is not sent there. Platform
// users are not tenant members and keep the path they had. Returns a refusal
// sentence, or null. Never throws: a thrown executeRun leaves the run unmarked.
// An endpoint suspended after an intrusion attempt takes no run until a Test
// Manager resumes it (utils/intrusion.js); runs queued before are refused here.
function refusedSuspendedEndpoint(companyId) {
  return endpointSuspension(companyId)
    ? 'The OSDM endpoint of this company or provider is suspended: an answer meant to attack OSCAR was detected during a run. A Test Manager resumes it on the API Config page once the provider is checked.'
    : null;
}

function refusedRunScope(runRow, companyId, userId) {
  try {
    if (runRow.company_id !== companyId) return 'Run refused: the run does not belong to the company it was queued for.';
    const user = get('SELECT id, company_id, role FROM users WHERE id = ?', [userId]);
    if (!user) return 'Run refused: the user who started the run no longer exists.';
    const member = { id: user.id, companyId: user.company_id, role: normalizeRole(user.role) };
    if (member.role === 'administrator') return 'Run refused: an administrator does not run tests on a company.';
    if (!canUseCompany(member, companyId)) return 'Run refused: the user who started the run may no longer use this company.';
    return null;
  } catch {
    return 'Run refused: the run\'s company could not be checked.';
  }
}

// ── Main execution function ────────────────────────────────────────────────────
async function executeRun({ runId, companyId, userId, scenarioOverride }) {
  // 1. Load run + company + user from DB. The OSDM credentials (auth_mode,
  //    OAuth fields, bearer token, token cache) are the user's for THIS
  //    company (#540: tester_credentials, per user and company). The company
  //    row keeps api_base + datafile only.
  const runRow     = get('SELECT * FROM runs     WHERE id = ?', [runId]);
  const companyRow = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  // Prefer the userId from the queue job; fall back to the run's recorded
  // user_id (set at POST /v1/runs time) so legacy queue items still resolve.
  const effectiveUserId = userId || runRow?.user_id || null;
  const userRow = effectiveUserId ? credentialsFor(effectiveUserId, companyId) : null;

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

  // 2b. Some runs are not started: because of the scenario's code (tracker
  //     NEW-02, second half) or of text in the datafile (NEW-10). The run
  //     stops here: before a token is asked for, before the environment file
  //     is written, before anything is started.
  const refusal = refusedRunScope(runRow, companyId, effectiveUserId)
    || refusedSuspendedEndpoint(companyId)
    || launcherProblem()
    || refusedScenarioCode(scenarioOverride)
    || await refusedApiBase(companyRow.api_base)
    || await refusedDatafileText(companyRow.datafile_path, { testManager: userRow.role === 'test_manager', email: userRow.email })
    || refusedFrameworkText(companyId)
    || await refusedOsdmVersion(companyRow.datafile_path, scenarioOverride, companyId);
  if (refusal) {
    dbRun(`UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`, [refusal, runId]);
    logEvent(runId, 'error', `[runner] ${refusal}`);
    return { exitCode: 1, error: refusal };
  }
  await recordRunVersions(runId, companyRow.datafile_path, scenarioOverride);

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
    // The run's error and log are read by the company: no secret, no quoted
    // token answer in them (tokenErrors.js).
    const reason = tokenErrorText(err, userRow);
    dbRun(
      `UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`,
      [reason, runId]
    );
    logEvent(runId, 'error', `[runner] Auth failed: ${reason}`);
    return { exitCode: 1, error: reason };
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

  // 4d. Resolve company-wide dedicated headers (issue #426). Stored as a JSON
  // array of { name, value } on the company row and passed verbatim to the
  // collection's before-request hook, which injects each header and resolves
  // any {{var}} templates in the values against the env at send time.
  let extraHeaders = [];
  try {
    // S6: extra_headers is encrypted at rest; colDecrypt reads both the
    // encrypted form and any legacy-plaintext row.
    const _stored = companyRow.extra_headers ? colDecrypt(companyRow.extra_headers) : null;
    const _eh = _stored ? JSON.parse(_stored) : null;
    if (Array.isArray(_eh)) extraHeaders = _eh;
  } catch (_ehErr) {
    logEvent(runId, 'warn', `[runner] Ignoring malformed company extra_headers: ${_ehErr.message}`);
  }

  // 5. Validate data file exists
  const datafileUrl = `${serverUrls().data}/data/${companyRow.slug}-datafile.json`;
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
  // An isolated run always has one: the runner agent sees the working
  // folders only, never the collection's own folder.
  // Pod mode (#1130): the run's pod makes its own folder from its image; nothing here.
  const podMode = isolationMode() === 'pod';
  const useWorkspace = !podMode && (isolationMode() === 'isolated' || (process.platform !== 'win32' && !!scenarioOverride));
  let workspaceDir = null;
  let runRealDir = null;   // the workspace's real path: its files are checked against it
  let runCwd = COLLECTION_PATH;

  if (useWorkspace) {
    try {
      ({ dir: workspaceDir, realDir: runRealDir } = await createWorkspace(runId));
    } catch (err) {
      // Refuse, never throw: a thrown executeRun leaves the run unmarked.
      const msg = `The run's working folder could not be made: ${err.message}`;
      dbRun(`UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`, [msg, runId]);
      logEvent(runId, 'error', `[runner] ${msg}`);
      await cleanupWorkspace(runId);
      return { exitCode: 1, error: msg };
    }
    runCwd = workspaceDir;
    logEvent(runId, 'info', `[runner] Workspace created → ${workspaceDir}`);
  }

  // 6. Generate ephemeral env file (credential-free since #306 — secrets go
  //    through the child process environment at spawn time instead)
  // Use a per-run unique env name to prevent file collisions when multiple
  // runs for the same company execute concurrently (MAX_CONCURRENT_RUNS > 1).
  // On Linux the workspace provides isolation, but on Windows (no workspace)
  // the unique name is essential. Harmless on Linux — just extra safety.
  // The clean label (without runId) is already stored in runs.env_name_used
  // at submission time for UI display purposes.
  const runIdShort = runId.slice(0, 8);
  const envName    = `OTST_${companyRow.slug}_${runIdShort}_Env`;
  const traceSettings = traceRunSettingsOf(frameworkConfigOf(companyRow.id) || {});
  const envYml     = buildEnvYml(envName, companyRow.api_base, requestor, datafileUrl, scenarioOverride || null, extraHeaders, traceSettings);
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
  // The run's own tag on its intrusion lines (utils/intrusion.js): a line
  // without it is not acted on, whatever prints it.
  const intrusionTag = newIntrusionTag();
  const envYmlOut  = envYml + [
    ...envVar('runHardDeadlineMs', Date.now() + _runBudget.effectiveMs),
    ...envVar('__runId', runId),
    ...envVar('__intrusionTag', intrusionTag),
    ...envVar('oscar_loopback_base', serverUrls().loopback),
  ].join('\n') + '\n';
  const envsDir    = workspaceDir ? path.join(workspaceDir, 'environments') : ENVS_DIR;
  const envFilePath = path.join(envsDir, `${envName}.yml`);

  const forScenario = scenarioOverride ? ` (scenario_override: ${scenarioOverride})` : '';
  if (podMode) {
    // The pod writes it in its own folder, from the run request (run-pod/runPod.js).
    logEvent(runId, 'info', `[runner] Environment file ${envName}.yml sent with the run to its pod${forScenario}`);
  } else {
    try {
      if (!workspaceDir) await fs.promises.mkdir(envsDir, { recursive: true });
      await writeRunFile(envsDir, `${envName}.yml`, envYmlOut, { ...runFolderCheck(runRealDir, 'environments'), mode: 0o600 });
      logEvent(runId, 'info', `[runner] Ephemeral env file written → ${envName}.yml${forScenario}`);
    } catch (err) {
      const msg = `Failed to write env file: ${err.message}`;
      dbRun(`UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE id = ?`, [msg, runId]);
      logEvent(runId, 'error', `[runner] ${msg}`);
      return { exitCode: 1, error: msg };
    }
  }

  // 7. Paths for Bruno output
  // Use a RELATIVE path for --reporter-json so bru.cmd resolves it from its own cwd.
  // runCwd is either the workspace (Linux) or COLLECTION_PATH (Windows).
  // Each run gets its own JSON file to prevent collisions under concurrent execution.
  const valDir         = path.join(runCwd, 'Validation_Reports');
  const bruJsonFile    = bruResultsName(runId);   // the run pod names it alike (run-pod/runLayout.js)

  if (!workspaceDir && !podMode) await fs.promises.mkdir(valDir, { recursive: true });
  logEvent(runId, 'info', `[runner] Spawning bru.cmd — env=${envName} cwd=${runCwd}`);

  // Record wall-clock time before Bruno starts so we can later filter report
  // files by mtime — stale reports from previous runs (same day, same company)
  // must NOT be linked as artifacts for this run. Subtract a safety margin:
  // some filesystems (observed in CI container storage drivers) round/truncate
  // a file's reported mtime to coarser-than-millisecond precision, which can
  // put a file's mtime just BELOW runStartTime even though it was genuinely
  // written after. A previous run's report is always at minimum seconds old
  // in practice, so a couple of seconds of margin costs nothing on the
  // staleness guarantee while eliminating this sub-second truncation race.
  const MTIME_FILTER_SAFETY_MARGIN_MS = 2000;
  const runStartTime = Date.now() - MTIME_FILTER_SAFETY_MARGIN_MS;

  // Detect auth/format failures in Bruno log output
  let authErrorDetected  = false;
  let tokenFormatError   = false;
  const AUTH_401_PATTERN    = /Wrong response status:\s*401|401\s+Unauthorized|HTTP\s+401/i;
  const TOKEN_FORMAT_PATTERN = /Error parsing environment|YAMLParseError|Unexpected scalar/i;

  const exitCode = await new Promise((resolve) => {
    // Relative --reporter-json path (no spaces issue); the run pod starts Bruno alike.
    const args = bruRunArgs(envName, runId);

    // Security: only the allowlisted env vars, never process.env — it holds
    // ENCRYPTION_KEY, JWT_SECRET and the SMTP credentials (CHILD_ENV_ALLOWLIST).
    const safeEnv = childBaseEnv();
    // #306: hand the per-run credentials to Bruno via its process
    // environment — never via the env yml on disk (see buildEnvYml). The
    // collection's before-request hook (opencollection.yml) seeds them into
    // Bruno's runtime vars with bru.getProcessEnv(), only while the runtime
    // var is still empty — so a mid-run loopback token refresh (#204) is
    // never clobbered by the stale spawn-time value.
    safeEnv.OSCAR_ACCESS_TOKEN = accessToken;
    if (subscriptionKey) safeEnv.OSCAR_SUBSCRIPTION_KEY = subscriptionKey;
    if (oauthExtra)      safeEnv.OSCAR_OAUTH_EXTRA      = String(oauthExtra);
    // S8-loopback: the secret that lets this child — and only while it runs —
    // fetch its company's datafile and refresh its token. Carried via the
    // environment like the token above, never written to the env file on disk.
    // The collection sends it back as a header on both loopback calls; the
    // routes bind it to this run's company. Revoked when the child exits.
    safeEnv.OSCAR_RUN_SECRET = runSecrets.issue(runId, companyRow.id);
    // Started by kind through the launcher (worker/launcher.js), which
    // keeps the shell off unless BRU_CMD is a Windows batch wrapper.
    let proc;
    let podEnded = () => {};
    try {
      proc = podMode
        ? launchRun({
          runId, envName, envYml: Buffer.from(envYmlOut, 'utf8').toString('base64'),
          deadlineSeconds: Math.max(60, Math.ceil(_runBudget.effectiveMs / 1000)), env: safeEnv,
        })
        : launch('bru', { args, cwd: runCwd, env: safeEnv });
      if (podMode) {
        podEnded = watchRunPod(proc);
        proc.on('pod', (address) => onRunPodAddress(runId, address, proc));
      }
    } catch (err) {
      if (podMode) metrics.runPodsEnded.inc({ outcome: 'refused' });
      runSecrets.revoke(runId);
      logEvent(runId, 'error', `[runner] Process error: ${err.message}`);
      resolve(1);
      return;
    }
    // Register for emergency-stop (killRun). Cleared in close/error below.
    _activeProcs.set(runId, proc);

    // Use the SAME effective timeout we just injected as runHardDeadlineMs.
    // Falling back to RUN_TIMEOUT_MS would let the worker get SIGTERMed mid-
    // wait when a scenario opted into a longer expired-flow per-scenario
    // max-wait (expiredBookingMaxWaitMinutes, expiredOfferMaxWaitMinutes, …).
    const runTimeoutMs = _runBudget.effectiveMs;
    // killRun escalates to SIGKILL when SIGTERM does not end the process.
    const timeout = setTimeout(() => {
      logEvent(runId, 'error', `[runner] Run timed out after ${runTimeoutMs}ms — killing process.`);
      killRun(runId);
    }, runTimeoutMs);

    // A provider that stops answering leaves Bruno waiting on one request,
    // silent, until the run's timeout (or for ever, if the process ignores
    // SIGTERM). Bruno prints a line per request, so a long silence means a
    // request got no answer: stop the run and say so. Not armed when the
    // scenario waits on purpose (an expired-flow or receipt timer).
    let lastOutputAt = Date.now();
    const idleLimitMs = runIdleLimitMs(_runBudget);
    if (idleLimitMs === 0 && _runBudget.armedTimers > 0) {
      logEvent(runId, 'info', `[runner] No stop on silence for this run: ${_runBudget.armedTimers} expiry test(s) armed, which wait on purpose. RUN_TIMEOUT_MS still applies.`);
    }
    const idleWatch = idleLimitMs > 0 ? setInterval(() => {
      if (Date.now() - lastOutputAt < idleLimitMs) return;
      clearInterval(idleWatch);
      logEvent(runId, 'error', `[runner] No output from Bruno for ${Math.round(idleLimitMs / 1000)}s: run stopped. Most often a request to the provider got no answer (unreachable, or blocking this server); the last step logged above is where it waited.`);
      killRun(runId);
    }, Math.min(IDLE_CHECK_EVERY_MS, Math.max(10, Math.floor(idleLimitMs / 4)))) : null;
    const stopIdleWatch = () => { if (idleWatch) clearInterval(idleWatch); };

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
    if (userRow?.auth_mode === 'oauth2') {
      const tickMs = Number.parseInt(getConfig('TOKEN_WATCHDOG_INTERVAL_MS', '300000'), 10) || 300000;
      // Disabled when set to 0 (operator opt-out).
      if (tickMs > 0) {
        tokenWatchdog = setInterval(async () => {
          // #540: no new token once the user may no longer use this company.
          const scopeRefusal = refusedRunScope(runRow, companyId, effectiveUserId);
          if (scopeRefusal) {
            logEvent(runId, 'warn', `[token-watchdog] refresh skipped — ${scopeRefusal}`);
            return;
          }
          try {
            await resolveAccessToken(
              userRow,
              { info: (m) => logEvent(runId, 'info', `[token-watchdog] ${m}`),
                error: (m) => logEvent(runId, 'error', `[token-watchdog] ${m}`) }
              // no forceRefresh — let the safety-margin check decide
            );
          } catch (err) {
            logEvent(runId, 'warn',
              `[token-watchdog] tick failed: ${err?.message ? err.message : err} — Bruno can still get a fresh token via /v1/runs/${runId}/refresh-access-token at scenario start.`);
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
    } else if (runRow?.scenario_code) {
      logParser.currentScenario = runRow.scenario_code;
    }

    proc.stdout.on('data', chunk => {
      lastOutputAt = Date.now();
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        const level = inferLevel(line, 'info');
        logEvent(runId, level, line, meta);
        onIntrusionLine(line, runRow, undefined, intrusionTag);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });
    proc.stderr.on('data', chunk => {
      lastOutputAt = Date.now();
      const lines = chunk.toString().split('\n');
      lines.forEach(line => {
        if (!line.trim()) return;
        const meta = logParser.parse(line);
        const level = inferLevel(line, 'error');
        logEvent(runId, level, line, meta);
        onIntrusionLine(line, runRow, undefined, intrusionTag);
        if (AUTH_401_PATTERN.test(line))    authErrorDetected = true;
        if (TOKEN_FORMAT_PATTERN.test(line)) tokenFormatError  = true;
      });
    });

    proc.on('close', code => {
      clearTimeout(timeout);
      stopIdleWatch();
      stopTokenWatchdog();
      _activeProcs.delete(runId);
      runSecrets.revoke(runId);            // S8-loopback: the child is gone; no more loopback calls
      podEnded(podOutcomeOf(code));
      resolve(code ?? 1);
    });
    proc.on('error', err => {
      clearTimeout(timeout);
      stopIdleWatch();
      stopTokenWatchdog();
      _activeProcs.delete(runId);
      runSecrets.revoke(runId);            // S8-loopback: no child, no valid secret
      podEnded('refused');
      logEvent(runId, 'error', `[runner] Process error: ${err.message}`);
      resolve(1);
    });
  });

  // 9. Clean up ephemeral env file
  // When using workspace, the entire workspace directory is cleaned up later (step 10d).
  // Individual env file deletion is only needed on Windows (no workspace).
  // In pod mode none was written here.
  if (!workspaceDir && !podMode) {
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
      // #306: not a credential leak — the env yml carries no secrets any more
      // (credentials travel via the child process environment). Hygiene only.
      logEvent(runId, 'warn', '[runner] Failed to delete ephemeral env file after 3 attempts. The file carries no credentials (#306); leftover is cosmetic.');
    }
    logEvent(runId, 'info', `[runner] Ephemeral env file ${envDeleted ? 'deleted' : 'DELETION FAILED'}.`);
  }

  // 10. Link HTML report artifacts (linkScenarioReports says which).
  const dateStr  = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const envShort = envName.replace(/^OTST_/i, '').replace(/_Env$/i, '');
  const prefix   = `${dateStr}_${envShort}`;
  const mergeReportName = `${prefix}_Report.html`;   // mergeReport.js exact output name

  if (podMode) {
    // The run's pod ran mergeReport.js too, and sent its result files to the
    // internal port (utils/runResults.js): they are linked from there.
    await linkUploadedResults({ runId, envShort, runArtifactDir });
  } else {
    // The run wrote this folder: its files are read as plain files of it only
    // (runFolder.js); one that is not is left out, with a line in the log.
    const reports = runFolderCheck(runRealDir, 'Validation_Reports');
    const htmlArtifactLinked = await linkScenarioReports({ runId, valDir, prefix, mergeReportName, runStartTime, runArtifactDir, reports });

    // 10b. Run mergeReport.js (produces a separate report with req/res bodies from .report_tmp.json).
    //      We run it for completeness; its output is used as fallback if reportGenerator.js produced nothing.
    await mergeAndStoreResults({ runId, runCwd, valDir, bruJsonFile, envName, mergeReportName, htmlArtifactLinked, runArtifactDir, reports });
  }

  // 10d. Clean up workspace (Linux only — includes env file)
  if (workspaceDir) {
    await cleanupWorkspace(runId);
    logEvent(runId, 'info', '[runner] Workspace cleaned up.');
  }

  // 10e. Extract structured assertion results into DB
  let checksStored = null;                       // null: not known (the extraction failed)
  try {
    const { extractStructuredResults } = require('../reports/structureResults');
    const stats = extractStructuredResults(runId, companyRow.id);
    checksStored = stats.assertions;
    if (stats.assertions > 0) {
      logEvent(runId, 'info', `[runner] Stored ${stats.assertions} assertions across ${stats.suites} suites and ${stats.requests} requests.`);
    }
  } catch (err) {
    logEvent(runId, 'error', `[runner] Failed to store structured results: ${err.message}`);
  }

  // A run Bruno ended well but that left no check checked nothing: its results
  // never reached the server (a run pod that could not send them), or the
  // collection made no check (its data file was not read). It is not a pass.
  const noChecks = exitCode === 0 && checksStored === 0;

  // 11. Update run record.
  // Guard with `AND status = 'RUNNING'`: if the run was emergency-stopped
  // (POST /v1/runs/stop-all set it to CANCELLED) while bru.cmd was being
  // killed, this write must NOT resurrect it to COMPLETED/FAILED.
  const finalStatus = exitCode === 0 && !noChecks ? 'COMPLETED' : 'FAILED';
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
      '[runner] ⚠️ YAML parse error in the run environment file — a configured value (e.g. API base URL or requestor) contains invalid characters such as a stray quote. Please check and re-save your API Config.');
  } else if (authErrorDetected) {
    dbRun(`UPDATE runs SET error_message = 'TOKEN_AUTH_ERROR' WHERE id = ?`, [runId]);
    logEvent(runId, 'error',
      '[runner] ⚠️ HTTP 401 detected — the API token configured in your profile is invalid or has expired. Please update it.');
    // #680: a refused token is not served again from the cache. Never fails
    // the end of the run: the status is already written.
    try {
      if (dropCachedToken(userRow, accessToken)) {
        logEvent(runId, 'info', '[runner] The cached token was refused (401); it is dropped and the next run will request a new one.');
      }
    } catch (err) {
      logEvent(runId, 'warn', `[runner] The refused token could not be dropped from the cache: ${err?.message ? err.message : err}`);
    }
  } else if (noChecks) {
    dbRun(`UPDATE runs SET error_message = 'NO_CHECKS' WHERE id = ?`, [runId]);
    logEvent(runId, 'error',
      '[runner] ⚠️ No check was recorded for this run, so it is marked failed: nothing was checked. Its results did not reach the server, or the collection made no check (its data file or scenario could not be read); the lines above say which.');
  }

  logEvent(runId, 'info', `[runner] Run finished — status=${finalStatus} exit=${exitCode}`);

  // Free the per-run line counter to prevent unbounded Map growth
  _resetLineCounter(runId);

  return { exitCode };
}

module.exports = { executeRun, killRun, refusedRunScope, podOutcomeOf, computeEffectiveRunTimeoutMs, LogParser, inferLevel, buildEnvYml, yamlQuoted, refusedScenarioCode, CHILD_ENV_ALLOWLIST, runIdleLimitMs, WORKSPACES_DIR, serverUrls };
