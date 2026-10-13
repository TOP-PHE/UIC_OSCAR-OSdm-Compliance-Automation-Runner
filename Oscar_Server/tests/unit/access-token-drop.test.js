// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #680: dropCachedToken() against the real database. A token the provider
 * refused with 401 is taken out of the (user, company) cache, and only if the
 * cache still holds that token.
 */

const { randomUUID } = require('node:crypto');
const { run, get, encrypt, decrypt } = require('../../src/db/db');
const { setCredentials, credentialsFor } = require('../../src/utils/testerCredentials');
const { dropCachedToken } = require('../../src/worker/access-token');

const EXP = '2099-01-01T00:00:00.000Z';

function seed(cachedToken, authMode = 'oauth2') {
  const companyId = randomUUID();
  const userId = randomUUID();
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [companyId, 'Drop Co', `drop-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role, auth_mode) VALUES (?, ?, ?, 'x', 'company_user', ?)`,
    [userId, companyId, `drop-${userId.slice(0, 8)}@drop-test.com`, authMode]);
  setCredentials(userId, companyId, {
    auth_mode: authMode,
    cached_token_enc: cachedToken ? encrypt(cachedToken) : null,
    cached_token_expires_at: cachedToken ? EXP : null,
    cached_token_cred_fp: cachedToken ? 'fp' : null,
  });
  return { userId, companyId, row: credentialsFor(userId, companyId) };
}

function cacheOf(userId, companyId) {
  return get('SELECT cached_token_enc, cached_token_expires_at, cached_token_cred_fp FROM tester_credentials WHERE user_id = ? AND company_id = ?',
    [userId, companyId]);
}

describe('dropCachedToken (#680)', () => {
  test('clears the cache when it still holds the refused token', () => {
    const { userId, companyId, row } = seed('tok-refused');
    expect(dropCachedToken(row, 'tok-refused')).toBe(true);
    expect(cacheOf(userId, companyId)).toEqual({ cached_token_enc: null, cached_token_expires_at: null, cached_token_cred_fp: null });
  });

  test('keeps the cache when it holds another token (refreshed during the run)', () => {
    const { userId, companyId, row } = seed('tok-newer');
    expect(dropCachedToken(row, 'tok-refused')).toBe(false);
    expect(decrypt(cacheOf(userId, companyId).cached_token_enc)).toBe('tok-newer');
    expect(cacheOf(userId, companyId).cached_token_expires_at).toBe(EXP);
  });

  test('does nothing when the cache is empty', () => {
    const { userId, companyId, row } = seed(null);
    expect(dropCachedToken(row, 'tok-refused')).toBe(false);
    expect(cacheOf(userId, companyId).cached_token_enc).toBeNull();
  });

  test('does nothing for a bearer token (it is the stored credential, not a cache)', () => {
    const { userId, companyId, row } = seed('tok-refused', 'bearer');
    expect(dropCachedToken(row, 'tok-refused')).toBe(false);
    expect(decrypt(cacheOf(userId, companyId).cached_token_enc)).toBe('tok-refused');
  });

  test('touches only the (user, company) row the run used', () => {
    const a = seed('tok-same');
    const b = seed('tok-same');
    expect(dropCachedToken(a.row, 'tok-same')).toBe(true);
    expect(decrypt(cacheOf(b.userId, b.companyId).cached_token_enc)).toBe('tok-same');
  });

  test('refuses what names no row or no token', () => {
    expect(dropCachedToken(null, 'x')).toBe(false);
    expect(dropCachedToken({ auth_mode: 'oauth2' }, 'x')).toBe(false);
    const { row } = seed('tok');
    expect(dropCachedToken(row, '')).toBe(false);
  });
});
