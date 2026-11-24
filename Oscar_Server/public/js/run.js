/* global esc, oscarToastAfterNav, parseServerTs */  // esc.js, nav.js, loaded before it by the page
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of run.html, moved out of the page unchanged (#1423) so that
// the content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

const token = localStorage.getItem('oscar_token') || '';
if (!localStorage.getItem('oscar_user')) window.location.href = '/';
const company = JSON.parse(localStorage.getItem('oscar_company') || '{}');
const user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
// logout() provided by nav.js

const warnEl = document.getElementById('warn');
function showWarn(msg) { warnEl.innerHTML = msg; warnEl.style.display = 'block'; }
function addWarn(msg)  {
  warnEl.innerHTML += (warnEl.style.display === 'none' ? '' : '<br>') + msg;
  warnEl.style.display = 'block';
}

// #838: the warning to show when this company or provider follows a reference
// configuration of the repository and is not up to date with it; null otherwise.
function referenceNoticeText(state) {
  if (!state || !state.linked || state.up_to_date) return null;
  if (state.missing) return `This configuration follows the reference ${esc(state.linked)}, which this server cannot read.`;
  return `This configuration is not up to date with the reference ${esc(state.linked)}: a Test Manager can update it in <a href="/scenarios.html">Test Config</a> (Reference configuration).`;
}

async function referenceNotice() {
  try {
    const res = await fetch('/v1/company/reference');
    return res.ok ? referenceNoticeText(await res.json()) : null;
  } catch {
    return null;
  }
}

async function loadProfile() {
  // Two endpoints since v12: company-shared bits (api_base, datafile_*) and
  // per-tester credentials (auth_mode, OAuth profile, has_token, etc.) live
  // in different resources. Fetch both in parallel.
  const [companyRes, credsRes] = await Promise.all([
    fetch('/v1/company',         {}),
    fetch('/v1/me/credentials',  {})
  ]);
  if (!companyRes.ok || !credsRes.ok) return;
  const c = await companyRes.json();   // { api_base, datafile_*, ... }
  const m = await credsRes.json();     // { auth_mode, has_token, has_client_id, ... }

  let apiReady  = true;
  let testReady = false;
  const warnings = [];

  // An endpoint suspended after an intrusion attempt takes no run.
  if (c.endpoint_suspended_at) {
    warnings.push('⛔ <strong>Intrusion attempt detected</strong>: the OSDM endpoint is suspended. A Test Manager resumes it on <a href="/profile.html">API Config</a> once the provider is checked.');
    apiReady = false;
  }

  // Credentials saved for another endpoint are sent nowhere (utils/credentialEndpoint.js).
  if (m.endpoint_changed) {
    warnings.push(m.credentials_endpoint
      ? 'The OSDM endpoint changed since your credentials were saved: check them on <a href="/profile.html">API Config</a> and save them again.'
      : 'Your credentials were saved before there was an OSDM endpoint: check them on <a href="/profile.html">API Config</a> and save them again.');
    apiReady = false;
  }

  // Endpoint (company-shared)
  if (c.api_base) {
    document.getElementById('cfg-endpoint').textContent = c.api_base;
    document.getElementById('cfg-endpoint').classList.remove('missing');
  } else {
    document.getElementById('cfg-endpoint').textContent = '⚠  Not configured';
    warnings.push('API endpoint is not set — go to <a href="/profile.html">API Config</a>.');
    apiReady = false;
  }

  // Auth mode (per-tester)
  const authMode = m.auth_mode === 'oauth2' ? 'OAuth2 Client Credentials' : 'Bearer Token';
  document.getElementById('cfg-auth').innerHTML = `<span class="badge ${m.auth_mode === 'oauth2' ? 'badge-oauth' : 'badge-ok'}">${authMode}</span>`;

  // Credentials (per-tester)
  if (m.auth_mode === 'bearer' && m.has_token) {
    document.getElementById('cfg-creds').innerHTML = '<span class="badge badge-ok">✓ Bearer token configured</span>';
    document.getElementById('cfg-creds').classList.remove('missing');
  } else if (m.auth_mode === 'oauth2' && m.has_client_id && m.has_client_secret && m.token_url) {
    document.getElementById('cfg-creds').innerHTML = '<span class="badge badge-ok">✓ OAuth2 credentials configured</span>';
    document.getElementById('cfg-creds').classList.remove('missing');
  } else {
    document.getElementById('cfg-creds').textContent = '⚠  Credentials not configured';
    warnings.push('Authentication credentials are missing — go to <a href="/profile.html">API Config</a>.');
    apiReady = false;
  }

  // Requestor (per-tester)
  if (m.has_requestor) {
    document.getElementById('cfg-requestor').innerHTML = '<span class="badge badge-ok">✓ Configured</span>';
    document.getElementById('cfg-requestor').style.fontStyle = 'normal';
    document.getElementById('cfg-requestor').style.color = '';
  }

  // Subscription Key (per-tester)
  if (m.has_subscription_key) {
    document.getElementById('cfg-subscription-key').innerHTML = '<span class="badge badge-ok">✓ Configured</span>';
    document.getElementById('cfg-subscription-key').style.fontStyle = 'normal';
    document.getElementById('cfg-subscription-key').style.color = '';
  }

  // Test Configuration — fetch actual datafile to show scenariosToRun
  const dfEl = document.getElementById('cfg-datafile');
  if (!c.datafile_updated_at) {
    dfEl.textContent = '⚠  No test configuration — set up in Test Config';
    warnings.push('Test Configuration is not set up — go to <a href="/scenarios.html">Test Config</a> to upload or create one.');
  } else {
    // Fetch the datafile to read scenariosToRun
    try {
      const dfRes = await fetch('/v1/company/datafile', {});
      if (dfRes.ok) {
        const df = await dfRes.json();
        const totalCount = (df.scenarios || []).length;
        const toRun = df.scenariosToRun;
        let toRunDesc, toRunBadgeClass;

        if (toRun === 'ALL' || !Array.isArray(toRun)) {
          toRunDesc     = `All ${totalCount} scenario(s) — <a href="/scenarios.html">use Test Config to narrow this down</a>`;
          toRunBadgeClass = 'badge-warn';
        } else if (toRun.length === 0) {
          toRunDesc     = '⚠ 0 scenarios selected — run will fall back to ALL. <a href="/scenarios.html">Fix in Test Config</a>';
          toRunBadgeClass = 'badge-warn';
        } else {
          toRunDesc     = toRun.length + ' of ' + totalCount + ' scenario(s) in your run list';
          toRunBadgeClass = 'badge-ok';
        }
        // #1029: a batch is chosen below, from the whole file or the run list.
        testReady = true;

        dfEl.innerHTML =
          `<span class="badge ${toRunBadgeClass}">✓ Configured</span> ` +
          `<span style="color:#546e7a;font-size:12px"> · ${toRunDesc}</span>` +
          `<div style="font-size:11px;color:#90a4ae;margin-top:4px">Saved ${parseServerTs(c.datafile_updated_at).toLocaleString()}</div>`;
        dfEl.classList.remove('missing');
      } else {
        dfEl.innerHTML = '<span class="badge badge-warn">⚠ File missing on server</span>';
        warnings.push('Test Configuration file is missing on the server — go to <a href="/scenarios.html">Test Config</a> to re-upload.');
      }
    } catch {
      // The file exists but could not be read from here. The server reads it
      // itself at run time, so the run is not blocked.
      dfEl.innerHTML = `<span class="badge badge-warn">Uploaded ${parseServerTs(c.datafile_updated_at).toLocaleString()}</span>`;
      dfEl.classList.remove('missing');
      testReady = true;
    }
  }

  // #838: a configuration that follows a reference and is older than it.
  const referenceWarning = await referenceNotice();
  if (referenceWarning) warnings.push(referenceWarning);

  // Aggregate warnings
  if (warnings.length > 0) {
    warnEl.innerHTML = '⚠&nbsp; ' + warnings.join('<br>⚠&nbsp; ');
    warnEl.style.display = 'block';
  }

  launchReady = apiReady && testReady;
  if (testReady) await loadSelection(null);
  updateLaunchButton();
}

/* ── What this batch runs (#1029) ──
 * The filters, their values, labels and counts come from the server's preview
 * (POST /v1/runs/preview, utils/runFilters.js): the page only draws them and
 * sends back what is ticked. */
const SELECT_FILTERS = [['categories', 'Category'], ['modes', 'Distribution'], ['groups', 'Capability'], ['forms', 'Offer request']];
let launchReady = false;
let runSelection = null;
let selectedCount = 0;

function selectOptionHtml(type, key, value, label, count, checked) {
  const none = Number(count) === 0 ? ' none' : '';
  return '<label class="opt' + none + '"><input type="' + type + '" name="sel-' + esc(key) + '" value="' + esc(value) + '" data-select="' + esc(key) + '"'
    + (checked ? ' checked' : '') + '> ' + esc(label) + ' <span class="sel-count">(' + Number(count || 0) + ')</span></label>';
}

function selectionPanelHtml(preview) {
  const p = preview || {};
  const sel = p.selection || {};
  const counts = p.counts || {};
  const labels = p.labels || {};
  let html = '<fieldset class="sel"><legend>Scenarios</legend>'
    + selectOptionHtml('radio', 'base', 'all', 'Every scenario of the data file', p.seen, sel.base !== 'list')
    + selectOptionHtml('radio', 'base', 'list', 'My run list (Test Config)', p.runList, sel.base === 'list')
    + '</fieldset>';
  for (const [key, title] of SELECT_FILTERS) {
    const values = Object.keys(counts[key] || {}).filter(function(v) { return key !== 'categories' || v !== 'simulated' || counts[key][v] > 0; });
    const links = key === 'groups'
      ? '<span class="sel-links"><button type="button" data-action="sel-all" data-key="groups">All</button><button type="button" data-action="sel-none" data-key="groups">None</button></span>'
      : '';
    html += '<fieldset class="sel"><legend>' + esc(title) + '</legend>' + links + values.map(function(v) {
      return selectOptionHtml('checkbox', key, v, (labels[key] || {})[v] || v, counts[key][v], (sel[key] || []).includes(v));
    }).join('') + '</fieldset>';
  }
  const last = counts.lastRun || {};
  html += '<fieldset class="sel"><legend>Last run</legend>' + Object.keys(last).map(function(v) {
    return selectOptionHtml('radio', 'lastRun', v, (labels.lastRun || {})[v] || v, last[v], (sel.lastRun || 'all') === v);
  }).join('') + '</fieldset>';
  return html;
}

// The selection the panel shows, as the server takes it.
function selectionFromPanel(root) {
  const picked = function(key) {
    return Array.from(root.querySelectorAll('input[data-select="' + key + '"]')).filter(function(i) { return i.checked; }).map(function(i) { return i.value; });
  };
  const out = { base: picked('base')[0] || 'all', lastRun: picked('lastRun')[0] || 'all' };
  for (const [key] of SELECT_FILTERS) out[key] = picked(key);
  // A value the panel does not show (the simulated errors of a file without any) stays out.
  return out;
}

function launchButtonText(count) {
  return '\u25B6 Run ' + count + ' scenario(s)';
}

function updateLaunchButton() {
  const btn = document.getElementById('run-btn');
  btn.disabled = !(launchReady && selectedCount > 0);
  btn.textContent = runSelection ? launchButtonText(selectedCount) : '\u25B6 Start Conformance Test Run';
}

async function loadSelection(selection) {
  const panel = document.getElementById('select-panel');
  const summary = document.getElementById('sel-summary');
  try {
    const res = await fetch('/v1/runs/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection ? { selection: selection } : {})
    });
    const data = await res.json();
    if (!res.ok) {
      summary.textContent = data.detail || data.title || 'The choice of scenarios could not be read.';
      return;
    }
    runSelection = data.selection;
    selectedCount = data.selected;
    panel.innerHTML = selectionPanelHtml(data);
    summary.textContent = data.selected + ' of ' + data.total + ' scenario(s) will run.';
  } catch (e) {
    summary.textContent = 'The choice of scenarios could not be read: ' + e.message;
  }
  updateLaunchButton();
}

let selectionTimer = null;
document.getElementById('select-panel').addEventListener('change', function() {
  const selection = selectionFromPanel(document.getElementById('select-panel'));
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(function() { loadSelection(selection).catch(function() { /* shown in the summary */ }); }, 200);
});
document.getElementById('select-panel').addEventListener('click', function(e) {
  const btn = e.target.closest('[data-action="sel-all"], [data-action="sel-none"]');
  if (!btn) return;
  const on = btn.dataset.action === 'sel-all';
  document.querySelectorAll('#select-panel input[data-select="' + btn.dataset.key + '"]').forEach(function(i) { i.checked = on; });
  document.getElementById('select-panel').dispatchEvent(new Event('change'));
});

async function startRun() {
  const btn = document.getElementById('run-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Submitting...';

  const res = await fetch('/v1/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runSelection ? { parallel: true, selection: runSelection } : { parallel: true })
  });
  const data = await res.json();
  if (!res.ok) {
    showWarn(esc(data.detail || data.title || 'Failed to start run.'));
    updateLaunchButton();
    return;
  }

  oscarToastAfterNav('Batch submitted: ' + data.runs.length + ' scenarios queued (batch: ' + data.batch_id.slice(0, 8) + ')', 'success');
  window.location.href = '/dashboard.html';
}

document.querySelector('[data-action="start-run"]').addEventListener('click', startRun);

/* ── Queue Status Panel ── */
async function pollQueueStatus() {
  try {
    const res = await fetch('/v1/runs/queue-status', {});
    if (!res.ok) return;
    const data = await res.json();
    const panel = document.getElementById('queue-panel');
    const content = document.getElementById('queue-status-content');

    if (!data.runs || data.runs.length === 0) {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';

    const used = data.slots_used != null ? data.slots_used : data.runs.filter(function(r) { return r.status === 'RUNNING'; }).length;
    const total = data.slots_total != null ? data.slots_total : '?';
    const pct = data.slots_total ? Math.round((used / data.slots_total) * 100) : 0;

    var html = '';
    // Slot usage bar
    html += '<div style="margin-bottom:14px">';
    html += '<div style="font-size:12px;font-weight:700;color:#546e7a;margin-bottom:6px">' + used + '/' + total + ' slots used</div>';
    html += '<div style="background:#eceff1;border-radius:4px;height:8px;overflow:hidden">';
    html += '<div style="background:#0090D4;height:100%;width:' + pct + '%;border-radius:4px;transition:width .3s"></div>';
    html += '</div></div>';

    // Runs table
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px">';
    html += '<thead><tr style="border-bottom:2px solid #eceff1;text-align:left">';
    html += '<th style="padding:6px 8px;color:#78909c;font-size:11px;font-weight:700">#</th>';
    html += '<th style="padding:6px 8px;color:#78909c;font-size:11px;font-weight:700">SCENARIO</th>';
    html += '<th style="padding:6px 8px;color:#78909c;font-size:11px;font-weight:700">USER</th>';
    html += '<th style="padding:6px 8px;color:#78909c;font-size:11px;font-weight:700">STATUS</th>';
    html += '</tr></thead><tbody>';

    var queuePos = 0;
    data.runs.forEach(function(run) {
      var pos = '';
      if (run.status === 'QUEUED') { queuePos++; pos = '#' + queuePos; }

      // A colleague's run comes without its scenario or e-mail (1.11.477).
      var scenario = run.scenario_code || ((run.user_email || run.is_current_user) ? 'All scenarios' : 'Another tester\'s run');
      var email = run.user_email || '-';
      var youBadge = run.is_current_user
        ? ' <span style="background:#e3f2fd;color:#1565c0;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:4px">you</span>'
        : '';

      var statusBadge = '';
      if (run.status === 'RUNNING') {
        statusBadge = '<span class="badge badge-ok" style="display:inline-flex;align-items:center;gap:4px">'
          + '<svg width="12" height="12" viewBox="0 0 24 24" style="animation:spin 1s linear infinite"><circle cx="12" cy="12" r="10" stroke="#2e7d32" stroke-width="3" fill="none" stroke-dasharray="31.4 31.4" stroke-linecap="round"/></svg>'
          + 'RUNNING</span>';
      } else {
        statusBadge = '<span class="badge badge-warn">QUEUED</span>';
      }

      html += '<tr style="border-bottom:1px solid #f5f5f5">';
      html += '<td style="padding:6px 8px;color:#90a4ae;font-weight:700">' + pos + '</td>';
      html += '<td style="padding:6px 8px">' + scenario + '</td>';
      html += '<td style="padding:6px 8px">' + email + youBadge + '</td>';
      html += '<td style="padding:6px 8px">' + statusBadge + '</td>';
      html += '</tr>';
    });

    html += '</tbody></table>';
    content.innerHTML = html;
  } catch (e) {
    // silently ignore fetch errors for queue polling
  }
}
setInterval(pollQueueStatus, 5000);
pollQueueStatus();

loadProfile();
