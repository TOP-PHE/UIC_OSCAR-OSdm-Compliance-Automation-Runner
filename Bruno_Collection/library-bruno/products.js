/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * products.js — the product (tariff) a scenario expects (#598).
 *
 * A scenario may name the product it expects with `expectedProduct`: the
 * product's code, or else words of its name (Product.summary, then
 * .description, compared without case). The offer step keeps the offers that
 * hold it; when none does, the scenario fails with the list of what was
 * offered and stops. The booking, once fulfilled, must hold the product, and
 * each fulfillment must cover a part of it.
 *
 * #1436: a sale asking product tags (product types) chooses an offer holding
 * one when there is one, and the booking must hold a product of that tag.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-products.test.js.
 */

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const listOf = (value) => (Array.isArray(value) ? value : []);

/**
 * The products of a list that match what the scenario names: those whose code
 * is exactly it, or, when no code is, those whose name contains it.
 */
function matchingProducts(products, wanted) {
  const name = text(wanted);
  if (!name) return [];
  const all = listOf(products).filter((p) => p && typeof p === 'object');
  const byCode = all.filter((p) => text(p.code) === name);
  if (byCode.length > 0) return byCode;
  const lower = name.toLowerCase();
  return all.filter((p) => text(p.summary).toLowerCase().includes(lower) || text(p.description).toLowerCase().includes(lower));
}

// The products of an offer: its own list, which its parts refer to by id.
const productsOfOffer = (offer) => listOf(offer?.products);

/**
 * The offers that hold the expected product. A code match anywhere in the
 * answer wins over a name match, so that a name never pulls in an offer the
 * code would not.
 */
function offersWithProduct(offers, wanted) {
  const all = listOf(offers);
  const everyProduct = all.flatMap(productsOfOffer);
  const matches = new Set(matchingProducts(everyProduct, wanted).map((p) => p.id));
  if (matches.size === 0) return [];
  return all.filter((offer) => productsOfOffer(offer).some((p) => matches.has(p.id)));
}

/** What the answer offered, one entry per product: "CODE (name)". */
function offeredProducts(offers) {
  const seen = new Map();
  for (const p of listOf(offers).flatMap(productsOfOffer)) {
    const key = text(p?.code) || text(p?.id);
    if (key && !seen.has(key)) seen.set(key, text(p.summary) ? `${key} (${text(p.summary)})` : key);
  }
  return [...seen.values()];
}

// The product ids a booked or offered part names: its summary product and
// each of its products.
function productIdsOfPart(part) {
  const ids = listOf(part?.products).map((p) => p?.productId).filter(Boolean);
  if (part?.summaryProductId) ids.push(part.summaryProductId);
  return ids;
}

const bookedParts = (booking) => listOf(booking?.bookedOffers)
  .flatMap((o) => [...listOf(o?.admissions), ...listOf(o?.reservations), ...listOf(o?.ancillaries)]);

/**
 * The checks that a fulfilled booking holds the expected product: a booked
 * offer lists it, and each fulfillment covers a booked part of it.
 * @returns {Array<{name: string, ok: boolean, message?: string}>}
 */
function checkBookingProduct(booking, wanted) {
  const products = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.products));
  const matches = matchingProducts(products, wanted);
  const ids = new Set(matches.map((p) => p.id));
  const checks = [{
    name: `Booking: a booked offer holds the expected product "${text(wanted)}"`,
    ok: matches.length > 0,
    message: matches.length > 0 ? undefined : `booked products: [${offeredProducts(booking?.bookedOffers).join(', ') || 'none'}]`,
  }];
  if (matches.length === 0) return checks;
  const partById = new Map(bookedParts(booking).filter((p) => p?.id).map((p) => [p.id, p]));
  for (const fulfillment of listOf(booking?.fulfillments)) {
    const covered = listOf(fulfillment?.bookingParts).map((ref) => partById.get(ref?.id)).filter(Boolean);
    const ok = covered.some((part) => productIdsOfPart(part).some((id) => ids.has(id)));
    checks.push({
      name: `Fulfillment ${fulfillment?.id}: covers a part of the expected product "${text(wanted)}"`,
      ok,
      message: ok ? undefined : `its booking parts name products [${[...new Set(covered.flatMap(productIdsOfPart))].join(', ') || 'none'}]`,
    });
  }
  return checks;
}

// ── #1436: a sale asking product tags ───────────────────────────────────────
//
// OSDM: "All product types can be used as Product Tags in the search"; the
// other known tags only ask for something (CARD_LOST, TICKET_LOST: the
// replacement of a lost item, checked by lostItems.js; SPLIT_RESERVATION: a
// reservation that may be split). A product is of a tag by its `type` or its
// `productTags` (which OSDM lets a provider leave out outside GET /products).

const SEARCH_ONLY_TAGS = new Set(['CARD_LOST', 'TICKET_LOST', 'SPLIT_RESERVATION']);

/**
 * The product-type tags a request's offerSearchCriteria asks: its
 * `productTags` and the tags of its `productSelections`, each once.
 */
function productTagsAsked(criteria) {
  const tags = [
    ...listOf(criteria?.productTags),
    ...listOf(criteria?.productSelections).map((s) => s?.productTag),
  ].map(text).filter((t) => t && !SEARCH_ONLY_TAGS.has(t));
  return [...new Set(tags)];
}

const isOfTag = (product, tags) => tags.includes(text(product?.type))
  || listOf(product?.productTags).some((t) => tags.includes(text(t)));

/** The offers holding a product of one of the tags. */
function offersWithTag(offers, tags) {
  return listOf(offers).filter((offer) => productsOfOffer(offer).some((p) => isOfTag(p, tags)));
}

// "CODE (type, tags)" of a booked product, for a message.
const productLabel = (p) => {
  const said = [text(p?.type), ...listOf(p?.productTags).map(text)].filter(Boolean);
  return `${text(p?.code) || text(p?.id) || '?'}${said.length > 0 ? ` (${[...new Set(said)].join(', ')})` : ''}`;
};

/**
 * The check that a booking holds a product of the tags asked (maintainer,
 * 2026-11-24: a booking of another product fails). A booking whose products
 * name neither a type nor tags cannot be checked: `level: 'warn'`.
 * @returns {{ name, ok, level?, message? } | null} null when no tag is asked.
 */
function checkBookingTag(booking, tags) {
  if (listOf(tags).length === 0) return null;
  const products = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.products)).filter((p) => p && typeof p === 'object');
  const name = `Booking: a booked offer holds a product of the tag asked (${tags.join(', ')})`;
  const named = products.filter((p) => text(p.type) || listOf(p.productTags).length > 0);
  if (named.length === 0) {
    return { name, ok: false, level: 'warn', message: `cannot be checked: the booked products [${products.map(productLabel).join(', ') || 'none'}] name no type and no product tag` };
  }
  const ok = named.some((p) => isOfTag(p, tags));
  return { name, ok, message: ok ? undefined : `booked products: [${products.map(productLabel).join(', ')}]` };
}

module.exports = {
  matchingProducts, offersWithProduct, offeredProducts, checkBookingProduct,
  SEARCH_ONLY_TAGS, productTagsAsked, offersWithTag, checkBookingTag,
};
