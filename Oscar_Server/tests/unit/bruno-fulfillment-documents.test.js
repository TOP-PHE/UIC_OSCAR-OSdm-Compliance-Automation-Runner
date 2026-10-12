// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-fulfillment-documents.test.js — #603: the documents of a confirmed
 * booking, GET /fulfillments/{id}, and the refund receipt.
 *
 * The collection checked that each document had something to download, but
 * not the media asked for, nor that a document is what its format says, nor
 * the ČD way of delivering them (one PDF merged for the booking, one PNG per
 * fulfillment). Every such check is a warning (maintainer decision). The
 * refund receipt, which some providers add minutes after the refund, is
 * awaited when the scenario says so, and its absence is a failure.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const fd = require('../../../Bruno_Collection/library-bruno/fulfillmentDocuments.js');
const steps = require('../../../Bruno_Collection/library-bruno/fulfillmentSteps.js');

beforeEach(() => { envStore = {}; mockResults = []; mockLogs = []; });

const b64 = (text) => Buffer.from(text, 'latin1').toString('base64');
const PDF = b64('%PDF-1.4 merged');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==';
const pdf = (id) => ({ id, medium: 'PDF_A4', type: 'TICKET', format: 'application/pdf', content: PDF });
const png = (id) => ({ id, medium: 'RETAILER_APP', type: 'TICKET', format: 'image/png', content: PNG });
// The ČD way, in the 3.8 shape: one PDF for the booking, one PNG per fulfillment.
const siblings = [pdf('D-PDF'), png('D-PNG1'), png('D-PNG2')];
const fulfillments = [
  { id: 'F1', fulfillmentDocumentRefs: ['D-PDF', 'D-PNG1'] },
  { id: 'F2', fulfillmentDocumentRefs: ['D-PDF', 'D-PNG2'] },
];
const warned = (checks) => checks.filter((c) => !c.ok).map((c) => c.name);

describe('where the documents are', () => {
  test('3.8: referred from the fulfillment to the booking; up to 3.7: nested; both read', () => {
    const nested = [{ id: 'F0', fulfillmentDocuments: [pdf('N1')] }];
    const byF = fd.documentsByFulfillment([...fulfillments, ...nested], siblings);
    expect(byF.get('F1').map((d) => d.id)).toEqual(['D-PDF', 'D-PNG1']);
    expect(byF.get('F0').map((d) => d.id)).toEqual(['N1']);
    expect(fd.documentHolders(fulfillments, siblings)).toEqual({ 'D-PDF': ['F1', 'F2'], 'D-PNG1': ['F1'], 'D-PNG2': ['F2'] });
  });

  test('a reference to no document is left out, not invented', () => {
    expect(fd.documentsByFulfillment([{ id: 'F', fulfillmentDocumentRefs: ['GONE'] }], siblings).get('F')).toEqual([]);
  });
});

describe('the documents of the booking (all warnings)', () => {
  test('the ČD way passes every check, and the summary names the merged PDF', () => {
    const { checks, summary } = fd.checkBookingDocuments(fulfillments, siblings, ['PDF_A4', 'RETAILER_APP']);
    expect(warned(checks)).toEqual([]);
    expect(checks.every((c) => c.level === 'warn')).toBe(true);
    expect(summary).toBe('3 document(s) on 2 fulfillment(s): PDF_A4 TICKET application/pdf; RETAILER_APP TICKET image/png; RETAILER_APP TICKET image/png; 1 PDF(s) merged for several fulfillments (2)');
  });

  test('a medium asked for and not delivered', () => {
    const { checks } = fd.checkBookingDocuments(fulfillments, [pdf('D-PDF')], ['PDF_A4', 'RETAILER_APP']);
    expect(warned(checks)).toEqual(['Documents: the RETAILER_APP medium asked for is delivered — 0 document(s)']);
  });

  test('a format that does not fit the medium, and a content that is not its format', () => {
    const wrong = [{ ...pdf('D-PDF'), format: 'image/png' }, { ...png('D-PNG1'), content: PDF }, png('D-PNG2')];
    expect(warned(fd.checkBookingDocuments(fulfillments, wrong, []).checks)).toEqual([
      'Document D-PDF: a PDF_A4 document is application/pdf',
      'Document D-PDF: its content is of type image/png',
      'Document D-PNG1: its content is of type image/png',
    ]);
  });

  test('a content that is not base64, or a link only, is not read', () => {
    const linked = [{ ...pdf('D-PDF'), content: undefined, downloadLink: 'https://x.example/d.pdf' }, { ...png('D-PNG1'), content: '!!not base64!!' }, png('D-PNG2')];
    expect(warned(fd.checkBookingDocuments(fulfillments, linked, []).checks)).toEqual([]);
  });

  test('one PNG per fulfillment: a fulfillment without one, or one PNG shared', () => {
    const missing = fd.checkBookingDocuments([fulfillments[0], { id: 'F2', fulfillmentDocumentRefs: ['D-PDF'] }], siblings, []).checks;
    expect(missing.find((c) => !c.ok).message).toBe('fulfillment(s) without one: F2');
    const shared = fd.checkBookingDocuments([fulfillments[0], { id: 'F2', fulfillmentDocumentRefs: ['D-PDF', 'D-PNG1'] }], siblings, []).checks;
    expect(shared.find((c) => !c.ok).message).toBe('shared by several fulfillments: D-PNG1');
  });

  test('a PDF per fulfillment is fine too: the summary says nothing is merged', () => {
    const own = [{ id: 'F1', fulfillmentDocuments: [pdf('P1')] }, { id: 'F2', fulfillmentDocuments: [pdf('P2')] }];
    const { checks, summary } = fd.checkBookingDocuments(own, [], ['PDF_A4']);
    expect(warned(checks)).toEqual([]);
    expect(summary).not.toMatch(/merged/);
  });
});

describe('GET /fulfillments/{id}', () => {
  const holders = fd.documentHolders(fulfillments, siblings);

  test('the fulfillment asked for, with a merged PDF: a warning naming the other fulfillment', () => {
    const checks = fd.checkFulfillmentRead({ fulfillment: fulfillments[1], fulfillmentDocuments: [siblings[0], siblings[2]] }, 'F2', holders);
    expect(warned(checks)).toEqual(['Fulfillment F2: document D-PDF covers this fulfillment only']);
    expect(checks.find((c) => !c.ok)).toMatchObject({ level: 'warn', message: 'it also holds F1 (a PDF_A4 merged for the booking)' });
  });

  test('another fulfillment answered is a failure; no fulfillment at all too', () => {
    const wrong = fd.checkFulfillmentRead({ fulfillment: fulfillments[0] }, 'F2', holders);
    expect(wrong[0]).toMatchObject({ ok: false, message: 'the answer\'s fulfillment is F1' });
    expect(wrong[0].level).toBeUndefined();
    expect(fd.checkFulfillmentRead({}, 'F2', holders)).toHaveLength(1);
  });
});

describe('the refund receipt', () => {
  const receipt = { id: 'R1', medium: 'PDF_A4', type: 'INFORMATION', format: 'application/pdf', content: PDF };

  test('found in fulfillmentDocuments, in documents, or nested; not one there before the refund', () => {
    expect(fd.findRefundReceipt({ fulfillmentDocuments: [...siblings, receipt] }, []).id).toBe('R1');
    expect(fd.findRefundReceipt({ documents: [{ id: 'R2', type: 'INFORMATION', scope: 'BOOKING' }] }, []).id).toBe('R2');
    expect(fd.findRefundReceipt({ fulfillments: [{ fulfillmentDocuments: [receipt] }] }, []).id).toBe('R1');
    const before = fd.informationKeys({ documents: [{ id: 'OLD', type: 'INFORMATION' }] });
    expect(fd.findRefundReceipt({ documents: [{ id: 'OLD', type: 'INFORMATION' }] }, before)).toBeNull();
    expect(fd.findRefundReceipt({ fulfillmentDocuments: siblings }, [])).toBeNull();
  });

  test('its form: a PDF with something to read (warnings)', () => {
    expect(warned(fd.checkRefundReceipt(receipt))).toEqual([]);
    expect(warned(fd.checkRefundReceipt({ type: 'INFORMATION', format: 'text/html' }))).toEqual([
      'Refund receipt: a PDF', 'Refund receipt: has a content or a download link',
    ]);
  });
});

describe('the steps', () => {
  test('06 lists the fulfillments for 06b; 06b reads each, then hands over to 07', () => {
    expect(steps.armFulfillmentReads({ fulfillments, fulfillmentDocuments: siblings })).toBe(true);
    expect(steps.readNextFulfillment()).toBe('F1');
    expect(steps.checkFulfillmentReadStep(200, { fulfillment: fulfillments[0], fulfillmentDocuments: [siblings[0], siblings[1]] })).toBe('06b. GET Fulfillment');
    expect(steps.readNextFulfillment()).toBe('F2');
    expect(steps.checkFulfillmentReadStep(200, { fulfillment: fulfillments[1], fulfillmentDocuments: [siblings[0], siblings[2]], problems: [{ code: 'DOCUMENT_COVERS_MORE_FULFILLMENTS', detail: 'merged' }] })).toBe('07. GET Booking after Fulfillments');
    expect(mockResults.filter((r) => !r.ok)).toEqual([]);
    expect(mockLogs.filter((l) => l.startsWith('[WARNING]'))).toHaveLength(2);
    expect(mockLogs).toContain('[INFO] GET /fulfillments/F2: the provider says DOCUMENT_COVERS_MORE_FULFILLMENTS — merged');
    expect(steps.armFulfillmentReads({ fulfillments: [] })).toBe(false);
  });

  test('06b not implemented (501): a passing row, and the other fulfillments are not read', () => {
    steps.armFulfillmentReads({ fulfillments });
    expect(steps.checkFulfillmentReadStep(501, null)).toBe('07. GET Booking after Fulfillments');
    expect(JSON.parse(envStore.__fulfillmentsToRead)).toEqual([]);
    expect(mockResults).toEqual([{ name: 'HTTP response status — not implemented by this provider (auto-detected): 06b. GET Fulfillment returns 501', ok: true }]);
  });

  test('06b answering 401 is a failure, and the reads go on', () => {
    steps.armFulfillmentReads({ fulfillments });
    expect(steps.checkFulfillmentReadStep(401, null)).toBe('06b. GET Fulfillment');
    expect(mockResults[0]).toMatchObject({ ok: false });
  });

  test('07 checks the documents against the media asked for, and keeps the receipts already there', () => {
    envStore.offerFulfillmentOptions = JSON.stringify([{ type: 'ETICKET', media: 'PDF_A4' }, { type: 'ETICKET', media: 'RETAILER_APP' }]);
    steps.checkConfirmedBookingDocuments({ fulfillments, fulfillmentDocuments: [siblings[0]], documents: [{ id: 'OLD', type: 'INFORMATION' }] });
    expect(mockLogs.filter((l) => l.startsWith('[WARNING]'))).toEqual(['[WARNING] Documents: the RETAILER_APP medium asked for is delivered — 0 document(s) — no RETAILER_APP document on the booking\'s 2 fulfillment(s)']);
    expect(JSON.parse(envStore.__infoDocKeysBeforeRefund)).toEqual(['OLD']);
  });

  test('14 without a wait asked: nothing awaited', () => {
    expect(steps.armRefundReceiptWait({})).toBe(false);
    envStore.refundReceiptMaxWaitMinutes = '61';
    expect(steps.armRefundReceiptWait({})).toBe(false);
  });

  test('14 with the receipt already there: passes at once', () => {
    envStore.refundReceiptMaxWaitMinutes = '2';
    expect(steps.armRefundReceiptWait({ fulfillmentDocuments: [{ id: 'R', type: 'INFORMATION', medium: 'PDF_A4', content: PDF }] })).toBe(false);
    expect(mockResults).toEqual([{ name: 'Refund receipt: in the booking — R (INFORMATION)', ok: true }]);
  });

  test('14b reads again until the receipt is there', () => {
    envStore.refundReceiptMaxWaitMinutes = '2';
    expect(steps.armRefundReceiptWait({})).toBe(true);
    expect(steps.checkRefundReceiptPoll(200, { booking: {} })).toBe('again');
    expect(steps.checkRefundReceiptPoll(503, null)).toBe('again');
    expect(steps.checkRefundReceiptPoll(200, { booking: { documents: [{ id: 'R', type: 'INFORMATION', format: 'application/pdf', content: PDF }] } })).toBe('done');
    expect(mockResults.map((r) => r.ok)).toEqual([true]);
    expect(mockResults[0].name).toMatch(/^Refund receipt: in the booking after \d+ s — R \(INFORMATION\)$/);
    expect(envStore.__refundReceiptDeadline).toBeNull();
  });

  test('14b past the wait without a receipt: a failure', () => {
    envStore.refundReceiptMaxWaitMinutes = '2';
    steps.armRefundReceiptWait({});
    envStore.__refundReceiptDeadline = String(Date.now() - 1);
    expect(steps.checkRefundReceiptPoll(200, { booking: {} })).toBe('done');
    expect(mockResults).toEqual([{ name: 'Refund receipt: in the booking within 2 minute(s)', ok: false, message: 'no document of type INFORMATION appeared in the booking (documents or fulfillmentDocuments) within 2 minute(s) of the refund' }]);
  });

  test('14b waits 15 seconds between reads, never past the end of the wait', async () => {
    jest.useFakeTimers();
    try {
      envStore.__refundReceiptDeadline = String(Date.now() + 4000);
      let done = false;
      const waiting = steps.waitBeforeReceiptPoll().then(() => { done = true; });
      await jest.advanceTimersByTimeAsync(3999);
      expect(done).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
      envStore.__refundReceiptDeadline = String(Date.now() + 60000);
      const second = steps.waitBeforeReceiptPoll();
      await jest.advanceTimersByTimeAsync(steps.POLL_EVERY_MS);
      await second;
    } finally {
      jest.useRealTimers();
    }
  });
});
