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

// #1070: the W3C trace context of OSCAR's own calls to a provider.
describe('withTraceHeaders / traceSettingsFor (#1070)', () => {
  const { withTraceHeaders, traceSettingsFor } = require('../../src/utils/osdm-client');
  const { run } = require('../../src/db/db');
  const { isTraceparent, settingsOf } = require('../../public/js/trace-context');

  test('a copy with a trace of its own, the dedicated one replaced, the rest kept', () => {
    const dedicated = { Requestor: 'ACME', TraceParent: 'cafebabe-0815', tracestate: 'processid=abc' };
    const a = withTraceHeaders(dedicated, settingsOf({}));
    const b = withTraceHeaders(dedicated, settingsOf({}));
    expect(dedicated.TraceParent).toBe('cafebabe-0815');                  // not changed in place
    expect(a.TraceParent).toBeUndefined();
    expect(isTraceparent(a.traceparent)).toBe(true);
    expect(a.traceparent.split('-')[1]).not.toBe(b.traceparent.split('-')[1]);
    expect(a).toMatchObject({ Requestor: 'ACME', tracestate: 'processid=abc' });
  });

  test('the framework\'s tracestate is filled in with the call\'s own trace id', () => {
    const h = withTraceHeaders({}, settingsOf({ traceContext: { tracestate: 't={{traceId}}' } }));
    expect(h.tracestate).toBe(`t=${h.traceparent.split('-')[1]}`);
  });

  test('none sent: the headers as they are', () => {
    expect(withTraceHeaders({ traceparent: 'fixed' }, settingsOf({ traceContext: { send: false } }))).toEqual({ traceparent: 'fixed' });
  });

  test('the settings come from the company\'s Test Framework, the defaults without one', () => {
    const company = require('node:crypto').randomUUID();
    run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [company, 'Trace Co', `trace-${company.slice(0, 8)}`]);
    try {
      expect(traceSettingsFor(company)).toEqual({ send: true, sampled: true, tracestate: '' });
      run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)',
        [require('node:crypto').randomUUID(), company, colEncrypt(JSON.stringify({ traceContext: { sampled: false } }))]);
      expect(traceSettingsFor(company)).toEqual({ send: true, sampled: false, tracestate: '' });
    } finally {
      run('DELETE FROM companies WHERE id = ?', [company]);
    }
  });
});
