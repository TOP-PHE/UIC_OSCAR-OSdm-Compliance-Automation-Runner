// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-oauth.js — the token endpoint of Company API accounts (#1342, D2).
 *
 *   POST /v1/api/oauth/token   (application/x-www-form-urlencoded)
 *     grant_type=client_credentials
 *     client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer
 *     client_assertion=<JWT signed with the account's private key>
 *     scope=runs:read runs:write   (optional: both when absent)
 *     client_id=<the account's id> (optional; when sent, the assertion's iss)
 *
 * OAuth 2.0 client credentials (RFC 6749 §4.4) with private_key_jwt client
 * authentication (RFC 7523): the assertion is checked against the account's
 * public keys (utils/clientAssertion.js), its jti is accepted once, and the
 * account must be active. The answer is RFC 6749 §5.1, never cached; an error
 * is §5.2 ({ error, error_description }), and a client the server does not
 * accept is always the same invalid_client, so the answer does not tell an
 * unknown account from a wrong key.
 *
 * Mounted before /v1/api, whose router asks for a key or a token on every
 * route. No session, no cookie: only the form.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { get, all, run } = require('../../db/db');
const { auditLog } = require('../helpers/shared');
const CA = require('../../utils/clientAssertion');
const Tokens = require('../../utils/apiAccessTokens');
const log = require('../../utils/logger').child({ module: 'api-oauth' });

const router = express.Router();

// Per address: a CI asks a token every quarter of an hour, an attacker more.
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => oauthError(res, 429, 'slow_down', 'Too many token requests from this address — wait a moment.'),
});

function oauthError(res, status, error, description) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.status(status).json({ error, error_description: description });
}

const INVALID_CLIENT = 'The client assertion was not accepted: check the account, its key, the assertion\'s iss, sub, aud, exp and jti.';

// The account's active keys, as clientAssertion.js reads them.
function keysOf(accountId) {
  return all(`SELECT id, alg, public_key AS pem, fingerprint FROM api_account_key
               WHERE user_id = ? AND revoked_at IS NULL`, [accountId]);
}

// Records the assertion's jti; false when it was used before.
function firstUse(accountId, jti, exp, now) {
  run('DELETE FROM api_assertion_jti WHERE expires_at < ?', [Math.floor(now.getTime() / 1000)]);
  const done = run('INSERT OR IGNORE INTO api_assertion_jti (user_id, jti, expires_at) VALUES (?, ?, ?)',
    [accountId, jti, exp + CA.CLOCK_TOLERANCE_S]);
  return Number(done?.changes) === 1;
}

// The form's own refusal, as [status, error, description], or null.
function formRefusal(req, body) {
  if (!req.is('application/x-www-form-urlencoded')) {
    return [400, 'invalid_request', 'Send the request as application/x-www-form-urlencoded (RFC 6749).'];
  }
  if (body.grant_type !== 'client_credentials') return [400, 'unsupported_grant_type', 'grant_type must be client_credentials.'];
  if (body.client_assertion_type !== CA.ASSERTION_TYPE || typeof body.client_assertion !== 'string') {
    return [401, 'invalid_client', `Authenticate with private_key_jwt: client_assertion_type=${CA.ASSERTION_TYPE} and a client_assertion.`];
  }
  return null;
}

// The client the assertion authenticates: { account, checked } with
// checked.ok, or null when it names no account at all.
function authenticated(body, base, now) {
  const claimed = CA.peek(body.client_assertion)?.payload?.iss;
  const clientId = typeof claimed === 'string' && /^[0-9a-fA-F-]{36}$/.test(claimed) ? claimed : null;
  if (!clientId || (body.client_id !== undefined && body.client_id !== clientId)) return null;
  const account = get(`SELECT u.id, u.email, u.status, u.company_id FROM users u
                         JOIN api_account a ON a.user_id = u.id AND a.company_id = u.company_id
                        WHERE u.id = ? AND u.role = 'api_client'`, [clientId]);
  if (account?.status !== 'active') return { account, checked: { ok: false, why: account ? 'account suspended' : 'no such account' } };
  const checked = CA.verifyAssertion(body.client_assertion, { clientId, keys: keysOf(clientId), audiences: [`${base}${Tokens.TOKEN_PATH}`, base], now });
  if (checked.ok && !firstUse(clientId, checked.jti, checked.exp, now)) return { account, checked: { ok: false, why: 'jti used before' } };
  return { account, checked };
}

router.post('/token', tokenLimiter, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const refusal = formRefusal(req, body);
  if (refusal) return oauthError(res, ...refusal);
  const base = Tokens.oscarBase(req);
  if (!base) return oauthError(res, 503, 'temporarily_unavailable', 'APP_URL is not set on the server: the token endpoint cannot check an assertion\'s aud.');

  const now = new Date();
  const client = authenticated(body, base, now);
  if (!client?.checked.ok) {
    if (client) log.info({ client: client.account?.id || null, why: client.checked.why }, 'client assertion refused');
    return oauthError(res, 401, 'invalid_client', INVALID_CLIENT);
  }
  const { account, checked } = client;
  const scopes = Tokens.scopesOf(body.scope);
  if (scopes.error) return oauthError(res, 400, 'invalid_scope', `scope must be one or more of: ${Tokens.SCOPES.join(' ')}.`);

  const issued = Tokens.issue(account.id, scopes.scopes, now, checked.keyId);
  try { run("UPDATE api_account_key SET last_used_at = datetime('now') WHERE id = ?", [checked.keyId]); } catch { /* never block a token on the bookkeeping */ }
  auditLog(account.id, account.company_id, account.email, `api_token_issued:${scopes.scopes.join(',')}`);
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.json({ access_token: issued.token, token_type: 'Bearer', expires_in: issued.expiresIn, scope: scopes.scopes.join(' ') });
});

// Anything else under /v1/api/oauth: no such route, said as the API says it.
router.use((req, res) => {
  res.status(404).json({ status: 404, title: 'Not Found', detail: 'The API has no such route.' });
});

module.exports = router;
