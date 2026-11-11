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
 * POST /v1/auth/register/request  — ask for access (name, e-mail, company typed)
 * POST /v1/auth/register/confirm  — confirm the e-mail; the request then waits
 *                                   for an administrator and a Test Manager
 * POST /v1/auth/login             — authenticate, return JWT
 * GET  /v1/auth/me                — return current user profile
 * POST /v1/auth/bootstrap/platform-user — server-side bootstrap for platform users
 */

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('node:crypto');
const { randomUUID: uuidv4 } = crypto;
const { get, run, transaction } = require('../../db/db');
const { requireAuth, normalizeRole, END_SESSIONS_SQL } = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../../utils/mailer');
const AccessRequests = require('../../utils/accessRequests');
const { resolveRole, ensurePlatformCompany } = require('../helpers/shared');
const { loginAttempts } = require('../../utils/metrics');
const { validate, v } = require('../middleware/validate');
const log = require('../../utils/logger').child({ module: 'auth' });

const rateLimit = require('express-rate-limit');

const router = express.Router();
const SALT_ROUNDS = 12;
// A hash of no one's password, compared when the e-mail is unknown.
const UNKNOWN_USER_HASH = bcrypt.hashSync(require('node:crypto').randomBytes(24).toString('hex'), SALT_ROUNDS);
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
const AUTH_RATE_LIMIT_MAX = Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '50', 10);
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

// Issue #449 — register/confirm now does more (account creation, a
// test_manager lookup, an outbound email) than before, and CodeQL's
// js/missing-rate-limiting re-fingerprinted it as a new alert even though
// the /register prefix above already rate-limits it. A dedicated, separate
// bucket applied directly on the route satisfies CodeQL's route-local
// detection without double-counting against the shared authLimiter store
// (reusing the same limiter instance twice would halve its effective
// window for every /register/* request).
const registerConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});
// NOTE: /logout is intentionally NOT rate-limited. It carries no credential to
// brute-force (it just revokes the caller's own session), and counting it in
// the same bucket as /login halved the effective login budget during rapid
// user-switching — each switch is a logout + a login. Removing it doubles the
// usable headroom for legitimate testers at no security cost.

// ── Helpers ───────────────────────────────────────────────────────────────────
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
    // req.ip: the address the trusted proxy saw (trust proxy), never the
    // leftmost X-Forwarded-For entry, which the client writes.
    ip: req.ip || req.socket?.remoteAddress || null,
    userAgent: (req.headers['user-agent'] || '').toString() || null
  };
}

function logAuthEvent({ userId = null, companyId = null, email = null, eventType, ip = null, userAgent = null }) {
  run(`INSERT INTO auth_events (user_id, company_id, email, event_type, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, companyId, email, eventType, ip, userAgent]);
}

// ── Access requests (decision 3, 2026-11-05) ─────────────────────────────────
// No list of companies is shown to a visitor: they type the company they work
// for, confirm their e-mail, then an administrator places the request in a
// company and a Test Manager of that company confirms it
// (utils/accessRequests.js). The answers never tell whether a company or an
// e-mail is known.

const GENERIC_REQUEST_ANSWER = 'If your request can be handled, you will receive an e-mail with a link to confirm your address.';

// ── POST /v1/auth/register/request ───────────────────────────────────────────
router.post('/register/request',
  validate([
    v.body('email').isString().withMessage('email is required')
      .isEmail().withMessage('email must be a valid address')
      .isLength({ max: 254 }).withMessage('email is too long'),
    v.body('name').isString().withMessage('name is required')
      .trim().isLength({ min: 1, max: 120 }).withMessage('name length 1–120 chars'),
    v.body('company').isString().withMessage('company is required')
      .trim().isLength({ min: 1, max: 160 }).withMessage('company length 1–160 chars'),
  ]),
  async (req, res) => {
    const { email, name, company } = req.body;
    const created = AccessRequests.createRequest({ email, name, company });
    if (!created) {
      log.warn('Access request for an e-mail with an account, or a request still open — generic answer, nothing sent');
      return res.json({ message: GENERIC_REQUEST_ANSWER });
    }
    try {
      const result = await sendVerificationEmail({ to: email.toLowerCase().trim(), verificationUrl: created.url });
      if (result?.devMode) {
        return res.json({ message: 'DEV MODE — SMTP not configured. Verification URL returned directly.', verificationUrl: created.url });
      }
    } catch (err) {
      run('DELETE FROM access_request WHERE token = ?', [created.token]);
      log.error({ err: err.message }, 'Verification e-mail send FAILED');
      return res.status(503).json({ status: 503, title: 'Service Unavailable', detail: 'The confirmation e-mail could not be sent. Please try again later.' });
    }
    return res.json({ message: GENERIC_REQUEST_ANSWER });
  });

// ── POST /v1/auth/register/confirm ───────────────────────────────────────────
// The e-mail is confirmed; no account yet. A password sent by a page loaded
// before this release is ignored: the person chooses it once access is given.
router.post('/register/confirm',
  registerConfirmLimiter,
  validate([
    v.body('token').isString().withMessage('token is required')
      .matches(/^[0-9a-fA-F-]{36}$/).withMessage('token must be a UUID'),
  ]),
  (req, res) => {
    const done = AccessRequests.verifyRequest(req.body.token);
    if (!done.row) {
      return res.status(done.status).json({ status: done.status, title: done.status === 410 ? 'Link Expired' : 'Not Found', detail: done.detail });
    }
    AccessRequests.noticeVerified(done.row);
    return res.json({
      verified: true,
      message: 'Your e-mail is confirmed. An administrator, then a Test Manager of your company, will check your request. You will then receive an e-mail to choose your password.',
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
      if (result?.devMode) {
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
      .matches(/\d/).withMessage('password must include a digit'),
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
      run(`UPDATE users SET password_hash = ?, ${END_SESSIONS_SQL} WHERE id = ?`, [passwordHash, user.id]);
      // Single-use: token is consumed
      run('DELETE FROM password_reset_tokens WHERE id = ?', [row.id]);
    });

    logAuthEvent({ userId: user.id, companyId: null, email: user.email, eventType: 'password_reset_confirmed' });
    log.info({ email: user.email }, 'Password reset confirmed — user can now sign in with new password');

    return res.json({ message: 'Password reset successful. You can now sign in with your new password.' });
  }
);

// ── GET /v1/auth/register/check-token ────────────────────────────────────────
// Called by verify-email.html on load, to show the e-mail and company asked.
router.get('/register/check-token', registerConfirmLimiter, (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'token is required.' });
  const found = AccessRequests.requestOfToken(token);
  if (!found.row) {
    return res.status(found.status).json({ status: found.status, title: found.status === 410 ? 'Link Expired' : 'Not Found', detail: found.detail });
  }
  return res.json({ email: found.row.email, companyName: found.row.company_text });
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
      .matches(/\d/).withMessage('password must include a digit'),
    v.body('role').optional().isString()
      .isIn(['administrator', 'certification_user']).withMessage('role must be administrator or certification_user'),
  ]),
  async (req, res) => {
  const provided = req.headers['x-platform-bootstrap-token'];
  const expected = process.env.PLATFORM_BOOTSTRAP_TOKEN;

  if (!expected) {
    return res.status(503).json({ status: 503, title: 'Service Unavailable', detail: 'PLATFORM_BOOTSTRAP_TOKEN is not configured on server.' });
  }
  // Constant-time compare — avoids leaking token length/content via timing.
  const providedBuf = Buffer.from(String(provided || ''));
  const expectedBuf = Buffer.from(expected);
  const tokenValid = providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
  if (!provided || !tokenValid) {
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
    // As long as a wrong password takes: the answer's time does not tell
    // whether the address has an account.
    await bcrypt.compare(password, UNKNOWN_USER_HASH);
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

  // Issue #449 — self-registered accounts stay locked out until a Test
  // Manager (or administrator) of their company approves them.
  if (user.status === 'pending') {
    logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_failed_pending', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Your account is awaiting approval from your company\'s Test Manager.' });
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
  const authHeader = req.headers['authorization'] || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const rawToken = rawCookie
    ? decodeURIComponent(rawCookie.slice(1).join('='))
    : bearerToken;

  if (rawToken) {
    try {
      const payload = jwt.decode(rawToken);
      if (payload?.jti) {
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
//     (X-User-Role is Grafana's role for that user, GRAFANA_ROLE below)
//   - No session, or an ended one → 401 (requireAuth): the proxy sends the
//     browser to the sign-in page (nginx's @sso_login, Traefik's
//     authSigninURL)
//   - A session, but not an administrator's → 403 (#1199): signing in again
//     would not help, and a redirect to the sign-in page would bring the
//     same person back here in a loop
//
// nginx receives the 200/401/403 from this call and decides whether to allow
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
// The role Grafana gives an OSCAR administrator, read from X-User-Role (#1193).
// Grafana's auth proxy takes it only when it is one of Grafana's roles
// (Viewer, Editor, Admin) and sets it at each sign-in; any other word is
// ignored, which is how "administrator" left everyone a Viewer, without
// Explore. Editor gives Explore and dashboards to edit, not Grafana's own
// administration. Only an administrator's session gets this far.
const GRAFANA_ROLE = 'Editor';
router.get('/sso-check', ssoCheckLimiter, requireAuth, (req, res) => {
  const role = normalizeRole(req.user?.role);
  if (role !== 'administrator') {
    return res.status(403).set('Cache-Control', 'no-store').json({
      status: 403, title: 'Forbidden',
      detail: 'SSO into the admin observability stack is restricted to administrators.'
    });
  }
  // requireAuth has already populated req.user; use the email straight from there.
  return res
    .set('Cache-Control', 'no-store')
    .set('X-User-Email', req.user.email || '')
    .set('X-User-Role',  GRAFANA_ROLE)
    .json({ ok: true });
});

module.exports = router;
