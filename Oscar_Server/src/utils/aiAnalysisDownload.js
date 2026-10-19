// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiAnalysisDownload.js — an AI analysis's groups as one Markdown file, each
 * with the failing requests of the batch that belong to it (#867). Pure: the
 * route reads the rows and the bodies, this module writes the text.
 *
 * Which requests: those of the analysis's batches whose check failed, of a
 * scenario the group names, at a step it names (a group naming no step takes
 * every step of its scenarios; one naming no scenario, every scenario at its
 * steps; one naming neither, none). The first of each run and step, at most
 * MAX_PER_GROUP a group, the later batch first; the others are counted.
 *
 * What is written: method, the URL's path and query, the body sent, the HTTP
 * status and the body received. The bodies are the company's own test data
 * and are not masked: its Test Manager reads the file. Never written: the
 * headers (they are not read at all), the endpoint's host (left out of the
 * URL and replaced in the bodies), credentials in the query or in a body
 * member named like one. Each body is cut at MAX_BODY_CHARS, the file stops
 * adding requests at MAX_FILE_CHARS, and both say so.
 */

const MAX_PER_GROUP = 3;
const MAX_BODY_CHARS = 20 * 1024;
const MAX_FILE_CHARS = 4 * 1024 * 1024;
const MAX_CHECKS = 5;
const REMOVED = '<removed>';
const HOST = '<host>';

const OWNER_TEXT = Object.freeze({ provider: 'Provider', oscar: 'OSCAR', configuration: 'Configuration', unclear: 'Unclear' });

// Connection data, compared lower-case without "_" or "-": never written.
const CONNECTION = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer', 'authorization', 'apikey', 'secret', 'clientsecret',
  'clientid', 'password', 'passwd', 'pwd', 'requestor', 'requestorid', 'cookie', 'sessionid', 'signature',
]);
const CONNECTION_PART = /token|secret|password|passwd|apikey|signature|credential/;
const norm = (k) => String(k).toLowerCase().replaceAll(/[_-]/g, '');
const isConnectionName = (k) => CONNECTION.has(norm(k)) || CONNECTION_PART.test(norm(k));

const oneLine = (v) => String(v ?? '').replaceAll(/\s+/g, ' ').trim();

/** The host names of a list of addresses, lower-case, each once. */
function hostsOf(urls) {
  const out = new Set();
  for (const u of urls || []) {
    try {
      const { hostname } = new URL(String(u));
      if (hostname) out.add(hostname.toLowerCase());
    } catch { /* not an absolute address */ }
  }
  return [...out];
}

/**
 * An address as written: its path and query, without scheme or host, with
 * the value of any query parameter named like a credential removed. A
 * `{{api_base}}`-style prefix is left out like a host.
 */
function pathOf(url) {
  const text = String(url ?? '').trim();
  if (!text) return '';
  const unprefixed = text.startsWith('{{') && text.includes('}}') ? text.slice(text.indexOf('}}') + 2) : text;
  let parsed;
  try {
    parsed = new URL(unprefixed, 'http://oscar.invalid');
  } catch {
    return '<an address that cannot be read>';
  }
  const pairs = [];
  for (const [k, v] of parsed.searchParams) pairs.push(`${encodeURIComponent(k)}=${isConnectionName(k) ? REMOVED : encodeURIComponent(v)}`);
  return parsed.pathname + (pairs.length ? '?' + pairs.join('&') : '');
}

// Each host replaced, whatever its case. No regular expression: a host is data.
function withoutHosts(text, hosts) {
  let out = text;
  for (const host of hosts || []) {
    if (!host) continue;
    const lower = out.toLowerCase();
    // A few characters change length when lower-cased: then the case is kept as it is.
    if (lower.length !== out.length) {
      out = out.split(host).join(HOST);
      continue;
    }
    let at = lower.indexOf(host);
    if (at < 0) continue;
    let built = '';
    let from = 0;
    while (at >= 0) {
      built += out.slice(from, at) + HOST;
      from = at + host.length;
      at = lower.indexOf(host, from);
    }
    out = built + out.slice(from);
  }
  return out;
}

// The members named like a credential, removed in place. A loop, not a recursion: the depth is the provider's.
function removeConnectionMembers(root) {
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    for (const [k, v] of Object.entries(value)) {
      if (isConnectionName(k)) value[k] = REMOVED;
      else stack.push(v);
    }
  }
  return root;
}

/**
 * A stored body as written: indented JSON when it is JSON, else its text;
 * credentials and hosts out; cut at MAX_BODY_CHARS. { text, json, cut, chars }
 * or null when there is no body.
 */
function bodyText(raw, hosts = []) {
  if (raw === null || raw === undefined || raw === '') return null;
  let text = String(raw);
  let json = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      text = JSON.stringify(removeConnectionMembers(parsed), null, 2);
      json = true;
    }
  } catch { /* not JSON: written as it is */ }
  text = withoutHosts(text, hosts);
  const chars = text.length;
  const cut = chars > MAX_BODY_CHARS;
  return { text: cut ? text.slice(0, MAX_BODY_CHARS) : text, json, cut, chars };
}

// The longest run of backticks in a text.
function longestBacktickRun(text) {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    current = ch === '`' ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** A fenced block whose fence is longer than any backtick run in the text. */
function fenced(text, lang = '') {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

/** Inline code that a backtick in the text cannot close. */
function inlineCode(text) {
  const t = oneLine(text);
  const fence = '`'.repeat(longestBacktickRun(t) + 1);
  return `${fence} ${t} ${fence}`;
}

// A step of the run against a step the group names: the model may have been sent it shortened ("…").
function sameStep(name, named) {
  const a = oneLine(name);
  const b = oneLine(named);
  if (!b) return false;
  if (a === b) return true;
  return b.endsWith('…') && b.length > 1 && a.startsWith(b.slice(0, -1));
}

/**
 * The failing requests of a group: `rows` are { requestId, runId, batchId,
 * scenarioCode, step, … } in the order the runs were made; `batches` the
 * analysis's batches, the earlier first. { chosen, leftOut, matches }.
 */
function requestsOfGroup(group, rows, batches = [], max = MAX_PER_GROUP) {
  const steps = (Array.isArray(group?.steps) ? group.steps : []).filter((s) => typeof s === 'string' && s.trim());
  const scenarios = new Set((Array.isArray(group?.scenarios) ? group.scenarios : []).filter((s) => typeof s === 'string'));
  if (!steps.length && !scenarios.size) return { chosen: [], leftOut: 0, matches: 0 };
  const order = (r) => {
    const i = batches.indexOf(r.batchId);
    return i < 0 ? batches.length : batches.length - 1 - i;   // the later batch first
  };
  const matching = (rows || [])
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (!scenarios.size || scenarios.has(r.scenarioCode)) && (!steps.length || steps.some((s) => sameStep(r.step, s))))
    .sort((x, y) => order(x.r) - order(y.r) || x.i - y.i)
    .map(({ r }) => r);
  const firsts = [];
  const seen = new Set();
  for (const r of matching) {
    const key = `${r.runId}\u0000${r.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    firsts.push(r);
  }
  return { chosen: firsts.slice(0, max), leftOut: Math.max(0, firsts.length - max), matches: firsts.length };
}

/** `oscar-analysis-<date>-<company>.md`, the company part of letters, digits and "-" only. */
function fileNameOf(date, company) {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(date ?? ''))?.[0] || 'undated';
  const slug = String(company ?? '').toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '').slice(0, 60) || 'company';
  return `oscar-analysis-${day}-${slug}.md`;
}

function bodyBlock(label, body) {
  if (!body) return `**${label}:** none stored.`;
  const note = body.cut ? `\n\n_The ${label.toLowerCase()} is cut here: ${MAX_BODY_CHARS} of its ${body.chars} characters are shown._` : '';
  return `**${label}:**\n\n${fenced(body.text, body.json ? 'json' : '')}${note}`;
}

/** One failing request: its scenario and step, request and response. */
function requestSection(number, r, bodies, failed, hosts) {
  const all = Array.isArray(failed) ? failed : [];
  const checks = all.slice(0, MAX_CHECKS).map((c) => `  - ${oneLine(c)}`);
  const more = all.length > MAX_CHECKS ? [`  - and ${all.length - MAX_CHECKS} more`] : [];
  const request = bodyText(bodies?.request, hosts);
  const response = bodyText(bodies?.response, hosts);
  const method = oneLine(r.method) || '(method not stored)';
  const address = pathOf(r.url) || '(address not stored)';
  return [
    `#### ${number} ${oneLine(r.scenarioCode) || '(no scenario)'} — ${oneLine(r.step)}`,
    '',
    `- Batch ${inlineCode(r.batchId)}, run ${inlineCode(r.runId)}`,
    ...(checks.length ? ['- Failed checks:', ...checks, ...more] : []),
    '',
    `**Request:** ${inlineCode(`${method} ${address}`)}`,
    '',
    bodyBlock('Request body', request),
    '',
    `**Response:** HTTP ${Number.isInteger(r.status) ? r.status : 'status not stored'}`,
    '',
    bodyBlock('Response body', response),
    '',
  ].join('\n');
}

function listLine(label, items) {
  const list = (Array.isArray(items) ? items : []).filter((x) => typeof x === 'string');
  return `- **${label}:** ${list.length ? list.map(oneLine).join(', ') : '—'}`;
}

function comparisonLines(c) {
  if (!c || typeof c !== 'object') return [];
  const line = (label, items) => listLine(label, items);
  return ['## Comparison', '', line('Fixed', c.fixed), line('Still failing', c.stillFailing), line('New', c.new), ''];
}

/**
 * The file. `analysis` is the stored analysis as the history read gives it
 * (done, with `result.groups`); `company` its company or provider's name;
 * `rows` the failing requests of its batches (see requestsOfGroup), each with
 * `method`, `url`, `status` (and `failedChecks`, else `checksOf(requestId)`
 * gives them); `bodyOf(requestId)` gives { request, response } as stored;
 * only the requests written are asked for. `hosts` are written as <host>; `now` an
 * ISO instant. Returns { text, requests, leftOut, stopped }.
 */
function buildMarkdown({ analysis, company, rows, bodyOf, checksOf, hosts = [], now }) {
  const groups = Array.isArray(analysis?.result?.groups) ? analysis.result.groups : [];
  const batches = Array.isArray(analysis?.batches) ? analysis.batches : [];
  const head = [
    '# OSCAR — the findings of an AI analysis',
    '',
    `- Company or provider: ${oneLine(company)}`,
    `- Analysis ${inlineCode(analysis.id)}, model ${inlineCode(analysis.model)}, made ${oneLine(analysis.createdAt)}${analysis.by ? ' by ' + oneLine(analysis.by) : ''}`,
    `- ${batches.length > 1 ? 'Batches compared' : 'Batch'}: ${batches.map(inlineCode).join(' and ') || '—'}`,
    `- Written ${oneLine(now)}`,
    '',
    '> An AI opinion: it can be wrong, and it is not a test result or a finding. Check each group against the runs before acting on it.',
    '>',
    '> The bodies are as OSCAR stored them, not masked: the company\'s own test data, personal data included.'
      + ' Headers, the provider\'s host and credentials are left out.',
    '',
    '## Summary',
    '',
    oneLine(analysis.result?.summary) || '—',
    '',
    ...comparisonLines(analysis.result?.comparison),
  ];
  let text = head.join('\n');
  let requests = 0;
  let leftOut = 0;
  let stopped = false;
  groups.forEach((g, n) => {
    const owner = OWNER_TEXT[g?.owner] || OWNER_TEXT.unclear;
    const part = [
      '',
      `## ${n + 1}. ${oneLine(g?.title) || 'Untitled'}`,
      '',
      `- **Owner:** ${owner}`,
      `- **Explanation:** ${oneLine(g?.cause) || '—'}`,
      `- **Evidence:** ${oneLine(g?.why) || '—'}`,
      `- **Next step:** ${oneLine(g?.action) || '—'}`,
      listLine('Steps', g?.steps),
      listLine('Scenarios', g?.scenarios),
      '',
      '### Failing requests',
      '',
    ];
    text += part.join('\n');
    const { chosen, leftOut: more, matches } = requestsOfGroup(g, rows, batches);
    if (!matches) {
      text += 'No failing request of the batch matches the steps and scenarios this group names.\n';
      return;
    }
    let shown = 0;
    for (const r of chosen) {
      if (stopped) break;
      const section = requestSection(`${n + 1}.${shown + 1}`, r, bodyOf ? bodyOf(r.requestId) : null,
        checksOf ? checksOf(r.requestId) : r.failedChecks, hosts);
      if (text.length + section.length > MAX_FILE_CHARS) {
        stopped = true;
        break;
      }
      text += section + '\n';
      shown += 1;
    }
    requests += shown;
    const omitted = more + (chosen.length - shown);
    leftOut += omitted;
    if (stopped && shown < chosen.length) {
      text += `_The file reached its size limit (${MAX_FILE_CHARS} characters): ${omitted} failing request(s) of this group left out, and no more request is written below._\n`;
    } else if (omitted) {
      text += `_${omitted} more failing request(s) of this group left out: the first of each run and step is shown, at most ${MAX_PER_GROUP}._\n`;
    }
  });
  if (!groups.length) text += '\nThe analysis names no group.\n';
  return { text: text.endsWith('\n') ? text : text + '\n', requests, leftOut, stopped };
}

module.exports = {
  MAX_PER_GROUP, MAX_BODY_CHARS, MAX_FILE_CHARS, REMOVED, HOST,
  hostsOf, pathOf, bodyText, fenced, inlineCode, requestsOfGroup, fileNameOf, buildMarkdown, isConnectionName,
};
