// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tripSearchParameters.js — the trip search parameters a provider takes (#780 PR B).
 *
 * A trip requirement's Trip Search Criteria (`trip.searchCriteria`) turn on
 * members of OSDM's TripSearchCriteria the collection sends with a search:
 * an arrival-time basis, vias, not-vias, and TripParameters (transfer limit,
 * numbers of results, real-time data, the train filter). The Test Framework
 * declares which ones the provider takes (`tripSearchParameters`); absent =
 * every one, [] = none. A scenario using one not declared gets the warning
 * `tripParameter:<NAME>`, and a reference scenario needing one is not copied.
 *
 * Pure module.
 */

const TRIP_SEARCH_PARAMETERS = Object.freeze(['ARRIVAL_TIME', 'VIAS', 'NOT_VIAS', 'TRANSFER_LIMIT', 'NUMBER_OF_RESULTS', 'IGNORE_REALTIME_DATA', 'TRAIN_FILTER']);

// How each one is named in a sentence (the catalogue's "missing" list).
const TRIP_SEARCH_PARAMETER_TEXT = Object.freeze({
  ARRIVAL_TIME: 'arrival time',
  VIAS: 'via',
  NOT_VIAS: 'not via',
  TRANSFER_LIMIT: 'transfer limit',
  NUMBER_OF_RESULTS: 'number of results',
  IGNORE_REALTIME_DATA: 'ignoring real-time data',
  TRAIN_FILTER: 'train filter',
});

const ON = new Set(['on', 'true', 'yes', '1', true, 1]);
const set = (v) => v !== null && v !== undefined && String(v).trim() !== '';

/** The parameters a Trip Search Criteria object turns on, in the list's order. */
function parametersOfCriteria(sc) {
  if (!sc || typeof sc !== 'object' || Array.isArray(sc)) return [];
  const on = {
    ARRIVAL_TIME: sc.timeBasis === 'ARRIVAL',
    VIAS: set(sc.via1Place) || set(sc.via2Place),
    NOT_VIAS: set(sc.notVias),
    TRANSFER_LIMIT: set(sc.transferLimit),
    NUMBER_OF_RESULTS: ['numberOfResults', 'numberOfResultsBefore', 'numberOfResultsAfter'].some((k) => set(sc[k])),
    IGNORE_REALTIME_DATA: set(sc.ignoreRealtimeData),
    TRAIN_FILTER: ON.has(sc.trainFilter),
  };
  return TRIP_SEARCH_PARAMETERS.filter((name) => on[name]);
}

/**
 * The parameters a scenario's search sends: those of its trip requirement's
 * Trip Search Criteria, for a SEARCH trip (a trip-id request searches the
 * same trip first). A specification sends none.
 */
function tripSearchParametersOf(scenario, datafile) {
  if (!scenario || typeof scenario !== 'object') return [];
  const trips = Array.isArray(datafile?.tripRequirements) ? datafile.tripRequirements : [];
  const trip = trips.find((t) => t && typeof t === 'object' && t.id === scenario.tripRequirementId);
  if (!trip || trip.tripType === 'SPECIFICATION') return [];
  return parametersOfCriteria(trip.trip?.searchCriteria);
}

/** True when the framework takes this parameter: no list declared, or listed. */
function tripSearchParameterDeclared(framework, name) {
  const declared = framework?.tripSearchParameters;
  return !Array.isArray(declared) || declared.includes(name);
}

module.exports = {
  TRIP_SEARCH_PARAMETERS, TRIP_SEARCH_PARAMETER_TEXT, parametersOfCriteria, tripSearchParametersOf, tripSearchParameterDeclared,
};
