// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * non-trip-forms.test.js — #1258: an offer request without a trip, by stop
 * places or by zones, as the server and the Test Config page read it: the
 * offer request form, the golden rule's warning, the capability, the run
 * filters, the catalogue's forms and Test Data, and the trip editor.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('../../src/utils/frameworkGating');
const { derivedCapability, CAPABILITIES } = require('../../src/utils/capabilities');
const { facetsOf } = require('../../src/utils/runFilters');
const R = require('../../src/utils/referenceConfiguration');

const datafile = {
  tripRequirements: [
    { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:1', destination: 'urn:uic:stn:2', startDatetime: '%TRIP_DATE%T08:00:00+01:00' } },
    { id: 2, tripType: 'NON_TRIP', nonTrip: { by: 'PLACES', places: ['urn:uic:stn:40', 'urn:uic:stn:41'] } },
    { id: 3, tripType: 'NON_TRIP', nonTrip: { by: 'ZONES', zones: [] } },
  ],
  scenarios: [
    { code: 'S_SEARCH', scenarioType: 'SALE', tripRequirementId: 1 },
    { code: 'S_PLACES', scenarioType: 'SALE', tripRequirementId: 2 },
    { code: 'S_ZONES', scenarioType: 'SALE', tripRequirementId: 3, offersByTripIds: 'on' },
  ],
};
const [search, places, zones] = datafile.scenarios;

describe('the server', () => {
  test('the form of a non-trip request, whatever else the scenario arms', () => {
    expect(G.offerRequestFormOf(search, datafile)).toBe('SEARCH');
    expect(G.offerRequestFormOf(places, datafile)).toBe('NON_TRIP_PLACES');
    expect(G.offerRequestFormOf(zones, datafile)).toBe('NON_TRIP_ZONES');
    expect(G.OFFER_REQUEST_FORMS).toEqual([...G.TRIP_REQUEST_FORMS, ...G.NON_TRIP_REQUEST_FORMS]);
    for (const form of G.OFFER_REQUEST_FORMS) expect(G.OFFER_REQUEST_TEXT[form]).toEqual(expect.any(String));
  });

  test('the golden rule: a non-trip form the framework leaves out is warned; no list declares the trip forms only', () => {
    expect(G.offerRequestFormDeclared({}, 'NON_TRIP_PLACES')).toBe(false);
    expect(G.offerRequestFormDeclared({}, 'NON_TRIP_ZONES')).toBe(false);
    expect(G.offerRequestFormDeclared({}, 'SEARCH')).toBe(true);
    expect(G.offerRequestFormDeclared({ offerRequestForms: ['SEARCH'] }, 'NON_TRIP_PLACES')).toBe(false);
    const noList = structuredClone(datafile);
    G.annotateDatafile(noList, {});
    const warned = (code) => noList.scenarios.find((s) => s.code === code).__featureNotDeclaredWarnings || [];
    expect(warned('S_PLACES')).toContain('offerRequestBy:NON_TRIP_PLACES');
    expect(warned('S_ZONES')).toContain('offerRequestBy:NON_TRIP_ZONES');
    expect(warned('S_SEARCH')).not.toContain('offerRequestBy:SEARCH');
    // annotateDatafile() writes the warnings into the file it is given.
    const annotated = structuredClone(datafile);
    G.annotateDatafile(annotated, { offerRequestForms: ['SEARCH', 'NON_TRIP_ZONES'] });
    const warnings = (code) => annotated.scenarios.find((s) => s.code === code).__featureNotDeclaredWarnings || [];
    expect(warnings('S_PLACES')).toContain('offerRequestBy:NON_TRIP_PLACES');
    expect(warnings('S_ZONES')).not.toContain('offerRequestBy:NON_TRIP_ZONES');
    expect(warnings('S_SEARCH')).not.toContain('offerRequestBy:SEARCH');
  });

  test('a non-trip sale is for its own capability', () => {
    expect(derivedCapability(places, datafile)).toBe('offers.nonTripPlaces');
    expect(derivedCapability(zones, datafile)).toBe('offers.nonTripZones');
    expect(derivedCapability(search, datafile)).toBe('sale');
    const ids = CAPABILITIES.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['offers.nonTripPlaces', 'offers.nonTripZones']));
  });

  test('the run filters know the two forms', () => {
    const facets = facetsOf(['S_SEARCH', 'S_PLACES', 'S_ZONES'], { datafile });
    expect(facets.map((f) => f.form)).toEqual(['SEARCH', 'NON_TRIP_PLACES', 'NON_TRIP_ZONES']);
    expect(facets.map((f) => f.group)).toEqual(['Sale', 'Offers', 'Offers']);
  });

  test('a request without a trip gives no Test Data train', () => {
    const resources = R.testResourcesFromDatafile(datafile);
    expect(resources).toHaveLength(1);
    expect(resources[0].data.originURN).toBe('urn:uic:stn:1');
  });
});

describe('the catalogue', () => {
  const { catalogueFor } = require('../../src/utils/scenarioCatalogue');
  const { readCatalogue } = require('../../src/api/helpers/catalogueSource');

  test('a trip search is offered in the trip forms declared, never as a non-trip request', () => {
    const { catalogue, simulator } = readCatalogue();
    const fw = { offerRequestForms: ['SEARCH', 'TRIP_IDS', 'NON_TRIP_PLACES', 'NON_TRIP_ZONES'] };
    const out = catalogueFor(catalogue, simulator, fw);
    expect(out.some((e) => e.tripAs === 'TRIP_IDS')).toBe(true);
    expect(out.some((e) => G.NON_TRIP_REQUEST_FORMS.includes(e.tripAs))).toBe(false);
    // The same entries as with the trip forms alone.
    const tripOnly = catalogueFor(catalogue, simulator, { offerRequestForms: ['SEARCH', 'TRIP_IDS'] });
    expect(out.map((e) => e.code)).toEqual(tripOnly.map((e) => e.code));
  });

  test('the non-trip entries need their form declared', () => {
    const { catalogue, simulator } = readCatalogue();
    const nonTrip = catalogueFor(catalogue, simulator, { offerRequestForms: ['SEARCH'] })
      .filter((e) => /^OTST_NONTRIP_/.test(e.code));
    expect(nonTrip.map((e) => e.code).sort()).toEqual(['OTST_NONTRIP_CARD_LOST_1ADT', 'OTST_NONTRIP_EXCHANGE_1ADT', 'OTST_NONTRIP_NUTS_1ADT', 'OTST_NONTRIP_PASS_BY_TAG', 'OTST_NONTRIP_PLACES_1ADT', 'OTST_NONTRIP_PRODUCT_BY_CODE_1ADT', 'OTST_NONTRIP_REFUND_1ADT', 'OTST_NONTRIP_SINGLE_RIDE_BY_TAG', 'OTST_NONTRIP_TICKET_LOST_1ADT', 'OTST_NONTRIP_ZONES_1ADT']);
    for (const entry of nonTrip) expect(entry.missing.join(' ')).toMatch(/offer requests without a trip/);
    const declared = catalogueFor(catalogue, simulator, { offerRequestForms: ['NON_TRIP_PLACES', 'NON_TRIP_ZONES', 'NON_TRIP_NUTS'] })
      .filter((e) => /^OTST_NONTRIP_/.test(e.code));
    for (const entry of declared) expect(entry.missing.join(' ')).not.toMatch(/offer requests/);
  });

  test('a framework with no list of forms is not offered the non-trip entries, and keeps every trip entry', () => {
    const { catalogue, simulator } = readCatalogue();
    const noList = catalogueFor(catalogue, simulator, {});
    const nonTrip = noList.filter((e) => /^OTST_NONTRIP_/.test(e.code));
    expect(nonTrip).toHaveLength(10);
    for (const entry of nonTrip) expect(entry.missing.join(' ')).toMatch(/offer requests without a trip/);
    // The trip entries read as before: no form is missing for them.
    const tripForms = catalogueFor(catalogue, simulator, { offerRequestForms: [...G.TRIP_REQUEST_FORMS] });
    const formMissing = (entries) => entries.filter((e) => !/^(OTST|NHF)_NONTRIP_/.test(e.code) && /offer requests/.test(e.missing.join(' '))).map((e) => e.code);
    expect(formMissing(noList)).toEqual([]);
    expect(formMissing(tripForms)).toEqual([]);
  });
});

describe('a copy', () => {
  const { planCopy, applyCopy } = require('../../src/utils/scenarioCopy');
  const { suggestTrips } = require('../../src/utils/catalogueMatch');

  test('a non-trip trip is copied as it is, on no train, and nothing is suggested for it', () => {
    const plan = planCopy(datafile, ['S_PLACES', 'S_ZONES'], {});
    expect(plan.trips.map((t) => [t.id, t.nonTrip])).toEqual([[2, true], [3, true]]);
    const train = { id: 't1', origin: 'urn:uic:stn:1', destination: 'urn:uic:stn:2', services: [{ index: 0 }] };
    expect(suggestTrips(plan.trips, { trains: [train], journeys: [] })).toEqual({ 2: null, 3: null });
    const source = {
      ...structuredClone(datafile),
      passengersList: [{ id: 1, passengers: [{ reference: '00001', type: 'PERSON' }] }],
      requestedFulfillmentOptionsList: [{ id: 1, requestedFulfillmentOptions: [{ type: 'ETICKET', media: 'PDF_A4' }] }],
    };
    for (const sc of source.scenarios) Object.assign(sc, { passengersListId: 1, requestedFulfillmentOptionsListId: 1 });
    const result = applyCopy(source, { scenarios: [], tripRequirements: [] }, { codes: ['S_PLACES', 'S_ZONES'], tripMap: {}, frameworkConfig: {}, resources: [], email: 'tm@example.org' });
    expect(result.errors).toBeUndefined();
    const copied = result.datafile.tripRequirements;
    expect(copied.map((t) => ({ tripType: t.tripType, nonTrip: t.nonTrip }))).toEqual([
      { tripType: 'NON_TRIP', nonTrip: datafile.tripRequirements[1].nonTrip },
      { tripType: 'NON_TRIP', nonTrip: datafile.tripRequirements[2].nonTrip },
    ]);
  });
});

describe('the simulator references', () => {
  test('a provider selling without a trip declares both non-trip forms, and its non-trip scenarios get no warning', () => {
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'reference', 'simulator-gamma.json'), 'utf8'));
    expect(ref.framework.offerRequestForms).toEqual(expect.arrayContaining(['NON_TRIP_PLACES', 'NON_TRIP_ZONES', 'NON_TRIP_NUTS']));
    expect(ref.scenariosToRun).toEqual(expect.arrayContaining(['SIM_NONTRIP_PLACES_1ADT_38', 'SIM_NONTRIP_PLACES_LOOKUP_1ADT_38', 'SIM_NONTRIP_ZONES_1ADT_38']));
    expect(ref.scenariosToRun).not.toContain('SIM_WRONG_NONTRIP_NO_VALIDITY_1ADT_38');
  });

  test('#1266: it declares the tags of what it sells without a trip, and the lost ticket and card it replaces, after those the checklist ticks', () => {
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'reference', 'simulator-gamma.json'), 'utf8'));
    expect(ref.framework.offerSearchOptions.productTags).toEqual(['ADMISSION_POINT2POINT', 'ADMISSION_PASS', 'ADMISSION_MULTI_RIDE', 'TICKET_LOST', 'CARD_LOST']);
    expect(ref.scenariosToRun).toEqual(expect.arrayContaining(['SIM_NONTRIP_PROBE_TAG_PASS_38', 'SIM_NONTRIP_PROBE_TAG_SINGLE_RIDE_38', 'SIM_NONTRIP_PRODUCT_CODE_1ADT_38', 'SIM_NONTRIP_TICKET_LOST_1ADT_38', 'SIM_NONTRIP_CARD_LOST_1ADT_38', 'SIM_NHF_NONTRIP_CARD_LOST_UNKNOWN_1ADT_38', 'SIM_NONTRIP_NUTS_1ADT_38', 'SIM_NHF_NONTRIP_NUTS_UNKNOWN_1ADT_38']));
    for (const wrong of ['SIM_WRONG_NONTRIP_TRIP_COVERAGE_1ADT_38', 'SIM_WRONG_NONTRIP_OTHER_PLACES_1ADT_38', 'SIM_WRONG_NONTRIP_OTHER_CARRIER_1ADT_38']) {
      expect(ref.scenariosToRun).not.toContain(wrong);
    }
  });
});

// #1266: what is sold without a trip, asked by tag or by code.
describe('the products sold without a trip', () => {
  const C = require('../../src/utils/scenarioCatalogue');
  const { adaptReferenceScenario } = require('../../src/utils/catalogueMatch');
  const byCode = {
    code: 'S_CODE', scenarioType: 'SALE', tripRequirementId: 3, expectedProduct: 'SIM_DAY_PASS',
    offerSearchCriteria: { productSelections: [{ productCode: 'SIM_DAY_PASS', numberOfItems: 1 }, { productTag: 'ADMISSION_PASS' }] },
  };
  const byTag = { code: 'S_TAG', scenarioType: 'SALE', tripRequirementId: 3, offerSearchCriteria: { productTags: ['ADMISSION_PASS'] } };

  test('a product selection needs OSDM 3.7; a tag, its declaration when the framework lists the tags', () => {
    const code = C.requirementsOf(byCode, datafile);
    expect(code.minOsdmVersion).toBe('3.7');
    const fw = { salesFlows: ['SALE'], offerRequestForms: ['NON_TRIP_ZONES'] };
    expect(C.missingFor(code, { ...fw, osdmVersion: '3.6.0' })).toEqual(['OSDM 3.7 or later']);
    expect(C.missingFor(code, { ...fw, osdmVersion: '3.8.0' })).toEqual([]);
    const tag = C.requirementsOf(byTag, datafile);
    expect(tag.productTags).toEqual(['ADMISSION_PASS']);
    expect(C.missingFor(tag, fw)).toEqual([]);
    expect(C.missingFor(tag, { ...fw, offerSearchOptions: { productTags: ['ADMISSION_POINT2POINT'] } })).toEqual(['product tag ADMISSION_PASS (Offer search options)']);
    expect(C.missingFor(tag, { ...fw, offerSearchOptions: { productTags: ['ADMISSION_PASS'] } })).toEqual([]);
  });

  test('a product code is the provider\'s: the copy leaves out the simulator\'s and says what to complete', () => {
    const needs = C.dataNeedsOf(byCode, datafile, C.simulatorFacts({}));
    expect(needs.providerValues).toEqual(['expectedProduct', 'productCode']);
    expect(C.needsText(needs).join(' ')).toContain("the provider's own product code (Product selections)");
    const { scenario, toComplete } = adaptReferenceScenario(byCode, needs, {});
    expect(scenario.expectedProduct).toBeUndefined();
    expect(scenario.offerSearchCriteria.productSelections).toEqual([{ productTag: 'ADMISSION_PASS' }]);
    expect(toComplete.join(' ')).toContain("now the simulator's SIM_DAY_PASS");
    expect(byCode.offerSearchCriteria.productSelections).toHaveLength(2);
    // A tag is OSDM's, not the provider's: nothing to complete.
    expect(C.dataNeedsOf(byTag, datafile, C.simulatorFacts({})).providerValues).toBeUndefined();
  });
});

describe('the Test Config page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').replaceAll('\r\n', '\n');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const nonTripByOf = lift('nonTripByOf', {});
  const withNonTripValue = lift('withNonTripValue', { nonTripByOf });

  test('places from a comma-separated list, a lookup name, the kind', () => {
    expect(withNonTripValue({}, 'places', ' urn:uic:stn:40 ,5400014,, ')).toEqual({ places: ['urn:uic:stn:40', '5400014'] });
    expect(withNonTripValue({ places: ['x'] }, 'places', '')).toEqual({ places: [] });
    expect(withNonTripValue({}, 'placeLookup', ' Praha ')).toEqual({ placeLookup: 'Praha' });
    expect(withNonTripValue({ placeLookup: 'Praha' }, 'placeLookup', '')).toEqual({});
    expect(withNonTripValue({ by: 'PLACES' }, 'by', 'ZONES').by).toBe('ZONES');
    expect(withNonTripValue({}, 'by', 'anything').by).toBe('PLACES');
    // #1266: NUTS codes, from a comma-separated list, in capitals.
    expect(withNonTripValue({ by: 'PLACES' }, 'by', 'NUTS').by).toBe('NUTS');
    expect(withNonTripValue({ by: 'NUTS' }, 'nutsCodes', ' cz010, XS111 ,, ')).toEqual({ by: 'NUTS', nutsCodes: ['CZ010', 'XS111'] });
    expect(withNonTripValue({ by: 'NUTS', nutsCodes: ['XS111'] }, 'nutsCodes', '')).toEqual({ by: 'NUTS', nutsCodes: [] });
    expect([nonTripByOf({ by: 'nuts' }), nonTripByOf({ by: 'zones' }), nonTripByOf(null), nonTripByOf({ by: 'LINES' })]).toEqual(['NUTS', 'ZONES', 'PLACES', 'PLACES']);
  });

  test('one zone from its id and carrier; both emptied: none, taken from GET /zones', () => {
    let nt = withNonTripValue({ by: 'ZONES' }, 'zoneId', 'SIM-CITY');
    expect(nt.zones).toEqual([{ id: 'SIM-CITY', carrier: '' }]);
    nt = withNonTripValue(nt, 'zoneCarrier', 'urn:c');
    expect(nt.zones).toEqual([{ id: 'SIM-CITY', carrier: 'urn:c' }]);
    nt = withNonTripValue(withNonTripValue(nt, 'zoneId', ''), 'zoneCarrier', '');
    expect(nt.zones).toEqual([]);
  });

  test('switching a trip to NON_TRIP starts by stop places and keeps its search', () => {
    const convert = lift('convertTripType', { NON_TRIP_VALID_FROM: '%TRIP_DATE%T00:00:00+01:00', TRIP_LEG_FIELDS: [] });
    const trip = convert({ id: 1, tripType: 'SEARCH', trip: { origin: 'urn:uic:stn:1' } }, 'NON_TRIP');
    expect(trip).toEqual({ id: 1, tripType: 'NON_TRIP', trip: { origin: 'urn:uic:stn:1' }, nonTrip: { by: 'PLACES', places: [], validFrom: '%TRIP_DATE%T00:00:00+01:00' } });
    const kept = convert({ tripType: 'SEARCH', nonTrip: { by: 'ZONES', zones: [] } }, 'NON_TRIP');
    expect(kept.nonTrip).toEqual({ by: 'ZONES', zones: [] });
  });

  test('the page reads a framework\'s forms as the server does (#1258: no list = the trip forms)', () => {
    const fwOfferRequestFormDeclared = lift('fwOfferRequestFormDeclared', {});
    const frameworks = [{}, null, { offerRequestForms: [] }, { offerRequestForms: ['SEARCH', 'NON_TRIP_ZONES'] }, { offerRequestForms: ['NON_TRIP_PLACES'] }];
    for (const fw of frameworks) {
      for (const form of G.OFFER_REQUEST_FORMS) {
        expect([fw, form, fwOfferRequestFormDeclared(fw, form)]).toEqual([fw, form, G.offerRequestFormDeclared(fw, form)]);
      }
    }
  });

  test('the trip type picker marks NON_TRIP when neither non-trip form is declared', () => {
    const fwOfferRequestFormDeclared = lift('fwOfferRequestFormDeclared', {});
    const text = lift('tripTypeOptionText', { fwOfferRequestFormDeclared, lbl: (v) => v, NON_TRIP_FORMS: ['NON_TRIP_PLACES', 'NON_TRIP_ZONES'] });
    expect(text('NON_TRIP', {})).toMatch(/^⚠ NON_TRIP — not declared/);
    expect(text('SEARCH', {})).toBe('SEARCH');
    expect(text('NON_TRIP', { offerRequestForms: ['NON_TRIP_ZONES'] })).toBe('NON_TRIP');
    expect(text('NON_TRIP', { offerRequestForms: ['SEARCH'] })).toMatch(/^⚠ NON_TRIP — not declared/);
  });

  test('the editor is wired: the trip section, both delegates, a Test Data train never made from a non-trip request', () => {
    expect(page).toContain("if (trip.tripType === 'NON_TRIP') {");
    expect(page).toContain('${buildNonTripFields(tIdx, trip, depDayField)}');
    // In the list a change tries first (#1403), and once in the input listener.
    expect(page).toMatch(/const CHANGE_GROUPS = \[[^\]]*\n {2}changeNonTrip,\n/);
    expect(page.match(/^ {2}if \(changeNonTrip\(action, el\)\) return;$/gm)).toHaveLength(1);
    expect(page).toContain("if (trip?.tripType === 'NON_TRIP') return;");
  });
});

// #1266: regions named by NUTS codes.
describe('NUTS codes (#1266)', () => {
  const C = require('../../src/utils/scenarioCatalogue');
  const { adaptReferenceScenario } = require('../../src/utils/catalogueMatch');
  const { isRefusalTest } = require('../../src/utils/capabilities');
  const nutsFile = {
    tripRequirements: [
      { id: 4, tripType: 'NON_TRIP', nonTrip: { by: 'NUTS', nutsCodes: [] } },
      { id: 5, tripType: 'NON_TRIP', nonTrip: { by: 'NUTS', nutsCodes: ['XS111'] } },
      { id: 6, tripType: 'NON_TRIP', nonTrip: { by: 'NUTS', nutsCodes: ['XS999'] } },
    ],
    scenarios: [
      { code: 'S_NUTS', scenarioType: 'SALE', tripRequirementId: 4 },
      { code: 'S_NUTS_NAMED', scenarioType: 'SALE', tripRequirementId: 5 },
      { code: 'S_NUTS_UNKNOWN', scenarioType: 'SALE', tripRequirementId: 6, nutsCodeExpectRejection: 'on' },
    ],
  };
  const [lookup, named, unknown] = nutsFile.scenarios;

  test('the form, its declaration, its capability and its run filter', () => {
    expect(G.offerRequestFormOf(lookup, nutsFile)).toBe('NON_TRIP_NUTS');
    expect(G.NON_TRIP_REQUEST_FORMS).toContain('NON_TRIP_NUTS');
    expect(G.offerRequestFormDeclared({}, 'NON_TRIP_NUTS')).toBe(false);
    expect(G.offerRequestFormDeclared({ offerRequestForms: ['NON_TRIP_ZONES'] }, 'NON_TRIP_NUTS')).toBe(false);
    expect(G.offerRequestFormDeclared({ offerRequestForms: ['NON_TRIP_NUTS'] }, 'NON_TRIP_NUTS')).toBe(true);
    const annotated = structuredClone(nutsFile);
    G.annotateDatafile(annotated, { offerRequestForms: ['NON_TRIP_ZONES'] });
    expect(annotated.scenarios[0].__featureNotDeclaredWarnings).toContain('offerRequestBy:NON_TRIP_NUTS');
    expect(derivedCapability(lookup, nutsFile)).toBe('offers.nonTripNuts');
    expect(CAPABILITIES.find((c) => c.id === 'offers.nonTripNuts').label).toBe('Offers without a trip, in regions named by NUTS codes');
    expect(facetsOf(['S_NUTS'], { datafile: nutsFile })[0].form).toBe('NON_TRIP_NUTS');
  });

  test('the unknown code probe is an expected refusal', () => {
    expect(isRefusalTest(unknown)).toBe(true);
    expect(isRefusalTest(named)).toBe(false);
  });

  test('NUTS codes named are the provider\'s, but a probe\'s made-up code stays', () => {
    const facts = C.simulatorFacts({});
    expect(C.dataNeedsOf(lookup, nutsFile, facts).providerValues).toBeUndefined();
    expect(C.dataNeedsOf(unknown, nutsFile, facts).providerValues).toBeUndefined();
    const needs = C.dataNeedsOf(named, nutsFile, facts);
    expect(needs.providerValues).toEqual(['nutsCodes']);
    expect(C.needsText(needs).join(' ')).toContain('NUTS codes');
    expect(adaptReferenceScenario(named, needs, {}).toComplete.join(' ')).toContain("the NUTS codes of the provider's regions");
  });

  test('a reference adds the NUTS form only for a provider whose zones name NUTS codes', () => {
    const forms = (zones) => {
      const framework = { offerRequestForms: ['SEARCH'], offerSearchOptions: {} };
      R.withNonTripForms(framework, { nonTrip: { zones } });
      return framework.offerRequestForms;
    };
    expect(forms([{ id: 'Z', nutsCodes: ['XS111'] }])).toEqual(['SEARCH', 'NON_TRIP_PLACES', 'NON_TRIP_ZONES', 'NON_TRIP_NUTS']);
    expect(forms([{ id: 'Z' }])).toEqual(['SEARCH', 'NON_TRIP_PLACES', 'NON_TRIP_ZONES']);
  });
});
