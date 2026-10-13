// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * catalogue-match.test.js — #681 part 2: a reference scenario takes the values
 * of the company it is copied into, says what is left to complete or check,
 * and its trips get a proposed train or journey.
 */

const path = require('node:path');

process.env.COLLECTION_PATH = path.resolve(__dirname, '../../../Bruno_Collection');
const { adaptReferenceScenario, adaptCatalogueDatafile, suggestTrip, OVERRULE_CODES } = require('../../src/utils/catalogueMatch');
const { catalogueDatafile, catalogueFor } = require('../../src/utils/scenarioCatalogue');

const DATA = path.resolve(__dirname, '../../../Bruno_Collection/data_base');
const catalogue = require(path.join(DATA, 'scenario_catalogue.json'));
const simulator = require(path.join(DATA, 'simulator_datafile.json'));

describe('adaptReferenceScenario', () => {
  const refund = { code: 'OTST_R', scenarioType: 'REFUND', overruleCode: 'TECHNICAL_FAILURE', desiredFlexibility: 'SEMI_FLEXIBLE' };
  const needs = { trip: 'SEARCH', passengers: 1, providerValues: ['overruleCode'] };

  test('an overrule code the framework declares is kept, else its first declared code is taken', () => {
    expect(adaptReferenceScenario(refund, needs, { iropsCodes: { refund: ['STRIKE', 'TECHNICAL_FAILURE'] } }).scenario.overruleCode).toBe('TECHNICAL_FAILURE');
    const r = adaptReferenceScenario(refund, needs, { config: { iropsCodes: { refund: ['STRIKE'] } } });
    expect(r.scenario.overruleCode).toBe('STRIKE');
    expect(r.toComplete).toEqual([]);
  });

  test('with no declared code there is none to send, and the scenario is to complete', () => {
    const r = adaptReferenceScenario(refund, needs, {});
    expect(r.scenario.overruleCode).toBeNull();
    expect(r.toComplete).toEqual([expect.stringMatching(/overrule code.*Test Framework/)]);
  });

  test('the refusal probe sends a listed code the framework does not declare', () => {
    const probe = { ...refund, overruleCode: 'STRIKE', overruleCodeExpectRejection: 'on' };
    const r = adaptReferenceScenario(probe, needs, { iropsCodes: { refund: ['CONNECTION_BROKEN', 'SALES_STAFF_ERROR'] } });
    expect(r.scenario.overruleCode).toBe('STRIKE');
    expect(adaptReferenceScenario(probe, needs, { iropsCodes: { refund: [...OVERRULE_CODES] } }).scenario.overruleCode).toBeNull();
  });

  test('a product code is the provider\'s: removed, and said to complete', () => {
    const r = adaptReferenceScenario({ code: 'X', expectedProduct: 'GAMMA_P1' }, { providerValues: ['expectedProduct'] }, {});
    expect(r.scenario.expectedProduct).toBeUndefined();
    expect(r.toComplete).toEqual([expect.stringMatching(/product/)]);
  });

  test('an after-sale never keeps the non-flexible tariff; a sale keeps what it asks', () => {
    expect(adaptReferenceScenario({ desiredFlexibility: 'NON_FLEXIBLE' }, { tariff: 'REFUNDABLE' }, {}).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
    expect(adaptReferenceScenario({}, { tariff: 'EXCHANGEABLE' }, {}).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
    expect(adaptReferenceScenario({ desiredFlexibility: 'SEMI_FLEXIBLE' }, { tariff: 'REFUNDABLE' }, {}).scenario.desiredFlexibility).toBe('SEMI_FLEXIBLE');
    expect(adaptReferenceScenario({ desiredFlexibility: 'NON_FLEXIBLE' }, { tariff: 'NON_FLEXIBLE' }, {}).scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
  });

  // #687: the tariff is one the provider sells, from the Test Framework.
  describe('after-sale flexibility from the Test Framework (#687)', () => {
    const fw = (...flexibilities) => ({ offerCriteria: { flexibilities } });
    const flex = (own, framework, tariff = 'REFUNDABLE') =>
      adaptReferenceScenario(own ? { desiredFlexibility: own } : {}, { tariff }, framework);

    test('a provider that sells only non-flexible tariffs keeps them, and the refund is to check', () => {
      const r = flex(undefined, fw('NON_FLEXIBLE'));
      expect(r.scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
      expect(r.toCheck).toEqual(['the provider\'s non-flexible tariff must allow the refund']);
      expect(flex('FULL_FLEXIBLE', fw('NON_FLEXIBLE'), 'EXCHANGEABLE').toCheck)
        .toEqual(['the provider\'s non-flexible tariff must allow the exchange']);
    });

    test('the scenario\'s own flexibility stays when declared, unless it is the non-flexible one', () => {
      expect(flex('SEMI_FLEXIBLE', fw('FULL_FLEXIBLE', 'SEMI_FLEXIBLE')).scenario.desiredFlexibility).toBe('SEMI_FLEXIBLE');
      expect(flex('NON_FLEXIBLE', fw('NON_FLEXIBLE', 'SEMI_FLEXIBLE')).scenario.desiredFlexibility).toBe('SEMI_FLEXIBLE');
    });

    test('otherwise the most flexible declared one', () => {
      expect(flex('FULL_FLEXIBLE', fw('NON_FLEXIBLE', 'SEMI_FLEXIBLE')).scenario.desiredFlexibility).toBe('SEMI_FLEXIBLE');
      expect(flex(undefined, fw('SEMI_FLEXIBLE', 'FULL_FLEXIBLE', 'NON_FLEXIBLE')).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
      expect(flex(undefined, fw('PROMO')).scenario.desiredFlexibility).toBe('PROMO');
      expect(flex(undefined, fw('SEMI_FLEXIBLE')).toCheck).toEqual([]);
    });

    test('nothing declared, or a legacy framework under `config`: as before', () => {
      expect(flex(undefined, fw()).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
      expect(flex(undefined, { offerCriteria: {} }).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
      expect(flex(undefined, { config: fw('NON_FLEXIBLE') }).scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
    });

    // #691: a sale asks for a flexibility the provider sells too.
    test('a sale keeps its flexibility when declared, else takes the most flexible declared', () => {
      expect(flex('FULL_FLEXIBLE', fw('NON_FLEXIBLE'), null).scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
      expect(flex('FULL_FLEXIBLE', fw('NON_FLEXIBLE', 'SEMI_FLEXIBLE'), null).scenario.desiredFlexibility).toBe('SEMI_FLEXIBLE');
      expect(flex('NON_FLEXIBLE', fw('FULL_FLEXIBLE', 'NON_FLEXIBLE'), null).scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
      expect(flex('SEMI_FLEXIBLE', fw('SEMI_FLEXIBLE'), null).toCheck).toEqual([]);
    });

    test('a sale with no flexibility, or a framework that declares none, is not touched', () => {
      expect(flex(undefined, fw('NON_FLEXIBLE'), null).scenario).not.toHaveProperty('desiredFlexibility');
      expect(flex('FULL_FLEXIBLE', fw(), null).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
      expect(flex('FULL_FLEXIBLE', {}, null).scenario.desiredFlexibility).toBe('FULL_FLEXIBLE');
    });
  });

  test('what the Test Data cannot show is to check; the scenario given is not changed', () => {
    const sc = { code: 'X', expectedProduct: 'P' };
    const r = adaptReferenceScenario(sc, {
      reservations: ['MANDATORY'], legClasses: ['FIRST', 'SECOND'], requestedInformation: true, reductionCards: true, providerValues: ['expectedProduct'],
    }, {});
    expect(r.toCheck).toEqual([
      'the chosen train must carry a mandatory seat reservation', 'each leg must be sold in its class: FIRST, SECOND',
      'the provider must ask for passenger details on the chosen trip', 'the passengers\' reduction cards must be ones the provider accepts',
    ]);
    expect(sc.expectedProduct).toBe('P');
  });
});

describe('the catalogue, adapted', () => {
  test('every reference scenario is adapted, and nothing of the simulator\'s overrule codes stays undeclared', () => {
    const entries = catalogueFor(catalogue, simulator, {});
    const { datafile, notes } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, { iropsCodes: { refund: ['CONNECTION_BROKEN'] } });
    expect(Object.keys(notes).sort()).toEqual(catalogue.entries.map(e => e.code).sort());
    const byCode = (c) => datafile.scenarios.find(s => s.code === c);
    expect(byCode('OTST_REFUND_TECHNICAL_CANCELLATION_1ADT').overruleCode).toBe('CONNECTION_BROKEN');
    expect(byCode('NHF_REFUND_OVERRULE_CODE_REFUSED').overruleCode).toBe('SALES_STAFF_ERROR');
    expect(notes.OTST_SALE_RESERVATION_MANDATORY_2ADT.toCheck).toEqual(['the chosen train must carry a mandatory seat reservation']);
    expect(notes.OTST_SALE_ONE_WAY_1ADT).toEqual({ toComplete: [], toCheck: [] });
  });
});

describe('suggestTrip', () => {
  const testData = {
    trains: [{ id: 'T1', services: [{ index: 0 }, { index: 1 }] }, { id: 'T2', services: [] }],
    journeys: [{ id: 'J3', legs: 3 }, { id: 'J2', legs: 2 }],
  };

  test('a trip of several legs gets a journey of as many legs, or nothing', () => {
    expect(suggestTrip({ legs: 2, needsJourney: true }, testData)).toBe('journey::J2');
    expect(suggestTrip({ legs: 4, needsJourney: true }, testData)).toBeNull();
  });

  test('a trip of one leg gets the first train\'s first service, else a journey, else nothing', () => {
    expect(suggestTrip({ legs: 1 }, testData)).toBe('train::T1::0');
    expect(suggestTrip({ legs: 1 }, { trains: [{ id: 'T2', services: [] }], journeys: [] })).toBe('train::T2::0');
    expect(suggestTrip({ legs: 1 }, { trains: [], journeys: [{ id: 'J9', legs: 1 }] })).toBe('journey::J9');
    expect(suggestTrip({ legs: 1 }, { trains: [], journeys: [] })).toBeNull();
  });
});

describe('#704 a sales-horizon entry departs on the framework\'s horizon, or the day after', () => {
  const source = catalogueDatafile(catalogue, simulator);
  const fw = { salesFlows: ['SALE'], passengerTypes: ['ADULT'], maxPassengers: 9 };
  const days = (df, code) => df.scenarios.find(s => s.code === code).departureDaysFromToday;

  test('the horizon\'s last day, the day after; the past one and the source unchanged', () => {
    const config = { ...fw, salesHorizonDays: 60 };
    const { datafile } = adaptCatalogueDatafile(source, catalogueFor(catalogue, simulator, config), config);
    expect(days(datafile, 'OTST_SALE_AT_SALES_HORIZON')).toBe(60);
    expect(days(datafile, 'NHF_SALE_BEYOND_SALES_HORIZON')).toBe(61);
    expect(days(datafile, 'NHF_SALE_DEPARTURE_IN_PAST')).toBe(-1);
    expect(days(source, 'OTST_SALE_AT_SALES_HORIZON')).toBe(90);
    expect(days(source, 'NHF_SALE_BEYOND_SALES_HORIZON')).toBe(91);
    // A horizon entry is not a passenger-limit entry: its list is kept.
    const list = (df) => df.scenarios.find(s => s.code === 'OTST_SALE_AT_SALES_HORIZON').passengersListId;
    expect(list(datafile)).toBe(list(source));
  });

  test('without a declared horizon, left as it is (and cannot be copied)', () => {
    const { datafile } = adaptCatalogueDatafile(source, catalogueFor(catalogue, simulator, fw), fw);
    expect(days(datafile, 'OTST_SALE_AT_SALES_HORIZON')).toBe(90);
  });
});

describe('#699 a limit entry takes the framework\'s maximum number of passengers', () => {
  const { resizedPassengers } = require('../../src/utils/catalogueMatch');
  const source = catalogueDatafile(catalogue, simulator);
  const fw = { salesFlows: ['SALE', 'REFUND_PARTIAL'], passengerTypes: ['ADULT'] };
  const listOf = (df, code) => {
    const sc = df.scenarios.find(s => s.code === code);
    return df.passengersList.find(l => l.id === sc.passengersListId).passengers;
  };

  test('the maximum, and one more for the negative test, each on a list of its own', () => {
    const entries = catalogueFor(catalogue, simulator, { ...fw, maxPassengers: 9 });
    const { datafile } = adaptCatalogueDatafile(source, entries, { ...fw, maxPassengers: 9 });
    expect(listOf(datafile, 'OTST_SALE_MAX_PASSENGERS')).toHaveLength(9);
    expect(listOf(datafile, 'OTST_REFUND_PARTIAL_PASSENGERS_THIRD')).toHaveLength(9);
    expect(listOf(datafile, 'NHF_SALE_TOO_MANY_PASSENGERS')).toHaveLength(10);
    const ids = ['OTST_SALE_MAX_PASSENGERS', 'OTST_REFUND_PARTIAL_PASSENGERS_THIRD', 'NHF_SALE_TOO_MANY_PASSENGERS']
      .map(c => datafile.scenarios.find(s => s.code === c).passengersListId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(source.passengersList.some(l => l.id === id)).toBe(false);
    // Another scenario keeps its list; the source data file is not changed.
    const other = datafile.scenarios.find(s => s.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(other.passengersListId).toBe(source.scenarios.find(s => s.code === 'OTST_SALE_ONE_WAY_1ADT').passengersListId);
    expect(listOf(source, 'OTST_SALE_MAX_PASSENGERS')).toHaveLength(19);
  });

  test('a maximum above the source list makes copies with their own reference, name, e-mail and phone', () => {
    const given = listOf(source, 'OTST_SALE_MAX_PASSENGERS');
    const out = resizedPassengers(given, 25);
    expect(out.map(p => p.reference)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(5, '0')));
    for (const key of ['firstName', 'email', 'phoneNumber']) expect(new Set(out.map(p => p[key])).size).toBe(25);
    expect(out.slice(0, 19).map(p => p.firstName)).toEqual(given.map(p => p.firstName));
    expect(out[19].firstName).toBe(`${given[0].firstName} 20`);
    expect(given).toHaveLength(19);
    expect(resizedPassengers([], 3)).toEqual([]);
    expect(resizedPassengers(given, 2).map(p => p.reference)).toEqual(['00001', '00002']);
  });

  test('without a declared maximum the entry is left as it is', () => {
    const entries = catalogueFor(catalogue, simulator, fw);
    const { datafile } = adaptCatalogueDatafile(source, entries, fw);
    expect(listOf(datafile, 'OTST_SALE_MAX_PASSENGERS')).toHaveLength(19);
    expect(datafile.passengersList).toHaveLength(source.passengersList.length);
  });
});
