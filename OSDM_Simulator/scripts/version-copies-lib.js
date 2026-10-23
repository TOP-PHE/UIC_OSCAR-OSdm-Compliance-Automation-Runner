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
 * so the same scenario tests the same thing on each. `NOT_POSSIBLE` lists,
 * per version, the scenarios left out and why; `tests/datafile.test.js`
 * holds the data file to it, and `scripts/version-copies.js` appends the
 * copies that are missing.
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

/** The scenario `source` (a `_38` one) for `version`, or null when not possible. */
function copyOf(source, version) {
  const target = VERSIONS[version];
  if (!target || source?.osdmVersion !== SOURCE_VERSION) return null;
  if (reasonNotPossible(source, version)) return null;
  const code = `${baseOf(source.code)}_${target.suffix}`;
  const tail = `OSDM ${version}, for ${target.provider} (a copy of ${source.code}, #914).`;
  const description = String(source.description || '');
  const replaced = description.replace(/OSDM 3\.8\.0, for gamma\.\s*$/, tail);
  const adapted = withCurrencies(source, currenciesOf('gamma'), currenciesOf(target.provider));
  return { ...adapted, code, osdmVersion: version, description: replaced === description ? `${description} ${tail}`.trim() : replaced };
}

/** The copies the data file should hold and does not, in the order of their sources. */
function missingCopies(datafile) {
  const scenarios = Array.isArray(datafile?.scenarios) ? datafile.scenarios : [];
  const codes = new Set(scenarios.map((s) => s?.code));
  const out = [];
  for (const version of Object.keys(VERSIONS)) {
    for (const source of scenarios) {
      const copy = copyOf(source, version);
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

/**
 * The data file's text with `copies` appended at the end of its scenarios,
 * the rest of the text untouched.
 */
function appendScenarios(text, copies) {
  if (copies.length === 0) return text;
  const start = text.indexOf('\n  "scenarios": [');
  const end = text.indexOf('\n  ],', start);
  if (start < 0 || end < 0) throw new Error('The data file has no scenarios array where expected.');
  const blocks = copies.map((c) => `    ${layout(c, 4)}`).join(',\n');
  return `${text.slice(0, end)},\n${blocks}${text.slice(end)}`;
}

module.exports = { SOURCE_VERSION, VERSIONS, NOT_POSSIBLE, reasonNotPossible, baseOf, copyOf, missingCopies, layout, appendScenarios };
