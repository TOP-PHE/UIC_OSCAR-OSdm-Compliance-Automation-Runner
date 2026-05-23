// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * access-token.test.js — unit tests for the shared per-tester token resolver
 * (extracted from runner.js in #157). The DB layer and the vendor token-fetch
 * adapter are mocked so this exercises only the resolution + cache logic.
 */

jest.mock('../../src/db/db', () => ({
  run: jest.fn(),
  // Simple reversible "encryption" so the test can assert round-trips.
  encrypt: jest.fn((s) => (s == null ? null : 'enc:' + s)),
  decrypt: jest.fn((s) => (s == null ? null : String(s).replace(/^enc:/, ''))),
}));
jest.mock('../../src/worker/auth-profiles', () => ({
  fetchToken: jest.fn(),
}));

const db = require('../../src/db/db');
const { fetchToken } = require('../../src/worker/auth-profiles');
const { resolveAccessToken } = require('../../src/worker/access-token');

const log = { info: jest.fn(), error: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('resolveAccessToken — bearer mode', () => {
  test('returns the decrypted bearer token', async () => {
    const tok = await resolveAccessToken({ auth_mode: 'bearer', access_token_enc: 'enc:abc123' }, log);
    expect(tok).toBe('abc123');
    expect(fetchToken).not.toHaveBeenCalled();
  });

  test('throws when no bearer token is configured', async () => {
    await expect(
      resolveAccessToken({ auth_mode: 'bearer', access_token_enc: null }, log)
    ).rejects.toThrow(/Bearer token not configured/);
  });
});

describe('resolveAccessToken — oauth2 missing fields', () => {
  test('names every missing credential', async () => {
    await expect(
      resolveAccessToken({ auth_mode: 'oauth2', oauth_profile: 'oauth2_basic' }, log)
    ).rejects.toThrow(/missing: token_url, client_id, client_secret/);
  });

  test('flags the Sqills extra credential when required', async () => {
    await expect(
      resolveAccessToken({
        auth_mode: 'oauth2', oauth_profile: 'sqills_extension',
        token_url: 'https://t', client_id_enc: 'enc:c', client_secret_enc: 'enc:s',
        oauth_extra_enc: null,
      }, log)
    ).rejects.toThrow(/extra credential/);
  });
});

describe('resolveAccessToken — oauth2 cache', () => {
  const base = {
    id: 'u1', auth_mode: 'oauth2', oauth_profile: 'oauth2_basic',
    token_url: 'https://token', client_id_enc: 'enc:cid', client_secret_enc: 'enc:secret',
    oauth_scope: '',
  };

  test('reuses a still-valid cached token without fetching', async () => {
    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const tok = await resolveAccessToken(
      { ...base, cached_token_enc: 'enc:cachedtok', cached_token_expires_at: future }, log
    );
    expect(tok).toBe('cachedtok');
    expect(fetchToken).not.toHaveBeenCalled();
  });

  test('refetches when the cache is expired/within margin and persists when expires_in is given', async () => {
    fetchToken.mockResolvedValue({ token: 'freshtok', expiresIn: 3600 });
    const past = new Date(Date.now() - 1000).toISOString();
    const tok = await resolveAccessToken(
      { ...base, cached_token_enc: 'enc:old', cached_token_expires_at: past }, log
    );
    expect(tok).toBe('freshtok');
    // fetchToken received the decrypted client credentials.
    expect(fetchToken).toHaveBeenCalledWith('oauth2_basic', expect.objectContaining({
      tokenUrl: 'https://token', clientId: 'cid', clientSecret: 'secret',
    }), log);
    // Cache persisted with the encrypted token + an expiry.
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('cached_token_enc = ?'),
      expect.arrayContaining(['enc:freshtok'])
    );
  });

  test('clears the cache when the vendor returns no expires_in', async () => {
    fetchToken.mockResolvedValue({ token: 'freshtok', expiresIn: null });
    const tok = await resolveAccessToken({ ...base }, log);
    expect(tok).toBe('freshtok');
    expect(db.run).toHaveBeenCalledWith(
      expect.stringContaining('cached_token_enc = NULL'),
      ['u1']
    );
  });
});
