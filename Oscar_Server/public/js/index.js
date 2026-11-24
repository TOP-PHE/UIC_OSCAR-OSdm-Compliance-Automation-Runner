// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of index.html, moved out of the page unchanged (#1423) so that
// the content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

/* global OscarMfa */
const API = '';

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='register')));
  document.querySelectorAll('.form').forEach(f => f.classList.remove('active'));
  document.getElementById(tab).classList.add('active');
  document.getElementById('beta-notice').style.display = tab === 'login' ? 'block' : 'none';
  // News banner moved to welcome.html — no element to toggle here anymore.
  document.getElementById('error').style.display = 'none';
}

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}

// Where to go once signed in (#1199). The sign-in check in front of Grafana
// and Prometheus sends the browser here with ?next= (Traefik's authSigninURL
// on k3s, nginx's @sso_login on the VPS). Only those two tools are followed,
// and only as fixed addresses of this site: a link cannot send someone
// signing in anywhere else. null: the home page, as before.
function nextAfterSignIn(search) {
  let next = null;
  try { next = new URLSearchParams(search).get('next'); } catch { return null; }
  if (typeof next !== 'string') return null;
  if (next.startsWith('/grafana/')) return '/grafana/';
  if (next.startsWith('/prometheus/')) return '/prometheus/';
  return null;
}

// One-shot session-expired notice. Set by the global fetch interceptor in
// nav.js when an authenticated API call returns 401 — picked up here on
// the next page load and surfaced as an inline notice above the login form.
(function showSessionExpiredNotice() {
  try {
    const msg = sessionStorage.getItem('oscar_login_message');
    if (msg) {
      sessionStorage.removeItem('oscar_login_message');
      showError(msg);
    }
  } catch (_e) { /* sessionStorage unavailable — silently skip */ }
})();

// A session answered: remember who signed in, then go on.
function finishSignIn(data) {
  // Primary auth path is the httpOnly cookie set by the server. We ALSO
  // mirror the token in localStorage so the existing Bearer-header fetch
  // calls in admin/dashboard pages keep working (the auth middleware
  // accepts both cookie and Bearer). The cookie is the source of truth
  // in production HTTPS; localStorage is the dev-HTTP fallback because
  // browsers refuse to set Secure cookies on plain http://localhost.
  if (data.token) localStorage.setItem('oscar_token', data.token);
  localStorage.setItem('oscar_company', JSON.stringify(data.company));
  localStorage.setItem('oscar_user', JSON.stringify(data.user));
  window.location.href = nextAfterSignIn(window.location.search) || '/welcome.html';
}

// ── Second factor (#1414) ────────────────────────────────────────────────────
// After a right password the server may answer { mfa: 'verify' | 'setup',
// mfa_token } instead of a session: the next step goes on with that token.
let mfaToken = null;

function showForm(id) {
  document.querySelectorAll('.form').forEach(f => f.classList.toggle('active', f.id === id));
  document.getElementById('error').style.display = 'none';
}

function backToSignIn(message) {
  mfaToken = null;
  showForm('login');
  if (message) showError(message);
}

async function postJson(url, body) {
  const res = await fetch(`${API}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { res, data: await res.json().catch(() => ({})) };
}

async function startMfaSetup() {
  const { res, data } = await postJson('/v1/auth/mfa/setup', { mfa_token: mfaToken });
  if (!res.ok) { backToSignIn(data.detail || 'The set-up could not start. Sign in again.'); return; }
  showForm('mfa-setup');
  OscarMfa.showSetup(document.getElementById('mfa-setup-box'), data, 'mfa-setup-code').focus();
}

async function sendCode(url, codeId, btn) {
  const code = OscarMfa.cleanCode(document.getElementById(codeId).value);
  if (!code) { showError('Type the six digits your authenticator app shows.'); return; }
  btn.disabled = true;
  try {
    const { res, data } = await postJson(url, { mfa_token: mfaToken, code });
    if (res.status === 401) { backToSignIn(data.detail || 'This sign-in has expired. Sign in again.'); return; }
    if (!res.ok) { showError(data.detail || 'That code was not accepted.'); return; }
    finishSignIn(data);
  } catch (err) { console.error('Second factor failed:', err); showError('Server unreachable. Is OSCAR running?'); }
  finally { btn.disabled = false; }
}

async function doLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('l-btn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const { res, data } = await postJson('/v1/auth/login', {
      email: document.getElementById('l-email').value, password: document.getElementById('l-password').value
    });
    if (!res.ok) { showError(data.detail || data.title || 'Login failed.'); return; }
    if (data.mfa === 'verify') {
      mfaToken = data.mfa_token;
      showForm('mfa-verify');
      document.getElementById('mfa-code').focus();
      return;
    }
    if (data.mfa === 'setup') {
      mfaToken = data.mfa_token;
      await startMfaSetup();
      return;
    }
    finishSignIn(data);
  } catch(err) { console.error('Sign-in failed:', err); showError('Server unreachable. Is OSCAR running?'); }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

async function doRegister(e) {
  e.preventDefault();
  const btn = document.getElementById('r-btn');
  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    const res = await fetch(`${API}/v1/auth/register/request`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        name:    document.getElementById('r-name').value.trim(),
        email:   document.getElementById('r-email').value.trim(),
        // Typed, never picked from a list: no list of companies is shown.
        company: document.getElementById('r-company').value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) { showError(data.detail || data.title || 'Registration failed.'); return; }

    // Always hide the form and show the "check your inbox" panel
    document.querySelector('#register form').style.display = 'none';
    document.getElementById('r-success').style.display = 'block';

    // Dev mode: SMTP not configured — show the link directly on the panel so
    // the developer can click it manually (simulates opening the email link).
    if (data.verificationUrl) {
      const devBlock = document.getElementById('r-devlink');
      const devLink  = document.getElementById('r-devlink-a');
      devLink.href        = data.verificationUrl;
      devLink.textContent = data.verificationUrl;
      devBlock.style.display = 'block';
    }
  } catch(err) { console.error('Registration request failed:', err); showError('Server unreachable. Is OSCAR running?'); }
  finally { btn.disabled = false; btn.textContent = 'Send Confirmation Email'; }
}

// Bind event listeners (CSP-safe — no inline handlers)
document.getElementById('tab-login').addEventListener('click', () => showTab('login'));
document.getElementById('tab-register').addEventListener('click', () => showTab('register'));
document.getElementById('login').addEventListener('submit', doLogin);
document.getElementById('register-form').addEventListener('submit', doRegister);
document.getElementById('mfa-verify').addEventListener('submit', (e) => {
  e.preventDefault();
  sendCode('/v1/auth/mfa/verify', 'mfa-code', document.getElementById('mfa-btn'));
});
document.getElementById('mfa-setup').addEventListener('submit', (e) => {
  e.preventDefault();
  sendCode('/v1/auth/mfa/setup/confirm', 'mfa-setup-code', document.getElementById('mfa-setup-btn'));
});
document.querySelectorAll('[data-mfa-cancel]').forEach(a => a.addEventListener('click', (e) => {
  e.preventDefault();
  backToSignIn('');
}));

// If already logged in, go straight to the welcome page. Not when a sign-in
// check sent the browser here (?next=): its session has ended, whatever this
// browser remembers, and going through the home page would lose ?next= (#1199).
if (localStorage.getItem('oscar_user') && !nextAfterSignIn(window.location.search)) {
  window.location.href = '/welcome.html';
}
