// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * me-credentials.js — per-user OSDM credential management.
 *
 * Each tester maintains their own auth credentials against the company's
 * OSDM API. The company row holds shared infrastructure (api_base, datafile);
 * everything below this comment is per-user.
 *
 * GET   /v1/me/credentials  — sanitised profile (no secret values)
 * PATCH /v1/me/credentials  — update credentials, encrypt secrets, clear cache
 * POST  /v1/me/credentials/test — test the saved credentials: a token, then
 *                                 GET {api_base}/versions with it (#872)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { requireAuth, isPlatformRole } = require('../middleware/auth');
const { enforceTenant, scopedCompanyId } = require('../middleware/tenant');
const { credentialsFor } = require('../../utils/testerCredentials');
const { safeUserCreds, credentialFieldsOf, saveCredentialFields } = require('../helpers/credentialsInput');
const { auditLog, denyAdminAndCertifier } = require('../helpers/shared');
const { testCredentials } = require('../../services/credentialTest');

const router = express.Router();
// #540: credentials are per (user, company). The company is the one the
// request acts in: the own company, or a provider named with X-Provider-Id /
// ?provider_id= that enforceTenant admitted (404 otherwise).
// A platform user (administrator, certifier) is not a tenant member: it keeps
// one set, for its own company, used for any company it names (as before
// #540), so no company is resolved for it here.
const credentialsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window.' }
});
router.use(credentialsLimiter);
router.use(requireAuth, (req, res, next) => (isPlatformRole(req.user.role) ? next() : enforceTenant(req, res, next)));

router.get('/', (req, res) => {
  const u = credentialsFor(req.user.id, scopedCompanyId(req));
  if (!u) return res.status(404).json({ status: 404, title: 'Not Found' });
  return res.json(safeUserCreds(u));
});

router.patch('/', (req, res) => {
  // The checks and stored fields are those of credentialsInput.js, shared
  // with the credentials a Test Manager keeps for a Company API account.
  const input = credentialFieldsOf(req.body);
  if (input.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: input.error });

  // Written for the company this request acts in (#540), never another's.
  // A save is for the endpoint as it is now: the credentials go to no other
  // (utils/credentialEndpoint.js). Saving again after a change confirms them.
  // A run pod kept for this user's runs there never serves new credentials (#1309).
  const companyId = scopedCompanyId(req);
  const shown = saveCredentialFields(req.user.id, companyId, input.fields);

  auditLog(req.user.id, companyId, req.user.email, `me_credential_update:${input.changed.join(',')}`);

  return res.json(shown);
});

// ── POST /v1/me/credentials/test (#872) ──────────────────────────────────────
// Tests what is saved here, for the company or provider of the request: a
// token by the path a run takes (forced fresh, so the token cache is written
// as a run writes it, and nothing else is), then one GET {api_base}/versions.
// The answer never holds the token. A member who keeps credentials here only:
// administrators and certifiers run nothing against a provider.
// Ten a minute per user: each test calls the token endpoint and the provider.
const credentialsTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => `credentials-test:${req.user?.id || ipKeyGenerator(req, res)}`,
  message: { status: 429, title: 'Too Many Requests', detail: 'At most 10 credential tests a minute. Wait a moment and try again.' }
});

router.post('/test', credentialsTestLimiter, async (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  const companyId = req.companyId;
  const result = await testCredentials(req.user.id, companyId);
  auditLog(req.user.id, companyId, req.user.email, `credentials_tested:${result.outcome}`);
  return res.json(result);
});

module.exports = router;
