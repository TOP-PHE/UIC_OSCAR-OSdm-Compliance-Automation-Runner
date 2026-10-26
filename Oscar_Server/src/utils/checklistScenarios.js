// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklistScenarios.js — the reference scenarios a provider's checklist
 * brings with it (#862, PR 2). Pure.
 *
 * Applying a checklist sets the Test Framework and the Test Data; the
 * scenarios of the scenario catalogue (#612) that this framework declares
 * everything for are then copied as Copy scenarios would copy them: adapted to
 * the framework (#681), each trip on the train or journey Copy scenarios
 * proposes (`suggestTrip()`), owned by the Test Manager, not added to any run
 * list. A scenario whose code the data file already holds is left alone, so
 * applying the next checklist does not copy it a second time.
 */

const { catalogueDatafile, catalogueFor } = require('./scenarioCatalogue');
const { adaptCatalogueDatafile, suggestTrips, journeysMissing } = require('./catalogueMatch');
const { planCopy } = require('./scenarioCopy');

const CHOICES = Object.freeze(['copy', 'none']);
const arr = v => (Array.isArray(v) ? v : []);

// "train::<id>::<service>" / "journey::<id>" (suggestTrip) as a trip_map entry.
function mappingOf(suggested) {
  const [type, id, svc] = String(suggested).split('::');
  return type === 'journey' ? { type, journey_id: id } : { type, train_id: id, service_index: Number(svc) || 0 };
}

/** The codes of a data file's scenarios. */
function codesOf(datafile) {
  return arr(datafile?.scenarios).map(s => s?.code).filter(c => typeof c === 'string' && c !== '');
}

/**
 * What applying would copy. `framework` is the framework after the apply,
 * `testData` the Test Data after it as `testDataChoices()` gives it,
 * `existingCodes` the codes the data file holds.
 *
 * { copy: [{ code, kind, purpose, toComplete }], alreadyThere: [code],
 *   notDeclared: [{ code, missing }], noJourney: [{ code, legs }],
 *   noTestData: [code], source, tripMap }
 */
function scenarioPlan({ catalogue, simulator, framework, testData, existingCodes }) {
  const entries = catalogueFor(catalogue, simulator, framework || {});
  const adapted = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, framework || {});
  const have = new Set(arr(existingCodes));
  const allowed = entries.filter(e => e.missing.length === 0);
  const candidates = allowed.filter(e => !have.has(e.code));
  const plan = planCopy(adapted.datafile, candidates.map(e => e.code), framework || {});

  const legsMissing = journeysMissing(plan.trips, testData);
  const tripMap = {};
  const noTestData = new Set();
  const suggestions = suggestTrips(plan.trips, testData);
  for (const trip of plan.trips) {
    const suggested = suggestions[trip.id];
    if (suggested) tripMap[String(trip.id)] = mappingOf(suggested);
    else if (!trip.needsJourney && (Number(trip.legs) || 1) === 1) trip.usedBy.forEach(code => noTestData.add(code));
  }
  // A scenario some of whose trips cannot be placed is not copied at all.
  const blocked = code => code in legsMissing || noTestData.has(code);
  return {
    copy: candidates.filter(e => !blocked(e.code)).map(e => ({
      code: e.code, kind: e.kind, purpose: e.purpose, toComplete: adapted.notes[e.code]?.toComplete || [],
    })),
    alreadyThere: allowed.filter(e => have.has(e.code)).map(e => e.code),
    notDeclared: entries.filter(e => e.missing.length > 0).map(e => ({ code: e.code, missing: e.missing })),
    noJourney: Object.entries(legsMissing).map(([code, legs]) => ({ code, legs })),
    noTestData: [...noTestData],
    source: adapted.datafile,
    tripMap,
  };
}

/** What the page is shown and the hash covers: the plan without the source data file. */
function shownPlan(plan, choice) {
  return {
    choice,
    copy: plan.copy,
    alreadyThere: plan.alreadyThere,
    notDeclared: plan.notDeclared,
    noJourney: plan.noJourney,
    noTestData: plan.noTestData,
  };
}

module.exports = { CHOICES, scenarioPlan, shownPlan, codesOf, mappingOf };
