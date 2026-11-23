// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/** totp.test.js — authenticator-app codes (#1414), utils/totp.js. */

const T = require('../../src/utils/totp');

// RFC 4226 appendix D and RFC 6238 appendix B use this ASCII secret.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32 (RFC 4648)', () => {
  test.each([
    ['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI'],
  ])('%j is %s without padding, and reads back', (text, encoded) => {
    expect(T.base32Encode(Buffer.from(text, 'ascii'))).toBe(encoded);
    expect(T.base32Decode(encoded).toString('ascii')).toBe(text);
  });

  test('reads a key typed in lower case, in groups, with padding', () => {
    expect(T.base32Decode('mzxw 6ytb-oi======').toString('ascii')).toBe('foobar');
  });

  test('refuses a character outside the alphabet', () => {
    expect(T.base32Decode('MZXW1')).toBeNull();
    expect(T.base32Decode('MZ%W')).toBeNull();
    expect(T.base32Decode(null)).toBeNull();
  });

  test('a new secret is 20 random bytes, 32 characters in base32', () => {
    const secrets = Array.from({ length: 200 }, () => T.newSecret());
    expect(secrets.every(s => s.length === 20)).toBe(true);
    expect(new Set(secrets.map(s => s.toString('hex'))).size).toBe(200);
    expect(T.base32Encode(secrets[0])).toMatch(/^[A-Z2-7]{32}$/);
    expect(T.base32Decode(T.base32Encode(secrets[0])).equals(secrets[0])).toBe(true);
  });
});

describe('HOTP (RFC 4226, appendix D)', () => {
  test.each([
    [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'], [4, '338314'],
    [5, '254676'], [6, '287922'], [7, '162583'], [8, '399871'], [9, '520489'],
  ])('counter %i gives %s', (counter, code) => {
    expect(T.hotp(RFC_SECRET, counter)).toBe(code);
  });
});

describe('TOTP (RFC 6238, appendix B, SHA-1, eight digits)', () => {
  test.each([
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ])('at %i s the code is %s', (seconds, code) => {
    expect(T.totpAt(RFC_SECRET, seconds * 1000, 8)).toBe(code);
  });

  test('six digits by default, the last six of the eight', () => {
    expect(T.totpAt(RFC_SECRET, 59 * 1000)).toBe('287082');
  });
});

describe('checking a typed code', () => {
  const secret = T.base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  const now = 1_790_000_015_000;              // 15 s into a step
  const step = T.stepAt(now);
  const codeAt = s => T.hotp(secret, s);

  test('the code of this step, of the step before and of the step after pass', () => {
    expect(T.verifyCode(secret, codeAt(step), now)).toEqual({ ok: true, step });
    expect(T.verifyCode(secret, codeAt(step - 1), now)).toEqual({ ok: true, step: step - 1 });
    expect(T.verifyCode(secret, codeAt(step + 1), now)).toEqual({ ok: true, step: step + 1 });
  });

  test('a code two steps away is wrong', () => {
    expect(T.verifyCode(secret, codeAt(step - 2), now)).toEqual({ ok: false, reason: 'wrong' });
    expect(T.verifyCode(secret, codeAt(step + 2), now)).toEqual({ ok: false, reason: 'wrong' });
  });

  test('a code is never accepted twice: its step or an earlier one is a replay', () => {
    expect(T.verifyCode(secret, codeAt(step), now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(T.verifyCode(secret, codeAt(step - 1), now, step)).toEqual({ ok: false, reason: 'replay' });
    expect(T.verifyCode(secret, codeAt(step + 1), now, step)).toEqual({ ok: true, step: step + 1 });
  });

  test('spaces are ignored; anything but six digits is a format error', () => {
    const code = codeAt(step);
    expect(T.verifyCode(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now).ok).toBe(true);
    for (const typed of ['12345', '1234567', 'abcdef', '', null, undefined, {}, '12 345a']) {
      expect(T.verifyCode(secret, typed, now)).toEqual({ ok: false, reason: 'format' });
    }
  });

  test('the code of another secret is wrong', () => {
    const other = T.newSecret();
    const hits = Array.from({ length: 50 }, (_, i) => T.verifyCode(other, codeAt(step + (i % 3) - 1), now).ok);
    expect(hits.filter(Boolean).length).toBeLessThanOrEqual(1);   // a chance match is one in 333,333
  });
});

describe('the otpauth:// address', () => {
  test('names OSCAR, the account, the key and the defaults', () => {
    const uri = T.otpauthUri('JBSWY3DPEHPK3PXP', 'élodie+test@example.org');
    expect(uri).toBe('otpauth://totp/OSCAR:%C3%A9lodie%2Btest%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=OSCAR&algorithm=SHA1&digits=6&period=30');
    const parsed = new URL(uri);
    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
  });
});
