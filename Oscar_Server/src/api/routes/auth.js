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
const { sendVerificationEmail, sendPasswordResetEmail, sendAccountNotice } = require('../../utils/mailer');
const AccessRequests = require('../../utils/accessRequests');
const { isApiAccountRole } = require('../../utils/apiAccounts');
const { resolveRole, ensurePlatformCompany } = require('../helpers/shared');
const bootstrapToken = require('../../utils/bootstrapToken');
const { loginAttempts } = require('../../utils/metrics');
const { validate, v } = require('../middleware/validate');
const Mfa = require('../helpers/mfa');
const LoginLock = require('../helpers/loginLock');
const { durationText } = require('../../utils/loginLock');
const { authClientMeta, logAuthEvent, logUserEvent, issueSession } = require('../helpers/sessions');
const log = require('../../utils/logger').child({ module: 'auth' });

const rateLimit = require('express-rate-limit');

const router = express.Router();
const SALT_ROUNDS = 12;
// A hash of no one's password, compared when the e-mail is unknown.
const UNKNOWN_USER_HASH = bcrypt.hashSync(require('node:crypto').randomBytes(24).toString('hex'), SALT_ROUNDS);

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

// The bootstrap route (#1365): a limit of its own, named in the route's own
// chain. It was limited through router.use('/bootstrap', authLimiter), in the
// bucket of the sign-in attempts; the code scanner does not read that as a
// limit on the route, and a sign-in page left open no longer uses up the
// attempts of whoever installs the server.
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});

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
// The session itself (token, cookie, log line) is api/helpers/sessions.js.
function createUser({ companyId, email, passwordHash, role }) {
  const userId = uuidv4();
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, ?, ?)`,
    [userId, companyId, email.toLowerCase(), passwordHash, role]);
  return get('SELECT id, company_id, email, role, created_at FROM users WHERE id = ?', [userId]);
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

    const user = get('SELECT id, email, role FROM users WHERE email = ?', [lowerEmail]);
    if (!user) {
      log.warn({ email: lowerEmail }, 'Password-reset request for non-existent email — returning generic success');
      return res.json(genericResponse);
    }
    // A Company API account (#1342) has no password anyone may choose: no
    // link is made for it, and the answer is the same as for any address.
    if (isApiAccountRole(normalizeRole(user.role))) return res.json(genericResponse);

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

    // A reset carried through proves the mailbox: the address's sign-in lock goes (#1421).
    LoginLock.clearLock(String(user.email).toLowerCase());
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
router.post('/bootstrap/platform-user', bootstrapLimiter,
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

  // #1365: the route is there for the first administrator. Once an active one
  // exists it creates nobody, whatever is asked: every other account is made
  // by invitation. Looked at after the token, so the answer says nothing to a
  // caller without it; before the body's own checks, so nothing is created
  // on any path.
  if (bootstrapToken.administratorExists()) {
    log.warn({ ip: req.ip }, 'Bootstrap route called with the token while an administrator exists: refused');
    // In the audit log too: someone holds the token. Never the body sent.
    try {
      logAuthEvent({ eventType: 'bootstrap_refused:administrator_exists', ip: req.ip, userAgent: String(req.get('user-agent') || '').slice(0, 200) });
    } catch { /* an audit line never changes the answer */ }
    return res.status(409).json({ status: 409, title: 'Conflict', detail: bootstrapToken.ALREADY_AN_ADMINISTRATOR, administrator_exists: true });
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

// ── The sign-in's lock per address (#1421) ──────────────────────────────────
// A wrong password, or an address without an account: 401, or 429 when this
// attempt is the one that locks the address. The owner of an account learns
// of the lock by e-mail, once per lock; a Company API account has no owner
// reading that address.
function refuseWrongPassword(res, { email, user = null, clientMeta }) {
  const meta = { userId: user?.id, companyId: user?.company_id, email: user?.email || email, ip: clientMeta.ip, userAgent: clientMeta.userAgent };
  logAuthEvent({ ...meta, eventType: 'login_failed' });
  loginAttempts.inc({ result: 'failure' });
  const locked = LoginLock.finishAttempt(email, false);
  if (!locked) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid credentials.' });
  logAuthEvent({ ...meta, eventType: `login_locked:${locked}s` });
  if (user && !isApiAccountRole(normalizeRole(user.role))) noticeLocked(user, locked);
  return LoginLock.lockedAnswer(res, locked);
}

/** The e-mail to the owner of a locked account, never awaited: the answer does not wait for the mail. */
function noticeLocked(user, seconds) {
  let appUrl = process.env.APP_URL || 'http://localhost:3001';
  while (appUrl.endsWith('/')) appUrl = appUrl.slice(0, -1);
  const until = new Date(Date.now() + seconds * 1000).toISOString().replace('T', ' ').slice(0, 16);
  sendAccountNotice({
    to: user.email,
    subject: 'OSCAR — sign-in to your account is paused',
    heading: 'Sign-in to your account is paused',
    lines: [`Several wrong passwords were typed for your account in a short time, so OSCAR refuses every password for it for ${durationText(seconds)}, until ${until} UTC.`,
      'If it was you, wait, or reset your password from the sign-in page: a reset lifts the pause at once.',
      'If it was not you, someone may be trying to guess your password: reset it, and turn on two-factor authentication from your account page if it is not on yet.'],
    url: `${appUrl}/forgot-password.html`,
  }).catch(err => log.warn({ err: err.message }, 'Sign-in lock notice not sent'));
}

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

  // The lock per address (#1421), before anything is read: the same answer
  // whether the address has an account or not, and no password checked.
  const wait = LoginLock.beginAttempt(normalizedEmail);
  if (wait) {
    logAuthEvent({ email: normalizedEmail, eventType: 'login_refused_locked', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    loginAttempts.inc({ result: 'locked' });
    return LoginLock.lockedAnswer(res, wait);
  }

  const user = get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (!user) {
    // As long as a wrong password takes: the answer's time does not tell
    // whether the address has an account.
    await bcrypt.compare(password, UNKNOWN_USER_HASH);
    return refuseWrongPassword(res, { email: normalizedEmail, clientMeta });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  // A Company API account (#1342) signs in to no page. Its password is made
  // up and known to nobody; should one ever match, the answer is the same as
  // for a wrong password.
  if (!match || isApiAccountRole(normalizeRole(user.role))) {
    return refuseWrongPassword(res, { email: normalizedEmail, user, clientMeta });
  }
  LoginLock.finishAttempt(normalizedEmail, true);

  // Issue #449 — self-registered accounts stay locked out until a Test
  // Manager (or administrator) of their company approves them.
  if (user.status === 'pending') {
    logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: 'login_failed_pending', ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    return res.status(403).json({ status: 403, title: 'Forbidden', detail: 'Your account is awaiting approval from your company\'s Test Manager.' });
  }

  // A second factor (#1414): an account that has one, or must have one (an
  // administrator), gets the next step of the sign-in instead of a session.
  const next = Mfa.stepAfterPassword(user, normalizeRole(user.role));
  if (next) {
    logAuthEvent({ userId: user.id, companyId: user.company_id, email: user.email, eventType: `login_password_ok_${next}`, ip: clientMeta.ip, userAgent: clientMeta.userAgent });
    return res.json({ mfa: next, mfa_token: Mfa.signChallenge(user.id, next) });
  }
  return res.json(issueSession(req, res, user));
});

// ── The second factor's steps of a sign-in (#1414) ──────────────────────────
// No session: the challenge the sign-in answered stands for the account. Ten
// wrong codes in 15 minutes stop the account's codes (api/helpers/mfa.js);
// this limit is per address, before anything is read, with the sign-in's
// setting (AUTH_RATE_LIMIT_MAX, 50 by default) in a bucket of its own.
const mfaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});
const EXPIRED_SIGN_IN = 'This sign-in has expired. Sign in again with your password.';
const mfaToken = v.body('mfa_token').isString().withMessage('mfa_token is required').isLength({ max: 2048 }).withMessage('mfa_token is too long');
const mfaCode  = v.body('code').isString().withMessage('code is required').isLength({ max: 20 }).withMessage('code is too long');

function refuseCode(req, res, user, result) {
  logUserEvent(req, user, 'login_failed_mfa');
  loginAttempts.inc({ result: 'failure' });
  const [status, detail, headers] = Mfa.refusalOf(result);
  return res.status(status).set(headers).json({ status, title: status === 429 ? 'Too Many Requests' : 'Forbidden', detail });
}

// ── POST /v1/auth/mfa/verify ──────────────────────────────────────────────────
router.post('/mfa/verify', mfaLimiter, validate([mfaToken, mfaCode]), (req, res) => {
  const user = Mfa.readChallenge(req.body.mfa_token, 'verify');
  if (!Mfa.isOn(user)) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: EXPIRED_SIGN_IN });
  const result = Mfa.checkCode(user.id, req.body.code);
  if (!result.ok) return refuseCode(req, res, user, result);
  return res.json(issueSession(req, res, user, { mfa: true }));
});

// ── POST /v1/auth/mfa/setup ───────────────────────────────────────────────────
// An administrator without a factor: a new secret, its address and QR code.
router.post('/mfa/setup', mfaLimiter, validate([mfaToken]), (req, res) => {
  const user = Mfa.readChallenge(req.body.mfa_token, 'setup');
  if (!user || Mfa.stepAfterPassword(user, normalizeRole(user.role)) !== 'setup') {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: EXPIRED_SIGN_IN });
  }
  logUserEvent(req, user, 'mfa_setup_started');
  return res.json(Mfa.startSetup(user));
});

// ── POST /v1/auth/mfa/setup/confirm ───────────────────────────────────────────
// The first code turns the factor on; every other session of the account
// ends, and this answer is the new one.
router.post('/mfa/setup/confirm', mfaLimiter, validate([mfaToken, mfaCode]), (req, res) => {
  const user = Mfa.readChallenge(req.body.mfa_token, 'setup');
  if (!user || Mfa.isOn(user)) return res.status(401).json({ status: 401, title: 'Unauthorized', detail: EXPIRED_SIGN_IN });
  const result = Mfa.confirmSetup(user.id, req.body.code);
  if (!result.ok) return refuseCode(req, res, user, result);
  logUserEvent(req, user, 'mfa_enabled');
  return res.json(issueSession(req, res, get('SELECT * FROM users WHERE id = ?', [user.id]), { mfa: true }));
});

// ── GET /v1/auth/me ───────────────────────────────────────────────────────────
// Every page asks it as it loads. The limit is per address and far above
// that; it is named in the route's own chain, before the session is read.
const sessionReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window. Please try again in a minute.' }
});
router.get('/me', sessionReadLimiter, requireAuth, (req, res) => {
  const user    = get('SELECT id, email, role, created_at, mfa_enabled_at, mfa_secret_enc FROM users WHERE id = ?', [req.user.id]);
  const company = get('SELECT id, name, slug, auth_mode, api_base, datafile_updated_at FROM companies WHERE id = ?', [req.user.companyId]);
  if (!user) return res.status(404).json({ status: 404, title: 'Not Found' });
  const role = normalizeRole(user.role);
  const mfa = Mfa.stateOf(user, role);
  return res.json({ user: { id: user.id, email: user.email, role, created_at: user.created_at, mfa }, company });
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
