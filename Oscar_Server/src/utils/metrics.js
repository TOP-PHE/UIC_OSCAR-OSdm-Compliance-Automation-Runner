// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * metrics.js — Prometheus metrics registry for OSCAR.
 *
 * Exposes a `register` (the prom-client default registry, with default
 * Node.js process metrics enabled) and a small set of OSCAR-specific
 * Counters / Gauges / Histograms that the rest of the codebase increments.
 *
 * No auth on the endpoint — see Documentation/Server_Operations/metrics-and-monitoring.md
 * for the deployment model: Prometheus runs in the same Docker network as
 * OSCAR and scrapes via the internal hostname (oscar:3001/metrics). External
 * access is blocked at the nginx layer (404 on /metrics).
 */

const promClient = require('prom-client');

const register = new promClient.Registry();

// Default Node.js process metrics: CPU, memory (rss/heap/external), GC pauses,
// event loop lag, open file descriptors, etc. Standard prom-client output.
promClient.collectDefaultMetrics({
  register,
  prefix: 'oscar_node_',           // keep namespacing consistent
  // 5s buckets cover all common HTTP timeouts; finer is overkill for an HTTP runner.
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]
});

// ─── HTTP request duration ───────────────────────────────────────────────────
// One Histogram covers latency, request count (= sample count), and error
// rate (filter by status_code label). Buckets sized to OSCAR's expected
// distribution: most API calls are <100ms, anything over 5s is unusual.
// `listener` (#1205): `public` (pages, API) or `internal` (the run pods' calls,
// INTERNAL_PORT). 30 and 60 s since the recovery drill read "10" for requests
// that waited longer: the last bucket was the most it could say.
const httpDuration = new promClient.Histogram({
  name: 'oscar_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by listener/method/route/status_code',
  labelNames: ['listener', 'method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [register]
});

// ─── What a run costs the server's one thread (#1205) ────────────────────────
// Synchronous work done for each run, timed where it runs. Its rate (seconds
// a second) is the share of the thread it takes: when the shares add up to
// about 1, every page waits behind them.
// results_read (#1218) is the results file decrypted, parsed and planned, one
// block a run before the slices of results_store: its length is that block's.
const RUN_WORK_KINDS = ['datafile_copy', 'results_read', 'results_store'];
const runWork = new promClient.Histogram({
  name: 'oscar_run_work_seconds',
  help: "Synchronous work for a run on the server's thread, by kind: its data file copy, its results file read, its results stored",
  labelNames: ['work'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register]
});
// How big a run's Bruno results file is (#1218): what results_read reads.
const runResultsBytes = new promClient.Histogram({
  name: 'oscar_run_results_bytes',
  help: "Size of a run's Bruno results file, as stored, read by the server",
  buckets: [1e5, 5e5, 1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8],
  registers: [register]
});
// Every line of a run's log is an encrypted insert: counted and timed in total,
// a histogram per line would be too many observations for what it tells.
const runLogLines = new promClient.Counter({
  name: 'oscar_run_log_lines_total',
  help: 'Lines of runs\' logs stored',
  registers: [register]
});
const runLogSeconds = new promClient.Counter({
  name: 'oscar_run_log_seconds_total',
  help: "Time spent storing runs' log lines, on the server's thread",
  registers: [register]
});

// ─── The database's commits (#1221) ──────────────────────────────────────────
// Each COMMIT of transaction() (db.js), timed on the server's thread: the
// results slices and the run log batches (their commits are part of
// results_store and of the log lines' time above), and the other
// transactions. With synchronous FULL each one waits for the disk; with
// NORMAL (the default since #1224) only the one that copies the journal into
// the database file (a checkpoint) does. A
// statement written alone, outside a transaction, commits too and is not
// counted. 0.1 is a bound: the dashboard counts the commits above it.
const dbCommitSeconds = new promClient.Histogram({
  name: 'oscar_db_commit_seconds',
  help: "Time of each database COMMIT of a transaction, on the server's thread",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

// The server connection's synchronous mode (#1224), set by server.js at start:
// 1 NORMAL (the default), 2 FULL (OSCAR_DB_SYNCHRONOUS=FULL). A PRAGMA asked
// on a connection of its own reads that connection's mode, not the server's.
const dbSynchronous = new promClient.Gauge({
  name: 'oscar_db_synchronous',
  help: "SQLite's synchronous mode on the server's connection: 0 off, 1 normal, 2 full, 3 extra",
  registers: [register]
});

// The checkpoints of the thread of their own (#1230, db.js
// startCheckpointThread()): the time of each, off the server's thread; the
// write-ahead log's size at the last one and what it could not copy (pages a
// reader still used), in frames of one page; and whether that thread
// checkpoints (1) or the server's connection does in its COMMITs (0:
// OSCAR_DB_CHECKPOINTS=inline, or the thread stopped).
const dbCheckpointSeconds = new promClient.Histogram({
  name: 'oscar_db_checkpoint_seconds',
  help: "Time of each passive checkpoint of the database's checkpoint thread (not the server's thread)",
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});
const dbWalFrames = new promClient.Gauge({
  name: 'oscar_db_wal_frames',
  help: 'Frames (pages) in the write-ahead log at the last checkpoint of the checkpoint thread',
  registers: [register]
});
const dbWalFramesNotCopied = new promClient.Gauge({
  name: 'oscar_db_wal_frames_not_copied',
  help: 'Frames of the write-ahead log that the last checkpoint could not copy into the database file',
  registers: [register]
});
const dbCheckpointThread = new promClient.Gauge({
  name: 'oscar_db_checkpoint_thread',
  help: "1 while a thread of its own checkpoints the database, 0 when the server's connection does in its COMMITs",
  registers: [register]
});

/** Times `fn` (synchronous) as run work of `kind`, and gives its result. */
function timeRunWork(kind, fn) {
  const end = runWork.startTimer({ work: kind });
  try {
    return fn();
  } finally {
    end();
  }
}

// Run work done in slices, with other requests served between them (#1214):
// `time(fn)` runs one slice and adds its time, `done()` observes the sum once
// as the run's work. The waits between slices are not the thread's work.
function runWorkClock(kind) {
  let spent = 0n;
  return {
    time(fn) {
      const started = process.hrtime.bigint();
      try {
        return fn();
      } finally {
        spent += process.hrtime.bigint() - started;
      }
    },
    done() {
      runWork.observe({ work: kind }, Number(spent) / 1e9);
    },
  };
}

// ─── Bruno run lifecycle ─────────────────────────────────────────────────────
// Counter incremented when a run transitions to a terminal status. Don't
// double-count when a job re-enters the queue or restarts on failure.
const runsTotal = new promClient.Counter({
  name: 'oscar_runs_total',
  help: 'Number of Bruno runs that reached a terminal status',
  labelNames: ['status'],   // COMPLETED | FAILED | CANCELLED | TIMEOUT
  registers: [register]
});

// Live gauges — point-in-time snapshot of the worker queue. Updated by
// queue.js whenever a job is added/removed/started/finished.
const queueDepth = new promClient.Gauge({
  name: 'oscar_queue_depth',
  help: 'Number of QUEUED runs awaiting a worker slot',
  registers: [register]
});

const activeRuns = new promClient.Gauge({
  name: 'oscar_active_runs',
  help: 'Number of currently RUNNING Bruno runs',
  registers: [register]
});

// ─── Runs by company or provider (#1017) ─────────────────────────────────────
// Labels: the company's name and its distributor's (empty for a top-level
// company); never a user. See utils/companyRunMetrics.js.
const COMPANY_LABELS = ['company', 'distributor'];
const companyRunsRunning = new promClient.Gauge({
  name: 'oscar_company_runs_running',
  help: 'Runs going, by company or provider',
  labelNames: COMPANY_LABELS,
  registers: [register]
});
const companyRunsQueued = new promClient.Gauge({
  name: 'oscar_company_runs_queued',
  help: 'Runs waiting for a slot, by company or provider',
  labelNames: COMPANY_LABELS,
  registers: [register]
});
const companyRunsFinished = new promClient.Counter({
  name: 'oscar_company_runs_finished_total',
  help: 'Runs ended, by company or provider and status',
  labelNames: [...COMPANY_LABELS, 'status'],
  registers: [register]
});
const companyRunRequests = new promClient.Counter({
  name: 'oscar_company_run_requests_total',
  help: 'Requests the runs made to the provider, counted when each run ends, by company or provider',
  labelNames: COMPANY_LABELS,
  registers: [register]
});

// ─── Run pods (RUN_ISOLATION=pod, #1130) ─────────────────────────────────────
// How long a run waits for its pod, and how its pod ended. Written in pod mode
// only (worker/runner.js); the outcomes are RUN_POD_OUTCOMES.
const RUN_POD_OUTCOMES = Object.freeze(['ran', 'deadline', 'not_started', 'stopped', 'refused']);
const runPodStart = new promClient.Histogram({
  name: 'oscar_run_pod_start_seconds',
  help: 'Seconds from asking the run dispatcher for a run to its pod running',
  buckets: [1, 2, 5, 10, 20, 30, 60, 120, 300],
  registers: [register]
});
const runPodsEnded = new promClient.Counter({
  name: 'oscar_run_pods_ended_total',
  help: 'Run pods ended, by outcome: ran (Bruno ended), deadline, not_started, stopped, refused (by the dispatcher, or it was lost)',
  labelNames: ['outcome'],
  registers: [register]
});

// ─── Auth ────────────────────────────────────────────────────────────────────
const loginAttempts = new promClient.Counter({
  name: 'oscar_login_attempts_total',
  help: 'Login attempts by result',
  labelNames: ['result'],   // success | failure
  registers: [register]
});

// ─── Mailer ──────────────────────────────────────────────────────────────────
const smtpSends = new promClient.Counter({
  name: 'oscar_smtp_send_total',
  help: 'SMTP send attempts by result',
  labelNames: ['result', 'kind'],   // success|failure × verification|password_reset|test
  registers: [register]
});

// ─── Express middleware to record HTTP duration ──────────────────────────────
// Records every response. Uses res.on('finish') so 404s / errors / streamed
// responses are all captured.

/**
 * The `route` label (#1196): the router's mount path and the matched route's
 * pattern ("/v1/runs", "/v1/runs/:id", "/v1/company/datafile"), never the
 * address asked, so ids do not make a label each. The route's pattern alone
 * read "/" for the root of every router (the run list, a batch, the company,
 * the providers…), and the mount paths are fixed (server.js mounts no
 * router on a path with a parameter). Without a route: the router's path
 * when a router stopped the request (401, 429), the file's path for a static
 * file served, else "unmatched", so an address a scanner tries is not a
 * label of its own.
 */
function routeLabel(req, statusCode) {
  const base = req.baseUrl || '';
  const routePath = req.route?.path;
  if (routePath !== undefined) {
    const pattern = String(routePath);
    return base && pattern === '/' ? base : base + pattern;
  }
  if (base) return base;
  if ((statusCode < 300 || statusCode === 304) && req.path) return req.path;
  return 'unmatched';
}

/** The middleware for one listener: `public` (the app) or `internal` (#1205). */
function httpDurationMiddlewareFor(listener) {
  return function httpDurationMiddleware(req, res, next) {
    const endTimer = httpDuration.startTimer();
    res.on('finish', () => {
      const route = routeLabel(req, res.statusCode);
      endTimer({
        listener,
        method:      req.method,
        route,
        status_code: String(res.statusCode)
      });
    });
    next();
  };
}
const httpDurationMiddleware = httpDurationMiddlewareFor('public');

module.exports = {
  register,
  httpDurationMiddleware,
  httpDurationMiddlewareFor,
  routeLabel,
  RUN_WORK_KINDS,
  runWork,
  runResultsBytes,
  runLogLines,
  runLogSeconds,
  dbCommitSeconds,
  dbSynchronous,
  dbCheckpointSeconds,
  dbWalFrames,
  dbWalFramesNotCopied,
  dbCheckpointThread,
  timeRunWork,
  runWorkClock,
  runsTotal,
  queueDepth,
  activeRuns,
  companyRunsRunning,
  companyRunsQueued,
  companyRunsFinished,
  companyRunRequests,
  RUN_POD_OUTCOMES,
  runPodStart,
  runPodsEnded,
  loginAttempts,
  smtpSends
};
