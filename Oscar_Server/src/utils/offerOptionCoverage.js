// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offerOptionCoverage.js — the offer request options in the coverage by
 * capability (#995). Pure.
 *
 * The options scenario (#227, `offerOptionDiscovery`) sends the offer request
 * with the mandatory parameters only, each optional parameter alone, random
 * combinations of those found supported, and all of them at once. Its report
 * reaches the server through the run log (`offerOptionReport.js`).
 *
 * Only a failed check made a point, so a reader of the coverage could not
 * tell whether the other parameters work, nor whether the combinations do.
 * Each result is stated here, in words. A point is still made only when:
 * - the mandatory request is not answered;
 * - a declared parameter is not taken;
 * - a combination is refused (#995).
 * A combination without offer is only stated: it can be legitimate.
 */

const { countsOf } = require('./offerOptionReport');

const MAX_PARAMETERS = 400;
const MAX_TEXT = 500;

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : '');
const intOrNull = (v) => (Number.isInteger(v) ? v : null);

// The words of each result, as the Report Builder's Offer Request Options card
// says them (`OFFER_OPTION_RESULTS` in the page; a test keeps the two alike).
const RESULT_TEXT = Object.freeze({
  honoured: 'Supported, kept to', accepted: 'Supported (nothing to check)',
  'ignored-said': 'Ignored, said', 'ignored-silent': 'Ignored, not said',
  'no-offer-said': 'No offer, said', 'no-offer-silent': 'No offer, not said',
  'invalid-said': 'Made-up value refused or said', 'invalid-silent': 'Made-up value taken without a word',
  refused: 'Refused', 'not-implemented': 'Not implemented', error: 'Error',
  'not-tested': 'Not tested', 'not-reached': 'Not reached (request budget)',
});

// The summary's groups, in reading order: [key, words, results].
const GROUPS = Object.freeze([
  ['supported', 'supported', ['honoured', 'accepted']],
  ['madeUpRefused', 'made-up value refused or said', ['invalid-said']],
  ['madeUpTaken', 'made-up value taken without a word', ['invalid-silent']],
  ['ignored', 'ignored', ['ignored-said', 'ignored-silent']],
  ['noOffer', 'no offer', ['no-offer-said', 'no-offer-silent']],
  ['refused', 'refused or not implemented', ['refused', 'not-implemented', 'error']],
  ['notTested', 'not tested', ['not-tested', 'not-reached']],
]);

// What a combination (or every parameter at once) got.
const COMBINATION_TEXT = Object.freeze({ answered: 'answered', 'no-offer': 'no offer', refused: 'refused', 'not-sent': 'not sent' });

/**
 * A combination's state: refused for a 4xx or 5xx (a point, #995), no offer,
 * answered for any other 2xx, not sent when no status came back.
 */
function combinationState(c) {
  const status = intOrNull(c?.status);
  if (status !== null && status >= 400 && status <= 599) return 'refused';
  if (String(c?.result || '').startsWith('no-offer')) return 'no-offer';
  if (status !== null && status >= 200 && status < 300) return 'answered';
  return 'not-sent';
}

const resultTextOf = (result) => (Object.hasOwn(RESULT_TEXT, result) ? RESULT_TEXT[result] : String(result || ''));

function summaryOf(report) {
  const counts = countsOf(report);
  const parameters = arr(report.options).length;
  const groups = GROUPS.map(([key, words, results]) => ({ key, words, count: results.reduce((n, r) => n + (counts[r] || 0), 0) }))
    .filter((g) => g.count > 0);
  const other = parameters - groups.reduce((n, g) => n + g.count, 0);
  if (other > 0) groups.push({ key: 'other', words: 'other', count: other });
  const states = arr(report.combinations).map(combinationState);
  const count = (state) => states.filter((s) => s === state).length;
  return {
    mandatory: isObj(report.mandatory) ? report.mandatory.ok === true : null,
    parameters,
    groups,
    combinations: { total: states.length, answered: count('answered'), noOffer: count('no-offer'), refused: count('refused'), notSent: count('not-sent') },
    all: isObj(report.all) ? combinationState(report.all) : null,
  };
}

/** The summary in one line, the same on the page, in the Markdown and in the workbook. */
function summaryText(s) {
  const parts = [];
  if (s.mandatory !== null) parts.push(`mandatory parameters only: ${s.mandatory ? 'answered' : 'NOT answered'}`);
  const groups = s.groups.map((g) => [g.count, g.words].join(' ')).join(', ');
  parts.push(groups ? `${s.parameters} parameter(s): ${groups}` : `${s.parameters} parameter(s)`);
  const c = s.combinations;
  if (c.total > 0) {
    const notSent = c.notSent ? `, ${c.notSent} not sent` : '';
    parts.push(`${c.total} combination(s): ${c.answered} answered, ${c.noOffer} without offer, ${c.refused} refused${notSent}`);
  }
  if (s.all) parts.push(`every supported parameter at once: ${COMBINATION_TEXT[s.all]}`);
  return parts.join(' · ');
}

function parameterOf(o) {
  const row = { option: text(o.option), status: intOrNull(o.status), result: text(o.result), resultText: resultTextOf(o.result) };
  if (o.value !== undefined && o.value !== null) row.value = text(String(o.value));
  if (o.source) row.source = text(o.source);
  if (typeof o.declared === 'boolean') row.declared = o.declared;
  if (o.message) row.message = text(o.message);
  return row;
}

function combinationOf(c) {
  const row = { options: arr(c.options).map(text), status: intOrNull(c.status), result: text(c.result), state: combinationState(c) };
  if (c.message) row.message = text(c.message);
  return row;
}

// Every supported parameter at once: how many, and what it got.
function allOf(a) {
  if (!isObj(a)) return null;
  const row = { count: intOrNull(a.count), status: intOrNull(a.status), result: text(a.result), state: combinationState(a) };
  if (a.message) row.message = text(a.message);
  return row;
}

/** One run's results: its scenario, run, the four phases and the summary. */
function entryOf({ code, run, report }) {
  const summary = summaryOf(report);
  return {
    code: text(code),
    runId: run?.id ?? null,
    at: run?.completed_at || run?.queued_at || null,
    version: report.version ?? null,
    budget: intOrNull(report.budget),
    used: intOrNull(report.used),
    mandatory: isObj(report.mandatory) ? { ok: report.mandatory.ok === true, message: text(report.mandatory.message) } : null,
    parameters: arr(report.options).slice(0, MAX_PARAMETERS).map(parameterOf),
    combinations: arr(report.combinations).map(combinationOf),
    all: allOf(report.all),
    summary,
    text: summaryText(summary),
  };
}

/**
 * The offer request options of the coverage: one entry per run holding a
 * report, the latest first. `items` are [{ code, run, report }].
 */
function offerOptionCoverageOf(items) {
  return arr(items).filter((i) => isObj(i) && isObj(i.report) && isObj(i.run)).map(entryOf)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')) || a.code.localeCompare(b.code));
}

/**
 * The coverage by capability with its options: the list, and the latest
 * run's summary on the capability's row.
 */
function withOfferOptions(byCapability, entries) {
  if (!isObj(byCapability) || arr(entries).length === 0) return byCapability;
  const withText = (rows) => arr(rows).map((c) => (c?.id === 'offers.requestOptions' ? { ...c, parameters: entries[0].text } : c));
  const out = { ...byCapability, capabilities: withText(byCapability.capabilities), offerOptions: entries };
  // #1053: the same line on the row of each distribution mode.
  if (Array.isArray(byCapability.byMode)) out.byMode = byCapability.byMode.map((m) => ({ ...m, capabilities: withText(m.capabilities) }));
  return out;
}

module.exports = { RESULT_TEXT, GROUPS, COMBINATION_TEXT, combinationState, summaryOf, summaryText, offerOptionCoverageOf, withOfferOptions };
