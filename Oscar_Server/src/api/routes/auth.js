// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth.js — Authentication routes
 *
 * POST /v1/auth/register/request  — request Tester account (sends verification email)
 * POST /v1/auth/register/confirm  — confirm email + set password → creates account
 * POST /v1/auth/login             — authenticate, return JWT
 * GET  /v1/auth/me                — return current user profile
 * POST /v1/auth/bootstrap/platform-user — server-side bootstrap for platform users
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, all, run, transaction } = require('../../db/db');
const { requireAuth, normalizeRole } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail, isSmtpConfigured } = require('../../utils/mailer');
const { resolveRole, ensurePlatformCompany } = require('../helpers/shared');
const { loginAttempts } = require('../../utils/metrics');
const { validate, v } = require('../middleware/validate');
const log = require('../../utils/logger').child({ module: 'auth' });

const rateLimit = require('express-rate-limit');

const router = express.Router();
const SALT_ROUNDS = 12;
const JWT_EXPIRY     = '8h';
const JWT_EXPIRY_SEC = 8 * 60 * 60;   // same as JWT_EXPIRY in seconds

// ── Session cookie helper ─────────────────────────────────────────────────────
// Sets an httpOnly, Secure, SameSite=Strict cookie named oscar_session with
// the JWT so the token never touches JavaScript-accessible storage.
// The legacy token field is kept in the JSON body so CLI / API clients that
// rely on Bearer tokens continue to work.
function setSessionCookie(res, token) {
  res.cookie('oscar_session', token, {
    httpOnly: true,
    // Only enforce Secure in production. On dev/local-testing we run on
    // plain http://localhost and browsers reject Secure cookies on http,
    // which would prevent login from "sticking". `test` was previously
    // the only exemption — broaden it to "anything that isn't production".
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge:   JWT_EXPIRY_SEC * 1000,
    path:     '/',
  });
}

// ── Rate limiting for auth endpoints (brute-force protection) ────────────────
// Brute-force protection on credential-bearing auth endpoints (CodeQL
// js/missing-rate-limiting). Keyed on IP (no keyGenerator → express-rate-limit
// default). The cap is env-tunable so an operator running heavy multi-account
// testing can raise it without a code change. Default raised 20 → 50 in
// v1.11.14: a conformance-testing platform invites rapid user-switching across
// vendor accounts, and 20/15min was tripping legitimate testers (each switch is
// a login). 50/15min is still far below a useful brute-force rate.
const AUTH_RATE_LIMIT_MAX = parseInt(process.env.AUTH_RATE_LIMIT_MAX || '50', 10);
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});
router.use('/login', authLimiter);
router.use('/register', authLimiter);
router.use('/bootstrap', authLimiter);
// NOTE: /logout is intentionally NOT rate-limited. It carries no credential to
// brute-force (it just revokes the caller's own session), and counting it in
// the same bucket as /login halved the effective login budget during rapid
// user-switching — each switch is a logout + a login. Removing it doubles the
// usable headroom for legitimate testers at no security cost.
const REGISTRATION_EXPIRY_HOURS = 24;

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeSlug(name) {
  return name.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function signToken(user, company) {
  const role = normalizeRole(user.role);
  const jti  = uuidv4();
  return jwt.sign(
    { sub: user.id, email: user.email, companyId: company.id, role, jti },
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

function createUser({ companyId, email, passwordHash, role }) {
  const userId = uuidv4();
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
    [userId, companyId, email.toLowerCase(), passwordHash, role]);
  return get('SELECT id, company_id, email, role, created_at FROM users WHERE id = ?', [userId]);
}

function authClientMeta(req) {
  return {
    ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null,
    userAgent: (req.headers['user-agent'] || '').toString() || null
  };
}

function logAuthEvent({ userId = null, companyId = null, email = null, eventType, ip = null, userAgent = null }) {
  run(`INSERT INTO auth_events (user_id, company_id, email, event_type, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, companyId, email, eventType, ip, userAgent]);
}

/**
 * Check that the email address contains at least one significant word
 * from the company name (3+ characters). This ensures users register
 * with their company email, not a personal one.
 */
function emailMatchesCompany(email, companyName) {
  const emailLower = email.toLowerCase();
  const words = companyName.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);
  if (words.length === 0) return true; // name too short to validate — let it through
  return words.some(word => emailLower.includes(word));
}

// ── GET /v1/auth/register/companies ──────────────────────────────────────────
// Public endpoint: returns list of company names for the registration dropdown.
// Only returns name and slug — no secrets, no internal IDs.
router.get('/register/companies', (_req, res) => {
  const rows = all('SELECT name, slug FROM companies ORDER BY name ASC');
  return res.json({ companies: rows.map(r => ({ name: r.name, slug: r.slug })) });
});

// ── POST /v1/auth/register/request ───────────────────────────────────────────
// Step 1: user submits email + company name → receives verification email
router.post('/register/request',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }).withMessage('email is too long'),
    v.body('companyName').isString().withMessage('companyName is required')
      .trim().isLength({ min: 2, max: 120 }).withMessage('companyName length 2–120 chars'),
  ]),
  async (req, res) => {
  const { email, companyName } = req.body || {};

  const lowerEmail = email.toLowerCase().trim();

  // Email–company consistency check
  if (!emailMatchesCompany(lowerEmail, companyName)) {
    return res.status(400).json({
      status: 400, title: 'Bad Request',
      detail: `Your email does not appear to match your company name "${companyName}". Please use your company email address.`
    });
  }

  // Check not already registered — generic response to prevent email enumeration
  const existingUser = get('SELECT id FROM users WHERE email = ?', [lowerEmail]);
  if (existingUser) {
    log.warn({ email: lowerEmail }, 'Registration attempt for existing user — returning generic success (no email sent)');
    return res.json({ message: 'If this email is not already registered, a verification link has been sent.' });
  }
  log.info({ email: lowerEmail, company: companyName.trim() }, 'New registration request');

  // Remove any previous pending request for this email (allow re-request)
  run('DELETE FROM pending_registrations WHERE email = ?', [lowerEmail]);

  // Create pending registration
  const token    = uuidv4();
  const id       = uuidv4();
  const expiresAt = new Date(Date.now() + REGISTRATION_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

  run('INSERT INTO pending_registrations (id, email, company_name, token, expires_at) VALUES (?, ?, ?, ?, ?)',
    [id, lowerEmail, companyName.trim(), token, expiresAt]);

  const appUrl = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const verificationUrl = `${appUrl}/verify-email.html?token=${token}`;

  try {
    log.info({
      email: lowerEmail,
      company: companyName.trim(),
      appUrl: process.env.APP_URL || 'NOT SET',
      smtpConfigured: isSmtpConfigured(),
    }, 'Sending verification email');

    const result = await sendVerificationEmail({ to: lowerEmail, companyName: companyName.trim(), verificationUrl });

    // Dev mode: return the URL directly so it can be tested without SMTP
    if (result && result.devMode) {
      log.info({ email: lowerEmail }, 'Dev mode — returning verification URL directly (no email sent)');
      return res.json({
        message: 'DEV MODE — SMTP not configured. Verification URL returned directly.',
        verificationUrl
      });
    }
    log.info({ email: lowerEmail }, 'Verification email sent successfully');
  } catch (err) {
    // Roll back pending record if email send fails
    run('DELETE FROM pending_registrations WHERE token = ?', [token]);
    log.error({ email: lowerEmail, err: err.message, stack: err.stack }, 'Email send FAILED');
    return res.status(503).json({ status: 503, title: 'Service Unavailable', detail: 'Failed to send verification email. Please try again later.' });
  }

  return res.json({ message: 'Verification email sent. Check your inbox and click the link to complete your registration.' });
});

// ── POST /v1/auth/register/confirm ───────────────────────────────────────────
// Step 2: user clicks link, sets password → account is created
router.post('/register/confirm',
  validate([
    v.body('token').isString().withMessage('token is required')
      .matches(/^[0-9a-fA-F-]{36}$/).withMessage('token must be a UUID'),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 12, max: 200 }).withMessage('password must be 12–200 chars')
      .matches(/[A-Z]/).withMessage('password must include an uppercase letter')
      .matches(/[a-z]/).withMessage('password must include a lowercase letter')
      .matches(/[0-9]/).withMessage('password must include a digit'),
  ]),
  async (req, res) => {
  const { token, password } = req.body || {};

  const pending = get('SELECT * FROM pending_registrations WHERE token = ?', [token]);
  if (!pending) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Invalid or already used confirmation link.' });
  }
  if (new Date(pending.expires_at) < new Date()) {
    run('DELETE FROM pending_registrations WHERE token = ?', [token]);
    return res.status(410).json({ status: 410, title: 'Link Expired', detail: 'This confirmation link has expired (24h limit). Please register again.' });
  }

  // Guard against race / double-click
  const existingUser = get('SELECT id FROM users WHERE email = ?', [pending.email]);
  if (existingUser) {
    run('DELETE FROM pending_registrations WHERE token = ?', [token]);
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Account already created. Please sign in.' });
  }

  const slug = makeSlug(pending.company_name);
  let company = get('SELECT * FROM companies WHERE slug = ?', [slug]);
  const companyId = company ? company.id : uuidv4();
  const userId    = uuidv4();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  transaction(() => {
    if (!company) {
      run(`INSERT INTO companies (id, name, slug, auth_mode) VALUES (?, ?, ?, 'bearer')`,
        [companyId, pending.company_name, slug]);
    }
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, 'company_user')`,
      [userId, companyId, pending.email, passwordHash]);
    run('DELETE FROM pending_registrations WHERE token = ?', [token]);
  });

  company = get('SELECT * FROM companies WHERE id = ?', [companyId]);
  const user  = get('SELECT * FROM users    WHERE id = ?', [userId]);
  const jwtToken = signToken(user, company);

  logAuthEvent({ userId: user.id, companyId: company.id, email: user.email, eventType: 'register_confirmed' });

  setSessionCookie(res, jwtToken);
  return res.status(201).json({
    token:   jwtToken,
    user:    { id: user.id, email: user.email, role: normalizeRole(user.role) },
    company: { id: company.id, name: company.name, slug: company.slug }
  });
});

// ── Password reset (issue #15) ───────────────────────────────────────────────
// Three-step self-service reset that mirrors the verified-registration flow:
//   1. POST /password-reset/request    { email }            → email a reset URL
//   2. GET  /password-reset/check-token?token=...           → token still valid?
//   3. POST /password-reset/confirm    { token, password }  → set new password
//
// Privacy: the request endpoint always returns a generic 200 — never
// discloses whether the email is registered. Tokens are single-use UUIDs
// stored in password_reset_tokens with a 24h expiry.

const PASSWORD_RESET_EXPIRY_HOURS = 24;

// Tight rate limit on the request endpoint — the only way to mass-mail
// from this surface. 5 attempts per IP per hour is generous for legitimate
// re-tries after a typo.
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many password-reset requests. Try again later.' }
});

// Rate limit the token-validation endpoints (check-token + confirm). Tokens
// are 36-char UUIDs (122 bits of entropy) so brute-force is infeasible on
// its merits, but rate-limiting is defense in depth and what CodeQL's
// js/missing-rate-limiting rule expects on auth endpoints. 30 per 15 min
// per IP is generous for a real user clicking through the flow (typos +
// retries) and tight enough to make bulk enumeration pointless.
const passwordResetTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many password-reset token attempts. Try again later.' }
});

router.post('/password-reset/request',
  passwordResetLimiter,
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }).withMessage('email is too long'),
  ]),
  async (req, res) => {
    const lowerEmail = String(req.body.email || '').toLowerCase().trim();
    const requestedIp = req.ip || null;

    // Generic-success response — never leak whether the email is registered.
    const genericResponse = {
      message: 'If an account exists for this email, a password-reset link has been sent.'
    };

    const user = get('SELECT id, email FROM users WHERE email = ?', [lowerEmail]);
    if (!user) {
      log.warn({ email: lowerEmail }, 'Password-reset request for non-existent email — returning generic success');
      return res.json(genericResponse);
    }

    // Wipe any previous outstanding token for this user (one active link at a time)
    run('DELETE FROM password_reset_tokens WHERE user_id = ?', [user.id]);

    const token     = uuidv4();
    const id        = uuidv4();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

    run(
      'INSERT INTO password_reset_tokens (id, user_id, token, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?)',
      [id, user.id, token, expiresAt, requestedIp]
    );

    const appUrl   = (process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
    const resetUrl = `${appUrl}/reset-password.html?token=${token}`;

    try {
      const result = await sendPasswordResetEmail({ to: user.email, resetUrl });
      logAuthEvent({ userId: user.id, companyId: null, email: user.email, eventType: 'password_reset_requested' });

      // Dev-mode passthrough mirrors the registration flow.
      if (result && result.devMode) {
        log.info({ email: user.email }, 'Dev mode — returning password-reset URL directly (no email sent)');
        return res.json({
          message: 'DEV MODE — SMTP not configured. Reset URL returned directly.',
          resetUrl
        });
      }
      log.info({ email: user.email }, 'Password-reset email sent');
    } catch (err) {
      // Don't roll back the token row — leaving it lets the admin
      // still hand the user a reset URL via the admin "generate reset
      // link" workaround if SMTP is broken. Log loudly.
      log.error({ email: user.email, err: err.message }, 'Password-reset email send FAILED — token retained for admin workaround');
    }

    return res.json(genericResponse);
  }
);

router.get('/password-reset/check-token', passwordResetTokenLimiter, (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'token is required.' });

  const row = get(
    `SELECT prt.expires_at, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
      WHERE prt.token = ?`,
    [token]
  );
  if (!row) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Invalid or already used reset link.' });
  }
  if (new Date(row.expires_at) < new Date()) {
    run('DELETE FROM password_reset_tokens WHERE token = ?', [token]);
    return res.status(410).json({ status: 410, title: 'Link Expired', detail: 'This reset link has expired (24h limit). Request a new one.' });
  }
  return res.json({ email: row.email });
});

router.post('/password-reset/confirm',
  passwordResetTokenLimiter,
  validate([
    v.body('token').isString().withMessage('token is required')
      .matches(/^[0-9a-fA-F-]{36}$/).withMessage('token must be a UUID'),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 12, max: 200 }).withMessage('password must be 12–200 chars')
      .matches(/[A-Z]/).withMessage('password must include an uppercase letter')
      .matches(/[a-z]/).withMessage('password must include a lowercase letter')
      .matches(/[0-9]/).withMessage('password must include a digit'),
  ]),
  async (req, res) => {
    const { token, password } = req.body || {};
    const row = get(
      'SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token = ?',
      [token]
    );
    if (!row) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Invalid or already used reset link.' });
    if (new Date(row.expires_at) < new Date()) {
      run('DELETE FROM password_reset_tokens WHERE token = ?', [token]);
      return res.status(410).json({ status: 410, title: 'Link Expired', detail: 'This reset link has expired (24h limit). Request a new one.' });
    }

    const user = get('SELECT id, email FROM users WHERE id = ?', [row.user_id]);
    if (!user) {
      run('DELETE FROM password_reset_tokens WHERE id = ?', [row.id]);
      return res.status(404).json({ status: 404, title: 'Not Found', detail: 'User no longer exists.' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    transaction(() => {
      run('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user.id]);
      // Single-use: token is consumed
      run('DELETE FROM password_reset_tokens WHERE id = ?', [row.id]);
    });

    logAuthEvent({ userId: user.id, companyId: null, email: user.email, eventType: 'password_reset_confirmed' });
    log.info({ email: user.email }, 'Password reset confirmed — user can now sign in with new password');

    return res.json({ message: 'Password reset successful. You can now sign in with your new password.' });
  }
);

// ── GET /v1/auth/register/check-token ────────────────────────────────────────
// Called by verify-email.html on page load to show email/company before password entry
router.get('/register/check-token', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'token is required.' });

  const pending = get('SELECT email, company_name, expires_at FROM pending_registrations WHERE token = ?', [token]);
  if (!pending) {
    return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Invalid or already used confirmation link.' });
  }
  if (new Date(pending.expires_at) < new Date()) {
    return res.status(410).json({ status: 410, title: 'Link Expired', detail: 'This confirmation link has expired. Please register again.' });
  }
  return res.json({ email: pending.email, companyName: pending.company_name });
});

// ── POST /v1/auth/bootstrap/platform-user ────────────────────────────────────
router.post('/bootstrap/platform-user',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 12, max: 200 }).withMessage('password must be 12–200 chars')
      .matches(/[A-Z]/).withMessage('password must include an uppercase letter')
      .matches(/[a-z]/).withMessage('password must include a lowercase letter')
      .matches(/[0-9]/).withMessage('password must include a digit'),
    v.body('role').optional().isString()
      .isIn(['administrator', 'certification_user']).withMessage('role must be administrator or certification_user'),
  ]),
  async (req, res) => {
  const provided = req.headers['x-platform-bootstrap-token'];
  const expected = process.env.PLATFORM_BOOTSTRAP_TOKEN;

  if (!expected) {
    return res.status(503).json({ status: 503, title: 'Service Unavailable', detail: 'PLATFORM_BOOTSTRAP_TOKEN is not configured on server.' });
  }
  if (!provided || provided !== expected) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid bootstrap token.' });
  }

  const { email, password, role } = req.body || {};
  const resolvedRole = resolveRole(role || 'administrator');
  if (!resolvedRole || resolvedRole === 'company_user') {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Bootstrap can only create administrator or certification_user.' });
  }

  const existingUser = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existingUser) {
    return res.status(409).json({ status: 409, title: 'Conflict', detail: 'Email already registered.' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const platformCompany = ensurePlatformCompany();
  const user = createUser({ companyId: platformCompany.id, email, passwordHash, role: resolvedRole });

  return res.status(201).json({
    user: { id: user.id, email: user.email, role: normalizeRole(user.role), company_id: user.company_id }
  });
});

// ── POST /v1/auth/login ───────────────────────────────────────────────────────
router.post('/login',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }).withMessage('email is too long'),
    v.body('password').isString().withMessage('password is required')
      .isLength({ min: 1, max: 200 }).withMessage('password length 1–200 chars'),
  ]),
  async (req, res) => {
  const { email, password } = req.body || {};

  const normalizedEmail = email.toLowerCase();
  const clientMeta = authClientMeta(req);

  const user = get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    logAuthEvent({ email: normalizedEmail, eventType: 'login_failed', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    loginAttempts.inc({ result: 'failure' });
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_failed', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    loginAttempts.inc({ result: 'failure' });
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials.' });
  }

  const company = get('SELECT * FROM companies WHERE id = ?', [user.company_id]);
  const token   = signToken(user, company);

  logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_success', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
  loginAttempts.inc({ result: 'success' });

  setSessionCookie(res, token);
  return res.json({
    token,
    user:    { id: user.id, email: user.email, role: normalizeRole(user.role) },
    company: { id: company.id, name: company.name, slug: company.slug }
  });
});

// ── GET /v1/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const user    = get('SELECT id, email, role, created_at FROM users    WHERE id = ?', [req.user.id]);
  const company = get('SELECT id, name, slug, auth_mode, api_base, datafile_updated_at FROM companies WHERE id = ?', [req.user.companyId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found' });
  return res.json({ user: { ...user, role: normalizeRole(user.role) }, company });
});

// ── POST /v1/auth/logout ──────────────────────────────────────────────────────
// Revokes the current session token (blacklists its jti) and clears the
// oscar_session cookie. Works for both cookie-authenticated and Bearer-token
// clients: we verify the token from either source, then blacklist its jti.
router.post('/logout', requireAuth, (req, res) => {
  // Extract raw token — try cookie first, then Authorization header.
  const rawCookie = (req.headers.cookie || '').split(';')
    .map(c => c.trim().split('='))
    .find(([k]) => k === 'oscar_session');
  const rawToken = rawCookie
    ? decodeURIComponent(rawCookie.slice(1).join('='))
    : ((req.headers['authorization'] || '').startsWith('Bearer ')
        ? req.headers['authorization'].slice(7)
        : null);

  if (rawToken) {
    try {
      const payload = jwt.decode(rawToken);
      if (payload && payload.jti) {
        // exp is a Unix timestamp (seconds); convert to ISO-8601
        const expiresAt = new Date((payload.exp || 0) * 1000).toISOString();
        run(
          `INSERT OR IGNORE INTO token_blacklist (jti, user_id, expires_at) VALUES (?, ?, ?)`,
          [payload.jti, req.user.id, expiresAt]
        );
      }
    } catch (_) { /* if decode fails just clear the cookie */ }
  }

  // Clear the session cookie
  res.clearCookie('oscar_session', { httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict', path: '/' });
  return res.json({ logged_out: true });
});

// ── GET /v1/auth/sso-check ───────────────────────────────────────────────────
// Internal endpoint called by nginx's `auth_request` directive to gate
// access to the admin observability stack (/grafana/, /prometheus/).
//
// Behaviour:
//   - Reads the oscar_session cookie or Authorization: Bearer header
//   - Validates the JWT (same path as requireAuth)
//   - If user.role === 'administrator' → 200 + X-User-Email + X-User-Role
//   - Else (no token, expired, wrong role) → 401
//
// nginx receives the 200/401 from this call and decides whether to allow
// the proxy_pass through. On 200 it forwards the X-User-Email back to
// the upstream (Grafana) as X-WEBAUTH-USER, which Grafana's auth.proxy
// module accepts as the authenticated identity (auto-creates the user
// on first visit).
//
// Restricted to administrators for v1 — easier to expand than retract.
//
// Cache headers: no-cache so nginx never caches the auth result. The
// JWT itself has a max-age of (typically) 24h baked into its `exp`
// claim, so even a "stale 200" reuses a token that the underlying
// requireAuth would still accept.
//
// Rate limit: 600 / 5 min / IP — generous because nginx fires this on
// EVERY proxied request to /grafana/ or /prometheus/ (one Grafana page
// load can trigger 20+ asset requests). Tighter than that risks 429s
// on legitimate dashboard browsing. Looser than 600 doesn't add abuse
// surface — requireAuth still rejects bad tokens, this just caps total
// validation work. Closes CodeQL js/missing-rate-limiting on this PR.
const ssoCheckLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'SSO check rate limit exceeded.' }
});
router.get('/sso-check', ssoCheckLimiter, requireAuth, (req, res) => {
  const role = normalizeRole(req.user && req.user.role);
  if (role !== 'administrator') {
    return res.status(401).set('Cache-Control', 'no-store').json({
      status: 401, title: 'Unauthorized',
      detail: 'SSO into the admin observability stack is restricted to administrators.'
    });
  }
  // requireAuth has already populated req.user; use the email straight from there.
  return res
    .set('Cache-Control', 'no-store')
    .set('X-User-Email', req.user.email || '')
    .set('X-User-Role',  role)
    .json({ ok: true });
});

module.exports = router;
