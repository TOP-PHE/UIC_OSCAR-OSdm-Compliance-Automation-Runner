// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * totp.js — one-time codes of an authenticator app (#1414), pure.
 *
 * TOTP is RFC 6238: the HOTP of RFC 4226 (HMAC-SHA1 of a counter, cut to
 * six digits) with the counter = the number of 30-second steps since the
 * Unix epoch. Google and Microsoft Authenticator, 1Password and the like
 * all compute it so, from a secret they receive in base32 (RFC 4648),
 * usually inside an otpauth:// address shown as a QR code (utils/qrCode.js).
 *
 * A code is accepted one step either side of the server's clock (a phone a
 * little fast or slow, a code typed as it changes), and never twice: the
 * caller keeps the last step accepted and passes it back as `lastStep`.
 * Nothing here reads a clock of its own: the time is always given.
 */

const crypto = require('node:crypto');

const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW_STEPS = 1;
const SECRET_BYTES = 20;          // 160 bits, the size RFC 4226 recommends
const ISSUER = 'OSCAR';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 of a Buffer, without '=' padding (authenticator apps take it so). */
function base32Encode(buf) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The bytes of a base32 text, or null when it holds a character outside the
 * alphabet. Case, spaces, dashes and '=' padding are ignored: people copy a
 * key in groups.
 */
function base32Decode(text) {
  if (typeof text !== 'string') return null;
  const clean = text.toUpperCase().replaceAll(/[\s=-]/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A new secret: 20 random bytes. */
function newSecret() {
  return crypto.randomBytes(SECRET_BYTES);
}

/** The HOTP code of `counter` (RFC 4226), as a text of `digits` digits. */
function hotp(secret, counter, digits = DIGITS) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', secret).update(message).digest();
  const offset = mac.at(-1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % (10 ** digits)).padStart(digits, '0');
}

/** The step a time falls in (milliseconds since the epoch). */
function stepAt(timeMs) {
  return Math.floor(timeMs / 1000 / PERIOD_SECONDS);
}

/** The TOTP code at a time (milliseconds since the epoch). */
function totpAt(secret, timeMs, digits = DIGITS) {
  return hotp(secret, stepAt(timeMs), digits);
}

/** The code a person typed, digits only, or null when it cannot be one. */
function cleanCode(code) {
  if (typeof code !== 'string' && typeof code !== 'number') return null;
  const digits = String(code).replaceAll(/\s/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;   // DIGITS
}

function sameCode(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Checks a code at `timeMs`: { ok: true, step } for the step it matched, or
 * { ok: false, reason } with reason 'format' (not six digits), 'replay' (a
 * step at or before `lastStep`) or 'wrong'. Every step of the window is
 * computed and compared, whatever matches first.
 */
function verifyCode(secret, code, timeMs, lastStep = null) {
  const typed = cleanCode(code);
  if (!typed) return { ok: false, reason: 'format' };
  const now = stepAt(timeMs);
  let matched = null;
  for (let step = now - WINDOW_STEPS; step <= now + WINDOW_STEPS; step++) {
    if (sameCode(hotp(secret, step), typed) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, reason: 'wrong' };
  if (Number.isInteger(lastStep) && matched <= lastStep) return { ok: false, reason: 'replay' };
  return { ok: true, step: matched };
}

/**
 * The otpauth:// address an authenticator app reads (Google's "Key Uri
 * Format"): the label is `OSCAR:<account>`, the parameters say the defaults
 * out loud for the apps that do not assume them.
 */
function otpauthUri(secretBase32, account, issuer = ISSUER) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  base32Encode, base32Decode, newSecret, hotp, stepAt, totpAt, cleanCode, verifyCode, otpauthUri,
  PERIOD_SECONDS, DIGITS, WINDOW_STEPS, SECRET_BYTES, ISSUER,
};
