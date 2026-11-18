// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Where a run's output goes when a kept run pod sends it (#1309; part 2 =
 * #1318): POST /v1/runs/:runId/output on the internal port, with the run's own
 * secret, `{ seq, parts: [["out" | "err", text], …] }` (run-pod/outputSender.js).
 *
 * The server opens a run's output when it hands the run to a pod (part 4),
 * with the function each part goes to, and closes it when the run ends. Each
 * batch is used once and in order: one already used (sent again after an
 * answer that was lost) is answered again and not used; one that comes before
 * its turn is refused. MAX_RUN_OUTPUT_BYTES a run at most.
 *
 * In memory, like the runs' secrets: a run does not outlive a restart.
 */

const MAX_RUN_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PARTS = 1000;
const STREAMS = new Set(['out', 'err']);

const _byRun = new Map();   // runId -> { sink, next, bytes }

/** Opens a run's output: each part goes to `sink(stream, text)`, in order. */
function open(runId, sink) {
  if (typeof runId !== 'string' || runId === '') throw new TypeError('runOutput.open: runId is required');
  if (typeof sink !== 'function') throw new TypeError('runOutput.open: sink must be a function');
  _byRun.set(runId, { sink, next: 0, bytes: 0 });
}

/** Closes a run's output; a batch that comes after it is refused. */
function close(runId) {
  _byRun.delete(runId);
}

/** A request's body as a batch { seq, parts }, or null when it is not one. */
function batchOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !Object.hasOwn(body, 'seq') || !Object.hasOwn(body, 'parts')) return null;
  const { seq, parts } = body;
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) return null;
  for (const part of parts) {
    if (!Array.isArray(part) || part.length !== 2 || !STREAMS.has(part[0]) || typeof part[1] !== 'string') return null;
  }
  return { seq, parts };
}

/**
 * Uses one batch of a run's output. { status: 200, used } (used false for a
 * batch already used), or { status, detail } when it is refused: 409 for a run
 * whose output is not open or a batch before its turn, 413 past the run's
 * limit (the run's output is then closed).
 */
function deliver(runId, { seq, parts }) {
  const run = _byRun.get(runId);
  if (!run) return { status: 409, detail: 'This run\'s output is not expected.' };
  if (seq < run.next) return { status: 200, used: false };
  if (seq > run.next) return { status: 409, detail: `Batch ${seq} came before batch ${run.next}.` };
  const bytes = parts.reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
  if (run.bytes + bytes > MAX_RUN_OUTPUT_BYTES) {
    close(runId);
    return { status: 413, detail: `A run's output holds at most ${MAX_RUN_OUTPUT_BYTES} bytes.` };
  }
  run.next += 1;
  run.bytes += bytes;
  for (const [stream, text] of parts) {
    try { run.sink(stream, text); } catch { /* the sink's own problem: the batch is used */ }
  }
  return { status: 200, used: true };
}

/** Tests only. */
function _clear() {
  _byRun.clear();
}

module.exports = { open, close, batchOf, deliver, MAX_RUN_OUTPUT_BYTES, MAX_PARTS, _clear };
