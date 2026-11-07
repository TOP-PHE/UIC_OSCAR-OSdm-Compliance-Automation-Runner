// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The server ↔ runner agent protocol (run isolation, option 2b). Pure: no
 * file, no network, no database.
 *
 * One TCP connection per process. Newline-delimited JSON:
 *   server → agent: first line { v: 1, token, kind, args, cwd, env },
 *                   then { t: 'kill', signal } as needed;
 *   agent → server: { t: 'started' }, { t: 'out', d }, { t: 'err', d },
 *                   { t: 'exit', code, signal } or { t: 'refused', reason }.
 * Closing the connection stops the process.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const { RUN_ENV_KEYS } = require('../worker/childEnv');

const VERSION = 1;
const KINDS = Object.freeze(['bru', 'merge']);
const SIGNALS = Object.freeze(['SIGTERM', 'SIGKILL']);
const MAX_LINE = 1024 * 1024;           // a request: args + env, far below this
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
const MAX_ENV_VALUE = 64 * 1024;
const RUN_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_TOKEN_LENGTH = 32;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const plainText = (s, max) => typeof s === 'string' && s.length <= max && !s.includes('\0');

/** Constant-time comparison of two tokens (by their digests). */
function sameToken(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The run folder a request names, if it is one: a direct child of
 * `workspacesDir` named by a run id. Returns the resolved path or null.
 * (The agent also checks it exists and is no symbolic link.)
 */
function runFolderOf(cwd, workspacesDir) {
  if (!plainText(cwd, 4096) || !workspacesDir) return null;
  const resolved = path.resolve(cwd);
  const root = path.resolve(workspacesDir);
  if (path.dirname(resolved) !== root || !RUN_DIR_RE.test(path.basename(resolved))) return null;
  return resolved;
}

/**
 * Checks a request line (already parsed). Returns { request } with only the
 * fields the agent uses, or { reason }. The environment keeps the run's own
 * credentials only: whatever else is sent is dropped, never passed on.
 */
function checkRequest(msg, { token, workspacesDir }) {
  if (!isObj(msg) || msg.v !== VERSION) return { reason: 'not a request of this protocol' };
  if (!sameToken(msg.token, token)) return { reason: 'not authorised' };
  if (!KINDS.includes(msg.kind)) return { reason: 'unknown kind' };
  if (!Array.isArray(msg.args) || msg.args.length > MAX_ARGS || !msg.args.every((a) => plainText(a, MAX_ARG_LENGTH))) {
    return { reason: 'arguments refused' };
  }
  const cwd = runFolderOf(msg.cwd, workspacesDir);
  if (!cwd) return { reason: 'not a run folder' };
  const env = {};
  if (msg.env !== undefined) {
    if (!isObj(msg.env)) return { reason: 'environment refused' };
    for (const key of RUN_ENV_KEYS) {
      const value = msg.env[key];
      if (value === undefined) continue;
      if (!plainText(value, MAX_ENV_VALUE)) return { reason: 'environment refused' };
      env[key] = value;
    }
  }
  return { request: { kind: msg.kind, args: [...msg.args], cwd, env } };
}

/** A kill message's signal, if it is one the agent sends on. */
function killSignalOf(msg) {
  return isObj(msg) && msg.t === 'kill' && SIGNALS.includes(msg.signal) ? msg.signal : null;
}

/** One message as a line. */
const line = (msg) => `${JSON.stringify(msg)}\n`;

/**
 * Splits a stream into lines, refusing one longer than `max`: calls
 * onLine(text) per line, onTooLong() once and stops when a line overflows.
 */
function lineReader(onLine, onTooLong, max = MAX_LINE) {
  let buffer = '';
  let dead = false;
  return (chunk) => {
    if (dead) return;
    buffer += chunk.toString('utf8');
    let at = buffer.indexOf('\n');
    while (at !== -1) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (text.length > max) { dead = true; onTooLong(); return; }
      onLine(text);
      at = buffer.indexOf('\n');
    }
    if (buffer.length > max) { dead = true; onTooLong(); }
  };
}

module.exports = {
  VERSION, KINDS, SIGNALS, MAX_LINE, MIN_TOKEN_LENGTH,
  sameToken, runFolderOf, checkRequest, killSignalOf, line, lineReader,
};
