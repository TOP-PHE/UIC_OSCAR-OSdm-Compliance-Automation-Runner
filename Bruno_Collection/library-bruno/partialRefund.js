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
 * Per the OSDM v3.8 semantics, `bookingPartIds` and `passengerIds` are
 * orthogonal filters the provider applies to the booking:
 *   - bookingPartIds only           → refund these parts (any passenger they cover)
 *   - passengerIds   only           → refund this passenger's parts (any leg)
 *   - both                          → refund the intersection
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
 * passenger's `externalRef`, with a fallback to fulfillments[0] for single-
 * fulfillment bookings (or when the matching info isn't present).
 *
 * Leg ordering
 * ────────────
 * The original resolver flattened `bookedOffers[].admissions[]` and treated
 * that flat list as the leg-list. On a multi-pax booking the flat list is
 * actually `legs × passengers`, so "last admission by index" was almost never
 * the user-visible "last leg". This rewrite prefers the authoritative ordering
 * from `booking.trips[*].legs[*].id` (the wizard's "first / last / outbound /
 * inbound" labels refer to those) and groups admissions by
 * `tripCoverage.coveredLegIds`.
 *
 * Legacy / minimal fixtures (single admission per leg, no trips[]/legs[],
 * no tripCoverage on admissions) fall back to "admissions in offer order are
 * the leg list" — the historical contract documented in the unit tests.
 *
 * Pax × Leg intersection
 * ──────────────────────
 * When BOTH axes are armed, we restrict the admission collection to the
 * intersection: admissions covering the chosen leg AND owned by the chosen
 * passenger (when admissions expose `passengerIds[]`). The original code
 * resolved the two axes independently and the resulting `bookingPartIds` +
 * `passengerIds` could disagree on the subject (#218 report).
 *
 * Booking-part expansion
 * ──────────────────────
 * For each chosen admission, OSCAR walks:
 *   - `admission.reservationRefs[].id` → reservation ids   (Paxone / v3.8)
 *   - `admission.ancillaryRefs[].id`   → ancillary  ids   (Paxone / v3.8)
 *
 * For minimal fixtures where the linkage lives on the *sibling* side, we
 * additionally walk the bookedOffer's reservations[] and ancillaries[] for
 * `requiredAdmissionKey | admissionRef | admissionId` pointing back at the
 * chosen admission.id. The two paths are unioned (no double-count via the
 * dedupe at the end).
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
function normaliseLegSelector(sel) {
  switch (String(sel || 'first').toLowerCase()) {
    case 'first':    return 'first';
    case 'last':     return 'last';
    case 'outbound': return 'first';
    case 'inbound':  return 'last';
    default:         return 'first';
  }
}

// Return the ordered list of legIds. Prefers `booking.trips[*].legs[*].id`
// (authoritative). Falls back to using admissions[].id (legacy minimal shape)
// when no trips[].legs are present — the contract the original code relied on.
function collectLegIds(booking, allAdmissions) {
  const fromTrips = [];
  const trips = Array.isArray(booking && booking.trips) ? booking.trips : [];
  for (const t of trips) {
    const legs = Array.isArray(t && t.legs) ? t.legs : [];
    for (const l of legs) { if (l && l.id) fromTrips.push(String(l.id)); }
  }
  if (fromTrips.length > 0) return { ids: fromTrips, mode: 'trips' };
  // Legacy fallback: each admission = one leg, in offer order.
  const fromAdms = (allAdmissions || []).map(a => String(a.id));
  return { ids: fromAdms, mode: 'admissions' };
}

// Return the ordered passenger list from booking.passengers[]. Each entry is
// `{ id, externalRef }`; both are kept (id is what we put in passengerIds[],
// externalRef is what we match against fulfillmentParts).
function collectPassengers(booking) {
  const out = [];
  const pax = Array.isArray(booking && booking.passengers) ? booking.passengers : [];
  for (const p of pax) {
    if (!p) continue;
    out.push({ id: p.id || null, externalRef: p.externalRef || null });
  }
  return out;
}

// Find the fulfillment whose fulfillmentParts[].passengerRef matches the
// chosen passenger's externalRef. Falls back to fulfillments[0] when no
// match (single-fulfillment-per-booking providers — Bileto, Sqills — and
// fixtures with no externalRef on passengers).
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

// Flatten admissions across all bookedOffers, preserving offer order. Each
// entry keeps a back-pointer to its bookedOffer for sibling-walk expansion.
function collectAdmissions(booking) {
  const out = [];
  const bookedOffers = Array.isArray(booking && booking.bookedOffers) ? booking.bookedOffers : [];
  for (const bo of bookedOffers) {
    const adms = Array.isArray(bo && bo.admissions) ? bo.admissions : [];
    for (const a of adms) { if (a && a.id) out.push({ ...a, _bo: bo }); }
  }
  return out;
}

// Walk admission.reservationRefs / ancillaryRefs (Paxone / OSDM v3.8 model)
// AND the sibling reservations/ancillaries whose requiredAdmissionKey /
// admissionRef / admissionId references this admission.id (legacy model).
// Union, dedupe at the call site.
function expandAdmissionRefs(admission) {
  const out = { reservationIds: [], ancillaryIds: [] };

  // Forward refs (Paxone / v3.8).
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

  // Reverse refs (legacy: sibling reservations/ancillaries naming the admission).
  const bo = admission && admission._bo;
  if (bo) {
    const admId = String(admission.id);
    const ress  = Array.isArray(bo.reservations) ? bo.reservations : [];
    for (const r of ress) {
      if (!r || !r.id) continue;
      const link = r.requiredAdmissionKey || r.admissionRef || r.admissionId;
      if (link && String(link) === admId) out.reservationIds.push(String(r.id));
    }
    const ancs = Array.isArray(bo.ancillaries) ? bo.ancillaries : [];
    for (const a of ancs) {
      if (!a || !a.id) continue;
      const link = a.admissionRef || a.admissionId || a.ancillaryFor;
      if (link && String(link) === admId) out.ancillaryIds.push(String(a.id));
    }
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
 *                          / optional trips[] / passengers[])
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
    // Phrase the reason so the (legacy) regex `/no fulfillment\.id/` keeps matching.
    return { armed: true, degraded: true, reason: 'booking has no fulfillment.id — cannot scope RefundSpecification' };
  }

  const bookedOffers = (booking && Array.isArray(booking.bookedOffers)) ? booking.bookedOffers : [];
  if (bookedOffers.length === 0) {
    return { armed: true, degraded: true, reason: 'booking has no bookedOffers — cannot resolve partial-refund scope' };
  }

  const passengers = collectPassengers(booking);
  const allAdms    = collectAdmissions(booking);
  const legSrc     = collectLegIds(booking, allAdms);
  const legIds     = legSrc.ids;
  const legMode    = legSrc.mode; // 'trips' or 'admissions'

  // ── Pick the passenger (drives passengerIds + fulfillment selection) ─────
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
      return { armed: true, degraded: true, reason: `booking has fewer than 2 admissions — leg-partial-refund requires a multi-leg booking` };
    }
    chosenLegId = pickFromArray(legIds, normaliseLegSelector(opts.legSel));
    if (!chosenLegId) {
      return { armed: true, degraded: true, reason: 'leg selection resolved to null — cannot scope' };
    }
  }

  // ── Resolve fulfillment by passenger externalRef (else fallback to [0]) ──
  const chosenFulfillment = chosenPassenger
    ? findFulfillmentForPassenger(fulfillments, chosenPassenger.externalRef)
    : fulfillments[0];
  if (!chosenFulfillment || !chosenFulfillment.id) {
    return { armed: true, degraded: true, reason: 'could not resolve a fulfillment.id for the chosen passenger — refusing to scope blindly' };
  }

  // ── Compute bookingPartIds ───────────────────────────────────────────────
  // OSDM v3.8 semantics: `bookingPartIds` is the per-leg axis. We populate it
  // ONLY when the wizard armed the leg axis. Per-pax-only requests leave the
  // field empty so the provider applies the passengerIds filter alone
  // (and refunds every part that belongs to that passenger).
  let bookingPartIds = [];
  if (byLeg) {
    // Filter admissions by chosen leg.
    let scopedAdms = allAdms;
    if (legMode === 'trips') {
      scopedAdms = scopedAdms.filter(a => {
        const covered = a && a.tripCoverage && Array.isArray(a.tripCoverage.coveredLegIds)
          ? a.tripCoverage.coveredLegIds.map(String)
          : [];
        return covered.includes(String(chosenLegId));
      });
    } else {
      // legacy: each admission = one leg, match by admission.id == chosenLegId
      scopedAdms = scopedAdms.filter(a => String(a.id) === String(chosenLegId));
    }

    // When BOTH axes are armed, also intersect with the chosen passenger. We
    // only apply the pax filter when admissions actually expose
    // `passengerIds[]`; minimal fixtures don't, and we mustn't drop everything
    // just because the field is missing.
    if (chosenPassenger && chosenPassenger.id) {
      const filtered = scopedAdms.filter(a => {
        const owners = Array.isArray(a && a.passengerIds) ? a.passengerIds.map(String) : null;
        return owners == null /* unknown ownership → keep */ || owners.includes(String(chosenPassenger.id));
      });
      scopedAdms = filtered;
    }

    if (scopedAdms.length === 0) {
      return { armed: true, degraded: true, reason: 'no admission matches the requested (leg, passenger) intersection — booking does not support the requested scope' };
    }

    for (const a of scopedAdms) {
      bookingPartIds.push(String(a.id));
      const refs = expandAdmissionRefs(a);
      for (const r of refs.reservationIds) bookingPartIds.push(r);
      for (const r of refs.ancillaryIds)   bookingPartIds.push(r);
    }
    // Dedupe while preserving order — admissions can share a sibling part.
    const seen = new Set();
    bookingPartIds = bookingPartIds.filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  const passengerIds = chosenPassenger ? [chosenPassenger.id] : [];

  return {
    armed: true,
    degraded: false,
    fulfillmentId: chosenFulfillment.id,
    bookingPartIds,
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
