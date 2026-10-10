/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * returnJourney.js — the return journey, in the two OSDM models (#594).
 *
 * Both models make two POST /offers calls: the outbound search, then the
 * inbound one. They differ in what the second call names and gets back:
 *
 *   SEPARATE  (model A) returnSearchParameters.outwardOfferIds = the chosen
 *             outbound offer → inbound offers; both offers are booked.
 *   COMBINED  (model B, OSDM 3.7 and later) returnSearchParameters
 *             .outboundTripIds = the chosen outbound trip → offers covering
 *             both trips (Offer.tripCoverage + Offer.inboundTripCoverage);
 *             that one offer is booked.
 *
 * The date of the inbound journey goes with the first call: in
 * OfferSearchCriteria.inboundDate from OSDM 3.7, in the deprecated
 * returnSearchParameters.inwardReturnDate before.
 *
 * Pure module: no Bruno globals, unit-tested in
 * Oscar_Server/tests/unit/bruno-return-journey.test.js.
 */

const { atLeast } = require('./osdmVersion.js');

const RETURN_MODELS = ['SEPARATE', 'COMBINED'];
// What a scenario may expect of the fulfillments of a return. Absent = no check.
const RETURN_FULFILLMENTS = ['ONE', 'PER_DIRECTION', 'PER_PASSENGER'];

const normaliseReturnModel = (value) => (RETURN_MODELS.includes(value) ? value : 'SEPARATE');
const normaliseReturnFulfillments = (value) => (RETURN_FULFILLMENTS.includes(value) ? value : null);

// inboundDate exists, and inwardReturnDate is deprecated, from OSDM 3.7.
const returnUsesInboundDate = (version) => atLeast(version, '3.7.0');
// outboundTripIds and Offer.inboundTripCoverage exist from OSDM 3.7.
const combinedReturnDefined = (version) => atLeast(version, '3.7.0');

// "2026-11-22T17:00:00+01:00" → "2026-11-22T17:00:00": the inboundDate pattern
// is a local date-time, like the search's departureTime.
function localDateTime(value) {
  const text = String(value || '');
  return text.length > 19 ? text.slice(0, 19) : text;
}

/**
 * The body of the second (inbound) POST /offers call.
 *
 * @param {object} o
 * @param {string} o.model              'SEPARATE' | 'COMBINED'
 * @param {object} o.outboundCriteria   the first call's tripSearchCriteria
 * @param {string} o.inboundDateTime    when the inbound journey leaves
 * @param {string} [o.outboundOfferId]  SEPARATE: the chosen outbound offer
 * @param {string} [o.outboundOfferTag] SEPARATE, before 3.7: its tag
 * @param {string} [o.outboundTripId]   COMBINED: the chosen outbound trip
 * @param {string} o.version            the scenario's OSDM version
 * @returns {{ body: object|null, reason: string|null }} reason when no body can be built
 */
function buildInboundOfferRequest(o) {
  const outbound = o.outboundCriteria || {};
  if (!o.inboundDateTime) return { body: null, reason: 'no inbound date: not a return scenario' };
  if (!outbound.origin || !outbound.destination) return { body: null, reason: 'the outbound search has no origin or destination' };
  const params = {};
  if (o.model === 'COMBINED') {
    if (!o.outboundTripId) return { body: null, reason: 'the chosen outbound offer names no trip (tripCoverage.coveredTripId)' };
    params.outboundTripIds = [o.outboundTripId];
  } else {
    if (!o.outboundOfferId) return { body: null, reason: 'no outbound offer was chosen' };
    params.outwardOfferIds = [o.outboundOfferId];
    if (o.outboundOfferTag && !returnUsesInboundDate(o.version)) params.outwardOfferTag = o.outboundOfferTag;
  }
  const tripSearchCriteria = {
    departureTime: o.inboundDateTime,
    origin: outbound.destination,
    destination: outbound.origin,
    returnSearchParameters: params,
  };
  return { body: { tripSearchCriteria }, reason: null };
}

const stopOf = (place) => (place && typeof place === 'object' ? place.stopPlaceRef || null : null);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * The checks of the inbound offer response.
 *
 * @param {object} response            the OfferCollectionResponse of the second call
 * @param {object} ctx
 * @param {string} ctx.model           'SEPARATE' | 'COMBINED'
 * @param {object} ctx.outboundCriteria the first call's tripSearchCriteria
 * @param {string} [ctx.outboundTripId] the trip of the chosen outbound offer
 * @param {string[]} ctx.passengerRefs the externalRefs of the first call
 * @returns {Array<{name: string, ok: boolean, message?: string, level: 'fail'|'warn'|'info'}>}
 */
function checkReturnOffers(response, ctx) {
  const out = [];
  const add = (name, ok, message, level = 'fail') => out.push({ name, ok, message: ok ? undefined : message, level });
  const trips = Array.isArray(response?.trips) ? response.trips : [];
  const offers = Array.isArray(response?.offers) ? response.offers : [];
  const tripIds = trips.map((t) => t?.id).filter(Boolean);
  checkTripBack(trips, ctx, add);
  checkSamePassengers(response, ctx, add);
  if (ctx.model === 'COMBINED') checkCombinedOffers(offers, tripIds, ctx, add);
  else checkSeparateOffers(offers, tripIds, ctx, add);
  return out;
}

// A trip of the answer runs back, and each inbound trip that states a
// direction says IN_BOUND (a warning: Trip.direction is optional).
function checkTripBack(trips, ctx, add) {
  const from = stopOf(ctx.outboundCriteria?.destination);
  const to = stopOf(ctx.outboundCriteria?.origin);
  const inbound = trips.filter((t) => t?.id !== ctx.outboundTripId);
  add(`Return: a trip goes back, from ${from} to ${to}`,
    inbound.some((t) => stopOf(t.origin) === from && stopOf(t.destination) === to),
    `no trip of the inbound response runs from ${from} to ${to}; trips: ${trips.map((t) => `${stopOf(t?.origin)}→${stopOf(t?.destination)}`).join(', ') || 'none'}`);
  for (const t of inbound) {
    if (t?.direction != null && t.direction !== 'IN_BOUND') {
      add(`Return: trip ${t.id} of the inbound search is IN_BOUND`, false,
        `direction is ${t.direction}; Trip.direction is optional, so this is a warning`, 'warn');
    }
  }
}

// The answer's passengers, when it lists them, are those of the outbound call.
function checkSamePassengers(response, ctx, add) {
  const listed = response?.anonymousPassengerSpecifications;
  const asked = Array.isArray(ctx.passengerRefs) ? ctx.passengerRefs : [];
  if (!Array.isArray(listed) || asked.length === 0) return;
  const answered = listed.map((p) => p?.externalRef).filter(Boolean);
  add('Return: the passengers are those of the outbound search', sameSet(answered, asked),
    `outbound [${asked.join(', ')}], inbound [${answered.join(', ')}]`);
}

// Both directions: each offer covers the chosen outbound trip and an inbound
// trip of the answer.
function checkCombinedOffers(offers, tripIds, ctx, add) {
  offers.forEach((offer, i) => {
    const label = `Return offer ${i + 1} (${offer?.offerId})`;
    add(`${label} covers the chosen outbound trip (tripCoverage.coveredTripId)`,
      offer?.tripCoverage?.coveredTripId === ctx.outboundTripId,
      `expected ${ctx.outboundTripId}, actual ${offer?.tripCoverage?.coveredTripId}`);
    const back = offer?.inboundTripCoverage?.coveredTripId;
    add(`${label} covers an inbound trip of the response (inboundTripCoverage.coveredTripId)`,
      !!back && back !== ctx.outboundTripId && tripIds.includes(back),
      back ? `${back} is ${back === ctx.outboundTripId ? 'the outbound trip' : 'not a trip of the response'}` : 'inboundTripCoverage is missing: the offer does not cover both directions');
  });
}

// Separate directions: an inbound offer that names its trip names an inbound
// one, never the outbound trip.
function checkSeparateOffers(offers, tripIds, ctx, add) {
  offers.forEach((offer, i) => {
    const covered = offer?.tripCoverage?.coveredTripId;
    if (covered == null) return;
    add(`Inbound offer ${i + 1} (${offer?.offerId}) covers an inbound trip, not the outbound one`,
      covered !== ctx.outboundTripId && tripIds.includes(covered),
      `tripCoverage.coveredTripId ${covered} is ${covered === ctx.outboundTripId ? 'the outbound trip' : 'not a trip of the response'}`);
  });
}

/**
 * The check of the number of fulfillments of a confirmed return, or null when
 * the scenario states no expectation.
 *
 * @param {Array}  fulfillments
 * @param {string|null} expected 'ONE' | 'PER_DIRECTION' | 'PER_PASSENGER' | null
 * @param {number} passengerCount
 */
function checkReturnFulfillmentCount(fulfillments, expected, passengerCount) {
  const want = { ONE: 1, PER_DIRECTION: 2, PER_PASSENGER: passengerCount }[normaliseReturnFulfillments(expected)];
  if (want == null) return null;
  const actual = Array.isArray(fulfillments) ? fulfillments.length : 0;
  return {
    name: `Return: ${want} fulfillment(s) as the scenario expects (${expected}) — actual: ${actual}`,
    ok: actual === want,
    message: `expected ${want} (${expected}), actual ${actual}`,
    level: 'fail',
  };
}

module.exports = {
  RETURN_MODELS,
  RETURN_FULFILLMENTS,
  normaliseReturnModel,
  normaliseReturnFulfillments,
  returnUsesInboundDate,
  combinedReturnDefined,
  localDateTime,
  buildInboundOfferRequest,
  checkReturnOffers,
  checkReturnFulfillmentCount,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
