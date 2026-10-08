// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-providers.js — a distributor's providers (#540).
 *
 *   GET    /v1/company/providers                      list (Test Manager: all; tester: those granted)
 *   POST   /v1/company/providers                      create        (Test Manager)
 *   PATCH  /v1/company/providers/:id                  rename        (Test Manager)
 *   GET    /v1/company/providers/:id/access           who may use it (Test Manager)
 *   PUT    /v1/company/providers/:id/access/:userId   grant a tester (Test Manager)
 *   DELETE /v1/company/providers/:id/access/:userId   withdraw      (Test Manager)
 *
 * A provider is a child company (companies.parent_id = the distributor). It
 * then reuses every per-company route by its own id: a request names it with
 * X-Provider-Id or ?provider_id=, and enforceTenant admits it through
 * canUseCompany() (helpers/provider-access.js). Its endpoint is changed there,
 * with PATCH /v1/company, which applies companyEndpointChange().
 *
 * Everything here acts on the caller's own company and its children, never on
 * an id from the request alone: a provider id that is not a child of the
 * caller's company answers 404. Deleting a provider is not offered.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, all, run } = require('../../db/db');
const { requireAuth, isPlatformRole, normalizeRole } = require('../middleware/auth');
const { auditLog, companyEndpointChange, familyEndpointClash, PLATFORM_SLUG } = require('../helpers/shared');
const { storedUrlRefusal } = require('../../utils/urlPolicy');
const { currentMember } = require('../helpers/provider-access');

const router = express.Router();
router.use(requireAuth);

const providerMutationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many provider changes. Slow down or wait a few minutes.' }
});
const providerReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window.' }
});
router.use((req, res, next) => {
  const limiter = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? providerMutationLimiter : providerReadLimiter;
  return limiter(req, res, next);
});

const NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Provider not found.' };
const NAME_MAX = 100;

// Platform users are not members of a distributor; nothing here is theirs.
router.use((req, res, next) => {
  if (isPlatformRole(req.user.role)) {
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Providers are managed by the distributor\'s Test Managers.' });
  }
  if (!req.user.companyId) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'No company context.' });
  // Role and company as stored now, not as the session token says.
  const member = currentMember(req.user);
  if (!member) return res.status(404).json(NOT_FOUND);
  req.memberRole = member.role;
  next();
});

function requireTestManager(req, res) {
  if (req.memberRole !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Only Test Managers manage providers.' });
    return false;
  }
  return true;
}

// A child of the caller's company, or null. The only lookup by request id.
function ownProvider(req) {
  const id = req.params.id;
  if (typeof id !== 'string' || id === '') return null;
  return get('SELECT * FROM companies WHERE id = ? AND parent_id = ?', [id, req.user.companyId]) || null;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (name === '' || name.length > NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f<>]/.test(name)) return null;   // one line of plain text
  return name;
}

// Is the name taken by another provider of the same distributor? Compared
// case-insensitively in JavaScript: SQLite's lower() only folds ASCII.
function nameTaken(parentId, name, exceptId) {
  const wanted = name.toLocaleLowerCase();
  return all('SELECT id, name FROM companies WHERE parent_id = ?', [parentId])
    .some(c => c.id !== exceptId && String(c.name).toLocaleLowerCase() === wanted);
}

function slugPart(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 40) || 'provider';
}

// {distributor slug}--{name}, made unique. The slug names the datafile on disk
// and the Bruno environment, so it is chosen here, never taken from a request.
function freeSlug(parentSlug, name) {
  const base = `${parentSlug}--${slugPart(name)}`.replace(/-+$/, '');
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (!get('SELECT 1 AS x FROM companies WHERE slug = ?', [slug])) return slug;
  }
  return `${base}-${uuidv4().slice(0, 8)}`;
}

function providerView(c) {
  return { id: c.id, name: c.name, slug: c.slug, api_base: c.api_base || null,
           parent_id: c.parent_id, created_at: c.created_at };
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const rows = req.memberRole === 'test_manager'
    ? all('SELECT * FROM companies WHERE parent_id = ? ORDER BY name ASC', [req.user.companyId])
    : all(`SELECT c.* FROM companies c
             JOIN provider_access pa ON pa.company_id = c.id AND pa.user_id = ?
            WHERE c.parent_id = ? ORDER BY c.name ASC`, [req.user.id, req.user.companyId]);
  return res.json({ providers: rows.map(providerView) });
});

// ── POST / ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const parent = get('SELECT * FROM companies WHERE id = ?', [req.user.companyId]);
  // Only a top-level company may own providers: one level, never a chain.
  if (!parent || parent.parent_id || parent.slug === PLATFORM_SLUG) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'This company cannot own providers.' });
  }
  const name = cleanName(req.body?.name);
  if (!name) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: `name is required: one line of plain text, 1-${NAME_MAX} characters.` });
  }
  if (nameTaken(parent.id, name, null)) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'A provider with this name already exists.' });
  }

  // The endpoint goes through the same rule as PATCH /v1/company (#544).
  const endpoint = companyEndpointChange(req.user.role, req.body?.api_base, null);
  if (endpoint.status) {
    return res.status(endpoint.status).json({ status: endpoint.status, title: 'Bad Request', detail: endpoint.detail });
  }
  let duplicateOf = null;
  if (endpoint.write !== null) {
    const urlRefusal = storedUrlRefusal(endpoint.write, 'OSDM endpoint');
    if (urlRefusal) return res.status(400).json({ status: 400, title: 'Bad Request', detail: urlRefusal });
    duplicateOf = familyEndpointClash(null, parent.id, endpoint.write);
    if (duplicateOf && req.body?.allow_duplicate_endpoint !== true) {
      return res.status(409).json({ status: 409, title: 'Conflict',
        detail: `This OSDM endpoint is already used by ${duplicateOf}. Send allow_duplicate_endpoint: true to use it anyway.` });
    }
  }

  const id = uuidv4();
  run(`INSERT INTO companies (id, name, slug, auth_mode, api_base, parent_id) VALUES (?, ?, ?, 'bearer', ?, ?)`,
    [id, name, freeSlug(parent.slug, name), endpoint.write, parent.id]);
  auditLog(req.user.id, id, req.user.email, `provider_created:${parent.id}`);
  if (duplicateOf) auditLog(req.user.id, id, req.user.email, 'company_update:api_base:duplicate_endpoint_confirmed');
  return res.status(201).json({ provider: providerView(get('SELECT * FROM companies WHERE id = ?', [id])) });
});

// ── PATCH /:id — rename ───────────────────────────────────────────────────────
// The endpoint and the dedicated headers are changed with PATCH /v1/company
// naming the provider, like any company's.
router.patch('/:id', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const provider = ownProvider(req);
  if (!provider) return res.status(404).json(NOT_FOUND);
  const name = cleanName(req.body?.name);
  if (!name) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: `name is required (1-${NAME_MAX} characters).` });
  }
  if (nameTaken(provider.parent_id, name, provider.id)) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'A provider with this name already exists.' });
  }
  run(`UPDATE companies SET name = ?, updated_at = datetime('now') WHERE id = ?`, [name, provider.id]);
  auditLog(req.user.id, provider.id, req.user.email, 'provider_renamed');
  return res.json({ provider: providerView(get('SELECT * FROM companies WHERE id = ?', [provider.id])) });
});

// ── Access list ───────────────────────────────────────────────────────────────
// A Test Manager of the distributor always has access; a tester only when
// listed. Only testers of the distributor itself can be listed.

router.get('/:id/access', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const provider = ownProvider(req);
  if (!provider) return res.status(404).json(NOT_FOUND);
  const rows = all(
    `SELECT u.id, u.email, pa.granted_at, pa.granted_by
       FROM provider_access pa JOIN users u ON u.id = pa.user_id
      WHERE pa.company_id = ?
      ORDER BY u.email ASC`, [provider.id]);
  return res.json({ provider_id: provider.id, testers: rows });
});

// The tester to grant or withdraw: a member of the distributor, or null.
function distributorTester(req, provider) {
  const user = get('SELECT id, email, role FROM users WHERE id = ? AND company_id = ?', [req.params.userId, provider.parent_id]);
  return user && normalizeRole(user.role) === 'company_user' ? user : null;
}

router.put('/:id/access/:userId', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const provider = ownProvider(req);
  if (!provider) return res.status(404).json(NOT_FOUND);
  const tester = distributorTester(req, provider);
  if (!tester) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Tester not found.' });
  run(`INSERT OR IGNORE INTO provider_access (company_id, user_id, granted_by) VALUES (?, ?, ?)`,
    [provider.id, tester.id, req.user.email]);
  auditLog(req.user.id, provider.id, req.user.email, `provider_access_granted:${tester.id}`);
  return res.json({ provider_id: provider.id, user_id: tester.id, granted: true });
});

router.delete('/:id/access/:userId', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const provider = ownProvider(req);
  if (!provider) return res.status(404).json(NOT_FOUND);
  // By (provider, user), whoever the user now is: a grant is always removable.
  const removed = run('DELETE FROM provider_access WHERE company_id = ? AND user_id = ?', [provider.id, req.params.userId]);
  if (!removed?.changes) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Tester not found.' });
  auditLog(req.user.id, provider.id, req.user.email, `provider_access_withdrawn:${req.params.userId}`);
  return res.json({ provider_id: provider.id, user_id: req.params.userId, granted: false });
});

module.exports = router;
