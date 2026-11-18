// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Where a run's output goes when a kept run pod sends it (#1309; part 2 =
 * #1318): each batch used once and in order, a limit per run.
 */

const { randomUUID } = require('node:crypto');
const runOutput = require('../../src/worker/runOutput');

const { MAX_RUN_OUTPUT_BYTES, MAX_PARTS } = runOutput;
let got;
beforeEach(() => {
  runOutput._clear();
  got = [];
});
const sink = (stream, text) => got.push([stream, text]);

describe('a run\'s output', () => {
  test('its batches go to the run\'s sink, in order, once each', () => {
    const runId = randomUUID();
    runOutput.open(runId, sink);
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a'], ['err', 'b']] })).toEqual({ status: 200, used: true });
    expect(runOutput.deliver(runId, { seq: 1, parts: [['out', 'c']] })).toEqual({ status: 200, used: true });
    expect(runOutput.deliver(runId, { seq: 1, parts: [['out', 'c']] })).toEqual({ status: 200, used: false });
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a']] })).toEqual({ status: 200, used: false });
    expect(got).toEqual([['out', 'a'], ['err', 'b'], ['out', 'c']]);
  });

  test('a batch before its turn is refused and not used', () => {
    const runId = randomUUID();
    runOutput.open(runId, sink);
    expect(runOutput.deliver(runId, { seq: 1, parts: [['out', 'b']] })).toMatchObject({ status: 409, detail: 'Batch 1 came before batch 0.' });
    expect(got).toEqual([]);
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a']] }).status).toBe(200);
  });

  test('a run whose output is not open, or closed: refused', () => {
    const runId = randomUUID();
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a']] }).status).toBe(409);
    runOutput.open(runId, sink);
    runOutput.close(runId);
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a']] }).status).toBe(409);
    expect(got).toEqual([]);
  });

  test('another run\'s output goes to its own sink', () => {
    const a = randomUUID();
    const b = randomUUID();
    const other = [];
    runOutput.open(a, sink);
    runOutput.open(b, (s, t) => other.push([s, t]));
    runOutput.deliver(b, { seq: 0, parts: [['out', 'for b']] });
    expect(got).toEqual([]);
    expect(other).toEqual([['out', 'for b']]);
  });

  test(`past ${MAX_RUN_OUTPUT_BYTES} bytes a run's output is refused, then closed`, () => {
    const runId = randomUUID();
    runOutput.open(runId, () => {});
    const big = 'x'.repeat(16 * 1024 * 1024);
    for (let seq = 0; seq < 4; seq++) expect(runOutput.deliver(runId, { seq, parts: [['out', big]] }).status).toBe(200);
    expect(runOutput.deliver(runId, { seq: 4, parts: [['out', 'x']] }).status).toBe(413);
    expect(runOutput.deliver(runId, { seq: 4, parts: [['out', '']] }).status).toBe(409);
  });

  test('the limit counts bytes, not characters', () => {
    const runId = randomUUID();
    runOutput.open(runId, () => {});
    const euros = '€'.repeat(Math.floor(MAX_RUN_OUTPUT_BYTES / 3));   // 3 bytes each: one byte short of the limit
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', euros]] }).status).toBe(200);
    expect(runOutput.deliver(runId, { seq: 1, parts: [['out', 'é']] }).status).toBe(413);
  });

  test('a sink that throws does not stop the batch being used', () => {
    const runId = randomUUID();
    runOutput.open(runId, () => { throw new Error('sink'); });
    expect(runOutput.deliver(runId, { seq: 0, parts: [['out', 'a'], ['err', 'b']] })).toEqual({ status: 200, used: true });
    expect(runOutput.deliver(runId, { seq: 1, parts: [['out', 'c']] }).status).toBe(200);
  });

  test('open() needs a run id and a function', () => {
    expect(() => runOutput.open('', sink)).toThrow(/runId/);
    expect(() => runOutput.open(randomUUID(), null)).toThrow(/sink/);
  });
});

describe('batchOf(): a body is { seq, parts } and nothing else', () => {
  test('a batch', () => {
    expect(runOutput.batchOf({ seq: 0, parts: [['out', ''], ['err', 'x']] })).toEqual({ seq: 0, parts: [['out', ''], ['err', 'x']] });
    expect(runOutput.batchOf({ parts: [['out', 'x']], seq: 7 })).toEqual({ seq: 7, parts: [['out', 'x']] });
  });

  test('anything else', () => {
    const part = ['out', 'x'];
    for (const body of [
      undefined, null, 'text', [], {}, { seq: 0 }, { parts: [part] }, { seq: 0, parts: [part], more: 1 },
      { seq: -1, parts: [part] }, { seq: 1.5, parts: [part] }, { seq: '0', parts: [part] }, { seq: 2 ** 53, parts: [part] },
      { seq: 0, parts: [] }, { seq: 0, parts: 'x' }, { seq: 0, parts: Array(MAX_PARTS + 1).fill(part) },
      { seq: 0, parts: [['in', 'x']] }, { seq: 0, parts: [['out', 1]] }, { seq: 0, parts: [['out']] }, { seq: 0, parts: [['out', 'x', 'y']] },
      { seq: 0, parts: [{ 0: 'out', 1: 'x' }] },
    ]) {
      expect([JSON.stringify(body), runOutput.batchOf(body)]).toEqual([JSON.stringify(body), null]);
    }
    expect(runOutput.batchOf({ seq: 0, parts: Array(MAX_PARTS).fill(part) })).not.toBeNull();
  });
});
