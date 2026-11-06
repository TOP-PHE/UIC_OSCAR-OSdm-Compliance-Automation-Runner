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
 *   POST   /v1/company/users/:id/approve          — activate a self-registered pending user (#449)
 *   POST   /v1/company/users/:id/reset-password   — reset password
 *   DELETE /v1/company/users/:id                  — delete user (also rejects a pending user)
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
const rateLimit = require('express-rate-limit');
const { get, all, run, transaction } = require('../../db/db');
const { requireAuth, requireRole, normalizeRole, END_SESSIONS_SQL } = require('../middleware/auth');
const { auditLog } = require('../helpers/shared');
const { membershipChanged } = require('../helpers/provider-access');
const { validate, v } = require('../middleware/validate');
const AccessRequests = require('../../utils/accessRequests');

const router = express.Router();

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
    status:       row.status || 'active',
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

// ── Access requests (decision 3) ─────────────────────────────────────────────
// Requests an administrator placed in this company, which a Test Manager of
// the company confirms (as a tester or a Test Manager) or refuses. The person
// then chooses their own password from the link they receive.

router.get('/access-requests', (req, res) => {
  res.json({ requests: AccessRequests.requestsOfCompany(req.user.companyId) });
});

router.post('/access-requests/:id/confirm', async (req, res) => {
  const role = req.body?.role;
  const companyId = req.user.companyId;
  const done = await AccessRequests.confirmRequest(req.params.id, companyId, role);
  if (done.status) {
    const title = { 404: 'Not Found', 409: 'Conflict' }[done.status] || 'Bad Request';
    return res.status(done.status).json({ status: done.status, title, detail: done.detail });
  }
  const company = get('SELECT name FROM companies WHERE id = ?', [companyId]);
  auditLog(req.user.id, companyId, req.user.email, `access_request_confirmed:${done.user.email}:${role}`);
  AccessRequests.noticeActivated(done.user, company?.name || 'your company', done.activationUrl);
  return res.json({ confirmed: true, user: done.user });
});

router.post('/access-requests/:id/refuse', (req, res) => {
  const companyId = req.user.companyId;
  const done = AccessRequests.refuseRequest(req.params.id, companyId);
  if (done.status) return res.status(done.status).json({ status: done.status, title: 'Not Found', detail: done.detail });
  auditLog(req.user.id, companyId, req.user.email, `access_request_refused:${done.request.email}`);
  AccessRequests.noticeRefused(done.request);
  return res.json({ refused: true });
});

// ── GET /v1/company/users ─────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const companyId = req.user.companyId;
  if (!companyId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company associated with this account.' });
  }

  const q = (req.query.q || '').toString().trim().toLowerCase();
  const status = (req.query.status || '').toString().trim();
  const params = [companyId];
  let where = 'u.company_id = ?';
  if (q) {
    where += ' AND lower(u.email) LIKE ?';
    params.push(`%${q}%`);
  }
  if (status) {
    where += ' AND u.status = ?';
    params.push(status);
  }

  const rows = all(
    `SELECT u.id, u.email, u.role, u.status, u.company_id, u.created_at,
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
    v.body('role').isString().withMessage('role is required'),
  ]),
  async (req, res) => {
    const companyId = req.user.companyId;
    if (!companyId) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No company associated with this account.' });
    }

    const { email, role } = req.body || {};
    if ('password' in (req.body || {})) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No password is set here: the person receives a link to choose their own.' });
    }
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

    // Decision 3: an invitation. The person chooses their own password from
    // the link they receive; the Test Manager never knows it.
    const done = await AccessRequests.invite({ email: lowerEmail, companyId, role: resolvedRole });
    auditLog(req.user.id, companyId, req.user.email, `company_user_invited:${lowerEmail}:${resolvedRole}`);
    const created = get(
      `SELECT u.id, u.email, u.role, u.status, u.company_id, u.created_at,
              c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [done.user.id]
    );
    AccessRequests.noticeActivated(done.user, created.company_name, done.activationUrl);
    return res.status(201).json({ invited: true, user: sanitizeUserRow(created) });
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
      updates.push(END_SESSIONS_SQL);
    }

    if (updates.length === 0) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No update fields provided.' });
    }

    values.push(userId);
    // #540: a role change ends the user's provider grants.
    transaction(() => {
      run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
      membershipChanged(userId, target);
    });
    auditLog(req.user.id, companyId, req.user.email, `company_user_updated:${userId}`);

    const updated = get(
      `SELECT u.id, u.email, u.role, u.status, u.company_id, u.created_at,
              c.name AS company_name
       FROM users u JOIN companies c ON c.id = u.company_id
       WHERE u.id = ?`,
      [userId]
    );
    return res.json({ user: sanitizeUserRow(updated) });
  }
);

// ── POST /v1/company/users/:id/approve ────────────────────────────────────────
// Issue #449 — activates a self-registered user pending Test-Manager review.
router.post('/:id/approve', (req, res) => {
  const companyId = req.user.companyId;
  const userId = req.params.id;

  const target = get('SELECT id, email, status FROM users WHERE id = ? AND company_id = ?', [userId, companyId]);
  if (!target) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found in this company.' });
  }
  if (target.status !== 'pending') {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User is not awaiting approval.' });
  }

  run('UPDATE users SET status = ? WHERE id = ?', ['active', userId]);
  auditLog(req.user.id, companyId, req.user.email, `company_user_approved:${target.email}`);

  const updated = get(
    `SELECT u.id, u.email, u.role, u.status, u.company_id, u.created_at,
            c.name AS company_name
     FROM users u JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [userId]
  );
  return res.json({ user: sanitizeUserRow(updated) });
});

// ── POST /v1/company/users/:id/send-reset ─────────────────────────────────────
// A user's password is theirs: the Test Manager sends them a link to choose a
// new one (decision 3) and never sets it.
router.post('/:id/send-reset', (req, res) => {
  const companyId = req.user.companyId;
  const target = get('SELECT id, email FROM users WHERE id = ? AND company_id = ?', [req.params.id, companyId]);
  if (!target) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found in this company.' });
  }
  AccessRequests.sendPasswordReset(target);
  auditLog(req.user.id, companyId, req.user.email, `company_password_reset_sent:${target.email}`);
  return res.json({ sent: true, email: target.email });
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
