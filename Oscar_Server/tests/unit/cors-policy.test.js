// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * cors-policy.test.js — utils/corsPolicy.js (tracker S7-cors).
 */

const { corsOptions } = require('../../src/utils/corsPolicy');

// Resolve the cors `origin` option against a request origin, the way the cors
// package would.
function decide(opts, origin) {
  if (typeof opts.origin !== 'function') return opts.origin;   // boolean
  return new Promise((resolve, reject) => {
    opts.origin(origin, (err, allow) => (err ? reject(err) : resolve(allow)));
  });
}

describe('corsOptions', () => {
  test('no allowlist: fail closed — no cross-origin, no credentials', () => {
    for (const empty of [[], undefined, null, 'not-an-array']) {
      const opts = corsOptions(empty);
      expect(opts.origin).toBe(false);          // the cors package sends no ACAO
      expect(opts.credentials).toBe(false);     // never reflect-any + credentials
    }
  });

  test('with an allowlist: only listed origins, with credentials', async () => {
    const opts = corsOptions(['https://ui.oscar.example', 'https://admin.oscar.example']);
    expect(opts.credentials).toBe(true);
    expect(typeof opts.origin).toBe('function');
    expect(await decide(opts, 'https://ui.oscar.example')).toBe(true);
    expect(await decide(opts, 'https://admin.oscar.example')).toBe(true);
    expect(await decide(opts, undefined)).toBe(true);           // same-origin / curl: no Origin
    await expect(decide(opts, 'https://evil.example')).rejects.toThrow('CORS blocked');
    await expect(decide(opts, 'http://ui.oscar.example')).rejects.toThrow('CORS blocked');  // scheme matters
  });
});
