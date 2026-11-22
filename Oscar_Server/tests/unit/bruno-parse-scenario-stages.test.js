// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-parse-scenario-stages.test.js — the stages of parseScenarioData()
 * that a run of the simulator never reaches (#1388): which scenario is
 * loaded when OSCAR does not name one, how a scenario's switches, waits and
 * words are read, and what is said when the scenario or the data it names
 * cannot be used.
 *
 * Each case parses the simulator's own data file after one change to it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai');

let envStore = {};
let stops = 0;
// Variables the environment does not give back, for the one case that needs it.
let forgotten = [];
let consoleLines = [];
global.bru = {
  getEnvVar:    (k) => (Object.hasOwn(envStore, k) && !forgotten.includes(k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       () => undefined,
  setVar:       () => {},
  runner:       { stopExecution: () => { stops += 1; } },
};

// The queue of expiry tests has rules of its own (expiredFlow.js), which arm
// one test at a time: here it is only watched.
const mockBuildQueue = jest.fn();
jest.mock('../../../Bruno_Collection/library-bruno/expiredFlow.js', () => ({
  buildAndArmExpiredFlowQueue: () => mockBuildQueue(),
}));

const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
// displays.js puts its own logger on the global object when loaded.
let logs = [];
global.validationLogger = (line) => { logs.push(String(line)); };

const SIMULATOR_FILE = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json');
const TEXT = fs.readFileSync(SIMULATOR_FILE, 'utf8');
const SEARCH = 'SIM_SALE_SEARCH_2ADT_SAVER_38';
const SEARCH_ONE = 'SIM_SALE_SEARCH_1ADT_38';
const SPECIFICATION = 'SIM_SALE_CLASS_PER_LEG_1ADT_38';
const NON_TRIP = 'SIM_NONTRIP_PLACES_1ADT_38';

beforeEach(() => { envStore = {}; logs = []; stops = 0; forgotten = []; consoleLines = []; mockBuildQueue.mockReset(); });

// The parser calls Bruno's own `test` and `expect` as it goes.
function run(file) {
  const jestTest = global.test;
  const quiet = jest.spyOn(console, 'log').mockImplementation((line) => { consoleLines.push(String(line)); });
  global.test = (name, fn) => { try { fn(); } catch { /* not what this file checks */ } };
  try {
    return { returned: withBrunoExpect(() => sp.parseScenarioData(file)), error: null };
  } catch (e) {
    return { returned: undefined, error: e };
  } finally {
    global.test = jestTest;
    quiet.mockRestore();
  }
}

// One scenario of the simulator's file, parsed after `change`, as OSCAR runs
// it: named by scenario_override, in an environment of its own (`env` is
// what it holds before). Gives what was thrown, if anything.
function parse(code, change = () => {}, env = {}) {
  const file = JSON.parse(TEXT);
  const scenario = file.scenarios.find((s) => s.code === code);
  const trip = file.tripRequirements.find((t) => t.id === scenario.tripRequirementId);
  const passengers = file.passengersList.find((l) => l.id === scenario.passengersListId).passengers;
  change({ file, scenario, trip, passengers });
  envStore = { ...env, scenario_override: code };
  return run(file).error;
}

const logged = (level, words) => logs.filter((line) => line.startsWith(`[${level}]`) && words.every((w) => line.includes(w)));

describe('which scenario is loaded when OSCAR names none', () => {
  // A file whose run list is `list`, parsed in the environment as it is.
  const withList = (list) => {
    const file = JSON.parse(TEXT);
    if (list === undefined) delete file.scenariosToRun;
    else file.scenariosToRun = list;
    return run(file);
  };

  test('a list is walked by the index, one scenario a call; past its end the run is told to stop', () => {
    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(SPECIFICATION);
    expect(envStore.scenariosToRunIndex).toBe('1');
    expect(envStore.__unitaryLoadedIdx).toBe('1');
    expect(JSON.parse(envStore.__scenariosList)).toEqual([SPECIFICATION, SEARCH]);

    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(SEARCH);
    expect(envStore.scenariosToRunIndex).toBe('2');
    expect(logged('INFO', ['scenariosToRun [2/2]', 'last in list'])).toHaveLength(1);
    expect(stops).toBe(0);

    // Nothing is loaded the third time: the variables of the second stay.
    envStore.TripType = 'left as it was';
    const third = withList([SPECIFICATION, SEARCH]);
    expect(third.error).toBeNull();
    expect(third.returned).toBeUndefined();
    expect(stops).toBe(1);
    expect(consoleLines.filter((line) => line.includes('All 2 scenarios attempted') && line.includes('stopping run (index 2)'))).toHaveLength(1);
    expect(envStore.scenarioCode).toBe(SEARCH);
    expect(envStore.scenariosToRunIndex).toBe('2');
    expect(envStore.TripType).toBe('left as it was');
  });

  test('a list of one scenario stops the run at the second call', () => {
    expect(withList([SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(SEARCH);
    envStore.TripType = 'left as it was';
    expect(withList([SEARCH]).error).toBeNull();
    expect(stops).toBe(1);
    expect(envStore.TripType).toBe('left as it was');
  });

  test('an index past the list in an environment that lost the list starts again at the first scenario', () => {
    envStore = { scenariosToRunIndex: '5' };
    forgotten = ['__scenariosList'];
    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(stops).toBe(0);
    expect(envStore.scenarioCode).toBe(SPECIFICATION);
    expect(envStore.scenariosToRunIndex).toBe('1');
    expect(consoleLines.filter((line) => line.includes('Index 5 exceeds list length 2') && line.includes('resetting to 0'))).toHaveLength(1);
  });

  test('a code that is in the list and in no scenario: the error says which codes the file holds, twenty at most', () => {
    // NaN equals nothing, itself included: the one code a list can hold that no scenario matches.
    const fileOf = (others) => ({ scenariosToRun: 'ALL', scenarios: [{ code: Number.NaN }, ...Array.from({ length: others }, (_, i) => ({ code: `CODE_${i + 1}` }))] });
    const twenty = run(fileOf(20));
    expect(twenty.error.message).toBe('Scenario code "NaN" not found');
    const first = logged('ERROR', ['Scenario "NaN" not found in the data file\'s scenarios[]']);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('Available code(s): [CODE_1, CODE_2, ');
    expect(first[0]).toContain(', CODE_20]. Fix in the wizard');
    expect(logged('ERROR', ['Stopping execution of further requests'])).toHaveLength(1);

    logs = [];
    envStore = {};
    expect(run(fileOf(21)).error.message).toBe('Scenario code "NaN" not found');
    expect(logged('ERROR', [', CODE_20, …]. Fix in the wizard'])).toHaveLength(1);
    expect(logged('ERROR', ['CODE_21'])).toEqual([]);
  });

  test('the list may be text with commas; ALL is every scenario of the file, in its order', () => {
    withList(` ${SEARCH} ,, ${NON_TRIP} `);
    expect(JSON.parse(envStore.__scenariosList)).toEqual([SEARCH, NON_TRIP]);
    expect(envStore.scenarioCode).toBe(SEARCH);

    envStore = {};
    withList('ALL');
    const codes = JSON.parse(TEXT).scenarios.map((s) => s.code);
    expect(JSON.parse(envStore.__scenariosList)).toEqual(codes);
    expect(envStore.scenarioCode).toBe(codes[0]);
  });

  test('a code the file does not hold is left out with a warning; an empty list means every scenario', () => {
    withList(['NOT_IN_THE_FILE', SEARCH]);
    expect(JSON.parse(envStore.__scenariosList)).toEqual([SEARCH]);
    expect(logged('WARNING', ['"NOT_IN_THE_FILE" not found', 'skipped'])).toHaveLength(1);

    envStore = {};
    logs = [];
    withList([]);
    expect(JSON.parse(envStore.__scenariosList)).toHaveLength(JSON.parse(TEXT).scenarios.length);
    expect(logged('WARNING', ['scenariosToRun was empty', 'falling back to ALL'])).toHaveLength(1);
  });

  test('no run list, or one that names no scenario of the file, is an error and loads nothing', () => {
    expect(withList(undefined).error.message).toContain('scenariosToRun is missing from the data file');
    expect(withList(null).error.message).toContain('scenariosToRun is missing from the data file');
    expect(withList(['NOT_IN_THE_FILE']).error.message).toContain('scenariosToRun resolved to an empty list');
    expect(envStore.scenarioCode).toBeUndefined();
    expect(envStore.__scenariosList).toBeUndefined();
  });

  test('scenarioTarget names the scenario by its place in the list or by its code, and leaves the index alone', () => {
    envStore = { scenarioTarget: '1', scenariosToRunIndex: '0' };
    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(SEARCH);
    expect(envStore.scenariosToRunIndex).toBe('0');
    expect(logged('INFO', ['scenarioTarget (index 1)', SEARCH])).toHaveLength(1);

    // By its code, a scenario of the file that the list leaves out can be run.
    envStore = { scenarioTarget: ` ${NON_TRIP} ` };
    logs = [];
    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(NON_TRIP);
    expect(envStore.scenariosToRunIndex).toBeUndefined();
    expect(logged('INFO', ['scenarioTarget (name)', NON_TRIP])).toHaveLength(1);
  });

  test('a target outside the list, or a code the file has not, is an error', () => {
    envStore = { scenarioTarget: '2' };
    expect(withList([SPECIFICATION, SEARCH]).error.message).toContain('scenarioTarget index 2 is out of range. effectiveList has 2 entries (0–1)');
    envStore = { scenarioTarget: 'NOT_IN_THE_FILE' };
    expect(withList([SPECIFICATION, SEARCH]).error.message).toContain('scenarioTarget "NOT_IN_THE_FILE" not found in scenarios list');
    envStore = { scenarioTarget: '-1' };
    expect(withList([SPECIFICATION, SEARCH]).error.message).toContain('scenarioTarget index -1 is out of range');
    // "01" is not an index as it is written: it is read as a code.
    envStore = { scenarioTarget: '01' };
    expect(withList([SPECIFICATION, SEARCH]).error.message).toContain('scenarioTarget "01" not found in scenarios list');
    // "0" is the first of the list.
    envStore = { scenarioTarget: '0' };
    expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
    expect(envStore.scenarioCode).toBe(SPECIFICATION);
    // An index is read in base ten.
    envStore = { scenarioTarget: '10' };
    expect(withList('ALL').error).toBeNull();
    expect(envStore.scenarioCode).toBe(JSON.parse(TEXT).scenarios[10].code);
  });

  test('an index that is not a number, or below 0, starts at the first scenario', () => {
    for (const index of ['abc', '-3']) {
      envStore = { scenariosToRunIndex: index };
      expect(withList([SPECIFICATION, SEARCH]).error).toBeNull();
      expect(envStore.scenarioCode).toBe(SPECIFICATION);
      expect(envStore.scenariosToRunIndex).toBe('1');
    }
  });

  test('under OSCAR the scenario named is the whole list', () => {
    expect(parse(NON_TRIP)).toBeNull();
    expect(JSON.parse(envStore.__scenariosList)).toEqual([NON_TRIP]);
    expect(envStore.scenarioCode).toBe(NON_TRIP);
    expect(logged('INFO', ['Parallel mode', NON_TRIP])).toHaveLength(1);
  });

  test('the day a trip is dated by default is today plus departureDateFromToday days, 10 when unset', () => {
    const dayAfter = (days) => {
      const d = new Date();
      d.setDate(d.getDate() + days);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    // A date of the scenario's own takes the place of the default: none here.
    const travelDay = (env) => {
      expect(parse(NON_TRIP, ({ trip }) => { delete trip.departureDay; }, env)).toBeNull();
      return envStore.__travelDay;
    };
    expect(travelDay({})).toBe(dayAfter(10));
    expect(travelDay({ departureDateFromToday: '3' })).toBe(dayAfter(3));
    expect(travelDay({ departureDateFromToday: 'abc' })).toBe(dayAfter(10));
  });
});

describe('how a value of a scenario is read', () => {
  test('a switch is on for true and for the words true, on and yes in any case; off for anything else', () => {
    const switches = ['expiredBookingTest', 'expiredOfferTest', 'expiredAddReservationOfferTest', 'expiredAddAncillaryOfferTest',
      'expiredRefundOfferTest', 'expiredExchangeOfferTest', 'expectedProductAbsent', 'offerSearchProbe',
      'overruleCodeExpectRejection', 'idempotencyCheck', 'tripIdsExpectRejection', 'passengerLimitExpectRejection',
      'emptyPassengersExpectRejection', 'lostCardExpectRejection', 'nutsCodeExpectRejection', 'departureExpectRejection',
      'currencyExpectRejection', 'offerOptionExpectRejection', 'offerOptionDiscovery', 'refundAgainProbe',
      'exchangeRefundedProbe', 'confirmAgainProbe', 'partialRefundByLeg', 'partialRefundByPax', 'partialRefundByFulfillment',
      'offersByTripIds'];
    for (const on of [true, 'true', 'TRUE', 'on', 'On', 'yes', 'YES']) {
      envStore = {};
      expect(parse(SEARCH, ({ scenario }) => { for (const name of switches) scenario[name] = on; })).toBeNull();
      expect(switches.filter((name) => envStore[name] !== 'true')).toEqual([]);
    }
    for (const off of [false, 'false', 'no', 'off', '', null, undefined, 1, 'x']) {
      envStore = {};
      expect(parse(SEARCH, ({ scenario }) => { for (const name of switches) scenario[name] = off; })).toBeNull();
      expect(switches.filter((name) => envStore[name] !== 'false')).toEqual([]);
    }
  });

  test('the queue of expiry tests is built once, after what it reads is set; when it fails the scenario still loads', () => {
    let seen = null;
    mockBuildQueue.mockImplementation(() => {
      seen = [envStore.expiredRefundOfferTest, envStore.scenarioType, envStore.salesFlow_addAncillary, envStore.placeSelectionMode, envStore.TripType];
    });
    expect(parse(SEARCH, ({ scenario }) => {
      scenario.expiredRefundOfferTest = 'on';
      scenario.salesFlowActions = { addAncillary: true };
      scenario.placeSelectionMode = 'ADD_TO_BOOKING';
    })).toBeNull();
    expect(mockBuildQueue).toHaveBeenCalledTimes(1);
    // The switches, the type, the booking-flow actions and the mode are there; the trip comes after.
    expect(seen).toEqual(['true', 'SALE', 'true', 'ADD_TO_BOOKING', undefined]);

    mockBuildQueue.mockImplementation(() => { throw new Error('no queue today'); });
    expect(parse(SEARCH)).toBeNull();
    expect(logged('ERROR', ['expiredFlow queue build failed: no queue today'])).toHaveLength(1);
    expect(envStore.TripType).toBe('SEARCH');
    expect(JSON.parse(envStore.bookingPassengerReferences)).toEqual(['00001', '00002']);
  });

  test('bookMandatoryReservations is on for true and the word true only', () => {
    const read = (value) => { parse(SEARCH, ({ scenario }) => { scenario.bookMandatoryReservations = value; }); return envStore.bookMandatoryReservations; };
    expect([true, 'true', 'TRUE'].map(read)).toEqual(['true', 'true', 'true']);
    expect(['on', 'yes', false, undefined].map(read)).toEqual(['false', 'false', 'false', 'false']);
  });

  test('a wait is 1 to 60 minutes, as a whole number; anything else is unset', () => {
    const waits = ['expiredBookingMaxWaitMinutes', 'expiredOfferMaxWaitMinutes', 'expiredAddReservationOfferMaxWaitMinutes',
      'expiredAddAncillaryOfferMaxWaitMinutes', 'expiredRefundOfferMaxWaitMinutes', 'expiredExchangeOfferMaxWaitMinutes'];
    const cases = [[1, '1'], [60, '60'], [59.9, '59'], ['5', '5'], [1.5, '1'], [0, ''], [0.9, ''], [61, ''], [60.5, ''], [-2, ''],
      ['x', ''], ['', ''], [null, ''], [undefined, ''], [true, '1']];
    for (const [given, kept] of cases) {
      envStore = {};
      expect(parse(SEARCH, ({ scenario }) => { for (const name of waits) scenario[name] = given; })).toBeNull();
      expect(waits.map((name) => envStore[name])).toEqual(waits.map(() => kept));
    }
  });

  test('the refund receipt wait is 1 to 60 minutes or nothing', () => {
    const read = (value) => { parse(SEARCH, ({ scenario }) => { scenario.refundReceiptMaxWaitMinutes = value; }); return envStore.refundReceiptMaxWaitMinutes; };
    expect([1, 60, '12', 12.7].map(read)).toEqual(['1', '60', '12', '12']);
    expect([0, 61, 'x', undefined].map(read)).toEqual([null, null, null, null]);
  });

  test('an empty value and the word null read as none', () => {
    const names = ['osdmVersion', 'loggingType', 'scenarioType', 'scenarioAction', 'desiredFlexibility', 'accommodationSelection',
      'accommodationGenderPreference', 'requiresPlaceSelection', 'overruleCode', 'refundDate', 'placeSelectionMode'];
    for (const none of ['', 'null']) {
      envStore = {};
      parse(SEARCH, ({ scenario }) => { for (const name of names) scenario[name] = none; });
      expect(names.filter((name) => envStore[name] !== null)).toEqual([]);
    }
    envStore = {};
    parse(SEARCH, ({ scenario }) => { for (const name of names) scenario[name] = 'A value'; scenario.osdmVersion = '3.8.0'; });
    expect(names.filter((name) => name !== 'osdmVersion' && envStore[name] !== 'A value')).toEqual([]);
    expect(envStore.osdmVersion).toBe('3.8.0');
  });

  test('a word has its default, and its case', () => {
    parse(SEARCH, ({ scenario }) => {
      for (const name of ['stepFailurePolicy', 'requestedInformationProbe', 'bookingPurchaserMode']) delete scenario[name];
    });
    expect([envStore.stepFailurePolicy, envStore.requestedInformationProbe, envStore.bookingPurchaserMode]).toEqual(['HARD_STOP', 'off', 'inline']);
    for (const none of ['', 'null', null]) {
      envStore = {};
      parse(SEARCH, ({ scenario }) => {
        for (const name of ['stepFailurePolicy', 'requestedInformationProbe', 'bookingPurchaserMode']) scenario[name] = none;
      });
      expect([envStore.stepFailurePolicy, envStore.requestedInformationProbe, envStore.bookingPurchaserMode]).toEqual(['HARD_STOP', 'off', 'inline']);
    }
    envStore = {};
    parse(SEARCH, ({ scenario }) => {
      scenario.stepFailurePolicy = 'continue';
      scenario.requestedInformationProbe = 'OMIT';
      scenario.bookingPurchaserMode = 'Deferred';
    });
    expect([envStore.stepFailurePolicy, envStore.requestedInformationProbe, envStore.bookingPurchaserMode]).toEqual(['CONTINUE', 'omit', 'deferred']);
  });
});

describe('a partial refund that cannot be made is said at the start', () => {
  test('on, a partial refund takes the first leg, passenger or fulfilment unless the scenario names another; off, none', () => {
    parse(SEARCH, ({ scenario }) => {
      scenario.partialRefundByLeg = true;
      scenario.partialRefundByPax = 'yes';
      scenario.partialRefundByFulfillment = 'on';
      scenario.partialRefundPaxSelection = 'last';
    });
    expect([envStore.partialRefundLegSelection, envStore.partialRefundPaxSelection, envStore.partialRefundFulfillmentSelection]).toEqual(['first', 'last', 'first']);
    envStore = {};
    parse(SEARCH, ({ scenario }) => { scenario.partialRefundFulfillmentSelection = 'null'; });
    expect([envStore.partialRefundLegSelection, envStore.partialRefundPaxSelection, envStore.partialRefundFulfillmentSelection]).toEqual(['', '', '']);
    expect(logged('WARNING', ['partialRefund'])).toEqual([]);
  });

  test('by passenger: a list of one passenger, and a list that is not found', () => {
    parse(SEARCH_ONE, ({ scenario }) => { scenario.partialRefundByPax = true; });
    expect(logged('WARNING', ['partialRefundByPax is on', 'passengersList #1 has only 1 passenger(s)', 'Add a passenger'])).toHaveLength(1);

    logs = [];
    parse(SEARCH, ({ scenario }) => { scenario.partialRefundByPax = true; scenario.passengersListId = 987654; });
    expect(logged('WARNING', ['partialRefundByPax is on', '#987654 was not found', 'passengersListId linkage'])).toHaveLength(1);

    // A list that holds no list of passengers counts none.
    logs = [];
    parse(SEARCH_ONE, ({ scenario, file }) => {
      scenario.partialRefundByPax = true;
      file.passengersList.find((l) => l.id === scenario.passengersListId).passengers = null;
    });
    expect(logged('WARNING', ['passengersList #1 has only 0 passenger(s)'])).toHaveLength(1);

    // Two passengers, an id written as text: nothing to say.
    logs = [];
    parse(SEARCH, ({ scenario }) => { scenario.partialRefundByPax = true; });
    expect(logged('WARNING', ['partialRefundByPax'])).toEqual([]);
  });

  test('by leg: a trip specification of one leg, and a direction asked of a one-way trip', () => {
    parse(SPECIFICATION, ({ scenario, trip }) => { scenario.partialRefundByLeg = true; trip.legs = trip.legs.slice(0, 1); });
    expect(logged('WARNING', ['partialRefundByLeg is on', 'has 1 leg(s)'])).toHaveLength(1);

    logs = [];
    parse(SPECIFICATION, ({ scenario, trip }) => { scenario.partialRefundByLeg = true; trip.legs = 'none'; });
    expect(logged('WARNING', ['partialRefundByLeg is on', 'has 0 leg(s)'])).toHaveLength(1);

    for (const direction of ['inbound', 'outbound']) {
      logs = [];
      parse(SPECIFICATION, ({ scenario }) => { scenario.partialRefundByLeg = true; scenario.partialRefundLegSelection = direction; });
      expect(logged('WARNING', [`partialRefundLegSelection='${direction}'`, 'this trip is one-way'])).toHaveLength(1);
      expect(logged('WARNING', ['leg(s)'])).toEqual([]);
      expect(envStore.partialRefundLegSelection).toBe('first');
    }
    // Another choice is kept as it is, without a word.
    logs = [];
    parse(SPECIFICATION, ({ scenario }) => { scenario.partialRefundByLeg = true; scenario.partialRefundLegSelection = 'last'; });
    expect(logged('WARNING', ['partialRefund'])).toEqual([]);
    expect(envStore.partialRefundLegSelection).toBe('last');

    // A return keeps the direction asked; a searched trip is checked later, at the offer.
    logs = [];
    envStore = {};
    parse(SPECIFICATION, ({ scenario, trip }) => {
      scenario.partialRefundByLeg = true;
      scenario.partialRefundLegSelection = 'outbound';
      trip.returnSearchParameters = {};
    });
    expect(envStore.partialRefundLegSelection).toBe('outbound');
    expect(logged('WARNING', ['partialRefundLegSelection'])).toEqual([]);
    logs = [];
    parse(SEARCH, ({ scenario }) => { scenario.partialRefundByLeg = true; scenario.partialRefundLegSelection = 'inbound'; });
    expect(logged('WARNING', ['partialRefund'])).toEqual([]);
  });
});

describe('a trip that cannot be built is named, and the scenario goes on', () => {
  test('a trip requirement the data file has not', () => {
    expect(parse(SEARCH, ({ scenario }) => { scenario.tripRequirementId = 987654; })).toBeNull();
    expect(logged('ERROR', [`"${SEARCH}" references tripRequirementId=987654`, 'no matching entry', 'Available ids: [1, 2,'])).toHaveLength(1);
    expect(envStore.TripType).toBeUndefined();
    // The stages after the trip still ran.
    expect(JSON.parse(envStore.bookingPassengerReferences)).toEqual(['00001', '00002']);
  });

  test('a searched trip without its origin, destination or time', () => {
    parse(SEARCH, ({ trip }) => { delete trip.trip.origin; trip.trip.startDatetime = ''; });
    expect(logged('ERROR', ['tripRequirement #2 has tripType=SEARCH', '[trip.origin, trip.startDatetime]'])).toHaveLength(1);
    expect(logged('ERROR', [])).toHaveLength(1);
    expect(logged('DEBUG', ['tripRequirement #2.trip dump = {'])).toHaveLength(1);
    expect(envStore.TripType).toBe('SEARCH');
    expect(envStore.offerTripSearchCriteria).toBeUndefined();
    expect(envStore.__travelDay).toBeUndefined();

    logs = [];
    envStore = {};
    parse(SEARCH, ({ trip }) => { trip.trip.destination = null; });
    expect(logged('ERROR', ['[trip.destination]'])).toHaveLength(1);

    logs = [];
    parse(SEARCH, ({ trip }) => { delete trip.trip; });
    expect(logged('ERROR', ['[trip (sub-object missing)]'])).toHaveLength(1);
  });

  test('a trip specification without legs, or with a leg that lacks a member', () => {
    parse(SPECIFICATION, ({ trip }) => { trip.legs = []; });
    expect(logged('ERROR', ['tripRequirement #4 has tripType=SPECIFICATION but .legs[] is empty or missing'])).toHaveLength(1);
    expect(logged('ERROR', [])).toHaveLength(1);
    expect(logged('DEBUG', ['tripRequirement #4 dump = {'])).toHaveLength(1);
    expect(envStore.offerTripSpecifications).toBeUndefined();

    logs = [];
    envStore = {};
    parse(SPECIFICATION, ({ trip }) => { delete trip.legs[1].destination; delete trip.legs[1].endDatetime; trip.legs.push(null); });
    expect(logged('ERROR', ['2 leg(s) are incomplete', 'legs[1] missing [destination, endDatetime]; legs[2] missing [leg (not an object)]'])).toHaveLength(1);
    expect(logged('ERROR', [])).toHaveLength(1);
    expect(logged('DEBUG', ['tripRequirement #4.legs dump = ['])).toHaveLength(1);
    expect(envStore.offerTripSpecifications).toBeUndefined();

    logs = [];
    for (const member of ['origin', 'startDatetime']) parse(SPECIFICATION, ({ trip }) => { delete trip.legs[0][member]; });
    expect(logged('ERROR', ['legs[0] missing [origin]'])).toHaveLength(1);
    expect(logged('ERROR', ['legs[0] missing [startDatetime]'])).toHaveLength(1);
  });

  test('offers without a trip that name neither stop places nor a zone', () => {
    parse(NON_TRIP, ({ trip }) => { delete trip.nonTrip; });
    expect(logged('ERROR', ['tripRequirement #45', 'name the stop places'])).toHaveLength(1);
    expect(logged('ERROR', [])).toHaveLength(1);
    expect(logged('DEBUG', ['tripRequirement #45 dump = {'])).toHaveLength(1);
    expect(envStore.TripType).toBe('NON_TRIP');
    expect(envStore.nonTripRequirement).toBeUndefined();
  });

  test('a complete trip of each kind is built, on the day ages are counted on', () => {
    expect(parse(SEARCH)).toBeNull();
    expect(logged('INFO', ['processing a search'])).toHaveLength(1);
    expect(envStore.offerTripSearchCriteria).toEqual(expect.any(String));
    expect(envStore.__travelDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    envStore = {};
    expect(parse(SPECIFICATION)).toBeNull();
    expect(logged('INFO', ['processing a specification'])).toHaveLength(1);
    expect(envStore.offerTripSpecifications).toEqual(expect.any(String));
    expect(envStore.__travelDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    envStore = {};
    expect(parse(NON_TRIP)).toBeNull();
    expect(logged('INFO', ['processing a non-trip request'])).toHaveLength(1);
    expect(envStore.nonTripRequirement).toEqual(expect.any(String));
    expect(envStore.__travelDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(logged('ERROR', [])).toEqual([]);
  });

  test('a trip whose time cannot be read: the error names the trip, and the passengers are still loaded', () => {
    expect(parse(SPECIFICATION, ({ trip }) => { trip.legs[0].startDatetime = 8; })).toBeNull();
    expect(logged('ERROR', ["building TripType=SPECIFICATION criteria for tripRequirement #4 threw: Data file error: tripRequirement (SPECIFICATION) leg 1 is missing a valid 'startDatetime' (got 8)"])).toHaveLength(1);
    expect(logged('DEBUG', ['tripRequirement #4 dump = {'])).toHaveLength(1);
    expect(envStore.offerTripSpecifications).toBeUndefined();
    expect(JSON.parse(envStore.bookingPassengerReferences)).toEqual(['00001']);
  });
});

describe('the passengers, the criteria and the fulfilment options', () => {
  test('a passengers list the data file has not', () => {
    expect(parse(SEARCH, ({ scenario }) => { scenario.passengersListId = 987654; })).toBeNull();
    expect(logged('ERROR', ['references passengersListId=987654', 'no matching entry', 'Available ids: [1, 2,'])).toHaveLength(1);
    expect(envStore.offerPassengerSpecifications).toBeUndefined();
  });

  test('passengerExternalRefFormat rewrites every reference; without a place for the number it is ignored', () => {
    parse(SEARCH, ({ scenario }) => { scenario.passengerExternalRefFormat = 'PAX%03d'; });
    expect(JSON.parse(envStore.bookingPassengerReferences)).toEqual(['PAX001', 'PAX002']);
    expect(JSON.parse(envStore.offerPassengerSpecifications).map((p) => p.externalRef)).toEqual(['PAX001', 'PAX002']);
    expect(logged('INFO', ['passengerExternalRefFormat probe armed', 'PAX001, PAX002'])).toHaveLength(1);

    logs = [];
    envStore = {};
    parse(SEARCH, ({ scenario }) => { scenario.passengerExternalRefFormat = 'PAX'; });
    expect(JSON.parse(envStore.bookingPassengerReferences)).toEqual(['00001', '00002']);
    expect(logged('WARNING', ['passengerExternalRefFormat set ("PAX")', 'probe ignored'])).toHaveLength(1);
  });

  test('an age on the day of travel gives the date of birth that is sent', () => {
    const born = (years, daysAfter) => {
      const d = new Date(`${envStore.__travelDay}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() - years);
      d.setUTCDate(d.getUTCDate() + daysAfter);
      return d.toISOString().slice(0, 10);
    };
    parse(SEARCH, ({ passengers }) => {
      Object.assign(passengers[0], { bornYearsBeforeTravel: 30, bornDaysAfter: 1, expectedPassengerType: 'ADULT' });
      Object.assign(passengers[1], { bornYearsBeforeTravel: 12 });
    });
    const sent = JSON.parse(envStore.offerPassengerSpecifications).map((p) => p.dateOfBirth);
    expect(sent).toEqual([born(30, 1), born(12, 0)]);
    expect(JSON.parse(envStore.bookingPassengerSpecifications).map((p) => p.dateOfBirth)).toEqual(sent);
    expect(logged('INFO', ['Passenger 00001: born ' + sent[0], '30 years before the day of travel plus 1 day(s); expected to be priced as ADULT'])).toHaveLength(1);
    const second = logged('INFO', ['Passenger 00002: born ' + sent[1], '12 years before the day of travel']);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toContain('plus');
    expect(second[0]).not.toContain('expected to be priced');
  });

  test('each passenger is read back against the update values, or the booked ones when it gives none', () => {
    parse(SEARCH);
    const data = JSON.parse(envStore.passengerAdditionalData);
    expect(data.map((p) => p.updateFirstName)).toEqual(['Samuel', expect.any(String)]);
    expect(envStore.updateFirstName_0).toBe('Samuel');
    expect(envStore.updateGender_0).toBe('X');
    expect(envStore.offerPassengerNumber).toBe(2);
    expect(envStore.skipPatchPassengerRequest).toBeUndefined();

    envStore = {};
    parse(SEARCH, ({ passengers }) => {
      for (const name of ['updateFirstName', 'updateLastName', 'updateDateOfBirth', 'updateEmail', 'updatePhoneNumber', 'updateGender']) delete passengers[1][name];
      delete passengers[1].gender;
    });
    expect(envStore.skipPatchPassengerRequest).toBe('true');
    expect(envStore.updateFirstName_1).toBe('Robin');
    expect(envStore.updateGender_1).toBe('X');
  });

  test('a passenger with one update member only is still updated', () => {
    const members = ['updateFirstName', 'updateLastName', 'updateDateOfBirth', 'updateEmail', 'updatePhoneNumber', 'updateGender'];
    for (const kept of members) {
      envStore = {};
      parse(SEARCH_ONE, ({ passengers }) => {
        for (const name of members) delete passengers[0][name];
        passengers[0][kept] = 'F';
      });
      expect([kept, envStore.skipPatchPassengerRequest]).toEqual([kept, undefined]);
      expect(envStore[`${kept}_0`]).toBe('F');
    }
  });

  test('the criteria of the scenario, else those of the list it names, else the defaults', () => {
    parse(SEARCH, ({ scenario }) => { scenario.offerSearchCriteria = { currency: 'CHF', travelClass: ['FIRST'] }; });
    expect(JSON.parse(envStore.offerSearchCriteria)).toEqual({ currency: 'CHF', travelClasses: ['FIRST'] });

    envStore = {};
    parse(SEARCH, ({ scenario }) => { delete scenario.offerSearchCriteria; });
    expect(JSON.parse(envStore.offerSearchCriteria)).toEqual({ currency: 'EUR', offerMode: 'INDIVIDUAL', requestedOfferParts: ['ADMISSION'] });
    expect(logged('INFO', ['offerSearchCriteria resolved from offerSearchCriteriaListId=1'])).toHaveLength(1);

    envStore = {};
    logs = [];
    parse(SEARCH, ({ scenario }) => { delete scenario.offerSearchCriteria; scenario.offerSearchCriteriaListId = 987654; });
    expect(JSON.parse(envStore.offerSearchCriteria)).toEqual({ currency: 'EUR', offerMode: 'INDIVIDUAL', requestedOfferParts: ['ADMISSION', 'RESERVATION'] });
    expect(logged('WARN', ['No offerSearchCriteria', 'using defaults'])).toHaveLength(1);
  });

  test('a class per leg asks for every class it names, whatever the criteria say', () => {
    parse(SPECIFICATION, ({ scenario }) => { scenario.offerSearchCriteria = { travelClass: ['SECOND'] }; });
    expect(JSON.parse(envStore.offerSearchCriteria).travelClasses).toEqual(['FIRST', 'SECOND']);
  });

  test('fulfilment options: a list the data file has not, and an option without type or media', () => {
    parse(SEARCH, ({ scenario }) => { scenario.requestedFulfillmentOptionsListId = 987654; });
    expect(logged('ERROR', ['references requestedFulfillmentOptionsListId=987654', 'Available ids: [1, 2]'])).toHaveLength(1);
    expect(envStore.offerFulfillmentOptions).toBeUndefined();

    envStore = {};
    logs = [];
    parse(SEARCH, ({ file, scenario }) => {
      scenario.requestedFulfillmentOptionsListId = 2;
      file.requestedFulfillmentOptionsList[1].requestedFulfillmentOptions[0].fulfillmentMedia = null;
    });
    expect(JSON.parse(envStore.offerFulfillmentOptions)).toEqual([{ type: 'ETICKET', media: 'RETAILER_APP' }]);
    expect(logged('ERROR', ['requestedFulfillmentOptionsListId'])).toEqual([]);

    envStore = {};
    logs = [];
    parse(SEARCH, ({ file }) => { file.requestedFulfillmentOptionsList = []; });
    expect(logged('INFO', ['requestedFulfillmentOptionsList is empty'])).toHaveLength(1);
    expect(envStore.offerFulfillmentOptions).toBeUndefined();
  });

  test('the purchaser is the first of the data file, in the form of the scenario\'s OSDM version', () => {
    parse(SEARCH);
    expect(JSON.parse(envStore.bookingPurchaserSpecifications)).toEqual({
      detail: { firstName: 'Paula', lastName: 'Purchaser', contact: { email: 'paula.purchaser@example.org', phoneNumber: '+33199000010' } },
    });
    envStore = {};
    parse(SEARCH, ({ scenario }) => { scenario.osdmVersion = '3.3'; });
    expect(JSON.parse(envStore.bookingPurchaserSpecifications)).toEqual({
      detail: { firstName: 'Paula', lastName: 'Purchaser', email: 'paula.purchaser@example.org', phoneNumber: '+33199000010' },
    });
  });
});

describe('what a loaded scenario says of itself', () => {
  test('the undeclared features the server marked are each warned of, and the scenario is said loaded', () => {
    expect(parse(SEARCH, ({ scenario }) => { scenario.__featureNotDeclaredWarnings = ['offerOption:travelClasses=FIRST', 'placeSelectionBy:AUTOMATIC_PLACE_SELECTION']; })).toBeNull();
    expect(logged('WARNING', [`Scenario "${SEARCH}"`, 'which the Test Framework does not declare'])).toHaveLength(2);
    expect(logged('INFO', [`Scenario selected: "${SEARCH}"`, 'Scenario Type: "SALE"', 'OSDM version: "3.8.0"'])).toHaveLength(1);
    expect(logged('INFO', [`Scenario "${SEARCH}" loaded from the data file`, 'tripRequirement #2', 'passengersList #2', 'fulfillmentOptions #1'])).toHaveLength(1);
  });

  test('the booking-flow actions and the place-selection probes', () => {
    parse(SEARCH, ({ scenario }) => {
      scenario.salesFlowActions = { patchPassengers: false, addAncillary: true };
      scenario.placeSelectionProbes = { wrongReservationId: true, omitPlaceSelections: true, unknownAccommodationType: false };
      scenario.__seatMapDeclared = false;
    });
    expect([envStore.salesFlow_patchPassengers, envStore.salesFlow_addAncillary, envStore.salesFlow_getBooking, envStore.salesFlow_placeSelection])
      .toEqual(['false', 'true', 'true', 'false']);
    expect(JSON.parse(envStore.placeSelectionProbes)).toEqual(['omitPlaceSelections', 'wrongReservationId']);
    expect(envStore.__placeProbeIndex).toBe('0');
    expect(envStore.__coachLayoutsSkip).toBe('true');
    expect(logged('INFO', ['Place-selection probe sweep ARMED (2 probe(s)'])).toHaveLength(1);

    envStore = {};
    parse(SEARCH, ({ scenario }) => { scenario.placeSelectionProbes = ['unknownAccommodationType']; });
    expect(JSON.parse(envStore.placeSelectionProbes)).toEqual(['unknownAccommodationType']);
    expect(envStore.__coachLayoutsSkip).toBe('false');
  });

  test('offers by trip id are asked for a one-way searched trip only', () => {
    parse(SEARCH, ({ scenario }) => { scenario.offersByTripIds = true; });
    expect(envStore.offersByTripIds).toBe('true');

    envStore = {};
    parse(SPECIFICATION, ({ scenario }) => { scenario.offersByTripIds = true; });
    expect(envStore.offersByTripIds).toBe('false');
    expect(logged('WARNING', ['offers by trip id need a SEARCH trip', 'this one is SPECIFICATION'])).toHaveLength(1);

    envStore = {};
    logs = [];
    parse(SEARCH, ({ scenario }) => { scenario.offersByTripIds = true; scenario.offerSearchCriteria.returnOffsetDays = 2; });
    expect(envStore.offersByTripIds).toBe('false');
    expect(logged('WARNING', ['one-way journey only', 'this scenario is a return'])).toHaveLength(1);
  });
});
