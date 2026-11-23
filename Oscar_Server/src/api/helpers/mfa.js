// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mfa.js — the second factor of an account (#1414).
 *
 * Maintainer's decisions (2026-11-23): required for administrators, offered
 * to every other account; a code of an authenticator app (utils/totp.js);
 * no recovery codes: another administrator resets it, and a command on the
 * server does it for the last one (src/cli/reset-mfa.js).
 *
 * After a right password the sign-in answers a challenge instead of a
 * session when the account has a factor ('verify') or must set one up
 * ('setup'). The challenge is a short JWT signed with a key derived from the
 * session secret, under an audience of its own: it never passes for a
 * session, nor a session for it. A session that went through the factor
 * says so (`mfa: true`); sessionUser() refuses one that does not, for an
 * account whose factor is on.
 *
 * The secret is kept encrypted, never answered again after the set-up. A
 * code is accepted once (the last step is kept). Ten wrong codes in fifteen
 * minutes stop the account's codes until the window ends, whatever address
 * they come from; the routes add a limit per address.
 */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { get, run, encrypt, decrypt } = require('../../db/db');
const { END_SESSIONS_SQL } = require('../middleware/auth');
const T = require('../../utils/totp');
const { qrDataUrl } = require('../../utils/qrCode');
const { REMOVE_FACTOR_SQL } = require('../../utils/mfaReset');

const REQUIRED_ROLES = new Set(['administrator']);
const MAX_FAILURES = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;
const CHALLENGE_SECONDS = Object.freeze({ verify: 5 * 60, setup: 10 * 60 });
const CHALLENGE_AUDIENCE = 'oscar-mfa';
const MAX_CHALLENGE_LENGTH = 2048;

const USER_SQL = 'SELECT * FROM users WHERE id = ?';

/** True for a role that must have a second factor. */
function isRequired(role) {
  return REQUIRED_ROLES.has(role);
}

/** True when the account's second factor is on. */
function isOn(row) {
  return Boolean(row?.mfa_enabled_at && row.mfa_secret_enc);
}

/** What the sign-in asks after a right password: 'verify', 'setup' or null (a session). */
function stepAfterPassword(row, role) {
  if (isOn(row)) return 'verify';
  if (isRequired(role)) return 'setup';
  return null;
}

/** What a page shows of an account's factor. */
function stateOf(row, role) {
  return { enabled: isOn(row), required: isRequired(role), enabled_at: isOn(row) ? row.mfa_enabled_at : null };
}

function challengeKey() {
  return crypto.createHmac('sha256', String(process.env.JWT_SECRET || '')).update('oscar-mfa-challenge-v1').digest();
}

/** A challenge for the next step of a sign-in: 'verify' or 'setup'. */
function signChallenge(userId, purpose) {
  return jwt.sign({ sub: userId, purpose, jti: crypto.randomUUID() }, challengeKey(),
    { algorithm: 'HS256', audience: CHALLENGE_AUDIENCE, expiresIn: CHALLENGE_SECONDS[purpose] });
}

/**
 * The account a challenge stands for, read now, or null: a challenge that is
 * malformed, expired, for another step, of an account gone or not active, or
 * signed before the account's sessions were ended.
 */
function readChallenge(token, purpose) {
  if (typeof token !== 'string' || token.length > MAX_CHALLENGE_LENGTH) return null;
  let payload;
  try {
    payload = jwt.verify(token, challengeKey(), { algorithms: ['HS256'], audience: CHALLENGE_AUDIENCE });
  } catch {
    return null;
  }
  if (payload.purpose !== purpose || typeof payload.sub !== 'string') return null;
  const row = get(USER_SQL, [payload.sub]);
  if (row?.status !== 'active') return null;
  const validAfter = Number(row.sessions_valid_after) || 0;
  if (validAfter && !(Number(payload.iat) >= validAfter)) return null;
  return row;
}

/** Seconds until the account's codes are taken again, or 0. */
function lockedFor(row, nowSeconds) {
  const since = Number(row.mfa_failures_since) || 0;
  const failures = Number(row.mfa_failures) || 0;
  if (failures < MAX_FAILURES || nowSeconds - since >= FAILURE_WINDOW_SECONDS) return 0;
  return since + FAILURE_WINDOW_SECONDS - nowSeconds;
}

function noteFailure(row, nowSeconds) {
  const since = Number(row.mfa_failures_since) || 0;
  if (!since || nowSeconds - since >= FAILURE_WINDOW_SECONDS) {
    run('UPDATE users SET mfa_failures = 1, mfa_failures_since = ? WHERE id = ?', [nowSeconds, row.id]);
  } else {
    run('UPDATE users SET mfa_failures = mfa_failures + 1 WHERE id = ?', [row.id]);
  }
}

/**
 * Checks a code against a secret kept in `column`: { ok: true, step } or
 * { ok: false, reason } with reason 'locked' (and retryAfter, seconds),
 * 'format', 'wrong' or 'replay'. A wrong or replayed code counts against
 * the account; a code that is not six digits does not.
 */
function checkAgainst(row, column, code, nowMs, lastStep) {
  const nowSeconds = Math.floor(nowMs / 1000);
  const wait = lockedFor(row, nowSeconds);
  if (wait > 0) return { ok: false, reason: 'locked', retryAfter: wait };
  const secret = T.base32Decode(decrypt(row[column]) || '');
  const result = T.verifyCode(secret, code, nowMs, lastStep);
  if (!result.ok && result.reason !== 'format') noteFailure(row, nowSeconds);
  return result;
}

/** A code of the account's factor, at a sign-in or to turn the factor off. */
function checkCode(userId, code, nowMs = Date.now()) {
  const row = get(USER_SQL, [userId]);   // read now: two requests never accept one code twice
  if (!isOn(row)) return { ok: false, reason: 'off' };
  const last = Number.isInteger(row.mfa_last_step) ? row.mfa_last_step : null;
  const result = checkAgainst(row, 'mfa_secret_enc', code, nowMs, last);
  if (result.ok) {
    run('UPDATE users SET mfa_last_step = ?, mfa_failures = 0, mfa_failures_since = NULL WHERE id = ?', [result.step, userId]);
  }
  return result;
}

/**
 * Starts setting up a factor: a new secret kept pending (encrypted) until a
 * first code proves the app holds it. Answers { secret, otpauth_uri, qr },
 * the QR code as an SVG data: URL; the only time the secret is answered.
 */
function startSetup(row) {
  const secret = T.base32Encode(T.newSecret());
  run('UPDATE users SET mfa_pending_enc = ? WHERE id = ?', [encrypt(secret), row.id]);
  const uri = T.otpauthUri(secret, row.email);
  return { secret, otpauth_uri: uri, qr: qrDataUrl(uri) };
}

/**
 * Turns the factor on with a first code of the pending secret: { ok, step }
 * or { ok: false, reason } ('none' when nothing is being set up). Every
 * session of the account ends: the caller hands out the new one.
 */
function confirmSetup(userId, code, nowMs = Date.now()) {
  const row = get(USER_SQL, [userId]);
  if (!row?.mfa_pending_enc) return { ok: false, reason: 'none' };
  const result = checkAgainst(row, 'mfa_pending_enc', code, nowMs, null);
  if (!result.ok) return result;
  run(`UPDATE users SET mfa_secret_enc = mfa_pending_enc, mfa_pending_enc = NULL,
         mfa_enabled_at = datetime('now'), mfa_last_step = ?, mfa_failures = 0, mfa_failures_since = NULL,
         ${END_SESSIONS_SQL} WHERE id = ?`, [result.step, userId]);
  return result;
}

/** Removes the factor (or the one being set up); every session of the account ends. */
function removeFactor(userId) {
  run(REMOVE_FACTOR_SQL, [userId]);
}

/** The refusal of a code, as a route answers it: [status, detail, headers]. */
function refusalOf(result) {
  if (result.reason === 'locked') {
    return [429, 'Too many wrong codes. Wait a few minutes before trying again.', { 'Retry-After': String(result.retryAfter) }];
  }
  if (result.reason === 'format') return [400, 'The code is the six digits your authenticator app shows.', {}];
  if (result.reason === 'none') return [409, 'Nothing is being set up: start again.', {}];
  return [403, 'That code is not right. Type the code your authenticator app shows now.', {}];
}

module.exports = {
  isRequired, isOn, stepAfterPassword, stateOf, signChallenge, readChallenge,
  checkCode, startSetup, confirmSetup, removeFactor, refusalOf,
  MAX_FAILURES, FAILURE_WINDOW_SECONDS, CHALLENGE_SECONDS, REQUIRED_ROLES,
};
