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
});
