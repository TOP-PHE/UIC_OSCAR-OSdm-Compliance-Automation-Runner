/* global oscarToast, parseServerTs */  // defined in nav.js / pages (S11b)
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * findings.js — "Test Findings & Open Points" page.
 *
 * A per-test-system, threaded conformance dialogue. OSCAR's analysis opens a
 * finding; the test team replies and settles a category / severity / status.
 * Soft-worded on purpose — a finding may be the provider's deviation OR OSCAR's
 * own issue; the thread decides. A finding the team baselines (step + documented
 * HTTP status) is projected server-side into the datafile's knownDeviations[] so
 * the #398 engine reports it as documented instead of FAILED.
 *
 * Reads: any of the vendor's own users. Writes: test_manager only (server-gated
 * too — the UI just hides the controls for testers).
 */
(function () {

  // ── State ───────────────────────────────────────────────────────────────────
  var state = {
    user: {},
    isTM: false,
    findings: [],     // list rows (+ commentCount)
    openId: null,     // id of the expanded finding (thread view), or null
    thread: null,     // { finding, comments } for the open finding
    form: null,       // { mode:'create'|'edit', id, fields:{...} } when composing
    replyText: '',    // draft reply for the open thread
    importing: false, // JSON-import view open
    importText: '',   // pasted import JSON
    suggest: null,    // #735 "Suggested from runs" view: { batches, batchId, analysis, drafts, oscarIssues, rejected, edits, busy }
    openCats: {},     // category → expanded?      (accordion level 1, collapsed by default)
    openGroups: {},   // 'category|status' → expanded? (accordion level 2, collapsed by default)
    scenarioCodes: [] // datafile scenario.code list — autocomplete source for "which scenario revealed this" (#447)
  };

  // ── Soft-label vocabularies ──────────────────────────────────────────────────
  var CAT_LABELS = {
    open:               'Open point',
    provider_deviation: 'Provider deviation',
    oscar_issue:        'OSCAR issue',
    not_supported:      'Not supported',
    spec_question:      'Spec question'
  };
  var SEV_LABELS = { major: 'Major', minor: 'Minor', not_supported: 'Not supported' };
  // Lifecycle labels. The stored status values (open/discussing/resolved) are
  // unchanged — these are the words the test team thinks in: New (not yet
  // reviewed) → WIP (under discussion) → Closed (settled).
  var ST_LABELS  = { open: 'New', discussing: 'WIP', resolved: 'Closed' };
  var LIFECYCLE = [
    { key: 'open',       label: 'New',    hint: 'not yet reviewed',   fg: '#a85b00', bg: '#fff8e1' },
    { key: 'discussing', label: 'WIP',    hint: 'discussion ongoing', fg: '#1565c0', bg: '#e3f2fd' },
    { key: 'resolved',   label: 'Closed', hint: 'settled',            fg: '#2e7d32', bg: '#e8f5e9' }
  ];
  // Category groups, in the order they appear in the accordion.
  var CAT_ORDER = ['provider_deviation', 'oscar_issue', 'not_supported', 'spec_question', 'open'];

  // ── Tiny utilities ───────────────────────────────────────────────────────────
  // S11: the one shared escaper (js/esc.js, loaded before findings.js).
  const esc = window.esc;
  function fmtTs(s) {
    try { return (typeof parseServerTs === 'function' ? parseServerTs(s) : new Date(s)).toLocaleString(); }
    catch (_e) { return String(s || ''); }
  }
  function toast(m, k) { if (typeof oscarToast === 'function') oscarToast(m, k); }
  function closestAction(el) {
    while (el && el !== document.body) { if (el.dataset && el.dataset.action) return el; el = el.parentElement; }
    return null;
  }
  function liveFinding(id) {
    if (state.thread && state.thread.finding && state.thread.finding.id === id) return state.thread.finding;
    for (var i = 0; i < state.findings.length; i++) if (state.findings[i].id === id) return state.findings[i];
    return null;
  }

  async function api(method, url, body) {
    var init = { method: method, headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    var res = await fetch(url, init);
    var data = null;
    try { data = await res.json(); } catch (_e) { /* may be empty */ }
    if (!res.ok) throw new Error((data && (data.detail || data.title)) || ('HTTP ' + res.status));
    return data;
  }

  // ── Boot + data refresh ──────────────────────────────────────────────────────
  function boot() {
    try { state.user = JSON.parse(localStorage.getItem('oscar_user') || '{}'); } catch (_e) { state.user = {}; }
    state.isTM = state.user.role === 'test_manager';
    loadFindings();
    loadScenarioCodes();
  }

  // Best-effort autocomplete source for "which scenario revealed this" (#447).
  // No datafile yet, or the fetch fails, just leaves the list empty — the
  // scenario field still works as free text either way.
  async function loadScenarioCodes() {
    try {
      var df = await api('GET', '/v1/company/datafile');
      state.scenarioCodes = (df.scenarios || []).map(function (s) { return s.code; }).filter(Boolean);
      if (state.form || state.thread) render();
    } catch (_e) { /* no datafile yet — fine */ }
  }

  async function loadFindings() {
    document.getElementById('loading').style.display = '';
    document.getElementById('findings-root').style.display = 'none';
    try {
      var data = await api('GET', '/v1/company/findings');
      state.findings = data.findings || [];
      document.getElementById('loading').style.display = 'none';
      document.getElementById('findings-root').style.display = '';
      render();
    } catch (e) {
      document.getElementById('loading').innerHTML = '❌ ' + esc(e.message);
    }
  }

  async function refresh() {
    var data = await api('GET', '/v1/company/findings');
    state.findings = data.findings || [];
    if (state.openId) {
      try { state.thread = await api('GET', '/v1/company/findings/' + encodeURIComponent(state.openId)); }
      catch (_e) { state.openId = null; state.thread = null; }
    }
    render();
  }

  // ── Render dispatch ──────────────────────────────────────────────────────────
  function render() {
    var ha = document.getElementById('header-actions');
    ha.innerHTML = (state.isTM && !state.form && !state.importing && !state.suggest)
      ? '<button class="btn btn-success" data-action="compose-new">＋ Open a finding</button>'
        + ' <button class="btn btn-secondary" data-action="suggest-open" title="Group a batch\'s failures into draft findings for you to accept, edit or reject">🧩 Suggested from runs</button>'
        + ' <button class="btn btn-secondary" data-action="import-open" title="Import findings from a JSON array (e.g. OSCAR\'s analysis for this test-system)">⬆ Import</button>'
      : '';
    var root = document.getElementById('findings-root');
    if (state.suggest) { root.innerHTML = renderSuggest(state.suggest); return; }
    if (state.importing) { root.innerHTML = renderImport(); return; }
    if (state.form) { root.innerHTML = renderForm(state.form); return; }
    if (state.openId && state.thread) { root.innerHTML = renderThread(state.thread); return; }
    root.innerHTML = renderList();
  }

  // ── List view — category accordion ───────────────────────────────────────────
  // Findings group by category (collapsed by default). Each category header shows
  // the New/WIP/Closed breakdown; expanding it reveals the lifecycle sub-groups
  // (also collapsed), and expanding one of those lists its findings. Both levels
  // remember their open/closed state across re-renders (state.openCats/openGroups).
  function renderList() {
    if (!state.findings.length) {
      return '<div class="card"><div class="card-body" style="padding:24px;text-align:center;color:#78909c">'
        + '<div style="font-size:15px;font-weight:700;color:#455a64;margin-bottom:6px">No findings recorded yet</div>'
        + '<div style="font-size:13px;max-width:560px;margin-left:auto;margin-right:auto">'
        + 'Open points raised here become the conformance record for this test-system — searchable, threaded, and a feed for OSDM working-group feedback.'
        + (state.isTM ? ' Use <strong>＋ Open a finding</strong> to add one.' : '')
        + '</div></div></div>';
    }

    // Bucket findings by category, in the configured order (unknown categories last).
    var groups = {};
    state.findings.forEach(function (f) {
      var c = f.category || 'open';
      (groups[c] || (groups[c] = [])).push(f);
    });
    var cats = CAT_ORDER.filter(function (c) { return groups[c] && groups[c].length; });
    Object.keys(groups).forEach(function (c) { if (cats.indexOf(c) === -1) cats.push(c); });

    var anyOpen = cats.some(function (c) { return state.openCats[c]; });
    var head = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">'
      + '<div style="font-size:12px;color:#78909c;flex:1;min-width:0">' + summarise(state.findings) + '</div>'
      + '<button class="btn btn-secondary btn-sm" data-action="' + (anyOpen ? 'collapse-all' : 'expand-all') + '">'
        + (anyOpen ? '⊟ Collapse all' : '⊞ Expand all') + '</button>'
      + '</div>';

    return head + cats.map(function (c) { return renderCatGroup(c, groups[c]); }).join('');
  }

  function lifecycleCounts(list) {
    var by = { open: 0, discussing: 0, resolved: 0 };
    list.forEach(function (f) { var s = f.status || 'open'; if (by[s] == null) by[s] = 0; by[s]++; });
    return by;
  }

  function summarise(list) {
    var by = lifecycleCounts(list), baselined = 0, osdm = 0;
    list.forEach(function (f) { if (f.baselineInRun) baselined++; if (f.raiseToOsdm) osdm++; });
    var parts = [list.length + ' finding' + (list.length === 1 ? '' : 's')];
    if (by.open)       parts.push(by.open + ' new');
    if (by.discussing) parts.push(by.discussing + ' WIP');
    if (by.resolved)   parts.push(by.resolved + ' closed');
    if (baselined)     parts.push(baselined + ' baselined into runs');
    if (osdm)          parts.push(osdm + ' flagged for OSDM');
    return parts.join(' · ');
  }

  function caret(open) {
    return '<span style="display:inline-block;width:12px;font-size:10px;color:#90a4ae">' + (open ? '▾' : '▸') + '</span>';
  }

  // "New 9 · WIP 0 · Closed 0" breakdown for a category header. Zero buckets stay
  // visible but muted so the full lifecycle is always legible at a glance.
  function lifecycleChips(counts) {
    return '<div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">' + LIFECYCLE.map(function (lc) {
      var n = counts[lc.key] || 0, on = n > 0;
      return '<span title="' + esc(lc.label + ' — ' + lc.hint) + '" style="font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px;'
        + (on ? ('background:' + lc.bg + ';color:' + lc.fg) : 'background:#f4f6f7;color:#cfd8dc') + '">'
        + esc(lc.label) + ' ' + n + '</span>';
    }).join('') + '</div>';
  }

  // Level 1: a category group (collapsed by default).
  function renderCatGroup(cat, list) {
    var counts = lifecycleCounts(list);
    var open = !!state.openCats[cat];
    var h = '<div class="card" style="margin-bottom:10px">';
    h += '<div class="card-head" style="cursor:pointer;gap:10px" data-action="toggle-cat" data-cat="' + esc(cat) + '">'
       + '<div style="display:flex;align-items:center;gap:9px;flex:1;min-width:0">'
         + caret(open) + catBadge(cat)
         + '<span style="font-size:12px;color:#b0bec5">' + list.length + ' total</span>'
       + '</div>'
       + lifecycleChips(counts)
       + '</div>';
    if (open) {
      // Always render all three lifecycle buckets so the structure is constant;
      // empty ones come back muted + inert (nothing to expand).
      h += '<div class="card-body" style="padding:8px 12px 10px">'
        + LIFECYCLE.map(function (lc) {
            return renderStatusGroup(cat, lc, list.filter(function (f) { return (f.status || 'open') === lc.key; }));
          }).join('')
        + '</div>';
    }
    h += '</div>';
    return h;
  }

  // Level 2: a lifecycle (New/WIP/Closed) sub-group inside a category (collapsed
  // by default — you expand the one you want). An empty bucket is shown muted and
  // inert so the three statuses are always visible.
  function renderStatusGroup(cat, lc, list) {
    if (!list.length) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;background:#f7f9fa;margin-bottom:6px;opacity:.55">'
        + '<span style="display:inline-block;width:12px"></span>'
        + '<span style="font-size:12px;font-weight:700;color:#b0bec5">' + lc.label + '</span>'
        + '<span style="font-size:11px;color:#cfd8dc">' + lc.hint + '</span>'
        + '<span style="margin-left:auto;font-size:12px;font-weight:700;color:#cfd8dc">0</span>'
        + '</div>';
    }
    var key = cat + '|' + lc.key;
    var open = !!state.openGroups[key];
    var h = '<div style="margin-bottom:' + (open ? '10px' : '6px') + '">';
    h += '<div style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;background:' + lc.bg + '" data-action="toggle-group" data-cat="' + esc(cat) + '" data-status="' + lc.key + '">'
       + caret(open)
       + '<span style="font-size:12px;font-weight:700;color:' + lc.fg + '">' + lc.label + '</span>'
       + '<span style="font-size:11px;color:' + lc.fg + '99">' + lc.hint + '</span>'
       + '<span style="margin-left:auto;font-size:12px;font-weight:800;color:' + lc.fg + '">' + list.length + '</span>'
       + '</div>';
    if (open) {
      h += '<div style="padding:8px 2px 2px">' + list.map(renderCard).join('') + '</div>';
    }
    h += '</div>';
    return h;
  }

  // A finding row inside a (category → lifecycle) group. The group headers already
  // carry the category + lifecycle, so the row stays lean: severity, title, the
  // run/OSDM flags, and the reply count.
  function renderCard(f) {
    return '<div class="card" style="margin-bottom:8px">'
      + '<div class="card-head" style="cursor:pointer" data-action="open-finding" data-id="' + esc(f.id) + '">'
        + '<div class="card-head-title" style="text-transform:none;font-size:13px;letter-spacing:0;color:#263238;flex:1;min-width:0">'
          + sevDot(f.severity) + esc(f.title) + '</div>'
        + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">'
          + (f.baselineInRun ? '<span class="badge badge-in-run" title="Projected into runs as a documented deviation">⚙ in runs</span>' : '')
          + (f.raiseToOsdm ? '<span class="badge badge-info" title="Flagged as OSDM feedback">📣 OSDM</span>' : '')
          + '<span style="font-size:12px;color:#90a4ae" title="replies">💬 ' + (f.commentCount || 0) + '</span>'
        + '</div>'
      + '</div>'
      + ((f.scenarioCode || f.step || f.expectedStatus != null)
          ? '<div style="padding:0 18px 11px 18px;font-size:12px;color:#607d8b">'
            + (f.scenarioCode ? scenarioLink(f.scenarioCode) + (f.step ? ' &middot; ' : '') : '')
            + (f.step ? 'Step <code>' + esc(f.step) + '</code>' : '')
            + (f.expectedStatus != null ? ' &middot; documented HTTP <strong>' + esc(f.expectedStatus) + '</strong>' : '')
            + '</div>'
          : '')
      + '</div>';
  }

  // Link to Test Config with the scenario code visible — the fastest path to
  // re-select and re-run the exact scenario that revealed this finding (#447).
  function scenarioLink(code) {
    return '🧪 <a href="/scenarios.html" title="Open Test Config to find and re-run this scenario" style="color:#0277bd;text-decoration:none"><code>' + esc(code) + '</code></a>';
  }

  function setAllCats(open) {
    if (!open) { state.openCats = {}; state.openGroups = {}; return; }
    var seen = {};
    state.findings.forEach(function (f) { seen[f.category || 'open'] = true; });
    Object.keys(seen).forEach(function (c) { state.openCats[c] = true; });
  }

  // ── Thread view (the dialogue) ───────────────────────────────────────────────
  function renderThread(t) {
    var f = t.finding, comments = t.comments || [];
    var h = '<div style="margin-bottom:12px"><button class="btn btn-secondary btn-sm" data-action="close-thread">← All findings</button></div>';

    // Opening post
    h += '<div class="card" style="margin-bottom:14px">';
    h += '<div class="card-head"><div class="card-head-title" style="text-transform:none;font-size:14px;letter-spacing:0;color:#263238;flex:1;min-width:0">'
       + sevDot(f.severity) + esc(f.title) + '</div>'
       + '<div style="display:flex;gap:6px;align-items:center;flex-shrink:0">' + catBadge(f.category) + statusBadge(f.status)
       + (f.baselineInRun ? '<span class="badge badge-in-run">⚙ in runs</span>' : '')
       + (f.raiseToOsdm ? '<span class="badge badge-info">📣 OSDM</span>' : '') + '</div></div>';
    h += '<div class="card-body" style="padding:16px 18px">';
    h += '<div style="font-size:11px;color:#90a4ae;margin-bottom:12px">Opened by <strong>' + esc(f.createdBy || '—') + '</strong> · ' + esc(fmtTs(f.createdAt))
       + (f.scenarioCode ? ' &nbsp;·&nbsp; ' + scenarioLink(f.scenarioCode) : '')
       + ((f.step || f.expectedStatus != null) ? ' &nbsp;·&nbsp; step <code>' + esc(f.step || '—') + '</code>' + (f.expectedStatus != null ? ' → HTTP ' + esc(f.expectedStatus) : '') : '')
       + '</div>';
    if (f.observed)       h += block('Observed', f.observed);
    if (f.interpretation) h += block('OSCAR’s reading', f.interpretation);
    if (f.evidence)       h += block('Evidence', f.evidence);

    if (state.isTM) {
      h += '<div style="border-top:1px dashed #e0e0e0;margin-top:14px;padding-top:12px">';
      h += ctrlRow('Category', pillSet('set-category', f.id, CAT_LABELS, f.category));
      h += ctrlRow('Severity', pillSet('set-severity', f.id, SEV_LABELS, f.severity));
      h += ctrlRow('Status',   pillSet('set-status',   f.id, ST_LABELS,  f.status));
      h += ctrlRow('Runs',     baselineControl(f));
      h += ctrlRow('OSDM',     '<span class="pill' + (f.raiseToOsdm ? ' selected' : '') + '" data-action="toggle-osdm" data-id="' + esc(f.id) + '">📣 Raise to OSDM working group</span>');
      h += '<div style="margin-top:12px;display:flex;gap:8px">'
         + '<button class="btn btn-secondary btn-sm" data-action="edit-finding" data-id="' + esc(f.id) + '">✎ Edit</button>'
         + '<button class="btn btn-danger btn-sm" data-action="delete-finding" data-id="' + esc(f.id) + '">🗑 Delete</button></div>';
      h += '</div>';
    }
    h += '</div></div>';

    // Discussion
    h += '<div class="card-head-title" style="margin:6px 4px 10px">💬 Discussion (' + comments.length + ')</div>';
    if (!comments.length) {
      h += '<div style="font-size:12px;color:#90a4ae;margin:0 4px 12px">No replies yet'
        + (state.isTM ? ' — start the conversation below.' : '.') + '</div>';
    }
    comments.forEach(function (c) {
      h += '<div class="card" style="margin-bottom:8px"><div class="card-body" style="padding:12px 16px">'
        + '<div style="font-size:11px;color:#90a4ae;margin-bottom:5px"><strong style="color:#546e7a">' + esc(c.author) + '</strong>' + roleTag(c.role) + ' · ' + esc(fmtTs(c.createdAt)) + '</div>'
        + '<div style="font-size:13px;color:#37474f;line-height:1.6;white-space:pre-wrap">' + esc(c.body) + '</div>'
        + '</div></div>';
    });

    if (state.isTM) {
      h += '<div class="card" style="margin-top:4px"><div class="card-body" style="padding:12px 16px">'
        + '<textarea class="param-input" data-action="set-reply-text" placeholder="Reply — agree, argue the spec reading, add context…" style="min-height:74px;resize:vertical">' + esc(state.replyText || '') + '</textarea>'
        + '<div style="margin-top:8px;text-align:right"><button class="btn btn-primary btn-sm" data-action="post-reply" data-id="' + esc(f.id) + '">Post reply</button></div>'
        + '</div></div>';
    }
    return h;
  }

  function block(label, text) {
    return '<div style="margin-bottom:10px">'
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#90a4ae;margin-bottom:3px">' + esc(label) + '</div>'
      + '<div style="font-size:13px;color:#37474f;line-height:1.6;white-space:pre-wrap">' + esc(text) + '</div></div>';
  }
  function ctrlRow(label, inner) {
    return '<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:7px">'
      + '<div style="width:62px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#90a4ae;flex-shrink:0;padding-top:5px">' + esc(label) + '</div>'
      + '<div class="pill-group" style="margin:0;flex:1">' + inner + '</div></div>';
  }
  function pillSet(action, id, labels, cur) {
    return Object.keys(labels).map(function (k) {
      return '<span class="pill' + (cur === k ? ' selected' : '') + '" data-action="' + action + '" data-id="' + esc(id) + '" data-value="' + k + '">' + esc(labels[k]) + '</span>';
    }).join('');
  }
  function baselineControl(f) {
    if (f.expectedStatus == null || !f.step) {
      return '<span style="font-size:11px;color:#b0bec5;padding-top:5px;display:inline-block">needs a step + documented HTTP status to baseline</span>';
    }
    return '<span class="pill' + (f.baselineInRun ? ' selected' : '') + '" data-action="toggle-baseline" data-id="' + esc(f.id) + '">'
      + '⚙ Baseline in runs — report HTTP ' + esc(f.expectedStatus) + ' as documented, not FAILED</span>';
  }

  // ── Badges ───────────────────────────────────────────────────────────────────
  function catBadge(cat) {
    var map = {
      open:               ['Open point',         'badge-info'],
      provider_deviation: ['Provider deviation', 'badge-refund'],
      oscar_issue:        ['OSCAR issue',         'badge-exchange'],
      not_supported:      ['Not supported',       'badge-not-in-run'],
      spec_question:      ['Spec question',       'badge-info']
    };
    var m = map[cat] || ['—', 'badge-info'];
    return '<span class="badge ' + m[1] + '">' + esc(m[0]) + '</span>';
  }
  function statusBadge(st) {
    var map = { open: ['#fff8e1', '#a85b00', 'Open'], discussing: ['#e3f2fd', '#1565c0', 'Discussing'], resolved: ['#e8f5e9', '#2e7d32', 'Resolved'] };
    var m = map[st] || map.open;
    return '<span class="badge" style="background:' + m[0] + ';color:' + m[1] + ';border:1px solid ' + m[1] + '33">' + esc(m[2]) + '</span>';
  }
  function sevDot(sev) {
    var c = sev === 'major' ? '#c62828' : sev === 'minor' ? '#ef6c00' : sev === 'not_supported' ? '#90a4ae' : '#cfd8dc';
    return '<span title="' + esc(sev ? ('severity: ' + sev) : 'unclassified') + '" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' + c + ';margin-right:8px;flex-shrink:0"></span>';
  }
  function roleTag(role) {
    if (!role) return '';
    var m = { test_manager: 'Test Mgr', company_user: 'Tester', oscar: 'OSCAR', administrator: 'Admin' };
    return ' <span style="font-size:9px;color:#b0bec5">(' + esc(m[role] || role) + ')</span>';
  }

  // ── Compose / edit form ──────────────────────────────────────────────────────
  function blankForm(mode) {
    return { mode: mode, id: null, fields: {
      title: '', step: '', scenarioCode: '', expectedStatus: '', observed: '', interpretation: '', evidence: '',
      category: 'open', severity: null, baselineInRun: false, raiseToOsdm: false } };
  }
  function renderForm(form) {
    var x = form.fields;
    function inp(field, ph, extra) { return '<input class="param-input" data-action="form-field" data-field="' + field + '" value="' + esc(x[field] || '') + '" placeholder="' + esc(ph) + '"' + (extra || '') + '>'; }
    function ta(field, ph) { return '<textarea class="param-input" data-action="form-field" data-field="' + field + '" placeholder="' + esc(ph) + '" style="min-height:64px;resize:vertical">' + esc(x[field] || '') + '</textarea>'; }
    var h = '<div class="card" style="margin-bottom:14px;border:1px solid #b3e5fc">';
    h += '<div class="card-head"><div class="card-head-title">' + (form.mode === 'edit' ? '✎ Edit finding' : '＋ Open a finding') + '</div></div>';
    h += '<div class="card-body" style="padding:16px 18px">';
    h += field('Title', inp('title', 'Short headline of the open point'));
    h += field('Scenario that revealed this (optional)',
        inp('scenarioCode', 'e.g. NHF_RFND_SRCH_CRIT_2ADT_2LEG — pick from Test Config to re-run when the fix lands', ' list="finding-scenario-codes"')
        + '<datalist id="finding-scenario-codes">' + state.scenarioCodes.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>');
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap">'
       + '<div style="flex:2;min-width:220px">' + field('Step (optional)', inp('step', 'e.g. GET Passenger — enables status-level baselining')) + '</div>'
       + '<div style="flex:1;min-width:120px">' + field('Documented HTTP (optional)', inp('expectedStatus', 'e.g. 501')) + '</div></div>';
    h += field('Observed', ta('observed', 'What the provider actually returned'));
    h += field('OSCAR’s reading', ta('interpretation', 'How OSCAR reads it + the spec reference'));
    h += field('Evidence (optional)', ta('evidence', 'Run link / response snippet'));
    h += field('Category', formPills('category', CAT_LABELS, x.category));
    h += field('Severity', formPills('severity', SEV_LABELS, x.severity));
    h += '<div style="display:flex;gap:18px;flex-wrap:wrap;margin:8px 0 4px">'
       + '<label style="font-size:12px;color:#455a64;display:flex;align-items:center;gap:6px"><input type="checkbox" data-action="form-toggle" data-field="baselineInRun"' + (x.baselineInRun ? ' checked' : '') + '> Baseline in runs <span style="color:#b0bec5">(needs step + HTTP)</span></label>'
       + '<label style="font-size:12px;color:#455a64;display:flex;align-items:center;gap:6px"><input type="checkbox" data-action="form-toggle" data-field="raiseToOsdm"' + (x.raiseToOsdm ? ' checked' : '') + '> Raise to OSDM</label>'
       + '</div>';
    h += '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">'
       + '<button class="btn btn-secondary btn-sm" data-action="cancel-form">Cancel</button>'
       + '<button class="btn btn-success btn-sm" data-action="submit-form">' + (form.mode === 'edit' ? 'Save changes' : 'Create finding') + '</button></div>';
    h += '</div></div>';
    return h;
  }
  function field(label, inner) {
    return '<div style="margin-bottom:10px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#90a4ae;margin-bottom:4px">' + esc(label) + '</div>' + inner + '</div>';
  }
  function formPills(fieldName, labels, cur) {
    return '<div class="pill-group" style="margin:0">' + Object.keys(labels).map(function (k) {
      return '<span class="pill' + (cur === k ? ' selected' : '') + '" data-action="form-pill" data-field="' + fieldName + '" data-value="' + k + '">' + esc(labels[k]) + '</span>';
    }).join('') + '</div>';
  }

  // ── Import view ──────────────────────────────────────────────────────────────
  function renderImport() {
    var h = '<div class="card" style="margin-bottom:14px;border:1px solid #b3e5fc">';
    h += '<div class="card-head"><div class="card-head-title">⬆ Import findings</div></div>';
    h += '<div class="card-body" style="padding:16px 18px">';
    h += '<div style="font-size:12px;color:#78909c;margin-bottom:8px">Paste a JSON array of findings — e.g. OSCAR\'s analysis for this test-system. Each needs a <code>title</code>; optional: <code>step, scenarioCode, expectedStatus, observed, interpretation, category, severity, baselineInRun, raiseToOsdm</code>. They\'re created as open points (authored “OSCAR analysis” unless the item sets <code>createdBy</code>) for you to review and reply to.</div>';
    h += '<textarea class="param-input" data-action="import-text" spellcheck="false" placeholder=\'[ {"title":"...","category":"provider_deviation","severity":"minor","observed":"...","interpretation":"..."} ]\' style="min-height:240px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5">' + esc(state.importText || '') + '</textarea>';
    h += '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">'
       + '<button class="btn btn-secondary btn-sm" data-action="import-cancel">Cancel</button>'
       + '<button class="btn btn-success btn-sm" data-action="import-run">Import</button></div>';
    h += '</div></div>';
    return h;
  }


  // ── Suggested from runs (#735) ───────────────────────────────────────────────
  // A batch's failures, grouped by the server into draft findings. Nothing is
  // written to a finding without a click here; testers never see this view.
  var SUGGEST_BASE = '/v1/company/findings/suggestions';

  async function openSuggest() {
    state.suggest = { batches: [], batchId: '', analysis: null, drafts: [], oscarIssues: [], rejected: 0, edits: {}, busy: false };
    state.form = null; state.importing = false; state.openId = null; state.thread = null;
    render(); window.scrollTo(0, 0);
    try {
      var b = await api('GET', SUGGEST_BASE + '/batches');
      state.suggest.batches = b.batches || [];
      state.suggest.batchId = state.suggest.batches.length ? state.suggest.batches[0].batchId : '';
      await loadSuggestions();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loadSuggestions() {
    var data = await api('GET', SUGGEST_BASE);
    var sg = state.suggest; if (!sg) return;
    sg.drafts = data.drafts || []; sg.oscarIssues = data.oscarIssues || []; sg.rejected = data.rejected || 0;
    render();
  }

  async function analyseBatch() {
    var sg = state.suggest; if (!sg || !sg.batchId) { toast('Choose a batch first.', 'warning'); return; }
    sg.busy = true; render();
    try {
      sg.analysis = await api('POST', SUGGEST_BASE + '/analyse', { batchId: sg.batchId });
      await loadSuggestions();
      toast(sg.analysis.created + ' new draft(s), ' + sg.analysis.updated + ' updated, ' + sg.analysis.stillSeen.length + ' still seen.', 'success');
    } catch (e) { toast(e.message, 'error'); }
    sg.busy = false; render();
  }

  function draftFields(d) {
    var e = state.suggest.edits[d.id] || {};
    return {
      title: e.title != null ? e.title : (d.draft.title || ''),
      category: e.category || d.draft.category || 'open',
      observed: e.observed != null ? e.observed : (d.draft.observed || ''),
      interpretation: e.interpretation != null ? e.interpretation : (d.draft.interpretation || ''),
      evidence: e.evidence != null ? e.evidence : (d.draft.evidence || '')
    };
  }

  async function decideSuggestion(id, how) {
    var sg = state.suggest; if (!sg) return;
    var d = sg.drafts.find(function (x) { return x.id === id; }); if (!d) return;
    try {
      if (how === 'accept') {
        var r = await api('POST', SUGGEST_BASE + '/' + encodeURIComponent(id) + '/accept', draftFields(d));
        toast('Finding created: ' + r.finding.title, 'success');
        await refresh();
      } else {
        await api('POST', SUGGEST_BASE + '/' + encodeURIComponent(id) + '/' + how);
        toast(how === 'reject' ? 'Rejected: it will not be suggested again.' : 'Kept as an OSCAR issue (not shown to the provider).', 'success');
      }
      delete sg.edits[id];
      await loadSuggestions();
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderSuggest(sg) {
    var h = '<div style="margin-bottom:12px"><button class="btn btn-secondary btn-sm" data-action="suggest-close">← All findings</button></div>';
    h += '<div class="card"><div class="card-body" style="padding:14px">'
      + '<div style="font-size:15px;font-weight:700;color:#37474f;margin-bottom:4px">🧩 Suggested from runs</div>'
      + '<div style="font-size:12px;color:#78909c;margin-bottom:10px">The failed checks of a batch, grouped: one draft per problem, with the scenarios that showed it. '
      + 'A draft is yours to accept, edit then accept, reject, or keep as an OSCAR issue. Testers and the provider never see drafts.</div>'
      + renderBatchPicker(sg) + '</div></div>';
    if (sg.analysis) h += renderAnalysis(sg.analysis);
    h += '<div style="font-size:13px;font-weight:700;color:#eceff1;margin:16px 0 8px">Drafts waiting (' + sg.drafts.length + ')</div>';
    h += sg.drafts.length ? sg.drafts.map(renderDraft).join('')
      : '<div class="placeholder" style="padding:14px">No draft waiting. Analyse a batch to get some.</div>';
    h += renderDecidedNote(sg);
    return h;
  }

  function renderBatchPicker(sg) {
    if (!sg.batches.length) return '<div style="font-size:13px;color:#78909c">No batch of runs yet for this test-system.</div>';
    var opts = sg.batches.map(function (b) {
      var label = fmtTs(b.started) + ' — ' + b.runs + ' run(s)' + (b.finishedRuns < b.runs ? (', ' + b.finishedRuns + ' finished') : '');
      return '<option value="' + esc(b.batchId) + '"' + (b.batchId === sg.batchId ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<label for="suggest-batch" style="font-size:12px;color:#455a64">Batch</label>'
      + '<select id="suggest-batch" class="param-input" data-action="suggest-batch" style="max-width:360px">' + opts + '</select>'
      + '<button class="btn btn-primary btn-sm" data-action="suggest-analyse"' + (sg.busy ? ' disabled' : '') + '>'
      + (sg.busy ? '⏳ Analysing…' : 'Analyse') + '</button></div>';
  }

  function renderAnalysis(a) {
    var h = '<div class="card" style="margin-top:12px"><div class="card-body" style="padding:12px;font-size:12px;color:#455a64">'
      + '<div style="margin-bottom:6px"><strong>' + a.batch.failures + '</strong> failed check(s) in ' + a.batch.finishedRuns + ' finished run(s) → '
      + a.groups + ' problem(s): ' + a.created + ' new draft(s), ' + a.updated + ' updated, ' + a.stillSeen.length + ' already recorded'
      + (a.suppressed ? (', ' + a.suppressed + ' rejected or OSCAR\'s before') : '') + '.'
      + (a.batch.truncated ? ' <span style="color:#c62828">Only the first failures were read.</span>' : '') + '</div>';
    if (a.stillSeen.length) {
      h += '<div style="margin-top:6px"><strong>Still seen</strong> (shown, nothing written):<ul style="margin:4px 0 0 18px">'
        + a.stillSeen.map(function (s) {
          return '<li><a href="#" data-action="open-finding" data-id="' + esc(s.findingId) + '">' + esc(s.title) + '</a> — '
            + esc(s.why) + ', ' + s.occurrences + '× in ' + esc(s.scenarios.join(', ')) + '</li>';
        }).join('') + '</ul></div>';
    }
    if (a.notSeen.length) {
      h += '<div style="margin-top:6px"><strong>Not seen in this batch</strong> (its scenario ran, nothing matched):<ul style="margin:4px 0 0 18px">'
        + a.notSeen.map(function (s) {
          return '<li><a href="#" data-action="open-finding" data-id="' + esc(s.findingId) + '">' + esc(s.title) + '</a> — ' + esc(s.scenarioCode) + '</li>';
        }).join('') + '</ul></div>';
    }
    return h + '</div></div>';
  }

  function renderDraft(d) {
    var x = draftFields(d);
    var pills = CAT_ORDER.map(function (k) {
      return '<span class="pill' + (x.category === k ? ' selected' : '') + '" data-action="suggest-pill" data-id="' + esc(d.id) + '" data-value="' + k + '">' + esc(CAT_LABELS[k]) + '</span>';
    }).join(' ');
    var maybe = d.maybeFindingId ? liveFinding(d.maybeFindingId) : null;
    function field(name, label, rows) {
      var fid = 'sg-' + name + '-' + d.id;
      var input = rows
        ? '<textarea id="' + esc(fid) + '" class="param-input" data-action="suggest-field" data-id="' + esc(d.id) + '" data-field="' + name + '" style="min-height:' + rows + 'px;resize:vertical">' + esc(x[name]) + '</textarea>'
        : '<input id="' + esc(fid) + '" class="param-input" data-action="suggest-field" data-id="' + esc(d.id) + '" data-field="' + name + '" value="' + esc(x[name]) + '">';
      return '<label for="' + esc(fid) + '" style="font-size:11px;color:#78909c;display:block;margin-top:8px">' + esc(label) + '</label>' + input;
    }
    return '<div class="card" style="margin-bottom:10px"><div class="card-body" style="padding:12px">'
      + '<div style="font-size:11px;color:#90a4ae">' + d.occurrences + ' failure(s) · ' + esc(d.scenarios.join(', ')) + ' · step ' + esc(d.draft.step || '—')
      + (d.draft.expectedStatus ? (' · HTTP ' + esc(d.draft.expectedStatus)) : '') + '</div>'
      + (maybe ? '<div style="font-size:12px;color:#a85b00;margin-top:4px">⚠ May already be recorded as <a href="#" data-action="open-finding" data-id="' + esc(maybe.id) + '">' + esc(maybe.title) + '</a> (same step and scenario).</div>' : '')
      + field('title', 'Title') + '<div style="margin-top:8px">' + pills
      + ' <span style="font-size:11px;color:#90a4ae">' + esc(d.draft.reason || '') + '</span></div>'
      + field('observed', 'Observed', 70) + field('interpretation', 'Interpretation (OSCAR\'s reading, spec reference)', 50) + field('evidence', 'Evidence', 50)
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap">'
      + '<button class="btn btn-secondary btn-sm" data-action="suggest-decide" data-how="oscar-issue" data-id="' + esc(d.id) + '" title="OSCAR\'s own problem: kept here, never shown to the provider">OSCAR issue</button>'
      + '<button class="btn btn-danger btn-sm" data-action="suggest-decide" data-how="reject" data-id="' + esc(d.id) + '" title="Not a finding: it will not be suggested again">Reject</button>'
      + '<button class="btn btn-success btn-sm" data-action="suggest-decide" data-how="accept" data-id="' + esc(d.id) + '">Accept as finding</button>'
      + '</div></div></div>';
  }

  function renderDecidedNote(sg) {
    if (!sg.oscarIssues.length && !sg.rejected) return '';
    var h = '<div style="font-size:12px;color:#cfd8dc;margin-top:12px">';
    if (sg.oscarIssues.length) {
      h += '<strong>Kept as OSCAR issues</strong> (' + sg.oscarIssues.length + '):<ul style="margin:4px 0 0 18px">'
        + sg.oscarIssues.map(function (s) { return '<li>' + esc(s.draft.title) + '</li>'; }).join('') + '</ul>';
    }
    if (sg.rejected) h += '<div>' + sg.rejected + ' suggestion(s) rejected; they are not suggested again.</div>';
    return h + '</div>';
  }

  // ── Actions ──────────────────────────────────────────────────────────────────
  async function openFinding(id) {
    try {
      state.thread = await api('GET', '/v1/company/findings/' + encodeURIComponent(id));
      state.openId = id; state.form = null; state.replyText = '';
      render(); window.scrollTo(0, 0);
    } catch (e) { toast(e.message, 'error'); }
  }
  async function patchField(id, patch) {
    try { await api('PATCH', '/v1/company/findings/' + encodeURIComponent(id), patch); await refresh(); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function toggleBaseline(id) { var f = liveFinding(id); if (f) await patchField(id, { baselineInRun: !f.baselineInRun }); }
  async function toggleOsdm(id)     { var f = liveFinding(id); if (f) await patchField(id, { raiseToOsdm: !f.raiseToOsdm }); }

  async function postReply(id) {
    var body = (state.replyText || '').trim();
    if (!body) { toast('Write a reply first.', 'warning'); return; }
    try { await api('POST', '/v1/company/findings/' + encodeURIComponent(id) + '/comments', { body: body }); state.replyText = ''; await refresh(); toast('Reply posted.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  async function delFinding(id) {
    if (!confirm('Delete this finding and its whole thread? This cannot be undone.')) return;
    try { await api('DELETE', '/v1/company/findings/' + encodeURIComponent(id)); state.openId = null; state.thread = null; await refresh(); toast('Finding deleted.', 'success'); }
    catch (e) { toast(e.message, 'error'); }
  }
  function startEdit(id) {
    var f = liveFinding(id); if (!f) return;
    state.form = { mode: 'edit', id: id, fields: {
      title: f.title || '', step: f.step || '', scenarioCode: f.scenarioCode || '', expectedStatus: (f.expectedStatus == null ? '' : String(f.expectedStatus)),
      observed: f.observed || '', interpretation: f.interpretation || '', evidence: f.evidence || '',
      category: f.category || 'open', severity: f.severity || null, baselineInRun: !!f.baselineInRun, raiseToOsdm: !!f.raiseToOsdm } };
    render(); window.scrollTo(0, 0);
  }
  async function submitForm() {
    var f = state.form; if (!f) return;
    var x = f.fields;
    if (!(x.title || '').trim()) { toast('A finding needs a title.', 'warning'); return; }
    var payload = {
      title: x.title.trim(), step: (x.step || '').trim() || null,
      scenarioCode: (x.scenarioCode || '').trim() || null,
      expectedStatus: (x.expectedStatus === '' || x.expectedStatus == null) ? null : parseInt(x.expectedStatus, 10),
      observed: x.observed || '', interpretation: x.interpretation || '', evidence: x.evidence || '',
      category: x.category || 'open', severity: x.severity || null,
      baselineInRun: !!x.baselineInRun, raiseToOsdm: !!x.raiseToOsdm
    };
    try {
      if (f.mode === 'edit') {
        await api('PATCH', '/v1/company/findings/' + encodeURIComponent(f.id), payload);
        toast('Finding updated.', 'success');
      } else {
        var r = await api('POST', '/v1/company/findings', payload);
        state.openId = r.finding && r.finding.id;
        toast('Finding created.', 'success');
      }
      state.form = null;
      await refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function importFindings() {
    var raw = (state.importText || '').trim();
    if (!raw) { toast('Paste a JSON array of findings first.', 'warning'); return; }
    var arr;
    try { arr = JSON.parse(raw); }
    catch (e) { toast('Invalid JSON: ' + e.message, 'error'); return; }
    if (!Array.isArray(arr)) { toast('Expected a JSON array of findings.', 'error'); return; }
    var items = arr.filter(function (o) { return o && typeof o === 'object' && String(o.title || '').trim(); });
    if (!items.length) { toast('No findings with a title found in the JSON.', 'warning'); return; }
    if (!confirm('Import ' + items.length + ' finding(s) into this test-system?')) return;
    var ok = 0, failed = 0;
    for (var i = 0; i < items.length; i++) {
      var o = items[i];
      try {
        await api('POST', '/v1/company/findings', {
          title:          String(o.title).trim(),
          step:           (o.step != null && String(o.step).trim()) ? String(o.step).trim() : null,
          scenarioCode:   (o.scenarioCode != null && String(o.scenarioCode).trim()) ? String(o.scenarioCode).trim() : null,
          expectedStatus: o.expectedStatus,
          observed:       o.observed || '',
          interpretation: o.interpretation || '',
          evidence:       o.evidence || '',
          category:       o.category || 'open',
          severity:       o.severity || null,
          baselineInRun:  !!o.baselineInRun,
          raiseToOsdm:    !!o.raiseToOsdm,
          createdBy:      (typeof o.createdBy === 'string' && o.createdBy.trim()) ? o.createdBy.trim() : 'OSCAR analysis'
        });
        ok++;
      } catch (_e) { failed++; }
    }
    state.importing = false; state.importText = '';
    await refresh();
    toast('Imported ' + ok + ' finding(s)' + (failed ? (' — ' + failed + ' failed') : '') + '.', failed ? 'warning' : 'success');
  }

  // ── Event delegation ─────────────────────────────────────────────────────────
  document.body.addEventListener('click', function (e) {
    var el = closestAction(e.target); if (!el) return;
    var a = el.dataset.action, id = el.dataset.id;
    switch (a) {
      case 'open-finding':  e.preventDefault(); state.suggest = null; openFinding(id); break;
      case 'suggest-open':  openSuggest(); break;
      case 'suggest-close': state.suggest = null; render(); break;
      case 'suggest-analyse': analyseBatch(); break;
      case 'suggest-decide': decideSuggestion(id, el.dataset.how); break;
      case 'suggest-pill': {
        if (!state.suggest) break;
        (state.suggest.edits[id] || (state.suggest.edits[id] = {})).category = el.dataset.value;
        render(); break;
      }
      case 'toggle-cat':    state.openCats[el.dataset.cat] = !state.openCats[el.dataset.cat]; render(); break;
      case 'toggle-group':  { var gk = el.dataset.cat + '|' + el.dataset.status; state.openGroups[gk] = !state.openGroups[gk]; render(); break; }
      case 'expand-all':    setAllCats(true); render(); break;
      case 'collapse-all':  setAllCats(false); render(); break;
      case 'close-thread':  state.openId = null; state.thread = null; render(); break;
      case 'compose-new':   state.form = blankForm('create'); state.importing = false; render(); window.scrollTo(0, 0); break;
      case 'import-open':   state.importing = true; state.form = null; state.openId = null; state.thread = null; render(); window.scrollTo(0, 0); break;
      case 'import-cancel': state.importing = false; render(); break;
      case 'import-run':    importFindings(); break;
      case 'edit-finding':  startEdit(id); break;
      case 'cancel-form':   state.form = null; render(); break;
      case 'submit-form':   submitForm(); break;
      case 'set-category':  patchField(id, { category: el.dataset.value }); break;
      case 'set-severity':  { var fs = liveFinding(id); patchField(id, { severity: (fs && fs.severity === el.dataset.value) ? null : el.dataset.value }); break; }
      case 'set-status':    patchField(id, { status: el.dataset.value }); break;
      case 'toggle-baseline': toggleBaseline(id); break;
      case 'toggle-osdm':   toggleOsdm(id); break;
      case 'post-reply':    postReply(id); break;
      case 'delete-finding': delFinding(id); break;
      case 'form-pill': {
        if (!state.form) break;
        var fld = el.dataset.field, val = el.dataset.value, cur = state.form.fields[fld];
        state.form.fields[fld] = (cur === val) ? (fld === 'category' ? 'open' : null) : val;
        render(); break;
      }
    }
  });
  document.body.addEventListener('input', function (e) {
    var el = closestAction(e.target); if (!el) return;
    if (el.dataset.action === 'set-reply-text') state.replyText = el.value;
    else if (el.dataset.action === 'import-text') state.importText = el.value;
    else if (el.dataset.action === 'form-field' && state.form) state.form.fields[el.dataset.field] = el.value;
    else if (el.dataset.action === 'suggest-field' && state.suggest) {
      (state.suggest.edits[el.dataset.id] || (state.suggest.edits[el.dataset.id] = {}))[el.dataset.field] = el.value;
    }
  });
  document.body.addEventListener('change', function (e) {
    var el = closestAction(e.target); if (!el) return;
    if (el.dataset.action === 'form-toggle' && state.form) state.form.fields[el.dataset.field] = el.checked;
    else if (el.dataset.action === 'suggest-batch' && state.suggest) state.suggest.batchId = el.value;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
  boot();

})();
