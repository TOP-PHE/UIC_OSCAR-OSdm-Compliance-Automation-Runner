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
const { adaptReferenceScenario, adaptCatalogueDatafile, suggestTrip, suggestTrips, journeysMissing, OVERRULE_CODES } = require('../../src/utils/catalogueMatch');
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

  test('a reference place is the simulator\'s coach: kept, and said to complete (#766)', () => {
    const r = adaptReferenceScenario({ code: 'X', referencePlace: '7/15' }, { providerValues: ['referencePlace'] }, {});
    expect(r.scenario.referencePlace).toBe('7/15');
    expect(r.toComplete).toEqual(["a coach and place of the provider's train to sit near (referencePlace, now the simulator's 7/15)"]);
    expect(adaptReferenceScenario({ code: 'X', referencePlace: '7/15' }, {}, {}).toComplete).toEqual([]);
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

  // #1027: the partial refund by leg rides 0000095, where the simulator gives a
  // ticket per leg; the first two-leg journey of the Test Data went elsewhere.
  test('a trip of several legs goes on a journey of its own route first', () => {
    const journeys = [
      { id: 'A', legs: 2, origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002' },
      { id: 'B', legs: 3, origin: 'urn:uic:stn:0000095', destination: 'urn:uic:stn:0000002' },
      { id: 'C', legs: 2, origin: '95', destination: '0000002' },
    ];
    const trip = { legs: 2, needsJourney: true, origin: 'urn:uic:stn:0000095', destination: 'urn:uic:stn:0000002' };
    expect(suggestTrip(trip, { trains: [], journeys })).toBe('journey::C');
    expect(suggestTrip({ ...trip, origin: 'urn:uic:stn:0000007' }, { trains: [], journeys })).toBe('journey::A');
    expect(suggestTrip({ ...trip, destination: 'urn:uic:stn:0000095', origin: 'urn:uic:stn:0000002' }, { trains: [], journeys })).toBe('journey::A');
    expect(suggestTrip({ legs: 2, needsJourney: true }, { trains: [], journeys })).toBe('journey::A');
  });

  // #1019: on the simulator the stop places choose what a scenario tests.
  test('a trip of one leg goes on a train of its own route when there is one', () => {
    const trains = [
      { id: 'X', origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', services: [{ index: 0 }] },
      { id: 'Y', origin: '96', destination: '0000002', services: [{ index: 0 }, { index: 1 }] },
    ];
    expect(suggestTrip({ legs: 1, origin: 'urn:uic:stn:0000096', destination: 'urn:uic:stn:0000002' }, { trains, journeys: [] })).toBe('train::Y::0');
    expect(suggestTrip({ legs: 1, origin: 'urn:uic:stn:0000095', destination: 'urn:uic:stn:0000002' }, { trains, journeys: [] })).toBe('train::X::0');
    expect(suggestTrip({ legs: 1, origin: 'urn:uic:stn:0000002', destination: 'urn:uic:stn:0000096' }, { trains, journeys: [] })).toBe('train::X::0');
  });

  // #1019: a trip specification sends its train's number and carrier (DatedJourney).
  test('a trip specification goes only on a service naming its number and operator code', () => {
    const trains = [
      { id: 'P', origin: '1', destination: '2', operatorCode: '', services: [{ index: 0, vehicleNumber: '9001' }] },
      { id: 'Q', origin: '1', destination: '2', operatorCode: 'urn:x:op', services: [{ index: 0, vehicleNumber: '' }, { index: 1, vehicleNumber: '17' }] },
      { id: 'R', origin: '3', destination: '4', operatorCode: 'urn:x:op', services: [{ index: 0, vehicleNumber: '21' }] },
    ];
    const spec = { legs: 1, tripType: 'SPECIFICATION', origin: '1', destination: '2' };
    expect(suggestTrip(spec, { trains, journeys: [] })).toBe('train::Q::1');
    expect(suggestTrip({ ...spec, origin: '5' }, { trains, journeys: [] })).toBe('train::Q::1');
    expect(suggestTrip(spec, { trains: [trains[0]], journeys: [] })).toBeNull();
    expect(suggestTrip({ ...spec, tripType: 'SEARCH' }, { trains: [trains[0]], journeys: [] })).toBe('train::P::0');
  });

  test('a trip of one leg gets the first train\'s first service, else a journey, else nothing', () => {
    expect(suggestTrip({ legs: 1 }, testData)).toBe('train::T1::0');
    expect(suggestTrip({ legs: 1 }, { trains: [{ id: 'T2', services: [] }], journeys: [] })).toBe('train::T2::0');
    expect(suggestTrip({ legs: 1 }, { trains: [], journeys: [{ id: 'J9', legs: 1 }] })).toBe('journey::J9');
    expect(suggestTrip({ legs: 1 }, { trains: [], journeys: [] })).toBeNull();
  });
});

// #959: the trip an exchange is for goes on another route than its sale's.
describe('suggestTrips', () => {
  const testData = {
    trains: [
      { id: 'A', origin: 'urn:uic:stn:0000001', destination: 'urn:uic:stn:0000002', services: [{ index: 0 }] },
      { id: 'B', origin: '1', destination: '2', services: [{ index: 0 }] },
      { id: 'C', origin: '0000003', destination: '0000001', services: [{ index: 4 }] },
    ],
    journeys: [{ id: 'J1', legs: 2 }, { id: 'J2', legs: 2 }],
  };

  test('a trip of sales only gets what suggestTrip() gives', () => {
    const trips = [{ id: 1, legs: 1, usedBy: ['S'] }, { id: 2, legs: 2, needsJourney: true, usedBy: ['T'] }];
    expect(suggestTrips(trips, testData)).toEqual({ 1: suggestTrip(trips[0], testData), 2: suggestTrip(trips[1], testData) });
  });

  test('an exchange\'s trip goes on another route than its sale trip; a train of the same route under another id does not count', () => {
    const trips = [{ id: 1, legs: 1, usedBy: ['E'] }, { id: 2, legs: 1, usedBy: ['E (exchange)'] }];
    expect(suggestTrips(trips, testData)).toEqual({ 1: 'train::A::0', 2: 'train::C::4' });
  });

  test('an exchange\'s trip takes its own route among the other routes when the Test Data has it (#1019)', () => {
    const trains = [
      { id: 'A', origin: '1', destination: '2', services: [{ index: 0 }] },
      { id: 'D', origin: '5', destination: '6', services: [{ index: 0 }] },
      { id: 'C', origin: '0000003', destination: '0000001', services: [{ index: 4 }] },
    ];
    const trips = [{ id: 1, legs: 1, origin: '1', destination: '2', usedBy: ['E'] },
      { id: 2, legs: 1, origin: 'urn:uic:stn:0000003', destination: 'urn:uic:stn:0000001', usedBy: ['E (exchange)'] }];
    expect(suggestTrips(trips, { trains, journeys: [] })).toEqual({ 1: 'train::A::0', 2: 'train::C::4' });
  });

  test('a trip that is a sale trip too still goes on another route than the exchanging scenario\'s sale', () => {
    const trips = [{ id: 1, legs: 1, usedBy: ['E'] }, { id: 2, legs: 1, usedBy: ['S', 'E (exchange)'] }];
    expect(suggestTrips(trips, testData)[2]).toBe('train::C::4');
  });

  test('no other route: none for a trip of exchanges only, suggestTrip()\'s for a shared one', () => {
    const one = { trains: [testData.trains[0]], journeys: [] };
    expect(suggestTrips([{ id: 1, legs: 1, usedBy: ['E'] }, { id: 2, legs: 1, usedBy: ['E (exchange)'] }], one))
      .toEqual({ 1: 'train::A::0', 2: null });
    expect(suggestTrips([{ id: 1, legs: 1, usedBy: ['E'] }, { id: 2, legs: 1, usedBy: ['S', 'E (exchange)'] }], one))
      .toEqual({ 1: 'train::A::0', 2: 'train::A::0' });
  });

  test('an exchange\'s trip of several legs takes another journey of as many legs', () => {
    const trips = [{ id: 1, legs: 2, needsJourney: true, usedBy: ['E'] }, { id: 2, legs: 2, needsJourney: true, usedBy: ['E (exchange)'] }];
    expect(suggestTrips(trips, testData)).toEqual({ 1: 'journey::J1', 2: 'journey::J2' });
    expect(suggestTrips(trips, { trains: [], journeys: [{ id: 'J1', legs: 2 }] })[2]).toBeNull();
  });

  test('an exchange\'s journey not taken by its sale takes its own route first (#1027)', () => {
    const journeys = [{ id: 'J1', legs: 2, origin: '1', destination: '2' }, { id: 'J2', legs: 2, origin: '1', destination: '2' }, { id: 'J3', legs: 2, origin: '3', destination: '1' }];
    const trips = [{ id: 1, legs: 2, needsJourney: true, origin: '1', destination: '2', usedBy: ['E'] },
      { id: 2, legs: 2, needsJourney: true, origin: '3', destination: '1', usedBy: ['E (exchange)'] }];
    expect(suggestTrips(trips, { trains: [], journeys })).toEqual({ 1: 'journey::J1', 2: 'journey::J3' });
  });

  test('the catalogue\'s exchange to another route: two trips, two routes', () => {
    const { planCopy } = require('../../src/utils/scenarioCopy');
    const plan = planCopy(catalogueDatafile(catalogue, simulator), ['OTST_EXCHANGE_OTHER_ROUTE_1ADT'], {});
    expect(plan.trips.map(t => t.usedBy)).toEqual([['OTST_EXCHANGE_OTHER_ROUTE_1ADT'], ['OTST_EXCHANGE_OTHER_ROUTE_1ADT (exchange)']]);
    const suggested = suggestTrips(plan.trips, testData);
    expect(suggested[plan.trips[0].id]).toBe('train::A::0');
    expect(suggested[plan.trips[1].id]).toBe('train::C::4');
  });
});

// #799: a scenario whose trip has several legs cannot be copied without a
// journey of as many legs in the Test Data.
describe('journeysMissing', () => {
  const trips = [
    { legs: 1, needsJourney: false, usedBy: ['ONE'] },
    { legs: 2, needsJourney: true, usedBy: ['TWO', 'BOTH'] },
    { legs: 3, needsJourney: true, usedBy: ['THREE', 'BOTH'] },
  ];

  test('each scenario names the leg counts no journey has', () => {
    expect(journeysMissing(trips, { journeys: [] })).toEqual({ TWO: [2], BOTH: [2, 3], THREE: [3] });
    expect(journeysMissing(trips, { journeys: [{ id: 'J', legs: 3 }] })).toEqual({ TWO: [2], BOTH: [2] });
  });

  test('a journey of as many legs, or a one-leg trip, needs nothing', () => {
    expect(journeysMissing(trips, { journeys: [{ legs: 2 }, { legs: 3 }] })).toEqual({});
    expect(journeysMissing([{ legs: 1, usedBy: ['ONE'] }], {})).toEqual({});
    expect(journeysMissing(null, null)).toEqual({});
  });

  test('a count is named once per scenario, whatever the number of its trips', () => {
    const twice = [{ legs: 2, needsJourney: true, usedBy: ['A'] }, { legs: 2, needsJourney: true, usedBy: ['A'] }];
    expect(journeysMissing(twice, { journeys: [] })).toEqual({ A: [2] });
  });
});

describe('#705 the age entry takes the framework\'s age ranges', () => {
  const source = catalogueDatafile(catalogue, simulator);
  const base = { salesFlows: ['SALE'], passengerTypes: ['ADULT', 'CHILD', 'YOUTH'], passengerAgeRanges: { ADULT: { min: 26, max: 99 }, CHILD: { min: 4, max: 15 }, YOUTH: { min: 12, max: 25 } } };
  const adapted = (config) => adaptCatalogueDatafile(source, catalogueFor(catalogue, simulator, config), config);
  const listOf = (df) => {
    const sc = df.scenarios.find(s => s.code === 'OTST_SALE_AGE_LIMITS');
    return df.passengersList.find(l => l.id === sc.passengersListId).passengers;
  };
  const edges = (df) => listOf(df).map(p => [p.bornYearsBeforeTravel, p.bornDaysAfter, p.expectedPassengerType]);

  test('the last day of CHILD, the day after it, the first day of ADULT, on a list of its own', () => {
    const { datafile, notes } = adapted(base);
    expect(edges(datafile)).toEqual([[16, 1, 'CHILD'], [16, undefined, 'YOUTH'], [26, undefined, 'ADULT']]);
    expect(notes.OTST_SALE_AGE_LIMITS.toCheck).toEqual([]);
    const id = datafile.scenarios.find(s => s.code === 'OTST_SALE_AGE_LIMITS').passengersListId;
    expect(source.passengersList.some(l => l.id === id)).toBe(false);
    // The source keeps the simulator's ages.
    expect(edges(source)).toEqual([[15, 1, 'CHILD'], [15, undefined, 'YOUTH'], [26, undefined, 'ADULT']]);
    expect(listOf(datafile).map(p => p.firstName)).toEqual(listOf(source).map(p => p.firstName));
  });

  test('the type after CHILD is the declared one holding that age, else ADULT\'s, else unchecked', () => {
    const noYouth = { ...base, passengerTypes: ['ADULT', 'CHILD'], passengerAgeRanges: { ADULT: { min: 16, max: 99 }, CHILD: { min: 4, max: 15 } } };
    expect(edges(adapted(noYouth).datafile)[1]).toEqual([16, undefined, 'ADULT']);
    const gap = { ...base, passengerTypes: ['ADULT', 'CHILD'] };
    const { datafile, notes } = adapted(gap);
    expect(edges(datafile)[1]).toEqual([16, undefined, undefined]);
    expect(notes.OTST_SALE_AGE_LIMITS.toCheck).toEqual([expect.stringContaining('no declared passenger type\'s age range holds 16')]);
  });

  test('without CHILD and ADULT ranges, left as it is (and cannot be copied)', () => {
    const { datafile } = adapted({ salesFlows: ['SALE'], passengerTypes: ['ADULT'] });
    const sc = datafile.scenarios.find(s => s.code === 'OTST_SALE_AGE_LIMITS');
    expect(sc.passengersListId).toBe(source.scenarios.find(s => s.code === 'OTST_SALE_AGE_LIMITS').passengersListId);
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

describe('#709 a provider without the passenger update', () => {
  const source = catalogueDatafile(catalogue, simulator);
  const fw = { salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'EXCHANGE_FULL'], passengerTypes: ['ADULT'] };
  const patching = (df) => df.scenarios.filter(s => s.salesFlowActions?.patchPassengers === true).length;

  test('passengerUpdate false: no copied scenario updates its passengers; the rest of their actions is kept', () => {
    const config = { ...fw, passengerUpdate: false };
    const { datafile } = adaptCatalogueDatafile(source, catalogueFor(catalogue, simulator, config), config);
    expect(patching(source)).toBeGreaterThan(0);
    expect(patching(datafile)).toBe(0);
    for (const sc of datafile.scenarios) {
      const before = source.scenarios.find(s => s.code === sc.code).salesFlowActions;
      if (before) expect(sc.salesFlowActions).toEqual({ ...before, patchPassengers: false });
    }
    // The source is not changed.
    expect(patching(source)).toBe(source.scenarios.filter(s => s.salesFlowActions?.patchPassengers === true).length);
  });

  test('absent or true: as before', () => {
    for (const config of [fw, { ...fw, passengerUpdate: true }]) {
      const { datafile } = adaptCatalogueDatafile(source, catalogueFor(catalogue, simulator, config), config);
      expect(patching(datafile)).toBe(patching(source));
    }
  });
});

// #1027: the reference copies, end to end. On the simulator a copy must go on
// the trains and journeys its source rides, as each reference holds them.
describe('the catalogue copied on a simulator reference', () => {
  const { testDataChoices } = require('../../src/api/helpers/catalogueSource');
  const { planCopy } = require('../../src/utils/scenarioCopy');
  const choicesOf = (provider) => {
    const ref = require(path.join(DATA, 'reference', `simulator-${provider}.json`));
    return testDataChoices(ref.testResources);
  };

  test('a journey states its first and last stop places', () => {
    const { journeys } = choicesOf('zeta');
    expect(journeys.length).toBeGreaterThan(0);
    for (const j of journeys) expect(j).toEqual(expect.objectContaining({ origin: expect.stringMatching(/^urn:uic:stn:\d+$/), destination: expect.stringMatching(/^urn:uic:stn:\d+$/) }));
  });

  test.each(['alpha', 'zeta'])('the partial refund by leg goes on the journey from 0000095 on %s', (provider) => {
    const testData = choicesOf(provider);
    const plan = planCopy(catalogueDatafile(catalogue, simulator), ['OTST_REFUND_PARTIAL_LEG_1ADT'], {});
    const suggested = suggestTrips(plan.trips, testData);
    const journey = testData.journeys.find((j) => `journey::${j.id}` === suggested[plan.trips[0].id]);
    expect(journey).toMatchObject({ legs: 2, origin: 'urn:uic:stn:0000095', destination: 'urn:uic:stn:0000002' });
  });
});
