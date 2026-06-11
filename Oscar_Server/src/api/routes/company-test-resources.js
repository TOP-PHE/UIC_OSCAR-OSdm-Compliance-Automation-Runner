// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-test-resources.js — Test resource management routes (Wizard Step 2)
 *
 * GET    /v1/company/test-resources      — list test resources
 * POST   /v1/company/test-resources      — create a test resource
 * PUT    /v1/company/test-resources/:id   — update a test resource
 * DELETE /v1/company/test-resources/:id   — delete a test resource
 */

const express = require('express');
const { randomUUID: uuidv4 } = require('node:crypto');
const { get, all, run, colEncrypt, colDecrypt, decrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope } = require('../helpers/shared');
const { resolveAccessToken } = require('../../worker/access-token');
const { harvestTrips, harvestOfferCatalog, groupAndMerge, searchDates, classifyOfferProbe, summarizeOfferProbe } = require('../../services/timetable-discovery');
const log = require('../../utils/logger').child({ module: 'timetable-discovery' });

// Cap each round-trip. Discovery loops several days, so a hung sandbox must
// not pin the request handler for minutes.
const TRIPS_FETCH_TIMEOUT_MS = 20000;

// Discovery harvests from POST /offers only (issue #167). The offer response
// carries BOTH the timetable (`trips[].legs[].timedLeg`, read by harvestTrips)
// AND the offered classes/ancillaries (`offers[]`, read by harvestOfferCatalog)
// — strictly more information than /trips-collection, and it's the path the
// Bruno run flow always uses, so it works on every sandbox (some, e.g. Chaps,
// don't implement the optional OJP /trips-collection search at all). The
// per-endpoint loop is kept generic in case a future vendor needs a fallback.
const DISCOVERY_ENDPOINTS = ['offers'];

// Normalize a station identifier to an OSDM URN. Accepts a full
// `urn:uic:stn:8400058` or a bare code `8400058` (convenience).
function _stnUrn(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  return /^urn:/i.test(v) ? v : `urn:uic:stn:${v}`;
}

// The shared trip-search block. The OSDM TripSearchCriteria rule is a
// LocalDateTime (no offset), EXCEPT Bileto, which requires an OffsetDateTime —
// its deserializer 400s ("Failed to read request") on a bare local time. This
// mirrors the Bileto exception in the Bruno run flow (scenarioParser.js).
function _tripSearch(date, origin, destination, apiBase) {
  const isBileto = /bileto/i.test(String(apiBase || ''));
  return {
    departureTime: isBileto ? `${date}T00:00:00+00:00` : `${date}T00:00:00`,
    origin: { objectType: 'StopPlaceRef', stopPlaceRef: origin },
    destination: { objectType: 'StopPlaceRef', stopPlaceRef: destination }
  };
}

// Build the request body for a given endpoint + day.
//   trips-collection → a bare TripSearchCriteria.
//   offers           → an OfferCollectionRequest (trip search + one anonymous
//                      passenger; offerSearchCriteria left empty so nothing is
//                      filtered out — we only want the trips, not the pricing).
function _discoveryBody(endpoint, date, origin, destination, apiBase) {
  const trip = _tripSearch(date, origin, destination, apiBase);
  if (endpoint === 'offers') {
    return {
      tripSearchCriteria: trip,
      anonymousPassengerSpecifications: [
        { externalRef: '1', type: 'PERSON', dateOfBirth: '1990-01-01', gender: 'X' }
      ],
      offerSearchCriteria: {}
    };
  }
  return trip;
}

// POST {api_base}/{path}. Returns { ok, status, json, text } and never throws
// on a non-2xx — the caller records per-day outcomes.
async function _postJson(apiBase, path, token, body, extraHeaders) {
  const url = `${String(apiBase).replace(/\/+$/, '')}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIPS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...extraHeaders
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let text = '';
    let json = null;
    try { text = await res.text(); json = text ? JSON.parse(text) : null; } catch (_) { /* keep raw text */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

const router = express.Router();
router.use(requireAuth, enforceTenant);

// ── Role guards (issue #60, v1.10.0) ──────────────────────────────────────────
// Test resources are test data — administrators no longer have read or write
// access. Certifiers never had a use case. Tightened from
// "test_manager OR isPlatformRole" to a strict role allow-list.
function denyAdminAndCertifier(req, res) {
  if (req.user.role === 'administrator' || req.user.role === 'certification_user') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Administrators and certifiers do not have access to test resources (issue #60).' });
    return true;
  }
  return false;
}
function requireTestManager(req, res) {
  if (req.user.role !== 'test_manager') {
    res.status(403).json({ status: 403, title: 'Forbidden',
      detail: 'Only Test Managers can modify test resources.' });
    return false;
  }
  return true;
}

// ── GET /v1/company/test-resources ────────────────────────────────────────────
router.get('/test-resources', (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const rows = all(
    'SELECT * FROM test_resources WHERE company_id = ? ORDER BY created_at ASC',
    [targetCompanyId]
  );
  // Phase 2 of issue #60 (v1.11.0): data column is encrypted at rest.
  // colDecrypt() handles legacy plaintext rows transparently.
  const resources = rows.map(r => {
    let data = {};
    try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
    return { id: r.id, resource_type: r.resource_type, label: r.label, data, created_at: r.created_at, updated_at: r.updated_at };
  });
  return res.json(resources);
});

// ── POST /v1/company/test-resources ───────────────────────────────────────────
router.post('/test-resources', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const { resource_type, label, data } = req.body || {};
  if (!resource_type || !['TRAIN', 'JOURNEY', 'MULTIMODAL'].includes(resource_type)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'resource_type must be TRAIN, JOURNEY or MULTIMODAL.' });
  }
  if (!label || !label.trim()) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'label is required.' });
  }

  const id = uuidv4();
  run(
    `INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)`,
    [id, targetCompanyId, resource_type, label.trim(), colEncrypt(JSON.stringify(data || {}))]
  );
  const saved = get('SELECT * FROM test_resources WHERE id = ?', [id]);
  let parsedData = {};
  try { parsedData = JSON.parse(colDecrypt(saved.data)); } catch (_) {}
  return res.status(201).json({
    id: saved.id, resource_type: saved.resource_type, label: saved.label,
    data: parsedData, created_at: saved.created_at, updated_at: saved.updated_at
  });
});

// ── PUT /v1/company/test-resources/:id ────────────────────────────────────────
router.put('/test-resources/:id', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const { label, data } = req.body || {};
  const row = get('SELECT id FROM test_resources WHERE id = ? AND company_id = ?',
                  [req.params.id, targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found' });

  run(
    `UPDATE test_resources SET label = ?, data = ?, updated_at = datetime('now') WHERE id = ?`,
    [label ? label.trim() : row.label, colEncrypt(JSON.stringify(data || {})), req.params.id]
  );
  const updated = get('SELECT * FROM test_resources WHERE id = ?', [req.params.id]);
  let parsedData = {};
  try { parsedData = JSON.parse(colDecrypt(updated.data)); } catch (_) {}
  return res.json({
    id: updated.id, resource_type: updated.resource_type, label: updated.label,
    data: parsedData, created_at: updated.created_at, updated_at: updated.updated_at
  });
});

// ── DELETE /v1/company/test-resources/:id ─────────────────────────────────────
router.delete('/test-resources/:id', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const row = get('SELECT id FROM test_resources WHERE id = ? AND company_id = ?',
                  [req.params.id, targetCompanyId]);
  if (!row) return res.status(404).json({ status: 404, title: 'Not Found' });

  run('DELETE FROM test_resources WHERE id = ?', [req.params.id]);
  return res.json({ deleted: true });
});

// ── POST /v1/company/test-resources/discover-timetable (issue #157,#159,#167) ─
// "Train Timetable Discovery" — reverse-engineer train-set test data from the
// offers a sandbox actually returns. For an O&D across the next N days (1..14,
// default 7) it calls POST {api_base}/offers, harvests every timed leg as a
// service AND the offered travel/service classes + ancillaries, groups services
// by route (origin + destination + product category), and merges the result
// into the company's existing TRAIN resources WITHOUT clobbering manual edits.
// Test-Manager only; tenant-scoped.
router.post('/test-resources/discover-timetable', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const origin = _stnUrn(req.body && req.body.originURN);
  const destination = _stnUrn(req.body && req.body.destinationURN);
  if (!origin || !destination) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'originURN and destinationURN are required.' });
  }
  let days = Number.parseInt(req.body && req.body.days, 10);
  if (!Number.isInteger(days) || days < 1) days = 7;
  if (days > 14) days = 14;

  // api_base lives on the company; OSDM credentials live on the tester.
  const company = get('SELECT id, slug, api_base FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company || !company.api_base) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No OSDM API base URL is configured for this company.' });
  }
  const userRow = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!userRow) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User credentials not found.' });
  }

  // Resolve a bearer token — reuses the runner's auth profiles + token cache.
  let token;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) });
  } catch (err) {
    return res.status(502).json({ status: 502, title: 'Auth Failed', detail: `Could not obtain an access token: ${err.message}` });
  }

  // Optional per-tester headers (mirror the Bruno run path).
  const extraHeaders = {};
  try { const r = userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null; if (r) extraHeaders.Requestor = r; } catch (_) {}
  try { const k = userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null; if (k) extraHeaders['Ocp-Apim-Subscription-Key'] = k; } catch (_) {}

  // Search day-by-day. For each day we try the endpoints in preference order
  // (trips-collection → offers); both responses carry `trips[]`. Once one
  // endpoint actually returns trips, we lock onto it for the remaining days so
  // we don't keep probing the unsupported one (issue #159).
  const dates = searchDates(days, new Date());
  const harvested = [];
  const dayResults = [];
  // Accumulate the offer "catalog" (travel/service classes + ancillaries the
  // sandbox actually offered) across days, to prefill Service Configuration.
  const cat = { travelClasses: new Set(), serviceClasses: new Set(), ancillaries: new Set() };
  // #365: offer-availability probe accumulator (offers-endpoint days only).
  const probe = { daysProbed: 0, daysWithOffers: 0, classes: new Set(), flex: new Set(), noOffer: [] };
  let preferred = null;   // endpoint that worked on a previous day

  for (const date of dates) {
    const order = preferred ? [preferred] : DISCOVERY_ENDPOINTS;
    let via = null;
    let lastStatus = 0;
    let lastError = '';
    let dayRecs = [];
    let dayTrips = 0;
    let dayJson = null;

    for (const endpoint of order) {
      let r;
      try {
        r = await _postJson(company.api_base, endpoint, token, _discoveryBody(endpoint, date, origin, destination, company.api_base), extraHeaders);
      } catch (err) {
        lastStatus = 0;
        lastError = err.name === 'AbortError' ? 'timeout' : err.message;
        continue;   // try the next endpoint
      }
      lastStatus = r.status;
      if (!r.ok) {
        lastError = `${endpoint}: ${(r.text || '').slice(0, 240)}`;
        continue;   // try the next endpoint
      }
      const recs = harvestTrips(r.json, { searchedOrigin: origin, searchedDestination: destination });
      const tripCount = (r.json && Array.isArray(r.json.trips)) ? r.json.trips.length : 0;
      // A 2xx with trips wins. A 2xx with NO trips only "wins" if it's the last
      // endpoint to try — otherwise fall through in case another endpoint has data.
      if (recs.length > 0 || endpoint === order[order.length - 1]) {
        via = endpoint;
        dayRecs = recs;
        dayTrips = tripCount;
        dayJson = r.json;
        if (recs.length > 0) preferred = endpoint;
        break;
      }
    }

    if (via) {
      harvested.push(...dayRecs);
      // Harvest the offered classes/ancillaries (no-op on a trips-collection
      // response, which has no offers[]).
      const oc = harvestOfferCatalog(dayJson);
      oc.travelClasses.forEach(x => cat.travelClasses.add(x));
      oc.serviceClasses.forEach(x => cat.serviceClasses.add(x));
      oc.ancillaries.forEach(x => cat.ancillaries.add(x));
      // #365: classify this day's offer availability (null on trips-collection).
      const pc = classifyOfferProbe(dayJson);
      if (pc) {
        probe.daysProbed++;
        if (pc.offers > 0) {
          probe.daysWithOffers++;
          pc.classes.forEach(c => probe.classes.add(c));
          pc.flexibilities.forEach(f => probe.flex.add(f));
        } else {
          probe.noOffer.push({ date, finding: pc.finding });
        }
      }
      dayResults.push({ date, status: lastStatus, via, trips: dayTrips, legs: dayRecs.length });
    } else {
      dayResults.push({ date, status: lastStatus, trips: 0, legs: 0, error: lastError });
    }
  }

  const anyOk = dayResults.some(d => d.status >= 200 && d.status < 300);
  if (!anyOk) {
    return res.status(502).json({
      status: 502, title: 'Discovery Failed',
      detail: 'No usable offer response across the searched days (POST /offers).',
      dayResults
    });
  }

  // Load existing TRAIN resources (decrypted) so the merge can preserve edits.
  const rows = all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [targetCompanyId, 'TRAIN']);
  const existing = rows.map(r => {
    let data = {};
    try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
    return { id: r.id, resource_type: r.resource_type, label: r.label, data };
  });

  const catalog = {
    travelClasses:  [...cat.travelClasses],
    serviceClasses: [...cat.serviceClasses],
    ancillaries:    [...cat.ancillaries]
  };
  const { toCreate, toUpdate, summary } = groupAndMerge(harvested, existing, catalog);

  // #365/#369: route-level offer-availability findings (shared builder).
  const offerProbe = summarizeOfferProbe(probe);
  if (offerProbe) {
    toCreate.forEach(c => { c.data.offerProbe = offerProbe; });
    toUpdate.forEach(u => { u.data.offerProbe = offerProbe; });
  }

  const created = [];
  for (const c of toCreate) {
    const id = uuidv4();
    run(
      `INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', ?, ?)`,
      [id, targetCompanyId, c.label, colEncrypt(JSON.stringify(c.data))]
    );
    created.push({ id, label: c.label });
  }
  const updated = [];
  for (const u of toUpdate) {
    run(
      `UPDATE test_resources SET data = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
      [colEncrypt(JSON.stringify(u.data)), u.id, targetCompanyId]
    );
    updated.push({ id: u.id, label: u.label });
  }

  log.info({ companyId: targetCompanyId, origin, destination, days, ...summary }, 'Timetable discovery completed');
  return res.json({ summary, created, updated, dayResults, offerProbe });
});

// ── POST /v1/company/test-resources/reprobe-offers (#369) ────────────────────
// Manual refresh of the offer-availability findings: for every DISTINCT O&D
// across the existing TRAIN resources, re-run the anonymous-adult offer probe
// (3 dates) and update data.offerProbe on the affected sets. No timetable
// harvest, no train create/update besides the probe member.
router.post('/test-resources/reprobe-offers', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const company = get('SELECT id, slug, api_base FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company || !company.api_base) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No OSDM API base URL is configured for this company.' });
  }
  const userRow = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!userRow) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User credentials not found.' });
  let token;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) });
  } catch (err) {
    return res.status(502).json({ status: 502, title: 'Auth Failed', detail: `Could not obtain an access token: ${err.message}` });
  }
  const extraHeaders = {};
  try { const r = userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null; if (r) extraHeaders.Requestor = r; } catch (_) {}
  try { const k = userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null; if (k) extraHeaders['Ocp-Apim-Subscription-Key'] = k; } catch (_) {}

  const rows = all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [targetCompanyId, 'TRAIN']);
  const trains = rows.map(r => {
    let data = {};
    try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
    return { id: r.id, label: r.label, data };
  }).filter(t => t.data && t.data.originURN && t.data.destinationURN);
  if (!trains.length) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No TRAIN resources with an origin/destination to probe.' });
  }

  const byOd = new Map();
  for (const t of trains) {
    const key = t.data.originURN + '>' + t.data.destinationURN;
    if (!byOd.has(key)) byOd.set(key, { origin: t.data.originURN, destination: t.data.destinationURN, trains: [] });
    byOd.get(key).trains.push(t);
  }

  const routes = [];
  let updatedCount = 0;
  for (const od of byOd.values()) {
    const probe = { daysProbed: 0, daysWithOffers: 0, classes: new Set(), flex: new Set(), noOffer: [] };
    for (const date of searchDates(3, new Date())) {
      let r2;
      try {
        r2 = await _postJson(company.api_base, 'offers', token, _discoveryBody('offers', date, od.origin, od.destination, company.api_base), extraHeaders);
      } catch (_err) { continue; }
      if (!r2.ok) continue;
      const pc = classifyOfferProbe(r2.json);
      if (!pc) continue;
      probe.daysProbed++;
      if (pc.offers > 0) {
        probe.daysWithOffers++;
        pc.classes.forEach(c => probe.classes.add(c));
        pc.flexibilities.forEach(f => probe.flex.add(f));
      } else {
        probe.noOffer.push({ date, finding: pc.finding });
      }
    }
    const offerProbe = summarizeOfferProbe(probe);
    if (offerProbe) {
      for (const t of od.trains) {
        t.data.offerProbe = offerProbe;
        run(`UPDATE test_resources SET data = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
          [colEncrypt(JSON.stringify(t.data)), t.id, targetCompanyId]);
        updatedCount++;
      }
    }
    routes.push({
      origin: od.origin, destination: od.destination, trains: od.trains.length,
      probed: !!offerProbe, findings: offerProbe ? offerProbe.findings : ['probe got no usable offers response']
    });
  }

  log.info({ companyId: targetCompanyId, routes: routes.length, updatedCount }, 'Offer re-probe completed');
  return res.json({ routes, updated: updatedCount });
});

module.exports = router;
