// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// The ready-made OSCAR data file must stay loadable by OSCAR and answerable
// by the simulator: nobody opens it until the day it is needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadProviders } = require('../src/config');
const { buildOfferCollection } = require('../src/osdm/offers');
const { PROVIDERS_DIR } = require('./helpers');

const collection = path.join(__dirname, '..', '..', 'Bruno_Collection');
const datafile = require(path.join(collection, 'data_base', 'simulator_datafile.json'));

test('the ready-made data file is valid against the collection\'s data file schema', () => {
  // Checked with the copy of Ajv that the collection carries, so the simulator
  // keeps no dependency. That copy does not have the 2020-12 meta-schema the
  // file declares, so the declaration is left out; the keywords the schema
  // uses (type, enum, required, properties, items, minimum) read the same without it.
  const Ajv = require(path.join(collection, 'json_validator', 'ajv.js'));
  const { $schema: _declared, ...schema } = require(path.join(collection, 'json_validator', 'datafile.schema.json'));
  const validate = new Ajv({ allErrors: true }).compile(schema);
  assert.equal(validate({ ...datafile, scenarios: [{}] }), false, 'the schema must be able to refuse a file');
  assert.equal(validate(datafile), true, JSON.stringify(validate.errors, null, 1));
});

test('every scenario points at entries that exist, and the run list at scenarios that exist', () => {
  const ids = (list) => new Set(datafile[list].map((entry) => entry.id));
  const codes = datafile.scenarios.map((s) => s.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const scenario of datafile.scenarios) {
    assert.ok(ids('tripRequirements').has(scenario.tripRequirementId), scenario.code);
    assert.ok(ids('passengersList').has(scenario.passengersListId), scenario.code);
    assert.ok(ids('purchaserList').has(scenario.purchaserListId), scenario.code);
    assert.ok(ids('requestedFulfillmentOptionsList').has(scenario.requestedFulfillmentOptionsListId), scenario.code);
    assert.ok(ids('offerSearchCriteriaList').has(scenario.offerSearchCriteriaListId), scenario.code);
    assert.equal(scenario.scenarioType, 'SALE', 'the simulator only answers a sale');
    assert.equal(scenario.shared, true, 'a tester must see the scenario');
    assert.equal(scenario.created_by, undefined, 'the file belongs to no one in particular');
    // The collection checks a passenger against the updated values even when
    // the update step is off, so the update has to be on.
    assert.equal(scenario.salesFlowActions.patchPassengers, true);
  }
  for (const code of datafile.scenariosToRun) assert.ok(codes.includes(code), code);
});

test('the data file holds no real person, station or template', () => {
  const text = JSON.stringify(datafile);
  assert.equal(text.includes('{{'), false, 'OSCAR refuses a data file that holds a template');
  for (const email of text.match(/[\w.+-]+@[\w.-]+/g)) assert.match(email, /@example\.org$/);
  for (const station of text.match(/urn:uic:stn:\d+/g)) assert.match(station, /urn:uic:stn:00000\d\d$/);
});

test('every trip of the data file is one the simulator answers, on every provider', () => {
  const providers = loadProviders(PROVIDERS_DIR);
  for (const requirement of datafile.tripRequirements) {
    assert.equal(requirement.tripType, 'SEARCH');
    // What the collection sends for a search: the local time, without offset.
    const departureTime = requirement.trip.startDatetime.replace('%TRIP_DATE%', '2026-11-20').slice(0, 19);
    for (const provider of providers.values()) {
      const { response } = buildOfferCollection({
        tripSearchCriteria: {
          departureTime,
          origin: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.origin },
          destination: { objectType: 'StopPlaceRef', stopPlaceRef: requirement.trip.destination },
        },
        anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }],
      }, provider, Date.parse('2026-11-02T09:00:00Z'));
      const wanted = new Set(datafile.scenarios.filter((s) => s.tripRequirementId === requirement.id).map((s) => s.desiredFlexibility));
      const offered = new Set(response.offers.map((o) => o.offerSummary.overallFlexibility));
      for (const flexibility of wanted) assert.ok(offered.has(flexibility), `${provider.key}: ${flexibility}`);
    }
  }
});
