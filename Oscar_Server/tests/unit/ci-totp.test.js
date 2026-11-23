// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ci-totp.test.js — the TOTP of the Kubernetes CI scripts (#1414),
 * OSCAR_Deploy/kubernetes/ci/totp.sh, held to the server's own
 * (utils/totp.js). An administrator's sign-in asks for a code: smoke.sh sets
 * the first administrator's factor up and check-monitoring.sh signs in with
 * it, both computing the code in bash.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const T = require('../../src/utils/totp');

const CI = path.resolve(__dirname, '../../../OSCAR_Deploy/kubernetes/ci');
const TOTP_SH = path.join(CI, 'totp.sh');
const hasTools = process.platform !== 'win32'
  && spawnSync('bash', ['-c', 'command -v base32 && command -v openssl && command -v od'], { encoding: 'utf8' }).status === 0;
const toolTest = hasTools ? test : test.skip;

function bashTotp(secret, time, offset = 0) {
  const out = spawnSync('bash', ['-c', `. "$1"; totp "$2" "$3"`, 'totp-test', TOTP_SH, secret, String(offset)],
    { env: { ...process.env, TOTP_TIME: String(time) }, encoding: 'utf8' });
  expect(out.stderr).toBe('');
  return out.stdout.trim();
}

describe('ci/totp.sh', () => {
  toolTest('gives the codes of RFC 6238, appendix B (six digits), as utils/totp.js does', () => {
    const secret = T.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    for (const seconds of [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000]) {
      expect([seconds, bashTotp(secret, seconds)]).toEqual([seconds, T.totpAt(Buffer.from('12345678901234567890', 'ascii'), seconds * 1000)]);
    }
  });

  toolTest('takes a step offset, and any secret the server makes', () => {
    for (let i = 0; i < 20; i++) {
      const raw = T.newSecret();
      const time = 1_790_000_000 + i * 977;
      expect(bashTotp(T.base32Encode(raw), time, 1)).toBe(T.hotp(raw, Math.floor(time / 30) + 1));
    }
  });

  test('the scripts that sign in as an administrator use it', () => {
    for (const script of ['smoke.sh', 'check-monitoring.sh']) {
      const text = fs.readFileSync(path.join(CI, script), 'utf8');
      expect([script, text.includes('. "$(dirname "$0")/totp.sh"')]).toEqual([script, true]);
    }
    expect(fs.readFileSync(path.join(CI, 'smoke.sh'), 'utf8')).toContain('admin_mfa_secret: $am');
    expect(fs.readFileSync(path.join(CI, 'check-monitoring.sh'), 'utf8')).toContain('/v1/auth/mfa/verify');
  });
});
