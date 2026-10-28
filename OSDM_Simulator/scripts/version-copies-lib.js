// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * version-copies-lib.js — every scenario written for gamma (OSDM 3.8, `_38`)
 * also exists for alpha (3.6, `_36`), beta (3.7, `_37`), delta (3.9, `_39`)
 * epsilon (3.10, `_310`, #920) and zeta (3.12 in development, `_312`, #925), unless the version cannot express it (#914). Pure.
 *
 * A copy is the `_38` scenario with its code, `osdmVersion` and description
 * changed, and gamma's currencies replaced by its provider's (CZK → its own,
 * EUR → its second one): the four providers have the same functions (#824),
 * so the same scenario tests the same thing on each. A trip naming gamma's
 * carrier (a trip specification's `operatorCode`) has a copy per provider
 * naming that provider's carrier, and a scenario's copy goes on its
 * provider's (#1022). `NOT_POSSIBLE` lists, per version, the scenarios left
 * out and why; `tests/datafile.test.js` holds the data file to it, and
 * `scripts/version-copies.js` brings the copies up to date.
 */

const SOURCE_VERSION = '3.8.0';
const VERSIONS = Object.freeze({
  '3.6.0': { suffix: '36', provider: 'alpha' },
  '3.7.0': { suffix: '37', provider: 'beta' },
  '3.9.0': { suffix: '39', provider: 'delta' },
  // #920: released 3.10 on epsilon. Its changes add optional members only,
  // so every `_38` scenario can be expressed.
  '3.10.0': { suffix: '310', provider: 'epsilon' },
  // #925: the version in development (OSDM master), on zeta. 3.11 and 3.12
  // add optional members and deprecations only, so far.
  '3.12.0': { suffix: '312', provider: 'zeta' },
});

// A provider's own currency and its second one, from its profile: a copy
// names its provider's currencies where the source names gamma's.
function currenciesOf(provider) {
  const profile = require(`../providers/${provider}.json`);
  return { own: profile.currency, other: Object.keys(profile.otherCurrencies || {})[0] };
}
const CURRENCY_FIELDS = new Set(['currency', 'expectedCurrency']);

// The source with gamma's currencies replaced by the provider's, in every
// `currency` / `expectedCurrency` member; another currency (one no provider
// sells, for a refusal) is kept.
function withCurrencies(value, from, to) {
  if (Array.isArray(value)) return value.map((v) => withCurrencies(v, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (CURRENCY_FIELDS.has(k) && typeof v === 'string') {
      if (v === from.own) return [k, to.own];
      if (v === from.other) return [k, to.other];
      return [k, v];
    }
    return [k, withCurrencies(v, from, to)];
  }));
}

// #1022: a provider's carrier, from its profile. A trip specification leg
// names the carrier whose train it asks for, so a copy names its provider's.
const carrierOf = (provider) => require(`../providers/${provider}.json`).carrier.ref;

// `value` with every text equal to `from` replaced by `to`, at any depth.
function withText(value, from, to) {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((v) => withText(v, from, to));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withText(v, from, to)]));
}

const namesText = (value, text) => JSON.stringify(withText(value, text, null)) !== JSON.stringify(value);

// The ids of the trips that name gamma's carrier: those a copy cannot share.
const carrierTripIds = (trips) => new Set((Array.isArray(trips) ? trips : [])
  .filter((t) => namesText(t, carrierOf('gamma'))).map((t) => t.id));

// The id of a trip's copy for `version`: the version's suffix, then the
// trip's id on two digits (trip 4 is 3604 for 3.6, 31204 for 3.12). Gamma's
// trips stay under 100, so no copy meets one of them or another copy.
function tripIdFor(id, version) {
  if (!Number.isInteger(id) || id < 1 || id > 99) throw new Error(`Trip ${id}: a trip naming gamma's carrier needs an id from 1 to 99 to be copied.`);
  return Number(`${VERSIONS[version].suffix}${String(id).padStart(2, '0')}`);
}

/** The trip `trip` (one naming gamma's carrier) for the provider of `version`. */
function tripCopyOf(trip, version) {
  const { provider } = VERSIONS[version];
  const adapted = withText(trip, carrierOf('gamma'), carrierOf(provider));
  // "where gamma offers seat preferences": every provider does (#824).
  const own = String(trip.description || '').trim().replaceAll(/\bgamma\b/g, provider);
  const sentence = own === '' || own.endsWith('.') ? own : `${own}.`;
  const description = `${sentence} On ${provider}'s carrier (a copy of trip ${trip.id}, #1022).`.trim();
  return { ...adapted, id: tripIdFor(trip.id, version), description };
}

// The trip slots of a scenario: its own and its exchange's (#959).
const TRIP_SLOTS = Object.freeze([
  { get: (s) => s?.tripRequirementId, set: (s, v) => ({ ...s, tripRequirementId: v }) },
  { get: (s) => s?.exchange?.tripRequirementId, set: (s, v) => ({ ...s, exchange: { ...s.exchange, tripRequirementId: v } }) },
]);

const NO_COMBINED_RETURN = 'OSDM 3.6 has no return in one offer (outboundTripIds and inboundDate come with 3.7).';
const NO_PRODUCT_SELECTIONS = 'OSDM 3.6 has no OfferSearchCriteria.productSelections (3.7).';
const NO_COMPARTMENT_SELECTION = 'OSDM before 3.8 has no PlaceSelection.compartments: a compartment cannot be named.';
const NO_FARE_REFUND_FEE = 'OSDM before 3.8 has no RefundSpecification.refundFee: the fee of a fare cannot be stated (#907).';
const NO_FARE_RESERVATION = 'OSDM before 3.8 has no distributionMode: a fare reservation cannot be told from a product one (#255; osdm.io, handling reservations).';
const rank = (version) => { const [a, b] = String(version).split('.').map(Number); return a * 100 + b; };

// Why a `_38` scenario has no copy for `version`, or null when it has one.
// By rule first (what the version's request schemas cannot express), then by
// name (what NOT_POSSIBLE lists, each with its reason).
function reasonNotPossible(source, version) {
  const criteria = source?.offerSearchCriteria || {};
  if (rank(version) < rank('3.7') && criteria.returnModel === 'COMBINED') return NO_COMBINED_RETURN;
  if (rank(version) < rank('3.7') && Array.isArray(criteria.productSelections) && criteria.productSelections.length > 0) return NO_PRODUCT_SELECTIONS;
  if (rank(version) < rank('3.8') && source?.namedPlaceKind === 'COMPARTMENT') return NO_COMPARTMENT_SELECTION;
  if (rank(version) < rank('3.8') && source?.fareRefundFee != null) return NO_FARE_REFUND_FEE;
  if (rank(version) < rank('3.8') && Array.isArray(criteria.requestedOfferParts) && criteria.requestedOfferParts.includes('FARE_RESERVATION')) return NO_FARE_RESERVATION;
  const named = NOT_POSSIBLE[version] || {};
  const base = baseOf(source?.code);
  return Object.hasOwn(named, base) ? named[base] : null;
}

// Per version: base code (without the version suffix) → why there is no copy,
// for what no rule above says.
const NOT_POSSIBLE = Object.freeze({
  '3.6.0': Object.freeze({}),
  '3.7.0': Object.freeze({}),
  '3.9.0': Object.freeze({}),
  '3.10.0': Object.freeze({}),
  '3.12.0': Object.freeze({}),
});

// `_38` and `_310` (#920): the version's major and minor.
const baseOf = (code) => String(code).replace(/_\d{2,3}$/, '');

/**
 * The scenario `source` (a `_38` one) for `version`, or null when not
 * possible. `trips` is the data file's `tripRequirements`: a copy goes on its
 * provider's copy of a trip that names gamma's carrier (#1022).
 */
function copyOf(source, version, trips) {
  const target = VERSIONS[version];
  if (!target || source?.osdmVersion !== SOURCE_VERSION) return null;
  if (!Array.isArray(trips)) throw new TypeError('copyOf() needs the data file\'s tripRequirements.');
  if (reasonNotPossible(source, version)) return null;
  const code = `${baseOf(source.code)}_${target.suffix}`;
  const tail = `OSDM ${version}, for ${target.provider} (a copy of ${source.code}, #914).`;
  const description = String(source.description || '');
  const replaced = description.replace(/OSDM 3\.8\.0, for gamma\.\s*$/, tail);
  const ownTrips = carrierTripIds(trips);
  let adapted = withText(withCurrencies(source, currenciesOf('gamma'), currenciesOf(target.provider)), carrierOf('gamma'), carrierOf(target.provider));
  for (const slot of TRIP_SLOTS) {
    const id = slot.get(adapted);
    if (ownTrips.has(id)) adapted = slot.set(adapted, tripIdFor(id, version));
  }
  return { ...adapted, code, osdmVersion: version, description: replaced === description ? `${description} ${tail}`.trim() : replaced };
}

/**
 * The trip copies the data file should hold, by id: each provider's copy of
 * every trip naming gamma's carrier that one of its scenario copies goes on,
 * in the order of the versions, then of the trips.
 */
function tripCopies(datafile) {
  const scenarios = Array.isArray(datafile?.scenarios) ? datafile.scenarios : [];
  const trips = Array.isArray(datafile?.tripRequirements) ? datafile.tripRequirements : [];
  const ownTrips = carrierTripIds(trips);
  const out = new Map();
  for (const version of Object.keys(VERSIONS)) {
    const named = new Set();
    for (const source of scenarios) {
      if (source?.osdmVersion !== SOURCE_VERSION || reasonNotPossible(source, version)) continue;
      for (const slot of TRIP_SLOTS) if (ownTrips.has(slot.get(source))) named.add(slot.get(source));
    }
    for (const trip of trips) if (named.has(trip.id)) out.set(tripIdFor(trip.id, version), tripCopyOf(trip, version));
  }
  return out;
}

/** The copies the data file should hold and does not, in the order of their sources. */
function missingCopies(datafile) {
  const scenarios = Array.isArray(datafile?.scenarios) ? datafile.scenarios : [];
  const codes = new Set(scenarios.map((s) => s?.code));
  const out = [];
  for (const version of Object.keys(VERSIONS)) {
    for (const source of scenarios) {
      const copy = copyOf(source, version, datafile.tripRequirements);
      if (copy && !codes.has(copy.code)) out.push(copy);
    }
  }
  return out;
}

// JSON in the data file's hand-kept layout: objects one member a line,
// arrays of plain values on one line.
function layout(value, indent) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value).replaceAll('","', '", "');
    if (value.length === 0) return '[]';
    const items = value.map((v) => pad + '  ' + layout(v, indent + 2));
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const members = entries.map(([k, v]) => pad + '  ' + JSON.stringify(k) + ': ' + layout(v, indent + 2));
    return `{\n${members.join(',\n')}\n${pad}}`;
  }
  return JSON.stringify(value);
}

// An entry of a root list as the data file writes it.
const blockOf = (value) => `    ${layout(value, 4)}`;

/** The text with `values` appended at the end of the root list `key`, the rest untouched. */
function appendTo(text, key, values) {
  if (values.length === 0) return text;
  const start = text.indexOf(`\n  ${JSON.stringify(key)}: [`);
  const end = start < 0 ? -1 : text.indexOf('\n  ]', start);
  if (start < 0 || end < 0) throw new Error(`The data file has no ${key} list where expected.`);
  return `${text.slice(0, end)},\n${values.map(blockOf).join(',\n')}${text.slice(end)}`;
}

// Where the entry `value` is written in the text: once, laid out as the
// script writes it, else the copy was edited by hand and is left to a person.
function placeOf(text, value) {
  const block = blockOf(value);
  const at = text.indexOf(block);
  if (at < 0 || text.indexOf(block, at + 1) >= 0) throw new Error(`Entry ${value.code || value.id} is not written once as the script writes it: change it by hand.`);
  return { at, length: block.length };
}

function replaceEntry(text, before, after) {
  const { at, length } = placeOf(text, before);
  return `${text.slice(0, at)}${blockOf(after)}${text.slice(at + length)}`;
}

function removeEntry(text, value) {
  const { at, length } = placeOf(text, value);
  if (text.slice(at - 2, at) !== ',\n') throw new Error(`Entry ${value.code || value.id} is the first of its list: remove it by hand.`);
  return `${text.slice(0, at - 2)}${text.slice(at + length)}`;
}

// A trip id tripIdFor() gives: a version's suffix, then two digits.
const isTripCopyId = (id) => Number.isInteger(id) && id >= 100
  && Object.values(VERSIONS).some(({ suffix }) => String(id).length === suffix.length + 2 && String(id).startsWith(suffix));

/**
 * The data file's text with its copies up to date (#914, #1022): trip copies
 * added, changed or removed, scenario copies changed (each keeps its own
 * description) or added. Only those entries are written; the rest of the text
 * is left as it is. Returns the text and what changed.
 */
function syncedText(text) {
  const done = { tripsAdded: 0, tripsChanged: 0, tripsRemoved: 0, added: 0, changed: 0 };
  let out = text;
  let datafile = JSON.parse(out);
  const wanted = tripCopies(datafile);
  for (const trip of datafile.tripRequirements) {
    if (!isTripCopyId(trip?.id)) continue;
    const want = wanted.get(trip.id);
    if (!want) {
      out = removeEntry(out, trip);
      done.tripsRemoved += 1;
    } else if (JSON.stringify(want) !== JSON.stringify(trip)) {
      out = replaceEntry(out, trip, want);
      done.tripsChanged += 1;
    }
  }
  const held = new Set(datafile.tripRequirements.map((t) => t?.id));
  const newTrips = [...wanted.values()].filter((t) => !held.has(t.id));
  out = appendTo(out, 'tripRequirements', newTrips);
  done.tripsAdded = newTrips.length;

  datafile = JSON.parse(out);
  const sources = new Map(datafile.scenarios.filter((s) => s?.osdmVersion === SOURCE_VERSION).map((s) => [baseOf(s.code), s]));
  for (const scenario of datafile.scenarios) {
    const source = scenario?.osdmVersion === SOURCE_VERSION ? null : sources.get(baseOf(scenario?.code));
    const copy = source ? copyOf(source, scenario.osdmVersion, datafile.tripRequirements) : null;
    if (!copy) continue;
    const want = { ...copy, description: scenario.description };
    if (JSON.stringify(want) !== JSON.stringify(scenario)) { out = replaceEntry(out, scenario, want); done.changed += 1; }
  }
  const missing = missingCopies(datafile);
  out = appendTo(out, 'scenarios', missing);
  done.added = missing.length;
  JSON.parse(out);
  return { text: out, done };
}

module.exports = {
  SOURCE_VERSION, VERSIONS, NOT_POSSIBLE, reasonNotPossible, baseOf, copyOf, missingCopies, layout,
  carrierOf, tripIdFor, tripCopyOf, tripCopies, isTripCopyId, syncedText,
};
