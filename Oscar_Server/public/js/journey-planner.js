// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Finding journeys among the defined trains (#711) ─────────────────────────
// A small journey planner over Test Data: given an origin and a destination,
// it chains the services of the TRAIN resources already defined into journeys
// of 2 or 3 legs. Nothing is asked of the provider.
//
// The rules are those a JOURNEY resource must keep (journeyContinuityWarnings
// in scenarios.js), made strict:
//   - a leg starts at the stop place where the previous one ends; codes are
//     compared without their leading zeros (005457076 = 5457076);
//   - it departs at least `minTransferMinutes` after the previous arrival, and
//     at most `maxWaitMinutes` after it;
//   - every leg runs on the trip date, since a journey's legs share it
//     (trip-apply.js): a service arriving after midnight can only end a
//     journey;
//   - no stop place twice (so no service twice either);
//   - the legs' operating days have a day in common (an empty list is every
//     day).
// Results are sorted by total duration, then legs, then departure.
//
// Loaded by scenarios.html before scenarios.js (browser global
// OscarJourneyPlanner) and required by the tests.
(function (root) {
  'use strict';

  const tripApply = root.OscarTripApply || require('./trip-apply.js');

  const DAY = 24 * 60;
  const DEFAULTS = Object.freeze({
    minLegs: 2, maxLegs: 3, minTransferMinutes: 5, maxWaitMinutes: 180, limit: 20,
  });
  // Partial chains looked at before the search gives up (and says so).
  const SEARCH_BUDGET = 200000;

  // A stop place as a comparable key: "urn:uic:stn:005457076", "5457076" and
  // "urn:uic:stn:5457076" are the same place. Empty text gives ''.
  function stopKey(value) {
    const s = String(value ?? '').trim();
    if (!s) return '';
    const urn = /^urn:/i.test(s) ? s : `urn:uic:stn:${s}`;
    const cut = urn.lastIndexOf(':');
    const prefix = urn.slice(0, cut).toLowerCase();
    let code = urn.slice(cut + 1);
    if (/^\d+$/.test(code)) code = code.replace(/^0+(?=\d)/, '');
    return `${prefix}:${code}`;
  }

  // "HH:MM", "HH:MM:SS", with an optional "Z" or "±HH:MM": { local, utc },
  // minutes since midnight on the clock as written and in UTC (which may be
  // below 0 or above a day). null when not a time.
  function parseTime(time) {
    const m = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(.*)$/.exec(String(time ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    const offset = offsetOf(m[3]);
    if (offset === null) return null;
    return { local: h * 60 + min, utc: h * 60 + min - offset };
  }

  // "", "Z", "+02:00", "+0200" or "-01:30": minutes east of UTC; null otherwise.
  function offsetOf(text) {
    if (text === '' || text.toUpperCase() === 'Z') return 0;
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(text);
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }

  // Days two calendars share. null stands for "every day"; [] for none.
  function commonDays(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    const inB = new Set(b);
    return a.filter((d) => inB.has(d));
  }

  // Every timed service of every TRAIN resource, as a leg candidate.
  function servicesOf(resources) {
    const out = [];
    for (const r of resources || []) {
      if (!r || (r.resource_type && r.resource_type !== 'TRAIN')) continue;
      if (r.id === null || r.id === undefined || r.id === '') continue;
      const d = tripApply.normalizeTrainData(tripApply.resourceData(r));
      const from = stopKey(d.originURN);
      const to = stopKey(d.destinationURN);
      if (!from || !to || from === to) continue;
      const days = Array.isArray(d.daysOfWeek) && d.daysOfWeek.length ? d.daysOfWeek.slice() : null;
      d.services.forEach((s, serviceIndex) => {
        const dep = parseTime(s.departureTime);
        const arr = parseTime(s.arrivalTime);
        if (!dep || !arr) return;
        // Arriving earlier on the clock than it left: after midnight.
        const nextDay = arr.local < dep.local ? DAY : 0;
        out.push({
          trainResourceId: r.id, serviceIndex, label: r.label || '',
          originURN: d.originURN, destinationURN: d.destinationURN, from, to,
          vehicleNumber: s.vehicleNumber, departureTime: s.departureTime, arrivalTime: s.arrivalTime,
          dep: dep.utc, arr: arr.utc + nextDay, days,
        });
      });
    }
    return out;
  }

  function settings(options) {
    const o = { ...DEFAULTS, ...options };
    const int = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= min && n <= max ? n : dflt;
    };
    o.maxLegs = int(o.maxLegs, 1, 3, DEFAULTS.maxLegs);
    o.minLegs = int(o.minLegs, 1, o.maxLegs, Math.min(DEFAULTS.minLegs, o.maxLegs));
    o.minTransferMinutes = int(o.minTransferMinutes, 0, DAY, DEFAULTS.minTransferMinutes);
    o.maxWaitMinutes = int(o.maxWaitMinutes, o.minTransferMinutes, DAY, Math.max(DEFAULTS.maxWaitMinutes, o.minTransferMinutes));
    o.limit = int(o.limit, 1, 200, DEFAULTS.limit);
    return o;
  }

  function journeyOf(chain, days) {
    const first = chain[0];
    const last = chain.at(-1);
    return {
      legs: chain.map((s) => ({ trainResourceId: s.trainResourceId, serviceIndex: s.serviceIndex })),
      steps: chain.map((s) => ({
        trainResourceId: s.trainResourceId, serviceIndex: s.serviceIndex, label: s.label,
        originURN: s.originURN, destinationURN: s.destinationURN, vehicleNumber: s.vehicleNumber,
        departureTime: s.departureTime, arrivalTime: s.arrivalTime,
      })),
      via: chain.slice(1).map((s) => s.originURN),
      waits: chain.slice(1).map((s, i) => s.dep - chain[i].arr),
      transfers: chain.length - 1,
      departureTime: first.departureTime,
      arrivalTime: last.arrivalTime,
      durationMinutes: last.arr - first.dep,
      startUtc: first.dep,
      days,
    };
  }

  // Whether `next` may follow `chain` (ending at `to`, settings `o`): the
  // days the journey would then run on (null = every day), or false.
  function followingDays(chain, seen, days, next, to, o) {
    const last = chain.at(-1);
    const wait = next.dep - last.arr;
    if (wait < o.minTransferMinutes || wait > o.maxWaitMinutes) return false;
    if (next.to === to ? chain.length + 1 < o.minLegs : seen.has(next.to)) return false;
    const shared = commonDays(days, next.days);
    return shared !== null && shared.length === 0 ? false : shared;
  }

  /**
   * Journeys from `origin` to `destination` among the TRAIN resources of
   * `resources`. Returns { journeys, truncated, error? }: `error` names a
   * missing origin or destination; `truncated` says the search stopped at its
   * budget, so a journey may be missing.
   */
  function planJourneys(resources, origin, destination, options) {
    const o = settings(options);
    const from = stopKey(origin);
    const to = stopKey(destination);
    if (!from || !to) return { journeys: [], truncated: false, error: 'Give an origin and a destination.' };
    if (from === to) return { journeys: [], truncated: false, error: 'The origin and the destination are the same stop place.' };

    const services = servicesOf(resources);
    const byOrigin = new Map();
    for (const s of services) {
      if (!byOrigin.has(s.from)) byOrigin.set(s.from, []);
      byOrigin.get(s.from).push(s);
    }
    for (const list of byOrigin.values()) list.sort((a, b) => a.dep - b.dep);

    const found = [];
    let looked = 0;
    let truncated = false;

    // Depth-first, one leg at a time; `seen` holds the stop places passed.
    const extend = (chain, seen, days) => {
      if (truncated) return;
      const last = chain.at(-1);
      if (last.to === to) {
        if (chain.length >= o.minLegs) found.push(journeyOf(chain, days));
        return;
      }
      // A leg after midnight ends past the day: no later leg of the trip date
      // leaves after it, so the wait below is negative and nothing follows.
      if (chain.length >= o.maxLegs) return;
      for (const next of byOrigin.get(last.to) || []) {
        if (++looked > SEARCH_BUDGET) { truncated = true; return; }
        const shared = followingDays(chain, seen, days, next, to, o);
        if (shared === false) continue;
        seen.add(next.to);
        extend([...chain, next], seen, shared);
        seen.delete(next.to);
      }
    };

    for (const first of byOrigin.get(from) || []) {
      if (truncated) break;
      if (first.to === from) continue;
      extend([first], new Set([from, first.to]), first.days);
    }

    found.sort((a, b) => a.durationMinutes - b.durationMinutes
      || a.legs.length - b.legs.length
      || a.startUtc - b.startUtc);
    return { journeys: found.slice(0, o.limit), total: found.length, truncated };
  }

  const api = Object.freeze({ planJourneys, stopKey, parseTime, commonDays, DEFAULTS, SEARCH_BUDGET });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarJourneyPlanner = api;
}(globalThis));
