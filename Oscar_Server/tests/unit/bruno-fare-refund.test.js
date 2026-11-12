'use strict';

/**
 * bruno-fare-refund.test.js — the refund of a booked fare (#907).
 *
 * The refunds come from the OSDM simulator's own modules (gamma, OSDM 3.8):
 * its CLUSTERING and COMBINING fare refunds pass every check, and each of its
 * two wrong fare refunds breaks exactly the check it is made for. Hand-made
 * answers cover the other rules.
 */

const fs = require('fs');
const path = require('path');
const fareRefund = require('../../../Bruno_Collection/library-bruno/fareRefund.js');
const fareBooking = require('../../../Bruno_Collection/library-bruno/fareBooking.js');
const fares = require('../../../Bruno_Collection/library-bruno/fares.js');
const { buildOfferCollection } = require('../../../OSDM_Simulator/src/osdm/offers');
const { createBooking, confirmBooking } = require('../../../OSDM_Simulator/src/osdm/bookings');
const { createRefundOffers, confirmRefundOffer } = require('../../../OSDM_Simulator/src/osdm/refunds');
const { loadProviders } = require('../../../OSDM_Simulator/src/config');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

const ROOT = path.join(__dirname, '..', '..', '..');
const gamma = loadProviders(path.join(ROOT, 'OSDM_Simulator', 'providers')).get('gamma');
const NOW = Date.parse('2026-11-02T09:00:00Z');
const station = (code) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${code}` });
const ADULT = { externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' };

// A fare sale on the simulator, confirmed: the offer of `cluster` (or the
// first), its confirmed booking and the fare fulfilments as 07 keeps them.
function sale({ start = '0000001', cluster = null, lastName = 'Example' } = {}) {
  const request = {
    tripSpecifications: [{ isPartOfInternationalTrip: true, legs: [{ timedLeg: {
      start: { stopPlaceRef: station('0000001'), serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+01:00' } },
      end: { stopPlaceRef: station('0000002'), serviceArrival: { timetabledTime: '2026-11-20T11:00:00+01:00' } },
      service: { vehicleNumbers: ['1001'] },
    } }] }],
    requestedSections: [{ startPlace: station(start), endPlace: station('0000002') }],
    offerSearchCriteria: { requestedOfferParts: ['FARE_ADMISSION'] },
    anonymousPassengerSpecifications: [ADULT],
  };
  const { response, remembered } = buildOfferCollection(request, gamma, NOW);
  const offer = fares.chooseFareOffer(response, cluster);
  const known = new Map(remembered.map((entry) => [entry.offer.offerId, entry]));
  const booking = createBooking({
    offers: [{ offerId: offer.offerId, passengerRefs: offer.passengerRefs }],
    passengerSpecifications: [{ ...ADULT, detail: { firstName: 'Sam', lastName } }],
  }, (id) => known.get(id), gamma, NOW);
  confirmBooking(booking, gamma, NOW + 1000);
  return { offer, booking, kept: fareRefund.fareFulfillmentsOf(structuredClone(booking)) };
}

// The refund offers the simulator answers to the request OSCAR builds.
function refund(s, { fee = null } = {}) {
  const ids = s.booking.fulfillments.map((f) => f.id);
  const { specs, sent } = fareRefund.feeSpecsFor(s.kept, { fee, osdmVersion: '3.8.0' });
  const body = { fulfillmentIds: ids, ...(specs.length ? { refundSpecifications: specs } : {}) };
  const offers = structuredClone(createRefundOffers(s.booking, body, gamma, NOW + 2000));
  return { offers, checks: fareRefund.refundOfferChecks(offers, s.kept, { asked: ids, sent, nowMs: NOW }) };
}

const failing = (checks) => checks.filter((c) => !c.ok).map((c) => `${c.id} ${c.level}`).sort();
const ids = (checks) => checks.map((c) => `${c.id} ${c.level}`).sort();

describe('the fare refund on the simulator\'s answers', () => {
  test('a CLUSTERING fare refunded by its own conditions passes R1 and R2; no fee is checked', () => {
    const s = sale({ cluster: 'SEMI_FLEX' });
    const { offers, checks } = refund(s);
    expect(offers).toHaveLength(1);
    expect(offers[0].refundFee.amount).toBe(Math.round(s.offer.fares[0].prices[0].amount * 0.25));
    expect(ids(checks)).toEqual(['R1 FAIL', 'R2 FAIL']);
    expect(failing(checks)).toEqual([]);
  });

  test('the fee OSCAR states for a CLUSTERING fare is taken (R4); the variant that ignores it fails R4 only', () => {
    const s = sale({ cluster: 'FULL_FLEX' });
    const stated = refund(s, { fee: 250 });
    expect(stated.offers[0].refundFee.amount).toBe(250);
    expect(ids(stated.checks)).toEqual(['R1 FAIL', 'R2 FAIL', 'R4 FAIL']);
    expect(failing(stated.checks)).toEqual([]);
    const ignored = refund(sale({ cluster: 'FULL_FLEX', lastName: 'Simvariant-Fare-Ignores-Refund-Fee' }), { fee: 250 });
    expect(failing(ignored.checks)).toEqual(['R4 FAIL']);
  });

  test('COMBINING fares give their fee by date (R3); the variant taking the other window fails R3 (#1055)', () => {
    const s = sale({ start: '0000087' });
    expect(fareRefund.feeRuleOf(s.kept[0].fares)).toBe('COMBINING');
    const right = refund(s);
    expect(right.offers[0].refundFee.amount).toBe(Math.round(s.offer.fares[0].prices[0].amount / 10));
    expect(ids(right.checks)).toEqual(['R1 FAIL', 'R2 FAIL', 'R3 FAIL']);
    expect(failing(right.checks)).toEqual([]);
    const wrong = refund(sale({ start: '0000087', lastName: 'Simvariant-Fare-Wrong-Combining-Fee' }));
    expect(failing(wrong.checks)).toEqual(['R3 FAIL']);
    // A fee stated for COMBINING fares is not sent.
    const { specs, notes } = fareRefund.feeSpecsFor(s.kept, { fee: 250, osdmVersion: '3.8.0' });
    expect(specs).toEqual([]);
    expect(failing(notes)).toEqual(['R4 WARNING']);
  });

  test('after the confirmation the fare and its fulfilment are REFUNDED, and the scope check says so (R5)', () => {
    const s = sale({ cluster: 'SEMI_FLEX' });
    const { offers } = refund(s);
    confirmRefundOffer(s.booking, offers[0].id, { status: 'CONFIRMED' }, gamma, NOW + 3000);
    const booking = structuredClone(s.booking);
    expect(booking.bookedOffers[0].fares.map((f) => f.status)).toEqual(['REFUNDED']);
    expect(booking.fulfillments.map((f) => f.status)).toEqual(['REFUNDED']);
    // refunds.js records through testCapture.js, which keeps the checks in bru.setVar('__rptTests').
    const env = { __refundedFulfillmentIds: JSON.stringify(booking.fulfillments.map((f) => f.id)) };
    const vars = {};
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; }, getVar: (k) => vars[k], setVar: (k, v) => { vars[k] = v; } };
    global.validationLogger = () => {};
    // testCapture.js also hands each check to Bruno's own test(), here Jest's.
    const realTest = global.test;
    global.test = () => {};
    try {
      withBrunoExpect(() => require('../../../Bruno_Collection/library-bruno/refunds.js').checkRefundScopeOnBooking(booking));
    } finally {
      global.test = realTest;
      delete global.bru;
      delete global.validationLogger;
    }
    const recorded = JSON.parse(vars.__rptTests || '[]');
    expect(recorded.map((r) => r.name)).toEqual([
      `Fulfillment ${booking.fulfillments[0].id} is REFUNDED (held by the confirmed refund offer) - status: REFUNDED`,
      `Booked fare ${booking.bookedOffers[0].fares[0].id} is REFUNDED - status: REFUNDED`,
    ]);
    expect(recorded.every((r) => r.passed)).toBe(true);
  });
});

describe('the fee OSCAR states (R4)', () => {
  const fulfillment = (fares) => ({ fulfillmentId: 'F1', fares });
  const fare = (models, isProviderFee = true) => ({ id: 'X', price: { amount: 1000, currency: 'EUR', scale: 2 }, models, isProviderFee, conditions: [] });

  test('the fee rule of a fulfilment\'s fares', () => {
    expect(fareRefund.feeRuleOf([fare(['CLUSTERING'])])).toBe('CLUSTERING');
    expect(fareRefund.feeRuleOf([fare(['COMBINING']), fare(['COMBINING', 'SEPARATE_TICKET'])])).toBe('COMBINING');
    expect(fareRefund.feeRuleOf([fare(['CLUSTERING']), fare(['COMBINING'])])).toBe('OTHER');
    expect(fareRefund.feeRuleOf([fare(['SEPARATE_TICKET'])])).toBe('OTHER');
    expect(fareRefund.feeRuleOf([])).toBe('OTHER');
  });

  test('a fee is a whole number of cents', () => {
    expect([250, '250', 0, '2.5', -1, '', null, undefined, 'x'].map(fareRefund.feeAmountOf)).toEqual([250, 250, 0, null, null, null, null, null, null]);
  });

  test('sent for CLUSTERING fares whose fee is the provider\'s, from OSDM 3.8, in the fares\' currency', () => {
    const out = fareRefund.feeSpecsFor([fulfillment([fare(['CLUSTERING'])])], { fee: '250', osdmVersion: '3.8.0' });
    expect(out.specs).toEqual([{ fulfillmentId: 'F1', refundFee: { currency: 'EUR', amount: 250, scale: 2 } }]);
    expect(out.sent).toEqual({ F1: { currency: 'EUR', amount: 250, scale: 2 } });
    expect(out.notes).toEqual([]);
    expect(fareRefund.feeSpecsFor([fulfillment([fare(['CLUSTERING'])])], { fee: 250, osdmVersion: '3.9.0' }).specs).toHaveLength(1);
  });

  test('not sent otherwise, each time with the reason', () => {
    const notSent = (fs2, version = '3.8.0') => {
      const out = fareRefund.feeSpecsFor(fs2, { fee: 250, osdmVersion: version });
      expect(out.specs).toEqual([]);
      return out.notes.map((n) => `${n.id} ${n.level}: ${n.message}`);
    };
    expect(notSent([fulfillment([fare(['CLUSTERING'])])], '3.7.0')).toEqual([expect.stringMatching(/^R4 WARNING: .*from OSDM 3\.8/)]);
    expect(notSent([fulfillment([fare(['CLUSTERING'], false)])])).toEqual([expect.stringMatching(/isProviderFee: false/)]);
    expect(notSent([fulfillment([fare(['COMBINING'])])])).toEqual([expect.stringMatching(/COMBINING/)]);
    expect(notSent([fulfillment([fare(['SEPARATE_TICKET'])])])).toEqual([expect.stringMatching(/not all combined by CLUSTERING/)]);
    // No fee set: a CLUSTERING refund says that its fee is not checked.
    const none = fareRefund.feeSpecsFor([fulfillment([fare(['CLUSTERING'])])], { fee: null, osdmVersion: '3.8.0' });
    expect(none.notes.map((n) => n.level)).toEqual(['INFO']);
    expect(fareRefund.feeSpecsFor([fulfillment([fare(['COMBINING'])])], { fee: null, osdmVersion: '3.8.0' }).notes).toEqual([]);
  });
});

describe('the refund offers on hand-made answers', () => {
  const price = (amount, currency = 'EUR') => ({ amount, currency, scale: 2 });
  const kept = [
    { fulfillmentId: 'F1', fares: [{ id: 'A', price: price(1000), models: ['CLUSTERING'], isProviderFee: true, conditions: [] }] },
    { fulfillmentId: 'F2', fares: [{ id: 'B', price: price(600), models: ['COMBINING'], isProviderFee: true, conditions: [{ condition: 'REFUND', afterSaleFee: price(60) }] }] },
  ];
  const offer = (id, fulfillmentIds, refundable, fee, extra = {}) => ({
    id, createdOn: '2026-11-02T09:00:00Z', fulfillments: fulfillmentIds.map((f) => ({ id: f })), refundableAmount: price(refundable), refundFee: price(fee), ...extra,
  });

  test('R1: a fare fulfilment asked and in no refund offer fails', () => {
    const checks = fareRefund.refundOfferChecks([offer('O1', ['F1'], 1000, 0)], kept, { asked: ['F1', 'F2'] });
    expect(failing(checks)).toEqual(['R1 FAIL']);
    expect(checks.find((c) => c.id === 'R1').message).toContain('F2');
  });

  test('R2: refundable + fee must be the fares\' price, in one currency', () => {
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 900, 50)], kept, { asked: ['F1'] }))).toEqual(['R2 FAIL']);
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 950, 50, { refundFee: price(50, 'CHF') })], kept, { asked: ['F1'] }))).toEqual(['R2 FAIL']);
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 950, 50, { refundableAmount: {} })], kept, { asked: ['F1'] }))).toEqual(['R2 FAIL']);
    // One offer for both fulfilments: the fares add up.
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1', 'F2'], 1540, 60)], kept, { asked: ['F1', 'F2'] }))).toEqual([]);
  });

  test('R3: a COMBINING fee other than the fares\' fails (#1055); a fee that cannot be worked out is an INFO line', () => {
    expect(failing(fareRefund.refundOfferChecks([offer('O2', ['F2'], 540, 60)], kept, { asked: ['F2'] }))).toEqual([]);
    expect(failing(fareRefund.refundOfferChecks([offer('O2', ['F2'], 600, 0)], kept, { asked: ['F2'] }))).toEqual(['R3 FAIL']);
    const noConditions = [{ ...kept[1], fares: [{ ...kept[1].fares[0], conditions: [] }] }];
    const checks = fareRefund.refundOfferChecks([offer('O2', ['F2'], 540, 60)], noConditions, { asked: ['F2'] });
    expect(checks.filter((c) => c.level === 'INFO').map((c) => c.id)).toEqual(['R3']);
    // Free fares keep nothing.
    const free = [{ ...kept[1], fares: [{ ...kept[1].fares[0], price: price(0) }] }];
    expect(failing(fareRefund.refundOfferChecks([offer('O2', ['F2'], 0, 0)], free, { asked: ['F2'] }))).toEqual([]);
  });

  test('R4: the fee must be the one sent, for every fulfilment of the offer', () => {
    const sent = { F1: { currency: 'EUR', amount: 250, scale: 2 } };
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 750, 250)], kept, { asked: ['F1'], sent }))).toEqual([]);
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 1000, 0)], kept, { asked: ['F1'], sent }))).toEqual(['R4 FAIL']);
    expect(failing(fareRefund.refundOfferChecks([offer('O1', ['F1'], 750, 250, { refundFee: price(250, 'CHF'), refundableAmount: price(750, 'CHF') })], kept, { asked: ['F1'], sent })))
      .toEqual(['R2 FAIL', 'R4 FAIL']);
    const mixed = fareRefund.refundOfferChecks([offer('O1', ['F1', 'F2'], 1290, 250)], kept, { asked: ['F1', 'F2'], sent });
    expect(mixed.find((c) => c.id === 'R4').message).toContain('with and without a fee sent');
  });

  test('an offer that also names fulfilments without fares is not compared with the fares', () => {
    const checks = fareRefund.refundOfferChecks([offer('O1', ['F1', 'P9'], 5, 5)], kept, { asked: ['F1'] });
    expect(failing(checks)).toEqual([]);
    expect(checks.filter((c) => c.level === 'INFO').map((c) => c.id)).toEqual(['R2']);
  });

  test('the fare fulfilments of a booking, each fare as the refund needs it', () => {
    const booking = {
      bookedOffers: [{ fares: [{ id: 'A', prices: [price(1000)], combinationConstraint: [{ model: 'CLUSTERING' }], afterSalesCondition: { conditions: [{ condition: 'REFUND' }] } }], admissions: [{ id: 'P' }] }],
      fulfillments: [{ id: 'F1', bookingParts: [{ id: 'A' }] }, { id: 'F9', bookingParts: [{ id: 'P' }] }],
    };
    expect(fareRefund.fareFulfillmentsOf(booking)).toEqual([{ fulfillmentId: 'F1', fares: [{ id: 'A', price: price(1000), models: ['CLUSTERING'], isProviderFee: true, conditions: [{ condition: 'REFUND' }] }] }]);
  });
});

describe('the Bruno glue', () => {
  const env = {};
  const recorded = [];
  const logged = [];
  let next = null;
  let stopped = false;
  const realTest = test;
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    recorded.length = 0;
    logged.length = 0;
    next = null;
    stopped = false;
    global.bru = {
      getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; },
      runner: { setNextRequest: (n) => { next = n; }, stopExecution: () => { stopped = true; } },
    };
    global.test = (name, fn) => { try { fn(); recorded.push(`${name}: ok`); } catch (e) { recorded.push(`${name}: ${e.message}`); } };
    global.validationLogger = (line) => logged.push(line);
  });
  afterAll(() => { delete global.bru; delete global.validationLogger; global.test = realTest; });

  realTest('07: a fare REFUND scenario goes on to 10 with what the refund steps read; an exchange ends', () => {
    const s = sale({ cluster: 'SEMI_FLEX' });
    Object.assign(env, { __fareSale: 'true', offer: s.offer, scenarioType: 'REFUND' });
    expect(fareBooking.checkFareConfirmedStep({ booking: structuredClone(s.booking) })).toBe(true);
    expect(next).toBe('10. POST Refund Offers');
    expect(stopped).toBe(false);
    expect(env.fulfillmentIds).toEqual(s.booking.fulfillments.map((f) => f.id));
    expect(JSON.parse(env.__bookingFulfillmentIds)).toEqual(env.fulfillmentIds);
    expect(env.confirmedPriceAmount).toBe(s.booking.confirmedPrice.amount);
    expect(JSON.parse(env.__fareRefundFulfillments)).toEqual(s.kept);
    next = null;
    env.scenarioType = 'EXCHANGE';
    fareBooking.checkFareConfirmedStep({ booking: structuredClone(s.booking) });
    expect(next).toBeNull();
    expect(stopped).toBe(true);
    expect(logged.some((l) => l.startsWith('[WARNING] [fares] The exchange of a fare is not covered'))).toBe(true);
  });

  realTest('10: the request of a fare refund, with the fee stated when it is the provider\'s; a partial refund is warned and made full', () => {
    expect(fareRefund.prepareFareRefundRequest()).toBe(false);
    const s = sale({ cluster: 'FULL_FLEX' });
    Object.assign(env, {
      __fareSale: 'true', fulfillmentIds: s.booking.fulfillments.map((f) => f.id), __fareRefundFulfillments: JSON.stringify(s.kept),
      fareRefundFee: '250', osdmVersion: '3.8.0', partialRefundByPax: 'true',
    });
    expect(fareRefund.prepareFareRefundRequest()).toBe(true);
    const body = JSON.parse(env.requestRefundOffersBodyData);
    const fulfillmentId = s.booking.fulfillments[0].id;
    expect(body).toEqual({ fulfillmentIds: [fulfillmentId], refundSpecifications: [{ fulfillmentId, refundFee: { currency: 'CZK', amount: 250, scale: 2 } }] });
    expect(JSON.parse(env.__fareRefundFeesSent)).toEqual({ [fulfillmentId]: { currency: 'CZK', amount: 250, scale: 2 } });
    expect(env.__partialRefundDegradedToFull).toBe('true');
    expect(env.__partialRefundScopeFulfillmentId).toBe('');
    expect(logged.some((l) => l.startsWith('[WARNING] [fares] A partial refund of fares is not covered'))).toBe(true);
    expect(logged.some((l) => l.includes('provisional, #242 D6'))).toBe(true);
    // 10's after-response: the simulator's refund offers pass R1, R2, R4.
    const offers = structuredClone(createRefundOffers(s.booking, body, gamma, NOW + 2000));
    fareRefund.checkFareRefundOffers(offers);
    expect(recorded.filter((r) => r.startsWith('[fares R'))).toHaveLength(3);
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
  });

  realTest('12, 14 and 16 check a booking of fares with the fare checks only; any other booking is left to the product checks', () => {
    expect(fareRefund.checkFareBookingInRefund({}, 'confirmed')).toBe(false);
    const s = sale({ cluster: 'SEMI_FLEX' });
    Object.assign(env, { __fareSale: 'true', offer: s.offer });
    expect(fareRefund.checkFareBookingInRefund({ booking: structuredClone(s.booking) }, 'confirmed')).toBe(true);
    expect(recorded.map((r) => r.slice(0, 9)).sort()).toEqual(['[fares B1', '[fares B2', '[fares B3', '[fares B6']);
    recorded.length = 0;
    const { offers } = refund(s);
    confirmRefundOffer(s.booking, offers[0].id, { status: 'CONFIRMED' }, gamma, NOW + 3000);
    expect(fareRefund.checkFareBookingInRefund({ booking: structuredClone(s.booking) }, 'refunded')).toBe(true);
    expect(recorded.map((r) => r.slice(0, 9)).sort()).toEqual(['[fares B1', '[fares B2', '[fares B3']);
    expect(recorded.every((r) => r.endsWith(': ok'))).toBe(true);
  });

  realTest('the parser reads the fee as a whole number of cents', () => {
    expect(fares.fareFieldsOf({ fareRefundFee: 250 }).fareRefundFee).toBe(250);
    expect(fares.fareFieldsOf({ fareRefundFee: '1.5' }).fareRefundFee).toBeNull();
    expect(fares.fareFieldsOf({}).fareRefundFee).toBeNull();
  });
});

describe('the wiring', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const step = (name) => read(`Bruno_Collection/03-Refund/${name}`);

  test('10 builds a fare refund\'s request before the partial-refund resolution, and checks its offers after the overrule total', () => {
    const ten = step('10. POST Refund Offers.yml');
    const at = ten.indexOf('fareRefund.js").prepareFareRefundRequest()) return;');
    expect(at).toBeGreaterThan(ten.indexOf('logStepStart(req)'));
    expect(at).toBeLessThan(ten.indexOf('const _byLeg ='));
    const checks = ten.indexOf('fareRefund.js").checkFareRefundOffers(jsonData.refundOffers);');
    expect(checks).toBeGreaterThan(ten.indexOf('checkOverruleTotal(jsonData.refundOffers)'));
  });

  test('12, 14 and 16 keep the product checks away from a booking of fares', () => {
    for (const [name, stage] of [['12. GET Booking before Patch Refund.yml', 'confirmed'], ['14. GET Booking after Patch Refund.yml', 'refunded'], ['16. GET Booking after Delete Refund.yml', 'refunded']]) {
      const text = step(name);
      const guard = text.indexOf(`checkFareBookingInRefund(jsonData, "${stage}")) {`);
      expect(guard).toBeGreaterThan(text.indexOf('jsonObjectOrStop(jsonData'));
      expect(guard).toBeLessThan(text.indexOf('postCreateBookingResponse('));
    }
    expect(step('16. GET Booking after Delete Refund.yml')).toContain('checkFareBookingInRefund(jsonData, "confirmed")) {');
    expect(read('Bruno_Collection/library-bruno/refunds.js')).toContain('["admissions", "reservations", "ancillaries", "fares"].forEach((kind) => {');
  });

  test('both reset lists clear the fare refund', () => {
    for (const file of ['Bruno_Collection/opencollection.yml', 'Bruno_Collection/library-bruno/scenarioParser.js']) {
      expect(read(file)).toContain('"__fareProductIds", "fareRefundFee", "__fareRefundFulfillments", "__fareRefundFeesSent"');
    }
  });
});

describe('the Test Config field (#907)', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'Oscar_Server/public/js/scenarios.js'), 'utf8');
  function loadFunction(name, context) {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  }
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  test('drawn on a REFUND scenario only, with the fee stored', () => {
    const state = { scenarios: [{ scenarioType: 'REFUND', fareRefundFee: 250 }, { scenarioType: 'SALE' }, { scenarioType: 'REFUND' }] };
    const field = loadFunction('fareRefundFeeField', { state, esc, String });
    expect(field(0)).toContain('data-action="set-scenario-fare-refund-fee" data-idx="0"');
    expect(field(0)).toContain('value="250"');
    expect(field(0)).toContain('Fare refund fee (cents)');
    expect(field(1)).toBe('');
    expect(field(2)).toContain('value=""');
    expect(source).toContain('${fareRefundFeeField(idx)}');
  });

  test('typing keeps a whole number of cents, clears on empty, ignores the rest', () => {
    const set = [];
    const input = loadFunction('inputFareRefundFee', { setScenarioField: (...a) => set.push(a), Number });
    const el = (value) => ({ value, dataset: { idx: '3' } });
    expect(input('set-scenario-section', el('1'))).toBe(false);
    for (const v of ['250', ' 0 ', '', '2.5', '-1', 'abc', '10000001']) expect(input('set-scenario-fare-refund-fee', el(v))).toBe(true);
    expect(set).toEqual([[3, 'fareRefundFee', 250], [3, 'fareRefundFee', 0], [3, 'fareRefundFee', null]]);
  });
});
