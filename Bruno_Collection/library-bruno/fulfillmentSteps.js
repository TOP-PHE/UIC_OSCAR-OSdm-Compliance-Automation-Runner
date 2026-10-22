/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fulfillmentSteps.js — the steps of #603, between Bruno and the pure rules
 * of fulfillmentDocuments.js.
 *
 *   06   after the fulfillments: armFulfillmentReads() lists them for 06b.
 *   06b  GET /fulfillments/{id}, once per fulfillment (readNextFulfillment /
 *        checkFulfillmentReadStep); not implemented (501, 404, …) is not a
 *        failure, as for the other optional reads (#488).
 *   07   the booking's documents (checkConfirmedBookingDocuments), and the
 *        receipts there before any refund.
 *   14   after the refund: armRefundReceiptWait() sends to 14b when the
 *        scenario waits for a receipt that is not there yet.
 *   14b  GET /bookings/{id} every 15 seconds until the receipt is there or
 *        the scenario's wait is over (waitBeforeReceiptPoll /
 *        checkRefundReceiptPoll). The access token is renewed before each
 *        read (#854): a provider's token may not outlast the wait.
 */

const { validationLogger } = require('./displays.js');
const { bruTest: test } = require('./testCapture.js');
const { parseEnvJson } = require('./envUtils.js');
const fd = require('./fulfillmentDocuments.js');
const { refreshAccessTokenIfNeeded } = require('./auth.js');

const READ_STEP = '06b. GET Fulfillment';
const AFTER_READS = '07. GET Booking after Fulfillments';
const RECEIPT_STEP = '14b. GET Booking Refund Receipt';
const POLL_EVERY_MS = 15000;

// Checks as the pure modules give them: a warning is a [WARNING] line, the
// others are tests.
function record(checks) {
  checks.forEach((c) => {
    if (c.level === 'warn') {
      if (!c.ok) validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      return;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
}

// ── 06 / 06b ────────────────────────────────────────────────────────────────

/**
 * After 06: keep which fulfillments name each document, and list the
 * fulfillments for 06b. True when 06b should run.
 */
function armFulfillmentReads(response) {
  const fulfillments = Array.isArray(response?.fulfillments) ? response.fulfillments : [];
  const ids = fulfillments.map((f) => f?.id).filter(Boolean);
  bru.setEnvVar('__fulfillmentDocHolders', JSON.stringify(fd.documentHolders(fulfillments, response?.fulfillmentDocuments)));
  bru.setEnvVar('__fulfillmentsToRead', JSON.stringify(ids));
  return ids.length > 0;
}

/** 06b's before-request: the fulfillment it reads. */
function readNextFulfillment() {
  const [next] = parseEnvJson('__fulfillmentsToRead', []) || [];
  bru.setEnvVar('fulfillmentToReadId', next || '');
  return next || null;
}

/**
 * 06b's after-response: the fulfillment answered and its documents, or a
 * read the provider does not implement. Returns the next request: 06b again
 * for the next fulfillment, else 07.
 */
function checkFulfillmentReadStep(status, body) {
  const ids = parseEnvJson('__fulfillmentsToRead', []) || [];
  const id = ids[0];
  if (status === 200) {
    checkFulfillmentAnswer(body, id);
  } else if (!checkFulfillmentNotRead(status, body, id)) {
    bru.setEnvVar('__fulfillmentsToRead', JSON.stringify([]));
    return AFTER_READS;
  }
  const rest = ids.slice(1);
  bru.setEnvVar('__fulfillmentsToRead', JSON.stringify(rest));
  return rest.length > 0 ? READ_STEP : AFTER_READS;
}

// 06b answered 200: the fulfillment and its documents.
function checkFulfillmentAnswer(body, id) {
  test('HTTP response status — expected 200, actual: 200', () => {});
  for (const p of Array.isArray(body?.problems) ? body.problems : []) {
    validationLogger(`[INFO] GET /fulfillments/${id}: the provider says ${p?.code ?? '?'} — ${p?.detail || p?.title || ''}`);
  }
  // #906: a fare fulfilment has no document to check; its own checks instead.
  if (require('./fares.js').isFareSale()) {
    const fareBooking = require('./fareBooking.js');
    fareBooking.recordFareChecks(fareBooking.fulfillmentReadChecks(body, id));
  } else {
    record(fd.checkFulfillmentRead(body, id, parseEnvJson('__fulfillmentDocHolders', {}) || {}));
  }
}

// 06b answered another status. False when the provider does not implement the
// read: no other fulfillment is read then. True otherwise.
function checkFulfillmentNotRead(status, body, id) {
  if (fareReservationRead()) {
    // #255 V12: in fare mode the client makes the fulfilment; an error is allowed.
    validationLogger(`[INFO] [fares V12] GET /fulfillments/${id} answered ${status}, which OSDM allows for a fare reservation (${require('./fareReservations.js').READ_ALLOWED}).`);
    test(`HTTP response status — 06b. GET Fulfillment returns ${status}, allowed for a fare reservation (OSDM handling reservations)`, () => {});
    return true;
  }
  const { classifySystemInfoStatus } = require('./osdmCompliance.js');
  const cls = classifySystemInfoStatus(status, 'Fulfillment', body);
  if (cls.outcome === 'skip') {
    if (cls.log) validationLogger(cls.log);
    test(`HTTP response status — not implemented by this provider (auto-detected): 06b. GET Fulfillment returns ${status}`, () => {});
    return false;
  }
  test(`HTTP response status — expected 200, actual: ${status}`, () => { throw new Error(cls.message || `HTTP ${status} received, expected 200`); });
  return true;
}

// #255: the read of a fulfilment in a fare sale that holds fare reservations.
function fareReservationRead() {
  return require('./fares.js').isFareSale() && (parseEnvJson('__fareReservationIds', []) || []).length > 0;
}

// ── 07 ──────────────────────────────────────────────────────────────────────

/**
 * 07: the documents of the confirmed booking (warnings), and the receipts
 * already there, so that a refund receipt is told apart from them.
 */
function checkConfirmedBookingDocuments(booking) {
  if (!booking) return;
  bru.setEnvVar('__infoDocKeysBeforeRefund', JSON.stringify(fd.informationKeys(booking)));
  const fulfillments = Array.isArray(booking.fulfillments) ? booking.fulfillments : [];
  if (fulfillments.length === 0) return;
  const media = (parseEnvJson('offerFulfillmentOptions', []) || []).map((o) => o?.media).filter(Boolean);
  const { checks, summary } = fd.checkBookingDocuments(fulfillments, booking.fulfillmentDocuments, media);
  validationLogger(`[INFO] 📄 Documents — ${summary}`);
  record(checks);
}

// ── 14 / 14b ────────────────────────────────────────────────────────────────

// The scenario's wait for the refund receipt, in minutes (1 to 60), or 0.
function receiptWaitMinutes() {
  const minutes = Number.parseInt(bru.getEnvVar('refundReceiptMaxWaitMinutes') || '', 10);
  return minutes >= 1 && minutes <= 60 ? minutes : 0;
}

// afterMs: how long after the refund it was found, or null when it was there at once.
function receiptFound(doc, afterMs) {
  const when = afterMs === null ? '' : ' after ' + Math.round(afterMs / 1000) + ' s';
  test(`Refund receipt: in the booking${when} — ${doc.id || doc.downloadLink || 'a document'} (${doc.type})`, () => {});
  record(fd.checkRefundReceipt(doc));
}

/**
 * 14, once every refund offer is confirmed: when the scenario waits for a
 * receipt, check the booking just read; if it is not there yet, arm 14b.
 * True when 14b should run.
 */
function armRefundReceiptWait(booking) {
  const minutes = receiptWaitMinutes();
  if (minutes === 0) return false;
  const before = parseEnvJson('__infoDocKeysBeforeRefund', []) || [];
  const receipt = fd.findRefundReceipt(booking, before);
  if (receipt) {
    receiptFound(receipt, null);
    return false;
  }
  const now = Date.now();
  bru.setEnvVar('__refundReceiptStart', String(now));
  bru.setEnvVar('__refundReceiptDeadline', String(now + minutes * 60000));
  validationLogger(`[INFO] 🧾 Refund receipt not in the booking yet — reading it again every ${POLL_EVERY_MS / 1000} s, for up to ${minutes} minute(s).`);
  return true;
}

/**
 * 14b's before-request: wait before reading the booking again, then renew
 * the access token if it is near its end (#854). Not forced: OSCAR's cache
 * keeps a safety margin and fetches a token only when needed. A failed
 * renewal logs a WARNING and the read goes with the token it has.
 */
async function waitBeforeReceiptPoll() {
  const deadline = Number(bru.getEnvVar('__refundReceiptDeadline')) || 0;
  const waitMs = Math.max(0, Math.min(POLL_EVERY_MS, deadline - Date.now()));
  if (waitMs > 0) await new Promise((resolve) => { setTimeout(resolve, waitMs); });
  await refreshAccessTokenIfNeeded({ callerLabel: RECEIPT_STEP });
}

/**
 * 14b's after-response. 'again' while the receipt is not there and the wait
 * is not over; 'done' when it is found, or when the wait is over (a failure:
 * the scenario asked for it).
 */
function checkRefundReceiptPoll(status, body) {
  const start = Number(bru.getEnvVar('__refundReceiptStart')) || Date.now();
  const deadline = Number(bru.getEnvVar('__refundReceiptDeadline')) || 0;
  const receipt = status === 200 ? fd.findRefundReceipt(body?.booking, parseEnvJson('__infoDocKeysBeforeRefund', []) || []) : null;
  if (status !== 200) validationLogger(`[WARNING] Refund receipt: GET /bookings answered ${status}; reading it again.`);
  if (!receipt && Date.now() < deadline) return 'again';
  bru.setEnvVar('__refundReceiptDeadline', null);
  if (receipt) {
    receiptFound(receipt, Date.now() - start);
  } else {
    const minutes = receiptWaitMinutes();
    test(`Refund receipt: in the booking within ${minutes} minute(s)`, () => {
      throw new Error(`no document of type INFORMATION appeared in the booking (documents or fulfillmentDocuments) within ${minutes} minute(s) of the refund`);
    });
  }
  return 'done';
}

module.exports = {
  READ_STEP, AFTER_READS, RECEIPT_STEP, POLL_EVERY_MS,
  armFulfillmentReads, readNextFulfillment, checkFulfillmentReadStep, checkConfirmedBookingDocuments,
  armRefundReceiptWait, waitBeforeReceiptPoll, checkRefundReceiptPoll,
};
