/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * bookedAsOffered.js — a booked part against the offer part it was booked
 * from, member by member (#1300).
 *
 * osdm.io, Processes, "Creating a Booking Based on Offers": the booked offers
 * "should look a lot like the offers as they were in the offer responses",
 * but for the places assigned. "Price changes when creating a booking": the
 * price of an offer "is not guaranteed before the pre-booking step"; the
 * booked parts are given "but have a different price", and "A warning
 * (OFFER_PART_PRICE_CHANGE) should be added in the reply". "Handling Partial
 * Success of Pre-Booking": booked resources are assumed to have other ids
 * than the offer's, passengers keep their references. So products are
 * compared by what they are (code, flexibility, classes) and passengers by
 * `externalRef`.
 *
 * The parts are paired by content first (`pairOfferParts()`, bookings.js,
 * #550). Each difference found here is a WARNING line, never a test: OSDM
 * allows a price change, and the other members are optional on a booked part.
 *
 * Pure module: no Bruno globals.
 */

function list(v) { return Array.isArray(v) ? v.filter((x) => x != null) : []; }

const PRICE_CHANGE = 'OFFER_PART_PRICE_CHANGE';

/** True when an answer's problems or (deprecated) warnings say OFFER_PART_PRICE_CHANGE. */
function priceChangeSaid(body) {
  const w = body?.warnings;
  let warnings = [];
  if (Array.isArray(w)) warnings = w;
  else if (Array.isArray(w?.warnings)) warnings = w.warnings;
  return [...list(body?.problems), ...list(warnings)]
    .some((p) => typeof p?.code === 'string' && (p.code === PRICE_CHANGE || p.code.endsWith(`:${PRICE_CHANGE}`) || p.code.endsWith(`/${PRICE_CHANGE}`)));
}

// A price as a value: its amount at its scale (OSDM's default scale is 2).
function valueOf(price) {
  if (!price || typeof price.amount !== 'number') return null;
  const scale = typeof price.scale === 'number' ? price.scale : 2;
  return { amount: price.amount / 10 ** scale, currency: price.currency ?? null };
}
const priceText = (price) => `${price.amount} ${price.currency ?? ''} (scale ${price.scale ?? 2})`.replace('  ', ' ');

function priceFinding(offerPart, bookedPart, ctx) {
  const o = valueOf(offerPart?.price);
  const b = valueOf(bookedPart?.price);
  if (!o || !b) return null;
  const fee = ctx.fees?.[offerPart?.id];
  const withFee = typeof fee === 'number' ? { amount: (offerPart.price.amount + fee) / 10 ** (offerPart.price.scale ?? 2), currency: o.currency } : null;
  const same = (x) => x && x.currency === b.currency && Math.abs(x.amount - b.amount) < 1e-9;
  if (same(o) || same(withFee)) return null;
  const said = ctx.priceChangeSaid
    ? 'the provider said OFFER_PART_PRICE_CHANGE when booking, as OSDM asks'
    : 'the booking answer did not say OFFER_PART_PRICE_CHANGE, which OSDM asks for a price changed at pre-booking';
  return `the price changed: the offer said ${priceText(offerPart.price)}, the booking says ${priceText(bookedPart.price)} (${said})`;
}

function instant(v) {
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function validityFindings(offerPart, bookedPart) {
  return ['validFrom', 'validUntil'].flatMap((key) => {
    const o = instant(offerPart?.[key]);
    const b = instant(bookedPart?.[key]);
    return o !== null && b !== null && o !== b ? [`${key} is ${bookedPart[key]}, the offer said ${offerPart[key]}`] : [];
  });
}

// The product of a part: its summaryProductId, else its first product.
function productIdOf(part) {
  if (typeof part?.summaryProductId === 'string' && part.summaryProductId !== '') return part.summaryProductId;
  const first = list(part?.products).find((p) => typeof p?.productId === 'string');
  return first ? first.productId : null;
}

const serviceClassOf = (product) => product?.serviceClass?.type ?? product?.serviceClass ?? null;

// The members of a product compared, each with its words (booked value first).
const PRODUCT_MEMBERS = [
  { read: (p) => p?.code, say: (b, o) => `another product: ${b}, the offer sold ${o}` },
  { read: (p) => p?.flexibility, say: (b, o) => `flexibility ${b}, the offer sold ${o}` },
  { read: (p) => p?.travelClass, say: (b, o) => `travel class ${b}, the offer sold ${o}` },
  { read: serviceClassOf, say: (b, o) => `service class ${JSON.stringify(b)}, the offer sold ${JSON.stringify(o)}` },
];

/** What differs between the product sold and the product booked, as words. */
function productDifferences(sold, booked) {
  return PRODUCT_MEMBERS.flatMap(({ read, say }) => {
    const o = read(sold);
    const b = read(booked);
    return o != null && b != null && JSON.stringify(o) !== JSON.stringify(b) ? [say(b, o)] : [];
  });
}

const noFinding = () => ({ warn: [], info: [] });

function productFindings(offerPart, bookedPart, ctx) {
  const oId = productIdOf(offerPart);
  const bId = productIdOf(bookedPart);
  if (!oId && !bId) return noFinding();
  if (!oId || !bId) {
    const [side, other] = oId ? ['offer', 'booking'] : ['booking', 'offer'];
    return { warn: [`the product is named in the ${side} (${oId || bId}) but not in the ${other}`], info: [] };
  }
  const o = list(ctx.offerProducts).find((p) => p?.id === oId);
  const b = list(ctx.bookedProducts).find((p) => p?.id === bId);
  if (o && b) return { warn: productDifferences(o, b), info: [] };
  if (oId === bId) return noFinding();
  const [holder, missing] = o ? ['booked offer', bId] : ['offer', oId];
  return { warn: [], info: [`the product ids differ (offer ${oId}, booking ${bId}) and the ${holder} gives no product ${missing} to compare them by`] };
}

// Text in a stable order, for the messages.
const byText = (a, b) => a.localeCompare(b);

/** True when two lists hold the same values as often (order aside). */
function sameMembers(a, b) {
  if (a.length !== b.length) return false;
  const count = new Map();
  a.forEach((v) => count.set(v, (count.get(v) || 0) + 1));
  return b.every((v) => {
    const left = count.get(v) || 0;
    count.set(v, left - 1);
    return left > 0;
  });
}

function coverageFindings(offerPart, bookedPart) {
  const o = offerPart?.tripCoverage;
  const b = bookedPart?.tripCoverage;
  if (!o && !b) return [];
  if (!o || !b) return [`a trip coverage is in the ${o ? 'offer' : 'booking'} but not in the ${o ? 'booking' : 'offer'}`];
  if (o.coveredTripId !== b.coveredTripId) return [];
  const ol = list(o.coveredLegIds).map(String);
  const bl = list(b.coveredLegIds).map(String);
  if (ol.length === 0 || bl.length === 0 || sameMembers(ol, bl)) return [];
  return [`it covers legs ${[...bl].sort(byText).join(', ')} of trip ${b.coveredTripId}, the offer part ${[...ol].sort(byText).join(', ')}`];
}

function passengerFindings(offerPart, bookedPart, ctx) {
  const refs = list(offerPart?.passengerRefs).map(String);
  const ids = list(bookedPart?.passengerIds).map(String);
  if (refs.length === 0 || ids.length === 0) return [];
  const refOf = ctx.passengerRefs || {};
  if (!ids.every((id) => typeof refOf[id] === 'string')) return [];
  const booked = ids.map((id) => refOf[id]);
  if (sameMembers(booked, refs)) return [];
  return [`it is for passengers ${[...booked].sort(byText).join(', ')} (by externalRef), the offer part for ${[...refs].sort(byText).join(', ')}`];
}

/**
 * The differences of one pair, as { warn: string[], info: string[] }.
 *
 * @param {object} offerPart, bookedPart  the pair (pairOfferParts())
 * @param {object} ctx  { offerProducts, bookedProducts, passengerRefs (booked
 *                      passenger id → externalRef), fees (offer part id →
 *                      named place fee, #766), priceChangeSaid }
 */
function pairFindings(offerPart, bookedPart, ctx = {}) {
  const product = productFindings(offerPart, bookedPart, ctx);
  const warn = [
    priceFinding(offerPart, bookedPart, ctx),
    ...validityFindings(offerPart, bookedPart),
    ...product.warn,
    ...coverageFindings(offerPart, bookedPart),
    ...passengerFindings(offerPart, bookedPart, ctx),
  ].filter(Boolean);
  return { warn, info: product.info };
}

/** The context of a booking: its products, its passengers' references. */
function contextOf(selectedOffer, booking, extra = {}) {
  const passengerRefs = {};
  list(booking?.passengers).forEach((p) => {
    if (typeof p?.id === 'string' && p.externalRef != null && p.externalRef !== '') passengerRefs[p.id] = String(p.externalRef);
  });
  return {
    offerProducts: list(selectedOffer?.products),
    bookedProducts: list(booking?.bookedOffers).flatMap((bo) => list(bo?.products)),
    passengerRefs,
    ...extra,
  };
}

module.exports = { PRICE_CHANGE, priceChangeSaid, pairFindings, contextOf, productIdOf };
