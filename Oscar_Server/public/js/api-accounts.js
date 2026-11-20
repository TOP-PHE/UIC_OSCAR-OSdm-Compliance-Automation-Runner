/* global esc, parseServerTs */  // esc.js, nav.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-accounts.js — the Company API accounts page (#1342): a Test Manager
 * makes the accounts the company's own test automation acts as, gives each
 * the providers it may use, suspends, resumes or deletes it. Its OSDM
 * credentials are saved on the API Config page, opened for that account
 * (profile.html?api_account=<id>).
 *
 * accountRowHtml(), providerBoxesHtml(), credentialsHtml() and whenText() are
 * pure top-level functions, lifted by the page test; the rest is wiring.
 */

const ACCOUNT_STATE_STYLE = {
  active:    'background:#e8f5e9;color:#1b5e20',
  suspended: 'background:#fff3e0;color:#e65100',
};

function whenText(value) {
  if (!value) return '—';
  if (typeof parseServerTs === 'function') {
    const d = parseServerTs(value);
    if (d && !Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return String(value);
}

// The providers of the company as boxes, ticked where the account is given one.
// accountId null: the boxes of the form that makes an account.
function providerBoxesHtml(providers, given, accountId) {
  if (!providers.length) return '<span class="muted">Your company has no provider.</span>';
  const ids = new Set((given || []).map(p => p.id));
  return providers.map((p) => {
    const data = accountId
      ? ' data-action="toggle-provider" data-id="' + esc(accountId) + '"'
      : ' data-new-provider="1"';
    return '<label class="box"><input type="checkbox" value="' + esc(p.id) + '"' + data
      + (ids.has(p.id) ? ' checked' : '') + '> ' + esc(p.name) + '</label>';
  }).join(' ');
}

// Where its OSDM credentials are saved, one line per company or provider.
function credentialsHtml(credentials) {
  if (!credentials || !credentials.length) return '—';
  return credentials.map(c => '<div>' + (c.set ? '✅ ' : '⚠️ ') + esc(c.company_name)
    + (c.set ? '' : ' <span class="muted">(not set)</span>') + '</div>').join('');
}

function accountRowHtml(a, providers) {
  const state = a.status === 'active' ? 'active' : 'suspended';
  const id = esc(a.id);
  const pause = state === 'active'
    ? '<button class="btn btn-secondary btn-sm" data-action="suspend" data-id="' + id + '">Suspend</button>'
    : '<button class="btn btn-primary btn-sm" data-action="resume" data-id="' + id + '">Resume</button>';
  return '<tr>'
    + '<td><strong>' + esc(a.name) + '</strong><div class="muted">' + esc(a.account_email) + '</div>'
    + '<div class="muted">Made by ' + esc(a.created_by || '—') + ', ' + esc(whenText(a.created_at)) + '</div></td>'
    + '<td><span class="state" style="' + ACCOUNT_STATE_STYLE[state] + '">' + esc(state) + '</span>'
    + (state === 'suspended' ? '<div class="muted">by ' + esc(a.suspended_by || '—') + ', ' + esc(whenText(a.suspended_at)) + '</div>' : '')
    + '</td>'
    + '<td>' + providerBoxesHtml(providers, a.providers, a.id) + '</td>'
    + '<td>' + credentialsHtml(a.credentials)
    + '<div><a href="/profile.html?api_account=' + encodeURIComponent(a.id) + '">Set its OSDM credentials</a></div></td>'
    + '<td class="actions">'
    + '<button class="btn btn-secondary btn-sm" data-action="rename" data-id="' + id + '">Rename</button> '
    + pause + ' '
    + '<button class="btn btn-danger btn-sm" data-action="delete" data-id="' + id + '">Delete</button>'
    + '</td></tr>';
}

(function () {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('accounts-list');
  if (!list) return;
  let user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch { user = {}; }
  let providers = [];
  let accounts = [];

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
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const accountUrl = id => '/v1/company/api-accounts/' + encodeURIComponent(id);

  async function load() {
    const [provRes, accRes] = await Promise.all([fetch('/v1/company/providers', {}), fetch('/v1/company/api-accounts')]);
    if (!accRes.ok) { list.innerHTML = ''; showMsg(await readError(accRes, 'Could not load the accounts.'), false); return; }
    providers = provRes.ok ? ((await provRes.json()).providers || []).map(p => ({ id: p.id, name: p.name })) : [];
    const data = await accRes.json();
    accounts = data.accounts || [];
    document.getElementById('accounts-target').textContent = data.company?.name || '';
    document.getElementById('new-providers').innerHTML = providerBoxesHtml(providers, [], null);
    list.innerHTML = accounts.length
      ? '<table><thead><tr><th>Account</th><th>State</th><th>Providers it may use</th><th>OSDM credentials</th><th></th></tr></thead><tbody>'
        + accounts.map(a => accountRowHtml(a, providers)).join('') + '</tbody></table>'
      : '<div class="empty">No Company API account yet.</div>';
  }

  async function create() {
    const name = document.getElementById('account-name').value.trim();
    if (!name) { showMsg('Give the account a name, such as the tool that will use it.', false); return; }
    const chosen = [...document.querySelectorAll('input[data-new-provider]:checked')].map(b => b.value);
    const res = await fetch('/v1/company/api-accounts', json('POST', { name, providers: chosen }));
    if (!res.ok) { showMsg(await readError(res, 'The account was not made.'), false); return; }
    document.getElementById('account-name').value = '';
    showMsg('Account made. Set its OSDM credentials for each place it will test.', true);
    await load();
  }

  async function patch(id, body, done) {
    const res = await fetch(accountUrl(id), json('PATCH', body));
    if (!res.ok) { showMsg(await readError(res, 'The account was not changed.'), false); await load(); return; }
    showMsg(done, true);
    await load();
  }

  async function toggleProvider(box) {
    const account = accounts.find(a => a.id === box.dataset.id);
    if (!account) return;
    const ids = new Set(account.providers.map(p => p.id));
    if (box.checked) ids.add(box.value); else ids.delete(box.value);
    if (!box.checked && !confirm('Take this provider away from the account? It stops testing there at once.')) { box.checked = true; return; }
    await patch(account.id, { providers: [...ids] }, 'Providers saved.');
  }

  async function rename(id) {
    const account = accounts.find(a => a.id === id);
    const name = prompt('New name of the account:', account?.name || '');
    if (name === null || !name.trim()) return;
    await patch(id, { name: name.trim() }, 'Account renamed.');
  }

  async function act(id, what) {
    if (what === 'suspend' && !confirm('Suspend this account? Whatever uses it stops at once, until it is resumed.')) return;
    if (what === 'delete' && !confirm('Delete this account? Its runs, with their checks and logs, are deleted with it. '
      + 'Suspend it instead to keep them. This cannot be undone.')) return;
    const res = what === 'delete'
      ? await fetch(accountUrl(id), { method: 'DELETE' })
      : await fetch(accountUrl(id) + '/' + what, { method: 'POST' });
    if (!res.ok) { showMsg(await readError(res, 'Nothing was changed.'), false); return; }
    showMsg({ suspend: 'Account suspended.', resume: 'Account resumed.', delete: 'Account deleted.' }[what], true);
    await load();
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.dataset.action === 'toggle-provider') return;
    const action = el.dataset.action;
    if (action === 'create') create().catch(reportError);
    else if (action === 'rename') rename(el.dataset.id).catch(reportError);
    else if (['suspend', 'resume', 'delete'].includes(action)) act(el.dataset.id, action).catch(reportError);
  });
  document.addEventListener('change', (e) => {
    const box = e.target.closest('input[data-action="toggle-provider"]');
    if (box) toggleProvider(box).catch(reportError);
  });

  if (user.role === 'test_manager') {
    load().catch(reportError);
  } else {
    document.getElementById('create-card').style.display = 'none';
    list.innerHTML = '<div class="empty">Company API accounts are managed by your company\'s Test Managers.</div>';
  }
})();
