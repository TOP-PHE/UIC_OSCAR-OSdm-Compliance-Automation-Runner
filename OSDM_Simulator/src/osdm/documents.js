// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * documents.js — fulfilment documents and the refund receipt (#603).
 *
 * A provider whose profile lists `documents` issues, on confirmation, the
 * documents of the media the booking asked for (its offers' fulfilment
 * options), in the OSDM 3.8 shape: the documents in the booking's
 * `fulfillmentDocuments`, each fulfilment naming its own in
 * `fulfillmentDocumentRefs`.
 *   PDF_A4        one PDF for the whole booking, every fulfilment and
 *                 passenger merged (as ČD does): every fulfilment names it;
 *   RETAILER_APP  one PNG per fulfilment, for a mobile application.
 * GET /fulfillments/{id} gives one fulfilment and its documents; when the
 * merged PDF covers other fulfilments too, a Problem says so.
 *
 * After a refund is confirmed, a receipt (type INFORMATION, PDF_A4) appears in
 * the booking's documents `refundReceiptDelaySeconds` later, and only in
 * GET /bookings/{id}.
 */

const crypto = require('node:crypto');

// The smallest files that are what they say: a PDF, and a PNG of one pixel.
const PDF_CONTENT = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'latin1').toString('base64');
const PNG_CONTENT = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';

// Each medium: its format, its content, and whether one document covers the
// whole booking or each fulfilment has its own.
const MEDIA = {
  PDF_A4: { format: 'application/pdf', content: PDF_CONTENT, perBooking: true },
  RETAILER_APP: { format: 'image/png', content: PNG_CONTENT, perBooking: false },
};

const RECEIPT_DUE = Symbol('refund receipt due');
const randomId = () => crypto.randomBytes(8).toString('hex');
const listOf = (value) => (Array.isArray(value) ? value : []);

// The media of the documents to issue: those the booking's offers asked for
// that the provider issues, in the order of its profile.
function mediaOf(booking, provider) {
  const asked = new Set(booking.bookedOffers
    .flatMap((o) => listOf(o.admissions))
    .flatMap((a) => listOf(a.availableFulfillmentOptions))
    .map((option) => option?.media));
  return listOf(provider.documents).filter((medium) => asked.has(medium) && MEDIA[medium]);
}

// #833: a FulfillmentDocument has no summary in OSDM; a ticket of one
// fulfilment names its control number (3.8).
const documentOf = (provider, medium, controlNumber) => ({
  id: `${provider.idPrefix}-DOC-${randomId()}`,
  medium,
  type: 'TICKET',
  format: MEDIA[medium].format,
  content: MEDIA[medium].content,
  ...(controlNumber ? { controlNumber } : {}),
});

/**
 * On confirmation: the booking's documents, and each fulfilment's references
 * to them. `fulfillments` are those that get documents: a fare fulfilment
 * gets none (#906).
 */
function issueDocuments(booking, provider, fulfillments = booking.fulfillments) {
  const documents = [];
  for (const medium of mediaOf(booking, provider)) {
    if (MEDIA[medium].perBooking) {
      const merged = documentOf(provider, medium);
      documents.push(merged);
      for (const fulfillment of fulfillments) fulfillment.fulfillmentDocumentRefs = [...listOf(fulfillment.fulfillmentDocumentRefs), merged.id];
    } else {
      for (const fulfillment of fulfillments) {
        const own = documentOf(provider, medium, fulfillment.controlNumber);
        documents.push(own);
        fulfillment.fulfillmentDocumentRefs = [...listOf(fulfillment.fulfillmentDocumentRefs), own.id];
      }
    }
  }
  if (documents.length > 0) booking.fulfillmentDocuments = documents;
}

/** #906, variant `fare-fulfillment-document`: a PDF ticket a fare fulfilment should not have. */
function attachTicket(booking, fulfillment, provider) {
  const ticket = documentOf(provider, 'PDF_A4');
  booking.fulfillmentDocuments = [...listOf(booking.fulfillmentDocuments), ticket];
  fulfillment.fulfillmentDocumentRefs = [...listOf(fulfillment.fulfillmentDocumentRefs), ticket.id];
}

/**
 * GET /fulfillments/{id}: the fulfilment and the documents it names. A
 * document another fulfilment names too (the merged PDF) is said in a Problem.
 */
function fulfillmentWithDocuments(booking, fulfillment) {
  const refs = new Set(listOf(fulfillment.fulfillmentDocumentRefs));
  const fulfillmentDocuments = listOf(booking.fulfillmentDocuments).filter((d) => refs.has(d.id));
  const answer = { fulfillment, fulfillmentDocuments };
  const shared = fulfillmentDocuments.filter((d) => booking.fulfillments.some((f) => f !== fulfillment && listOf(f.fulfillmentDocumentRefs).includes(d.id)));
  if (shared.length > 0) {
    answer.problems = [{
      code: 'DOCUMENT_COVERS_MORE_FULFILLMENTS',
      type: 'https://osdm.io/spec/errors-problems',
      title: 'The document covers more than this fulfillment',
      detail: `Document(s) ${shared.map((d) => d.id).join(', ')} hold every fulfillment and passenger of the booking, not only ${fulfillment.id}.`,
    }];
  }
  return answer;
}

/** A refund was confirmed: the receipt is due after the provider's delay (once). */
function noteRefund(booking, provider, nowMs) {
  if (!provider.documents || booking[RECEIPT_DUE] !== undefined) return;
  Object.defineProperty(booking, RECEIPT_DUE, { value: nowMs + provider.refundReceiptDelaySeconds * 1000 });
}

/** On a read of the booking: the receipt, once it is due. */
function showRefundReceipt(booking, provider, nowMs) {
  const due = booking[RECEIPT_DUE];
  if (due === undefined || nowMs < due) return;
  const documents = listOf(booking.fulfillmentDocuments);
  if (documents.some((d) => d.type === 'INFORMATION')) return;
  booking.fulfillmentDocuments = [...documents, {
    id: `${provider.idPrefix}-DOC-${randomId()}`,
    medium: 'PDF_A4',
    type: 'INFORMATION',
    format: 'application/pdf',
    content: PDF_CONTENT,
  }];
}

module.exports = { issueDocuments, attachTicket, fulfillmentWithDocuments, noteRefund, showRefundReceipt, MEDIA };
