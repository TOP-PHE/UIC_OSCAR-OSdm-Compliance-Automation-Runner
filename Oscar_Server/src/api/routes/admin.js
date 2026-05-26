// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin.js — Administrator routes
 *
 * GET    /v1/admin/users                 — list users across platform
 * POST   /v1/admin/users                 — create user
 * PATCH  /v1/admin/users/:id             — update role/company/email
 * POST   /v1/admin/users/:id/reset-password — reset password
 * DELETE /v1/admin/users/:id             — delete user
 * GET    /v1/admin/activity              — server activity metrics
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { get, all, run, transaction, getConfig } = require('../../db/db');
const { requireAuth, requireRole, normalizeRole } = require('../middleware/auth');
const { ALLOWED_ROLES, PLATFORM_SLUG, resolveRole, ensurePlatformCompany, auditLog } = require('../helpers/shared');
const { validate, v } = require('../middleware/validate');
const { sendTestEmail, isSmtpConfigured } = require('../../utils/mailer');

const router = express.Router();
const SALT_ROUNDS = 12;

router.use(requireAuth, requireRole('administrator'));

// ── Rate limiting on destructive admin endpoints ─────────────────────────────
// requireRole already gates these to authenticated administrators, so the
// brute-force angle (the usual rate-limit target) doesn't really apply.
// This is defence-in-depth: if an admin session token leaks, the attacker
// can't issue a high-velocity stream of user-deletions, password-resets, or
// role changes before the leak is noticed and the token is revoked. The
// limit is generous (60 mutating actions per 5 min per IP) so legitimate
// bulk-administration via the UI never trips it.
const adminMutationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5-minute window
  max: 60,                   // 60 mutating requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests',
             detail: 'Too many admin write requests in a short window. Slow down or wait a few minutes.' }
});
// Apply only to mutating verbs — read-only GET endpoints (list users,
// activity metrics) stay unthrottled so dashboards refresh smoothly.
router.use((req, res, next) => {
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' || req.method === 'DELETE') {
    return adminMutationLimiter(req, res, next);
  }
  next();
});

function sanitizeUserRow(row) {
  return {
    id: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    company_id: row.company_id,
    company_name: row.company_name,
    company_slug: row.company_slug,
    created_at: row.created_at
  };
}

router.get('/users', (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();

  let rows;
  if (q) {
    rows = all(
      `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
              c.name AS company_name, c.slug AS company_slug
       FROM users u
       JOIN companies c ON c.id = u.company_id
       WHERE lower(u.email) LIKE ? OR lower(c.name) LIKE ? OR lower(c.slug) LIKE ?
       ORDER BY u.created_at DESC`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );
  } else {
    rows = all(
      `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
              c.name AS company_name, c.slug AS company_slug
       FROM users u
       JOIN companies c ON c.id = u.company_id
       ORDER BY u.created_at DESC`
    );
  }

  return res.json({ users: rows.map(sanitizeUserRow) });
});

router.post('/users',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 12, max: 200 }).withMessage('password must be 12–200 chars')
      .matches(/[A-Z]/).withMessage('password must include an uppercase letter')
      .matches(/[a-z]/).withMessage('password must include a lowercase letter')
      .matches(/[0-9]/).withMessage('password must include a digit'),
    v.body('role').isString().withMessage('role is required')
      .isIn([...ALLOWED_ROLES, 'admin', 'member']).withMessage('role must be a recognised value'),
    v.body('company_id').optional({ values: 'falsy' }).isString()
      .matches(/^[0-9a-fA-F-]{36}$/).withMessage('company_id must be a UUID'),
  ]),
  async (req, res) => {
  const { email, password, role, company_id } = req.body || {};
  const resolvedRole = resolveRole(role);
  if (!resolvedRole) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'role could not be resolved to a known value.' });
  }

  const lowerEmail = email.toLowerCase();
  const existingUser = get('SELECT id FROM users WHERE email = ?', [lowerEmail]);
  if (existingUser) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Email already registered.' });
  }

  let targetCompany;
  const needsCompany = resolvedRole === 'company_user' || resolvedRole === 'test_manager';
  if (needsCompany) {
    if (!company_id) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: `company_id is required for ${resolvedRole}.` });
    }
    targetCompany = get('SELECT id, name, slug FROM companies WHERE id = ?', [company_id]);
    if (!targetCompany) {
      return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Target company not found.' });
    }
  } else {
    targetCompany = ensurePlatformCompany();
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const userId = uuidv4();

  run(
    `INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
    [userId, targetCompany.id, lowerEmail, passwordHash, resolvedRole]
  );
  auditLog(req.user.id, targetCompany.id, req.user.email, `user_created:${lowerEmail}:${resolvedRole}`);

  const created = get(
    `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
            c.name AS company_name, c.slug AS company_slug
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [userId]
  );

  return res.status(201).json({ user: sanitizeUserRow(created) });
});

router.patch('/users/:id',
  validate([
    v.param('id').matches(/^[0-9a-fA-F-]{36}$/).withMessage('id must be a UUID'),
    v.body('email').optional().isString().isEmail().withMessage('email must be a valid address').isLength({ max: 254 }),
    v.body('role').optional().isString()
      .isIn([...ALLOWED_ROLES, 'admin', 'member']).withMessage('role must be a recognised value'),
    v.body('company_id').optional({ values: 'falsy' }).isString()
      .matches(/^[0-9a-fA-F-]{36}$/).withMessage('company_id must be a UUID'),
  ]),
  (req, res) => {
  const userId = req.params.id;
  const { email, role, company_id } = req.body || {};

  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found.' });

  const updates = [];
  const values = [];

  if (email) {
    const lowerEmail = email.toLowerCase();
    const existing = get('SELECT id FROM users WHERE email = ? AND id != ?', [lowerEmail, userId]);
    if (existing) {
      return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Email already in use by another user.' });
    }
    updates.push('email = ?');
    values.push(lowerEmail);
  }

  if (role) {
    const resolvedRole = resolveRole(role);
    if (!resolvedRole) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Invalid role value.' });
    }

    updates.push('role = ?');
    values.push(resolvedRole);

    if (resolvedRole === 'company_user' || resolvedRole === 'test_manager') {
      // Company-bound roles. Change the company only when a valid company_id is
      // provided; otherwise KEEP the user's current company. Changing the role
      // alone (e.g. Tester → Test Manager) must NOT move the user off their
      // company (issue #128 — previously test_manager fell into the platform
      // catch-all below). A company-bound role may not sit on the platform
      // company, so require company_id if the user is currently on it.
      if (company_id) {
        const targetCompany = get('SELECT id FROM companies WHERE id = ?', [company_id]);
        if (!targetCompany) {
          return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Target company not found.' });
        }
        updates.push('company_id = ?');
        values.push(company_id);
      } else {
        const platformCompany = ensurePlatformCompany();
        if (user.company_id === platformCompany.id) {
          return res.status(400).json({ status: 400, title: 'Bad Request', detail: `company_id is required for ${resolvedRole} (the user is currently on the platform company).` });
        }
        // Already on a real company and no company_id provided → keep it
        // (no company_id update is pushed).
      }
    } else if (resolvedRole === 'certification_user') {
      // Certifiers may optionally belong to a specific company; if not provided keep current
      if (company_id) {
        const targetCompany = get('SELECT id FROM companies WHERE id = ?', [company_id]);
        if (!targetCompany) {
          return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Target company not found.' });
        }
        updates.push('company_id = ?');
        values.push(company_id);
      }
    } else {
      // administrator always belongs to the platform company
      const platformCompany = ensurePlatformCompany();
      updates.push('company_id = ?');
      values.push(platformCompany.id);
    }
  } else if (company_id) {
    const targetCompany = get('SELECT id FROM companies WHERE id = ?', [company_id]);
    if (!targetCompany) {
      return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Target company not found.' });
    }
    updates.push('company_id = ?');
    values.push(company_id);
  }

  if (updates.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No update fields provided.' });
  }

  values.push(userId);
  run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, values);
  auditLog(req.user.id, null, req.user.email, `user_updated:${userId}`);

  const updated = get(
    `SELECT u.id, u.email, u.role, u.company_id, u.created_at,
            c.name AS company_name, c.slug AS company_slug
     FROM users u
     JOIN companies c ON c.id = u.company_id
     WHERE u.id = ?`,
    [userId]
  );

  return res.json({ user: sanitizeUserRow(updated) });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const userId = req.params.id;
  const { new_password } = req.body || {};

  if (!new_password || new_password.length < 12) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'new_password is required (min 12 chars).' });
  }
  if (!/[A-Z]/.test(new_password) || !/[a-z]/.test(new_password) || !/[0-9]/.test(new_password)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Password must contain uppercase, lowercase, and a digit.' });
  }

  const user = get('SELECT id, email FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found.' });

  const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, userId]);
  auditLog(req.user.id, null, req.user.email, `password_reset:${user.email}`);

  return res.json({ id: userId, email: user.email, password_reset: true });
});

// ── POST /v1/admin/users/:id/generate-reset-link (issue #15 workaround) ──────
// Generates a self-service password-reset URL and returns it directly to the
// admin instead of emailing it to the user. Used when SMTP is misconfigured
// (issue #14) but a user still needs to reset their password — admin pastes
// the URL into Slack / Teams / in-person, user clicks it, sets new password.
//
// Same token table (password_reset_tokens), same 24h expiry, same single-
// use semantics as /v1/auth/password-reset/request — we just bypass the
// email send. Audit-logged so the trail of who-issued-what is recoverable.
router.post('/users/:id/generate-reset-link', (req, res) => {
  const userId = req.params.id;
  const user = get('SELECT id, email FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found.' });

  // Wipe any previous outstanding token for this user (one active link at a time)
  run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);

  const token     = require('uuid').v4();
  const id        = require('uuid').v4();
  const PASSWORD_RESET_EXPIRY_HOURS = 24;
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  run(
    'INSERT INTO password_reset_tokens (id, user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?)',
    [id, user.id, token, expiresAt, req.ip || null]
  );

  const appUrl   = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const resetUrl = `${appUrl}/reset-password.html?token=${token}`;

  auditLog(req.user.id, null, req.user.email, `admin_generated_reset_link:${user.email}`);
  return res.json({
    id: userId,
    email: user.email,
    resetUrl,
    expires_at: expiresAt,
    note: 'Share this link with the user out-of-band (Slack/Teams/in-person). Single-use; expires in 24h.'
  });
});

router.delete('/users/:id', (req, res) => {
  const userId = req.params.id;

  if (req.user.id === userId) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'You cannot delete your own account.' });
  }

  const user = get('SELECT id, email FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User not found.' });

  transaction(() => {
    // Nullify auth_events references (user_id is nullable — keeps the login history rows)
    run('UPDATE auth_events SET user_id = NULL WHERE user_id = ?', [userId]);

    // Delete report_comparisons that involve any of this user's runs (run_id FK has no cascade)
    run(`DELETE FROM report_comparisons
         WHERE run_a_id IN (SELECT id FROM runs WHERE user_id = ?)
            OR run_b_id IN (SELECT id FROM runs WHERE user_id = ?)`, [userId, userId]);

    // Delete runs (cascades automatically to run_events and run_artifacts)
    run('DELETE FROM runs WHERE user_id = ?', [userId]);

    // Now safe to delete the user
    run('DELETE FROM users WHERE id = ?', [userId]);
  });

  auditLog(req.user.id, user.company_id, req.user.email, `user_deleted:${user.email}`);
  return res.json({ deleted: true, id: userId, email: user.email });
});

router.get('/activity', (req, res) => {
  const totals = {
    users: get('SELECT COUNT(*) AS n FROM users').n,
    companies: get('SELECT COUNT(*) AS n FROM companies').n,
    runs: get("SELECT COUNT(*) AS n FROM runs WHERE status != 'DELETED'").n,
    comparisons: get('SELECT COUNT(*) AS n FROM report_comparisons').n
  };

  const runStatus = all(
    `SELECT status, COUNT(*) AS n
     FROM runs
     WHERE status != 'DELETED'
     GROUP BY status
     ORDER BY n DESC`
  );

  const runs24h = get(`SELECT COUNT(*) AS n FROM runs WHERE queued_at >= datetime('now', '-1 day') AND status != 'DELETED'`).n;
  const logins24h = get(`SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'login_success' AND created_at >= datetime('now', '-1 day')`).n;
  const failedLogins24h = get(`SELECT COUNT(*) AS n FROM auth_events WHERE event_type = 'login_failed' AND created_at >= datetime('now', '-1 day')`).n;

  const topSubmitters = all(
    `SELECT u.email, COUNT(*) AS runs
     FROM runs r
     JOIN users u ON u.id = r.user_id
     WHERE r.queued_at >= datetime('now', '-7 day') AND r.status != 'DELETED'
     GROUP BY u.email
     ORDER BY runs DESC
     LIMIT 10`
  );

  // Optional ?from=&to= (UTC datetimes "YYYY-MM-DD HH:MM:SS") — return login
  // events in that half-open range instead of the most-recent 50. The client
  // computes the range from the LOCAL day the admin picks (local midnight →
  // +24h, converted to UTC), so the day filter matches the local times shown in
  // the table. created_at is stored UTC in that exact format, so a lexical
  // string range is also chronological. Without the params, the historic
  // "latest 50" is returned.
  const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  const fromParam = (typeof req.query.from === 'string' && TS_RE.test(req.query.from)) ? req.query.from : null;
  const toParam   = (typeof req.query.to   === 'string' && TS_RE.test(req.query.to))   ? req.query.to   : null;
  const useRange  = !!(fromParam && toParam);

  const latestLogins = useRange
    ? all(
        `SELECT created_at, event_type, email, ip, user_agent
         FROM auth_events
         WHERE created_at >= ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT 1000`,
        [fromParam, toParam]
      )
    : all(
        `SELECT created_at, event_type, email, ip, user_agent
         FROM auth_events
         ORDER BY created_at DESC
         LIMIT 50`
      );

  return res.json({
    totals,
    runs_last_24h: runs24h,
    logins_last_24h: logins24h,
    failed_logins_last_24h: failedLogins24h,
    run_status_distribution: runStatus,
    top_submitters_last_7d: topSubmitters,
    latest_auth_events: latestLogins,
    auth_events_range: useRange ? { from: fromParam, to: toParam } : null
  });
});

// ── Company management ────────────────────────────────────────────────────────

router.get('/companies', (req, res) => {
  const rows = all(
    `SELECT c.id, c.name, c.slug, c.auth_mode, c.api_base, c.created_at,
            COUNT(u.id) AS user_count
     FROM companies c
     LEFT JOIN users u ON u.company_id = c.id
     GROUP BY c.id
     ORDER BY c.created_at DESC`
  );
  return res.json({ companies: rows });
});

router.post('/companies', (req, res) => {
  const { name, slug } = req.body || {};
  if (!name || !slug) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'name and slug are required.' });
  }
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const existing = get('SELECT id FROM companies WHERE slug = ?', [cleanSlug]);
  if (existing) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Company slug already in use.' });
  }
  const id = uuidv4();
  run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, ?, ?, 'bearer')`, [id, name, cleanSlug]);
  const created = get(
    `SELECT c.id, c.name, c.slug, c.auth_mode, c.api_base, c.created_at, COUNT(u.id) AS user_count
     FROM companies c LEFT JOIN users u ON u.company_id = c.id WHERE c.id = ? GROUP BY c.id`,
    [id]
  );
  return res.status(201).json({ company: created });
});

router.patch('/companies/:id', (req, res) => {
  const companyId = req.params.id;
  const company = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
  if (company.slug === PLATFORM_SLUG) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'The platform root company cannot be modified.' });
  }
  const { name, slug } = req.body || {};
  const updates = [];
  const values = [];
  if (name) { updates.push('name = ?'); values.push(name); }
  if (slug) {
    const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const existing = get('SELECT id FROM companies WHERE slug = ? AND id != ?', [cleanSlug, companyId]);
    if (existing) return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Company slug already in use.' });
    updates.push('slug = ?');
    values.push(cleanSlug);
  }
  if (updates.length === 0) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No update fields provided.' });
  values.push(companyId);
  run(`UPDATE companies SET ${updates.join(', ')} WHERE id = ?`, values);
  const updated = get(
    `SELECT c.id, c.name, c.slug, c.auth_mode, c.api_base, c.created_at, COUNT(u.id) AS user_count
     FROM companies c LEFT JOIN users u ON u.company_id = c.id WHERE c.id = ? GROUP BY c.id`,
    [companyId]
  );
  return res.json({ company: updated });
});

router.delete('/companies/:id', (req, res) => {
  const companyId = req.params.id;
  const company = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Company not found.' });
  if (company.slug === PLATFORM_SLUG) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'The platform root company cannot be deleted.' });
  }
  const userCount = get('SELECT COUNT(*) AS n FROM users WHERE company_id = ?', [companyId]).n;
  if (userCount > 0) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: `Cannot delete company with ${userCount} user(s). Reassign or delete them first.` });
  }
  // Cascade delete related data (SQLite foreign_keys pragma may not be enabled)
  transaction(() => {
    run('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
    run('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE company_id = ?)', [companyId]);
    run('DELETE FROM runs WHERE company_id = ?', [companyId]);
    run('DELETE FROM test_resources WHERE company_id = ?', [companyId]);
    run('DELETE FROM test_frameworks WHERE company_id = ?', [companyId]);
    run('DELETE FROM auth_events WHERE company_id = ?', [companyId]);
    run('DELETE FROM companies WHERE id = ?', [companyId]);
  });
  auditLog(req.user.id, companyId, req.user.email, `company_deleted:${company.name}`);
  return res.json({ deleted: true, id: companyId, name: company.name });
});

// ══════════════════════════════════════════════════════════════════════════════
// Server configuration — runtime-editable settings
// ══════════════════════════════════════════════════════════════════════════════

const CONFIG_SCHEMA = {
  MAX_CONCURRENT_RUNS: { description: 'Max parallel runs (server-wide)', type: 'number', min: 1, max: 20 },
  PARALLEL_STAGGER_MS: { description: 'Delay between batch launches (ms)', type: 'number', min: 0, max: 30000 },
  RUN_TIMEOUT_MS:      { description: 'Hard timeout per run (ms)',         type: 'number', min: 60000, max: 3600000 },
  // Logging — applied immediately on save
  LOG_LEVEL: {
    description: 'Server log verbosity (info = production-friendly, debug = verbose for troubleshooting)',
    type: 'enum',
    options: ['error', 'warn', 'info', 'debug', 'trace'],
    group: 'logging'
  },
  // SMTP settings — single source of truth, used by OSCAR (password reset,
  // verification, test email) AND by Alertmanager (after the operator clicks
  // "Apply alerting config" in the Alerting section, which regenerates
  // alertmanager.yml from these same values).
  SMTP_HOST:   { description: 'SMTP server hostname (e.g. smtp-relay.brevo.com)',      type: 'string', group: 'smtp' },
  SMTP_PORT:   { description: 'SMTP port (587 for STARTTLS, 465 for SSL)',             type: 'number', min: 1, max: 65535, group: 'smtp' },
  SMTP_SECURE: { description: 'Use SSL/TLS — "true" for port 465, "false" for 587 (STARTTLS)', type: 'string', group: 'smtp' },
  SMTP_USER:   { description: 'SMTP authentication identity (often a relay-internal id like a731f1001@smtp-brevo.com — NOT the address recipients see)', type: 'string', group: 'smtp', label: 'SMTP login' },
  SMTP_PASS:   { description: 'SMTP password / API key (e.g. Brevo SMTP key starting with xsmtpsib-...)', type: 'string', group: 'smtp', sensitive: true, label: 'SMTP password' },
  SMTP_FROM:   { description: 'Sender shown in the From: header (must be an address your SMTP relay has verified — e.g. OSCAR Platform <noreply@yourdomain.com>)', type: 'string', group: 'smtp', label: 'Display "From" address' },
  // Alerting (v1.9) — used by alertmanagerConfig.js to regenerate alertmanager.yml.
  ALERT_RECIPIENTS:       { description: 'Admin emails to receive alerts — comma or newline separated. Same SMTP relay as above.', type: 'string', group: 'alerting' },
  ALERT_REPEAT_CRITICAL:  { description: 'How often to re-page critical alerts until acknowledged (e.g. 1h, 30m)', type: 'string', group: 'alerting' },
  ALERT_REPEAT_WARNING:   { description: 'How often to re-page warning alerts until acknowledged (e.g. 4h, 12h)', type: 'string', group: 'alerting' },
};

router.get('/config', (req, res) => {
  const config = {};
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    let value = getConfig(key, '');
    // Mask sensitive values (show first 4 chars + ****)
    if (schema.sensitive && value) {
      value = value.length > 4 ? value.slice(0, 4) + '****' : '****';
    }
    config[key] = { value, ...schema };
  }

  const serverInfo = {
    version:         '1.0.0',
    node_version:    process.version,
    platform:        process.platform,
    collection_path: process.env.COLLECTION_PATH || '',
    bru_cmd:         process.env.BRU_CMD || '',
    uptime_seconds:  Math.floor(process.uptime()),
    db_path:         'data/oscar.db',
  };

  return res.json({ config, server_info: serverInfo });
});

// Soft-validation hints for SMTP — NOT errors that block the save (the operator
// might genuinely want an unusual setup), but warnings surfaced in the response
// body so the UI can highlight likely-mistakes inline. Closes the diagnostic
// gap that produced the SMTP_USER-pasted-into-SMTP_FROM incident.
const INTERNAL_RELAY_DOMAINS = [
  'smtp-brevo.com', 'smtp.sendgrid.net', 'smtp-sendgrid.net',
  'smtp.mailgun.org', 'smtp.postmarkapp.com', 'smtp.mailtrap.io'
];
function smtpFromWarnings(value, allValues) {
  const w = [];
  const v = String(value || '').toLowerCase();
  if (INTERNAL_RELAY_DOMAINS.some(d => v.endsWith('@' + d) || v.includes('@' + d + '>'))) {
    w.push("This looks like an SMTP relay's internal authentication identity, not a sender address. Recipients will see this in the From: header and most receiving mail servers will reject the message. Use an address on a domain your relay has verified (e.g. noreply@yourdomain.com).");
  }
  const userVal = String(allValues.SMTP_USER || allValues.smtp_user || '').toLowerCase();
  if (userVal && (v === userVal || v.includes('<' + userVal + '>'))) {
    w.push('SMTP "From" address is the same as the SMTP login. These are usually different — the login authenticates you to the relay, the From: is what recipients see.');
  }
  return w;
}

router.patch('/config', (req, res) => {
  const body = req.body || {};
  const updated = [];
  const errors  = [];
  const warnings = [];

  for (const [key, rawValue] of Object.entries(body)) {
    const schema = CONFIG_SCHEMA[key];
    if (!schema) {
      errors.push(`Unknown config key: ${key}`);
      continue;
    }

    let value;
    if (schema.type === 'number') {
      value = Number(rawValue);
      if (isNaN(value)) {
        errors.push(`${key}: must be a number`);
        continue;
      }
      if (schema.min != null && value < schema.min) { errors.push(`${key}: minimum is ${schema.min}`); continue; }
      if (schema.max != null && value > schema.max) { errors.push(`${key}: maximum is ${schema.max}`); continue; }
    } else if (schema.type === 'enum') {
      value = String(rawValue || '');
      if (!schema.options || !schema.options.includes(value)) {
        errors.push(`${key}: must be one of ${(schema.options || []).join(', ')}`);
        continue;
      }
    } else {
      // String type — skip masked values (unchanged sensitive fields)
      value = String(rawValue || '');
      if (schema.sensitive && value.includes('****')) continue; // skip — user didn't change it
    }

    run(
      `INSERT INTO server_config (key, value, updated_at, updated_by)
       VALUES (?, ?, datetime('now'), ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [key, String(value), req.user.email]
    );

    // Apply runtime side-effects for keys that need immediate action
    if (key === 'LOG_LEVEL') {
      try { require('../../utils/logger').setLevel(String(value)); } catch (_) { /* ignore */ }
    }
    // Soft warnings for the SMTP_FROM gotcha — surfaced to the UI so admins
    // see them inline next to the field, but do not block the save.
    if (key === 'SMTP_FROM') {
      smtpFromWarnings(value, body).forEach(msg => warnings.push({ key, message: msg }));
    }

    updated.push({ key, value: schema.sensitive ? '****' : String(value) });
  }

  if (errors.length > 0 && updated.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: errors.join('; ') });
  }

  auditLog(req.user.id, null, req.user.email, `config_updated:${updated.map(u => `${u.key}=${u.value}`).join(',')}`);

  // Return the full config after update
  const config = {};
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    config[key] = { value: getConfig(key, ''), ...schema };
  }

  return res.json({ updated, errors, warnings, config });
});

// ── POST /v1/admin/alertmanager/apply (v1.9.0) ───────────────────────────────
// Regenerate alertmanager.yml from current Server Config (SMTP_* + ALERT_*),
// write it to the shared volume mounted into the alertmanager container, and
// hot-reload Alertmanager via its built-in /-/reload endpoint. No SSH or VPS
// file edits needed. Surfaces the verbatim outcome of every step so admins
// can self-diagnose if anything goes wrong.
const alertmanagerConfig = require('../../utils/alertmanagerConfig');
router.post('/alertmanager/apply', async (req, res) => {
  const result = await alertmanagerConfig.applyConfig();
  auditLog(req.user.id, null, req.user.email,
    `alertmanager_apply:${result.ok ? 'ok' : 'failed'}:${result.error || ''}`);
  // 200 even on partial failure (file written, reload failed) — the response
  // carries the diagnostic detail. The UI surfaces it inline regardless.
  return res.json(result);
});

// ── POST /v1/admin/rotate-jwt-secret — invalidate all sessions ───────────────
// Generates a new JWT secret in the DB. All currently issued tokens become
// invalid immediately. Use after suspected token leak or scheduled rotation.
const crypto = require('crypto');
router.post('/rotate-jwt-secret', (req, res) => {
  const newSecret = crypto.randomBytes(32).toString('hex');
  run(
    `INSERT INTO server_config (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ['JWT_SECRET', newSecret, req.user.email]
  );
  process.env.JWT_SECRET = newSecret;
  auditLog(req.user.id, null, req.user.email, 'jwt_secret_rotated');
  return res.json({ rotated: true, message: 'JWT secret rotated. All existing sessions are now invalid.' });
});

// ── POST /v1/admin/test-email ────────────────────────────────────────────────
// Sends a small fixed-content email using the current SMTP config so the
// admin can verify end-to-end delivery without going through registration.
// Closes the diagnostic gap that issue #14 surfaced (only way to test SMTP
// was to attempt registration and SSH into the container for the log).
//
// Rate-limited to 6 sends per 5 minutes per admin user — generous for normal
// "configure-and-verify" loops, but blocks turning the endpoint into a small
// outbound spam relay if an admin account is ever compromised.
const testEmailLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `test-email:${req.user && req.user.id}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'Test-email rate limit: 6 per 5 minutes per admin.' }
});

router.post('/test-email',
  testEmailLimiter,
  // Use express-validator's isEmail() — same library and complexity-bounded
  // regex used everywhere else in this codebase. Avoids the polynomial-ReDoS
  // risk CodeQL flagged on a hand-rolled `[^\s@]+@[^\s@]+\.[^\s@]+` pattern
  // (multiple unbounded quantifiers on overlapping negated classes).
  validate([
    v.body('to').isString().withMessage('"to" is required')
      .isEmail().withMessage('"to" must be a valid email address')
      .isLength({ max: 254 }).withMessage('"to" is too long'),
  ]),
  async (req, res) => {
  const to = String(req.body.to).trim().toLowerCase();

  if (!isSmtpConfigured()) {
    auditLog(req.user.id, null, req.user.email, `test_email:not_configured:${to}`);
    return res.status(409).json({
      status: 409, title: 'SMTP Not Configured',
      detail: 'SMTP_HOST, SMTP_USER and SMTP_PASS must all be set on the Server Config tab before sending a test email.'
    });
  }

  try {
    const info = await sendTestEmail({ to, requestedBy: req.user.email });
    auditLog(req.user.id, null, req.user.email, `test_email:sent:${to}`);
    return res.json({
      ok: true,
      to,
      messageId: info.messageId,
      response:  info.response,
      accepted:  info.accepted,
      rejected:  info.rejected
    });
  } catch (err) {
    // Don't 5xx — this is a diagnostic endpoint and the failure detail is
    // the entire point. Return 200 with ok:false so the UI can surface the
    // specific SMTP error verbatim ("535 Authentication failed", etc.) to
    // the admin trying to debug their config.
    auditLog(req.user.id, null, req.user.email, `test_email:failed:${to}:${err.code || 'UNKNOWN'}`);
    return res.json({
      ok: false,
      to,
      error: err.message || String(err),
      code:  err.code || null,
      command: err.command || null,
      responseCode: err.responseCode || null,
      response: err.response || null
    });
  }
});

module.exports = router;
