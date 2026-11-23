/* global OscarMfa */  // mfa-setup.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * account.js — "My account" (#1414): the signed-in person's own second
 * factor. Off: the password, then the QR code and a first code turn it on.
 * On and not required: the password and a code turn it off. An
 * administrator's factor is required: the page says how to get it reset.
 *
 * Turning it on or off ends every session of the account; the answer brings
 * the new one (its cookie, and the token mirrored in localStorage as the
 * sign-in page does). A wrong password or code is a 403, never a 401, which
 * nav.js would read as a session that ended.
 *
 * noteText() is a pure top-level function, lifted by the page test.
 */

function noteText(state) {
  if (state.required && state.enabled) {
    return 'Administrators must keep two-factor authentication. If you lose your phone, another administrator can reset it from Manage Users.';
  }
  if (state.enabled) return 'It is on. You can turn it off below with your password and a code.';
  return 'It is off. Turn it on with your password, then scan the code with your authenticator app.';
}

(function () {
  const $ = id => document.getElementById(id);

  function showMsg(text, ok) {
    const el = $('msg');
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
    el.style.display = text ? 'block' : 'none';
  }

  async function readError(res, fallback) {
    const data = await res.json().catch(() => ({}));
    return data.detail || data.title || fallback;
  }

  async function send(method, url, body) {
    return fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function draw(state) {
    const badge = $('mfa-state');
    badge.textContent = state.enabled ? 'On' : 'Off';
    badge.className = 'state ' + (state.enabled ? 'state-on' : 'state-off');
    $('mfa-note').textContent = noteText(state);
    $('mfa-off').hidden = state.enabled;
    $('mfa-on').hidden = !state.enabled || state.required;
    $('mfa-box').hidden = true;
    $('confirm-btn').hidden = true;
    $('mfa-box').replaceChildren();
  }

  // The new session after turning the factor on or off.
  function keepSession(data) {
    try { if (data.token) localStorage.setItem('oscar_token', data.token); } catch { /* storage unavailable: the cookie holds it */ }
  }

  async function load() {
    const res = await fetch('/v1/me/mfa');
    if (!res.ok) { showMsg(await readError(res, 'Could not read your account.'), false); return; }
    draw(await res.json());
  }

  async function start() {
    const password = $('on-password').value;
    if (!password) { showMsg('Type your password first.', false); return; }
    const res = await send('POST', '/v1/me/mfa/setup', { password });
    if (!res.ok) { showMsg(await readError(res, 'The set-up could not start.'), false); return; }
    $('on-password').value = '';
    const box = $('mfa-box');
    box.hidden = false;
    OscarMfa.showSetup(box, await res.json(), 'setup-code').focus();
    $('confirm-btn').hidden = false;
    showMsg('', true);
  }

  async function confirmCode() {
    const code = OscarMfa.cleanCode($('setup-code')?.value);
    if (!code) { showMsg('Type the six digits your authenticator app shows.', false); return; }
    const res = await send('POST', '/v1/me/mfa/confirm', { code });
    if (!res.ok) { showMsg(await readError(res, 'That code was not accepted.'), false); return; }
    const data = await res.json();
    keepSession(data);
    draw(data);
    showMsg('Two-factor authentication is on. Your other sessions were signed out.', true);
  }

  async function disable() {
    const password = $('off-password').value;
    const code = OscarMfa.cleanCode($('off-code').value);
    if (!password || !code) { showMsg('Type your password and a six-digit code.', false); return; }
    if (!globalThis.confirm('Turn two-factor authentication off? Your password alone will sign you in.')) return;
    const res = await send('DELETE', '/v1/me/mfa', { password, code });
    if (!res.ok) { showMsg(await readError(res, 'It was not turned off.'), false); return; }
    const data = await res.json();
    keepSession(data);
    $('off-password').value = '';
    $('off-code').value = '';
    draw(data);
    showMsg('Two-factor authentication is off. Your other sessions were signed out.', true);
  }

  const ACTIONS = { start, confirm: confirmCode, disable };
  document.querySelector('.container').addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    const action = el && ACTIONS[el.dataset.action];
    if (!action) return;
    el.disabled = true;
    action().catch(err => showMsg(err?.message || 'Server unreachable.', false)).finally(() => { el.disabled = false; });
  });

  load().catch(err => showMsg(err?.message || 'Server unreachable.', false));
})();
