// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklistConfiguration.js — what a provider's filled set-up checklist
 * (#795) sets up in OSCAR, and what it would change (#862). Pure.
 *
 *  - The Test Framework: the company's current framework (the editor's
 *    defaults when it has none), each answered `fw.*` question placed over it
 *    by the rules of the simulator's references (`referenceConfiguration.js`,
 *    #838). What the checklist does not ask stays as it is. An answer OSCAR
 *    cannot place is listed in `unplaced`, never guessed; other modes and
 *    another OSDM version are placed here.
 *  - The Test Data: a train set per route of each service sheet (Part B), a
 *    journey per combination of Part C that is sold, its legs on those train
 *    sets. Local times get the offset of the station's zone today
 *    (`stationZones.js`); the collection moves it to the trip date.
 *  - The changes: the answers that changed since the checklist applied
 *    before, the framework values that change, the Test Data that would be
 *    added or removed. `previewHash()` names what was shown: the apply must
 *    carry it, so nothing is applied that the Test Manager did not see.
 */

const crypto = require('node:crypto');
const RC = require('./referenceConfiguration');
const { canonical, planTestData } = require('./configurationBundle');
const { isOsdmVersion } = require('./osdmVersion');
const { offsetOfStopPlace } = require('./stationZones');

const PT_MODES = Object.freeze(['TRAM', 'UNDERGROUND', 'BUS']);
const SHARED_MODES = Object.freeze(['SHARED_TAXI', 'TAXI', 'ON_DEMAND_SERVICE']);
const DAYS = Object.freeze(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
const TICKET_TYPES = Object.freeze(['IRT', 'NRT_NO_RESERVATION', 'NRT_OPTIONAL_RESERVATION', 'NIGHT_TRAIN', 'TOURISTIC']);
const MAX_SHOWN = 300;   // characters of an answer shown in a change

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const textOf = v => (typeof v === 'string' ? v.trim() : '');

// The ticked codes of a question ("fw.otherModes" → ["BUS"]).
function ticksOf(answers, name) {
  const prefix = `${name}=`;
  return Object.keys(answers).filter(t => t.startsWith(prefix) && answers[t] === true).map(t => t.slice(prefix.length));
}

// ── The Test Framework ──────────────────────────────────────────────────────

/**
 * The framework the checklist declares over `current` (null: the defaults).
 * { framework, unplaced: [question names] }.
 */
function frameworkOfChecklist(answers, current) {
  const unplaced = new Set();
  const framework = RC.frameworkFromChecklist(answers, { base: isObject(current) ? current : null, unplaced });

  // A8.3, other modes: urban transport and shared mobility, as the editor has
  // them (WIZ_PT_SUBMODES, WIZ_SHARED_SUBMODES). Ferry cannot be declared.
  if (unplaced.has('otherModes')) {
    unplaced.delete('otherModes');
    const modes = ticksOf(answers, 'fw.otherModes');
    const pt = modes.filter(m => PT_MODES.includes(m));
    const shared = modes.filter(m => SHARED_MODES.includes(m));
    framework.pt = { ...(isObject(framework.pt) ? framework.pt : {}), enabled: pt.length > 0, subModes: pt };
    framework.shared = { ...(isObject(framework.shared) ? framework.shared : {}), enabled: shared.length > 0, subModes: shared };
    if (modes.some(m => !PT_MODES.includes(m) && !SHARED_MODES.includes(m))) unplaced.add(`otherModes=${modes.filter(m => !PT_MODES.includes(m) && !SHARED_MODES.includes(m)).join(',')}`);
  }
  // A1.2 "other": a version the list does not offer (3.0.5…), taken when no
  // listed one is ticked and it is a version.
  if (unplaced.has('osdmVersion.other')) {
    const other = textOf(answers['fw.osdmVersion.other']);
    if (ticksOf(answers, 'fw.osdmVersion').length === 0 && isOsdmVersion(other)) {
      framework.osdmVersion = other;
      unplaced.delete('osdmVersion.other');
    }
  }
  return { framework, unplaced: [...unplaced].sort((a, b) => a.localeCompare(b)).map(n => `fw.${n}`) };
}

// ── The Test Data ───────────────────────────────────────────────────────────

// "urn:uic:stn:8503000", "8503000 Zürich HB" → the stop place's URN, or ''.
// A code of 7 or 8 digits is kept as written (some providers give the check
// digit too).
function stationOf(text) {
  const t = textOf(text);
  const urn = /urn:uic:stn:\d+/.exec(t);
  if (urn) return urn[0];
  const code = /(?:^|\D)(\d{7,8})(?!\d)/.exec(t);
  if (code) return `urn:uic:stn:${code[1]}`;
  const other = /urn:[^\s,;]+/.exec(t);
  return other ? other[0] : '';
}

// "8:05", "08.05", "08h05" → "08:05:00" with the station's offset when its
// zone is known, else without one.
function timeAt(text, station, atMs) {
  const m = /^(\d{1,2})[:.h](\d{2})/.exec(textOf(text));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return '';
  const time = `${m[1].padStart(2, '0')}:${m[2]}:00`;
  const offset = offsetOfStopPlace(station, atMs);
  return offset ? time + offset : time;
}

// "EuroCity, urn:uic:sbc:EC; operator urn:uic:rics:1185" → name, category, operator.
function productOf(text) {
  const t = textOf(text);
  const urns = t.match(/urn:[^\s,;]+/g) || [];
  const operatorAt = /operator\s*(?::\s*)?(urn:[^\s,;]+)/i.exec(t);
  const isOperator = u => /:(rics|carrier|operator)s?:/i.test(u);
  const operatorCode = operatorAt ? operatorAt[1] : (urns.find(isOperator) || '');
  const productCategoryRef = urns.find(u => u !== operatorCode && /(sbc|product-?category)/i.test(u))
    || urns.find(u => u !== operatorCode) || '';
  const head = t.split(/[,;]/)[0].trim();
  return { productCategoryName: head.startsWith('urn:') ? '' : head, productCategoryRef, operatorCode };
}

const stationLabel = urn => String(urn || '').slice(String(urn || '').lastIndexOf(':') + 1);

// The numbers n of the service sheets answered (svc1, svc2…).
function sheetsOf(answers) {
  const seen = new Set();
  for (const tag of Object.keys(answers)) {
    const m = /^svc(\d+)\./.exec(tag);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

// The rows of a table of the checklist: `prefix.<i>.<col>` → [{ row, ...cols }].
function rowsOf(answers, prefix, cols) {
  const rows = new Map();
  for (const [tag, value] of Object.entries(answers)) {
    if (!tag.startsWith(`${prefix}.`)) continue;
    const m = /^(\d+)\.([a-zA-Z]+)$/.exec(tag.slice(prefix.length + 1));
    if (!m || !cols.includes(m[2])) continue;
    const row = Number(m[1]);
    if (!rows.has(row)) rows.set(row, { row });
    rows.get(row)[m[2]] = textOf(value);
  }
  return [...rows.values()].sort((a, b) => a.row - b.row);
}

/**
 * The Test Data a checklist names: { resources, skipped }. Trains have ids
 * 1, 2…, journeys after them; the import gives them new ids
 * (configurationBundle.planTestData), as for a full configuration (#810).
 */
function testDataOfChecklist(answers, { atMs = Date.now() } = {}) {
  const ctx = { answers, atMs, trains: [], skipped: [], byRoute: new Map() };
  trainsOfServiceSheets(ctx);
  const journeys = journeysOfCombinations(ctx);
  const { trains, skipped } = ctx;
  const resources = [...trains, ...journeys.map((j, i) => ({ id: trains.length + i + 1, ...j }))];
  // A time whose station has no known zone keeps no offset: the collection
  // moves only an offset its zone uses (#772), so one guessed here would be an
  // hour off half the year.
  const noOffset = trains.filter(t => t.data.services.some(sv => /^\d{2}:\d{2}:\d{2}$/.test(sv.departureTime))).length;
  const notes = noOffset ? [`${noOffset} train set(s) keep local times without a UTC offset: their stations have no 7-digit UIC code with a known country.`] : [];
  return { resources, skipped, notes };
}

const routeKey = (o, d) => `${o}|${d}`;

// The index of a service in a train set, added when it is not there yet.
function serviceIndexIn(train, service) {
  const same = train.data.services.findIndex(s => s.vehicleNumber === service.vehicleNumber && s.departureTime === service.departureTime);
  if (same >= 0) return same;
  train.data.services.push(service);
  return train.data.services.length - 1;
}

function emptyTrainData(originURN, destinationURN) {
  return {
    originURN, destinationURN, operatorCode: '', productCategoryRef: '', productCategoryName: '', productCategoryShortName: '',
    daysOfWeek: [], services: [], ticketTypes: [], travelClasses: [], serviceClasses: [], accommodations: [], ancillaries: [],
  };
}

function missingStationText(n, row, originURN, destinationURN) {
  const missing = [];
  if (!originURN) missing.push('for its origin');
  if (!destinationURN) missing.push('for its destination');
  return `Service sheet ${n}, service ${row.row}: no station code ${missing.join(' and ')}.`;
}

// One train set per service sheet and route, with the sheet's services.
function trainsOfServiceSheets(ctx) {
  const { answers, atMs, trains, skipped, byRoute } = ctx;
  for (const n of sheetsOf(answers)) {
    const s = `svc${n}`;
    const product = productOf(answers[`${s}.product`]);
    const kind = product.productCategoryName || ticksOf(answers, `${s}.mode`)[0] || 'service';
    for (const row of rowsOf(answers, `${s}.service`, ['origin', 'destination', 'departure', 'arrival', 'number'])) {
      const originURN = stationOf(row.origin);
      const destinationURN = stationOf(row.destination);
      if (!originURN || !destinationURN) {
        skipped.push(missingStationText(n, row, originURN, destinationURN));
        continue;
      }
      const key = `${n}|${routeKey(originURN, destinationURN)}`;
      let train = byRoute.get(key);
      if (!train) {
        train = {
          id: trains.length + 1,
          resource_type: 'TRAIN',
          label: `Sheet ${n}: ${kind} ${stationLabel(originURN)}–${stationLabel(destinationURN)}`,
          data: {
            ...emptyTrainData(originURN, destinationURN),
            ...product,
            daysOfWeek: ticksOf(answers, `${s}.daysOfWeek`).filter(d => DAYS.includes(d)),
            ticketTypes: ticksOf(answers, `${s}.ticketType`).filter(t => TICKET_TYPES.includes(t)),
            travelClasses: ticksOf(answers, `${s}.travelClasses`),
            serviceClasses: ticksOf(answers, `${s}.serviceClasses`),
            accommodations: ticksOf(answers, `${s}.accommodations`),
          },
        };
        trains.push(train);
        byRoute.set(key, train);
        if (!byRoute.has(routeKey(originURN, destinationURN))) byRoute.set(routeKey(originURN, destinationURN), train);
      }
      serviceIndexIn(train, {
        vehicleNumber: row.number || '',
        departureTime: timeAt(row.departure, originURN, atMs),
        arrivalTime: timeAt(row.arrival, destinationURN, atMs),
      });
    }
  }
}

// The legs of one journey table, or null when a leg names no station code.
function legsOfCombination(ctx, code, rows) {
  const { atMs, trains, byRoute } = ctx;
  const legs = [];
  for (const row of rows) {
    const originURN = stationOf(row.from);
    const destinationURN = stationOf(row.to);
    if (!originURN || !destinationURN) return null;
    let train = byRoute.get(routeKey(originURN, destinationURN));
    if (!train) {
      const data = emptyTrainData(originURN, destinationURN);
      if (TICKET_TYPES.includes(row.ticketType)) data.ticketTypes = [row.ticketType];
      train = {
        id: trains.length + 1,
        resource_type: 'TRAIN',
        label: `Journey ${code}, leg ${row.row}: ${stationLabel(originURN)}–${stationLabel(destinationURN)}`,
        data,
      };
      trains.push(train);
      byRoute.set(routeKey(originURN, destinationURN), train);
    }
    legs.push({
      trainResourceId: train.id,
      serviceIndex: serviceIndexIn(train, {
        vehicleNumber: row.train || '',
        departureTime: timeAt(row.departs, originURN, atMs),
        arrivalTime: timeAt(row.arrives, destinationURN, atMs),
      }),
    });
  }
  return legs;
}

// One journey per combination sold whose table gives two legs or more.
function journeysOfCombinations(ctx) {
  const { answers, trains, skipped } = ctx;
  const journeys = [];
  const combos = [...new Set(Object.keys(answers)
    .map(t => /^jrn\.(\w+)\.sold=(.+)$/.exec(t))
    .filter(m => m && answers[m[0]] === true && m[2] !== 'NO')
    .map(m => m[1]))].sort((a, b) => a.localeCompare(b));
  for (const code of combos) {
    const rows = rowsOf(answers, `jrn.${code}.leg`, ['from', 'to', 'departs', 'arrives', 'train', 'ticketType'])
      .filter(r => r.from || r.to || r.departs || r.train);
    const legs = legsOfCombination(ctx, code, rows);
    if (!legs || legs.length < 2) {
      skipped.push(`Journey ${code}: ${legs ? 'fewer than two legs given' : 'a leg has no station code'}.`);
      continue;
    }
    const first = trains.find(t => t.id === legs[0].trainResourceId).data;
    const last = trains.find(t => t.id === legs.at(-1).trainResourceId).data;
    journeys.push({ resource_type: 'JOURNEY', label: `Journey ${code}: ${stationLabel(first.originURN)}–${stationLabel(last.destinationURN)}, ${legs.length} legs`, data: { legs } });
  }
  return journeys;
}

// ── The changes ─────────────────────────────────────────────────────────────

// The answers by question: { name: { ticks: [sorted codes], text } }.
function byQuestion(answers) {
  const out = new Map();
  for (const [tag, value] of Object.entries(answers || {})) {
    const eq = tag.indexOf('=');
    const name = eq > 0 ? tag.slice(0, eq) : tag;
    if (!out.has(name)) out.set(name, { ticks: [], text: '' });
    if (eq > 0 && value === true) out.get(name).ticks.push(tag.slice(eq + 1));
    else if (eq < 0) out.get(name).text = textOf(value);
  }
  for (const q of out.values()) q.ticks.sort((a, b) => a.localeCompare(b));
  return out;
}

const shown = (q) => {
  if (!q) return null;
  const text = [q.ticks.join(', '), q.text].filter(Boolean).join(' — ');
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}…` : text;
};

/** The questions answered otherwise: [{ question, before, after }], by name. */
function answerChanges(before, after) {
  const a = byQuestion(before);
  const b = byQuestion(after);
  const names = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  const changes = [];
  for (const name of names) {
    const was = shown(a.get(name));
    const now = shown(b.get(name));
    if (was !== now) changes.push({ question: name, before: was, after: now });
  }
  return changes;
}

// Every value of a framework by its path; lists and scalars are leaves.
function leavesOf(value, path, out) {
  if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (key.startsWith('_')) continue;
      leavesOf(value[key], path ? `${path}.${key}` : key, out);
    }
  } else if (path) {
    out.set(path, value);
  }
  return out;
}

/** The framework values that differ: [{ path, before, after }], by path. */
function frameworkChanges(current, proposed) {
  const a = leavesOf(isObject(current) ? current : {}, '', new Map());
  const b = leavesOf(proposed, '', new Map());
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) => x.localeCompare(y));
  return paths
    .filter(p => canonical(a.get(p) ?? null) !== canonical(b.get(p) ?? null))
    .map(p => ({ path: p, before: a.has(p) ? a.get(p) : null, after: b.has(p) ? b.get(p) : null }));
}

/**
 * What the Test Data would become: `existing` the company's rows (data
 * parsed), `incoming` the checklist's, `mode` add or replace.
 */
function testDataChanges(existing, incoming, mode) {
  let n = 0;
  const plan = planTestData(existing, incoming, mode, () => `new-${++n}`);
  const byId = new Map((existing || []).map(r => [String(r.id), r]));
  return {
    mode,
    add: plan.create.map(r => ({ type: r.resource_type, label: r.label })),
    remove: plan.deleteIds.map(id => ({ type: byId.get(String(id))?.resource_type, label: byId.get(String(id))?.label || '' })),
    alreadyThere: plan.alreadyThere,
    unresolvedLegs: plan.unresolvedLegs,
  };
}

/** The hash of a preview: what the Test Manager saw, which the apply must carry. */
function previewHash(preview) {
  return crypto.createHash('sha256').update(canonical({
    import: preview.importId,
    framework: preview.proposedFramework,
    testData: preview.testData,
    incoming: preview.incomingTestData,
  })).digest('hex');
}

/**
 * The preview of applying `answers` to a company: `current` its framework
 * (or null), `existing` its Test Data rows, `previous` the answers applied
 * before (or null), `mode` add | replace.
 */
function previewOf({ importId, answers, previous, current, existing, mode, atMs }) {
  const { framework, unplaced } = frameworkOfChecklist(answers, current);
  const { resources, skipped, notes } = testDataOfChecklist(answers, { atMs });
  const preview = {
    importId,
    answerChanges: previous ? answerChanges(previous, answers) : null,
    framework: { changes: frameworkChanges(current, framework), unplaced, created: !isObject(current) },
    testData: testDataChanges(existing, resources, mode),
    skipped,
    notes,
    proposedFramework: framework,
    incomingTestData: resources,
  };
  preview.hash = previewHash(preview);
  return preview;
}

module.exports = {
  PT_MODES, SHARED_MODES,
  frameworkOfChecklist, testDataOfChecklist, stationOf, timeAt, productOf,
  answerChanges, frameworkChanges, testDataChanges, previewOf, previewHash,
};
