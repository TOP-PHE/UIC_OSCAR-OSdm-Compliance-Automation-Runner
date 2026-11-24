// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0
//
// The script of admin-dashboard.html, moved out of the page unchanged (#1423) so that
// the content security policy can refuse inline scripts. The page loads it
// where its inline script stood, so it runs at the same moment as before.

// Show the access notice if the logged-in user isn't an administrator —
// they CAN navigate to this page but the SSO check will reject them at the
// Grafana / Prometheus boundary.
(function() {
  try {
    var user = JSON.parse(localStorage.getItem('oscar_user') || '{}');
    if (user.role !== 'administrator') {
      document.getElementById('non-admin-notice').style.display = 'block';
    }
  } catch (_e) { /* ignore */ }
})();

// #572: the disaster-recovery status, read only. Built with textContent: no
// value of the status file is ever written as markup.
var DR_FREQUENCIES = { daily: 'Daily (02:30)', weekly: 'Weekly (Monday 02:30)', monthly: 'Monthly (the 1st, 02:30)', custom: 'Custom timer', 'on-demand': 'On demand (no timer)' };
var DR_WARNINGS = {
  last_backup_failed: 'The last backup failed. Check the host log (journalctl -u oscar-backup).',
  next_run_past: 'The next run is in the past: the timer may be stopped.',
  more_archives_than_kept: 'More archives are present than the retention keeps.',
  no_restore_drill: 'No restore drill is recorded. Record one with oscar-backup-status.sh drill after a drill.'
};
function drWhen(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function drSize(bytes) {
  if (typeof bytes !== 'number') return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}
// The result of the last backup: its text and the class that colours it.
function drResult(ok) {
  if (ok === true) return ['OK', 'ok'];
  if (ok === false) return ['Failed', 'bad'];
  return ['—', ''];
}
function drItems(st) {
  var result = drResult(st.last_backup_ok);
  return [
    ['Last backup', drWhen(st.last_backup_at), ''],
    ['Result', result[0], result[1]],
    ['Size', drSize(st.last_backup_size_bytes), ''],
    ['Last success', drWhen(st.last_success_at), ''],
    ['Last failure', drWhen(st.last_failure_at), st.last_failure_at ? 'bad' : ''],
    ['Frequency', DR_FREQUENCIES[st.frequency] || '—', ''],
    ['Next run', drWhen(st.next_run), ''],
    ['Retention', typeof st.retention_keep === 'number' ? 'keeps ' + st.retention_keep : '—', ''],
    ['Archives present', typeof st.archives_present === 'number' ? String(st.archives_present) : '—', ''],
    ['Last restore drill', drWhen(st.last_restore_drill_at), ''],
    ['Recorded', drWhen(st.updated_at), '']
  ];
}
function drText(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}
function drRender(body, st) {
  body.replaceChildren();
  if (!st || st.state === 'none') {
    body.appendChild(drText('p', 'dr-note', 'No backup recorded yet. Install the schedule on the host (oscar-backup-schedule.sh) or run oscar-backup.sh once.'));
    return;
  }
  if (st.state !== 'reported') {
    body.appendChild(drText('p', 'dr-note', 'The status file on the host cannot be read. Run oscar-backup-status.sh show on the host.'));
    return;
  }
  var grid = document.createElement('div');
  grid.className = 'dr-grid';
  drItems(st).forEach(function (item) {
    var box = document.createElement('div');
    box.className = 'dr-item';
    box.appendChild(drText('div', 'dr-label', item[0]));
    box.appendChild(drText('div', 'dr-value' + (item[2] ? ' ' + item[2] : ''), item[1]));
    grid.appendChild(box);
  });
  body.appendChild(grid);
  var warnings = (st.warnings || []).filter(function (w) { return DR_WARNINGS[w]; });
  if (warnings.length) {
    var list = document.createElement('ul');
    list.className = 'dr-warnings';
    warnings.forEach(function (w) { list.appendChild(drText('li', '', DR_WARNINGS[w])); });
    body.appendChild(list);
  }
}
(function () {
  var user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}') || {}; } catch (_e) { user = {}; }
  if (user.role !== 'administrator') return;
  var panel = document.getElementById('dr-panel');
  var body = document.getElementById('dr-body');
  panel.hidden = false;
  fetch('/v1/admin/backup-status')
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    })
    .then(function (st) { drRender(body, st); })
    .catch(function (e) {
      body.replaceChildren(drText('p', 'dr-note', 'The status could not be loaded (' + e.message + ').'));
    });
})();
// The intrusion attempts runs met (GET /v1/admin/security-events), as text.
function secRender(body, events) {
  if (!events.length) { body.replaceChildren(drText('p', 'dr-note', 'None recorded.')); return; }
  var table = document.createElement('table');
  table.style.cssText = 'border-collapse:collapse;width:100%;font-size:13px';
  var head = document.createElement('tr');
  ['Detected (UTC)', 'Company or provider', 'Kind', 'Step', 'Run started by', 'Endpoint'].forEach(function (h) { head.appendChild(drText('th', '', h)); });
  table.appendChild(head);
  events.forEach(function (e) {
    var tr = document.createElement('tr');
    [e.detected_at, e.company_name, e.kind, e.step || '', e.started_by || '',
     e.resumed_at ? 'resumed ' + e.resumed_at + ' by ' + (e.resumed_by || '?') : 'SUSPENDED'
    ].forEach(function (v) { tr.appendChild(drText('td', '', String(v))); });
    table.appendChild(tr);
  });
  body.replaceChildren(table);
}
(function () {
  var user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}') || {}; } catch (_e) { user = {}; }
  if (user.role !== 'administrator') return;
  var body = document.getElementById('sec-body');
  document.getElementById('sec-panel').hidden = false;
  fetch('/v1/admin/security-events')
    .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function (r) { secRender(body, r.events || []); })
    .catch(function (e) { body.replaceChildren(drText('p', 'dr-note', 'The list could not be loaded (' + e.message + ').')); });
})();
// The Prometheus card where the server runs (GET /v1/admin/deployment, #1187):
// on Kubernetes Prometheus's own page is not published, on purpose; its
// queries run in Grafana's Explore. null keeps the card as it is (the VPS).
function prometheusCardFor(kind) {
  if (kind !== 'kubernetes') return null;
  return {
    href: '/grafana/explore',
    title: 'Prometheus, in Grafana',
    desc: 'On Kubernetes Prometheus\'s own page is not published. Its PromQL queries run in Grafana → Explore, data source Prometheus; the query up lists the scrape targets.',
    cta: 'Open Explore →'
  };
}
(function () {
  var user = {};
  try { user = JSON.parse(localStorage.getItem('oscar_user') || '{}') || {}; } catch (_e) { user = {}; }
  if (user.role !== 'administrator') return;
  fetch('/v1/admin/deployment')
    .then(function (res) {
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      return res.json();
    })
    .then(function (d) {
      var card = prometheusCardFor(d.kind);
      if (!card) return;
      var a = document.getElementById('prometheus-card');
      a.href = card.href;
      a.querySelector('.card-title').textContent = card.title;
      a.querySelector('.card-desc').textContent = card.desc;
      a.querySelector('.card-cta').textContent = card.cta;
    })
    .catch(function () { /* the card stays as it is */ });
})();
