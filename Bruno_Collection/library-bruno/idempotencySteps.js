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
          Requestor: bru.getEnvVar('requestor') || '',
          'Idempotency-Key': key,
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
  const other = await send('/bookings', body, newKey());
  record(idem.checkBookingOtherKey(firstBody, other.body, other.status));
  if (other.body?.booking?.id) {
    validationLogger(`[INFO] Idempotency-Key: the booking made with another key (${other.body.booking.id}) is left pre-booked; it expires on its own.`);
  }
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
