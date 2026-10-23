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
 * An administrator is a name and a password in `<data>/admins.json`, written
 * on the host by `scripts/make-admin.js`; nothing over HTTP creates one. The
 * file is read at each login, so a new administrator or password needs no
 * restart. Passwords are kept as scrypt digests.
 *
 * A login gives a session cookie (`__Host-sim_admin`: HttpOnly, Secure,
 * SameSite=Strict, kept in memory only, so a restart signs everyone out) and a
 * CSRF token. Every request but the login and the reads needs the token in
 * `X-CSRF-Token`; a request from another origin is refused. Failed logins are
 * counted per address and per name.
 *
 * An OSDM client never reaches these routes: they take no Bearer token, and
 * `admin` cannot be a provider key.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { HttpError, sendJson, readBody, parseJsonObject } = require('./http');
const { AccountError } = require('./accounts');

const scrypt = promisify(crypto.scrypt);

const ADMINS_FILE = 'admins.json';
const ADMIN_NAME = /^[A-Za-z][A-Za-z0-9._-]{1,31}$/;
const COOKIE = '__Host-sim_admin';
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 50;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const FAILURES_PER_ADDRESS = 10;
const FAILURES_PER_NAME = 20;
const MAX_LOGIN_BODY = 4096;
const MAX_ACCOUNT_BODY = 1024;
// The memory of a hash costs 128 · N · r bytes: 16 MB here.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** The stored form of a password: `scrypt:N:r:p:<salt>:<digest>`, base64. */
async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join(':');
}

// A stored form this module wrote; anything else never matches.
function parseHash(stored) {
  const parts = typeof stored === 'string' ? stored.split(':') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const key = Buffer.from(parts[5], 'base64');
  if (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p || salt.length < 16 || key.length !== SCRYPT.keylen) return null;
  return { salt, key };
}

// A digest the unknown names are checked against, so that an unknown name
// and a wrong password take the same time.
let decoy;
async function decoyHash() {
  decoy ||= parseHash(await hashPassword(crypto.randomBytes(24).toString('base64url')));
  return decoy;
}

async function passwordMatches(stored, password) {
  const parsed = parseHash(stored);
  const target = parsed || await decoyHash();
  const given = await scrypt(typeof password === 'string' ? password : '', target.salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(given, target.key) && parsed !== null;
}

/** The administrators of a data folder: name → stored password. Missing file = none. */
function readAdmins(dataDir) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, ADMINS_FILE), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const admins = new Map();
  for (const entry of Array.isArray(raw?.admins) ? raw.admins : []) {
    if (entry && typeof entry.name === 'string' && ADMIN_NAME.test(entry.name) && parseHash(entry.password)) {
      admins.set(entry.name, entry.password);
    }
  }
  return admins;
}

// Failures counted in a fixed window, per key; the table cannot grow without end.
function createFailureCounter(limit, now) {
  const MAX_TRACKED = 10000;
  let windowStart = now();
  let counts = new Map();
  const turn = () => {
    if (now() - windowStart >= LOGIN_WINDOW_MS) {
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
    clear(key) { counts.delete(key); },
  };
}

function cookieOf(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim();
  }
  return '';
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const unauthorised = () => new HttpError(401, 'NOT_SIGNED_IN', 'Sign in first');
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Not found');
const methodNotAllowed = (allowed) => new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', undefined, { Allow: allowed.join(', ') });

function requireMethod(req, ...allowed) {
  if (!allowed.includes(req.method)) throw methodNotAllowed(allowed);
}

function createAdmin({ dataDir, accounts, now = Date.now }) {
  const sessions = new Map();
  const byAddress = createFailureCounter(FAILURES_PER_ADDRESS, now);
  const byName = createFailureCounter(FAILURES_PER_NAME, now);

  function sessionOf(req) {
    const id = cookieOf(req);
    const session = id ? sessions.get(id) : undefined;
    if (!session) return null;
    const t = now();
    if (t - session.lastSeen > SESSION_IDLE_MS || t - session.created > SESSION_MAX_MS) {
      sessions.delete(id);
      return null;
    }
    // An administrator removed from the file since the login is signed out.
    if (!readAdmins(dataDir).has(session.name)) {
      sessions.delete(id);
      return null;
    }
    session.lastSeen = t;
    return { id, ...session };
  }

  // A request that changes something: from this origin, with the session's token.
  function checkChange(req, session) {
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let host;
      try { host = new URL(origin).host; } catch { host = null; }
      if (host === null || host !== req.headers.host) throw new HttpError(403, 'FOREIGN_ORIGIN', 'The request comes from another site');
    }
    if (!sameText(req.headers['x-csrf-token'] || '', session.csrf)) {
      throw new HttpError(403, 'CSRF_TOKEN', 'The request does not carry this session\'s token');
    }
  }

  async function jsonBody(req, limit) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const raw = await readBody(req, limit);
    if (raw.length === 0) return {};
    if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'The body must be JSON');
    return parseJsonObject(raw);
  }

  async function login(req, res, address) {
    requireMethod(req, 'POST');
    const { name, password } = await jsonBody(req, MAX_LOGIN_BODY);
    const nameKey = typeof name === 'string' ? name.slice(0, 64) : '';
    if (byAddress.blocked(address) || byName.blocked(nameKey)) {
      throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed sign-ins', 'Wait 15 minutes.', { 'Retry-After': String(LOGIN_WINDOW_MS / 1000) });
    }
    const stored = typeof name === 'string' ? readAdmins(dataDir).get(name) : undefined;
    if (!(await passwordMatches(stored, password))) {
      byAddress.fail(address);
      byName.fail(nameKey);
      accounts.audit({ by: nameKey || '?', action: 'sign_in_refused', address });
      throw new HttpError(401, 'SIGN_IN_REFUSED', 'Wrong name or password');
    }
    byAddress.clear(address);
    byName.clear(nameKey);
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    const t = now();
    sessions.set(id, { name, csrf, created: t, lastSeen: t });
    accounts.audit({ by: name, action: 'signed_in', address });
    sendJson(res, 200, { name, csrfToken: csrf }, {
      'Set-Cookie': `${COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`,
    });
    return name;
  }

  function accountsRoute(req, res, session, rest) {
    const [provider, clientId, action, ...more] = rest;
    if (more.length) throw notFound();
    if (provider === undefined) {
      requireMethod(req, 'GET');
      sendJson(res, 200, { providers: accounts.list() });
      return null;
    }
    if (clientId === undefined) {
      requireMethod(req, 'POST');
      return { change: async () => {
        const body = await jsonBody(req, MAX_ACCOUNT_BODY);
        sendJson(res, 201, accounts.add(provider, { clientId: body.clientId, kind: body.kind }, session.name));
      } };
    }
    if (action === undefined) {
      requireMethod(req, 'DELETE');
      return { change: async () => {
        accounts.remove(provider, clientId, session.name);
        sendJson(res, 200, { provider, clientId, deleted: true });
      } };
    }
    if (action === 'reset-secret') {
      requireMethod(req, 'POST');
      return { change: async () => sendJson(res, 200, accounts.resetSecret(provider, clientId, session.name)) };
    }
    throw notFound();
  }

  /** `/admin/...`: `rest` is the path after `admin`. Returns the status sent. */
  async function handle(req, res, rest, seen, address) {
    const [area, what, ...more] = rest;
    if (area !== 'api') throw notFound();
    if (what === 'login' && more.length === 0) {
      seen.client = `admin:${await login(req, res, address)}`;
      return 200;
    }
    const session = sessionOf(req);
    if (!session) throw unauthorised();
    seen.client = `admin:${session.name}`;
    if (what === 'session' && more.length === 0) {
      requireMethod(req, 'GET');
      sendJson(res, 200, { name: session.name, csrfToken: session.csrf });
      return 200;
    }
    if (what === 'logout' && more.length === 0) {
      requireMethod(req, 'POST');
      checkChange(req, session);
      sessions.delete(session.id);
      accounts.audit({ by: session.name, action: 'signed_out' });
      sendJson(res, 200, { signedOut: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      return 200;
    }
    if (what === 'audit' && more.length === 0) {
      requireMethod(req, 'GET');
      sendJson(res, 200, { entries: accounts.auditTail(200) });
      return 200;
    }
    if (what === 'accounts') {
      const route = accountsRoute(req, res, session, more);
      if (route === null) return 200;
      checkChange(req, session);
      try {
        await route.change();
      } catch (error) {
        if (error instanceof AccountError) throw new HttpError(error.status, error.code, error.message);
        throw error;
      }
      return res.statusCode;
    }
    throw notFound();
  }

  return { handle };
}

module.exports = { createAdmin, hashPassword, passwordMatches, readAdmins, ADMINS_FILE, ADMIN_NAME, COOKIE };
