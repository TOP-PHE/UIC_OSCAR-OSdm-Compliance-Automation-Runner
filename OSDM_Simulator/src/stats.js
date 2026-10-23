// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * stats.js — how much each account uses the simulator (#930, PR 3).
 *
 * Counted from what the simulator sees, at the end of each request: per day
 * (UTC), provider and account, the tokens issued, the OSDM requests, the
 * offers asked, the bookings made and confirmed, the refunds and exchanges
 * confirmed, and the answers in error. Nothing else is kept: no path, body,
 * header, address or time of day. Requests whose account is not known (a
 * refused token, a request without one) are counted for the provider only.
 *
 * Kept in `<data>/stats.json`, written at most once a minute and when the
 * simulator stops, and for `retentionDays` days.
 */

const fs = require('node:fs');
const path = require('node:path');
const { setInterval, clearInterval } = require('node:timers');
const { ConfigError, readJson } = require('./config');
const { writeAtomically } = require('./accounts');

const FORMAT = 1;
const STATS_FILE = 'stats.json';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;
const COUNTERS = ['tokens', 'requests', 'offers', 'bookings', 'confirmations', 'refunds', 'exchanges', 'clientErrors', 'serverErrors'];

const zero = () => Object.fromEntries(COUNTERS.map((c) => [c, 0]));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function addInto(target, counters) {
  for (const c of COUNTERS) target[c] += counters[c] || 0;
  return target;
}

/**
 * What a request counts for, from its method, its path after the provider and
 * its status: the counter names to add one to.
 */
// What a successful OSDM request did: offers, bookings, confirmations, refunds, exchanges.
function saleCounterOf(method, [resource, id, part, partId]) {
  if (resource === 'offers') return method === 'POST' && id === undefined ? 'offers' : null;
  if (resource !== 'bookings') return null;
  if (id === undefined) return method === 'POST' ? 'bookings' : null;
  const key = `${method} ${part}${partId === undefined ? '' : '/id'}`;
  return { 'POST fulfillments': 'confirmations', 'PATCH refund-offers/id': 'refunds', 'POST exchange-operations': 'exchanges' }[key] || null;
}

function countersOf({ method, segments, status }) {
  const out = [];
  if (status >= 500) out.push('serverErrors');
  else if (status >= 400) out.push('clientErrors');
  if (segments[0] === 'oauth') {
    if (status === 200) out.push('tokens');
    return out;
  }
  out.push('requests');
  const sale = status >= 200 && status < 300 ? saleCounterOf(method, segments) : null;
  if (sale) out.push(sale);
  return out;
}

function checkCounters(value) {
  return value && typeof value === 'object' && COUNTERS.every((c) => value[c] === undefined || (Number.isInteger(value[c]) && value[c] >= 0));
}

function readStatsFile(file) {
  const raw = readJson(file, 'the statistics file');
  if (raw?.format !== FORMAT || !raw.days || typeof raw.days !== 'object' || Array.isArray(raw.days)) {
    throw new ConfigError(`the statistics file is not a statistics file of format ${FORMAT} (${file})`);
  }
  for (const [day, byProvider] of Object.entries(raw.days)) {
    const ok = DAY.test(day) && byProvider && typeof byProvider === 'object'
      && Object.values(byProvider).every((p) => checkCounters(p?.unidentified || {})
        && p.clients && typeof p.clients === 'object' && Object.values(p.clients).every(checkCounters));
    if (!ok) throw new ConfigError(`the statistics file holds a day that is not valid (${file})`);
  }
  return raw.days;
}

// Add one day's counts into the per-provider sums; returns the day's total.
function addDay(perProvider, byProvider) {
  const total = zero();
  for (const [key, b] of Object.entries(byProvider)) {
    const target = perProvider.get(key);
    if (!target) continue;
    addInto(target.unidentified, b.unidentified);
    addInto(total, b.unidentified);
    for (const [client, counters] of Object.entries(b.clients)) {
      if (!target.clients.has(client)) target.clients.set(client, zero());
      addInto(target.clients.get(client), counters);
      addInto(total, counters);
    }
  }
  return total;
}

function checkPeriod(from, to) {
  const valid = (d) => DAY.test(d || '') && !Number.isNaN(Date.parse(d));
  if (!valid(from) || !valid(to) || from > to) throw new RangeError('from and to are days, YYYY-MM-DD, from not after to');
  if ((Date.parse(to) - Date.parse(from)) / 86400000 >= MAX_RANGE_DAYS) throw new RangeError(`at most ${MAX_RANGE_DAYS} days`);
}

/** Statistics of a data folder. `flushMs` 0: written only by flush(). */
function createStats({ dataDir, providers, now = Date.now, retentionDays = 400, flushMs = 60000 }) {
  const file = path.join(dataDir, STATS_FILE);
  const days = fs.existsSync(file) ? readStatsFile(file) : {};
  let dirty = false;

  function bucket(day, provider) {
    days[day] ||= {};
    days[day][provider] ||= { unidentified: zero(), clients: {} };
    return days[day][provider];
  }

  /** Count one request. `client` may be missing (refused or no token). */
  function record({ provider, client, method, segments, status }) {
    if (!provider || !providers.has(provider)) return;
    const names = countersOf({ method, segments, status });
    if (names.length === 0) return;
    const b = bucket(dayOf(now()), provider);
    let target = b.unidentified;
    if (client) {
      b.clients[client] ||= zero();
      target = b.clients[client];
    }
    for (const n of names) target[n] += 1;
    dirty = true;
  }

  function prune() {
    const oldest = dayOf(now() - retentionDays * 86400000);
    for (const day of Object.keys(days)) {
      if (day < oldest) {
        delete days[day];
        dirty = true;
      }
    }
  }

  /** Write the file when something changed since the last write. */
  function flush() {
    prune();
    if (!dirty) return;
    writeAtomically(file, `${JSON.stringify({ format: FORMAT, days })}\n`);
    dirty = false;
  }

  /**
   * The counters from `from` to `to` (YYYY-MM-DD, both included): per
   * provider, its accounts and its unidentified requests, and per day the
   * totals. Throws a RangeError for dates that are not valid.
   */
  function query({ from, to }) {
    checkPeriod(from, to);
    const perProvider = new Map([...providers.keys()].map((k) => [k, { unidentified: zero(), clients: new Map() }]));
    const daily = Object.keys(days).filter((day) => day >= from && day <= to).sort((a, b) => a.localeCompare(b))
      .map((day) => ({ day, ...addDay(perProvider, days[day]) }));
    return {
      from,
      to,
      counters: COUNTERS,
      providers: [...perProvider].map(([key, p]) => {
        const accounts = [...p.clients].sort(([a], [b]) => a.localeCompare(b)).map(([clientId, c]) => ({ clientId, ...c }));
        const totals = accounts.reduce((t, a) => addInto(t, a), addInto(zero(), p.unidentified));
        return { provider: key, name: providers.get(key).name, totals, unidentified: p.unidentified, accounts };
      }),
      daily,
    };
  }

  let timer = null;
  if (flushMs > 0) {
    timer = setInterval(() => {
      try { flush(); } catch { /* the next flush tries again; the counts stay in memory */ }
    }, flushMs);
    timer.unref();
  }

  function close() {
    if (timer) clearInterval(timer);
    flush();
  }

  return { record, flush, query, close };
}

module.exports = { createStats, countersOf, COUNTERS, STATS_FILE, MAX_RANGE_DAYS };
