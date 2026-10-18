// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * apiKey.js — authentication by OSCAR API key (#503).
 *
 * Mounted only on the /v1/api router, which holds read routes and nothing
 * else: a key opens nothing the router does not list. The key travels in
 * `Authorization: Bearer oscar_…` only; a cookie or a URL parameter is never
 * read. Every refusal is the same 401, so an answer does not tell a revoked
 * key from a wrong one.
 *
 * A key is usable while it is not revoked, not expired, and its creator is
 * still an active Test Manager who may use the key's company (canUseCompany,
 * read from the database at each call). It then sets
 *   req.apiKey = { id, companyId, scopes }
 *   req.user   = { id: <creator>, companyId and keyCompanyId: <key's company>, role: 'api_key' }
 * canUserSeeRun() gives the role 'api_key' the runs of that one company.
 */

const { get, run } = require('../../db/db');
const { canUseCompany } = require('../helpers/provider-access');
const K = require('../../utils/apiKeys');

const REFUSED = { status: 401, title: 'Unauthorized', detail: 'Missing, invalid, expired or revoked API key.' };
const TOUCH_EVERY_MS = 60 * 1000;   // last_used_at is written at most once a minute per key

function bearerOf(req) {
  const header = req.headers?.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/** The key row a request may use, or null. Never throws. */
function usableKey(token, now = new Date()) {
  try {
    const parsed = K.parseKey(token);
    if (!parsed) return null;
    const row = get('SELECT * FROM api_key WHERE prefix = ?', [parsed.prefix]);
    if (!row || !K.secretMatches(parsed.secret, row.secret_hash)) return null;
    if (K.unusableBecause(row, now)) return null;
    const creator = get('SELECT id, company_id, role, status FROM users WHERE id = ?', [row.created_by]);
    if (!creator || creator.status !== 'active' || creator.role !== 'test_manager') return null;
    const asCreator = { id: creator.id, companyId: creator.company_id, role: 'test_manager' };
    if (!canUseCompany(asCreator, row.company_id)) return null;
    return row;
  } catch {
    return null;
  }
}

function touch(row, now) {
  const last = Date.parse(String(row.last_used_at || '').replace(' ', 'T') + 'Z');
  if (Number.isFinite(last) && now.getTime() - last < TOUCH_EVERY_MS) return;
  try {
    run("UPDATE api_key SET last_used_at = datetime('now') WHERE id = ?", [row.id]);
  } catch { /* never block a read on the bookkeeping */ }
}

function requireApiKey(req, res, next) {
  const token = bearerOf(req);
  const now = new Date();
  const row = token ? usableKey(token, now) : null;
  if (!row) return res.status(401).json(REFUSED);
  touch(row, now);
  req.apiKey = { id: row.id, companyId: row.company_id, scopes: String(row.scopes || '').split(' ').filter(Boolean) };
  req.user = { id: row.created_by, companyId: row.company_id, keyCompanyId: row.company_id, role: 'api_key' };
  req.companyId = row.company_id;
  next();
}

module.exports = { requireApiKey, usableKey };
