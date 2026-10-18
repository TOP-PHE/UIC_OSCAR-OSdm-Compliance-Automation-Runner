// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api.js — the read-only API, by API key (#503).
 *
 *   GET /v1/api/key   — the key's own name, company, scopes and expiry
 *
 * Default-deny: a key opens the GET routes this router lists and nothing
 * else (any other method or path is a 404 here, and every other OSCAR route
 * refuses a key in requireAuth). Each key has its own rate limit. The read
 * routes on runs and results come with the OpenAPI description (#503 PR 2);
 * every run they return must go through canUserSeeRun().
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { get } = require('../../db/db');
const { requireApiKey } = require('../middleware/apiKey');

const router = express.Router();

// Before the key is checked, by address: guessing keys is slowed down too.
const guessLimiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests from this address — please wait a moment.' },
});
const perKeyLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `api-key:${req.apiKey.id}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'This API key made too many requests in a short window — please wait a moment.' },
});

router.use(guessLimiter, requireApiKey, perKeyLimiter);

router.get('/key', (req, res) => {
  const row = get(`SELECT k.name, k.prefix, k.scopes, k.created_at, k.expires_at, c.id AS company_id, c.name AS company_name
                   FROM api_key k JOIN companies c ON c.id = k.company_id WHERE k.id = ?`, [req.apiKey.id]);
  if (!row) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Missing, invalid, expired or revoked API key.' });
  res.json({
    name: row.name,
    hint: `oscar_${row.prefix}_…`,
    company: { id: row.company_id, name: row.company_name },
    scopes: String(row.scopes || '').split(' ').filter(Boolean),
    created_at: row.created_at,
    expires_at: row.expires_at,
  });
});

// Anything not listed above, whatever the method: the request ends here and
// never reaches another router or the page fallback.
router.use((req, res) => {
  res.status(404).json({ status: 404, title: 'Not Found', detail: 'The API has no such route.' });
});

module.exports = router;
