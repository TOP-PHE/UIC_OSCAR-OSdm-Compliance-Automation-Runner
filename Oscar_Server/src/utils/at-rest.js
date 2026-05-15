// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * at-rest.js — application-level at-rest encryption for files and large
 * blobs. Used by Phase 2 of issue #60 to make sensitive content on disk
 * (artifact HTML/JSON, company datafiles) unreadable to anyone with raw
 * filesystem access — even an SSH-equipped sysadmin running `cat` on the
 * file. Plaintext is recoverable only inside the OSCAR process, which holds
 * the ENCRYPTION_KEY in memory.
 *
 * Format (single-shot AES-256-GCM, file-as-a-whole):
 *
 *   ┌────────┬─────┬─────┬───────────────────────┐
 *   │ MAGIC  │ IV  │ TAG │   ciphertext...       │
 *   │ 6 byte │ 12  │ 16  │   variable            │
 *   └────────┴─────┴─────┴───────────────────────┘
 *      "OSCAR1"             AES-256-GCM output
 *
 * The 6-byte MAGIC ("OSCAR1") doubles as a version + a backward-compat
 * marker: if a file's first 6 bytes are not "OSCAR1", decryptBuffer()
 * treats the input as a legacy plaintext file and returns it unchanged.
 * This lets the v1.11 release land WITHOUT a forced migration of existing
 * artifacts — old reports remain readable; only new writes are encrypted.
 * A v19 migration optionally re-encrypts in place.
 *
 * Implementation note — why one-shot, not streaming:
 *   AES-GCM authenticates the whole ciphertext via a tag emitted at the
 *   end of encryption. To verify a streamed read, the receiver must
 *   buffer the entire payload before trusting any byte. OSCAR's
 *   artifacts are bounded (HTML reports < 1 MB, datafiles < 5 MB) so
 *   buffering the whole file is safe and the code stays simple.
 */

const crypto = require('crypto');
const fs     = require('fs');

const ALGO   = 'aes-256-gcm';
const MAGIC  = Buffer.from('OSCAR1', 'utf8');   // 6 bytes — file format marker
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN + TAG_LEN;   // = 34

/**
 * Resolve the AES key from ENCRYPTION_KEY env var (64-char hex = 32 bytes).
 * Throws if missing or wrong length — fails fast at boot rather than at
 * first encrypt/decrypt call.
 */
function _key() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * True if the buffer carries OSCAR's at-rest envelope (magic + IV + tag).
 * Used to distinguish legacy plaintext files from encrypted ones during
 * the transition window AND after, since the v19 migration is optional.
 */
function isEncryptedBuffer(buf) {
  return Buffer.isBuffer(buf)
      && buf.length >= HEADER_LEN
      && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Encrypt a Buffer (or anything Buffer.from() accepts). Returns a Buffer
 * with the OSCAR1 envelope prepended.
 */
function encryptBuffer(plaintext) {
  if (plaintext == null) return null;
  const buf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const key = _key();
  const iv  = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

/**
 * Decrypt a Buffer that was produced by encryptBuffer(). If the buffer has
 * no OSCAR1 magic header, returns it unchanged — this is the "legacy
 * plaintext" path that lets us deploy v1.11 without forcing every artifact
 * to be re-encrypted up front. A v19 migration handles the backfill.
 *
 * Throws on tampering: AES-GCM auth-tag failure surfaces as an exception,
 * never silently. Callers should treat that as a security alert.
 */
function decryptBuffer(buf) {
  if (buf == null) return null;
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (!isEncryptedBuffer(buf)) return buf;       // legacy plaintext fall-through
  const iv         = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag        = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(HEADER_LEN);
  const key = _key();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Generate an unguessable temp-file suffix. CodeQL js/insecure-temporary-file
 * objects to predictable patterns like pid+Date.now() because a co-located
 * attacker could pre-create the file as a symlink to /etc/shadow and wait
 * for our writer to overwrite it. crypto.randomBytes makes that race
 * impossible — 16 random bytes = 2^128 possible suffixes.
 */
function _tmpSuffix() {
  return '.tmp.' + crypto.randomBytes(16).toString('hex');
}

/**
 * Convenience: encrypt a Buffer/string and write it to a file. Atomic via
 * temp+rename so a crash mid-write leaves the previous version intact
 * (matters for the datafile path which is read by Bruno during runs).
 *
 * dstPath must be an absolute path under one of OSCAR's writable
 * directories (data/artifacts, data/datafiles). Caller is responsible
 * for that — we don't re-validate here because the helper is called
 * from many sites with their own scoping logic; adding a global allow-
 * list would be brittle.
 */
function encryptToFile(plaintext, dstPath) {
  const enc = encryptBuffer(plaintext);
  const tmp = dstPath + _tmpSuffix();
  fs.writeFileSync(tmp, enc, { mode: 0o640 });
  fs.renameSync(tmp, dstPath);
}

/**
 * Convenience: read a file written by encryptToFile() (or a legacy
 * plaintext file pre-v1.11) and return the decrypted Buffer.
 */
function decryptFromFile(srcPath) {
  const buf = fs.readFileSync(srcPath);
  return decryptBuffer(buf);
}

/**
 * Async variant of encryptToFile. Same atomic temp+rename guarantee.
 * Preferred from inside async code paths (runner.js does parallel writes
 * for multi-scenario runs — sync I/O would serialize them on the event loop).
 */
async function encryptToFileAsync(plaintext, dstPath) {
  const enc = encryptBuffer(plaintext);
  const tmp = dstPath + _tmpSuffix();
  await fs.promises.writeFile(tmp, enc, { mode: 0o640 });
  await fs.promises.rename(tmp, dstPath);
}

/** Async variant of decryptFromFile. */
async function decryptFromFileAsync(srcPath) {
  const buf = await fs.promises.readFile(srcPath);
  return decryptBuffer(buf);
}

/**
 * Encrypt a source file to a destination path. Reads src in one shot,
 * writes dst encrypted. Used by runner.js to copy+encrypt artifacts in
 * a single step.
 */
async function copyAndEncryptFileAsync(srcPath, dstPath) {
  const plaintext = await fs.promises.readFile(srcPath);
  await encryptToFileAsync(plaintext, dstPath);
}

module.exports = {
  encryptBuffer,
  decryptBuffer,
  encryptToFile,
  decryptFromFile,
  encryptToFileAsync,
  decryptFromFileAsync,
  copyAndEncryptFileAsync,
  isEncryptedBuffer,
  HEADER_LEN,   // exported for tests
  MAGIC,        // exported for tests
};
