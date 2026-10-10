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
    // A sale, or the refund of one (#595); exchanges are not simulated.
    assert.ok(['SALE', 'REFUND'].includes(scenario.scenarioType), `${scenario.code}: ${scenario.scenarioType}`);
    if (scenario.scenarioType === 'REFUND') assert.equal(scenario.scenarioAction, 'PATCH', `${scenario.code}: a refund is confirmed`);
    assert.equal(scenario.shared, true, 'a tester must see the scenario');
    assert.equal(scenario.created_by, undefined, 'the file belongs to no one in particular');
    // The collection checks a passenger against the updated values even when
    // the update step is off, so the update has to be on.
    assert.equal(scenario.salesFlowActions.patchPassengers, true);
  }
  for (const code of datafile.scenariosToRun) assert.ok(codes.includes(code), code);
});

test('each provider\'s OSDM version has the same scenarios, and the run list is gamma\'s', () => {
  // One file for the three providers (#614): a scenario asks for one version,
  // so each provider runs the scenarios of its own and the version check agrees.
  // The return covering both directions (#594, outboundTripIds) exists from 3.7.
  // The overrule codes (#596) and the reduction cards (#597) are gamma's only.
  const providers = [...loadProviders(PROVIDERS_DIR).values()];
  const byVersion = new Map();
  for (const scenario of datafile.scenarios) {
    const sale = scenario.code.replace(/_\d{2}$/, '');
    assert.equal(scenario.code, `${sale}_${scenario.osdmVersion.slice(0, 3).replace('.', '')}`, 'the code names the version');
    if (!byVersion.has(scenario.osdmVersion)) byVersion.set(scenario.osdmVersion, []);
    byVersion.get(scenario.osdmVersion).push(sale);
  }
  assert.deepEqual([...byVersion.keys()].sort(), providers.map((p) => p.osdmVersion).sort());
  const combined = 'SIM_RETURN_COMBINED_1ADT';
  const latest = byVersion.get('3.8.0');
  const everyVersion = latest.filter((s) => !s.startsWith('SIM_REFUND_OVERRULE_') && !s.startsWith('SIM_SALE_CARD_'));
  for (const [version, sales] of byVersion) {
    let expected = latest;
    if (version === '3.7.0') expected = everyVersion;
    if (version === '3.6.0') expected = everyVersion.filter((s) => s !== combined);
    assert.deepEqual(sales, expected, version);
  }
  const gamma = providers.find((p) => p.key === 'gamma');
  assert.deepEqual(datafile.scenariosToRun, datafile.scenarios.filter((s) => s.osdmVersion === gamma.osdmVersion).map((s) => s.code));
});

test('the return scenarios name a model their version defines, and expect a ticket per direction', () => {
  const returns = datafile.scenarios.filter((s) => s.offerSearchCriteria.returnOffsetDays != null && s.scenarioType === 'SALE');
  assert.equal(returns.length, 5);
  for (const scenario of returns) {
    const model = scenario.offerSearchCriteria.returnModel;
    assert.ok(scenario.code.startsWith(`SIM_RETURN_${model}_`), scenario.code);
    if (model === 'COMBINED') assert.notEqual(scenario.osdmVersion, '3.6.0', 'outboundTripIds is OSDM 3.7 and later');
    assert.equal(scenario.offerSearchCriteria.returnFulfillments, 'PER_DIRECTION');
  }
});

test('the refund scenarios refund a return: in full, and the inbound ticket alone', () => {
  // #595: a return gives one ticket per direction on the simulator, so a full
  // refund confirms two refund offers and a partial one refunds one ticket.
  const refunds = datafile.scenarios.filter((s) => s.scenarioType === 'REFUND');
  assert.equal(refunds.length, 11);
  for (const scenario of refunds) {
    assert.notEqual(scenario.offerSearchCriteria.returnOffsetDays, null, `${scenario.code} is a return`);
    const partial = scenario.partialRefundByFulfillment === 'on';
    assert.equal(partial, scenario.code.startsWith('SIM_REFUND_INBOUND_'), scenario.code);
    if (partial) assert.equal(scenario.partialRefundFulfillmentSelection, 'inbound');
    for (const axis of ['partialRefundByLeg', 'partialRefundByPax']) {
      assert.ok([undefined, 'off', false].includes(scenario[axis]), `${scenario.code}: the provider refuses a scope by leg or passenger`);
    }
  }
});

test('the overrule scenarios: each code gamma accepts, and one it refuses (#596)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const overruled = datafile.scenarios.filter((s) => s.code.startsWith('SIM_REFUND_OVERRULE_'));
  const accepted = overruled.filter((s) => s.overruleCodeExpectRejection !== 'on');
  const refused = overruled.filter((s) => s.overruleCodeExpectRejection === 'on');
  assert.deepEqual(accepted.map((s) => s.overruleCode), gamma.overruleCodes);
  for (const scenario of accepted) assert.equal(scenario.code, `SIM_REFUND_OVERRULE_${scenario.overruleCode}_38`);
  assert.deepEqual(refused.map((s) => s.code), ['SIM_REFUND_OVERRULE_REFUSED_38']);
  assert.equal(gamma.overruleCodes.includes(refused[0].overruleCode), false, 'the probe sends a code gamma does not accept');
  for (const scenario of overruled) {
    assert.equal(scenario.osdmVersion, gamma.osdmVersion);
    // A fee without the code, so that waiving it shows.
    assert.equal(scenario.desiredFlexibility, 'SEMI_FLEXIBLE', scenario.code);
    assert.equal(scenario.partialRefundByFulfillment, 'off', scenario.code);
  }
  for (const scenario of datafile.scenarios.filter((s) => !overruled.includes(s))) assert.equal(scenario.overruleCode, null, scenario.code);
});

test('the reduction card scenarios: each card gamma lists, on a passenger of its own (#597)', () => {
  const gamma = loadProviders(PROVIDERS_DIR).get('gamma');
  const carded = datafile.scenarios.filter((s) => s.code.startsWith('SIM_SALE_CARD_'));
  assert.deepEqual(carded.map((s) => s.code), ['SIM_SALE_CARD_25_1ADT_38', 'SIM_SALE_CARD_50_2ADT_38', 'SIM_SALE_CARD_STUDENT_1YTH_38']);
  const used = [];
  for (const scenario of carded) {
    assert.equal(scenario.osdmVersion, gamma.osdmVersion);
    assert.equal(scenario.scenarioType, 'SALE');
    const list = datafile.passengersList.find((l) => l.id === scenario.passengersListId);
    const cards = list.passengers.flatMap((p) => p.reductionCards || []);
    assert.equal(cards.length, 1, `${scenario.code}: one passenger holds one card`);
    used.push(...cards);
  }
  assert.deepEqual(used.sort(), gamma.reductionCards.map((c) => c.code).sort());
  for (const scenario of datafile.scenarios.filter((s) => !carded.includes(s))) {
    const list = datafile.passengersList.find((l) => l.id === scenario.passengersListId);
    assert.ok(list.passengers.every((p) => !p.reductionCards), `${scenario.code} holds no card`);
  }
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
