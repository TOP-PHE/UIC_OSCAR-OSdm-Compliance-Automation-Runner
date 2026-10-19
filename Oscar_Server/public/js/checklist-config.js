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
  return `${esc(item.fileName || 'checklist')} — imported ${esc(item.importedAt || '')}${by} — ${esc(CHECKLIST_STATUS[item.status] || item.status || '')}${item.decidedAt ? ` ${esc(item.decidedAt)}` : ''}`;
}

/** The box: the last checklist applied, the import control and the list of imports. */
function checklistBoxHtml(imports) {
  const list = Array.isArray(imports) ? imports : [];
  const applied = list.find(i => i.status === 'applied');
  const status = applied
    ? `Last applied: ${esc(applied.fileName || 'checklist')}, imported ${esc(applied.importedAt || '')}, applied ${esc(applied.decidedAt || '')}.`
    : 'No checklist applied yet.';
  const history = list.length
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px">Imports kept (${list.length})</summary>
        <ul style="margin:6px 0 0 18px;padding:0;font-size:12px">${list.map(i => `<li>${checklistImportLine(i)}</li>`).join('')}</ul></details>`
    : '';
  return `<div style="${CHECKLIST_BOX_STYLE}"><strong>📋 Provider checklist</strong> — ${status}
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label for="checklist-file" style="font-size:12px">Import a filled checklist (.docx)</label>
      <input id="checklist-file" type="file" accept=".docx" data-checklist-action="import">
    </div>
    <div style="font-size:11px;color:#78909c;margin-top:6px">The checklist sets up the Test Framework and the Test Data. Importing it changes nothing: you see what would change, then apply or discard it. Its answers are kept with the date (never the API and contact answers); the file itself is not.</div>
    ${history}
    <div id="checklist-preview"></div></div>`;
}

// The first column names a question or a setting: wide enough to stay on one line.
function checklistTable(rows, head) {
  const width = i => (i === 0 ? 'width:26%;' : '');
  return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:4px"><thead><tr>${head.map((h, i) => `<th style="${width(i)}text-align:left;border-bottom:1px solid #cfd8dc;padding:2px 6px">${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map(c => `<td style="vertical-align:top;border-bottom:1px solid #eceff1;padding:2px 6px;overflow-wrap:anywhere">${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function checklistList(items) {
  return `<ul style="margin:4px 0 0 18px;padding:0;font-size:12px">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

/** What applying a checklist would change, with the buttons to decide. */
function checklistPreviewHtml(p) {
  if (!p?.import) return '';
  const imp = p.import;
  const parts = [];
  let against = 'No checklist was applied before: everything below is new.';
  if (p.previous) {
    const kind = p.previous.kind === 'ai_analysis' ? 'the checklist imported for the AI analysis' : 'the checklist applied before';
    against = `Compared with ${kind}: ${esc(p.previous.fileName || 'checklist')}, imported ${esc(p.previous.importedAt || '')}.`;
  }
  parts.push(`<div><strong>${esc(imp.fileName || 'Checklist')}</strong>, imported ${esc(imp.importedAt || '')} — ${esc(CHECKLIST_STATUS[imp.status] || imp.status)}. ${against}</div>`);

  if (Array.isArray(p.answerChanges)) {
    parts.push(p.answerChanges.length
      ? `<details open style="margin-top:8px"><summary style="cursor:pointer"><strong>Answers changed (${p.answerChanges.length})</strong></summary>${checklistTable(p.answerChanges.map(c => [c.question, c.before ?? '—', c.after ?? '—']), ['Question', 'Before', 'Now'])}</details>`
      : '<div style="margin-top:8px"><strong>Answers changed:</strong> none.</div>');
  }

  const fw = p.framework || {};
  const fwChanges = Array.isArray(fw.changes) ? fw.changes : [];
  const fwTitle = fw.created ? 'Test Framework (created)' : 'Test Framework';
  parts.push(fwChanges.length
    ? `<details ${fwChanges.length <= 30 ? 'open ' : ''}style="margin-top:8px"><summary style="cursor:pointer"><strong>${fwTitle}: ${fwChanges.length} value(s) change</strong></summary>${checklistTable(fwChanges.map(c => [c.path, checklistValueText(c.before), checklistValueText(c.after)]), ['Setting', 'Now', 'After'])}</details>`
    : `<div style="margin-top:8px"><strong>${fwTitle}:</strong> no change.</div>`);
  if (Array.isArray(fw.unplaced) && fw.unplaced.length) {
    parts.push(`<div style="margin-top:4px;color:#7a4f01">Answers OSCAR cannot place in the framework (set them by hand if needed):${checklistList(fw.unplaced)}</div>`);
  }

  const td = p.testData || {};
  const add = Array.isArray(td.add) ? td.add : [];
  const remove = Array.isArray(td.remove) ? td.remove : [];
  const replace = td.mode === 'replace';
  parts.push(`<div style="margin-top:8px"><strong>Test Data</strong>
    <span style="margin-left:8px;font-size:12px">
      <input type="radio" id="checklist-td-add" name="checklist-td" value="add" data-checklist-action="mode"${replace ? '' : ' checked'}> <label for="checklist-td-add">add to the trains and journeys there</label>
      <input type="radio" id="checklist-td-replace" name="checklist-td" value="replace" data-checklist-action="mode"${replace ? ' checked' : ''} style="margin-left:8px"> <label for="checklist-td-replace">replace them</label>
    </span></div>`);
  parts.push(add.length ? `<div style="font-size:12px">Added (${add.length}):${checklistList(add.map(r => `${r.type === 'JOURNEY' ? 'Journey' : 'Train set'}: ${r.label}`))}</div>` : '<div style="font-size:12px">Nothing to add.</div>');
  if (td.alreadyThere) parts.push(`<div style="font-size:12px">Already there, left as they are: ${Number(td.alreadyThere)}.</div>`);
  if (remove.length) parts.push(`<div style="font-size:12px;color:#b71c1c">Removed (${remove.length}):${checklistList(remove.map(r => r.label || r.type || ''))}</div>`);
  if (Array.isArray(p.skipped) && p.skipped.length) parts.push(`<div style="font-size:12px;margin-top:4px;color:#7a4f01">From the checklist, not built:${checklistList(p.skipped)}</div>`);
  if (Array.isArray(p.notes) && p.notes.length) parts.push(`<div style="font-size:12px;margin-top:4px;color:#7a4f01">To check:${checklistList(p.notes)}</div>`);

  if (imp.status === 'waiting') {
    parts.push(`<div style="margin-top:10px;display:flex;gap:8px">
      <button class="btn btn-success btn-sm" data-checklist-action="apply">Apply these changes</button>
      <button class="btn btn-secondary btn-sm" data-checklist-action="discard">Discard this checklist</button></div>`);
  }
  return `<div style="margin-top:10px;padding:10px;border-radius:6px;background:#fff;border:1px solid #cfd8dc;color:#263238">${parts.join('')}</div>`;
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

  async function loadPreview(id, mode) {
    const res = await fetch(`/v1/company/checklists/${encodeURIComponent(id)}/preview?testData=${encodeURIComponent(mode)}`);
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
    const res = await fetch(`/v1/company/checklists/${encodeURIComponent(current.import.id)}/apply`, {
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
    const res = await fetch(`/v1/company/checklists/${encodeURIComponent(current.import.id)}/discard`, { method: 'POST' });
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
