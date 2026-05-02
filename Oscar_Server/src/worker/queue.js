// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * queue.js — In-process async job queue with per-company concurrency control
 *
 * Manages concurrent test runs with two levels of throttling:
 *   1. Global limit — MAX_CONCURRENT_RUNS env var (server-wide cap)
 *   2. Per-company limit — concurrentLimit on each job (from test framework config)
 *
 * Jobs are never refused — they stay in the queue until a slot opens.
 * A company at its limit doesn't block other companies' jobs.
 *
 * For batch jobs, a stagger delay (PARALLEL_STAGGER_MS) spaces out launches
 * to avoid overwhelming the provider API.
 *
 * Job object: { runId, companyId, concurrentLimit, scenarioOverride?, batchId?, scenarioCode?, userId? }
 */

const EventEmitter = require('events');
const { executeRun } = require('./runner');
const { getConfig }  = require('../db/db');
const log = require('../utils/logger').child({ module: 'queue' });

class RunQueue extends EventEmitter {
  constructor() {
    super();
    this._queue             = [];       // pending jobs
    this._running           = 0;        // global active count
    this._runningByCompany  = new Map(); // companyId → active job count
  }

  // Read config dynamically from DB on every drain — admin changes take effect immediately
  get maxConcurrent() { return parseInt(getConfig('MAX_CONCURRENT_RUNS', '10'), 10); }
  get staggerMs()     { return parseInt(getConfig('PARALLEL_STAGGER_MS', '2000'), 10); }

  enqueue(job) {
    this._queue.push(job);
    log.info({ runId: job.runId, companyId: job.companyId, scenario: job.scenarioCode || 'all', depth: this._queue.length }, 'Job enqueued');
    // Use setImmediate to allow all synchronous enqueue calls to complete first,
    // then drain once with all jobs in the queue.
    if (!this._drainScheduled) {
      this._drainScheduled = true;
      setImmediate(() => {
        this._drainScheduled = false;
        log.debug({ queue: this._queue.length, running: this._running }, 'Drain triggered');
        this._drain();
      });
    }
  }

  /**
   * Drain: start as many eligible jobs as possible.
   * Loops until no more slots available or no more eligible jobs.
   * For batch jobs, spaces out launches by staggerMs using setTimeout.
   */
  _drain() {
    let launched = 0;

    while (this._running < this.maxConcurrent && this._queue.length > 0) {
      // Find next job whose company hasn't hit its concurrent limit
      const jobIdx = this._queue.findIndex(job => {
        const companyRunning = this._runningByCompany.get(job.companyId) || 0;
        const limit = job.concurrentLimit || 1;
        log.debug({ runId: job.runId, companyRunning, limit, eligible: companyRunning < limit }, 'Drain check');
        return companyRunning < limit;
      });

      if (jobIdx === -1) {
        log.debug({ queue: this._queue.length, running: this._running }, 'No eligible jobs (all at company limit)');
        break;
      }

      const job = this._queue.splice(jobIdx, 1)[0];

      // Reserve the slot immediately (prevents over-scheduling)
      this._running++;
      this._runningByCompany.set(
        job.companyId,
        (this._runningByCompany.get(job.companyId) || 0) + 1
      );

      log.info({ runId: job.runId, scenario: job.scenarioCode || 'all', launched, running: this._running, queue: this._queue.length }, 'Scheduling job');
      setImmediate(() => this._launchJob(job));
      launched++;
    }
    log.debug({ launched, running: this._running, queue: this._queue.length }, 'Drain loop exited');
  }

  _launchJob(job) {
    log.info({ runId: job.runId, companyId: job.companyId, scenario: job.scenarioCode || 'all', running: this._running, companyRunning: this._runningByCompany.get(job.companyId), companyLimit: job.concurrentLimit || 1 }, 'Job starting');
    this.emit('started', job);

    executeRun(job)
      .then(result => {
        this._decrementCompany(job.companyId);
        this._running--;
        log.info({ runId: job.runId, scenario: job.scenarioCode || 'all', exitCode: result.exitCode }, 'Job completed');
        this.emit('completed', { ...job, ...result });
        this._drain();
      })
      .catch(err => {
        this._decrementCompany(job.companyId);
        this._running--;
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ runId: job.runId, err: errMsg }, 'Job errored');
        this.emit('failed', { ...job, error: errMsg });
        this._drain();
      });
  }

  _decrementCompany(companyId) {
    const current = this._runningByCompany.get(companyId) || 0;
    if (current <= 1) {
      this._runningByCompany.delete(companyId);
    } else {
      this._runningByCompany.set(companyId, current - 1);
    }
  }

  /**
   * Returns queue status for a specific company (used by queue-status API).
   */
  queueStatus(companyId) {
    const companyJobs = this._queue.filter(j => j.companyId === companyId);
    return {
      running: this._runningByCompany.get(companyId) || 0,
      queued:  companyJobs.length,
      jobs:    companyJobs.map(j => ({
        runId:        j.runId,
        scenarioCode: j.scenarioCode || null,
        userId:       j.userId || null,
        batchId:      j.batchId || null
      }))
    };
  }

  get depth()   { return this._queue.length; }
  get running() { return this._running; }
}

module.exports = new RunQueue();
