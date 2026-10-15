// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #766 (PR 1): the Test Framework declares how a provider lets a place be
 * chosen (placeSelectionFlows, OSDM's PlaceSelectionFlow). A scenario's flow
 * is its own placeSelectionFlow, else what its place fields send; one the
 * framework does not declare warns at the run, is refused by the catalogue
 * and named by a copy. At the offer step, the collection says whether the
 * offer lists the flow (supportedPlaceSelectionFlows) and which preferences
 * it offers (availablePlacePreferences).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  placeSelectionFlowOf, placeSelectionFlowDeclared, annotateDatafile, PLACE_SELECTION_FLOWS, PLACE_SELECTION_TEXT,
} = require('../../src/utils/frameworkGating');
const { catalogueFor, catalogueDatafile, requirementsOf, missingFor } = require('../../src/utils/scenarioCatalogue');
const { planCopy } = require('../../src/utils/scenarioCopy');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const ps = require(path.join(LIB, 'placeSelection.js'));
const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));

const FRAMEWORK = {
  osdmVersion: '3.8',
  salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'EXCHANGE_FULL'],
  returnModels: ['SEPARATE', 'COMBINED'],
  passengerTypes: ['ADULT', 'CHILD', 'YOUTH', 'SENIOR'],
  passengerAgeRanges: { CHILD: { min: 6, max: 14 }, ADULT: { min: 26, max: 64 }, YOUTH: { min: 15, max: 25 } },
  maxPassengers: 9,
  salesHorizonDays: 90,
};
const withFlows = (flows) => ({ ...FRAMEWORK, placeSelectionFlows: flows });
const placeMissing = (entry) => entry.missing.filter((m) => m.startsWith('place selection'));

// Every way a scenario can name or imply a flow.
const SCENARIOS = [
  { code: 'NONE' },
  { code: 'OWN', placeSelectionFlow: 'automatic_place_selection_nearby' },
  { code: 'OWN_WINS', placeSelectionFlow: 'MANUAL_PLACE_SELECTION_WITH_FEE', accommodationSelection: 'COUCHETTE' },
  { code: 'OWN_UNKNOWN', placeSelectionFlow: 'GRAPHICAL', placeSelectionMode: 'ADD_TO_BOOKING' },
  { code: 'SEATMAP', placeSelectionMode: 'SEATMAP_AT_OFFER' },
  { code: 'ADD', placeSelectionMode: 'ADD_TO_BOOKING' },
  { code: 'COUCHETTE', accommodationSelection: 'couchette' },
  { code: 'BERTH', accommodationSelection: 'BERTH' },
  { code: 'SEAT', accommodationSelection: 'SEAT' },
  { code: 'PLACE_SEL', reservationBookingForm: 'PLACE_SELECTION' },
  { code: 'RES_SEL', reservationBookingForm: 'RESERVATION_SELECTION' },
  { code: 'LATER', reservationBookingForm: 'ADD_LATER' },
];
const EXPECTED = {
  NONE: null,
  OWN: 'AUTOMATIC_PLACE_SELECTION_NEARBY',
  OWN_WINS: 'MANUAL_PLACE_SELECTION_WITH_FEE',
  OWN_UNKNOWN: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
  SEATMAP: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
  ADD: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
  COUCHETTE: 'AUTOMATIC_PLACE_SELECTION',
  BERTH: 'AUTOMATIC_PLACE_SELECTION',
  SEAT: null,
  PLACE_SEL: 'AUTOMATIC_PLACE_SELECTION',
  RES_SEL: null,
  LATER: null,
};

describe('#766 — the flow of a scenario', () => {
  test('its own flow, else what its place fields send; the server and the collection agree', () => {
    for (const sc of SCENARIOS) {
      expect([sc.code, placeSelectionFlowOf(sc)]).toEqual([sc.code, EXPECTED[sc.code]]);
      expect([sc.code, ps.flowOfScenario(sc)]).toEqual([sc.code, EXPECTED[sc.code]]);
    }
    expect(placeSelectionFlowOf(null)).toBeNull();
    expect(ps.flowOfScenario(undefined)).toBeNull();
    // Every scenario of the simulator, too.
    for (const sc of simulator.scenarios) expect(ps.flowOfScenario(sc)).toBe(placeSelectionFlowOf(sc));
  });

  test('the five OSDM flows, the same on both sides, each with its text', () => {
    expect(ps.FLOWS).toEqual(PLACE_SELECTION_FLOWS);
    expect(ps.FLOW_TEXT).toEqual(PLACE_SELECTION_TEXT);
    expect(Object.keys(PLACE_SELECTION_TEXT)).toEqual(PLACE_SELECTION_FLOWS);
  });

  test('declared: no flow, no list, or listed; [] declares none', () => {
    expect(placeSelectionFlowDeclared({}, 'AUTOMATIC_PLACE_SELECTION')).toBe(true);
    expect(placeSelectionFlowDeclared({ placeSelectionFlows: [] }, null)).toBe(true);
    expect(placeSelectionFlowDeclared({ placeSelectionFlows: [] }, 'AUTOMATIC_PLACE_SELECTION')).toBe(false);
    expect(placeSelectionFlowDeclared({ placeSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'] }, 'AUTOMATIC_PLACE_SELECTION')).toBe(true);
    expect(placeSelectionFlowDeclared(null, 'MANUAL_PLACE_SELECTION_WITH_FEE')).toBe(true);
  });

  test('the served data file names an undeclared flow; a declared or absent list removes it', () => {
    const datafile = { scenarios: SCENARIOS.map((s) => ({ ...s })) };
    annotateDatafile(datafile, { placeSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'] });
    const warned = Object.fromEntries(datafile.scenarios.map((s) => [s.code, s.__featureNotDeclaredWarnings || []]));
    expect(warned.SEATMAP).toEqual(['placeSelectionBy:MANUAL_PLACE_SELECTION_WITHOUT_FEE']);
    expect(warned.OWN).toEqual(['placeSelectionBy:AUTOMATIC_PLACE_SELECTION_NEARBY']);
    expect(warned.COUCHETTE).toEqual([]);
    expect(warned.NONE).toEqual([]);
    annotateDatafile(datafile, {});
    expect(datafile.scenarios.some((s) => s.__featureNotDeclaredWarnings)).toBe(false);
  });

  test('the collection\'s warning names the flow and where to declare it', () => {
    global.bru = { getEnvVar: () => undefined, setEnvVar: () => {} };
    global.validationLogger = () => {};
    const { featureNotDeclaredWarning } = require(path.join(LIB, 'scenarioParser.js'));
    expect(featureNotDeclaredWarning({ code: 'X' }, 'placeSelectionBy:MANUAL_PLACE_SELECTION_WITH_FEE'))
      .toMatch(/^\[WARNING\] Scenario "X" chooses a place of a named place, with a fee \(MANUAL_PLACE_SELECTION_WITH_FEE\), which the Test Framework does not declare \(Seat Selection\)/);
  });
});

describe('#766 — the catalogue and the copy', () => {
  test('a reference scenario that chooses a place needs its flow declared', () => {
    const df = catalogueDatafile(catalogue, simulator);
    const sc = df.scenarios.find((s) => s.code === 'OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT');
    expect(requirementsOf(sc, df).placeSelectionFlow).toBe('AUTOMATIC_PLACE_SELECTION');
    expect(missingFor({ salesFlows: [], passengerTypes: [], placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION' }, { placeSelectionFlows: ['MANUAL_PLACE_SELECTION_WITH_FEE'] }))
      .toEqual(['place selection by accommodation and place properties (Seat Selection)']);
    expect(missingFor({ salesFlows: [], passengerTypes: [], placeSelectionFlow: null }, { placeSelectionFlows: [] })).toEqual([]);
  });

  test('no list: nothing refused for the flow; none declared: only the scenarios that choose a place are refused', () => {
    expect(catalogueFor(catalogue, simulator, FRAMEWORK).some((e) => placeMissing(e).length)).toBe(false);
    const entries = catalogueFor(catalogue, simulator, withFlows([]));
    const refused = entries.filter((e) => placeMissing(e).length).map((e) => e.code);
    expect(refused).toEqual(['OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT']);
    const declared = catalogueFor(catalogue, simulator, withFlows(['AUTOMATIC_PLACE_SELECTION']));
    expect(declared.some((e) => placeMissing(e).length)).toBe(false);
  });

  test('a copy names a flow the target does not declare', () => {
    const source = { tripRequirements: [], scenarios: [{ code: 'A', placeSelectionMode: 'SEATMAP_AT_OFFER' }, { code: 'B' }] };
    const plan = planCopy(source, ['A', 'B'], { placeSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'] });
    expect(plan.scenarios[0].warnings).toContain('A place is chosen of a named place, without fee, which the target\'s Test Framework does not declare (Seat Selection).');
    expect(plan.scenarios[1].warnings).toEqual([]);
  });
});

describe('#766 — what the offer says of the flow', () => {
  const part = (flows, groups) => ({ id: 'R', supportedPlaceSelectionFlows: flows, availablePlacePreferences: groups && { preferenceGroups: groups } });
  const offer = (...parts) => ({ reservationOfferParts: parts });

  test('the flows and preferences of every reservation part, each once', () => {
    const o = offer(
      part(['AUTOMATIC_PLACE_SELECTION', 'manual_place_selection_with_fee'], [{ preferenceGroup: 'POSITION', preferences: ['WINDOW', 'AISLE'] }]),
      part(['AUTOMATIC_PLACE_SELECTION', ''], [{ preferenceGroup: 'POSITION', preferences: ['WINDOW', 'TABLE'] }, { preferenceGroup: 'ZONE', preferences: [] }, { preferences: ['X'] }]),
    );
    expect(ps.flowsOffered(o)).toEqual(['AUTOMATIC_PLACE_SELECTION', 'MANUAL_PLACE_SELECTION_WITH_FEE']);
    expect(ps.preferencesOffered(o)).toEqual({ POSITION: ['WINDOW', 'AISLE', 'TABLE'], ZONE: [] });
    expect(ps.flowsOffered({})).toEqual([]);
    expect(ps.preferencesOffered(null)).toEqual({});
  });

  test('listed: information; not listed: a warning; none named: information; no reservation part: a warning', () => {
    const flow = 'MANUAL_PLACE_SELECTION_WITHOUT_FEE';
    expect(ps.describeOfferedFlow(offer(part([flow])), flow)).toEqual([
      { level: 'INFO', text: 'Place selection of a named place, without fee (MANUAL_PLACE_SELECTION_WITHOUT_FEE): the offer lists it (MANUAL_PLACE_SELECTION_WITHOUT_FEE).' },
    ]);
    expect(ps.describeOfferedFlow(offer(part(['AUTOMATIC_PLACE_SELECTION'], [{ preferenceGroup: 'POSITION', preferences: ['WINDOW'] }])), flow)).toEqual([
      { level: 'WARNING', text: 'Place selection of a named place, without fee (MANUAL_PLACE_SELECTION_WITHOUT_FEE): the offer does not list it (it lists AUTOMATIC_PLACE_SELECTION); the place choice may be refused or ignored.' },
      { level: 'INFO', text: 'Place preferences offered — POSITION: WINDOW' },
    ]);
    expect(ps.describeOfferedFlow(offer(part()), flow)[0].level).toBe('INFO');
    expect(ps.describeOfferedFlow({ reservationOfferParts: [] }, flow)).toEqual([
      { level: 'WARNING', text: 'Place selection of a named place, without fee (MANUAL_PLACE_SELECTION_WITHOUT_FEE): the offer chosen has no reservation part; the place choice is not tested.' },
    ]);
    expect(ps.describeOfferedFlow(offer(part([flow])), null)).toEqual([]);
  });
});

describe('#766 — the collection wiring', () => {
  const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

  test('the parser sets the flow, both reset lists clear it, step 01 reads the offer', () => {
    const parser = read('library-bruno', 'scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("placeSelectionFlow", require(\'./placeSelection.js\').flowOfScenario(scenario));');
    for (const text of [parser, read('opencollection.yml')]) expect(text).toContain('"__legClassesSold", "placeSelectionFlow"');
    expect(read('02-Common Requests', '01. POST Get Offer.yml')).toContain('offers.js").checkOfferPlaceSelection();');
  });

  test('checkOfferPlaceSelection logs what the offer says, nothing without a flow', () => {
    const env = {};
    const logs = [];
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; } };
    global.validationLogger = (l) => logs.push(l);
    jest.isolateModules(() => {
      jest.doMock(path.join(LIB, 'displays.js'), () => ({ validationLogger: (l) => logs.push(l), logStepStart: () => {} }));
      const offers = require(path.join(LIB, 'offers.js'));
      offers.checkOfferPlaceSelection();
      expect(logs).toEqual([]);
      env.placeSelectionFlow = 'AUTOMATIC_PLACE_SELECTION';
      env.offer = JSON.stringify({ reservationOfferParts: [{ supportedPlaceSelectionFlows: ['AUTOMATIC_PLACE_SELECTION'] }] });
      offers.checkOfferPlaceSelection();
    });
    expect(logs).toEqual(['[INFO] Place selection by accommodation and place properties (AUTOMATIC_PLACE_SELECTION): the offer lists it (AUTOMATIC_PLACE_SELECTION).']);
  });
});

describe('#766 — the Test Framework page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').replaceAll('\r\n', '\n');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const start = lines.indexOf('const FW_PLACE_SELECTION_FLOWS = [');
  const FW_PLACE_SELECTION_FLOWS = vm.runInNewContext(lines.slice(start, lines.indexOf('];', start) + 1).join('\n').replace('const FW_PLACE_SELECTION_FLOWS = ', ''));

  test('the page\'s flows are the server\'s', () => {
    expect(FW_PLACE_SELECTION_FLOWS.map(([f]) => f)).toEqual(PLACE_SELECTION_FLOWS);
  });

  test('the first click starts from every flow; the pills follow; the panel is drawn and wired', () => {
    const wizData = { framework: {} };
    const toggle = lift('fwTogglePlaceSelectionFlow', { wizData, FW_PLACE_SELECTION_FLOWS });
    const el = { classList: { toggle: (_c, on) => { el.on = on; } } };
    toggle(el, 'AUTOMATIC_PLACE_SELECTION');
    expect(wizData.framework.placeSelectionFlows).toEqual(PLACE_SELECTION_FLOWS.slice(1));
    expect(el.on).toBe(false);
    toggle(el, 'AUTOMATIC_PLACE_SELECTION');
    expect(wizData.framework.placeSelectionFlows).toEqual([...PLACE_SELECTION_FLOWS.slice(1), 'AUTOMATIC_PLACE_SELECTION']);
    expect(el.on).toBe(true);
    const declared = lift('fwPlaceSelectionFlowDeclared', {});
    const panel = lift('placeSelectionFlowsPanelHtml', { FW_PLACE_SELECTION_FLOWS, fwPlaceSelectionFlowDeclared: declared, esc: (v) => v });
    const html = panel({ placeSelectionFlows: ['MANUAL_PLACE_SELECTION_WITH_FEE'] });
    expect((html.match(/class="pill selected"/g) || []).length).toBe(1);
    expect(html).toContain('data-action="fw-place-selection-flow" data-val="MANUAL_PLACE_SELECTION_WITH_FEE"');
    expect(page).toContain("case 'fw-place-selection-flow':");
    expect(page).toContain('${placeSelectionFlowsPanelHtml(fw)}');
  });
});
