// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * at-rest-rename-retry.test.js — the atomic temp+rename in encryptToFile /
 * encryptToFileAsync survives a file that Windows is briefly holding.
 *
 * On Windows, OneDrive or Defender briefly lock a freshly written file, and a
 * rename over it fails with EPERM (also seen as EBUSY / EACCES). Measured
 * 2026-09-11 on a checkout inside OneDrive: 14 of 400 back-to-back rewrites of
 * one path. Before this fix the write failed outright AND left its
 * `<dst>.tmp.<hex>` file behind. The tests inject those errors by mocking
 * fs.renameSync / fs.promises.rename, so they behave the same on Linux CI.
 *
 * Scratch files live under data/artifacts/ — at-rest only writes under
 * data/artifacts or data/datafiles — in a per-suite random directory, never
 * os.tmpdir() (CodeQL js/insecure-temporary-file).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const at     = require('../../src/utils/at-rest');

const SCRATCH = path.resolve(__dirname, '../../data/artifacts',
                             `_test_rename_${crypto.randomBytes(16).toString('hex')}`);
fs.mkdirSync(SCRATCH, { mode: 0o700, recursive: true });

afterAll(() => {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});
afterEach(() => jest.restoreAllMocks());

const dstFor = name => path.join(SCRATCH, `${name}-${crypto.randomBytes(4).toString('hex')}.json`);

/** Temp files left next to dst — `<dst>.tmp.<hex>` is at-rest's naming. */
function strays(dst) {
  const prefix = path.basename(dst) + '.tmp.';
  return fs.readdirSync(path.dirname(dst)).filter(n => n.startsWith(prefix));
}

function fsError(code, syscall, p) {
  const err = new Error(`${code}: simulated, ${syscall} '${p}'`);
  err.code = code;
  err.syscall = syscall;
  return err;
}

const LOCK_CODES = ['EPERM', 'EBUSY', 'EACCES'];

// The whole retry budget, read from the module so the tests follow the schedule
// rather than restating it. Undefined on the un-fixed code, where the retry
// tests below must fail.
const DELAYS      = at.RENAME_RETRY_DELAYS_MS || [];
const MAX_TRIES   = DELAYS.length + 1;
const TOTAL_DELAY = DELAYS.reduce((a, b) => a + b, 0);

// ── Sync ──────────────────────────────────────────────────────────────────────
describe('encryptToFile (sync) — rename over a briefly locked file', () => {
  const realRenameSync = fs.renameSync;

  test.each(LOCK_CODES)('%s twice, then free: the write lands and no temp file is left', (code) => {
    const dst = dstFor(`sync-${code}`);
    let injected = 2;
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (injected > 0) { injected--; throw fsError(code, 'rename', from); }
      return realRenameSync(from, to);
    });

    at.encryptToFile('fresh content', dst);

    expect(injected).toBe(0);                            // both injected failures were retried past
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(at.decryptFromFile(dst).toString()).toBe('fresh content');
    expect(strays(dst)).toEqual([]);
  });

  test('a lock that never clears: the error surfaces after the retry budget, the temp file is removed, the previous file survives', () => {
    const dst = dstFor('sync-stuck');
    at.encryptToFile('previous', dst);                   // real write, before the mock

    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(from => { throw fsError('EPERM', 'rename', from); });
    const started = Date.now();
    expect(() => at.encryptToFile('never lands', dst)).toThrow(/EPERM/);
    const elapsed = Date.now() - started;

    expect(DELAYS.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(MAX_TRIES);
    // It waited between attempts rather than spinning — a lock needs time to clear.
    expect(elapsed).toBeGreaterThanOrEqual(TOTAL_DELAY * 0.8);
    expect(strays(dst)).toEqual([]);
    spy.mockRestore();
    expect(at.decryptFromFile(dst).toString()).toBe('previous');
  });

  test('an error that is not a lock is not retried, and still cleans up', () => {
    const dst = dstFor('sync-exdev');
    const spy = jest.spyOn(fs, 'renameSync').mockImplementation(from => { throw fsError('EXDEV', 'rename', from); });
    expect(() => at.encryptToFile('x', dst)).toThrow(/EXDEV/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(strays(dst)).toEqual([]);
  });

  test('the cleanup itself is retried when the temp file is the one being held', () => {
    const dst = dstFor('sync-unlink');
    const realUnlinkSync = fs.unlinkSync;
    jest.spyOn(fs, 'renameSync').mockImplementation(from => { throw fsError('EPERM', 'rename', from); });
    let unlinkLocked = 2;
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementation(p => {
      if (unlinkLocked > 0) { unlinkLocked--; throw fsError('EPERM', 'unlink', p); }
      return realUnlinkSync(p);
    });

    expect(() => at.encryptToFile('x', dst)).toThrow(/EPERM/);
    expect(unlinkLocked).toBe(0);
    expect(unlink.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(strays(dst)).toEqual([]);
  });
});

// ── Async ─────────────────────────────────────────────────────────────────────
describe('encryptToFileAsync — rename over a briefly locked file', () => {
  const realRename = fs.promises.rename;

  test.each(LOCK_CODES)('%s twice, then free: the write lands and no temp file is left', async (code) => {
    const dst = dstFor(`async-${code}`);
    let injected = 2;
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (injected > 0) { injected--; throw fsError(code, 'rename', from); }
      return realRename.call(fs.promises, from, to);
    });

    await at.encryptToFileAsync('fresh content', dst);

    expect(injected).toBe(0);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect((await at.decryptFromFileAsync(dst)).toString()).toBe('fresh content');
    expect(strays(dst)).toEqual([]);
  });

  test('a lock that never clears: the error surfaces after the retry budget, the temp file is removed, the previous file survives', async () => {
    const dst = dstFor('async-stuck');
    await at.encryptToFileAsync('previous', dst);

    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async from => { throw fsError('EPERM', 'rename', from); });
    const started = Date.now();
    await expect(at.encryptToFileAsync('never lands', dst)).rejects.toThrow(/EPERM/);
    const elapsed = Date.now() - started;

    expect(DELAYS.length).toBeGreaterThan(0);
    expect(spy).toHaveBeenCalledTimes(MAX_TRIES);
    expect(elapsed).toBeGreaterThanOrEqual(TOTAL_DELAY * 0.8);
    expect(strays(dst)).toEqual([]);
    spy.mockRestore();
    expect((await at.decryptFromFileAsync(dst)).toString()).toBe('previous');
  });

  test('an error that is not a lock is not retried, and still cleans up', async () => {
    const dst = dstFor('async-exdev');
    const spy = jest.spyOn(fs.promises, 'rename').mockImplementation(async from => { throw fsError('EXDEV', 'rename', from); });
    await expect(at.encryptToFileAsync('x', dst)).rejects.toThrow(/EXDEV/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(strays(dst)).toEqual([]);
  });

  test('the cleanup itself is retried when the temp file is the one being held', async () => {
    const dst = dstFor('async-unlink');
    const realUnlink = fs.promises.unlink;
    jest.spyOn(fs.promises, 'rename').mockImplementation(async from => { throw fsError('EPERM', 'rename', from); });
    let unlinkLocked = 2;
    const unlink = jest.spyOn(fs.promises, 'unlink').mockImplementation(async p => {
      if (unlinkLocked > 0) { unlinkLocked--; throw fsError('EPERM', 'unlink', p); }
      return realUnlink.call(fs.promises, p);
    });

    await expect(at.encryptToFileAsync('x', dst)).rejects.toThrow(/EPERM/);
    expect(unlinkLocked).toBe(0);
    expect(unlink.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(strays(dst)).toEqual([]);
  });

  test('copyAndEncryptFileAsync inherits the retry (runner.js artifact path)', async () => {
    const src = dstFor('copy-src');
    fs.writeFileSync(src, 'report body');
    const dst = dstFor('copy-dst');
    let injected = 1;
    jest.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (injected > 0) { injected--; throw fsError('EBUSY', 'rename', from); }
      return realRename.call(fs.promises, from, to);
    });

    await at.copyAndEncryptFileAsync(src, dst);

    expect(injected).toBe(0);
    expect((await at.decryptFromFileAsync(dst)).toString()).toBe('report body');
    expect(strays(dst)).toEqual([]);
  });
});
