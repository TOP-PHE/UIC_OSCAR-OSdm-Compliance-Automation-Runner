// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * me-mfa.js — an account's own second factor (#1414).
 *
 * GET    /v1/me/mfa          — { enabled, required, enabled_at }
 * POST   /v1/me/mfa/setup    — { password } → { secret, otpauth_uri, qr }
 * POST   /v1/me/mfa/confirm  — { code } → the factor is on; a new session
 * DELETE /v1/me/mfa          — { password, code } → the factor is off; a new session
 *
 * Any signed-in account; an administrator's factor is required, so it cannot
 * be turned off here (another administrator resets it). Turning the factor on
 * or off ends every session of the account, and the answer carries the new
 * one (cookie and token), as a sign-in does. A wrong password or code is a
 * 403, never a 401: the pages read a 401 as a session that ended.
 */

const express = require('express');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { get } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { validate, v } = require('../middleware/validate');
const Mfa = require('../helpers/mfa');
const { issueSession, logUserEvent } = require('../helpers/sessions');

const router = express.Router();

// Per address, with the sign-in's setting (AUTH_RATE_LIMIT_MAX, 50 by default).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number.parseInt(process.env.AUTH_RATE_LIMIT_MAX || '50', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many attempts. Please try again later.' }
});

const password = v.body('password').isString().withMessage('password is required').isLength({ min: 1, max: 200 }).withMessage('password length 1–200 chars');
const code = v.body('code').isString().withMessage('code is required').isLength({ max: 20 }).withMessage('code is too long');

const userRow = id => get('SELECT * FROM users WHERE id = ?', [id]);
const problem = (res, status, detail, headers = {}) => res.status(status).set(headers).json({
  status, title: { 400: 'Bad Request', 403: 'Forbidden', 409: 'Conflict', 429: 'Too Many Requests' }[status], detail });
const refuse = (res, result) => {
  const [status, detail, headers] = Mfa.refusalOf(result);
  return problem(res, status, detail, headers);
};

router.get('/', limiter, requireAuth, (req, res) => {
  res.json(Mfa.stateOf(userRow(req.user.id), req.user.role));
});

router.post('/setup', limiter, requireAuth, validate([password]), async (req, res) => {
  const row = userRow(req.user.id);
  if (Mfa.isOn(row)) return problem(res, 409, 'Two-factor authentication is already on.');
  if (!(await bcrypt.compare(req.body.password, row.password_hash))) return problem(res, 403, 'That password is not right.');
  logUserEvent(req, row, 'mfa_setup_started');
  return res.json(Mfa.startSetup(row));
});

router.post('/confirm', limiter, requireAuth, validate([code]), (req, res) => {
  const row = userRow(req.user.id);
  if (Mfa.isOn(row)) return problem(res, 409, 'Two-factor authentication is already on.');
  const result = Mfa.confirmSetup(row.id, req.body.code);
  if (!result.ok) return refuse(res, result);
  const session = issueSession(req, res, userRow(row.id), { mfa: true, eventType: 'mfa_enabled', signIn: false });
  return res.json({ ...Mfa.stateOf(userRow(row.id), req.user.role), ...session });
});

router.delete('/', limiter, requireAuth, validate([password, code]), async (req, res) => {
  const row = userRow(req.user.id);
  if (!Mfa.isOn(row)) return problem(res, 409, 'Two-factor authentication is not on.');
  if (Mfa.isRequired(req.user.role)) {
    return problem(res, 403, 'An administrator must keep two-factor authentication. Another administrator can reset it.');
  }
  if (!(await bcrypt.compare(req.body.password, row.password_hash))) return problem(res, 403, 'That password is not right.');
  const result = Mfa.checkCode(row.id, req.body.code);
  if (!result.ok) return refuse(res, result);
  Mfa.removeFactor(row.id);
  const session = issueSession(req, res, userRow(row.id), { eventType: 'mfa_disabled', signIn: false });
  return res.json({ ...Mfa.stateOf(userRow(row.id), req.user.role), ...session });
});

module.exports = router;
