// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #748: the Test Framework declares how the provider takes an offer request
 * (offerRequestForms: SEARCH, SPECIFICATION, TRIP_IDS). A provider that only
 * answers trip specifications (the 500s on every tripSearchCriteria of a real
 * provider's first runs) gets the catalogue's searches as specifications; one
 * that takes both gets them twice; a scenario in an undeclared form warns.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  offerRequestFormOf, offerRequestFormDeclared, annotateDatafile, OFFER_REQUEST_FORMS,
} = require('../../src/utils/frameworkGating');
const { catalogueFor, catalogueDatafile, requirementsOf, missingFor } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');
const { planCopy, applyCopy } = require('../../src/utils/scenarioCopy');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));

// A framework that declares everything the catalogue needs, but the forms.
const FRAMEWORK = {
  osdmVersion: '3.8',
  salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'EXCHANGE_FULL'],
  returnModels: ['SEPARATE', 'COMBINED'],
  passengerTypes: ['ADULT', 'CHILD', 'YOUTH', 'SENIOR'],
  passengerAgeRanges: { CHILD: { min: 6, max: 14 }, ADULT: { min: 26, max: 64 }, YOUTH: { min: 15, max: 25 } },
  maxPassengers: 9,
  salesHorizonDays: 90,
};
const withForms = (forms) => ({ ...FRAMEWORK, offerRequestForms: forms });
const formMissing = (entry) => entry.missing.filter((m) => m.startsWith('offer requests'));

const datafile = {
  tripRequirements: [
    { id: 1, tripType: 'SEARCH', trip: { origin: 'A', destination: 'B' } },
    { id: 2, tripType: 'SPECIFICATION', legs: [{ origin: 'A', destination: 'B' }] },
  ],
  scenarios: [
    { code: 'S_SEARCH', tripRequirementId: 1 },
    { code: 'S_SPEC', tripRequirementId: 2 },
    { code: 'S_IDS', tripRequirementId: 1, offersByTripIds: 'on' },
    { code: 'S_IDS_NHF', tripRequirementId: 1, tripIdsExpectRejection: true },
    { code: 'S_NO_TRIP' },
  ],
};

describe('#748 — the form of a scenario\'s offer request', () => {
  test('trip ids, then the trip\'s type, SEARCH by default', () => {
    expect(datafile.scenarios.map((s) => offerRequestFormOf(s, datafile)))
      .toEqual(['SEARCH', 'SPECIFICATION', 'TRIP_IDS', 'TRIP_IDS', 'SEARCH']);
    expect(offerRequestFormOf(null, datafile)).toBe('SEARCH');
  });

  test('no list declared takes every form; a list takes what it names', () => {
    for (const form of OFFER_REQUEST_FORMS) expect(offerRequestFormDeclared({}, form)).toBe(true);
    expect(offerRequestFormDeclared({ offerRequestForms: ['SPECIFICATION'] }, 'SEARCH')).toBe(false);
    expect(offerRequestFormDeclared({ offerRequestForms: [] }, 'SPECIFICATION')).toBe(false);
  });

  test('the run\'s copy names the undeclared form, and drops it once declared', () => {
    const df = structuredClone(datafile);
    annotateDatafile(df, { offerRequestForms: ['SPECIFICATION'] });
    expect(df.scenarios.map((s) => s.__featureNotDeclaredWarnings))
      .toEqual([['offerRequestBy:SEARCH'], undefined, ['offerRequestBy:TRIP_IDS'], ['offerRequestBy:TRIP_IDS'], ['offerRequestBy:SEARCH']]);
    annotateDatafile(df, {});
    expect(df.scenarios.every((s) => !('__featureNotDeclaredWarnings' in s))).toBe(true);
  });

  test('the collection says which form, and what to do', () => {
    global.bru = { getEnvVar: () => undefined, setEnvVar: () => {} };
    global.validationLogger = () => {};
    const { featureNotDeclaredWarning } = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
    const line = featureNotDeclaredWarning({ code: 'X' }, 'offerRequestBy:SEARCH');
    expect(line).toMatch(/^\[WARNING\] Scenario "X" asks for offers by trip search, which the Test Framework does not declare \(Offer requests\)/);
    expect(featureNotDeclaredWarning({ code: 'X' }, 'offerRequestBy:TRIP_IDS')).toContain('by trip id');
  });
});

describe('#748 — the catalogue follows the declared forms', () => {
  const plain = catalogueFor(catalogue, simulator, FRAMEWORK);

  test('no declaration: the catalogue as before', () => {
    expect(plain.map((e) => e.code)).toEqual(catalogue.entries.map((e) => e.code));
    expect(plain.some((e) => e.tripAs || e.variantOf || formMissing(e).length)).toBe(false);
  });

  test('what can go as a specification: one-way searches without the train filter', () => {
    const df = catalogueDatafile(catalogue, simulator);
    const req = (code) => requirementsOf(df.scenarios.find((s) => s.code === code), df).offerRequest;
    expect(req('OTST_SALE_ONE_WAY_1ADT')).toEqual({ form: 'SEARCH', convertible: true });
    expect(req('OTST_SALE_RETURN_SEPARATE_1ADT')).toEqual({ form: 'SEARCH', convertible: false });
    expect(req('OTST_SALE_SEARCH_TRAIN_FILTER_1ADT')).toEqual({ form: 'SEARCH', convertible: false });
    expect(req('OTST_SALE_BY_TRIP_ID_1ADT')).toEqual({ form: 'TRIP_IDS', convertible: false });
    expect(req('OTST_SALE_CLASS_PER_LEG_1ADT')).toEqual({ form: 'SPECIFICATION', convertible: false });
    expect(missingFor({ salesFlows: [], passengerTypes: [], offerRequest: { form: 'TRIP_IDS', convertible: false } },
      { offerRequestForms: ['SEARCH'] })).toEqual(['offer requests by trip id']);
  });

  test('specifications only: searches go as specifications, the rest is refused', () => {
    const entries = catalogueFor(catalogue, simulator, withForms(['SPECIFICATION']));
    expect(entries.map((e) => e.code)).toEqual(catalogue.entries.map((e) => e.code));
    const one = entries.find((e) => e.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(one).toMatchObject({ tripAs: 'SPECIFICATION', needs: { trip: 'SPECIFICATION' } });
    expect(one.missing).toEqual([]);
    const refused = entries.filter((e) => formMissing(e).length).map((e) => [e.code, formMissing(e)[0]]);
    expect(refused).toContainEqual(['OTST_SALE_RETURN_SEPARATE_1ADT', 'offer requests by trip search']);
    expect(refused).toContainEqual(['OTST_SALE_SEARCH_TRAIN_FILTER_1ADT', 'offer requests by trip search']);
    expect(refused).toContainEqual(['OTST_SALE_BY_TRIP_ID_1ADT', 'offer requests by trip id']);
    expect(refused.map(([c]) => c)).not.toContain('OTST_SALE_CLASS_PER_LEG_1ADT');
  });

  test('searches only: the specification entries are refused, the searches stay', () => {
    const entries = catalogueFor(catalogue, simulator, withForms(['SEARCH', 'TRIP_IDS']));
    expect(formMissing(entries.find((e) => e.code === 'OTST_SALE_CLASS_PER_LEG_1ADT'))).toEqual(['offer requests by trip specification']);
    expect(entries.find((e) => e.code === 'OTST_SALE_ONE_WAY_1ADT')).not.toHaveProperty('tripAs');
    expect(entries.find((e) => e.code === 'OTST_SALE_BY_TRIP_ID_1ADT').missing).toEqual([]);
  });

  test('all three: each search that can change form comes three times, SEARCH, _SPEC, _TRIPID in that order', () => {
    const entries = catalogueFor(catalogue, simulator, withForms(['SEARCH', 'SPECIFICATION', 'TRIP_IDS']));
    const codes = entries.map((e) => e.code);
    const convertible = plain.filter((e) => e.requirements.offerRequest.convertible).map((e) => e.code);
    const twins = entries.filter((e) => e.variantOf);
    expect(twins.length).toBe(2 * convertible.length);
    for (const code of convertible) {
      const at = codes.indexOf(code);
      expect(codes.slice(at, at + 3)).toEqual([code, `${code}_SPEC`, `${code}_TRIPID`]);
      expect(entries[at]).not.toHaveProperty('tripAs');
      expect(entries[at + 1]).toMatchObject({ variantOf: code, tripAs: 'SPECIFICATION', missing: [] });
      expect(entries[at + 2]).toMatchObject({ variantOf: code, tripAs: 'TRIP_IDS', missing: [] });
      expect(entries[at + 1].purpose).toMatch(/Offers asked by trip specification\.$/);
      expect(entries[at + 2].purpose).toMatch(/Offers asked by trip id, from POST \/trips-collection\.$/);
      expect(entries[at + 2].needs).toEqual(entries[at].needs);
    }
    expect(codes).not.toContain('OTST_SALE_RETURN_SEPARATE_1ADT_SPEC');
    expect(codes).not.toContain('OTST_SALE_RETURN_SEPARATE_1ADT_TRIPID');
    expect(codes).not.toContain('OTST_SALE_BY_TRIP_ID_1ADT_TRIPID');
  });

  test('two forms: only the declared twin is added', () => {
    const codes = catalogueFor(catalogue, simulator, withForms(['SEARCH', 'TRIP_IDS'])).map((e) => e.code);
    expect(codes).toContain('OTST_SALE_ONE_WAY_1ADT_TRIPID');
    expect(codes.some((c) => c.endsWith('_SPEC'))).toBe(false);
  });

  test('trip ids only: searches go by trip id in place, the rest is refused', () => {
    const entries = catalogueFor(catalogue, simulator, withForms(['TRIP_IDS']));
    expect(entries.map((e) => e.code)).toEqual(catalogue.entries.map((e) => e.code));
    const one = entries.find((e) => e.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(one).toMatchObject({ tripAs: 'TRIP_IDS', missing: [] });
    expect(one).not.toHaveProperty('variantOf');
    expect(formMissing(entries.find((e) => e.code === 'OTST_SALE_RETURN_SEPARATE_1ADT'))).toEqual(['offer requests by trip search']);
    expect(formMissing(entries.find((e) => e.code === 'OTST_SALE_CLASS_PER_LEG_1ADT'))).toEqual(['offer requests by trip specification']);
  });

  test('specifications and trip ids: the in-place form is the specification, the trip-id one a twin', () => {
    const entries = catalogueFor(catalogue, simulator, withForms(['SPECIFICATION', 'TRIP_IDS']));
    const codes = entries.map((e) => e.code);
    const at = codes.indexOf('OTST_SALE_ONE_WAY_1ADT');
    expect(entries[at]).toMatchObject({ tripAs: 'SPECIFICATION' });
    expect(entries[at + 1]).toMatchObject({ code: 'OTST_SALE_ONE_WAY_1ADT_TRIPID', tripAs: 'TRIP_IDS' });
  });
});

describe('#759 — the copy of a catalogue search by trip id', () => {
  const fw = withForms(['SEARCH', 'TRIP_IDS']);
  const entries = catalogueFor(catalogue, simulator, fw);
  const { datafile: source, notes } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
  const scenario = (code) => source.scenarios.find((s) => s.code === code);

  test('the twin keeps the search trip and arms offersByTripIds; the original does not', () => {
    const original = scenario('OTST_SALE_ONE_WAY_1ADT');
    const twin = scenario('OTST_SALE_ONE_WAY_1ADT_TRIPID');
    expect(twin.offersByTripIds).toBe('on');
    expect(original.offersByTripIds).not.toBe('on');
    expect(twin.tripRequirementId).toBe(original.tripRequirementId);
    const codes = source.scenarios.map((s) => s.code);
    expect(codes.indexOf(twin.code)).toBe(codes.indexOf(original.code) + 1);
  });

  test('the twin reads as a trip-id scenario, so the framework gate agrees', () => {
    const df = catalogueDatafile(catalogue, simulator);
    df.scenarios = source.scenarios;
    df.tripRequirements = source.tripRequirements;
    expect(requirementsOf(scenario('OTST_SALE_ONE_WAY_1ADT_TRIPID'), df).offerRequest.form).toBe('TRIP_IDS');
  });

  test('trip ids only: the scenario is converted in place', () => {
    const only = withForms(['TRIP_IDS']);
    const { datafile } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), catalogueFor(catalogue, simulator, only), only);
    const sc = datafile.scenarios.find((s) => s.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(sc.offersByTripIds).toBe('on');
    expect(datafile.scenarios.some((s) => s.code.endsWith('_TRIPID'))).toBe(false);
  });

  test('the person copying is told the trip search must find the train', () => {
    const line = "the provider's POST /trips-collection must list a trip for the chosen train's stations and time";
    expect(notes.OTST_SALE_ONE_WAY_1ADT_TRIPID.toCheck).toContain(line);
    expect(notes.OTST_SALE_ONE_WAY_1ADT.toCheck).not.toContain(line);
  });
});

describe('#748 — the copy of a catalogue search as a specification', () => {
  const TRAIN = { id: 9, resource_type: 'TRAIN', label: 'NJ', data: {
    originURN: 'urn:uic:stn:8101003', destinationURN: 'urn:uic:stn:8001071', operatorCode: 'urn:uic:rics:1181',
    productCategoryRef: 'urn:uic:sbc:244', services: [{ vehicleNumber: '492', departureTime: '19:36:00+02:00', arrivalTime: '08:38:00+01:00' }] } };
  const fw = withForms(['SEARCH', 'SPECIFICATION']);
  const entries = catalogueFor(catalogue, simulator, fw);
  const { datafile: source } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
  const tripOf = (code) => {
    const sc = source.scenarios.find((s) => s.code === code);
    return source.tripRequirements.find((t) => t.id === sc.tripRequirementId);
  };

  test('the twin rides a one-leg specification trip of its own; the original keeps its search', () => {
    const original = tripOf('OTST_SALE_ONE_WAY_1ADT');
    const spec = tripOf('OTST_SALE_ONE_WAY_1ADT_SPEC');
    expect(original.tripType).toBe('SEARCH');
    expect(spec).toMatchObject({ tripType: 'SPECIFICATION', legs: [{ origin: original.trip.origin, destination: original.trip.destination }] });
    expect(spec.id).not.toBe(original.id);
    // One specification trip per search trip, however many twins use it.
    const sharing = source.scenarios.filter((s) => s.tripRequirementId === original.id).map((s) => `${s.code}_SPEC`)
      .filter((code) => source.scenarios.some((s) => s.code === code));
    expect(sharing.length).toBeGreaterThan(1);
    for (const code of sharing) expect(tripOf(code).id).toBe(spec.id);
    expect(catalogueDatafile(catalogue, simulator).tripRequirements.every((t) => t.tripType !== 'SPECIFICATION' || t.legs.length > 1)).toBe(true);
  });

  test('the person copying is told the train needs its number and operator', () => {
    const { notes } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
    const line = 'the chosen train must have its number and operator code in Test Data: a trip specification names both';
    expect(notes.OTST_SALE_ONE_WAY_1ADT_SPEC.toCheck).toContain(line);
    expect(notes.OTST_SALE_ONE_WAY_1ADT.toCheck).not.toContain(line);
  });

  test('the leg is filled from the chosen train, and sent as tripSpecifications', () => {
    const codes = ['OTST_SALE_ONE_WAY_1ADT', 'OTST_SALE_ONE_WAY_1ADT_SPEC'];
    const plan = planCopy(source, codes, fw);
    expect(plan.trips.map((t) => t.tripType).sort()).toEqual(['SEARCH', 'SPECIFICATION']);
    const tripMap = Object.fromEntries(plan.trips.map((t) => [String(t.id), { type: 'train', train_id: 9, service_index: 0 }]));
    const { datafile: out, errors } = applyCopy(source, {}, { codes, tripMap, frameworkConfig: fw, resources: [TRAIN], email: 'tm@x.example' });
    expect(errors).toBeUndefined();
    const spec = out.scenarios.find((s) => s.code === 'OTST_SALE_ONE_WAY_1ADT_SPEC');
    const trip = out.tripRequirements.find((t) => t.id === spec.tripRequirementId);
    expect(trip.tripType).toBe('SPECIFICATION');
    expect(trip.legs).toHaveLength(1);
    expect(trip.legs[0]).toMatchObject({ origin: 'urn:uic:stn:8101003', destination: 'urn:uic:stn:8001071', vehicleNumber: '492' });
  });

  test('a copy between companies warns of a form the target does not take', () => {
    const plan = planCopy(datafile, ['S_SEARCH', 'S_SPEC'], { offerRequestForms: ['SPECIFICATION'] });
    expect(plan.scenarios[0].warnings).toContain('Offers are asked by trip search, which the target\'s Test Framework does not declare (Offer requests).');
    expect(plan.scenarios[1].warnings).toEqual([]);
  });
});

describe('#748 — the Test Framework page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').replaceAll('\r\n', '\n');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const start = lines.indexOf('const FW_OFFER_REQUEST_FORMS = [');
  const FW_OFFER_REQUEST_FORMS = vm.runInNewContext(lines.slice(start, lines.indexOf('];', start) + 1).join('\n').replace('const FW_OFFER_REQUEST_FORMS = ', ''));

  test('the page\'s forms are the server\'s', () => {
    expect(FW_OFFER_REQUEST_FORMS.map(([f]) => f)).toEqual(OFFER_REQUEST_FORMS);
  });

  test('the first click starts from every form; the pills follow', () => {
    const wizData = { framework: {} };
    const toggle = lift('fwToggleOfferRequestForm', { wizData, FW_OFFER_REQUEST_FORMS });
    const el = { classList: { toggle: (_c, on) => { el.on = on; } } };
    toggle(el, 'SEARCH');
    expect(wizData.framework.offerRequestForms).toEqual(['SPECIFICATION', 'TRIP_IDS']);
    expect(el.on).toBe(false);
    toggle(el, 'SEARCH');
    expect(wizData.framework.offerRequestForms).toEqual(['SPECIFICATION', 'TRIP_IDS', 'SEARCH']);
    expect(el.on).toBe(true);
  });

  test('the trip type picker marks a form the framework does not take', () => {
    const fwOfferRequestFormDeclared = lift('fwOfferRequestFormDeclared', {});
    const text = lift('tripTypeOptionText', { fwOfferRequestFormDeclared, lbl: (v) => v });
    expect(text('SEARCH', {})).toBe('SEARCH');
    expect(text('SEARCH', { offerRequestForms: ['SPECIFICATION'] })).toBe('⚠ SEARCH — not declared in the Test Framework (Offer requests)');
    expect(page).toContain("${esc(tripTypeOptionText(t, wizData?.framework || {}))}");
    expect(page).toContain("case 'fw-offer-request-form':");
    expect(page).toContain('${offerRequestPanelHtml(fw)}');
  });
});

describe('#748 — an exchange asks offers the way the sale did', () => {
  const env = {};
  const load = () => {
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; }, getVar: () => undefined };
    global.validationLogger = () => {};
    jest.resetModules();
    return require('../../../Bruno_Collection/library-bruno/requestsBuilder.js');
  };
  const body = (tripType) => {
    Object.assign(env, {
      TripType: tripType, fulfillmentIds: JSON.stringify(['F1']),
      offerTripSearchCriteria: JSON.stringify({ origin: { stopPlaceRef: 'A' } }),
      offerTripSpecifications: JSON.stringify([{ legs: [] }]),
      offerSearchCriteria: '{}', offerPassengerSpecifications: JSON.stringify([{ externalRef: '00001', type: 'PERSON' }]),
    });
    load().requestExchangeOffersBody();
    return JSON.parse(env.requestExchangeOffersBodyData);
  };

  test('a specification: tripSpecifications, no tripSearchCriteria', () => {
    const b = body('SPECIFICATION');
    expect(b.tripSpecifications).toEqual([{ legs: [] }]);
    expect(b).not.toHaveProperty('tripSearchCriteria');
  });

  test('a search: tripSearchCriteria, as before', () => {
    const b = body('SEARCH');
    expect(Object.keys(b).slice(0, 3)).toEqual(['fulfillmentIds', 'tripSearchCriteria', 'offerSearchCriteria']);
    expect(b).not.toHaveProperty('tripSpecifications');
  });
});
