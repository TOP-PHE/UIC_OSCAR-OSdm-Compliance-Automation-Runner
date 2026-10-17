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
 * A Test Manager reads the commitment text, ticks the company and the
 * providers they ask access for, accepts the text and sends the request; the
 * OSCAR administrator decides each one on its own. The analysis itself comes
 * in a later release. `accessHtml(data)` is pure (lifted by the page test);
 * the rest is wiring.
 */

const NOTE = 'padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5;margin-bottom:14px;';
const INFO = 'background:#e3f2fd;color:#0d47a1;border:1px solid #bbdefb;';
const OK = 'background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9;';
const CELL = 'padding:7px 14px 7px 0;text-align:left;vertical-align:top;border-bottom:1px solid #eceff1;';

// The text in a card; `footer` (the box to tick and the button) goes inside it.
function commitmentHtml(c, footer) {
  const points = (c.points || []).map(p => `<li style="margin-bottom:8px">${esc(p)}</li>`).join('');
  return `<div class="card" style="padding:18px 20px">
    <h3 style="margin:0 0 10px">${esc(c.title)}</h3>
    <ol style="padding-left:20px;font-size:13px;line-height:1.55;color:#37474f">${points}</ol>
    <div style="font-size:11px;color:#90a4ae">Version ${esc(c.version)}</div>${footer || ''}
  </div>`;
}

function requestFormHtml(c) {
  return commitmentHtml(c, `
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#37474f;margin:16px 0 12px;padding-top:14px;border-top:1px solid #eceff1">
      <input type="checkbox" id="ai-accept" data-ai-action="accept" style="width:auto;margin-top:3px">
      <span>I have read this text, I understand what it means for my company's data and costs, and I accept it.</span>
    </label>
    <button class="btn btn-primary" id="ai-request" data-ai-action="request" disabled>Send the request</button>`);
}

// A refused or withdrawn request, with its reason; else nothing asked yet.
function pastRequestHtml(r) {
  if (r.state !== 'refused' && r.state !== 'revoked') return 'No request yet';
  const verdict = r.state === 'refused' ? 'Refused' : 'Withdrawn';
  const reason = r.reason ? ': ' + esc(r.reason) : '';
  return `<span style="color:#b71c1c">${verdict}${reason}</span>. You may ask again.`;
}

// Where the Test Manager stands for one company or provider, in words.
function stateHtml(t) {
  const r = t.request || {};
  if (t.state === 'pending') {
    return `<span style="color:#0d47a1">Waiting for an OSCAR administrator</span> (text v${esc(r.textVersion)} accepted on ${esc(r.acceptedAt)})`;
  }
  if (t.state === 'approved') return '<span style="color:#1b5e20">Approved</span>';
  if (t.state === 'needs_acceptance') {
    return '<span style="color:#7a4f01">Approved, but the text has changed: accept it again to keep the access (no new approval)</span>';
  }
  return pastRequestHtml(r);
}

function mayAsk(t) {
  return t.state === 'none' || t.state === 'needs_acceptance';
}

function targetRowHtml(t) {
  const box = mayAsk(t)
    ? `<input type="checkbox" data-ai-action="target" value="${esc(t.id)}" aria-label="Ask access for ${esc(t.name)}" style="width:auto">`
    : '';
  const kind = t.provider ? 'Provider' : 'Company';
  return `<tr><td style="${CELL}width:32px">${box}</td><td style="${CELL}">${esc(t.name)}</td><td style="${CELL}">${kind}</td><td style="${CELL}">${stateHtml(t)}</td></tr>`;
}

/** The page's body for a GET /ai-analysis/access answer. */
function accessHtml(data) {
  const c = data.commitment || {};
  const targets = data.targets || [];
  const table = `<div class="card" style="padding:14px 18px">
    <h3 style="margin:0 0 6px">Access per company and provider</h3>
    <div style="font-size:12px;color:#78909c;margin-bottom:10px">Tick those you ask access for. The OSCAR administrator decides each one
      on its own: a refusal for one provider leaves the others open.</div>
    <div class="table-wrap"><table style="border-collapse:collapse;font-size:13px">
      <thead><tr><th style="${CELL}"></th><th style="${CELL}">Name</th><th style="${CELL}">Kind</th><th style="${CELL}">Access</th></tr></thead>
      <tbody>${targets.map(targetRowHtml).join('')}</tbody>
    </table></div>
  </div>`;
  if (targets.some(mayAsk)) {
    return `<div style="${NOTE}${INFO}">The AI analysis sends test results to an AI service your company
      chooses. Read what that means before you ask for access.</div>` + table + requestFormHtml(c);
  }
  const open = targets.some(t => t.state === 'approved')
    ? `<div style="${NOTE}${OK}">The analysis itself (configuring your company's AI, then analysing a batch or
      comparing two) comes in the next releases.</div>`
    : '';
  return open + table + commitmentHtml(c);
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

function ticked() {
  return [...document.querySelectorAll('[data-ai-action="target"]:checked')].map(el => el.value);
}

function updateButton() {
  const button = document.getElementById('ai-request');
  const accept = document.getElementById('ai-accept');
  if (button) button.disabled = !(accept?.checked && ticked().length);
}

async function requestAccess() {
  if (!current) return;
  const companies = ticked();
  const button = document.getElementById('ai-request');
  button.disabled = true;
  const res = await fetch('/v1/company/ai-analysis/access/request', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: current.commitment.version, hash: current.commitment.hash, companies }),
  });
  if (!res.ok) { updateButton(); show(await readError(res, 'The request failed.'), 'error'); return; }
  show(res.status === 201 ? 'Your request was sent to the OSCAR administrators.' : 'Thank you: your access is kept.', 'ok');
  await load();
}

document.addEventListener('change', (e) => {
  if (e.target.closest('[data-ai-action="accept"], [data-ai-action="target"]')) updateButton();
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-ai-action="request"]');
  if (el) requestAccess().catch(err => show(err.message, 'error'));
});

if (typeof window !== 'undefined' && document.getElementById('ai-root')) {
  load().catch(err => show(err.message, 'error'));
}
