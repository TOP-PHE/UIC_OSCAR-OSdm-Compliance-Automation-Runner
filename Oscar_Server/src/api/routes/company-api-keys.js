// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-api-keys.js — a company's or provider's read-only API keys (#503).
 *
 *   GET    /v1/company/api-keys       — the keys of the company or provider
 *   POST   /v1/company/api-keys       — make one: { name, expires_in_days }
 *   DELETE /v1/company/api-keys/:id   — revoke one
 *
 * Test Managers only, for the company or provider the request names
 * (X-Provider-Id, checked by enforceTenant). The key itself is answered once,
 * by the POST; nothing else ever shows it or its hash. Creation and
 * revocation are audited, without the key.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('node:crypto');
const { get, all, run } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope } = require('../helpers/shared');
const K = require('../../utils/apiKeys');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window — please wait a moment.' },
});

router.use('/api-keys', limiter, requireAuth, enforceTenant);

function scopeForTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers manage API keys.' });
    return null;
  }
  return resolveCompanyScope(req, res);
}

const FIELDS = `k.id, k.name, k.prefix, k.scopes, k.created_at, k.expires_at, k.last_used_at, k.revoked_at,
  u.email AS created_by_email, r.email AS revoked_by_email`;

function toApiKey(row, now = new Date()) {
  return {
    id: row.id,
    name: row.name,
    hint: `oscar_${row.prefix}_…`,
    scopes: String(row.scopes || '').split(' ').filter(Boolean),
    created_by: row.created_by_email || null,
    created_at: row.created_at,
    expires_at: row.expires_at,
    last_used_at: row.last_used_at || null,
    revoked_at: row.revoked_at || null,
    revoked_by: row.revoked_by_email || null,
    state: K.unusableBecause(row, now) || 'active',
  };
}

function keyRow(id, companyId) {
  return get(`SELECT ${FIELDS} FROM api_key k
    LEFT JOIN users u ON u.id = k.created_by LEFT JOIN users r ON r.id = k.revoked_by
    WHERE k.id = ? AND k.company_id = ?`, [id, companyId]);
}

router.get('/api-keys', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (!companyId) return;
  const company = get('SELECT id, name FROM companies WHERE id = ?', [companyId]);
  const rows = all(`SELECT ${FIELDS} FROM api_key k
    LEFT JOIN users u ON u.id = k.created_by LEFT JOIN users r ON r.id = k.revoked_by
    WHERE k.company_id = ? ORDER BY k.created_at DESC`, [companyId]);
  const now = new Date();
  res.json({
    company: company ? { id: company.id, name: company.name } : null,
    max_days: K.MAX_DAYS,
    default_days: K.DEFAULT_DAYS,
    keys: rows.map(r => toApiKey(r, now)),
  });
});

router.post('/api-keys', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (!companyId) return;
  const body = req.body || {};
  const name = K.nameOf(body.name);
  if (name.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: name.error });
  const life = K.lifetimeOf(body.expires_in_days);
  if (life.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: life.error });

  const id = randomUUID();
  const made = K.newKey();
  run(`INSERT INTO api_key (id, company_id, created_by, name, prefix, secret_hash, scopes, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, companyId, req.user.id, name.name, made.prefix, made.secretHash, K.SCOPES.join(' '), K.expiryAfter(life.days)]);
  auditLog(req.user.id, companyId, req.user.email, 'api_key_created');
  res.status(201).json({ ...toApiKey(keyRow(id, companyId)), key: made.key });
});

router.delete('/api-keys/:id', (req, res) => {
  const companyId = scopeForTestManager(req, res);
  if (!companyId) return;
  const row = keyRow(req.params.id, companyId);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'No such API key here.' });
  if (!row.revoked_at) {
    run("UPDATE api_key SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ? AND revoked_at IS NULL", [req.user.id, row.id]);
    auditLog(req.user.id, companyId, req.user.email, 'api_key_revoked');
  }
  res.json(toApiKey(keyRow(row.id, companyId)));
});

module.exports = router;
