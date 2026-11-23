// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * sessions.js — handing out a session (moved out of routes/auth.js, #1414).
 *
 * The sign-in, the second factor's steps and the page where an account turns
 * its own factor on or off all end with a new session: the JWT (HS256, 8
 * hours, a jti for the revocation list), the httpOnly cookie, and the line of
 * the authentication log. A session that went through the second factor says
 * so (`mfa: true`): sessionUser() refuses one without it for an account whose
 * factor is on.
 */

const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { get, run } = require('../../db/db');
const { normalizeRole } = require('../middleware/auth');
const { loginAttempts } = require('../../utils/metrics');

const JWT_EXPIRY     = '8h';
const JWT_EXPIRY_SEC = 8 * 60 * 60;   // same as JWT_EXPIRY in seconds

function signToken(user, company, { mfa = false } = {}) {
  const role = normalizeRole(user.role);
  const claims = { sub: user.id, email: user.email, companyId: company.id, role, jti: randomUUID() };
  if (mfa) claims.mfa = true;
  return jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// Sets an httpOnly, Secure, SameSite=Strict cookie named oscar_session with
// the JWT so the token never touches JavaScript-accessible storage.
// The token is also in the JSON body so CLI / API clients that rely on
// Bearer tokens continue to work.
function setSessionCookie(res, token) {
  res.cookie('oscar_session', token, {
    httpOnly: true,
    // Only enforce Secure in production. On dev/local-testing we run on
    // plain http://localhost and browsers reject Secure cookies on http.
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge:   JWT_EXPIRY_SEC * 1000,
    path:     '/',
  });
}

function authClientMeta(req) {
  return {
    // req.ip: the address the trusted proxy saw (trust proxy), never the
    // leftmost X-Forwarded-For entry, which the client writes.
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: (req.headers['user-agent'] || '').toString() || null
  };
}

function logAuthEvent({ userId = null, companyId = null, email = null, eventType, ip = null, userAgent = null }) {
  run(`INSERT INTO auth_events (user_id, company_id, email, event_type, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, companyId, email, eventType, ip, userAgent]);
}

/** Logs an authentication event of `user` for this request. */
function logUserEvent(req, user, eventType) {
  const meta = authClientMeta(req);
  logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType, ip: meta.ip, userAgent: meta.userAgent });
}

/**
 * A new session for `user` (a users row): the cookie is set and the answer's
 * body returned, { token, user, company }. `signIn` counts it as a sign-in
 * (the metric); an account turning its own factor on or off gets a session
 * of its own without one.
 */
function issueSession(req, res, user, { mfa = false, eventType = 'login_success', signIn = true } = {}) {
  const company = get('SELECT * FROM companies WHERE id = ?', [user.company_id]);
  const token = signToken(user, company, { mfa });
  logUserEvent(req, user, eventType);
  if (signIn) loginAttempts.inc({ result: 'success' });
  setSessionCookie(res, token);
  return {
    token,
    user:    { id: user.id, email: user.email, role: normalizeRole(user.role) },
    company: { id: company.id, name: company.name, slug: company.slug },
  };
}

module.exports = {
  signToken, setSessionCookie, authClientMeta, logAuthEvent, logUserEvent, issueSession,
  JWT_EXPIRY, JWT_EXPIRY_SEC,
};
