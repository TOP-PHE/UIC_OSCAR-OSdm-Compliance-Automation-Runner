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
const { checkpointsSetting, checkpointSizeSetting, checkpointWaitSetting } = require('../../src/db/db');

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
// to `setting` and the settings of `more` as given. The environment is put
// back after.
function boot(setting, name, more = {}) {
  const wanted = { OSCAR_DB_PATH: path.join(tempDir, `${name}.db`), OSCAR_DB_CHECKPOINTS: setting, ...more };
  const saved = Object.fromEntries(Object.keys(wanted).map((key) => [key, process.env[key]]));
  let fresh;
  try {
    for (const [key, value] of Object.entries(wanted)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.isolateModules(() => {
      fresh = require('../../src/db/db');
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  booted.push(fresh);
  return fresh;
}

async function until(condition, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const autocheckpoint = (m) => m.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;
const sizeLimit = (m) => m.db.prepare('PRAGMA journal_size_limit').get().journal_size_limit;
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// At every look, as before #1294.
const EVERY_LOOK = { limitBytes: 0, maxWaitMs: 0 };
// Never by itself during a test: only the first look copies the log.
const NEVER = { limitBytes: 512 * 1024 * 1024, maxWaitMs: 600000 };

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
    expect(m.checkpointState()).toMatchObject({ mode: 'inline', running: false, count: 0, last: null, statistics: null });
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
    m.startCheckpointThread({ intervalMs: 20, ...EVERY_LOOK });
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
      // A second of silence, not 0.2 s: on a busy machine the thread itself
      // took longer than that to start, and was given up before it was ready.
      m.startCheckpointThread({ intervalMs: 600000, staleMs: 1000 });
      await until(() => m.checkpointState().running);
      expect(autocheckpoint(m)).toBe(0);
      await until(() => !m.checkpointState().running);
      expect(autocheckpoint(m)).toBe(1000);
      expect(errors.mock.calls.flat().join('\n')).toMatch(/reported nothing for 1 s/);
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

// #1294: the first write after a complete checkpoint starts the log again and
// syncs it to the disk, on the server's thread. A checkpoint a second made
// that one disk sync a second during a batch. The thread still looks every
// second, but copies the log only past a size or an age.
describe('when the thread copies the log (#1294)', () => {
  test('16 MB or 30 s by default; a wrong value is refused', () => {
    expect(checkpointSizeSetting(undefined)).toBe(16);
    expect(checkpointSizeSetting(' 64 ')).toBe(64);
    expect(checkpointWaitSetting('')).toBe(30);
    expect(checkpointWaitSetting('600')).toBe(600);
    for (const value of ['0', '1025', '16.5', '-1', '16; PRAGMA x', 'big']) {
      expect(() => checkpointSizeSetting(value)).toThrow('OSCAR_DB_CHECKPOINT_MB must be a whole number of megabytes from 1 to 1024');
    }
    for (const value of ['0', '601', '1.5', 'soon']) {
      expect(() => checkpointWaitSetting(value)).toThrow('OSCAR_DB_CHECKPOINT_SECONDS must be a whole number of seconds from 1 to 600');
    }
  });

  test('a wrong value stops the start before the database is opened', () => {
    expect(() => boot(undefined, 'wrong-size', { OSCAR_DB_CHECKPOINT_MB: '0' })).toThrow('OSCAR_DB_CHECKPOINT_MB must be');
    expect(() => boot(undefined, 'wrong-wait', { OSCAR_DB_CHECKPOINT_SECONDS: 'never' })).toThrow('OSCAR_DB_CHECKPOINT_SECONDS must be');
    expect(fs.existsSync(path.join(tempDir, 'wrong-size.db'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'wrong-wait.db'))).toBe(false);
  });

  test('the settings reach the thread, and the log file is cut back to the size', async () => {
    const m = boot(undefined, 'settings', { OSCAR_DB_CHECKPOINT_MB: '3', OSCAR_DB_CHECKPOINT_SECONDS: '7' });
    m.startCheckpointThread({ intervalMs: 20 });
    await until(() => m.checkpointState().running);
    expect(m.checkpointState()).toMatchObject({ limitBytes: 3 * 1024 * 1024, maxWaitMs: 7000 });
    expect(sizeLimit(m)).toBe(3 * 1024 * 1024);
    await m.stopCheckpointThread();
    expect(sizeLimit(m)).toBe(-1);
  });

  test('a log under the size and a recent checkpoint: the thread looks, and leaves it', async () => {
    const m = boot(undefined, 'left');
    m.startCheckpointThread({ intervalMs: 20, ...NEVER });
    // The first look copies whatever the start left.
    await until(() => m.checkpointState().count === 1);
    writePages(m);
    // It goes on looking: it reports the size of the log file it saw.
    await until(() => m.checkpointState().walBytes > 4 * 1024 * 1024);
    await pause(200);
    expect(m.checkpointState().count).toBe(1);
    const { log } = m.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
    expect(log).toBeGreaterThan(1200);
    const text = await metrics.register.getSingleMetricAsString('oscar_db_wal_bytes');
    expect(Number(text.split('oscar_db_wal_bytes ').pop())).toBeGreaterThan(4 * 1024 * 1024);
  });

  test('a log past the size is copied, without waiting for its age', async () => {
    const m = boot(undefined, 'size');
    m.startCheckpointThread({ intervalMs: 20, limitBytes: 1024 * 1024, maxWaitMs: 600000 });
    await until(() => m.checkpointState().count === 1);
    writePages(m);
    await until(() => m.checkpointState().count >= 2 && m.checkpointState().last.checkpointed > 0);
    // Copied in full, the log is then left alone: nothing was written since.
    await until(() => m.checkpointState().last.checkpointed === m.checkpointState().last.log);
    // One more may follow, for what was written while the last one ran; then none.
    let count;
    await until(async () => {
      count = m.checkpointState().count;
      await pause(300);
      return m.checkpointState().count === count;
    });
    expect(m.checkpointState().last.checkpointed).toBe(m.checkpointState().last.log);
  });

  test('a checkpoint that is old is made again, whatever the size of the log', async () => {
    const m = boot(undefined, 'age');
    m.startCheckpointThread({ intervalMs: 20, limitBytes: 512 * 1024 * 1024, maxWaitMs: 150 });
    await until(() => m.checkpointState().count === 1);
    m.db.exec('CREATE TABLE IF NOT EXISTS filler (x BLOB)');
    m.db.exec('INSERT INTO filler (x) VALUES (randomblob(4000))');
    await until(() => m.checkpointState().count >= 3);
    await until(() => m.checkpointState().last.checkpointed === m.checkpointState().last.log);
  });

  test('what a checkpoint could not copy is tried again at each look', async () => {
    const m = boot(undefined, 'reader');
    const { DatabaseSync } = require('node:sqlite');
    m.db.exec('CREATE TABLE IF NOT EXISTS filler (x BLOB)');
    m.startCheckpointThread({ intervalMs: 20, limitBytes: 1024 * 1024, maxWaitMs: 600000 });
    await until(() => m.checkpointState().count === 1);
    // A reader that keeps its view of the database: a passive checkpoint
    // cannot copy the frames written after it.
    const reader = new DatabaseSync(path.join(tempDir, 'reader.db'));
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM filler').get();
      writePages(m);
      await until(() => {
        const { last } = m.checkpointState();
        return last.log > 1200 && last.checkpointed < last.log;
      });
      const { count } = m.checkpointState();
      await until(() => m.checkpointState().count >= count + 3);
      reader.exec('COMMIT');
      await until(() => m.checkpointState().last.checkpointed === m.checkpointState().last.log);
    } finally {
      reader.close();
    }
  });
});
