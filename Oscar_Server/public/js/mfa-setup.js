// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mfa-setup.js — setting up a second factor in a page (#1414): the sign-in
 * page (an administrator's first sign-in) and the account page share it.
 *
 * showSetup() draws, with DOM elements only (no markup from the answer): the
 * QR code the server made (an SVG data: URL, checked before it is used), the
 * key in groups of four for typing by hand, and the field for the first
 * code. Browser global `OscarMfa`, and CommonJS for the tests.
 */

(function (global) {
  const QR_PREFIX = 'data:image/svg+xml;base64,';

  /** The key in groups of four, as people type it. */
  function groupedKey(secret) {
    const clean = String(secret || '').toUpperCase().replaceAll(/[^A-Z2-7]/g, '');
    return (clean.match(/.{1,4}/g) || []).join(' ');
  }

  /** True for the data: URL of an SVG, base64 characters only. */
  function isQrUrl(value) {
    return typeof value === 'string' && value.startsWith(QR_PREFIX)
      && /^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(QR_PREFIX.length));
  }

  /** The six digits of a typed code, or '' when it is not one. */
  function cleanCode(text) {
    const digits = String(text || '').replaceAll(/\s/g, '');
    return /^\d{6}$/.test(digits) ? digits : '';
  }

  function element(doc, tag, props, children) {
    const el = doc.createElement(tag);
    Object.assign(el, props || {});
    for (const child of children || []) el.append(child);
    return el;
  }

  /**
   * Fills `box` with the steps of the set-up of `setup` ({ secret, qr }) and
   * returns the code field. `codeId` names the field (its label points at it).
   */
  function showSetup(box, setup, codeId, doc) {
    const d = doc || global.document;
    box.replaceChildren();
    box.append(element(d, 'p', { className: 'mfa-step', textContent: '1. In your authenticator app (Google or Microsoft Authenticator, 1Password…), add an account and scan this code:' }));
    if (isQrUrl(setup.qr)) {
      box.append(element(d, 'img', { src: setup.qr, alt: 'QR code to scan with your authenticator app', className: 'mfa-qr', width: 200, height: 200 }));
    }
    box.append(element(d, 'p', { className: 'mfa-hint', textContent: 'Cannot scan it? Type this key instead (time-based):' }));
    box.append(element(d, 'code', { className: 'mfa-key', textContent: groupedKey(setup.secret) }));
    box.append(element(d, 'label', { htmlFor: codeId, textContent: '2. The six-digit code the app shows' }));
    const field = element(d, 'input', {
      id: codeId, type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, required: true,
    });
    box.append(field);
    return field;
  }

  const api = { groupedKey, isQrUrl, cleanCode, showSetup, QR_PREFIX };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.OscarMfa = api;
})(typeof window === 'undefined' ? globalThis : window);
