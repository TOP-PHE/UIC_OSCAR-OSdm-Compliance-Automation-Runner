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

const { get } = require('../../db/db');

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
    if (user.role === 'test_manager') return true;
    return !!get('SELECT 1 AS ok FROM provider_access WHERE company_id = ? AND user_id = ?', [companyId, user.id]);
  } catch {
    return false;
  }
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

module.exports = { canUseCompany, requestedProviderId, MEMBER_ROLES };
