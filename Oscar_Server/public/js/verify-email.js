// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of verify-email.html, moved out of the page unchanged (#1423) so that
// the content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const token = new URLSearchParams(location.search).get('token');

async function init() {
  if (!token) { showExpired(); return; }
  try {
    const res  = await fetch(`/v1/auth/register/check-token?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) { showExpired(data.detail); return; }
    document.getElementById('info-email').textContent   = data.email;
    document.getElementById('info-company').textContent = data.companyName;
    document.getElementById('loading').style.display = 'none';
    document.getElementById('main').style.display    = 'block';
  } catch(e) {
    console.error('Checking the verification link failed:', e);
    showExpired('Server unreachable.');
  }
}

function showExpired(msg) {
  document.getElementById('loading').style.display  = 'none';
  document.getElementById('expired').style.display  = 'block';
  if (msg) document.getElementById('expired-text').textContent = msg;
}

// The e-mail is confirmed by a click, never on load: a mail scanner opening
// the link must not confirm it.
async function doConfirm(e) {
  e.preventDefault();
  const errEl = document.getElementById('error');
  errEl.style.display = 'none';
  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Confirming…';
  try {
    const res  = await fetch('/v1/auth/register/confirm', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.detail || data.title || 'Confirmation failed.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('main').style.display = 'none';
    document.getElementById('pending').style.display = 'block';
  } catch(e) {
    console.error('Confirming the e-mail failed:', e);
    errEl.textContent = 'Server unreachable.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Confirm my email address';
  }
}

document.getElementById('confirm-form').addEventListener('submit', doConfirm);

init();
