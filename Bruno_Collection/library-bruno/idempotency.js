/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * idempotency.js — the Idempotency-Key test (#604).
 *
 * OSDM lets a client send an `Idempotency-Key` header (a UUID) on a request
 * that is not idempotent, so that a request sent again after a lost answer
 * does not act twice: the provider answers the same key with the same answer.
 * ČD supports it on POST /bookings and POST /bookings/{id}/fulfillments.
 *
 * With `idempotencyCheck` on, each of these two requests is sent with a key,
 * then sent again with the same key: the answer must be the same booking, or
 * the same fulfillments, and no second booking. The booking is also sent a
 * third time with another key: that one must be a new booking.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-idempotency.test.js.
 */

const listOf = (value) => (Array.isArray(value) ? value : []);

/** A version 4 UUID made from 16 bytes (random ones, from the caller). */
function uuidFromBytes(bytes) {
  const b = Array.from(bytes).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const statusCheck = (label, status) => ({ name: `${label}: HTTP status 200 — actual ${status}`, ok: status === 200, message: `HTTP ${status}` });

/**
 * The booking sent again with the same key: the same booking, and its id
 * only once (no second booking).
 */
function checkBookingReplay(first, replay, status) {
  const label = 'Idempotency-Key, POST /bookings sent again with the same key';
  const checks = [statusCheck(label, status)];
  if (status !== 200) return checks;
  const a = first?.booking?.id;
  const b = replay?.booking?.id;
  checks.push({ name: `${label}: the same booking — ${a}`, ok: !!a && a === b, message: `the answer is booking ${b ?? 'none'}, not ${a}` });
  return checks;
}

/** The booking sent with another key: a new booking. */
function checkBookingOtherKey(first, other, status) {
  const label = 'Idempotency-Key, POST /bookings with another key';
  const checks = [statusCheck(label, status)];
  if (status !== 200) return checks;
  const a = first?.booking?.id;
  const b = other?.booking?.id;
  checks.push({ name: `${label}: a new booking`, ok: !!b && b !== a, message: b ? `the same booking ${b} again` : 'no booking in the answer' });
  return checks;
}

const fulfillmentIds = (body) => listOf(body?.fulfillments).map((f) => f?.id).filter(Boolean).sort((x, y) => x.localeCompare(y));

/** The confirmation sent again with the same key: the same fulfillments. */
function checkFulfillmentReplay(first, replay, status) {
  const label = 'Idempotency-Key, POST /bookings/{id}/fulfillments sent again with the same key';
  const checks = [statusCheck(label, status)];
  if (status !== 200) return checks;
  const a = fulfillmentIds(first);
  const b = fulfillmentIds(replay);
  checks.push({
    name: `${label}: the same fulfillments — ${a.length}`,
    ok: a.length > 0 && a.join() === b.join(),
    message: `first [${a.join(', ')}], then [${b.join(', ')}]`,
  });
  return checks;
}

module.exports = { uuidFromBytes, checkBookingReplay, checkBookingOtherKey, checkFulfillmentReplay };
