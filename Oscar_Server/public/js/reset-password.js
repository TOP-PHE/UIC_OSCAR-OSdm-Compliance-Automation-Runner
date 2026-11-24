// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of reset-password.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const token = new URLSearchParams(location.search).get('token');
// An access just given (accessRequests.js) uses this page to choose the first password.
if (new URLSearchParams(location.search).get('welcome') === '1') {
  document.getElementById('main-title').textContent = 'Choose your password';
  document.getElementById('main-subtitle').textContent = 'Your access to OSCAR is ready. Choose your password to sign in.';
}

async function init() {
  if (!token) { showExpired(); return; }
  try {
    const res  = await fetch(`/v1/auth/password-reset/check-token?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) { showExpired(data.detail); return; }
    document.getElementById('info-email').textContent = data.email;
    document.getElementById('loading').style.display = 'none';
    document.getElementById('main').style.display    = 'block';
  } catch(e) {
    console.error('Checking the reset link failed:', e);
    showExpired('Server unreachable.');
  }
}

function showExpired(msg) {
  document.getElementById('loading').style.display  = 'none';
  document.getElementById('expired').style.display  = 'block';
  if (msg) document.querySelector('#expired .error').innerHTML =
    msg + '<br>Please <a href="/forgot-password.html" style="color:#c62828">request a new reset link</a>.';
}

async function doConfirm(e) {
  e.preventDefault();
  const pwd  = document.getElementById('password').value;
  const pwd2 = document.getElementById('password2').value;
  const errEl = document.getElementById('error');
  errEl.style.display = 'none';

  if (pwd !== pwd2) {
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Updating…';

  try {
    const res  = await fetch('/v1/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password: pwd })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.detail || data.title || 'Reset failed.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('main').style.display = 'none';
    document.getElementById('done').style.display = 'block';
    setTimeout(() => { window.location.href = '/'; }, 2200);
  } catch(e) {
    console.error('Setting the new password failed:', e);
    errEl.textContent = 'Server unreachable.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Set new password';
  }
}

document.getElementById('confirm-form').addEventListener('submit', doConfirm);

init().catch(oscarReportError);

// A promise nothing awaits ends with .catch(oscarReportError) (#1423): the
// error is logged, as an unhandled one was. This page loads no nav.js.
function oscarReportError(err) {
  console.error('[OSCAR]', err);
}
