// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * oscar-test.test.js — the tool against a stand-in OSCAR on a loopback port.
 * The stand-in checks each client assertion with the account's public key,
 * as OSCAR does, then answers the API as OSCAR does (#1342).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');
const { argsOf } = require('../src/args');
const { clientFor, assertionFor, privateKeyOf, originOf } = require('../src/oscar');
const { runTool, providerIdsOf, EXIT } = require('../src/run');

const CLIENT = '3f2a91c0-1d2e-4c5b-8a9f-0123456789ab';
const COMPANY = { id: 'c0000000-0000-4000-8000-000000000000', name: 'UIC Simulateurs' };
const ALPHA = { id: 'a0000000-0000-4000-8000-000000000000', name: 'alpha' };
const BETA = { id: 'b0000000-0000-4000-8000-000000000000', name: 'beta' };
const TOOL = path.resolve(__dirname, '..', 'oscar-test.js');

const run = (code, verdict, extra = {}) => ({ id: `r-${code}`, scenario_code: code, state: 'finished', verdict, reason: null, run_url: `https://oscar.example/run-detail.html?id=r-${code}`, failures: [], warnings: [], deviations: [], ...extra });

/** A stand-in OSCAR: { origin, seen, close }. `finishAfter` status reads say running first. */
async function standIn({ publicKey, finishAfter = 1, never = false }) {
  const seen = { tokens: 0, posts: [], reads: [], scopes: [] };
  let reads = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'Content-Type': type });
        res.end(type === 'application/json' ? JSON.stringify(body) : body);
      };
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/v1/api/oauth/token') {
        const form = new URLSearchParams(raw);
        const [h, p, s] = String(form.get('client_assertion')).split('.');
        const header = JSON.parse(Buffer.from(h, 'base64url'));
        const claims = JSON.parse(Buffer.from(p, 'base64url'));
        const ok = header.alg === 'ES256' && crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
          && claims.iss === CLIENT && claims.sub === CLIENT && claims.aud === `${origin}/v1/api/oauth/token` && claims.exp - claims.iat <= 300;
        if (!ok) return send(401, { error: 'invalid_client', error_description: 'not accepted' });
        seen.tokens += 1;
        seen.scopes.push(form.get('scope'));
        return send(200, { access_token: `tok-${seen.tokens}`, token_type: 'Bearer', expires_in: 900, scope: form.get('scope') });
      }
      if (!String(req.headers.authorization).startsWith('Bearer tok-')) return send(401, { detail: 'Missing, invalid, expired or revoked API key.' });
      if (url.pathname === '/v1/api/key') {
        return send(200, { kind: 'company_api_account', name: 'PC test client', client_id: CLIENT, company: COMPANY, providers: [ALPHA, BETA], scopes: ['runs:read', 'runs:write'] });
      }
      if (url.pathname === '/v1/api/suites') return send(200, { suites: [{ name: 'smoke', selection: { categories: ['happy'] }, codes: null }] });
      if (req.method === 'POST' && url.pathname === '/v1/api/test-requests') {
        const body = JSON.parse(raw);
        seen.posts.push({ body, key: req.headers['idempotency-key'] || null });
        return send(202, { id: 'tr-1', reference: body.reference || null, state: 'queued', providers: [
          { id: ALPHA.id, name: 'alpha', not_found: ['OTST_GONE'], runs: [run('OTST_A', null, { state: 'queued' })] },
          { id: BETA.id, name: 'beta', not_found: [], runs: [run('OTST_A', null, { state: 'queued' })] },
        ] });
      }
      if (url.pathname === '/v1/api/test-requests/tr-1') {
        seen.reads.push(url.searchParams.get('wait'));
        reads += 1;
        const done = !never && reads > finishAfter;
        return send(200, done
          ? { id: 'tr-1', state: 'finished', verdict: 'failed', counts: { passed: 1, failed: 1 } }
          : { id: 'tr-1', state: 'running', verdict: null, counts: { running: 2 } });
      }
      if (url.pathname === '/v1/api/test-requests/tr-1/results') {
        if (url.searchParams.get('format') === 'junit') return send(200, '<?xml version="1.0"?><testsuites/>\n', 'application/xml');
        return send(200, { id: 'tr-1', state: 'finished', verdict: 'failed', counts: { passed: 1, failed: 1 }, providers: [
          { id: ALPHA.id, name: 'alpha', verdict: 'failed', counts: { failed: 1 }, not_found: ['OTST_GONE'], runs: [
            run('OTST_A', 'failed', { failures: [{ step: '02. POST Booking', check: 'HTTP response status', message: 'expected 200, actual: 400', http_status: 400, problem_code: 'BOOKING_REFUSED' }] })] },
          { id: BETA.id, name: 'beta', verdict: 'passed', counts: { passed: 1 }, not_found: [], runs: [run('OTST_A', 'passed')] },
        ] });
      }
      return send(404, { detail: 'The API has no such route.' });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, seen, close: () => new Promise(r => server.close(r)) };
}

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { publicKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

function harness(origin, pem, files = {}) {
  const lines = [];
  const written = {};
  const client = clientFor({ origin, clientId: CLIENT, privateKey: privateKeyOf(pem) });
  const io = { out: l => lines.push(l), readFile: f => files[f], writeFile: (f, t) => { written[f] = t; } };
  return { client, io, lines, written };
}

test('settings: options or environment, and every missing piece said', () => {
  const env = { OSCAR_URL: 'https://oscar.example', OSCAR_CLIENT_ID: CLIENT, OSCAR_PRIVATE_KEY_FILE: 'k.pem' };
  const ok = argsOf(['--provider', 'alpha,beta', '--provider', 'gamma', '--suite', 'smoke'], env);
  assert.deepEqual(ok.providers, ['alpha', 'beta', 'gamma']);
  assert.equal(ok.oscar, 'https://oscar.example');
  assert.equal(argsOf(['--oscar', 'https://other', '--suite', 's', '--provider', 'a'], env).oscar, 'https://other');
  assert.match(argsOf(['--suite', 's', '--provider', 'a'], {}).error, /--oscar/);
  assert.match(argsOf(['--provider', 'a'], env).error, /exactly one of --suite/);
  assert.match(argsOf(['--suite', 's', '--scenarios', 'A', '--provider', 'a'], env).error, /exactly one/);
  assert.match(argsOf(['--suite', 's'], env).error, /--provider/);
  assert.match(argsOf(['--nope'], env).error, /Unknown option/);
  assert.match(argsOf(['--timeout', '0', '--suite', 's', '--provider', 'a'], env).error, /--timeout/);
  assert.equal(argsOf(['--whoami'], env).whoami, true);
  assert.equal(argsOf(['--whoami'], { ...env, OSCAR_PRIVATE_KEY_FILE: undefined, OSCAR_PRIVATE_KEY: 'pem' }).keyText, 'pem');
});

test('addresses: https, or http for this machine only, without a path', () => {
  assert.equal(originOf('https://oscar.example/'), 'https://oscar.example');
  assert.equal(originOf('http://localhost:3001'), 'http://localhost:3001');
  assert.throws(() => originOf('http://oscar.example'), /https/);
  assert.throws(() => originOf('https://oscar.example/v1'), /without a path/);
});

test('a suite on two providers by name: the request, the wait, the report, JUnit; exit 1 on a failure', async () => {
  const { publicKey, pem } = keyPair();
  const oscar = await standIn({ publicKey, finishAfter: 1 });
  try {
    const settings = argsOf(['--oscar', oscar.origin, '--client-id', CLIENT, '--key', 'k', '--provider', 'ALPHA', '--provider', BETA.id,
      '--suite', 'smoke', '--reference', 'pipeline 42', '--idempotency-key', 'ci-build-1001', '--junit', 'out.xml', '--json', 'out.json']);
    const h = harness(oscar.origin, pem);
    const { code, id } = await runTool(settings, h.client, h.io);
    assert.equal(code, EXIT.failed);
    assert.equal(id, 'tr-1');
    assert.deepEqual(oscar.seen.posts, [{ body: { providers: [ALPHA.id, BETA.id], suite: 'smoke', reference: 'pipeline 42' }, key: 'ci-build-1001' }]);
    assert.equal(oscar.seen.tokens, 1, 'the token is asked once and kept');
    assert.deepEqual(oscar.seen.reads, ['60', '60']);
    const text = h.lines.join('\n');
    assert.match(text, /alpha: 1 run\(s\); not on this provider: OTST_GONE/);
    assert.match(text, /Verdict: FAILED/);
    assert.match(text, /✗ 02\. POST Booking: HTTP response status \[HTTP 400 BOOKING_REFUSED\] — expected 200, actual: 400/);
    assert.doesNotMatch(text, /beta.*OTST_A: passed/, 'passing runs are not listed one by one');
    assert.equal(h.written['out.xml'], '<?xml version="1.0"?><testsuites/>\n');
    assert.equal(JSON.parse(h.written['out.json']).verdict, 'failed');
    assert.ok(!text.includes('tok-1') && !text.includes('PRIVATE KEY'), 'no secret is printed');
  } finally {
    await oscar.close();
  }
});

test('not finished in time: exit 3, with how to wait again', async () => {
  const { publicKey, pem } = keyPair();
  const oscar = await standIn({ publicKey, never: true });
  try {
    let clock = 0;
    const settings = argsOf(['--oscar', oscar.origin, '--client-id', CLIENT, '--key', 'k', '--provider', 'alpha', '--scenarios', 'OTST_A', '--timeout', '2']);
    const h = harness(oscar.origin, pem);
    h.io.now = () => { clock += 61 * 1000; return clock; };
    const { code } = await runTool(settings, h.client, h.io);
    assert.equal(code, EXIT.timeout);
    assert.match(h.lines.at(-1), /--status tr-1/);
  } finally {
    await oscar.close();
  }
});

test('a provider the account is not given is named, with those it is', () => {
  assert.throws(() => providerIdsOf(['gamma'], { company: COMPANY, providers: [ALPHA, BETA] }), /It may test: UIC Simulateurs, alpha, beta/);
});

test('--whoami and --suites read only; a key OSCAR does not hold is refused, quoting no secret', async () => {
  const { publicKey, pem } = keyPair();
  const oscar = await standIn({ publicKey });
  try {
    const h = harness(oscar.origin, pem);
    await runTool(argsOf(['--oscar', oscar.origin, '--client-id', CLIENT, '--key', 'k', '--whoami']), h.client, h.io);
    await runTool(argsOf(['--oscar', oscar.origin, '--client-id', CLIENT, '--key', 'k', '--suites']), h.client, h.io);
    assert.match(h.lines[0], /Account "PC test client".*UIC Simulateurs/);
    assert.match(h.lines.join('\n'), /smoke: a selection/);
    assert.equal(oscar.seen.posts.length, 0);

    const other = harness(oscar.origin, keyPair().pem);
    await assert.rejects(runTool(argsOf(['--oscar', oscar.origin, '--client-id', CLIENT, '--key', 'k', '--whoami']), other.client, other.io),
      /OSCAR refused the token request \(HTTP 401\)\. invalid_client: not accepted/);
  } finally {
    await oscar.close();
  }
});

test('the assertion: ES256, one minute, the token endpoint as audience', () => {
  const { publicKey, pem } = keyPair();
  const a = assertionFor({ clientId: CLIENT, privateKey: privateKeyOf(pem), origin: 'https://oscar.example', now: 1_800_000_000_000, jti: 'j-123456' });
  const [h, p, s] = a.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url')), { iss: CLIENT, sub: CLIENT, aud: 'https://oscar.example/v1/api/oauth/token', iat: 1_800_000_000, exp: 1_800_000_060, jti: 'j-123456' });
  const short = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => privateKeyOf(short), /EC P-256 or RSA/);
});

test('the command line: --help, and a missing setting is exit 4 with the reason', () => {
  assert.match(execFileSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' }), /Exit code: 0 passed, 1 failed/);
  const r = spawnSync(process.execPath, [TOOL, '--suite', 'smoke'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /--oscar/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-test-'));
  try {
    const missing = spawnSync(process.execPath, [TOOL, '--oscar', 'https://oscar.example', '--client-id', CLIENT, '--key', path.join(dir, 'none.pem'), '--whoami'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(missing.status, 4);
    assert.match(missing.stderr, /File not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
