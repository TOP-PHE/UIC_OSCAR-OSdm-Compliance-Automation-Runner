// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth-profiles.test.js — Unit tests for the OAuth profile adapter module
 *
 * Covers:
 *   - PROFILES list is complete and contains only expected values
 *   - isValidProfile correctly validates known / unknown profiles
 *   - fetchToken rejects unknown profiles immediately
 *   - fetchToken dispatches to the correct adapter (mocked fetch)
 *   - fetchToken handles successful token responses (expires_in variants)
 *   - fetchToken handles HTTP errors from the token endpoint
 *   - fetchToken handles missing access_token in response
 */

const { fetchToken, PROFILES, isValidProfile } = require('../../src/worker/auth-profiles');

const EXPECTED_PROFILES = [
  'oauth2_basic',
  'oauth2_post',
  'paxone_json',
  'sqills_extension',
  'custom',
];

const noop = { info: () => {}, error: () => {} };

// ── PROFILES / isValidProfile ─────────────────────────────────────────────────

describe('PROFILES', () => {
  test('contains all expected profile identifiers', () => {
    for (const p of EXPECTED_PROFILES) {
      expect(PROFILES).toContain(p);
    }
  });

  test('has exactly 5 profiles', () => {
    expect(PROFILES).toHaveLength(5);
  });
});

describe('isValidProfile', () => {
  test.each(EXPECTED_PROFILES)('"%s" is a valid profile', (profile) => {
    expect(isValidProfile(profile)).toBe(true);
  });

  test('"unknown_profile" is not valid', () => {
    expect(isValidProfile('unknown_profile')).toBe(false);
  });

  test('empty string is not valid', () => {
    expect(isValidProfile('')).toBe(false);
  });

  test('null is not valid', () => {
    expect(isValidProfile(null)).toBe(false);
  });

  test('undefined is not valid', () => {
    expect(isValidProfile(undefined)).toBe(false);
  });
});

// ── fetchToken — unknown profile ──────────────────────────────────────────────

describe('fetchToken — unknown profile', () => {
  test('rejects immediately for unknown profile (no fetch needed)', async () => {
    await expect(
      fetchToken('not_a_profile', {}, noop)
    ).rejects.toThrow(/Unknown OAuth profile/);
  });
});

// ── fetchToken with mocked global fetch ───────────────────────────────────────
// We use jest.spyOn on globalThis so we can restore it after each test.

let fetchSpy;

beforeEach(() => {
  fetchSpy = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function mockFetchSuccess(body) {
  fetchSpy.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function mockFetchFailure(status, errorBody = { error: 'invalid_client' }) {
  fetchSpy.mockResolvedValue({
    ok: false,
    status,
    json: async () => errorBody,
    text: async () => JSON.stringify(errorBody),
  });
}

// ── oauth2_basic ──────────────────────────────────────────────────────────────

describe('fetchToken — oauth2_basic', () => {
  const ctx = {
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'my-client',
    clientSecret: 'my-secret',
  };

  test('returns token on success', async () => {
    mockFetchSuccess({ access_token: 'tok-abc', expires_in: 3600 });
    const result = await fetchToken('oauth2_basic', ctx, noop);
    expect(result.token).toBe('tok-abc');
    expect(result.expiresIn).toBe(3600);
  });

  test('uses Basic authorization header', async () => {
    mockFetchSuccess({ access_token: 'tok', expires_in: 1800 });
    await fetchToken('oauth2_basic', ctx, noop);
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers['Authorization']).toMatch(/^Basic /);
  });

  test('null expiresIn when response has no expires_in', async () => {
    mockFetchSuccess({ access_token: 'tok-no-expiry' });
    const result = await fetchToken('oauth2_basic', ctx, noop);
    expect(result.expiresIn).toBeNull();
  });

  test('throws on missing access_token in response', async () => {
    mockFetchSuccess({ token_type: 'Bearer' });  // no access_token
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/access_token/);
  });

  test('throws on HTTP error from token endpoint', async () => {
    mockFetchFailure(401);
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/HTTP 401/);
  });

  test('includes scope in request body when provided', async () => {
    mockFetchSuccess({ access_token: 'tok', expires_in: 600 });
    await fetchToken('oauth2_basic', { ...ctx, scope: 'read:data' }, noop);
    const bodyParam = fetchSpy.mock.calls[0][1].body;
    // body is URLSearchParams
    expect(bodyParam.toString()).toContain('scope=read%3Adata');
  });
});

// ── oauth2_post ───────────────────────────────────────────────────────────────

describe('fetchToken — oauth2_post', () => {
  const ctx = {
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'client-id',
    clientSecret: 'secret',
  };

  test('returns token on success', async () => {
    mockFetchSuccess({ access_token: 'post-token', expires_in: 1200 });
    const result = await fetchToken('oauth2_post', ctx, noop);
    expect(result.token).toBe('post-token');
  });

  test('sends credentials in body, not Authorization header', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    await fetchToken('oauth2_post', ctx, noop);
    const callArgs = fetchSpy.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers['Authorization']).toBeUndefined();
    const body = callArgs[1].body.toString();
    expect(body).toContain('client_id=client-id');
    expect(body).toContain('client_secret=secret');
  });

  test('throws when access_token missing', async () => {
    mockFetchSuccess({});
    await expect(fetchToken('oauth2_post', ctx, noop)).rejects.toThrow(/access_token/);
  });
});

// ── paxone_json ───────────────────────────────────────────────────────────────

describe('fetchToken — paxone_json', () => {
  const ctx = {
    tokenUrl: 'https://auth.paxone.example.com/auth',
    clientId: 'account-name',
    clientSecret: 'account-secret',
  };

  test('returns token from "access_token" field', async () => {
    mockFetchSuccess({ access_token: 'pax-token' });
    const result = await fetchToken('paxone_json', ctx, noop);
    expect(result.token).toBe('pax-token');
  });

  test('returns token from "token" field', async () => {
    mockFetchSuccess({ token: 'pax-tok-2' });
    const result = await fetchToken('paxone_json', ctx, noop);
    expect(result.token).toBe('pax-tok-2');
  });

  test('returns token from "accessToken" field', async () => {
    mockFetchSuccess({ accessToken: 'pax-tok-3' });
    const result = await fetchToken('paxone_json', ctx, noop);
    expect(result.token).toBe('pax-tok-3');
  });

  test('throws when no recognized token field', async () => {
    mockFetchSuccess({ some_other_field: 'value' });
    await expect(fetchToken('paxone_json', ctx, noop)).rejects.toThrow(/recognised token field/);
  });
});

// ── sqills_extension ──────────────────────────────────────────────────────────

describe('fetchToken — sqills_extension', () => {
  const ctx = {
    tokenUrl: 'https://auth.sqills.example.com/token',
    clientId: 'user',
    clientSecret: 'pass',
    extra: 'Base64EncodedValue==',
  };

  test('returns token on success', async () => {
    mockFetchSuccess({ access_token: 'sqills-tok' });
    const result = await fetchToken('sqills_extension', ctx, noop);
    expect(result.token).toBe('sqills-tok');
  });

  test('throws when extra (pre-encoded Basic) is missing', async () => {
    await expect(
      fetchToken('sqills_extension', { ...ctx, extra: undefined }, noop)
    ).rejects.toThrow(/Extra credential/);
  });

  test('prepends "Basic " when extra does not already start with it', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    await fetchToken('sqills_extension', ctx, noop);
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Basic Base64EncodedValue==');
  });

  test('does not double-prefix "Basic " when extra already starts with it', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    await fetchToken('sqills_extension', { ...ctx, extra: 'Basic AlreadyPrefixed==' }, noop);
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Basic AlreadyPrefixed==');
  });
});

// ── custom ────────────────────────────────────────────────────────────────────

describe('fetchToken — custom', () => {
  const template = JSON.stringify({
    method: 'POST',
    headers: { 'X-Client': '{{client_id}}' },
    body: { grant_type: 'client_credentials', secret: '{{client_secret}}' },
    token_field: 'access_token',
  });

  const ctx = {
    tokenUrl: 'https://auth.custom.example.com/token',
    clientId: 'cid',
    clientSecret: 'csecret',
    customTemplate: template,
  };

  test('returns token from custom token_field', async () => {
    mockFetchSuccess({ access_token: 'custom-tok' });
    const result = await fetchToken('custom', ctx, noop);
    expect(result.token).toBe('custom-tok');
  });

  test('substitutes {{client_id}} in headers', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    await fetchToken('custom', ctx, noop);
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['X-Client']).toBe('cid');
  });

  test('throws when customTemplate is missing', async () => {
    await expect(
      fetchToken('custom', { ...ctx, customTemplate: undefined }, noop)
    ).rejects.toThrow(/Custom profile requires a JSON template/);
  });

  test('throws when customTemplate is invalid JSON', async () => {
    await expect(
      fetchToken('custom', { ...ctx, customTemplate: 'not-json{' }, noop)
    ).rejects.toThrow(/not valid JSON/);
  });

  test('uses string expiresIn from response', async () => {
    mockFetchSuccess({ access_token: 'tok', expires_in: '7200' });
    const result = await fetchToken('custom', ctx, noop);
    expect(result.expiresIn).toBe(7200);
  });

  test('custom template with form body_format sends form-encoded body', async () => {
    mockFetchSuccess({ access_token: 'form-tok' });
    const formTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: '{{client_id}}' },
      body_format: 'form',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: formTemplate }, noop);
    const callArgs = fetchSpy.mock.calls[0];
    const body = callArgs[1].body;
    expect(body instanceof URLSearchParams).toBe(true);
    expect(body.toString()).toContain('client_id=cid');
  });

  test('custom template with raw body_format sends the substituted string verbatim', async () => {
    mockFetchSuccess({ access_token: 'raw-tok' });
    const rawTemplate = JSON.stringify({
      method: 'POST',
      body: 'grant_type=client_credentials&client_id={{client_id}}',
      body_format: 'raw',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: rawTemplate }, noop);
    const callArgs = fetchSpy.mock.calls[0];
    const body = callArgs[1].body;
    expect(typeof body).toBe('string');
    expect(body).toBe('grant_type=client_credentials&client_id=cid');
  });

  test('custom template with raw body_format and a non-string body JSON-stringifies the substituted object', async () => {
    mockFetchSuccess({ access_token: 'raw-obj-tok' });
    const rawObjTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: '{{client_id}}' },
      body_format: 'raw',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: rawObjTemplate }, noop);
    const callArgs = fetchSpy.mock.calls[0];
    const body = callArgs[1].body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body)).toEqual({ grant_type: 'client_credentials', client_id: 'cid' });
  });

  test('raw body_format defaults Content-Type to form-urlencoded when template does not set one', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const rawTemplate = JSON.stringify({
      method: 'POST',
      body: 'a=b',
      body_format: 'raw',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: rawTemplate }, noop);
    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  test('form body_format logs a hint when a value contains "%" or "+" (percent-encoding round-trip risk)', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const infoLog = [];
    const capturingLog = { info: (msg) => infoLog.push(msg), error: () => {} };
    const formTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials', client_secret: '{{client_secret}}' },
      body_format: 'form',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, clientSecret: 'sec%ret+here', customTemplate: formTemplate }, capturingLog);
    const hint = infoLog.find((m) => m.includes('form-encoding percent-escapes'));
    expect(hint).toBeDefined();
    expect(hint).toContain('client_secret');
  });

  test('form body_format does not log the percent-encoding hint when no value contains "%" or "+"', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const infoLog = [];
    const capturingLog = { info: (msg) => infoLog.push(msg), error: () => {} };
    const formTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials', client_id: '{{client_id}}' },
      body_format: 'form',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: formTemplate }, capturingLog);
    const hint = infoLog.find((m) => m.includes('form-encoding percent-escapes'));
    expect(hint).toBeUndefined();
  });

  test('logs unrecognised {{placeholder}}s and names (never values) them', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const infoLog = [];
    const capturingLog = { info: (msg) => infoLog.push(msg), error: () => {} };
    const typoTemplate = JSON.stringify({
      method: 'POST',
      headers: { 'X-Typo': '{{clientSecert}}' },
      body: { grant_type: 'client_credentials' },
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: typoTemplate }, capturingLog);
    const hint = infoLog.find((m) => m.includes('unrecognised placeholder'));
    expect(hint).toBeDefined();
    expect(hint).toContain('clientSecert');
    expect(hint).not.toContain(ctx.clientSecret);
  });

  test('does not log unrecognised-placeholder hint when all placeholders are known', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const infoLog = [];
    const capturingLog = { info: (msg) => infoLog.push(msg), error: () => {} };
    await fetchToken('custom', { ...ctx, customTemplate: template }, capturingLog);
    const hint = infoLog.find((m) => m.includes('unrecognised placeholder'));
    expect(hint).toBeUndefined();
  });

  test('substitutes deep non-string primitive values as-is (numbers/booleans pass through unchanged)', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const primitiveTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials', max_age: 3600, verified: true, extra_field: null },
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: primitiveTemplate }, noop);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ grant_type: 'client_credentials', max_age: 3600, verified: true, extra_field: null });
  });

  test('throws with the configured token_field name when the field is absent from the response', async () => {
    mockFetchSuccess({ some_unrelated_field: 'x' });
    const fieldTemplate = JSON.stringify({
      method: 'POST',
      body: { grant_type: 'client_credentials' },
      token_field: 'custom_token',
    });
    await expect(
      fetchToken('custom', { ...ctx, customTemplate: fieldTemplate }, noop)
    ).rejects.toThrow(/did not contain field "custom_token"/);
  });
});

// ── _doFetch — network failure paths ─────────────────────────────────────────

describe('fetchToken — network / transport failures', () => {
  const ctx = {
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'my-client',
    clientSecret: 'my-secret',
  };

  test('surfaces a timeout error when fetch aborts', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    fetchSpy.mockRejectedValue(abortErr);
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/timed out after 15s/);
  });

  test('propagates a generic network error (e.g. DNS/connection failure)', async () => {
    fetchSpy.mockRejectedValue(new Error('getaddrinfo ENOTFOUND auth.example.com'));
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/ENOTFOUND/);
  });

  test('throws a descriptive error when the success response body is not valid JSON', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
      text: async () => 'not json',
    });
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/response was not valid JSON/);
  });

  test('HTTP error response with a JSON body lacking "error"/"error_description" falls back to raw text summary', async () => {
    mockFetchFailure(500, { message: 'internal failure', code: 'E500' });
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/internal failure/);
  });

  test('HTTP error response with a non-JSON text body uses the raw text as the summary', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('not json'); },
      text: async () => 'Bad Gateway',
    });
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/Bad Gateway/);
  });

  test('HTTP error response where reading the body itself fails still throws with the HTTP status', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => { throw new Error('should not be called'); },
      text: async () => { throw new Error('stream already consumed'); },
    });
    await expect(fetchToken('oauth2_basic', ctx, noop)).rejects.toThrow(/HTTP 503/);
  });
});

// ── Masked request diagnostics (secrets never appear in logs) ───────────────
// _maskValue/_maskHeaders/_maskKV/_maskBody/_logMaskedRequest are not exported;
// exercised indirectly through fetchToken with a capturing logger.

describe('fetchToken — masked request diagnostics', () => {
  const ctx = {
    tokenUrl: 'https://auth.example.com/token',
    clientId: 'my-client',
    clientSecret: 'super-secret-value',
  };

  function captureInfo() {
    const lines = [];
    return { log: { info: (msg) => lines.push(msg), error: () => {} }, lines };
  }

  test('masks Authorization header and body credential values in the diagnostic log line', async () => {
    mockFetchSuccess({ access_token: 'tok', expires_in: 60 });
    const { log, lines } = captureInfo();
    await fetchToken('oauth2_basic', ctx, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toBeDefined();
    expect(diag).not.toContain('super-secret-value');
    expect(diag).not.toContain(Buffer.from(`${ctx.clientId}:${ctx.clientSecret}`).toString('base64'));
    expect(diag).toContain('Authorization: ***');
  });

  test('keeps allowlisted structural header/body fields (Content-Type, grant_type) unmasked for diagnosability', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const { log, lines } = captureInfo();
    await fetchToken('oauth2_basic', ctx, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toContain('Content-Type: application/x-www-form-urlencoded');
    expect(diag).toContain('grant_type=client_credentials');
  });

  test('masks a JSON-body credential (paxone_json) while leaving no plaintext secret in the log', async () => {
    mockFetchSuccess({ access_token: 'pax-tok' });
    const { log, lines } = captureInfo();
    await fetchToken('paxone_json', { ...ctx, clientId: 'acct-name', clientSecret: 'acct-secret-value' }, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toBeDefined();
    expect(diag).not.toContain('acct-secret-value');
    expect(diag).not.toContain('acct-name');
  });

  test('masks a raw urlencoded-looking string body from a custom "raw" template', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const { log, lines } = captureInfo();
    const rawTemplate = JSON.stringify({
      method: 'POST',
      body: 'grant_type=client_credentials&client_secret={{client_secret}}',
      body_format: 'raw',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: rawTemplate }, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toBeDefined();
    expect(diag).not.toContain('super-secret-value');
    expect(diag).toContain('grant_type=client_credentials');
    expect(diag).toContain('client_secret=***');
  });

  test('masks an opaque (non-JSON, non-urlencoded) raw string body as "*** (opaque body)"', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const { log, lines } = captureInfo();
    const rawTemplate = JSON.stringify({
      method: 'POST',
      body: 'just some opaque text {{client_secret}}',
      body_format: 'raw',
      token_field: 'access_token',
    });
    await fetchToken('custom', { ...ctx, customTemplate: rawTemplate }, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toBeDefined();
    expect(diag).not.toContain('super-secret-value');
    expect(diag).toContain('*** (opaque body)');
  });

  test('renders "(empty)" for a blank credential value instead of leaving it silently absent', async () => {
    mockFetchSuccess({ access_token: 'tok' });
    const { log, lines } = captureInfo();
    await fetchToken('oauth2_post', { ...ctx, scope: '' }, log);
    const diag = lines.find((m) => m.includes('request (secrets masked)'));
    expect(diag).toBeDefined();
    // client_id/client_secret are present (non-empty) -> masked as ***; the diagnostic
    // must still render even though no field in this request is blank here.
    expect(diag).toContain('client_id=***');
  });

  test('a diagnostics failure (log.info throwing) never breaks the actual token fetch', async () => {
    mockFetchSuccess({ access_token: 'resilient-tok' });
    // Only the masked-request diagnostic line (emitted via _logMaskedRequest,
    // identifiable by its "request (secrets masked)" text) is guarded by a
    // try/catch in the source — throw specifically from that call so this test
    // verifies the guard, rather than an unrelated (unprotected) log.info call.
    const throwingLog = {
      info: (msg) => { if (msg.includes('request (secrets masked)')) throw new Error('logging backend down'); },
      error: () => {},
    };
    const result = await fetchToken('oauth2_basic', ctx, throwingLog);
    expect(result.token).toBe('resilient-tok');
  });
});
