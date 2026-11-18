// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/* global AbortSignal */  // Node 22 global

/**
 * A run's output, sent by a kept run pod to the server's internal port
 * (#1309; part 2 = #1318): POST /v1/runs/:runId/output with the run's own
 * secret, `{ seq, parts: [["out" | "err", text], …] }`.
 *
 * Each stream is decoded as UTF-8 on its own (a character cut between two
 * chunks is kept whole), the parts keep the order they came in, and a batch
 * goes every FLUSH_MS or once it holds MAX_BATCH_BYTES. One batch at a time,
 * numbered from 0: the server uses a batch once, so one sent again after an
 * answer that was lost does no harm. A batch the server cannot take yet (no
 * connection, 502/503/504) is sent again after the run's pauses; once they are
 * spent, or on any other refusal, the rest of the run's output is not sent.
 * Node only: no dependency, nothing of the server.
 */

const { StringDecoder } = require('node:string_decoder');

const FLUSH_MS = 500;
const MAX_BATCH_BYTES = 64 * 1024;
// Output that has not gone yet: past this, the newest is left out.
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const SEND_TIMEOUT_MS = 30 * 1000;
const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000]);
const RETRY_STATUSES = new Set([502, 503, 504]);
const STREAMS = Object.freeze(['out', 'err']);
const HIGH_SURROGATE = /^[\uD800-\uDBFF]$/;

// A text cut into pieces of at most `max` characters, never inside a
// surrogate pair: each piece is at most 3 × max bytes in UTF-8.
function piecesOf(text, max) {
  const pieces = [];
  let at = 0;
  while (at < text.length) {
    let end = Math.min(at + max, text.length);
    // A pair is kept whole: it ends this piece's room, or is the whole piece.
    if (end < text.length && HIGH_SURROGATE.test(text[end - 1])) end = end - 1 > at ? end - 1 : end + 1;
    pieces.push(text.slice(at, end));
    at = end;
  }
  return pieces;
}

class OutputSender {
  /**
   * @param {object} o
   * @param {string} o.url        the run's output address on the internal port
   * @param {string} o.secret     the run's secret
   * @param {Function} o.fetchImpl, o.log, o.sleep, o.reasonOf
   */
  constructor({
    url, secret, fetchImpl, log, sleep, reasonOf,
    flushMs = FLUSH_MS, maxBatchBytes = MAX_BATCH_BYTES, maxPendingBytes = MAX_PENDING_BYTES,
    retryDelaysMs = RETRY_DELAYS_MS,
  }) {
    Object.assign(this, { url, secret, fetchImpl, log, sleep, reasonOf, flushMs, maxBatchBytes, maxPendingBytes });
    this.pauses = [...retryDelaysMs];
    this.decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
    this.parts = [];
    this.size = 0;
    this.seq = 0;
    this.stopped = false;
    this.leftOut = 0;
    this.timer = null;
    this.chain = Promise.resolve();
    this.push = this.push.bind(this);
  }

  /** A chunk of one stream ('out' or 'err'), as a process wrote it. */
  push(stream, chunk) {
    if (!STREAMS.includes(stream)) return;
    this.add(stream, this.decoders[stream].write(chunk));
  }

  add(stream, text) {
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    if (this.stopped || this.size + bytes > this.maxPendingBytes) {
      this.leftOut += bytes;
      return;
    }
    const last = this.parts.at(-1);
    if (last && last[0] === stream) last[1] += text;
    else this.parts.push([stream, text]);
    this.size += bytes;
    if (this.size >= this.maxBatchBytes) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), this.flushMs);
  }

  // The parts waiting, in batches of at most maxBatchBytes, queued to be sent.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const pieces = [];
    for (const [stream, text] of this.parts) {
      for (const piece of piecesOf(text, Math.floor(this.maxBatchBytes / 3))) pieces.push([stream, piece]);
    }
    this.parts = [];
    this.size = 0;
    let batch = [];
    let bytes = 0;
    for (const piece of pieces) {
      const size = Buffer.byteLength(piece[1]);
      if (batch.length > 0 && bytes + size > this.maxBatchBytes) {
        this.queue(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(piece);
      bytes += size;
    }
    if (batch.length > 0) this.queue(batch);
  }

  queue(parts) {
    this.chain = this.chain.then(() => this.send(parts));
  }

  async send(parts) {
    if (this.stopped) {
      this.leftOut += parts.reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
      return;
    }
    const seq = this.seq;
    const body = JSON.stringify({ seq, parts });
    for (;;) {
      let reason;
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'X-OSCAR-Run-Secret': this.secret, 'Content-Type': 'application/json' },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status === 200) {
          this.seq += 1;
          return;
        }
        if (!RETRY_STATUSES.has(res.status)) return this.stop(parts, `HTTP ${res.status}`);
        reason = `HTTP ${res.status}`;
      } catch (err) {
        reason = this.reasonOf(err);
      }
      const pause = this.pauses.shift();
      if (pause === undefined) return this.stop(parts, reason);
      await this.sleep(pause);
    }
  }

  stop(parts, reason) {
    this.stopped = true;
    this.leftOut += parts.reduce((n, [, text]) => n + Buffer.byteLength(text), 0);
    this.log(`[kept-pod] the run's output is not sent any more (${reason})`);
  }

  /** The rest of the output, sent; resolves once every batch went or was given up. */
  async end() {
    for (const stream of STREAMS) this.add(stream, this.decoders[stream].end());
    this.flush();
    await this.chain;
    if (this.leftOut > 0) this.log(`[kept-pod] ${this.leftOut} bytes of the run's output were not sent`);
    return { batches: this.seq, leftOut: this.leftOut };
  }
}

module.exports = { OutputSender, piecesOf, FLUSH_MS, MAX_BATCH_BYTES, MAX_PENDING_BYTES, RETRY_DELAYS_MS };
