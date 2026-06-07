// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-partialrefund.test.js — unit tests for the partial-refund helper
 * (Bruno_Collection/library-bruno/partialRefund.js, issue #218).
 *
 * Two exported functions:
 *   - resolvePartialRefundScope(booking, opts) — pure mapper, returns either
 *     { armed: false }, { armed: true, degraded: true, reason },
 *     or { armed: true, degraded: false, fulfillmentId, bookingPartIds, passengerIds }.
 *   - buildRefundSpecifications(booking, opts) — returns the OSDM array form
 *     (or null when nothing to send).
 *
 * Harness mirrors the other library-bruno tests: minimal `bru` + a stub
 * validationLogger. partialRefund.js depends on displays.js only for the
 * logger; mock it to silence the [INFO]/[WARNING] noise in test output.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: () => {},
}));

const {
  resolvePartialRefundScope,
  buildRefundSpecifications,
} = require('../../../Bruno_Collection/library-bruno/partialRefund.js');

beforeEach(() => { envStore = {}; });

// ─── Fixtures ─────────────────────────────────────────────────────────────
// Minimal booking shapes that exercise each axis of resolution.
function multiLegMultiPaxBooking() {
  return {
    fulfillments: [{ id: 'ff-001' }],
    passengers:   [{ id: 'pax-A' }, { id: 'pax-B' }],
    bookedOffers: [{
      passengerRefs: ['pax-A', 'pax-B'],
      admissions: [
        { id: 'adm-leg1' },
        { id: 'adm-leg2' },
      ],
      reservations: [
        { id: 'res-leg1-pax-A', requiredAdmissionKey: 'adm-leg1' },
        { id: 'res-leg2-pax-B', requiredAdmissionKey: 'adm-leg2' },
      ],
      ancillaries: [
        { id: 'anc-leg1',  admissionRef: 'adm-leg1' },
      ],
    }],
  };
}

function singleLegBooking() {
  return {
    fulfillments: [{ id: 'ff-001' }],
    passengers:   [{ id: 'pax-A' }, { id: 'pax-B' }],
    bookedOffers: [{
      passengerRefs: ['pax-A', 'pax-B'],
      admissions:    [{ id: 'adm-only' }],
      reservations:  [],
      ancillaries:   [],
    }],
  };
}

function singlePaxBooking() {
  return {
    fulfillments: [{ id: 'ff-001' }],
    passengers:   [{ id: 'pax-A' }],
    bookedOffers: [{
      passengerRefs: ['pax-A'],
      admissions:    [{ id: 'adm-leg1' }, { id: 'adm-leg2' }],
      reservations:  [],
      ancillaries:   [],
    }],
  };
}

// ─── resolvePartialRefundScope ────────────────────────────────────────────
describe('resolvePartialRefundScope', () => {
  test('returns { armed: false } when neither axis is on', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(), {});
    expect(r).toEqual({ armed: false });
  });

  test('per-leg "first" → picks the first admission + its linked res/anc', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byLeg: true, legSel: 'first' });
    expect(r.armed).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.fulfillmentId).toBe('ff-001');
    expect(r.bookingPartIds).toEqual(expect.arrayContaining([
      'adm-leg1', 'res-leg1-pax-A', 'anc-leg1',
    ]));
    // does NOT include leg2's bits
    expect(r.bookingPartIds).not.toContain('adm-leg2');
    expect(r.bookingPartIds).not.toContain('res-leg2-pax-B');
    expect(r.passengerIds).toEqual([]);
  });

  test('per-leg "last" → picks the last admission', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byLeg: true, legSel: 'last' });
    expect(r.degraded).toBe(false);
    expect(r.bookingPartIds).toContain('adm-leg2');
    expect(r.bookingPartIds).not.toContain('adm-leg1');
  });

  test('per-leg "outbound" / "inbound" → first / last (return-trip convention)', () => {
    const out = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byLeg: true, legSel: 'outbound' });
    expect(out.bookingPartIds).toContain('adm-leg1');
    const inb = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byLeg: true, legSel: 'inbound' });
    expect(inb.bookingPartIds).toContain('adm-leg2');
  });

  test('per-pax "first" → picks first passenger ref', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byPax: true, paxSel: 'first' });
    expect(r.degraded).toBe(false);
    expect(r.passengerIds).toEqual(['pax-A']);
    expect(r.bookingPartIds).toEqual([]);
  });

  test('per-pax "last" → picks last passenger ref', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(),
      { byPax: true, paxSel: 'last' });
    expect(r.passengerIds).toEqual(['pax-B']);
  });

  test('both axes on → emits bookingPartIds AND passengerIds', () => {
    const r = resolvePartialRefundScope(multiLegMultiPaxBooking(), {
      byLeg: true, legSel: 'first',
      byPax: true, paxSel: 'last',
    });
    expect(r.degraded).toBe(false);
    expect(r.bookingPartIds).toContain('adm-leg1');
    expect(r.passengerIds).toEqual(['pax-B']);
  });

  test('per-leg on single-leg booking → degraded with reason', () => {
    const r = resolvePartialRefundScope(singleLegBooking(),
      { byLeg: true, legSel: 'first' });
    expect(r.armed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/fewer than 2 admissions/);
  });

  test('per-pax on single-pax booking → degraded with reason', () => {
    const r = resolvePartialRefundScope(singlePaxBooking(),
      { byPax: true, paxSel: 'first' });
    expect(r.armed).toBe(true);
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/only 1 passenger/);
  });

  test('no fulfillment.id on booking → degraded (cannot scope)', () => {
    const bk = multiLegMultiPaxBooking();
    bk.fulfillments = [];
    const r = resolvePartialRefundScope(bk, { byLeg: true, legSel: 'first' });
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/no fulfillment\.id/);
  });

  test('empty bookedOffers → degraded', () => {
    const bk = multiLegMultiPaxBooking();
    bk.bookedOffers = [];
    const r = resolvePartialRefundScope(bk, { byLeg: true });
    expect(r.degraded).toBe(true);
    expect(r.reason).toMatch(/no bookedOffers/);
  });

  test('falls back to booking.passengers[].id when bookedOffer.passengerRefs is empty', () => {
    const bk = multiLegMultiPaxBooking();
    bk.bookedOffers[0].passengerRefs = [];
    const r = resolvePartialRefundScope(bk, { byPax: true, paxSel: 'first' });
    expect(r.degraded).toBe(false);
    expect(r.passengerIds).toEqual(['pax-A']);
  });
});

// ─── buildRefundSpecifications ────────────────────────────────────────────
describe('buildRefundSpecifications', () => {
  test('returns null when not armed', () => {
    expect(buildRefundSpecifications(multiLegMultiPaxBooking(), {})).toBeNull();
  });

  test('returns null when degraded (caller falls back to full refund)', () => {
    expect(buildRefundSpecifications(singleLegBooking(),
      { byLeg: true, legSel: 'first' })).toBeNull();
  });

  test('emits single-entry array shaped as OSDM RefundSpecification', () => {
    const arr = buildRefundSpecifications(multiLegMultiPaxBooking(), {
      byLeg: true, legSel: 'first',
      byPax: true, paxSel: 'last',
    });
    expect(Array.isArray(arr)).toBe(true);
    expect(arr).toHaveLength(1);
    expect(arr[0].fulfillmentId).toBe('ff-001');
    expect(arr[0].bookingPartIds).toContain('adm-leg1');
    expect(arr[0].passengerIds).toEqual(['pax-B']);
  });

  test('omits bookingPartIds when only per-pax is on', () => {
    const arr = buildRefundSpecifications(multiLegMultiPaxBooking(),
      { byPax: true, paxSel: 'first' });
    expect(arr[0]).not.toHaveProperty('bookingPartIds');
    expect(arr[0].passengerIds).toEqual(['pax-A']);
  });

  test('omits passengerIds when only per-leg is on', () => {
    const arr = buildRefundSpecifications(multiLegMultiPaxBooking(),
      { byLeg: true, legSel: 'first' });
    expect(arr[0]).not.toHaveProperty('passengerIds');
    expect(arr[0].bookingPartIds).toContain('adm-leg1');
  });
});
