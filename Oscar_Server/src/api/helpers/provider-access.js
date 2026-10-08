// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * provider-access.js — which companies a company member may act in (#540).
 *
 * A distributor company can own Provider companies (companies.parent_id). A
 * member of the distributor acts in its own company by default, and in a
 * provider only when the request names it (X-Provider-Id header or
 * ?provider_id=, never the body) and this rule admits it:
 *
 *   own company                  → every member
 *   a child of the own company   → a Test Manager always; a tester only when
 *                                  listed in provider_access
 *   anything else                → nobody
 *
 * One rule, used by enforceTenant (which company a request acts in) and by
 * canUserSeeRun (which runs a member may see). Do not write a second copy in a
 * route: compare against req.companyId, which enforceTenant set from here.
 *
 * Platform roles (administrator, certification_user) are not members of a
 * tenant and are never admitted here; they keep their own paths.
 */

const { get, run } = require('../../db/db');

const MEMBER_ROLES = new Set(['tester', 'company_user', 'test_manager']);

/**
 * May this member act in this company? `user` is { id, companyId, role } as
 * requireAuth sets it. Never throws; anything unexpected is a refusal.
 */
function canUseCompany(user, companyId) {
  if (!user || !MEMBER_ROLES.has(user.role)) return false;
  if (typeof companyId !== 'string' || companyId === '') return false;
  if (typeof user.companyId !== 'string' || user.companyId === '') return false;
  if (companyId === user.companyId) return true;
  try {
    const company = get('SELECT parent_id FROM companies WHERE id = ?', [companyId]);
    if (!company || company.parent_id !== user.companyId) return false;
    // A provider is decided on the user as stored now, not as the session
    // token says: a Test Manager demoted or moved since signing in loses the
    // distributor's providers at once, not when the token expires.
    const member = currentMember(user);
    if (!member) return false;
    if (member.role === 'test_manager') return true;
    return !!get('SELECT 1 AS ok FROM provider_access WHERE company_id = ? AND user_id = ?', [companyId, user.id]);
  } catch {
    return false;
  }
}

/**
 * The user as stored, when it is still a member of the company its token
 * names: { role } (normalised), or null.
 */
function currentMember(user) {
  const { normalizeRole } = require('../middleware/auth');
  const row = get('SELECT company_id, role FROM users WHERE id = ?', [user?.id]);
  if (!row || row.company_id !== user.companyId) return null;
  const role = normalizeRole(row.role);
  return MEMBER_ROLES.has(role) ? { role } : null;
}

/**
 * The provider a request names. Returns undefined when it names none, the id
 * when it names exactly one, and null when the naming is malformed (a repeated
 * query parameter, or a header and a query that disagree), which callers
 * answer like an unknown provider.
 */
function requestedProviderId(req) {
  const header = req.headers?.['x-provider-id'];
  const query = req.query?.provider_id;
  const fromHeader = header === undefined || header === '' ? undefined : header;
  const fromQuery = query === undefined || query === '' ? undefined : query;
  for (const v of [fromHeader, fromQuery]) {
    if (v !== undefined && typeof v !== 'string') return null;
  }
  if (fromHeader !== undefined && fromQuery !== undefined && fromHeader !== fromQuery) return null;
  return fromHeader === undefined ? fromQuery : fromHeader;
}

/**
 * Call after a user's company or role was changed (admin or Test Manager
 * edit), with the users row as it was before, inside the same transaction.
 *
 *  - Provider grants were given for one company and one role: a change of
 *    either ends them, so a user moved back, or demoted again, does not get
 *    access back without a Test Manager granting it.
 *  - Credentials follow the user, as they did before #540: the set kept for
 *    the old own company becomes the set for the new one. Sets for the old
 *    company's providers are removed: they cannot be reached any more.
 */
function membershipChanged(userId, before) {
  const after = get('SELECT company_id, role FROM users WHERE id = ?', [userId]);
  if (!after || !before) return;
  const { normalizeRole } = require('../middleware/auth');
  const moved = after.company_id !== before.company_id;
  if (moved || normalizeRole(after.role) !== normalizeRole(before.role)) {
    run('DELETE FROM provider_access WHERE user_id = ?', [userId]);
  }
  if (moved) {
    run('DELETE FROM tester_credentials WHERE user_id = ? AND company_id != ?', [userId, before.company_id]);
    run('UPDATE tester_credentials SET company_id = ? WHERE user_id = ? AND company_id = ?', [after.company_id, userId, before.company_id]);
  }
}

module.exports = { canUseCompany, currentMember, requestedProviderId, membershipChanged, MEMBER_ROLES };
