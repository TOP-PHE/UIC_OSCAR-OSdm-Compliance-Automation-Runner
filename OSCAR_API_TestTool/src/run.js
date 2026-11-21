// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run.js — what the tool does once it can call OSCAR: find the providers,
 * ask for the tests, wait for the verdict, report it. Every function takes
 * the client (oscar.js) and an `out` that prints a line, so the tests drive
 * it with a stand-in OSCAR.
 */

const { OscarError } = require('./oscar');

const EXIT = Object.freeze({ passed: 0, failed: 1, incomplete: 2, timeout: 3, error: 4 });
// The longest wait asked, under the 60 s a proxy in front of OSCAR often
// allows (nginx's default read timeout cut a 60 s wait with 504, #1355).
const WAIT_S = 50;
// A wait a proxy cuts is asked again, half as long (not under MIN_WAIT_S); after
// GATEWAY_TRIES cuts in a row the tool stops waiting.
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const MIN_WAIT_S = 10;
const GATEWAY_TRIES = 5;

/** Text of a file as read: a leading UTF-8 byte-order mark dropped, UTF-16 read as such. */
function textOf(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The account as OSCAR describes it (GET /v1/api/key). */
async function whoami(client) {
  const { body } = await client.call('GET', '/v1/api/key');
  if (body?.kind !== 'company_api_account') {
    throw new OscarError('These settings sign in as something other than a Company API account.');
  }
  return body;
}

/** The ids of the providers named (a name without case, or an id), or an error listing the choices. */
function providerIdsOf(names, account) {
  const places = [account.company, ...(account.providers || [])].filter(Boolean);
  return names.map((n) => {
    const found = places.find(p => p.id === n || String(p.name).toLowerCase() === n.toLowerCase());
    if (!found) {
      throw new OscarError(`"${n}" is not a company or provider this account may test. It may test: ${places.map(p => p.name).join(', ')}.`);
    }
    return found.id;
  });
}

/** The body of POST /v1/api/test-requests from the settings. */
function requestBodyOf(settings, providerIds, readFile) {
  const body = { providers: providerIds };
  if (settings.suite) body.suite = settings.suite;
  if (settings.scenarios) body.scenarios = settings.scenarios;
  if (settings.selection) {
    try {
      body.selection = JSON.parse(readFile(settings.selection));
    } catch (e) {
      throw new OscarError(`--selection: ${settings.selection} is not a JSON file (${e.message}).`);
    }
  }
  if (settings.reference) body.reference = settings.reference;
  return body;
}

const countsText = c => ['queued', 'running', 'passed', 'passed_with_deviation', 'failed', 'not_a_result', 'cancelled']
  .filter(k => c?.[k]).map(k => `${k.replaceAll('_', ' ')} ${c[k]}`).join(', ') || 'nothing yet';

// One wait of at most `wait` seconds: the answer, or null when a proxy cut it.
async function waitOnce(client, id, wait) {
  try {
    return (await client.call('GET', `/v1/api/test-requests/${encodeURIComponent(id)}?wait=${wait}`)).body;
  } catch (e) {
    if (e instanceof OscarError && GATEWAY_STATUSES.has(e.status)) return null;
    throw e;
  }
}

const cutText = (id, cuts) => `A proxy in front of OSCAR cut the wait ${cuts} times in a row (HTTP 502, 503 or 504). `
  + `The tests go on in OSCAR: wait again later with --status ${id}. OSCAR's administrator can raise the proxy's `
  + 'read timeout (nginx: proxy_read_timeout 660s).';

/** Waits for the verdict: the answer once finished, or null at the deadline. */
async function waitForVerdict(client, id, { deadline, out, now = () => Date.now() }) {
  let last = '';
  let longest = WAIT_S;
  let cuts = 0;
  for (;;) {
    const left = Math.floor((deadline - now()) / 1000);
    const wait = Math.max(0, Math.min(longest, left));
    const body = await waitOnce(client, id, wait);
    if (!body) {
      cuts += 1;
      if (cuts >= GATEWAY_TRIES) throw new OscarError(cutText(id, cuts));
      // Shorter waits from now on: whatever cut this one may cut the next.
      longest = Math.max(MIN_WAIT_S, Math.floor(longest / 2));
      out(`  (a proxy cut the wait: asking every ${longest} s now)`);
      continue;
    }
    cuts = 0;
    const line = `${body.state}: ${countsText(body.counts)}`;
    if (line !== last) { out(`  ${line}`); last = line; }
    if (body.state === 'finished') return body;
    if (left <= 0) return null;
  }
}

// One provider's line.
function providerLine(p) {
  const missing = p.not_found?.length ? ' — not on this provider: ' + p.not_found.join(', ') : '';
  return `  ${p.name || p.id}: ${p.verdict || p.state} (${countsText(p.counts)})${missing}`;
}

// One failed check's line.
function failureLine(f) {
  const step = f.step ? f.step + ': ' : '';
  const code = f.problem_code ? ' ' + f.problem_code : '';
  const status = f.http_status ? ' [HTTP ' + f.http_status + code + ']' : '';
  const message = f.message ? ' — ' + f.message : '';
  return `      ✗ ${step}${f.check}${status}${message}`;
}

// One known deviation's line.
function deviationLine(d) {
  const note = d.note ? ' — ' + d.note : '';
  return `      ~ known deviation: ${d.step} returned HTTP ${d.status}${note}`;
}

// The lines of a run that did not pass: its verdict, failed checks and known deviations.
function runLines(r) {
  const reason = r.reason ? ' (' + r.reason + ')' : '';
  const lines = [`    ${r.scenario_code}: ${r.verdict || r.state}${reason}  ${r.run_url || ''}`.trimEnd()];
  for (const f of r.failures || []) lines.push(failureLine(f));
  for (const d of r.deviations || []) lines.push(deviationLine(d));
  return lines;
}

/** The report of the results: lines for a person. */
function reportOf(results) {
  const lines = [`Verdict: ${String(results.verdict).toUpperCase()} (${countsText(results.counts)})`];
  for (const p of results.providers || []) {
    lines.push(providerLine(p));
    for (const r of p.runs || []) {
      if (r.verdict !== 'passed') lines.push(...runLines(r));
    }
  }
  return lines;
}

/** The exit code of a verdict. */
const exitOf = verdict => EXIT[verdict] ?? EXIT.error;

// --whoami and --suites: read only.
async function readCommand(settings, client, out) {
  if (settings.whoami) {
    const me = await whoami(client);
    out(`Account "${me.name}" (client id ${me.client_id}) of ${me.company.name}, scopes ${me.scopes.join(' ')}.`);
    out('It may test: ' + [me.company, ...me.providers].map(p => `${p.name} (${p.id})`).join(', ') + '.');
    return;
  }
  const { body } = await client.call('GET', '/v1/api/suites');
  if (!body.suites.length) out('The company has no named suite yet: save one on the Run page (card Named suites).');
  for (const s of body.suites) {
    const parts = [s.selection ? 'a selection' : null, s.codes ? s.codes.length + ' scenario(s)' : null].filter(Boolean);
    out(`${s.name}: ${parts.join(' and ')}`);
  }
}

// Asks for the tests: the test request's id.
async function launch(settings, client, io) {
  const account = await whoami(client);
  const body = requestBodyOf(settings, providerIdsOf(settings.providers, account), io.readFile);
  const headers = settings.idempotencyKey ? { 'Idempotency-Key': settings.idempotencyKey } : {};
  const { status, body: made } = await client.call('POST', '/v1/api/test-requests', { body, headers });
  const reference = made.reference ? ` (${made.reference})` : '';
  const again = status === 200 ? ', already made with this Idempotency-Key' : '';
  io.out(`Test request ${made.id}${reference}${again}:`);
  for (const p of made.providers) {
    const missing = p.not_found.length ? '; not on this provider: ' + p.not_found.join(', ') : '';
    io.out(`  ${p.name}: ${p.runs.length} run(s)${missing}`);
  }
  return made.id;
}

// Reads the results, prints them, writes the files asked: the exit code.
async function report(settings, client, io, id) {
  const where = `/v1/api/test-requests/${encodeURIComponent(id)}/results`;
  const { body: results } = await client.call('GET', where);
  for (const line of reportOf(results)) io.out(line);
  if (settings.json) {
    io.writeFile(settings.json, JSON.stringify(results, null, 2) + '\n');
    io.out(`JSON written to ${settings.json}`);
  }
  if (settings.junit) {
    const { body: xml } = await client.call('GET', where + '?format=junit', { as: 'text' });
    io.writeFile(settings.junit, xml);
    io.out(`JUnit XML written to ${settings.junit}`);
  }
  return exitOf(results.verdict);
}

/**
 * Runs the tool: { code } (the exit code). `io` gives out (a line), readFile,
 * writeFile and now, so the tests can drive it.
 */
async function runTool(settings, client, io) {
  if (settings.whoami || settings.suites) {
    await readCommand(settings, client, io.out);
    return { code: 0 };
  }
  let id = settings.status;
  if (id) io.out(`Test request ${id}:`);
  else id = await launch(settings, client, io);

  const now = io.now || (() => Date.now());
  const finished = await waitForVerdict(client, id, { deadline: now() + settings.timeoutMinutes * 60 * 1000, out: io.out, now });
  if (!finished) {
    io.out(`Not finished after ${settings.timeoutMinutes} minute(s). Wait again with: --status ${id}`);
    return { code: EXIT.timeout, id };
  }
  return { code: await report(settings, client, io, id), id };
}

module.exports = { runTool, providerIdsOf, requestBodyOf, reportOf, exitOf, waitForVerdict, textOf, EXIT, WAIT_S };
