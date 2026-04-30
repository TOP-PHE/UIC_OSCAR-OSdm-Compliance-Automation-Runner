'use strict';

/**
 * auth.js — JWT validation middleware
 * Attaches req.user = { id, email, companyId, role } on success.
 */

const jwt = require('jsonwebtoken');

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

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'Missing Bearer token.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
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
