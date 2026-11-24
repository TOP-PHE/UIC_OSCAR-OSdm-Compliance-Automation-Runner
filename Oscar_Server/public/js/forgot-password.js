// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of forgot-password.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

async function doRequest(e) {
  e.preventDefault();
  const email = document.getElementById('email').value.trim();
  const errEl = document.getElementById('error');
  errEl.style.display = 'none';

  const btn = document.getElementById('btn');
  btn.disabled = true; btn.textContent = 'Sending…';

  try {
    const res  = await fetch('/v1/auth/password-reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.detail || data.title || 'Request failed.';
      errEl.style.display = 'block';
      return;
    }
    // Server returns generic success even if the email isn't registered
    // (anti-enumeration). In dev mode it returns the URL directly — surface
    // it so the developer can click through without SMTP.
    document.getElementById('form-area').style.display = 'none';
    document.getElementById('done-area').style.display = 'block';
    if (data.resetUrl) {
      const note = document.createElement('div');
      note.style.cssText = 'background:#fff3e0;border:1px solid #ffcc80;border-radius:6px;padding:10px 14px;font-size:12px;margin-top:10px;color:#bf360c;word-break:break-all';
      note.innerHTML = '<strong>DEV MODE:</strong> SMTP not configured. <a href="' + data.resetUrl + '">Click here to reset</a>';
      document.getElementById('done-area').appendChild(note);
    }
  } catch(e) {
    console.error('Password-reset request failed:', e);
    errEl.textContent = 'Server unreachable.';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false; btn.textContent = 'Send reset link';
  }
}

document.getElementById('request-form').addEventListener('submit', doRequest);
