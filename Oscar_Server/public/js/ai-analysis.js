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
 * later release. `accessHtml(data)`, `serviceHtml(...)` and `checklistHtml(c)`
 * are pure (lifted by the page test); the rest is wiring. #827: the provider's
 * set-up checklist is imported per company or provider in the analysis card.
 * #831: a list of models, the model chosen per analysis, two analyses side by
 * side, the cost of each and what was spent, a suggested limit and instruction.
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
    ? `<div style="${NOTE}${OK}">Configure the AI service of each company or provider below, then analyse a batch, or compare two.</div>`
    : '';
  return open + table + commitmentHtml(c);
}

const FIELD = 'display:block;font-size:12px;color:#546e7a;margin:10px 0 4px';
const WIDE = 'width:100%;max-width:560px;box-sizing:border-box';

function connectorOptionsHtml(connectors, chosen) {
  return connectors.map(c => `<option value="${esc(c.id)}"${c.id === chosen ? ' selected' : ''}>${esc(c.label)}</option>`).join('');
}

// "$4 / $20 per million tokens", or nothing when OSCAR has no price.
function priceText(m) {
  if (m.input === null || m.input === undefined) return '';
  return ` — $${m.input} / $${m.output} per million tokens in / out`;
}

/** The models to choose from (#831), the stored one selected; one not in the list is added, marked. */
function modelOptionsHtml(models, chosen) {
  const known = models.some(m => m.id === chosen);
  const own = chosen && !known ? `<option value="${esc(chosen)}" selected>${esc(chosen)} (not in the list)</option>` : '';
  const options = models.map(m => `<option value="${esc(m.id)}"${m.id === chosen ? ' selected' : ''}>${esc(m.label)} (${esc(m.id)})${esc(priceText(m))}${m.note ? ' — ' + esc(m.note) : ''}</option>`).join('');
  return own + options + '<option value="">Another model: type its id below</option>';
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
  const suggestedCap = answer.suggested?.monthlyTokenCap ?? 2000000;
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
    <div data-f="modelList" style="${connector === 'anthropic' ? '' : 'display:none'}">
      <select data-f="modelPick" data-ai-action="model-pick" aria-label="Choose a model" style="${WIDE}">${modelOptionsHtml(answer.models || [], config?.model || '')}</select>
      <button class="btn" data-ai-action="models" style="margin-top:6px">Refresh the list from the service</button>
    </div>
    <input id="${id('model')}" data-f="model" style="${WIDE};margin-top:6px" type="text" value="${esc(config?.model || (connector === 'anthropic' ? answer.models?.[0]?.id || '' : ''))}" placeholder="claude-opus-5-5, gpt-4o, mistral-large-latest…" autocomplete="off">
    <div style="font-size:11px;color:#90a4ae;margin-top:3px">The id of the model, without spaces. Each analysis can still choose another one.</div>
    <label for="${id('apiKey')}" style="${FIELD}">Key</label>
    <input id="${id('apiKey')}" data-f="apiKey" style="${WIDE}" type="password" value="" placeholder="${esc(keyHint)}" autocomplete="new-password">
    <div style="font-size:11px;color:#90a4ae;margin-top:3px">Never shown again once saved. Changing the service or its host asks for it again.</div>
    <label for="${id('cap')}" style="${FIELD}">Monthly token limit (optional)</label>
    <input id="${id('cap')}" data-f="monthlyTokenCap" style="${WIDE}" type="number" min="${esc(answer.limits?.minTokenCap ?? 1000)}" step="1" value="${esc(config?.monthlyTokenCap ?? '')}" placeholder="${esc(suggestedCap)}">
    <div style="font-size:11px;color:#90a4ae;margin-top:3px">Suggested: ${esc(Number(suggestedCap).toLocaleString('en'))} tokens, about 30 analyses of a large batch
      (one takes up to about 66,000). Counted for you, on this company or provider.</div>
    <label for="${id('instruction')}" style="${FIELD}">Your own instruction, added to OSCAR's (optional)</label>
    <textarea id="${id('instruction')}" data-f="instruction" style="${WIDE}" rows="3" maxlength="${esc(answer.limits?.instruction ?? 2000)}">${esc(config?.instruction || '')}</textarea>
    <div><button class="btn" data-ai-action="suggest-instruction" style="margin-top:4px">Insert the suggested instruction</button></div>
    <template data-f="suggestedInstruction">${esc(answer.suggested?.instruction || '')}</template>
    <label for="${id('priceIn')}" style="${FIELD}">Price per million input tokens, US$ (only for a model OSCAR has no price for)</label>
    <input id="${id('priceIn')}" data-f="priceInput" style="${WIDE}" type="number" min="0" step="any" value="${esc(config?.priceInput ?? '')}">
    <label for="${id('priceOut')}" style="${FIELD}">Price per million output tokens, US$</label>
    <input id="${id('priceOut')}" data-f="priceOutput" style="${WIDE}" type="number" min="0" step="any" value="${esc(config?.priceOutput ?? '')}">
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

// ── The analysis (PR 3) ─────────────────────────────────────────────────────

const OWNER_LABEL = { provider: 'Provider', oscar: 'OSCAR', configuration: 'Configuration', unclear: 'Unclear' };
const OWNER_STYLE = { provider: 'background:#fff3e0;color:#e65100', oscar: 'background:#e3f2fd;color:#0d47a1', configuration: 'background:#f3e5f5;color:#6a1b9a', unclear: 'background:#eceff1;color:#455a64' };

/** The analysis card: where, which batches, which language. Filled by loadAnalysisTarget(). */
function analysisPanelHtml(targets) {
  if (!targets.length) return '';
  const options = targets.map(t => `<option value="${esc(t.id)}" data-provider="${t.provider ? '1' : ''}">${esc(t.name)}</option>`).join('');
  return `<div class="card" style="padding:16px 20px" id="ai-analysis">
    <h3 style="margin:0 0 4px">Analyse results</h3>
    <div style="font-size:12px;color:#78909c">One batch: what failed, grouped by probable cause. Two batches: what is fixed, still failing or new.
      You see exactly what will be sent before anything leaves OSCAR.</div>
    <label for="ai-an-target" style="${FIELD}">Company or provider</label>
    <select id="ai-an-target" data-ai-action="an-target" style="${WIDE}">${options}</select>
    <div id="ai-an-checklist" style="margin-top:10px"></div>
    <label for="ai-an-a" style="${FIELD}">Batch</label>
    <select id="ai-an-a" style="${WIDE}"></select>
    <label for="ai-an-b" style="${FIELD}">Compare with a later batch (optional)</label>
    <select id="ai-an-b" style="${WIDE}"></select>
    <label for="ai-an-lang" style="${FIELD}">Language of the answer</label>
    <select id="ai-an-lang" style="${WIDE}"></select>
    <label for="ai-an-model" style="${FIELD}">Model for this analysis</label>
    <select id="ai-an-model" style="${WIDE}"></select>
    <div style="font-size:11px;color:#90a4ae;margin-top:3px">Analyse the same batch with another model to compare the answers: tick two in the list below.</div>
    <div style="margin-top:12px"><button class="btn" data-ai-action="an-preview">See what will be sent</button></div>
    <div id="ai-an-preview" style="margin-top:12px"></div>
    <div id="ai-an-result" style="margin-top:12px"></div>
    <h4 style="margin:18px 0 6px">Earlier analyses</h4>
    <div id="ai-an-history" style="font-size:13px"></div>
    <div id="ai-an-compare" style="margin-top:12px"></div>
    <h4 style="margin:18px 0 6px">Spent on AI analysis</h4>
    <div id="ai-an-spend" style="font-size:13px"></div>
  </div>`;
}

/**
 * The provider's set-up checklist (#827): what was imported, what the model
 * is told of it, and the buttons to import another or remove it.
 */
function checklistHtml(c) {
  const input = `<label for="ai-an-checklist-file" style="${FIELD}">Import the filled set-up checklist (.docx)</label>
    <input id="ai-an-checklist-file" type="file" accept=".docx" data-ai-action="an-checklist-file" style="${WIDE}">`;
  if (!c) {
    return `<div style="font-size:12px;color:#78909c">Provider context: <strong>no checklist imported.</strong>
      The model is told the provider's answers to OSCAR's set-up checklist when one is imported: what it does not do, its test data, its remarks.</div>${input}`;
  }
  const by = c.importedBy ? ' by ' + esc(c.importedBy) : '';
  const cut = c.cut ? `, ${esc(c.cut)} left out for size` : '';
  const sent = `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px">What the model is told (${esc(Object.keys(c.sent || {}).length)} answers${cut})</summary>
    <pre style="white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto;background:#fafafa;padding:8px;border:1px solid #eceff1">${esc(JSON.stringify(c.sent || {}, null, 1))}</pre></details>`;
  return `<div style="font-size:12px;color:#37474f">Provider context: checklist <strong>${esc(c.fileName || '')}</strong>, ${esc(c.answers)} answers,
    imported ${esc(c.importedAt)}${by}. API Config and contact answers are never kept.
    <button class="btn" data-ai-action="an-checklist-remove" style="margin-left:6px">Remove</button></div>${sent}${input}`;
}

function batchLabel(b) {
  const when = b.started ? esc(b.started) : 'date unknown';
  return `${when} — ${esc(b.runs)} run(s), ${esc(b.finishedRuns)} finished`;
}

function batchOptionsHtml(batches, withNone) {
  const none = withNone ? '<option value="">(no comparison)</option>' : '';
  return none + batches.map(b => `<option value="${esc(b.batchId)}">${batchLabel(b)}</option>`).join('');
}

/** An amount in US dollars: cents, or more digits below one cent; a dash when unknown. */
function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
}

// The preview's cost, at the model's list price (#831).
function estimateText(p) {
  if (!p.estimatedCost) return 'OSCAR has no price for this model: its cost is not counted.';
  const own = p.price?.source === 'custom' ? 'your price' : 'list price';
  return `Estimated cost (${own}): about <strong>${usd(p.estimatedCost.input)}</strong> for what is sent, at most ${usd(p.estimatedCost.atMost)} with the answer.`;
}

/** What will be sent, its size and cost, and the button that sends it. */
function previewHtml(p) {
  const cap = p.monthly?.cap !== null && p.monthly?.cap !== undefined
    ? `${esc(p.monthly.used)} of your ${esc(p.monthly.cap)} tokens used this month.` : `${esc(p.monthly?.used ?? 0)} tokens used this month (no limit set).`;
  const counts = p.mode === 'compare'
    ? `${esc(p.counts.fixed)} problem(s) fixed, ${esc(p.counts.stillFailing)} still failing, ${esc(p.counts.new)} new, as OSCAR counts them.`
    : `${esc(p.counts.groups)} group(s) of failed checks.`;
  const summarised = p.summarisedByStep
    ? `<div style="${NOTE}background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;">Too large to send check by check: the failures are summarised by step.</div>` : '';
  const truncated = (p.batches || []).some(b => b.truncated)
    ? `<div style="${NOTE}background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;">A batch has more failed checks than OSCAR reads; only the first ones are sent.</div>` : '';
  const send = p.tooLarge
    ? `<div style="${NOTE}background:#ffebee;color:#b71c1c;border:1px solid #ffcdd2;">Too large to send, even summarised by step.</div>`
    : `<button class="btn btn-primary" data-ai-action="an-run">Send to ${esc(p.model)} and analyse</button>`;
  return `<div style="${NOTE}${INFO}">${counts}<br>About <strong>${esc(p.estimatedTokens)}</strong> tokens (${esc(p.chars)} characters) to ${esc(p.model)}, plus the answer. ${cap}<br>${estimateText(p)}</div>
    ${summarised}${truncated}
    <details style="margin-bottom:10px"><summary style="cursor:pointer;font-size:13px">Exactly what will be sent</summary>
      <div style="font-size:12px;color:#546e7a;margin:8px 0 4px">Instructions</div>
      <pre style="white-space:pre-wrap;font-size:11px;max-height:240px;overflow:auto;background:#fafafa;padding:8px;border:1px solid #eceff1">${esc(p.instructions)}</pre>
      <div style="font-size:12px;color:#546e7a;margin:8px 0 4px">Results</div>
      <pre style="white-space:pre-wrap;font-size:11px;max-height:360px;overflow:auto;background:#fafafa;padding:8px;border:1px solid #eceff1">${esc(p.input)}</pre>
    </details>
    ${send}`;
}

function listHtml(items) {
  if (!items.length) return '<span style="color:#90a4ae">none</span>';
  const lines = items.map(x => '<li>' + esc(x) + '</li>').join('');
  return `<ul style="margin:4px 0 0 18px;padding:0">${lines}</ul>`;
}

function groupRowHtml(g, n) {
  const owner = OWNER_LABEL[g.owner] ? g.owner : 'unclear';
  const badge = `<span style="font-size:11px;padding:2px 8px;border-radius:10px;${OWNER_STYLE[owner]}">${OWNER_LABEL[owner]}</span>`;
  const where = [g.steps?.length ? 'Steps: ' + g.steps.map(esc).join(', ') : '', g.scenarios?.length ? 'Scenarios: ' + g.scenarios.map(esc).join(', ') : '']
    .filter(Boolean).join('<br>');
  const why = g.why ? `<div style="color:#78909c;margin-top:4px">${esc(g.why)}</div>` : '';
  const action = g.action ? `<div style="margin-top:4px"><strong>Next:</strong> ${esc(g.action)}</div>` : '';
  const copy = owner === 'oscar'
    ? `<div style="margin-top:6px"><button class="btn" data-ai-action="an-copy-issue" data-group="${esc(n)}">Copy as an OSCAR issue</button></div>` : '';
  return `<tr><td style="${CELL}">${badge}</td><td style="${CELL}"><strong>${esc(g.title)}</strong><div>${esc(g.cause)}</div>${why}${action}
    <div style="font-size:11px;color:#90a4ae;margin-top:4px">${where}</div>${copy}</td></tr>`;
}

/** A group the model gives to OSCAR, as the text of a GitHub issue (Markdown). */
function issueText(g, a) {
  const list = (title, items) => (items?.length ? `\n**${title}:** ${items.join(', ')}` : '');
  return `## ${g.title}\n\n${g.cause}\n\n**Why OSCAR:** ${g.why || '—'}\n\n**Next:** ${g.action || '—'}\n${list('Steps', g.steps)}${list('Scenarios', g.scenarios)}\n\n`
    + `_From an AI analysis (${a.model}, ${a.createdAt}, id ${a.id}). An AI opinion, to be checked before acting on it._\n`;
}

function comparisonHtml(c) {
  if (!c) return '';
  return `<div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0">
    <div><strong style="color:#1b5e20">Fixed</strong>${listHtml(c.fixed || [])}</div>
    <div><strong style="color:#7a4f01">Still failing</strong>${listHtml(c.stillFailing || [])}</div>
    <div><strong style="color:#b71c1c">New</strong>${listHtml(c.new || [])}</div></div>`;
}

/** One stored analysis, as the history read gives it. */
function resultHtml(a) {
  const head = `<div style="font-size:12px;color:#78909c;margin-bottom:8px">${esc(a.createdAt)} · ${esc(a.by || '')} · ${esc(a.model)} ·
    ${a.mode === 'compare' ? 'two batches compared' : 'one batch'}${a.summarisedByStep ? ' · summarised by step' : ''}</div>`;
  if (a.status === 'running') return head + `<div style="${NOTE}${INFO}">⏳ The AI service is reading the results…</div>`;
  if (a.status === 'failed' || a.status === 'interrupted') {
    return head + `<div style="${NOTE}background:#ffebee;color:#b71c1c;border:1px solid #ffcdd2;">${a.status === 'interrupted' ? 'Interrupted (the server restarted).' : esc(a.error || 'Failed.')}</div>`;
  }
  if (a.status === 'unreadable') {
    return head + `<div style="${NOTE}background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;">The answer could not be read as asked (${esc(a.error)}). Here it is as it came:</div>
      <pre style="white-space:pre-wrap;font-size:12px">${esc(a.result?.raw || '')}</pre>`;
  }
  const r = a.result || {};
  const rows = (r.groups || []).map((g, n) => groupRowHtml(g, n)).join('');
  const groups = rows ? '<div class="table-wrap"><table style="border-collapse:collapse;font-size:13px">' + rows + '</table></div>' : '';
  return head + `<div style="${NOTE}background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;">An AI opinion: it can be wrong, and it is not a test result or a finding.</div>
    <p style="font-size:13px;line-height:1.55">${esc(r.summary || '')}</p>${comparisonHtml(r.comparison)}
    ${groups}
    <div style="font-size:11px;color:#90a4ae;margin-top:8px">Tokens: ${esc(a.tokens?.input ?? '?')} in, ${esc(a.tokens?.output ?? '?')} out · Cost: ${usd(a.cost)}.</div>`;
}

const STATUS_LABEL = { running: 'Running', done: 'Done', failed: 'Failed', unreadable: 'Answer not readable', interrupted: 'Interrupted' };

// Analyses sent the same input share a letter (#831): A, B… by first seen.
function inputLetters(list) {
  const letters = new Map();
  for (const a of list) {
    if (a.contentHash && list.filter(x => x.contentHash === a.contentHash).length > 1 && !letters.has(a.contentHash)) {
      letters.set(a.contentHash, String.fromCodePoint(65 + (letters.size % 26)));
    }
  }
  return letters;
}

/** The earlier analyses of a company or provider. */
function historyHtml(list) {
  if (!list.length) return '<span style="color:#90a4ae">None yet.</span>';
  const letters = inputLetters(list);
  const rows = list.map(a => {
    const same = letters.get(a.contentHash);
    const input = same ? `<span title="Same input as the other analyses marked ${same}" style="font-size:11px;padding:1px 6px;border-radius:8px;background:#e8eaf6;color:#283593">${same}</span>` : '';
    return `<tr><td style="${CELL}"><input type="checkbox" data-ai-action="an-pick" value="${esc(a.id)}" aria-label="Compare this analysis" style="width:auto"></td>
    <td style="${CELL}">${esc(a.createdAt)}</td><td style="${CELL}">${esc(a.by || '')}</td>
    <td style="${CELL}">${a.mode === 'compare' ? 'Compare' : 'One batch'}</td><td style="${CELL}">${esc(a.model)}</td><td style="${CELL}">${input}</td>
    <td style="${CELL}">${esc(STATUS_LABEL[a.status] || a.status)}</td><td style="${CELL}">${usd(a.cost)}</td>
    <td style="${CELL}"><button class="btn" data-ai-action="an-show" data-id="${esc(a.id)}">Show</button></td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table style="border-collapse:collapse;font-size:13px">
    <thead><tr><th style="${CELL}"></th><th style="${CELL}">When</th><th style="${CELL}">By</th><th style="${CELL}">What</th><th style="${CELL}">Model</th><th style="${CELL}">Input</th><th style="${CELL}">Status</th><th style="${CELL}">Cost</th><th style="${CELL}"></th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div style="margin-top:8px"><button class="btn" data-ai-action="an-side">Show the two ticked side by side</button>
    <span style="font-size:11px;color:#90a4ae">Analyses with the same letter were sent the same input.</span></div>`;
}

/** Two analyses side by side (#831), saying whether they were sent the same input. */
function sideBySideHtml(a, b) {
  const same = a.contentHash && a.contentHash === b.contentHash;
  const note = same
    ? `<div style="${NOTE}${OK}">Both were sent the same input: the differences are the models' (${esc(a.model)}, ${esc(b.model)}).</div>`
    : `<div style="${NOTE}background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;">The inputs differ (other batches, results, findings or settings): compare with care.</div>`;
  const column = (x) => `<div style="flex:1 1 380px;min-width:0;border:1px solid #eceff1;border-radius:6px;padding:10px"><h4 style="margin:0 0 6px">${esc(x.model)}</h4>${resultHtml(x)}</div>`;
  return note + `<div style="display:flex;gap:12px;flex-wrap:wrap">${column(a)}${column(b)}</div>`;
}

function spendRow(label, s) {
  const unpriced = s.unpriced ? ` (${esc(s.unpriced)} without a price)` : '';
  return `<tr><td style="${CELL}">${esc(label)}</td><td style="${CELL}">${esc(s.analyses)}</td><td style="${CELL}">${esc(Number(s.tokens).toLocaleString('en'))}</td><td style="${CELL}">${usd(s.cost)}${unpriced}</td></tr>`;
}

/** What the analyses of this company or provider cost (#831), at list prices. */
function spendHtml(s) {
  const head = `<thead><tr><th style="${CELL}"></th><th style="${CELL}">Analyses</th><th style="${CELL}">Tokens</th><th style="${CELL}">Cost</th></tr></thead>`;
  const table = (rows) => `<div class="table-wrap"><table style="border-collapse:collapse;font-size:13px">${head}<tbody>${rows}</tbody></table></div>`;
  const mine = s.mine?.cap === null || s.mine?.cap === undefined
    ? `Your use this month: ${esc(Number(s.mine?.used ?? 0).toLocaleString('en'))} tokens (no limit set).`
    : `Your use this month: ${esc(Number(s.mine.used).toLocaleString('en'))} of your ${esc(Number(s.mine.cap).toLocaleString('en'))} tokens.`;
  const months = (s.months || []).map(m => spendRow(m.month, m)).join('');
  const models = (s.models || []).map(m => spendRow(m.model, m)).join('');
  return `<div style="font-size:12px;color:#78909c;margin-bottom:6px">Every Test Manager's analyses here, at the model's list price in US dollars
    (or the price entered for a model OSCAR does not know). An estimate: the AI service's invoice is what counts. ${mine}</div>
    ${table(spendRow('Today', s.today) + spendRow('This month', s.month))}
    ${months ? '<div style="font-size:12px;color:#546e7a;margin:10px 0 4px">Per month</div>' + table(months) : ''}
    ${models ? '<div style="font-size:12px;color:#546e7a;margin:10px 0 4px">This month, per model</div>' + table(models) : ''}`;
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
  if (current) current.configured = approved.filter((t, n) => answers[n]?.config);
  return approved.map((t, n) => (answers[n] ? serviceHtml(t, answers[n], n) : '')).join('');
}

async function load() {
  const root = document.getElementById('ai-root');
  const res = await fetch('/v1/company/ai-analysis/access');
  document.getElementById('loading').style.display = 'none';
  if (!res.ok) { show(await readError(res, 'Could not read your access.'), 'error'); return; }
  current = await res.json();
  root.innerHTML = accessHtml(current) + await servicesHtml(current.targets || []) + analysisPanelHtml(current.configured || []);
  root.style.display = 'block';
  if ((current.configured || []).length) await loadAnalysisTarget().catch(err => show(err.message, 'error'));
}

function fieldsOf(section) {
  const value = (f) => section.querySelector(`[data-f="${f}"]`).value;
  return { connector: value('connector'), baseUrl: value('baseUrl'), model: value('model'), apiKey: value('apiKey'),
    monthlyTokenCap: value('monthlyTokenCap'), instruction: value('instruction'),
    priceInput: value('priceInput'), priceOutput: value('priceOutput') };
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
// The list of models is Anthropic's only (#831).
function connectorChanged(section) {
  const chosen = (current?.connectorsShown || []).find(c => c.id === section.querySelector('[data-f="connector"]').value);
  const address = section.querySelector('[data-f="baseUrl"]');
  const defaults = (current?.connectorsShown || []).map(c => c.defaultBaseUrl);
  if (chosen && (address.value === '' || defaults.includes(address.value))) address.value = chosen.defaultBaseUrl;
  section.querySelector('[data-f="modelList"]').style.display = chosen?.id === 'anthropic' ? '' : 'none';
}

// A model chosen in the list goes into the field; "another model" leaves the field to type in.
function modelPicked(section) {
  const picked = section.querySelector('[data-f="modelPick"]').value;
  const field = section.querySelector('[data-f="model"]');
  if (picked) field.value = picked;
  else field.focus();
}

// The models the service offers now, with the stored or the typed key (#831).
async function refreshModels(section) {
  const f = fieldsOf(section);
  showResult(section, '⏳ Asking the service for its models…');
  const res = await fetch('/v1/company/ai-analysis/config/models', inTarget(section, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connector: f.connector, baseUrl: f.baseUrl, apiKey: f.apiKey }) }));
  if (!res.ok) { showResult(section, testResultHtml({ ok: false, error: await readError(res, 'The list of models could not be read.') })); return; }
  const { models } = await res.json();
  section.querySelector('[data-f="modelPick"]').innerHTML = modelOptionsHtml(models, f.model);
  showResult(section, `<div style="${NOTE}${OK}">${esc(models.length)} model(s) offered by the service. Prices are OSCAR's list; a model without one shows none.</div>`);
}

function insertSuggestedInstruction(section) {
  const text = section.querySelector('[data-f="suggestedInstruction"]').content.textContent;
  const box = section.querySelector('[data-f="instruction"]');
  if (box.value.trim() && !confirm('Replace your instruction with the suggested one?')) return;
  box.value = text;
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

// The analysis card's company or provider, as a header naming it.
function analysisHeaders(extra = {}) {
  const sel = document.getElementById('ai-an-target');
  const opt = sel.options[sel.selectedIndex];
  return { ...extra, 'X-Provider-Id': opt?.dataset.provider ? sel.value : '' };
}

async function loadAnalysisTarget() {
  document.getElementById('ai-an-preview').innerHTML = '';
  document.getElementById('ai-an-result').innerHTML = '';
  const res = await fetch('/v1/company/ai-analysis/batches', { headers: analysisHeaders() });
  if (!res.ok) { show(await readError(res, 'Could not read the batches.'), 'error'); return; }
  const data = await res.json();
  document.getElementById('ai-an-a').innerHTML = batchOptionsHtml(data.batches || [], false);
  document.getElementById('ai-an-b').innerHTML = batchOptionsHtml(data.batches || [], true);
  document.getElementById('ai-an-lang').innerHTML = (data.languages || ['English']).map(l => `<option>${esc(l)}</option>`).join('');
  document.getElementById('ai-an-compare').innerHTML = '';
  await loadModels();
  await loadChecklist();
  await loadHistory();
  await loadSpend();
}

/** The models an analysis may use (#831): the configured one first, then the list for Anthropic. */
function analysisModelOptionsHtml(answer) {
  const configured = answer?.config?.model || '';
  const listed = answer?.config?.connector === 'anthropic' ? (answer.models || []).filter(m => m.id !== configured) : [];
  const first = configured ? `<option value="${esc(configured)}" selected>${esc(configured)} (configured)</option>` : '';
  return first + listed.map(m => `<option value="${esc(m.id)}">${esc(m.label)} (${esc(m.id)})${esc(priceText(m))}</option>`).join('');
}

async function loadModels() {
  const res = await fetch('/v1/company/ai-analysis/config', { headers: analysisHeaders() });
  document.getElementById('ai-an-model').innerHTML = res.ok ? analysisModelOptionsHtml(await res.json()) : '';
}

async function loadSpend() {
  const res = await fetch('/v1/company/ai-analysis/spend', { headers: analysisHeaders() });
  const el = document.getElementById('ai-an-spend');
  el.innerHTML = res.ok ? spendHtml(await res.json()) : esc(await readError(res, 'Could not read what was spent.'));
}

// The two analyses ticked in the history, side by side (#831).
async function showSideBySide() {
  const ids = [...document.querySelectorAll('[data-ai-action="an-pick"]:checked')].map(el => el.value);
  const box = document.getElementById('ai-an-compare');
  if (ids.length !== 2) { show('Tick two analyses to show them side by side.', 'error'); return; }
  const read = async (id) => {
    const res = await fetch('/v1/company/ai-analysis/history/' + encodeURIComponent(id), { headers: analysisHeaders() });
    if (!res.ok) throw new Error(await readError(res, 'Could not read the analysis.'));
    return res.json();
  };
  const [a, b] = await Promise.all(ids.map(read));
  box.innerHTML = sideBySideHtml(a, b);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadChecklist() {
  const el = document.getElementById('ai-an-checklist');
  const res = await fetch('/v1/company/ai-analysis/checklist', { headers: analysisHeaders() });
  el.innerHTML = res.ok ? checklistHtml((await res.json()).checklist) : esc(await readError(res, 'Could not read the checklist.'));
}

async function importChecklist(input) {
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append('checklist', file);
  const res = await fetch('/v1/company/ai-analysis/checklist', { method: 'POST', headers: analysisHeaders(), body: form });
  if (!res.ok) { show(await readError(res, 'The checklist could not be imported.'), 'error'); input.value = ''; return; }
  const { checklist } = await res.json();
  show(`Checklist imported: ${checklist.answers} answers.`, 'ok');
  previewed = null;
  document.getElementById('ai-an-preview').innerHTML = '';
  document.getElementById('ai-an-checklist').innerHTML = checklistHtml(checklist);
}

async function removeChecklist() {
  if (!confirm('Remove the imported checklist? The model will no longer be told its answers.')) return;
  const res = await fetch('/v1/company/ai-analysis/checklist', { method: 'DELETE', headers: analysisHeaders() });
  if (!res.ok) { show(await readError(res, 'The checklist could not be removed.'), 'error'); return; }
  show('Checklist removed.', 'ok');
  previewed = null;
  document.getElementById('ai-an-preview').innerHTML = '';
  await loadChecklist();
}

async function loadHistory() {
  const res = await fetch('/v1/company/ai-analysis/history', { headers: analysisHeaders() });
  const el = document.getElementById('ai-an-history');
  el.innerHTML = res.ok ? historyHtml((await res.json()).analyses || []) : esc(await readError(res, 'Could not read the earlier analyses.'));
}

let previewed = null;

function analysisChoice() {
  const a = document.getElementById('ai-an-a').value;
  const b = document.getElementById('ai-an-b').value;
  // The comparison reads the batch chosen first as the earlier one; the server orders them by date.
  return { batches: b ? [a, b] : [a], language: document.getElementById('ai-an-lang').value, model: document.getElementById('ai-an-model').value };
}

async function previewAnalysis() {
  const box = document.getElementById('ai-an-preview');
  box.innerHTML = '⏳ Reading the results…';
  const choice = analysisChoice();
  const res = await fetch('/v1/company/ai-analysis/preview', { method: 'POST', headers: analysisHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(choice) });
  if (!res.ok) { box.innerHTML = testResultHtml({ ok: false, error: await readError(res, 'The preview failed.') }); return; }
  const p = await res.json();
  previewed = { ...choice, hash: p.hash };
  box.innerHTML = previewHtml(p);
}

async function showAnalysis(id) {
  const res = await fetch('/v1/company/ai-analysis/history/' + encodeURIComponent(id), { headers: analysisHeaders() });
  const box = document.getElementById('ai-an-result');
  if (!res.ok) { box.innerHTML = testResultHtml({ ok: false, error: await readError(res, 'Could not read the analysis.') }); return null; }
  const a = await res.json();
  shownAnalysis = a;
  box.innerHTML = resultHtml(a);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return a;
}

let shownAnalysis = null;

// #827: the text of an OSCAR issue for a group of the analysis shown, to the clipboard.
async function copyIssue(n) {
  const g = shownAnalysis?.result?.groups?.[Number(n)];
  if (!g) return;
  const text = issueText(g, shownAnalysis);
  try {
    await navigator.clipboard.writeText(text);
    show('Copied: paste it in a new issue of the OSCAR repository.', 'ok');
  } catch {
    window.prompt('Copy this text into a new OSCAR issue:', text);
  }
}

async function runAnalysis() {
  if (!previewed) return;
  if (!confirm('Send these results to the AI service and analyse them? Your account with it is billed.')) return;
  const res = await fetch('/v1/company/ai-analysis/run', { method: 'POST', headers: analysisHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(previewed) });
  if (!res.ok) { document.getElementById('ai-an-preview').innerHTML += testResultHtml({ ok: false, error: await readError(res, 'The analysis could not start.') }); return; }
  const { id } = await res.json();
  document.getElementById('ai-an-preview').innerHTML = '';
  previewed = null;
  await followAnalysis(id, 120);
  await loadHistory();
  await loadSpend();
}

// Show a running analysis every 3 s until it ends, at most `left` more times.
async function followAnalysis(id, left) {
  const a = await showAnalysis(id);
  if (a?.status !== 'running' || left <= 0) return;
  await new Promise(r => setTimeout(r, 3000));
  await followAnalysis(id, left - 1);
}

document.addEventListener('change', (e) => {
  if (e.target.closest('[data-ai-action="an-target"]')) loadAnalysisTarget().catch(err => show(err.message, 'error'));
  else if (e.target.closest('[data-ai-action="an-checklist-file"]')) importChecklist(e.target).catch(err => show(err.message, 'error'));
  else if (e.target.closest('#ai-an-a, #ai-an-b, #ai-an-lang, #ai-an-model')) { previewed = null; document.getElementById('ai-an-preview').innerHTML = ''; }
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-ai-action="an-preview"], [data-ai-action="an-run"], [data-ai-action="an-show"], [data-ai-action="an-checklist-remove"], [data-ai-action="an-copy-issue"], [data-ai-action="an-side"]');
  if (!el) return;
  const act = el.dataset.aiAction;
  let job;
  if (act === 'an-preview') job = previewAnalysis();
  else if (act === 'an-run') job = runAnalysis();
  else if (act === 'an-checklist-remove') job = removeChecklist();
  else if (act === 'an-copy-issue') job = copyIssue(el.dataset.group);
  else if (act === 'an-side') job = showSideBySide();
  else job = showAnalysis(el.dataset.id);
  job.catch(err => show(err.message, 'error'));
});

document.addEventListener('change', (e) => {
  if (e.target.closest('[data-ai-action="accept"], [data-ai-action="target"]')) updateButton();
  const kind = e.target.closest('[data-ai-action="connector"]');
  if (kind) connectorChanged(kind.closest('[data-ai-target]'));
  const pick = e.target.closest('[data-ai-action="model-pick"]');
  if (pick) modelPicked(pick.closest('[data-ai-target]'));
});
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-ai-action="request"]');
  if (el) requestAccess().catch(err => show(err.message, 'error'));
  const service = e.target.closest('[data-ai-action="test"], [data-ai-action="save"], [data-ai-action="remove"]');
  if (service) {
    const section = service.closest('[data-ai-target]');
    serviceAction(section, service.dataset.aiAction).catch(err => showResult(section, testResultHtml({ ok: false, error: err.message })));
  }
  const models = e.target.closest('[data-ai-action="models"]');
  if (models) {
    const section = models.closest('[data-ai-target]');
    refreshModels(section).catch(err => showResult(section, testResultHtml({ ok: false, error: err.message })));
  }
  const suggest = e.target.closest('[data-ai-action="suggest-instruction"]');
  if (suggest) insertSuggestedInstruction(suggest.closest('[data-ai-target]'));
});

if (typeof window !== 'undefined' && document.getElementById('ai-root')) {
  load().catch(err => show(err.message, 'error'));
}
