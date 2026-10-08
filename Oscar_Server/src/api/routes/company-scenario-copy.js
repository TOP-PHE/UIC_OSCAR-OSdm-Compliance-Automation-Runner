// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-scenario-copy.js — copy scenarios from another company or provider
 * of the same distributor into the one the request acts in (#540).
 *
 *   POST /v1/company/scenario-copy/preview   { source_id }
 *   POST /v1/company/scenario-copy           { source_id, codes, trip_map }
 *
 * The target is the request's company (enforceTenant: the own company or the
 * provider named with X-Provider-Id). The source is a parameter, checked with
 * the same rule, canUseCompany(); an unknown or refused source answers 404.
 * A tester copies only what their view of the source shows them, and the
 * copies are theirs. The rules of the copy are in utils/scenarioCopy.js.
 */

const express   = require('express');
const fs        = require('node:fs');
const rateLimit = require('express-rate-limit');
const { get, all, colDecrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { auditLog, resolveCompanyScope, denyAdminAndCertifier } = require('../helpers/shared');
const { canUseCompany } = require('../helpers/provider-access');
const { viewForTester } = require('../../utils/datafileOwnership');
const { templatesAddedBy, saveRefusal } = require('../../utils/datafileTemplates');
const { withDatafileLock } = require('../../utils/datafileLock');
const { writeDatafile } = require('../../utils/datafileWrite');
const { decryptFromFileAsync } = require('../../utils/at-rest');
const { planCopy, applyCopy } = require('../../utils/scenarioCopy');
const TripApply = require('../../../public/js/trip-apply');
const log = require('../../utils/logger').child({ module: 'scenario-copy' });

const router = express.Router();

const previewLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many requests in a short window.' },
});
const copyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many copies. Please wait before trying again.' },
});

router.use(requireAuth, enforceTenant);

const SOURCE_NOT_FOUND = { status: 404, title: 'Not Found', detail: 'Source not found.' };

class Refusal extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// A company's datafile as an object; null when it has none. Throws a Refusal
// when it exists but cannot be read: copying from or into it would guess.
async function readDatafile(companyId) {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!row?.datafile_path || !fs.existsSync(row.datafile_path)) return null;
  try {
    const df = JSON.parse((await decryptFromFileAsync(row.datafile_path)).toString('utf8'));
    if (df && typeof df === 'object' && !Array.isArray(df)) return df;
  } catch (err) {
    log.error({ err, companyId }, 'scenario copy: data file unreadable');
  }
  throw new Refusal(409, 'A data file involved in the copy cannot be read. Ask your Test Manager to check it.');
}

function readFramework(companyId) {
  const row = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
  if (!row) return null;
  try { return JSON.parse(colDecrypt(row.config)); } catch { return {}; }
}

function readTestData(companyId) {
  return all(`SELECT id, resource_type, label, data FROM test_resources
               WHERE company_id = ? AND resource_type IN ('TRAIN', 'JOURNEY') ORDER BY created_at ASC`, [companyId])
    .map(r => {
      let data = {};
      try { data = JSON.parse(colDecrypt(r.data)); } catch { /* an unreadable entry offers nothing */ }
      return { id: r.id, resource_type: r.resource_type, label: r.label, data };
    });
}

// Everything both routes need, or a Refusal: the target (the request's
// company), the source and its scenarios as this user may see them, and the
// target's framework and Test Data (which must exist: the copy adapts to them).
async function copyContext(req, res) {
  if (denyAdminAndCertifier(req, res)) return null;
  const targetId = resolveCompanyScope(req, res);
  if (targetId === null) return null;
  const sourceId = req.body?.source_id;
  if (typeof sourceId !== 'string' || sourceId === targetId || !canUseCompany(req.user, sourceId)) {
    res.status(404).json(SOURCE_NOT_FOUND);
    return null;
  }
  try {
    let source = await readDatafile(sourceId);
    if (!source) throw new Refusal(404, 'The source has no data file.');
    if (req.user.role === 'company_user') source = viewForTester(source, req.user.email, null);
    const frameworkConfig = readFramework(targetId);
    if (!frameworkConfig) throw new Refusal(409, 'Set up the Test Framework of the company you copy into first.');
    const resources = readTestData(targetId);
    if (!resources.length) throw new Refusal(409, 'Add trains or journeys to the Test Data of the company you copy into first.');
    const names = Object.fromEntries(all('SELECT id, name, slug FROM companies WHERE id IN (?, ?)', [sourceId, targetId])
      .map(c => [c.id, c]));
    return { targetId, sourceId, source, frameworkConfig, resources, names };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    res.status(err.status).json({ status: err.status, title: err.status === 404 ? 'Not Found' : 'Conflict', detail: err.message });
    return null;
  }
}

// The target's trains and journeys, as the person choosing sees them.
function testDataChoices(resources) {
  const trains = resources.filter(r => r.resource_type === 'TRAIN').map(r => {
    const d = TripApply.normalizeTrainData(r.data);
    return {
      id: r.id, label: r.label, origin: d.originURN || '', destination: d.destinationURN || '',
      services: d.services.map((s, index) => ({ index, vehicleNumber: s.vehicleNumber, departureTime: s.departureTime, arrivalTime: s.arrivalTime })),
    };
  });
  const journeys = resources.filter(r => r.resource_type === 'JOURNEY').map(r => ({
    id: r.id, label: r.label, legs: TripApply.journeyToTripLegs(r, resources).length,
  }));
  return { trains, journeys };
}

// ── POST /scenario-copy/preview ───────────────────────────────────────────────
router.post('/scenario-copy/preview', previewLimiter, async (req, res) => {
  const ctx = await copyContext(req, res);
  if (!ctx) return;
  const codes = (Array.isArray(ctx.source.scenarios) ? ctx.source.scenarios : [])
    .map(s => s?.code).filter(c => typeof c === 'string' && c !== '');
  return res.json({
    source: { id: ctx.sourceId, name: ctx.names[ctx.sourceId]?.name || '' },
    target: { id: ctx.targetId, name: ctx.names[ctx.targetId]?.name || '' },
    ...planCopy(ctx.source, codes, ctx.frameworkConfig),
    testData: testDataChoices(ctx.resources),
  });
});

// ── POST /scenario-copy ───────────────────────────────────────────────────────
router.post('/scenario-copy', copyLimiter, async (req, res) => {
  const ctx = await copyContext(req, res);
  if (!ctx) return;
  const { codes, trip_map: tripMap } = req.body || {};
  if (!Array.isArray(codes) || codes.length === 0) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'Choose at least one scenario to copy.' });
  }
  const target = ctx.names[ctx.targetId];
  return withDatafileLock(ctx.targetId, async () => {
    let stored;
    try { stored = (await readDatafile(ctx.targetId)) || {}; }
    catch (err) {
      if (!(err instanceof Refusal)) throw err;
      return res.status(err.status).json({ status: err.status, title: 'Conflict', detail: err.message });
    }
    const result = applyCopy(ctx.source, stored, {
      codes, tripMap, frameworkConfig: ctx.frameworkConfig, resources: ctx.resources, email: req.user.email,
    });
    if (result.errors) {
      return res.status(400).json({ status: 400, title: 'Bad Request', detail: result.errors.join(' '), errors: result.errors });
    }
    // NEW-10: what the copy adds may not carry a double-brace template.
    const templateRefusal = saveRefusal(templatesAddedBy(stored, result.datafile));
    if (templateRefusal) return res.status(400).json({ status: 400, title: 'Bad Request', detail: templateRefusal });
    if (!Array.isArray(result.datafile.scenariosToRun)) result.datafile.scenariosToRun = [];

    let hash;
    try { ({ hash } = await writeDatafile({ id: ctx.targetId, slug: target.slug }, result.datafile)); }
    catch (err) {
      log.error({ err, companyId: ctx.targetId }, 'scenario copy: write failed');
      return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file to disk.' });
    }
    auditLog(req.user.id, ctx.targetId, req.user.email, `scenarios_copied:${ctx.sourceId}:${result.copied.length}`);
    return res.json({ copied: result.copied, hash });
  });
});

module.exports = router;
