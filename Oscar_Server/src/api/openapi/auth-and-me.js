// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { bearer, open, queryParam, jsonBody } = require('./common');

const TOKEN = queryParam('token', 'The token of the link sent by e-mail (required)');
const PROVIDER = { name: 'X-Provider-Id', in: 'header', required: false, description: 'A provider of the own company; none or empty = the own company', schema: { type: 'string' } };
const AUTH_LIMIT = 'Shares the sign-in rate limit of /v1/auth (by default 50 requests in 15 minutes per address).';
const LINK_ANSWERS = { 400: { description: 'No token' }, 404: { description: 'Unknown or already used link' }, 410: { description: 'The link has expired' }, 429: { description: 'Too many attempts' } };
// Two-factor authentication (#1414).
const MFA_STEP = 'No session: the mfa_token of the sign-in stands for the account (#1414).';
const MFA_CODES = 'A code is six digits; the code of the step before or after is taken, never the same code twice. Ten wrong codes in 15 minutes stop the account\'s codes until the window ends (429 with Retry-After).';
const MFA_LIMIT = 'At most 50 requests in 15 minutes per address (AUTH_RATE_LIMIT_MAX), in a bucket of their own.';
const ME_MFA_LIMIT = 'At most 50 requests in 15 minutes per address (AUTH_RATE_LIMIT_MAX).';
const MFA_429 = { description: 'Too many attempts, or too many wrong codes for the account' };
const CREDENTIALS_WHO ='For the signed-in user and the company or provider of the request (X-Provider-Id; one the user may not use = 404). An administrator or certifier keeps one set, for its own company.';

module.exports = {
  '/v1/auth/password-reset/check-token': {
    get: { tags: ['Auth'], summary: 'Is a password-reset link still valid?', security: open,
      description: 'Checks the token of the link only. Answer { email } of the account. At most 30 checks in 15 minutes per address (shared with the confirmation).',
      parameters: [TOKEN],
      responses: { 200: { description: 'Valid: { email }' }, ...LINK_ANSWERS } },
  },
  '/v1/auth/password-reset/confirm': {
    post: { tags: ['Auth'], summary: 'Set a new password with a password-reset link', security: open,
      description: 'Body: { token, password } (12 to 200 characters, an upper-case letter, a lower-case letter and a digit). The link can be used once. At most 30 attempts in 15 minutes per address (shared with the check).',
      requestBody: jsonBody('{ token, password }'),
      responses: { 200: { description: 'Password changed' }, 400: { description: 'A field refused' }, 404: { description: 'Unknown or already used link, or the account is gone' }, 410: { description: 'The link has expired' }, 429: { description: 'Too many attempts' } } },
  },
  '/v1/auth/password-reset/request': {
    post: { tags: ['Auth'], summary: 'Send a password-reset link by e-mail', security: open,
      description: 'Body: { email }. Answers the same message whether or not an account has that address. A new link replaces the previous one and is valid 24 hours. Without mail configured (development), the answer holds the link. At most 5 requests an hour per address.',
      requestBody: jsonBody('{ email }'),
      responses: { 200: { description: 'The same message in every case' }, 400: { description: 'Not an e-mail address' }, 429: { description: 'Too many requests' } } },
  },
  '/v1/auth/register/check-token': {
    get: { tags: ['Auth'], summary: 'Is a registration link still valid?', security: open,
      description: `Read by the page that confirms the e-mail of an access request. Answer { email, companyName } (the company as typed). ${AUTH_LIMIT}`,
      parameters: [TOKEN],
      responses: { 200: { description: 'Valid: { email, companyName }' }, ...LINK_ANSWERS } },
  },
  '/v1/auth/sso-check': {
    get: { tags: ['Auth'], summary: 'Is the session an administrator\'s? (for the reverse proxy)', security: bearer,
      description: 'Asked by the reverse proxy before it lets a request through to the monitoring tools. An administrator\'s session answers 200 { ok: true } with the X-User-Email and X-User-Role headers, X-User-Role being the role Grafana gives that user (Editor: Explore included, #1193); no session, or an ended one, 401 (the proxy then sends the browser to the sign-in page); a session that is not an administrator\'s, 403 (#1199). Not cached. At most 600 checks in 5 minutes per address.',
      responses: { 200: { description: 'An administrator' }, 401: { description: 'No session, or an ended one' }, 403: { description: 'A session, not an administrator\'s' }, 429: { description: 'Too many checks' } } },
  },
  '/v1/auth/bootstrap/platform-user': {
    post: { tags: ['Auth'], summary: 'Create the first administrator with the server\'s bootstrap token', security: open,
      description: `No session: the X-Platform-Bootstrap-Token header must equal the server's PLATFORM_BOOTSTRAP_TOKEN (compared in constant time); without that setting the route answers 503. Body: { email, password, role? } (role administrator, the default, or certification_user; the password rules of a reset). The user joins the platform company. ${AUTH_LIMIT}`,
      parameters: [{ name: 'X-Platform-Bootstrap-Token', in: 'header', required: true, schema: { type: 'string' } }],
      requestBody: jsonBody('{ email, password, role? }'),
      responses: { 201: { description: '{ user: { id, email, role, company_id } }' }, 400: { description: 'A field refused' }, 401: { description: 'Wrong or missing bootstrap token' }, 409: { description: 'An active administrator already exists (administrator_exists: true): the route creates the first one only (#1365). Or the e-mail is already registered' }, 429: { description: 'Too many attempts' }, 503: { description: 'No bootstrap token configured' } } },
  },
  '/v1/auth/mfa/verify': {
    post: { tags: ['Auth'], summary: 'Second step of a sign-in: the code of the authenticator app', security: open,
      description: `${MFA_STEP} Body: { mfa_token, code } (mfa_token answered by /v1/auth/login with mfa "verify", valid 5 minutes). Answer: the session, as /v1/auth/login gives it ({ token, user, company } and the session cookie). ${MFA_CODES} ${MFA_LIMIT}`,
      requestBody: jsonBody('{ mfa_token, code }'),
      responses: { 200: { description: 'The session' }, 400: { description: 'Not six digits, or a field missing' }, 401: { description: 'The sign-in expired: sign in again' }, 403: { description: 'Wrong code, or one already used' }, 429: MFA_429 } },
  },
  '/v1/auth/mfa/setup': {
    post: { tags: ['Auth'], summary: 'Set up the second factor during a sign-in (an administrator without one)', security: open,
      description: `${MFA_STEP} Body: { mfa_token } (answered by /v1/auth/login with mfa "setup", valid 10 minutes). Answer: { secret (base32), otpauth_uri, qr (the QR code of otpauth_uri, an SVG data: URL) }. A new secret each call, kept encrypted and pending until /v1/auth/mfa/setup/confirm; never answered again. ${MFA_LIMIT}`,
      requestBody: jsonBody('{ mfa_token }'),
      responses: { 200: { description: '{ secret, otpauth_uri, qr }' }, 400: { description: 'A field missing' }, 401: { description: 'The sign-in expired, or the account needs no set-up' }, 429: MFA_429 } },
  },
  '/v1/auth/mfa/setup/confirm': {
    post: { tags: ['Auth'], summary: 'Turn the second factor on with its first code, and sign in', security: open,
      description: `${MFA_STEP} Body: { mfa_token, code }. The first code of the pending secret turns the factor on; every other session of the account ends. Answer: the session, as /v1/auth/login gives it. ${MFA_CODES} ${MFA_LIMIT}`,
      requestBody: jsonBody('{ mfa_token, code }'),
      responses: { 200: { description: 'The factor is on; the session' }, 400: { description: 'Not six digits, or a field missing' }, 401: { description: 'The sign-in expired, or the factor is already on' }, 403: { description: 'Wrong code' }, 409: { description: 'Nothing is being set up: call /v1/auth/mfa/setup first' }, 429: MFA_429 } },
  },
  '/v1/me/mfa': {
    get: { tags: ['Auth'], summary: 'My second factor: on or off, required or not', security: bearer,
      description: `Answer: { enabled, required (an administrator's), enabled_at }. ${ME_MFA_LIMIT}`,
      responses: { 200: { description: '{ enabled, required, enabled_at }' }, 401: { description: 'Not signed in' }, 429: MFA_429 } },
    delete: { tags: ['Auth'], summary: 'Turn my second factor off (not for an administrator)', security: bearer,
      description: `Body: { password, code }. An administrator's factor is required: 403 (another administrator resets it). Every session of the account ends; the answer carries the new one ({ enabled: false, required, enabled_at, token, user, company } and the cookie). ${MFA_CODES} ${ME_MFA_LIMIT}`,
      requestBody: jsonBody('{ password, code }'),
      responses: { 200: { description: 'Off; the new session' }, 400: { description: 'A field refused' }, 401: { description: 'Not signed in' }, 403: { description: 'Wrong password or code, or an administrator' }, 409: { description: 'The factor is not on' }, 429: MFA_429 } },
  },
  '/v1/me/mfa/setup': {
    post: { tags: ['Auth'], summary: 'Start turning my second factor on', security: bearer,
      description: `Body: { password } (asked again). Answer: { secret (base32), otpauth_uri, qr (an SVG data: URL) }; the secret is kept encrypted and pending until /v1/me/mfa/confirm, and never answered again. ${ME_MFA_LIMIT}`,
      requestBody: jsonBody('{ password }'),
      responses: { 200: { description: '{ secret, otpauth_uri, qr }' }, 400: { description: 'A field refused' }, 401: { description: 'Not signed in' }, 403: { description: 'Wrong password' }, 409: { description: 'The factor is already on' }, 429: MFA_429 } },
  },
  '/v1/me/mfa/confirm': {
    post: { tags: ['Auth'], summary: 'Turn my second factor on with its first code', security: bearer,
      description: `Body: { code }. Every session of the account ends; the answer carries the new one ({ enabled: true, required, enabled_at, token, user, company } and the cookie). ${MFA_CODES} ${ME_MFA_LIMIT}`,
      requestBody: jsonBody('{ code }'),
      responses: { 200: { description: 'On; the new session' }, 400: { description: 'Not six digits' }, 401: { description: 'Not signed in' }, 403: { description: 'Wrong code' }, 409: { description: 'Already on, or nothing being set up' }, 429: MFA_429 } },
  },
  '/v1/auth/logout': {
    post: { tags: ['Auth'], summary: 'Sign out: the session token is revoked and the cookie cleared', security: bearer,
      description: 'The token (from the session cookie, else the Authorization header) is refused from then on, until it would have expired. Answer { logged_out: true }.',
      responses: { 200: { description: 'Signed out' }, 401: { description: 'Not signed in' } } },
  },
  '/v1/me/credentials': {
    get: { tags: ['Company'], summary: 'My OSDM credentials for the company or provider of the request, without their values', security: bearer,
      description: `${CREDENTIALS_WHO} Answer: auth_mode, token_url, oauth_profile, oauth_scope, oauth_custom_template, cached_token_expires_at, and has_* booleans saying which secrets are set (token, client id and secret, extra, cached token, requestor, subscription key); no secret is returned. At most 120 requests a minute per address.`,
      parameters: [PROVIDER],
      responses: { 200: { description: 'The credentials, without secrets' }, 401: { description: 'Not signed in' }, 404: { description: 'No such provider for this user, or the account no longer exists' }, 429: { description: 'Too many requests' } } },
    patch: { tags: ['Company'], summary: 'Change my OSDM credentials for the company or provider of the request', security: bearer,
      description: `${CREDENTIALS_WHO} Body: any of { auth_mode (bearer | oauth2), token_url (public https address), oauth_profile, oauth_scope, oauth_extra, oauth_custom_template (JSON text), access_token, client_id, client_secret, requestor, subscription_key }; a field left out is kept, a secret sent empty or null is removed. Secrets are trimmed and encrypted; changing what the token is made from clears the cached token. Answers as GET. Audited with the names of the fields changed, never their values.`,
      parameters: [PROVIDER],
      requestBody: jsonBody('The fields to change'),
      responses: { 200: { description: 'The credentials, without secrets' }, 400: { description: 'A field refused, or nothing to change' }, 401: { description: 'Not signed in' }, 404: { description: 'No such provider for this user' }, 429: { description: 'Too many requests' } } },
  },
};
