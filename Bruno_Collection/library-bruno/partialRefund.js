'use strict';

/**
 * partialRefund.js — resolve the OSDM `RefundSpecification[]` payload for a
 * partial refund (issue #218).
 *
 * Background
 * ──────────
 * OSDM v3.8 added `RefundOfferRequest.refundSpecifications[]` so a distributor
 * can scope the requested refund to a subset of the booking:
 *   - fulfillmentId  REQUIRED  the fulfillment the partial scope applies to
 *   - bookingPartIds OPTIONAL  ids of booking parts to remove (per-leg axis)
 *   - passengerIds   OPTIONAL  ids of passengers  to remove (per-passenger axis)
 *   - refundFee      OPTIONAL  distributor-defined fee override (unused today)
 *
 * Provider modelling differences
 * ──────────────────────────────
 * Providers don't agree on how a booking gets carved up:
 *
 *   * Paxone — one fulfillment **per passenger**; each fulfillment carries the
 *     booking parts that belong to that passenger across all legs. So a
 *     4-pax / 2-leg booking has 4 fulfillments and the passenger-target maps
 *     to picking the matching fulfillment.id.
 *
 *   * Bileto / Sqills — one fulfillment per booking; passenger and leg
 *     scoping live entirely in bookingPartIds[].
 *
 * The original resolver picked `booking.fulfillments[0].id` unconditionally —
 * fine for Bileto / Sqills, wrong for Paxone when the chosen passenger isn't
 * the one bound to fulfillments[0]. This rewrite picks the fulfillment by
 * matching `fulfillment.fulfillmentParts[].passengerRef` against the chosen
 * passenger's `externalRef` (with a fallback to fulfillments[0] for single-
 * fulfillment bookings).
 *
 * Leg ordering
 * ────────────
 * The original resolver flattened `bookedOffers[].admissions[]` and treated
 * that flat list as the leg-list. On a multi-pax booking the flat list is
 * actually `legs × passengers`, so "last admission by index" was almost never
 * the user-visible "last leg". This rewrite:
 *   1. Reads `booking.trips[*].legs[*].id` in trip order — that's the
 *      authoritative leg ordering the wizard's "first/last/outbound/inbound"
 *      labels refer to.
 *   2. Picks one legId from that ordered list.
 *   3. Collects every admission whose `tripCoverage.coveredLegIds` contains
 *      the picked legId.
 *
 * Pax × Leg intersection
 * ──────────────────────
 * When BOTH axes are armed, we restrict the admission collection to the
 * intersection: admissions covering the chosen leg AND owned by the chosen
 * passenger. The original code resolved the two axes independently and the
 * resulting `bookingPartIds` + `passengerIds` could disagree on the subject
 * (#218 report).
 *
 * Booking-part expansion
 * ──────────────────────
 * For each chosen admission, OSCAR walks:
 *   - `admission.reservationRefs[].id` → reservation ids
 *   - `admission.ancillaryRefs[].id`   → ancillary  ids
 *
 * The original code looked for `requiredAdmissionKey | admissionRef |
 * admissionId` on the reservation/ancillary side, which is the reverse of how
 * Paxone / OSDM model the linkage. The result was reservations/ancillaries
 * were never added — the partial scope refunded an admission while leaving
 * its dependent parts orphaned in the booking.
 *
 * Degradation
 * ───────────
 * When the booking can't satisfy the requested scope (single-leg trip while
 * per-leg is armed, single-pax booking while per-pax is armed, fulfillment
 * lookup fails) this helper returns `{ degraded: true, reason: "..." }` and
 * the caller (10.yml's before-request) logs a [WARNING] + sets
 * `__partialRefundDegradedToFull`. The full-refund happy path runs in that
 * case — user requirement (#218).
 */

require('./displays.js');

module.exports = {
  resolvePartialRefundScope,
  buildRefundSpecifications,
};

// ── helpers ────────────────────────────────────────────────────────────────

// Pick "first" or "last" from an array.
function pickFromArray(arr, sel) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return (String(sel || 'first').toLowerCase() === 'last') ? arr[arr.length - 1] : arr[0];
}

// Map "outbound" / "inbound" onto first / last for single-trip lists.
// For multi-trip bookings (return-trip with separate outbound + inbound
// Trip objects), the wizard intends each trip = one direction; we follow
// the same convention here.
function normaliseLegSelector(sel) {
  switch (String(sel || 'first').toLowerCase()) {
    case 'first':    return 'first';
    case 'last':     return 'last';
    case 'outbound': return 'first';
    case 'inbound':  return 'last';
    default:         return 'first';
  }
}

// Return the ordered list of legIds across all trips (preserves trip order
// then leg order within each trip). Trips that don't expose legs are skipped.
function collectLegIds(booking) {
  const legIds = [];
  const trips = Array.isArray(booking && booking.trips) ? booking.trips : [];
  for (const t of trips) {
    const legs = Array.isArray(t && t.legs) ? t.legs : [];
    for (const l of legs) { if (l && l.id) legIds.push(String(l.id)); }
  }
  return legIds;
}

// Return the ordered passenger list from booking.passengers[]. Each entry is
// `{ id, externalRef }`; both are required for the resolver to match an
// admission (id) and a fulfillment (externalRef via fulfillmentParts).
function collectPassengers(booking) {
  const out = [];
  const pax = Array.isArray(booking && booking.passengers) ? booking.passengers : [];
  for (const p of pax) {
    if (!p) continue;
    out.push({ id: p.id || null, externalRef: p.externalRef || null });
  }
  return out;
}

// Find the fulfillment whose fulfillmentParts[].passengerRef references the
// chosen passenger's externalRef. Falls back to fulfillments[0] when no match
// (single-fulfillment-per-booking providers — Bileto, Sqills).
function findFulfillmentForPassenger(fulfillments, externalRef) {
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) return null;
  if (externalRef) {
    const match = fulfillments.find(f => {
      const parts = Array.isArray(f && f.fulfillmentParts) ? f.fulfillmentParts : [];
      return parts.some(fp => fp && String(fp.passengerRef) === String(externalRef));
    });
    if (match) return match;
  }
  return fulfillments[0] || null;
}

// Flatten admissions across all bookedOffers, preserving offer order.
function collectAdmissions(booking) {
  const out = [];
  const bookedOffers = Array.isArray(booking && booking.bookedOffers) ? booking.bookedOffers : [];
  for (const bo of bookedOffers) {
    const adms = Array.isArray(bo && bo.admissions) ? bo.admissions : [];
    for (const a of adms) { if (a && a.id) out.push({ ...a, _bo: bo }); }
  }
  return out;
}

// Walk admission.reservationRefs / ancillaryRefs and return the id arrays.
// Spec calls these "refs to sibling booking-part ids" — they are NOT the
// admission's own id.
function expandAdmissionRefs(admission) {
  const out = { reservationIds: [], ancillaryIds: [] };
  const resRefs = Array.isArray(admission && admission.reservationRefs) ? admission.reservationRefs : [];
  for (const r of resRefs) {
    if (r && r.id) out.reservationIds.push(String(r.id));
    else if (typeof r === 'string') out.reservationIds.push(r);
  }
  const ancRefs = Array.isArray(admission && admission.ancillaryRefs) ? admission.ancillaryRefs : [];
  for (const a of ancRefs) {
    if (a && a.id) out.ancillaryIds.push(String(a.id));
    else if (typeof a === 'string') out.ancillaryIds.push(a);
  }
  return out;
}

// ── public API ─────────────────────────────────────────────────────────────

/**
 * Inspect a booking response and return the resolved partial-refund scope, or
 * a degradation marker. The caller decides whether to log a WARNING and
 * degrade to full refund.
 *
 * @param {object} booking  booking object (with bookedOffers[] / fulfillments[]
 *                          / trips[] / passengers[])
 * @param {object} opts     { byLeg, byPax, legSel, paxSel }
 * @returns {object} one of:
 *   { armed: false }                                 — nothing to scope
 *   { armed: true, degraded: true, reason: '...' }   — can't fulfil request
 *   { armed: true, degraded: false,
 *     fulfillmentId, bookingPartIds, passengerIds,
 *     chosenLegId, chosenPassenger }                 — ready to send
 */
function resolvePartialRefundScope(booking, opts) {
  opts = opts || {};
  const byLeg = !!opts.byLeg;
  const byPax = !!opts.byPax;
  if (!byLeg && !byPax) return { armed: false };

  const fulfillments = (booking && Array.isArray(booking.fulfillments)) ? booking.fulfillments : [];
  if (fulfillments.length === 0) {
    return { armed: true, degraded: true, reason: 'booking has no fulfillments — cannot scope RefundSpecification.fulfillmentId' };
  }

  const bookedOffers = (booking && Array.isArray(booking.bookedOffers)) ? booking.bookedOffers : [];
  if (bookedOffers.length === 0) {
    return { armed: true, degraded: true, reason: 'booking has no bookedOffers — cannot resolve partial-refund scope' };
  }

  const passengers = collectPassengers(booking);
  const legIds     = collectLegIds(booking);
  const allAdms    = collectAdmissions(booking);

  // ── Pick the passenger (drives both pax id and fulfillment selection) ────
  let chosenPassenger = null;
  if (byPax) {
    if (passengers.length < 2) {
      return { armed: true, degraded: true, reason: `booking has only ${passengers.length} passenger(s) — per-passenger partial refund requires >=2` };
    }
    chosenPassenger = pickFromArray(passengers, opts.paxSel);
    if (!chosenPassenger || !chosenPassenger.id) {
      return { armed: true, degraded: true, reason: 'passenger selection resolved to a row with no id — cannot scope' };
    }
  }

  // ── Pick the leg ─────────────────────────────────────────────────────────
  let chosenLegId = null;
  if (byLeg) {
    if (legIds.length < 2) {
      return { armed: true, degraded: true, reason: `booking has only ${legIds.length} leg(s) — per-leg partial refund requires >=2` };
    }
    chosenLegId = pickFromArray(legIds, normaliseLegSelector(opts.legSel));
    if (!chosenLegId) {
      return { armed: true, degraded: true, reason: 'leg selection resolved to null — cannot scope' };
    }
  }

  // ── Resolve fulfillment by passenger externalRef ─────────────────────────
  // When per-pax is NOT armed, fall through to fulfillments[0] (the only
  // sensible default for single-fulfillment-per-booking providers; for
  // multi-fulfillment providers there is no canonical "all-pax" fulfillment
  // to point at, so the caller's expected payload is a single representative
  // entry — full refund still operates via the unchanged fulfillmentIds[]).
  const chosenFulfillment = chosenPassenger
    ? findFulfillmentForPassenger(fulfillments, chosenPassenger.externalRef)
    : fulfillments[0];
  if (!chosenFulfillment || !chosenFulfillment.id) {
    return { armed: true, degraded: true, reason: 'could not resolve a fulfillment matching the chosen passenger — refusing to scope blindly' };
  }

  // ── Collect admissions matching (leg ∩ pax) ──────────────────────────────
  let scopedAdms = allAdms;
  if (chosenLegId) {
    scopedAdms = scopedAdms.filter(a => {
      const covered = a && a.tripCoverage && Array.isArray(a.tripCoverage.coveredLegIds)
        ? a.tripCoverage.coveredLegIds.map(String)
        : [];
      return covered.includes(String(chosenLegId));
    });
  }
  if (chosenPassenger && chosenPassenger.id) {
    scopedAdms = scopedAdms.filter(a => {
      const owners = Array.isArray(a && a.passengerIds) ? a.passengerIds.map(String) : [];
      return owners.includes(String(chosenPassenger.id));
    });
  }

  // It's legitimate for the intersection to be empty when the scope is
  // unsatisfiable (e.g. asking for the inbound leg of a booking the chosen
  // passenger isn't on); degrade rather than send a leg-less, parts-less
  // RefundSpecification that Paxone would reinterpret as "everything".
  if (scopedAdms.length === 0) {
    return { armed: true, degraded: true, reason: 'no admission matches the requested (leg, passenger) intersection — booking does not support the requested scope' };
  }

  // ── Expand each scoped admission into bookingPartIds ─────────────────────
  const bookingPartIds = [];
  for (const a of scopedAdms) {
    bookingPartIds.push(String(a.id));
    const refs = expandAdmissionRefs(a);
    for (const r of refs.reservationIds) bookingPartIds.push(r);
    for (const r of refs.ancillaryIds)   bookingPartIds.push(r);
  }
  // Dedupe while preserving order (admissions can share a reservation
  // when modelled as a single trip-wide booking part on some providers).
  const seen = new Set();
  const deduped = [];
  for (const id of bookingPartIds) {
    if (!seen.has(id)) { seen.add(id); deduped.push(id); }
  }

  const passengerIds = chosenPassenger ? [chosenPassenger.id] : [];

  return {
    armed: true,
    degraded: false,
    fulfillmentId: chosenFulfillment.id,
    bookingPartIds: deduped,
    passengerIds,
    chosenLegId,
    chosenPassenger,
  };
}

/**
 * Build the `refundSpecifications[]` array to attach to a RefundOfferRequest.
 * Returns `null` when the scope cannot be satisfied (caller degrades to full
 * refund) or `[]`-with-one-entry when ready.
 *
 * @param {object} booking
 * @param {object} opts  same shape as resolvePartialRefundScope
 * @returns {Array|null}
 */
function buildRefundSpecifications(booking, opts) {
  const r = resolvePartialRefundScope(booking, opts);
  if (!r.armed || r.degraded) return null;

  const spec = { fulfillmentId: r.fulfillmentId };
  if (r.bookingPartIds.length > 0) spec.bookingPartIds = r.bookingPartIds;
  if (r.passengerIds.length   > 0) spec.passengerIds   = r.passengerIds;
  return [spec];
}

// Expose to globalThis for the eval/require loader path (matches other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] partialRefund globalThis exposure skipped: ' + (e && e.message));
}
