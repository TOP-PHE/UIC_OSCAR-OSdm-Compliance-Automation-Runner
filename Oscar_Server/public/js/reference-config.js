/* global esc, oscarToast, oscarToastAfterNav */  // esc.js, nav.js
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reference-config.js — Test Config's "Reference configuration" box (#838).
 *
 * A company or provider testing the OSDM simulator follows one of the
 * repository's reference configurations (simulator-alpha…). The box says
 * which, whether the stored configuration is the reference's current one,
 * and lets a Test Manager choose the reference and update from it. A tester
 * sees the state only. `referenceBoxHtml(state, isTestManager)` is pure
 * (lifted by the page test); the rest is wiring.
 */

const REFERENCE_BOX_STYLE = 'padding:12px 14px;border-radius:6px;font-size:13px;line-height:1.5;margin-bottom:14px;';

function referenceBoxHtml(state, isTestManager) {
  const s = state || {};
  const available = Array.isArray(s.available) ? s.available : [];
  if (!s.linked && !isTestManager) return '';
  let status = 'Follows no reference: its configuration is its own.';
  let tone = 'background:#eceff1;color:#37474f;border:1px solid #cfd8dc;';
  if (s.linked && s.missing) {
    status = `Follows ${esc(s.linked)}, which this server cannot read.`;
    tone = 'background:#ffebee;color:#b71c1c;border:1px solid #ffcdd2;';
  } else if (s.linked && s.up_to_date) {
    status = `Follows ${esc(s.linked)}: up to date (updated ${esc(s.applied_at || '')}).`;
    tone = 'background:#e8f5e9;color:#1b5e20;border:1px solid #c8e6c9;';
  } else if (s.linked) {
    status = s.applied_version
      ? `Follows ${esc(s.linked)}: the reference has changed since the last update (${esc(s.applied_at || '')}).`
      : `Follows ${esc(s.linked)}: not updated from it yet.`;
    tone = 'background:#fff8e1;color:#7a4f01;border:1px solid #ffe082;';
  }
  let controls = '';
  if (isTestManager) {
    const options = ['<option value="">None (its own configuration)</option>']
      .concat(available.map(r => `<option value="${esc(r.name)}"${r.name === s.linked ? ' selected' : ''}>${esc(r.name)} (OSDM ${esc(r.osdmVersion || '?')})</option>`))
      .join('');
    const update = s.linked && !s.missing
      ? '<button class="btn btn-success btn-sm" data-ref-action="apply">Update from the reference</button>'
      : '';
    controls = `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <label for="ref-name" style="font-size:12px">Reference</label>
      <select id="ref-name" data-ref-action="link" style="max-width:320px">${options}</select>
      ${update}
    </div>
    <div style="font-size:11px;color:#78909c;margin-top:6px">Only for a company or provider that tests the OSDM simulator. The update replaces the scenarios (the current data file is kept as the previous one), the Test Framework and the Test Data with the repository's; the endpoint and the credentials are not changed. Scenarios a tester added are replaced too.</div>`;
  }
  return `<div style="${REFERENCE_BOX_STYLE}${tone}"><strong>🔗 Reference configuration</strong> — ${status}${controls}</div>`;
}

(function () {
  if (typeof document === 'undefined') return;
  const box = document.getElementById('reference-config');
  if (!box) return;
  let user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch { user = {}; }
  const isTestManager = user.role === 'test_manager';

  async function detailOf(res, fallback) {
    try { return (await res.json()).detail || fallback; } catch { return fallback; }
  }

  async function refresh() {
    const res = await fetch('/v1/company/reference');
    if (!res.ok) { box.innerHTML = ''; return; }
    box.innerHTML = referenceBoxHtml(await res.json(), isTestManager);
  }

  async function link(name) {
    const res = await fetch('/v1/company/reference', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name || null }) });
    if (!res.ok) { oscarToast(await detailOf(res, 'The reference could not be chosen.'), 'error'); return; }
    box.innerHTML = referenceBoxHtml(await res.json(), isTestManager);
  }

  async function apply() {
    if (!confirm('Replace the scenarios, the Test Framework and the Test Data with the reference configuration?\n\nThe current data file is kept as the previous one ("Restore previous file"). Scenarios a tester added are replaced too. The endpoint and the credentials are not changed.')) return;
    const res = await fetch('/v1/company/reference/apply', { method: 'POST' });
    if (!res.ok) { oscarToast(await detailOf(res, 'The reference configuration could not be applied.'), 'error'); return; }
    oscarToastAfterNav('Updated from the reference configuration.', 'success');
    window.location.reload();
  }

  box.addEventListener('change', (e) => {
    if (e.target.closest('[data-ref-action="link"]')) link(e.target.value).catch(err => oscarToast(err.message, 'error'));
  });
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-ref-action="apply"]')) apply().catch(err => oscarToast(err.message, 'error'));
  });
  refresh().catch(() => { box.innerHTML = ''; });
})();
