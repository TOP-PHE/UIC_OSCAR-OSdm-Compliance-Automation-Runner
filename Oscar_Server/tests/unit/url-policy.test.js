// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * url-policy.test.js — utils/urlPolicy.js (tracker S5).
 *
 * The whole suite runs with ALLOW_PRIVATE_TARGETS=1 (tests/setup.js), so this
 * file turns it OFF to exercise the policy, and restores it after. DNS is
 * mocked where usableUrlRefusal resolves a host.
 */

jest.mock('node:dns', () => ({ promises: { lookup: jest.fn() } }));
const dns = require('node:dns').promises;
const { storedUrlRefusal, usableUrlRefusal, ipIsPublic } = require('../../src/utils/urlPolicy');

const PRIOR = process.env.ALLOW_PRIVATE_TARGETS;
beforeEach(() => { process.env.ALLOW_PRIVATE_TARGETS = ''; dns.lookup.mockReset(); });
afterAll(() => { process.env.ALLOW_PRIVATE_TARGETS = PRIOR; });

describe('ipIsPublic', () => {
  test('only public unicast addresses are public', () => {
    // '::ffff:8.8.8.8' is a public v4 mapped into v6 — it must be unwrapped and
    // judged as the v4, not left as the (non-unicast) 'ipv4Mapped' range.
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(ipIsPublic(ip)).toBe(true);
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.1', '192.168.1.1',
      '169.254.169.254', '0.0.0.0', '100.64.0.1', '255.255.255.255', '224.0.0.1',
      '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
      'not-an-ip', '',
    ]) expect(ipIsPublic(ip)).toBe(false);
  });
});

describe('storedUrlRefusal — structural, no DNS', () => {
  test('a public https URL is allowed', () => {
    for (const ok of ['https://api.vendor.com/osdm', 'https://osdm.example.co.uk/v3', 'https://8.8.8.8/x']) {
      expect(storedUrlRefusal(ok, 'endpoint')).toBeNull();
    }
  });

  test.each([
    ['http://api.vendor.com', 'must use https'],
    ['ftp://api.vendor.com', 'must use https'],
    ['https://127.0.0.1/x', 'private, loopback'],
    ['https://10.1.2.3/x', 'private, loopback'],
    ['https://192.168.0.5', 'private, loopback'],
    ['https://169.254.169.254/latest/meta-data', 'private, loopback'],
    ['https://[::1]/x', 'private, loopback'],
    ['https://localhost/x', 'internal host name'],
    ['https://grafana/x', 'internal host name'],
    ['https://oscar:3001/data/other-datafile.json', 'internal host name'],
    ['not a url', 'is not a valid URL'],
    ['', 'is empty'],
  ])('refuses %s', (raw, fragment) => {
    const msg = storedUrlRefusal(raw, 'endpoint');
    expect(msg).toContain(fragment);
    expect(msg).toContain('endpoint');
    expect(msg).toContain('public host');
  });

  test('non-string input is refused, not thrown', () => {
    for (const bad of [null, undefined, 7, {}, []]) expect(typeof storedUrlRefusal(bad, 'x')).toBe('string');
  });

  test('ALLOW_PRIVATE_TARGETS=1 lets everything through', () => {
    process.env.ALLOW_PRIVATE_TARGETS = '1';
    for (const raw of ['http://localhost:3001', 'https://127.0.0.1', 'https://grafana/x']) {
      expect(storedUrlRefusal(raw, 'endpoint')).toBeNull();
    }
  });
});

describe('usableUrlRefusal — structural + DNS', () => {
  test('a name that resolves only to public addresses is allowed', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    expect(await usableUrlRefusal('https://api.vendor.com/osdm', 'endpoint')).toBeNull();
    expect(dns.lookup).toHaveBeenCalledWith('api.vendor.com', { all: true });
  });

  test('a name that resolves to a private address is refused (DNS-rebinding backstop)', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]);
    const msg = await usableUrlRefusal('https://sneaky.vendor.com', 'endpoint');
    expect(msg).toContain('resolves to a private');
  });

  test('a name where any resolved address is private is refused', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect(await usableUrlRefusal('https://split.vendor.com', 'endpoint')).toContain('resolves to a private');
  });

  test('a name that will not resolve is refused, not allowed', async () => {
    dns.lookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect(await usableUrlRefusal('https://nope.vendor.com', 'endpoint')).toContain('resolves to a private');
  });

  test('the structural check still applies before any DNS', async () => {
    expect(await usableUrlRefusal('http://api.vendor.com', 'endpoint')).toContain('must use https');
    expect(await usableUrlRefusal('https://grafana/x', 'endpoint')).toContain('internal host name');
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('a literal public IP needs no DNS', async () => {
    expect(await usableUrlRefusal('https://8.8.8.8/x', 'endpoint')).toBeNull();
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  test('ALLOW_PRIVATE_TARGETS=1 skips the DNS check', async () => {
    process.env.ALLOW_PRIVATE_TARGETS = '1';
    expect(await usableUrlRefusal('https://anything.internal', 'endpoint')).toBeNull();
    expect(dns.lookup).not.toHaveBeenCalled();
  });
});
