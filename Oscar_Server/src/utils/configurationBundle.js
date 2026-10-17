// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * configurationBundle.js — a company's full configuration in one file (#810).
 *
 * Test Config's "Download JSON" gives the data file only. The Test Framework
 * and the Test Data trains and journeys are stored apart, so a data file taken
 * from one company or provider to another left both behind. A full
 * configuration holds the three:
 *
 *   { "__oscarConfiguration": { "format": 1, ... },
 *     "datafile": { ... } | null,
 *     "framework": { ... } | null,
 *     "testResources": [ { id, resource_type, label, data } ] }
 *
 * The root marker keeps it from being taken for a data file: the data-file
 * upload refuses it (NOT_THE_COMPANY_FILE in company.js). It never holds a
 * credential, a token, an endpoint or anything about a tester: the data file,
 * the framework and the resources hold none.
 *
 * Pure: no database, no file. The route in company.js reads and writes.
 *
 * Only journeys name other resources (legs[].trainResourceId). The data file
 * names none: "Apply test data" copies a train's values into the trip
 * (public/js/trip-apply.js). So when trains get new ids in the target, the
 * journeys' legs are the only references to remap.
 */

const CONFIGURATION_KEY = '__oscarConfiguration';
const CONFIGURATION_FORMAT = 1;

// The Test Data kinds a configuration carries. MULTIMODAL has no editor.
const RESOURCE_TYPES = Object.freeze(['TRAIN', 'JOURNEY']);

const MAX_RESOURCES = 5000;
const MAX_LABEL_LENGTH = 200;
// Deeper than any data file, framework or resource the pages write. The depth
// is the client's choice, and the server compares and stores these values with
// functions that recurse: refused before any of them runs.
const MAX_DEPTH = 64;

const SCENARIO_CHOICES = Object.freeze(['replace', 'keep']);
const FRAMEWORK_CHOICES = Object.freeze(['replace', 'keep']);
const TEST_DATA_CHOICES = Object.freeze(['add', 'replace', 'keep']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The depth of a value, read with a list rather than by recursion, and given
// up as soon as it passes `limit`.
function deeperThan(value, limit) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [v, depth] = pending.pop();
    if (v === null || typeof v !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Object.values(v)) {
      if (child !== null && typeof child === 'object') pending.push([child, depth + 1]);
    }
  }
  return false;
}

// ── Building ─────────────────────────────────────────────────────────────────
// `resources` as the test_resources rows give them, data already parsed. Only
// TRAIN and JOURNEY go in, with the fields the import reads.
function buildConfiguration({ datafile, framework, resources, company, exportedBy, exportedAt }) {
  return {
    [CONFIGURATION_KEY]: {
      format: CONFIGURATION_FORMAT,
      note: 'A full OSCAR configuration: the data file (scenarios), the Test Framework and the Test Data trains and journeys. It holds no credential. Upload it in Test Config, which asks what to take; it cannot be uploaded as a data file.',
      company: company || null,
      exported_by: exportedBy || null,
      exported_at: exportedAt || new Date().toISOString(),
    },
    datafile: isPlainObject(datafile) ? datafile : null,
    framework: isPlainObject(framework) ? framework : null,
    testResources: (Array.isArray(resources) ? resources : [])
      .filter(r => r && RESOURCE_TYPES.includes(r.resource_type))
      .map(r => ({
        id: r.id,
        resource_type: r.resource_type,
        label: r.label,
        data: isPlainObject(r.data) ? r.data : {},
      })),
  };
}

function isConfiguration(value) {
  return isPlainObject(value) && Object.hasOwn(value, CONFIGURATION_KEY);
}

// ── Reading ──────────────────────────────────────────────────────────────────
// { configuration } with the three parts, or { refusal } saying why not.
function readConfiguration(value) {
  const refuse = refusal => ({ refusal });
  if (!isConfiguration(value)) return refuse('This file is not a full OSCAR configuration.');
  const marker = value[CONFIGURATION_KEY];
  const format = isPlainObject(marker) ? marker.format : undefined;
  if (typeof format === 'number' && format > CONFIGURATION_FORMAT) {
    return refuse(`This configuration was made by a newer OSCAR (format ${format}); this server reads format ${CONFIGURATION_FORMAT}. Nothing was changed.`);
  }
  if (format !== CONFIGURATION_FORMAT) return refuse('This configuration has no format this server reads. Nothing was changed.');
  if (deeperThan(value, MAX_DEPTH)) return refuse(`This configuration is nested more than ${MAX_DEPTH} levels deep. Nothing was changed.`);

  const { datafile = null, framework = null, testResources = [] } = value;
  if (datafile !== null && !isPlainObject(datafile)) return refuse('"datafile" must be an object or null. Nothing was changed.');
  if (framework !== null && !isPlainObject(framework)) return refuse('"framework" must be an object or null. Nothing was changed.');
  if (!Array.isArray(testResources)) return refuse('"testResources" must be a list. Nothing was changed.');
  if (testResources.length > MAX_RESOURCES) return refuse(`"testResources" holds more than ${MAX_RESOURCES} entries. Nothing was changed.`);

  const seen = new Set();
  for (let i = 0; i < testResources.length; i++) {
    const problem = resourceProblem(testResources[i], seen);
    if (problem) return refuse(`Test Data entry ${i + 1}: ${problem} Nothing was changed.`);
  }
  return { configuration: { datafile, framework, testResources } };
}

function resourceProblem(r, seen) {
  if (!isPlainObject(r)) return 'it is not an object.';
  if (!RESOURCE_TYPES.includes(r.resource_type)) return `"resource_type" must be ${RESOURCE_TYPES.join(' or ')}.`;
  if (typeof r.id !== 'string' && typeof r.id !== 'number') return '"id" must be text or a number.';
  const key = String(r.id);
  if (seen.has(key)) return `the id "${key.slice(0, 60)}" is used twice.`;
  seen.add(key);
  if (typeof r.label !== 'string' || !r.label.trim()) return '"label" is required.';
  if (r.label.length > MAX_LABEL_LENGTH) return `"label" is longer than ${MAX_LABEL_LENGTH} characters.`;
  if (!isPlainObject(r.data)) return '"data" must be an object.';
  return null;
}

// ── The choices of the import ────────────────────────────────────────────────
// { choices } or { refusal }. Every choice must be named: an import that
// guesses could replace what the person meant to keep.
function readChoices(input, configuration) {
  const body = isPlainObject(input) ? input : {};
  const choices = { scenarios: body.scenarios, framework: body.framework, testData: body.testData };
  if (!SCENARIO_CHOICES.includes(choices.scenarios)) return { refusal: `"scenarios" must be ${SCENARIO_CHOICES.join(' or ')}.` };
  if (!FRAMEWORK_CHOICES.includes(choices.framework)) return { refusal: `"framework" must be ${FRAMEWORK_CHOICES.join(' or ')}.` };
  if (!TEST_DATA_CHOICES.includes(choices.testData)) return { refusal: `"testData" must be ${TEST_DATA_CHOICES.join(', ')}.` };
  if (choices.scenarios === 'replace' && !configuration.datafile) return { refusal: 'This configuration has no data file, so its scenarios cannot replace the stored ones.' };
  if (choices.framework === 'replace' && !configuration.framework) return { refusal: 'This configuration has no Test Framework, so it cannot replace the stored one.' };
  if (choices.scenarios === 'keep' && choices.framework === 'keep' && choices.testData === 'keep') {
    return { refusal: 'Nothing to import: every part is kept as it is.' };
  }
  return { choices };
}

// ── Test Data: what to delete and what to create ─────────────────────────────
// A value's text with the keys of every object in order, so that two trains
// written in another key order compare equal. Only called on values that
// passed readConfiguration (depth limited) or that the server stored.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort(byText).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const byText = (a, b) => (a < b ? -1 : 1);   // keys of one object are never equal

const sameKind = type => r => r.resource_type === type;

// The plan for `mode`:
//   add     — a train or journey whose data the target already holds is not
//             added again (the import's references to it go to the target's);
//             every other one is added with a new id.
//   replace — the target's trains and journeys are removed, the file's added
//             with new ids.
//   keep    — nothing.
// Journeys are added after the trains, their legs naming the trains' new ids.
// A leg naming a train that is neither in the file nor, under "add", in the
// target is left as it is and counted (`unresolvedLegs`).
// `existing`: the target's rows, data parsed. `newId()`: a fresh id.
function planTestData(existing, incoming, mode, newId) {
  const plan = { deleteIds: [], create: [], trainsAdded: 0, journeysAdded: 0, alreadyThere: 0, unresolvedLegs: 0 };
  if (mode === 'keep') return plan;
  const target = (Array.isArray(existing) ? existing : []).filter(r => RESOURCE_TYPES.includes(r.resource_type));
  const kept = mode === 'replace' ? [] : target;
  if (mode === 'replace') plan.deleteIds = target.map(r => r.id);

  const idMap = new Map();
  const keptTrainIds = new Set(kept.filter(sameKind('TRAIN')).map(r => String(r.id)));

  addMissing(plan, kept, incoming.filter(sameKind('TRAIN')), newId, idMap, r => r.data);
  addMissing(plan, kept, incoming.filter(sameKind('JOURNEY')), newId, idMap, r => remapJourney(r.data, idMap, keptTrainIds, plan));
  return plan;
}

function addMissing(plan, kept, resources, newId, idMap, dataOf) {
  const held = new Map();
  for (const r of kept) {
    if (resources.length && r.resource_type === resources[0].resource_type) {
      const key = canonical(r.data || {});
      if (!held.has(key)) held.set(key, r.id);
    }
  }
  for (const r of resources) {
    const data = dataOf(r);
    const key = canonical(data);
    if (held.has(key)) {
      idMap.set(String(r.id), held.get(key));
      plan.alreadyThere++;
      continue;
    }
    const id = newId();
    idMap.set(String(r.id), id);
    held.set(key, id);
    plan.create.push({ id, resource_type: r.resource_type, label: r.label.trim(), data });
    if (r.resource_type === 'TRAIN') plan.trainsAdded++;
    else plan.journeysAdded++;
  }
}

// A journey's data with each leg naming the train's id in the target.
function remapJourney(data, idMap, keptTrainIds, plan) {
  if (!Array.isArray(data.legs)) return data;
  const legs = data.legs.map(leg => {
    if (!isPlainObject(leg) || leg.trainResourceId == null || leg.trainResourceId === '') return leg;
    const from = String(leg.trainResourceId);
    if (idMap.has(from)) return { ...leg, trainResourceId: idMap.get(from) };
    if (!keptTrainIds.has(from)) plan.unresolvedLegs++;
    return leg;
  });
  return { ...data, legs };
}

module.exports = {
  CONFIGURATION_KEY,
  CONFIGURATION_FORMAT,
  RESOURCE_TYPES,
  MAX_DEPTH,
  MAX_RESOURCES,
  buildConfiguration,
  isConfiguration,
  readConfiguration,
  readChoices,
  planTestData,
  canonical,
  deeperThan,
};
