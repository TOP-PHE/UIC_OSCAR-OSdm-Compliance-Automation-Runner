// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #872: what "Test my credentials" tells, from the provider's answer to
 * GET /versions and the token resolver's message (pure).
 */

const O = require('../../src/utils/credentialTestOutcome');

describe('classifyVersionsAnswer', () => {
  test('2xx: the token is accepted and the OSDM versions are listed', () => {
    const text = JSON.stringify([{ version: '3.7.0' }, { version: ' 3.8.0 ', sunset: '2027-01-01T00:00:00Z' }, { nextVersion: {} }, null, { version: 7 }]);
    expect(O.classifyVersionsAnswer(200, text)).toEqual({ ok: true, outcome: 'accepted', status: 200, versions: ['3.7.0', '3.8.0'], versionsReadable: true });
    expect(O.classifyVersionsAnswer(204, '')).toEqual({ ok: true, outcome: 'accepted', status: 204, versions: [], versionsReadable: false });
  });

  test('a 2xx that is not a list is still an accepted token, said not readable', () => {
    for (const text of ['<html>Request Rejected</html>', '{"version":"3.8.0"}', '"3.8"']) {
      expect(O.classifyVersionsAnswer(200, text)).toMatchObject({ outcome: 'accepted', versions: [], versionsReadable: false });
    }
  });

  test('the list is bounded', () => {
    const many = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ version: `3.${i}.0${'x'.repeat(60)}` })));
    const { versions } = O.classifyVersionsAnswer(200, many);
    expect(versions).toHaveLength(O.MAX_VERSIONS);
    expect(versions.every(v => v.length <= 40)).toBe(true);
  });

  test.each([[401], [403]])('%i: the provider refuses the token', (status) => {
    expect(O.classifyVersionsAnswer(status, '{}')).toEqual({ ok: false, outcome: 'token_refused', status });
  });

  test.each([[404], [405], [501]])('%i: the token is not refused, /versions is not offered', (status) => {
    expect(O.classifyVersionsAnswer(status, '')).toEqual({ ok: true, outcome: 'not_offered', status });
  });

  test.each([[301], [302], [307]])('%i: a redirect, not followed', (status) => {
    expect(O.classifyVersionsAnswer(status, '')).toEqual({ ok: false, outcome: 'redirect', status });
  });

  test.each([[400], [406], [429], [500], [502], [503]])('%i: shown as it is', (status) => {
    expect(O.classifyVersionsAnswer(status, '')).toEqual({ ok: false, outcome: 'unexpected', status });
  });
});

describe('sameVersion', () => {
  test('a missing patch is 0', () => {
    expect(O.sameVersion('3.8', '3.8.0')).toBe(true);
    expect(O.sameVersion(' 3.8.0', '3.8')).toBe(true);
    expect(O.sameVersion('3.8', '3.8.1')).toBe(false);
    expect(O.sameVersion('3.7.0', '3.8.0')).toBe(false);
    expect(O.sameVersion('3.x', '3.x')).toBe(false);
    expect(O.sameVersion(undefined, '3.8')).toBe(false);
  });
});

describe('cleanTokenError', () => {
  test('the HTTP status and the error code stay', () => {
    expect(O.cleanTokenError('OAuth2[basic] request failed — HTTP 401: invalid_client — bad client', []))
      .toBe('OAuth2[basic] request failed — HTTP 401: invalid_client — bad client');
  });

  test('an answer quoted after "Body:" is cut: it may hold a token under another name', () => {
    expect(O.cleanTokenError('Custom response did not contain field "access_token". Body: {"jwt":"eyJ.secret"}', []))
      .toBe('Custom response did not contain field "access_token".');
  });

  test('every secret given is masked, short values are left alone', () => {
    expect(O.cleanTokenError('HTTP 400: client abc-id secret s3cr3t-long and s3cr3t-long again', ['abc-id', 's3cr3t-long', 'ab', null]))
      .toBe('HTTP 400: client *** secret *** and *** again');
  });

  test('a long message is cut, an empty one has a sentence', () => {
    expect(O.cleanTokenError('x'.repeat(2000), [])).toHaveLength(500);
    expect(O.cleanTokenError(undefined, [])).toBe('The token could not be obtained.');
  });
});

describe('bearerExpiry', () => {
  const jwtWith = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const now = Date.parse('2026-10-19T12:00:00Z');

  test('the seconds left of a JWT naming exp, negative once expired', () => {
    expect(O.bearerExpiry(jwtWith({ exp: now / 1000 + 600 }), now)).toBe(600);
    expect(O.bearerExpiry(jwtWith({ exp: now / 1000 - 60 }), now)).toBe(-60);
  });

  test('nothing for a token that is no JWT, or names no exp', () => {
    expect(O.bearerExpiry('opaque-token', now)).toBeNull();
    expect(O.bearerExpiry(jwtWith({ sub: 'x' }), now)).toBeNull();
    expect(O.bearerExpiry(jwtWith({ exp: '600' }), now)).toBeNull();
    expect(O.bearerExpiry('a.!!!.c', now)).toBeNull();
    expect(O.bearerExpiry(null, now)).toBeNull();
  });
});

describe('outcomeOf and summaryOf', () => {
  const ok = { ok: true, mode: 'oauth2', profile: 'oauth2_basic' };

  test('a failed token is the outcome, whatever the API', () => {
    const result = { token: { ok: false, error: 'Bearer token not configured.' }, api: { ok: false, outcome: 'no_endpoint' } };
    expect(O.outcomeOf(result)).toBe('token_failed');
    expect(O.summaryOf(result)).toBe('No token: Bearer token not configured. No OSDM endpoint is saved here either.');
  });

  test('the framework version is compared with the list', () => {
    const api = { ok: true, outcome: 'accepted', status: 200, versions: ['3.7.0'], versionsReadable: true, frameworkVersion: '3.8', frameworkVersionListed: false };
    expect(O.outcomeOf({ token: ok, api })).toBe('accepted');
    expect(O.summaryOf({ token: ok, api })).toBe("The provider accepted the token (GET /versions answered 200). It lists OSDM 3.7.0. Your Test Framework's version 3.8 is not among them.");
    expect(O.summaryOf({ token: ok, api: { ...api, versions: [] } })).toBe('The provider accepted the token (GET /versions answered 200). Its answer lists no OSDM version.');
  });

  test('each other outcome has its sentence', () => {
    const say = api => O.summaryOf({ token: ok, api });
    expect(say({ outcome: 'token_refused', status: 403 })).toBe('The provider refused the token: GET /versions answered 403.');
    expect(say({ outcome: 'not_offered', status: 404 })).toMatch(/does not offer GET \/versions \(it answered 404\)/);
    expect(say({ outcome: 'redirect', status: 302 })).toMatch(/a redirect\. It was not followed/);
    expect(say({ outcome: 'unexpected', status: 500 })).toBe('GET /versions answered 500.');
    expect(say({ outcome: 'no_endpoint' })).toBe('No OSDM endpoint is saved here, so the API was not called.');
    expect(say({ outcome: 'url_refused', error: 'The OSDM endpoint must be https.' })).toBe('The OSDM endpoint must be https.');
    expect(say({ outcome: 'no_answer' })).toBe('The API could not be reached.');
  });
});
