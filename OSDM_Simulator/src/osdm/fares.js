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
 * whose profile has `fares` answers, besides its product offers, one offer
 * per fare cluster of its profile. Each offer holds `fares[]` only: one fare
 * per passenger for the section, combined by CLUSTERING, with a regional
 * constraint (an entry connection point and a route), a validity, after-sales
 * conditions, the TCOs involved and the section covered. A passenger younger
 * than `freeUnderAge` on the day of travel travels free: a fare priced 0.
 *
 * Without `FARE_*` in the request, or without a section, there is no fare.
 *
 * The wrong answers, for the negative checks of the collection, are chosen by
 * the section's start station (offers are anonymous, so a passenger's last
 * name cannot choose them as at booking): `fares.variants` maps a variant to
 * its station.
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');

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

/** Does the request ask for fare admissions? */
function asksFares(criteria) {
  const parts = Array.isArray(criteria?.requestedOfferParts) ? criteria.requestedOfferParts : [];
  return parts.includes('FARE_ADMISSION') || parts.includes('ALL');
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

/**
 * The fare offers of a request: [] unless the provider sells fares, the
 * request asks for them and names a section (or the section starts at the
 * "unrequested fares" variant station).
 */
function fareOffersOf({ body, criteria, trips, passengers, provider, nowMs, lifetimeMs }) {
  checkInternationalFlags(body);
  const rules = provider.fares;
  const sections = sectionsOf(body);
  if (!rules || sections.length === 0 || trips.length === 0) return [];
  const section = sections[0];
  const variant = variantOf(section, rules);
  if (!asksFares(criteria) && variant !== 'unrequestedFares') return [];
  const day = trips[0].startTime.slice(0, 10);
  const seed = hashOf(`${section.startPlace.stopPlaceRef}|${section.endPlace.stopPlaceRef}`);
  const baseCents = 800 + (seed.readUInt16BE(0) % 4200);
  const clusters = rules.clusters.filter((c) => CLUSTERS.includes(c));
  const createdOn = new Date(nowMs).toISOString();
  return clusters.map((cluster) => {
    const priceCents = Math.round(baseCents * CLUSTER_FACTOR[cluster] * provider.priceFactor);
    const fares = passengers
      .filter((p, i) => !(variant === 'passengerWithoutFare' && i === passengers.length - 1))
      .flatMap((passenger) => faresOfPassenger(passenger, section, {
        variant, cluster, clusters, day, provider,
        priceCents: isFree(passenger, day, rules) ? 0 : priceCents,
      }));
    for (const fare of fares) applyClusterVariant(fare, variant);
    return {
      offerId: `${provider.idPrefix}-FOF-${randomId()}`,
      summary: `${provider.name} ${cluster.replace('_', ' ').toLowerCase()} fares, ${stopName(section.startPlace.stopPlaceRef)} - ${stopName(section.endPlace.stopPlaceRef)}`,
      createdOn,
      preBookableUntil: new Date(nowMs + lifetimeMs).toISOString(),
      passengerRefs: passengers.map((p) => p.externalRef),
      fares,
    };
  });
}

module.exports = { fareOffersOf, sectionsOf, asksFares, CLUSTERS };
