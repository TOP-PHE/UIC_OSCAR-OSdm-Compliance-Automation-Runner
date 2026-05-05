// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tenant.js — Company scope enforcement middleware
 * Company users are always scoped to their own company.
 * Platform users (administrator, certification_user) can optionally target
 * a specific company with query/body/header company_id.
 */

const { isPlatformRole } = require('./auth');
const { get } = require('../../db/db');

function enforceTenant(req, res, next) {
  if (!req.user || !req.user.companyId) {
    return res.status(401).json({ status: 401, title: 'Unauthorized', detail: 'No company context.' });
  }

  if (isPlatformRole(req.user.role)) {
    const bodyCompanyId = req.body && req.body.company_id ? req.body.company_id : null;
    req.companyId = req.query.company_id || req.headers['x-company-id'] || bodyCompanyId || null;
    // Validate that the specified company actually exists
    if (req.companyId) {
      const company = get('SELECT id, share_reports_with_certifier FROM companies WHERE id = ?', [req.companyId]);
      if (!company) return res.status(404).json({ status: 404, title: 'Not Found', detail: 'Specified company does not exist.' });
      // Privacy guard (v15): a certification_user targeting a specific
      // company that opted out of certifier sharing is refused. Administrators
      // are unaffected — they always have unconditional read access.
      if (req.user.role === 'certification_user' &&
          (company.share_reports_with_certifier === 0 || company.share_reports_with_certifier === false)) {
        return res.status(403).json({
          status: 403, title: 'Forbidden',
          detail: 'This company does not share reports with certifiers.'
        });
      }
    }
    return next();
  }

  req.companyId = req.user.companyId;
  next();
}

module.exports = { enforceTenant };
