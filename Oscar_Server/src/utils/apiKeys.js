// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * apiKeys.js — the shape of an OSCAR API key (#503), pure.
 *
 * A key reads one company's or provider's results and nothing else. It is
 * `oscar_<prefix>_<secret>`: the prefix (8 lowercase hex characters) finds
 * the stored row and is shown on the page; the secret (32 random bytes,
 * base64url) is shown once and only its sha256 is stored. The recognisable
 * `oscar_` start lets secret scanners find a key that was published by
 * mistake.
 */

const crypto = require('node:crypto');

const PREFIX_BYTES = 4;
const SECRET_BYTES = 32;
const KEY_PATTERN = /^oscar_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

const SCOPES = Object.freeze(['runs:read']);
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const MAX_NAME = 80;

function hashOf(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

/** A new key: { key, prefix, secretHash }. `key` is shown once and never stored. */
function newKey() {
  const prefix = crypto.randomBytes(PREFIX_BYTES).toString('hex');
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { key: `oscar_${prefix}_${secret}`, prefix, secretHash: hashOf(secret) };
}

/** Looks like an OSCAR key (not a session token), whether valid or not. */
function looksLikeKey(token) {
  return typeof token === 'string' && token.startsWith('oscar_');
}

/** { prefix, secret } of a well-formed key, else null. */
function parseKey(token) {
  if (typeof token !== 'string') return null;
  const m = KEY_PATTERN.exec(token);
  return m ? { prefix: m[1], secret: m[2] } : null;
}

/** Does `secret` match the stored hash? Constant time. */
function secretMatches(secret, storedHash) {
  if (typeof storedHash !== 'string' || !/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashOf(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return crypto.timingSafeEqual(a, b);
}

/** The key's lifetime in days: { days } or { error }. Absent = the default. */
function lifetimeOf(value) {
  if (value === undefined || value === null || value === '') return { days: DEFAULT_DAYS };
  const readable = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  const days = readable ? Number(value) : Number.NaN;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return { error: `expires_in_days must be a whole number of days from 1 to ${MAX_DAYS}.` };
  }
  return { days };
}

/** The key's name: { name } or { error }. */
function nameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { error: 'A key needs a name, to tell it from the others.' };
  if (name.length > MAX_NAME) return { error: `A key's name has at most ${MAX_NAME} characters.` };
  return { name };
}

/** SQLite datetime text (UTC, 'YYYY-MM-DD HH:MM:SS'), `days` after `now`. */
function expiryAfter(days, now = new Date()) {
  return new Date(now.getTime() + days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
}

/** Is a stored row usable at `now`? 'revoked', 'expired' or null (usable). */
function unusableBecause(row, now = new Date()) {
  if (!row) return 'unknown';
  if (row.revoked_at) return 'revoked';
  const expires = Date.parse(String(row.expires_at || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(expires) || expires <= now.getTime()) return 'expired';
  return null;
}

module.exports = {
  SCOPES, DEFAULT_DAYS, MAX_DAYS, MAX_NAME,
  hashOf, newKey, looksLikeKey, parseKey, secretMatches,
  lifetimeOf, nameOf, expiryAfter, unusableBecause,
};
