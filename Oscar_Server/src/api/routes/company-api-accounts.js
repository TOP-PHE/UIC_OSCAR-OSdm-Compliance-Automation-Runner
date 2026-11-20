// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-api-accounts.js — a company's Company API accounts (#1342, D1).
 *
 *   GET    /v1/company/api-accounts                    — the accounts of the company
 *   POST   /v1/company/api-accounts                    — make one: { name, providers }
 *   GET    /v1/company/api-accounts/:id                — one account
 *   PATCH  /v1/company/api-accounts/:id                — rename it, set its providers
 *   POST   /v1/company/api-accounts/:id/suspend        — stop it at once
 *   POST   /v1/company/api-accounts/:id/resume         — let it work again
 *   DELETE /v1/company/api-accounts/:id                — delete it, and its runs
 *   GET    /v1/company/api-accounts/:id/credentials    — its OSDM credentials (shown as "set?")
 *   PATCH  /v1/company/api-accounts/:id/credentials    — save them
 *   POST   /v1/company/api-accounts/:id/credentials/test — test what is saved
 *   GET    /v1/company/api-accounts/:id/keys          — its public keys (private_key_jwt, #1342 D2)
 *   POST   /v1/company/api-accounts/:id/keys          — add one: { public_key } (PEM), two active at most
 *   DELETE /v1/company/api-accounts/:id/keys/:keyId   — revoke one
 *
 * Test Managers only. An account belongs to the distributor (the request's
 * company, or the distributor of the provider it names); the providers it may
 * use are rows of provider_access, as a tester's. Its OSDM credentials are
 * kept per company or provider, the one the request names (X-Provider-Id),
 * which the account must be given. They are saved through the same rule as a
 * tester's own (helpers/credentialsInput.js) and are never shown.
 *
 * An account never signs in to the pages (sessionUser() refuses its role): it
 * has no password anyone knows and a made-up e-mail under .invalid
 * (utils/apiAccounts.js). Everything here is audited, never with a secret.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const crypto = require('node:crypto');
const bcrypt = require('bcrypt');
const { get, all, run, transaction } = require('../../db/db');
const { requireAuth, END_SESSIONS_SQL } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog } = require('../helpers/shared');
const { canUseCompany } = require('../helpers/provider-access');
const { credentialsFor } = require('../../utils/testerCredentials');
const { safeUserCreds, credentialFieldsOf, saveCredentialFields } = require('../helpers/credentialsInput');
const { testCredentials } = require('../../services/credentialTest');
const { deleteUserAccount } = require('../../utils/userDeletion');
const keptPods = require('../../worker/keptPods');
const A = require('../../utils/apiAccounts');
const CA = require('../../utils/clientAssertion');
const Tokens = require('../../utils/apiAccessTokens');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});
// Each test calls the provider's token endpoint and its GET /versions.
const testLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req, res) => `api-account-test:${req.user?.id || ipKeyGenerator(req, res)}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'At most 10 credential tests a minute. Wait a moment and try again.' },
});

router.use(limiter, requireAuth, enforceTenant, (req, res, next) => {
  if (req.user.role !== 'test_manager') {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers manage Company API accounts.' });
  }
  return next();
});

const NOT_FOUND = Object.freeze({ status: 404, title: 'Not Found', detail: 'No such Company API account here.' });
const bad = (res, detail) => res.status(400).json({ status: 400, title: 'Bad Request', detail });

// The distributor of the request: its company, or the parent of the provider it names.
function distributorOf(req) {
  const row = get('SELECT id, name, parent_id FROM companies WHERE id = ?', [req.companyId]);
  if (!row) return null;
  return row.parent_id ? get('SELECT id, name, parent_id FROM companies WHERE id = ?', [row.parent_id]) : row;
}

// The account as the provider rule reads a member.
const principalOf = (account, companyId) => ({ id: account.id, companyId, role: A.ROLE });

function accountRow(id, companyId) {
  if (typeof id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(id)) return null;
  return get(`SELECT a.user_id AS id, a.name, a.created_at, a.suspended_at, u.status, u.email,
                     cb.email AS created_by_email, sb.email AS suspended_by_email
                FROM api_account a
                JOIN users u ON u.id = a.user_id AND u.role = ?
                LEFT JOIN users cb ON cb.id = a.created_by
                LEFT JOIN users sb ON sb.id = a.suspended_by
               WHERE a.user_id = ? AND a.company_id = ?`, [A.ROLE, id, companyId]);
}

function providersOf(accountId, distributorId) {
  return all(`SELECT c.id, c.name FROM provider_access pa JOIN companies c ON c.id = pa.company_id
               WHERE pa.user_id = ? AND c.parent_id = ? ORDER BY c.name`, [accountId, distributorId]);
}

// What a run needs from the account there (the rule of POST /v1/runs and of
// the API Config page's credentialsSet()).
function credentialsSet(c) {
  if (!c) return false;
  if (c.auth_mode === 'oauth2') return !!(c.token_url && c.client_id_enc && c.client_secret_enc);
  return !!c.access_token_enc;
}

// What a client needs to ask a token: its id and the token endpoint (null
// when APP_URL is not set in production: the endpoint then answers 503).
function signInOf(req, accountId) {
  const base = Tokens.oscarBase(req);
  const active = get('SELECT COUNT(*) AS n FROM api_account_key WHERE user_id = ? AND revoked_at IS NULL', [accountId]).n;
  return { client_id: accountId, token_url: base ? base + Tokens.TOKEN_PATH : null, active_keys: active };
}

function accountView(row, distributor, req) {
  const providers = providersOf(row.id, distributor.id);
  const places = [{ id: distributor.id, name: distributor.name }, ...providers];
  return {
    id: row.id,
    name: row.name,
    status: row.status === 'active' ? 'active' : 'suspended',
    account_email: row.email,
    providers,
    credentials: places.map(p => ({ company_id: p.id, company_name: p.name, set: credentialsSet(credentialsFor(row.id, p.id)) })),
    created_by: row.created_by_email || null,
    created_at: row.created_at,
    suspended_at: row.suspended_at || null,
    suspended_by: row.suspended_by_email || null,
    ...(req ? signInOf(req, row.id) : {}),
  };
}

// The providers of a body, each a provider of the distributor: { ids } or { error }.
function checkedProviders(value, distributor) {
  const given = A.providerIdsOf(value);
  if (given.error) return given;
  for (const id of given.ids) {
    if (!get('SELECT 1 AS ok FROM companies WHERE id = ? AND parent_id = ?', [id, distributor.id])) {
      return { error: 'Each provider must be a provider of your company.' };
    }
  }
  return given;
}

const nameTaken = (name, companyId, exceptId = '') => !!get(
  'SELECT 1 AS ok FROM api_account WHERE company_id = ? AND lower(name) = lower(?) AND user_id != ?',
  [companyId, name, exceptId]);

// The account of the request's :id in its distributor, or the answer already sent.
function loaded(req, res) {
  const distributor = distributorOf(req);
  const row = distributor && accountRow(req.params.id, distributor.id);
  if (!row) { res.status(404).json(NOT_FOUND); return null; }
  return { distributor, row };
}

// Every company or provider the account may use: its distributor and its providers.
function placesOf(accountId, distributorId) {
  return [distributorId, ...providersOf(accountId, distributorId).map(p => p.id)];
}

router.get('/', (req, res) => {
  const distributor = distributorOf(req);
  if (!distributor) return res.status(404).json(NOT_FOUND);
  const rows = all(`SELECT a.user_id AS id FROM api_account a WHERE a.company_id = ? ORDER BY a.created_at DESC, a.user_id`, [distributor.id]);
  return res.json({
    company: { id: distributor.id, name: distributor.name },
    max_accounts: A.MAX_PER_COMPANY,
    accounts: rows.map(r => accountView(accountRow(r.id, distributor.id), distributor, req)),
  });
});

router.post('/', async (req, res) => {
  const distributor = distributorOf(req);
  if (!distributor) return res.status(404).json(NOT_FOUND);
  const body = req.body || {};
  const name = A.nameOf(body.name);
  if (name.error) return bad(res, name.error);
  const providers = checkedProviders(body.providers, distributor);
  if (providers.error) return bad(res, providers.error);
  if (nameTaken(name.name, distributor.id)) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Another Company API account of your company has this name.' });
  }
  const count = get('SELECT COUNT(*) AS n FROM api_account WHERE company_id = ?', [distributor.id]).n;
  if (count >= A.MAX_PER_COMPANY) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `A company has at most ${A.MAX_PER_COMPANY} Company API accounts: delete one first.` });
  }

  // A password nobody knows, never shown: the account signs in to no page.
  const unusable = await bcrypt.hash(crypto.randomBytes(32).toString('base64'), 12);
  const id = crypto.randomUUID();
  transaction(() => {
    run(`INSERT INTO users (id, company_id, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?, 'active')`,
      [id, distributor.id, A.emailFor(name.name), unusable, A.ROLE]);
    run('INSERT INTO api_account (user_id, company_id, name, created_by) VALUES (?, ?, ?, ?)',
      [id, distributor.id, name.name, req.user.id]);
    for (const p of providers.ids) {
      run('INSERT OR IGNORE INTO provider_access (company_id, user_id, granted_by) VALUES (?, ?, ?)', [p, id, req.user.email]);
    }
  });
  auditLog(req.user.id, distributor.id, req.user.email, `api_account_created:${id}`);
  return res.status(201).json(accountView(accountRow(id, distributor.id), distributor, req));
});

router.get('/:id', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  return res.json(accountView(found.row, found.distributor, req));
});

router.patch('/:id', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  const body = req.body || {};
  if (body.name === undefined && body.providers === undefined) return bad(res, 'Nothing to change: send name, providers or both.');
  let name = null;
  if (body.name !== undefined) {
    const given = A.nameOf(body.name);
    if (given.error) return bad(res, given.error);
    if (nameTaken(given.name, distributor.id, row.id)) {
      return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Another Company API account of your company has this name.' });
    }
    name = given.name;
  }
  let providers = null;
  if (body.providers !== undefined) {
    providers = checkedProviders(body.providers, distributor);
    if (providers.error) return bad(res, providers.error);
  }
  const before = providersOf(row.id, distributor.id).map(p => p.id);
  const removed = providers ? before.filter(p => !providers.ids.includes(p)) : [];
  transaction(() => {
    if (name !== null) run('UPDATE api_account SET name = ? WHERE user_id = ?', [name, row.id]);
    if (providers) {
      for (const p of removed) run('DELETE FROM provider_access WHERE company_id = ? AND user_id = ?', [p, row.id]);
      for (const p of providers.ids) {
        run('INSERT OR IGNORE INTO provider_access (company_id, user_id, granted_by) VALUES (?, ?, ?)', [p, row.id, req.user.email]);
      }
    }
  });
  // A provider taken away stops at once: no run pod is kept for it there.
  for (const p of removed) keptPods.revokeUser(row.id, p);
  auditLog(req.user.id, distributor.id, req.user.email,
    `api_account_updated:${row.id}${name === null ? '' : ':name'}${providers ? ':providers' : ''}`);
  return res.json(accountView(accountRow(row.id, distributor.id), distributor, req));
});

router.post('/:id/suspend', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  if (row.status === 'active') {
    transaction(() => {
      run(`UPDATE users SET status = 'suspended', ${END_SESSIONS_SQL} WHERE id = ?`, [row.id]);
      run("UPDATE api_account SET suspended_at = datetime('now'), suspended_by = ? WHERE user_id = ?", [req.user.id, row.id]);
    });
    for (const place of placesOf(row.id, distributor.id)) keptPods.revokeUser(row.id, place);
    auditLog(req.user.id, distributor.id, req.user.email, `api_account_suspended:${row.id}`);
  }
  return res.json(accountView(accountRow(row.id, distributor.id), distributor, req));
});

router.post('/:id/resume', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  if (row.status !== 'active') {
    transaction(() => {
      run("UPDATE users SET status = 'active' WHERE id = ?", [row.id]);
      run('UPDATE api_account SET suspended_at = NULL, suspended_by = NULL WHERE user_id = ?', [row.id]);
    });
    auditLog(req.user.id, distributor.id, req.user.email, `api_account_resumed:${row.id}`);
  }
  return res.json(accountView(accountRow(row.id, distributor.id), distributor, req));
});

router.delete('/:id', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  for (const place of placesOf(row.id, distributor.id)) keptPods.revokeUser(row.id, place);
  // Its runs go with it, as a person's (utils/userDeletion.js).
  deleteUserAccount(row.id);
  auditLog(req.user.id, distributor.id, req.user.email, `api_account_deleted:${row.id}`);
  return res.json({ deleted: true, id: row.id });
});

// ── Its OSDM credentials, for the company or provider the request names ──────

// The account and the company of the request, which the account must be given.
function credentialsPlace(req, res) {
  const found = loaded(req, res);
  if (!found) return null;
  if (!canUseCompany(principalOf(found.row, found.distributor.id), req.companyId)) {
    res.status(409).json({ status: 409, title: 'Conflict',
      detail: 'This account is not given this provider: add the provider to the account first.' });
    return null;
  }
  return { ...found, companyId: req.companyId };
}

router.get('/:id/credentials', (req, res) => {
  const place = credentialsPlace(req, res);
  if (!place) return;
  return res.json(safeUserCreds(credentialsFor(place.row.id, place.companyId)));
});

router.patch('/:id/credentials', (req, res) => {
  const place = credentialsPlace(req, res);
  if (!place) return;
  const input = credentialFieldsOf(req.body);
  if (input.error) return bad(res, input.error);
  const shown = saveCredentialFields(place.row.id, place.companyId, input.fields);
  auditLog(req.user.id, place.companyId, req.user.email, `api_account_credentials_update:${place.row.id}:${input.changed.join(',')}`);
  return res.json(shown);
});

router.post('/:id/credentials/test', testLimiter, async (req, res) => {
  const place = credentialsPlace(req, res);
  if (!place) return;
  const result = await testCredentials(place.row.id, place.companyId);
  auditLog(req.user.id, place.companyId, req.user.email, `api_account_credentials_tested:${place.row.id}:${result.outcome}`);
  return res.json(result);
});

// ── Its public keys: how it signs in to the API (private_key_jwt, #1342 D2) ──

const keyView = k => ({
  id: k.id, alg: k.alg, fingerprint: k.fingerprint,
  created_by: k.created_by_email || null, created_at: k.created_at,
  last_used_at: k.last_used_at || null, revoked_at: k.revoked_at || null, revoked_by: k.revoked_by_email || null,
  state: k.revoked_at ? 'revoked' : 'active',
});
const KEY_FIELDS = `k.id, k.alg, k.fingerprint, k.created_at, k.last_used_at, k.revoked_at,
  cb.email AS created_by_email, rb.email AS revoked_by_email`;
const keysOf = (accountId) => all(`SELECT ${KEY_FIELDS} FROM api_account_key k
  LEFT JOIN users cb ON cb.id = k.created_by LEFT JOIN users rb ON rb.id = k.revoked_by
  WHERE k.user_id = ? ORDER BY k.created_at DESC, k.id`, [accountId]).map(keyView);

router.get('/:id/keys', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  return res.json({ ...signInOf(req, found.row.id), max_active_keys: CA.MAX_KEYS, algorithms: CA.ALGORITHMS, keys: keysOf(found.row.id) });
});

router.post('/:id/keys', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  const key = CA.publicKeyOf(req.body?.public_key);
  if (key.error) return bad(res, key.error);
  const active = all('SELECT fingerprint FROM api_account_key WHERE user_id = ? AND revoked_at IS NULL', [row.id]);
  if (active.some(k => k.fingerprint === key.fingerprint)) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: "This key is already one of the account's." });
  }
  if (active.length >= CA.MAX_KEYS) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `An account has at most ${CA.MAX_KEYS} active keys: revoke the old one first.` });
  }
  const id = crypto.randomUUID();
  run(`INSERT INTO api_account_key (id, user_id, company_id, alg, public_key, fingerprint, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, row.id, distributor.id, key.alg, key.pem, key.fingerprint, req.user.id]);
  auditLog(req.user.id, distributor.id, req.user.email, `api_account_key_added:${row.id}:${key.fingerprint}`);
  return res.status(201).json(keysOf(row.id).find(k => k.id === id));
});

router.delete('/:id/keys/:keyId', (req, res) => {
  const found = loaded(req, res);
  if (!found) return;
  const { distributor, row } = found;
  const key = get('SELECT id, fingerprint, revoked_at FROM api_account_key WHERE id = ? AND user_id = ?', [String(req.params.keyId), row.id]);
  if (!key) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No such key for this account.' });
  if (!key.revoked_at) {
    run("UPDATE api_account_key SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ? AND revoked_at IS NULL", [req.user.id, key.id]);
    auditLog(req.user.id, distributor.id, req.user.email, `api_account_key_revoked:${row.id}:${key.fingerprint}`);
  }
  return res.json(keysOf(row.id).find(k => k.id === key.id));
});

module.exports = router;
