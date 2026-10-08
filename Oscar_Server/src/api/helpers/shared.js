// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * shared.js — Shared utilities used across multiple route files.
 *
 * Extracted to eliminate duplication between auth.js, admin.js, and company.js.
 */

const { randomUUID: uuidv4 } = require('node:crypto');
const { get, all, run } = require('../../db/db');
const { stripTrailingSlashes } = require('../../utils/osdm-client');
const { normalizeRole } = require('../middleware/auth');

// ── Constants ────────────────────────────────────────────────────────────────
const ALLOWED_ROLES = new Set(['administrator', 'certification_user', 'test_manager', 'company_user']);
const PLATFORM_SLUG = 'platform-root';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalize and validate a role string against the allowed set.
 * Returns the normalized role, or null if invalid.
 */
function resolveRole(inputRole) {
  const role = normalizeRole(inputRole || 'company_user');
  return ALLOWED_ROLES.has(role) ? role : null;
}

/**
 * Return the platform-root company row, creating it if it doesn't exist yet.
 */
function ensurePlatformCompany() {
  const platformCompany = get('SELECT id, name, slug FROM companies WHERE slug = ?', [PLATFORM_SLUG]);
  if (platformCompany) return platformCompany;

  const companyId = uuidv4();
  run(
    `INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, ?, ?, 'bearer')`,
    [companyId, 'OSCAR Platform', PLATFORM_SLUG]
  );

  return get('SELECT id, name, slug FROM companies WHERE id = ?', [companyId]);
}

/**
 * Record an audit event in the auth_events table.
 * Failures are silently swallowed so audit logging never blocks request handling.
 */
function auditLog(userId, companyId, email, eventType) {
  try {
    run(
      `INSERT INTO auth_events (user_id, company_id, email, event_type, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
      [userId, companyId, email, eventType]
    );
  } catch (_) { /* never block on audit failures */ }
}

/**
 * Resolve the effective company scope for company-settings routes.
 * Returns a companyId string, or null (after sending the answer) if the
 * caller is a certification_user who should not access company settings.
 */
function resolveCompanyScope(req, res) {
  const { isPlatformRole } = require('../middleware/auth');

  if (req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot access company settings.' });
    return null;
  }

  // enforceTenant chose it: for a member, the own company or a provider of it
  // (#540); for a platform user, the company it named, if any. A member route
  // mounted without enforceTenant has no scope, and is refused rather than
  // guessed.
  if (!isPlatformRole(req.user.role) && !req.companyId) {
    res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'No company scope.' });
    return null;
  }
  return req.companyId;
}

// v1.11.15: companyShareWithCertifier() removed — the company-wide
// certifier-sharing toggle was retired in favour of per-report sharing
// (runs.shared_with_certifier_at). The helper had no remaining callers.

// ── Test-data role guards (issue #60) ────────────────────────────────────────
// Test configuration / resources / places are TEST DATA: administrators and
// certifiers have no access; only Test Managers may write. Shared by every
// company-test-* route (was triplicated per file). Both send the 403 and
// return a boolean so callers stay one-liners:
//   if (denyAdminAndCertifier(req, res)) return;
//   if (!requireTestManager(req, res)) return;
function denyAdminAndCertifier(req, res) {
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to test data (issue #60).' });
    return true;
  }
  return false;
}
function requireTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only Test Managers can modify test data.' });
    return false;
  }
  return true;
}

// ── Who may change a company's OSDM endpoint (#544) ──────────────────────────
// The endpoint is company-wide: every request of every run goes to it with the
// token of the tester who started the run. A tester who could change it would
// send colleagues' runs, and their tokens, anywhere. So a Test Manager changes
// it. An administrator who names the company keeps the access they had, as
// for the dedicated headers. The two roles are named here on purpose:
// isPlatformRole() also covers certifiers, and an unknown role must be refused.
//
// A tester may send back the endpoint that is stored. The API Config page did
// so on every save, for every role, until 1.11.207, and a page left open
// across the upgrade still does. That is not a change and nothing is written.
//
// Pure. Returns { write } (the trimmed endpoint, or null for "nothing to
// write"), with echoed: true for the case above, or { status, detail } to
// refuse.
function companyEndpointChange(role, requested, stored) {
  if (!requested) return { write: null };   // absent or empty: nothing asked, as before
  if (typeof requested !== 'string') return { status: 400, detail: 'api_base must be a string.' };
  const endpoint = requested.trim();
  if (role === 'test_manager' || role === 'administrator') return { write: endpoint };
  if (endpoint === (stored || '')) return { write: null, echoed: true };
  return { status: 403, detail: 'Only Test Managers can change the OSDM API endpoint.' };
}

// ── One endpoint per provider within a distributor (#540) ────────────────────
// Two companies of the same family (a distributor and its providers) pointing
// at the same OSDM endpoint is almost always a mistake: runs meant for one
// provider would go to another. Returns the name of the other company of the
// family that already uses `endpoint`, or null. `companyId` is the company
// being written (null for one being created under `parentId`). Comparison
// ignores case and trailing slashes.
function familyEndpointClash(companyId, parentId, endpoint) {
  const norm = v => stripTrailingSlashes(String(v || '').trim()).toLowerCase();
  const wanted = norm(endpoint);
  if (!wanted) return null;
  const root = parentId || get('SELECT parent_id FROM companies WHERE id = ?', [companyId])?.parent_id || companyId;
  if (!root) return null;
  const family = all('SELECT id, name, api_base FROM companies WHERE id = ? OR parent_id = ?', [root, root]);
  const clash = family.find(c => c.id !== companyId && norm(c.api_base) === wanted);
  return clash ? clash.name : null;
}

module.exports = {
  ALLOWED_ROLES,
  PLATFORM_SLUG,
  resolveRole,
  ensurePlatformCompany,
  auditLog,
  resolveCompanyScope,
  denyAdminAndCertifier,
  requireTestManager,
  companyEndpointChange,
  familyEndpointClash,
};
