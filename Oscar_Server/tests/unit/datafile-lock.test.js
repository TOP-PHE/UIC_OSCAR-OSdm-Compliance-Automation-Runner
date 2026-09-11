// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafile-lock.test.js — every datafile write for one company runs alone
 * (v1.11.197). A tester's save is read-merge-write; without this, two saves
 * that overlap would each read the same stored file and the second write would
 * drop the first one's scenarios.
 */

const { withDatafileLock } = require('../../src/utils/datafileLock');

const tick = ms => new Promise(r => setTimeout(r, ms));

describe('withDatafileLock', () => {
  test('two writes for the same company never overlap, and run in arrival order', async () => {
    const events = [];
    const job = (name, ms) => async () => { events.push(`${name}:start`); await tick(ms); events.push(`${name}:end`); return name; };
    const results = await Promise.all([
      withDatafileLock('co-1', job('A', 30)),
      withDatafileLock('co-1', job('B', 1)),
      withDatafileLock('co-1', job('C', 1)),
    ]);
    expect(results).toEqual(['A', 'B', 'C']);
    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end']);
  });

  test('a lost update is impossible: read-modify-write sequences see each other\'s result', async () => {
    let stored = [];
    const addScenario = code => withDatafileLock('co-2', async () => {
      const snapshot = [...stored];      // read
      await tick(5);                     // the await where an unlocked handler would interleave
      stored = [...snapshot, code];      // write
    });
    await Promise.all(['ANA', 'BEN', 'CAROL'].map(addScenario));
    expect(stored.sort()).toEqual(['ANA', 'BEN', 'CAROL']);
  });

  test('different companies do not wait for each other', async () => {
    const events = [];
    await Promise.all([
      withDatafileLock('co-3', async () => { events.push('3:start'); await tick(30); events.push('3:end'); }),
      withDatafileLock('co-4', async () => { events.push('4:start'); await tick(1); events.push('4:end'); }),
    ]);
    expect(events.indexOf('4:end')).toBeLessThan(events.indexOf('3:end'));
  });

  test('a failed write rejects its own caller and does not block the next one', async () => {
    const failing = withDatafileLock('co-5', async () => { throw new Error('disk full'); });
    const next = withDatafileLock('co-5', async () => 'written');
    await expect(failing).rejects.toThrow('disk full');
    await expect(next).resolves.toBe('written');
  });
});
