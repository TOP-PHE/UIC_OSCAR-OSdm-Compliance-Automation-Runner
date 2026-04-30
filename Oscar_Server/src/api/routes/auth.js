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
const { v4: uuidv4 } = require('uuid');
const { get, all, run, transaction } = require('../../db/db');
const { requireAuth, normalizeRole } = require('../middleware/auth');
const { sendVerificationEmail, isSmtpConfigured } = require('../../utils/mailer');
const { resolveRole, ensurePlatformCompany } = require('../helpers/shared');
const { validate, v } = require('../middleware/validate');
const log = require('../../utils/logger').child({ module: 'auth' });

const rateLimit = require('express-rate-limit');

const router = express.Router();
const SALT_ROUNDS = 12;
const JWT_EXPIRY  = '8h';

// ── Rate limiting for auth endpoints (brute-force protection) ────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  max: 20,                    // max 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});
router.use('/login', authLimiter);
router.use('/register', authLimiter);
router.use('/bootstrap', authLimiter);
const REGISTRATION_EXPIRY_HOURS = 24;

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeSlug(name) {
  return name.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function signToken(user, company) {
  const role = normalizeRole(user.role);
  return jwt.sign(
    { sub: user.id, email: user.email, companyId: company.id, role },
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

  return res.status(201).json({
    token:   jwtToken,
    user:    { id: user.id, email: user.email, role: normalizeRole(user.role) },
    company: { id: company.id, name: company.name, slug: company.slug }
  });
});

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
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_failed', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials.' });
  }

  const company = get('SELECT * FROM companies WHERE id = ?', [user.company_id]);
  const token   = signToken(user, company);

  logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_success', ip: clientMeta.ip, userAgent: clientMeta.userAgent });

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

module.exports = router;
