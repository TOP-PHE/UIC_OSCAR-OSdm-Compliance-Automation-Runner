// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdm-client.test.js — the S5 use-time guard on utils/osdm-client.osdmGet
 * (the server-side OSDM calls: places refresh, discover timetable). The suite
 * allows private targets (tests/setup.js); off here. fetch is stubbed so no
 * request leaves the process.
 */

const { osdmGet, mergeDedicatedHeaders } = require('../../src/utils/osdm-client');
const { colEncrypt } = require('../../src/db/db');

const PRIOR = process.env.ALLOW_PRIVATE_TARGETS;
let fetchSpy;
beforeEach(() => {
  process.env.ALLOW_PRIVATE_TARGETS = '';
  fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true, status: 200, text: async () => '{"ok":true}',
  });
});
afterEach(() => { process.env.ALLOW_PRIVATE_TARGETS = PRIOR; fetchSpy.mockRestore(); });

test.each([
  'http://vendor.example',      // not https
  'https://127.0.0.1',          // loopback
  'https://10.0.0.1',           // private
  'https://places',             // a Docker service name
])('osdmGet refuses a non-public api_base %s before fetching', async (bad) => {
  await expect(osdmGet(bad, 'places', 'tok')).rejects.toThrow(/public host/);
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('osdmGet fetches when the api_base is a public literal IP (no DNS)', async () => {
  const res = await osdmGet('https://8.8.8.8', 'places', 'tok');
  expect(res.ok).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy.mock.calls[0][0]).toBe('https://8.8.8.8/places');
});

// S6 (v1.11.213): extra_headers is encrypted at rest; mergeDedicatedHeaders must
// decrypt it at use and resolve the configured headers (incl. {{var}} templates).
describe('mergeDedicatedHeaders decrypts the stored (encrypted) extra_headers', () => {
  test('an encrypted row resolves to the configured headers', () => {
    const companyRow = {
      id: 'c1',
      extra_headers: colEncrypt(JSON.stringify([
        { name: 'X-Api-Key', value: 'sk-secret-123' },
        { name: 'X-Requestor', value: '{{requestor}}' },
      ])),
    };
    expect(companyRow.extra_headers.startsWith('enc:v1:')).toBe(true);   // genuinely encrypted
    const headers = mergeDedicatedHeaders({ Requestor: 'ACME' }, companyRow, 'tok-xyz');
    expect(headers['X-Api-Key']).toBe('sk-secret-123');
    expect(headers['X-Requestor']).toBe('ACME');                         // {{requestor}} resolved
  });

  test('a legacy plaintext row still resolves (colDecrypt passthrough)', () => {
    const companyRow = { id: 'c2', extra_headers: JSON.stringify([{ name: 'X-Legacy', value: 'plain' }]) };
    const headers = mergeDedicatedHeaders({}, companyRow, 'tok');
    expect(headers['X-Legacy']).toBe('plain');
  });
});
