// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runFilters.js — what a batch runs, chosen at launch (#1029). Pure.
 *
 * Every scenario of the data file has four facets, all computed, none tagged
 * by hand:
 *  - category: `simulated` for the simulator's deliberate errors (a code
 *    `SIM_WRONG_` / `SIM_FAULT_`, or a scenario naming `simulatorFaults`),
 *    `refusal` for an expected refusal (`isRefusalTest()`: the `NHF_` codes
 *    and the refusal probes), else `happy`;
 *  - group: the group of its main capability, as the coverage report reads
 *    it (the catalogue entry's capability, else `derivedCapability()`);
 *  - form: the form of its offer request (`offerRequestFormOf()`);
 *  - its latest finished run: `never`, `failed` (a check failed, or the run
 *    ended FAILED) or `passed`, and whether it is to run again (never run, or
 *    older than the collection or the scenario, or not known).
 *
 * A selection { base, categories, groups, forms, lastRun } keeps the
 * scenarios whose facets are all ticked: AND between the filters, OR within
 * one. `base` is `all` (every scenario the person sees) or `list` (their run
 * list); the route reads it.
 */

const K = require('./capabilities');
const { offerRequestFormOf } = require('./frameworkGating');
const { catalogueEntryForScenario } = require('./scenarioCatalogue');
const { scenarioHash, toRunAgain } = require('./frameworkCoverage');

const CATEGORIES = Object.freeze(['happy', 'refusal', 'simulated']);
const CATEGORY_TEXT = Object.freeze({ happy: 'Happy flows', refusal: 'Expected refusals', simulated: 'Simulated errors' });
const FORMS = Object.freeze(['SEARCH', 'SPECIFICATION', 'TRIP_IDS']);
const FORM_TEXT = Object.freeze({ SEARCH: 'Search', SPECIFICATION: 'Specification', TRIP_IDS: 'Trip id' });
const BASES = Object.freeze(['all', 'list']);
const LAST_RUNS = Object.freeze(['all', 'toRunAgain', 'failed']);
const LAST_RUN_TEXT = Object.freeze({ all: 'All', toRunAgain: 'To run again', failed: 'Failed at the last run' });
const SELECTION_KEYS = Object.freeze(['base', 'categories', 'groups', 'forms', 'lastRun']);

/** What the page starts with: happy flows and expected refusals, everything else. */
const DEFAULT_SELECTION = Object.freeze({
  base: 'all', categories: ['happy', 'refusal'], groups: [...K.GROUPS], forms: [...FORMS], lastRun: 'all',
});

const SIMULATED_CODE = /^SIM_(?:WRONG|FAULT)_/;
const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v : '');

// A scenario that asks the simulator for faults (#833), whatever its code.
const namesFaults = (scenario) => (Array.isArray(scenario.simulatorFaults)
  ? scenario.simulatorFaults.length > 0
  : text(scenario.simulatorFaults).trim() !== '');

/** happy, refusal or simulated. */
function categoryOf(scenario) {
  if (!isObj(scenario)) return 'happy';
  if (SIMULATED_CODE.test(text(scenario.code)) || namesFaults(scenario)) return 'simulated';
  return K.isRefusalTest(scenario) ? 'refusal' : 'happy';
}

/** The group of the scenario's main capability, as the coverage report reads it. */
function groupOf(scenario, datafile, entries) {
  const entry = catalogueEntryForScenario(scenario.code, arr(entries));
  const capability = K.CAPABILITY.has(entry?.capability) ? entry.capability : K.derivedCapability(scenario, datafile);
  const group = K.CAPABILITY.get(capability)?.group;
  return K.GROUPS.includes(group) ? group : 'Sale';
}

/** SEARCH, SPECIFICATION or TRIP_IDS. */
function formOf(scenario, datafile) {
  const form = offerRequestFormOf(scenario, datafile);
  return FORMS.includes(form) ? form : 'SEARCH';
}

/**
 * What the latest finished run says ({ status, failed, collection_version,
 * scenario_hash } or nothing): { lastRun, toRunAgain }.
 */
function lastRunOf(run, scenario, collectionVersion) {
  if (!isObj(run)) return { lastRun: 'never', toRunAgain: true };
  const failed = run.status === 'FAILED' || Number(run.failed) > 0;
  // Unknown (a run from before the versions were recorded) counts as to run again.
  const again = toRunAgain(run, { collectionVersion, hash: scenarioHash(scenario) }) !== false;
  return { lastRun: failed ? 'failed' : 'passed', toRunAgain: again };
}

/**
 * The facets of each scenario named in `codes`, in that order:
 * [{ code, category, group, form, lastRun, toRunAgain }]. `runs` maps a code
 * to its latest finished run.
 */
function facetsOf(codes, { datafile, entries = [], runs = {}, collectionVersion = null } = {}) {
  const byCode = new Map(arr(datafile?.scenarios).filter((s) => isObj(s) && typeof s.code === 'string').map((s) => [s.code, s]));
  return arr(codes).filter((code) => byCode.has(code)).map((code) => {
    const scenario = byCode.get(code);
    return {
      code, category: categoryOf(scenario), group: groupOf(scenario, datafile, entries), form: formOf(scenario, datafile),
      ...lastRunOf(runs?.[code], scenario, collectionVersion),
    };
  });
}

// One list of the selection: every value known, each once.
function listProblem(value, known, name) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `selection.${name} must be a list`;
  const unknown = value.filter((v) => !known.includes(v));
  if (unknown.length > 0) return `selection.${name}: unknown value ${JSON.stringify(String(unknown[0])).slice(0, 60)} (known: ${known.join(', ')})`;
  return null;
}

/** Why a selection cannot be used, as a sentence; null when it can. */
function selectionProblem(selection) {
  if (!isObj(selection)) return 'selection must be an object';
  const extra = Object.keys(selection).find((k) => !SELECTION_KEYS.includes(k));
  if (extra) return `selection.${extra.slice(0, 40)} is not known (known: ${SELECTION_KEYS.join(', ')})`;
  if (selection.base !== undefined && !BASES.includes(selection.base)) return `selection.base must be one of ${BASES.join(', ')}`;
  if (selection.lastRun !== undefined && !LAST_RUNS.includes(selection.lastRun)) return `selection.lastRun must be one of ${LAST_RUNS.join(', ')}`;
  return listProblem(selection.categories, CATEGORIES, 'categories')
    || listProblem(selection.groups, K.GROUPS, 'groups')
    || listProblem(selection.forms, FORMS, 'forms');
}

/** A selection with every missing key at its default. Call after selectionProblem(). */
function withDefaults(selection) {
  const s = isObj(selection) ? selection : {};
  return {
    base: s.base ?? DEFAULT_SELECTION.base,
    categories: s.categories ?? [...DEFAULT_SELECTION.categories],
    groups: s.groups ?? [...DEFAULT_SELECTION.groups],
    forms: s.forms ?? [...DEFAULT_SELECTION.forms],
    lastRun: s.lastRun ?? DEFAULT_SELECTION.lastRun,
  };
}

/** Whether a scenario's facets are all ticked. */
function keeps(facet, selection) {
  if (!selection.categories.includes(facet.category)) return false;
  if (!selection.groups.includes(facet.group) || !selection.forms.includes(facet.form)) return false;
  if (selection.lastRun === 'toRunAgain') return facet.toRunAgain;
  if (selection.lastRun === 'failed') return facet.lastRun === 'failed';
  return true;
}

/** The codes a selection keeps, in the order of `facets`. */
function selectCodes(facets, selection) {
  const s = withDefaults(selection);
  return arr(facets).filter((f) => keeps(f, s)).map((f) => f.code);
}

/**
 * What the page shows before a launch: how many scenarios the base holds
 * (`total`), how many the selection keeps (`selected`), and how many of the
 * base each value holds, filter by filter (`counts`), with the labels.
 */
function previewOf(facets, selection) {
  const list = arr(facets);
  const tally = (values, key) => Object.fromEntries(values.map((v) => [v, list.filter((f) => f[key] === v).length]));
  return {
    total: list.length,
    selected: selectCodes(list, selection).length,
    counts: {
      categories: tally(CATEGORIES, 'category'),
      groups: tally(K.GROUPS, 'group'),
      forms: tally(FORMS, 'form'),
      lastRun: { all: list.length, toRunAgain: list.filter((f) => f.toRunAgain).length, failed: list.filter((f) => f.lastRun === 'failed').length },
    },
    labels: { categories: CATEGORY_TEXT, groups: Object.fromEntries(K.GROUPS.map((g) => [g, g])), forms: FORM_TEXT, lastRun: LAST_RUN_TEXT },
  };
}

// How the values of one filter read: nothing when it keeps every value, the
// values when there are three or fewer, else how many.
function valuesText(values, all, text, many) {
  if (values.length === all.length && key(values) === key(all)) return null;
  if (values.length > 3) return `${values.length} ${many}`;
  return values.map((v) => text[v] || v).join(' + ');
}
// Code-unit order: the same list in any order gives the same key.
function byCodeUnits(a, b) {
  if (a === b) return 0;
  return String(a) < String(b) ? -1 : 1;
}
const key = (list) => [...list].sort(byCodeUnits).join('|');

/**
 * What a batch ran, in words (#1029 PR 3): "Expected refusals · Refund",
 * "Run list · Happy flows + Expected refusals · Failed at the last run". A
 * filter that keeps everything is not said, the categories always are.
 */
function selectionLabel(selection) {
  const s = withDefaults(selection);
  const parts = [];
  if (s.base === 'list') parts.push('Run list');
  const categories = s.categories.length === CATEGORIES.length
    ? 'Every category'
    : s.categories.map((c) => CATEGORY_TEXT[c] || c).join(' + ');
  parts.push(categories, valuesText(s.groups, K.GROUPS, {}, 'capabilities'), valuesText(s.forms, FORMS, FORM_TEXT, 'forms'));
  if (s.lastRun !== 'all') parts.push(LAST_RUN_TEXT[s.lastRun]);
  return parts.filter(Boolean).join(' · ');
}

module.exports = {
  selectionLabel,
  CATEGORIES, CATEGORY_TEXT, FORMS, FORM_TEXT, BASES, LAST_RUNS, LAST_RUN_TEXT, DEFAULT_SELECTION,
  categoryOf, groupOf, formOf, lastRunOf, facetsOf, selectionProblem, withDefaults, selectCodes, previewOf,
};
