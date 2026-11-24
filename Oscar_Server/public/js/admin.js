/* global localTzRef, logout, oscarReportError, parseServerTs */  // nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of admin.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
const token = localStorage.getItem('oscar_token') || '';
if (!localStorage.getItem('oscar_user')) window.location.href = '/';

const isAdmin   = user.role === 'administrator';
const isCertif  = user.role === 'certification_user';
const isTestMgr = user.role === 'test_manager';

// Admins, auditors, and test managers reach this page. Test managers
// only see the "Users" tab and operate against /v1/company/users
// (scoped to their own company), not /v1/admin/users.
if (!isAdmin && !isCertif && !isTestMgr) {
  window.location.href = '/dashboard.html';
}


// Send Bearer header on every admin API call. The auth middleware accepts
// both httpOnly cookie AND Authorization: Bearer — the cookie is the prod
// path, this is the dev/HTTP fallback.
const authHeaders = { Authorization: 'Bearer ' + token };
let companies = [];       // excludes platform-root — used for Create User form
let allCompanies = [];    // full list including platform-root — used for user-table dropdowns
let userSearchTimer = null;

// Test managers use the company-scoped endpoint family. The two URL bases
// only differ in the prefix — the response shapes match — so we can flip
// between them with this single switch.
const USERS_API_BASE = isTestMgr ? '/v1/company/users' : '/v1/admin/users';

// Open the tab requested via ?tab= URL param (default: reports for auditors,
// users for admins, users for test managers — they have nothing else here)
const _initTab = new URLSearchParams(location.search).get('tab')
  || (isCertif ? 'reports' : 'users');
let currentTab = _initTab;

// logout() provided by nav.js

function showMsg(text, ok) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'msg-ok' : 'msg-err');
  el.style.display = 'block';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// Platform-wide emergency stop (administrator only). The /v1/runs/stop-all
// endpoint stops ALL companies' active runs when the caller is an administrator.
async function emergencyStopAllPlatform() {
  if (!confirm('🛑 PLATFORM-WIDE EMERGENCY STOP\n\nThis force-cancels EVERY running and queued scenario across ALL companies.\nRunning processes are killed immediately. This cannot be undone.\n\nProceed?')) return;
  const btn = document.getElementById('btn-emergency-stop-all');
  const out = document.getElementById('emergency-stop-result');
  btn.disabled = true;
  try {
    const res = await fetch('/v1/runs/stop-all', { method: 'POST', headers: authHeaders });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showMsg(`Emergency stop failed (${res.status}): ${data.detail || data.title || 'error'}`, false);
      return;
    }
    showMsg(`Platform stop complete — ${data.running_cancelled || 0} running killed, ${data.queued_cancelled || 0} queued cancelled.`, true);
    if (out) out.textContent = `Stopped ${data.stopped || 0} (running ${data.running_cancelled || 0}, queued ${data.queued_cancelled || 0}).`;
  } catch (e) {
    showMsg('Network error during emergency stop: ' + e.message, false);
  } finally {
    btn.disabled = false;
  }
}

// HTML-escape that's safe for BOTH text content and ALL attribute contexts.
// Previously escaped only & < >, which is enough for innerHTML text but lets
// values containing " or ' break out of an attribute. CodeQL flagged
// js/incomplete-html-attribute-sanitization on the new "Reset Link" button
// (and the same pattern was already present on neighbouring buttons —
// hardening esc() fixes them all in one place).
// S11: the one shared escaper (js/esc.js, loaded in <head> before this script).
const esc = window.esc;

function fmtDate(ts) {
  if (!ts) return '-';
  // v1.11.7 — parseServerTs (nav.js) handles SQLite's TZ-less UTC strings.
  return parseServerTs(ts).toLocaleString();
}

var TAB_TITLES = { users: 'Manage Users', companies: 'Manage Companies', reports: 'All Reports', activity: 'Server Activity', config: 'Server Config' };

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.getElementById('page-title').textContent = TAB_TITLES[name] || name;
  refreshCurrentTab();
}

function refreshCurrentTab() {
  if (currentTab === 'users') { loadUsers().catch(oscarReportError); loadAccessRequests().catch(oscarReportError); }
  if (currentTab === 'reports') loadReports().catch(oscarReportError);
  if (currentTab === 'activity') loadActivity().catch(oscarReportError);
  if (currentTab === 'companies') loadCompaniesPanel().catch(oscarReportError);
  if (currentTab === 'config') loadConfig().catch(oscarReportError);
}

function toggleNewCompanyField() {
  // Test managers always create users INSIDE their own company — the company
  // dropdown is meaningless for them and the new endpoint scopes server-side.
  if (isTestMgr) {
    document.getElementById('new-company-field').classList.add('hidden');
    return;
  }
  const role = document.getElementById('new-role').value;
  const needsCompany = role === 'company_user' || role === 'test_manager';
  document.getElementById('new-company-field').classList.toggle('hidden', !needsCompany);
}

async function loadCompanies() {
  const res = await fetch('/v1/admin/companies', { headers: authHeaders });
  const data = await res.json();
  allCompanies = data.companies || [];
  companies = allCompanies.filter(c => c.slug !== 'platform-root');

  const options = companies.map(c => `<option value="${c.id}">${esc(c.name)} (${esc(c.slug)})</option>`).join('');
  document.getElementById('new-company').innerHTML = options;
}

function companyOptions(selectedId) {
  const none = `<option value="" ${!selectedId ? 'selected' : ''}>\u2014 None \u2014</option>`;
  return none + allCompanies.map(c => `<option value="${c.id}" ${c.id===selectedId?'selected':''}>${esc(c.name)}</option>`).join('');
}

// Returns either an editable <select> (Tester or Certifier) or a read-only label (Administrator).
// For test managers the company is implicit (their own) — we render the company name as static text.
function companyCellHtml(u) {
  if (isTestMgr) {
    return `<span style="color:#78909c;font-size:12px;font-style:italic">${esc(u.company_name || '')}</span>`;
  }
  // Company-bound roles (Tester, Test Manager) and Certifier get an editable
  // company select so an admin can keep or change the company (issue #128).
  if (u.role === 'company_user' || u.role === 'certification_user' || u.role === 'test_manager') {
    return `<select id="company-${u.id}">${companyOptions(u.company_id)}</select>`;
  }
  return `<span style="color:#78909c;font-size:12px;font-style:italic">${esc(u.company_name || 'Platform')}</span>`;
}

// When the role dropdown changes, swap the company cell between editable and read-only
function onRoleChange(userId) {
  const roleEl = document.getElementById(`role-${userId}`);
  const role = roleEl.value;
  const cell = document.getElementById(`company-cell-${userId}`);
  if (!cell) return;
  // Test managers manage only their own company's users — no company reassignment.
  if (isTestMgr) return;
  if (role === 'company_user' || role === 'certification_user' || role === 'test_manager') {
    // Tester, Test Manager and Certifier are assigned to a company. Preserve the
    // user's current company across the role change (issue #128) — preselect it.
    const current = roleEl.dataset.companyId || '';
    // esc(userId) — userId originates from a data-* DOM attribute; escape it
    // before it reaches innerHTML (CodeQL js/xss-through-dom, defence-in-depth).
    cell.innerHTML = `<select id="company-${esc(userId)}">${companyOptions(current)}</select>`;
  } else {
    // Administrator always belongs to the platform
    cell.innerHTML = `<span style="color:#78909c;font-size:12px;font-style:italic">Platform</span>`;
  }
}

const ROLE_LABELS = { administrator: 'Administrator', certification_user: 'Certifier', test_manager: 'Test Manager', company_user: 'Tester' };

function roleOptions(selectedRole) {
  // Test managers may only assign roles within their own company — platform
  // roles (administrator, certification_user) are off-limits even via the
  // dropdown so the UI doesn't mislead them with options the server will reject.
  const roles = isTestMgr
    ? ['company_user', 'test_manager']
    : ['administrator', 'certification_user', 'test_manager', 'company_user'];
  return roles.map(r => `<option value="${r}" ${r===selectedRole?'selected':''}>${ROLE_LABELS[r] || r}</option>`).join('');
}

function debouncedLoadUsers() {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(loadUsers, 250);
}

// Set a password or hand over a reset link: platform accounts (administrators,
// certifiers) only. The server refuses both for a company account.
function platformPasswordButtons(u) {
  if (isTestMgr || u.role === 'company_user' || u.role === 'test_manager') return '';
  return `<button class="btn btn-small btn-secondary" data-action="reset-pwd" data-user-id="${u.id}" data-email="${esc(u.email)}">Reset PWD</button>
        <button class="btn btn-small btn-secondary" data-action="reset-link" data-user-id="${u.id}" data-email="${esc(u.email)}" title="Generate a self-service reset URL the user can click to set their own password — useful when SMTP is broken.">Reset Link</button>`;
}

async function loadUsers() {
  const q = encodeURIComponent(document.getElementById('user-search').value || '');
  const res = await fetch(`${USERS_API_BASE}?q=${q}`, { headers: authHeaders });
  const data = await res.json();
  const tbody = document.getElementById('users-tbody');

  tbody.innerHTML = (data.users || []).map(u => `
    <tr>
      <td class="mono">${esc(u.email)}</td>
      <td>${u.status === 'pending' ? '<span class="status-badge sb-pending">Pending</span>' : ''}${u.mfa_enabled ? ' <span class="status-badge sb-mfa" title="Two-factor authentication is on">2FA</span>' : ''}</td>
      <td><select id="role-${u.id}" data-action="role-change" data-user-id="${u.id}" data-company-id="${esc(u.company_id || '')}">${roleOptions(u.role)}</select></td>
      <td id="company-cell-${u.id}">${companyCellHtml(u)}</td>
      <td>${fmtDate(u.created_at)}</td>
      <td>
        ${u.status === 'pending' ? `<button class="btn btn-small btn-success" data-action="approve-user" data-user-id="${u.id}" data-email="${esc(u.email)}">Approve</button>` : ''}
        <button class="btn btn-small btn-secondary" data-action="save-user" data-user-id="${u.id}">Save</button>
        <button class="btn btn-small btn-secondary" data-action="send-reset" data-user-id="${u.id}" data-email="${esc(u.email)}">Send reset e-mail</button>
        ${platformPasswordButtons(u)}
        ${!isTestMgr && u.mfa_enabled ? `<button class="btn btn-small btn-secondary" data-action="reset-mfa" data-user-id="${u.id}" data-email="${esc(u.email)}" title="A lost phone: remove the account's second factor and sign it out everywhere">Reset 2FA</button>` : ''}
        <button class="btn btn-small btn-danger" data-action="delete-user" data-user-id="${u.id}" data-email="${esc(u.email)}">Delete</button>
      </td>
    </tr>
  `).join('');
}

// ── Access requests (decision 3) ─────────────────────────────────────────────
// The administrator places a request in a company (or refuses it); a Test
// Manager of that company confirms it as a tester or a Test Manager.
const ACCESS_API_BASE = isTestMgr ? '/v1/company/users/access-requests' : '/v1/admin/access-requests';

function accessActionsHtml(r) {
  const id = esc(r.id);
  if (isTestMgr) {
    return `<select id="access-role-${id}"><option value="company_user">Tester</option><option value="test_manager">Test Manager</option></select>
      <button class="btn btn-small btn-success" data-access-action="confirm" data-request-id="${id}">Confirm</button>
      <button class="btn btn-small btn-danger" data-access-action="refuse" data-request-id="${id}" data-email="${esc(r.email)}">Refuse</button>`;
  }
  if (r.state === 'unverified') {
    return `<button class="btn btn-small btn-danger" data-access-action="refuse" data-request-id="${id}" data-email="${esc(r.email)}">Refuse</button>`;
  }
  const options = companies.map(c => `<option value="${esc(c.id)}" ${c.id === r.company_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  return `<select id="access-company-${id}"><option value="">— Choose —</option>${options}</select>
    <button class="btn btn-small btn-success" data-access-action="assign" data-request-id="${id}">${r.state === 'assigned' ? 'Move' : 'Place'}</button>
    <button class="btn btn-small btn-danger" data-access-action="refuse" data-request-id="${id}" data-email="${esc(r.email)}">Refuse</button>`;
}

function accessCompanyHtml(r) {
  if (isTestMgr) return esc(r.company_name || '');
  if (r.state === 'unverified') return unconfirmedHtml(r.link_expires_at);
  return r.state === 'assigned'
    ? `${esc(r.company_name || '')} <span class="status-badge sb-pending">Waiting for its Test Manager</span>`
    : '<span class="status-badge sb-pending">To place</span>';
}

// A request whose address is not confirmed yet: the person has not clicked
// the link sent to it. It can only be refused.
function unconfirmedHtml(expiresAt) {
  const expired = expiresAt && parseServerTs(expiresAt).getTime() < Date.now();
  const detail = expired ? 'link expired' : `link valid until ${esc(fmtDate(expiresAt))}`;
  return `<span class="status-badge sb-CANCELLED">E-mail not confirmed yet</span> <span style="color:#90a4ae;font-size:12px">${detail}</span>`;
}

async function loadAccessRequests() {
  if (!isAdmin && !isTestMgr) return;
  const res = await fetch(ACCESS_API_BASE, { headers: authHeaders });
  if (!res.ok) return;
  const data = await res.json();
  const requests = data.requests || [];
  document.getElementById('access-card').classList.toggle('hidden', requests.length === 0);
  document.getElementById('access-help').textContent = isTestMgr
    ? 'People an OSCAR administrator placed in your company. Confirm them as a tester or a Test Manager; they then choose their own password.'
    : 'Place each confirmed request in a company: its Test Manager confirms it. A company with no Test Manager gets its first one from you. A request whose e-mail is not confirmed yet waits for its owner to click the link sent to it; it can only be refused.';
  document.getElementById('access-col').textContent = isTestMgr ? 'Placed in' : 'Company';
  document.getElementById('access-tbody').innerHTML = requests.map(r => `
    <tr${r.state === 'unverified' ? ' style="opacity:.6"' : ''}>
      <td>${esc(r.name || '')}</td>
      <td class="mono">${esc(r.email)}</td>
      <td>${esc(r.company_typed || '')}</td>
      <td>${accessCompanyHtml(r)}</td>
      <td>${accessActionsHtml(r)}</td>
    </tr>`).join('');
}

async function accessPost(path, body) {
  const res = await fetch(`${ACCESS_API_BASE}/${encodeURIComponent(path.id)}/${path.action}`, {
    method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  return { res, data: await res.json().catch(() => ({})) };
}

async function assignAccess(id) {
  const companyId = document.getElementById(`access-company-${id}`).value;
  if (!companyId) { showMsg('Choose the company first.', false); return; }
  let { res, data } = await accessPost({ id, action: 'assign' }, { company_id: companyId });
  if (res.status === 409 && data.needs_first_test_manager) {
    if (!confirm(`${data.detail}\n\nMake this person its first Test Manager?`)) return;
    ({ res, data } = await accessPost({ id, action: 'assign' }, { company_id: companyId, first_test_manager: true }));
  }
  if (!res.ok) { showMsg(data.detail || 'The request could not be placed.', false); return; }
  showMsg(data.activated ? 'First Test Manager created: they receive a link to choose their password.' : 'Placed: the company\'s Test Managers are told.', true);
  loadAccessRequests().catch(oscarReportError); loadUsers().catch(oscarReportError);
}

async function confirmAccess(id) {
  const role = document.getElementById(`access-role-${id}`).value;
  const { res, data } = await accessPost({ id, action: 'confirm' }, { role });
  if (!res.ok) { showMsg(data.detail || 'The request could not be confirmed.', false); return; }
  showMsg('Confirmed: they receive a link to choose their password.', true);
  loadAccessRequests().catch(oscarReportError); loadUsers().catch(oscarReportError);
}

async function refuseAccess(id, email) {
  if (!confirm(`Refuse the access request of ${email}?`)) return;
  const { res, data } = await accessPost({ id, action: 'refuse' });
  if (!res.ok) { showMsg(data.detail || 'The request could not be refused.', false); return; }
  showMsg('Refused: the person is told.', true);
  loadAccessRequests().catch(oscarReportError);
}

async function createUser() {
  const role = document.getElementById('new-role').value;
  const body = {
    email: document.getElementById('new-email').value.trim(),
    role
  };

  if (role === 'company_user' || role === 'test_manager') {
    body.company_id = document.getElementById('new-company').value;
  }

  const res = await fetch(USERS_API_BASE, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'The invitation failed.', false); return; }
  showMsg(data.placed ? data.detail : `Invited: ${data.user.email} receives a link to choose a password.`, true);
  document.getElementById('new-email').value = '';
  loadUsers().catch(oscarReportError);
  loadAccessRequests().catch(oscarReportError);
}

async function saveUser(userId) {
  const role = document.getElementById(`role-${userId}`).value;
  const companyEl = document.getElementById(`company-${userId}`);
  const companyId = companyEl ? companyEl.value : '';

  const body = { role };
  if (companyId) body.company_id = companyId;

  const res = await fetch(`${USERS_API_BASE}/${userId}`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'User update failed.', false); return; }
  const companyLabel = data.user && data.user.company_name ? ` (${data.user.company_name})` : '';
  showMsg(`User updated: ${data.user.email}${companyLabel}`, true);
  await loadCompanies();
  await loadUsers();
}

// A lost phone (#1414): the account's second factor goes and every session
// of the account ends; the owner is told by e-mail. An administrator sets up
// a new one at the next sign-in.
async function resetMfa(userId, email) {
  if (!confirm(`Reset the two-factor authentication of ${email}? The account is signed out everywhere; an administrator sets up a new factor at the next sign-in.`)) return;
  const res = await fetch(`/v1/admin/users/${userId}/mfa/reset`, { method: 'POST', headers: authHeaders });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showMsg(data.detail || data.title || 'The second factor was not reset.', false); return; }
  showMsg(`Two-factor authentication of ${email} reset. They were told by e-mail.`, true);
  loadUsers().catch(oscarReportError);
}

// A company account's password is its owner's (decision 3): they receive a
// link to choose a new one. Only platform accounts keep the two buttons below.
async function sendReset(userId, email) {
  if (!confirm(`Send ${email} an e-mail with a link to choose a new password?`)) return;
  const res = await fetch(`${USERS_API_BASE}/${userId}/send-reset`, { method: 'POST', headers: authHeaders });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { showMsg(data.detail || data.title || 'The e-mail could not be sent.', false); return; }
  showMsg(`Reset e-mail sent to ${email}.`, true);
}

async function resetPwd(userId, email) {
  const newPwd = prompt(`New password for ${email}:`);
  if (!newPwd) return;
  const res = await fetch(`${USERS_API_BASE}/${userId}/reset-password`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: newPwd })
  });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Password reset failed.', false); return; }
  showMsg(`Password reset for ${email}`, true);
}

// Admin-only "out-of-band" reset helper (issue #15 workaround when SMTP is
// broken). Generates the same single-use reset URL the user would normally
// receive by email and shows it in a dialog so the admin can copy + deliver
// it via Slack / Teams / in person.
async function generateResetLink(userId, email) {
  if (!confirm(
    `Generate a self-service password-reset link for ${email}?\n\n` +
    `The user can click it to set their own new password.\n` +
    `Single-use; expires in 24 hours. Any previously-issued reset link for this user is invalidated.`
  )) return;
  const res = await fetch(`/v1/admin/users/${userId}/generate-reset-link`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  const data = await res.json();
  if (!res.ok) {
    showMsg(data.detail || data.title || 'Failed to generate reset link.', false);
    return;
  }
  // Use prompt() so the URL is pre-selected and easy to copy. The dialog
  // also makes it harder to forget you generated one (vs. flashing a toast).
  prompt(
    `Reset link for ${email}\n` +
    `Expires: ${parseServerTs(data.expires_at).toLocaleString()}\n\n` +
    `Copy and send this URL out-of-band (Slack/Teams/in-person):`,
    data.resetUrl
  );
  showMsg(`Reset link generated for ${email}. Copy it from the dialog and share with the user.`, true);
}

async function approveUser(userId, email) {
  const res = await fetch(`${USERS_API_BASE}/${userId}/approve`, { method: 'POST', headers: authHeaders });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Approval failed.', false); return; }
  showMsg(`User approved: ${email}`, true);
  loadUsers().catch(oscarReportError);
}

async function deleteUser(userId, email) {
  if (!confirm(`Delete user ${email}?`)) return;
  const res = await fetch(`${USERS_API_BASE}/${userId}`, { method: 'DELETE', headers: authHeaders });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Delete failed.', false); return; }
  showMsg(`User deleted: ${email}`, true);
  loadUsers().catch(oscarReportError);
}

async function loadCompaniesPanel() {
  const res = await fetch('/v1/admin/companies', { headers: authHeaders });
  const data = await res.json();
  const tbody = document.getElementById('companies-tbody');
  tbody.innerHTML = (data.companies || []).map(c => `
    <tr>
      <td><input id="coname-${c.id}" value="${esc(c.name)}" style="width:100%;min-width:120px;border:1px solid #ddd;border-radius:4px;padding:4px 6px"></td>
      <td><input id="coslug-${c.id}" value="${esc(c.slug)}" class="mono" style="width:100%;min-width:120px;border:1px solid #ddd;border-radius:4px;padding:4px 6px"></td>
      <td>${c.user_count}</td>
      <td>${fmtDate(c.created_at)}</td>
      <td>
        <button class="btn btn-small btn-secondary" data-action="save-company" data-company-id="${c.id}">Save</button>
        <button class="btn btn-small btn-danger" data-action="delete-company" data-company-id="${c.id}" data-name="${esc(c.name)}">Delete</button>
      </td>
    </tr>
  `).join('');
  await loadCompanies();
  await loadAiRequests();
}

function aiDecidedCell(r) {
  if (!r.decidedAt) return '';
  const by = r.decidedBy ? ' · ' + esc(r.decidedBy) : '';
  return fmtDate(r.decidedAt) + by;
}

function aiRequestActions(r) {
  if (r.state === 'pending') {
    return `<button class="btn btn-small btn-primary" data-action="ai-decide" data-decision="approve" data-request-id="${esc(r.id)}">Approve</button>
      <button class="btn btn-small btn-danger" data-action="ai-decide" data-decision="refuse" data-request-id="${esc(r.id)}">Refuse</button>`;
  }
  if (r.state === 'approved') {
    return `<button class="btn btn-small btn-secondary" data-action="ai-decide" data-decision="revoke" data-request-id="${esc(r.id)}">Withdraw</button>`;
  }
  return '';
}

function aiRequestRow(r, textVersion) {
  const providerOf = r.company.providerOf ? ` <span style="color:#90a4ae">(provider of ${esc(r.company.providerOf)})</span>` : '';
  const oldText = r.state === 'approved' && r.textVersion !== textVersion ? ' <span style="color:#a85b00">(older text)</span>' : '';
  const reason = r.reason ? `<br><span style="font-size:11px;color:#78909c">${esc(r.reason)}</span>` : '';
  return `<tr>
      <td>${esc(r.company.name)}${providerOf}</td>
      <td>${esc(r.user.email)}</td>
      <td>${esc(r.state)}${oldText}${reason}</td>
      <td>v${esc(r.textVersion)} · ${fmtDate(r.acceptedAt)}</td>
      <td>${aiDecidedCell(r)}</td>
      <td>${aiRequestActions(r)}</td>
    </tr>`;
}

async function loadAiRequests() {
  const tbody = document.getElementById('ai-requests-tbody');
  const res = await fetch('/v1/admin/ai-access-requests', { headers: authHeaders });
  if (!res.ok) { tbody.innerHTML = '<tr><td colspan="6">Could not read the requests.</td></tr>'; return; }
  const data = await res.json();
  tbody.innerHTML = data.requests.length
    ? data.requests.map(r => aiRequestRow(r, data.textVersion)).join('')
    : '<tr><td colspan="6" style="color:#90a4ae">No request yet.</td></tr>';
}

async function decideAiRequest(id, decision) {
  let reason = '';
  if (decision !== 'approve') {
    reason = prompt(decision === 'refuse' ? 'Why is the request refused? The Test Manager reads this.' : 'Why is the access withdrawn? The Test Manager reads this.');
    if (reason === null) return;
  }
  const res = await fetch(`/v1/admin/ai-access-requests/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'The decision failed.', false); return; }
  showMsg(`Request ${data.state}.`, true);
  loadAiRequests().catch(oscarReportError);
}

function autoSlug() {
  const name = document.getElementById('new-co-name').value;
  const slug = name.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');   // one at most: the step above never leaves two together
  document.getElementById('new-co-slug').value = slug;
}

async function createCompany() {
  const name = document.getElementById('new-co-name').value.trim();
  const slug = document.getElementById('new-co-slug').value.trim();
  if (!name || !slug) { showMsg('Name and slug are required.', false); return; }
  const res = await fetch('/v1/admin/companies', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug })
  });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Company creation failed.', false); return; }
  showMsg(`Company created: ${data.company.name}`, true);
  document.getElementById('new-co-name').value = '';
  document.getElementById('new-co-slug').value = '';
  loadCompaniesPanel().catch(oscarReportError);
}

async function saveCompany(companyId) {
  const name = document.getElementById(`coname-${companyId}`).value.trim();
  const slug = document.getElementById(`coslug-${companyId}`).value.trim();
  const res = await fetch(`/v1/admin/companies/${companyId}`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug })
  });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Company update failed.', false); return; }
  showMsg(`Company updated: ${data.company.name}`, true);
  loadCompaniesPanel().catch(oscarReportError);
}

async function deleteCompany(companyId, name) {
  if (!confirm(`Delete company "${name}"?\nThis will fail if users are still assigned to it.`)) return;
  const res = await fetch(`/v1/admin/companies/${companyId}`, { method: 'DELETE', headers: authHeaders });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || data.title || 'Delete failed.', false); return; }
  showMsg(`Company deleted: ${name}`, true);
  loadCompaniesPanel().catch(oscarReportError);
}

// ── Reports tab state ─────────────────────────────────────────────────────────
let selectedPending = new Set();  // DELETION_REQUESTED run IDs
let selectedRuns    = new Set();  // all-runs table selection
let _allRunsCache   = [];         // every run fetched (after pagination)
let _comparisonsCache = [];       // last fetched comparisons (re-used on filter change)
const BULK_CHUNK_SIZE = 50;       // server-side limit per request

// Fetch the entire runs list by paginating through GET /v1/runs.
// The server caps each page at 200, so we loop until we have everything.
async function fetchAllRuns() {
  const PAGE = 200;
  let offset = 0;
  let total = Infinity;
  const all = [];
  while (offset < total) {
    const res = await fetch(`/v1/runs?limit=${PAGE}&offset=${offset}`, { headers: authHeaders });
    if (!res.ok) throw new Error(`GET /v1/runs failed (${res.status})`);
    const data = await res.json();
    total = data.total ?? data.runs?.length ?? 0;
    all.push(...(data.runs || []));
    if (!data.runs || data.runs.length === 0) break;  // safety
    offset += PAGE;
  }
  return all;
}

async function loadReports() {
  // Surface the v1.10.0 (issue #60) admin scope notice once per page load.
  // The first fetch returns a `notice` field whenever admin is hitting an
  // endpoint with restricted visibility — show it as a sticky banner above
  // the report list so the operator understands why the list is shorter.
  const firstPage = await fetch('/v1/runs?limit=1&offset=0', { headers: authHeaders }).then(r => r.json()).catch(() => ({}));
  if (firstPage.notice) {
    let banner = document.getElementById('admin-scope-notice');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'admin-scope-notice';
      banner.style.cssText = 'background:#fff3e0;border-left:4px solid #ff9800;padding:12px 16px;margin-bottom:14px;border-radius:4px;font-size:13px;color:#bf360c';
      const panel = document.getElementById('panel-reports');
      if (panel) panel.insertBefore(banner, panel.firstChild);
    }
    banner.textContent = '🔒 ' + firstPage.notice;
  }

  const [allRuns, cmpRes] = await Promise.all([
    fetchAllRuns(),
    fetch('/v1/reports/comparisons', { headers: authHeaders })
  ]);
  const cmpData  = await cmpRes.json();
  _allRunsCache = allRuns;
  _comparisonsCache = cmpData.comparisons || [];

  // ── Populate filter dropdowns from the full data set ──────────────────────
  const companies = [...new Set(allRuns.map(r => r.company_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const users     = [...new Set(allRuns.map(r => r.submitted_by).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const fc = document.getElementById('filter-company');
  const fu = document.getElementById('filter-user');
  const prevC = fc.value, prevU = fu.value;
  fc.innerHTML = '<option value="">— All companies —</option>' +
    companies.map(c => `<option value="${esc(c)}"${c===prevC?' selected':''}>${esc(c)}</option>`).join('');
  fu.innerHTML = '<option value="">— All users —</option>' +
    users.map(u => `<option value="${esc(u)}"${u===prevU?' selected':''}>${esc(u)}</option>`).join('');

  renderReportsTables();
}

// Re-render tables based on current filter state. Called by loadReports() and
// by filter dropdown 'change' events (no DB hit — uses _allRunsCache).
function renderReportsTables() {
  const allRuns = _allRunsCache;
  const fCompany = document.getElementById('filter-company').value;
  const fUser    = document.getElementById('filter-user').value;
  const fStatus  = document.getElementById('filter-status').value;

  const matchesFilter = r =>
    (!fCompany || r.company_name === fCompany) &&
    (!fUser    || r.submitted_by === fUser) &&
    (!fStatus  || r.status === fStatus);

  // ── Pending deletion section (also respects filters) ──────────────────────
  const pending = allRuns.filter(r => r.status === 'DELETION_REQUESTED' && matchesFilter(r));
  const pendingCard = document.getElementById('pending-del-card');
  pendingCard.style.display = pending.length > 0 ? 'block' : 'none';
  document.getElementById('pending-del-count').textContent = pending.length;

  document.getElementById('pending-del-tbody').innerHTML = pending.map(r => `
    <tr class="del-pending">
      <td><input type="checkbox" class="chk-pending" value="${r.id}" data-action="toggle-pending"></td>
      <td class="mono"><a href="/run-detail.html?id=${encodeURIComponent(r.id)}">${esc(r.id.slice(0,8))}</a></td>
      <td>${esc(r.company_name || '-')}</td>
      <td class="mono">${esc(r.submitted_by || '-')}</td>
      <td style="color:#e65100;font-size:11px">${esc(r.deleted_by || '-')}</td>
      <td>${fmtDate(r.queued_at)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-small btn-success" data-action="single-admin" data-admin-action="restore" data-run-id="${r.id}">↩ Restore</button>
        <button class="btn btn-small btn-danger"  data-action="single-admin" data-admin-action="confirm_delete" data-run-id="${r.id}">✓ Confirm Delete</button>
      </td>
    </tr>`).join('');

  // ── Main runs table (all non-DELETION_REQUESTED, filter-aware) ────────────
  const mainRuns = allRuns.filter(r => r.status !== 'DELETION_REQUESTED' && matchesFilter(r));

  // Update summary line on the card heading
  const totalAll = allRuns.filter(r => r.status !== 'DELETION_REQUESTED').length;
  const summary = document.getElementById('runs-summary');
  if (summary) {
    summary.textContent = (mainRuns.length === totalAll)
      ? `(${totalAll} total)`
      : `(showing ${mainRuns.length} of ${totalAll})`;
  }
  // Reset selection when filters change so we don't act on hidden rows
  selectedRuns.clear();
  const masterChk = document.getElementById('chk-all-runs');
  if (masterChk) masterChk.checked = false;
  updateRunsBar();

  document.getElementById('runs-tbody').innerHTML = mainRuns.map(r => {
    const isDel = r.status === 'DELETED_BY_ADMIN';
    const rowCls = isDel ? 'del-by-admin' : '';
    return `
    <tr class="${rowCls}">
      <td><input type="checkbox" class="chk-run" value="${r.id}" data-action="toggle-run"></td>
      <td class="mono"><a href="/run-detail.html?id=${encodeURIComponent(r.id)}">${esc(r.id.slice(0,8))}</a></td>
      <td>${esc(r.company_name || '-')}</td>
      <td><span class="status-badge sb-${esc(r.status)}">${esc(r.status)}</span>
        ${isDel ? `<span style="font-size:10px;color:#c62828;margin-left:4px">by ${esc(r.deleted_by||'admin')}</span>` : ''}
      </td>
      <td class="mono">${esc(r.submitted_by || '-')}</td>
      <td>${fmtDate(r.queued_at)}</td>
      <td style="white-space:nowrap">
        ${isDel
          ? `<button class="btn btn-small btn-secondary" data-action="single-admin" data-admin-action="restore" data-run-id="${r.id}">↩ Restore</button>
             <button class="btn btn-small btn-danger"    data-action="single-admin" data-admin-action="purge" data-run-id="${r.id}">⚠ Purge</button>`
          : `<button class="btn btn-small" style="background:#e65100;color:#fff;font-size:11px;padding:4px 8px"
               data-action="single-admin" data-admin-action="soft_delete" data-run-id="${r.id}">🏷 Flag Delete</button>
             <button class="btn btn-small btn-danger" data-action="single-admin" data-admin-action="purge" data-run-id="${r.id}">⚠ Purge</button>`
        }
      </td>
    </tr>`;
  }).join('');

  // ── Comparisons ───────────────────────────────────────────────────────────
  document.getElementById('comparisons-tbody').innerHTML = _comparisonsCache.map(c => `
    <tr>
      <td class="mono">${esc((c.id || '').slice(0,8))}</td>
      <td>${esc(c.company_name || '-')}</td>
      <td class="mono">${esc((c.run_a_id || '').slice(0,8))}</td>
      <td class="mono">${esc((c.run_b_id || '').slice(0,8))}</td>
      <td>${fmtDate(c.created_at)}</td>
    </tr>`).join('');
}

// ── Checkbox helpers ──────────────────────────────────────────────────────────
function toggleAllPending(master) {
  document.querySelectorAll('.chk-pending').forEach(cb => {
    cb.checked = master.checked;
    if (master.checked) selectedPending.add(cb.value);
    else                selectedPending.delete(cb.value);
  });
  updatePendingBar();
}
function togglePendingRow(cb) {
  if (cb.checked) selectedPending.add(cb.value);
  else            selectedPending.delete(cb.value);
  updatePendingBar();
}
function updatePendingBar() {
  const bar = document.getElementById('pending-del-bar');
  const lbl = document.getElementById('pending-del-bar-label');
  bar.style.display = selectedPending.size > 0 ? 'flex' : 'none';
  lbl.textContent = `${selectedPending.size} run(s) selected`;
}

function toggleAllRuns(master) {
  // Select/deselect ALL filtered rows (the full filtered set, not just the
  // visible DOM page). This makes "select all" actually mean all rows the
  // user is currently looking at after filters are applied.
  selectedRuns.clear();
  if (master.checked) {
    document.querySelectorAll('.chk-run').forEach(cb => {
      cb.checked = true;
      selectedRuns.add(cb.value);
    });
  } else {
    document.querySelectorAll('.chk-run').forEach(cb => { cb.checked = false; });
  }
  updateRunsBar();
}
function toggleRunRow(cb) {
  if (cb.checked) selectedRuns.add(cb.value);
  else            selectedRuns.delete(cb.value);
  updateRunsBar();
}
function updateRunsBar() {
  const bar = document.getElementById('runs-action-bar');
  const lbl = document.getElementById('runs-bar-label');
  bar.style.display = selectedRuns.size > 0 ? 'flex' : 'none';
  lbl.textContent = `${selectedRuns.size} run(s) selected`;
}

// ── Admin action helpers ──────────────────────────────────────────────────────
const ACTION_LABELS = {
  soft_delete:     'flag selected runs for deletion',
  confirm_delete:  'PERMANENTLY delete the selected deletion requests',
  purge:           'PERMANENTLY delete the selected runs (this cannot be undone)',
  restore:         'restore the selected runs'
};

async function singleAdminAction(action, runId) {
  const label = ACTION_LABELS[action] || action;
  if (!confirm(`Are you sure you want to ${label}?\n\nRun: ${runId.slice(0,8)}`)) return;
  await callBulkAdminAction(action, [runId]);
}

async function bulkAdminAction(action, source) {
  const ids = [...(source === 'pending' ? selectedPending : selectedRuns)];
  if (ids.length === 0) { showMsg('No runs selected.', false); return; }
  const label = ACTION_LABELS[action] || action;
  if (!confirm(`Are you sure you want to ${label}?\n\n${ids.length} run(s) selected.`)) return;
  await callBulkAdminAction(action, ids);
  if (source === 'pending') { selectedPending.clear(); }
  else                      { selectedRuns.clear(); }
}

async function callBulkAdminAction(action, run_ids) {
  // Server caps each request at 50 IDs (BULK_CHUNK_SIZE). For larger
  // selections we transparently chunk and aggregate the results.
  const chunks = [];
  for (let i = 0; i < run_ids.length; i += BULK_CHUNK_SIZE) {
    chunks.push(run_ids.slice(i, i + BULK_CHUNK_SIZE));
  }

  let doneCount = 0;
  let skipCount = 0;
  let notFound  = 0;
  let firstError = null;

  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) {
      showMsg(`Processing batch ${i + 1} of ${chunks.length} (${chunks[i].length} runs)…`, true);
    }
    const res = await fetch('/v1/runs/bulk-admin-action', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, run_ids: chunks[i] })
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json();
    if (!res.ok) {
      firstError = data.detail || data.title || `HTTP ${res.status}`;
      break;
    }
    doneCount += (data.processed || []).length;
    skipCount += (data.skipped   || []).length;
    notFound  += (data.not_found || []).length;
  }

  if (firstError) {
    showMsg(`Action partially failed: ${firstError} (processed ${doneCount} before stopping)`, false);
  } else {
    let msg = `${doneCount} run(s) updated (action: ${action}).`;
    if (skipCount) msg += ` ${skipCount} skipped.`;
    if (notFound)  msg += ` ${notFound} not found.`;
    if (chunks.length > 1) msg += ` [${chunks.length} batches]`;
    showMsg(msg, true);
  }
  loadReports().catch(oscarReportError);
}

// #1017: one row per user and company or provider, with runs going and waiting.
function runsInProgressRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '<tr><td colspan="4" style="color:#90a4ae;padding:12px">No run in progress.</td></tr>';
  }
  return rows.map(function (x) {
    var where = x.distributor ? esc(x.company) + ' <span style="color:#90a4ae">(' + esc(x.distributor) + ')</span>' : esc(x.company);
    return '<tr><td class="mono">' + esc(x.email) + '</td><td>' + where + '</td><td>' + (Number(x.running) || 0) + '</td><td>' + (Number(x.queued) || 0) + '</td></tr>';
  }).join('');
}

async function loadActivity(date) {
  let url = '/v1/admin/activity';
  if (date) {
    // Convert the picked LOCAL day to a UTC [start, start+24h) range so the
    // filter matches the local times shown in the table.
    const startLocal = new Date(date + 'T00:00:00');               // local midnight
    const endLocal   = new Date(startLocal.getTime() + 86400000);  // +24h
    const toSql = d => d.toISOString().slice(0, 19).replace('T', ' ');  // UTC "YYYY-MM-DD HH:MM:SS"
    url += '?from=' + encodeURIComponent(toSql(startLocal)) + '&to=' + encodeURIComponent(toSql(endLocal));
  }
  const res = await fetch(url, { headers: authHeaders });
  const data = await res.json();

  document.getElementById('activity-kpis').innerHTML = `
    <div class="kpi"><div class="n">${data.totals.users}</div><div class="l">Users</div></div>
    <div class="kpi"><div class="n">${data.totals.companies}</div><div class="l">Companies</div></div>
    <div class="kpi"><div class="n">${data.totals.runs}</div><div class="l">Total Runs</div></div>
    <div class="kpi"><div class="n">${data.runs_last_24h}</div><div class="l">Runs (24h)</div></div>
    <div class="kpi"><div class="n">${data.logins_last_24h}</div><div class="l">Logins (24h)</div></div>
    <div class="kpi"><div class="n">${data.failed_logins_last_24h}</div><div class="l">Failed Logins (24h)</div></div>
  `;

  document.getElementById('runs-in-progress-tbody').innerHTML = runsInProgressRows(data.runs_in_progress);

  document.getElementById('submitters-tbody').innerHTML = (data.top_submitters_last_7d || []).map(x => `
    <tr><td class="mono">${esc(x.email)}</td><td>${x.runs}</td></tr>
  `).join('');

  document.getElementById('auth-events-tbody').innerHTML = (data.latest_auth_events || []).map(e => `
    <tr>
      <td>${fmtDate(e.created_at)}</td>
      <td>${esc(e.event_type)}</td>
      <td class="mono">${esc(e.email || '-')}</td>
      <td class="mono">${esc(e.ip || '-')}</td>
      <td>${esc((e.user_agent || '-').slice(0,80))}</td>
    </tr>
  `).join('') || `<tr><td colspan="5" style="color:#90a4ae;padding:12px">No login events for this day.</td></tr>`;

  // Reflect what the events list is showing (the picked LOCAL day), and keep the
  // date picker in sync. Times in the table are already rendered in local time
  // via fmtDate()/parseServerTs().
  const evCount = (data.latest_auth_events || []).length;
  const lbl = document.getElementById('activity-date-label');
  if (lbl) lbl.textContent = (date
    ? evCount + ' event(s) on ' + date
    : 'Showing the latest ' + evCount + ' events')
    + ' — times in ' + localTzRef();
  const dEl = document.getElementById('activity-date');
  if (dEl) {
    if (!dEl.max) {
      const now = new Date();   // clamp to LOCAL today (no future days)
      dEl.max = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    }
    dEl.value = date || '';
  }
}

// ── Static element event listeners ───────────────────────────────────────────
document.getElementById('btn-refresh').addEventListener('click', refreshCurrentTab);
// Server Activity — jump to a specific day, or back to the latest events.
(function () {
  var dateEl = document.getElementById('activity-date');
  if (dateEl) dateEl.addEventListener('change', function () { loadActivity(this.value || null).catch(oscarReportError); });
  var latestEl = document.getElementById('btn-activity-latest');
  if (latestEl) latestEl.addEventListener('click', function () {
    var d = document.getElementById('activity-date'); if (d) d.value = '';
    loadActivity(null).catch(oscarReportError);
  });
})();
document.getElementById('new-role').addEventListener('change', toggleNewCompanyField);
document.getElementById('btn-create-user').addEventListener('click', createUser);
document.getElementById('user-search').addEventListener('input', debouncedLoadUsers);
document.getElementById('new-co-name').addEventListener('input', autoSlug);
document.getElementById('btn-create-company').addEventListener('click', createCompany);
document.getElementById('btn-bulk-restore-pending').addEventListener('click', function() { bulkAdminAction('restore','pending').catch(oscarReportError); });
document.getElementById('btn-bulk-confirm-pending').addEventListener('click', function() { bulkAdminAction('confirm_delete','pending').catch(oscarReportError); });
document.getElementById('chk-all-pending').addEventListener('change', function() { toggleAllPending(this); });
document.getElementById('btn-bulk-restore-runs').addEventListener('click', function() { bulkAdminAction('restore','runs').catch(oscarReportError); });
document.getElementById('btn-bulk-softdel-runs').addEventListener('click', function() { bulkAdminAction('soft_delete','runs').catch(oscarReportError); });
document.getElementById('btn-bulk-purge-runs').addEventListener('click', function() { bulkAdminAction('purge','runs').catch(oscarReportError); });
document.getElementById('chk-all-runs').addEventListener('change', function() { toggleAllRuns(this); });

// Filter dropdowns — re-render from cache without re-fetching
['filter-company', 'filter-user', 'filter-status'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', function() { renderReportsTables(); });
});
const clearBtn = document.getElementById('btn-clear-filters');
if (clearBtn) clearBtn.addEventListener('click', function() {
  document.getElementById('filter-company').value = '';
  document.getElementById('filter-user').value    = '';
  document.getElementById('filter-status').value  = '';
  renderReportsTables();
});

// ── Event delegation for dynamically generated elements ──────────────────────

// Access requests (click)
document.getElementById('access-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-access-action]');
  if (!el) return;
  var id = el.dataset.requestId;
  var action = el.dataset.accessAction;
  var done;
  if (action === 'assign') done = assignAccess(id);
  else if (action === 'confirm') done = confirmAccess(id);
  else if (action === 'refuse') done = refuseAccess(id, el.dataset.email);
  if (done !== undefined) done.catch(function(err) { console.error('Access request action failed:', err); showMsg('Server unreachable.', false); });
});

// Users table delegation (click + change)
document.getElementById('users-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  var userId = el.dataset.userId;
  if (action === 'save-user') saveUser(userId).catch(oscarReportError);
  else if (action === 'approve-user') approveUser(userId, el.dataset.email).catch(oscarReportError);
  else if (action === 'send-reset') sendReset(userId, el.dataset.email).catch(oscarReportError);
  else if (action === 'reset-pwd') resetPwd(userId, el.dataset.email).catch(oscarReportError);
  else if (action === 'reset-link') generateResetLink(userId, el.dataset.email).catch(oscarReportError);
  else if (action === 'reset-mfa') resetMfa(userId, el.dataset.email).catch(oscarReportError);
  else if (action === 'delete-user') deleteUser(userId, el.dataset.email).catch(oscarReportError);
});
document.getElementById('users-tbody').addEventListener('change', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'role-change') onRoleChange(el.dataset.userId);
});

// Companies table delegation
document.getElementById('companies-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  var companyId = el.dataset.companyId;
  if (action === 'save-company') saveCompany(companyId).catch(oscarReportError);
  else if (action === 'delete-company') deleteCompany(companyId, el.dataset.name).catch(oscarReportError);
});

// #801: AI analysis requests
document.getElementById('ai-requests-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action="ai-decide"]');
  if (el) decideAiRequest(el.dataset.requestId, el.dataset.decision).catch(oscarReportError);
});

// Pending deletion table delegation (click + change)
document.getElementById('pending-del-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'single-admin') {
    singleAdminAction(el.dataset.adminAction, el.dataset.runId).catch(oscarReportError);
  }
});
document.getElementById('pending-del-tbody').addEventListener('change', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-pending') togglePendingRow(el);
});

// Runs table delegation (click + change)
document.getElementById('runs-tbody').addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'single-admin') {
    singleAdminAction(el.dataset.adminAction, el.dataset.runId).catch(oscarReportError);
  }
});
document.getElementById('runs-tbody').addEventListener('change', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'toggle-run') toggleRunRow(el);
});

// ── Server Config ────────────────────────────────────────────────────────────
let _configCache = null;

const CONFIG_LABELS = {
  MAX_CONCURRENT_RUNS: 'Max Concurrent Runs',
  PARALLEL_STAGGER_MS: 'Batch Stagger Delay (ms)',
  RUN_TIMEOUT_MS:      'Run Timeout (ms)',
  RUN_HARD_MAX_TIMEOUT_MS: 'Run Budget Ceiling (ms)',
  RUN_IDLE_TIMEOUT_MS: 'Silent Run Limit (ms)',
  RUN_FIRST_LINE_TIMEOUT_MS: 'Run Pod First Line Limit (ms)',
  MAX_WAITING_RUNS_PER_ACCOUNT: 'Max Waiting Runs per Account',
  LOG_LEVEL:           'Log Level',
  SMTP_HOST:   'SMTP Host',
  SMTP_PORT:   'SMTP Port',
  SMTP_SECURE: 'SMTP Secure (TLS)',
  SMTP_USER:   'SMTP Login',
  SMTP_PASS:   'SMTP Password',
  SMTP_FROM:   'Display "From" Address',
  ALERT_RECIPIENTS:      'Alert Recipients',
  ALERT_REPEAT_CRITICAL: 'Re-page Critical Every',
  ALERT_REPEAT_WARNING:  'Re-page Warning Every',
};

// The <input> type of a Server Config value.
function configInputType(isSensitive, isNum) {
  if (isSensitive) return 'password';
  return isNum ? 'number' : 'text';
}

// What an empty Server Config field shows (#1338). A number with a default
// shows it: saving the field empty keeps that default. The description is
// beside the field already.
function configPlaceholder(cfg) {
  if (cfg.type === 'number' && cfg.default != null) return `Empty = default (${cfg.default})`;
  return cfg.description || '';
}

// How Alertmanager gets the SMTP and Alerting values (#1175): 'file' on the
// VPS (the Apply button writes its file), 'kubernetes' on a cluster, where
// the administrator makes its Secret with the commands the server gives.
let _alertingMode = 'file';

// The SMTP section's note on Alertmanager.
function smtpAlertingNote(mode) {
  const how = mode === 'kubernetes'
    ? 'once given to Alertmanager with the commands of the Alerting section below'
    : 'after you click "Apply" in the Alerting section below';
  return '💡 <strong>One mail server for everything.</strong> It sends OSCAR\'s own e-mails (invitations, password resets) and Alertmanager\'s alerts to administrators (' + how + ').';
}

// A bootstrap token left in the server's environment (#1365,
// server_info.bootstrap_token_set). The administrator reading this exists, so
// the token creates no account any more: the note says how to remove it.
function bootstrapTokenNote(set) {
  if (set !== true) return '';
  return '<div class="kpi" style="grid-column:1/-1;text-align:left;font-size:12px;padding:10px 14px;color:#7c5800;background:#fff8e1;border-left:3px solid #f9a825">' +
    '⚠️ <strong>The bootstrap token is still set in the server\'s environment.</strong> It was there to create the first administrator and creates no account any more. ' +
    'Remove it: empty <code>PLATFORM_BOOTSTRAP_TOKEN</code> in the server\'s environment (the <code>.env</code> file on a Docker host; the Secret on Kubernetes), then create the server again (<code>docker compose up -d oscar</code>; on Kubernetes, restart it).' +
    '</div>';
}

// ALLOW_PRIVATE_TARGETS is on (#1371, server_info.private_targets_allowed): the
// policy that keeps OSCAR's outbound calls on public https addresses is off.
function privateTargetsNote(set) {
  if (set !== true) return '';
  return '<div class="kpi" style="grid-column:1/-1;text-align:left;font-size:12px;padding:10px 14px;color:#7c5800;background:#fff8e1;border-left:3px solid #f9a825">' +
    '⚠️ <strong>Private targets are allowed.</strong> <code>ALLOW_PRIVATE_TARGETS</code> is set in the server\'s environment: OSCAR\'s outbound calls (a provider\'s endpoint and token URL, an AI service, the simulator\'s administration) are not kept to public https addresses. ' +
    'It is meant for a development PC or for providers on a private network. Otherwise remove it from the server\'s environment and create the server again.' +
    '</div>';
}

// The id of a Server Config field. A setting the page only shows (#1363: the
// mail server's) gets another id than the fields saveConfig() collects.
function configFieldId(key, cfg) {
  return (cfg && cfg.read_only ? 'cfg-shown-' : 'cfg-') + key;
}

// Where the mail settings come from and how they are changed (#1363). They
// are the server's environment's: the page shows them and saves none.
// `source` is server_info.mail_source; `replaced` server_info.mail_replaced,
// the names of the settings saved earlier that the environment's differ from.
function mailSettingsNote(source, replaced) {
  const change = 'in the server\'s environment (the <code>.env</code> file on a Docker host; the settings and the Secret on Kubernetes), then create the server again (<code>docker compose up -d oscar</code>; on Kubernetes, apply and restart it)';
  if (source === 'environment') {
    const names = (Array.isArray(replaced) ? replaced : []).filter(name => /^[A-Z_]{1,30}$/.test(name));
    const html = '📌 <strong>Set in the server\'s environment.</strong> These settings are shown here, not changed here. To change them, edit them ' + change + '. Then send a test e-mail below.';
    if (names.length === 0) return { warn: false, html: html };
    return { warn: true, html: html + ' <strong>Check them:</strong> the settings saved from this page earlier are no longer read, and held another value for ' + names.join(', ') + '. If the environment still holds an older mail server, e-mails fail until it is corrected there.' };
  }
  if (source === 'stored') {
    return { warn: true, html: '⚠️ <strong>Saved from this page by an earlier version.</strong> These settings are still in use and can no longer be changed here. To change them, set <code>SMTP_HOST</code> and the other <code>SMTP_*</code> values ' + change + '. From then on the environment\'s values are the ones used, and the ones kept here are no longer read.' };
  }
  return { warn: true, html: '⚠️ <strong>No mail server is set.</strong> OSCAR sends no e-mail: no invitation, no password reset, no alert. Set <code>SMTP_HOST</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code> and <code>SMTP_FROM</code> ' + change + '.' };
}

// The server's hints on the sender address (server_info.mail_warnings), as text.
function mailWarningsHtml(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return '<div style="font-size:12px;color:#7c5800;margin-bottom:14px;padding:10px 14px;background:#fff8e1;border-left:3px solid #f9a825;border-radius:4px">' +
    warnings.map(w => '<div>' + esc(w) + '</div>').join('') + '</div>';
}

// The Alerting section's opening line and its end: the Apply button, or on
// Kubernetes the commands (escaped: they are shown, never run here).
function alertingParts(mode, commands) {
  if (mode === 'kubernetes') {
    return {
      intro: 'Saving these values does NOT push them to Alertmanager. On Kubernetes OSCAR does not write its configuration: it has no right on the cluster, on purpose.',
      end: '<div style="font-size:12px;color:#546e7a;margin:14px 0 6px">After saving, give these values (and the SMTP ones) to Alertmanager on the machine, as root: the same lines the first time and after every change. Alertmanager reads them again within a minute. Guide <em>OSCAR - k3s on one VPS</em>, section 8a, step 1.</div>' +
        '<pre id="alertmanager-commands" style="margin:0 0 14px;padding:12px;border-radius:6px;background:#eceff1;color:#263238;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere">' + esc(commands || '') + '</pre>'
    };
  }
  return {
    intro: 'Saving these values does NOT automatically push them to Alertmanager — that requires writing the YAML and reloading. Use the button below after editing.',
    end: '<div style="margin:14px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" id="btn-apply-alertmanager" style="background:#bf360c">⚡ Apply alerting config to Alertmanager</button>' +
      '<span style="font-size:12px;color:#78909c">Templates <code>alertmanager.yml</code> from these values, writes it to the shared volume, hot-reloads Alertmanager. No SSH, no VPS edits.</span>' +
      '</div>' +
      '<pre id="apply-alertmanager-result" style="margin-top:6px;padding:12px;border-radius:6px;font-family:Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;display:none"></pre>'
  };
}

// What a successful save says about Alertmanager.
function savedConfigMessage(mode) {
  const next = mode === 'kubernetes'
    ? 'For Alerting changes, run the commands of the Alerting section on the machine.'
    : 'For Alerting changes, click "Apply alerting config" below.';
  return 'Configuration saved — changes take effect immediately. (' + next + ')';
}

async function loadConfig() {
  const res = await fetch('/v1/admin/config', { headers: authHeaders });
  if (!res.ok) { showMsg('Failed to load config', false); return; }
  const data = await res.json();
  _configCache = data.config;

  // Server info cards
  const si = data.server_info;
  _alertingMode = si.alerting_mode === 'kubernetes' ? 'kubernetes' : 'file';
  document.getElementById('server-info-grid').innerHTML = [
    { n: si.version, l: 'Version' },
    { n: si.node_version, l: 'Node.js' },
    { n: si.platform, l: 'Platform' },
    { n: formatUptime(si.uptime_seconds), l: 'Uptime' },
  ].map(k => `<div class="kpi"><div class="n" style="font-size:18px">${esc(k.n)}</div><div class="l">${k.l}</div></div>`).join('')
    + `<div class="kpi" style="grid-column:1/-1;text-align:left;font-size:12px;padding:10px 14px">
         <div style="margin-bottom:4px"><strong style="color:#546e7a">Collection:</strong> <span class="mono">${esc(si.collection_path)}</span></div>
         <div><strong style="color:#546e7a">Bruno CLI:</strong> <span class="mono">${esc(si.bru_cmd)}</span></div>
       </div>`
    + bootstrapTokenNote(si.bootstrap_token_set)
    + privateTargetsNote(si.private_targets_allowed);

  // Config form — group by category
  const smtpKeys     = Object.entries(data.config).filter(([_, cfg]) => cfg.group === 'smtp');
  const loggingKeys  = Object.entries(data.config).filter(([_, cfg]) => cfg.group === 'logging');
  const alertingKeys = Object.entries(data.config).filter(([_, cfg]) => cfg.group === 'alerting');
  const runnerKeys   = Object.entries(data.config).filter(([_, cfg]) => !cfg.group);

  function configRow([key, cfg]) {
    const isNum = cfg.type === 'number';
    const isEnum = cfg.type === 'enum';
    const isSensitive = cfg.sensitive;
    const rangeHint = isNum && cfg.min != null ? `(${cfg.min} – ${cfg.max})` : '';
    const fieldId = configFieldId(key, cfg);

    let control;
    if (cfg.read_only) {
      // Shown, never sent back (#1363). A sensitive value arrives masked.
      control = `<input id="${fieldId}" type="text" readonly value="${esc(cfg.value || '')}" style="font-size:14px;font-weight:600;background:#f5f7f8;color:#546e7a" placeholder="not set">`;
    } else if (isEnum) {
      const opts = (cfg.options || []).map(o =>
        `<option value="${esc(o)}"${o === cfg.value ? ' selected' : ''}>${esc(o)}</option>`
      ).join('');
      control = `<select id="${fieldId}" style="font-size:14px;font-weight:600;padding:9px 10px;border:1px solid #cfd8dc;border-radius:6px;width:100%">${opts}</select>`;
    } else {
      const inputType = configInputType(isSensitive, isNum);
      const attrs = isNum ? `min="${cfg.min}" max="${cfg.max}"` : '';
      control = `<input id="${fieldId}" type="${inputType}" ${attrs} value="${esc(cfg.value || '')}" style="font-size:14px;font-weight:600" placeholder="${esc(configPlaceholder(cfg))}">`;
    }

    return `
    <div class="row" style="margin-bottom:12px;align-items:start">
      <div class="field" style="max-width:320px">
        <label for="${fieldId}">${esc(CONFIG_LABELS[key] || key)}</label>
        ${control}
      </div>
      <div style="flex:1;font-size:12px;color:#78909c;padding-top:22px">
        ${esc(cfg.description)} ${rangeHint ? `<span style="color:#b0bec5">${rangeHint}</span>` : ''}
      </div>
    </div>`;
  }

  let html = '<div style="font-size:13px;font-weight:700;color:#546e7a;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px">Runner Settings</div>';
  html += runnerKeys.map(configRow).join('');
  if (loggingKeys.length) {
    html += '<div style="font-size:13px;font-weight:700;color:#6a1b9a;text-transform:uppercase;letter-spacing:.4px;margin:20px 0 10px;padding-top:14px;border-top:1px solid #eceff1">Logging</div>';
    html += loggingKeys.map(configRow).join('');
  }
  html += '<div style="font-size:13px;font-weight:700;color:#0090D4;text-transform:uppercase;letter-spacing:.4px;margin:20px 0 10px;padding-top:14px;border-top:1px solid #eceff1">SMTP / Email Settings</div>';
  const mailNote = mailSettingsNote(si.mail_source, si.mail_replaced);
  html += '<div style="font-size:12px;color:' + (mailNote.warn ? '#7c5800' : '#546e7a') + ';margin-bottom:10px;padding:10px 14px;background:' + (mailNote.warn ? '#fff8e1' : '#f5fcff') + ';border-left:3px solid ' + (mailNote.warn ? '#f9a825' : '#0090D4') + ';border-radius:4px">' +
    mailNote.html + '</div>';
  html += '<div style="font-size:12px;color:#78909c;margin-bottom:14px;padding:10px 14px;background:#f5fcff;border-left:3px solid #0090D4;border-radius:4px">' +
    smtpAlertingNote(_alertingMode) + '</div>';
  html += mailWarningsHtml(si.mail_warnings);
  html += smtpKeys.map(configRow).join('');
  if (alertingKeys.length) {
    const alerting = alertingParts(_alertingMode, si.alerting_commands);
    html += '<div style="font-size:13px;font-weight:700;color:#bf360c;text-transform:uppercase;letter-spacing:.4px;margin:20px 0 10px;padding-top:14px;border-top:1px solid #eceff1">🔔 Alerting</div>';
    html += '<div style="font-size:12px;color:#78909c;margin-bottom:14px">' + alerting.intro + '</div>';
    html += alertingKeys.map(configRow).join('');
    html += alerting.end;
  }
  document.getElementById('config-form').innerHTML = html;

  // Wire the alertmanager apply button (re-bound on every loadConfig because
  // the button is re-rendered into the DOM each time)
  const amBtn = document.getElementById('btn-apply-alertmanager');
  if (amBtn) amBtn.addEventListener('click', applyAlertmanagerConfig);
}

async function applyAlertmanagerConfig() {
  const out = document.getElementById('apply-alertmanager-result');
  const btn = document.getElementById('btn-apply-alertmanager');
  if (!out || !btn) return;
  out.style.display = 'block';
  out.style.background = '#fff8e1';
  out.style.color = '#7c5800';
  out.textContent = '⏳ Templating alertmanager.yml + reloading…';
  btn.disabled = true;
  try {
    const r = await fetch('/v1/admin/alertmanager/apply', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' }
    });
    const data = await r.json();
    if (data.ok) {
      out.style.background = '#e8f5e9';
      out.style.color = '#2e7d32';
      out.textContent = `✅ Alertmanager reloaded successfully.

  Config written to:  ${data.configPath}
  Reload endpoint:    ${data.reloadUrl}
  Reload status:      ${data.reloadStatus}

The new config is live. Trigger a synthetic alert to verify end-to-end:
  curl -XPOST http://127.0.0.1:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{"labels":{"alertname":"TestAlert","severity":"critical"},"annotations":{"summary":"Test"}}]'`;
    } else {
      out.style.background = '#ffebee';
      out.style.color = '#c62828';
      out.textContent = `❌ Apply failed.

  Error: ${data.error || 'Unknown error'}

  Config written:    ${data.written ? 'yes' : 'no'}
  Reload attempted:  ${data.reloaded ? 'yes' : 'no'}
  Reload status:     ${data.reloadStatus || 'n/a'}
  Reload body:       ${data.reloadBody || 'n/a'}

Common causes:
  • SMTP_HOST (set in the server's environment) or ALERT_RECIPIENTS (above) empty
  • alertmanager-config volume not mounted into the OSCAR container (operator action — see Admin Guide § 14)
  • Alertmanager container not running or unreachable on http://alertmanager:9093`;
    }
  } catch (err) {
    out.style.background = '#ffebee';
    out.style.color = '#c62828';
    out.textContent = `❌ Network error talking to /v1/admin/alertmanager/apply: ${err.message || err}`;
  } finally {
    btn.disabled = false;
  }
}

async function saveConfig() {
  if (!_configCache) return;
  const payload = {};
  for (const key of Object.keys(_configCache)) {
    // A setting the page only shows is not sent back (#1363).
    if (_configCache[key] && _configCache[key].read_only) continue;
    const el = document.getElementById('cfg-' + key);
    if (el) payload[key] = el.value;
  }
  const res = await fetch('/v1/admin/config', {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) { showMsg(data.detail || 'Failed to save config', false); return; }
  if (data.errors && data.errors.length > 0) {
    showMsg('Saved with errors: ' + data.errors.join('; '), false);
  } else if (data.warnings && data.warnings.length > 0) {
    // Soft warnings (typically the SMTP_FROM / SMTP_USER mix-up) — saved
    // successfully but flagged for the admin to double-check.
    const warnText = data.warnings.map(w => `${w.key}: ${w.message}`).join('\n\n');
    showMsg('Saved — but please review:\n\n' + warnText, false);
  } else {
    showMsg(savedConfigMessage(_alertingMode), true);
  }
  _configCache = data.config;
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Wire up save config button (avoids inline onclick blocked by CSP)
document.getElementById('btn-save-config').addEventListener('click', saveConfig);

// ─── Test Email (admin diagnostic) ────────────────────────────────────────────
async function sendTestEmail() {
  const toEl    = document.getElementById('test-email-to');
  const btn     = document.getElementById('btn-test-email');
  const out     = document.getElementById('test-email-result');
  const to      = (toEl.value || '').trim();
  if (!to) { toEl.focus(); return; }

  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = '⏳ Sending…';
  out.style.display = 'block';
  out.style.background = '#eceff1';
  out.style.color = '#37474f';
  out.style.border = '1px solid #cfd8dc';
  out.textContent  = `Attempting send to ${to} …`;

  try {
    const r = await fetch('/v1/admin/test-email', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to })
    });
    const data = await r.json();

    if (!r.ok) {
      // 4xx — input or pre-check failure (not configured, bad email, rate limit)
      out.style.background = '#ffebee';
      out.style.color      = '#c62828';
      out.style.border     = '1px solid #ef9a9a';
      out.textContent      = `❌ ${data.title || 'Error'}: ${data.detail || JSON.stringify(data, null, 2)}`;
      return;
    }

    if (data.ok) {
      // SMTP accepted the message
      out.style.background = '#e8f5e9';
      out.style.color      = '#1b5e20';
      out.style.border     = '1px solid #a5d6a7';
      out.textContent =
        `✅ Sent to ${data.to}\n` +
        `   message-id: ${data.messageId || '(none)'}\n` +
        `   accepted:   ${JSON.stringify(data.accepted || [])}\n` +
        `   rejected:   ${JSON.stringify(data.rejected || [])}\n` +
        `   response:   ${data.response || ''}\n\n` +
        `Check the inbox (and spam folder).`;
    } else {
      // Server reached the SMTP relay but the relay rejected
      out.style.background = '#ffebee';
      out.style.color      = '#c62828';
      out.style.border     = '1px solid #ef9a9a';
      out.textContent =
        `❌ SMTP rejected the message.\n\n` +
        `   to:           ${data.to}\n` +
        `   error:        ${data.error}\n` +
        `   code:         ${data.code || '(none)'}\n` +
        `   command:      ${data.command || '(none)'}\n` +
        `   responseCode: ${data.responseCode || '(none)'}\n` +
        `   response:     ${data.response || '(none)'}\n\n` +
        `Common causes:\n` +
        `  • 535 → wrong SMTP_PASSWORD (Brevo: must be your SMTP key, not account password)\n` +
        `  • 550 sender not allowed → SMTP_FROM domain not verified in your relay's senders\n` +
        `  • ECONNREFUSED / timeout → SMTP_HOST or SMTP_PORT wrong, or VPS firewall`;
    }
  } catch (err) {
    out.style.background = '#ffebee';
    out.style.color      = '#c62828';
    out.style.border     = '1px solid #ef9a9a';
    out.textContent      = `❌ Network error talking to /v1/admin/test-email: ${err.message || err}`;
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// Default the "Send to" field to the logged-in admin's own email so the
// usual "send to myself, check inbox" loop is one click.
(function preloadTestEmailTo() {
  const el = document.getElementById('test-email-to');
  if (el && user && user.email) el.value = user.email;
})();

document.getElementById('btn-test-email').addEventListener('click', sendTestEmail);
document.getElementById('btn-emergency-stop-all').addEventListener('click', emergencyStopAllPlatform);

(async function init(){
  try {
    // Test managers only have the Users tab; the Create User form's role
    // dropdown is constrained to {Tester, Test Manager} and the Company
    // dropdown is hidden (their company is implicit).
    if (isTestMgr) {
      const roleSelect = document.getElementById('new-role');
      roleSelect.innerHTML =
        '<option value="company_user">Tester</option>' +
        '<option value="test_manager">Test Manager</option>';
      document.getElementById('new-company-field').classList.add('hidden');
      document.getElementById('page-title').textContent = 'Manage Company Users';
    }

    // Load companies first — required so the company dropdowns in the user table are populated
    if (isAdmin) {
      await loadCompanies();
      toggleNewCompanyField();
    }
    // Activate the tab after companies are ready
    switchTab(_initTab);
  } catch (e) {
    console.error('Admin page failed to load:', e);
    showMsg('Failed to load admin data.', false);
  }
})().catch(oscarReportError);
