// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reconcile.js — startup reconciliation of orphaned runs.
 *
 * The run queue (worker/queue.js) is an in-memory singleton: its pending-job
 * list and active-count live only in process memory. When the process exits —
 * a deploy (Watchtower promoting :stable), a crash, a SIGTERM from
 * RUN_TIMEOUT_MS, or `docker restart` — every queued/in-flight job is lost,
 * but the corresponding `runs` rows survive in SQLite as RUNNING / QUEUED.
 * Nothing will ever advance them again:
 *   - RUNNING rows stay RUNNING forever (their Bruno child process was killed);
 *   - QUEUED rows are never dispatched (the in-memory queue is empty on boot).
 * Both keep occupying the company's concurrency slots, so the dashboard's
 * "Company Queue" wedges at its limit and no new run can start. This is exactly
 * what was observed when a release auto-deployed in the middle of a batch run:
 * four orphaned RUNNING rows pinned all four slots and two QUEUED rows could
 * never start.
 *
 * Because the in-memory queue is empty at boot, ANY RUNNING/QUEUED row present
 * when this runs is — by definition — an orphan. We mark them all FAILED with
 * an explanatory message:
 *   - RUNNING cannot be resumed (the process is gone), so it must fail;
 *   - QUEUED is FAILED rather than auto-re-dispatched, by deliberate product
 *     decision. Re-running would fire vendor API calls unattended after every
 *     deploy (real tokens, sandbox traffic), possibly with stale credentials,
 *     and a crash-triggering run could re-loop. Testers resubmit if they still
 *     want those scenarios.
 *
 * Idempotent: a second call with no orphans changes nothing. Designed to be
 * called exactly once at startup — synchronously, after DB migrations have run
 * and before app.listen / before any new job is enqueued.
 *
 * Dependencies (db `run`, logger) are injectable for testing; production calls
 * pass no arguments and the real singletons are lazily required, so unit tests
 * that inject `run` never open a database.
 */

const RUNNING_MSG =
  'Interrupted by a server restart — the run process was terminated and cannot be resumed. Please resubmit.';
const QUEUED_MSG =
  'Cancelled by a server restart before this run started. Please resubmit.';

/**
 * @param {object}   [deps]
 * @param {function} [deps.run] - db run(sql, params) → { changes }
 * @param {object}   [deps.log] - logger with info/warn/error
 * @returns {{ running: number, queued: number, error?: string }}
 */
function reconcileOrphanedRuns(deps = {}) {
  const run = deps.run || require('../db/db').run;
  const log = deps.log || require('../utils/logger').child({ module: 'reconcile' });

  let running = 0;
  let queued = 0;

  try {
    const r1 = run(
      `UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE status = 'RUNNING'`,
      [RUNNING_MSG]
    );
    running = Number((r1 && r1.changes) || 0);

    const r2 = run(
      `UPDATE runs SET status = 'FAILED', completed_at = datetime('now'), error_message = ? WHERE status = 'QUEUED'`,
      [QUEUED_MSG]
    );
    queued = Number((r2 && r2.changes) || 0);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log.error({ err: msg }, 'Startup run reconciliation failed');
    return { running, queued, error: msg };
  }

  if (running > 0 || queued > 0) {
    log.warn(
      { runningOrphans: running, queuedOrphans: queued },
      'Startup reconciliation — failed orphaned runs left by a previous process exit'
    );
  } else {
    log.info('Startup reconciliation — no orphaned runs found');
  }

  return { running, queued };
}

module.exports = { reconcileOrphanedRuns, RUNNING_MSG, QUEUED_MSG };
