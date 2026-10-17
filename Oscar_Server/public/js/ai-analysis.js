/* global esc */  // esc.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ai-analysis.js — the AI analysis page (#801). PR 1: access only.
 *
 * A Test Manager reads the commitment text, accepts it and asks for access;
 * an administrator decides. The analysis itself comes in a later release.
 * `accessHtml(data)` is pure (lifted by the page test); the rest is wiring.
 */

const NOTE = 'padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5;margin-bottom:14px;';
const INFO = 'background:#e3f2fd;color:#0d47a1;border:1px solid #bbdefb;';
const WARN = 'background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;';
const OK = 'background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9;';

// The text in a card; `footer` (the box to tick and the button) goes inside it.
function commitmentHtml(c, footer) {
  const points = (c.points || []).map(p => `<li style="margin-bottom:8px">${esc(p)}</li>`).join('');
  return `<div class="card" style="padding:18px 20px">
    <h3 style="margin:0 0 10px">${esc(c.title)}</h3>
    <ol style="padding-left:20px;font-size:13px;line-height:1.55;color:#37474f">${points}</ol>
    <div style="font-size:11px;color:#90a4ae">Version ${esc(c.version)}</div>${footer || ''}
  </div>`;
}

function requestFormHtml(c, label) {
  return commitmentHtml(c, `
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#37474f;margin:16px 0 12px;padding-top:14px;border-top:1px solid #eceff1">
      <input type="checkbox" id="ai-accept" data-ai-action="accept" style="width:auto;margin-top:3px">
      <span>I have read this text, I understand what it means for my company's data and costs, and I accept it.</span>
    </label>
    <button class="btn btn-primary" id="ai-request" data-ai-action="request" disabled>${esc(label)}</button>`);
}

// A refused or withdrawn request, with its reason, above a new one.
function pastRequestHtml(r) {
  if (r.state !== 'refused' && r.state !== 'revoked') return '';
  const verdict = r.state === 'refused' ? 'refused' : 'withdrawn';
  const reason = r.reason ? ': ' + esc(r.reason) : '';
  return `<div style="${NOTE}${WARN}">Your last request was ${verdict}${reason}.
            You may ask again.</div>`;
}

/** The page's body for a GET /ai-analysis/access answer. */
function accessHtml(data) {
  const c = data.commitment || {};
  const r = data.request || {};
  switch (data.state) {
    case 'disabled':
      return `<div style="${NOTE}${INFO}">The AI analysis is not enabled for ${esc(data.company?.name)}.
        An OSCAR administrator enables it per company; ask them if your company wants it.</div>`;
    case 'pending':
      return `<div style="${NOTE}${INFO}">Your request is waiting for an OSCAR administrator. You accepted version
        ${esc(r.textVersion)} of the text on ${esc(r.acceptedAt)}. You will be told by e-mail and on this page.</div>`
        + commitmentHtml(c);
    case 'approved':
      return `<div style="${NOTE}${OK}">Your access is approved. The analysis itself (configuring your company's AI,
        then analysing a batch or comparing two) comes in the next releases.</div>`;
    case 'needs_acceptance':
      return `<div style="${NOTE}${WARN}">The commitment text has changed since you accepted it. Read it and accept
        it again to keep your access; no new approval is needed.</div>` + requestFormHtml(c, 'Accept the new text');
    default:
      return pastRequestHtml(r) + `<div style="${NOTE}${INFO}">The AI analysis sends test results to an AI service your company
        chooses. Read what that means before you ask for access.</div>` + requestFormHtml(c, 'Ask for access');
  }
}

let current = null;

function show(message, kind) {
  const el = document.getElementById('msg');
  el.textContent = message || '';
  const tone = kind === 'error' ? 'msg-err' : 'msg-ok';
  el.className = message ? 'msg ' + tone : 'msg';
  el.style.display = message ? 'block' : 'none';
}

async function readError(res, fallback) {
  try { const body = await res.json(); return body.detail || body.title || fallback; } catch { return fallback; }
}

async function load() {
  const root = document.getElementById('ai-root');
  const res = await fetch('/v1/company/ai-analysis/access');
  document.getElementById('loading').style.display = 'none';
  if (!res.ok) { show(await readError(res, 'Could not read your access.'), 'error'); return; }
  current = await res.json();
  root.innerHTML = accessHtml(current);
  root.style.display = 'block';
}

async function requestAccess() {
  if (!current) return;
  const button = document.getElementById('ai-request');
  button.disabled = true;
  const res = await fetch('/v1/company/ai-analysis/access/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: current.commitment.version, hash: current.commitment.hash }),
  });
  if (!res.ok) { button.disabled = false; show(await readError(res, 'The request failed.'), 'error'); return; }
  show(res.status === 201 ? 'Your request was sent to the OSCAR administrators.' : 'Thank you: your access is kept.', 'ok');
  await load();
}

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-ai-action="accept"]');
  if (el) document.getElementById('ai-request').disabled = !el.checked;
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-ai-action="request"]');
  if (el) requestAccess().catch(err => show(err.message, 'error'));
});

if (typeof window !== 'undefined' && document.getElementById('ai-root')) {
  load().catch(err => show(err.message, 'error'));
}
