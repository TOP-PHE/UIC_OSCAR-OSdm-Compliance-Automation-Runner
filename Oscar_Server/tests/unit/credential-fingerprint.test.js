// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * credential-fingerprint.test.js — the fingerprint kept beside a tester's
 * access token (utils/credentialFingerprint.js), and one thing found while
 * changing it: a source file that held a NUL character, which git read as
 * binary.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('../../src/utils/credentialFingerprint');

const KEY_A = { ENCRYPTION_KEY: 'a'.repeat(64) };
const KEY_B = { ENCRYPTION_KEY: 'b'.repeat(64) };
const VALUES = ['oauth2_basic', 'https://token.example/oauth', 'client', 'secret', 'scope', '', '', 'https://api.example'];
const REPO = path.join(__dirname, '..', '..', '..');

describe('the fingerprint of a set of credentials', () => {
  test('the same values give the same fingerprint, any other value another', () => {
    const base = F.credentialFingerprint(VALUES, KEY_A);
    expect(F.credentialFingerprint([...VALUES], KEY_A)).toBe(base);
    for (let i = 0; i < VALUES.length; i++) {
      const changed = [...VALUES];
      changed[i] = `${changed[i]}x`;
      expect(F.credentialFingerprint(changed, KEY_A)).not.toBe(base);
    }
  });

  test('where a value ends counts: two values are not their joined text', () => {
    expect(F.credentialFingerprint(['ab', 'c'], KEY_A)).not.toBe(F.credentialFingerprint(['a', 'bc'], KEY_A));
    expect(F.credentialFingerprint(['a', 'b'], KEY_A)).not.toBe(F.credentialFingerprint(['b', 'a'], KEY_A));
  });

  test('a value that is missing counts as empty text', () => {
    expect(F.credentialFingerprint(['a', null, undefined, 'b'], KEY_A)).toBe(F.credentialFingerprint(['a', '', '', 'b'], KEY_A));
  });

  test('it is keyed: another server key, another fingerprint', () => {
    expect(F.credentialFingerprint(VALUES, KEY_A)).not.toBe(F.credentialFingerprint(VALUES, KEY_B));
  });

  test('it is not a digest anyone can compute from the values alone', () => {
    const fingerprint = F.credentialFingerprint(VALUES, KEY_A);
    const joined = VALUES.join(String.fromCharCode(0));
    for (const algorithm of ['sha256', 'sha512', 'sha1', 'md5']) {
      expect(fingerprint).not.toContain(crypto.createHash(algorithm).update(joined).digest('hex'));
    }
    // Nor one keyed by the encryption key as it is: the key is derived.
    const direct = crypto.createHmac('sha256', Buffer.from(KEY_A.ENCRYPTION_KEY, 'hex')).update(joined).digest('hex');
    expect(fingerprint).not.toContain(direct);
  });

  test('it names its form, and one kept by an earlier version does not', () => {
    const fingerprint = F.credentialFingerprint(VALUES, KEY_A);
    expect(fingerprint).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(F.isCurrentForm(fingerprint)).toBe(true);
    const earlier = crypto.createHash('sha256').update('anything').digest('hex');
    for (const other of [earlier, '', null, undefined, 42, 'fp']) expect(F.isCurrentForm(other)).toBe(false);
  });

  test('no fingerprint without a server key of the right form', () => {
    for (const env of [{}, { ENCRYPTION_KEY: '' }, { ENCRYPTION_KEY: 'abc' }, { ENCRYPTION_KEY: 'z'.repeat(64) }, { ENCRYPTION_KEY: 7 }]) {
      expect(() => F.credentialFingerprint(VALUES, env)).toThrow(/ENCRYPTION_KEY/);
    }
  });

  test('the key follows ENCRYPTION_KEY when it changes', () => {
    const first = F.fingerprintKey(KEY_A);
    expect(F.fingerprintKey(KEY_A).equals(first)).toBe(true);
    expect(F.fingerprintKey(KEY_B).equals(first)).toBe(false);
    expect(F.fingerprintKey(KEY_A).equals(first)).toBe(true);
  });
});

describe('the token module', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'worker', 'access-token.js'), 'utf8');

  test('makes its fingerprint with the keyed digest, and with nothing else', () => {
    expect(source).toContain('const credFp = credentialFingerprint([');
    expect(source).not.toContain('createHash(');
    expect(source).not.toContain("require('node:crypto')");
  });

  test('says so when a token was kept by an earlier version, not that the credentials changed', () => {
    const earlier = source.indexOf('!isCurrentForm(userRow.cached_token_cred_fp)');
    const changed = source.indexOf('credentials changed since the cached token was issued');
    expect(earlier).toBeGreaterThan(-1);
    expect(changed).toBeGreaterThan(earlier);
  });
});

describe('no source file holds a NUL character', () => {
  // git reads a file that holds one as binary: its changes show as "Binary
  // files differ" in a review. The token module held one for months, written
  // by an editing tool in place of the escape that was typed.
  const FOLDERS = [
    'Oscar_Server/src', 'Oscar_Server/public', 'Oscar_Server/tests', 'Oscar_Server/scripts',
    'Bruno_Collection/library-bruno', 'OSDM_Simulator/src', 'OSDM_Simulator/scripts', 'OSDM_Simulator/tests', 'OSCAR_MCP/src',
  ];
  const SKIPPED = new Set(['node_modules', 'vendor']);

  function sourceFiles(folder, found = []) {
    if (!fs.existsSync(folder)) return found;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) sourceFiles(full, found);
      else if (/[.](js|html|css|yml)$/.test(entry.name)) found.push(full);
    }
    return found;
  }

  test('in the server, the pages, the tests, the collection library, the simulator and the MCP server', () => {
    const files = FOLDERS.flatMap(folder => sourceFiles(path.join(REPO, folder)));
    expect(files.length).toBeGreaterThan(500);
    const withNul = files.filter(file => fs.readFileSync(file).includes(0)).map(file => path.relative(REPO, file));
    expect(withNul).toEqual([]);
  });
});
