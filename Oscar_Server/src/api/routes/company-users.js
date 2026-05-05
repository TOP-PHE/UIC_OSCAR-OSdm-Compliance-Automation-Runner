// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-users.js — Test-manager-scoped user management.
 *
 * Mirrors the user CRUD surface of /v1/admin/users but scoped to the
 * caller's own company. Test managers can:
 *
 *   GET    /v1/company/users                      — list users in this company
 *   POST   /v1/company/users                      — create a user (company_user or test_manager)
 *   PATCH  /v1/company/users/:id                  — change email / role within {company_user, test_manager}
 *   POST   /v1/company/users/:id/reset-password   — reset password
 *   DELETE /v1/company/users/:id                  — delete user
 *
 * Restrictions enforced server-side:
 *   - Only the test_manager role may invoke these endpoints (administrator
 *     uses /v1/admin/users for cross-company management).
 *   - Every operation is filtered to the caller's own company_id — there is
 *     no way to escape the tenant via query/header overrides on these routes.
 *   - Roles assignable here are limited to {company_user, test_manager}.
 *     Platform roles (administrator, certification_user) cannot be created
 *     or assigned through this endpoint.
 *   - Cannot delete yourself.
 *   - Cannot delete the LAST test_manager of the company (would orphan it).
 *   - Cannot demote yourself out of test_manager (same self-lockout reason).
 */

const express   = require('express');
const bcrypt    = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { get, all, run, transaction } = require('../../db/db');
const { requireAuth, requireRole, normalizeRole } = require('../middleware/auth');
const { auditLog } = require('../helpers/shared');
const { validate, v } = require('../middleware/validate');

const router = express.Router();
const SALT_ROUNDS = 12;

// Roles a test_manager may set or create. NEVER includes administrator
// or certification_user — those are platform roles managed exclusively
// via /v1/admin/users.
const COMPANY_ASSIGNABLE_ROLES = new Set(['company_user', 'test_manager']);

router.use(requireAuth, requireRole('test_manager'));

// Defence-in-depth rate limit on mutating verbs (mirrors admin.js).
const companyUserMutationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many user-management requests. Slow down or wait a few minutes.' }
});
router.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    return companyUserMutationLimiter(req, res, next);
  }
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitizeUserRow(row) {
  return {
    id:           row.id,
    email:        row.email,
    role:         normalizeRole(row.role),
    company_id:   row.company_id,
    company_name: row.company_name,
    created_at:   row.created_at
  };
}

/** Count current test_managers of a given company. */
function countTestManagers(companyId) {
  const r = get(
    `SELECT COUNT(*) AS n FROM users WHERE company_id = ? AND role = 'test_manager'`,
    [companyId]
  );
  return r ? r.n : 0;
}

// ── GET /v1/company/users ─────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company associated with this account.' });
  }

  const q = (req.query.q || '').toString().trim().toLowerCase();
  const params = [companyId];
  let where = 'u.company_id = ?';
  if (q) {
    where += ' AND lower(u.email) LIKE ?';
    params.push(`%${q}%`);
  }

  const rows = all(
    `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
            c.name AS company_name
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE ${where}
     ORDER BY u.created_at DESC`,
    params
  );

  return res.json({ users: rows.map(sanitizeUserRow) });
});

// ── POST /v1/company/users ────────────────────────────────────────────────────
router.post('/',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 12, max: 200 }).withMessage('password must be 12–200 chars')
      .matches(/[A-Z]/).withMessage('password must include an uppercase letter')
      .matches(/[a-z]/).withMessage('password must include a lowercase letter')
      .matches(/[0-9]/).withMessage('password must include a digit'),
    v.body('role').isString().withMessage('role is required'),
  ]),
  async (req, res) => {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company associated with this account.' });
    }

    const { email, password, role } = req.body || {};
    const resolvedRole = normalizeRole(role);
    if (!COMPANY_ASSIGNABLE_ROLES.has(resolvedRole)) {
      return res.status(400).json({
        status: 400, title: 'Bad Request',
        detail: `role must be one of: ${[...COMPANY_ASSIGNABLE_ROLES].join(', ')}.`
      });
    }

    const lowerEmail = email.toLowerCase();
    const existing = get('SELECT id FROM users WHERE email = ?', [lowerEmail]);
    if (existing) {
      return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Email already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const userId = uuidv4();

    run(
      `INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [userId, companyId, lowerEmail, passwordHash, resolvedRole]
    );
    auditLog(req.user.id, companyId, req.user.email, `company_user_created:${lowerEmail}:${resolvedRole}`);

    const created = get(
      `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
              c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [userId]
    );
    return res.status(201).json({ user: sanitizeUserRow(created) });
  }
);

// ── PATCH /v1/company/users/:id ───────────────────────────────────────────────
router.patch('/:id',
  validate([
    v.param('id').matches(/^[0-9a-fA-F-]{36}$/).withMessage('id must be a UUID'),
    v.body('email').optional().isString().isEmail().withMessage('email must be a valid address').isLength({ max: 254 }),
    v.body('role').optional().isString(),
  ]),
  (req, res) => {
    const companyId = req.user.companyId;
    const userId = req.params.id;
    const { email, role } = req.body || {};

    // Look up the target user IN THIS COMPANY only — refuses to touch
    // foreign-company rows even if the caller knows their UUID.
    const target = get('SELECT * FROM users WHERE id = ? AND company_id = ?', [userId, companyId]);
    if (!target) {
      return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found in this company.' });
    }

    const updates = [];
    const values  = [];

    if (email) {
      const lowerEmail = email.toLowerCase();
      const dup = get('SELECT id FROM users WHERE email = ? AND id != ?', [lowerEmail, userId]);
      if (dup) {
        return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Email already in use by another user.' });
      }
      updates.push('email = ?');
      values.push(lowerEmail);
    }

    if (role) {
      const resolvedRole = normalizeRole(role);
      if (!COMPANY_ASSIGNABLE_ROLES.has(resolvedRole)) {
        return res.status(400).json({
          status: 400, title: 'Bad Request',
          detail: `role must be one of: ${[...COMPANY_ASSIGNABLE_ROLES].join(', ')}.`
        });
      }

      // Self-demotion lockout: a test_manager downgrading themselves to
      // company_user would lose access to this very endpoint. Refuse — they
      // can ask another test_manager to do it, or an administrator.
      if (req.user.id === userId && resolvedRole !== 'test_manager') {
        return res.status(400).json({
          status: 400, title: 'Bad Request',
          detail: 'You cannot demote yourself out of test_manager. Ask another test_manager or an administrator.'
        });
      }

      // Last-manager guard: refuse to demote the only remaining test_manager.
      if (target.role === 'test_manager' && resolvedRole !== 'test_manager') {
        if (countTestManagers(companyId) <= 1) {
          return res.status(400).json({
            status: 400, title: 'Bad Request',
            detail: 'Cannot demote the last test_manager of this company. Promote another user first.'
          });
        }
      }

      updates.push('role = ?');
      values.push(resolvedRole);
    }

    if (updates.length === 0) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No update fields provided.' });
    }

    values.push(userId);
    run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
    auditLog(req.user.id, companyId, req.user.email, `company_user_updated:${userId}`);

    const updated = get(
      `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
              c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [userId]
    );
    return res.json({ user: sanitizeUserRow(updated) });
  }
);

// ── POST /v1/company/users/:id/reset-password ─────────────────────────────────
router.post('/:id/reset-password', async (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.params.id;
  const { new_password } = req.body || {};

  if (!new_password || new_password.length < 12) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'new_password is required (min 12 chars).' });
  }
  if (!/[A-Z]/.test(new_password) || !/[a-z]/.test(new_password) || !/[0-9]/.test(new_password)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Password must contain uppercase, lowercase, and a digit.' });
  }

  const target = get('SELECT id, email FROM users WHERE id = ? AND company_id = ?', [userId, companyId]);
  if (!target) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found in this company.' });
  }

  const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  auditLog(req.user.id, companyId, req.user.email, `company_password_reset:${target.email}`);

  return res.json({ id: userId, email: target.email, password_reset: true });
});

// ── DELETE /v1/company/users/:id ──────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.params.id;

  if (req.user.id === userId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'You cannot delete your own account.' });
  }

  const target = get('SELECT id, email, role, company_id FROM users WHERE id = ? AND company_id = ?', [userId, companyId]);
  if (!target) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found in this company.' });
  }

  // Last-manager guard.
  if (target.role === 'test_manager' && countTestManagers(companyId) <= 1) {
    return res.status(400).json({
      status: 400, title: 'Bad Request',
      detail: 'Cannot delete the last test_manager of this company. Promote another user first.'
    });
  }

  transaction(() => {
    run('UPDATE auth_events SET user_id = NULL WHERE user_id = ?', [userId]);
    run(`DELETE FROM report_comparisons
         WHERE run_a_id IN (SELECT id FROM runs WHERE user_id = ?)
            OR run_b_id IN (SELECT id FROM runs WHERE user_id = ?)`, [userId, userId]);
    run('DELETE FROM runs WHERE user_id = ?', [userId]);
    run('DELETE FROM users WHERE id = ?', [userId]);
  });

  auditLog(req.user.id, companyId, req.user.email, `company_user_deleted:${target.email}`);
  return res.json({ deleted: true, id: userId, email: target.email });
});

module.exports = router;
