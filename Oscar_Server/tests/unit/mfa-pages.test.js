// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mfa-pages.test.js — the pages' part of the second factor (#1414):
 * public/js/mfa-setup.js (shared by the sign-in page and "My account") and
 * noteText() of public/js/account.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../../public/js/mfa-setup');
const { qrDataUrl } = require('../../src/utils/qrCode');

// A document of plain objects: what showSetup() builds, without a browser.
function fakeDocument() {
  const make = tag => ({
    tag, children: [],
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren() { this.children = []; },
    focus() {},
  });
  return { createElement: make, make };
}

describe('mfa-setup.js', () => {
  test('the key reads in groups of four, whatever it was typed as', () => {
    expect(M.groupedKey('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(M.groupedKey('jbsw y3dp-ehp')).toBe('JBSW Y3DP EHP');
    expect(M.groupedKey(null)).toBe('');
  });

  test('only an SVG data: URL of base64 is taken as the QR code', () => {
    expect(M.isQrUrl(qrDataUrl('otpauth://totp/OSCAR:a%40b.example?secret=JBSWY3DPEHPK3PXP'))).toBe(true);
    for (const bad of ['javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/svg+xml;base64,PHN2Zz4" onerror="x',
      'data:image/svg+xml,<svg/onload=alert(1)>', 'https://example.org/qr.svg', '', null, 42]) {
      expect([bad, M.isQrUrl(bad)]).toEqual([bad, false]);
    }
  });

  test('a code is six digits, spaces ignored', () => {
    expect(M.cleanCode(' 123 456 ')).toBe('123456');
    for (const typed of ['12345', '1234567', 'abcdef', null, undefined]) expect(M.cleanCode(typed)).toBe('');
  });

  test('showSetup draws the QR code, the key and the field, nothing from the answer as markup', () => {
    const doc = fakeDocument();
    const box = doc.make('div');
    box.children.push('left over');
    const qr = qrDataUrl('otpauth://totp/OSCAR:a%40b.example?secret=JBSWY3DPEHPK3PXP');
    const field = M.showSetup(box, { secret: 'JBSWY3DPEHPK3PXP', qr }, 'code-id', doc);
    expect(box.children.map(c => c.tag)).toEqual(['p', 'img', 'p', 'code', 'label', 'input']);
    expect(box.children[1].src).toBe(qr);
    expect(box.children[3].textContent).toBe('JBSW Y3DP EHPK 3PXP');
    expect(box.children[4].htmlFor).toBe('code-id');
    expect(field).toBe(box.children[5]);
    expect(field).toMatchObject({ id: 'code-id', inputMode: 'numeric', autocomplete: 'one-time-code' });
    expect(box.children.some(c => 'innerHTML' in c)).toBe(false);
  });

  test('a QR code that is not an SVG data: URL is not drawn; the key still is', () => {
    const doc = fakeDocument();
    const box = doc.make('div');
    M.showSetup(box, { secret: 'JBSWY3DPEHPK3PXP', qr: 'javascript:alert(1)' }, 'c', doc);
    expect(box.children.map(c => c.tag)).toEqual(['p', 'p', 'code', 'label', 'input']);
  });

  test('the server and the sign-in page agree on the prefix of the QR code', () => {
    expect(qrDataUrl('x').startsWith(M.QR_PREFIX)).toBe(true);
  });
});

describe("account.js's note", () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/account.js'), 'utf8');
  const start = source.indexOf('function noteText(');
  const context = {};
  vm.runInNewContext(source.slice(start, source.indexOf('\n}\n', start) + 2), context);

  test('says what to do in each state', () => {
    expect(context.noteText({ enabled: true, required: true })).toMatch(/another administrator can reset it/);
    expect(context.noteText({ enabled: true, required: false })).toMatch(/turn it off below/);
    expect(context.noteText({ enabled: false, required: false })).toMatch(/It is off/);
  });
});
