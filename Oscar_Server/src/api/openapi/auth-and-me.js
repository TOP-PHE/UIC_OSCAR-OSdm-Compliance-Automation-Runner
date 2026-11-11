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
const CREDENTIALS_WHO = 'For the signed-in user and the company or provider of the request (X-Provider-Id; one the user may not use = 404). An administrator or certifier keeps one set, for its own company.';

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
      description: 'Asked by the reverse proxy before it lets a request through to the monitoring tools. An administrator\'s session answers 200 { ok: true } with the X-User-Email and X-User-Role headers, X-User-Role being the role Grafana gives that user (Editor: Explore included, #1193); any other session, or none, 401. Not cached. At most 600 checks in 5 minutes per address.',
      responses: { 200: { description: 'An administrator' }, 401: { description: 'No session, or not an administrator' }, 429: { description: 'Too many checks' } } },
  },
  '/v1/auth/bootstrap/platform-user': {
    post: { tags: ['Auth'], summary: 'Create an administrator or certifier with the server\'s bootstrap token', security: open,
      description: `No session: the X-Platform-Bootstrap-Token header must equal the server's PLATFORM_BOOTSTRAP_TOKEN (compared in constant time); without that setting the route answers 503. Body: { email, password, role? } (role administrator, the default, or certification_user; the password rules of a reset). The user joins the platform company. ${AUTH_LIMIT}`,
      parameters: [{ name: 'X-Platform-Bootstrap-Token', in: 'header', required: true, schema: { type: 'string' } }],
      requestBody: jsonBody('{ email, password, role? }'),
      responses: { 201: { description: '{ user: { id, email, role, company_id } }' }, 400: { description: 'A field refused' }, 401: { description: 'Wrong or missing bootstrap token' }, 409: { description: 'E-mail already registered' }, 429: { description: 'Too many attempts' }, 503: { description: 'No bootstrap token configured' } } },
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
