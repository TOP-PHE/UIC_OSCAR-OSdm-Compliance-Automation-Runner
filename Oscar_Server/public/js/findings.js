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
    importText: ''    // pasted import JSON
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
  var ST_LABELS  = { open: 'Open', discussing: 'Discussing', resolved: 'Resolved' };

  // ── Tiny utilities ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
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
    ha.innerHTML = (state.isTM && !state.form && !state.importing)
      ? '<button class="btn btn-success" data-action="compose-new">＋ Open a finding</button>'
        + ' <button class="btn btn-secondary" data-action="import-open" title="Import findings from a JSON array (e.g. OSCAR\'s analysis for this test-system)">⬆ Import</button>'
      : '';
    var root = document.getElementById('findings-root');
    if (state.importing) { root.innerHTML = renderImport(); return; }
    if (state.form) { root.innerHTML = renderForm(state.form); return; }
    if (state.openId && state.thread) { root.innerHTML = renderThread(state.thread); return; }
    root.innerHTML = renderList();
  }

  // ── List view ────────────────────────────────────────────────────────────────
  function renderList() {
    if (!state.findings.length) {
      return '<div class="card"><div class="card-body" style="padding:24px;text-align:center;color:#78909c">'
        + '<div style="font-size:15px;font-weight:700;color:#455a64;margin-bottom:6px">No findings recorded yet</div>'
        + '<div style="font-size:13px;max-width:560px;margin-left:auto;margin-right:auto">'
        + 'Open points raised here become the conformance record for this test-system — searchable, threaded, and a feed for OSDM working-group feedback.'
        + (state.isTM ? ' Use <strong>＋ Open a finding</strong> to add one.' : '')
        + '</div></div></div>';
    }
    return '<div style="margin-bottom:12px;font-size:12px;color:#78909c">' + summarise(state.findings) + '</div>'
      + state.findings.map(renderCard).join('');
  }

  function summarise(list) {
    var by = { open: 0, discussing: 0, resolved: 0 }, baselined = 0, osdm = 0;
    list.forEach(function (f) { by[f.status] = (by[f.status] || 0) + 1; if (f.baselineInRun) baselined++; if (f.raiseToOsdm) osdm++; });
    var parts = [list.length + ' finding' + (list.length === 1 ? '' : 's')];
    if (by.open) parts.push(by.open + ' open');
    if (by.discussing) parts.push(by.discussing + ' discussing');
    if (by.resolved) parts.push(by.resolved + ' resolved');
    if (baselined) parts.push(baselined + ' baselined into runs');
    if (osdm) parts.push(osdm + ' flagged for OSDM');
    return parts.join(' · ');
  }

  function renderCard(f) {
    return '<div class="card" style="margin-bottom:10px">'
      + '<div class="card-head" style="cursor:pointer" data-action="open-finding" data-id="' + esc(f.id) + '">'
        + '<div class="card-head-title" style="text-transform:none;font-size:13.5px;letter-spacing:0;color:#263238;flex:1;min-width:0">'
          + sevDot(f.severity) + esc(f.title) + '</div>'
        + '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0">'
          + catBadge(f.category) + statusBadge(f.status)
          + (f.baselineInRun ? '<span class="badge badge-in-run" title="Projected into runs as a documented deviation">⚙ in runs</span>' : '')
          + (f.raiseToOsdm ? '<span class="badge badge-info" title="Flagged as OSDM feedback">📣 OSDM</span>' : '')
          + '<span style="font-size:12px;color:#90a4ae" title="replies">💬 ' + (f.commentCount || 0) + '</span>'
        + '</div>'
      + '</div>'
      + ((f.step || f.expectedStatus != null)
          ? '<div style="padding:0 18px 12px 18px;font-size:12px;color:#607d8b">'
            + (f.step ? 'Step <code>' + esc(f.step) + '</code>' : '')
            + (f.expectedStatus != null ? ' &middot; documented HTTP <strong>' + esc(f.expectedStatus) + '</strong>' : '')
            + '</div>'
          : '')
      + '</div>';
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
      title: '', step: '', expectedStatus: '', observed: '', interpretation: '', evidence: '',
      category: 'open', severity: null, baselineInRun: false, raiseToOsdm: false } };
  }
  function renderForm(form) {
    var x = form.fields;
    function inp(field, ph) { return '<input class="param-input" data-action="form-field" data-field="' + field + '" value="' + esc(x[field] || '') + '" placeholder="' + esc(ph) + '">'; }
    function ta(field, ph) { return '<textarea class="param-input" data-action="form-field" data-field="' + field + '" placeholder="' + esc(ph) + '" style="min-height:64px;resize:vertical">' + esc(x[field] || '') + '</textarea>'; }
    var h = '<div class="card" style="margin-bottom:14px;border:1px solid #b3e5fc">';
    h += '<div class="card-head"><div class="card-head-title">' + (form.mode === 'edit' ? '✎ Edit finding' : '＋ Open a finding') + '</div></div>';
    h += '<div class="card-body" style="padding:16px 18px">';
    h += field('Title', inp('title', 'Short headline of the open point'));
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
    h += '<div style="font-size:12px;color:#78909c;margin-bottom:8px">Paste a JSON array of findings — e.g. OSCAR\'s analysis for this test-system. Each needs a <code>title</code>; optional: <code>step, expectedStatus, observed, interpretation, category, severity, baselineInRun, raiseToOsdm</code>. They\'re created as open points (authored “OSCAR analysis” unless the item sets <code>createdBy</code>) for you to review and reply to.</div>';
    h += '<textarea class="param-input" data-action="import-text" spellcheck="false" placeholder=\'[ {"title":"...","category":"provider_deviation","severity":"minor","observed":"...","interpretation":"..."} ]\' style="min-height:240px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5">' + esc(state.importText || '') + '</textarea>';
    h += '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">'
       + '<button class="btn btn-secondary btn-sm" data-action="import-cancel">Cancel</button>'
       + '<button class="btn btn-success btn-sm" data-action="import-run">Import</button></div>';
    h += '</div></div>';
    return h;
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
      title: f.title || '', step: f.step || '', expectedStatus: (f.expectedStatus == null ? '' : String(f.expectedStatus)),
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
      case 'open-finding':  openFinding(id); break;
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
  });
  document.body.addEventListener('change', function (e) {
    var el = closestAction(e.target); if (!el) return;
    if (el.dataset.action === 'form-toggle' && state.form) state.form.fields[el.dataset.field] = el.checked;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────
  boot();

})();
