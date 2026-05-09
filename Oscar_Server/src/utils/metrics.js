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
const httpDuration = new promClient.Histogram({
  name: 'oscar_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method/route/status_code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
});

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
// responses are all captured. The `route` label uses Express's matched route
// pattern (e.g. "/v1/runs/:id") instead of req.url, so high-cardinality IDs
// don't blow up the metrics cardinality.
function httpDurationMiddleware(req, res, next) {
  const endTimer = httpDuration.startTimer();
  res.on('finish', () => {
    const route = (req.route && req.route.path) || req.baseUrl || req.path || 'unknown';
    endTimer({
      method:      req.method,
      route,
      status_code: String(res.statusCode)
    });
  });
  next();
}

module.exports = {
  register,
  httpDurationMiddleware,
  runsTotal,
  queueDepth,
  activeRuns,
  loginAttempts,
  smtpSends
};
