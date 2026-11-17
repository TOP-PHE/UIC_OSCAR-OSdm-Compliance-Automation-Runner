/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * confirmedFulfillments.js — the fulfilments the confirmation gave (#1045,
 * from a real provider's fare run).
 *
 * Step 06 (POST /bookings/{id}/fulfillments) answers the fulfilments it made,
 * and OSCAR keeps them: a provider may leave them out of the booking it gives
 * at 07. OSDM does not require Booking.fulfillments (the Booking's required
 * members are id, createdOn and passengers), though GET /bookings/{id} embeds
 * ALL by default. At 07:
 *   - a booking that lists none of them, or not all, is a WARNING, and what
 *     follows (the refund or the exchange) names the confirmation's;
 *   - a refund or exchange with no fulfilment id from either step ends there,
 *     with one failed check: OSDM's RefundOfferRequest and
 *     ExchangeOfferCollectionRequest need at least one fulfillmentId
 *     (minItems 1), and a request without one tests nothing.
 * At every booking read after 07 (refund 12, 14, 16; exchange 13, 15, 17,
 * which ask embed=ALL), a fulfilment seen before and no longer listed is a
 * WARNING too (#1298): the confirmation's, 07's and an exchange's.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

function list(v) { return Array.isArray(v) ? v.filter((x) => x != null) : []; }

/** The ids of fulfilments, as given. */
function idsOf(fulfillments) {
  return list(fulfillments).map((f) => f?.id).filter((id) => typeof id === 'string' && id !== '');
}

/**
 * What OSCAR keeps of each fulfilment of the confirmation: its id, status, the
 * parts it names and (#1208, OSDM 3.11) the fares its billing references name
 * by their accounting reference.
 */
function keptOf(fulfillments) {
  return list(fulfillments).filter((f) => typeof f?.id === 'string' && f.id !== '').map((f) => {
    const kept = {
      id: f.id,
      status: f.status ?? null,
      bookingParts: list(f.bookingParts).map((p) => p?.id).filter((id) => typeof id === 'string').map((id) => ({ id })),
    };
    const references = list(f.billingReferences).filter((r) => r?.accountingRef && typeof r.accountingRef === 'object').map((r) => ({ accountingRef: r.accountingRef }));
    if (references.length > 0) kept.billingReferences = references;
    return kept;
  });
}

const LIST_CHECK = 'The booking read after the confirmation lists the fulfilments the confirmation gave';

/**
 * The booking read after the confirmation against the confirmation's
 * fulfilments: { name, ok, message }, or null when the confirmation gave none.
 */
function bookingListCheck(bookingFulfillments, confirmed) {
  const given = idsOf(confirmed);
  if (given.length === 0) return null;
  const listed = new Set(idsOf(bookingFulfillments));
  const missing = given.filter((id) => !listed.has(id));
  if (missing.length === 0) return { name: LIST_CHECK, ok: true };
  const what = listed.size === 0 ? 'it lists no fulfilment' : `it does not list ${missing.join(', ')}`;
  return {
    name: LIST_CHECK,
    ok: false,
    message: `${what}, though the confirmation gave ${given.join(', ')}. OSCAR goes on with the confirmation's fulfilments `
      + '(OSDM does not require Booking.fulfillments, but GET /bookings/{id} embeds ALL by default)',
  };
}

const STILL_CHECK = 'The booking still lists the fulfilments given before';

/**
 * #1298: a booking read after 07 (refund 12, 14, 16; exchange 13, 15, 17)
 * against the fulfilment ids seen so far: the confirmation's, those 07
 * listed, those an exchange's confirmation gave. The text of the WARNING, or
 * null when none was seen or all are listed. A fulfilment refunded or
 * exchanged stays in the booking, in state REFUNDED or EXCHANGED.
 */
function stillListedMessage(bookingFulfillments, seen, step) {
  const ids = [...new Set(list(seen).filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return null;
  const listed = idsOf(bookingFulfillments);
  const missing = ids.filter((id) => !listed.includes(id));
  if (missing.length === 0) return null;
  const what = listed.length === 0
    ? 'the booking lists no fulfilment'
    : `the booking no longer lists ${missing.join(', ')} (it lists ${listed.join(', ')})`;
  return `${step}: ${what}, though ${ids.join(', ')} ${ids.length === 1 ? 'was' : 'were'} given before `
    + '(by the confirmation or an earlier booking read). OSDM does not require Booking.fulfillments, but this read asks embed=ALL';
}

/** The fulfilments a refund or exchange names: the booking's when it lists some, else the confirmation's. */
function fulfillmentsInUse(bookingFulfillments, confirmed) {
  return idsOf(bookingFulfillments).length > 0 ? list(bookingFulfillments) : keptOf(confirmed);
}

/** 'refund', 'exchange' or null, from the scenario type. */
function afterSaleOf(scenarioType) {
  const type = String(scenarioType || '').toUpperCase();
  if (type.includes('REFUND')) return 'refund';
  if (type.includes('EXCHANGE')) return 'exchange';
  return null;
}

/** The failed check of a refund or exchange with no fulfilment id to name, or null. */
function nothingToNameCheck(scenarioType, ids) {
  const kind = afterSaleOf(scenarioType);
  if (!kind || list(ids).length > 0) return null;
  return {
    name: `A fulfilment to name in the ${kind} offer request`,
    ok: false,
    message: `neither the confirmation (POST /fulfillments) nor the booking read after it gave a fulfilment id; `
      + `the ${kind} offer request needs at least one (OSDM: fulfillmentIds, minItems 1), so the scenario ends here`,
  };
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readJson(name, fallback) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null') ?? fallback; } catch { return fallback; }
}

/** Step 06: keep the fulfilments the confirmation gave (none when it gave none). */
function keepConfirmation(body) {
  bru.setEnvVar('__confirmedFulfillments', JSON.stringify(keptOf(body?.fulfillments)));
  // #1298: a new confirmation starts what later booking reads are held to.
  bru.setEnvVar('__fulfillmentIdsSeen', JSON.stringify(idsOf(body?.fulfillments)));
}

/** #1298: the fulfilment ids seen so far in this sale. */
function seenFulfillmentIds() {
  return list(readJson('__fulfillmentIdsSeen', [])).filter((id) => typeof id === 'string');
}

/** #1298: add the ids of these fulfilments to those later booking reads are held to. */
function rememberFulfillments(fulfillments) {
  bru.setEnvVar('__fulfillmentIdsSeen', JSON.stringify([...new Set([...seenFulfillmentIds(), ...idsOf(fulfillments)])]));
}

/**
 * #1298: refund 12, 14, 16 and exchange 13, 15, 17: the WARNING when the
 * booking does not list every fulfilment seen before.
 */
function checkBookingStillLists(booking, step) {
  const message = stillListedMessage(booking?.fulfillments, seenFulfillmentIds(), step);
  if (message) require('./displays.js').validationLogger(`[WARNING] ${STILL_CHECK} — ${message}.`);
}

/** The fulfilments step 06 kept. */
function confirmedFulfillments() {
  return list(readJson('__confirmedFulfillments', []));
}

/**
 * Step 07: the WARNING when the booking does not list the confirmation's
 * fulfilments. Returns the fulfilments a refund or exchange names.
 */
function checkBookingLists(booking) {
  const confirmed = confirmedFulfillments();
  const c = bookingListCheck(booking?.fulfillments, confirmed);
  if (c && !c.ok) require('./displays.js').validationLogger(`[WARNING] ${c.name} — ${c.message}`);
  rememberFulfillments(booking?.fulfillments);
  return fulfillmentsInUse(booking?.fulfillments, confirmed);
}

/**
 * Step 07, before a refund or an exchange: true when no fulfilment id is
 * known, after one failed check and the end of the scenario.
 */
function stopWithoutFulfillment(ids) {
  const c = nothingToNameCheck(bru.getEnvVar('scenarioType'), ids);
  if (!c) return false;
  test(c.name, () => { throw new Error(c.message); });
  require('./loopback.js').loopbackOrStop('GET Booking after Fulfillments (no fulfilment to name)');
  return true;
}

module.exports = {
  idsOf, keptOf, bookingListCheck, fulfillmentsInUse, afterSaleOf, nothingToNameCheck, stillListedMessage,
  keepConfirmation, confirmedFulfillments, checkBookingLists, stopWithoutFulfillment, LIST_CHECK,
  seenFulfillmentIds, rememberFulfillments, checkBookingStillLists, STILL_CHECK,
};
