// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * valid-datafile.js — a data file the upload accepts (#549).
 *
 * Since #549 an upload is checked against the datafile schema, as each run
 * checks it (src/utils/datafileSchema.js). asValidDatafile() takes the small
 * files the tests are written with ({ scenarios: [{ code }] }) and fills in
 * what the schema requires, keeping every field the test set.
 */

const SCENARIO_DEFAULTS = Object.freeze({
  collection: 'OTST_TEST',
  loggingType: 'INFO',
  scenarioType: 'SALE',
  scenarioAction: null,
  osdmVersion: '3.8.0',
  overruleCode: null,
  tripRequirementId: 1,
  passengersListId: 1,
  requestedFulfillmentOptionsListId: 1,
});

const ROOT_DEFAULTS = Object.freeze({
  requestedFulfillmentOptionsList: [
    { id: 1, requestedFulfillmentOptions: [{ fulfillmentType: 'ETICKET', fulfillmentMedia: 'PDF_A4' }] },
  ],
  tripRequirements: [
    { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', startDatetime: '%TRIP_DATE%T08:00:00+01:00' } },
  ],
  passengersList: [
    { id: 1, passengers: [{ reference: '00001', dateOfBirth: '1990-01-15', firstName: 'Alex', lastName: 'Example',
      phoneNumber: '+33199000001', email: 'alex.example@example.org', type: 'PERSON' }] },
  ],
});

function asValidDatafile(partial = {}) {
  const out = { ...structuredClone(ROOT_DEFAULTS), ...structuredClone(partial) };
  out.scenarios = (out.scenarios || []).map(sc =>
    (sc && typeof sc === 'object' && !Array.isArray(sc)) ? { ...SCENARIO_DEFAULTS, ...sc } : sc);
  if (!Array.isArray(out.scenariosToRun)) out.scenariosToRun = out.scenarios.map(sc => sc?.code).filter(Boolean);
  return out;
}

module.exports = { asValidDatafile };
