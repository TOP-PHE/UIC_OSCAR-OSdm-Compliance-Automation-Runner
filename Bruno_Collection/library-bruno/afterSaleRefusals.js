/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * afterSaleRefusals.js — after-sale requests that must be refused (#700).
 *
 * Each probe is sent from the script of the step after which it makes sense,
 * with bru.sendRequest, so the flow of the scenario does not change:
 *
 *   refundAgainProbe       14, once the refund is done: POST …/refund-offers
 *                          for the fulfillments just refunded → a 4xx Problem.
 *   exchangeRefundedProbe  14, once the refund is done: POST …/exchange-offers
 *                          for the same fulfillments → a 4xx Problem.
 *   confirmAgainProbe      06, once the booking is confirmed: POST
 *                          …/fulfillments again, without an Idempotency-Key →
 *                          the same fulfillments, or a 4xx Problem; never new
 *                          tickets.
 */

require('./displays.js');
const { requestorHeader } = require('./requestHeaders.js');

const isOn = (name) => String(bru.getEnvVar(name)) === 'true';

// ── pure ───────────────────────────────────────────────────────────────────

/** The ids of a fulfillment list, in order. */
const idsOf = (fulfillments) => (Array.isArray(fulfillments) ? fulfillments : [])
  .map((f) => (f && typeof f === 'object' ? f.id : null)).filter((id) => typeof id === 'string' && id !== '');

/** The fulfillments an answer to POST …/fulfillments gives, wherever it puts them. */
function fulfillmentsOfAnswer(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.fulfillments)) return body.fulfillments;
  if (Array.isArray(body.booking?.fulfillments)) return body.booking.fulfillments;
  return [];
}

/**
 * The confirmation sent again: 'same' (2xx, the same fulfillments), 'refused'
 * (4xx), 'new' (2xx with a fulfillment the first answer did not have),
 * 'error' (anything else).
 */
function confirmAgainOutcome(firstIds, status, body) {
  if (typeof status === 'number' && status >= 400 && status < 500) return 'refused';
  if (typeof status !== 'number' || status < 200 || status >= 300) return 'error';
  const again = idsOf(fulfillmentsOfAnswer(body));
  return again.some((id) => !firstIds.includes(id)) ? 'new' : 'same';
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

async function send(path, body) {
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
        },
        data: JSON.stringify(body ?? {}),
      }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
    });
    let data = res?.data ?? res?.body ?? null;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = null; }
    }
    return { status: res?.status || res?.statusCode || 0, body: data };
  } catch (err) {
    validationLogger(`[ERROR] After-sale probe: POST ${path} could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

function gradeRefusal(prefix, label, status, body) {
  const { validateProblemResponse } = require('./requestedInformation.js');
  validateProblemResponse({
    status,
    body,
    targets: [],
    prefix,
    label,
    assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
    log: (level, msg) => validationLogger(`[${level}] ${msg}`),
  });
}

/** 14, once the refund is done: the refunded fulfillments cannot be refunded or exchanged again. */
async function probeRefundedFulfillments(booking) {
  const refund = isOn('refundAgainProbe');
  const exchange = isOn('exchangeRefundedProbe');
  if (!refund && !exchange) return;
  const refunded = idsOf(booking?.fulfillments).filter((id) => {
    const f = booking.fulfillments.find((x) => x?.id === id);
    return f?.status === 'REFUNDED';
  });
  if (refunded.length === 0) {
    validationLogger('[WARNING] After-sale probe: no fulfillment of the booking is REFUNDED, so there is nothing to refund or exchange again; the probe is not sent.');
    return;
  }
  const bookingId = bru.getEnvVar('bookingId');
  const label = `${refunded.length} refunded fulfillment(s)`;
  if (refund) {
    validationLogger(`[INFO] 🧪 Refund again — POST /bookings/${bookingId}/refund-offers for ${label}; a refusal is expected.`);
    const r = await send(`/bookings/${bookingId}/refund-offers`, { fulfillmentIds: refunded });
    gradeRefusal('🧪 Refund again', label, r.status, r.body);
  }
  if (exchange) {
    const { requestExchangeOffersBody } = require('./requestsBuilder.js');
    requestExchangeOffersBody(null);
    let body;
    try { body = JSON.parse(bru.getEnvVar('requestExchangeOffersBodyData') || '{}'); } catch { body = {}; }
    body.fulfillmentIds = refunded;
    validationLogger(`[INFO] 🧪 Exchange a refunded ticket — POST /bookings/${bookingId}/exchange-offers for ${label}; a refusal is expected.`);
    const r = await send(`/bookings/${bookingId}/exchange-offers`, body);
    gradeRefusal('🧪 Exchange a refunded ticket', label, r.status, r.body);
  }
}

/** 06, once the booking is confirmed: the confirmation sent again issues no new ticket. */
async function probeConfirmAgain(firstBody) {
  if (!isOn('confirmAgainProbe')) return;
  const first = idsOf(fulfillmentsOfAnswer(firstBody));
  const bookingId = bru.getEnvVar('bookingId');
  validationLogger(`[INFO] 🧪 Confirm again — POST /bookings/${bookingId}/fulfillments sent a second time, without an Idempotency-Key: the same fulfillments, or a refusal, are expected.`);
  // Step 06 sends an empty body.
  const r = await send(`/bookings/${bookingId}/fulfillments`, {});
  const outcome = confirmAgainOutcome(first, r.status, r.body);
  test(`🧪 Confirm again: no new ticket — HTTP ${r.status}, ${outcome === 'same' ? 'the same fulfillments' : outcome}`, () => {
    if (outcome === 'new') throw new Error(`a second confirmation issued new fulfillments: first [${first.join(', ')}], then [${idsOf(fulfillmentsOfAnswer(r.body)).join(', ')}]`);
    if (outcome === 'error') throw new Error(`expected 2xx with the same fulfillments, or a 4xx refusal; got HTTP ${r.status}`);
  });
  if (outcome === 'refused') gradeRefusal('🧪 Confirm again', 'refused', r.status, r.body);
}

module.exports = { idsOf, fulfillmentsOfAnswer, confirmAgainOutcome, probeRefundedFulfillments, probeConfirmAgain };
