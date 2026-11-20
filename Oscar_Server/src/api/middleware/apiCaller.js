// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * apiCaller.js — who calls /v1/api: a read-only API key (#503), or a Company
 * API account with an access token from POST /v1/api/oauth/token (#1342).
 *
 * The bearer token decides: an `oscar_…` key goes to requireApiKey(), as
 * before; anything else must be an access token (utils/apiAccessTokens.js).
 * The account is read again at each call: still of role api_client, active,
 * of its company, and the token issued after any suspension
 * (users.sessions_valid_after). Every refusal is the same 401. It then sets
 *   req.apiAccount = { id, companyId, scopes }
 *   req.user       = { id, email, companyId, role: 'api_client' }
 *   req.scopes     = the token's scopes (for a key, the key's)
 * canUserSeeRun() gives the role api_client the runs it launched.
 */

const { get } = require('../../db/db');
const { looksLikeKey } = require('../../utils/apiKeys');
const Tokens = require('../../utils/apiAccessTokens');
const { requireApiKey } = require('./apiKey');

const REFUSED = { status: 401, title: 'Unauthorized', detail: 'Missing, invalid, expired or revoked API key.' };

function bearerOf(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** The account an access token stands for now, or null. Never throws. */
function accountOf(token, now = new Date()) {
  try {
    const claims = Tokens.verify(token, now);
    if (!claims) return null;
    const row = get(`SELECT u.id, u.email, u.role, u.status, u.company_id, u.sessions_valid_after
                       FROM users u JOIN api_account a ON a.user_id = u.id AND a.company_id = u.company_id
                      WHERE u.id = ?`, [claims.accountId]);
    if (row?.role !== 'api_client' || row.status !== 'active') return null;
    const validAfter = Number(row.sessions_valid_after) || 0;
    // A token issued before a suspension stays refused, and one without a
    // numeric issue time too.
    const issuedAt = Number(claims.iat);
    if (validAfter && (!Number.isFinite(issuedAt) || issuedAt < validAfter)) return null;
    return { row, scopes: claims.scopes };
  } catch {
    return null;
  }
}

function requireApiCaller(req, res, next) {
  const token = bearerOf(req);
  if (!token) return res.status(401).json(REFUSED);
  if (looksLikeKey(token)) {
    return requireApiKey(req, res, (err) => {
      if (err) return next(err);
      req.scopes = req.apiKey.scopes;
      return next();
    });
  }
  const found = accountOf(token);
  if (!found) return res.status(401).json(REFUSED);
  const { row, scopes } = found;
  req.apiAccount = { id: row.id, companyId: row.company_id, scopes };
  req.user = { id: row.id, email: row.email, companyId: row.company_id, role: 'api_client' };
  req.companyId = row.company_id;
  req.scopes = scopes;
  return next();
}

/** Refuses a caller whose key or token does not hold `scope` (403 insufficient_scope). */
function needScope(scope) {
  return (req, res, next) => {
    if (Array.isArray(req.scopes) && req.scopes.includes(scope)) return next();
    res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: `This needs the scope ${scope}.` });
  };
}

module.exports = { requireApiCaller, needScope, accountOf };
