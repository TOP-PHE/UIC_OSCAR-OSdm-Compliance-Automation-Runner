/* global esc, parseServerTs */  // esc.js, nav.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-keys.js — the API keys page (#503): a Test Manager makes, sees and
 * revokes the read-only API keys of the company or provider chosen in
 * "Working on" (nav.js adds X-Provider-Id to every call). A new key is shown
 * once, in the box above the list, and is gone after a reload.
 *
 * keyRowHtml(), newKeyHtml() and whenText() are pure top-level functions,
 * lifted by the page test; the rest is wiring.
 */

const KEY_STATE_STYLE = {
  active:  'background:#e8f5e9;color:#1b5e20',
  expired: 'background:#eceff1;color:#546e7a',
  revoked: 'background:#ffebee;color:#b71c1c',
};

function whenText(value) {
  if (!value) return '—';
  if (typeof parseServerTs === 'function') {
    const d = parseServerTs(value);
    if (d && !Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return String(value);
}

function keyRowHtml(k) {
  const state = KEY_STATE_STYLE[k.state] ? k.state : 'expired';
  const action = state === 'active'
    ? '<button class="btn btn-danger btn-sm" data-action="revoke" data-id="' + esc(k.id) + '">Revoke</button>'
    : '';
  return '<tr>'
    + '<td><strong>' + esc(k.name) + '</strong><div class="muted"><code>' + esc(k.hint) + '</code></div></td>'
    + '<td><span class="state" style="' + KEY_STATE_STYLE[state] + '">' + esc(state) + '</span></td>'
    + '<td>' + esc(k.created_by || '—') + '<div class="muted">' + esc(whenText(k.created_at)) + '</div></td>'
    + '<td>' + esc(whenText(k.expires_at)) + '</td>'
    + '<td>' + esc(whenText(k.last_used_at)) + '</td>'
    + '<td>' + action + '</td>'
    + '</tr>';
}

function newKeyHtml(created) {
  return '<p><strong>Copy this key now: it is shown only once.</strong> OSCAR keeps only a fingerprint of it, '
    + 'and nobody, administrators included, can show it again. Lost, it is revoked and replaced.</p>'
    + '<div class="key-box"><code id="new-key-value">' + esc(created.key) + '</code>'
    + '<button class="btn btn-secondary btn-sm" data-action="copy">Copy</button></div>'
    + '<p class="muted">Send it in the header <code>Authorization: Bearer &lt;key&gt;</code>, to the routes under '
    + '<code>/v1/api</code> only. It expires on ' + esc(whenText(created.expires_at)) + '.</p>';
}

(function () {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('keys-list');
  if (!list) return;
  let user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch { user = {}; }

  function showMsg(text, ok) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 6000);
  }
  async function readError(res, fallback) {
    const d = await res.json().catch(() => ({}));
    return d.detail || d.title || fallback;
  }
  function reportError(e) { showMsg(e?.message || 'Something went wrong.', false); }

  async function load() {
    const res = await fetch('/v1/company/api-keys');
    if (!res.ok) { list.innerHTML = ''; showMsg(await readError(res, 'Could not load the API keys.'), false); return; }
    const data = await res.json();
    document.getElementById('keys-target').textContent = data.company?.name || '';
    const keys = data.keys || [];
    list.innerHTML = keys.length
      ? '<table><thead><tr><th>Name</th><th>State</th><th>Made by</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>'
        + keys.map(keyRowHtml).join('') + '</tbody></table>'
      : '<div class="empty">No API key yet.</div>';
  }

  async function create() {
    const name = document.getElementById('key-name').value.trim();
    if (!name) { showMsg('Give the key a name, to tell it from the others.', false); return; }
    const days = Number(document.getElementById('key-days').value);
    const res = await fetch('/v1/company/api-keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, expires_in_days: days }),
    });
    if (!res.ok) { showMsg(await readError(res, 'The key was not made.'), false); return; }
    const created = await res.json();
    document.getElementById('key-name').value = '';
    const box = document.getElementById('new-key');
    box.innerHTML = newKeyHtml(created);
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth' });
    await load();
  }

  async function revoke(id) {
    if (!confirm('Revoke this key? Whatever uses it stops working at once. This cannot be undone.')) return;
    const res = await fetch('/v1/company/api-keys/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!res.ok) { showMsg(await readError(res, 'The key was not revoked.'), false); return; }
    showMsg('Key revoked.', true);
    await load();
  }

  async function copy() {
    const value = document.getElementById('new-key-value')?.textContent || '';
    await navigator.clipboard.writeText(value);
    showMsg('Key copied.', true);
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'create') create().catch(reportError);
    else if (el.dataset.action === 'revoke') revoke(el.dataset.id).catch(reportError);
    else if (el.dataset.action === 'copy') copy().catch(reportError);
  });

  if (user.role === 'test_manager') {
    load().catch(reportError);
  } else {
    document.getElementById('create-card').style.display = 'none';
    list.innerHTML = '<div class="empty">API keys are managed by your company\'s Test Managers.</div>';
  }
})();
