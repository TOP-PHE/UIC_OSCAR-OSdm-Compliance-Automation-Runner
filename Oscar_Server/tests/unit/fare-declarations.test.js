// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #937: what a fare provider declares in its Test Framework, the fare
 * reference scenarios of the catalogue, and their copy (cluster, free child,
 * section moved onto the chosen trip).
 */

const fs = require('node:fs');
const path = require('node:path');

const F = require('../../src/utils/fareDeclarations');
const { mappedSections, tripStations, stationKey } = require('../../src/utils/fareSections');
const { catalogueFor, catalogueDatafile, missingFor } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');
const { applyCopy } = require('../../src/utils/scenarioCopy');

const ROOT = path.join(__dirname, '..', '..', '..');
const DATA = path.join(ROOT, 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));

const FARE_FW = {
  osdmVersion: '3.8.0', distributionModes: ['FARE'], salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT', 'CHILD', 'BICYCLE'],
  reductionCards: [{ code: 'CARD25', issuer: '9999' }],
  fares: { clusters: ['FULL_FLEX', 'NON_FLEX'], combinationModels: ['CLUSTERING', 'COMBINING'], statedRefundFee: true, reservations: ['BICYCLE'], salesFlows: ['SALE', 'REFUND_FULL'], freeUnderAge: 6 },
};
const fareEntries = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => /FARE/.test(e.code));

describe('#937 what a framework declares in fares', () => {
  test('absent means every cluster, either model, no stated fee, no reservation, SALE only, no free age', () => {
    expect(F.declaredFareClusters({})).toEqual([...F.FARE_CLUSTERS]);
    expect(F.combinationModelDeclared({}, 'COMBINING')).toBe(true);
    expect(F.statedRefundFeeDeclared({})).toBe(false);
    expect(F.fareReservationDeclared({}, 'BICYCLE')).toBe(false);
    expect(F.fareSalesFlowDeclared({}, 'SALE')).toBe(true);
    expect(F.fareSalesFlowDeclared({}, 'REFUND_FULL')).toBe(false);
    expect(F.freeUnderAgeOf({})).toBeNull();
  });

  test('a declaration is read under config too, in OSCAR\'s order', () => {
    const fw = { config: { fares: { clusters: ['NON_FLEX', 'BUSINESS'], combinationModels: ['COMBINING'], freeUnderAge: 6 } } };
    expect(F.declaredFareClusters(fw)).toEqual(['BUSINESS', 'NON_FLEX']);
    expect(F.combinationModelDeclared(fw, 'CLUSTERING')).toBe(false);
    expect(F.freeUnderAgeOf(fw)).toBe(6);
  });

  test('the cluster of a copy: its own when declared, else the most flexible declared', () => {
    const fw = { fares: { clusters: ['SEMI_FLEX', 'NON_FLEX'] } };
    expect(F.fareClusterFor('NON_FLEX', fw)).toBe('NON_FLEX');
    expect(F.fareClusterFor('FULL_FLEX', fw)).toBe('SEMI_FLEX');
    expect(F.fareClusterFor(null, fw)).toBeNull();
    expect(F.fareClusterFor('PROMO', { fares: { clusters: [] } })).toBeNull();
  });

  test('a stored value must be known', () => {
    expect(F.fareDeclarationsProblem(undefined)).toBeNull();
    expect(F.fareDeclarationsProblem(FARE_FW.fares)).toBeNull();
    expect(F.fareDeclarationsProblem([])).toContain('must be an object');
    expect(F.fareDeclarationsProblem({ cluster: [] })).toContain('not a fare declaration');
    expect(F.fareDeclarationsProblem({ clusters: 'NON_FLEX' })).toContain('must be a list');
    expect(F.fareDeclarationsProblem({ clusters: ['NON_FLEX', 'NON_FLEX'] })).toContain('twice');
    expect(F.fareDeclarationsProblem({ combinationModels: ['ZONES'] })).toContain('"ZONES"');
    expect(F.fareDeclarationsProblem({ salesFlows: ['REFUND_FULL'] })).toContain('must hold SALE');
    expect(F.fareDeclarationsProblem({ statedRefundFee: 'yes' })).toContain('true or false');
    for (const age of [0, 31, 6.5, '6']) expect(F.fareDeclarationsProblem({ freeUnderAge: age })).toContain('freeUnderAge');
  });

  test('versions compare by number, never as decimals', () => {
    expect(F.versionAtLeast('3.10.0', 3, 8)).toBe(true);
    expect(F.versionAtLeast('3.7.0', 3, 8)).toBe(false);
    expect(F.versionAtLeast('', 3, 8)).toBe(false);
  });

  test('a simulated provider declares its profile\'s fares, the 3.8 ones from 3.8', () => {
    const fares = { clusters: ['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX'], freeUnderAge: 6 };
    expect(F.referenceFares({ osdmVersion: '3.6.0', fares })).toEqual({
      clusters: ['FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX'], combinationModels: ['CLUSTERING', 'COMBINING'], statedRefundFee: false,
      reservations: [], salesFlows: ['SALE', 'REFUND_FULL'], freeUnderAge: 6,
    });
    expect(F.referenceFares({ osdmVersion: '3.10.0', fares })).toMatchObject({ statedRefundFee: true, reservations: ['BICYCLE'] });
    expect(F.referenceFares({ osdmVersion: '3.8.0' })).toBeUndefined();
    for (const p of ['alpha', 'gamma', 'zeta']) {
      const ref = JSON.parse(fs.readFileSync(path.join(DATA, 'reference', `simulator-${p}.json`), 'utf8'));
      expect(F.fareDeclarationsProblem(ref.framework.fares)).toBeNull();
    }
  });
});

describe('#937 the fare entries of the catalogue', () => {
  test('a framework declaring everything is offered all twenty-four (and #1449\'s three, sold without a trip)', () => {
    const entries = fareEntries(FARE_FW);
    expect(entries).toHaveLength(27);
    const refused = entries.filter((e) => e.missing.length && !['NHF_FARE_PRODUCT_ONLY', 'NHF_NONTRIP_FARES_1ADT'].includes(e.code) && !/^OTST_NONTRIP_FARES_/.test(e.code));
    expect(refused.map((e) => [e.code, e.missing])).toEqual([]);
    expect(entries.find((e) => e.code === 'NHF_FARE_PRODUCT_ONLY').missing).toEqual(['product-based distribution (Distribution)']);
    // #1444: the probe of fares without a trip also needs offers without a trip declared.
    expect(entries.find((e) => e.code === 'NHF_NONTRIP_FARES_1ADT').missing).toEqual(['offer requests without a trip, in zones']);
    expect(fareEntries({ ...FARE_FW, offerRequestForms: ['SEARCH', 'NON_TRIP_ZONES'] }).find((e) => e.code === 'NHF_NONTRIP_FARES_1ADT').missing).toEqual([]);
  });

  test('a fare entry keeps its form: no _SPEC or _TRIPID twin', () => {
    const entries = fareEntries({ ...FARE_FW, offerRequestForms: ['SEARCH', 'SPECIFICATION', 'TRIP_IDS'] });
    expect(entries).toHaveLength(27);
    expect(entries.some((e) => e.variantOf)).toBe(false);
  });

  test('each declaration it lacks is named, once the provider sells fares', () => {
    const missing = Object.fromEntries(fareEntries({ osdmVersion: '3.7.0', distributionModes: ['FARE'], salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT', 'BICYCLE'], fares: { combinationModels: ['CLUSTERING'] } }).map((e) => [e.code, e.missing]));
    expect(missing.OTST_FARE_SPEC_1ADT).toEqual([]);
    expect(missing.OTST_FARE_REFUND_1ADT).toEqual(['a refund of fares (Fares › Sales flows)']);
    expect(missing.OTST_FARE_REFUND_SRCH_1ADT).toEqual(['a refund of fares (Fares › Sales flows)']);
    expect(missing.OTST_FARE_REFUND_TRIPIDS_1ADT).toEqual(['a refund of fares (Fares › Sales flows)']);
    expect(missing.OTST_FARE_REFUND_FEE_1ADT).toEqual(['a refund of fares (Fares › Sales flows)', 'a refund fee the distributor states (Fares)', 'OSDM 3.8 or later']);
    expect(missing.OTST_FARE_REFUND_COMBINING_1ADT).toEqual(['a refund of fares (Fares › Sales flows)', 'fares combined by COMBINING (Fares › Combination models)']);
    expect(missing.OTST_FARE_BICYCLE_1ADT).toEqual(['a fare reservation for a bicycle (Fares › Reservations)', 'OSDM 3.8 or later']);
    expect(missing.OTST_FARE_FREE_CHILD).toEqual(['the age under which a fare is free (Fares)']);
    // #1045: the entries of the newer simulator fare scenarios.
    expect(missing.OTST_FARE_FIRST_1ADT).toEqual([]);
    expect(missing.OTST_FARE_REDUCTION_CARD_1ADT).toEqual(['a reduction card the provider accepts (Passenger Types › Reduction cards)']);
    expect(missing.OTST_FARE_FAMILY).toEqual(['the age under which a fare is free (Fares)']);
    expect(missing.OTST_FARE_BICYCLE_ADMISSION).toEqual([]);
    expect(missing.OTST_FARE_GROUP_6ADT).toEqual([]);
  });

  // #1045: a refund of fares was offered by trip specification only, so a
  // provider taking search criteria alone had no fare refund to copy.
  test('#1045: a refund of fares in each form of offer request, each offered to a provider taking that form', () => {
    const refunds = (forms) => fareEntries({ ...FARE_FW, offerRequestForms: forms })
      .filter((e) => /^OTST_FARE_REFUND_(1ADT|SRCH_1ADT|TRIPIDS_1ADT)$/.test(e.code) && e.missing.length === 0).map((e) => e.code);
    expect(refunds(['SEARCH'])).toEqual(['OTST_FARE_REFUND_SRCH_1ADT']);
    expect(refunds(['SPECIFICATION'])).toEqual(['OTST_FARE_REFUND_1ADT']);
    expect(refunds(['TRIP_IDS'])).toEqual(['OTST_FARE_REFUND_TRIPIDS_1ADT']);
    expect(refunds(['SEARCH', 'SPECIFICATION', 'TRIP_IDS'])).toEqual(['OTST_FARE_REFUND_1ADT', 'OTST_FARE_REFUND_SRCH_1ADT', 'OTST_FARE_REFUND_TRIPIDS_1ADT']);
  });

  test('#1045: a bicycle sold as a passenger needs its passenger type, nothing under Fares', () => {
    const missing = Object.fromEntries(fareEntries({ ...FARE_FW, passengerTypes: ['ADULT'], fares: {} }).map((e) => [e.code, e.missing]));
    expect(missing.OTST_FARE_BICYCLE_ADMISSION).toEqual(['passenger type BICYCLE']);
  });

  test('a provider selling no fare is told the distribution only', () => {
    for (const e of fareEntries({ osdmVersion: '3.8.0', salesFlows: ['SALE', 'REFUND_FULL'] })) {
      expect(e.missing.filter((m) => /Fares/.test(m))).toEqual([]);
      expect(e.missing[0]).toBe('fare-based distribution (Distribution)');
    }
  });

  test('the older version rule still reads 3.7 for a combined return', () => {
    expect(missingFor({ salesFlows: [], minOsdmVersion: '3.7', passengerTypes: [] }, { osdmVersion: '3.10.0' })).toEqual([]);
    expect(missingFor({ salesFlows: [], minOsdmVersion: '3.7', passengerTypes: [] }, { osdmVersion: '3.6.0' })).toEqual(['OSDM 3.7 or later']);
  });
});

describe('#937 the copy of a fare entry', () => {
  const adapted = (fw) => {
    const entries = fareEntries(fw);
    const file = catalogueDatafile(catalogue, simulator);
    return adaptCatalogueDatafile(file, entries, fw);
  };

  test('the cluster is one the framework declares', () => {
    const { datafile } = adapted(FARE_FW);
    const by = Object.fromEntries(datafile.scenarios.map((s) => [s.code, s]));
    expect(by.OTST_FARE_SPEC_1ADT.desiredFareCluster).toBe('FULL_FLEX');   // SEMI_FLEX not declared
    expect(by.OTST_FARE_SRCH_1ADT.desiredFareCluster).toBe('NON_FLEX');    // its own
  });

  test('the free child is one year under the declared age, in a list of its own', () => {
    const { datafile } = adapted({ ...FARE_FW, fares: { ...FARE_FW.fares, freeUnderAge: 12 } });
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_FARE_FREE_CHILD');
    const list = datafile.passengersList.find((l) => l.id === sc.passengersListId);
    expect(list.passengers.map((p) => p.bornYearsBeforeTravel)).toEqual([undefined, 11]);
    expect(simulator.passengersList.find((l) => l.id === 29).passengers[1].bornYearsBeforeTravel).toBe(3);
  });

  test('#1045: in a family only the youngest becomes the free child; the adult and the older child keep their ages', () => {
    const { datafile } = adapted(FARE_FW);
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_FARE_FAMILY');
    const list = datafile.passengersList.find((l) => l.id === sc.passengersListId);
    expect(list.passengers.map((p) => p.bornYearsBeforeTravel)).toEqual([35, 8, 5]);
    expect(list.passengers.map((p) => p.expectedPassengerType)).toEqual(['ADULT', 'CHILD', 'YOUNG_CHILD']);
  });

  test('#1045: the card holder of a fare sale takes the first card declared', () => {
    const { datafile } = adapted(FARE_FW);
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_FARE_REDUCTION_CARD_1ADT');
    const list = datafile.passengersList.find((l) => l.id === sc.passengersListId);
    expect(list.passengers.map((p) => p.reductionCards)).toEqual([[{ code: 'CARD25', issuer: '9999' }]]);
  });

  test('what is left to check names the section and the model', () => {
    const { notes } = adapted(FARE_FW);
    expect(notes.OTST_FARE_SPEC_1ADT.toCheck).toContain('the provider must sell fares for the section asked on the chosen trip (requestedSections)');
    expect(notes.OTST_FARE_REFUND_COMBINING_1ADT.toCheck).toContain('the provider\'s fares on the chosen trip must be combined by COMBINING');
    expect(notes.OTST_FARE_TRIPIDS_1ADT.toCheck).toContain('the provider\'s POST /trips-collection must list a trip for the chosen train\'s stations and time');
  });
});

describe('#937 a section moved onto the chosen trip', () => {
  const spec = (...stations) => ({ tripType: 'SPECIFICATION', legs: stations.slice(1).map((d, i) => ({ origin: stations[i], destination: d })) });
  const search = (o, d) => ({ tripType: 'SEARCH', trip: { origin: o, destination: d } });
  const from = spec('urn:uic:stn:0000001', 'urn:uic:stn:0000004', 'urn:uic:stn:0000002');

  test('stations compare without prefix or leading zeros; a trip lists its stations in order', () => {
    expect(stationKey('urn:uic:stn:0000004')).toBe(stationKey('4'));
    expect(stationKey('Bern')).toBe('Bern');
    expect(tripStations(from)).toEqual(['urn:uic:stn:0000001', 'urn:uic:stn:0000004', 'urn:uic:stn:0000002']);
    expect(tripStations(search('A', 'B'))).toEqual(['A', 'B']);
  });

  test('the last leg stays the last leg, the whole trip the whole trip', () => {
    const to = spec('8500010', '8507000', '8509000', '8000105');
    const last = [{ startPlace: 'urn:uic:stn:0000004', endPlace: 'urn:uic:stn:0000002' }];
    expect(mappedSections(last, from, to)).toEqual([{ startPlace: '8509000', endPlace: '8000105' }]);
    const whole = [{ startPlace: 'urn:uic:stn:0000001', endPlace: 'urn:uic:stn:0000002' }];
    expect(mappedSections(whole, search('urn:uic:stn:0000001', 'urn:uic:stn:0000002'), to)).toEqual([{ startPlace: '8500010', endPlace: '8000105' }]);
  });

  test('on a trip of one leg an inner station has no place: the section is the whole trip', () => {
    const last = [{ startPlace: 'urn:uic:stn:0000004', endPlace: 'urn:uic:stn:0000002' }];
    expect(mappedSections(last, from, search('X', 'Y'))).toEqual([{ startPlace: 'X', endPlace: 'Y' }]);
  });

  test('a section not on its trip, an empty list and anything else are kept as they are', () => {
    const odd = [{ startPlace: 'urn:uic:stn:0000099', endPlace: 'urn:uic:stn:0000002' }, null];
    expect(mappedSections(odd, from, spec('A', 'B'))).toEqual(odd);
    expect(mappedSections([], from, spec('A', 'B'))).toEqual([]);
    expect(mappedSections(undefined, from, spec('A', 'B'))).toBeUndefined();
    const given = [{ startPlace: 'urn:uic:stn:0000004', endPlace: 'urn:uic:stn:0000002' }];
    mappedSections(given, from, spec('A', 'B', 'C'));
    expect(given[0].startPlace).toBe('urn:uic:stn:0000004');
  });

  test('the copy writes the moved section on the copied scenario', () => {
    const resources = [
      { id: 't1', resource_type: 'TRAIN', data: { originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8507000', services: [{ vehicleNumber: '1' }] } },
      { id: 't2', resource_type: 'TRAIN', data: { originURN: 'urn:uic:stn:8507000', destinationURN: 'urn:uic:stn:8000105', services: [{ vehicleNumber: '2' }] } },
      { id: 'j1', resource_type: 'JOURNEY', data: { legs: [{ trainResourceId: 't1', serviceIndex: 0 }, { trainResourceId: 't2', serviceIndex: 0 }] } },
    ];
    const source = catalogueDatafile(catalogue, simulator);
    const out = applyCopy(source, { scenarios: [] }, {
      codes: ['OTST_FARE_SPEC_1ADT'], tripMap: { 24: { type: 'journey', journey_id: 'j1' } }, frameworkConfig: FARE_FW, resources, email: 'tm@example.org',
    });
    expect(out.errors).toBeUndefined();
    const sc = out.datafile.scenarios[0];
    const trip = out.datafile.tripRequirements.find((t) => t.id === sc.tripRequirementId);
    const stations = tripStations(trip);
    expect(stations).toEqual(['urn:uic:stn:8500010', 'urn:uic:stn:8507000', 'urn:uic:stn:8000105']);
    expect(sc.requestedSections).toEqual([{ startPlace: stations[1], endPlace: stations[2] }]);
  });
});

// #1449: fares sold without a trip, a theoretical case.
describe('#1449 fares sold without a trip', () => {
  const { derivedCapability, traitsOf, stepCapabilities, SALE_GOAL } = require('../../src/utils/capabilities');
  const { declaredFunctions, functionsOf } = require('../../src/utils/frameworkCoverage');
  const { dataNeedsOf, simulatorFacts } = require('../../src/utils/scenarioCatalogue');
  const { adaptReferenceScenario } = require('../../src/utils/catalogueMatch');
  const { runListFor } = require('../../src/utils/referenceConfiguration');
  const sim = (code) => simulator.scenarios.find((s) => s.code === code);
  const SALES = ['SIM_FARE_NONTRIP_ZONE_1ADT_38', 'SIM_FARE_NONTRIP_NUTS_1ADT_38', 'SIM_FARE_NONTRIP_PLACES_1ADT_38'];
  const FORMS = ['SEARCH', 'NON_TRIP_PLACES', 'NON_TRIP_ZONES', 'NON_TRIP_NUTS'];
  const entry = (fw, code) => fareEntries(fw).find((e) => e.code === code);

  test('fares.nonTrip is true or false; absent is not declared', () => {
    expect(F.FARE_KEYS).toContain('nonTrip');
    expect(F.fareDeclarationsProblem({ nonTrip: true })).toBeNull();
    expect(F.fareDeclarationsProblem({ nonTrip: false })).toBeNull();
    expect(F.fareDeclarationsProblem({ nonTrip: 'yes' })).toBe('fares.nonTrip must be true or false.');
    expect(F.nonTripFaresDeclared({})).toBe(false);
    expect(F.nonTripFaresDeclared({ config: { fares: { nonTrip: true } } })).toBe(true);
  });

  test('a fare scenario without a trip needs it declared; #1444\'s probe needs it not declared', () => {
    const parts = ['FARE_ADMISSION'];
    expect(F.fareRequirementsOf({}, parts, {}, { nonTrip: true })).toEqual({ nonTrip: true });
    expect(F.fareRequirementsOf({ nonTripFaresExpectRejection: 'on' }, parts, {}, { nonTrip: true })).toEqual({ nonTripRefused: true });
    expect(F.fareRequirementsOf({}, parts)).toEqual({});
    expect(F.fareRequirementsOf({}, ['ADMISSION'], {}, { nonTrip: true })).toEqual({});
    expect(F.fareMissing({ nonTrip: true }, {})).toEqual(['fares sold without a trip (Fares)']);
    expect(F.fareMissing({ nonTrip: true }, { fares: { nonTrip: true } })).toEqual([]);
    expect(F.fareMissing({ nonTripRefused: true }, { fares: { nonTrip: true } })).toEqual(['a provider that does not sell fares without a trip: this framework declares them sold (Fares)']);
    expect(F.fareMissing({ nonTripRefused: true }, {})).toEqual([]);
  });

  test('the catalogue offers the three sales when declared, with their form; the probe only when not declared', () => {
    const declared = { ...FARE_FW, offerRequestForms: FORMS, fares: { ...FARE_FW.fares, nonTrip: true } };
    for (const code of ['OTST_NONTRIP_FARES_ZONE_1ADT', 'OTST_NONTRIP_FARES_NUTS_1ADT', 'OTST_NONTRIP_FARES_PLACES_1ADT']) {
      expect([code, entry(declared, code).missing]).toEqual([code, []]);
      expect(entry({ ...FARE_FW, offerRequestForms: FORMS }, code).missing).toEqual(['fares sold without a trip (Fares)']);
    }
    expect(entry({ ...declared, offerRequestForms: ['SEARCH', 'NON_TRIP_ZONES'] }, 'OTST_NONTRIP_FARES_NUTS_1ADT').missing).toEqual(['offer requests without a trip, in regions named by NUTS codes']);
    expect(entry(declared, 'NHF_NONTRIP_FARES_1ADT').missing).toEqual(['a provider that does not sell fares without a trip: this framework declares them sold (Fares)']);
    expect(entry({ ...FARE_FW, offerRequestForms: FORMS }, 'NHF_NONTRIP_FARES_1ADT').missing).toEqual([]);
  });

  test('their capability is fares.nonTrip, proved at the sale\'s step; the probe stays a refusal of fare offers', () => {
    for (const code of SALES) {
      expect([code, derivedCapability(sim(code), simulator)]).toEqual([code, 'fares.nonTrip']);
      expect(stepCapabilities(SALE_GOAL, traitsOf(sim(code), simulator))).toEqual(['fares.nonTrip']);
    }
    expect(stepCapabilities(SALE_GOAL, traitsOf(sim('SIM_FARE_SRCH_1ADT_38'), simulator))).toEqual(['fares.sale']);
    expect(derivedCapability(sim('SIM_NHF_FARE_NONTRIP_1ADT_38'), simulator)).toBe('fares.offers');
  });

  test('the coverage: a row when declared, and the function of each sale', () => {
    const fw = { distributionModes: ['FARE'], fares: { nonTrip: true } };
    expect(declaredFunctions(fw).filter((r) => r.id === 'fare:nonTrip')).toEqual([{ id: 'fare:nonTrip', group: 'Fares', label: 'Fares sold without a trip' }]);
    expect(declaredFunctions({ distributionModes: ['FARE'], fares: {} }).some((r) => r.id === 'fare:nonTrip')).toBe(false);
    for (const code of SALES) expect(functionsOf(sim(code), simulator)).toContain('fare:nonTrip');
    expect(functionsOf(sim('SIM_NHF_FARE_NONTRIP_1ADT_38'), simulator)).not.toContain('fare:nonTrip');
  });

  test('a stop place of the trip whose zone is asked is the simulator\'s: a value to complete in a copy', () => {
    const facts = simulatorFacts(JSON.parse(fs.readFileSync(path.join(ROOT, 'OSDM_Simulator', 'providers', 'gamma.json'), 'utf8')));
    const needs = dataNeedsOf(sim('SIM_FARE_NONTRIP_ZONE_1ADT_38'), simulator, facts);
    expect(needs.providerValues).toEqual(['zoneOf']);
    expect(adaptReferenceScenario(sim('SIM_FARE_NONTRIP_ZONE_1ADT_38'), needs, {}).toComplete)
      .toEqual(["a stop place of the provider in one of its zones, whose zone is asked (Trip → Zone of a stop place of the trip, now the simulator's)"]);
  });

  test('the simulator references declare it, and their run list leaves #1444\'s probe out', () => {
    for (const provider of ['alpha', 'gamma', 'zeta']) {
      const ref = JSON.parse(fs.readFileSync(path.join(DATA, 'reference', `simulator-${provider}.json`), 'utf8'));
      expect([provider, ref.framework.fares.nonTrip]).toEqual([provider, true]);
      expect(ref.scenariosToRun.some((c) => c.startsWith('SIM_NHF_FARE_NONTRIP_'))).toBe(false);
      expect(ref.scenariosToRun.filter((c) => c.startsWith('SIM_FARE_NONTRIP_'))).toHaveLength(3);
    }
    expect(runListFor(simulator, '3.8.0')).toContain('SIM_NHF_FARE_NONTRIP_1ADT_38');
    expect(runListFor(simulator, '3.8.0', { fares: { nonTrip: true } })).not.toContain('SIM_NHF_FARE_NONTRIP_1ADT_38');
  });
});
