// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reconcile.test.js — startup orphan-run reconciliation (worker/reconcile.js).
 *
 * Two layers:
 *   1. Pure unit tests with an injected `run` — verify the control flow,
 *      returned counts, BigInt coercion and error swallowing without touching
 *      a database.
 *   2. A real-schema test against the per-process temp DB (setup.js) — proves
 *      the SQL runs against the actual `runs` table: orphaned RUNNING + QUEUED
 *      become FAILED, terminal runs are untouched, and it is idempotent.
 */

const { reconcileOrphanedRuns, RUNNING_MSG, QUEUED_MSG } = require('../../src/worker/reconcile');

function makeLog() {
  return { info() {}, warn() {}, error() {}, child() { return this; } };
}

describe('reconcileOrphanedRuns — unit (injected db)', () => {
  test('fails RUNNING then QUEUED orphans and returns the counts', () => {
    const calls = [];
    const run = (sql, params) => {
      calls.push({ sql, params });
      return { changes: /'RUNNING'/.test(sql) ? 4 : 2 };
    };
    const res = reconcileOrphanedRuns({ run, log: makeLog() });

    expect(res).toEqual({ running: 4, queued: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toMatch(/UPDATE runs SET status = 'FAILED'/);
    expect(calls[0].sql).toMatch(/WHERE status = 'RUNNING'/);
    expect(calls[0].params).toEqual([RUNNING_MSG]);
    expect(calls[1].sql).toMatch(/WHERE status = 'QUEUED'/);
    expect(calls[1].params).toEqual([QUEUED_MSG]);
  });

  test('no orphans → zero counts', () => {
    const res = reconcileOrphanedRuns({ run: () => ({ changes: 0 }), log: makeLog() });
    expect(res).toEqual({ running: 0, queued: 0 });
  });

  test('coerces node:sqlite BigInt changes to Number', () => {
    const run = (sql) => ({ changes: /'RUNNING'/.test(sql) ? 3n : 1n });
    expect(reconcileOrphanedRuns({ run, log: makeLog() })).toEqual({ running: 3, queued: 1 });
  });

  test('a DB error is caught (never throws at startup) and surfaced', () => {
    const res = reconcileOrphanedRuns({
      run: () => { throw new Error('database is locked'); },
      log: makeLog(),
    });
    expect(res.running).toBe(0);
    expect(res.queued).toBe(0);
    expect(res.error).toMatch(/database is locked/);
  });

  test('the two messages are distinct and mention a restart', () => {
    expect(RUNNING_MSG).not.toBe(QUEUED_MSG);
    expect(RUNNING_MSG).toMatch(/restart/i);
    expect(QUEUED_MSG).toMatch(/restart/i);
  });
});

describe('reconcileOrphanedRuns — against the real schema', () => {
  const { run, get } = require('../../src/db/db');
  const { randomUUID } = require('crypto');

  // runs.company_id / user_id are FK-constrained (schema.sql: PRAGMA
  // foreign_keys = ON), so seed a minimal company + user first.
  const companyId = randomUUID();
  const userId = randomUUID();

  beforeAll(() => {
    run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)',
      [companyId, 'Recon Test Co', 'recon-' + companyId.slice(0, 8)]);
    run('INSERT INTO users (id, company_id, email, password_hash) VALUES (?, ?, ?, ?)',
      [userId, companyId, 'recon-' + userId.slice(0, 8) + '@example.com', 'x']);
  });

  function insertRun(status) {
    const id = randomUUID();
    run('INSERT INTO runs (id, company_id, user_id, status) VALUES (?, ?, ?, ?)',
      [id, companyId, userId, status]);
    return id;
  }

  test('FAILs orphaned RUNNING + QUEUED, leaves terminal runs alone, is idempotent', () => {
    const r1 = insertRun('RUNNING');
    const r2 = insertRun('RUNNING');
    const q1 = insertRun('QUEUED');
    const done = insertRun('COMPLETED');
    const cancelled = insertRun('CANCELLED');

    const res = reconcileOrphanedRuns(); // real db + logger via defaults
    expect(res).toEqual({ running: 2, queued: 1 });

    for (const id of [r1, r2, q1]) {
      const row = get('SELECT status, error_message, completed_at FROM runs WHERE id = ?', [id]);
      expect(row.status).toBe('FAILED');
      expect(row.error_message).toMatch(/restart/i);
      expect(row.completed_at).not.toBeNull();
    }
    expect(get('SELECT status FROM runs WHERE id = ?', [done]).status).toBe('COMPLETED');
    expect(get('SELECT status FROM runs WHERE id = ?', [cancelled]).status).toBe('CANCELLED');

    // Second pass: nothing left to reconcile.
    expect(reconcileOrphanedRuns()).toEqual({ running: 0, queued: 0 });
  });
});
