/* global esc, parseServerTs */  // esc.js, nav.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-simulator.js — the OSDM simulator's accounts, for OSCAR's
 * administrators (#930, PR 2). Every call goes to /v1/admin/simulator, which
 * calls the simulator with its key; this page never sees the key after it is
 * typed. A new secret is shown once, in the box above the providers, and is
 * gone after a reload.
 *
 * whenText(), providerHtml(), secretHtml(), auditHtml() and auditWhat() are
 * pure top-level functions, lifted by the page test; the rest is wiring.
 */

function whenText(value) {
  if (!value) return '—';
  if (typeof parseServerTs === 'function') {
    const d = parseServerTs(value);
    if (d && !Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return String(value);
}

function providerHtml(p) {
  const rows = (p.accounts || []).map((a) => '<tr>'
    + '<td><code>' + esc(a.clientId) + '</code></td>'
    + '<td>' + esc(whenText(a.createdAt)) + '</td>'
    + '<td>' + esc(a.lastTokenAt ? whenText(a.lastTokenAt) : 'none since the start') + '</td>'
    + '<td class="actions">'
    + '<button class="btn btn-secondary btn-sm" data-action="reset" data-provider="' + esc(p.provider) + '" data-client="' + esc(a.clientId) + '">New secret</button> '
    + '<button class="btn btn-danger btn-sm" data-action="delete" data-provider="' + esc(p.provider) + '" data-client="' + esc(a.clientId) + '">Delete</button>'
    + '</td></tr>').join('');
  const table = rows
    ? '<div class="table-wrap"><table><thead><tr><th>Client id</th><th>Created</th><th>Last token</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<div class="empty">No account.</div>';
  return '<div class="card">'
    + '<div class="provider-head"><h3><code>' + esc(p.provider) + '</code> ' + esc(p.name || '') + '</h3>'
    + '<span class="muted">OSDM ' + esc(p.osdmVersion || '?') + ' · ' + (p.accounts || []).length + ' accounts</span></div>'
    + table
    + '<div class="add-row">'
    + '<label class="muted" for="add-id-' + esc(p.provider) + '">New account</label>'
    + '<input type="text" id="add-id-' + esc(p.provider) + '" maxlength="64" placeholder="client id, or empty for the next number">'
    + '<select id="add-kind-' + esc(p.provider) + '" aria-label="Kind of account"><option value="tst">tester (tstNN)</option><option value="tstmgr">Test Manager (tstmgrNN)</option></select>'
    + '<button class="btn btn-primary btn-sm" data-action="add" data-provider="' + esc(p.provider) + '">Add</button>'
    + '</div></div>';
}

function secretHtml(created) {
  return '<div class="card"><p><strong>Copy this secret now: it is shown only once.</strong> The simulator keeps only a fingerprint of it, '
    + 'and nobody can show it again. Lost, it is reset.</p>'
    + '<p>Account <code>' + esc(created.clientId) + '</code> on <code>' + esc(created.provider) + '</code>:</p>'
    + '<div class="key-box"><code id="new-secret-value">' + esc(created.clientSecret) + '</code>'
    + '<button class="btn btn-secondary btn-sm" data-action="copy">Copy</button>'
    + '<button class="btn btn-secondary btn-sm" data-action="hide-secret">Done</button></div></div>';
}

const AUDIT_WHAT = {
  account_added: 'added',
  account_deleted: 'deleted',
  secret_reset: 'new secret for',
  imported_clients_file: 'imported the clients file',
  admin_key_refused: 'refused a wrong key',
};

function auditWhat(e) {
  const verb = AUDIT_WHAT[e.action] || e.action || '?';
  if (e.clientId) return verb + ' ' + e.provider + '/' + e.clientId;
  if (e.action === 'imported_clients_file') return verb + ' (' + (e.count ?? '?') + ' accounts)';
  if (e.address) return verb + ' from ' + e.address;
  return verb;
}

function auditHtml(entries) {
  if (!entries.length) return '<div class="empty">Nothing yet.</div>';
  return '<table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>'
    + entries.map((e) => '<tr><td>' + esc(whenText(e.at)) + '</td><td>' + esc(e.by || '?') + '</td><td>' + esc(auditWhat(e)) + '</td></tr>').join('')
    + '</tbody></table>';
}

(function () {
  if (typeof document === 'undefined') return;
  const providers = document.getElementById('providers');
  if (!providers) return;
  const BASE = '/v1/admin/simulator';

  function showMsg(text, ok) {
    const el = document.getElementById('msg');
    el.textContent = text;
    el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 8000);
  }
  async function readError(res, fallback) {
    const d = await res.json().catch(() => ({}));
    return d.detail || d.title || fallback;
  }
  function reportError(e) { showMsg(e?.message || 'Something went wrong.', false); }

  async function loadConfig() {
    const res = await fetch(BASE + '/config');
    if (!res.ok) { showMsg(await readError(res, 'Could not read the set-up.'), false); return null; }
    const cfg = await res.json();
    document.getElementById('sim-url').value = cfg.url || '';
    document.getElementById('config-state').textContent = cfg.keySet ? 'Key saved.' : 'Not set up yet.';
    return cfg;
  }

  async function loadAccounts() {
    const res = await fetch(BASE + '/accounts');
    if (!res.ok) { providers.innerHTML = '<div class="empty">' + esc(await readError(res, 'Could not read the accounts.')) + '</div>'; return; }
    const data = await res.json();
    providers.innerHTML = (data.providers || []).map(providerHtml).join('') || '<div class="empty">The simulator has no provider.</div>';
  }

  async function loadAudit() {
    const box = document.getElementById('audit');
    const res = await fetch(BASE + '/audit');
    if (!res.ok) { box.innerHTML = '<div class="empty">' + esc(await readError(res, 'Could not read the audit.')) + '</div>'; return; }
    box.innerHTML = auditHtml((await res.json()).entries || []);
  }

  async function saveConfig() {
    const url = document.getElementById('sim-url').value.trim();
    const keyField = document.getElementById('sim-key');
    const res = await fetch(BASE + '/config', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(keyField.value ? { url, key: keyField.value } : { url }),
    });
    if (!res.ok) { showMsg(await readError(res, 'Not saved.'), false); return; }
    keyField.value = '';
    showMsg('Saved: the simulator answered with this key.', true);
    await loadConfig();
    await loadAccounts();
  }

  async function removeConfig() {
    if (!confirm('Forget the simulator\'s address and key? The simulator itself is not changed.')) return;
    const res = await fetch(BASE + '/config', { method: 'DELETE' });
    if (!res.ok) { showMsg(await readError(res, 'Not removed.'), false); return; }
    showMsg('The address and key are forgotten.', true);
    await loadConfig();
    providers.innerHTML = '<div class="empty">Not set up.</div>';
  }

  function showSecret(created) {
    const box = document.getElementById('new-secret');
    box.innerHTML = secretHtml(created);
    box.style.display = 'block';
    box.scrollIntoView({ behavior: 'smooth' });
  }

  async function add(provider) {
    const clientId = document.getElementById('add-id-' + provider).value.trim();
    const kind = document.getElementById('add-kind-' + provider).value;
    const res = await fetch(BASE + '/accounts/' + encodeURIComponent(provider), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientId ? { clientId } : { kind }),
    });
    if (!res.ok) { showMsg(await readError(res, 'The account was not added.'), false); return; }
    showSecret(await res.json());
    await loadAccounts();
  }

  async function reset(provider, clientId) {
    if (!confirm('Give ' + clientId + ' a new secret? The old one, and every token asked with it, stop working at once.')) return;
    const res = await fetch(BASE + '/accounts/' + encodeURIComponent(provider) + '/' + encodeURIComponent(clientId) + '/reset-secret', { method: 'POST' });
    if (!res.ok) { showMsg(await readError(res, 'No new secret.'), false); return; }
    showSecret(await res.json());
  }

  async function remove(provider, clientId) {
    if (!confirm('Delete ' + clientId + ' on ' + provider + '? Its tokens stop working at once. This cannot be undone.')) return;
    const res = await fetch(BASE + '/accounts/' + encodeURIComponent(provider) + '/' + encodeURIComponent(clientId), { method: 'DELETE' });
    if (!res.ok) { showMsg(await readError(res, 'The account was not deleted.'), false); return; }
    showMsg(clientId + ' deleted.', true);
    await loadAccounts();
  }

  async function copy() {
    await navigator.clipboard.writeText(document.getElementById('new-secret-value')?.textContent || '');
    showMsg('Secret copied.', true);
  }

  function hideSecret() {
    const box = document.getElementById('new-secret');
    box.innerHTML = '';
    box.style.display = 'none';
  }

  function showTab(name) {
    const tab = name === 'audit' ? 'audit' : 'accounts';
    document.getElementById('accounts-view').style.display = tab === 'accounts' ? '' : 'none';
    document.getElementById('audit-view').style.display = tab === 'audit' ? '' : 'none';
    document.getElementById('accounts-help').style.display = tab === 'accounts' ? '' : 'none';
    document.getElementById('audit-help').style.display = tab === 'audit' ? '' : 'none';
    for (const el of document.querySelectorAll('[data-tab]')) el.classList.toggle('active', el.dataset.tab === tab);
    if (tab === 'audit') loadAudit().catch(reportError);
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, provider, client } = el.dataset;
    if (action === 'save-config') saveConfig().catch(reportError);
    else if (action === 'remove-config') removeConfig().catch(reportError);
    else if (action === 'add') add(provider).catch(reportError);
    else if (action === 'reset') reset(provider, client).catch(reportError);
    else if (action === 'delete') remove(provider, client).catch(reportError);
    else if (action === 'copy') copy().catch(reportError);
    else if (action === 'hide-secret') hideSecret();
  });
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  showTab(location.hash.slice(1));
  loadConfig().then((cfg) => {
    if (cfg?.keySet) return loadAccounts();
    providers.innerHTML = '<div class="empty">Enter the simulator\'s address and key above.</div>';
    return null;
  }).catch(reportError);
})();
