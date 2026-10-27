// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #227: which optional parameters of the offer request a provider supports.
 * The pure part of library-bruno/offerOptions.js.
 */

const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const o = require(path.join(LIB, 'offerOptions.js'));
const { requestIssues } = require(path.join(LIB, 'osdmRequestSchema.js'));

const place = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });

const searchRequest = () => ({
  anonymousPassengerSpecifications: [
    { externalRef: 'P1', type: 'PERSON', dateOfBirth: '1980-01-01', gender: 'MALE' },
    { externalRef: 'P2', dateOfBirth: '1985-02-02', gender: 'FEMALE', cards: [{ type: 'REDUCTION_CARD', code: 'X' }] },
  ],
  tripSearchCriteria: { origin: place('8500010'), destination: place('8507000'), departureTime: '2026-11-10T08:00:00', parameters: { numberOfResults: 5 } },
  offerSearchCriteria: { currency: 'CZK', flexibilities: ['NON_FLEXIBLE'] },
  requestedFulfillmentOptions: [{ type: 'ETICKET', media: 'PDF_A4' }],
});

const VERSIONS = ['3.4.0', '3.5.0', '3.6.0', '3.7.0', '3.8.0', '3.9.0', '3.10.0', '3.11.0', '3.12.0'];

const optionsOf = (extra = {}) => o.optionsFor({ request: searchRequest(), version: '3.8.0', seed: 7, travelDay: '2026-11-10', ...extra });
const row = (rows, key) => rows.find((r) => r.option.key === key);

describe('the mandatory request', () => {
  test('keeps each passenger\'s externalRef and type, and the search\'s origin, destination and time', () => {
    expect(o.mandatoryRequest(searchRequest())).toEqual({
      anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }],
      tripSearchCriteria: { origin: place('8500010'), destination: place('8507000'), departureTime: '2026-11-10T08:00:00' },
    });
  });

  test('keeps trip ids or a specification as they are', () => {
    expect(o.mandatoryRequest({ tripIds: ['T1'], anonymousPassengerSpecifications: [{ externalRef: 'A' }] }))
      .toEqual({ tripIds: ['T1'], anonymousPassengerSpecifications: [{ externalRef: 'A', type: 'PERSON' }] });
    const spec = [{ legs: [{ timedLeg: { start: { stopPlaceRef: place('1') } } }] }];
    expect(o.mandatoryRequest({ tripSpecifications: spec }).tripSpecifications).toEqual(spec);
    expect(o.tripFormOf({ tripSpecifications: spec })).toBe('SPECIFICATION');
    expect(o.tripFormOf({})).toBe('SEARCH');
  });

  test.each(VERSIONS)('is a valid OSDM %s request', (version) => {
    expect(requestIssues(o.mandatoryRequest(searchRequest()), 'OfferCollectionRequest', version)).toEqual([]);
  });
});

describe('the options', () => {
  test.each(VERSIONS)('each one alone, and all at once, keep the request valid in OSDM %s', (version) => {
    const rows = o.optionsFor({ request: searchRequest(), version, seed: 3, travelDay: '2026-11-10' }).filter((r) => !r.skipped);
    const mandatory = o.mandatoryRequest(searchRequest());
    for (const r of rows) {
      expect([r.option.key, requestIssues(o.withOptions(mandatory, [r]), 'OfferCollectionRequest', version)]).toEqual([r.option.key, []]);
    }
    expect(requestIssues(o.withOptions(mandatory, o.allSupported(rows)), 'OfferCollectionRequest', version)).toEqual([]);
  });

  test('follow the version\'s schema: no member OSDM 3.4 does not have', () => {
    const keys = (v) => o.optionsFor({ request: searchRequest(), version: v, seed: 1, travelDay: '2026-11-10' }).map((r) => r.option.key);
    const old = keys('3.4.0');
    for (const k of ['passenger.transportable', 'offerSearchCriteria.productSelections', 'offerSearchCriteria.inboundDate', 'tripResponseParameters']) {
      expect(old).not.toContain(k);
      expect(keys('3.8.0')).toContain(k);
    }
  });

  test('take the scenario\'s own values first, per passenger, else OSDM defaults', () => {
    const rows = optionsOf();
    const birth = row(rows, 'passenger.dateOfBirth');
    expect(birth.source).toBe('scenario');
    const req = o.withOptions(o.mandatoryRequest(searchRequest()), [birth]);
    expect(req.anonymousPassengerSpecifications.map((p) => p.dateOfBirth)).toEqual(['1980-01-01', '1985-02-02']);
    expect(row(rows, 'passenger.cards').source).toBe('scenario');
    expect(row(rows, 'offerSearchCriteria.offerMode').value).toBe('COLLECTIVE');
    expect(row(rows, 'requestedSections').value).toEqual([{ startPlace: place('8500010'), endPlace: place('8507000') }]);
    expect(row(rows, 'tripSearchCriteria.arrivalTime').value).toBe('2026-11-10T14:00:00');
    expect(row(rows, 'offerSearchCriteria.inboundDate').value).toBe('2026-11-12T16:00:00');
  });

  test('age replaces the date of birth, and the two are never combined', () => {
    const rows = optionsOf();
    const req = o.withOptions(o.mandatoryRequest(searchRequest()), [row(rows, 'passenger.age')]);
    expect(req.anonymousPassengerSpecifications[0]).toEqual({ externalRef: 'P1', type: 'PERSON', age: 35 });
    const all = o.allSupported(rows.filter((r) => !r.skipped)).map((r) => r.option.key);
    expect(all).toContain('passenger.dateOfBirth');
    expect(all).not.toContain('passenger.age');
    expect(all).not.toContain('offerSearchCriteria.serviceClassTypes');
  });

  test('declared values win; without them a code is made up, or not tested', () => {
    const declared = optionsOf({ values: { corporateCodes: [{ code: 'ACME', issuer: 'urn:x:acme' }] } });
    expect(row(declared, 'corporateCodes')).toMatchObject({ source: 'declared', value: [{ code: 'ACME', issuer: 'urn:x:acme' }] });
    const made = row(optionsOf(), 'promotionCodes');
    expect(made.source).toBe('invalid');
    expect(made.value[0].code).toMatch(/^OSCAR-UNKNOWN-[0-9A-F]{6}$/);
    expect(row(optionsOf(), 'promotionCodes').value).toEqual(made.value);
    expect(row(optionsOf({ seed: 8 }), 'promotionCodes').value).not.toEqual(made.value);
    expect(row(optionsOf({ invalidValues: 'skip' }), 'promotionCodes').skipped).toMatch(/invalid values are not sent/);
  });

  test('trip search options are only for a search', () => {
    const rows = o.optionsFor({ request: { ...searchRequest(), tripSearchCriteria: undefined, tripIds: ['T'] }, version: '3.8.0', seed: 1 });
    expect(row(rows, 'tripSearchCriteria.arrivalTime').skipped).toMatch(/trip ids/);
    expect(row(rows, 'tripSearchCriteria.vias').skipped).toBeDefined();
  });
});

describe('classifying an answer', () => {
  const asked = (key, extra) => [{ ...row(optionsOf(extra), key) }];
  const request = (picks) => o.withOptions(o.mandatoryRequest(searchRequest()), picks);
  const offer = (over = {}) => ({ offerId: 'O1', offerSummary: { minimalPrice: { amount: 100, currency: 'CZK' }, overallFlexibility: 'FULL_FLEXIBLE' }, ...over });

  test('level 1: the status alone', () => {
    expect(o.statusClass(200)).toBe('supported');
    expect(o.statusClass(400)).toBe('refused');
    expect(o.statusClass(501)).toBe('not-implemented');
    expect(o.statusClass(500)).toBe('error');
    expect(o.statusClass(0)).toBe('error');
    const refused = o.classify(400, { code: 'PROMOTION_CODE_UNKNOWN', title: 'unknown', pointers: [{ requestPointer: '/promotionCodes/0' }] }, {}, []);
    expect(refused).toMatchObject({ level1: 'refused', result: 'refused', message: 'PROMOTION_CODE_UNKNOWN: unknown (at /promotionCodes/0)' });
    expect(o.classify(400, { problems: [{ code: 'A', pointers: ['/x'] }, { code: 'B' }] }, {}, []).message).toBe('A (at /x) | B');
    expect(o.classify(503, null, {}, []).message).toBe('HTTP 503');
  });

  test('honoured when the offers keep to the option, ignored silently when not', () => {
    const picks = asked('offerSearchCriteria.currency', { values: { 'offerSearchCriteria.currency': 'EUR' } });
    const eur = offer({ offerSummary: { minimalPrice: { amount: 1, currency: 'EUR' } } });
    expect(o.classify(200, { offers: [eur] }, request(picks), picks).result).toBe('honoured');
    expect(o.classify(200, { offers: [offer()] }, request(picks), picks).result).toBe('ignored-silent');
    expect(o.classify(200, { offers: [offer()], problems: [{ code: 'CURRENCY_NOT_SUPPORTED' }] }, request(picks), picks).result).toBe('ignored-said');
  });

  test('ignored said when the answer names the member as not supported', () => {
    const picks = asked('passenger.residency');
    const r = o.classify(200, { offers: [offer()] }, request(picks), picks, ['residency']);
    expect(r.result).toBe('ignored-said');
    expect(r.message).toMatch(/passenger.residency/);
  });

  test('accepted when the answer cannot show it', () => {
    const picks = asked('passenger.gender');
    expect(o.classify(201, { offers: [offer()] }, request(picks), picks).result).toBe('accepted');
  });

  test('no offer must say why', () => {
    const picks = asked('passenger.prmNeeds');
    expect(o.classify(200, { offers: [] }, request(picks), picks).result).toBe('no-offer-silent');
    expect(o.classify(200, { offers: [], warnings: { warnings: [{ code: 'NO_OFFER_FOR_PRM' }] } }, request(picks), picks))
      .toMatchObject({ result: 'no-offer-said', message: 'NO_OFFER_FOR_PRM' });
  });

  test('a made-up code taken without a word is reported; said is fine', () => {
    const picks = asked('promotionCodes');
    expect(o.classify(200, { offers: [offer()] }, request(picks), picks).result).toBe('invalid-silent');
    expect(o.classify(200, { offers: [offer()], problems: [{ code: 'PROMOTION_CODE_UNKNOWN' }] }, request(picks), picks).result).toBe('invalid-said');
    expect(o.isSupported({ source: 'invalid', result: 'accepted' })).toBe(false);
    expect(o.isSupported({ source: 'default', result: 'honoured' })).toBe(true);
    expect(o.isSupported({ source: 'default', result: 'ignored-said' })).toBe(false);
  });

  test('phase 1 fails on a refusal or no offer', () => {
    expect(o.mandatoryOutcome(200, { offers: [offer()] }).ok).toBe(true);
    expect(o.mandatoryOutcome(400, { problems: [{ code: 'MISSING_GENDER' }] })).toMatchObject({ ok: false });
    expect(o.mandatoryOutcome(400, { problems: [{ code: 'MISSING_GENDER' }] }).message).toMatch(/MISSING_GENDER/);
    expect(o.mandatoryOutcome(200, { offers: [] }).ok).toBe(false);
  });
});

describe('planning', () => {
  test('the budget is 30 by default, within 3 and 200', () => {
    expect(o.budgetOf(undefined)).toBe(30);
    expect(o.budgetOf('x')).toBe(30);
    expect(o.budgetOf(1)).toBe(3);
    expect(o.budgetOf('500')).toBe(200);
    expect(o.budgetOf(12)).toBe(12);
  });

  test('phases 1 and 4 always run, three combinations are kept when the budget allows', () => {
    expect(o.plan(30, 25)).toEqual({ phase1: 1, phase2: 25, phase3: 3, phase4: 1 });
    expect(o.plan(30, 10)).toEqual({ phase1: 1, phase2: 10, phase3: 18, phase4: 1 });
    expect(o.plan(10, 25)).toEqual({ phase1: 1, phase2: 5, phase3: 3, phase4: 1 });
    expect(o.plan(3, 25)).toEqual({ phase1: 1, phase2: 1, phase3: 0, phase4: 1 });
    for (const [b, n] of [[30, 25], [10, 25], [3, 25], [200, 5]]) {
      const p = o.plan(b, n);
      expect(p.phase1 + p.phase2 + p.phase3 + p.phase4).toBeLessThanOrEqual(b);
    }
  });

  test('combinations are seeded, distinct, 2 to 4 options, never two of one group', () => {
    const rows = optionsOf().filter((r) => !r.skipped);
    const a = o.drawCombinations(rows, 5, 11);
    expect(a).toHaveLength(5);
    expect(o.drawCombinations(rows, 5, 11).map((c) => c.map((r) => r.option.key))).toEqual(a.map((c) => c.map((r) => r.option.key)));
    const keys = new Set();
    for (const combo of a) {
      expect(combo.length).toBeGreaterThanOrEqual(2);
      expect(combo.length).toBeLessThanOrEqual(4);
      const groups = combo.map((r) => r.option.conflicts).filter(Boolean);
      expect(new Set(groups).size).toBe(groups.length);
      keys.add(combo.map((r) => r.option.key).sort().join('+'));
    }
    expect(keys.size).toBe(5);
    expect(o.drawCombinations(rows.slice(0, 1), 3, 1)).toEqual([]);
  });

  test('the seed of a scenario code is stable', () => {
    expect(o.seedOf('OTST_OFFER_OPTION_DISCOVERY')).toBe(o.seedOf('OTST_OFFER_OPTION_DISCOVERY'));
    expect(o.seedOf('A')).not.toBe(o.seedOf('B'));
  });
});

describe('the report', () => {
  test('names each option, the phases and what was taken without a word', () => {
    const lines = o.reportLines({
      version: '3.8.0', budget: 30, used: 6, seed: 9,
      mandatory: { ok: true, message: '3 offer(s)' },
      options: [
        { option: 'passenger.gender', value: 'FEMALE', source: 'default', status: 200, result: 'accepted', message: '' },
        { option: 'promotionCodes', value: [{ code: 'OSCAR-UNKNOWN-1' }], source: 'invalid', status: 200, result: 'invalid-silent', message: 'taken' },
        { option: 'tripSearchCriteria.vias', result: 'not-tested', message: 'no value' },
      ],
      combinations: [{ options: ['a', 'b'], status: 200, result: 'accepted', message: '' }],
      all: { options: ['passenger.gender'], status: 200, result: 'accepted', message: '' },
    });
    expect(lines[0]).toMatch(/OSDM 3.8.0, budget 30 request\(s\), 6 used, seed 9/);
    expect(lines.some((l) => /Phase 2.*1 accepted, 1 invalid-silent, 1 not-tested/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('promotionCodes = [{"code":"OSCAR-UNKNOWN-1"}] (invalid): HTTP 200, invalid-silent'))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\[WARNING\].*promotionCodes/);
  });
});

describe('the phases, with a provider stub', () => {
  // A provider that refuses promotion codes, ignores residency silently and
  // keeps to the rest.
  const offerFor = (body) => ({
    offerId: 'O', offerSummary: { minimalPrice: { amount: 1, currency: body.offerSearchCriteria?.currency || 'CZK' }, overallFlexibility: 'FULL_FLEXIBLE', overallTravelClass: 'FIRST' },
    admissionOfferParts: [{ travelClass: 'FIRST', serviceClass: { type: 'HIGH' } }],
  });
  const stub = (body) => {
    if (body.promotionCodes) return { status: 400, body: { code: 'PROMOTION_CODE_UNKNOWN' } };
    if (body.embed) return { status: 501, body: null };
    return { status: 200, body: { offers: [offerFor(body)] } };
  };

  test('phase 2 in order, the rest not reached, then combinations and all at once within the budget', async () => {
    const sent = [];
    const report = await o.discover({
      request: searchRequest(), version: '3.8.0', values: {}, invalidValues: 'random', seed: 4, travelDay: '2026-11-10',
      budget: 10, mandatory: { ok: true, message: '1 offer(s)' }, ignoredOf: () => [],
      send: async (b) => { sent.push(b); return stub(b); },
    });
    expect(report.used).toBe(10);
    expect(sent).toHaveLength(9);
    const tried = report.options.filter((r) => r.status);
    expect(tried).toHaveLength(5);
    expect(report.options.filter((r) => r.result === 'not-reached').length).toBeGreaterThan(0);
    expect(report.options.filter((r) => r.result === 'not-tested').map((r) => r.option)).toEqual(['tripSearchCriteria.vias', 'tripSearchCriteria.notVias']);
    expect(report.combinations).toHaveLength(3);
    expect(report.all.options.length).toBeGreaterThan(1);
  });

  test('no phase 4 with fewer than two supported options', async () => {
    const report = await o.discover({
      request: searchRequest(), version: '3.8.0', values: {}, seed: 4, travelDay: '2026-11-10', budget: 3,
      mandatory: { ok: true, message: '' }, ignoredOf: () => [], send: async (b) => stub(b),
    });
    expect(report.all).toBeNull();
    expect(o.reportLines(report).some((l) => /Phase 4 not run/.test(l))).toBe(true);
  });
});

describe('the Bruno glue', () => {
  let env;
  let checks;
  let logs;
  let answer;
  beforeEach(() => {
    env = {};
    checks = [];
    logs = [];
    answer = { status: 200, data: { offers: [{ offerId: 'O' }] } };
    global.bru = {
      getEnvVar: (k) => env[k],
      setEnvVar: (k, v) => { env[k] = v; },
      sendRequest: (req, cb) => {
        const body = JSON.parse(req.data);
        if (body.promotionCodes) cb({ response: { status: 400, data: JSON.stringify({ code: 'NOPE' }) } });
        else if (body.embed) cb(new Error('socket hang up'));
        else cb(null, answer);
      },
    };
    global.test = (name, fn) => { try { fn(); checks.push([name, 'pass']); } catch (e) { checks.push([name, `fail: ${e.message}`]); } };
    global.validationLogger = (line) => logs.push(line);
  });
  afterEach(() => { delete global.bru; delete global.test; delete global.validationLogger; });

  test('off: nothing changes', async () => {
    env.OfferCollectionRequest = JSON.stringify(searchRequest());
    o.prepareOptionDiscovery();
    expect(JSON.parse(env.OfferCollectionRequest)).toEqual(searchRequest());
    expect(await o.runOptionDiscovery(200, {})).toBe(false);
  });

  test('on: the mandatory request is sent, the options from the script, the report kept', async () => {
    Object.assign(env, {
      offerOptionDiscovery: 'true', OfferCollectionRequest: searchRequest(), osdmVersion: '3.8.0', api_base: 'https://x',
      access_token: 't', simulatorFaults: 'offer.price-below-parts', scenarioCode: 'S', offerOptionMaxRequests: '12', __travelDay: '2026-11-10',
    });
    o.prepareOptionDiscovery();
    expect(JSON.parse(env.OfferCollectionRequest)).toEqual(o.mandatoryRequest(searchRequest()));
    expect(await o.runOptionDiscovery(200, { offers: [{ offerId: 'O' }] })).toBe(true);
    expect(checks).toEqual([[expect.stringMatching(/mandatory parameters only/), 'pass']]);
    const report = JSON.parse(env.__offerOptionReport);
    expect(report.used).toBe(12);
    expect(report.seed).toBe(o.seedOf('S'));
    expect(logs.some((l) => /Phase 1/.test(l))).toBe(true);
    const promo = report.options.find((r) => r.option === 'promotionCodes');
    if (promo.status) expect(promo).toMatchObject({ status: 400, result: 'refused', message: 'NOPE' });
  });

  test('a refused mandatory request fails the one check; a request that cannot be sent is an error', async () => {
    Object.assign(env, { offerOptionDiscovery: 'true', __offerOptionFull: JSON.stringify(searchRequest()), osdmVersion: '3.8.0', offerOptionSeed: '9', offerOptionInvalidValues: 'skip', offerOptionValues: '{"embed":["ALL"]}' });
    answer = { statusCode: 200, body: { offers: [] } };
    await o.runOptionDiscovery(400, { code: 'MISSING_GENDER' });
    expect(checks[0][1]).toMatch(/^fail: HTTP 400.*MISSING_GENDER/);
    const report = JSON.parse(env.__offerOptionReport);
    expect(report.seed).toBe(9);
    expect(report.options.find((r) => r.option === 'promotionCodes').result).toBe('not-tested');
    expect(logs.some((l) => /could not be sent: socket hang up/.test(l))).toBe(true);
  });
});
