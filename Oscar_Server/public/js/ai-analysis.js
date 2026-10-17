/* global esc */  // esc.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ai-analysis.js — the AI analysis page (#801). PR 1: access; PR 2: the
 * AI service.
 *
 * A Test Manager reads the commitment text, ticks the company and the
 * providers they ask access for, accepts the text and sends the request; the
 * OSCAR administrator decides each one on its own. Where access is approved,
 * the Test Manager configures the AI service, one section per company or
 * provider, each saved and tested on its own. The analysis itself comes in a
 * later release. `accessHtml(data)` and `serviceHtml(...)` are pure (lifted
 * by the page test); the rest is wiring.
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
    ? `<div style="${NOTE}${OK}">Configure the AI service of each company or provider below. The analysis itself
      (a batch, or two batches compared) comes in the next release.</div>`
    : '';
  return open + table + commitmentHtml(c);
}

const FIELD = 'display:block;font-size:12px;color:#546e7a;margin:10px 0 4px';
const WIDE = 'width:100%;max-width:560px;box-sizing:border-box';

function connectorOptionsHtml(connectors, chosen) {
  return connectors.map(c => `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
}

function testedHtml(config) {
  if (!config) return '<span style="color:#78909c">Not configured yet.</span>';
  const when = config.testedAt ? `last tested ${esc(config.testedAt)}` : 'not tested';
  return `<span style="color:#1b5e20">Configured</span>: ${esc(config.model)}, ${when}.`;
}

/**
 * One company's or provider's AI service. `n` makes the field ids unique on
 * the page; the script finds the fields by data-f inside the section.
 */
function serviceHtml(target, answer, n) {
  const config = answer.config;
  const connectors = answer.connectors || [];
  const connector = config?.connector || connectors[0]?.id || '';
  const defaults = connectors.find(c => c.id === connector) || {};
  const id = (f) => `ai-${f}-${n}`;
  const keyHint = config?.hasKey ? 'A key is stored. Leave empty to keep it.' : 'The key of your account with this service.';
  const removeButton = config
    ? '<button class="btn" data-ai-action="remove">Remove</button>'
    : '';
  return `<div class="card" style="padding:16px 20px" data-ai-target="${esc(target.id)}" data-ai-provider="${target.provider ? '1' : ''}">
    <h3 style="margin:0 0 4px">AI service — ${esc(target.name)}</h3>
    <div style="font-size:12px;color:#78909c" data-f="status">${testedHtml(config)}</div>
    <label for="${id('connector')}" style="${FIELD}">Kind of service</label>
    <select id="${id('connector')}" data-f="connector" data-ai-action="connector" style="${WIDE}">${connectorOptionsHtml(connectors, connector)}</select>
    <label for="${id('baseUrl')}" style="${FIELD}">Address (https)</label>
    <input id="${id('baseUrl')}" data-f="baseUrl" style="${WIDE}" type="url" value="${esc(config?.baseUrl || defaults.defaultBaseUrl || '')}" autocomplete="off">
    <label for="${id('model')}" style="${FIELD}">Model</label>
    <input id="${id('model')}" data-f="model" style="${WIDE}" type="text" value="${esc(config?.model || '')}" placeholder="claude-opus-5-5, gpt-4o, mistral-large-latest…" autocomplete="off">
    <label for="${id('apiKey')}" style="${FIELD}">Key</label>
    <input id="${id('apiKey')}" data-f="apiKey" style="${WIDE}" type="password" value="" placeholder="${esc(keyHint)}" autocomplete="new-password">
    <div style="font-size:11px;color:#90a4ae;margin-top:3px">Never shown again once saved. Changing the service or its host asks for it again.</div>
    <label for="${id('cap')}" style="${FIELD}">Monthly token limit (optional)</label>
    <input id="${id('cap')}" data-f="monthlyTokenCap" style="${WIDE}" type="number" min="${esc(answer.limits?.minTokenCap ?? 1000)}" step="1" value="${esc(config?.monthlyTokenCap ?? '')}">
    <label for="${id('instruction')}" style="${FIELD}">Your own instruction, added to OSCAR's (optional)</label>
    <textarea id="${id('instruction')}" data-f="instruction" style="${WIDE}" rows="3" maxlength="${esc(answer.limits?.instruction ?? 2000)}">${esc(config?.instruction || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
      <button class="btn" data-ai-action="test">Test the connection</button>
      <button class="btn btn-primary" data-ai-action="save">Save</button>${removeButton}
    </div>
    <div data-f="result" style="margin-top:10px"></div>
  </div>`;
}

/** What a connection test answered, in words. */
function testResultHtml(test) {
  if (!test) return '';
  if (!test.ok) return `<div style="${NOTE}background:#ffebee;color:#b71c1c;border:1px solid #ffcdd2;">${esc(test.error)}</div>`;
  const usage = test.usage && (test.usage.input != null || test.usage.output != null)
    ? ` · ${esc(test.usage.input ?? '?')} tokens in, ${esc(test.usage.output ?? '?')} out` : '';
  const answer = test.answer ? `“${esc(test.answer)}”` : '(no text in the answer)';
  const model = test.model ? ' — model ' + esc(test.model) : '';
  return `<div style="${NOTE}${OK}">The service answered in ${esc(test.ms)} ms${usage}: ${answer}${model}</div>`;
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

// Every request of a section names its company or provider: an empty
// X-Provider-Id is the own company (nav.js then adds nothing).
function inTarget(section, init = {}) {
  const provider = section.dataset.aiProvider ? section.dataset.aiTarget : '';
  return { ...init, headers: { ...init.headers, 'X-Provider-Id': provider } };
}

// One target's answer, or null after saying why it could not be read.
async function serviceAnswer(t) {
  const res = await fetch('/v1/company/ai-analysis/config', { headers: { 'X-Provider-Id': t.provider ? t.id : '' } });
  if (!res.ok) { show(await readError(res, `Could not read the AI service of ${t.name}.`), 'error'); return null; }
  return res.json();
}

async function servicesHtml(targets) {
  const approved = targets.filter(x => x.state === 'approved');
  const answers = await Promise.all(approved.map(serviceAnswer));
  const shown = answers.find(Boolean);
  if (current && shown) current.connectorsShown = shown.connectors || [];
  return approved.map((t, n) => (answers[n] ? serviceHtml(t, answers[n], n) : '')).join('');
}

async function load() {
  const root = document.getElementById('ai-root');
  const res = await fetch('/v1/company/ai-analysis/access');
  document.getElementById('loading').style.display = 'none';
  if (!res.ok) { show(await readError(res, 'Could not read your access.'), 'error'); return; }
  current = await res.json();
  root.innerHTML = accessHtml(current) + await servicesHtml(current.targets || []);
  root.style.display = 'block';
}

function fieldsOf(section) {
  const value = (f) => section.querySelector(`[data-f="${f}"]`).value;
  return { connector: value('connector'), baseUrl: value('baseUrl'), model: value('model'), apiKey: value('apiKey'),
    monthlyTokenCap: value('monthlyTokenCap'), instruction: value('instruction') };
}

function showResult(section, html) {
  section.querySelector('[data-f="result"]').innerHTML = html;
}

async function serviceAction(section, action) {
  const url = '/v1/company/ai-analysis/config';
  const json = { 'Content-Type': 'application/json' };
  let res;
  if (action === 'test') {
    showResult(section, '⏳ Testing…');
    res = await fetch(url + '/test', inTarget(section, { method: 'POST', headers: json, body: JSON.stringify(fieldsOf(section)) }));
  } else if (action === 'save') {
    showResult(section, '⏳ Saving (a new service, address, model or key is tested first)…');
    res = await fetch(url, inTarget(section, { method: 'PUT', headers: json, body: JSON.stringify(fieldsOf(section)) }));
  } else {
    if (!confirm('Remove this AI service, key included?')) return;
    res = await fetch(url, inTarget(section, { method: 'DELETE' }));
  }
  if (res.status === 204) { show('AI service removed.', 'ok'); await load(); return; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    showResult(section, body.test ? testResultHtml(body.test) : testResultHtml({ ok: false, error: body.detail || 'The request failed.' }));
    return;
  }
  if (action === 'test') { showResult(section, testResultHtml(body.test)); return; }
  show('AI service saved.', 'ok');
  await load();
}

// A new kind of service starts from its usual address, unless one was typed.
function connectorChanged(section) {
  const chosen = (current?.connectorsShown || []).find(c => c.id === section.querySelector('[data-f="connector"]').value);
  const address = section.querySelector('[data-f="baseUrl"]');
  const defaults = (current?.connectorsShown || []).map(c => c.defaultBaseUrl);
  if (chosen && (address.value === '' || defaults.includes(address.value))) address.value = chosen.defaultBaseUrl;
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
  const kind = e.target.closest('[data-ai-action="connector"]');
  if (kind) connectorChanged(kind.closest('[data-ai-target]'));
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-ai-action="request"]');
  if (el) requestAccess().catch(err => show(err.message, 'error'));
  const service = e.target.closest('[data-ai-action="test"], [data-ai-action="save"], [data-ai-action="remove"]');
  if (service) {
    const section = service.closest('[data-ai-target]');
    serviceAction(section, service.dataset.aiAction).catch(err => showResult(section, testResultHtml({ ok: false, error: err.message })));
  }
});

if (typeof window !== 'undefined' && document.getElementById('ai-root')) {
  load().catch(err => show(err.message, 'error'));
}
