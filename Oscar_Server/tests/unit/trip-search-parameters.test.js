// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #780 PR B: the Test Framework declares the trip search parameters a
 * provider takes (tripSearchParameters); a scenario sending one not declared
 * warns at the run, a reference scenario needing one is not copied, and after
 * 01 the collection says whether the trips keep to the transfer limit, the
 * vias, the places to avoid and the number of results.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const T = require('../../src/utils/tripSearchParameters');
const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { catalogueFor, catalogueDatafile, requirementsOf, missingFor } = require('../../src/utils/scenarioCatalogue');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const DATA = path.join(LIB, '..', 'data_base');
const { askedParameters, transfersOf, placesPassed, checkTripParameters } = require(path.join(LIB, 'tripParameters.js'));

const stop = (ref) => ({ objectType: 'StopPlaceRef', stopPlaceRef: ref });
// A trip through the given stops (A, …, B), one timed leg between each two.
function trip(id, stops, extra = {}) {
  const legs = stops.slice(1).map((to, i) => ({ id: `${id}-L${i + 1}`, timedLeg: { start: { stopPlaceRef: stop(stops[i]) }, end: { stopPlaceRef: stop(to) } } }));
  return { id, legs, ...extra };
}
const A = 'urn:uic:stn:0000001';
const B = 'urn:uic:stn:0000002';
const V = 'urn:uic:stn:0000050';

describe('server: what a scenario sends, and the declaration', () => {
  test('the parameters of a Trip Search Criteria, in the list\'s order; blank values send nothing', () => {
    expect(T.parametersOfCriteria({
      trainFilter: 'true', ignoreRealtimeData: 'false', numberOfResultsAfter: '3', transferLimit: '0',
      notVias: 'urn:x', via2Place: 'urn:y', timeBasis: 'ARRIVAL',
    })).toEqual(T.TRIP_SEARCH_PARAMETERS);
    expect(T.parametersOfCriteria({ timeBasis: 'DEPARTURE', via1Place: ' ', transferLimit: '', trainFilter: 'false' })).toEqual([]);
    expect(T.parametersOfCriteria(null)).toEqual([]);
    expect(T.parametersOfCriteria(['x'])).toEqual([]);
  });

  test('a scenario: its search trip\'s criteria; a specification or a missing trip, none', () => {
    const df = { tripRequirements: [
      { id: 1, tripType: 'SEARCH', trip: { searchCriteria: { transferLimit: '0' } } },
      { id: 2, tripType: 'SPECIFICATION', trip: { searchCriteria: { transferLimit: '0' } } },
      { id: 3, trip: { searchCriteria: { via1Place: V } } },
    ] };
    expect(T.tripSearchParametersOf({ tripRequirementId: 1 }, df)).toEqual(['TRANSFER_LIMIT']);
    expect(T.tripSearchParametersOf({ tripRequirementId: 2 }, df)).toEqual([]);
    expect(T.tripSearchParametersOf({ tripRequirementId: 3 }, df)).toEqual(['VIAS']);
    expect(T.tripSearchParametersOf({ tripRequirementId: 9 }, df)).toEqual([]);
    expect(T.tripSearchParametersOf(null, df)).toEqual([]);
    expect(T.tripSearchParameterDeclared({}, 'VIAS')).toBe(true);
    expect(T.tripSearchParameterDeclared({ tripSearchParameters: [] }, 'VIAS')).toBe(false);
    expect(T.tripSearchParameterDeclared({ tripSearchParameters: ['VIAS'] }, 'VIAS')).toBe(true);
  });

  test('the run\'s data file names each parameter not declared', () => {
    const df = {
      tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: { searchCriteria: { via1Place: V, transferLimit: '0' } } }],
      scenarios: [{ code: 'A', tripRequirementId: 1 }],
    };
    annotateDatafile(df, { tripSearchParameters: ['VIAS'] });
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['tripParameter:TRANSFER_LIMIT']);
    annotateDatafile(df, {});
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('no simulator scenario warns against a framework that declares nothing', () => {
    const sim = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
    annotateDatafile(sim, { salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'REFUND_IROPS', 'EXCHANGE_FULL', 'EXCHANGE_PARTIAL', 'EXCHANGE_IROPS'], returnModels: ['SEPARATE', 'COMBINED'] });
    expect(sim.scenarios.flatMap((s) => (s?.__featureNotDeclaredWarnings || []).filter((w) => w.startsWith('tripParameter:')))).toEqual([]);
  });
});

describe('the catalogue: a reference scenario needs its parameters declared', () => {
  const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const entry = (fw) => catalogueFor(catalogue, simulator, fw).find((e) => e.code === 'OTST_TRIP_TRANSFER_LIMIT_0');

  test('its requirements name them, and a list without them refuses the copy', () => {
    const datafile = catalogueDatafile(catalogue, simulator);
    const scenario = datafile.scenarios.find((s) => s.code === 'OTST_TRIP_TRANSFER_LIMIT_0');
    expect(requirementsOf(scenario, datafile).tripSearchParameters).toEqual(['TRANSFER_LIMIT', 'NUMBER_OF_RESULTS']);
    expect(entry(FW).missing).toEqual([]);
    expect(entry({ ...FW, tripSearchParameters: ['TRANSFER_LIMIT'] }).missing).toEqual(['trip search by number of results (Trip search parameters)']);
    expect(missingFor({ salesFlows: [], passengerTypes: [], tripSearchParameters: ['VIAS'] }, { tripSearchParameters: [] }))
      .toEqual(['trip search by via (Trip search parameters)']);
  });

  test('a copy onto a train keeps the trip\'s search criteria', () => {
    const { applyCopy } = require('../../src/utils/scenarioCopy');
    const datafile = catalogueDatafile(catalogue, simulator);
    const scenario = datafile.scenarios.find((s) => s.code === 'OTST_TRIP_TRANSFER_LIMIT_0');
    const resources = [{ id: 't1', resource_type: 'TRAIN', data: { originURN: 'urn:uic:stn:8500010', destinationURN: 'urn:uic:stn:8507000', services: [{ vehicleNumber: '1', departureTime: '08:00', arrivalTime: '09:00' }] } }];
    const target = { scenarios: [], tripRequirements: [], passengersList: [], requestedFulfillmentOptionsList: [] };
    const { datafile: out } = applyCopy(datafile, target, {
      codes: ['OTST_TRIP_TRANSFER_LIMIT_0'], tripMap: { [scenario.tripRequirementId]: { type: 'train', train_id: 't1', service_index: 0 } },
      frameworkConfig: FW, resources, email: 'tm@example.org',
    });
    const copied = out.scenarios.find((s) => s.code === 'OTST_TRIP_TRANSFER_LIMIT_0');
    const tripOut = out.tripRequirements.find((t) => t.id === copied.tripRequirementId);
    expect(tripOut.trip.origin).toBe('urn:uic:stn:8500010');
    expect(tripOut.trip.searchCriteria).toEqual({ transferLimit: '0', numberOfResults: '1' });
  });
});

describe('collection: the trips keep to the parameters sent', () => {
  test('what the request carried; transfers and the places a trip passes', () => {
    expect(askedParameters({
      vias: [{ viaPlace: stop(V) }, {}], notVias: [{ notViaPlace: [stop('urn:x'), stop('urn:y')] }],
      parameters: { transferLimit: 0, numberOfResults: 2, numberOfResultsAfter: 5 },
    })).toEqual({ transferLimit: 0, vias: [V], notVias: ['urn:x', 'urn:y'], numberOfResults: 2 });
    expect(askedParameters(null)).toEqual({ transferLimit: null, vias: [], notVias: [], numberOfResults: null });
    expect(transfersOf(trip('t', [A, V, B]))).toBe(1);
    expect(transfersOf(trip('t', [A, V, B], { transfers: 0 }))).toBe(0);
    expect(transfersOf({})).toBe(0);
    const withStops = trip('t', [A, V, B]);
    withStops.legs[1].timedLeg.intermediates = [{ stopPlaceRef: stop('urn:i') }];
    expect(placesPassed(withStops)).toEqual([V, V, 'urn:i']);
    expect(placesPassed(trip('t', [A, B]))).toEqual([]);
  });

  test('kept: passing checks; none kept: a warning; some: INFO; a via compared without leading zeros', () => {
    const asked = { vias: [{ viaPlace: stop(V) }], notVias: [{ notViaPlace: [stop(V)] }], parameters: { transferLimit: 0, numberOfResults: 1 } };
    const direct = { trips: [trip('d', [A, B])] };
    const c = checkTripParameters(asked, direct);
    expect(c.map((x) => [x.name, x.ok])).toEqual([
      ['Trip search: the trips keep to the transfer limit asked (0)', true],
      [`Trip search: the trips pass the via asked (${V})`, false],
      [`Trip search: the trips avoid the places asked (${V})`, true],
      ['Trip search: no more trips than asked (1)', true],
    ]);
    expect(c[1].level).toBe('warn');
    expect(c[1].message).toBe('1 of 1 trip(s) do not (trip d: does not pass it)');
    const mixed = checkTripParameters(asked, { trips: [trip('d', [A, B]), trip('v', [A, 'urn:uic:stn:50', B])] });
    expect(mixed.map((x) => [x.ok, x.level])).toEqual([[false, 'info'], [false, 'info'], [false, 'info'], [false, 'warn']]);
    expect(mixed[0].message).toBe('1 of 2 trip(s) do not (trip v: 1 transfer(s))');
    expect(mixed[2].message).toBe('1 of 2 trip(s) do not (trip v: passes urn:uic:stn:0000050)');
    expect(mixed[3].message).toBe('2 trips given');
    expect(checkTripParameters(asked, { trips: [] })).toEqual([]);
    expect(checkTripParameters({}, direct)).toEqual([]);
  });

  test('a member the provider says it ignored is a warning saying so', () => {
    const asked = { vias: [{ viaPlace: stop(V) }], notVias: [{ notViaPlace: [stop(V)] }], parameters: { transferLimit: 0, numberOfResults: 1 } };
    const c = checkTripParameters(asked, { trips: [trip('d', [A, B])] }, ['transferlimit', 'vias', 'notvias', 'numberofresults']);
    expect(c.every((x) => !x.ok && x.level === 'warn' && /PARAMETER_NOT_SUPPORTED/.test(x.message))).toBe(true);
    expect(c[0].message).toBe('the provider says it ignored tripSearchCriteria.parameters.transferLimit (PARAMETER_NOT_SUPPORTED): not supported');
  });

  test('after 01: logged with the offer search options, tests in a probe', () => {
    const run = (env, response) => {
      const logs = [];
      const results = [];
      global.bru = { getEnvVar: (k) => env[k], setEnvVar: () => {} };
      global.test = (name, fn) => { try { fn(); results.push([name, 'pass']); } catch (e) { results.push([name, 'fail', e.message]); } };
      try {
        const offers = require(path.join(LIB, 'offers.js'));
        global.validationLogger = (line) => { logs.push(line); };
        offers.checkOfferSearchCriteria(response);
      } finally { delete global.bru; delete global.test; }
      return { logs, results };
    };
    const env = { offerTripSearchCriteria: JSON.stringify({ parameters: { transferLimit: 0 } }) };
    const response = { offers: [], trips: [trip('v', [A, V, B])] };
    expect(run(env, response).logs).toEqual([
      '[WARNING] Trip search: the trips keep to the transfer limit asked (0) — 1 of 1 trip(s) do not (trip v: 1 transfer(s))',
      '[WARNING] Offer request: the answer names the parameters it did not take (PARAMETER_NOT_SUPPORTED) — kept by no offer or trip, and not named in the answer: tripSearchCriteria.parameters.transferLimit',
    ]);
    expect(run({ ...env, offerSearchProbe: 'true' }, response).results).toEqual([
      ['Trip search: the trips keep to the transfer limit asked (0)', 'fail', '1 of 1 trip(s) do not (trip v: 1 transfer(s))'],
    ]);
    expect(run({}, response).logs).toEqual([]);
  });

  test('the scenario parser words the framework warning', () => {
    global.bru = { getEnvVar: () => undefined, setEnvVar: () => {} };
    let sp;
    try { sp = require(path.join(LIB, 'scenarioParser.js')); } finally { delete global.bru; }
    expect(sp.featureNotDeclaredWarning({ code: 'S1' }, 'tripParameter:VIAS')).toBe(
      '[WARNING] Scenario "S1" searches its trip with a via (vias), which the Test Framework does not declare (Trip search parameters). The run will proceed; the provider may refuse or ignore it. Declare the parameter in the Test Framework, or change the Trip Search Criteria of the scenario\'s trip.');
  });
});

describe('the Test Framework page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const start = lines.indexOf('const FW_TRIP_SEARCH_PARAMETERS = [');
  const FW_TRIP_SEARCH_PARAMETERS = vm.runInNewContext(lines.slice(start, lines.indexOf('];', start) + 1).join('\n').replace('const FW_TRIP_SEARCH_PARAMETERS = ', ''));

  test('the page\'s parameters are the server\'s', () => {
    expect(FW_TRIP_SEARCH_PARAMETERS.map(([n]) => n)).toEqual([...T.TRIP_SEARCH_PARAMETERS]);
  });

  test('the first click starts from every parameter; the pills follow; the panel is drawn and wired', () => {
    const wizData = { framework: {} };
    const toggle = lift('fwToggleTripSearchParameter', { wizData, FW_TRIP_SEARCH_PARAMETERS });
    const el = { classList: { toggle: (_c, on) => { el.on = on; } } };
    toggle(el, 'VIAS');
    expect(wizData.framework.tripSearchParameters).toEqual(T.TRIP_SEARCH_PARAMETERS.filter((n) => n !== 'VIAS'));
    expect(el.on).toBe(false);
    toggle(el, 'VIAS');
    expect(wizData.framework.tripSearchParameters.at(-1)).toBe('VIAS');
    expect(el.on).toBe(true);
    toggle(el, 'NOPE');
    expect(wizData.framework.tripSearchParameters).toHaveLength(7);
    const declared = lift('fwTripSearchParameterDeclared', {});
    const html = lift('tripSearchParametersHtml', { FW_TRIP_SEARCH_PARAMETERS, fwTripSearchParameterDeclared: declared, esc: String })({ tripSearchParameters: ['VIAS'] });
    expect((html.match(/class="pill selected"/g) || []).length).toBe(1);
    expect(html).toContain('data-action="fw-trip-parameter" data-val="VIAS"');
    expect(page).toContain('${tripSearchParametersHtml(fw)}');
    expect(page).toContain("case 'fw-trip-parameter':");
  });
});
