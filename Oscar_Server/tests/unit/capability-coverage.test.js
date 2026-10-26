// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * capability-coverage.test.js — the coverage report by capability (#972):
 * the list and the step table against the collection, the catalogue's
 * `capability`, and one fixture per mechanism the issue names (a failure
 * spreading, a late failure, a probe, an optional operation, forms and
 * copies), each with the result #956 gave and the one it gives now.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const K = require('../../src/utils/capabilities');
const { capabilityCoverageOf, runEvidence, combine, stepsOf } = require('../../src/utils/capabilityCoverage');
const { coverageOf } = require('../../src/utils/frameworkCoverage');

const COLLECTION = path.resolve(__dirname, '../../../Bruno_Collection');
const catalogue = JSON.parse(fs.readFileSync(path.join(COLLECTION, 'data_base/scenario_catalogue.json'), 'utf8')).entries;
const simulator = JSON.parse(fs.readFileSync(path.join(COLLECTION, 'data_base/simulator_datafile.json'), 'utf8'));

// Entries whose capability their source's fields cannot tell: it is in the
// provider's data (the number of passengers, the names, a reservation the
// train makes mandatory, what the run checks of documents or requested
// information), or the source is a refund or an exchange made to test the
// currency of the whole flow.
const DATA_DRIVEN = {
  OTST_SALE_MAX_PASSENGERS: 'sale.limits', OTST_SALE_ACCENTED_LONG_NAMES: 'passengers.names',
  OTST_SALE_RESERVATION_MANDATORY_2ADT: 'reservation.mandatory', OTST_SALE_DOCUMENTS_RETURN_1ADT: 'fulfilment.documents',
  OTST_SALE_REQUESTED_INFORMATION_1ADT: 'passengers.requestedInformation', OTST_SALE_CURRENCY: 'sale.currencies',
  OTST_EXCHANGE_CURRENCY: 'sale.currencies',
};

function requestNames() {
  const names = [];
  for (const folder of ['01-System Infos Requests', '02-Common Requests', '03-Refund', '04-Exchange']) {
    for (const file of fs.readdirSync(path.join(COLLECTION, folder))) {
      if (!file.endsWith('.yml') || file === 'folder.yml') continue;
      const doc = yaml.load(fs.readFileSync(path.join(COLLECTION, folder, file), 'utf8'));
      names.push(doc?.info?.name);
    }
  }
  return names;
}

const quotedIn = (file, start) => {
  const source = fs.readFileSync(file, 'utf8');
  const from = source.indexOf(start);
  const block = source.slice(from, source.indexOf(']);', from));
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

describe('the capabilities and the step table', () => {
  test('every capability has a known group, a label and a way to be proven', () => {
    const ids = K.CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of K.CAPABILITIES) {
      expect([c.id, K.GROUPS.includes(c.group)]).toEqual([c.id, true]);
      expect(c.label.length).toBeGreaterThan(3);
      expect([c.id, Boolean(c.goal) !== Boolean(c.stage)]).toEqual([c.id, true]);
      if (c.stage) expect(['offer', 'sale']).toContain(c.stage);
    }
  });

  test('every request of the collection has a role, and every role names a request', () => {
    const names = requestNames();
    expect(names.filter((n) => !K.STEP_ROLES[n])).toEqual([]);
    expect(Object.keys(K.STEP_ROLES).filter((n) => !names.includes(n))).toEqual([]);
    const roles = new Set(Object.values(K.STEP_ROLES));
    for (const role of roles) {
      if (['offers', 'sale', 'refund', 'refundOffer'].includes(role)) continue;
      expect([role, K.CAPABILITY.has(role)]).toEqual([role, true]);
    }
    for (const c of K.CAPABILITIES.filter((x) => Array.isArray(x.goal))) {
      for (const goal of c.goal) expect([c.id, goal, names.includes(goal)]).toEqual([c.id, goal, true]);
    }
  });

  test('the optional reads are the collection\'s and the report\'s (#488)', () => {
    const collection = quotedIn(path.join(COLLECTION, 'library-bruno/auth.js'), 'const OPTIONAL_READ_PROBES');
    const report = quotedIn(path.resolve(__dirname, '../../src/reports/structureResults.js'), 'const CAPABILITY_PROBE_ENDPOINTS');
    expect([...K.OPTIONAL_READS].sort()).toEqual([...new Set(collection)].sort());
    expect([...K.OPTIONAL_READS].sort()).toEqual([...new Set(report)].sort());
  });
});

describe('the catalogue names each entry\'s capability', () => {
  const sources = new Map(simulator.scenarios.map((s) => [s.code, s]));

  test('a known capability, the one its source\'s fields give unless the provider\'s data decides', () => {
    for (const e of catalogue) {
      expect([e.code, K.CAPABILITY.has(e.capability)]).toEqual([e.code, true]);
      const derived = K.derivedCapability(sources.get(e.source), simulator);
      if (DATA_DRIVEN[e.code]) {
        expect([e.code, e.capability, derived === e.capability]).toEqual([e.code, DATA_DRIVEN[e.code], false]);
      } else {
        expect([e.code, derived]).toEqual([e.code, e.capability]);
      }
    }
  });

  test('an expected refusal is an NHF entry, or the probe of an undeclared option', () => {
    for (const e of catalogue) {
      const refusal = K.isRefusalTest({ ...sources.get(e.source), code: e.code });
      expect([e.code, refusal]).toEqual([e.code, e.code.startsWith('NHF_') || e.probe === 'OFFER_OPTION_NOT_DECLARED']);
    }
  });

  test('every scenario of the simulator\'s data file gets a capability', () => {
    for (const s of simulator.scenarios) expect([s.code, K.CAPABILITY.has(K.derivedCapability(s, simulator))]).toEqual([s.code, true]);
  });
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const SALE = ['01. POST Get Offer', '02. POST Create Booking', '03. PATCH Multi Passenger', '04. GET Passenger',
  '05. GET Booking before Fulfillments', '06. POST Obtaining Fulfillments from Booking', '06b. GET Fulfillment', '07. GET Booking after Fulfillments'];
const REFUND_OFFER = ['10. POST Refund Offers', '11. GET Refund Offer', '12. GET Booking before Patch Refund'];
const REFUND = [...REFUND_OFFER, '13. PATCH Refund Offer', '14. GET Booking after Patch Refund'];
const WITHDRAW = [...REFUND_OFFER, '15. DEL Refund Offer', '16. GET Booking after Delete Refund'];

let runCount = 0;
// A run through `names` (each answered `status`, or the step's own), stopping
// after `stopAt` when given, with failed checks { step: [check] }.
function run(names, { statuses = {}, failures = {}, stopAt = null } = {}) {
  runCount += 1;
  const end = stopAt ? names.indexOf(stopAt) + 1 : names.length;
  const steps = names.slice(0, end).map((n) => ({ request_name: n, http_status: statuses[n] ?? 200 }));
  const checks = Object.entries(failures).flatMap(([step, list]) => list.map((c) => ({ request_name: step, ...c })));
  return {
    id: `00000000-0000-4000-8000-${String(runCount).padStart(12, '0')}`, status: checks.length > 0 ? 'FAILED' : 'COMPLETED',
    completed_at: '2026-10-26 08:00:00', steps, checks, total: steps.length * 5, failed: checks.length,
    failure: checks.length > 0 ? { blocking: checks.some((c) => c.category === 'http_status'), step: checks[0].request_name, check: checks[0].assertion_name } : null,
  };
}
const fail = (assertion, category = 'business_logic') => [{ assertion_name: assertion, category, severity: 'major' }];

const ENTRIES = [
  { code: 'OTST_SALE_ONE_WAY_1ADT', source: 'S1', purpose: 'One-way sale.', capability: 'sale' },
  { code: 'OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT', source: 'S2', purpose: 'Reservation with placeSelections.', capability: 'reservation.placeSelection' },
  { code: 'OTST_REFUND_WITHDRAWN_1ADT', source: 'S3', purpose: 'Refund offer withdrawn.', capability: 'refund.withdraw' },
  { code: 'NHF_REFUND_TWICE', source: 'S4', purpose: 'A ticket refunded twice must be refused.', capability: 'refund.full' },
];
const FRAMEWORK = { salesFlows: ['SALE', 'REFUND_FULL'], offerRequestForms: ['SEARCH', 'SPECIFICATION', 'TRIP_IDS'] };
const datafile = (scenarios, scenariosToRun) => ({
  scenariosToRun: scenariosToRun || scenarios.map((s) => s.code),
  scenarios,
  tripRequirements: [{ id: 1, tripType: 'SEARCH' }, { id: 2, tripType: 'SPECIFICATION' }],
  passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }, { id: 2, passengers: [{ type: 'PERSON' }, { type: 'PERSON' }] }],
});
const oneWay = (code, extra = {}) => ({ code, scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, ...extra });
const report = (scenarios, runs, extra = {}) => capabilityCoverageOf({ framework: FRAMEWORK, datafile: datafile(scenarios, extra.runList), catalogue: ENTRIES, runs, ...extra });
const row = (r, id) => r.capabilities.find((c) => c.id === id);

describe('a failure counts against what its scenario is for (R1)', () => {
  const scenarios = [
    oneWay('OTST_SALE_ONE_WAY_1ADT'),
    { code: 'OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT', scenarioType: 'SALE', tripRequirementId: 2, passengersListId: 2, reservationBookingForm: 'PLACE_SELECTION' },
  ];
  const runs = {
    OTST_SALE_ONE_WAY_1ADT: run(SALE),
    OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT: run(SALE, {
      stopAt: '02. POST Create Booking', statuses: { '02. POST Create Booking': 500 },
      failures: { '02. POST Create Booking': fail('HTTP response status — expected 200, actual: 500', 'http_status') },
    }),
  };

  test('#956 marked the sale as a whole failed', () => {
    const old = coverageOf({ framework: FRAMEWORK, datafile: datafile(scenarios), runs });
    expect(old.functions.find((f) => f.id === 'salesFlow:SALE').state).toBe('failed');
  });

  test('now only the reservation is blocked; the sale and the offers by search pass', () => {
    const r = report(scenarios, runs);
    expect(row(r, 'reservation.placeSelection')).toMatchObject({
      result: 'blocked', tests: [{ key: 'OTST_SALE_RESERVATION_PLACE_SELECTION_2ADT', forms: [{ result: 'blocked', step: '02. POST Create Booking' }] }],
    });
    expect(row(r, 'sale').result).toBe('passed');
    expect(row(r, 'offers.search').result).toBe('passed');
    // The specification's offer request went through before the booking failed (R2).
    expect(row(r, 'offers.specification')).toMatchObject({ result: 'passed', provenBy: { count: 1 } });
    expect(r.summary).toMatchObject({ blocked: 1 });
  });
});

describe('the steps a run went through are evidence (R2), an optional operation is its own row (R7)', () => {
  const scenarios = [{ code: 'OTST_REFUND_WITHDRAWN_1ADT', scenarioType: 'REFUND', scenarioAction: 'DELETE', tripRequirementId: 1, passengersListId: 1 }];
  const runs = {
    OTST_REFUND_WITHDRAWN_1ADT: run([...SALE, ...WITHDRAW], {
      statuses: { '15. DEL Refund Offer': 501 },
      failures: { '15. DEL Refund Offer': fail('Status code is 204, offer is deleted', 'http_status') },
    }),
  };

  test('#956 marked the full refund failed', () => {
    const old = coverageOf({ framework: FRAMEWORK, datafile: datafile(scenarios), runs });
    expect(old.functions.find((f) => f.id === 'salesFlow:REFUND_FULL').state).toBe('failed');
  });

  test('now the withdrawal is not supported by the provider, and the sale and the refund offer pass', () => {
    const r = report(scenarios, runs);
    expect(row(r, 'refund.withdraw')).toMatchObject({ result: 'not-supported', tests: [{ forms: [{ result: 'not-supported', step: '15. DEL Refund Offer' }] }] });
    expect(row(r, 'refund.offer').result).toBe('passed');
    expect(row(r, 'sale').result).toBe('passed');
  });

  test('a failed fulfilment read is the read\'s own point, not the sale\'s', () => {
    const sale = { OTST_SALE_ONE_WAY_1ADT: run(SALE, { failures: { '06b. GET Fulfillment': fail('Fulfillment document is a PDF') } }) };
    const old = coverageOf({ framework: FRAMEWORK, datafile: datafile([oneWay('OTST_SALE_ONE_WAY_1ADT')]), runs: sale });
    expect(old.functions.find((f) => f.id === 'salesFlow:SALE').state).toBe('defects');
    const r = report([oneWay('OTST_SALE_ONE_WAY_1ADT')], sale);
    expect(row(r, 'sale').result).toBe('passed');
    expect(row(r, 'fulfilment.documents')).toMatchObject({ result: 'points', sideProblems: [{ code: 'OTST_SALE_ONE_WAY_1ADT', result: 'points' }] });
  });

  test('a scenario that stops before its capability leaves it blocked, with the step it stopped at', () => {
    const refund = [{ code: 'R', scenarioType: 'REFUND', scenarioAction: 'PATCH', tripRequirementId: 1, passengersListId: 1 }];
    const r = report(refund, { R: run([...SALE, ...REFUND], { stopAt: '01. POST Get Offer', failures: { '01. POST Get Offer': fail('Offers exist', 'business_logic') } }) });
    expect(row(r, 'refund.full')).toMatchObject({ result: 'blocked', tests: [{ forms: [{ step: '01. POST Get Offer', check: 'Offers exist' }] }] });
  });
});

describe('expected refusals are rows of their own (R4)', () => {
  const scenarios = [
    { code: 'NHF_REFUND_TWICE', scenarioType: 'REFUND', scenarioAction: 'PATCH', refundAgainProbe: 'on', tripRequirementId: 1, passengersListId: 1 },
  ];
  const runs = {
    NHF_REFUND_TWICE: run([...SALE, ...REFUND], {
      failures: { '14. GET Booking after Patch Refund': fail('🧪 Refund again [1 refunded fulfillment(s)]: provider rejects with a client error (4xx)') },
    }),
  };

  test('#956 marked the full refund with defects', () => {
    const old = coverageOf({ framework: FRAMEWORK, datafile: datafile(scenarios), runs });
    expect(old.functions.find((f) => f.id === 'salesFlow:REFUND_FULL').state).toBe('defects');
  });

  test('now the refusal is "not refused", and the refund it went through passes', () => {
    const r = report(scenarios, runs);
    expect(r.expectedRefusals).toMatchObject([{ key: 'NHF_REFUND_TWICE', capability: 'refund.full', result: 'not-refused', forms: [{ step: '14. GET Booking after Patch Refund' }] }]);
    expect(row(r, 'refund.full')).toMatchObject({ result: 'passed', tests: [], provenBy: { count: 1, codes: ['NHF_REFUND_TWICE'] } });
    expect(r.summary.expectedRefusals).toEqual({ total: 1, refused: 0, notRefused: 1, notRun: 0 });
  });
});

describe('one test whatever its forms and copies (R3)', () => {
  const scenarios = [
    oneWay('OTST_SALE_ONE_WAY_1ADT'),
    oneWay('OTST_SALE_ONE_WAY_1ADT_SPEC', { tripRequirementId: 2 }),
    oneWay('OTST_SALE_ONE_WAY_1ADT_TRIPID', { offersByTripIds: 'on' }),
    oneWay('OTST_SALE_ONE_WAY_1ADT_2'),
  ];
  const runs = {
    OTST_SALE_ONE_WAY_1ADT: run(SALE),
    OTST_SALE_ONE_WAY_1ADT_SPEC: run(SALE),
    OTST_SALE_ONE_WAY_1ADT_TRIPID: run(SALE, { stopAt: '01. POST Get Offer', failures: { '01. POST Get Offer': fail('trips-collection answered 400', 'http_status') } }),
  };
  const runList = ['OTST_SALE_ONE_WAY_1ADT', 'OTST_SALE_ONE_WAY_1ADT_SPEC', 'OTST_SALE_ONE_WAY_1ADT_TRIPID'];

  test('the three forms are one test that fails by trip id only, and the copy never run is set apart', () => {
    const r = report(scenarios, runs, { runList });
    expect(row(r, 'sale').tests).toEqual([expect.objectContaining({
      key: 'OTST_SALE_ONE_WAY_1ADT', result: 'points',
      forms: [
        expect.objectContaining({ form: 'SEARCH', result: 'passed' }),
        expect.objectContaining({ form: 'SPECIFICATION', result: 'passed' }),
        expect.objectContaining({ form: 'TRIP_IDS', result: 'blocked' }),
      ],
    })]);
    expect(r.apart).toEqual([{ code: 'OTST_SALE_ONE_WAY_1ADT_2', entry: 'OTST_SALE_ONE_WAY_1ADT' }]);
    expect(row(r, 'offers.tripIds').result).toBe('not-tested');
  });

  test('#956 counted the copy as a scenario never run', () => {
    const old = coverageOf({ framework: FRAMEWORK, datafile: datafile(scenarios, runList), runs });
    expect(old.functions.find((f) => f.id === 'salesFlow:SALE').scenarios.filter((s) => s.result === 'never-run').map((s) => s.code))
      .toEqual(['OTST_SALE_ONE_WAY_1ADT_2']);
  });
});

describe('what the framework says', () => {
  test('a capability the framework leaves out is out of scope; a declared one without a run is not tested', () => {
    const fw = { salesFlows: ['SALE', 'EXCHANGE_FULL'] };
    const scenarios = [oneWay('OTST_SALE_ONE_WAY_1ADT'), { code: 'R', scenarioType: 'REFUND', scenarioAction: 'PATCH', tripRequirementId: 1, passengersListId: 1 }];
    const r = capabilityCoverageOf({ framework: fw, datafile: datafile(scenarios), catalogue: ENTRIES, runs: { R: run([...SALE, ...REFUND]) } });
    expect(row(r, 'refund.full')).toMatchObject({ result: 'out-of-scope', declaration: 'not-declared' });
    expect(row(r, 'exchange.full')).toMatchObject({ result: 'not-tested', tests: [] });
    expect(r.summary).toMatchObject({ outOfScope: 1 });
  });

  test('passenger update declared not supported is out of scope', () => {
    const r = capabilityCoverageOf({ framework: { passengerUpdate: false }, datafile: datafile([oneWay('A')]), runs: { A: run(SALE) } });
    expect(row(r, 'passengers.update')).toMatchObject({ result: 'out-of-scope', declaration: 'declared-not-supported' });
  });

  test('the declared functions without a scenario are listed', () => {
    const functions = [{ id: 'card:X', group: 'Reduction cards', label: 'X', state: 'not-covered' }, { id: 'salesFlow:SALE', group: 'Sales flows', label: 'Sale', state: 'passed' }];
    const r = capabilityCoverageOf({ framework: {}, datafile: datafile([]), functions });
    expect(r.notTested).toEqual([{ id: 'card:X', group: 'Reduction cards', label: 'X', state: 'not-covered' }]);
    expect(r.summary.declaredWithoutScenario).toBe(1);
  });
});

describe('the pieces', () => {
  test('combine: passed, points, blocked, not supported', () => {
    expect(combine([])).toBeNull();
    expect(combine(['passed', 'not-supported'])).toBe('passed');
    expect(combine(['not-supported'])).toBe('not-supported');
    expect(combine(['passed', 'blocked'])).toBe('points');
    expect(combine(['blocked', 'blocked'])).toBe('blocked');
    expect(combine(['points', 'blocked'])).toBe('points');
  });

  test('an optional read answering 404 is not supported, a required step answering 404 is a failure', () => {
    const steps = stepsOf({ steps: [{ request_name: '04. GET Passenger', http_status: 404 }, { request_name: '02. POST Create Booking', http_status: 404 }], checks: [] });
    expect(steps.map((s) => [s.name, s.state])).toEqual([['04. GET Passenger', 'not-supported'], ['02. POST Create Booking', 'passed']]);
  });

  test('a run of a refund for irregular operations proves the technical cancellation at its refund steps', () => {
    const scenario = { code: 'T', scenarioType: 'REFUND', scenarioAction: 'PATCH', overruleCode: 'STRIKE' };
    const traits = K.traitsOf(scenario, datafile([]));
    const e = runEvidence(run([...SALE, ...REFUND]), { main: 'refund.technical', traits, refusal: false });
    expect(e.main.result).toBe('passed');
    expect(e.proven).toMatchObject({ sale: 'passed', 'refund.offer': 'passed', 'offers.search': 'passed' });
    expect(e.proven['refund.technical']).toBeUndefined();
  });
});
