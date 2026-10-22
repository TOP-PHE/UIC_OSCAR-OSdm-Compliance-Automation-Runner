// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * versionShapes.js — an answer in the shapes of the provider's OSDM version
 * (#833).
 *
 * The simulator builds every answer in the OSDM 3.8 shapes. Just before an
 * answer leaves, a provider of an earlier version (alpha 3.6, beta 3.7) gets
 * it in its own version's shapes:
 *
 *  - below 3.8, a fulfilment holds its documents (`fulfillmentDocuments`)
 *    instead of naming them (`fulfillmentDocumentRefs`) from a list of the
 *    booking or of the answer; a document has no `id` or `controlNumber`;
 *    `distributionMode`, `summaryTranslations` and a fare's `isProviderFee`
 *    do not exist;
 *  - below 3.7, `inboundTripCoverage`, `isIncluded`, `compartmentNumber` and
 *    `fulfillmentStatus` and a fare route's `routeSummary` do not exist.
 *
 * Each member removed by name exists in no schema of the earlier version, so
 * removing it wherever it is found removes nothing that version has.
 * tests/osdm-conformance.js checks every answer of the tests against the
 * response schema of the provider's version: a member this file misses
 * fails a test.
 */

const rank = (version) => {
  const [major, minor] = String(version || '').split('.').map((x) => Number.parseInt(x, 10) || 0);
  return major * 100 + minor;
};

// Members that do not exist below a version, by name.
const ABSENT_BELOW = [
  { below: '3.8', names: ['fulfillmentDocumentRefs', 'distributionMode', 'summaryTranslations', 'isProviderFee'] },
  { below: '3.7', names: ['inboundTripCoverage', 'isIncluded', 'compartmentNumber', 'fulfillmentStatus', 'routeSummary'] },
];

// A FulfillmentDocument's members that 3.8 added.
const DOCUMENT_MEMBERS_3_8 = new Set(['id', 'controlNumber']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The documents of one list that have an id.
function addDocuments(list, found) {
  for (const doc of list) {
    if (isObject(doc) && doc.id) found.set(doc.id, doc);
  }
}

// Every document of the answer that has an id, wherever a list of them is.
function documentsById(value, found = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) documentsById(item, found);
  } else if (isObject(value)) {
    if (Array.isArray(value.fulfillmentDocuments)) addDocuments(value.fulfillmentDocuments, found);
    for (const child of Object.values(value)) documentsById(child, found);
  }
  return found;
}

const documentBefore38 = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !DOCUMENT_MEMBERS_3_8.has(k)));

// A booking's own document as OSDM's `Document` (3.6, 3.7): id, type, scope,
// format and content; `Document` has no medium.
const bookingDocumentBefore38 = (doc) => Object.fromEntries(Object.entries({
  id: doc.id, type: doc.type, scope: 'BOOKING', format: doc.format, content: doc.content,
}).filter(([, v]) => v !== undefined));

// #914: the booking's documents that no fulfilment names (the refund
// receipt) go to `Booking.documents` below 3.8, scoped to the booking;
// before, they were lost with the booking's list.
function keepBookingDocuments(booking) {
  if (!Array.isArray(booking.fulfillments)) return;
  const named = new Set(booking.fulfillments.flatMap((f) => (Array.isArray(f?.fulfillmentDocumentRefs) ? f.fulfillmentDocumentRefs : [])));
  const own = booking.fulfillmentDocuments.filter((d) => isObject(d) && !named.has(d.id)).map(bookingDocumentBefore38);
  if (own.length) booking.documents = [...(Array.isArray(booking.documents) ? booking.documents : []), ...own];
}

// Below 3.8: each fulfilment holds the documents it names; the lists of the
// booking and of the answer go.
function nestDocuments(value, docs) {
  if (Array.isArray(value)) { value.forEach((item) => nestDocuments(item, docs)); return; }
  if (!isObject(value)) return;
  if (Array.isArray(value.fulfillmentDocumentRefs)) {
    const held = value.fulfillmentDocumentRefs.map((id) => docs.get(id)).filter(Boolean).map(documentBefore38);
    delete value.fulfillmentDocumentRefs;
    if (held.length) value.fulfillmentDocuments = held;
    else delete value.fulfillmentDocuments;
  } else if (Array.isArray(value.fulfillmentDocuments) && !('status' in value && 'bookingRef' in value)) {
    // A list that is not a fulfilment's own: the booking's or the answer's.
    keepBookingDocuments(value);
    delete value.fulfillmentDocuments;
  }
  for (const child of Object.values(value)) nestDocuments(child, docs);
}

function removeNames(value, names) {
  if (Array.isArray(value)) { value.forEach((item) => removeNames(item, names)); return; }
  if (!isObject(value)) return;
  for (const name of names) delete value[name];
  for (const child of Object.values(value)) removeNames(child, names);
}

/**
 * The answer as a provider of `version` gives it: the same object for 3.8
 * and later, else a changed copy.
 */
function shapeAnswer(body, version) {
  if (!isObject(body) || rank(version) >= rank('3.8')) return body;
  const out = structuredClone(body);
  nestDocuments(out, documentsById(out));
  for (const rule of ABSENT_BELOW) {
    if (rank(version) < rank(rule.below)) removeNames(out, rule.names);
  }
  return out;
}

module.exports = { shapeAnswer, ABSENT_BELOW, rank };
