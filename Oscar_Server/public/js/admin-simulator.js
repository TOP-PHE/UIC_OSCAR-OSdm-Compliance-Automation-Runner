/* global parseServerTs */  // nav.js
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
 * Everything an answer holds is drawn as text, through the DOM, never as
 * HTML. whenText(), el(), accountRow(), providerNode(), secretNode(),
 * auditWhat() and auditNode() are top-level functions, lifted by the page
 * test with a small stand-in document; the rest is wiring.
 */

function whenText(value) {
  if (!value) return '—';
  if (typeof parseServerTs === 'function') {
    const d = parseServerTs(value);
    if (d && !Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  return String(value);
}

// One element: `props` are attributes (`text` is its text), `children` nodes
// or text. Nothing is ever parsed as HTML: an answer's text stays text.
function el(doc, tag, props, children) {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(props || {})) {
    if (name === 'text') node.textContent = String(value);
    else node.setAttribute(name, String(value));
  }
  for (const child of children || []) {
    node.appendChild(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

function accountRow(doc, provider, a) {
  const action = (name, label, cls) => el(doc, 'button', { class: 'btn btn-sm ' + cls, 'data-action': name, 'data-provider': provider, 'data-client': a.clientId, text: label });
  return el(doc, 'tr', {}, [
    el(doc, 'td', {}, [el(doc, 'code', { text: a.clientId })]),
    el(doc, 'td', { text: whenText(a.createdAt) }),
    el(doc, 'td', { text: a.lastTokenAt ? whenText(a.lastTokenAt) : 'none since the start' }),
    el(doc, 'td', { class: 'actions' }, [action('reset', 'New secret', 'btn-secondary'), ' ', action('delete', 'Delete', 'btn-danger')]),
  ]);
}

function providerNode(doc, p) {
  const accounts = p.accounts || [];
  const head = el(doc, 'tr', {}, ['Client id', 'Created', 'Last token', ''].map((t) => el(doc, 'th', { text: t })));
  const table = accounts.length
    ? el(doc, 'div', { class: 'table-wrap' }, [el(doc, 'table', {}, [el(doc, 'thead', {}, [head]), el(doc, 'tbody', {}, accounts.map((a) => accountRow(doc, p.provider, a)))])])
    : el(doc, 'div', { class: 'empty', text: 'No account.' });
  const kinds = el(doc, 'select', { id: 'add-kind-' + p.provider, 'aria-label': 'Kind of account' }, [
    el(doc, 'option', { value: 'tst', text: 'tester (tstNN)' }),
    el(doc, 'option', { value: 'tstmgr', text: 'Test Manager (tstmgrNN)' }),
  ]);
  return el(doc, 'div', { class: 'card' }, [
    el(doc, 'div', { class: 'provider-head' }, [
      el(doc, 'h3', {}, [el(doc, 'code', { text: p.provider }), ' ' + (p.name || '')]),
      el(doc, 'span', { class: 'muted', text: 'OSDM ' + (p.osdmVersion || '?') + ' · ' + accounts.length + ' accounts' }),
    ]),
    table,
    el(doc, 'div', { class: 'add-row' }, [
      el(doc, 'label', { class: 'muted', for: 'add-id-' + p.provider, text: 'New account' }),
      el(doc, 'input', { type: 'text', id: 'add-id-' + p.provider, maxlength: '64', placeholder: 'client id, or empty for the next number' }),
      kinds,
      el(doc, 'button', { class: 'btn btn-primary btn-sm', 'data-action': 'add', 'data-provider': p.provider, text: 'Add' }),
    ]),
  ]);
}

function secretNode(doc, created) {
  return el(doc, 'div', { class: 'card' }, [
    el(doc, 'p', {}, [el(doc, 'strong', { text: 'Copy this secret now: it is shown only once.' }),
      ' The simulator keeps only a fingerprint of it, and nobody can show it again. Lost, it is reset.']),
    el(doc, 'p', {}, ['Account ', el(doc, 'code', { text: created.clientId }), ' on ', el(doc, 'code', { text: created.provider }), ':']),
    el(doc, 'div', { class: 'key-box' }, [
      el(doc, 'code', { id: 'new-secret-value', text: created.clientSecret }),
      el(doc, 'button', { class: 'btn btn-secondary btn-sm', 'data-action': 'copy', text: 'Copy' }),
      el(doc, 'button', { class: 'btn btn-secondary btn-sm', 'data-action': 'hide-secret', text: 'Done' }),
    ]),
  ]);
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

// #930 PR 3: the statistics' columns, in the simulator's names.
const STATS_COLUMNS = [
  ['tokens', 'Tokens'], ['requests', 'Requests'], ['offers', 'Offers'], ['bookings', 'Bookings'],
  ['confirmations', 'Confirmed'], ['refunds', 'Refunds'], ['exchanges', 'Exchanges'],
  ['clientErrors', '4xx'], ['serverErrors', '5xx'],
];

const anyCount = (c) => STATS_COLUMNS.some(([key]) => (c?.[key] || 0) > 0);

function statsRow(doc, label, counters, strong) {
  const cells = STATS_COLUMNS.map(([key]) => el(doc, 'td', { class: 'num', text: String(counters?.[key] || 0) }));
  const name = strong ? el(doc, 'strong', { text: label }) : el(doc, 'code', { text: label });
  return el(doc, 'tr', {}, [el(doc, 'td', {}, [name]), ...cells]);
}

function statsProviderNode(doc, p) {
  const head = el(doc, 'tr', {}, [el(doc, 'th', { text: 'Account' }), ...STATS_COLUMNS.map(([, t]) => el(doc, 'th', { class: 'num', text: t }))]);
  const rows = (p.accounts || []).map((a) => statsRow(doc, a.clientId, a, false));
  if (anyCount(p.unidentified)) rows.push(statsRow(doc, 'account not known', p.unidentified, true));
  rows.push(statsRow(doc, 'Total', p.totals, true));
  const body = (p.accounts || []).length || anyCount(p.unidentified)
    ? el(doc, 'div', { class: 'table-wrap' }, [el(doc, 'table', {}, [el(doc, 'thead', {}, [head]), el(doc, 'tbody', {}, rows)])])
    : el(doc, 'div', { class: 'empty', text: 'Not used in this period.' });
  return el(doc, 'div', { class: 'card' }, [
    el(doc, 'div', { class: 'provider-head' }, [el(doc, 'h3', {}, [el(doc, 'code', { text: p.provider }), ' ' + (p.name || '')])]),
    body,
  ]);
}

function statsNode(doc, stats) {
  const period = el(doc, 'p', { class: 'muted', text: 'From ' + (stats.from || '?') + ' to ' + (stats.to || '?') + ' (UTC days).' });
  return el(doc, 'div', {}, [period, ...(stats.providers || []).map((p) => statsProviderNode(doc, p))]);
}

// #930 PR 4: the test sets OSCAR sent to the simulator, per provider and user.
const RUN_COLUMNS = [
  ['sets', 'Sets'], ['scenarios', 'Scenarios'], ['scenariosPerSet', 'Scenarios per set'],
  ['scenariosFailed', 'Scenarios failed'], ['failedChecks', 'Failed checks'],
];

function runsRow(doc, label, counts, strong) {
  const cells = RUN_COLUMNS.map(([key]) => el(doc, 'td', { class: 'num', text: String(counts?.[key] ?? 0) }));
  const name = strong ? el(doc, 'strong', { text: label }) : el(doc, 'span', { text: label });
  return el(doc, 'tr', {}, [el(doc, 'td', {}, [name]), ...cells]);
}

function runsNode(doc, body) {
  const providers = body.providers || [];
  if (providers.length === 0) return el(doc, 'div', { class: 'empty', text: 'No test set was run on the simulator in this period.' });
  return el(doc, 'div', {}, providers.map((p) => {
    const head = el(doc, 'tr', {}, [el(doc, 'th', { text: 'User' }), ...RUN_COLUMNS.map(([, t]) => el(doc, 'th', { class: 'num', text: t }))]);
    const rows = (p.users || []).map((u) => runsRow(doc, u.email || '(unknown user)', u, false));
    rows.push(runsRow(doc, 'Total', p.totals, true));
    return el(doc, 'div', { class: 'card' }, [
      el(doc, 'div', { class: 'provider-head' }, [el(doc, 'h3', {}, [el(doc, 'code', { text: p.provider })])]),
      el(doc, 'div', { class: 'table-wrap' }, [el(doc, 'table', {}, [el(doc, 'thead', {}, [head]), el(doc, 'tbody', {}, rows)])]),
    ]);
  }));
}

function auditNode(doc, entries) {
  if (!entries.length) return el(doc, 'div', { class: 'empty', text: 'Nothing yet.' });
  const head = el(doc, 'tr', {}, ['When', 'Who', 'What'].map((t) => el(doc, 'th', { text: t })));
  const rows = entries.map((e) => el(doc, 'tr', {}, [
    el(doc, 'td', { text: whenText(e.at) }), el(doc, 'td', { text: e.by || '?' }), el(doc, 'td', { text: auditWhat(e) }),
  ]));
  return el(doc, 'table', {}, [el(doc, 'thead', {}, [head]), el(doc, 'tbody', {}, rows)]);
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
  function showEmpty(box, text) { box.replaceChildren(el(document, 'div', { class: 'empty', text })); }

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
    if (!res.ok) { showEmpty(providers, await readError(res, 'Could not read the accounts.')); return; }
    const list = (await res.json()).providers || [];
    if (list.length === 0) { showEmpty(providers, 'The simulator has no provider.'); return; }
    providers.replaceChildren(...list.map((p) => providerNode(document, p)));
  }

  async function loadAudit() {
    const box = document.getElementById('audit');
    const res = await fetch(BASE + '/audit');
    if (!res.ok) { showEmpty(box, await readError(res, 'Could not read the audit.')); return; }
    box.replaceChildren(auditNode(document, (await res.json()).entries || []));
  }

  async function loadRuns(days) {
    const box = document.getElementById('runs');
    const res = await fetch(BASE + '/runs?days=' + encodeURIComponent(days));
    if (!res.ok) { showEmpty(box, await readError(res, 'Could not read the test sets.')); return; }
    box.replaceChildren(runsNode(document, await res.json()));
  }

  async function loadStats() {
    const box = document.getElementById('stats');
    const days = document.getElementById('stats-days').value;
    loadRuns(days).catch(reportError);
    const res = await fetch(BASE + '/stats?days=' + encodeURIComponent(days));
    if (!res.ok) { showEmpty(box, await readError(res, 'Could not read the statistics.')); return; }
    box.replaceChildren(statsNode(document, await res.json()));
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
    showEmpty(providers, 'Not set up.');
  }

  function showSecret(created) {
    const box = document.getElementById('new-secret');
    box.replaceChildren(secretNode(document, created));
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
    box.replaceChildren();
    box.style.display = 'none';
  }

  function showTab(name) {
    const tab = ['audit', 'stats'].includes(name) ? name : 'accounts';
    for (const view of ['accounts', 'stats', 'audit']) {
      document.getElementById(view + '-view').style.display = tab === view ? '' : 'none';
      document.getElementById(view + '-help').style.display = tab === view ? '' : 'none';
    }
    for (const link of document.querySelectorAll('[data-tab]')) link.classList.toggle('active', link.dataset.tab === tab);
    if (tab === 'audit') loadAudit().catch(reportError);
    if (tab === 'stats') loadStats().catch(reportError);
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
  document.getElementById('stats-days').addEventListener('change', () => loadStats().catch(reportError));
  window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

  showTab(location.hash.slice(1));
  loadConfig().then((cfg) => {
    if (cfg?.keySet) return loadAccounts();
    showEmpty(providers, 'Enter the simulator\'s address and key above.');
    return null;
  }).catch(reportError);
})();
