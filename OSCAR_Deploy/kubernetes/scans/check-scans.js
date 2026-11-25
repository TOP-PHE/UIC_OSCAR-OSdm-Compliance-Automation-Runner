// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// check-scans.js <kubescape|kube-bench|trivy> <results.json> — a scan's
// findings against the accepted list (accepted.json beside this file), #1438,
// Trivy since #1453.
//
// Fails (exit 1) on a finding the list does not accept, on an accepted entry
// that matched nothing (the list stays true: remove what no longer fails), and
// on an entry without its reason. Prints every finding, and writes the same
// to the job summary when $GITHUB_STEP_SUMMARY is set. No dependency.
//
//  - Kubescape (JSON output): a finding is a control that failed on a
//    resource of a rendered file: "overlays-k3s:Deployment/-/oscar"
//    (file:kind/namespace/name, the namespace "-" for none). An accepted
//    entry names its control and the resources it covers, each
//    "Kind/namespace/name" (in any file) or "file:Kind/namespace/name", "*"
//    for any part: ["Deployment/oscar/*"], ["overlays-openshift:*/*/*"], or
//    ["*"] for all.
//  - kube-bench (--json): a finding is a check that FAILED, by number
//    ("1.1.1"). WARN checks are the benchmark's manual ones: listed, never
//    failing.
//  - Trivy (`trivy config --format json`): a finding is a misconfiguration
//    that failed, in a Dockerfile (its folder: "dockerfile-run") or a
//    rendered file, with the resource Trivy's message names:
//    "overlays-k3s:Deployment/oscar". An accepted entry names its check and
//    what it covers: "file", "file:Kind/name", "Kind/name" (in any file),
//    "*" for any part.

const fs = require('node:fs');
const path = require('node:path');

const TOOLS = ['kubescape', 'kube-bench', 'trivy'];

// ── Kubescape ────────────────────────────────────────────────────────────────
function resourceName(object) {
  const kind = object?.kind || '?';
  // A related object (an RBAC subject) names itself without metadata.
  const meta = object?.metadata || object || {};
  return `${kind}/${meta.namespace || '-'}/${meta.name || '?'}`;
}

// What the control found wrong: its failed, fix, review and delete paths.
function pathsOf(control) {
  const out = [];
  const walk = (value, depth) => {
    if (depth > 6 || out.length >= 6 || value === null || typeof value !== 'object') return;
    for (const [key, x] of Object.entries(value)) {
      if (key === 'fixPath' && x && typeof x.path === 'string' && x.path) out.push(`${x.path}=${x.value}`);
      else if (typeof x === 'string' && /Path$/.test(key) && x) out.push(x);
      else walk(x, depth + 1);
    }
  };
  walk(control, 0);
  return [...new Set(out)];
}

function statusOf(control) {
  const s = control.status;
  return typeof s === 'string' ? s : s?.status;
}

function kubescapeFindings(report) {
  if (!Array.isArray(report?.results)) {
    throw new Error(`not a Kubescape JSON report: no "results" list (keys: ${Object.keys(report || {}).join(', ')})`);
  }
  const resources = new Map((report.resources || []).map((r) => [r.resourceID, r]));
  const names = new Map(Object.entries(report.summaryDetails?.controls || {})
    .map(([id, c]) => [id, c.name]));
  const findings = [];
  for (const result of report.results) {
    const resource = resources.get(result.resourceID);
    const file = fileOf(resource?.source);
    const where = `${file ? `${file}:` : ''}${resourceName(resource?.object)}`;
    for (const control of result.controls || []) {
      if (statusOf(control) !== 'failed') continue;
      findings.push({
        id: control.controlID,
        name: control.name || names.get(control.controlID) || '',
        where,
        detail: pathsOf(control).join('; '),
      });
    }
  }
  return findings;
}

// The rendered file a resource comes from, without its folder or extension.
function fileOf(source) {
  const p = source?.relativePath || source?.path || '';
  return p ? path.basename(p).replace(/\.(ya?ml|json)$/, '') : '';
}

function matchesResource(pattern, resource) {
  if (pattern === '*') return true;
  const [wantFile, wantName] = pattern.includes(':') ? pattern.split(':') : ['*', pattern];
  const [haveFile, haveName] = resource.includes(':') ? resource.split(':') : ['', resource];
  if (wantFile !== '*' && wantFile !== haveFile) return false;
  const want = wantName.split('/');
  const have = haveName.split('/');
  return want.length === 3 && want.every((part, i) => part === '*' || part === have[i]);
}

// ── kube-bench ───────────────────────────────────────────────────────────────
function kubeBenchFindings(report) {
  const sections = Array.isArray(report) ? report : report?.Controls;
  if (!Array.isArray(sections)) {
    throw new Error(`not a kube-bench JSON report: no "Controls" list (keys: ${Object.keys(report || {}).join(', ')})`);
  }
  const findings = [];
  for (const section of sections) {
    for (const group of section.tests || []) {
      for (const r of group.results || []) {
        if (r.status !== 'FAIL' && r.status !== 'WARN') continue;
        const detail = String(r.actual_value || r.reason || '').replace(/\s+/g, ' ').slice(0, 300);
        findings.push({ id: r.test_number, name: r.test_desc || '', where: section.text || '', warn: r.status === 'WARN', detail });
      }
    }
  }
  return findings;
}

// ── Trivy ────────────────────────────────────────────────────────────────────
// "dockerfile-run/Dockerfile" is the folder's name, "overlays-k3s.yaml" the
// file's without its extension.
function trivyTarget(target) {
  const parts = String(target || '').split('/').filter(Boolean);
  const base = parts.pop() || '';
  if (base === 'Dockerfile' && parts.length > 0) return parts.pop();
  return base.replace(/\.(ya?ml|json)$/, '');
}

// The resource a Kubernetes check's message names: "Container 'x' of
// Deployment 'oscar' should …" or "Role 'oscar-dispatcher' should …".
function trivyResource(message) {
  const text = String(message || '');
  const m = /\bof (\w+) '([^']+)'/.exec(text) || /^(\w+) '([^']+)'/.exec(text);
  return m ? `${m[1]}/${m[2]}` : '';
}

function trivyFindings(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || !('SchemaVersion' in report)) {
    throw new Error(`not a Trivy JSON report: no "SchemaVersion" (keys: ${Object.keys(report || {}).join(', ')})`);
  }
  const findings = [];
  for (const result of report.Results || []) {
    const file = trivyTarget(result.Target);
    for (const m of result.Misconfigurations || []) {
      if (m.Status !== 'FAIL') continue;
      const resource = trivyResource(m.Message);
      findings.push({
        id: m.ID || m.AVDID || '?',
        name: m.Title || '',
        where: resource ? `${file}:${resource}` : file,
        detail: `${m.Severity || '?'}: ${String(m.Message || '').replace(/\s+/g, ' ').slice(0, 300)}`,
      });
    }
  }
  return findings;
}

function matchesTrivy(pattern, where) {
  if (pattern === '*') return true;
  const [haveFile, haveResource = ''] = where.split(':');
  let wantFile = pattern;
  let wantResource = '*';
  if (pattern.includes(':')) [wantFile, wantResource] = pattern.split(':');
  else if (pattern.includes('/')) [wantFile, wantResource] = ['*', pattern];
  if (wantFile !== '*' && wantFile !== haveFile) return false;
  if (wantResource === '*') return true;
  const want = wantResource.split('/');
  const have = haveResource.split('/');
  return want.length === 2 && have.length === 2 && want.every((part, i) => part === '*' || part === have[i]);
}

// ── The list ─────────────────────────────────────────────────────────────────
const FINDINGS = { kubescape: kubescapeFindings, 'kube-bench': kubeBenchFindings, trivy: trivyFindings };

function acceptedEntry(tool, entries, f) {
  if (tool === 'kubescape') {
    return entries.find((e) => e.control === f.id && (e.resources || []).some((p) => matchesResource(p, f.where)));
  }
  if (tool === 'trivy') {
    return entries.find((e) => e.check === f.id && (e.resources || []).some((p) => matchesTrivy(p, f.where)));
  }
  return entries.find((e) => e.check === f.id);
}

function check(tool, report, accepted) {
  const all = FINDINGS[tool](report);
  const entries = accepted[tool] || [];
  const problems = [];
  for (const e of entries) {
    if (!e.reason || !String(e.reason).trim()) problems.push(`accepted entry ${e.control || e.check} gives no reason`);
  }
  const used = new Set();
  const rows = [];
  const seen = new Map();
  for (const f of all) {
    const key = `${f.id}|${f.where}`;
    if (seen.has(key)) { seen.get(key).times += 1; continue; }
    const entry = acceptedEntry(tool, entries, f);
    if (entry) used.add(entry);
    const state = f.warn ? 'manual' : entry ? 'accepted' : 'NEW';
    const row = { ...f, state, reason: entry?.reason || '', times: 1 };
    seen.set(key, row);
    rows.push(row);
  }
  for (const e of entries) {
    if (!used.has(e)) problems.push(`accepted ${e.control || e.check} matched nothing: remove it from accepted.json`);
  }
  const fresh = rows.filter((r) => r.state === 'NEW');
  for (const r of fresh) problems.push(`${r.id} ${r.name} — ${r.where}`);
  return { rows, problems, fresh: fresh.length };
}

function markdown(tool, { rows, problems }) {
  // Markdown table cell: backslash first, then the column bar.
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`### ${tool}`, ''];
  if (rows.length === 0) lines.push('No finding.');
  else {
    lines.push('| State | Check | What | Where | Found | Reason |', '|---|---|---|---|---|---|');
    for (const r of rows) lines.push(`| ${r.state} | ${cell(r.id)} | ${cell(r.name)} | ${cell(r.where)}${r.times > 1 ? ` (×${r.times})` : ''} | ${cell(r.detail || '')} | ${cell(r.reason)} |`);
  }
  lines.push('', problems.length ? `**${problems.length} to look at.**` : '**Nothing new.**', '');
  return lines.join('\n');
}

function main(argv) {
  const [tool, file] = argv;
  if (!TOOLS.includes(tool) || !file) {
    console.error(`usage: check-scans.js <${TOOLS.join('|')}> <results.json>`);
    return 2;
  }
  const accepted = JSON.parse(fs.readFileSync(path.join(__dirname, 'accepted.json'), 'utf8'));
  const result = check(tool, JSON.parse(fs.readFileSync(file, 'utf8')), accepted);
  for (const r of result.rows) {
    console.log(`${r.state.padEnd(8)} ${r.id}  ${r.name}  [${r.where}${r.times > 1 ? ` ×${r.times}` : ''}]`);
    if (r.detail && r.state !== 'manual') console.log(`         found: ${r.detail}`);
  }
  for (const p of result.problems) console.log(`::error::${tool}: ${p}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(tool, result));
  console.log(`${tool}: ${result.rows.length} findings, ${result.fresh} new, ${result.problems.length} to look at`);
  return result.problems.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  check, kubescapeFindings, kubeBenchFindings, trivyFindings, trivyTarget, trivyResource, matchesTrivy,
  matchesResource, resourceName, pathsOf, fileOf, markdown, main,
};
