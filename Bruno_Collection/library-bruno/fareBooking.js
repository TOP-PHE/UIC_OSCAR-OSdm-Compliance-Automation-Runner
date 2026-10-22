/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fareBooking.js — booking and fulfilment of a fare (#906, fares phase 2).
 *
 * A fare scenario whose offer step failed no fare check books the fare offer
 * it chose (step 01 sets `__fareSale`). The booking is the ordinary one
 * (OSDM `OfferSelection`, by offer id); the fulfilment is a confirmation that
 * returns a fulfilment id, without a ticket: the distributor builds the ticket
 * (osdm.io, constructing products from fares). A fare sale goes 02 → 05 → 06
 * → 06b → 07 and runs these checks instead of the product ones:
 *
 *   B1  the booking holds fares                                02 05 07  FAIL
 *   B2  every offered fare has its booked fare (by content)    02 05 07  FAIL
 *   B3  booked fares keep the members OSDM requires            02 05 07  FAIL
 *   B4  a booked fare's price is the offered fare's            02 05     FAIL
 *   B5  provisionalPrice is the sum of the fare prices            05     WARNING
 *   B6  fare status PREBOOKED, then CONFIRMED / FULFILLED         05 07  FAIL / WARNING
 *   F1  a fare fulfilment is CONFIRMED or FULFILLED            06 06b 07 FAIL
 *   F2  no document, control number, issuer, continuous-service
 *       usage or links on a fare fulfilment                    06 06b 07 WARNING
 *   F3  a fare fulfilment names the parts it covers            06 06b 07 FAIL
 *   F4  no fulfilment holds both fares and product parts       06 06b 07 FAIL
 *   F5  every booked fare is in a fulfilment                          07 FAIL
 *   F6  the fulfilment-step attributes are the offer's                07 WARNING
 *
 * Sources and levels are in #906 and #242 (D3 for F2). The refund of a fare is
 * #907: until then a fare sale ends after 07.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { sameStopPlace } = require('./returnJourney.js');
const { missingFareMembers, isFareSale } = require('./fares.js');

// OSDM processes: the fulfilment statuses of fares after a confirmation.
const FARE_FULFILLMENT_STATUSES = ['CONFIRMED', 'FULFILLED'];
// What OSDM's processes page says a fare fulfilment does not include.
const NOT_ON_A_FARE_FULFILLMENT = [
  ['fulfillmentDocuments', (v) => list(v).length > 0],
  ['fulfillmentDocumentRefs', (v) => list(v).length > 0],
  ['controlNumber', (v) => v != null && v !== ''],
  ['issuer', (v) => v != null && v !== ''],
  ['continuousServiceUsage', (v) => v != null],
  ['_links', (v) => (Array.isArray(v) ? v.length > 0 : isObject(v) && Object.keys(v).length > 0)],
];
const MAX_LISTED = 5;

function list(v) { return Array.isArray(v) ? v.filter((x) => x != null) : []; }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function check(id, level, title, broken, explain) {
  const shown = broken.slice(0, MAX_LISTED).join('; ');
  const more = broken.length > MAX_LISTED ? ` and ${broken.length - MAX_LISTED} more` : '';
  return { id, level, title, ok: broken.length === 0, message: broken.length ? `${explain}: ${shown}${more}` : '' };
}

// Text of a value with its keys sorted, to compare two of them.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The fares a booking holds, each with its path. */
function bookedFaresOf(booking) {
  return list(booking?.bookedOffers).flatMap((offer, i) => list(offer.fares).map((fare, j) => ({ fare, path: `bookedOffers[${i}].fares[${j}]` })));
}

/** The ids of a booking's product parts: admissions, reservations, ancillaries. */
function productPartIdsOf(booking) {
  return list(booking?.bookedOffers)
    .flatMap((offer) => [...list(offer.admissions), ...list(offer.reservations), ...list(offer.ancillaries)])
    .map((part) => part.id).filter(Boolean);
}

// The offer's references of the passengers a booked fare names: the booking
// names its passengers by id, the offer by external reference.
function passengerKeysOf(fare, booking) {
  const externalRefOf = new Map(list(booking?.passengers).map((p) => [p.id, p.externalRef]));
  return list(fare?.passengerRefs).map((ref) => String(externalRefOf.get(ref) ?? ref)).sort();
}

const priceText = (fare) => { const p = list(fare?.prices)[0]; return p ? `${p.amount} ${p.currency}` : ''; };
const placeOf = (place) => place?.stopPlaceRef || place?.id || null;
function sameSection(a, b) {
  const [s1, e1, s2, e2] = [a?.coveredSection?.startPlace, a?.coveredSection?.endPlace, b?.coveredSection?.startPlace, b?.coveredSection?.endPlace].map(placeOf);
  return Boolean(s1 && e1) && sameStopPlace(s1, s2) && sameStopPlace(e1, e2);
}

/**
 * The offered fares paired with the booked ones by content, never by position
 * (#550's rule): a booked fare stands for an offered one when it has its id or
 * names the same passengers; among those, the id counts most, then the
 * passengers, the section covered and the price. Ties go to the fare whose
 * text sorts first, so any order of either list gives the same pairs.
 */
function pairFares(offeredFares, booking) {
  const booked = bookedFaresOf(booking).map((b) => ({ ...b, text: canonical(b.fare) })).sort((a, b) => a.text.localeCompare(b.text));
  const offered = list(offeredFares).map((fare, index) => ({ fare, index, text: canonical(fare) })).sort((a, b) => a.text.localeCompare(b.text));
  const used = new Set();
  const pairs = [];
  const missing = [];
  for (const o of offered) {
    const offeredKeys = list(o.fare.passengerRefs).map(String).sort().join('|');
    let best = null;
    let bestScore = 0;
    for (const b of booked) {
      if (used.has(b)) continue;
      const sameId = o.fare.id != null && b.fare.id === o.fare.id;
      const samePassengers = offeredKeys !== '' && passengerKeysOf(b.fare, booking).join('|') === offeredKeys;
      if (!sameId && !samePassengers) continue;
      const score = (sameId ? 8 : 0) + (samePassengers ? 4 : 0) + (sameSection(o.fare, b.fare) ? 2 : 0) + (priceText(o.fare) === priceText(b.fare) ? 1 : 0);
      if (score > bestScore) { best = b; bestScore = score; }
    }
    if (best) {
      used.add(best);
      pairs.push({ offered: o.fare, booked: best.fare, path: best.path });
    } else {
      missing.push(o);
    }
  }
  return { pairs, missing };
}

// B5: the provisional price, when the booking states one.
function provisionalPriceCheck(booking, booked) {
  const price = booking?.provisionalPrice;
  if (!isObject(price) || price.amount == null) {
    return { id: 'B5', level: 'INFO', title: 'Provisional price', ok: true, message: 'the booking states no provisionalPrice' };
  }
  const prices = booked.map(({ fare }) => list(fare.prices)[0]).filter(Boolean);
  const sum = prices.reduce((total, p) => total + Number(p.amount), 0);
  const differs = prices.some((p) => p.currency !== price.currency) || sum !== Number(price.amount);
  return check('B5', 'WARNING', 'provisionalPrice is the sum of the booked fares\' prices', differs ? [`${price.amount} ${price.currency}, the fares add up to ${sum} ${prices[0]?.currency ?? ''}`.trim()] : [],
    'the provisional price is not the sum of the fares (OSDM does not say it must be)');
}

// B6: each booked fare's status; Fare.status is not required, so none stated is a warning.
function statusChecks(booked, stage) {
  const expected = stage === 'confirmed' ? FARE_FULFILLMENT_STATUSES : ['PREBOOKED'];
  return [
    check('B6', 'FAIL', `Each booked fare's status is ${expected.join(' or ')}`,
      booked.filter(({ fare }) => fare.status != null && !expected.includes(fare.status)).map(({ fare, path }) => `${path}.status = ${JSON.stringify(fare.status)}`),
      'fares in another status'),
    check('B6', 'WARNING', 'Each booked fare states its status',
      booked.filter(({ fare }) => fare.status == null).map(({ path }) => path), 'no status (OSDM does not require it)'),
  ];
}

/**
 * The checks of a booking of fares against the fare offer booked. `stage` is
 * 'booked' (02's answer), 'prebooked' (05) or 'confirmed' (07).
 * Each check: { id, level: FAIL | WARNING | INFO, title, ok, message }.
 */
function bookingChecks(booking, offer, stage) {
  const booked = bookedFaresOf(booking);
  const first = check('B1', 'FAIL', 'The booking holds the fares booked (bookedOffers[].fares)', booked.length ? [] : ['no booked offer holds a fare'],
    'the booking of a fare offer holds no fare');
  if (booked.length === 0) return [first];
  const { pairs, missing } = pairFares(offer?.fares, booking);
  const checks = [
    first,
    check('B2', 'FAIL', 'Every fare of the offer is in the booking (paired by id, else passengers, section and price)',
      missing.map((m) => `offered fare ${m.fare.id ?? `[${m.index}]`}`), 'fares of the offer missing from the booking'),
    check('B3', 'FAIL', 'Each booked fare has the members OSDM requires (Fare.required, passengerRefs)',
      booked.map(({ fare, path }) => ({ path, missing: missingFareMembers(fare) })).filter((x) => x.missing.length).map((x) => `${x.path} lacks ${x.missing.join(', ')}`),
      'members missing or empty'),
  ];
  if (stage !== 'confirmed') {
    checks.push(check('B4', 'FAIL', 'Each booked fare\'s price is the offered fare\'s',
      pairs.filter((p) => priceText(p.offered) !== priceText(p.booked)).map((p) => `${p.path}: ${priceText(p.booked) || 'none'}, offered ${priceText(p.offered) || 'none'}`),
      'prices that differ from the offer'));
  }
  if (stage === 'prebooked') checks.push(provisionalPriceCheck(booking, booked));
  if (stage !== 'booked') checks.push(...statusChecks(booked, stage));
  return checks;
}

/**
 * The checks of the fulfilments of a fare sale (06, 06b, 07). `fareIds` and
 * `productIds` are the booking's part ids; a fulfilment that names a fare, or
 * names no part, is a fare fulfilment (every fulfilment, when no fare id is
 * known). `documents` are the documents the answer carries beside the
 * fulfilments.
 */
function fulfillmentChecks(fulfillments, { fareIds = [], productIds = [], documents = [] } = {}) {
  const all = list(fulfillments);
  const fares = new Set(list(fareIds));
  const products = new Set(list(productIds));
  const named = (f) => list(f.bookingParts).map((p) => p.id).filter(Boolean);
  // A fulfilment that names no part cannot be told apart: in a booking of fares it is taken as one of them.
  const ofFares = all.filter((f) => fares.size === 0 || named(f).length === 0 || named(f).some((id) => fares.has(id)));
  const at = (f) => `fulfillment ${f.id ?? '?'}`;
  return [
    check('F1', 'FAIL', `Each fare fulfilment is ${FARE_FULFILLMENT_STATUSES.join(' or ')}`,
      ofFares.filter((f) => !FARE_FULFILLMENT_STATUSES.includes(f.status)).map((f) => `${at(f)} is ${JSON.stringify(f.status)}`),
      'fulfilments in another status'),
    ...NOT_ON_A_FARE_FULFILLMENT.map(([member, present]) => check('F2', 'WARNING',
      `A fare fulfilment carries no ${member} (OSDM processes: a fare fulfilment does not include it; #242 D3)`,
      ofFares.filter((f) => present(f[member])).map(at), `${member} present`)),
    check('F2', 'WARNING', 'No document comes with the fare fulfilments (the distributor builds the ticket)',
      ofFares.length > 0 && list(documents).length > 0 ? [`${list(documents).length} document(s)`] : [], 'documents in the answer'),
    check('F3', 'FAIL', 'Each fare fulfilment names the booking parts it covers (Fulfillment.bookingParts)',
      ofFares.flatMap((f) => {
        const ids = named(f);
        if (ids.length === 0) return [`${at(f)} names none`];
        if (fares.size + products.size === 0) return [];
        return ids.filter((id) => !fares.has(id) && !products.has(id)).map((id) => `${at(f)} names ${id}, which is no part of the booking`);
      }),
      'booking parts not named, or unknown'),
    check('F4', 'FAIL', 'No fulfilment holds both fares and product booking parts (OSDM processes)',
      all.filter((f) => named(f).some((id) => fares.has(id)) && named(f).some((id) => products.has(id))).map(at),
      'fulfilments mixing fares and products'),
  ];
}

// F6: what the distributor needs for the ticket, kept as the offer gave it.
function attributesCheck(booking, offer) {
  const { pairs } = pairFares(offer?.fares, booking);
  const changed = pairs.flatMap((p) => ['regionalConstraint', 'travelValidityConstraint', 'passengerConstraints']
    .filter((member) => p.offered[member] !== undefined && canonical(p.offered[member]) !== canonical(p.booked[member]))
    .map((member) => `${p.path}.${member}`));
  return check('F6', 'WARNING', 'The attributes the ticket needs are the offer\'s (regional constraint, travel validity, passenger constraints)',
    changed, 'attributes that differ from the offer (osdm.io, constructing products from fares: fulfilment step)');
}

/** The checks of the confirmed booking (07): B1–B3, B6, F1–F4 on its fulfilments, F5, F6. */
function confirmedBookingChecks(booking, offer) {
  const booked = bookedFaresOf(booking);
  const fulfillments = list(booking?.fulfillments);
  const inFulfillments = new Set(fulfillments.flatMap((f) => list(f.bookingParts).map((p) => p.id)));
  return [
    ...bookingChecks(booking, offer, 'confirmed'),
    ...fulfillmentChecks(fulfillments, { fareIds: booked.map(({ fare }) => fare.id), productIds: productPartIdsOf(booking), documents: booking?.fulfillmentDocuments }),
    check('F5', 'FAIL', 'The booking lists its fulfilments, and every booked fare is in one (bookingParts)',
      fulfillments.length === 0 ? ['the booking lists no fulfilment'] : booked.filter(({ fare }) => !inFulfillments.has(fare.id)).map(({ fare, path }) => `${path} (${fare.id})`),
      'fares in no fulfilment'),
    attributesCheck(booking, offer),
  ];
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readJson(name, fallback = null) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

/** Records checks of this module: a FAIL is a test, a WARNING a log line when broken, INFO a log line. */
function recordFareChecks(checks) {
  for (const c of checks) {
    if (c.level === 'FAIL') test(`[fares ${c.id}] ${c.title}`, () => { if (!c.ok) throw new Error(c.message); });
    else if (c.level === 'WARNING') { if (!c.ok) validationLogger(`[WARNING] [fares ${c.id}] ${c.title} — ${c.message}`); }
    else validationLogger(`[INFO] [fares ${c.id}] ${c.message}`);
  }
}

function keepPartIds(booking) {
  bru.setEnvVar('__fareIds', JSON.stringify(bookedFaresOf(booking).map(({ fare }) => fare.id).filter(Boolean)));
  bru.setEnvVar('__fareProductIds', JSON.stringify(productPartIdsOf(booking)));
}

const bookingOf = (body) => (isObject(body?.booking) ? body.booking : body);

/** Step 02's after-response, for a fare sale: true when it handled the answer (and routed to 05). */
function checkFareBookingStep(status, body) {
  if (!isFareSale()) return false;
  test(`HTTP response status — expected 200, actual: ${status}`, () => {
    if (status !== 200) throw new Error(`HTTP ${status} received, expected 200 — the booking of the fare offer was refused`);
  });
  const booking = body?.booking;
  if (status !== 200 || !isObject(booking)) {
    if (status === 200) test('[fares] The answer holds the booking', () => { throw new Error('no booking in the answer'); });
    require('./loopback.js').loopbackOrStop('POST Create Booking (fare sale)');
    return true;
  }
  bru.setEnvVar('bookingId', booking.id);
  recordFareChecks(bookingChecks(booking, readJson('offer'), 'booked'));
  keepPartIds(booking);
  validationLogger(`[INFO] [fares] Fare offer ${bru.getEnvVar('offerId')} booked: booking ${booking.id}. Next: the booking read, then its confirmation.`);
  bru.runner.setNextRequest('05. GET Booking before Fulfillments');
  return true;
}

/** Step 05's after-response, for a fare sale: true when it checked the booking (05 then goes on to 06). */
function checkFarePrebookedStep(body) {
  if (!isFareSale()) return false;
  const booking = bookingOf(body);
  recordFareChecks(bookingChecks(booking, readJson('offer'), 'prebooked'));
  keepPartIds(booking);
  return true;
}

/** Step 06's after-response, for a fare sale: true when it checked the fulfilments. */
function checkFareFulfillmentStep(body) {
  if (!isFareSale()) return false;
  const fulfillments = list(body?.fulfillments);
  test('[fares F1] The confirmation gives the fare fulfilment (fulfillments)', () => {
    if (fulfillments.length === 0) throw new Error('POST /fulfillments gave no fulfilment');
  });
  recordFareChecks(fulfillmentChecks(fulfillments, { fareIds: readJson('__fareIds', []), productIds: readJson('__fareProductIds', []), documents: body?.fulfillmentDocuments }));
  return true;
}

/** Step 06b, for a fare sale: the checks of one fulfilment read (GET /fulfillments/{id}). */
function fulfillmentReadChecks(body, id) {
  const fulfillment = body?.fulfillment;
  const same = check('F1', 'FAIL', 'GET /fulfillments/{id} gives the fulfilment asked', isObject(fulfillment) && fulfillment.id === id ? [] : [`asked ${id}, got ${isObject(fulfillment) ? fulfillment.id : 'none'}`],
    'another fulfilment, or none');
  if (!isObject(fulfillment)) return [same];
  return [same, ...fulfillmentChecks([fulfillment], { fareIds: readJson('__fareIds', []), productIds: readJson('__fareProductIds', []), documents: body?.fulfillmentDocuments })];
}

/** Step 07's after-response, for a fare sale: checks the confirmed booking, then ends the scenario. */
function checkFareConfirmedStep(body) {
  if (!isFareSale()) return false;
  const booking = bookingOf(body);
  recordFareChecks(confirmedBookingChecks(booking, readJson('offer')));
  // For the refund of phase 3 (#907): the booked fares are the parts to refund.
  bru.setEnvVar('admissionReservationAncillaryBookingPartsIds', bookedFaresOf(booking).map(({ fare }) => fare.id).filter(Boolean));
  if (/REFUND|EXCHANGE/.test(String(bru.getEnvVar('scenarioType') || ''))) {
    validationLogger('[WARNING] [fares] The refund or exchange of a fare comes with #907: this fare scenario ends after its confirmation.');
  } else {
    validationLogger('[INFO] [fares] Fare sale complete: booked and confirmed.');
  }
  const scenarios = readJson('__scenariosList', []) || [];
  const next = Number.parseInt(bru.getEnvVar('scenariosToRunIndex') || '0', 10);
  if (scenarios.length > 0 && next < scenarios.length) {
    bru.setEnvVar('__loopback', 'true');
    bru.runner.setNextRequest('01. POST Get Offer');
  } else {
    bru.runner.stopExecution();
  }
  return true;
}

module.exports = {
  FARE_FULFILLMENT_STATUSES, bookedFaresOf, productPartIdsOf, pairFares, bookingChecks, fulfillmentChecks, confirmedBookingChecks,
  recordFareChecks, checkFareBookingStep, checkFarePrebookedStep, checkFareFulfillmentStep, fulfillmentReadChecks, checkFareConfirmedStep,
};
