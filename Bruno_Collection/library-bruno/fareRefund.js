/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fareRefund.js — the refund of a booked fare (#907, fares phase 3).
 *
 * A fare sale whose scenario is a REFUND goes on from 07 to the refund steps
 * (10 → 11 → 12 → 13 → 14), as a product sale does. The refund steps run their
 * usual checks; this module adds what is particular to fares and keeps the
 * product booking checks away from a booking of fares:
 *
 *   R1  the refund offers cover the fare fulfilments asked              10  FAIL
 *   R2  refundableAmount + refundFee = the price of the fares refunded   10  FAIL
 *   R3  COMBINING: the fee is the one the fares' after-sales
 *       conditions give at the time of the refund offer                  10  WARNING
 *   R4  CLUSTERING, the fee the provider's (isProviderFee): the fee
 *       OSCAR sent (fareRefundFee) is the refund offer's fee              10  FAIL
 *   R5  after the confirmation, the fares and their fulfilment are
 *       REFUNDED, every other fulfilment unchanged                        14  FAIL
 *       (refunds.js checkRefundScopeOnBooking(), which reads fares too)
 *
 * Sources (#907): osdm.io, constructing products from fares, "Handling After
 * Sales": in the clustering model the distributor calculates the fee and,
 * when the fee belongs to the provider (isProviderFee: true), states it in
 * RefundSpecification.refundFee; in the combining model the fare gives the
 * fee. RefundSpecification.refundFee exists from OSDM 3.8.
 *
 * Request form for a full refund (#242 D6, provisional until OTST answers):
 * one RefundSpecification per fare fulfilment, holding only its fulfillmentId
 * and refundFee.
 *
 * Only the fare fulfilments are refunded, in full: a partial refund of fares
 * is not covered.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { expectedRefundForParts } = require('./afterSalesRules.js');
const { atLeast } = require('./osdmVersion.js');

const MAX_LISTED = 5;
const FEE_FROM_VERSION = '3.8';

function list(v) { return Array.isArray(v) ? v.filter((x) => x != null) : []; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function check(id, level, title, broken, explain) {
  const shown = broken.slice(0, MAX_LISTED).join('; ');
  const more = broken.length > MAX_LISTED ? ` and ${broken.length - MAX_LISTED} more` : '';
  return { id, level, title, ok: broken.length === 0, message: broken.length ? `${explain}: ${shown}${more}` : '' };
}

const info = (id, message) => ({ id, level: 'INFO', title: '', ok: true, message });
const warning = (id, title, message) => ({ id, level: 'WARNING', title, ok: false, message });

// What a fare needs for its refund: id, price, combination models, whose fee
// it is, after-sales conditions.
function fareSummary(fare) {
  const price = list(fare?.prices)[0] || null;
  return {
    id: fare?.id ?? null,
    price: isObject(price) ? { amount: price.amount, currency: price.currency, scale: price.scale ?? 2 } : null,
    models: list(fare?.combinationConstraint).map((c) => c?.model).filter((m) => typeof m === 'string'),
    // OSDM: isProviderFee defaults to true.
    isProviderFee: fare?.afterSalesCondition?.isProviderFee !== false,
    conditions: list(fare?.afterSalesCondition?.conditions),
  };
}

// #255: a fare reservation as a fare to refund: its price, no combination model (R3 and R4 then check nothing).
const reservationAsFare = (r) => ({ id: r.id, prices: isObject(r.price) ? [r.price] : [], afterSalesCondition: { conditions: list(r.afterSalesConditions) } });

/**
 * The fare fulfilments of a confirmed booking: [{ fulfillmentId, fares }], one
 * per fulfilment naming a booked fare or fare reservation (#255), each as
 * fareSummary() gives it.
 */
function fareFulfillmentsOf(booking) {
  const reservations = list(booking?.bookedOffers).flatMap((o) => list(o.reservations)).filter((r) => r.distributionMode === 'FARE_MODE').map(reservationAsFare);
  const fares = new Map([...list(booking?.bookedOffers).flatMap((o) => list(o.fares)), ...reservations].filter((f) => f.id != null).map((f) => [f.id, f]));
  return list(booking?.fulfillments)
    .map((f) => ({ fulfillmentId: f.id, fares: list(f.bookingParts).map((p) => fares.get(p?.id)).filter(Boolean).map(fareSummary) }))
    .filter((f) => f.fulfillmentId != null && f.fares.length > 0);
}

/**
 * The fee rule of a fulfilment's fares: COMBINING or CLUSTERING when all its
 * fares can be combined that way and none the other way, else OTHER.
 */
function feeRuleOf(fares) {
  const all = list(fares);
  if (all.length === 0) return 'OTHER';
  const has = (model) => all.every((f) => f.models.includes(model));
  const none = (model) => all.every((f) => !f.models.includes(model));
  if (has('COMBINING') && none('CLUSTERING')) return 'COMBINING';
  if (has('CLUSTERING') && none('COMBINING')) return 'CLUSTERING';
  return 'OTHER';
}

// A fare fee of the data file: a whole number of cents, else null.
function feeAmountOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The refund specifications that carry the fee OSCAR sets (R4), for the fare
 * fulfilments asked: one per CLUSTERING fulfilment whose fee is the
 * provider's, holding its fulfillmentId and refundFee (#242 D6, provisional).
 * `fee` is the scenario's fareRefundFee (cents, or null). Returns { specs,
 * sent: { fulfillmentId: amount }, notes: checks to record }.
 */
function feeSpecsFor(fulfillments, { fee, osdmVersion }) {
  const amount = feeAmountOf(fee);
  const out = { specs: [], sent: {}, notes: [] };
  const clustering = list(fulfillments).filter((f) => feeRuleOf(f.fares) === 'CLUSTERING');
  if (amount === null) {
    if (clustering.length > 0) {
      out.notes.push(info('R4', 'CLUSTERING: the distributor applies its own after-sales rules (osdm.io, constructing products from fares). The scenario sets no fare refund fee, so no refundFee is sent and the provider\'s fee is not checked.'));
    }
    return out;
  }
  if (!atLeast(osdmVersion, FEE_FROM_VERSION)) {
    out.notes.push(warning('R4', 'The fare refund fee is sent', `RefundSpecification.refundFee exists from OSDM ${FEE_FROM_VERSION}; this scenario is on ${osdmVersion || 'an unknown version'}, so the fee is not sent`));
    return out;
  }
  for (const f of list(fulfillments)) {
    const rule = feeRuleOf(f.fares);
    if (rule === 'COMBINING') {
      out.notes.push(warning('R4', 'The fare refund fee is sent', `fulfilment ${f.fulfillmentId}: its fares are combined by COMBINING, whose fee is the fares' own (osdm.io); the fee is not sent`));
    } else if (rule !== 'CLUSTERING') {
      out.notes.push(warning('R4', 'The fare refund fee is sent', `fulfilment ${f.fulfillmentId}: its fares are not all combined by CLUSTERING; the fee is not sent`));
    } else if (!f.fares.every((fare) => fare.isProviderFee)) {
      out.notes.push(warning('R4', 'The fare refund fee is sent', `fulfilment ${f.fulfillmentId}: a fare gives the fee to the distributor (isProviderFee: false), so the provider is not told it (osdm.io); the fee is not sent`));
    } else {
      const price = f.fares.find((fare) => fare.price)?.price || {};
      const refundFee = { currency: price.currency, amount, scale: price.scale ?? 2 };
      out.specs.push({ fulfillmentId: f.fulfillmentId, refundFee });
      out.sent[f.fulfillmentId] = refundFee;
    }
  }
  return out;
}

const fulfillmentIdsOf = (refundOffer) => list(refundOffer?.fulfillments).map((f) => f?.id).filter((id) => typeof id === 'string');
const amountOf = (price) => (isObject(price) && typeof price.amount === 'number' ? price.amount : null);
const text = (price) => (isObject(price) ? `${price.amount} ${price.currency ?? ''}`.trim() : 'none');

// A fare as afterSalesRules.js reads a part: its price and its conditions.
const asPart = (fare) => ({ price: fare.price, afterSalesConditions: fare.conditions });

// R2: what the refund offer gives back and keeps is what its fares cost.
function amountBroken(offer, fares) {
  const refundable = amountOf(offer.refundableAmount);
  const fee = amountOf(offer.refundFee);
  const prices = fares.map((f) => f.price).filter(Boolean);
  const cost = prices.reduce((sum, p) => sum + Number(p.amount), 0);
  const currencies = new Set([offer.refundableAmount?.currency, offer.refundFee?.currency, ...prices.map((p) => p.currency)].filter(Boolean));
  if (refundable === null || fee === null) return `refund offer ${offer.id}: refundableAmount or refundFee has no amount`;
  if (currencies.size > 1) return `refund offer ${offer.id}: currencies ${[...currencies].join(', ')}`;
  if (refundable + fee !== cost) return `refund offer ${offer.id}: refundable ${refundable} + fee ${fee} = ${refundable + fee}, its fares cost ${cost}`;
  return null;
}

// R3: the fee the fares' REFUND conditions give at `atMs`, or why it cannot be said.
function combiningFeeOf(fares, atMs) {
  const r = expectedRefundForParts(fares.map(asPart), atMs, 'REFUND');
  if (!r.ok && r.reason === 'no value-bearing parts') return { ok: true, fee: 0 };
  return r.ok ? { ok: true, fee: r.expectedFee, detail: r.detail.join('; ') } : { ok: false, reason: r.reason };
}

// R3 for one refund offer whose fares are all COMBINING: { combining } when
// its fee is not the fares', { note } when that cannot be worked out.
function combiningFinding(offer, known, nowMs) {
  if (!known.every((f) => feeRuleOf(f.fares) === 'COMBINING')) return {};
  const atMs = Date.parse(offer.createdOn);
  const expected = combiningFeeOf(known.flatMap((f) => f.fares), Number.isNaN(atMs) ? nowMs : atMs);
  if (!expected.ok) return { note: info('R3', `refund offer ${offer.id}: the fee of its COMBINING fares cannot be worked out (${expected.reason})`) };
  if (amountOf(offer.refundFee) === expected.fee) return {};
  const detail = expected.detail ? ` (${expected.detail})` : '';
  return { combining: `refund offer ${offer.id}: fee ${text(offer.refundFee)}, the fares' conditions give ${expected.fee}${detail}` };
}

// R4 for one refund offer: what is wrong with its fee against the fees sent
// for its fulfilments, or null (also when none was sent).
function feeFinding(offer, ids, sent) {
  const withFee = ids.filter((id) => sent[id]);
  if (withFee.length === 0) return null;
  if (withFee.length < ids.length) return `refund offer ${offer.id} holds fulfilments with and without a fee sent`;
  const expected = withFee.reduce((sum, id) => sum + sent[id].amount, 0);
  const currency = sent[withFee[0]].currency;
  const same = amountOf(offer.refundFee) === expected && (!currency || offer.refundFee?.currency === currency);
  return same ? null : `refund offer ${offer.id}: fee ${text(offer.refundFee)}, OSCAR sent ${expected} ${currency ?? ''}`.trim();
}

// R2, R3 and R4 for one refund offer, as texts (or a note); {} when it names
// no fare fulfilment.
function offerFindings(offer, byId, sent, nowMs) {
  const ids = fulfillmentIdsOf(offer);
  const known = ids.map((id) => byId.get(id)).filter(Boolean);
  if (known.length === 0) return {};
  if (known.length < ids.length) {
    return { note: info('R2', `refund offer ${offer.id} also names fulfilments without fares: its amounts are not compared with the fares`) };
  }
  return {
    amount: amountBroken(offer, known.flatMap((f) => f.fares)),
    ...combiningFinding(offer, known, nowMs),
    fee: feeFinding(offer, ids, sent),
  };
}

/**
 * The checks of the refund offers of a fare refund (step 10): R1 for the
 * fulfilments `asked`, then per refund offer R2, R3 (COMBINING) and R4 (a fee
 * sent). `fulfillments` is fareFulfillmentsOf() of the confirmed booking,
 * `sent` what feeSpecsFor() sent, `nowMs` the time when an offer gives none.
 */
function refundOfferChecks(refundOffers, fulfillments, { asked = [], sent = {}, nowMs = Date.now() } = {}) {
  const offers = list(refundOffers);
  const byId = new Map(list(fulfillments).map((f) => [f.fulfillmentId, f]));
  const covered = new Set(offers.flatMap(fulfillmentIdsOf));
  const findings = offers.map((offer) => offerFindings(offer, byId, sent, nowMs));
  const of = (key) => findings.map((f) => f[key]).filter(Boolean);
  const checks = [
    check('R1', 'FAIL', 'The refund offers cover every fare fulfilment asked',
      list(asked).filter((id) => byId.has(id) && !covered.has(id)).map((id) => `fulfilment ${id}`), 'fare fulfilments in no refund offer'),
    check('R2', 'FAIL', 'Each refund offer gives back and keeps what its fares cost (refundableAmount + refundFee)', of('amount'), 'amounts that do not add up to the fares\' price'),
  ];
  const combiningAsked = offers.some((o) => fulfillmentIdsOf(o).some((id) => byId.has(id) && feeRuleOf(byId.get(id).fares) === 'COMBINING'));
  if (combiningAsked) {
    // #1055: a fee the fares do not give is money, a failed check (maintainer, 2026-10-29).
    checks.push(check('R3', 'FAIL', 'COMBINING: each refund offer\'s fee is the one its fares\' after-sales conditions give (osdm.io: the distributor must obey the fares\' fees)', of('combining'), 'fees that are not the fares\''));
  }
  if (Object.keys(sent).length > 0) {
    checks.push(check('R4', 'FAIL', 'CLUSTERING: each refund offer\'s fee is the refundFee OSCAR sent (osdm.io: the provider uses the amount the client states)', of('fee'), 'fees other than the one sent'));
  }
  return [...checks, ...of('note')];
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readJson(name, fallback = null) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

const PARTIAL_FLAGS = ['partialRefundByLeg', 'partialRefundByPax', 'partialRefundByFulfillment'];

/**
 * Step 07, a confirmed fare sale: what the refund steps read (the fare
 * fulfilments, the fulfilment ids, the confirmed price) and the next step.
 * Returns the step to go to, or null when the scenario ends here.
 */
function prepareFareRefund(booking) {
  const fulfillments = list(booking?.fulfillments);
  const ids = fulfillments.map((f) => f?.id).filter(Boolean);
  bru.setEnvVar('__fareRefundFulfillments', JSON.stringify(fareFulfillmentsOf(booking)));
  bru.setEnvVar('fulfillmentIds', ids);
  bru.setEnvVar('__bookingFulfillmentIds', JSON.stringify(ids));
  const confirmed = amountOf(booking?.confirmedPrice);
  const sum = list(booking?.bookedOffers).flatMap((o) => list(o.fares)).reduce((total, f) => total + (amountOf(list(f.prices)[0]) ?? 0), 0);
  bru.setEnvVar('confirmedPriceAmount', confirmed ?? sum);
  const type = String(bru.getEnvVar('scenarioType') || '');
  if (type.includes('REFUND')) return '10. POST Refund Offers';
  if (type.includes('EXCHANGE')) validationLogger('[WARNING] [fares] The exchange of a fare is not covered (#907 leaves ExchangeOffer.fares out): this fare scenario ends after its confirmation.');
  return null;
}

/**
 * Step 10's before-request, for a fare sale: the refund offer request of the
 * fare fulfilments, with the fee the scenario sets when it is the provider's
 * (R4). True when it built the body (the step then skips its partial-refund
 * resolution).
 */
function prepareFareRefundRequest() {
  if (!require('./fares.js').isFareSale()) return false;
  const partial = PARTIAL_FLAGS.some((name) => String(bru.getEnvVar(name)) === 'true');
  bru.setEnvVar('__partialRefundDegradedToFull', partial ? 'true' : 'false');
  for (const name of ['__partialRefundResolvedSpec', '__partialRefundExpectedAmount', '__partialRefundExpectedPartIds', '__partialRefundScopeFulfillmentId']) bru.setEnvVar(name, '');
  if (partial) validationLogger('[WARNING] [fares] A partial refund of fares is not covered (#907): the fare fulfilments are refunded in full.');
  const { requestRefundOffersBody } = require('./requestsBuilder.js');
  requestRefundOffersBody(bru.getEnvVar('overruleCode'), bru.getEnvVar('refundDate') || null, null);
  const body = readJson('requestRefundOffersBodyData', {}) || {};
  const asked = new Set(list(body.fulfillmentIds));
  const fulfillments = list(readJson('__fareRefundFulfillments', [])).filter((f) => asked.has(f.fulfillmentId));
  const { specs, sent, notes } = feeSpecsFor(fulfillments, { fee: bru.getEnvVar('fareRefundFee'), osdmVersion: bru.getEnvVar('osdmVersion') });
  if (specs.length > 0) {
    body.refundSpecifications = specs;
    for (const s of specs) {
      validationLogger(`[INFO] [fares R4] refundFee ${s.refundFee.amount} ${s.refundFee.currency ?? ''} sent for fulfilment ${s.fulfillmentId}: CLUSTERING, the fee is the provider's (osdm.io, constructing products from fares). Request form: one RefundSpecification per fare fulfilment, holding its fulfillmentId and refundFee (provisional, #242 D6).`);
    }
  }
  require('./fareBooking.js').recordFareChecks(notes);
  bru.setEnvVar('requestRefundOffersBodyData', JSON.stringify(body));
  bru.setEnvVar('__fareRefundFeesSent', JSON.stringify(sent));
  validationLogger(`[INFO] [fares] Refund of the fare fulfilment(s) [${[...asked].join(', ')}] asked.`);
  return true;
}

/** Step 10's after-response, for a fare sale: R1–R4 on the refund offers. */
function checkFareRefundOffers(refundOffers) {
  if (!require('./fares.js').isFareSale()) return;
  const body = readJson('requestRefundOffersBodyData', {}) || {};
  require('./fareBooking.js').recordFareChecks(refundOfferChecks(refundOffers, readJson('__fareRefundFulfillments', []), {
    asked: list(body.fulfillmentIds), sent: readJson('__fareRefundFeesSent', {}) || {}, nowMs: Date.now(),
  }));
}

/**
 * Steps 12, 14 and 16, for a fare sale: the booking's fare checks instead of
 * the product ones. `stage` is 'confirmed' (12, 16) or 'refunded' (14). True
 * when it checked the booking.
 */
function checkFareBookingInRefund(body, stage) {
  if (!require('./fares.js').isFareSale()) return false;
  const fareBooking = require('./fareBooking.js');
  const booking = isObject(body?.booking) ? body.booking : body;
  fareBooking.recordFareChecks(fareBooking.bookingChecks(booking, readJson('offer'), stage));
  return true;
}

module.exports = {
  FEE_FROM_VERSION, fareSummary, fareFulfillmentsOf, feeRuleOf, feeAmountOf, feeSpecsFor, refundOfferChecks,
  prepareFareRefund, prepareFareRefundRequest, checkFareRefundOffers, checkFareBookingInRefund,
};
