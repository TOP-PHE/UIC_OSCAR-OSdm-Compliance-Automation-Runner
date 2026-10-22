'use strict';

/**
 * bruno-fares.test.js — the fare checks of step 01 (#903).
 *
 * The answers come from the OSDM simulator itself (gamma, OSDM 3.8): its
 * normal fares pass every check, and each of its wrong variants fails
 * exactly the check it is made for, and no other.
 */

const fs = require('fs');
const path = require('path');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');

const ROOT = path.join(__dirname, '..', '..', '..');
const providers = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers'));
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const ADULT = { externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' };
const SECOND = { externalRef: '00002', type: 'PERSON', dateOfBirth: '1985-06-01' };
const CHILD = { externalRef: '00003', type: 'PERSON', dateOfBirth: '2023-03-01' };

function request({ start = '0000001', parts = ['FARE_ADMISSION'], passengers = [ADULT, SECOND] } = {}) {
  return {
    tripSpecifications: [{
      isPartOfInternationalTrip: true,
      legs: [{ timedLeg: {
        start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
        end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
        service: { vehicleNumbers: ['1001'] },
      } }],
    }],
    requestedSections: [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: parts },
    anonymousPassengerSpecifications: passengers,
  };
}

const answer = (req) => buildOfferCollection(req, providers.get('gamma'), NOW).response;
const failing = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort();
const run = (req) => failing(fares.fareChecks(answer(req), req, { travelDay: '2026-11-20' }));

describe('fare checks on the simulator\'s answers', () => {
  test('normal fares, with a free child, pass every check', () => {
    expect(run(request({ passengers: [ADULT, SECOND, CHILD] }))).toEqual([]);
  });

  test.each([
    ['0000080', 'a passenger without a fare', ['O7 FAIL']],
    ['0000081', 'a cluster outside the list', ['O10 WARNING']],
    ['0000082', 'allowed clusters wider than the reference', ['O11 WARNING']],
    ['0000083', 'a gap in the section', ['O8 FAIL']],
    ['0000084', 'overlapping fares', ['O8 WARNING']],
  ])('variant %s (%s) fails exactly %j', (start, _what, expected) => {
    expect(run(request({ start }))).toEqual(expected);
  });

  test('fares that were not asked fail O14; asked ones do not', () => {
    const req = request({ start: '0000085', parts: ['ADMISSION'] });
    expect(fares.unaskedFaresCheck(answer(req), req)).toMatchObject({ id: 'O14', ok: false });
    const asked = request();
    expect(fares.unaskedFaresCheck(answer(asked), asked)).toBeNull();
    const none = request({ parts: ['ADMISSION'] });
    expect(fares.unaskedFaresCheck(answer(none), none)).toMatchObject({ ok: true });
  });

  test('no fare offer at all fails O1 and stops there', () => {
    const req = request();
    const checks = fares.fareChecks({ offers: [] }, req);
    expect(checks.map((c) => c.id)).toEqual(['O1']);
    expect(checks[0].ok).toBe(false);
  });
});

describe('fare checks on hand-made answers', () => {
  const req = request({ passengers: [ADULT] });
  const base = () => answer(req);
  const firstFare = (body) => body.offers.find((o) => o.fares).fares[0];

  test('a missing required member, a type not asked, a negative price', () => {
    const body = base();
    delete firstFare(body).travelClass;
    expect(run2(body)).toContain('O2 FAIL');
    const typed = base();
    firstFare(typed).type = 'RESERVATION';
    expect(run2(typed)).toContain('O3 FAIL');
    const neg = base();
    firstFare(neg).prices[0].amount = -1;
    expect(run2(neg)).toContain('O13 FAIL');
  });

  test('regional validities, after-sales conditions, validity range, TCOs, combination model', () => {
    const cases = [
      [(f) => { f.regionalConstraint.regionalValidities = []; }, 'O4 FAIL'],
      [(f) => { f.regionalConstraint.regionalValidities = [{ seqNb: 1 }]; }, 'O4 WARNING'],
      [(f) => { f.afterSalesCondition.conditions = []; }, 'O5 FAIL'],
      [(f) => { delete f.travelValidityConstraint.validityRange; }, 'O6 FAIL'],
      [(f) => { f.travelValidityConstraint.validTravelDates = { from: '2026-12-01T00:00:00Z', until: '2026-12-02T00:00:00Z' }; }, 'O6 WARNING'],
      [(f) => { delete f.involvedTCOs; }, 'O12 WARNING'],
      [(f) => { f.combinationConstraint[0].model = 'CLUSTER'; }, 'O9 WARNING'],
      [(f) => { delete f.coveredSection; }, 'O8 WARNING'],
    ];
    for (const [change, expected] of cases) {
      const body = base();
      change(firstFare(body));
      expect(run2(body)).toEqual([expected]);
    }
  });

  test('without coveredSection, the entry and exit connection points say what a fare covers', () => {
    const body = base();
    for (const offer of body.offers.filter((o) => o.fares)) {
      for (const f of offer.fares) {
        delete f.coveredSection;
        f.regionalConstraint.exitConnectionPoint = { objectType: 'FareConnectionPoint', id: 'x', stationSets: [{ stations: [station('2')] }] };
      }
    }
    expect(run2(body)).toEqual([]);
  });

  function run2(body) {
    return failing(fares.fareChecks(body, req, { travelDay: '2026-11-20' }));
  }
});

describe('the pure helpers', () => {
  test('asksFares and the types asked', () => {
    expect(fares.asksFares({ offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] } })).toBe(true);
    expect(fares.asksFares({ offerSearchCriteria: { requestedOfferParts: ['ALL'] } })).toBe(true);
    expect(fares.asksFares({ offerSearchCriteria: { requestedOfferParts: ['ADMISSION'] } })).toBe(false);
    expect(fares.asksFares({})).toBe(false);
    expect(fares.typesAsked({ offerSearchCriteria: { requestedOfferParts: ['ALL'] } })).toEqual(['ADMISSION', 'RESERVATION', 'ANCILLARY']);
  });

  test('the coverage walk: covered, gap, overlap, unknown; stations compared without leading zeros', () => {
    const fare = (a, b) => ({ coveredSection: { startPlace: station(a), endPlace: station(b) } });
    const section = { start: 'urn:uic:stn:0000001', end: 'urn:uic:stn:0000003' };
    expect(fares.coverageOfPassenger([fare('1', '2'), fare('0000002', '3')], section)).toBe('covered');
    expect(fares.coverageOfPassenger([fare('1', '2')], section)).toBe('gap');
    expect(fares.coverageOfPassenger([fare('1', '3'), fare('1', '2')], section)).toBe('overlap');
    expect(fares.coverageOfPassenger([{}], section)).toBe('unknown');
  });

  test('chooseFareOffer takes the cluster asked, else the first fare offer', () => {
    const body = answer(request());
    expect(fares.chooseFareOffer(body, 'SEMI_FLEX').fares[0].combinationConstraint[0].referenceCluster).toBe('SEMI_FLEX');
    expect(fares.chooseFareOffer(body, null).fares[0].combinationConstraint[0].referenceCluster).toBe('FULL_FLEX');
    expect(fares.chooseFareOffer(body, 'PROMO')).toBeNull();
  });

  test('productOffersOf leaves fare-only offers out', () => {
    const body = answer(request());
    expect(fares.productOffersOf(body).every((o) => !o.fares)).toBe(true);
    expect(fares.productOffersOf(body).length).toBeGreaterThan(0);
  });

  test('fareFieldsOf reads a scenario', () => {
    expect(fares.fareFieldsOf({
      requestedSections: [{ startPlace: '8000001', endPlace: 'urn:uic:stn:8500010' }, { startPlace: 'x', endPlace: '' }],
      isPartOfInternationalTrip: 'true', desiredFareCluster: 'semi_flex', bookMode: 'fare',
    })).toEqual({
      requestedSections: [{ startPlace: station('8000001'), endPlace: station('8500010') }], emptySectionList: false,
      isPartOfInternationalTrip: true, desiredFareCluster: 'SEMI_FLEX', bookMode: 'FARE', expectFares: null, fareRefundFee: null,
    });
    expect(fares.fareFieldsOf({})).toEqual({
      requestedSections: [], emptySectionList: false, isPartOfInternationalTrip: null, desiredFareCluster: null, bookMode: null, expectFares: null, fareRefundFee: null,
    });
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  test('01 checks fares after the status check and before the product checks, and ends a fare scenario', () => {
    const yml = read('Bruno_Collection/02-Common Requests/01. POST Get Offer.yml');
    const fareAt = yml.indexOf('fares.js").checkFareOffers(jsonData)');
    expect(fareAt).toBeGreaterThan(yml.indexOf('Stop flow if status != 200'));
    expect(fareAt).toBeLessThan(yml.indexOf('postOfferResponse(jsonData);'));
  });

  test('the request carries the sections, the trip specification the flag', () => {
    expect(read('Bruno_Collection/library-bruno/requestsBuilder.js')).toContain('body.requestedSections = requestedSections');
    expect(read('Bruno_Collection/library-bruno/scenarioParser.js')).toContain('tripSpecification.isPartOfInternationalTrip =');
  });

  test('both reset lists name the new variables', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      const text = read(file);
      for (const v of ['requestedSections', 'isPartOfInternationalTrip', 'desiredFareCluster', 'bookMode', 'fareOfferId']) {
        expect(text).toContain(`"${v}"`);
      }
    }
  });
});

describe('the negative fare requests (#905)', () => {
  const withoutSection = (req) => { const r = { ...req }; delete r.requestedSections; return r; };
  const fromStation = (req, code) => {
    const r = JSON.parse(JSON.stringify(req));
    r.tripSpecifications[0].legs[0].timedLeg.start.stopPlaceRef = station(code);
    return r;
  };
  const outcome = (req) => fares.noFareChecks(answer(req), req).map((c) => `${c.id} ${c.level} ${c.ok ? 'ok' : 'broken'}`);

  test('on the simulator\'s answers: none of N1, N2 and N4 has a fare; the wrong variant fails N', () => {
    // N1: a section, ADMISSION only: O14 says it.
    expect(outcome(request({ start: '0000001', parts: ['ADMISSION'] }))).toEqual(['O14 FAIL ok', 'O15 INFO ok']);
    // N2: fares asked, no section; N4: an empty list.
    expect(outcome(withoutSection(request()))).toEqual(['N FAIL ok', 'O15 INFO ok']);
    expect(outcome({ ...request(), requestedSections: [] })).toEqual(['N FAIL ok', 'O15 INFO ok']);
    // A trip from the variant station gets fares all the same.
    expect(outcome(fromStation(withoutSection(request()), '0000086'))).toEqual(['N FAIL broken', 'O15 INFO ok']);
    // Fares not asked, given anyway: O14, not N.
    expect(outcome(request({ start: '0000085', parts: ['ADMISSION'] }))).toEqual(['O14 FAIL broken', 'O15 INFO ok']);
  });

  test('no offer part named and fares given: N, since O14 then checks nothing', () => {
    const req = request();
    delete req.offerSearchCriteria;
    const checks = fares.noFareChecks(answer(request()), req);
    expect(checks[0]).toMatchObject({ id: 'N', ok: false });
    expect(checks[0].message).toMatch(/6 fare\(s\) in 3 offer\(s\)/);
  });

  test('fareFieldsOf: expectFares is false only when the scenario says so; an empty list is kept apart', () => {
    for (const value of [false, 'false']) expect(fares.fareFieldsOf({ expectFares: value }).expectFares).toBe(false);
    for (const value of [true, 'true', '', null, undefined, 'no']) expect(fares.fareFieldsOf({ expectFares: value }).expectFares).toBeNull();
    expect(fares.fareFieldsOf({ requestedSections: [] }).emptySectionList).toBe(true);
    expect(fares.fareFieldsOf({ requestedSections: [{ startPlace: '', endPlace: '' }] }).emptySectionList).toBe(false);
    expect(fares.fareFieldsOf({ requestedSections: null }).emptySectionList).toBe(false);
  });

  test('sectionsToSend: an empty list goes out with a request for fares only', () => {
    const asks = { requestedOfferParts: ['FARE_ADMISSION'] };
    const one = [{ startPlace: station('1'), endPlace: station('2') }];
    expect(fares.sectionsToSend([], asks)).toEqual([]);
    expect(fares.sectionsToSend([], { requestedOfferParts: ['ADMISSION'] })).toBeUndefined();
    expect(fares.sectionsToSend([], null)).toBeUndefined();
    expect(fares.sectionsToSend(null, asks)).toBeUndefined();
    expect(fares.sectionsToSend(one, { requestedOfferParts: ['ADMISSION'] })).toBe(one);
  });

  describe('step 01: a scenario expecting no fare ends, or goes on with a product', () => {
    const env = {};
    const recorded = [];
    const logged = [];
    beforeEach(() => {
      for (const k of Object.keys(env)) delete env[k];
      recorded.length = 0;
      logged.length = 0;
      global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; } };
      global.test = (name, fn) => { try { fn(); recorded.push(`${name}: ok`); } catch (e) { recorded.push(`${name}: ${e.message}`); } };
      global.validationLogger = (line) => logged.push(line);
    });
    afterAll(() => { delete global.bru; delete global.validationLogger; global.test = test; });
    const realTest = test;
    const runStep = (req, vars) => {
      Object.assign(env, { OfferCollectionRequest: JSON.stringify(req), ...vars });
      const body = answer(req);
      return { ended: fares.checkFareOffers(body), body };
    };

    realTest('without bookMode the scenario ends; no fare check but N runs', () => {
      const { ended } = runStep(withoutSection(request()), { expectFares: 'false' });
      expect(ended).toBe(true);
      expect(recorded).toEqual(['[fares N] No fare in the answer, as the scenario expects (expectFares: false): ok']);
      expect(logged.join('\n')).toMatch(/No requested section, on purpose/);
      expect(logged.join('\n')).not.toMatch(/\[WARNING\]/);
    });

    realTest('with bookMode PRODUCT the sale goes on, with the product offers only', () => {
      const { ended, body } = runStep(fromStation(withoutSection(request()), '0000086'), { expectFares: 'false', bookMode: 'PRODUCT' });
      expect(ended).toBe(false);
      expect(recorded[0]).toMatch(/^\[fares N\] .*: 6 fare\(s\) in 3 offer\(s\)/);
      expect(body.offers.length).toBeGreaterThan(0);
      expect(body.offers.every((o) => !o.fares)).toBe(true);
    });

    realTest('without expectFares, a fare request without a section is still graded as before (O1 fails)', () => {
      const { ended } = runStep(withoutSection(request()), {});
      expect(ended).toBe(true);
      expect(recorded[0]).toMatch(/^\[fares O1\] .*: the request asks for fares/);
      expect(logged.join('\n')).toMatch(/\[WARNING\] \[fares\] The request asks for fares without a requested section/);
    });
  });

  test('the wiring: the parser sets expectFares, both reset lists clear it, the request sends sections through sectionsToSend, Test Config shows it', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    expect(read('Bruno_Collection/library-bruno/scenarioParser.js')).toContain('bru.setEnvVar("expectFares", _fareFields.expectFares === false ? "false" : null);');
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect(read(file)).toContain('"bookMode", "expectFares", "fareOfferId"');
    }
    expect(read('Bruno_Collection/library-bruno/requestsBuilder.js')).toContain('const requestedSections = sectionsToSend(parseEnvJson("requestedSections", null), parseEnvJson("offerSearchCriteria", null));');
    const src = read('Oscar_Server/public/js/scenarios.js');
    expect(src).toContain("buildSelect(idx, 'expectFares', 'Fares expected', ENUMS.expectFares,");
    expect(src).toContain("expectFares:                       [null, 'false'],");
    const schema = JSON.parse(read('Bruno_Collection/json_validator/datafile.schema.json'));
    const scenarioProps = JSON.stringify(schema);
    expect(scenarioProps).toContain('"expectFares":{');
  });
});

describe('the Test Config fields (#903)', () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'Oscar_Server/public/js/scenarios.js'), 'utf8');
  const lift = (name, context = {}) => {
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const requestedSectionOf = lift('requestedSectionOf');
  const withRequestedSection = lift('withRequestedSection', { requestedSectionOf });

  test('one end typed keeps the other; both empty removes the section; later sections stay', () => {
    expect(withRequestedSection({}, 'startPlace', ' 8000001 ')).toEqual([{ startPlace: '8000001', endPlace: '' }]);
    const one = { requestedSections: [{ startPlace: '8000001', endPlace: '' }] };
    expect(withRequestedSection(one, 'endPlace', '8500010')).toEqual([{ startPlace: '8000001', endPlace: '8500010' }]);
    expect(withRequestedSection(one, 'startPlace', '')).toBeNull();
    const two = { requestedSections: [{ startPlace: 'a', endPlace: '' }, { startPlace: 'c', endPlace: 'd' }] };
    expect(withRequestedSection(two, 'startPlace', '')).toEqual([{ startPlace: 'c', endPlace: 'd' }]);
    expect(requestedSectionOf({ requestedSections: null })).toEqual({ startPlace: '', endPlace: '' });
  });

  test('the fields are drawn, the input handled before the switch, the flag shown when stored as a boolean', () => {
    expect(src).toContain('${buildFareFields(idx)}');
    expect(src).toContain("if (inputRequestedSection(action, el)) return;\n  if (inputFareRefundFee(action, el)) return;\n\n  switch (action) {");
    expect(src).toContain('String(optionValue(val)) === String(optionValue(o))');
    const access = require(path.join(ROOT, 'Oscar_Server/public/js/scenario-access.js'));
    expect(access.READ_ONLY_CARD_ACTIONS).not.toContain('set-scenario-section');
  });
});

describe('the requested sections against the trip (#904)', () => {
  const leg = (from, to, intermediates = []) => ({ timedLeg: {
    start: { stopPlaceRef: station(from) }, end: { stopPlaceRef: station(to) },
    intermediates: intermediates.map((c) => ({ stopPlaceRef: station(c) })),
  } });
  const sectionOf = (a, b) => [{ startPlace: station(a), endPlace: station(b) }];

  test('a trip specification gives every station; a section must start on it and end after its start', () => {
    const spec = { tripSpecifications: [{ legs: [leg('0000001', '0000004', ['0000003']), leg('0000004', '0000002')] }] };
    expect(fares.tripStationsOf(spec)).toEqual({ stations: ['urn:uic:stn:0000001', 'urn:uic:stn:0000003', 'urn:uic:stn:0000004', 'urn:uic:stn:0000002'], complete: true });
    expect(fares.sectionsOutsideTrip({ ...spec, requestedSections: sectionOf('0000003', '0000002') })).toEqual([]);
    expect(fares.sectionsOutsideTrip({ ...spec, requestedSections: sectionOf('4', '2') })).toEqual([]);
    expect(fares.sectionsOutsideTrip({ ...spec, requestedSections: sectionOf('0000080', '0000002') })[0]).toMatch(/starts at a station that is not on the trip/);
    expect(fares.sectionsOutsideTrip({ ...spec, requestedSections: sectionOf('0000004', '0000001') })[0]).toMatch(/does not end at a station after its start/);
  });

  test('a trip chosen by id is read from its legs; none known checks nothing', () => {
    const byId = { tripIds: ['T1'], requestedSections: sectionOf('0000001', '0000009') };
    expect(fares.sectionsOutsideTrip(byId, [leg('0000001', '0000002')])).toHaveLength(1);
    expect(fares.sectionsOutsideTrip(byId, [leg('0000001', '0000009')])).toEqual([]);
    expect(fares.sectionsOutsideTrip(byId, null)).toEqual([]);
  });

  test('search criteria: only a section between two given stations in the wrong order is outside', () => {
    const search = { tripSearchCriteria: { origin: station('0000001'), destination: station('0000002'), vias: [{ viaPlace: station('0000005') }] } };
    expect(fares.tripStationsOf(search).complete).toBe(false);
    expect(fares.sectionsOutsideTrip({ ...search, requestedSections: sectionOf('0000001', '0000002') })).toEqual([]);
    expect(fares.sectionsOutsideTrip({ ...search, requestedSections: sectionOf('0000007', '0000002') })).toEqual([]);
    expect(fares.sectionsOutsideTrip({ ...search, requestedSections: sectionOf('0000002', '0000005') })[0]).toMatch(/against the direction of the search/);
  });

  test('the trip search path follows the version: trips-collections from OSDM 3.10', () => {
    const { tripsCollectionPath } = require('../../../Bruno_Collection/library-bruno/tripIds.js');
    expect(['3.6.0', '3.8', '3.9.0', '', null].map(tripsCollectionPath)).toEqual(Array(5).fill('trips-collection'));
    expect(['3.10.0', '3.11', '4.0.0'].map(tripsCollectionPath)).toEqual(Array(3).fill('trips-collections'));
  });

  test('the wiring: checked before the request is sent, graded first after it; the chosen trip kept; the flag for a specification only', () => {
    const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const yml = read('Bruno_Collection/02-Common Requests/01. POST Get Offer.yml');
    expect(yml.indexOf('prepareSectionCheck()')).toBeGreaterThan(yml.indexOf('await prepareOfferRequestByTripIds();'));
    expect(yml.indexOf('stopOnSectionsOutside()')).toBeLessThan(yml.indexOf('checkOfferRequestByTripIds(res.getStatus()'));
    const offers = read('Bruno_Collection/library-bruno/offers.js');
    expect(offers).toContain('bru.setEnvVar("__chosenTripLegs", JSON.stringify(');
    expect(offers).toContain('tripsCollectionPath(bru.getEnvVar("osdmVersion"))}`');
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect(read(file)).toContain('"__fareSectionsOutside", "__chosenTripLegs"');
    }
    const vm = require('vm');
    const src = read('Oscar_Server/public/js/scenarios.js');
    const lines = src.split('\n');
    const start = lines.findIndex((l) => l.startsWith('function fareInternationalField('));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    const trips = { 1: { tripType: 'SEARCH' }, 2: { tripType: 'SPECIFICATION' } };
    const ctx = { state: { scenarios: [{ tripRequirementId: 1 }, { tripRequirementId: 2 }] }, getTrip: (id) => trips[id] || {},
      buildSelect: (idx, field) => `<${field}>`, ENUMS: {} };
    const field = vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, ctx);
    expect(field(0)).toBe('');
    expect(field(1)).toBe('<isPartOfInternationalTrip>');
  });
});
