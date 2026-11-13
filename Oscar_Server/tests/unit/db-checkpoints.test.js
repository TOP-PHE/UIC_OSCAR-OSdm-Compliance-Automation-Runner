// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1230: the database's checkpoints run in a thread of their own. SQLite's
// automatic checkpoint ran inside the COMMIT that took the write-ahead log
// past 1,000 pages, 0.1 to 0.26 s on the server's thread (k3s test machine,
// 2026.548). If that thread fails, ends or goes silent, the server's
// connection checkpoints by itself again: the log never grows without bound.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const metrics = require('../../src/utils/metrics');
const { checkpointsSetting } = require('../../src/db/db');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-ckpt-'));
const booted = [];

// A worker thread starts, writes and checkpoints: on a machine running the
// whole suite this file once took 26 s instead of 4, and a test of several
// waits ran past Jest's 10 s. Each wait has 20 s, each test 60.
jest.setTimeout(60000);

afterAll(async () => {
  for (const m of booted) {
    await m.stopCheckpointThread();
    try { m.db.close(); } catch { /* already closed */ }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// db.js loaded afresh against a database of its own, OSCAR_DB_CHECKPOINTS set
// to `setting`. The environment is put back after.
function boot(setting, name) {
  const saved = { path: process.env.OSCAR_DB_PATH, mode: process.env.OSCAR_DB_CHECKPOINTS };
  let fresh;
  try {
    process.env.OSCAR_DB_PATH = path.join(tempDir, `${name}.db`);
    if (setting === undefined) delete process.env.OSCAR_DB_CHECKPOINTS;
    else process.env.OSCAR_DB_CHECKPOINTS = setting;
    jest.isolateModules(() => {
      fresh = require('../../src/db/db');
    });
  } finally {
    for (const [key, value] of [['OSCAR_DB_PATH', saved.path], ['OSCAR_DB_CHECKPOINTS', saved.mode]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  booted.push(fresh);
  return fresh;
}

async function until(condition, ms = 20000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const autocheckpoint = (m) => m.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;

// About 1,500 pages of 4 KB in small transactions: past the 1,000 pages at
// which a COMMIT checkpoints by itself.
function writePages(m) {
  m.db.exec('CREATE TABLE IF NOT EXISTS filler (x BLOB)');
  const insert = m.db.prepare('INSERT INTO filler (x) VALUES (randomblob(4000))');
  for (let t = 0; t < 150; t++) m.transaction(() => { for (let i = 0; i < 10; i++) insert.run(); });
}

describe('the checkpoint setting (#1230)', () => {
  test('thread by default, inline on demand, anything else refused', () => {
    expect(checkpointsSetting(undefined)).toBe('thread');
    expect(checkpointsSetting('')).toBe('thread');
    expect(checkpointsSetting(' Inline ')).toBe('inline');
    expect(checkpointsSetting('THREAD')).toBe('thread');
    expect(() => checkpointsSetting('off')).toThrow('OSCAR_DB_CHECKPOINTS must be thread or inline, not "off"');
  });

  test('a wrong value stops the start before the database is opened', () => {
    expect(() => boot('never', 'never')).toThrow('OSCAR_DB_CHECKPOINTS must be thread or inline');
    expect(fs.existsSync(path.join(tempDir, 'never.db'))).toBe(false);
  });

  test('inline: no thread, and the COMMITs checkpoint at 1,000 pages', () => {
    const m = boot('inline', 'inline');
    expect(m.startCheckpointThread()).toBeNull();
    expect(autocheckpoint(m)).toBe(1000);
    expect(m.checkpointState()).toEqual({ mode: 'inline', running: false, count: 0, last: null });
  });
});

describe('checkpoints in a thread of their own (#1230)', () => {
  test('once the thread is ready, a COMMIT no longer checkpoints', async () => {
    const m = boot(undefined, 'idle');
    // A thread that never gets to checkpoint during the test.
    m.startCheckpointThread({ intervalMs: 600000 });
    await until(() => m.checkpointState().running);
    expect(autocheckpoint(m)).toBe(0);
    writePages(m);
    // Asked here, the log holds every page written since nothing copied it.
    const { log } = m.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    expect(log).toBeGreaterThan(1200);
  });

  test('the thread copies the log into the database file and says so', async () => {
    const m = boot(undefined, 'working');
    m.startCheckpointThread({ intervalMs: 20 });
    await until(() => m.checkpointState().running);
    writePages(m);
    await until(() => (m.checkpointState().last?.checkpointed ?? 0) > 0);
    await until(() => {
      const last = m.checkpointState().last;
      return last.log > 0 && last.checkpointed === last.log;
    });
    const text = await metrics.register.getSingleMetricAsString('oscar_db_checkpoint_seconds');
    expect(Number(/oscar_db_checkpoint_seconds_count (\d+)/.exec(text)[1])).toBeGreaterThan(0);
    expect(await metrics.register.getSingleMetricAsString('oscar_db_wal_frames_not_copied')).toMatch(/\noscar_db_wal_frames_not_copied 0\n?/);
    expect(await metrics.register.getSingleMetricAsString('oscar_db_checkpoint_thread')).toMatch(/\noscar_db_checkpoint_thread 1\n?/);
    await m.stopCheckpointThread();
    expect(autocheckpoint(m)).toBe(1000);
    expect(await metrics.register.getSingleMetricAsString('oscar_db_checkpoint_thread')).toMatch(/\noscar_db_checkpoint_thread 0\n?/);
  });

  test('a thread that ends: the COMMITs checkpoint again', async () => {
    const m = boot(undefined, 'ended');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const worker = m.startCheckpointThread({ intervalMs: 20 });
      await until(() => m.checkpointState().running);
      await worker.terminate();
      await until(() => !m.checkpointState().running);
      expect(autocheckpoint(m)).toBe(1000);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/the checkpoint thread ended .*checkpoints by itself again/);
    } finally {
      errors.mockRestore();
    }
  });

  test('a thread that reports nothing: the COMMITs checkpoint again', async () => {
    const m = boot(undefined, 'silent');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      m.startCheckpointThread({ intervalMs: 600000, staleMs: 200 });
      await until(() => m.checkpointState().running);
      expect(autocheckpoint(m)).toBe(0);
      await until(() => !m.checkpointState().running);
      expect(autocheckpoint(m)).toBe(1000);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/reported nothing for 0\.2 s/);
    } finally {
      errors.mockRestore();
    }
  });

  test('started twice, one thread', async () => {
    const m = boot(undefined, 'twice');
    const first = m.startCheckpointThread({ intervalMs: 600000 });
    expect(m.startCheckpointThread({ intervalMs: 600000 })).toBe(first);
    await until(() => m.checkpointState().running);
  });

  test('stopped, the thread closes its connection: the files can be removed', async () => {
    const m = boot(undefined, 'stopped');
    m.startCheckpointThread({ intervalMs: 20 });
    await until(() => m.checkpointState().count > 0);
    await m.stopCheckpointThread();
    expect(m.checkpointState().running).toBe(false);
    m.db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(tempDir, `stopped.db${suffix}`), { force: true });
    }
    expect(fs.existsSync(path.join(tempDir, 'stopped.db'))).toBe(false);
  });
});
