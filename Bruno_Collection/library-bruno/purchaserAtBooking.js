/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * purchaserAtBooking.js — the invalid purchaser probe in the booking (#899).
 *
 * `bookingPurchaserMode: invalid` books without a purchaser and sends invalid
 * ones to …/purchaser afterwards. A provider that takes the purchaser only in
 * the booking refuses that booking (400 "Parameter 'purchaser' must be
 * entered"), and nothing is probed. With `invalid_at_booking` (the run's copy
 * turns `invalid` into it when the Test Framework says the provider takes no
 * purchaser after the booking) step 02 sends the purchaser in the booking with
 * one field wrong per pass, the same fields as the after-booking sweep, grades
 * each answer, and books with the valid purchaser at the end.
 *
 * Variables: `__purchaserAtBookingPass` (the pass, "done" once the sweep is
 * over), `__purchaserAtBookingProbe` ("true" while a probe pass is sent: the
 * [OSCAR request] check reads it as a negative test),
 * `__purchaserAtBookingTarget` (the field of the pass).
 */

const MODE = 'invalid_at_booking';
// Names omitted first (required: the provider must refuse), then contact
// values of the wrong form (unconstrained strings in OSDM: a refusal is
// recommended, an acceptance a WARNING).
const SWEEP = Object.freeze(['firstName', 'lastName', 'email', 'phoneNumber']);
const BAD = Object.freeze({ email: 'not-an-email', phoneNumber: 'not-a-phone' });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Is the scenario's purchaser mode the probe in the booking? */
const isAtBookingProbe = (mode) => String(mode || '').trim().toLowerCase() === MODE;

/** The pass to send, from the variable: a number, or null when the sweep is over. */
function passOf(raw) {
  if (String(raw) === 'done') return null;
  const n = Number.parseInt(raw ?? '0', 10);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, SWEEP.length - 1);
}

/**
 * The purchaser of one pass: a copy of the valid one with one field wrong.
 * Email and phone go where the purchaser holds them (flat below OSDM 3.4).
 * Returns { purchaser, target } (target as validateProblemResponse reads it).
 */
function corruptedPurchaser(purchaser, pass) {
  // Copies of the levels changed (purchaser, detail, contact): the valid one stays as it is.
  const out = isObj(purchaser) ? { ...purchaser } : {};
  out.detail = isObj(out.detail) ? { ...out.detail } : {};
  const field = SWEEP[pass];
  if (!(field in BAD)) {
    delete out.detail[field];
    return { purchaser: out, target: { scenarioField: field } };
  }
  const flat = field in out.detail && !isObj(out.detail.contact);
  if (flat) {
    out.detail[field] = BAD[field];
  } else {
    out.detail.contact = isObj(out.detail.contact) ? { ...out.detail.contact } : {};
    out.detail.contact[field] = BAD[field];
  }
  return { purchaser: out, target: { scenarioField: field, value: BAD[field] } };
}

/**
 * What one answer to a probe pass leads to: the next pass, or the clean
 * booking after the last one. Returns { next, accepted }.
 */
function afterPass(pass, status) {
  const accepted = typeof status === 'number' && status >= 200 && status < 300;
  return { next: pass + 1 < SWEEP.length ? String(pass + 1) : 'done', accepted };
}

/** The pre-booking an accepted probe made, for the log ('' when none is named). */
function bookingIdOf(body) {
  return isObj(body?.booking) && typeof body.booking.id === 'string' ? body.booking.id : '';
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

/**
 * Step 02, after the response. True when this answer was a probe pass: it is
 * graded like the after-booking sweep and 02 is sent again (next pass, or the
 * booking with the valid purchaser). A pass the provider accepts made a
 * pre-booking: it is named in the log and left to expire.
 */
function gradePurchaserAtBooking(status, body) {
  if (!isAtBookingProbe(bru.getEnvVar('bookingPurchaserMode'))) return false;
  if (String(bru.getEnvVar('__purchaserAtBookingProbe')) !== 'true') return false;
  require('./displays.js');
  const { validateProblemResponse } = require('./requestedInformation.js');
  const pass = passOf(bru.getEnvVar('__purchaserAtBookingPass')) ?? SWEEP.length - 1;
  let target = null;
  try { target = JSON.parse(bru.getEnvVar('__purchaserAtBookingTarget') || 'null'); } catch { target = null; }
  const field = target?.scenarioField || SWEEP[pass];
  validateProblemResponse({
    status,
    body,
    targets: target ? [target] : [],
    prefix: 'Purchaser negative sweep in the booking',
    label: `purchaser.${field}`,
    assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
    log: (level, msg) => validationLogger(`[${level}] ${msg}`),
  });
  const { next, accepted } = afterPass(pass, status);
  if (accepted) {
    const id = bookingIdOf(body);
    const named = id ? ` (booking ${id})` : '';
    validationLogger(`[INFO] Purchaser negative sweep in the booking: the provider booked with the wrong '${field}'${named}; that pre-booking is not confirmed and is left to expire.`);
  }
  // __purchaserAtBookingProbe stays as it is: the collection's [OSCAR request]
  // check runs after this script and reads it; the next build sets it again.
  bru.setEnvVar('__purchaserAtBookingPass', next);
  bru.runner.setNextRequest('02. POST Create Booking');
  return true;
}

module.exports = { MODE, SWEEP, isAtBookingProbe, passOf, corruptedPurchaser, afterPass, bookingIdOf, gradePurchaserAtBooking };
