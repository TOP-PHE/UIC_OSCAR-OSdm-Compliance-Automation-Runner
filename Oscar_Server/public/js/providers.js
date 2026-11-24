/* global esc, oscarToastAfterNav */  // esc.js, nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of providers.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
let providers = [];
let testers = [];
let accessCounts = {};
let accessProvider = null;
let operatorProvider = null;
let operatorCompanies = [];

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}

async function readError(res, fallback) {
  const d = await res.json().catch(() => ({}));
  return d.detail || d.title || fallback;
}

// A write that may answer 409 because another company of the same distributor
// already uses the endpoint: ask, then send again with the confirmation.
async function sendWithDuplicateConfirm(url, method, body, extraHeaders) {
  const send = b => fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(b),
  });
  let res = await send(body);
  if (res.status === 409) {
    const detail = await readError(res, 'Conflict.');
    if (!detail.includes('allow_duplicate_endpoint')) return { res, detail };
    if (!confirm(detail.replace(/ Send allow_duplicate_endpoint: true to use it anyway\.$/, '') + '\n\nUse this endpoint anyway?')) {
      return { res: null, detail: null };
    }
    res = await send({ ...body, allow_duplicate_endpoint: true });
  }
  return { res, detail: res.ok ? null : await readError(res, 'The change was not saved.') };
}

function providerRow(p) {
  const count = accessCounts[p.id];
  const testerText = count === undefined ? '…' : String(count);
  return '<tr>'
    + '<td><strong>' + esc(p.name) + '</strong></td>'
    + '<td class="endpoint">' + (p.api_base ? esc(p.api_base) : '<span class="muted">not set</span>') + '</td>'
    + '<td>' + esc(testerText) + '</td>'
    + '<td>' + operatorLabel(p.operator) + '</td>'
    + '<td style="white-space:nowrap">'
    + '<button class="btn btn-secondary btn-sm" data-action="rename" data-id="' + esc(p.id) + '">Rename</button> '
    + '<button class="btn btn-secondary btn-sm" data-action="endpoint" data-id="' + esc(p.id) + '">Endpoint</button> '
    + '<button class="btn btn-secondary btn-sm" data-action="access" data-id="' + esc(p.id) + '">Testers</button> '
    + '<button class="btn btn-secondary btn-sm" data-action="operator" data-id="' + esc(p.id) + '">Operated by</button>'
    + '</td></tr>';
}

function renderProviders() {
  const el = document.getElementById('providers-list');
  if (!providers.length) {
    el.innerHTML = '<div class="empty">No provider yet. Your company works on its own endpoint, as before.</div>';
    return;
  }
  el.innerHTML = '<table><thead><tr><th>Name</th><th>OSDM endpoint</th><th>Testers</th><th>Operated by</th><th></th></tr></thead><tbody>'
    + providers.map(providerRow).join('') + '</tbody></table>';
}

async function loadProviders() {
  const res = await fetch('/v1/company/providers', {});
  if (!res.ok) { showMsg(await readError(res, 'Could not load providers.'), false); return; }
  providers = (await res.json()).providers || [];
  renderProviders();
  await Promise.all(providers.map(async p => {
    const id = providerIdOf(p.id);
    if (!id) return;
    const r = await fetch('/v1/company/providers/' + encodeURIComponent(id) + '/access', {});
    if (r.ok) accessCounts[p.id] = ((await r.json()).testers || []).length;
  }));
  renderProviders();
}

// #901: the company that operates a provider, and where its acceptance stands.
function operatorLabel(op) {
  if (!op) return '<span class="muted">—</span>';
  const state = { waiting: 'waiting for their acceptance', accepted: 'accepted', refused: 'refused' }[op.status] || op.status;
  const colour = { accepted: '#2e7d32', refused: '#c62828' }[op.status] || '#e65100';
  return esc(op.company_name) + ' <span style="color:' + colour + ';font-size:11px">(' + esc(state) + ')</span>';
}

async function openOperator(p) {
  operatorProvider = p;
  if (!operatorCompanies.length) {
    const res = await fetch('/v1/company/providers/operator-companies', {});
    if (!res.ok) { showMsg(await readError(res, 'Could not load the companies.'), false); return; }
    operatorCompanies = (await res.json()).companies || [];
  }
  document.getElementById('operator-title').textContent = 'Company that operates ' + p.name;
  const select = document.getElementById('operator-select');
  select.innerHTML = '<option value="">— choose a company —</option>'
    + operatorCompanies.map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
  select.value = p.operator ? p.operator.company_id : '';
  document.getElementById('operator-remove').style.display = p.operator ? '' : 'none';
  document.getElementById('operator-card').style.display = 'block';
  document.getElementById('operator-card').scrollIntoView({ behavior: 'smooth' });
}

async function saveOperator(remove) {
  const p = operatorProvider;
  if (!p) return;
  const url = '/v1/company/providers/' + encodeURIComponent(p.id) + '/operator';
  let res;
  if (remove) {
    if (!confirm('Remove the link? Every run shared with ' + (p.operator ? p.operator.company_name : 'that company') + ' is hidden from them at once.')) return;
    res = await fetch(url, { method: 'DELETE' });
  } else {
    const companyId = document.getElementById('operator-select').value;
    if (!companyId) { showMsg('Choose a company.', false); return; }
    res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: companyId }) });
  }
  if (!res.ok) { showMsg(await readError(res, 'The link was not saved.'), false); return; }
  const op = remove ? null : ((await res.json().catch(() => ({}))).provider || {}).operator;
  let note = 'Linked. Their Test Managers now have to accept it (Providers page).';
  if (remove) note = 'Link removed.';
  else if (op && op.status !== 'waiting') note = 'This company is already linked (' + op.status + ').';
  showMsg(note, true);
  document.getElementById('operator-card').style.display = 'none';
  await loadProviders();
}

// The other side: companies that linked one of their providers to this company.
function linkRow(l) {
  const state = { waiting: 'Waiting for your answer', accepted: 'Accepted', refused: 'Refused' }[l.status] || l.status;
  const accept = l.status === 'accepted' ? '' : '<button class="btn btn-primary btn-sm" data-action="link-accept" data-provider="' + esc(l.provider_id) + '">Accept</button> ';
  const refuseLabel = l.status === 'accepted' ? 'Stop' : 'Refuse';
  const refuse = l.status === 'refused' ? '' : '<button class="btn btn-secondary btn-sm" data-action="link-refuse" data-provider="' + esc(l.provider_id) + '">' + refuseLabel + '</button>';
  return '<tr><td><strong>' + esc(l.distributor_name) + '</strong></td><td>' + esc(l.provider_name) + '</td><td>' + esc(state) + '</td>'
    + '<td style="white-space:nowrap">' + accept + refuse + '</td></tr>';
}

async function loadLinks() {
  const res = await fetch('/v1/company/run-share-links', { headers: { 'X-Provider-Id': '' } });
  if (!res.ok) return;
  const links = (await res.json()).links || [];
  document.getElementById('links-card').style.display = links.length ? 'block' : 'none';
  document.getElementById('links-list').innerHTML = '<table><thead><tr><th>Company</th><th>As its provider</th><th>Status</th><th></th></tr></thead><tbody>'
    + links.map(linkRow).join('') + '</tbody></table>';
}

async function decideLink(providerId, verb) {
  if (verb === 'refuse' && !confirm('The runs this company shared with you will no longer be shown. Go on?')) return;
  const res = await fetch('/v1/company/run-share-links/' + encodeURIComponent(providerId) + '/' + verb, { method: 'POST', headers: { 'X-Provider-Id': '' } });
  if (!res.ok) { showMsg(await readError(res, 'Not saved.'), false); return; }
  showMsg(verb === 'accept' ? 'Accepted: the runs they share appear on your Dashboard.' : 'Done.', true);
  await loadLinks();
}

async function loadTesters() {
  const res = await fetch('/v1/company/users', {});
  if (!res.ok) return;
  testers = ((await res.json()).users || []).filter(u => u.role === 'company_user' && u.status !== 'pending');
}

async function createProvider() {
  const name = document.getElementById('new-name').value.trim();
  const apiBase = document.getElementById('new-endpoint').value.trim();
  if (!name) { showMsg('Give the provider a name.', false); return; }
  const body = { name };
  if (apiBase) body.api_base = apiBase;
  const { res, detail } = await sendWithDuplicateConfirm('/v1/company/providers', 'POST', body);
  if (!res) return;
  if (detail) { showMsg(detail, false); return; }
  document.getElementById('new-name').value = '';
  document.getElementById('new-endpoint').value = '';
  // Reload so the menu's "Working on" selector lists the new provider.
  oscarToastAfterNav('Provider "' + name + '" added. Choose it in "Working on" to set up its data file and credentials.', 'success');
  location.reload();
}

async function renameProvider(p) {
  const name = prompt('New name for "' + p.name + '":', p.name);
  if (name === null || name.trim() === '' || name.trim() === p.name) return;
  const res = await fetch('/v1/company/providers/' + encodeURIComponent(p.id), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) { showMsg(await readError(res, 'Rename failed.'), false); return; }
  showMsg('Renamed.', true);
  await loadProviders();
}

// The endpoint is the provider's company setting: PATCH /v1/company naming it.
async function changeEndpoint(p) {
  const value = prompt('OSDM API endpoint for "' + p.name + '":', p.api_base || '');
  if (value === null || value.trim() === '' || value.trim() === (p.api_base || '')) return;
  const { res, detail } = await sendWithDuplicateConfirm('/v1/company', 'PATCH', { api_base: value.trim() }, { 'X-Provider-Id': p.id });
  if (!res) return;
  if (detail) { showMsg(detail, false); return; }
  showMsg('Endpoint saved.', true);
  await loadProviders();
}

async function openAccess(p) {
  accessProvider = p;
  const res = await fetch('/v1/company/providers/' + encodeURIComponent(p.id) + '/access', {});
  if (!res.ok) { showMsg(await readError(res, 'Could not load the access list.'), false); return; }
  const granted = new Set(((await res.json()).testers || []).map(t => t.id));
  document.getElementById('access-title').textContent = 'Testers with access to ' + p.name;
  const list = document.getElementById('access-list');
  list.innerHTML = testers.length
    ? testers.map(t => '<div class="tester-row">'
        + '<input type="checkbox" id="acc-' + esc(t.id) + '" data-action="toggle-access" data-user="' + esc(t.id) + '"'
        + (granted.has(t.id) ? ' checked' : '') + '>'
        + '<label for="acc-' + esc(t.id) + '">' + esc(t.email) + '</label></div>').join('')
    : '<div class="empty">Your company has no active tester yet.</div>';
  document.getElementById('access-card').style.display = 'block';
  document.getElementById('access-card').scrollIntoView({ behavior: 'smooth' });
}

async function toggleAccess(box) {
  const p = accessProvider;
  if (!p) return;
  const url = '/v1/company/providers/' + encodeURIComponent(p.id) + '/access/' + encodeURIComponent(box.dataset.user);
  box.disabled = true;
  const res = await fetch(url, { method: box.checked ? 'PUT' : 'DELETE' });
  box.disabled = false;
  if (!res.ok) {
    box.checked = !box.checked;
    showMsg(await readError(res, 'The change was not saved.'), false);
    return;
  }
  accessCounts[p.id] = (accessCounts[p.id] || 0) + (box.checked ? 1 : -1);
  renderProviders();
}

function reportError(e) { showMsg((e && e.message) || 'Something went wrong.', false); }

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.dataset.action === 'toggle-access') return;
  const p = providers.find(x => x.id === el.dataset.id);
  if (el.dataset.action === 'create') createProvider().catch(reportError);
  else if (el.dataset.action === 'rename' && p) renameProvider(p).catch(reportError);
  else if (el.dataset.action === 'endpoint' && p) changeEndpoint(p).catch(reportError);
  else if (el.dataset.action === 'access' && p) openAccess(p).catch(reportError);
  else if (el.dataset.action === 'operator' && p) openOperator(p).catch(reportError);
  else if (el.dataset.action === 'operator-save') saveOperator(false).catch(reportError);
  else if (el.dataset.action === 'operator-remove') saveOperator(true).catch(reportError);
  else if (el.dataset.action === 'link-accept') decideLink(el.dataset.provider, 'accept').catch(reportError);
  else if (el.dataset.action === 'link-refuse') decideLink(el.dataset.provider, 'refuse').catch(reportError);
});
document.addEventListener('change', e => {
  const el = e.target.closest('[data-action="toggle-access"]');
  if (el) toggleAccess(el).catch(reportError);
});

if (user.role === 'test_manager') {
  Promise.all([loadProviders(), loadTesters(), loadLinks()]).catch(reportError);
} else {
  document.getElementById('create-card').style.display = 'none';
  document.getElementById('providers-list').innerHTML =
    '<div class="empty">Providers are managed by your company\'s Test Managers.</div>';
}

// A provider id from an answer: a UUID (the server makes them with crypto.randomUUID), else ''.
// Only that goes into a request address (#1423).
function providerIdOf(value) {
  const text = typeof value === 'string' ? value : '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text : '';
}
