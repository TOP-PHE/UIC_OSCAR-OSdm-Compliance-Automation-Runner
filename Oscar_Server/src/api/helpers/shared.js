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
const { get, run } = require('../../db/db');
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
 * Returns a companyId string, or null (after sending 403) if the caller
 * is a certification_user who should not access company settings.
 */
function resolveCompanyScope(req, res) {
  const { isPlatformRole } = require('../middleware/auth');

  if (req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden', detail: 'certification_user cannot access company settings.' });
    return null;
  }

  if (isPlatformRole(req.user.role)) {
    return req.companyId;
  }

  return req.user.companyId;
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

module.exports = {
  ALLOWED_ROLES,
  PLATFORM_SLUG,
  resolveRole,
  ensurePlatformCompany,
  auditLog,
  resolveCompanyScope,
  denyAdminAndCertifier,
  requireTestManager,
};
