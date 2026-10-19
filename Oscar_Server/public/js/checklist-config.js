/* global esc, oscarToast, oscarToastAfterNav */  // esc.js, nav.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklist-config.js — Test Config's "Provider checklist" box (#862).
 *
 * A Test Manager imports the provider's filled set-up checklist. Each import
 * is kept with its date. An import changes nothing: the box shows what
 * applying it would change, set against the checklist applied before (the
 * answers changed, the Test Framework values, the Test Data added or
 * removed), and the Test Manager applies it, after a confirmation, or
 * discards it. Testers see nothing. The *Html functions are pure (lifted by
 * the page test); the rest is wiring.
 */

const CHECKLIST_BOX_STYLE = 'padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5;margin-bottom:14px;background:#eceff1;color:#37474f;border:1px solid #cfd8dc;';
const CHECKLIST_STATUS = { waiting: 'waiting for a decision', applied: 'applied', discarded: 'discarded' };

// A value of the framework as a short text.
function checklistValueText(value) {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function checklistImportLine(item) {
  const by = item.importedBy ? `, by ${esc(item.importedBy)}` : '';
  const decided = item.decidedAt ? ` ${esc(item.decidedAt)}` : '';
  const status = esc(CHECKLIST_STATUS[item.status] || item.status || '');
  return `${esc(item.fileName || 'checklist')} — imported ${esc(item.importedAt || '')}${by} — ${status}${decided}`;
}

// A count read from an answer, as a number whatever the answer holds.
function checklistCount(list) {
  return Array.isArray(list) ? Number(list.length) : 0;
}

/** The box: the last checklist applied, the import control and the list of imports. */
function checklistBoxHtml(imports) {
  const list = Array.isArray(imports) ? imports : [];
  const applied = list.find(i => i.status === 'applied');
  const status = applied
    ? `Last applied: ${esc(applied.fileName || 'checklist')}, imported ${esc(applied.importedAt || '')}, applied ${esc(applied.decidedAt || '')}.`
    : 'No checklist applied yet.';
  let history = '';
  if (list.length) {
    const items = list.map(i => '<li>' + checklistImportLine(i) + '</li>').join('');
    history = `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px">Imports kept (${checklistCount(list)})</summary>
        <ul style="margin:6px 0 0 18px;padding:0;font-size:12px">${items}</ul></details>`;
  }
  return `<div style="${CHECKLIST_BOX_STYLE}"><strong>📋 Provider checklist</strong> — ${status}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label for="checklist-file" style="font-size:12px">Import a filled checklist (.docx)</label>
      <input id="checklist-file" type="file" accept=".docx" data-checklist-action="import">
    </div>
    <div style="font-size:11px;color:#78909c;margin-top:6px">The checklist sets up the Test Framework and the Test Data. Importing it changes nothing: you see what would change, then apply or discard it. Its answers are kept with the date (never the API and contact answers); the file itself is not.</div>
    ${history}
    <div id="checklist-preview"></div></div>`;
}

const CHECKLIST_TH = 'text-align:left;border-bottom:1px solid #cfd8dc;padding:2px 6px';
const CHECKLIST_TD = 'vertical-align:top;border-bottom:1px solid #eceff1;padding:2px 6px;overflow-wrap:anywhere';

function checklistHeadCell(h, i) {
  const width = i === 0 ? 'width:26%;' : '';
  return '<th style="' + width + CHECKLIST_TH + '">' + esc(h) + '</th>';
}

function checklistRow(r) {
  return '<tr>' + r.map(c => '<td style="' + CHECKLIST_TD + '">' + esc(c) + '</td>').join('') + '</tr>';
}

// The first column names a question or a setting: wide enough to stay on one line.
function checklistTable(rows, head) {
  const heads = head.map(checklistHeadCell).join('');
  const body = rows.map(checklistRow).join('');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px"><thead><tr>${heads}</tr></thead>
    <tbody>${body}</tbody></table>`;
}

function checklistList(items) {
  const lis = items.map(i => '<li>' + esc(i) + '</li>').join('');
  return `<ul style="margin:4px 0 0 18px;padding:0;font-size:12px">${lis}</ul>`;
}

function checklistHeadHtml(p) {
  const imp = p.import;
  let against = 'No checklist was applied before: everything below is new.';
  if (p.previous) {
    const kind = p.previous.kind === 'ai_analysis' ? 'the checklist imported for the AI analysis' : 'the checklist applied before';
    against = `Compared with ${kind}: ${esc(p.previous.fileName || 'checklist')}, imported ${esc(p.previous.importedAt || '')}.`;
  }
  return `<div><strong>${esc(imp.fileName || 'Checklist')}</strong>, imported ${esc(imp.importedAt || '')} — ${esc(CHECKLIST_STATUS[imp.status] || imp.status)}. ${against}</div>`;
}

function checklistAnswersHtml(changes) {
  if (!Array.isArray(changes)) return '';
  if (!changes.length) return '<div style="margin-top:8px"><strong>Answers changed:</strong> none.</div>';
  const table = checklistTable(changes.map(c => [c.question, c.before ?? '—', c.after ?? '—']), ['Question', 'Before', 'Now']);
  return `<details open style="margin-top:8px"><summary style="cursor:pointer"><strong>Answers changed (${checklistCount(changes)})</strong></summary>${table}</details>`;
}

function checklistFrameworkHtml(fw) {
  const changes = Array.isArray(fw.changes) ? fw.changes : [];
  const title = fw.created ? 'Test Framework (created)' : 'Test Framework';
  let html = `<div style="margin-top:8px"><strong>${title}:</strong> no change.</div>`;
  if (changes.length) {
    const open = changes.length <= 30 ? 'open ' : '';
    const table = checklistTable(changes.map(c => [c.path, checklistValueText(c.before), checklistValueText(c.after)]), ['Setting', 'Now', 'After']);
    html = `<details ${open}style="margin-top:8px"><summary style="cursor:pointer"><strong>${title}: ${checklistCount(changes)} value(s) change</strong></summary>${table}</details>`;
  }
  if (Array.isArray(fw.unplaced) && fw.unplaced.length) {
    html += `<div style="margin-top:4px;color:#7a4f01">Answers OSCAR cannot place in the framework (set them by hand if needed):${checklistList(fw.unplaced)}</div>`;
  }
  return html;
}

function checklistResourceText(r) {
  const kind = r.type === 'JOURNEY' ? 'Journey' : 'Train set';
  return kind + ': ' + r.label;
}

function checklistTestDataHtml(td, p) {
  const add = Array.isArray(td.add) ? td.add : [];
  const remove = Array.isArray(td.remove) ? td.remove : [];
  const replace = td.mode === 'replace';
  const html = [`<div style="margin-top:8px"><strong>Test Data</strong>
    <span style="margin-left:8px;font-size:12px">
      <input type="radio" id="checklist-td-add" name="checklist-td" value="add" data-checklist-action="mode"${replace ? '' : ' checked'}> <label for="checklist-td-add">add to the trains and journeys there</label>
      <input type="radio" id="checklist-td-replace" name="checklist-td" value="replace" data-checklist-action="mode"${replace ? ' checked' : ''} style="margin-left:8px"> <label for="checklist-td-replace">replace them</label>
    </span></div>`];
  const added = add.length
    ? `<div style="font-size:12px">Added (${checklistCount(add)}):${checklistList(add.map(checklistResourceText))}</div>`
    : '<div style="font-size:12px">Nothing to add.</div>';
  html.push(added);
  if (td.alreadyThere) html.push(`<div style="font-size:12px">Already there, left as they are: ${Number(td.alreadyThere)}.</div>`);
  if (remove.length) html.push(`<div style="font-size:12px;color:#b71c1c">Removed (${checklistCount(remove)}):${checklistList(remove.map(r => r.label || r.type || ''))}</div>`);
  if (Array.isArray(p.skipped) && p.skipped.length) html.push(`<div style="font-size:12px;margin-top:4px;color:#7a4f01">From the checklist, not built:${checklistList(p.skipped)}</div>`);
  if (Array.isArray(p.notes) && p.notes.length) html.push(`<div style="font-size:12px;margin-top:4px;color:#7a4f01">To check:${checklistList(p.notes)}</div>`);
  return html.join('');
}

/** What applying a checklist would change, with the buttons to decide. */
function checklistPreviewHtml(p) {
  if (!p?.import) return '';
  const parts = [
    checklistHeadHtml(p),
    checklistAnswersHtml(p.answerChanges),
    checklistFrameworkHtml(p.framework || {}),
    checklistTestDataHtml(p.testData || {}, p),
  ];
  if (p.import.status === 'waiting') {
    parts.push(`<div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn btn-success btn-sm" data-checklist-action="apply">Apply these changes</button>
      <button class="btn btn-secondary btn-sm" data-checklist-action="discard">Discard this checklist</button></div>`);
  }
  return `<div style="margin-top:10px;padding:10px;border-radius:6px;background:#fff;border:1px solid #cfd8dc;color:#263238">${parts.join('')}</div>`;
}

// An import id from an answer: a positive integer, else null.
function checklistIdOf(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

(function () {
  if (typeof document === 'undefined') return;
  const box = document.getElementById('checklist-config');
  if (!box) return;
  let user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch { user = {}; }
  if (user.role !== 'test_manager') return;
  let current = null;   // the preview shown

  async function detailOf(res, fallback) {
    try { return (await res.json()).detail || fallback; } catch { return fallback; }
  }
  const previewBox = () => document.getElementById('checklist-preview');
  function showPreview(p) {
    current = p;
    const at = previewBox();
    if (at) at.innerHTML = checklistPreviewHtml(p);
  }

  async function refresh() {
    const res = await fetch('/v1/company/checklists');
    if (!res.ok) { box.innerHTML = ''; return; }
    const { imports } = await res.json();
    box.innerHTML = checklistBoxHtml(imports);
    const waiting = (imports || []).find(i => i.status === 'waiting');
    if (waiting) await loadPreview(waiting.id, 'add');
  }

  async function loadPreview(value, mode) {
    const id = checklistIdOf(value);
    if (id === null) return;
    const testData = mode === 'replace' ? 'replace' : 'add';
    const res = await fetch(`/v1/company/checklists/${id}/preview?testData=${testData}`);
    if (!res.ok) { oscarToast(await detailOf(res, 'The preview could not be made.'), 'error'); return; }
    showPreview(await res.json());
  }

  async function importFile(file) {
    const form = new FormData();
    form.append('checklist', file, file.name);
    const res = await fetch('/v1/company/checklists', { method: 'POST', body: form });
    if (!res.ok) { oscarToast(await detailOf(res, 'The checklist could not be imported.'), 'error'); return; }
    const preview = await res.json();
    await refresh();
    showPreview(preview);
  }

  async function apply() {
    if (!current) return;
    const mode = current.testData?.mode || 'add';
    const removing = mode === 'replace' ? '\n\nThe trains and journeys now in the Test Data are removed first.' : '';
    if (!confirm(`Apply this checklist to the Test Framework and the Test Data, as shown?${removing}\n\nThe scenarios, the endpoint and the credentials are not changed.`)) return;
    const id = checklistIdOf(current.import.id);
    if (id === null) return;
    const res = await fetch(`/v1/company/checklists/${id}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hash: current.hash, testData: mode }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      oscarToast(body.detail || 'Something changed since this preview.', 'error');
      if (body.preview) showPreview(body.preview);
      return;
    }
    if (!res.ok) { oscarToast(await detailOf(res, 'The checklist could not be applied.'), 'error'); return; }
    oscarToastAfterNav('The checklist is applied to the Test Framework and the Test Data.', 'success');
    window.location.reload();
  }

  async function discard() {
    if (!current || !confirm('Discard this checklist? It stays in the list of imports.')) return;
    const id = checklistIdOf(current.import.id);
    if (id === null) return;
    const res = await fetch(`/v1/company/checklists/${id}/discard`, { method: 'POST' });
    if (!res.ok) { oscarToast(await detailOf(res, 'The checklist could not be discarded.'), 'error'); return; }
    current = null;
    await refresh();
  }

  const report = err => oscarToast(err.message, 'error');
  box.addEventListener('change', (e) => {
    const input = e.target.closest('[data-checklist-action="import"]');
    if (input?.files?.[0]) importFile(input.files[0]).catch(report);
    const mode = e.target.closest('[data-checklist-action="mode"]');
    if (mode && current) loadPreview(current.import.id, mode.value).catch(report);
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-checklist-action="apply"]')) apply().catch(report);
    if (e.target.closest('[data-checklist-action="discard"]')) discard().catch(report);
  });
  refresh().catch(() => { box.innerHTML = ''; });
})();
