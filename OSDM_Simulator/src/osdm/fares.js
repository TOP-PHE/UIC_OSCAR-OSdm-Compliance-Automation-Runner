// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fares.js — fare offers for a requested section (#903, fares phase 1a).
 *
 * Asked for `FARE_ADMISSION` (or `ALL`) with a requested section, a provider
 * whose profile has `fares` answers one offer per fare cluster of its
 * profile. Its product offers come too, unless the request asks for fare
 * parts only (#1046, `asksOnlyFares()`): then the answer holds fare offers
 * alone, or no offer and a warning when no fare can be given
 * (`noFareOfferProblem()`). Each offer holds `fares[]` only: one fare
 * per passenger for the section, combined by CLUSTERING, with a regional
 * constraint (an entry connection point and a route), a validity, after-sales
 * conditions, the TCOs involved and the section covered. A passenger younger
 * than `freeUnderAge` on the day of travel travels free: a fare priced 0.
 *
 * Without `FARE_*` in the request, or without a section (none, or an empty
 * list), there is no fare.
 *
 * The wrong answers, for the negative checks of the collection, are chosen by
 * the section's start station (offers are anonymous, so a passenger's last
 * name cannot choose them as at booking): `fares.variants` maps a variant to
 * its station. One variant is asked without a section (#905): a trip from
 * the `faresWithoutSection` station gets fares for the whole trip all the
 * same, as a provider that ignores the missing section would give.
 *
 * One variant is not wrong (#907): a section from the `combiningFares`
 * station gets fares combined by COMBINING, whose refund fee is the fare's own
 * and depends on the date: a tenth of the price until noon (UTC) the day
 * before travel, half of it after.
 *
 * Fare reservations (#255): from OSDM 3.8, `FARE_RESERVATION` asked gives each
 * BICYCLE passenger a bicycle place on each leg of the section, a
 * ReservationOfferPart marked `distributionMode: FARE_MODE` with no product
 * (osdm.io, handling reservations). A bicycle has no fare of its own: its
 * place is its fare. With fare admissions asked too, every fare offer holds
 * the places; else one offer holds them alone. Below 3.8 a fare reservation
 * cannot be told from a product one, and none is offered. A section from the
 * `bicycleReservationProductMode` station gives the places without
 * `distributionMode` (so in product mode): deliberately wrong.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { rank } = require('./versionShapes');
const { FARE_PLACE } = require('./reservations');

const MAX_SECTIONS = 4;
const MAX_REF_LENGTH = 120;
// The clusters OSDM names, most flexible first (constructing products from fares).
const CLUSTERS = ['BUSINESS', 'FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX', 'PROMO'];
const CLUSTER_FACTOR = { BUSINESS: 2, FULL_FLEX: 1.6, SEMI_FLEX: 1.3, NON_FLEX: 1, PROMO: 0.8 };
const AFTER_SALE = {
  BUSINESS: [{ condition: 'REFUND', fee: 0 }, { condition: 'EXCHANGE', fee: 0 }],
  FULL_FLEX: [{ condition: 'REFUND', fee: 0 }, { condition: 'EXCHANGE', fee: 0 }],
  SEMI_FLEX: [{ condition: 'REFUND', share: 0.25 }, { condition: 'EXCHANGE', share: 0.1 }],
  NON_FLEX: [{ condition: 'REFUND', share: 1 }],
  PROMO: [{ condition: 'REFUND', share: 1 }],
};

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The offer request is not valid', detail);
const randomId = () => crypto.randomBytes(8).toString('hex');
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();
const stopName = (stopPlaceRef) => `Station ${stopPlaceRef.split(':').pop()}`;
// Where the fares of the "gap" and "overlap" variants stop: a station of no trip.
const MIDDLE = { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000079' };

function stationOf(place, what) {
  const id = place?.stopPlaceRef;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_REF_LENGTH) throw bad(`${what}.stopPlaceRef is missing or not valid`);
  return { objectType: 'StopPlaceRef', stopPlaceRef: id };
}

/** The requested sections of a request: [{ startPlace, endPlace }], [] when none. */
function sectionsOf(body) {
  const list = body.requestedSections;
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_SECTIONS) throw bad(`requestedSections must hold at most ${MAX_SECTIONS} sections`);
  return list.map((s, i) => {
    const startPlace = stationOf(s?.startPlace, `requestedSections[${i}].startPlace`);
    const endPlace = stationOf(s?.endPlace, `requestedSections[${i}].endPlace`);
    if (startPlace.stopPlaceRef === endPlace.stopPlaceRef) throw bad(`requestedSections[${i}] starts where it ends`);
    return { startPlace, endPlace };
  });
}

/** `isPartOfInternationalTrip` of each trip specification: a boolean when given (#903). */
function checkInternationalFlags(body) {
  const specs = Array.isArray(body.tripSpecifications) ? body.tripSpecifications : [];
  specs.forEach((spec, i) => {
    const flag = spec?.isPartOfInternationalTrip;
    if (flag !== undefined && flag !== null && typeof flag !== 'boolean') {
      throw bad(`tripSpecifications[${i}].isPartOfInternationalTrip must be a boolean`);
    }
  });
}

const partsAsked = (criteria) => (Array.isArray(criteria?.requestedOfferParts) ? criteria.requestedOfferParts : []);

/** Does the request ask for fare admissions? */
function asksFares(criteria) {
  const parts = partsAsked(criteria);
  return parts.includes('FARE_ADMISSION') || parts.includes('ALL');
}

/** #255: does the request ask for fare reservations? */
function asksFareReservations(criteria) {
  const parts = partsAsked(criteria);
  return parts.includes('FARE_RESERVATION') || parts.includes('ALL');
}

// OSDM's OfferPartType values; any other is not read.
const OFFER_PART_TYPES = ['ADMISSION', 'RESERVATION', 'ANCILLARY', 'FARE_ADMISSION', 'FARE_RESERVATION', 'FARE_ANCILLARY', 'CONTINUOUS_SERVICE', 'ALL'];

/**
 * #1046: does the request ask for fare parts and nothing else? OSDM:
 * requestedOfferParts "allows to request offer-parts of a certain type", so
 * such a request gets no product offer.
 */
function asksOnlyFares(criteria) {
  const parts = partsAsked(criteria).filter((p) => OFFER_PART_TYPES.includes(p));
  return parts.length > 0 && parts.every((p) => p.startsWith('FARE_'));
}

/**
 * #1046: the warning of an answer to a request asking for fare parts only,
 * when no fare can be given: no offer at all, and why.
 */
function noFareOfferProblem(body, criteria, provider) {
  const asked = partsAsked(criteria).filter((p) => OFFER_PART_TYPES.includes(p)).join(', ');
  let reason = 'none of the fare parts asked is sold for this section';
  if (!provider.fares) reason = 'this provider sells no fares';
  else if (sectionsOf(body).length === 0) reason = 'a fare is offered for a requested section, and none was given (requestedSections)';
  return {
    code: 'OFFER_NO_RESULTS',
    title: 'No offer found',
    detail: `Only fare parts were asked (${asked}), so no product is offered; and no fare: ${reason}.`,
  };
}

// #255: a bicycle travels on a place of its own, its fare reservation.
const isBicycle = (passenger) => passenger.type === 'BICYCLE';
const BICYCLE_PLACE_CENTS = 300;
// OSDM 3.8 marks a fare reservation with ReservationOfferPart.distributionMode.
const FARE_RESERVATIONS_FROM = rank('3.8');

// #255: the legs of a trip a section runs over: from the one it starts at to
// the one it ends at; every leg when the section names neither.
function legsOfSection(trip, section) {
  const legs = Array.isArray(trip.legs) ? trip.legs : [];
  const at = (leg, end) => leg.timedLeg?.[end]?.stopPlaceRef?.stopPlaceRef;
  const first = legs.findIndex((leg) => at(leg, 'start') === section.startPlace.stopPlaceRef);
  const last = legs.findIndex((leg, i) => i >= Math.max(first, 0) && at(leg, 'end') === section.endPlace.stopPlaceRef);
  if (first < 0 || last < 0) return legs;
  return legs.slice(first, last + 1);
}

// #255: the bicycle places of a request, one per bicycle and leg: fare
// reservations, without a product. The wrong variant leaves out their mode.
function bicyclePlacesOf({ trip, section, bicycles, provider, createdOn, fulfillmentOptions, variant }) {
  const price = { amount: Math.round(BICYCLE_PLACE_CENTS * provider.priceFactor), currency: provider.currency, scale: 2 };
  const marked = (part) => Object.defineProperty(part, FARE_PLACE, { value: true });
  return bicycles.flatMap((bicycle) => legsOfSection(trip, section).map((leg) => marked({
    objectType: 'ReservationOfferPart',
    id: `${provider.idPrefix}-FRES-${randomId()}`,
    summary: `Bicycle place, train ${leg.timedLeg.service.vehicleNumbers[0]}`,
    createdOn,
    validFrom: leg.timedLeg.start.serviceDeparture.timetabledTime,
    validUntil: leg.timedLeg.end.serviceArrival.timetabledTime,
    price: { ...price },
    tripCoverage: { coveredTripId: trip.id, coveredLegIds: [leg.id] },
    offerMode: 'INDIVIDUAL',
    isReusable: false,
    passengerRefs: [bicycle.externalRef],
    refundable: 'YES',
    exchangeable: 'NO',
    products: [],
    availableFulfillmentOptions: fulfillmentOptions,
    ...(variant === 'bicycleReservationProductMode' ? {} : { distributionMode: 'FARE_MODE' }),
  })));
}

// The age of a passenger on a day, or null without a date of birth.
function ageOn(dateOfBirth, day) {
  if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = day.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

const isFree = (passenger, day, rules) => {
  const age = ageOn(passenger.dateOfBirth, day);
  return age !== null && Number.isInteger(rules.freeUnderAge) && age < rules.freeUnderAge;
};

// The clusters a fare of `cluster` may be combined with: itself and the less
// flexible ones (OSDM: allowed clusters are usually not more flexible).
const allowedOf = (cluster, clusters) => clusters.filter((c) => CLUSTERS.indexOf(c) >= CLUSTERS.indexOf(cluster));

function variantOf(section, rules) {
  const start = section.startPlace.stopPlaceRef;
  const entry = Object.entries(rules.variants || {}).find(([, station]) => station === start);
  return entry ? entry[0] : null;
}

// #905: the whole trip as the section, for a request that names none, when
// the trip leaves from the `faresWithoutSection` station. null otherwise.
function wholeTripWithoutSection(trips, rules) {
  const station = rules.variants?.faresWithoutSection;
  const first = trips[0];
  if (!station || first?.origin?.stopPlaceRef !== station || !first.destination?.stopPlaceRef) return null;
  return {
    startPlace: { objectType: 'StopPlaceRef', stopPlaceRef: first.origin.stopPlaceRef },
    endPlace: { objectType: 'StopPlaceRef', stopPlaceRef: first.destination.stopPlaceRef },
  };
}

// One fare of one passenger for [from, to] of the section.
function fareOf({ passenger, from, to, cluster, clusters, day, priceCents, provider }) {
  const price = (amount) => ({ amount, currency: provider.currency, scale: 2 });
  const amount = priceCents;
  return {
    id: `${provider.idPrefix}-FARE-${randomId()}`,
    type: 'ADMISSION',
    name: { id: `${provider.idPrefix}-FARE-NAME-${cluster}`, text: `${provider.name} ${cluster.replace('_', ' ').toLowerCase()} fare` },
    prices: [price(amount)],
    regionalConstraint: {
      entryConnectionPoint: {
        objectType: 'FareConnectionPoint',
        id: `urn:x_osdm_simulator:fcp:${from.stopPlaceRef.split(':').pop()}`,
        name: stopName(from.stopPlaceRef),
        stationSets: [{ stations: [{ ...from }] }],
      },
      regionalValidities: [{ seqNb: 1, route: { routeSummary: `${stopName(from.stopPlaceRef)} - ${stopName(to.stopPlaceRef)}` } }],
    },
    serviceClass: { type: 'STANDARD', name: 'Standard' },
    travelClass: 'SECOND',
    afterSalesCondition: {
      conditions: AFTER_SALE[cluster].map((c) => ({
        condition: c.condition,
        afterSaleFee: price(c.fee ?? Math.round(amount * c.share)),
      })),
      isProviderFee: true,
    },
    combinationConstraint: [{ model: 'CLUSTERING', referenceCluster: cluster, allowedClusters: allowedOf(cluster, clusters) }],
    travelValidityConstraint: {
      validTravelDates: { from: `${day}T00:00:00Z`, until: `${day}T23:59:59Z` },
      validityRange: { timeUnit: 'DAYS', value: 1 },
    },
    coveredSection: { startPlace: { ...from }, endPlace: { ...to } },
    passengerRefs: [passenger.externalRef],
    involvedTCOs: [provider.carrier.ref],
  };
}

// The fares of one passenger in one cluster for a section, as the variant has
// them. A gap ends the fares at an intermediate station; an overlap adds a
// second fare over the start of the section.
function faresOfPassenger(passenger, section, ctx) {
  const { variant, cluster } = ctx;
  const { startPlace, endPlace } = section;
  const middle = MIDDLE;
  const base = { passenger, cluster, ...ctx };
  if (variant === 'sectionGap') return [fareOf({ ...base, from: startPlace, to: middle })];
  const whole = fareOf({ ...base, from: startPlace, to: endPlace });
  if (variant === 'overlappingFares') return [whole, fareOf({ ...base, from: startPlace, to: middle })];
  return [whole];
}

// The wrong variants that change the combination constraint.
function applyClusterVariant(fare, variant) {
  const model = fare.combinationConstraint[0];
  if (variant === 'unknownCluster') model.referenceCluster = 'GOLD';
  if (variant === 'widerClusters') model.allowedClusters = [...CLUSTERS];
}

// #907: a fare combined by COMBINING gives its own refund fee, by date.
function applyCombiningVariant(fare, variant, day) {
  if (variant !== 'combiningFares') return;
  const { amount, currency } = fare.prices[0];
  const price = (cents) => ({ amount: cents, currency, scale: 2 });
  const eve = new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  fare.combinationConstraint = [{ model: 'COMBINING' }];
  fare.afterSalesCondition.conditions = [
    { condition: 'REFUND', validUntil: `${eve}T11:59:59Z`, afterSaleFee: price(Math.round(amount / 10)) },
    { condition: 'REFUND', validFrom: `${eve}T12:00:00Z`, validUntil: `${day}T23:59:59Z`, afterSaleFee: price(Math.round(amount / 2)) },
    { condition: 'EXCHANGE', afterSaleFee: price(0) },
  ];
}

/**
 * The fare offers of a request: [] unless the provider sells fares, the
 * request asks for them and names a section (or the section starts at the
 * "unrequested fares" variant station, or the trip leaves from the "fares
 * without section" one).
 */
function fareOffersOf({ body, criteria, trips, passengers, provider, nowMs, lifetimeMs, fulfillmentOptions = [] }) {
  checkInternationalFlags(body);
  const rules = provider.fares;
  const sections = sectionsOf(body);
  if (!rules || trips.length === 0) return [];
  const section = sections[0] || wholeTripWithoutSection(trips, rules);
  if (!section) return [];
  const variant = sections.length ? variantOf(section, rules) : null;
  const admissions = asksFares(criteria) || variant === 'unrequestedFares';
  // #255: bicycle places in fare mode, from OSDM 3.8.
  const bicycles = asksFareReservations(criteria) && rank(provider.osdmVersion) >= FARE_RESERVATIONS_FROM ? passengers.filter(isBicycle) : [];
  if (!admissions && bicycles.length === 0) return [];
  const persons = passengers.filter((p) => !isBicycle(p));
  if (persons.length === 0 && bicycles.length === 0) return [];
  const day = trips[0].startTime.slice(0, 10);
  const seed = hashOf(`${section.startPlace.stopPlaceRef}|${section.endPlace.stopPlaceRef}`);
  const baseCents = 800 + (seed.readUInt16BE(0) % 4200);
  const clusters = rules.clusters.filter((c) => CLUSTERS.includes(c));
  const createdOn = new Date(nowMs).toISOString();
  const places = () => bicyclePlacesOf({ trip: trips[0], section, bicycles, provider, createdOn, fulfillmentOptions, variant });
  const route = `${stopName(section.startPlace.stopPlaceRef)} - ${stopName(section.endPlace.stopPlaceRef)}`;
  const offerOf = (summary, members) => ({
    offerId: `${provider.idPrefix}-FOF-${randomId()}`,
    summary,
    createdOn,
    preBookableUntil: new Date(nowMs + lifetimeMs).toISOString(),
    passengerRefs: passengers.map((p) => p.externalRef),
    ...members,
  });
  if (!admissions || persons.length === 0) return [offerOf(`${provider.name} bicycle places, ${route}`, { reservationOfferParts: places() })];
  return clusters.map((cluster) => {
    const priceCents = Math.round(baseCents * CLUSTER_FACTOR[cluster] * provider.priceFactor);
    const fares = persons
      .filter((p, i) => !(variant === 'passengerWithoutFare' && i === persons.length - 1))
      .flatMap((passenger) => faresOfPassenger(passenger, section, {
        variant, cluster, clusters, day, provider,
        priceCents: isFree(passenger, day, rules) ? 0 : priceCents,
      }));
    for (const fare of fares) {
      applyClusterVariant(fare, variant);
      applyCombiningVariant(fare, variant, day);
    }
    const reservations = bicycles.length > 0 ? { reservationOfferParts: places() } : {};
    return offerOf(`${provider.name} ${cluster.replace('_', ' ').toLowerCase()} fares, ${route}`, { fares, ...reservations });
  });
}

module.exports = { fareOffersOf, sectionsOf, asksFares, asksFareReservations, asksOnlyFares, noFareOfferProblem, CLUSTERS };
