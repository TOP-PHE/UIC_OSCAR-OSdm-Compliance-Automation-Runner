'use strict';

/**
 * db.test.js — encryption and config helper unit tests
 *
 * Covers the two pure helpers most critical to security:
 *   1. encrypt/decrypt round-trip with AES-256-GCM
 *   2. getConfig fallback chain (DB → env → default)
 */

const { encrypt, decrypt, getConfig, run } = require('../../src/db/db');

describe('encryption (AES-256-GCM)', () => {
  test('round-trip: decrypt(encrypt(x)) === x', () => {
    const plain = 'super-secret-token-abc123';
    const enc = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(decrypt(enc)).toBe(plain);
  });

  test('encrypt(null) → null, encrypt("") → null', () => {
    expect(encrypt(null)).toBeNull();
    expect(encrypt('')).toBeNull();
  });

  test('decrypt(null) → null, decrypt("") → null', () => {
    expect(decrypt(null)).toBeNull();
    expect(decrypt('')).toBeNull();
  });

  test('two encryptions of same plaintext produce different ciphertexts (random IV)', () => {
    const plain = 'same-secret';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plain);
    expect(decrypt(b)).toBe(plain);
  });

  test('tampered ciphertext fails authentication', () => {
    const enc = encrypt('hello');
    // Flip one byte in the encoded payload
    const buf = Buffer.from(enc, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered)).toThrow();
  });

  test('handles unicode and binary-ish strings', () => {
    const plain = 'héllo 🔐 \\n\\t"weird"';
    expect(decrypt(encrypt(plain))).toBe(plain);
  });
});

describe('getConfig', () => {
  test('falls back to default when key not in DB and no env var', () => {
    expect(getConfig('NOT_A_REAL_KEY', 'default-value')).toBe('default-value');
  });

  test('reads from server_config table when present', () => {
    run(
      `INSERT INTO server_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ['TEST_FROM_DB', 'db-value']
    );
    expect(getConfig('TEST_FROM_DB', 'default')).toBe('db-value');
  });

  test('DB value takes precedence over env var', () => {
    process.env.TEST_PRECEDENCE = 'env-value';
    run(
      `INSERT INTO server_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ['TEST_PRECEDENCE', 'db-value']
    );
    expect(getConfig('TEST_PRECEDENCE', 'default')).toBe('db-value');
    delete process.env.TEST_PRECEDENCE;
  });

  test('env var used when DB has no entry', () => {
    process.env.TEST_FROM_ENV = 'env-only-value';
    expect(getConfig('TEST_FROM_ENV', 'default')).toBe('env-only-value');
    delete process.env.TEST_FROM_ENV;
  });
});
