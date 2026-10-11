/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fulfillmentDocuments.js — the documents of a confirmed booking, and the
 * refund receipt (#603).
 *
 * Where the documents are depends on the OSDM version:
 *   up to 3.7  in each fulfillment, `fulfillmentDocuments`;
 *   3.8        in the booking (or the fulfillment response), each fulfillment
 *              naming its own in `fulfillmentDocumentRefs` (the nested list is
 *              deprecated but still read).
 * Every check here is a warning (maintainer decision): the media asked for
 * are delivered, each document's format fits its medium and its content is
 * what the format says, and the ČD way of delivering them: one PDF for the
 * whole booking, one PNG per fulfillment for a mobile application.
 *
 * After a refund, a receipt (type INFORMATION) may appear in the booking some
 * minutes later, in `documents` or in `fulfillmentDocuments`.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-fulfillment-documents.test.js.
 */

const listOf = (value) => (Array.isArray(value) ? value : []);

// The formats each medium may come in. A medium not listed is not checked.
const FORMATS = {
  PDF_A4: ['application/pdf'],
  UIC_PDF: ['application/pdf'],
  RETAILER_APP: ['image/png', 'image/jpeg'],
  DISTRIBUTOR_APP: ['image/png', 'image/jpeg'],
  ALLOCATOR_APP: ['image/png', 'image/jpeg'],
  PKPASS: ['application/vnd.apple.pkpass'],
};

// How the first bytes of a file of each format begin.
const SIGNATURES = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
};

// A document's own reference: its id, else its link.
const keyOf = (doc) => doc?.id || doc?.downloadLink || null;

/**
 * The documents of each fulfillment: those nested in it, and those its
 * fulfillmentDocumentRefs name among `siblings` (the booking's or the
 * response's fulfillmentDocuments).
 * @returns {Map<string, object[]>} fulfillment id → documents
 */
function documentsByFulfillment(fulfillments, siblings) {
  const byId = new Map(listOf(siblings).filter((d) => d?.id).map((d) => [String(d.id), d]));
  return new Map(listOf(fulfillments).filter((f) => f?.id).map((f) => {
    const nested = listOf(f.fulfillmentDocuments);
    const referred = listOf(f.fulfillmentDocumentRefs).map((ref) => byId.get(String(ref))).filter(Boolean);
    return [String(f.id), [...nested, ...referred]];
  }));
}

/** The fulfillments naming each document: document key → fulfillment ids. */
function holdersOf(byFulfillment) {
  const holders = new Map();
  for (const [fulfillmentId, docs] of byFulfillment) {
    for (const key of new Set(docs.map(keyOf).filter(Boolean))) {
      holders.set(key, [...(holders.get(key) || []), fulfillmentId]);
    }
  }
  return holders;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// The first bytes of a base64 content (its first eight characters give six
// bytes), or null when it is not base64. Decoded by hand: Bruno's sandbox
// need not give scripts a Buffer.
function firstBytes(content, count) {
  if (typeof content !== 'string') return null;
  const values = Array.from(content.slice(0, 8), (c) => BASE64.indexOf(c));
  if (values.length < 8 || values.some((v) => v < 0)) return null;
  const bytes = [];
  for (let i = 0; i < 8; i += 4) {
    const n = (values[i] << 18) | (values[i + 1] << 12) | (values[i + 2] << 6) | values[i + 3];
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  return bytes.slice(0, count);
}

/** The checks of one document: its format fits its medium, its content is that format. */
function checkDocument(doc, label) {
  const checks = [];
  const allowed = FORMATS[doc?.medium];
  if (allowed) {
    checks.push({
      name: `${label}: a ${doc.medium} document is ${allowed.join(' or ')}`,
      ok: allowed.includes(doc.format),
      level: 'warn',
      message: `its format is ${doc.format ?? 'not given'}`,
    });
  }
  const signature = SIGNATURES[doc?.format];
  const bytes = signature && firstBytes(doc.content, signature.length);
  if (bytes) {
    checks.push({
      name: `${label}: its content is of type ${doc.format}`,
      ok: signature.every((b, i) => bytes[i] === b),
      level: 'warn',
      message: `its first bytes are not those of ${doc.format}`,
    });
  }
  return checks;
}

/**
 * The checks of the documents of a confirmed booking (all warnings), and a
 * line saying how they are delivered.
 * @param {object[]} fulfillments
 * @param {object[]} siblings      the booking's / response's fulfillmentDocuments
 * @param {string[]} requestedMedia the media the scenario asked for
 * @returns {{ checks: object[], summary: string }}
 */
function checkBookingDocuments(fulfillments, siblings, requestedMedia) {
  const byFulfillment = documentsByFulfillment(fulfillments, siblings);
  const all = [...new Map([...byFulfillment.values()].flat().map((d) => [keyOf(d) || d, d])).values()];
  const holders = holdersOf(byFulfillment);
  const checks = [];
  for (const medium of new Set(listOf(requestedMedia).filter(Boolean))) {
    const found = all.filter((d) => d.medium === medium);
    checks.push({ name: `Documents: the ${medium} medium asked for is delivered — ${found.length} document(s)`, ok: found.length > 0, level: 'warn', message: `no ${medium} document on the booking's ${byFulfillment.size} fulfillment(s)` });
  }
  all.forEach((doc, i) => checks.push(...checkDocument(doc, `Document ${keyOf(doc) || i + 1}`)));
  // ČD: one PNG per fulfillment for a mobile application.
  if (all.some((d) => d.medium === 'RETAILER_APP')) {
    const without = [...byFulfillment].filter(([, docs]) => !docs.some((d) => d.medium === 'RETAILER_APP')).map(([id]) => id);
    const shared = all.filter((d) => d.medium === 'RETAILER_APP' && (holders.get(keyOf(d)) || []).length > 1).map(keyOf);
    checks.push({
      name: 'Documents: one RETAILER_APP document per fulfillment',
      ok: without.length === 0 && shared.length === 0,
      level: 'warn',
      message: without.length > 0 ? `fulfillment(s) without one: ${without.join(', ')}` : `shared by several fulfillments: ${shared.join(', ')}`,
    });
  }
  const merged = all.filter((d) => FORMATS.PDF_A4.includes(d.format) && (holders.get(keyOf(d)) || []).length > 1);
  const describe = (d) => [d.medium ?? '?', d.type, d.format].filter(Boolean).join(' ');
  const mergedNote = merged.length > 0
    ? '; ' + merged.length + ' PDF(s) merged for several fulfillments (' + merged.map((d) => (holders.get(keyOf(d)) || []).length).join(', ') + ')'
    : '';
  const summary = `${all.length} document(s) on ${byFulfillment.size} fulfillment(s): ${all.map(describe).join('; ') || 'none'}${mergedNote}`;
  return { checks, summary };
}

/** Which fulfillments name each document, as kept between steps: { key: [fulfillment ids] }. */
function documentHolders(fulfillments, siblings) {
  return Object.fromEntries(holdersOf(documentsByFulfillment(fulfillments, siblings)));
}

/**
 * The checks of GET /fulfillments/{id}: the fulfillment asked for is the one
 * answered (failure otherwise), and its documents (warnings), among which a
 * document that also holds other fulfillments (a merged PDF).
 * @param {object} body           the FulfillmentResponse
 * @param {string} fulfillmentId
 * @param {object} holders        documentHolders() of the booking
 */
function checkFulfillmentRead(body, fulfillmentId, holders) {
  const fulfillment = body?.fulfillment;
  const checks = [{ name: `Fulfillment ${fulfillmentId}: the answer is that fulfillment`, ok: fulfillment?.id === fulfillmentId, message: `the answer's fulfillment is ${fulfillment?.id ?? 'missing'}` }];
  if (!fulfillment) return checks;
  const docs = documentsByFulfillment([fulfillment], body.fulfillmentDocuments).get(String(fulfillment.id)) || [];
  docs.forEach((doc, i) => checks.push(...checkDocument(doc, `Fulfillment ${fulfillmentId}, document ${keyOf(doc) || i + 1}`)));
  for (const doc of docs) {
    const others = listOf(holders?.[keyOf(doc)]).filter((id) => id !== fulfillmentId);
    if (others.length > 0) {
      checks.push({ name: `Fulfillment ${fulfillmentId}: document ${keyOf(doc)} covers this fulfillment only`, ok: false, level: 'warn', message: `it also holds ${others.join(', ')} (a ${doc.medium ?? ''} merged for the booking)` });
    }
  }
  return checks;
}

/** Every receipt-like document of a booking (type INFORMATION), wherever it is. */
function informationDocuments(booking) {
  const nested = listOf(booking?.fulfillments).flatMap((f) => listOf(f?.fulfillmentDocuments));
  return [...listOf(booking?.documents), ...listOf(booking?.fulfillmentDocuments), ...nested]
    .filter((d) => d?.type === 'INFORMATION');
}

/** The keys of the booking's INFORMATION documents, before the refund. */
function informationKeys(booking) {
  return informationDocuments(booking).map((d) => keyOf(d) || JSON.stringify(d));
}

/** The refund receipt: an INFORMATION document that was not there before the refund, or null. */
function findRefundReceipt(booking, keysBefore) {
  const before = new Set(listOf(keysBefore));
  return informationDocuments(booking).find((d) => !before.has(keyOf(d) || JSON.stringify(d))) || null;
}

/** The checks of the receipt found (warnings): a PDF, with something to read. */
function checkRefundReceipt(doc) {
  const isPdf = doc.format === 'application/pdf' || doc.medium === 'PDF_A4';
  return [
    { name: 'Refund receipt: a PDF', ok: isPdf, level: 'warn', message: `medium ${doc.medium ?? 'not given'}, format ${doc.format ?? 'not given'}` },
    { name: 'Refund receipt: has a content or a download link', ok: !!(doc.content || doc.downloadLink), level: 'warn', message: 'neither content nor downloadLink' },
  ];
}

module.exports = {
  FORMATS, documentsByFulfillment, checkBookingDocuments, documentHolders, checkFulfillmentRead,
  informationKeys, findRefundReceipt, checkRefundReceipt,
};
