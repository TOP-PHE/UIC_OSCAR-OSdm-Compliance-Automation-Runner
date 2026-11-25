// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * nonTripFares.js — fares sold without a trip (#1449), a theoretical case.
 *
 * OSDM describes online fares as part of an offer for a trip. The OSDM
 * architect's reading (2026-11-25): fares are implicitly trip-related, but a
 * fare could theoretically be sold without a trip, between stop places, in
 * zones and in regions named by NUTS codes; the distributor must then link
 * the trip of its product-based sale to the fare provider's zones.
 *
 * The simulator sells them on every provider whose profile lists
 * `nonTrip.fares`, for any well-expressed request (what nonTrip.nonTripAsked
 * accepts: a zone of GET /zones with its carrier, stop places of GET
 * /places, a NUTS code of a zone): a zone fare (FARE_ZONE) in zones and NUTS
 * regions, a fare between stop places (FARE_POINT2POINT). The tags are the
 * simulator's own; GET /product-tags groups them and GET /products lists
 * each fare with its tag and, in its description, where it is valid. One
 * offer per fare and travel class asked, one fare per passenger, each Fare
 * valid where asked (regionalConstraint.regionalValidities), covering no
 * section and no trip, sold as a separate ticket (SEPARATE_TICKET).
 */

const crypto = require('crypto');
const nonTrip = require('./nonTrip');

const randomId = () => crypto.randomBytes(8).toString('hex');
const hashOf = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

// The after-sales conditions of a fare by its flexibility, as shares of its price.
const AFTER_SALE = {
  FULL_FLEXIBLE: [{ condition: 'REFUND', share: 0 }, { condition: 'EXCHANGE', share: 0 }],
  SEMI_FLEXIBLE: [{ condition: 'REFUND', share: 0.25 }, { condition: 'EXCHANGE', share: 0.1 }],
  NON_FLEXIBLE: [{ condition: 'REFUND', share: 1 }],
};
const CLASS_WORDS = { FIRST: 'first class', SECOND: 'second class' };

/** The kind of request a fare is sold for: a NUTS region is sold what a zone is. */
const byOf = (asked) => (asked.kind === 'places' ? 'PLACES' : 'ZONES');

/** Where the fares asked are valid, in words. */
function whereOf(asked) {
  return asked.kind === 'places' ? `between ${asked.names.join(', ')}` : `in ${asked.names.join(', ')}`;
}

/** The fare tags a request asks (offerSearchCriteria.productTags), among the profile's. */
function fareTagsAsked(criteria, provider) {
  const tags = new Set((provider.nonTrip?.fares || []).map((f) => f.tag));
  const asked = Array.isArray(criteria?.productTags) ? criteria.productTags : [];
  return asked.filter((tag) => tags.has(tag));
}

/** The criteria without the fare tags, for the product selection (it would count them as ignored). */
function withoutFareTags(criteria, provider) {
  const tags = fareTagsAsked(criteria, provider);
  if (!criteria || tags.length === 0) return criteria;
  const rest = criteria.productTags.filter((tag) => !tags.includes(tag));
  const out = { ...criteria };
  if (rest.length > 0) out.productTags = rest;
  else delete out.productTags;
  return out;
}

/** The fares of the profile sold for this request: by its kind, then the tags and flexibilities asked. */
function itemsFor(asked, criteria, provider) {
  const tags = fareTagsAsked(criteria, provider);
  const flexibilities = Array.isArray(criteria?.flexibilities) && criteria.flexibilities.length > 0 ? criteria.flexibilities : null;
  return (provider.nonTrip?.fares || []).filter((item) => item.by.includes(byOf(asked))
    && (tags.length === 0 || tags.includes(item.tag))
    && (!flexibilities || flexibilities.includes(item.flexibility)));
}

/** One passenger's fare. */
function fareOf({ item, passenger, asked, travelClass, priceCents, day, ctx }) {
  const { provider } = ctx;
  const id = `${provider.idPrefix}-FARE-${randomId()}`;
  const price = (amount) => ({ amount, currency: provider.currency, scale: 2 });
  const carrier = provider.carrier.ref;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    id,
    type: 'ADMISSION',
    name: { id: `${provider.idPrefix}-FARE-NAME-${item.code}`, text: item.name },
    description: { id: `${id}-DESCRIPTION`, text: `${item.name}, valid ${whereOf(asked)}, sold without a trip` },
    prices: [price(priceCents)],
    regionalConstraint: { regionalValidities: nonTrip.regionalValiditiesOf(asked, provider) },
    carrierConstraint: { includedCarriers: [carrier] },
    serviceClass: ctx.serviceClassOf(travelClass),
    travelClass,
    afterSalesCondition: {
      conditions: AFTER_SALE[item.flexibility].map((c) => ({ condition: c.condition, afterSaleFee: price(Math.round(priceCents * c.share)) })),
      isProviderFee: true,
    },
    combinationConstraint: [{ model: 'SEPARATE_TICKET' }],
    fulfillmentConstraint: { acceptedControlSecurityTypes: ['SID'], isIndividualTicketingForbidden: false },
    travelValidityConstraint: {
      validTravelDates: { from: `${day}T00:00:00Z`, until: `${next}T00:00:00Z` },
      validityRange: { timeUnit: 'MINUTES', value: item.validityMinutes },
    },
    passengerRefs: [passenger.externalRef],
    involvedTCOs: [carrier],
    accountingRef: { accountingCompany: carrier, accountingIds: [`SIM-NT-${item.code}`] },
  };
}

/**
 * The fare offers of a non-trip request asking fares. `ctx`: { asked,
 * criteria, classes, day (of validFrom, in its own offset), passengers,
 * provider, nowMs, lifetimeMs, serviceClassOf, classFactor }. Priced by the
 * fare's factor, the same for the same places or zones.
 */
function nonTripFareOffersOf(ctx) {
  const { asked, criteria, classes, passengers, provider, nowMs, lifetimeMs } = ctx;
  const items = itemsFor(asked, criteria, provider);
  const seed = hashOf(`non-trip-fare|${asked.key}`);
  const createdOn = new Date(nowMs).toISOString();
  const { day } = ctx;
  return items.flatMap((item) => classes.map((travelClass) => {
    const priceCents = Math.max(1, Math.round((800 + (seed.readUInt16BE(6) % 1200)) * item.factor * ctx.classFactor(travelClass) * provider.priceFactor));
    return {
      offerId: `${provider.idPrefix}-FOF-${randomId()}`,
      summary: `${provider.name} ${item.name.toLowerCase()}, ${CLASS_WORDS[travelClass]}, ${whereOf(asked)}`,
      createdOn,
      preBookableUntil: new Date(nowMs + lifetimeMs).toISOString(),
      passengerRefs: passengers.map((p) => p.externalRef),
      fares: passengers.map((passenger) => fareOf({ item, passenger, asked, travelClass, priceCents, day, ctx })),
    };
  }));
}

/** Where a fare of the profile is valid, in words, for GET /products. */
function validityText(item, provider) {
  if (item.by.includes('PLACES') && !item.by.includes('ZONES')) {
    return 'between two stop places of GET /places';
  }
  const nutsOf = (z) => (z.nutsCodes ? ', NUTS ' + z.nutsCodes.join(', ') : '');
  const zones = (provider.nonTrip?.zones || []).map((z) => `${z.id} (${z.name}${nutsOf(z)})`);
  return `in a zone of GET /zones, or a NUTS region one names: ${zones.join('; ')}`;
}

/** The products of the fares sold without a trip, one per travel class, for GET /products. */
function nonTripFareProductsOf(provider, { classes, serviceClassOf }) {
  return (provider.nonTrip?.fares || []).flatMap((item) => classes.map((travelClass) => ({
    id: `${provider.idPrefix}-PRD-${item.code}-${travelClass}`,
    code: item.code,
    summary: item.name,
    description: `A fare sold without a trip (nonTripSearchCriteria, fare parts), valid ${validityText(item, provider)}.`,
    owner: provider.carrier.ref,
    flexibility: item.flexibility,
    serviceClass: serviceClassOf(travelClass),
    travelClass,
    isTrainBound: false,
    productTags: [item.tag],
  })));
}

module.exports = { nonTripFareOffersOf, nonTripFareProductsOf, fareTagsAsked, withoutFareTags, itemsFor, AFTER_SALE };
