// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1059: the two settings a cluster deployment needs, read as the server reads
// them. The server's own use of them is in server.test.js (an isolated load
// with both set).

const { trustProxyHops, metricsAllowed, MAX_PROXY_HOPS } = require('../../src/utils/clusterSettings');

describe('trustProxyHops()', () => {
  test.each([undefined, null, '', '   '])('one hop when unset (%p), as before', (raw) => {
    expect(trustProxyHops(raw)).toBe(1);
  });

  test.each([['0', 0], ['1', 1], ['2', 2], [' 3 ', 3], ['5', 5]])('"%s" is %d hops', (raw, hops) => {
    expect(trustProxyHops(raw)).toBe(hops);
  });

  test.each(['6', '9', '10', '-1', '1.5', 'two', 'true', '0x1', '1e0', '１'])('refuses "%s"', (raw) => {
    expect(() => trustProxyHops(raw)).toThrow(`from 0 to ${MAX_PROXY_HOPS}`);
  });

  test('a long value is cut in the message', () => {
    expect(() => trustProxyHops('x'.repeat(500))).toThrow(/not "x{20}"\.$/);
  });
});

describe('metricsAllowed()', () => {
  const token = 'a'.repeat(64);

  test.each([undefined, null, ''])('everything passes when no token is set (%p): nginx guards it', (unset) => {
    expect(metricsAllowed(undefined, unset)).toBe(true);
    expect(metricsAllowed('Bearer anything', unset)).toBe(true);
  });

  test('the token as a bearer token passes', () => {
    expect(metricsAllowed(`Bearer ${token}`, token)).toBe(true);
  });

  test.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another token', `Bearer ${'b'.repeat(64)}`],
    ['a prefix of the token', `Bearer ${token.slice(0, 10)}`],
    ['the token and more', `Bearer ${token}x`],
    ['the token without the scheme', token],
    ['another scheme', `Basic ${token}`],
    ['a lower-case scheme', `bearer ${token}`],
    ['an empty bearer token', 'Bearer '],
    ['a header given twice (Node joins them)', [`Bearer ${token}`, `Bearer ${token}`]],
  ])('refuses %s', (_what, header) => {
    expect(metricsAllowed(header, token)).toBe(false);
  });
});
