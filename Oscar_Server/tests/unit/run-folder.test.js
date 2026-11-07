// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The files of a run's working folder (src/worker/runFolder.js), with real
 * links on disk: the server never follows one there, whether a link to a
 * file or a folder of the path. A link to a file needs a right Windows gives
 * in Developer Mode only; without it those tests are skipped (CI runs them).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const F = require('../../src/worker/runFolder');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-folder-')));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

let n = 0;
// A run folder and, beside it, a folder of the server's that holds a secret.
function setup() {
  n += 1;
  const base = path.join(root, `case-${n}`);
  const run = path.join(base, 'run');
  const reports = path.join(run, 'Validation_Reports');
  const server = path.join(base, 'server');
  fs.mkdirSync(reports, { recursive: true });
  fs.mkdirSync(server);
  const secret = path.join(server, 'oscar.db');
  fs.writeFileSync(secret, 'SERVER-SECRET');
  return { run, reports, server, secret };
}

function canLink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-folder-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    fs.symlinkSync(path.join(dir, 'f'), path.join(dir, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const linkTest = canLink() ? test : test.skip;
// A link to a folder: a junction on Windows (no right needed), a symlink elsewhere.
const linkFolder = (target, at) => fs.symlinkSync(target, at, 'junction');
const procFd = fs.existsSync('/proc/self/fd') ? test : test.skip;

describe('reading a file of the run folder', () => {
  test('a plain file is read', async () => {
    const { reports } = setup();
    fs.writeFileSync(path.join(reports, 'r.html'), '<html>ok</html>');
    const content = await F.readRunFile(reports, 'r.html', { expectedDir: reports });
    expect(content.toString()).toBe('<html>ok</html>');
  });

  linkTest('a link to a file is refused, and what it names is never read', async () => {
    const { reports, secret } = setup();
    fs.symlinkSync(secret, path.join(reports, 'r.html'), 'file');
    await expect(F.readRunFile(reports, 'r.html', { expectedDir: reports }))
      .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('link') });
  });

  linkTest('a link is refused even without a folder to check against', async () => {
    const { reports, secret } = setup();
    fs.symlinkSync(secret, path.join(reports, 'r.html'), 'file');
    await expect(F.readRunFile(reports, 'r.html')).rejects.toMatchObject({ code: 'ERUNFILE' });
  });

  test('a folder of the path that is a link is refused', async () => {
    const { run, server, reports } = setup();
    fs.rmSync(reports, { recursive: true });
    linkFolder(server, reports);
    await expect(F.readRunFile(reports, 'oscar.db', { expectedDir: path.join(run, 'Validation_Reports') }))
      .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('not the run\'s own folder') });
  });

  procFd('a folder swapped for a link after the check is caught on the open file', async () => {
    const { run, server, reports } = setup();
    const expected = path.join(run, 'Validation_Reports');
    fs.rmSync(reports, { recursive: true });
    linkFolder(server, reports);
    // The check is passed (as if the swap came just after it); the open file says where it is.
    const realpath = jest.spyOn(fs.promises, 'realpath').mockResolvedValueOnce(expected);
    try {
      await expect(F.readRunFile(reports, 'oscar.db', { expectedDir: expected }))
        .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('outside') });
    } finally {
      realpath.mockRestore();
    }
  });

  test('a file over the limit is refused', async () => {
    const { reports } = setup();
    fs.writeFileSync(path.join(reports, 'big.json'), 'x'.repeat(2048));
    await expect(F.readRunFile(reports, 'big.json', { expectedDir: reports, maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('larger') });
    const fits = await F.readRunFile(reports, 'big.json', { expectedDir: reports, maxBytes: 2048 });
    expect(fits.length).toBe(2048);
  });

  test('a folder is not a file', async () => {
    const { reports } = setup();
    fs.mkdirSync(path.join(reports, 'r.html'));
    await expect(F.readRunFile(reports, 'r.html', { expectedDir: reports })).rejects.toBeTruthy();
  });

  (process.platform === 'linux' ? test : test.skip)('a named pipe is refused at once, never waited on', async () => {
    const { reports } = setup();
    const fifo = path.join(reports, 'r.html');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    await expect(F.readRunFile(reports, 'r.html', { expectedDir: reports }))
      .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('not a plain file') });
  }, 5000);

  test.each(['', '.', '..', '../oscar.db', 'a/b', 'a\\b', 'a\0b', 7, null])('the name %p is refused', async (name) => {
    const { reports } = setup();
    await expect(F.readRunFile(reports, name)).rejects.toMatchObject({ code: 'ERUNFILE' });
  });

  test('a file that is not there is ENOENT, not a refusal', async () => {
    const { reports } = setup();
    await expect(F.readRunFile(reports, 'none.json')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('writing a file of the run folder', () => {
  test('a new file is written', async () => {
    const { reports } = setup();
    await F.writeRunFile(reports, 'e.yml', 'name: x\n', { expectedDir: reports });
    expect(fs.readFileSync(path.join(reports, 'e.yml'), 'utf8')).toBe('name: x\n');
  });

  test('a file already there is replaced', async () => {
    const { reports } = setup();
    fs.writeFileSync(path.join(reports, 'e.yml'), 'old');
    await F.writeRunFile(reports, 'e.yml', 'new', { expectedDir: reports });
    expect(fs.readFileSync(path.join(reports, 'e.yml'), 'utf8')).toBe('new');
  });

  linkTest('a link where the file goes is replaced by a new file; what it named is unchanged', async () => {
    const { reports, secret } = setup();
    const at = path.join(reports, '.bru_results.json');
    fs.symlinkSync(secret, at, 'file');
    await F.writeRunFile(reports, '.bru_results.json', '{"results":[]}', { expectedDir: reports });
    expect(fs.readFileSync(secret, 'utf8')).toBe('SERVER-SECRET');
    expect(fs.readFileSync(at, 'utf8')).toBe('{"results":[]}');
    expect(fs.lstatSync(at).isSymbolicLink()).toBe(false);
  });

  test('a folder of the path that is a link is refused, and nothing is written there', async () => {
    const { run, server, reports } = setup();
    fs.rmSync(reports, { recursive: true });
    linkFolder(server, reports);
    await expect(F.writeRunFile(reports, 'oscar.db', 'overwritten', { expectedDir: path.join(run, 'Validation_Reports') }))
      .rejects.toMatchObject({ code: 'ERUNFILE' });
    expect(fs.readFileSync(path.join(server, 'oscar.db'), 'utf8')).toBe('SERVER-SECRET');
    expect(fs.readdirSync(server)).toEqual(['oscar.db']);
  });

  procFd('a folder swapped for a link after the check: the file made there is removed', async () => {
    const { run, server, reports } = setup();
    const expected = path.join(run, 'Validation_Reports');
    fs.rmSync(reports, { recursive: true });
    linkFolder(server, reports);
    const realpath = jest.spyOn(fs.promises, 'realpath').mockResolvedValueOnce(expected);
    try {
      await expect(F.writeRunFile(reports, 'env.yml', 'x', { expectedDir: expected }))
        .rejects.toMatchObject({ code: 'ERUNFILE', message: expect.stringContaining('outside') });
    } finally {
      realpath.mockRestore();
    }
    expect(fs.readdirSync(server)).toEqual(['oscar.db']);
  });

  linkTest('removing a file removes a link, never what it names', async () => {
    const { reports, secret } = setup();
    fs.symlinkSync(secret, path.join(reports, 'x.json'), 'file');
    await F.removeRunFile(reports, 'x.json', { expectedDir: reports });
    expect(fs.existsSync(path.join(reports, 'x.json'))).toBe(false);
    expect(fs.readFileSync(secret, 'utf8')).toBe('SERVER-SECRET');
    await expect(F.removeRunFile(reports, 'x.json', { expectedDir: reports })).resolves.toBeUndefined();
  });
});

describe('listing, making and copying', () => {
  linkTest('a listing tells plain files from links, with the link\'s own date', async () => {
    const { reports, secret } = setup();
    fs.writeFileSync(path.join(reports, 'a_Report.html'), 'a');
    fs.symlinkSync(secret, path.join(reports, 'b_Report.html'), 'file');
    const old = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(secret, old, old);                             // what the link names is old
    const list = await F.listRunFolder(reports, { expectedDir: reports });
    const byName = Object.fromEntries(list.map(e => [e.name, e]));
    expect(byName['a_Report.html'].plain).toBe(true);
    expect(byName['b_Report.html'].plain).toBe(false);
    expect(byName['b_Report.html'].mtimeMs).toBeGreaterThan(old.getTime());   // the link's own date
  });

  test('a listing of a folder that is a link is refused', async () => {
    const { run, server, reports } = setup();
    fs.rmSync(reports, { recursive: true });
    linkFolder(server, reports);
    await expect(F.listRunFolder(reports, { expectedDir: path.join(run, 'Validation_Reports') }))
      .rejects.toMatchObject({ code: 'ERUNFILE' });
  });

  test('a folder is made new, never reused', async () => {
    const { run } = setup();
    const made = await F.makeRunFolder(run, 'environments', { expectedDir: run });
    expect(made).toBe(path.join(run, 'environments'));
    await expect(F.makeRunFolder(run, 'environments', { expectedDir: run })).rejects.toMatchObject({ code: 'EEXIST' });
  });

  test('a link where a folder goes is not made into one', async () => {
    const { run, server } = setup();
    linkFolder(server, path.join(run, 'library-bruno'));
    await expect(F.makeRunFolder(run, 'library-bruno', { expectedDir: run })).rejects.toMatchObject({ code: 'EEXIST' });
  });

  test('a folder of the collection is copied, files and sub-folders', async () => {
    const { run } = setup();
    const source = path.join(root, `source-${n}`);
    fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(source, 'a.js'), 'A');
    fs.writeFileSync(path.join(source, 'sub', 'b.json'), 'B');
    await F.copyIntoRunFolder(source, run, 'library-bruno', { expectedDir: run });
    expect(fs.readFileSync(path.join(run, 'library-bruno', 'a.js'), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(run, 'library-bruno', 'sub', 'b.json'), 'utf8')).toBe('B');
    await expect(F.copyFileIntoRunFolder(path.join(source, 'none'), run, 'none', { expectedDir: run })).resolves.toBe(false);
  });

  linkTest('removing a run folder removes a link in it, never what it names', async () => {
    const { run, server, secret } = setup();
    linkFolder(server, path.join(run, 'data_base'));
    fs.symlinkSync(secret, path.join(run, 'Validation_Reports', 'r.html'), 'file');
    await fs.promises.rm(run, { recursive: true, force: true });        // what cleanupWorkspace does
    expect(fs.existsSync(run)).toBe(false);
    expect(fs.readFileSync(secret, 'utf8')).toBe('SERVER-SECRET');
  });
});
