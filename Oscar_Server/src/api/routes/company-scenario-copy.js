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
 *   GET  /v1/company/scenario-catalogue      the catalogue, against this framework
 *
 * The target is the request's company (enforceTenant: the own company or the
 * provider named with X-Provider-Id). The source is a parameter, checked with
 * the same rule, canUseCompany(); an unknown or refused source answers 404.
 * A tester copies only what their view of the source shows them, and the
 * copies are theirs. The rules of the copy are in utils/scenarioCopy.js.
 *
 * #612: `source_id: "catalogue"` copies reference scenarios from the scenario
 * catalogue (utils/scenarioCatalogue.js) instead of a company. Those whose
 * requirements this company's Test Framework does not declare are refused.
 */

const express   = require('express');
const fs        = require('node:fs');
const path      = require('node:path');
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
const { catalogueDatafile, catalogueFor } = require('../../utils/scenarioCatalogue');
const { adaptCatalogueDatafile, suggestTrip, journeysMissing } = require('../../utils/catalogueMatch');
const TripApply = require('../../../public/js/trip-apply');
const { copyReport } = require('../../../public/js/copy-report');
const { getRunSelection } = require('../../utils/runSelections');
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
const CATALOGUE = 'catalogue';
const CATALOGUE_NAME = 'Scenario catalogue';

const REFUSAL_TITLES = { 404: 'Not Found', 503: 'Service Unavailable' };

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

// #612: a file of the collection the runs use (COLLECTION_PATH), else the
// repository's copy, as the data file schema is read.
function collectionJson(...parts) {
  const candidates = [
    path.join(path.resolve(process.env.COLLECTION_PATH || '/collection'), ...parts),
    path.resolve(__dirname, '../../../../Bruno_Collection', ...parts),
  ];
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* the next copy */ }
  }
  throw new Refusal(503, 'The scenario catalogue cannot be read on this server.');
}

function readCatalogue() {
  return { catalogue: collectionJson('data_base', 'scenario_catalogue.json'), simulator: collectionJson('data_base', 'simulator_datafile.json') };
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
      // The Test Data routes store any JSON value; only an object is a train or journey.
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
      return { id: r.id, resource_type: r.resource_type, label: r.label, data };
    });
}

// The source data file as this user may see it: the catalogue's (#612), or a
// company's, a tester's view of it. A Refusal when there is none.
async function readSource(user, sourceId, fromCatalogue) {
  if (fromCatalogue) {
    const catalogue = readCatalogue();
    return { source: catalogueDatafile(catalogue.catalogue, catalogue.simulator), catalogue };
  }
  const stored = await readDatafile(sourceId);
  if (!stored) throw new Refusal(404, 'The source has no data file.');
  return { source: user.role === 'company_user' ? viewForTester(stored, user.email, null) : stored, catalogue: null };
}

// Everything both routes need, or a Refusal: the target (the request's
// company), the source and its scenarios as this user may see them, and the
// target's framework and Test Data (which must exist: the copy adapts to them).
async function copyContext(req, res) {
  if (denyAdminAndCertifier(req, res)) return null;
  const targetId = resolveCompanyScope(req, res);
  if (targetId === null) return null;
  const sourceId = req.body?.source_id;
  const fromCatalogue = sourceId === CATALOGUE;
  if (typeof sourceId !== 'string' || sourceId === targetId || (!fromCatalogue && !canUseCompany(req.user, sourceId))) {
    res.status(404).json(SOURCE_NOT_FOUND);
    return null;
  }
  try {
    const { source, catalogue } = await readSource(req.user, sourceId, fromCatalogue);
    const frameworkConfig = readFramework(targetId);
    if (!frameworkConfig) throw new Refusal(409, 'Set up the Test Framework of the company you copy into first.');
    const resources = readTestData(targetId);
    if (!resources.length) throw new Refusal(409, 'Add trains or journeys to the Test Data of the company you copy into first.');
    const names = Object.fromEntries(all('SELECT id, name, slug FROM companies WHERE id IN (?, ?)', [sourceId, targetId])
      .map(c => [c.id, c]));
    if (fromCatalogue) names[CATALOGUE] = { id: CATALOGUE, name: CATALOGUE_NAME };
    const entries = catalogue ? catalogueFor(catalogue.catalogue, catalogue.simulator, frameworkConfig) : null;
    // #681: reference scenarios take this company's values, and say what is left.
    const adapted = entries ? adaptCatalogueDatafile(source, entries, frameworkConfig) : { datafile: source, notes: {} };
    return { targetId, sourceId, source: adapted.datafile, notes: adapted.notes, frameworkConfig, resources, names, entries };
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    res.status(err.status).json({ status: err.status, title: REFUSAL_TITLES[err.status] || 'Conflict', detail: err.message });
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

// #681: whether the run list of this user, once the copy is written, is
// "ALL", so that a copied scenario runs without being ticked. The same reading
// as POST /v1/runs: a tester's own list when they have one, else the file's;
// a missing file list becomes [] with the copy.
function runsAllAfterCopy(user, companyId, stored) {
  const fileList = stored && 'scenariosToRun' in stored ? stored.scenariosToRun : [];
  if (user.role === 'company_user') {
    const selection = getRunSelection(companyId, user.id);
    return (selection == null ? fileList : selection) === 'ALL';
  }
  return !Array.isArray(fileList);
}

// ── POST /scenario-copy/preview ───────────────────────────────────────────────
router.post('/scenario-copy/preview', previewLimiter, async (req, res) => {
  const ctx = await copyContext(req, res);
  if (!ctx) return;
  const codes = (Array.isArray(ctx.source.scenarios) ? ctx.source.scenarios : [])
    .map(s => s?.code).filter(c => typeof c === 'string' && c !== '');
  const plan = planCopy(ctx.source, codes, ctx.frameworkConfig);
  // #612: what each reference scenario is for, and what it needs declared;
  // #681: what it needs from the provider's data.
  if (ctx.entries) {
    const byCode = new Map(ctx.entries.map(e => [e.code, e]));
    plan.scenarios = plan.scenarios.map(s => {
      const e = byCode.get(s.code);
      const notes = ctx.notes[s.code] || { toComplete: [], toCheck: [] };
      return {
        ...s, kind: e.kind, purpose: e.purpose, checks: e.checks, missing: e.missing, dataNeeds: e.needsText,
        toComplete: notes.toComplete, toCheck: notes.toCheck,
      };
    });
  }
  const testData = testDataChoices(ctx.resources);
  // #681: a proposed train or journey for each trip of a reference scenario.
  if (ctx.entries) {
    plan.trips = plan.trips.map(t => ({ ...t, suggested: suggestTrip(t, testData) }));
    // #799: a trip of several legs needs a journey of as many in the Test Data.
    const noJourney = journeysMissing(plan.trips, testData);
    plan.scenarios = plan.scenarios.map(s => ({ ...s, journeyLegsMissing: noJourney[s.code] || [] }));
  }
  let runsAll = false;
  try { runsAll = runsAllAfterCopy(req.user, ctx.targetId, await readDatafile(ctx.targetId)); }
  catch (err) { if (!(err instanceof Refusal)) throw err; }
  return res.json({
    runsAll,
    source: { id: ctx.sourceId, name: ctx.names[ctx.sourceId]?.name || '' },
    target: { id: ctx.targetId, name: ctx.names[ctx.targetId]?.name || '' },
    ...plan,
    testData,
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
  // #612, the golden rule: a reference scenario needing what this company's
  // framework does not declare is not copied.
  const undeclared = (ctx.entries || []).filter(e => codes.includes(e.code) && e.missing.length > 0);
  if (undeclared.length) {
    const detail = undeclared.map(e => `${e.code} needs ${e.missing.join(', ')} in the Test Framework.`).join(' ');
    return res.status(400).json({ status: 400, title: 'Bad Request', detail });
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
    // A file with no run list gets an empty one; an existing one ("ALL", a
    // comma list, an array) is the company's and stays as it is.
    if (!('scenariosToRun' in result.datafile)) result.datafile.scenariosToRun = [];

    let hash;
    try { ({ hash } = await writeDatafile({ id: ctx.targetId, slug: target.slug }, result.datafile)); }
    catch (err) {
      log.error({ err, companyId: ctx.targetId }, 'scenario copy: write failed');
      return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'Failed to save data file to disk.' });
    }
    auditLog(req.user.id, ctx.targetId, req.user.email, `scenarios_copied:${ctx.sourceId}:${result.copied.length}`);
    // #681: what a copied reference scenario still needs before it can run,
    // and the report of the copy (under the codes it now has here).
    const copied = result.copied.map(c => (ctx.notes[c.from] ? { ...c, toComplete: ctx.notes[c.from].toComplete } : c));
    const report = ctx.entries ? copyReport(copied.map(c => ({ code: c.to, toComplete: c.toComplete })), copied.map(c => c.to)) : null;
    if (report) report.runsAll = runsAllAfterCopy(req.user, ctx.targetId, result.datafile);
    return res.json({ copied, hash, report });
  });
});

// ── GET /scenario-catalogue (#612) ────────────────────────────────────────────
// The reference scenarios, each with what it needs the Test Framework to
// declare and what this company's framework lacks. Needs no Test Data: it is
// for reading; the copy is POST /scenario-copy with source_id "catalogue".
router.get('/scenario-catalogue', previewLimiter, (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return;
  try {
    const { catalogue, simulator } = readCatalogue();
    const entries = catalogueFor(catalogue, simulator, readFramework(companyId) || {});
    return res.json({ entries });
  } catch (err) {
    if (err instanceof Refusal) return res.status(err.status).json({ status: err.status, title: 'Service Unavailable', detail: err.message });
    log.error({ err }, 'scenario catalogue: not valid');
    return res.status(503).json({ status: 503, title: 'Service Unavailable', detail: 'The scenario catalogue cannot be read on this server.' });
  }
});

module.exports = router;
