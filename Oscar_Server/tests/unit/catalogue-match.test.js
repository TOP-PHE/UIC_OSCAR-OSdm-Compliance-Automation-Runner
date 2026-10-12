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
