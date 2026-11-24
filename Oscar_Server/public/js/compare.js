/* global oscarReportError, parseServerTs */  // nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of compare.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const token = localStorage.getItem('oscar_token') || '';
if (!localStorage.getItem('oscar_user')) window.location.href = '/';
const company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
// logout() provided by nav.js

const params = new URLSearchParams(location.search);
const runAId = params.get('a');
const runBId = params.get('b');
if (!runAId || !runBId) window.location.href = '/dashboard.html';

let allItems  = [];
let activeFilter = 'ALL';

const LABELS = {
  PASSED_TO_FAILED: '❌ Passed → Failed',
  FAILED_TO_PASSED: '✅ Failed → Passed',
  ADDED:            '➕ Added',
  REMOVED:          '➖ Removed',
  UNCHANGED_FAIL:   '⬜ Unchanged (Fail)',
  UNCHANGED_PASS:   '✔ Unchanged (Pass)'
};

// v1.11.7 — parseServerTs (nav.js) handles SQLite's TZ-less UTC strings.
function fmtDate(d) { return d ? parseServerTs(d).toLocaleString() : '-'; }

function renderDiff(data) {
  const s = data.summary;
  document.getElementById('main').innerHTML = `
    <div class="run-cards">
      <div class="run-card">
        <h4>Run A (baseline)</h4>
        <div class="url">${esc(data.run_a.api_base || '-')}</div>
        <div style="color:#90a4ae;font-size:12px;margin-top:4px">${esc(fmtDate(data.run_a.queued_at))}</div>
      </div>
      <div style="display:flex;align-items:center;font-size:22px;color:#90a4ae;padding-top:8px">→</div>
      <div class="run-card">
        <h4>Run B (latest)</h4>
        <div class="url">${esc(data.run_b.api_base || '-')}</div>
        <div style="color:#90a4ae;font-size:12px;margin-top:4px">${esc(fmtDate(data.run_b.queued_at))}</div>
      </div>
    </div>

    <div class="summary">
      <div class="tile tile-p2f"><div class="n">${esc(s.passed_to_failed)}</div><div class="l">Passed → Failed</div></div>
      <div class="tile tile-f2p"><div class="n">${esc(s.failed_to_passed)}</div><div class="l">Failed → Passed</div></div>
      <div class="tile tile-add"><div class="n">${esc(s.added)}</div><div class="l">Added</div></div>
      <div class="tile tile-rem"><div class="n">${esc(s.removed)}</div><div class="l">Removed</div></div>
      <div class="tile tile-uf" ><div class="n">${esc(s.unchanged_fail)}</div><div class="l">Unchanged Fail</div></div>
      <div class="tile tile-up" ><div class="n">${esc(s.unchanged_pass)}</div><div class="l">Unchanged Pass</div></div>
    </div>

    <div class="filter-bar">
      <span style="font-size:12px;color:#546e7a;font-weight:700">Filter:</span>
      ${['ALL','PASSED_TO_FAILED','FAILED_TO_PASSED','ADDED','REMOVED','UNCHANGED_FAIL','UNCHANGED_PASS'].map(f =>
        `<button class="filter-btn fb-${f} ${f==='ALL'?'active':''}" data-filter="${f}" id="fb-${f}">
          ${f === 'ALL' ? `All (${esc(s.total)})` : LABELS[f]}
        </button>`
      ).join('')}
    </div>

    <div id="diff-list"></div>
  `;

  allItems = data.items || [];
  renderItems();
}

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`fb-${f}`).classList.add('active');
  renderItems();
}

// The error line of a comparison item: run B's error, or run A's when the
// item was removed.
function diffErrorHtml(item) {
  if (item.run_b?.error) return `<div class="diff-error">${esc(item.run_b.error)}</div>`;
  if (item.run_a?.error && item.category === 'REMOVED') return `<div class="diff-error">${esc(item.run_a.error)}</div>`;
  return '';
}

function renderItems() {
  const filtered = activeFilter === 'ALL' ? allItems : allItems.filter(i => i.category === activeFilter);
  const el = document.getElementById('diff-list');
  if (!filtered.length) { el.innerHTML = '<div class="empty">No items match this filter.</div>'; return; }
  el.innerHTML = filtered.map(item => {
    const error = diffErrorHtml(item);
    return `<div class="diff-item">
      <div class="diff-header">
        <span class="cat-badge cat-${esc(item.category)}">${esc(LABELS[item.category] || item.category)}</span>
        <div class="diff-path">
          <div class="suite">${esc(item.suite)} › ${esc(item.request)}</div>
          <div style="margin-top:2px">${esc(item.assertion)}</div>
        </div>
      </div>
      ${error}
    </div>`;
  }).join('');
}

// S11: the one shared escaper (js/esc.js). Was {&,<,>}-only; now also " and '.
const esc = window.esc;

async function loadComparison() {
  const res = await fetch('/v1/reports/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_a_id: runAId, run_b_id: runBId })
  });
  const data = await res.json();
  if (!res.ok) {
    document.getElementById('main').innerHTML = `<div class="empty">⚠️ ${esc(data.detail || data.title || 'Failed to compute comparison.')}</div>`;
    return;
  }
  renderDiff(data);
}

document.getElementById('main').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-filter]');
  if (btn) setFilter(btn.dataset.filter);
});

loadComparison().catch(oscarReportError);
