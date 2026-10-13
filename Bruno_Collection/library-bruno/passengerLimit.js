/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * passengerLimit.js — the passenger-limit probe (#699).
 *
 * OSDM sets no maximum number of passengers per offer or booking; each
 * provider has one, declared in the Test Framework (`maxPassengers`). A
 * scenario with `passengerLimitExpectRejection` asks for one passenger more
 * and expects a refusal: at POST /offers (a 4xx Problem, or a 2xx holding no
 * offer), or else at POST /bookings (a 4xx Problem). Either ends the
 * scenario; a booking made over the limit is a failure.
 */

require('./displays.js');

/** What the provider did with the request over the limit: 'refused', 'no-offer' or 'accepted'. */
function overLimitOutcome(status, body) {
  if (typeof status !== 'number' || status >= 300) return 'refused';
  const offers = body && typeof body === 'object' ? body.offers : undefined;
  if (Array.isArray(offers) && offers.length === 0) return 'no-offer';
  return 'accepted';
}

/** The number of passengers of a request: its anonymous passengers, else its passenger specifications. */
function passengerCountOf(request) {
  if (!request || typeof request !== 'object') return 0;
  const list = Array.isArray(request.anonymousPassengerSpecifications)
    ? request.anonymousPassengerSpecifications : request.passengerSpecifications;
  return Array.isArray(list) ? list.length : 0;
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

const armed = () => String(bru.getEnvVar('passengerLimitExpectRejection')) === 'true';

function requestedCount() {
  let request = bru.getEnvVar('OfferCollectionRequest');
  if (typeof request === 'string') {
    try { request = JSON.parse(request); } catch { request = null; }
  }
  return passengerCountOf(request);
}

// A 4xx answer graded as the other negative probes are: a client error with
// an RFC 9457 Problem.
function gradeRefusal(step, status, body, count) {
  const { validateProblemResponse } = require('./requestedInformation.js');
  validateProblemResponse({
    status,
    body,
    targets: [],
    prefix: '🧪 Passenger limit probe',
    label: `${count} passengers, ${step}`,
    assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
    log: (level, msg) => validationLogger(`[${level}] ${msg}`),
  });
}

/**
 * Step 01, after the response. True when the probe ends the scenario here:
 * the offer request was refused, or gave no offer. Offers given: the
 * refusal is expected at the booking, and the sale goes on.
 */
function checkOffersOverLimit(status, body) {
  if (!armed()) return false;
  const count = requestedCount();
  validationLogger(`[INFO] 🧪 Passenger limit probe — ${count} passengers, one more than the provider's declared maximum; a refusal is expected.`);
  const outcome = overLimitOutcome(status, body);
  if (outcome === 'accepted') {
    validationLogger(`[INFO] 🧪 Passenger limit probe: POST /offers gave offers for ${count} passengers; the refusal is expected at POST /bookings.`);
    return false;
  }
  if (outcome === 'no-offer') {
    test(`🧪 Passenger limit probe [${count} passengers, POST /offers]: no offer is given`, () => {});
    const problems = Array.isArray(body?.problems) ? body.problems : [];
    validationLogger(problems.length
      ? `[INFO] 🧪 Passenger limit probe: the answer explains it with ${problems.length} problem(s): ${problems.map((p) => p?.code || p?.title).filter(Boolean).join(', ')}.`
      : '[WARNING] 🧪 Passenger limit probe: no offer and no problem saying why; a Problem naming the passenger limit helps a distributor.');
    return true;
  }
  gradeRefusal('POST /offers', status, body, count);
  return true;
}

/**
 * Step 02, after the response. True when the probe ends the scenario here,
 * which is always when it is armed: a refusal is graded, a booking made over
 * the limit fails.
 */
function checkBookingOverLimit(status, body) {
  if (!armed()) return false;
  const count = requestedCount();
  if (typeof status === 'number' && status < 300) {
    validationLogger(`[WARNING] 🧪 Passenger limit probe: POST /bookings accepted ${count} passengers, over the maximum the Test Framework declares. Either the maximum is higher, or the provider does not enforce it.`);
  }
  gradeRefusal('POST /bookings', status, body, count);
  return true;
}

module.exports = { overLimitOutcome, passengerCountOf, checkOffersOverLimit, checkBookingOverLimit };

