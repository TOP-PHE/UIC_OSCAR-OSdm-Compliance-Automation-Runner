// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin.js — the administration API of the simulator, under `/admin/api/`
 * (#930).
 *
 * Its one caller is the OSCAR server: OSCAR's administrators manage the
 * simulator's accounts from OSCAR's own pages, and the OSCAR server calls
 * these routes with a key both sides know. The simulator holds only the
 * SHA-256 of that key (`SIM_ADMIN_KEY_SHA256`); OSCAR holds the key itself,
 * encrypted. There is no sign-in, session or cookie here.
 *
 * Each request names the OSCAR administrator who asked (`X-Admin-Actor`), and
 * the audit keeps that name. Wrong keys are counted per address: after 10 in
 * 15 minutes, that address gets 429 whatever it sends.
 *
 * An OSDM client never reaches these routes: an OSDM token is not the key,
 * and `admin` cannot be a provider key.
 */

const crypto = require('node:crypto');
const { HttpError, sendJson, readBody, parseJsonObject } = require('./http');
const { AccountError } = require('./accounts');

const KEY_HEADER_PATTERN = /^bearer +(\S{1,512})$/i;
// Printable ASCII, so that an actor name cannot start a line of its own.
const ACTOR = /^[\x21-\x7E][\x20-\x7E]{0,119}$/;
const WINDOW_MS = 15 * 60 * 1000;
const FAILURES_PER_ADDRESS = 10;
const MAX_ACCOUNT_BODY = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found');
const methodNotAllowed = (allowed) => new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', undefined, { Allow: allowed.join(', ') });

function requireMethod(req, ...allowed) {
  if (!allowed.includes(req.method)) throw methodNotAllowed(allowed);
}

// Failures counted in a fixed window, per address; the table cannot grow without end.
function createFailureCounter(limit, now) {
  const MAX_TRACKED = 10000;
  let windowStart = now();
  let counts = new Map();
  const turn = () => {
    if (now() - windowStart >= WINDOW_MS) {
      windowStart = now();
      counts = new Map();
    }
  };
  return {
    blocked(key) {
      turn();
      return (counts.get(key) || 0) >= limit || (!counts.has(key) && counts.size >= MAX_TRACKED);
    },
    fail(key) {
      turn();
      if (counts.has(key) || counts.size < MAX_TRACKED) counts.set(key, (counts.get(key) || 0) + 1);
    },
  };
}

/** Is this the SHA-256 of an administration key, as `SIM_ADMIN_KEY_SHA256` holds it? */
const isKeyDigest = (value) => typeof value === 'string' && SHA256_HEX.test(value);

/**
 * `keySha256`: the hex SHA-256 of the key. `accounts`: the data folder's
 * accounts (accounts.js).
 */
function createAdmin({ keySha256, accounts, now = Date.now }) {
  if (!isKeyDigest(keySha256)) throw new Error('createAdmin needs the SHA-256 of the key, in hex');
  const expected = Buffer.from(keySha256, 'hex');
  const failures = createFailureCounter(FAILURES_PER_ADDRESS, now);

  // The caller, or a refusal. Checked whatever the header holds, in constant time.
  function authenticate(req, address) {
    if (failures.blocked(address)) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many refused keys', 'Wait 15 minutes.', { 'Retry-After': String(WINDOW_MS / 1000) });
    }
    const match = KEY_HEADER_PATTERN.exec(req.headers.authorization || '');
    const same = crypto.timingSafeEqual(digest(match ? match[1] : ''), expected);
    if (!match || !same) {
      failures.fail(address);
      accounts.audit({ by: '?', action: 'admin_key_refused', address });
      throw new HttpError(401, 'ADMIN_KEY_REFUSED', 'The administration key is missing or wrong', undefined, { 'WWW-Authenticate': 'Bearer' });
    }
    const actor = req.headers['x-admin-actor'];
    if (typeof actor !== 'string' || !ACTOR.test(actor)) {
      throw new HttpError(400, 'ADMIN_ACTOR', 'X-Admin-Actor must name the administrator', 'Printable ASCII, 1 to 120 characters.');
    }
    return actor;
  }

  async function jsonBody(req) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const raw = await readBody(req, MAX_ACCOUNT_BODY);
    if (raw.length === 0) return {};
    if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The body must be JSON');
    return parseJsonObject(raw);
  }

  // The change a request asks for, as a function; or the answer of a read.
  async function accountsRoute(req, res, actor, rest) {
    const [provider, clientId, action, ...more] = rest;
    if (more.length) throw notFound();
    if (provider === undefined) {
      requireMethod(req, 'GET');
      sendJson(res, 200, { providers: accounts.list() });
      return 200;
    }
    if (clientId === undefined) {
      requireMethod(req, 'POST');
      const body = await jsonBody(req);
      sendJson(res, 201, accounts.add(provider, { clientId: body.clientId, kind: body.kind }, actor));
      return 201;
    }
    if (action === undefined) {
      requireMethod(req, 'DELETE');
      accounts.remove(provider, clientId, actor);
      sendJson(res, 200, { provider, clientId, deleted: true });
      return 200;
    }
    if (action === 'reset-secret') {
      requireMethod(req, 'POST');
      sendJson(res, 200, accounts.resetSecret(provider, clientId, actor));
      return 200;
    }
    throw notFound();
  }

  /** `/admin/...`: `rest` is the path after `admin`. Returns the status sent. */
  async function handle(req, res, rest, seen, address) {
    const [area, what, ...more] = rest;
    if (area !== 'api') throw notFound();
    const actor = authenticate(req, address);
    seen.client = `admin:${actor}`;
    if (what === 'audit' && more.length === 0) {
      requireMethod(req, 'GET');
      sendJson(res, 200, { entries: accounts.auditTail(200) });
      return 200;
    }
    if (what !== 'accounts') throw notFound();
    try {
      return await accountsRoute(req, res, actor, more);
    } catch (error) {
      if (error instanceof AccountError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  return { handle };
}

module.exports = { createAdmin, isKeyDigest };
