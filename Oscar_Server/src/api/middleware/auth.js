// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * auth.js — JWT validation middleware
 * Attaches req.user = { id, email, companyId, role } on success.
 *
 * Token source priority:
 *   1. oscar_session httpOnly cookie (set by /v1/auth/login and /v1/auth/logout)
 *   2. Authorization: Bearer <token> header (API clients, backward-compat)
 *
 * Revoked tokens (jti in token_blacklist) are rejected with 401.
 */

const jwt = require('jsonwebtoken');
const { get } = require('../../db/db');

const ROLE_MAP = {
  admin: 'company_user',
  member: 'company_user'
};

const PLATFORM_ROLES = new Set(['administrator', 'certification_user']);

function normalizeRole(role) {
  if (!role) return 'company_user';
  return ROLE_MAP[role] || role;
}

function isPlatformRole(role) {
  return PLATFORM_ROLES.has(normalizeRole(role));
}

// Parse a raw Cookie header into a key→value map (no dependency on cookie-parser).
function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    out[key]  = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function requireAuth(req, res, next) {
  // 1. Try httpOnly cookie
  const cookies     = parseCookies(req.headers.cookie);
  const cookieToken = cookies.oscar_session || null;

  // 2. Fall back to Authorization: Bearer header
  const header      = req.headers['authorization'] || '';
  const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : null;

  const token = cookieToken || bearerToken;

  if (!token) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Missing Bearer token.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    // Check token revocation blacklist (only if jti is present — old tokens without
    // jti are not subject to per-session revocation and remain valid until expiry).
    if (payload.jti) {
      const revoked = get('SELECT jti FROM token_blacklist WHERE jti = ?', [payload.jti]);
      if (revoked) {
        return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Token has been revoked.' });
      }
    }

    const normalizedRole = normalizeRole(payload.role);
    req.user = {
      id:        payload.sub,
      email:     payload.email,
      companyId: payload.companyId,
      role:      normalizedRole
    };
    next();
  } catch (_err) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Invalid or expired token.' });
  }
}

function isTestManagerOrAbove(role) {
  const r = normalizeRole(role);
  return r === 'test_manager' || r === 'administrator';
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 401, title: 'Unauthorized' });
    const normalizedRoles = roles.map(normalizeRole);
    if (!normalizedRoles.includes(req.user.role)) {
      return res.status(403).json({ status: 403, title: 'Forbidden', detail: `Requires role: ${roles.join(' or ')}.` });
    }
    next();
  };
}

function requireNotRole(...excludedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ status: 401, title: 'Unauthorized' });
    if (excludedRoles.includes(req.user.role)) {
      return res.status(403).json({ status: 403, title: 'Forbidden', detail: `Role ${req.user.role} cannot perform this action.` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, requireNotRole, normalizeRole, isPlatformRole, isTestManagerOrAbove };
