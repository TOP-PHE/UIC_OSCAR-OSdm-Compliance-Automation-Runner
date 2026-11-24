// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The sign-in's lock per e-mail address (#1421), kept in `login_lock` by the
 * SHA-256 of the address (an address without an account is counted too, and
 * the table holds no address). The rules are utils/loginLock.js. Each
 * function reads and writes in one go, with no `await` between: two attempts
 * of one address never count from the same state.
 */

const crypto = require('node:crypto');
const { get, run } = require('../../db/db');
const L = require('../../utils/loginLock');

const PRUNE_EVERY_SECONDS = 60;
let lastPrune = 0;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** The key of an address: the SHA-256 of the address as the sign-in reads it (lower case). */
function keyOf(normalizedEmail) {
  return crypto.createHash('sha256').update(String(normalizedEmail)).digest('hex');
}

function stateOf(key) {
  const row = get('SELECT failures, failures_since, locked_until, lock_level FROM login_lock WHERE email_hash = ?', [key]);
  if (!row) return L.emptyState();
  return {
    failures: Number(row.failures) || 0,
    failuresSince: Number(row.failures_since) || 0,
    lockedUntil: Number(row.locked_until) || 0,
    lockLevel: Number(row.lock_level) || 0,
  };
}

function save(key, state) {
  run(`INSERT INTO login_lock (email_hash, failures, failures_since, locked_until, lock_level, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(email_hash) DO UPDATE SET failures = excluded.failures,
         failures_since = excluded.failures_since, locked_until = excluded.locked_until,
         lock_level = excluded.lock_level, expires_at = excluded.expires_at`,
  [key, state.failures, state.failuresSince, state.lockedUntil, state.lockLevel, L.expiresAt(state)]);
}

/** Removes the states that no longer matter, at most once a minute. */
function pruneIfDue(now) {
  if (now - lastPrune < PRUNE_EVERY_SECONDS) return;
  lastPrune = now;
  run('DELETE FROM login_lock WHERE expires_at < ?', [now]);
}

/**
 * An attempt of the sign-in starts for `normalizedEmail`: answers the seconds
 * to wait when the address is locked (nothing is counted then), else 0, and
 * the attempt is counted until `finishAttempt()` says how it went.
 */
function beginAttempt(normalizedEmail, now = nowSeconds()) {
  pruneIfDue(now);
  const key = keyOf(normalizedEmail);
  const { refused, state } = L.begin(stateOf(key), now);
  if (!refused) save(key, state);
  return refused;
}

/**
 * The attempt ended, its password right (`ok`) or not: answers the length of
 * the lock this attempt started (seconds), else 0.
 */
function finishAttempt(normalizedEmail, ok, now = nowSeconds()) {
  const key = keyOf(normalizedEmail);
  const { lockedNow, state } = L.finish(stateOf(key), now, ok);
  save(key, state);
  return lockedNow;
}

/** A password reset was carried through: the address's lock and series go. */
function clearLock(normalizedEmail) {
  run('DELETE FROM login_lock WHERE email_hash = ?', [keyOf(normalizedEmail)]);
}

/** The 429 answer of a locked address: the same for every address. */
function lockedAnswer(res, seconds) {
  res.set('Retry-After', String(Math.max(1, Math.ceil(seconds))));
  return res.status(429).json({
    status: 429,
    title: 'Too Many Requests',
    detail: `Too many wrong passwords for this address. Sign-in is paused for ${L.durationText(seconds)}; a password reset lifts the pause.`,
  });
}

/** For the tests: the next prune runs at once. */
function _resetPrune() { lastPrune = 0; }

module.exports = { keyOf, beginAttempt, finishAttempt, clearLock, lockedAnswer, _resetPrune };
