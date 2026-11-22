// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * health-checks.test.js — the two disk checks of GET /health
 * (utils/healthChecks.js), and the limits three read routes name in their own
 * chain. The route's side of /health is in server.test.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const H = require('../../src/utils/healthChecks');

const SRC = path.join(__dirname, '..', '..', 'src');
const GB = 1024 * 1024 * 1024;

/** A file system that counts what is asked of it. */
function fakeFiles({ writeError = null, free = 5 * GB, statError = null, noStatfs = false } = {}) {
  const calls = { write: 0, unlink: 0, statfs: 0 };
  const files = {
    writeFileSync: () => { calls.write++; if (writeError) throw writeError; },
    unlinkSync: () => { calls.unlink++; },
    statfsSync: () => { calls.statfs++; if (statError) throw statError; return { bavail: free / 4096, bsize: 4096 }; },
  };
  if (noStatfs) delete files.statfsSync;
  return { files, calls };
}
const read = (now, files, extra = {}) => H.diskChecks({ now, files, dataDir: '/data', root: '/', ...extra });

beforeEach(() => H.forgetDiskChecks());

describe('the disk is read once in a while, not at every call', () => {
  test('a burst of calls reads it once', () => {
    const { files, calls } = fakeFiles();
    const first = read(1_000_000, files);
    for (let i = 1; i <= 50; i++) expect(read(1_000_000 + i * 10, files)).toBe(first);
    expect(calls).toEqual({ write: 1, unlink: 1, statfs: 1 });
    expect(first).toEqual({ data_dir: { ok: true, status: 'writable' }, disk: { ok: true, free_mb: 5120 }, ok: true });
  });

  test('read again once what is kept is KEEP_MS old', () => {
    const { files, calls } = fakeFiles();
    read(1_000_000, files);
    read(1_000_000 + H.KEEP_MS - 1, files);
    expect(calls.write).toBe(1);
    read(1_000_000 + H.KEEP_MS, files);
    expect(calls.write).toBe(2);
  });

  test('a probe every 15 seconds reads the disk each time', () => {
    const { files, calls } = fakeFiles();
    for (let i = 0; i < 4; i++) read(1_000_000 + i * 15_000, files);
    expect(calls.write).toBe(4);
    expect(H.KEEP_MS).toBeLessThan(15_000);
  });

  test('a clock that went back reads again, and never keeps an answer for good', () => {
    const { files, calls } = fakeFiles();
    read(1_000_000, files);
    read(500_000, files);
    expect(calls.write).toBe(2);
  });
});

describe('a check that fails', () => {
  test('says its code, and gives the words to the log only', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/srv/oscar/data/.health-check'"), { code: 'EACCES' });
    const { files } = fakeFiles({ writeError: err });
    const warned = [];
    const result = read(1, files, { warn: (what, e) => warned.push([what, e]) });
    expect(result.ok).toBe(false);
    expect(result.data_dir).toEqual({ ok: false, status: 'error', error: 'EACCES' });
    expect(JSON.stringify(result)).not.toContain('/srv/oscar');
    expect(warned).toEqual([['health: the data folder is not writable', err]]);
  });

  test('a failure is kept like a success: the log is not written at every call', () => {
    const { files } = fakeFiles({ writeError: new Error('no') });
    let warned = 0;
    for (let i = 0; i < 20; i++) read(1 + i, files, { warn: () => { warned++; } });
    expect(warned).toBe(1);
  });

  test('a code is a plain word, anything else is "error"', () => {
    expect(H.errorCode({ code: 'ENOSPC' })).toBe('ENOSPC');
    expect(H.errorCode({ code: 'ERR_SQLITE_ERROR' })).toBe('ERR_SQLITE_ERROR');
    for (const err of [null, undefined, {}, { code: 13 }, { code: '' }, { code: 'no such file /etc/x' }, { code: 'A'.repeat(41) }, new Error('x')]) {
      expect(H.errorCode(err)).toBe('error');
    }
  });

  test('too little free space fails; a reading that fails, or a system without one, fails nothing', () => {
    expect(read(1, fakeFiles({ free: 100 * 1024 * 1024 }).files).disk).toEqual({ ok: false, free_mb: 100 });
    H.forgetDiskChecks();
    expect(read(1, fakeFiles({ free: 101 * 1024 * 1024 }).files).ok).toBe(true);
    H.forgetDiskChecks();
    expect(read(1, fakeFiles({ statError: new Error('x') }).files)).toEqual(
      { data_dir: { ok: true, status: 'writable' }, disk: { ok: true, status: 'check_failed_non_critical' }, ok: true });
    H.forgetDiskChecks();
    expect(read(1, fakeFiles({ noStatfs: true }).files).disk).toEqual({ ok: true, status: 'not_checked' });
  });
});

describe('a route that reads a file or the database names its limit in its own chain', () => {
  const source = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

  test('GET /health', () => {
    const server = source('server.js');
    expect(server).toContain("app.get('/health', healthLimiter, (req, res) => {");
    expect(server).toMatch(/const healthLimiter = require\('express-rate-limit'\)\(\{\s+windowMs: 60 \* 1000,\s+max: 300,/);
    // Nothing of an error's own words in an answer anyone can read.
    const handler = server.slice(server.indexOf("app.get('/health'"), server.indexOf('// ── Serve static UI'));
    expect(handler).not.toContain('err.message');
    expect(handler).not.toContain('writeFileSync');
  });

  test('GET /v1/auth/me, before the session is read', () => {
    const auth = source('api/routes/auth.js');
    expect(auth).toContain("router.get('/me', sessionReadLimiter, requireAuth, (req, res) => {");
    expect(auth).toMatch(/const sessionReadLimiter = rateLimit\(\{\s+windowMs: 60 \* 1000,\s+max: 600,/);
  });

  test('GET /v1/runs/:id/artifacts/:aid, and its refusal holds no error text', () => {
    const runs = source('api/routes/runs.js');
    expect(runs).toContain("router.get('/:id/artifacts/:aid', artifactReadLimiter, (req, res) => {");
    expect(runs).toMatch(/const artifactReadLimiter = rateLimit\(\{\s+windowMs: 60 \* 1000,\s+max: 300,/);
    const handler = runs.slice(runs.indexOf("router.get('/:id/artifacts/:aid'"), runs.indexOf("// ── POST /v1/runs/:id/share"));
    expect(handler).not.toContain('detail: err.message');
  });

  test('the sign-out stays without one, on purpose', () => {
    const auth = source('api/routes/auth.js');
    expect(auth).toContain('/logout is intentionally NOT rate-limited');
    expect(auth).toContain("router.post('/logout', requireAuth, (req, res) => {");
  });
});
