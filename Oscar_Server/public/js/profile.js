/* global esc, oscarSelectedProvider */  // esc.js, nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of profile.html, moved out of the page unchanged (#1423) so that
// the content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

if (!localStorage.getItem('oscar_user')) window.location.href = '/';
const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');

// #1342: a Test Manager saves a Company API account's OSDM credentials here,
// opened from the API Accounts page as profile.html?api_account=<id>. Only
// the credentials change then: the shared part (endpoint, dedicated headers)
// is the company's and stays read-only on this page.
const API_ACCOUNT_ID = apiAccountIdOf(location.search, user.role);

// The account's id when a Test Manager opens the page for one, else null.
function apiAccountIdOf(search, role) {
  if (role !== 'test_manager') return null;
  const id = new URLSearchParams(search).get('api_account') || '';
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ? id : null;
}

// Where this page reads and saves credentials: the user's own, or the account's.
function credentialsUrl(suffix) {
  const base = API_ACCOUNT_ID ? '/v1/company/api-accounts/' + API_ACCOUNT_ID + '/credentials' : '/v1/me/credentials';
  return base + (suffix || '');
}

// Whose credentials a sentence speaks of.
function whoseCredentials(capital) {
  if (API_ACCOUNT_ID) return capital ? 'The account\'s' : 'the account\'s';
  return capital ? 'Your' : 'your';
}

// logout() provided by nav.js

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.style.display = 'block';
}

// ── Sections (#580) ───────────────────────────────────────────────────────────
// The page holds one section for the user's company and one for each provider
// they may use. A section is a copy of #target-template; `card` below is always
// the root element of one section.

// One field of a section.
function field(card, name) {
  return card.querySelector('[data-f="' + name + '"]');
}

// #1351: an eye button beside each masked field of a section shows what was
// typed in it, to catch a typo before saving, and masks it again. Saved
// secrets never reach the page ("leave blank to keep current"): it shows what
// is typed here, and the token URL and scope the page already holds.
function addRevealButtons(card) {
  card.querySelectorAll('input[type="password"]').forEach(input => {
    const box = document.createElement('div');
    box.className = 'secret-field';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reveal';
    button.textContent = '👁';
    button.dataset.reveals = input.dataset.f;
    button.setAttribute('aria-controls', input.id);
    input.replaceWith(box);
    box.append(input, button);
    setShown(input, button, false);
    button.addEventListener('click', () => setShown(input, button, input.type === 'password'));
  });
}

// Shows or masks one field's text, and says which on its button.
function setShown(input, button, shown) {
  input.type = shown ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(shown));
  button.setAttribute('aria-label', (shown ? 'Hide' : 'Show') + ' what is typed in this field');
  button.title = shown ? 'Hide' : 'Show what is typed';
}

// Every field of a section masked again: after a save, a clear or a re-read.
function maskSecrets(card) {
  card.querySelectorAll('button.reveal').forEach(button => setShown(field(card, button.dataset.reveals), button, false));
}

// Every request of a section names the company or provider of that section.
// The menu's "Working on" choice plays no part on this page: nav.js adds it
// only to a request that names none, and every request here names one.
function inTarget(card, init) {
  return { ...init, headers: { ...init?.headers, 'X-Provider-Id': card.dataset.targetId } };
}

// A message next to the buttons of the section it is about.
function showTargetMsg(card, text, ok) {
  const el = field(card, 'msg');
  el.textContent = text;
  el.className = 'msg target-msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.style.display = 'block';
}

// What a run needs from the user here (the same rule as POST /v1/runs).
function credentialsSet(m) {
  if (m.auth_mode === 'oauth2') return !!(m.token_url && m.has_client_id && m.has_client_secret);
  return !!m.has_token;
}

function switchMode(card) {
  const mode = field(card, 'auth_mode').value;
  field(card, 'mode-bearer').classList.toggle('active', mode === 'bearer');
  field(card, 'mode-oauth2').classList.toggle('active', mode === 'oauth2');
}

// Per-profile UI hints + visibility of the optional fields. Keeps storage
// names (client_id / client_secret) but relabels them to match how each
// vendor's docs describe them, so the operator doesn't have to translate.
const PROFILE_META = {
  oauth2_basic: {
    help:        'RFC 6749 client_secret_basic — credentials sent as Basic auth header.',
    cidLabel:    'Client ID',
    csecLabel:   'Client Secret',
    showScope:   true,
    showExtra:   false,
    showTemplate:false
  },
  oauth2_post: {
    help:        'RFC 6749 client_secret_post — credentials sent in the form body. Used by Bileto and Turnit.',
    cidLabel:    'Client ID',
    csecLabel:   'Client Secret',
    showScope:   true,
    showExtra:   false,
    showTemplate:false
  },
  paxone_json: {
    help:        'Paxone — POST JSON {"accountName": Client ID, "accountSecret": Client Secret}.',
    cidLabel:    'Account Name',
    csecLabel:   'Account Secret',
    showScope:   false,
    showExtra:   false,
    showTemplate:false
  },
  sqills_extension: {
    help:        'Sqills — Basic auth header (Extra Credential) layered on a JSON body { grant_type URI, username, password }.',
    cidLabel:    'Username',
    csecLabel:   'Password',
    showScope:   false,
    showExtra:   true,
    showTemplate:false
  },
  custom: {
    help:        'Custom — provide a JSON request template. Placeholders: {{client_id}}, {{client_secret}}, {{scope}}, {{extra}}.',
    cidLabel:    'Client ID',
    csecLabel:   'Client Secret',
    showScope:   true,
    showExtra:   true,
    showTemplate:true
  }
};

function switchProfile(card) {
  const meta = PROFILE_META[field(card, 'oauth_profile').value] || PROFILE_META.oauth2_basic;
  field(card, 'profile-help').textContent        = meta.help;
  field(card, 'client_id_label').textContent     = meta.cidLabel;
  field(card, 'client_secret_label').textContent = meta.csecLabel;
  field(card, 'field-scope').style.display           = meta.showScope    ? '' : 'none';
  field(card, 'field-extra').style.display           = meta.showExtra    ? '' : 'none';
  field(card, 'field-custom-template').style.display = meta.showTemplate ? '' : 'none';
}

// ── Dedicated headers (issue #426) ────────────────────────────────────────────
// Custom request headers shared by everyone who works in the section's company
// or provider. Editable by Test Managers only; other testers see them
// read-only. Each row = header name + value (literal or a {{var}} template
// resolved per tester at request time).
const CAN_EDIT_HEADERS = (user.role === 'test_manager') && !API_ACCOUNT_ID;

// The shared endpoint (#544). Every run of every tester goes to it, so it is
// the Test Manager's to change. Everyone else sees it read-only, and the server
// refuses the change from anyone else.
const CAN_EDIT_ENDPOINT = (user.role === 'test_manager') && !API_ACCOUNT_ID;

function makeHeaderRow(name, value) {
  const row = document.createElement('div');
  row.className = 'eh-row';
  row.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center';
  const nameI = document.createElement('input');
  nameI.type = 'text'; nameI.className = 'eh-name'; nameI.placeholder = 'Header-Name';
  nameI.setAttribute('aria-label', 'Header name');
  nameI.value = name || '';
  nameI.style.cssText = 'flex:0 0 38%;padding:8px 10px;border:1px solid #cfd8dc;border-radius:6px;font-size:13px';
  const valI = document.createElement('input');
  valI.type = 'text'; valI.className = 'eh-value'; valI.placeholder = 'value or {{requestor}}';
  valI.setAttribute('aria-label', 'Header value');
  valI.value = value || '';
  valI.style.cssText = 'flex:1;padding:8px 10px;border:1px solid #cfd8dc;border-radius:6px;font-size:13px';
  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'btn btn-secondary eh-remove'; rm.textContent = '✕';
  rm.title = 'Remove header'; rm.style.cssText = 'flex:0 0 auto;padding:8px 12px';
  rm.addEventListener('click', () => {
    const card = row.closest('details.target');
    row.remove();
    if (card) markUnsaved(card, true);
  });
  if (!CAN_EDIT_HEADERS) { nameI.disabled = true; valI.disabled = true; rm.style.display = 'none'; }
  row.appendChild(nameI); row.appendChild(valI); row.appendChild(rm);
  return row;
}

function renderExtraHeaders(card, arr) {
  const list = field(card, 'extra-headers-list');
  list.innerHTML = '';
  (Array.isArray(arr) ? arr : []).forEach(h => list.appendChild(makeHeaderRow(h?.name, h?.value)));
  if (!CAN_EDIT_HEADERS) {
    field(card, 'add-header-btn').style.display = 'none';
    field(card, 'extra-headers-readonly-note').style.display = 'block';
  }
}

function collectExtraHeaders(card) {
  const out = [];
  field(card, 'extra-headers-list').querySelectorAll('.eh-row').forEach(r => {
    const name  = (r.querySelector('.eh-name').value || '').trim();
    const value = r.querySelector('.eh-value').value || '';
    if (name) out.push({ name, value });
  });
  return out;
}

// ── The summary and the title line of a section ───────────────────────────────
// What is known of each section, by id: { name, provider, company, creds }.
const targets = new Map();

function badge(ok, yes, no) {
  return '<span class="badge ' + (ok ? 'badge-ok' : 'badge-warn') + '">' + esc(ok ? yes : no) + '</span>';
}

function markUnsaved(card, unsaved) {
  card.dataset.unsaved = unsaved ? '1' : '';
  field(card, 'unsaved').style.display = unsaved ? 'inline' : 'none';
}

function renderSummary() {
  const rows = [];
  targets.forEach((t, id) => {
    const endpoint = t.company?.api_base;
    rows.push('<tr>'
      + '<td><a href="#target-' + esc(id) + '" data-open="' + esc(id) + '">' + esc(t.name) + '</a>'
      + (t.provider ? '' : ' <span class="target-kind">your company</span>') + '</td>'
      + '<td class="endpoint">' + (endpoint ? esc(endpoint) : badge(false, '', 'not set')) + '</td>'
      + '<td>' + (t.creds ? badge(credentialsSet(t.creds), 'set', 'missing') : '') + '</td>'
      + '<td>' + (t.company ? badge(!!t.company.datafile_updated_at, 'set', 'missing') : '') + '</td>'
      + '</tr>');
  });
  document.getElementById('targets-summary-rows').innerHTML = rows.join('');
}

// ── One section: fill, save, clear ────────────────────────────────────────────
// The name of a section's company or provider, wherever the section shows it.
// Named everywhere, the company's own section included (#580): the credentials
// typed here are for this one and for no other.
function nameTarget(card, c) {
  const name = c.name || 'Company';
  field(card, 'name').textContent = name;
  field(card, 'name-2').textContent = name;
  field(card, 'kind').textContent = c.parent_id ? 'provider' : 'your company';
  field(card, 'shared-hint').textContent = c.parent_id
    ? 'Shared with everyone in your company who may use ' + name + '. Editing it changes the OSDM endpoint of all their runs on ' + name + '.'
    : 'Shared with everyone in your company. Editing it changes the OSDM endpoint for all testers.';
  field(card, 'save-btn').textContent = '💾 Save configuration for ' + name;
  const whose = API_ACCOUNT_ID ? 'the account\'s' : 'my';
  field(card, 'clear-creds-btn').textContent = '🗑 Clear ' + whose + ' credentials for ' + name;
  field(card, 'test-creds-btn').textContent = '🔌 Test ' + whose + ' credentials for ' + name;
}

// The shared part of a section: the endpoint and the dedicated headers.
function fillShared(card, c) {
  field(card, 'api_base').value = c.api_base || '';
  if (!CAN_EDIT_ENDPOINT) {
    // Read-only, not disabled: a tester can still select and copy the address.
    const endpointInput = field(card, 'api_base');
    endpointInput.readOnly = true;
    endpointInput.style.background = '#f5f7f8';
    field(card, 'api-base-readonly-note').style.display = 'block';
  }
  renderExtraHeaders(card, c.extra_headers);   // issue #426 — dedicated headers
}

// The user's own part of a section. A secret is never put back in its field.
function fillCredentials(card, m) {
  maskSecrets(card);
  field(card, 'auth_mode').value             = m.auth_mode || 'bearer';
  field(card, 'token_url').value             = m.token_url || '';
  field(card, 'oauth_profile').value         = m.oauth_profile || 'oauth2_basic';
  field(card, 'oauth_scope').value           = m.oauth_scope || '';
  field(card, 'oauth_custom_template').value = m.oauth_custom_template || '';
  ['access_token', 'client_id', 'client_secret', 'oauth_extra', 'requestor', 'subscription_key']
    .forEach(secret => { field(card, secret).value = ''; });
  switchMode(card);
  switchProfile(card);
}

// Put what the server holds for this section into its fields.
// An endpoint suspended after an intrusion attempt (utils/intrusion.js): a red
// note above the endpoint, and for a Test Manager the button that resumes it.
function showSuspension(card, c) {
  // Found by data-f inside the section, as every field of a section is.
  card.querySelector('[data-f="suspended-note"]')?.remove?.();
  if (!c.endpoint_suspended_at) return;
  const note = document.createElement('div');
  note.className = 'suspended-note';
  note.dataset.f = 'suspended-note';
  note.setAttribute('role', 'alert');
  note.style.cssText = 'background:#b71c1c;color:#fff;border-radius:6px;padding:10px 14px;margin:0 0 12px;font-size:13px;line-height:1.5';
  const title = document.createElement('strong');
  title.textContent = '⛔ Intrusion attempt detected — endpoint suspended. ';
  const text = document.createElement('span');
  text.textContent = CAN_EDIT_ENDPOINT
    ? 'No run goes to this endpoint until you resume it. Check the provider first; saving another endpoint also resumes.'
    : 'No run goes to this endpoint until a Test Manager resumes it.';
  note.append(title, text);
  if (CAN_EDIT_ENDPOINT) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Resume the endpoint';
    btn.style.cssText = 'margin-left:10px;padding:4px 10px;border-radius:4px;border:0;cursor:pointer';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await fetch('/v1/company/endpoint/resume', inTarget(card, { method: 'POST' }));
      if (res.ok) await loadTarget(card);
      else btn.disabled = false;
    });
    note.append(btn);
  }
  field(card, 'api_base').parentElement.insertAdjacentElement('beforebegin', note);
}

// The endpoint changed since these credentials were saved: OSCAR sends them
// nowhere until they are saved again (utils/credentialEndpoint.js).
function showEndpointChanged(card, m) {
  card.querySelector('[data-f="endpoint-changed-note"]')?.remove?.();
  if (!m.endpoint_changed) return;
  const note = document.createElement('div');
  note.dataset.f = 'endpoint-changed-note';
  note.setAttribute('role', 'alert');
  note.style.cssText = 'background:#fff3e0;border:2px solid #e65100;color:#bf360c;border-radius:6px;padding:10px 14px;margin:0 0 12px;font-size:13px;line-height:1.5';
  const title = document.createElement('strong');
  const text = document.createElement('span');
  // 1.11.479: saved while there was no endpoint, they are tied to none.
  if (m.credentials_endpoint) {
    title.textContent = '⚠️ The OSDM endpoint changed since ' + whoseCredentials(false) + ' credentials were saved. ';
    text.textContent = `They were saved for ${m.credentials_endpoint}. OSCAR sends them nowhere, and starts no run, until you check them below and save them again.`;
  } else {
    title.textContent = '⚠️ ' + whoseCredentials(true) + ' credentials were saved before there was an OSDM endpoint. ';
    text.textContent = 'OSCAR sends them nowhere, and starts no run, until you check them below and save them again.';
  }
  note.append(title, text);
  field(card, 'save-btn').insertAdjacentElement('beforebegin', note);
}

function fillTarget(card, c, m) {
  const known = targets.get(card.dataset.targetId);
  if (known) { known.company = c; known.creds = m; }
  nameTarget(card, c);
  fillShared(card, c);
  showSuspension(card, c);
  fillCredentials(card, m);
  showEndpointChanged(card, m);

  // The title line: is this section ready for a run?
  const credsConfigured = credentialsSet(m);
  field(card, 'badges').innerHTML = badge(!!c.api_base, 'endpoint set', 'no endpoint')
    + ' ' + badge(credsConfigured, 'credentials set', 'no credentials');
  // The "no test config" notice: endpoint and credentials are set, but there
  // is no data file here yet.
  const noTestData = !!c.api_base && credsConfigured && !c.datafile_updated_at;
  field(card, 'notice-testconfig').style.display = noTestData ? 'block' : 'none';
  markUnsaved(card, false);
}

// A section whose company or provider could not be read: say so in it, and
// take its buttons away, rather than show fields that would not save.
function targetUnavailable(card, gone) {
  const notice = field(card, 'notice-unavailable');
  notice.textContent = gone
    ? 'This provider is no longer available to you. Ask a Test Manager of your company.'
    : 'This section could not be loaded. Reload the page to try again.';
  notice.style.display = 'block';
  field(card, 'save-btn').disabled = true;
  field(card, 'clear-creds-btn').disabled = true;
  field(card, 'test-creds-btn').disabled = true;
}

async function loadTarget(card) {
  const [companyRes, credsRes] = await Promise.all([
    fetch('/v1/company',        inTarget(card)),
    fetch(credentialsUrl(), inTarget(card))
  ]);
  if (!companyRes.ok || !credsRes.ok) {
    targetUnavailable(card, companyRes.status === 404 || credsRes.status === 404);
    return;
  }
  fillTarget(card, await companyRes.json(), await credsRes.json());
  renderSummary();
}

// What a save sends of a section's shared part. Empty when there is nothing
// this user may send.
function sharedPayload(card) {
  const payload = {};
  const apiBase = field(card, 'api_base').value.trim();
  // #544 — only a Test Manager sends the endpoint. For everyone else the field
  // is read-only, and their save goes straight to their own credentials.
  if (apiBase && CAN_EDIT_ENDPOINT) payload.api_base = apiBase;
  // Issue #426 — always send the current header list (so emptying it clears the
  // stored value). Test-Manager-only; the server rejects edits from other roles.
  if (CAN_EDIT_HEADERS) payload.extra_headers = collectExtraHeaders(card);
  return payload;
}

// What a save sends of the user's own credentials. A secret left blank is not
// sent, so the stored one is kept.
function credentialsPayload(card) {
  const typed = name => field(card, name).value.trim();
  const creds = { auth_mode: field(card, 'auth_mode').value };
  const secrets = creds.auth_mode === 'bearer'
    ? ['access_token']
    : ['token_url', 'client_id', 'client_secret', 'oauth_extra'];
  if (creds.auth_mode !== 'bearer') {
    creds.oauth_profile         = field(card, 'oauth_profile').value;
    // Always sent, so that the user can clear them (empty → null in DB)
    creds.oauth_scope           = typed('oauth_scope');
    creds.oauth_custom_template = typed('oauth_custom_template');
  }
  secrets.concat(['requestor', 'subscription_key']).forEach(name => {
    if (typed(name)) creds[name] = typed(name);
  });
  return creds;
}

// Save a section's shared part. True when it is stored, or when there was
// nothing to store; false when the save stopped, with the reason shown.
async function saveShared(card) {
  const payload = sharedPayload(card);
  if (Object.keys(payload).length === 0) return true;
  const patchCompany = body => fetch('/v1/company', inTarget(card, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
  let r = await patchCompany(payload);
  // #540: another company of the same distributor already uses this
  // endpoint. Ask, then send again with the confirmation (it is audited).
  if (r.status === 409) {
    const d = await r.json().catch(() => ({}));
    const detail = String(d.detail || '');
    if (!detail.includes('allow_duplicate_endpoint')) { showTargetMsg(card, detail || 'Saving the shared settings failed.', false); return false; }
    if (!confirm(detail.replace(/ Send allow_duplicate_endpoint: true to use it anyway\.$/, '') + '\n\nUse this endpoint anyway?')) return false;
    r = await patchCompany({ ...payload, allow_duplicate_endpoint: true });
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    showTargetMsg(card, d.detail || d.title || 'Saving the shared settings failed.', false);
    return false;
  }
  return true;
}

async function saveTarget(card) {
  // Two PATCHes, both for this section's company or provider: the shared part
  // goes to /v1/company, the user's own to /v1/me/credentials. Sequential so
  // an error in either surfaces clearly.
  if (!(await saveShared(card))) return;

  const r2 = await fetch(credentialsUrl(), inTarget(card, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentialsPayload(card))
  }));
  if (!r2.ok) {
    const d = await r2.json().catch(() => ({}));
    showTargetMsg(card, d.detail || d.title || 'Saving credentials failed.', false); return;
  }

  // Read this section again: the secret fields are emptied and the summary
  // shows what is stored now. No other section is touched.
  await loadTarget(card);
  showTargetMsg(card, 'Configuration saved for ' + field(card, 'name').textContent + '.', true);
}

async function clearCredentials(card) {
  const name = field(card, 'name').textContent;
  if (!confirm('Wipe ' + whoseCredentials(false) + ' stored credentials for ' + name + '?\n\n' +
               'This removes: bearer token, OAuth client id/secret, OAuth extra, ' +
               'requestor, subscription key, and any cached access token.\n\n' +
               whoseCredentials(true) + ' credentials for any other company or provider are not touched.')) {
    return;
  }
  // Send null for every credential field so the server clears each one.
  // me-credentials.js distinguishes "field absent" (no change) from
  // "field present and falsy" (clear).
  const wipe = {
    access_token: null,
    client_id: null,
    client_secret: null,
    oauth_extra: null,
    oauth_scope: null,
    oauth_custom_template: null,
    requestor: null,
    subscription_key: null
  };
  const r = await fetch(credentialsUrl(), inTarget(card, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wipe)
  }));
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    showTargetMsg(card, d.detail || d.title || 'Clearing credentials failed.', false);
    return;
  }
  await loadTarget(card);
  showTargetMsg(card, whoseCredentials(true) + ' credentials for ' + name + ' were cleared.', true);
}

// ── Test my credentials (#872) ────────────────────────────────────────────────
// The test uses what is saved, never what is typed: the server gets a token the
// way a run does, then asks the provider's GET /versions with it. The result
// is drawn as text, line by line, under the buttons of its own section.

// How long a token lives, in words.
function lifetimeText(seconds) {
  if (seconds <= 0) return 'expired';
  if (seconds < 120) return 'valid ' + seconds + ' s';
  if (seconds < 7200) return 'valid ' + Math.round(seconds / 60) + ' min';
  return 'valid ' + Math.round(seconds / 3600) + ' h';
}

// The lines of a test's answer: what was found first, then the two steps.
function credentialTestLines(d) {
  const lines = [String(d?.summary || '')];
  const t = d?.token || {};
  let token = 'Token: ' + (t.ok ? 'obtained' : 'not obtained') + ' (' + (t.mode === 'oauth2' ? 'OAuth2, ' + t.profile : 'bearer token');
  if (typeof t.expiresInSeconds === 'number') token += ', ' + lifetimeText(t.expiresInSeconds);
  lines.push(token + ').');
  const a = d?.api || {};
  if (typeof a.status === 'number') lines.push('GET /versions: HTTP ' + a.status + '.');
  if (a.frameworkVersion) lines.push('Test Framework version: ' + a.frameworkVersion + '.');
  return lines.filter(Boolean);
}

// Draw a test's lines under the buttons. ok: true green, false red, null neutral.
function showTestResult(card, lines, ok) {
  const el = field(card, 'test-result');
  el.replaceChildren();
  lines.forEach(line => {
    const row = document.createElement('div');
    row.textContent = line;
    el.appendChild(row);
  });
  let tone = 'msg-info';
  if (ok === true) tone = 'msg-ok';
  if (ok === false) tone = 'msg-err';
  el.className = 'msg target-msg test-result ' + tone;
  el.style.display = 'block';
}

async function testSavedCredentials(card) {
  const name = field(card, 'name').textContent;
  // What is typed and not saved is not what a run would use: save it first.
  if (card.dataset.unsaved === '1') {
    if (!confirm('Your changes for ' + name + ' are not saved, and the test uses what is saved.\n\nSave them first, then test?')) {
      showTestResult(card, ['Not tested: save your changes first, or reload the page to drop them.'], null);
      return;
    }
    await saveTarget(card);
    if (card.dataset.unsaved === '1') return;   // the save stopped and said why
  }
  const button = field(card, 'test-creds-btn');
  button.disabled = true;
  showTestResult(card, ['Testing the credentials saved for ' + name + '…'], null);
  try {
    const r = await fetch(credentialsUrl('/test'), inTarget(card, { method: 'POST' }));
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      showTestResult(card, [d.detail || d.title || ('The test could not be run (HTTP ' + r.status + ').')], false);
      return;
    }
    showTestResult(card, credentialTestLines(d), !!(d.token?.ok && d.api?.ok));
  } finally {
    button.disabled = false;
  }
}

// ── Building the page ─────────────────────────────────────────────────────────
// Reports a failed action in the section it belongs to (nothing awaits these).
function reportTargetError(card) {
  return (e) => { console.error(e); showTargetMsg(card, 'Something went wrong: ' + (e?.message || e), false); };
}

function addTarget(target, index) {
  const card = document.getElementById('target-template').content.firstElementChild.cloneNode(true);
  card.dataset.targetId = target.id;
  card.id = 'target-' + target.id;
  // In the template a label names its field (for="api_base", id="api_base").
  // Each copy gets ids of its own here, before it enters the page, so the page
  // never holds the same id twice.
  card.querySelectorAll('label[for]').forEach(label => {
    const input = field(card, label.htmlFor);
    input.id = label.htmlFor + '-' + index;
    label.htmlFor = input.id;
  });
  addRevealButtons(card);
  field(card, 'name').textContent = target.name;
  field(card, 'name-2').textContent = target.name;
  if (API_ACCOUNT_ID) {
    // #1355: opened for a Company API account, the section is the account's, not the person's.
    field(card, 'creds-whose').textContent = 'The account\'s';
    field(card, 'creds-hint').textContent = 'Used only for the Company API account\'s runs here. Your own credentials are not changed.';
  }
  field(card, 'auth_mode').addEventListener('change', () => switchMode(card));
  field(card, 'oauth_profile').addEventListener('change', () => switchProfile(card));
  field(card, 'save-btn').addEventListener('click', () => { saveTarget(card).catch(reportTargetError(card)); });
  field(card, 'clear-creds-btn').addEventListener('click', () => { clearCredentials(card).catch(reportTargetError(card)); });
  field(card, 'test-creds-btn').addEventListener('click', () => { testSavedCredentials(card).catch(reportTargetError(card)); });
  field(card, 'add-header-btn').addEventListener('click', () => {
    field(card, 'extra-headers-list').appendChild(makeHeaderRow('', ''));
    markUnsaved(card, true);
  });
  // Anything typed or chosen in a section marks that section, and only it.
  card.addEventListener('input', () => markUnsaved(card, true));
  document.getElementById('targets').appendChild(card);
  return card;
}

// The sections of this page: the user's company first, then the providers
// they may use. null when the company itself could not be read.
async function listTargets() {
  if (API_ACCOUNT_ID) return listAccountTargets();
  // '' names no provider: the user's own company, whatever "Working on" says.
  const [ownRes, listRes] = await Promise.all([
    fetch('/v1/company', { headers: { 'X-Provider-Id': '' } }),
    fetch('/v1/company/providers', {})
  ]);
  if (!ownRes.ok) return null;
  const own = await ownRes.json();
  if (!own.id) return null;
  const list = [{ id: own.id, name: own.name || 'My company', provider: false }];
  if (!listRes.ok) {
    // Not "there are none": the list could not be read, and the page says so.
    showMsg('The providers of your company could not be loaded. Only your own company is shown; reload the page to try again.', false);
    return list;
  }
  const providers = (await listRes.json()).providers;
  (Array.isArray(providers) ? providers : []).forEach(p => list.push({ id: p.id, name: p.name, provider: true }));
  return list;
}

// The sections of a Company API account (#1342): its company and the
// providers it is given, as the account's own answer lists them.
async function listAccountTargets() {
  const res = await fetch('/v1/company/api-accounts/' + encodeURIComponent(API_ACCOUNT_ID), { headers: { 'X-Provider-Id': '' } });
  if (!res.ok) return null;
  const account = await res.json();
  showAccountNotice(account);
  return (account.credentials || []).map((c, i) => ({ id: c.company_id, name: c.company_name, provider: i > 0 }));
}

// Says, above the sections, whose credentials they are. Text only.
function showAccountNotice(account) {
  const box = document.getElementById('account-notice');
  const title = document.createElement('strong');
  title.textContent = '🤖 OSDM credentials of the Company API account “' + (account.name || '') + '”';
  const text = document.createElement('p');
  text.className = 'muted';
  text.textContent = 'What you save here is the account\'s, not yours: its runs use it. The endpoint and the dedicated headers are your company\'s; change them on this page opened from the menu.';
  const back = document.createElement('a');
  back.href = '/api-accounts.html';
  back.textContent = '← Back to API Accounts';
  box.replaceChildren(title, text, back);
  box.style.display = 'block';
  // #1355: the summary's column names whose credentials it shows.
  const column = document.getElementById('summary-creds-col');
  if (column) column.textContent = 'The account\'s credentials';
}

function openTarget(id) {
  const card = document.getElementById('target-' + id);
  if (!card) return;
  card.open = true;
  card.scrollIntoView({ block: 'start' });
}

async function buildPage() {
  const list = await listTargets();
  if (!list) {
    showMsg(API_ACCOUNT_ID
      ? 'This Company API account could not be loaded: it may have been deleted. Open it again from API Accounts.'
      : 'Your company could not be loaded. Reload the page to try again.', false);
    return;
  }
  // The section of the menu's "Working on" choice is the one opened.
  const working = (typeof oscarSelectedProvider === 'function' && oscarSelectedProvider()) || null;
  const current = list.some(t => t.id === working?.id) ? working.id : list[0].id;
  const several = list.length > 1;
  list.forEach((t, i) => {
    targets.set(t.id, { name: t.name, provider: t.provider, company: null, creds: null });
    const card = addTarget(t, i);
    card.open = !several || t.id === current;
    card.classList.toggle('current', several && t.id === current);
  });
  document.getElementById('page-hint').style.display = several ? 'block' : 'none';
  document.getElementById('targets-summary').style.display = several ? 'block' : 'none';
  document.getElementById('providers-link').style.display = (several && user.role === 'test_manager') ? 'block' : 'none';
  renderSummary();
  await Promise.all(list.map(t => loadTarget(document.getElementById('target-' + t.id))));
  if (several && current !== list[0].id) openTarget(current);
}

document.getElementById('targets-summary-rows').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-open]');
  if (!link) return;
  e.preventDefault();
  openTarget(link.dataset.open);
});

// Text typed in a section and not saved would be lost with the page (changing
// "Working on" reloads it): ask first.
window.addEventListener('beforeunload', (e) => {
  if (document.querySelector('details.target[data-unsaved="1"]')) e.preventDefault();
});

buildPage().catch((e) => { console.error(e); showMsg('The page could not be loaded: ' + (e?.message || e), false); });
