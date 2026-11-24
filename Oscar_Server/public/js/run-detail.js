/* global esc, logout, oscarReportError, OscarRunExit, oscarToast, parseServerTs */  // esc.js, nav.js, run-exit.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of run-detail.html, moved out of the page (#1423) so that the
// content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const token = localStorage.getItem('oscar_token') || '';
if (!localStorage.getItem('oscar_user')) window.location.href = '/';
const company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
// logout() provided by nav.js

// runId is interpolated into authenticated fetch URLs throughout this page,
// so we strictly validate it's a UUID before doing anything. Closes a
// CodeQL js/request-forgery flag (raw query-string value used as URL
// fragment) and prevents a crafted ?id= from escaping to a foreign URL.
const RUNID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const _rawRunId = new URLSearchParams(location.search).get('id');
if (!_rawRunId || !RUNID_RE.test(_rawRunId)) {
  window.location.href = '/dashboard.html';
}
// The id checked above, or '' while the page leaves for the dashboard: only a
// UUID goes into a request address (#1423).
const runId = RUNID_RE.test(_rawRunId || '') ? _rawRunId : '';

let lastEventId = 0;
let polling     = true;
// #343 followup (v1.11.117): run the terminal-status side-effects (artifacts /
// assertions / requests loads, delete + share buttons) exactly once — the
// poll loop now keeps spinning after a terminal status to drain the log
// backlog, so updateStatus() can be called with a terminal run several times.
let terminalHandled = false;

// Friendly, self-describing download name for run artifacts —
// {sandbox}_{date}_{scenario}.{ext} — so a downloaded results file is no longer
// an anonymous bru_results.json. Built from the run object (set in updateStatus).
let currentRun = null;
function friendlyArtifactBase() {
  const r = currentRun || {};
  const sandbox = String(r.env_name_used || 'sandbox')
    .replace(/^OTST[_-]?/i, '').replace(/[_-]?Env$/i, '').trim() || 'sandbox';
  let date = '';
  try { date = parseServerTs(r.started_at || r.queued_at).toISOString().slice(0, 10); } catch (_e) { /* missing/invalid date → omit */ }
  const scenario = r.scenario_code || 'run';
  let base = [sandbox, date, scenario].filter(Boolean).join('_')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-');
  if (base.length > 120) {   // mind the filename length
    base = base.slice(0, 120);
    while (/[-_.]$/.test(base)) base = base.slice(0, -1);
  }
  return base || 'run';
}

// v1.11.7 — parseServerTs (nav.js) handles SQLite's TZ-less UTC strings.
function fmtDate(d) { return d ? parseServerTs(d).toLocaleString() : '-'; }
function duration(a, b) {
  if (!a || !b) return '-';
  const s = Math.round((new Date(b) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`;
}

// An intrusion attempt this run met (utils/intrusion.js): a red banner above
// everything, built as text only.
const INTRUSION_KINDS = {
  template: 'An answer held a template ("{{") the test engine would have filled in with its own variables.',
  script: 'An answer held markup meant to run in a browser.',
  redirect: 'An answer redirected to a private or internal address.',
};
function showIntrusionBanner(run) {
  if (!run.intrusion || document.getElementById('intrusion-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'intrusion-banner';
  banner.className = 'intrusion-banner';
  banner.setAttribute('role', 'alert');
  const title = document.createElement('div');
  title.className = 'ib-title';
  title.textContent = '⛔ Intrusion attempt detected';
  const what = document.createElement('div');
  what.textContent = `${INTRUSION_KINDS[run.intrusion.kind] || 'An answer was refused.'} Step: ${run.intrusion.step || 'unknown'}.`;
  const done = document.createElement('div');
  done.textContent = 'The run was stopped, the provider tokens were dropped and the endpoint is suspended. The administrators were alerted. A Test Manager resumes the endpoint on the API Config page once the provider is checked.';
  banner.append(title, what, done);
  document.getElementById('meta').insertAdjacentElement('beforebegin', banner);
}

// #1287: Bruno ended the run with a code that is not a test result. The code
// is a number from the server; the meaning is OscarRunExit's own text.
function notFinishedBannerHtml(code) {
  const shown = Number.isInteger(code) ? String(code) : 'unknown';
  return `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">The run did not go to its end — this is not a test result</div>
          <div class="auth-msg">
            It ended with code ${escHtml(shown)}: ${escHtml(OscarRunExit.exitMeaning(code))}.<br>
            The checks shown are those made before it stopped; the rest of the scenario was not tested. Run the scenario again; if it happens again, tell your OSCAR administrator.
          </div>
        </div>`;
}

// #1291: the server restarted while the run was going or waiting, and its
// start marked the run failed. The message is OscarRunExit's own text.
function restartedBannerHtml(message) {
  return `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">Stopped by a server restart — this is not a test result</div>
          <div class="auth-msg">
            ${escHtml(message)}<br>
            Nothing, or not all, of the scenario was tested, and the coverage report does not count this run. Run the scenario again.
          </div>
        </div>`;
}

function updateStatus(run) {
  currentRun = run;
  const badge = document.getElementById('status-badge');
  badge.className = `status s-${run.status}`;
  const spin = (run.status === 'RUNNING' || run.status === 'QUEUED') ? '<span class="spin">⟳</span> ' : '';
  badge.innerHTML = `${spin}${escHtml(run.status)}`;
  document.getElementById('run-title').textContent = run.env_name_used || `Run ${run.id.slice(0,8)}`;
  showSharedNote(run);

  const metaItems = [
    { lbl: 'Run ID',    val: run.id.slice(0,8) + '...' },
    { lbl: 'Endpoint',  val: run.api_base_used || '-' },
    { lbl: 'Auth Mode', val: run.auth_mode_used || '-' },
    { lbl: 'Queued',    val: fmtDate(run.queued_at) },
    { lbl: 'Started',   val: fmtDate(run.started_at) },
    { lbl: 'Duration',  val: duration(run.started_at, run.completed_at) },
    { lbl: 'Exit Code', val: run.exit_code != null ? run.exit_code : '-' },
  ];
  if (run.scenario_code) metaItems.push({ lbl: 'Scenario', val: run.scenario_code });
  // Every value is text: escaped here. Only the batch link is markup, built
  // from an escaped id.
  if (run.batch_id) metaItems.push({ lbl: 'Batch', html: `<a href="/dashboard.html" style="color:#0090D4;text-decoration:none">${escHtml(run.batch_id.slice(0,8))}... (view batch)</a>` });
  document.getElementById('meta').innerHTML = metaItems.map(m => `<div class="meta-item"><div class="lbl">${m.lbl}</div><div class="val">${m.html ?? escHtml(m.val)}</div></div>`).join('');
  showIntrusionBanner(run);

  // Auth error banner — shown when runner detected a token problem
  const existingBanner  = document.getElementById('auth-error-banner');
  const isFormatError   = run.error_message === 'TOKEN_FORMAT_ERROR';
  const isAuthError     = run.error_message === 'TOKEN_AUTH_ERROR';
  const isNoChecks      = run.error_message === 'NO_CHECKS';
  const isProcessError  = run.error_message === 'RUN_PROCESS_ERROR';
  const isNotFinished   = run.error_message === OscarRunExit.NOT_FINISHED;
  const isRestarted     = OscarRunExit.isRestarted(run.error_message);
  const isOAuthError    = !isFormatError && !isAuthError && !isNoChecks && !isProcessError && !isNotFinished && !isRestarted && run.error_message && run.auth_mode_used === 'oauth2';
  const showBanner      = isFormatError || isAuthError || isNoChecks || isProcessError || isNotFinished || isRestarted || isOAuthError;

  if (showBanner && !existingBanner) {
    const banner = document.createElement('div');
    banner.id        = 'auth-error-banner';
    banner.className = 'auth-error-banner';
    if (isFormatError) {
      banner.innerHTML = `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">Invalid API configuration — Bruno could not parse the run environment</div>
          <div class="auth-msg">
            A value saved in your API settings (e.g. the API base URL or requestor) contains invalid characters (e.g. a stray quote <code style="background:#fbe9e7;padding:1px 4px;border-radius:3px">"</code> or leading/trailing whitespace).<br>
            Please check the values in your API settings and re-save them — do not include surrounding quotes.
          </div>
          <a href="/profile.html" class="auth-link">Fix API Config →</a>
        </div>`;
    } else if (isAuthError) {
      banner.innerHTML = `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">API Token rejected — HTTP 401 Unauthorized</div>
          <div class="auth-msg">
            The token configured in your API settings was refused by the provider.<br>
            This usually means the token has expired or is incorrect.
          </div>
          <a href="/profile.html" class="auth-link">Update API Token →</a>
        </div>`;
    } else if (isNoChecks) {
      banner.innerHTML = `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">No check was recorded — the run is marked failed</div>
          <div class="auth-msg">
            Bruno ended without error, but OSCAR received no check result for this run: nothing was checked.<br>
            The execution log says why. Run the scenario again; if it happens again, tell your OSCAR administrator.
          </div>
        </div>`;
    } else if (isProcessError) {
      banner.innerHTML = `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">The run did not go to its end — this is not a test result</div>
          <div class="auth-msg">
            OSCAR could not start the run, or lost it while it ran (on a cluster: its pod could not be made or followed). Nothing, or not all, was tested.<br>
            The "Process error" line of the execution log gives the reason. Run the scenario again; if it happens again, tell your OSCAR administrator.
          </div>
        </div>`;
    } else if (isNotFinished) {
      banner.innerHTML = notFinishedBannerHtml(run.exit_code);
    } else if (isRestarted) {
      banner.innerHTML = restartedBannerHtml(run.error_message);
    } else {
      banner.innerHTML = `
        <div class="auth-icon">⚠️</div>
        <div class="auth-body">
          <div class="auth-title">OAuth2 authentication failed</div>
          <div class="auth-msg">${esc(run.error_message)}</div>
          <a href="/profile.html" class="auth-link">Update OAuth2 Credentials →</a>
        </div>`;
    }
    document.getElementById('meta').insertAdjacentElement('afterend', banner);
  } else if (!showBanner && existingBanner) {
    existingBanner.remove();
  }

  if (run.status === 'COMPLETED' || run.status === 'FAILED' || run.status === 'CANCELLED') {
    polling = false;
    if (terminalHandled) return;
    terminalHandled = true;
    loadArtifacts().catch(oscarReportError);
    loadAssertions().catch(oscarReportError);
    loadRequests().catch(oscarReportError);

    // Show delete button if user has permission
    const canDelete = user.role === 'administrator' ||
      ((user.role === 'company_user' || user.role === 'test_manager') && run.user_id === user.id);
    const wrap = document.getElementById('delete-btn-wrap');
    if (canDelete && !wrap.querySelector('button')) {
      wrap.innerHTML = '<button class="btn btn-danger" data-action="delete-run">🗑 Delete Run</button>';
    }

    // ── Per-run share-with-certifier toggle (issue #60, v1.10.0) ─────────────
    // Test managers explicitly choose which terminal runs are visible to
    // certifiers. Replaces the company-wide all-or-nothing toggle.
    // Visible to test_managers, and to the tester whose run it is (1.11.477);
    // the button text + colour reflect the current shared state, which the run
    // object now carries via the shared_with_certifier_at timestamp (null = not shared).
    const ownTesterRun = (user.role === 'company_user' || user.role === 'tester') && run.user_id === user.id;
    if ((user.role === 'test_manager' || ownTesterRun) && !run.shared) {
      const shareWrap = document.getElementById('share-btn-wrap');
      if (shareWrap) {
        const isShared = !!run.shared_with_certifier_at;
        const sharedAt = isShared
          ? parseServerTs(run.shared_with_certifier_at).toLocaleString()
          : '';
        const sharedBy = run.shared_with_certifier_by || '';
        shareWrap.innerHTML = isShared
          ? `<button class="btn btn-warn" data-action="unshare-run"
                title="Shared on ${escHtml(sharedAt)} by ${escHtml(sharedBy)} — click to revoke certifier access">
              🔓 Shared with certifiers — click to revoke
            </button>`
          : `<button class="btn btn-primary" data-action="share-run"
                title="Make this report visible to UIC certifiers">
              🤝 Share this report with certifiers
            </button>`;
      }
    }
  }
}

// #901: a run another company shared with this one is read only. Its people
// are named by that company, never by e-mail (the server replaces them).
function showSharedNote(run) {
  const note = document.getElementById('shared-note');
  if (!run.shared) { note.style.display = 'none'; return; }
  note.textContent = `Shared with your company by ${run.shared.distributor}, which tests your system as its provider "${run.shared.provider}". Read only.`;
  note.style.display = 'block';
}

// ── Share / unshare with certifier (issue #60, v1.10.0) ──────────────────────
async function shareRunWithCertifier(share) {
  const verb = share ? 'share' : 'revoke certifier access to';
  if (!confirm(`Are you sure you want to ${verb} this report?\n\nWhen shared, certifiers will be able to view this run's structured results, HTTP traffic, and downloadable artifacts.`)) return;
  try {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/share`, { method: share ? 'POST' : 'DELETE' });
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      oscarToast(`Action failed (${res.status}): ${data.detail || data.title || 'Unknown error'}`, 'error');
      return;
    }
    // Reload the page to refresh the share button + the run banner.
    location.reload();
  } catch (err) {
    oscarToast(`Network error: ${err.message || err}`, 'error');
  }
}


let activeLogLevel = 'all';
let logSearchTerm = '';
// #351: hierarchical level filter — a selected level shows that level AND
// everything more severe (the standard logging pyramid, matching the Bruno
// library's loggingType semantics). 'all' shows everything incl. DEBUG.
// Unknown levels stay visible — same safety net as the #341 colors.
const LOG_LEVEL_RANK = { debug: 0, info: 1, warn: 2, warning: 2, error: 3 };
function levelVisible(level) {
  if (activeLogLevel === 'all') return true;
  const r = LOG_LEVEL_RANK[level];
  return r === undefined ? true : r >= LOG_LEVEL_RANK[activeLogLevel];
}
// Endpoint filter (#350): the runner's LogParser attributes each line to the
// request being executed (request_name); this lets the tester isolate one
// endpoint's log, like the per-request grouping in the assertions panel.
let activeLogRequest = 'all';
const logRequestsSeen = new Set();

// #351: the log is SPLIT per area (suite), like the assertions panel — one
// collapsible section per suite, in chronological order. Lines stream into
// the current section; a new section starts when suite_name changes.
let currentLogSuite = null;
let currentLogGroupBody = null;
function logGroupBodyFor(suiteName, box) {
  const suite = suiteName || 'Runner';
  if (currentLogGroupBody && suite === currentLogSuite) return currentLogGroupBody;
  currentLogSuite = suite;
  const det = document.createElement('details');
  det.className = 'log-group';
  det.open = true;
  const sum = document.createElement('summary');
  sum.className = 'log-group-head';
  const chev = document.createElement('span');
  chev.className = 'gchev';
  chev.textContent = '▶';
  const lbl = document.createElement('span');
  lbl.textContent = `📂 ${suite}`;
  const cnt = document.createElement('span');
  cnt.className = 'log-group-count';
  sum.appendChild(chev); sum.appendChild(lbl); sum.appendChild(cnt);
  det.appendChild(sum);
  const body = document.createElement('div');
  body.className = 'log-group-body';
  det.appendChild(body);
  box.appendChild(det);
  currentLogGroupBody = body;
  return body;
}
// Keep each section's count badge fresh and hide sections whose lines are all
// filtered out (level / endpoint / search).
function syncLogGroups() {
  document.querySelectorAll('#log-box .log-group').forEach(g => {
    const total = g.querySelectorAll('.log-line').length;
    const visible = g.querySelectorAll('.log-line:not(.hidden)').length;
    const cnt = g.querySelector('.log-group-count');
    if (cnt) cnt.textContent = visible === total ? `${total} lines` : `${visible}/${total} lines`;
    g.classList.toggle('hidden', visible === 0);
  });
}

function registerLogRequest(name) {
  if (!name || logRequestsSeen.has(name)) return;
  logRequestsSeen.add(name);
  const sel = document.getElementById('log-req-filter');
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name;
  sel.appendChild(opt);
}

function appendLogs(events) {
  if (!events.length) return;
  const box = document.getElementById('log-box');
  if (box.querySelector('span[style]')) {
    box.innerHTML = '';
    // #351: the placeholder wipe detaches any tracked group — start fresh.
    currentLogSuite = null;
    currentLogGroupBody = null;
  }
  events.forEach(e => {
    const line = document.createElement('div');
    line.className = `log-line l-${e.level}`;
    line.dataset.level = e.level;
    line.dataset.request = e.request_name || '';
    registerLogRequest(e.request_name);
    // #336 (v1.11.113): show milliseconds in the timestamp prefix. ts is
    // an ISO string like "2026-06-09T19:12:42.123Z" — slice(11,23) gives
    // "19:12:42.123". Previously slice(11,19) dropped the ms portion,
    // making it hard to correlate OSCAR log lines with provider-side logs
    // at sub-second precision.
    line.textContent = `[${e.ts.slice(11,23)}] ${e.message}`;
    // Apply current filters to new lines
    if (!levelVisible(e.level)) line.classList.add('hidden');
    if (logSearchTerm && !e.message.toLowerCase().includes(logSearchTerm)) line.classList.add('hidden');
    if (activeLogRequest !== 'all' && (e.request_name || '') !== activeLogRequest) line.classList.add('hidden');
    logGroupBodyFor(e.suite_name, box).appendChild(line);
    lastEventId = Math.max(lastEventId, e.id);
  });
  syncLogGroups();
  if (document.getElementById('autoscroll').checked) {
    box.scrollTop = box.scrollHeight;
  }
  updateLogMatchCount();
}

function applyLogFilters() {
  const box = document.getElementById('log-box');
  const lines = box.querySelectorAll('.log-line');
  lines.forEach(line => {
    const level = line.dataset.level;
    const text = line.textContent.toLowerCase();
    const levelOk = levelVisible(level);
    const searchOk = !logSearchTerm || text.includes(logSearchTerm);
    const requestOk = activeLogRequest === 'all' || (line.dataset.request || '') === activeLogRequest;
    line.classList.toggle('hidden', !(levelOk && searchOk && requestOk));
  });
  syncLogGroups();
  updateLogMatchCount();
}

function updateLogMatchCount() {
  const box = document.getElementById('log-box');
  const visible = box.querySelectorAll('.log-line:not(.hidden)').length;
  const total = box.querySelectorAll('.log-line').length;
  const el = document.getElementById('log-match-count');
  if (total > 0 && (activeLogLevel !== 'all' || logSearchTerm || activeLogRequest !== 'all')) {
    el.textContent = `${visible}/${total} shown`;
  } else {
    el.textContent = '';
  }
}

function copyLogs() {
  const box = document.getElementById('log-box');
  const visible = [...box.querySelectorAll('.log-line:not(.hidden)')].map(l => l.textContent).join('\n');
  navigator.clipboard.writeText(visible).then(() => {
    const btn = document.getElementById('log-copy-btn');
    btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = 'Copy', 2000);
  }).catch(oscarReportError);
}

function downloadLogs() {
  const box = document.getElementById('log-box');
  const visible = [...box.querySelectorAll('.log-line:not(.hidden)')].map(l => l.textContent).join('\n');
  const blob = new Blob([visible], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `run-${runId.slice(0,8)}-logs.txt`;
  a.click();
}

async function poll() {
  // #343 followup (v1.11.117): the /logs endpoint caps each fetch at 500
  // rows. The old loop stopped polling the moment the run reached a terminal
  // status — stranding everything past the first page when a finished run
  // was opened after the fact ("log stops before the offer request"). Now a
  // full page (has_more from the server, with a length fallback) forces an
  // immediate follow-up fetch to drain the backlog, and only then does the
  // terminal status end the loop.
  let drainBacklog = false;
  try {
    const [runRes, logRes] = await Promise.all([
      fetch(`/v1/runs/${encodeURIComponent(runId)}`,       {}),
      fetch(`/v1/runs/${encodeURIComponent(runId)}/logs?since_id=${lastEventId}`, {})
    ]);
    if (runRes.status === 401) { logout(); return; }
    const run  = await runRes.json();
    const logs = await logRes.json();
    updateStatus(run);
    const events = logs.events || [];
    appendLogs(events);
    drainBacklog = logs.has_more === true || events.length >= 500;
  } catch(e) { /* network hiccup - keep polling */ }

  if (drainBacklog)  setTimeout(poll, 50);
  else if (polling)  setTimeout(poll, 1500);
}

async function loadArtifacts() {
  const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/artifacts`, {});
  if (!res.ok) return;
  const data = await res.json();
  if (!data.artifacts.length) return;

  document.getElementById('artifacts-card').style.display = 'block';
  document.getElementById('artifacts-list').innerHTML = data.artifacts.map(a => {
    // HTML reports are served via the public static /artifacts route (no auth needed in browser).
    // JSON results keep the authenticated API endpoint for programmatic access — for those
    // we render a button that does an authenticated fetch + Blob download (a plain <a href>
    // would 401 because the browser does not send the Bearer token automatically).
    // For HTML reports extract the scenario code from the filename:
    // report_{SCENARIO_CODE}.html → "OTST RFND PATCH ..." (underscores → spaces)
    // Falls back to "HTML Report" for legacy single-scenario report.html
    const scenarioLabel = a.type === 'html_report'
      ? (a.filename.replace(/^report_/, '').replace(/\.html$/i, '').replaceAll('_', ' ') || 'HTML Report')
      : null;
    const label    = a.type === 'html_report' ? `📊 ${scenarioLabel}` : '📄 JSON Results';
    if (a.type === 'html_report') {
      const href = `/artifacts/${encodeURIComponent(runId)}/${a.filename}`;
      return `
      <div class="artifact-row">
        <span style="flex:1;font-weight:600">${label}</span>
        <span style="color:#90a4ae;font-size:12px">${a.filename}</span>
        <a href="${href}" target="_blank" class="btn btn-dl">🔍 Open Report</a>
      </div>`;
    }
    const _ext    = (a.filename.match(/\.([A-Za-z0-9]+)$/) || [])[1] || 'json';
    const _dlName = `${friendlyArtifactBase()}.${_ext}`;
    return `
    <div class="artifact-row">
      <span style="flex:1;font-weight:600">${label}</span>
      <span style="color:#90a4ae;font-size:12px" title="stored as ${a.filename}">${_dlName}</span>
      <button class="btn btn-dl" data-action="download-artifact" data-artifact-id="${a.id}" data-filename="${_dlName}">⬇ Download</button>
    </div>`;
  }).join('');
}

// Authenticated artifact download. Replaces the plain <a href> the JSON
// results used to use, which requires an authenticated request (the session
// cookie is sent automatically by the browser for same-origin requests).
async function downloadArtifact(artifactId, filename) {
  try {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/artifacts/${artifactId}`, {});
    if (res.status === 401) { logout(); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      oscarToast(`Download failed (${res.status}): ${err.detail || err.title || 'Unknown error'}`, 'error');
      return;
    }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename || 'artifact';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch (e) {
    oscarToast('Network error during download: ' + e.message, 'error');
  }
}

// Delegate clicks on the artifacts card so the listener survives re-renders.
document.getElementById('artifacts-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action="download-artifact"]');
  if (!btn) return;
  e.preventDefault();
  downloadArtifact(btn.dataset.artifactId, btn.dataset.filename).catch(oscarReportError);
});

async function deleteRun() {
  if (!confirm('Delete this run? It will no longer appear in the dashboard.')) return;
  const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'DELETE',
    });
  if (res.status === 401) { logout(); return; }
  if (res.ok) {
    window.location.href = '/dashboard.html';
  } else {
    const err = await res.json();
    oscarToast(err.detail || 'Could not delete run.', 'error');
  }
}

document.getElementById('delete-btn-wrap').addEventListener('click', function(e) {
  if (e.target.closest('[data-action="delete-run"]')) deleteRun().catch(oscarReportError);
});
document.getElementById('share-btn-wrap').addEventListener('click', function(e) {
  if (e.target.closest('[data-action="share-run"]'))   shareRunWithCertifier(true).catch(oscarReportError);
  if (e.target.closest('[data-action="unshare-run"]')) shareRunWithCertifier(false).catch(oscarReportError);
});

// ── Assertions ──────────────────────────────────────────────────────────────
let assertionsData = null;
let activeAssertionFilter = 'all';

// S11: the one shared escaper (js/esc.js, loaded before this script). Was a local escHtml.
const escHtml = window.esc;

async function loadAssertions() {
  try {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/assertions`, {});
    if (!res.ok) return;
    assertionsData = await res.json();
    if (!assertionsData.summary || assertionsData.summary.total === 0) return;
    document.getElementById('assertions-card').style.display = 'block';

    // Populate filter dropdowns
    const catSel = document.getElementById('assertion-category-filter');
    const domSel = document.getElementById('assertion-domain-filter');
    (assertionsData.by_category || []).forEach(c => {
      const o = document.createElement('option');
      o.value = c.category; o.textContent = (c.category||'other') + ' (' + c.total + ')';
      catSel.appendChild(o);
    });
    (assertionsData.by_domain || []).forEach(d => {
      const o = document.createElement('option');
      o.value = d.domain; o.textContent = (d.domain||'other') + ' (' + d.total + ')';
      domSel.appendChild(o);
    });
    renderAssertions();
  } catch { /* optional card: a failure to load it is not shown to the user */ }
}

// The PASS / FAIL / SKIP badge of a request.
function resultBadgeHtml(result) {
  if (result === 'PASS') return '<span class="a-pass">PASS</span>';
  if (result === 'FAIL') return '<span class="a-fail">FAIL</span>';
  return '<span style="color:#90a4ae">SKIP</span>';
}

// Two-level collapse: suite (main area) → request (endpoint) → assertions.
// Everything starts collapsed; clicking a suite reveals its endpoints (still
// collapsed), clicking an endpoint reveals its assertions.
function renderAssertions() {
  if (!assertionsData) return;
  const s = assertionsData.summary;
  const passRate = s.total > 0 ? Math.round(s.passed / s.total * 1000) / 10 : 0;
  document.getElementById('assertion-summary').innerHTML =
    `<strong>${esc(s.total)}</strong> assertions — <span class="a-pass">${esc(s.passed)} passed</span> · <span class="a-fail">${esc(s.failed)} failed</span> · <strong>${esc(passRate)}%</strong> pass rate
     <span style="color:#90a4ae;font-size:11px;margin-left:6px">(click an area to expand)</span>`;

  const catFilter = document.getElementById('assertion-category-filter').value;
  const domFilter = document.getElementById('assertion-domain-filter').value;
  let html = '';

  for (const suite of assertionsData.suites || []) {
    let reqsHtml = '';
    let suiteFiltered = 0;
    let suiteFailed = 0;

    for (const req of suite.requests || []) {
      let assertions = req.assertions || [];
      if (activeAssertionFilter === 'passed') assertions = assertions.filter(a => a.passed);
      if (activeAssertionFilter === 'failed') assertions = assertions.filter(a => !a.passed);
      if (catFilter) assertions = assertions.filter(a => a.category === catFilter);
      if (domFilter) assertions = assertions.filter(a => a.domain === domFilter);
      if (assertions.length === 0) continue;
      suiteFiltered += assertions.length;
      const reqFailed = assertions.filter(a => !a.passed).length;
      suiteFailed += reqFailed;

      const statusBadge = resultBadgeHtml(req.result);

      let rowsHtml = '';
      for (const a of assertions) {
        const icon = a.passed ? '<span class="a-pass">✓</span>' : '<span class="a-fail">✗</span>';
        const sev = !a.passed && a.severity ? `<span class="a-badge a-sev-${a.severity}">${escHtml(a.severity)}</span>` : '';
        // #387: the decoded failure message is the payload of a failed row —
        // it used to be clipped to 60 chars in a 180px column ("half hidden",
        // tester finding). It now gets a full-width wrapped line of its own
        // under the row; nothing truncates.
        const hasMsg = !a.passed && a.error_msg;
        rowsHtml += `<div class="assertion-row${hasMsg ? ' has-msg' : ''}">${icon}
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(a.assertion_name)}">${escHtml(a.assertion_name)}</span>
          ${a.category ? `<span class="a-badge a-cat">${escHtml(a.category)}</span>` : ''}
          ${a.domain ? `<span class="a-badge a-dom">${escHtml(a.domain)}</span>` : ''}
          ${sev}
        </div>`;
        if (hasMsg) {
          rowsHtml += `<div class="assertion-msg">⚠ ${escHtml(a.error_msg)}</div>`;
        }
      }

      reqsHtml += `<div class="areq">
        <div class="req-header collapsible-head" data-action="toggle-areq"><span class="chev">▶</span>
          ${statusBadge} <span>${escHtml(req.request_name)}</span>
          <span class="areq-count">${escHtml(req.http_method||'')} ${escHtml(req.http_status||'')} · ${req.duration_ms||0}ms · ${assertions.length} assertion${assertions.length!==1?'s':''}${reqFailed>0?` · <span class="a-fail">${reqFailed} failed</span>`:''}</span>
        </div>
        <div class="areq-body">${rowsHtml}</div>
      </div>`;
    }

    if (suiteFiltered === 0) continue;
    html += `<div class="asuite">
      <div class="suite-header collapsible-head" data-action="toggle-asuite"><span class="chev">▶</span>
        ${escHtml(suite.suite_name)} — ${suiteFiltered} assertion${suiteFiltered!==1?'s':''}${suiteFailed>0?` · <span style="color:#c62828">${suiteFailed} failed</span>`:''} · ${suite.pass_rate}%</div>
      <div class="asuite-body">${reqsHtml}</div>
    </div>`;
  }

  document.getElementById('assertion-content').innerHTML = html || '<div style="padding:16px;color:#90a4ae">No assertions match the selected filters.</div>';
}

// Collapse/expand toggles for the two assertion levels.
document.getElementById('assertion-content').addEventListener('click', function(e) {
  const sh = e.target.closest('[data-action="toggle-asuite"]');
  if (sh) { sh.parentElement.classList.toggle('open'); return; }
  const rh = e.target.closest('[data-action="toggle-areq"]');
  if (rh) { rh.parentElement.classList.toggle('open'); }
});

// Assertion filter event listeners
document.getElementById('assertions-card').addEventListener('click', function(e) {
  const btn = e.target.closest('.assertion-filter');
  if (!btn) return;
  activeAssertionFilter = btn.dataset.filter;
  document.querySelectorAll('.assertion-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderAssertions();
});
document.getElementById('assertion-category-filter').addEventListener('change', function() { renderAssertions(); });
document.getElementById('assertion-domain-filter').addEventListener('change', function() { renderAssertions(); });

// Log filter event listeners
document.querySelector('.card-header').addEventListener('click', function(e) {
  const btn = e.target.closest('.log-level-btn');
  if (!btn) return;
  activeLogLevel = btn.dataset.level;
  document.querySelectorAll('.log-level-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  applyLogFilters();
});
document.getElementById('log-search').addEventListener('input', function() {
  logSearchTerm = this.value.toLowerCase().trim();
  applyLogFilters();
});
document.getElementById('log-req-filter').addEventListener('change', function() {
  activeLogRequest = this.value;
  applyLogFilters();
});
document.getElementById('log-copy-btn').addEventListener('click', copyLogs);
document.getElementById('log-download-btn').addEventListener('click', downloadLogs);

// Collapse / expand the whole Execution Log card.
document.getElementById('log-toggle').addEventListener('click', function() {
  document.getElementById('log-card').classList.toggle('collapsed');
});

// ── HTTP Traffic (request / response messages) ───────────────────────────────
// Same suite → endpoint structure as the assertions, collapsed by default.
// Bodies are fetched lazily the first time an endpoint is expanded (the list
// endpoint returns metadata only, so we avoid pulling every body up-front).
let requestsData = null;
let activeReqFilter = 'all';

async function loadRequests() {
  try {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/requests?status_filter=${encodeURIComponent(activeReqFilter)}`, {});
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;
    requestsData = await res.json();
    if (!requestsData.requests || requestsData.requests.length === 0) {
      // Only hide on the unfiltered (all) view — keep the card visible so the
      // user can switch filters back.
      if (activeReqFilter === 'all') return;
    }
    document.getElementById('requests-card').style.display = 'block';
    renderRequests();
  } catch { /* optional card: a failure here is not shown to the user */ }
}

function renderRequests() {
  if (!requestsData) return;
  const reqs = requestsData.requests || [];
  document.getElementById('requests-summary').innerHTML =
    `<strong>${esc(reqs.length)}</strong> request${reqs.length!==1?'s':''} <span style="color:#90a4ae;font-size:11px;margin-left:6px">(click an endpoint to load its request &amp; response)</span>`;

  // Group by suite, preserving first-seen order.
  const order = [];
  const bySuite = new Map();
  for (const r of reqs) {
    const key = r.suite_name || r.scenario_name || '—';
    if (!bySuite.has(key)) { bySuite.set(key, []); order.push(key); }
    bySuite.get(key).push(r);
  }

  let html = '';
  for (const suiteName of order) {
    const group = bySuite.get(suiteName);
    let rowsHtml = '';
    for (const r of group) {
      const st = r.http_status;
      const ok = typeof st === 'number' && st >= 200 && st < 300;
      const badgeClass = ok ? 'a-pass' : 'a-fail';
      const badge = st == null ? '<span style="color:#90a4ae">—</span>'
        : `<span class="${badgeClass}">${escHtml(st)}</span>`;
      rowsHtml += `<div class="areq" data-req-id="${escHtml(r.id)}">
        <div class="req-header collapsible-head" data-action="toggle-rreq"><span class="chev">▶</span>
          ${badge} <span>${escHtml(r.request_name)}</span>
          <span class="areq-count">${escHtml(r.http_method||'')} · ${r.duration_ms||0}ms${r.failed>0?` · <span class="a-fail">${r.failed} failed</span>`:''}</span>
        </div>
        <div class="areq-body"><div class="msg-loading">Click to load…</div></div>
      </div>`;
    }
    html += `<div class="asuite">
      <div class="suite-header collapsible-head" data-action="toggle-rsuite"><span class="chev">▶</span>
        ${escHtml(suiteName)} — ${group.length} request${group.length!==1?'s':''}</div>
      <div class="asuite-body">${rowsHtml}</div>
    </div>`;
  }
  document.getElementById('requests-content').innerHTML = html || '<div style="padding:16px;color:#90a4ae">No requests match the selected filter.</div>';
}

// #287: HTTP-Traffic body viewer — opt-in structured Tree view.
//   - Raw view is the DEFAULT (no behaviour change for users who don't toggle).
//   - Tree view lazy-loads vanilla-jsoneditor only on first click.
//   - Guards: non-JSON bodies and bodies > MSG_TREE_MAX_BYTES leave the toggle disabled.
const MSG_TREE_MAX_BYTES = 2 * 1024 * 1024;   // 2 MB cap for tree view
let __msgIdCounter = 0;
let __jsoneditorModulePromise = null;          // cached module loader
function loadJsonEditorModule() {
  if (!__jsoneditorModulePromise) {
    __jsoneditorModulePromise = import('/vendor/vanilla-jsoneditor/standalone.js')
      .catch(err => { __jsoneditorModulePromise = null; throw err; });
  }
  return __jsoneditorModulePromise;
}
// Escape "<\/script" inside the inline JSON payload so it cannot terminate
// its inline <script type="application/json"> envelope (the JSON is data,
// not executed). Anywhere in this source where the literal sequence
// "<\/script" would otherwise appear is written as "<\/script" — the JS
// engine collapses "\/" to "/", so the EMITTED HTML is correct, while the
// HTML parser scanning this <script> block does NOT see "</" and therefore
// does NOT terminate this outer <script> while reading the source.
function safeJsonForInlineScript(s) {
  return String(s).replace(/<\/(?=script)/gi, String.raw`<\/`);
}

function renderMessage(label, meta, body, opts) {
  // opts: { kind: 'request'|'response', stepName: string, scenarioName: string }
  // — used to build the Copy/Download buttons' filename. All optional;
  // sensible fallbacks keep the function callable from existing sites that
  // didn't pass opts.
  opts = opts || {};
  const kind         = opts.kind || (String(label).toLowerCase().includes('request') ? 'request' : 'response');
  const stepName     = opts.stepName || '';
  const scenarioName = opts.scenarioName || '';
  const id = `m${++__msgIdCounter}`;
  let pretty = body;
  let parsedOk = false;
  let payloadSize = 0;
  if (body) {
    payloadSize = (typeof body === 'string') ? body.length : 0;
    try {
      const parsed = JSON.parse(body);
      pretty = JSON.stringify(parsed, null, 2);
      parsedOk = true;
    } catch {
      // Not JSON: show the body as received.
      pretty = body;
    }
  }
  const canTree = parsedOk && payloadSize > 0 && payloadSize <= MSG_TREE_MAX_BYTES;
  let toggleHtml = '';
  let payloadScript = '';
  let treeDiv = '';
  if (canTree) {
    toggleHtml =
      `<div class="msg-toggle-group" data-msg-id="${id}">`
        + `<button class="msg-toggle active" data-mode="raw" type="button">Raw</button>`
        + `<button class="msg-toggle" data-mode="tree" type="button" title="Structured tree view with key/value search (lazy-loaded)">Tree</button>`
      + `</div>`;
    // IMPORTANT: write "<\/script>" (not the literal closing tag) so the HTML
    // parser does NOT terminate this outer <script> block while reading the
    // source. JS interprets "\/" as "/", so the EMITTED HTML is correct.
    payloadScript = `<script type="application/json" id="${id}-payload">${safeJsonForInlineScript(pretty)}<\/script>`;
    treeDiv = `<div class="msg-tree" id="${id}-tree" style="display:none"></div>`;
  } else if (body) {
    let reason = '';
    if (!parsedOk) reason = 'Body is not JSON — tree view unavailable';
    else if (payloadSize > MSG_TREE_MAX_BYTES) reason = `Body > ${Math.round(MSG_TREE_MAX_BYTES/1024/1024)} MB — too large for tree view`;
    if (reason) {
      toggleHtml =
        `<div class="msg-toggle-group disabled" title="${escHtml(reason)}">`
          + `<button class="msg-toggle active" disabled type="button">Raw</button>`
          + `<button class="msg-toggle" disabled type="button">Tree</button>`
        + `</div>`;
    }
  }
  // Tester-ergonomics buttons (#325): Copy + Download + Expand/Collapse for
  // the raw payload. Hidden when there is no body. Filename built from the
  // scenario + step + direction so downloaded files are self-identifying.
  let actionsHtml = '';
  if (body) {
    actionsHtml =
      `<div class="msg-actions" data-msg-id="${id}" data-msg-kind="${escHtml(kind)}" `
        + `data-msg-step="${escHtml(stepName)}" data-msg-scenario="${escHtml(scenarioName)}">`
        + `<button class="msg-act" data-act="copy" type="button" title="Copy body to clipboard">Copy</button>`
        + `<button class="msg-act" data-act="download" type="button" title="Download body as JSON">Download</button>`
        + `<button class="msg-act" data-act="expand" type="button" title="Expand / collapse the body box">⌄ Expand</button>`
      + `</div>`;
  }
  // #350: headers ride between meta and body — real HTTP message order
  // (status line → headers → body). Collapsed by default.
  const headersHtml = opts.headersHtml || '';
  return `<div class="msg-header"><div class="msg-label">${escHtml(label)}</div>${toggleHtml}${actionsHtml}</div>`
    + (meta ? `<div class="msg-meta">${meta}</div>` : '')
    + headersHtml
    + payloadScript
    + `<pre class="msg-pre" id="${id}-raw">${escHtml(pretty || '(empty)')}</pre>`
    + treeDiv;
}

// Mount the tree view on demand. Idempotent — no-ops if already mounted or if
// the payload script went missing.
async function mountJsonTree(msgId) {
  const target = document.getElementById(`${msgId}-tree`);
  if (!target || target.dataset.mounted === '1') return;
  const payloadEl = document.getElementById(`${msgId}-payload`);
  if (!payloadEl) return;
  let parsed;
  try { parsed = JSON.parse(payloadEl.textContent); }
  catch (_) { return; }
  let mod;
  try { mod = await loadJsonEditorModule(); }
  catch (err) {
    console.warn('[run-detail] vanilla-jsoneditor failed to load — Tree view unavailable, Raw view still works', err);
    target.textContent = 'Tree view unavailable (failed to load editor).';
    return;
  }
  try {
    mod.createJSONEditor({
      target,
      props: {
        content: { json: parsed },
        readOnly: true,
        mode: 'tree',
        mainMenuBar: true,
        navigationBar: true,
        statusBar: false
      }
    });
    target.dataset.mounted = '1';
  } catch (err) {
    console.warn('[run-detail] vanilla-jsoneditor mount failed — Raw view still works', err);
    target.textContent = 'Tree view failed to mount.';
  }
}

// #350: collapsible header table for one direction (request or response).
// Headers are stored alongside the bodies (credential values already masked
// at capture by the server — head + last 4 chars kept so the tester can
// check the right token was used). Includes every captured header, also the
// non-mandatory ones (traceId, correlation ids…) useful for provider debug.
function renderHeadersBlock(label, headersJson) {
  let h = headersJson;
  if (typeof h === 'string') { try { h = JSON.parse(h); } catch (_) { h = null; } }
  if (!h || typeof h !== 'object') return '';
  const keys = Object.keys(h).sort((a, b) => a.localeCompare(b));
  if (!keys.length) return '';
  const rows = keys.map(k => {
    const v = typeof h[k] === 'string' ? h[k] : JSON.stringify(h[k]);
    return `<tr><td class="hdr-k">${escHtml(k)}</td><td class="hdr-v">${escHtml(v)}</td></tr>`;
  }).join('');
  return `<details class="hdr-details"><summary class="hdr-summary">${escHtml(label)} (${keys.length})</summary>`
    + `<table class="hdr-table"><tbody>${rows}</tbody></table></details>`;
}

async function loadRequestBodies(reqId, bodyEl) {
  bodyEl.innerHTML = '<div class="msg-loading">Loading…</div>';
  try {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/requests/${encodeURIComponent(reqId)}`, {});
    if (res.status === 401) { logout(); return; }
    if (!res.ok) { bodyEl.innerHTML = '<div class="msg-loading">Could not load this message.</div>'; return; }
    const d = await res.json();
    const r = d.request || {};
    const reqMeta = `${escHtml(r.http_method||'')} ${escHtml(r.http_url||'')}`.trim();
    const resMeta = r.http_status != null ? `HTTP ${escHtml(r.http_status)}` : '';
    // #325: pass step + scenario into renderMessage so the Download button can
    // produce a self-identifying filename like
    //   `${scenario}_${step}_response.json`.
    const msgOpts = { stepName: r.request_name || '', scenarioName: r.scenario_name || r.suite_name || '' };
    bodyEl.innerHTML = '<div class="msg-block">'
      + renderMessage('Request', reqMeta, r.request_body,
          { kind: 'request',
            headersHtml: renderHeadersBlock('Request headers', r.request_headers), ...msgOpts })
      + renderMessage('Response', resMeta, r.response_body,
          { kind: 'response',
            headersHtml: renderHeadersBlock('Response headers', r.response_headers), ...msgOpts })
      + '</div>';
  } catch (e) {
    console.error('Loading the message failed:', e);
    bodyEl.innerHTML = '<div class="msg-loading">Network error loading this message.</div>';
  }
}

// #325: tester ergonomics — Copy / Download / Expand handlers for the
// per-message action buttons. Filename pattern:
//   ${scenario}_${step}_${kind}.json
// with non-filesystem-safe chars collapsed to underscores.
function _msgSanitiseFilename(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
function _msgFlash(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1100);
}
function _msgGetBodyText(msgId) {
  // The <pre> always carries the pretty-printed text (already escaped HTML
  // entities → use textContent so the clipboard / download gets the original
  // JSON, not the escaped HTML).
  const rawEl = document.getElementById(`${msgId}-raw`);
  return rawEl ? rawEl.textContent : '';
}

// Collapse/expand + lazy body load for the HTTP Traffic section.
document.getElementById('requests-content').addEventListener('click', function(e) {
  // #325: per-message action buttons (Copy / Download / Expand).
  const actBtn = e.target.closest('.msg-actions .msg-act');
  if (actBtn) {
    const wrap     = actBtn.closest('.msg-actions');
    const msgId    = wrap && wrap.dataset.msgId;
    const kind     = (wrap && wrap.dataset.msgKind) || 'response';
    const stepName = (wrap && wrap.dataset.msgStep) || '';
    const scenario = (wrap && wrap.dataset.msgScenario) || '';
    const act      = actBtn.dataset.act;
    if (!msgId || !act) return;
    const bodyText = _msgGetBodyText(msgId);
    if (act === 'copy') {
      if (!bodyText) return;
      navigator.clipboard.writeText(bodyText)
        .then(() => _msgFlash(actBtn, 'Copied!'))
        .catch(() => _msgFlash(actBtn, 'Copy failed'));
      return;
    }
    if (act === 'download') {
      if (!bodyText) return;
      const filename = [
        _msgSanitiseFilename(scenario) || 'oscar',
        _msgSanitiseFilename(stepName) || 'request',
        kind
      ].join('_') + '.json';
      const blob = new Blob([bodyText], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      _msgFlash(actBtn, '✓ Downloaded');
      return;
    }
    if (act === 'expand') {
      const rawEl = document.getElementById(`${msgId}-raw`);
      if (!rawEl) return;
      const expanded = rawEl.classList.toggle('msg-pre--expanded');
      actBtn.textContent = expanded ? '⌃ Collapse' : '⌄ Expand';
      return;
    }
    return;
  }
  // #287: Tree/Raw toggle inside a body panel — handle first so the click
  // never falls through to a collapsible.
  const tgBtn = e.target.closest('.msg-toggle-group .msg-toggle');
  if (tgBtn && !tgBtn.disabled) {
    const group = tgBtn.closest('.msg-toggle-group');
    const msgId = group && group.dataset.msgId;
    const mode  = tgBtn.dataset.mode;
    if (!msgId || !mode) return;
    group.querySelectorAll('.msg-toggle').forEach(b => b.classList.toggle('active', b === tgBtn));
    const rawEl  = document.getElementById(`${msgId}-raw`);
    const treeEl = document.getElementById(`${msgId}-tree`);
    if (mode === 'tree') {
      if (rawEl)  rawEl.style.display  = 'none';
      if (treeEl) treeEl.style.display = '';
      mountJsonTree(msgId).catch(oscarReportError);
    } else {
      if (rawEl)  rawEl.style.display  = '';
      if (treeEl) treeEl.style.display = 'none';
    }
    return;
  }
  const sh = e.target.closest('[data-action="toggle-rsuite"]');
  if (sh) { sh.parentElement.classList.toggle('open'); return; }
  const rh = e.target.closest('[data-action="toggle-rreq"]');
  if (rh) {
    const areq = rh.parentElement;
    areq.classList.toggle('open');
    if (areq.classList.contains('open') && !areq.dataset.loaded) {
      areq.dataset.loaded = '1';
      loadRequestBodies(areq.dataset.reqId, areq.querySelector('.areq-body')).catch(oscarReportError);
    }
  }
});

// HTTP Traffic filter buttons (re-fetch with the server-side status filter).
document.getElementById('requests-card').addEventListener('click', function(e) {
  const btn = e.target.closest('.req-filter');
  if (!btn) return;
  activeReqFilter = btn.dataset.filter;
  document.querySelectorAll('.req-filter').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadRequests().catch(oscarReportError);
});

poll().catch(oscarReportError);
