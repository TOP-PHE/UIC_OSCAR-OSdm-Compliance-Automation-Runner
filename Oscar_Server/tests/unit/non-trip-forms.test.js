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

  test('the golden rule: a non-trip form the framework leaves out is warned, absent declares every form', () => {
    expect(G.offerRequestFormDeclared({}, 'NON_TRIP_PLACES')).toBe(true);
    expect(G.offerRequestFormDeclared({ offerRequestForms: ['SEARCH'] }, 'NON_TRIP_PLACES')).toBe(false);
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
    expect(nonTrip.map((e) => e.code).sort()).toEqual(['OTST_NONTRIP_PLACES_1ADT', 'OTST_NONTRIP_ZONES_1ADT']);
    for (const entry of nonTrip) expect(entry.missing.join(' ')).toMatch(/offer requests without a trip/);
    const declared = catalogueFor(catalogue, simulator, { offerRequestForms: ['NON_TRIP_PLACES', 'NON_TRIP_ZONES'] })
      .filter((e) => /^OTST_NONTRIP_/.test(e.code));
    for (const entry of declared) expect(entry.missing.join(' ')).not.toMatch(/offer requests/);
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
    expect(ref.framework.offerRequestForms).toEqual(expect.arrayContaining(['NON_TRIP_PLACES', 'NON_TRIP_ZONES']));
    expect(ref.scenariosToRun).toEqual(expect.arrayContaining(['SIM_NONTRIP_PLACES_1ADT_38', 'SIM_NONTRIP_PLACES_LOOKUP_1ADT_38', 'SIM_NONTRIP_ZONES_1ADT_38']));
    expect(ref.scenariosToRun).not.toContain('SIM_WRONG_NONTRIP_NO_VALIDITY_1ADT_38');
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
  const withNonTripValue = lift('withNonTripValue', {});

  test('places from a comma-separated list, a lookup name, the kind', () => {
    expect(withNonTripValue({}, 'places', ' urn:uic:stn:40 ,5400014,, ')).toEqual({ places: ['urn:uic:stn:40', '5400014'] });
    expect(withNonTripValue({ places: ['x'] }, 'places', '')).toEqual({ places: [] });
    expect(withNonTripValue({}, 'placeLookup', ' Praha ')).toEqual({ placeLookup: 'Praha' });
    expect(withNonTripValue({ placeLookup: 'Praha' }, 'placeLookup', '')).toEqual({});
    expect(withNonTripValue({ by: 'PLACES' }, 'by', 'ZONES').by).toBe('ZONES');
    expect(withNonTripValue({}, 'by', 'anything').by).toBe('PLACES');
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

  test('the trip type picker marks NON_TRIP when neither non-trip form is declared', () => {
    const fwOfferRequestFormDeclared = lift('fwOfferRequestFormDeclared', {});
    const text = lift('tripTypeOptionText', { fwOfferRequestFormDeclared, lbl: (v) => v, NON_TRIP_FORMS: ['NON_TRIP_PLACES', 'NON_TRIP_ZONES'] });
    expect(text('NON_TRIP', {})).toBe('NON_TRIP');
    expect(text('NON_TRIP', { offerRequestForms: ['NON_TRIP_ZONES'] })).toBe('NON_TRIP');
    expect(text('NON_TRIP', { offerRequestForms: ['SEARCH'] })).toMatch(/^⚠ NON_TRIP — not declared/);
  });

  test('the editor is wired: the trip section, both delegates, a Test Data train never made from a non-trip request', () => {
    expect(page).toContain("if (trip.tripType === 'NON_TRIP') {");
    expect(page).toContain('${buildNonTripFields(tIdx, trip, depDayField)}');
    // Once in the change listener, once in the input listener.
    expect(page.match(/^ {2}if \(changeNonTrip\(action, el\)\) return;$/gm)).toHaveLength(2);
    expect(page).toContain("if (trip?.tripType === 'NON_TRIP') return;");
  });
});
