/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * refundPerFulfillment.js — a provider that takes one fulfillment per refund
 * offer request (#883).
 *
 * OSDM's RefundOfferRequest.fulfillmentIds is a list (minItems 1, no maximum).
 * A real provider refuses a list of more than one with
 *   501 VALUE_NOT_SUPPORTED "Only one value (single-element array) is
 *   expected for the 'fulfillmentIds' parameter"
 * so a booking with one ticket per direction could not be refunded at all.
 *
 * Step 10 then says so once (a WARNING: OSDM allows the list), asks one refund
 * offer per fulfillment from its own script, the same body with one id and the
 * refund specifications of that fulfillment, and goes on with all the refund
 * offers together: the answers read as one answer giving one offer per
 * fulfillment, which step 13 already confirms in turn (#595).
 *
 * Only a refusal whose Problem names `fulfillmentIds`, of a request naming
 * several, takes this path; any other refusal is graded as before.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The Problems of an answer: the body itself, or its `problems` list. */
function problemsOf(body) {
  if (!isObj(body)) return [];
  const listed = Array.isArray(body.problems) ? body.problems.filter(isObj) : [];
  return body.code || body.title || body.detail ? [body, ...listed] : listed;
}

// The text of a Problem that may name a member: title, detail and pointers.
function textOf(problem) {
  const pointers = (Array.isArray(problem.pointers) ? problem.pointers : [])
    .map((p) => (isObj(p) ? p.pointer : p)).filter((p) => typeof p === 'string');
  return [problem.title, problem.detail, ...pointers].filter((t) => typeof t === 'string').join(' — ');
}

/**
 * True when a refund offer request naming several fulfillments was refused
 * (4xx, or 501) by a Problem naming `fulfillmentIds`.
 */
function refusesSeveralFulfillments(status, body, asked) {
  const n = Number(status);
  if (!Array.isArray(asked) || asked.length < 2) return false;
  if (!((n >= 400 && n < 500) || n === 501)) return false;
  return problemsOf(body).some((p) => /fulfillmentIds/i.test(textOf(p)));
}

/** One request body per fulfillment: one id, and that fulfillment's specifications. */
function bodiesPerFulfillment(body) {
  const ids = Array.isArray(body?.fulfillmentIds) ? body.fulfillmentIds : [];
  const specs = Array.isArray(body?.refundSpecifications) ? body.refundSpecifications : null;
  return ids.map((id) => {
    const one = { ...body, fulfillmentIds: [id] };
    if (specs) {
      const own = specs.filter((s) => isObj(s) && s.fulfillmentId === id);
      if (own.length > 0) one.refundSpecifications = own;
      else delete one.refundSpecifications;
    }
    return one;
  });
}

const offersOf = (body) => {
  if (!isObj(body) || body.refundOffers == null) return [];
  return Array.isArray(body.refundOffers) ? body.refundOffers : [body.refundOffers];
};

/**
 * The answers to the requests one per fulfillment, read as one answer. Each
 * refund offer once (#893): a provider may answer each request with every
 * refund offer of the booking still proposed, the earlier ones included. The
 * latest copy of an offer is kept, in the order first seen; `repeated` counts
 * the copies left out. An offer without an id is kept as it is.
 */
function combineAnswers(bodies) {
  const offers = [];
  const at = new Map();
  let repeated = 0;
  for (const offer of bodies.flatMap(offersOf)) {
    const id = isObj(offer) && typeof offer.id === 'string' && offer.id ? offer.id : null;
    if (id !== null && at.has(id)) {
      offers[at.get(id)] = offer;
      repeated += 1;
      continue;
    }
    if (id !== null) at.set(id, offers.length);
    offers.push(offer);
  }
  const combined = { refundOffers: offers };
  if (repeated > 0) combined.repeated = repeated;
  const problems = bodies.flatMap((b) => (isObj(b) && Array.isArray(b.problems) ? b.problems : []));
  if (problems.length > 0) combined.problems = problems;
  return combined;
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

const log = (line) => require('./displays.js').validationLogger(line);

function readBody() {
  const raw = bru.getEnvVar('requestRefundOffersBodyData');
  if (isObj(raw)) return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

async function post(path, body) {
  const { requestorHeader } = require('./requestHeaders.js');
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
        data: JSON.stringify(body),
      }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
    });
    let data = res?.data ?? res?.body ?? null;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { /* not JSON: kept as text */ }
    }
    return { status: res?.status || res?.statusCode || 0, body: data };
  } catch (err) {
    log(`[ERROR] Refund offer request for one fulfillment could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

/**
 * Step 10, after the response. When the provider refused a request naming
 * several fulfillments, asks one refund offer per fulfillment and returns
 * { status, body } to grade instead of the answer: 200 and every refund offer
 * together, or the first request that failed. Null otherwise.
 */
async function askOnePerFulfillment(status, answer) {
  const body = readBody();
  const asked = Array.isArray(body.fulfillmentIds) ? body.fulfillmentIds : [];
  if (!refusesSeveralFulfillments(status, answer, asked)) return null;
  const reason = problemsOf(answer).map(textOf).find((t) => /fulfillmentIds/i.test(t)) || '';
  log(`[WARNING] Refund offers: the provider refuses a request naming ${asked.length} fulfillments (HTTP ${status}: "${reason.slice(0, 200)}"). OSDM allows a list; a distributor must then ask one refund offer per fulfillment. Asked one at a time.`);
  const path = `/bookings/${bru.getEnvVar('bookingId')}/refund-offers`;
  const answers = [];
  for (const one of bodiesPerFulfillment(body)) {
    const id = one.fulfillmentIds[0];
    const r = await post(path, one);
    test(`Refund offer request for fulfillment ${id} alone — HTTP 200`, () => {
      if (r.status !== 200) throw new Error(`HTTP ${r.status} received, expected 200`);
    });
    if (r.status !== 200) return r;
    answers.push(r.body);
  }
  const combined = combineAnswers(answers);
  if (combined.repeated) {
    log(`[INFO] Refund offers: ${combined.repeated} refund offer(s) came again in the answer for a later fulfillment; each is counted once.`);
    delete combined.repeated;
  }
  log(`[INFO] Refund offers asked one fulfillment at a time: ${combined.refundOffers.length} refund offer(s) for ${asked.length} fulfillments.`);
  return { status: 200, body: combined };
}

module.exports = { problemsOf, refusesSeveralFulfillments, bodiesPerFulfillment, combineAnswers, askOnePerFulfillment };
