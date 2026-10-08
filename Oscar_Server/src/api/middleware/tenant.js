// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tenant.js — Company scope enforcement middleware
 * Company users act in their own company, or in one of its providers (#540)
 * when the request names it with X-Provider-Id or ?provider_id= and
 * canUseCompany() admits it. An unknown or unauthorised provider answers 404.
 * Platform users (administrator, certification_user) can optionally target
 * a specific company with query/body/header company_id.
 *
 * Routes read the result from req.companyId. scopedCompanyId(req) is the
 * spelling for the handlers that fall back to a platform user's own company.
 */

const { isPlatformRole } = require('./auth');
const { get } = require('../../db/db');
const { canUseCompany, requestedProviderId } = require('../helpers/provider-access');

const PROVIDER_NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Provider not found.' };

function enforceTenant(req, res, next) {
  if (!req.user?.companyId) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'No company context.' });
  }

  if (isPlatformRole(req.user.role)) {
    const bodyCompanyId = req.body?.company_id ? req.body.company_id : null;
    req.companyId = req.query.company_id || req.headers['x-company-id'] || bodyCompanyId || null;
    // Validate that the specified company actually exists.
    // v1.11.15: the company-wide certifier-sharing refusal was removed.
    // Certifier visibility is now decided per-report (shared_with_certifier_at),
    // enforced by run-access.js / the runs + reports listings — not at the
    // tenant boundary. A certifier may target any company; they will simply
    // see only the individual runs that company's test_manager has shared.
    if (req.companyId) {
      const company = get('SELECT id FROM companies WHERE id = ?', [req.companyId]);
      if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Specified company does not exist.' });
    }
    return next();
  }

  const provider = requestedProviderId(req);
  if (provider === undefined) {
    req.companyId = req.user.companyId;
    return next();
  }
  // 404, never 403: a 403 would confirm that the id names a company.
  if (provider === null || !canUseCompany(req.user, provider)) {
    return res.status(404).json(PROVIDER_NOT_FOUND);
  }
  req.companyId = provider;
  next();
}

// The company a handler acts in: the one enforceTenant chose, or, for a
// platform user who named none, their own (the platform company).
function scopedCompanyId(req) {
  return req.companyId || req.user?.companyId || null;
}

module.exports = { enforceTenant, scopedCompanyId };
