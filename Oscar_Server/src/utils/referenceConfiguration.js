// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * referenceConfiguration.js — the reference configuration of a simulated
 * provider (#838). Pure.
 *
 * A company or provider that tests the OSDM simulator must hold what the
 * repository says: the scenarios of `simulator_datafile.json`, a Test
 * Framework declaring what the simulated provider does, and Test Data naming
 * its trains. The repository keeps one reference per provider in
 * `Bruno_Collection/data_base/reference/simulator-<provider>.json`, generated
 * by `scripts/generate-reference-configurations.js` from:
 *
 *  - the provider's set-up checklist (`Documentation/Server_Operations/
 *    Simulator checklists/`, itself generated): every `fw.*` answer goes into
 *    the framework, over the editor's defaults (`DEFAULT_FRAMEWORK`, the
 *    page's `emptyFramework()`, pinned by a test);
 *  - the simulator's profile (`OSDM_Simulator/providers/<provider>.json`):
 *    the exact OSDM version, and the distribution modes (#936: fares when
 *    the profile has them);
 *  - the data file: one train per trip leg, one journey per trip of several
 *    legs, and the run list of the provider's version. Only the provider's
 *    part of it counts (`providerPartOf()`, #912): the scenarios of its OSDM
 *    version and what they name, so that a scenario or trip added for
 *    another provider changes neither its Test Data nor its version, and
 *    an update stores that part only (#914).
 *
 * The reference does not copy the scenarios: it names the data file, and
 * `configurationOf()` puts the two together, in the full-configuration
 * format of #810, when a company is updated from it.
 */

const crypto = require('node:crypto');
const { CONFIGURATION_KEY, CONFIGURATION_FORMAT } = require('./configurationBundle');

const REFERENCE_KEY = '__oscarReference';
const REFERENCE_FORMAT = 1;
const PROVIDERS = Object.freeze(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']);
const DATAFILE_NAME = 'simulator_datafile.json';
const referenceName = provider => `simulator-${provider}`;

// The IRREGULAR codes the editor always declares (WIZ_IROPS_MANDATORY in
// scenarios.js): the checklist lists only the optional ones.
const IROPS_MANDATORY = Object.freeze(['CONNECTION_BROKEN', 'SALES_STAFF_ERROR', 'STRIKE', 'TECHNICAL_FAILURE']);
const ANCILLARY_TYPES = Object.freeze(['PAYMENT_VOUCHER', 'PRODUCT_ACCESS', 'MERCHANDISE_PRODUCT', 'LUGGAGE', 'LUGGAGE_TRANSFER',
  'ON_BOARD_SERVICE', 'STATION_SERVICE', 'FOOD_ON_BOARD', 'DRINKS_ON_BOARD', 'WIFI', 'PARKING']);

/** The page's emptyFramework(): what a framework holds before anything is declared. */
function defaultFramework() {
  return {
    osdmVersion: '3.4',
    distributionModes: ['PRODUCT'],
    concurrentSessionLimit: 1,
    salesFlows: ['SALE'],
    iropsCodes: { refund: [...IROPS_MANDATORY], exchange: [...IROPS_MANDATORY] },
    rail: { enabled: true, subModes: ['HIGH_SPEED_TRAIN', 'INTERCITY'], ticketTypes: ['IRT', 'NRT_NO_RESERVATION'] },
    pt: { enabled: false, subModes: [] },
    shared: { enabled: false, subModes: [] },
    offerCriteria: {
      serviceClasses: ['STANDARD'],
      requestedOfferParts: ['RESERVATION', 'ADMISSION'],
      travelClasses: ['SECOND'],
      flexibilities: ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'],
      offerMode: 'INDIVIDUAL',
      currency: 'EUR',
      requiresPlaceSelection: false,
    },
    placeSelection: { seatMap: false, supportedModes: [] },
    fulfillment: { media: ['PDF_A4'], types: ['ETICKET'] },
    serviceClasses: ['STANDARD', 'HIGH'],
    accommodations: ['SEAT'],
    ancillaries: [...ANCILLARY_TYPES],
    passengerTypes: ['ADULT', 'CHILD'],
    passengerAgeRanges: { ADULT: { min: 26, max: 99 }, CHILD: { min: 4, max: 15 } },
  };
}

// How each checklist answer goes into the framework. A question is a path
// under `fw.`; its answers are ticks (`fw.<path>=<code>`) or a text
// (`fw.<path>`). Paths not listed here stop the generator: a new question of
// the checklist must be placed here first.
const LIST_PATHS = new Set([
  'distributionModes', 'passengerTypes', 'offerRequestForms', 'returnModels', 'offerCriteria.flexibilities',
  'offerSearchOptions.offerModes', 'offerSearchOptions.requestedOfferParts', 'offerSearchOptions.travelClasses',
  'offerSearchOptions.serviceClassTypes', 'offerSearchOptions.productTags', 'offerSearchOptions.productSelections', 'tripSearchParameters', 'fulfillment.types', 'fulfillment.media', 'salesFlows', 'partialRefundScopes',
  'iropsCodes.refund', 'iropsCodes.exchange', 'placeSelectionFlows', 'placeSelection.supportedModes', 'ancillaries',
  'rail.subModes', 'rail.ticketTypes',
]);
const ONE_PATHS = new Set(['osdmVersion', 'mandatoryReservationForm']);
const NUMBER_PATHS = new Set(['concurrentSessionLimit', 'maxPassengers', 'salesHorizonDays']);
const AGE_RANGE = /^passengerAgeRanges\.([A-Z_]+)\.(min|max)$/;
const TEXT_PATHS = new Set(['currencies.sold', 'currencies.default']);

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

const known = path => LIST_PATHS.has(path) || ONE_PATHS.has(path) || NUMBER_PATHS.has(path) || TEXT_PATHS.has(path) || AGE_RANGE.test(path);

/**
 * The checklist's `fw.*` answers ({ tag: true | text }, as answersOfDocx
 * gives them) by question: { path: { ticks: [codes], text } }. Throws on a
 * question this file does not place, unless `unplaced` (a Set) is given: a
 * provider's checklist may answer what OSCAR cannot declare (#862), and the
 * question's name is then added to it.
 */
function questionsOf(answers, unplaced = null) {
  const questions = new Map();
  const questionAt = (path) => {
    if (!questions.has(path)) questions.set(path, { ticks: [], text: null });
    return questions.get(path);
  };
  for (const [tag, value] of Object.entries(answers || {})) {
    if (!tag.startsWith('fw.')) continue;
    const [name, code] = tag.slice(3).split('=');
    if (name.endsWith('.comment')) {
      questionAt(name.slice(0, -'.comment'.length));
      continue;
    }
    if (!known(name) && unplaced) { unplaced.add(name); continue; }
    if (!known(name)) throw new Error(`The checklist answers fw.${name}, which the reference framework does not place: add it to referenceConfiguration.js.`);
    const q = questionAt(name);
    if (code === undefined) q.text = String(value).trim();
    else if (value === true) q.ticks.push(code);
  }
  return questions;
}

// What one answered question puts at its place: { value } or null for nothing.
function answerAt(path, ticks, text) {
  if (LIST_PATHS.has(path)) {
    return { value: path.startsWith('iropsCodes.') ? [...new Set([...IROPS_MANDATORY, ...ticks])] : ticks };
  }
  if (ONE_PATHS.has(path)) return ticks.length ? { value: ticks[0] } : null;
  if (NUMBER_PATHS.has(path) || AGE_RANGE.test(path)) {
    const n = Number(text);
    return text !== null && text !== '' && Number.isFinite(n) ? { value: n } : null;
  }
  if (path === 'currencies.sold') return { value: (text || '').split(/[\s,]+/).filter(Boolean) };
  if (path === 'currencies.default') return text ? { value: text } : null;
  return null;
}

/**
 * The framework a checklist declares: `base` (the defaults when none), each
 * answered question over it. With `unplaced` (a Set), a question this file
 * does not place is named there instead of stopping (#862).
 */
function frameworkFromChecklist(answers, { base = null, unplaced = null } = {}) {
  const framework = base ? structuredClone(base) : defaultFramework();
  for (const [path, { ticks, text }] of questionsOf(answers, unplaced)) {
    if (!known(path)) continue;   // a comment of a question not asked as such
    const answer = answerAt(path, ticks, text);
    if (answer) setPath(framework, path, answer.value);
  }
  const modes = framework.placeSelection?.supportedModes;
  if (Array.isArray(modes)) framework.placeSelection.seatMap = modes.includes('SEATMAP_AT_OFFER');
  withPassengerUpdateScope(framework, answers);
  withPurchaserTiming(framework, answers);
  // #887: A3.7, the reduction cards the provider accepts.
  const cards = require('./reductionCards').cardsFromChecklist(answers);
  if (cards) framework.reductionCards = cards;
  // #887 PR 2: A4.18, the products the provider sells.
  const products = require('./namedProducts').productsFromChecklist(answers);
  if (products) framework.products = products;
  // PR 3: A4.19, the group products.
  const groups = require('./namedProducts').groupProductsFromChecklist(answers);
  if (groups) framework.groupProducts = groups;
  return framework;
}

/**
 * #885: question A3.5 (`data.passengerUpdateScope`, one tick) says which
 * booked passengers can be updated. MAIN = the main one only
 * (`passengerUpdateScope`), NONE = none (`passengerUpdate: false`), ALL =
 * every one, which is what neither key says. No tick leaves the framework as
 * it is.
 */
function withPassengerUpdateScope(framework, answers) {
  const ticked = ['ALL', 'MAIN', 'NONE'].find((code) => answers?.[`data.passengerUpdateScope=${code}`] === true);
  if (!ticked) return;
  delete framework.passengerUpdate;
  delete framework.passengerUpdateScope;
  if (ticked === 'MAIN') framework.passengerUpdateScope = 'MAIN';
  if (ticked === 'NONE') framework.passengerUpdate = false;
}

/**
 * #899: question A5.1 (`data.purchaser`, one tick) says when the provider
 * takes the purchaser. AT_BOOKING (required in the booking) and NOT_NEEDED
 * mean none after the booking (`purchaserAfterBooking: false`); LATER_ALLOWED
 * is what an absent key says. No tick leaves the framework as it is.
 */
function withPurchaserTiming(framework, answers) {
  const ticked = ['AT_BOOKING', 'LATER_ALLOWED', 'NOT_NEEDED'].find((code) => answers?.[`data.purchaser=${code}`] === true);
  if (!ticked) return;
  delete framework.purchaserAfterBooking;
  if (ticked !== 'LATER_ALLOWED') framework.purchaserAfterBooking = false;
}

// ── Test Data ────────────────────────────────────────────────────────────────

const timeOf = (instant) => String(instant || '').replace(/^%TRIP_DATE%T/, '');

// A train of one leg, the shape Test Data's editor writes (trainFromTrip in scenarios.js).
function trainOfLeg(leg) {
  const vehicleNumber = leg.vehicleNumber || '';
  const departureTime = timeOf(leg.startDatetime);
  const arrivalTime = timeOf(leg.endDatetime);
  return {
    originURN: leg.origin || '',
    destinationURN: leg.destination || '',
    operatorCode: leg.operatorCode || '',
    productCategoryRef: leg.productCategoryRef || '',
    productCategoryName: leg.productCategoryName || '',
    productCategoryShortName: leg.productCategoryShortName || '',
    daysOfWeek: [],
    services: (vehicleNumber || departureTime || arrivalTime) ? [{ vehicleNumber, departureTime, arrivalTime }] : [],
    ticketTypes: [],
    travelClasses: [],
    serviceClasses: [],
    accommodations: [],
    ancillaries: [],
  };
}

const legsOfTrip = trip => (trip?.tripType === 'SPECIFICATION' && Array.isArray(trip.legs) && trip.legs.length ? trip.legs : [trip?.trip || {}]);
const trainKey = d => [d.originURN, d.destinationURN, d.productCategoryRef, ...(d.services[0] ? [d.services[0].vehicleNumber, d.services[0].departureTime, d.services[0].arrivalTime] : [])].join('|');
const stationOf = urn => String(urn || '').slice(String(urn || '').lastIndexOf(':') + 1);

/**
 * Test Data of a data file: one train per distinct leg of its trips (ids 1,
 * 2…), then one journey per trip of several legs, its legs naming those
 * trains. The import gives them new ids (configurationBundle.planTestData).
 */
function testResourcesFromDatafile(datafile) {
  const trains = [];
  const byKey = new Map();
  const journeys = [];
  for (const trip of Array.isArray(datafile?.tripRequirements) ? datafile.tripRequirements : []) {
    const legs = legsOfTrip(trip).map((leg) => {
      const data = trainOfLeg(leg);
      const key = trainKey(data);
      if (!byKey.has(key)) {
        const id = trains.length + 1;
        const number = data.services[0]?.vehicleNumber;
        const route = `${stationOf(data.originURN)}–${stationOf(data.destinationURN)}`;
        trains.push({ id, resource_type: 'TRAIN', label: number ? `Train ${number} ${route}` : `Trip ${trip.id} ${route}`, data });
        byKey.set(key, id);
      }
      return { trainResourceId: byKey.get(key), serviceIndex: 0 };
    });
    if (legs.length > 1) {
      const all = legsOfTrip(trip);
      journeys.push({ resource_type: 'JOURNEY', label: `Trip ${trip.id}: ${stationOf(all[0].origin)}–${stationOf(all.at(-1).destination)}, ${legs.length} legs`, data: { legs } });
    }
  }
  return [...trains, ...journeys.map((j, i) => ({ id: trains.length + i + 1, ...j }))];
}

// The resource lists of a data file and the scenario field naming an entry
// of each (as in datafileOwnership.js).
const RESOURCE_LISTS = Object.freeze([
  ['tripRequirements', 'tripRequirementId'],
  ['passengersList', 'passengersListId'],
  ['purchaserList', 'purchaserListId'],
  ['requestedFulfillmentOptionsList', 'requestedFulfillmentOptionsListId'],
  ['offerSearchCriteriaList', 'offerSearchCriteriaListId'],
]);

/**
 * A provider's part of the data file (#912): the scenarios of its OSDM
 * version (those that fail on purpose included: a company may run them by
 * hand), the entries of the resource lists they name, the first purchaser
 * (the collection reads `purchaserList[0]` for every scenario), and every
 * other root key but the file's own run list, which the reference holds.
 */
function providerPartOf(datafile, osdmVersion) {
  const scenarios = (Array.isArray(datafile?.scenarios) ? datafile.scenarios : [])
    .filter(s => s && s.osdmVersion === osdmVersion);
  const part = {};
  for (const [key, value] of Object.entries(datafile || {})) {
    if (key !== 'scenarios' && key !== 'scenariosToRun') part[key] = value;
  }
  part.scenarios = scenarios;
  for (const [list, field] of RESOURCE_LISTS) {
    if (!Array.isArray(datafile?.[list])) continue;
    const named = new Set(scenarios.map(s => s[field]));
    part[list] = datafile[list].filter((entry, i) => named.has(entry?.id) || (list === 'purchaserList' && i === 0));
  }
  return part;
}

// The scenarios a provider's companies run by default: those of its OSDM
// version, but the ones that fail on purpose.
const failsOnPurpose = code => /^SIM_(WRONG|FAULT)_/.test(code);
function runListFor(datafile, osdmVersion) {
  return (Array.isArray(datafile?.scenarios) ? datafile.scenarios : [])
    .filter(s => s && s.osdmVersion === osdmVersion && !failsOnPurpose(String(s.code)))
    .map(s => s.code);
}

/** The reference of one provider, as stored in the repository. */
function buildReference({ provider, profile, answers, datafile }) {
  if (!PROVIDERS.includes(provider)) throw new Error(`Unknown simulated provider ${provider}.`);
  const framework = frameworkFromChecklist(answers);
  const osdmVersion = String(profile?.osdmVersion || '');
  // "3.10" names 3.10.0, never 3.1.x (#920): the declared version is the
  // profile's or its major.minor followed by a dot.
  const declared = String(framework.osdmVersion);
  if (osdmVersion !== declared && !osdmVersion.startsWith(`${declared}.`)) {
    throw new Error(`${provider}: the checklist declares OSDM ${framework.osdmVersion}, the simulator's profile ${osdmVersion}.`);
  }
  framework.osdmVersion = osdmVersion;
  // #936: a simulated provider sells products, and fares when its profile
  // has them (every one since #903). The checklist does not ask yet (#938).
  framework.distributionModes = profile?.fares ? ['PRODUCT', 'FARE'] : ['PRODUCT'];
  // #937: what it sells in fares, from the same profile.
  const fares = require('./fareDeclarations').referenceFares(profile);
  if (fares) framework.fares = fares;
  return {
    [REFERENCE_KEY]: {
      format: REFERENCE_FORMAT,
      name: referenceName(provider),
      provider,
      osdmVersion,
      datafile: DATAFILE_NAME,
      note: 'Generated by Oscar_Server/scripts/generate-reference-configurations.js from the provider\'s checklist, the simulator\'s profile and the data file. Do not edit by hand.',
    },
    framework,
    testResources: testResourcesFromDatafile(providerPartOf(datafile, osdmVersion)),
    scenariosToRun: runListFor(datafile, osdmVersion),
  };
}

/**
 * sha256 of a reference and of its provider's part of the data file (#912):
 * what a company was last updated to. A change elsewhere in the data file
 * leaves it as it is. `datafile` is the parsed file or its text.
 */
function versionOf(reference, datafile) {
  const parsed = typeof datafile === 'string' ? JSON.parse(datafile) : datafile;
  const part = providerPartOf(parsed, reference?.[REFERENCE_KEY]?.osdmVersion);
  return crypto.createHash('sha256').update(JSON.stringify(reference)).update('\n').update(JSON.stringify(part)).digest('hex');
}

/**
 * The full configuration (#810) a company is updated with: its provider's
 * part of the data file (#914: no other provider's scenarios) with the
 * provider's run list, the framework and the Test Data.
 */
function configurationOf(reference, datafile, { version, at } = {}) {
  const meta = reference[REFERENCE_KEY];
  const part = providerPartOf(datafile, meta.osdmVersion);
  return {
    [CONFIGURATION_KEY]: {
      format: CONFIGURATION_FORMAT,
      note: `The reference configuration ${meta.name} (#838).`,
      company: null,
      exported_by: 'reference',
      exported_at: at || new Date().toISOString(),
      reference: { name: meta.name, version: version || null },
    },
    datafile: { ...part, scenariosToRun: [...reference.scenariosToRun] },
    framework: reference.framework,
    testResources: reference.testResources,
  };
}

module.exports = {
  REFERENCE_KEY, REFERENCE_FORMAT, PROVIDERS, DATAFILE_NAME, IROPS_MANDATORY, ANCILLARY_TYPES,
  referenceName, defaultFramework, frameworkFromChecklist, questionsOf, testResourcesFromDatafile, providerPartOf, runListFor,
  buildReference, versionOf, configurationOf,
};
