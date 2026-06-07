'use strict';

/**
 * partialRefund.js — resolve the OSDM `RefundSpecification[]` payload for a
 * partial refund (issue #218).
 *
 * The OSDM v3.8 mechanism (RefundOfferRequest.refundSpecifications[]):
 *   - fulfillmentId  REQUIRED   the fulfillment the partial scope applies to
 *   - bookingPartIds OPTIONAL   ids of booking parts to remove (per-leg axis)
 *   - passengerIds   OPTIONAL   ids of passengers  to remove (per-passenger axis)
 *   - refundFee      OPTIONAL   distributor-defined fee override (not used today)
 *
 * Mapping rules used here:
 *   PER-LEG    The booking's bookedOffers[].admissions[] array is treated as
 *              "one entry per leg" (the standard OSDM shape for multi-leg).
 *              For each selected admission, OSCAR collects:
 *                - the admission.id itself
 *                - any reservation.id whose requiredAdmissionKey or
 *                  admissionRef references that admission
 *                - any ancillary.id whose tripCoverage matches
 *              These ids are sent as bookingPartIds[].
 *   PER-PAX    The booking's bookedOffers[].passengerRefs (or booking.passengers
 *              if the bookedOffer reference isn't populated) is treated as the
 *              ordered passenger list. "first" / "last" selects one ref.
 *
 * Degradation:
 *   When the booking can't satisfy the requested scope (single-leg trip while
 *   per-leg is armed; single-pax booking while per-pax is armed), this helper
 *   returns `{ degraded: true, reason: "..." }` and the caller (10.yml's
 *   before-request) logs a [WARNING] + sets __partialRefundDegradedToFull.
 *   The full-refund happy path runs in that case — user requirement (#218).
 */

require('./displays.js');

module.exports = {
  resolvePartialRefundScope,
  buildRefundSpecifications,
};

// Helper: pick "first" or "last" from an array, default first.
function pick(arr, sel) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return (sel === 'last') ? arr[arr.length - 1] : arr[0];
}

// Helper: for the leg-axis, "outbound" / "inbound" require a return trip with
// at least 2 admissions. They degrade to first/last when not honourable.
function resolveLegSelection(sel, admissionsCount) {
  if (admissionsCount < 2) return { ok: false, reason: 'booking has fewer than 2 admissions — leg-partial-refund requires a multi-leg booking' };
  switch (String(sel || 'first').toLowerCase()) {
    case 'first':    return { ok: true, index: 0 };
    case 'last':     return { ok: true, index: admissionsCount - 1 };
    case 'outbound': return { ok: true, index: 0 };               // outbound = 1st admission
    case 'inbound':  return { ok: true, index: admissionsCount - 1 }; // inbound = last admission
    default:         return { ok: true, index: 0 };
  }
}

/**
 * Inspect a booking response and return the resolved partial-refund scope, or
 * a degradation marker. The caller decides whether to log a WARNING and
 * degrade to full refund.
 *
 * @param {object} booking  booking object (with bookedOffers[] / fulfillments[])
 * @param {object} opts     { byLeg, byPax, legSel, paxSel }
 * @returns {object} one of:
 *   { armed: false }                                 — nothing to scope
 *   { armed: true, degraded: true, reason: '...' }   — can't fulfil request
 *   { armed: true, degraded: false,
 *     fulfillmentId, bookingPartIds, passengerIds }  — ready to send
 */
function resolvePartialRefundScope(booking, opts) {
  opts = opts || {};
  const byLeg = !!opts.byLeg;
  const byPax = !!opts.byPax;
  if (!byLeg && !byPax) return { armed: false };

  // The fulfillment is required by the spec on every RefundSpecification.
  // OSCAR scenarios always have exactly one fulfillment today; reach for the
  // first that's not VOIDED if multiple ever appear.
  const fulfillments = (booking && Array.isArray(booking.fulfillments))
    ? booking.fulfillments : [];
  const fulfillmentId = (fulfillments[0] && fulfillments[0].id) || null;
  if (!fulfillmentId) {
    return { armed: true, degraded: true, reason: 'booking has no fulfillment.id — cannot scope RefundSpecification.fulfillmentId' };
  }

  const bookedOffers = (booking && Array.isArray(booking.bookedOffers))
    ? booking.bookedOffers : [];
  if (bookedOffers.length === 0) {
    return { armed: true, degraded: true, reason: 'booking has no bookedOffers — cannot resolve partial-refund scope' };
  }

  // Walk every bookedOffer; flatten the admissions/reservations/ancillaries.
  // For per-leg we use admissions as the leg-list. For per-pax we use
  // passengerRefs at the bookedOffer level (or booking.passengers as fallback).
  let bookingPartIds = [];
  let passengerIds   = [];

  // ── Per-leg axis ───────────────────────────────────────────────────────
  if (byLeg) {
    // Flatten admissions across all bookedOffers, preserving order.
    const allAdmissions = [];
    for (const bo of bookedOffers) {
      const adms = Array.isArray(bo.admissions) ? bo.admissions : [];
      for (const a of adms) { if (a && a.id) allAdmissions.push({ ...a, _bo: bo }); }
    }
    const sel = resolveLegSelection(opts.legSel, allAdmissions.length);
    if (!sel.ok) {
      return { armed: true, degraded: true, reason: sel.reason };
    }
    const chosen = allAdmissions[sel.index];
    bookingPartIds.push(chosen.id);

    // Collect linked reservations + ancillaries on the SAME bookedOffer.
    // OSDM linkage: a reservation references its admission via either
    // requiredAdmissionKey or admissionRef (vendor-variant); ancillaries
    // reference via ancillaryFor / admissionRef. Be permissive — collect
    // anything that names the chosen admission's id.
    const reservations = Array.isArray(chosen._bo.reservations) ? chosen._bo.reservations : [];
    for (const r of reservations) {
      if (!r || !r.id) continue;
      const link = r.requiredAdmissionKey || r.admissionRef || r.admissionId;
      if (link && link === chosen.id) bookingPartIds.push(r.id);
    }
    const ancillaries = Array.isArray(chosen._bo.ancillaries) ? chosen._bo.ancillaries : [];
    for (const a of ancillaries) {
      if (!a || !a.id) continue;
      const link = a.admissionRef || a.admissionId || a.ancillaryFor;
      if (link && link === chosen.id) bookingPartIds.push(a.id);
    }
  }

  // ── Per-passenger axis ─────────────────────────────────────────────────
  if (byPax) {
    // Each bookedOffer carries passengerRefs[] (provider-assigned passenger
    // ids); the booking-level passengers[] is the union. Use the union for
    // ordering ("first" / "last").
    const seen = new Set();
    const allPax = [];
    for (const bo of bookedOffers) {
      const refs = Array.isArray(bo.passengerRefs) ? bo.passengerRefs : [];
      for (const r of refs) {
        if (r && !seen.has(r)) { seen.add(r); allPax.push(r); }
      }
    }
    // Fallback: booking.passengers[].id
    if (allPax.length === 0 && Array.isArray(booking.passengers)) {
      for (const p of booking.passengers) {
        if (p && p.id && !seen.has(p.id)) { seen.add(p.id); allPax.push(p.id); }
      }
    }
    if (allPax.length < 2) {
      return { armed: true, degraded: true, reason: `booking has only ${allPax.length} passenger(s) — per-passenger partial refund requires ≥2` };
    }
    const chosenPax = pick(allPax, opts.paxSel);
    if (chosenPax) passengerIds.push(chosenPax);
  }

  return {
    armed: true,
    degraded: false,
    fulfillmentId,
    bookingPartIds,
    passengerIds,
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
