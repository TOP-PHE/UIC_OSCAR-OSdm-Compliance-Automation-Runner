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
 * the one bound to fulfillments[0]. Since #610 the fulfillment is the one
 * whose `bookingParts` hold the parts refunded (else the chosen passenger's,
 * by `fulfillmentParts[].passengerRef`); fulfillments[0] only when the
 * booking has one. Parts spread over several fulfillments, or no way to tell,
 * degrade to a full refund with the reason, never a guess.
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

// ── Partial refund by fulfillment (#595) ────────────────────────────────────
// Some providers refund per fulfillment only: a refund offer always holds
// every part and passenger of its fulfillment, and a scope by booking part or
// passenger is refused. A partial refund is then the refund of one
// fulfillment: the first or last of the booking, or the one holding the
// outbound or inbound trip of a return. What a fulfillment holds depends on
// how the provider divides the booking (one per booking, per direction, per
// passenger, per passenger and leg), so the selection is by position or by
// direction, never by an id.

const PART_GROUPS = ['admissions', 'reservations', 'ancillaries'];

function bookedParts(booking) {
  const out = [];
  for (const bo of (Array.isArray(booking?.bookedOffers) ? booking.bookedOffers : [])) {
    for (const group of PART_GROUPS) {
      for (const part of (Array.isArray(bo?.[group]) ? bo[group] : [])) if (part?.id) out.push(part);
    }
  }
  return out;
}

// The trip of a direction: the one marked OUT_BOUND / IN_BOUND, else the
// first / last of the booking's trips. Null when the booking has one trip.
function tripOfDirection(booking, direction) {
  const trips = (Array.isArray(booking?.trips) ? booking.trips : []).filter((t) => t?.id);
  if (trips.length < 2) return null;
  const marked = trips.find((t) => t.direction === (direction === 'outbound' ? 'OUT_BOUND' : 'IN_BOUND'));
  if (marked) return marked;
  return direction === 'outbound' ? trips[0] : trips[trips.length - 1];
}

function partsCoveringTrip(booking, tripId) {
  return new Set(bookedParts(booking)
    .filter((p) => p.tripCoverage && String(p.tripCoverage.coveredTripId) === String(tripId))
    .map((p) => String(p.id)));
}

function chooseFulfillment(booking, fulfillments, selection) {
  if (selection !== 'outbound' && selection !== 'inbound') {
    return { fulfillment: pickFromArray(fulfillments, selection) };
  }
  const trip = tripOfDirection(booking, selection);
  if (!trip) return { reason: `'${selection}' needs a return: the booking has fewer than 2 trips` };
  const parts = partsCoveringTrip(booking, trip.id);
  const fulfillment = fulfillments.find((f) => (f.bookingParts || []).some((p) => p && parts.has(String(p.id))));
  if (!fulfillment) return { reason: `no fulfillment holds a part covering the ${selection} trip ${trip.id}` };
  return { fulfillment };
}

/**
 * The fulfillment to refund for a partial refund by fulfillment, and what its
 * refund should cover.
 *
 * @param {object} booking    the booking after fulfillments
 * @param {string} selection  'first' | 'last' | 'outbound' | 'inbound'
 * @returns {{armed: boolean, degraded: boolean, reason?: string,
 *            fulfillmentId?: string, expectedPartIds?: string[],
 *            expected?: {amount: number, currency: string|null, scale: number|null}}}
 */
function resolveFulfillmentRefundScope(booking, selection) {
  const fulfillments = (Array.isArray(booking?.fulfillments) ? booking.fulfillments : []).filter((f) => f?.id);
  if (fulfillments.length < 2) {
    return { armed: false, degraded: true, reason: `the booking has ${fulfillments.length} fulfillment(s): refunding one of them is the whole booking` };
  }
  const sel = ['first', 'last', 'outbound', 'inbound'].includes(String(selection || '').toLowerCase())
    ? String(selection).toLowerCase() : 'first';
  const { fulfillment, reason } = chooseFulfillment(booking, fulfillments, sel);
  if (!fulfillment) return { armed: false, degraded: true, reason };
  const expectedPartIds = (fulfillment.bookingParts || []).filter((p) => p?.id).map((p) => String(p.id));
  const wanted = new Set(expectedPartIds);
  const expected = { amount: 0, currency: null, scale: null };
  for (const part of bookedParts(booking)) {
    if (!wanted.has(String(part.id))) continue;
    const price = part.price || {};
    if (typeof price.amount === 'number') expected.amount += price.amount;
    if (!expected.currency && price.currency) expected.currency = price.currency;
    if (expected.scale == null && typeof price.scale === 'number') expected.scale = price.scale;
  }
  return { armed: true, degraded: false, selection: sel, fulfillmentId: String(fulfillment.id), expectedPartIds, expected };
}

module.exports = {
  resolvePartialRefundScope,
  buildRefundSpecifications,
  resolveFulfillmentRefundScope,
  wireSpecs,
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
// chosen passenger's externalRef, or null.
function findFulfillmentForPassenger(fulfillments, externalRef) {
  if (!Array.isArray(fulfillments) || fulfillments.length === 0 || !externalRef) return null;
  return fulfillments.find(f => {
    const parts = Array.isArray(f && f.fulfillmentParts) ? f.fulfillmentParts : [];
    return parts.some(fp => fp && String(fp.passengerRef) === String(externalRef));
  }) || null;
}

// The fulfillments listing any of these booking parts in their bookingParts.
function fulfillmentsHoldingParts(fulfillments, partIds) {
  const wanted = new Set(partIds.map(String));
  return fulfillments.filter(f => (Array.isArray(f?.bookingParts) ? f.bookingParts : [])
    .some(p => p && wanted.has(String(p.id))));
}

/**
 * #610: the fulfillment a RefundSpecification names. It must hold the parts
 * the refund lists: a provider that issues one fulfillment per passenger
 * holds each passenger's parts in their own. Never a guess:
 *   - one fulfillment in the booking: that one, as before;
 *   - the fulfillments listing the parts (bookingParts): exactly one → it;
 *     several → none (one specification names one fulfillment);
 *   - none listing them: the chosen passenger's (fulfillmentParts), else none.
 * Returns { fulfillment } or { reason }.
 */
function fulfillmentForScope(fulfillments, partIds, passenger) {
  if (fulfillments.length === 1) return { fulfillment: fulfillments[0] };
  const holders = partIds.length > 0 ? fulfillmentsHoldingParts(fulfillments, partIds) : [];
  if (holders.length === 1) return { fulfillment: holders[0] };
  if (holders.length > 1) {
    return { reason: `the parts to refund are in ${holders.length} fulfillments (${holders.map(f => f.id).join(', ')}); one RefundSpecification names one fulfillment` };
  }
  const own = passenger ? findFulfillmentForPassenger(fulfillments, passenger.externalRef) : null;
  if (own) return { fulfillment: own };
  return { reason: `the booking has ${fulfillments.length} fulfillments and none of them is shown to hold the parts to refund${passenger ? ' or the chosen passenger' : ''} — refusing to name one blindly` };
}

// The chosen passenger's parts: admissions naming the passenger, and their
// reservations and ancillaries. Empty when admissions do not name passengers.
function passengerPartIds(allAdms, passenger) {
  const out = [];
  if (!passenger) return out;
  for (const a of allAdms) {
    const owners = Array.isArray(a?.passengerIds) ? a.passengerIds.map(String) : [];
    if (!owners.includes(String(passenger.id))) continue;
    const refs = expandAdmissionRefs(a);
    out.push(String(a.id), ...refs.reservationIds, ...refs.ancillaryIds);
  }
  return out;
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

  // ── Pick the passenger(s) (drive passengerIds + fulfillment selection) ──
  // #699: 'third' picks the last third of the passengers, rounded up.
  let chosenPassengers = [];
  if (byPax) {
    if (passengers.length < 2) {
      return { armed: true, degraded: true, reason: `booking has only ${passengers.length} passenger(s) — per-passenger partial refund requires >=2` };
    }
    chosenPassengers = choosePassengers(passengers, opts.paxSel);
    if (chosenPassengers.length === 0 || chosenPassengers.some((p) => !p?.id)) {
      return { armed: true, degraded: true, reason: 'passenger selection resolved to a row with no id — cannot scope' };
    }
  }
  const chosenPassenger = chosenPassengers.length === 1 ? chosenPassengers[0] : null;
  const chosenIds = new Set(chosenPassengers.map((p) => String(p.id)));

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
    if (chosenIds.size > 0) {
      const filtered = scopedAdms.filter(a => {
        const owners = Array.isArray(a && a.passengerIds) ? a.passengerIds.map(String) : null;
        return owners == null /* unknown ownership → keep */ || owners.some((o) => chosenIds.has(o));
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

  const passengerIds = chosenPassengers.map((p) => p.id);

  // ── The fulfillment holding what is refunded (#610) ──────────────────────
  if (chosenPassengers.length > 1) {
    return severalPassengersScope({ fulfillments, allAdms, chosenPassengers, byLeg, bookingPartIds, passengerIds, chosenLegId });
  }
  const scopeParts = byLeg ? bookingPartIds : passengerPartIds(allAdms, chosenPassenger);
  const { fulfillment: chosenFulfillment, reason: noFulfillment } = fulfillmentForScope(fulfillments, scopeParts, chosenPassenger);
  if (!chosenFulfillment || !chosenFulfillment.id) {
    return { armed: true, degraded: true, reason: noFulfillment || 'could not resolve a fulfillment.id for the scope — refusing to scope blindly' };
  }

  return {
    armed: true,
    degraded: false,
    fulfillmentId: chosenFulfillment.id,
    bookingPartIds,
    passengerIds,
    chosenLegId,
    chosenPassenger,
    specs: [{ fulfillmentId: chosenFulfillment.id, bookingPartIds, passengerIds }],
  };
}

// #699: the passengers a selection names: the first, the last, or the last
// third of them, rounded up.
function choosePassengers(passengers, sel) {
  if (String(sel || '').toLowerCase() === 'third') {
    return passengers.slice(passengers.length - Math.ceil(passengers.length / 3));
  }
  const one = pickFromArray(passengers, sel);
  return one ? [one] : [];
}

// #699: several passengers refunded. Each one's parts are in one
// fulfillment (#610's rule, per passenger); one RefundSpecification per
// fulfillment, naming its passengers (and, with the leg axis, its parts).
// One fulfillment for everyone gives one specification listing them all.
function severalPassengersScope({ fulfillments, allAdms, chosenPassengers, byLeg, bookingPartIds, passengerIds, chosenLegId }) {
  const legParts = new Set(bookingPartIds.map(String));
  const groups = new Map();
  for (const passenger of chosenPassengers) {
    const own = passengerPartIds(allAdms, passenger).filter((id) => !byLeg || legParts.has(String(id)));
    const { fulfillment, reason } = fulfillmentForScope(fulfillments, own, passenger);
    if (!fulfillment?.id) {
      return { armed: true, degraded: true, reason: `passenger ${passenger.id}: ${reason || 'no fulfillment holds their parts'}` };
    }
    const key = String(fulfillment.id);
    if (!groups.has(key)) groups.set(key, { fulfillmentId: fulfillment.id, bookingPartIds: [], passengerIds: [] });
    const group = groups.get(key);
    group.passengerIds.push(passenger.id);
    if (byLeg) group.bookingPartIds.push(...own.filter((id) => !group.bookingPartIds.includes(id)));
  }
  const specs = [...groups.values()];
  return {
    armed: true,
    degraded: false,
    fulfillmentId: specs[0].fulfillmentId,
    bookingPartIds,
    passengerIds,
    chosenLegId,
    chosenPassenger: chosenPassengers[0],
    chosenPassengers,
    specs,
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
  return wireSpecs(r.specs);
}

// The RefundSpecification[] to send: empty lists left out.
function wireSpecs(specs) {
  return (Array.isArray(specs) ? specs : []).map((s) => {
    const spec = { fulfillmentId: s.fulfillmentId };
    if (Array.isArray(s.bookingPartIds) && s.bookingPartIds.length > 0) spec.bookingPartIds = s.bookingPartIds;
    if (Array.isArray(s.passengerIds) && s.passengerIds.length > 0) spec.passengerIds = s.passengerIds;
    return spec;
  });
}

// Expose to globalThis for the eval/require loader path (matches other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] partialRefund globalThis exposure skipped: ' + (e && e.message));
}
