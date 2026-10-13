/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * idempotencySteps.js — the steps of the Idempotency-Key test (#604),
 * between Bruno and the pure checks of idempotency.js.
 *
 *   02, 06 before-request  setIdempotencyKey(): a new key on the request.
 *   02 after-response      checkBookingIdempotency(): the booking sent again
 *                          with the same key, then with another key.
 *   06 after-response      checkConfirmationIdempotency(): the confirmation
 *                          sent again with the same key.
 * The requests sent again are made from the step's own script
 * (bru.sendRequest), so that the flow of the scenario does not change; their
 * checks are recorded in the step.
 */

const { validationLogger } = require('./displays.js');
const { bruTest: test } = require('./testCapture.js');
const idem = require('./idempotency.js');
const { requestorHeader } = require('./requestHeaders.js');

let counter = 0;

const isOn = () => String(bru.getEnvVar('idempotencyCheck')) === 'true';

// Sixteen random bytes. Bruno's sandbox gives scripts `crypto` in developer
// mode; without it, a time-and-counter value, unique within the run.
function randomBytes() {
  try {
    return Array.from(require('node:crypto').randomBytes(16));
  } catch {
    counter += 1;
    const seed = `${Date.now()}-${counter}`.padEnd(16, '0');
    return Array.from(seed.slice(0, 16), (c) => c.codePointAt(0));
  }
}

function newKey() {
  return idem.uuidFromBytes(randomBytes());
}

function record(checks) {
  checks.forEach((c) => test(c.name, () => { if (!c.ok) throw new Error(c.message); }));
}

/** 02 and 06, before the request: a new Idempotency-Key, kept for the replay. */
function setIdempotencyKey(request, step) {
  if (!isOn()) return null;
  const key = newKey();
  bru.setEnvVar(`__idempotencyKey_${step}`, key);
  request.setHeader('Idempotency-Key', key);
  return key;
}

// The request sent again, with the headers of the step and the key given.
async function send(path, body, key) {
  try {
    const res = await new Promise((resolve, reject) => {
      bru.sendRequest({
        url: `${bru.getEnvVar('api_base')}${path}`,
        method: 'POST',
        headers: {
          'Content-Type': `application/json;version=${bru.getEnvVar('osdmVersion')}`,
          Accept: 'application/json',
          Authorization: `Bearer ${bru.getEnvVar('access_token')}`,
          ...requestorHeader(bru.getEnvVar('requestor')),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        data: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
      }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
    });
    let data = res?.data ?? res?.body ?? null;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    return { status: res?.status || res?.statusCode || 0, body: data };
  } catch (err) {
    validationLogger(`[ERROR] Idempotency-Key: POST ${path} could not be sent again: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

/** 02, after a booking: the same request with the same key, then with another key. */
async function checkBookingIdempotency(firstBody) {
  if (!isOn()) return;
  const key = bru.getEnvVar('__idempotencyKey_booking');
  const body = bru.getEnvVar('BookingRequest');
  validationLogger(`[INFO] 🔑 Idempotency-Key — POST /bookings sent again with the same key (${key}), then with another key.`);
  const replay = await send('/bookings', body, key);
  record(idem.checkBookingReplay(firstBody, replay.body, replay.status));
  let other = await send('/bookings', body, newKey());
  if (idem.refusedWithoutBooking(other.status, other.body)) {
    // #693: a provider may book an offer only once. That is its rule, not a
    // fault of idempotency: said, then the booking with another key is made
    // on a new offer.
    const offerId = parseJson(body)?.offers?.[0]?.offerId;
    validationLogger(`[WARNING] Idempotency-Key: POST /bookings with another key was refused (HTTP ${other.status}) for offer ${offerId}, already booked: this provider books an offer only once. New offers are asked for, and the booking with another key is made on one of them.`);
    other = await bookOnNewOffer(body);
    if (!other) return;
  }
  record(idem.checkBookingOtherKey(firstBody, other.body, other.status));
  if (other.body?.booking?.id) {
    validationLogger(`[INFO] Idempotency-Key: the booking made with another key (${other.body.booking.id}) is left pre-booked; it expires on its own.`);
  }
}

function parseJson(value) {
  if (value == null || typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

// #693: the offers asked again with step 01's request, the offer standing for
// the one chosen, and the booking made on it with another key. Null, said,
// when that cannot be done.
async function bookOnNewOffer(bookingBody) {
  const request = parseJson(bookingBody);
  if (!Array.isArray(request?.offers) || request.offers.length !== 1) {
    validationLogger('[WARNING] Idempotency-Key: the booking names several offers; new offers are not asked for, and the booking with another key is not checked.');
    return null;
  }
  const offers = await send('/offers', bru.getEnvVar('OfferCollectionRequest'), null);
  const match = offers.status === 200 ? idem.matchingOffer(parseJson(bru.getEnvVar('offer')), offers.body?.offers) : null;
  if (!match) {
    validationLogger(`[WARNING] Idempotency-Key: the offers asked again gave none (HTTP ${offers.status}); the booking with another key is not checked.`);
    return null;
  }
  const rebooking = idem.bookingOnOffer(request, match.offer.offerId);
  validationLogger(`[INFO] Idempotency-Key: new offer ${match.offer.offerId}, ${match.how}.${rebooking.droppedSelections ? ' The seats or reservations chosen for the first booking name the old offer, so they are left out.' : ''}`);
  return send('/bookings', rebooking.body, newKey());
}

/** 06, after the confirmation: the same request with the same key. */
async function checkConfirmationIdempotency(firstBody) {
  if (!isOn()) return;
  const key = bru.getEnvVar('__idempotencyKey_confirmation');
  validationLogger(`[INFO] 🔑 Idempotency-Key — POST /bookings/{id}/fulfillments sent again with the same key (${key}).`);
  const replay = await send(`/bookings/${bru.getEnvVar('bookingId')}/fulfillments`, {}, key);
  record(idem.checkFulfillmentReplay(firstBody, replay.body, replay.status));
}

module.exports = { setIdempotencyKey, checkBookingIdempotency, checkConfirmationIdempotency, newKey };
