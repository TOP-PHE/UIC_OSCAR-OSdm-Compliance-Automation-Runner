// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offers.js — the answer to POST /offers.
 *
 * There is no timetable. The trip is built from the request: the same origin,
 * destination and time always give the same trip and the same prices, and a
 * different provider gives a different carrier, currency, price and id prefix.
 *
 * A return is answered in both of the OSDM ways (#594):
 *  - separate directions: the inbound search names the outbound offer it goes
 *    with (`returnSearchParameters.outwardOfferIds`), and gets inbound offers;
 *  - both directions: the inbound search names the outbound trip
 *    (`returnSearchParameters.outboundTripIds`, OSDM 3.7 and later), and gets
 *    offers that cover the outbound and the inbound trip, with a return price.
 * An id this client was not given is refused, as is naming both.
 *
 * A passenger's reduction card is applied when the provider knows it (#597):
 * the passenger's price is reduced and its admissions name the card in
 * `appliedPassengerTypes`. An unknown card is reported in `problems`.
 *
 * A group product (#599) is offered only when the request asks for the
 * COLLECTIVE offer mode and the group meets the product's rules: one admission
 * per direction for the whole group, priced for the group, naming the
 * passenger type of each passenger, without card reductions. When no group
 * offer can be made, the answer holds the individual offers and a Problem
 * saying why, as OSDM asks of a provider that falls back to the other mode.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { cardsOf, applyCards, reducedPrice, unknownCardProblem, appliedCardType } = require('./reductionCards');

const MAX_PASSENGERS = 19;
const MAX_TRIPS = 4;
const MAX_LEGS = 6;
const MAX_REF_LENGTH = 120;
const OFFER_LIFETIME_MS = 30 * 60 * 1000;

const FLEXIBILITIES = [
  { key: 'FULL_FLEXIBLE', label: 'Flex', factor: 1.6, refundable: 'YES', exchangeable: 'YES' },
  { key: 'SEMI_FLEXIBLE', label: 'Semi-flex', factor: 1.3, refundable: 'WITH_CONDITION', exchangeable: 'WITH_CONDITION' },
  { key: 'NON_FLEXIBLE', label: 'Saver', factor: 1, refundable: 'NO', exchangeable: 'NO' },
];
const TRAVEL_CLASSES = { SECOND: 1, FIRST: 1.5 };

// The tariffs a provider sells (#598): its named products when its profile
// lists them, else one per flexibility, as before. A named product takes its
// refund and exchange conditions from its flexibility.
function tariffsOf(provider) {
  if (!provider.products) return FLEXIBILITIES;
  return provider.products.map((p) => {
    const flexibility = FLEXIBILITIES.find((f) => f.key === p.flexibility);
    return { ...flexibility, label: p.name, factor: p.factor, code: p.code, name: p.name, isTrainBound: p.isTrainBound, group: p.group };
  });
}

// The OSDM product of a tariff in a travel class.
function productOf(tariff, travelClass, provider) {
  const serviceClass = travelClass === 'FIRST' ? { type: 'HIGH', name: 'First' } : { type: 'STANDARD', name: 'Standard' };
  const named = tariff.code !== undefined;
  return {
    id: named ? `${provider.idPrefix}-PRD-${tariff.code}-${travelClass}` : `${provider.idPrefix}-PRD-${tariff.key}-${travelClass}`,
    code: named ? tariff.code : `${provider.idPrefix}-${tariff.key}-${travelClass}`,
    summary: named ? tariff.name : `${provider.name} ${tariff.label}`,
    type: 'ADMISSION',
    owner: provider.carrier.ref,
    flexibility: tariff.key,
    serviceClass,
    travelClass,
    isTrainBound: named ? tariff.isTrainBound : tariff.key === 'NON_FLEXIBLE',
  };
}

// The travel classes a tariff is sold in: a group product may be second class only.
const classesOf = (tariff) => Object.keys(TRAVEL_CLASSES).filter((c) => c === 'SECOND' || !tariff.group?.secondClassOnly);

/** The products of a provider, for GET /products: each tariff in each class. */
function productsOf(provider) {
  return tariffsOf(provider).flatMap((tariff) => classesOf(tariff).map((c) => productOf(tariff, c, provider)));
}
const DEFAULT_FULFILLMENT_OPTIONS = [{ type: 'ETICKET', media: 'PDF_A4' }];
const PRODUCT_CATEGORY = { productCategoryRef: 'urn:x_osdm_simulator:product-category:IC', name: 'InterCity', shortName: 'IC' };
// An offer that covers both directions costs this share of two single ones.
const RETURN_FACTOR = 0.9;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The offer request is not valid', detail);
// What the provider made of a passenger's cards: a hidden property (a symbol,
// not enumerable), so that it is never sent back with the passenger.
const CARDS_APPLIED = Symbol('cards applied');
const randomId = () => crypto.randomBytes(8).toString('hex');
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

// A short text taken from a request. Refused when it is not text or too long;
// what is kept is only ever sent back inside JSON.
function ref(value, what) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REF_LENGTH) throw bad(`${what} is missing or not valid`);
  return value;
}

// A date-time of a request: { ms, offset }. The offset is the one the request
// wrote. A local time without one, which the OSCAR collection sends for a
// search, is read in the provider's own offset, so that the answer is always a
// complete date-time.
function instant(value, what, provider) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw bad(`${what} is missing or not a date-time`);
  }
  const zone = /(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const offset = zone ? zone[1] : provider.utcOffset;
  const ms = Date.parse(zone ? value : value + offset);
  if (Number.isNaN(ms)) throw bad(`${what} is not a date-time`);
  return { ms, offset };
}

// The same instant written in that offset.
function isoAt(ms, offset) {
  if (offset === 'Z') return new Date(ms).toISOString().replace('.000Z', 'Z');
  const sign = offset.startsWith('-') ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  return new Date(ms + minutes * 60000).toISOString().replace('.000Z', '') + offset;
}

function isoDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `PT${h ? h + 'H' : ''}${m || !h ? m + 'M' : ''}`;
}

const stopPlace = (value, what) => ({ objectType: 'StopPlaceRef', stopPlaceRef: ref(value?.stopPlaceRef, what) });
// No station list: the name is made from the last part of the reference.
const stopName = (stopPlaceRef) => `Station ${stopPlaceRef.split(':').pop()}`;

function buildLeg({ from, to, start, end, vehicleNumber }, provider) {
  return {
    timedLeg: {
      start: { stopPlaceRef: from, stopPlaceName: stopName(from.stopPlaceRef), serviceDeparture: { timetabledTime: isoAt(start.ms, start.offset) } },
      end: { stopPlaceRef: to, stopPlaceName: stopName(to.stopPlaceRef), serviceArrival: { timetabledTime: isoAt(end.ms, end.offset) } },
      service: {
        mode: { ptMode: 'TRAIN' },
        productCategory: PRODUCT_CATEGORY,
        vehicleNumbers: [vehicleNumber],
        carriers: [{ ref: provider.carrier.ref, name: provider.carrier.name }],
      },
      duration: isoDuration(end.ms - start.ms),
    },
  };
}

function finishTrip(legs, externalRef, provider) {
  const first = legs[0].timedLeg;
  const last = legs.at(-1).timedLeg;
  const startMs = Date.parse(first.start.serviceDeparture.timetabledTime);
  const endMs = Date.parse(last.end.serviceArrival.timetabledTime);
  if (endMs <= startMs) throw bad('a trip must end after it starts');
  // The id is a digest of the trip itself: the same request gives the same id.
  const id = `${provider.idPrefix}-TRIP-${hashOf(provider.key + JSON.stringify(legs)).toString('hex').slice(0, 12)}`;
  legs.forEach((leg, i) => { leg.id = `${id}-L${i + 1}`; });
  const trip = {
    id,
    summary: `${first.start.stopPlaceName} - ${last.end.stopPlaceName}`,
    direction: 'OUT_BOUND',
    origin: first.start.stopPlaceRef,
    originName: first.start.stopPlaceName,
    destination: last.end.stopPlaceRef,
    destinationName: last.end.stopPlaceName,
    startTime: first.start.serviceDeparture.timetabledTime,
    endTime: last.end.serviceArrival.timetabledTime,
    duration: isoDuration(endMs - startMs),
    transfers: legs.length - 1,
    legs: legs.map((leg) => ({ id: leg.id, timedLeg: leg.timedLeg })),
  };
  if (externalRef !== undefined) trip.externalRef = ref(externalRef, 'tripSpecifications.externalRef');
  return trip;
}

// A search: one direct trip, leaving when asked. Its length and its train
// number come from the two places, so they do not change between two calls.
function tripFromSearch(criteria, provider) {
  if (!criteria || typeof criteria !== 'object') throw bad('tripSearchCriteria is not valid');
  const from = stopPlace(criteria.origin, 'tripSearchCriteria.origin');
  const to = stopPlace(criteria.destination, 'tripSearchCriteria.destination');
  const seed = hashOf(`${from.stopPlaceRef}|${to.stopPlaceRef}`);
  const lengthMs = (45 + (seed.readUInt16BE(0) % 240)) * 60000;
  let start;
  let end;
  if (criteria.departureTime !== undefined) {
    start = instant(criteria.departureTime, 'tripSearchCriteria.departureTime', provider);
    end = { ms: start.ms + lengthMs, offset: start.offset };
  } else {
    end = instant(criteria.arrivalTime, 'tripSearchCriteria.arrivalTime', provider);
    start = { ms: end.ms - lengthMs, offset: end.offset };
  }
  const asked = criteria.parameters?.dataFilter?.vehicleFilter;
  const askedNumber = asked?.exclude === false && Array.isArray(asked.vehicleNumbers) ? asked.vehicleNumbers[0] : undefined;
  const vehicleNumber = typeof askedNumber === 'string' && askedNumber.length > 0 && askedNumber.length <= 20
    ? askedNumber
    : String(1000 + (seed.readUInt16BE(2) % 9000));
  return finishTrip([buildLeg({ from, to, start, end, vehicleNumber }, provider)], undefined, provider);
}

// A specified trip: the legs of the request, served by this provider.
function tripFromSpecification(spec, provider) {
  if (!spec || !Array.isArray(spec.legs) || spec.legs.length === 0 || spec.legs.length > MAX_LEGS) throw bad('tripSpecifications.legs is not valid');
  const legs = spec.legs.map((leg, i) => {
    const timed = leg?.timedLeg;
    if (!timed?.start || !timed.end) throw bad(`tripSpecifications.legs[${i}].timedLeg is not valid`);
    const numbers = Array.isArray(timed.service?.vehicleNumbers) ? timed.service.vehicleNumbers : [];
    return buildLeg({
      from: stopPlace(timed.start.stopPlaceRef, `legs[${i}].start.stopPlaceRef`),
      to: stopPlace(timed.end.stopPlaceRef, `legs[${i}].end.stopPlaceRef`),
      start: instant(timed.start.serviceDeparture?.timetabledTime, `legs[${i}].start.serviceDeparture`, provider),
      end: instant(timed.end.serviceArrival?.timetabledTime, `legs[${i}].end.serviceArrival`, provider),
      vehicleNumber: typeof numbers[0] === 'string' && numbers[0].length > 0 && numbers[0].length <= 20 ? numbers[0] : '1000',
    }, provider);
  });
  return finishTrip(legs, spec.externalRef, provider);
}

function tripsOf(body, provider) {
  if (Array.isArray(body.tripSpecifications) && body.tripSpecifications.length > 0) {
    if (body.tripSpecifications.length > MAX_TRIPS) throw bad(`at most ${MAX_TRIPS} tripSpecifications`);
    return body.tripSpecifications.map((spec) => tripFromSpecification(spec, provider));
  }
  if (body.tripSearchCriteria !== undefined) return [tripFromSearch(body.tripSearchCriteria, provider)];
  throw bad('tripSearchCriteria or tripSpecifications is required');
}

function passengersOf(body, provider) {
  const list = body.anonymousPassengerSpecifications;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PASSENGERS) {
    throw bad(`anonymousPassengerSpecifications must hold 1 to ${MAX_PASSENGERS} passengers`);
  }
  const seen = new Set();
  return list.map((p, i) => {
    const externalRef = ref(p?.externalRef, `anonymousPassengerSpecifications[${i}].externalRef`);
    if (seen.has(externalRef)) throw bad(`anonymousPassengerSpecifications: externalRef "${externalRef}" appears twice`);
    seen.add(externalRef);
    const out = { externalRef, type: typeof p.type === 'string' && p.type.length <= 30 ? p.type : 'PERSON' };
    if (typeof p.dateOfBirth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.dateOfBirth)) out.dateOfBirth = p.dateOfBirth;
    const cards = cardsOf(p, `anonymousPassengerSpecifications[${i}]`);
    if (cards.length > 0) out.cards = cards;
    Object.defineProperty(out, CARDS_APPLIED, { value: applyCards(cards, provider) });
    return out;
  });
}

// The values of a criterion that this simulator knows; all of them when the
// request names none it knows.
function wanted(criteria, field, known) {
  const asked = Array.isArray(criteria?.[field]) ? criteria[field].filter((v) => known.includes(v)) : [];
  return asked.length > 0 ? asked : null;
}

function fulfillmentOptionsOf(body) {
  const asked = Array.isArray(body.requestedFulfillmentOptions) ? body.requestedFulfillmentOptions : [];
  const options = asked
    .filter((o) => typeof o?.type === 'string' && typeof o.media === 'string' && o.type.length <= 30 && o.media.length <= 30)
    .slice(0, 6)
    .map((o) => ({ type: o.type, media: o.media }));
  return options.length > 0 ? options : DEFAULT_FULFILLMENT_OPTIONS;
}

const coverageOf = (trip) => ({ coveredTripId: trip.id, coveredLegIds: trip.legs.map((leg) => leg.id) });

// The price of one passenger for one trip.
function priceOfTrip(trip, flexibility, travelClass, provider) {
  const seed = hashOf(`${trip.origin.stopPlaceRef}|${trip.destination.stopPlaceRef}`);
  const baseCents = 1500 + (seed.readUInt16BE(4) % 8500);
  return Math.round(baseCents * flexibility.factor * TRAVEL_CLASSES[travelClass] * provider.priceFactor);
}

// The passenger type and card an admission was priced with, when a card was
// applied; nothing otherwise, as before cards existed.
function appliedPassengerTypesOf(passenger, provider) {
  const { applied } = passenger[CARDS_APPLIED];
  if (!applied) return {};
  return {
    appliedPassengerTypes: [{
      passengerRef: passenger.externalRef,
      type: passenger.type === 'PERSON' ? 'ADULT' : passenger.type,
      description: `${passenger.type === 'PERSON' ? 'Adult' : passenger.type} with ${applied.name}`,
      appliedReductionCardTypes: [appliedCardType(applied, provider)],
      appliedReductions: [{ type: 'REDUCTION_CARD', code: applied.code, issuer: provider.carrier.ref }],
    }],
  };
}

// ── Group products (#599) ───────────────────────────────────────────────────

const AGE_LIMIT = 15;
const localDay = (trip) => trip.startTime.slice(0, 10);
const isWeekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

// The age of a passenger on a day, or null without a date of birth.
function ageOn(dateOfBirth, day) {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = day.split('-').map(Number);
  const beforeBirthday = tm < m || (tm === m && td < d);
  return ty - y - (beforeBirthday ? 1 : 0);
}

// A passenger without a date of birth counts as aged 15 or more.
function isOver15(passenger, day) {
  const age = ageOn(passenger.dateOfBirth, day);
  return age === null || age >= AGE_LIMIT;
}

/**
 * Why a group product cannot be offered to these passengers, on these trips,
 * in this class; null when it can. The ages are taken on the day of the first
 * trip.
 */
function groupRefusal(tariff, passengers, trips, travelClass) {
  const rules = tariff.group;
  const count = passengers.length;
  if (count < rules.minPassengers || count > rules.maxPassengers) {
    return `${tariff.name}: ${rules.minPassengers} to ${rules.maxPassengers} passengers, not ${count}`;
  }
  const over15 = passengers.filter((p) => isOver15(p, localDay(trips[0]))).length;
  if (rules.maxOver15 !== undefined && over15 > rules.maxOver15) {
    return `${tariff.name}: at most ${rules.maxOver15} passengers aged 15 or more, not ${over15}`;
  }
  if (rules.weekendOnly && !trips.every((t) => isWeekend(localDay(t)))) return `${tariff.name}: on a Saturday or a Sunday only`;
  if (rules.secondClassOnly && travelClass !== 'SECOND') return `${tariff.name}: in second class only`;
  return null;
}

// The price of a group from the price of one passenger.
function groupPrice(single, count, rules) {
  if (rules.pricedPassengers !== undefined) return single * rules.pricedPassengers;
  return single + (count - 1) * Math.round(single * rules.followerPercent / 100);
}

// The passenger type each member of a group was priced as.
function groupPassengerTypes(passengers, day) {
  return passengers.map((p) => {
    const adult = isOver15(p, day);
    return { passengerRef: p.externalRef, type: adult ? 'ADULT' : 'CHILD', description: adult ? 'Adult in a group' : 'Child in a group' };
  });
}

// The admissions of one direction: one per passenger, or one for the whole
// group, each with its passengers, its price and its applied passenger types.
function admissionsOfDirection(trip, passengers, tariff, singlePrice, provider) {
  if (tariff.group) {
    return [{
      passengers,
      amount: groupPrice(singlePrice(trip, null), passengers.length, tariff.group),
      applied: { appliedPassengerTypes: groupPassengerTypes(passengers, localDay(trip)) },
      offerMode: 'COLLECTIVE',
    }];
  }
  return passengers.map((passenger) => ({
    passengers: [passenger],
    amount: singlePrice(trip, passenger),
    applied: appliedPassengerTypesOf(passenger, provider),
    offerMode: 'INDIVIDUAL',
  }));
}

// An offer for `trip`, or, given `inboundTrip`, for both directions: one
// admission per passenger and direction, or, for a group product, one per
// direction for the whole group; each covers its own trip.
function buildOffer({ trip, inboundTrip, passengers, flexibility, travelClass, fulfillmentOptions, provider, nowMs }) {
  const coverage = coverageOf(trip);
  const directions = inboundTrip ? [trip, inboundTrip] : [trip];
  const factor = inboundTrip ? RETURN_FACTOR : 1;
  // A group pays no card reduction: its single price is the full one.
  const singlePrice = (t, passenger) => reducedPrice(Math.round(priceOfTrip(t, flexibility, travelClass, provider) * factor), passenger?.[CARDS_APPLIED].applied);
  const price = (amount) => ({ amount, currency: provider.currency, scale: 2 });
  const createdOn = new Date(nowMs).toISOString();
  const product = productOf(flexibility, travelClass, provider);
  const { serviceClass } = product;
  const admissionOfferParts = directions.flatMap((t) => admissionsOfDirection(t, passengers, flexibility, singlePrice, provider).map((part) => ({
    objectType: 'AdmissionOfferPart',
    id: `${provider.idPrefix}-ADM-${randomId()}`,
    summary: `${product.summary}, ${serviceClass.name} class`,
    createdOn,
    validFrom: t.startTime,
    validUntil: t.endTime,
    price: price(part.amount),
    tripCoverage: coverageOf(t),
    ...part.applied,
    offerMode: part.offerMode,
    isReusable: false,
    passengerRefs: part.passengers.map((p) => p.externalRef),
    refundable: flexibility.refundable,
    exchangeable: flexibility.exchangeable,
    summaryProductId: product.id,
    products: [{ productId: product.id, legIds: coverageOf(t).coveredLegIds }],
    availableFulfillmentOptions: fulfillmentOptions,
    isReservationRequired: false,
  })));
  const total = admissionOfferParts.reduce((sum, part) => sum + part.price.amount, 0);
  const offer = {
    offerId: `${provider.idPrefix}-OFR-${randomId()}`,
    summary: `${product.summary}, ${serviceClass.name} class`,
    offerSummary: {
      minimalPrice: price(total),
      overallServiceClass: serviceClass,
      overallTravelClass: travelClass,
      overallFlexibility: flexibility.key,
    },
    createdOn,
    preBookableUntil: new Date(nowMs + OFFER_LIFETIME_MS).toISOString(),
    passengerRefs: passengers.map((p) => p.externalRef),
    products: [product],
    tripCoverage: coverage,
    admissionOfferParts,
  };
  if (inboundTrip) offer.inboundTripCoverage = coverageOf(inboundTrip);
  return offer;
}

// What a return request asks, from the trip it searches with:
// { outwardOfferIds } (separate directions), { outboundTripIds } (both
// directions), or null. A date of a later inbound journey (first call) is no
// return request of its own.
function returnOf(body) {
  const params = body.tripSearchCriteria?.returnSearchParameters
    ?? (Array.isArray(body.tripSpecifications) ? body.tripSpecifications[0]?.returnSearchParameters : undefined);
  if (params == null) return null;
  if (typeof params !== 'object' || Array.isArray(params)) throw bad('returnSearchParameters is not valid');
  const ids = (field) => {
    const value = params[field];
    if (value == null) return null;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TRIPS) throw bad(`returnSearchParameters.${field} must hold 1 to ${MAX_TRIPS} ids`);
    return value.map((id, i) => ref(id, `returnSearchParameters.${field}[${i}]`));
  };
  const outwardOfferIds = ids('outwardOfferIds');
  const outboundTripIds = ids('outboundTripIds');
  if (outwardOfferIds && outboundTripIds) throw bad('returnSearchParameters: give outwardOfferIds or outboundTripIds, not both');
  if (outwardOfferIds) return { outwardOfferIds };
  if (outboundTripIds) return { outboundTripIds };
  return null;
}

const notGiven = (field, id) => bad(`returnSearchParameters.${field}: "${id}" is not one this client was given`);

// For a return request: checks that what it names was given to this client,
// marks the searched trips IN_BOUND, and gives the outbound trips it names
// (both directions), or none.
function outboundTripsOf(asked, known, trips) {
  if (!asked) return [];
  for (const trip of trips) trip.direction = 'IN_BOUND';
  for (const id of asked.outwardOfferIds || []) {
    if (!known.offer?.(id)) throw notGiven('outwardOfferIds', id);
  }
  return (asked.outboundTripIds || []).map((id) => {
    const outbound = known.trip?.(id);
    if (!outbound) throw notGiven('outboundTripIds', id);
    return outbound;
  });
}

// Whether a tariff is offered: a group product only to a COLLECTIVE request
// whose group meets its rules. Why one is not goes into `refusals`.
function isOffered(tariff, { collective, passengers, covered, travelClass, refusals }) {
  if (!tariff.group) return true;
  if (!collective) return false;
  const refusal = groupRefusal(tariff, passengers, covered, travelClass);
  if (refusal) refusals.add(refusal);
  return !refusal;
}

// The Problem of a COLLECTIVE request answered with individual offers only.
function noCollectiveOfferProblem(refusals) {
  const why = refusals.size > 0 ? `the group does not meet the rules (${[...refusals].join('; ')})` : 'this provider sells no group product';
  return {
    code: 'COLLECTIVE_OFFER_NOT_AVAILABLE',
    title: 'No collective offer',
    detail: `No collective offer: ${why}. Individual offers are given instead.`,
  };
}

// The Problems of an answer: each card not applied (#597), and a COLLECTIVE
// request answered without a collective offer (#599).
function problemsOf(passengers, offers, collective, refusals) {
  const problems = passengers
    .filter((p) => p[CARDS_APPLIED].unknown.length > 0)
    .map((p) => unknownCardProblem(p.externalRef, p[CARDS_APPLIED].unknown));
  const hasCollective = offers.some((o) => o.admissionOfferParts.some((part) => part.offerMode === 'COLLECTIVE'));
  if (collective && !hasCollective) problems.push(noCollectiveOfferProblem(refusals));
  return problems;
}

/**
 * The OfferCollectionResponse for this request and provider, and what has to
 * be remembered of each offer for the booking that may follow. `known` reads
 * back what this client was given before: `known.offer(id)`, `known.trip(id)`;
 * only a return request uses it.
 */
function buildOfferCollection(body, provider, nowMs, known = {}) {
  const trips = tripsOf(body, provider);
  const passengers = passengersOf(body, provider);
  const outboundTrips = outboundTripsOf(returnOf(body), known, trips);
  const criteria = body.offerSearchCriteria;
  const askedFlexibilities = wanted(criteria, 'flexibilities', FLEXIBILITIES.map((f) => f.key));
  const flexibilities = tariffsOf(provider).filter((f) => !askedFlexibilities || askedFlexibilities.includes(f.key));
  const classes = wanted(criteria, 'travelClass', Object.keys(TRAVEL_CLASSES)) || ['SECOND'];
  const fulfillmentOptions = fulfillmentOptionsOf(body);
  const collective = criteria?.offerMode === 'COLLECTIVE';
  const refusals = new Set();
  const offers = [];
  const remembered = [];
  // Both directions: one offer covers an outbound trip and an inbound one.
  const pairs = outboundTrips.length > 0
    ? outboundTrips.flatMap((outbound) => trips.map((inbound) => ({ trip: outbound, inboundTrip: inbound })))
    : trips.map((trip) => ({ trip }));
  for (const { trip, inboundTrip } of pairs) {
    const covered = inboundTrip ? [trip, inboundTrip] : [trip];
    for (const travelClass of classes) {
      for (const flexibility of flexibilities.filter((f) => isOffered(f, { collective, passengers, covered, travelClass, refusals }))) {
        const offer = buildOffer({ trip, inboundTrip, passengers, flexibility, travelClass, fulfillmentOptions, provider, nowMs });
        offers.push(offer);
        remembered.push({ offer, trips: covered, passengers, oneFulfillment: flexibility.group?.oneFulfillment === true });
      }
    }
  }
  const allTrips = [...outboundTrips, ...trips];
  const problems = problemsOf(passengers, offers, collective, refusals);
  const response = { anonymousPassengerSpecifications: passengers, trips: allTrips, offers };
  if (problems.length > 0) response.problems = problems;
  return { response, remembered, trips: allTrips };
}

module.exports = { buildOfferCollection, productsOf, OFFER_LIFETIME_MS };
