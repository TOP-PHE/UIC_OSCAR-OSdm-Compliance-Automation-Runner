// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * at-rest.test.js — unit tests for the file/buffer at-rest encryption
 * helper introduced in v1.11.0 (Phase 2 of issue #60).
 *
 * Coverage targets:
 *   - encryptBuffer / decryptBuffer round-trip on edge sizes
 *   - OSCAR1 magic-header detection
 *   - Legacy plaintext fall-through (v1.11 deploy doesn't break existing
 *     unencrypted artifacts)
 *   - File I/O: encryptToFile + decryptFromFile (sync + async variants)
 *   - Tampering rejection (auth-tag failure)
 *   - Corruption / truncation handling
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const at   = require('../../src/utils/at-rest');

const TMP = (name) => path.join(os.tmpdir(), `oscar-at-rest-test-${process.pid}-${name}`);

afterAll(() => {
  // Best-effort cleanup of any test artifacts that survived
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(`oscar-at-rest-test-${process.pid}-`)) {
      try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (_) { /* ignore */ }
    }
  }
});

describe('encryptBuffer / decryptBuffer — round-trip', () => {
  test('empty Buffer round-trips', () => {
    const enc = at.encryptBuffer(Buffer.alloc(0));
    expect(enc.length).toBe(at.HEADER_LEN);   // header only, no ciphertext
    expect(at.decryptBuffer(enc)).toEqual(Buffer.alloc(0));
  });
  test('1-byte payload round-trips', () => {
    const enc = at.encryptBuffer(Buffer.from([0x42]));
    expect(at.decryptBuffer(enc)).toEqual(Buffer.from([0x42]));
  });
  test('typical HTML report payload round-trips', () => {
    const html = Buffer.from('<html><body>Hello vendor.</body></html>');
    expect(at.decryptBuffer(at.encryptBuffer(html))).toEqual(html);
  });
  test('1 MB random payload round-trips', () => {
    const buf = require('crypto').randomBytes(1024 * 1024);
    expect(at.decryptBuffer(at.encryptBuffer(buf))).toEqual(buf);
  });
  test('Unicode text round-trips losslessly', () => {
    const s = 'Héllo — wörld 中文 🚂';
    expect(at.decryptBuffer(at.encryptBuffer(s)).toString('utf8')).toBe(s);
  });
  test('two encryptions of same plaintext produce different ciphertexts (random IV)', () => {
    const p = Buffer.from('same input');
    const a = at.encryptBuffer(p);
    const b = at.encryptBuffer(p);
    expect(a.equals(b)).toBe(false);
    expect(at.decryptBuffer(a)).toEqual(at.decryptBuffer(b));
  });
});

describe('OSCAR1 envelope detection', () => {
  test('encryptBuffer output starts with OSCAR1 magic', () => {
    const enc = at.encryptBuffer('x');
    expect(enc.subarray(0, at.MAGIC.length).toString('utf8')).toBe('OSCAR1');
  });
  test('isEncryptedBuffer recognises encrypted output', () => {
    expect(at.isEncryptedBuffer(at.encryptBuffer('x'))).toBe(true);
  });
  test('isEncryptedBuffer rejects raw plaintext', () => {
    expect(at.isEncryptedBuffer(Buffer.from('plaintext'))).toBe(false);
  });
  test('isEncryptedBuffer rejects buffer too short for envelope', () => {
    expect(at.isEncryptedBuffer(Buffer.alloc(5))).toBe(false);
  });
  test('isEncryptedBuffer rejects non-Buffer', () => {
    expect(at.isEncryptedBuffer('OSCAR1abcdef')).toBe(false);
  });
});

describe('decryptBuffer — legacy plaintext fall-through', () => {
  test('returns plaintext input unchanged when no MAGIC header', () => {
    const plain = Buffer.from('legacy unencrypted file content');
    expect(at.decryptBuffer(plain)).toEqual(plain);
  });
  test('null in → null out', () => {
    expect(at.decryptBuffer(null)).toBeNull();
  });
  test('returns short non-magic buffer unchanged', () => {
    expect(at.decryptBuffer(Buffer.from('hi'))).toEqual(Buffer.from('hi'));
  });
});

describe('decryptBuffer — tampering / corruption rejection', () => {
  test('throws on flipped ciphertext byte (auth-tag failure)', () => {
    const enc = Buffer.from(at.encryptBuffer('important payload'));
    // Flip a byte in the ciphertext (after header)
    enc[at.HEADER_LEN + 0] ^= 0xff;
    expect(() => at.decryptBuffer(enc)).toThrow();
  });
  test('throws on corrupted auth tag', () => {
    const enc = Buffer.from(at.encryptBuffer('important payload'));
    // Tag lives at offset MAGIC.length + 12 .. + 28
    enc[at.MAGIC.length + 12] ^= 0xff;
    expect(() => at.decryptBuffer(enc)).toThrow();
  });
});

describe('encryptToFile / decryptFromFile (sync)', () => {
  test('write then read preserves content', () => {
    const f = TMP('sync.bin');
    at.encryptToFile(Buffer.from('sync test'), f);
    expect(at.decryptFromFile(f).toString('utf8')).toBe('sync test');
  });
  test('on-disk file starts with OSCAR1 magic, not the plaintext', () => {
    const f = TMP('sync2.bin');
    at.encryptToFile('private vendor secret', f);
    const onDisk = fs.readFileSync(f);
    expect(onDisk.subarray(0, 6).toString('utf8')).toBe('OSCAR1');
    expect(onDisk.toString('utf8')).not.toContain('private vendor secret');
  });
  test('decryptFromFile passes through legacy plaintext file unchanged', () => {
    const f = TMP('legacy.bin');
    fs.writeFileSync(f, 'old plaintext file');
    expect(at.decryptFromFile(f).toString('utf8')).toBe('old plaintext file');
  });
});

describe('encryptToFileAsync / decryptFromFileAsync', () => {
  test('async round-trip', async () => {
    const f = TMP('async.bin');
    await at.encryptToFileAsync(Buffer.from('async test'), f);
    const out = await at.decryptFromFileAsync(f);
    expect(out.toString('utf8')).toBe('async test');
  });
  test('atomic temp+rename leaves no .tmp.* turds on success', async () => {
    const f = TMP('async-atomic.bin');
    await at.encryptToFileAsync(Buffer.from('x'), f);
    const dir = path.dirname(f);
    const stragglers = fs.readdirSync(dir).filter(n => n.startsWith(path.basename(f) + '.tmp.'));
    expect(stragglers).toHaveLength(0);
  });
});

describe('copyAndEncryptFileAsync', () => {
  test('copies plaintext source to encrypted destination, leaves source untouched', async () => {
    const src = TMP('copysrc.txt');
    const dst = TMP('copydst.bin');
    fs.writeFileSync(src, 'source content stays plaintext');
    await at.copyAndEncryptFileAsync(src, dst);
    // Source unchanged
    expect(fs.readFileSync(src).toString('utf8')).toBe('source content stays plaintext');
    // Destination is OSCAR1-encrypted
    const onDisk = fs.readFileSync(dst);
    expect(onDisk.subarray(0, 6).toString('utf8')).toBe('OSCAR1');
    // Round-trip via the helper
    expect((await at.decryptFromFileAsync(dst)).toString('utf8')).toBe('source content stays plaintext');
  });
});
