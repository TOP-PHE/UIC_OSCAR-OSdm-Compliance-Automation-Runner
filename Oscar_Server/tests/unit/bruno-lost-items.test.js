// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-lost-items.test.js — #1266: the replacement of a lost ticket or card
 * (TICKET_LOST / CARD_LOST): library-bruno/lostItems.js, the card number in
 * requestedInformation, and the lost card in the booking request.
 */

const path = require('node:path');

const LIB = path.resolve(__dirname, '../../../Bruno_Collection/library-bruno');
const L = require(path.join(LIB, 'lostItems.js'));
const RI = require(path.join(LIB, 'requestedInformation.js'));

const CARD = { type: 'REDUCTION_CARD', code: 'SIM_CARD_25', number: 'SIM-CARD-0001' };
const HOLDER_RI = 'passengerSpecifications[ANY].detail.lastName AND passengerSpecifications[ANY].dateOfBirth';
const CARD_RI = 'passengerSpecifications[ANY].cards.number';
const offerOf = (tag, ri, fees) => ({
  offerId: 'O1',
  summary: 'Replacement',
  products: [{ id: 'P1', code: 'SIM_LOST', productTags: tag ? [tag] : undefined }],
  admissionOfferParts: [{ id: 'A1', requestedInformation: ri }],
  ...(fees ? { fees } : {}),
});
const fee = (amount, currency = 'CZK') => ({ id: `F${amount}`, price: { amount, currency, scale: 2 } });

function withBru(vars, fn) {
  const tests = [];
  const logs = [];
  global.bru = { getEnvVar: (k) => vars[k], setEnvVar: (k, v) => { vars[k] = v; } };
  global.test = (name, body) => {
    try { body(); tests.push([name, 'pass']); } catch (e) { tests.push([name, 'fail', e.message]); }
  };
  global.validationLogger = (m) => logs.push(m);
  try { return { result: fn(), tests, logs }; } finally {
    delete global.bru; delete global.test;
  }
}

describe('what is asked', () => {
  test('the lost kinds of a request: its tags and its selections\' tags, in OSDM\'s order', () => {
    expect(L.lostKindsOf({ offerSearchCriteria: { productTags: ['CARD_LOST', 'ADMISSION_PASS'] } })).toEqual(['CARD_LOST']);
    expect(L.lostKindsOf({ offerSearchCriteria: { productSelections: [{ productTag: 'TICKET_LOST' }, { productCode: 'X' }] } })).toEqual(['TICKET_LOST']);
    expect(L.lostKindsOf({ offerSearchCriteria: { productTags: ['CARD_LOST', 'TICKET_LOST'] } })).toEqual(['TICKET_LOST', 'CARD_LOST']);
    expect(L.lostKindsOf({ offerSearchCriteria: { productTags: ['ADMISSION_PASS'] } })).toEqual([]);
    expect(L.lostKindsOf(null)).toEqual([]);
  });

  test('the scenario\'s lost card: a number, perhaps a code and an issuer; nothing without a number', () => {
    expect(L.lostCardOf({ code: ' SIM_CARD_25 ', number: 'SIM-CARD-0001' })).toEqual(CARD);
    expect(L.lostCardOf({ number: 'N', issuer: 'urn:x:i' })).toEqual({ type: 'REDUCTION_CARD', number: 'N', issuer: 'urn:x:i' });
    expect(L.lostCardOf({ code: 'SIM_CARD_25' })).toBeNull();
    expect(L.lostCardOf({ code: 'SIM_CARD_25', number: '  ' })).toBeNull();
    expect(L.lostCardOf('SIM-CARD-0001')).toBeNull();
    expect(L.lostCardOf(null)).toBeNull();
  });

  test('the lost card goes among the first passenger\'s cards, in place of one of its code or number', () => {
    const specs = [{ externalRef: '1', cards: [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_25' }, { type: 'REDUCTION_CARD', code: 'OTHER' }] }, { externalRef: '2' }];
    const out = L.withLostCard(specs, CARD);
    expect(out[0].cards).toEqual([{ type: 'REDUCTION_CARD', code: 'OTHER' }, CARD]);
    expect(out[1]).toBe(specs[1]);
    expect(specs[0].cards).toHaveLength(2);
    expect(L.withLostCard([{ externalRef: '1' }], CARD)[0].cards).toEqual([CARD]);
    expect(L.withLostCard(specs, null)).toBe(specs);
    expect(L.withLostCard([], CARD)).toEqual([]);
  });
});

describe('the replacement offer', () => {
  test('a card replacement asking for the card\'s number: nothing to say', () => {
    expect(L.replacementChecks(offerOf('CARD_LOST', CARD_RI), ['CARD_LOST'], CARD).filter((c) => !c.ok)).toEqual([]);
  });

  test('a ticket replacement asking for the holder: nothing to say; asking for an e-mail only: a WARNING', () => {
    expect(L.replacementChecks(offerOf('TICKET_LOST', HOLDER_RI), ['TICKET_LOST'], null).filter((c) => !c.ok)).toEqual([]);
    const email = L.replacementChecks(offerOf('TICKET_LOST', 'passengerSpecifications[0].detail.contact.email'), ['TICKET_LOST'], null);
    expect(email.filter((c) => !c.ok).map((c) => [c.level, c.name])).toEqual([
      ['warn', '🔑 Lost ticket: the replacement offer asks for the data of the lost ticket (requestedInformation)'],
    ]);
  });

  test('an offer asking for nothing is a WARNING, never a failure', () => {
    const checks = L.replacementChecks(offerOf('CARD_LOST', undefined), ['CARD_LOST'], CARD);
    expect(checks.filter((c) => !c.ok)).toHaveLength(1);
    expect(checks[0].level).toBe('warn');
    expect(checks[0].message).toMatch(/cards\.number/);
  });

  test('a card replacement for a scenario naming no lost card fails one check', () => {
    const failed = L.replacementChecks(offerOf('CARD_LOST', CARD_RI), ['CARD_LOST'], null).filter((c) => !c.ok && c.level !== 'warn');
    expect(failed.map((c) => c.name)).toEqual(['🔑 Lost card: the scenario names the card to replace (lostCard: its number, and its code)']);
    // A ticket needs no card.
    expect(L.replacementChecks(offerOf('TICKET_LOST', HOLDER_RI), ['TICKET_LOST'], null).every((c) => c.ok || c.level === 'warn')).toBe(true);
  });

  test('the kind is the lost tag the chosen offer carries, else the first asked', () => {
    expect(L.kindOfOffer(offerOf('CARD_LOST'), ['TICKET_LOST', 'CARD_LOST'])).toBe('CARD_LOST');
    expect(L.kindOfOffer(offerOf(null), ['TICKET_LOST', 'CARD_LOST'])).toBe('TICKET_LOST');
    expect(L.kindOfOffer(offerOf(null), [])).toBeNull();
    expect(L.replacementChecks(offerOf(null), [], null)).toEqual([]);
  });

  test('the fees: none, a total in one currency, or a count when the currencies differ', () => {
    expect(L.feesOf(offerOf('TICKET_LOST'))).toBeNull();
    expect(L.feesOf(offerOf('TICKET_LOST', HOLDER_RI, [fee(12000), fee(500)]))).toEqual({ count: 2, amount: 12500, currency: 'CZK', scale: 2 });
    expect(L.feesOf(offerOf('TICKET_LOST', HOLDER_RI, [fee(12000), fee(500, 'EUR')])).amount).toBeNull();
  });
});

describe('in Bruno', () => {
  const request = (tag) => JSON.stringify({ offerSearchCriteria: { productTags: [tag] } });

  test('step 01: the replacement said with its fee; a card replacement asking nothing warned', () => {
    const r = withBru({
      OfferCollectionRequest: request('CARD_LOST'),
      offer: JSON.stringify(offerOf('CARD_LOST', undefined, [fee(12000)])),
      __lostCard: JSON.stringify(CARD),
    }, () => L.recordReplacementChecks(global.test));
    expect(r.tests).toEqual([]);
    expect(r.logs[0]).toBe('[INFO] 🔑 Replacement of a lost card (CARD_LOST): Replacement; fee 120.00 CZK (1 fee(s)).');
    expect(r.logs[1]).toMatch(/^\[WARNING\] 🔑 Lost card: the replacement offer asks for the data of the lost card/);
  });

  test('step 01: a card replacement without lostCard fails its check; a request without a lost tag does nothing', () => {
    const r = withBru({ OfferCollectionRequest: request('CARD_LOST'), offer: JSON.stringify(offerOf('CARD_LOST', CARD_RI)) },
      () => L.recordReplacementChecks(global.test));
    expect(r.tests.map((t) => t[1])).toEqual(['fail']);
    expect(r.logs[0]).toMatch(/no fee\.$/);
    const none = withBru({ OfferCollectionRequest: request('ADMISSION_PASS'), offer: JSON.stringify(offerOf(null)) },
      () => L.recordReplacementChecks(global.test));
    expect(none.tests).toEqual([]);
    expect(none.logs).toEqual([]);
  });

  test('step 02: an unknown card refused with a Problem passes; booked, it fails; not armed, nothing', () => {
    const vars = { lostCardExpectRejection: 'true', __lostCard: JSON.stringify({ ...CARD, number: 'SIM-CARD-9999' }) };
    const refused = withBru({ ...vars }, () => L.checkLostCardRefused(400, { code: 'LOST_CARD_NOT_FOUND', title: 'Lost card not found' }));
    expect(refused.result).toBe(true);
    expect(refused.tests.map((t) => t[1])).toEqual(['pass', 'pass']);
    expect(refused.logs[0]).toMatch(/SIM-CARD-9999/);
    const booked = withBru({ ...vars }, () => L.checkLostCardRefused(200, { booking: {} }));
    expect(booked.tests.map((t) => t[1])).toEqual(['fail']);
    expect(withBru({ lostCardExpectRejection: 'false' }, () => L.checkLostCardRefused(400, {})).result).toBe(false);
  });
});

describe('requestedInformation: a card\'s number (#1266)', () => {
  const run = (specs) => {
    const asserts = [];
    const logs = [];
    RI.processRequestedInformation({
      expr: CARD_RI,
      tag: 'admissionOfferParts[0]',
      additional: [{}],
      specs,
      passengerCount: 1,
      assert: (name, ok, msg) => asserts.push([name, ok, msg]),
      log: (level, msg) => logs.push(`[${level}] ${msg}`),
    });
    return { asserts, logs };
  };

  test('read as the scenario\'s lostCard, a known attribute', () => {
    const leaves = RI.summariseRequestedInformation(CARD_RI).leaves;
    expect(leaves.map((l) => [l.fieldLabel, l.scenarioField])).toEqual([['card number', 'lostCard']]);
    expect(RI.staticIssues(RI.parseRequestedInformation(CARD_RI).ast, 1).unknownPaths).toEqual([]);
  });

  test('met by a card with a number among the passenger\'s cards', () => {
    const { asserts, logs } = run([{ externalRef: '1', type: 'PERSON', cards: [CARD] }]);
    expect(asserts.every((a) => a[1])).toBe(true);
    expect(logs.some((l) => l.includes('already satisfied'))).toBe(true);
    expect(logs.some((l) => l.startsWith('[WARNING]'))).toBe(false);
  });

  test('a card without its number does not meet it: a WARNING naming lostCard, no failed check', () => {
    const { asserts, logs } = run([{ externalRef: '1', type: 'PERSON', cards: [{ type: 'REDUCTION_CARD', code: 'SIM_CARD_25' }] }]);
    expect(asserts.every((a) => a[1])).toBe(true);
    expect(logs.filter((l) => l.startsWith('[WARNING]'))).toEqual([
      "[WARNING] admissionOfferParts[0]: the provider asks for a card number for passenger 0; set the scenario's lostCard (the card to replace) — booking/confirmation may be rejected.",
    ]);
  });

  test('the other fields are read as before', () => {
    const model = { passengerSpecifications: [{ detail: { lastName: 'Example' }, dateOfBirth: '1990-01-15', cards: [] }] };
    expect(RI.evaluateRequestedInformation(RI.parseRequestedInformation(HOLDER_RI).ast, model).satisfied).toBe(true);
    const none = { passengerSpecifications: [{ detail: {}, cards: [] }] };
    expect(RI.evaluateRequestedInformation(RI.parseRequestedInformation(HOLDER_RI).ast, none).satisfied).toBe(false);
  });
});

describe('the Test Config fields', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/scenarios.js'), 'utf8');
  function loadFunction(name, context) {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  }
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  test('drawn with the scenario\'s card, and the probe beside them', () => {
    const state = { scenarios: [{ lostCard: { number: 'N<1>', code: 'SIM_CARD_25' } }, {}] };
    const select = [];
    const fields = loadFunction('buildLostCardFields', {
      state, esc, ENUMS: { lostCardExpectRejection: ['off', 'on'] },
      buildSelect: (...a) => { select.push(a.slice(0, 3)); return '<select>'; },
    });
    const html = fields(0);
    expect(html).toContain('data-action="set-scenario-lost-card" data-idx="0" data-part="number"');
    expect(html).toContain('value="N&lt;1>"');
    expect(html).toContain('value="SIM_CARD_25"');
    expect(fields(1)).toContain('value=""');
    expect(select[0]).toEqual([0, 'lostCardExpectRejection', 'Unknown lost card refused']);
    expect(source).toContain('${buildLostCardFields(idx)}');
    expect(source).toMatch(/const INPUT_GROUPS = \[[^\]]*\n {2}inputLostCard,\n/);
  });

  test('typing sets one part; emptying the last leaves no card', () => {
    const withPart = loadFunction('withLostCardPart', { Object, Array, String });
    expect(withPart(undefined, 'number', ' N1 ')).toEqual({ number: 'N1' });
    expect(withPart({ number: 'N1' }, 'code', 'C')).toEqual({ number: 'N1', code: 'C' });
    expect(withPart({ number: 'N1', code: 'C' }, 'number', '')).toEqual({ code: 'C' });
    expect(withPart({ code: 'C' }, 'code', '  ')).toBeNull();
    expect(withPart({ number: 'N1' }, 'other', 'x')).toEqual({ number: 'N1' });
  });

  test('the input handler stores the card on the scenario, or removes it', () => {
    const state = { scenarios: [{ lostCard: { number: 'N1' } }] };
    let dirty = 0;
    const withLostCardPart = loadFunction('withLostCardPart', { Object, Array, String });
    const input = loadFunction('inputLostCard', { state, withLostCardPart, markDirty: () => { dirty++; }, Number });
    const el = (part, value) => ({ value, dataset: { idx: '0', part } });
    expect(input('set-scenario-text', el('number', 'x'))).toBe(false);
    expect(input('set-scenario-lost-card', el('code', 'SIM_CARD_25'))).toBe(true);
    expect(state.scenarios[0].lostCard).toEqual({ number: 'N1', code: 'SIM_CARD_25' });
    input('set-scenario-lost-card', el('number', ''));
    input('set-scenario-lost-card', el('code', ''));
    expect(state.scenarios[0]).not.toHaveProperty('lostCard');
    expect(dirty).toBe(3);
  });
});

describe('the booking request', () => {
  const base = {
    requiresPlaceSelection: 'false',
    accommodationSelection: 'NONE',
    api_base: 'https://x',
    bookingPassengerSpecifications: '[{"externalRef":"00001","detail":{"firstName":"Alex","lastName":"Example"}}]',
    bookingPassengerReferences: '["00001"]',
    bookingPurchaserSpecifications: JSON.stringify({ detail: { firstName: 'P', lastName: 'Q' } }),
    offerId: 'OFFER-1',
  };
  function build(vars) {
    const store = { ...base, ...vars };
    global.bru = { getEnvVar: (k) => store[k], setEnvVar: (k, v) => { store[k] = v; } };
    global.validationLogger = () => {};
    jest.isolateModules(() => require(path.join(LIB, 'requestsBuilder.js')).buildBookingRequest());
    delete global.bru;
    return JSON.parse(store.BookingRequest);
  }

  test('the scenario\'s lost card goes in the first passenger\'s cards', () => {
    expect(build({ __lostCard: JSON.stringify(CARD) }).passengerSpecifications[0].cards).toEqual([CARD]);
  });

  test('without a lost card the passengers are as before', () => {
    expect(build({}).passengerSpecifications[0]).not.toHaveProperty('cards');
  });
});
