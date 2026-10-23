// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulatorRuns.js — the test runs OSCAR sent to the OSDM simulator, counted
 * per provider and per user (#930, PR 4). Pure.
 *
 * A run went to the simulator when the endpoint it used (`runs.api_base_used`)
 * is under the simulator's address saved in Admin → OSDM Simulator; the
 * provider is the first path segment after it. OSCAR knows the sets (batches),
 * their scenarios (runs) and the checks that failed, so nothing is asked of
 * the simulator and nothing more is sent to it or to any other provider.
 *
 * Counts only: no scenario code, check text, body or endpoint leaves here.
 */

const PROVIDER = /^[a-z][a-z0-9-]{1,30}$/;

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

function trimSlashes(path) {
  let p = path;
  while (p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/** The simulator provider an endpoint names, or null when it is not under the simulator's address. */
function providerOfBase(apiBase, simulatorUrl) {
  if (typeof apiBase !== 'string' || typeof simulatorUrl !== 'string') return null;
  const sim = parse(simulatorUrl);
  if (sim === null) return null;
  const base = parse(apiBase.trim());
  if (base?.origin !== sim.origin) return null;
  const prefix = `${trimSlashes(sim.pathname)}/`;
  if (!base.pathname.startsWith(prefix)) return null;
  const provider = base.pathname.slice(prefix.length).split('/')[0];
  return PROVIDER.test(provider) ? provider : null;
}

const zero = () => ({ sets: new Set(), scenarios: 0, scenariosFailed: 0, failedChecks: 0 });

function add(target, row) {
  // A run without a batch (older runs) is a set of its own.
  target.sets.add(row.batch_id || `run:${row.id}`);
  target.scenarios += 1;
  const failed = Number.isInteger(row.failed_checks) && row.failed_checks > 0 ? row.failed_checks : 0;
  if (failed > 0) target.scenariosFailed += 1;
  target.failedChecks += failed;
}

function view(c) {
  const sets = c.sets.size;
  return {
    sets,
    scenarios: c.scenarios,
    scenariosPerSet: sets ? Math.round((c.scenarios / sets) * 10) / 10 : 0,
    scenariosFailed: c.scenariosFailed,
    failedChecks: c.failedChecks,
  };
}

/**
 * Rows { id, api_base_used, batch_id, email, failed_checks } → per provider
 * (sorted), its users (sorted) and its total. Rows not sent to the simulator
 * are left out.
 */
function summarise(rows, simulatorUrl) {
  const byProvider = new Map();
  for (const row of rows) {
    const provider = providerOfBase(row.api_base_used, simulatorUrl);
    if (!provider) continue;
    if (!byProvider.has(provider)) byProvider.set(provider, { total: zero(), users: new Map() });
    const p = byProvider.get(provider);
    const user = typeof row.email === 'string' ? row.email : '';
    if (!p.users.has(user)) p.users.set(user, zero());
    add(p.total, row);
    add(p.users.get(user), row);
  }
  return [...byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([provider, p]) => ({
    provider,
    totals: view(p.total),
    users: [...p.users].sort(([a], [b]) => a.localeCompare(b)).map(([email, c]) => ({ email, ...view(c) })),
  }));
}

module.exports = { providerOfBase, summarise };
