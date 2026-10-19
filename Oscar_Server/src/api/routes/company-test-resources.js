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
const { get, all, run, transaction, colEncrypt, colDecrypt, decrypt } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, denyAdminAndCertifier, requireTestManager } = require('../helpers/shared');
const { resolveAccessToken } = require('../../worker/access-token');
const { credentialsFor } = require('../../utils/testerCredentials');
const { mergeDedicatedHeaders, stripTrailingSlashes } = require('../../utils/osdm-client');
const { harvestTrips, harvestConnections, journeysFromConnections, calendarFromHarvest, harvestOfferCatalog, groupAndMerge, fitsOneTripDate, searchDates, classifyOfferProbe, summarizeOfferProbe, serviceFindings, servicesUnseen, dayOfWeekCode } = require('../../services/timetable-discovery');
const { journeyPlan, probeDates, compareAnswer, probeSummary, collectOfferedTrips, tripToKeep } = require('../../services/journeyProbe');
const log = require('../../utils/logger').child({ module: 'timetable-discovery' });

// Cap each round-trip. Discovery loops several days, so a hung sandbox must
// not pin the request handler for minutes.
const TRIPS_FETCH_TIMEOUT_MS = 20000;

// Discovery harvests from POST /offers by default (issue #167). The offer
// response carries BOTH the timetable (`trips[].legs[].timedLeg`, read by
// harvestTrips) AND the offered classes/ancillaries (`offers[]`, read by
// harvestOfferCatalog), and it's the path the Bruno run flow always uses, so
// it works on every sandbox. #715: the Test Manager may ask for the trip
// search instead (`searchWith: 'trips-collection'`): timetables only, with
// /offers as the fallback on a day it fails or gives no trip.
const DISCOVERY_ENDPOINTS = ['offers'];
const TRIP_SEARCH_ENDPOINTS = ['trips-collection', 'offers'];

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
function _tripSearch(date, origin, destination, apiBase, atTime) {
  const isBileto = /bileto/i.test(String(apiBase || ''));
  const isPaxone = /paxone/i.test(String(apiBase || ''));
  // Most sandboxes return the whole day's offers for a midnight departureTime,
  // but PAXONE returns offers only AROUND the requested time — a T00:00:00 query
  // finds nothing (its sandbox trains run during the day), so discovery reported
  // "0 trips" even on routes that clearly run (the SALE scenario gets offers at
  // T06:00). Query PAXONE at a daytime hour so the running service is in range;
  // every other sandbox keeps midnight (whole-day), unchanged.
  // #787: the re-probe also asks for a service at its own time.
  const time = atTime || (isPaxone ? '08:00:00' : '00:00:00');
  return {
    departureTime: isBileto ? `${date}T${time}+00:00` : `${date}T${time}`,
    origin: { objectType: 'StopPlaceRef', stopPlaceRef: origin },
    destination: { objectType: 'StopPlaceRef', stopPlaceRef: destination }
  };
}

// Build the request body for a given endpoint + day.
//   trips-collection → a bare TripSearchCriteria.
//   offers           → an OfferCollectionRequest (trip search + one anonymous
//                      passenger; offerSearchCriteria left empty so nothing is
//                      filtered out — we only want the trips, not the pricing).
//
// offerSearchCriteria.currency + .offerMode are OPTIONAL in OSDM, but PAXONE
// rejects an offers request that omits them with a 422 VALIDATION_ERROR
// ("Field body.offerSearchCriteria.offerMode/currency is missing"), which makes
// timetable discovery fail on every searched day. For PAXONE we send the minimal
// required pair (EUR / INDIVIDUAL — neither filters the timetable we harvest);
// every other sandbox keeps the empty criteria, unchanged.
function _discoveryBody(endpoint, date, origin, destination, apiBase, atTime) {
  const trip = _tripSearch(date, origin, destination, apiBase, atTime);
  if (endpoint === 'offers') {
    const isPaxone = /paxone/i.test(String(apiBase || ''));
    return {
      tripSearchCriteria: trip,
      anonymousPassengerSpecifications: [
        { externalRef: '1', type: 'PERSON', dateOfBirth: '1990-01-01', gender: 'X' }
      ],
      offerSearchCriteria: isPaxone ? { currency: 'EUR', offerMode: 'INDIVIDUAL' } : {}
    };
  }
  return trip;
}

// POST {api_base}/{path}. Returns { ok, status, json, text } and never throws
// on a non-2xx — the caller records per-day outcomes.
async function _postJson(apiBase, path, token, body, extraHeaders) {
  const url = `${stripTrailingSlashes(String(apiBase))}/${path}`;
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

// Role guards (issue #60): test resources are test data — administrators and
// certifiers have no access, only Test Managers may write. Shared helpers now
// live in helpers/shared.js (denyAdminAndCertifier / requireTestManager).

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
  if (!label?.trim()) {
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

// #715: store the provider's connections as JOURNEY resources, once their legs
// are stored as train services. { created: [{id, label}], skipped }.
function createConnectionJourneys(companyId, connections) {
  if (connections.length === 0) return { created: [], skipped: 0 };
  const decoded = (type) => all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [companyId, type])
    .map(r => {
      let data = {};
      try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
      return { id: r.id, label: r.label, data };
    });
  const { toCreate, skipped } = journeysFromConnections(connections, decoded('TRAIN'), decoded('JOURNEY'));
  const created = toCreate.map(j => {
    const id = uuidv4();
    run(
      `INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'JOURNEY', ?, ?)`,
      [id, companyId, j.label, colEncrypt(JSON.stringify(j.data))]
    );
    return { id, label: j.label };
  });
  return { created, skipped };
}

// What a call to the provider needs: the company's endpoint, the person's
// token and their headers (requestor, subscription key, and the company's
// Dedicated Headers, #477). Answers the request and returns null when one is
// missing.
async function _vendorSession(req, res, targetCompanyId) {
  // api_base lives on the company; OSDM credentials live on the tester.
  const company = get('SELECT id, slug, api_base, extra_headers FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company?.api_base) {
    res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No OSDM API base URL is configured for this company.' });
    return null;
  }
  const userRow = credentialsFor(req.user.id, targetCompanyId);
  if (!userRow) {
    res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User credentials not found.' });
    return null;
  }
  // Resolve a bearer token — reuses the runner's auth profiles + token cache.
  let token;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) });
  } catch (err) {
    res.status(502).json({ status: 502, title: 'Auth Failed', detail: `Could not obtain an access token: ${err.message}` });
    return null;
  }
  // Optional per-tester headers (mirror the Bruno run path).
  const extraHeaders = {};
  try { const r = userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null; if (r) extraHeaders.Requestor = r; } catch { /* optional header: a value that will not decrypt is left out */ }
  try { const k = userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null; if (k) extraHeaders['Ocp-Apim-Subscription-Key'] = k; } catch { /* optional header: a value that will not decrypt is left out */ }
  // #477: company-wide Dedicated Headers (API Config) — previously only the
  // Bruno run path applied these; Discovery silently ignored them.
  mergeDedicatedHeaders(extraHeaders, company, token);
  return { company, token, extraHeaders };
}

// #717: `days` days of POST /offers for a route, one after the other.
// { harvested: records (harvestTrips), daysAnswered }.
async function _searchRouteDays({ company, token, extraHeaders }, origin, destination, days) {
  const harvested = [];
  let daysAnswered = 0;
  await searchDates(days, new Date()).reduce((previous, date) => previous.then(async () => {
    let r;
    try {
      r = await _postJson(company.api_base, 'offers', token, _discoveryBody('offers', date, origin, destination, company.api_base), extraHeaders);
    } catch { return; }   // a day that fails is a day not answered
    if (!r.ok) return;
    daysAnswered++;
    harvested.push(...harvestTrips(r.json, { searchedOrigin: origin, searchedDestination: destination }));
  }), Promise.resolve());
  return { harvested, daysAnswered };
}

// #717: give train set `t` its days from the harvest, or say why not.
function _fillCalendar(t, daysAnswered, harvested, companyId, out) {
  const found = daysAnswered === 0 ? { reason: 'the provider answered no search of its route' } : calendarFromHarvest(t.data, harvested);
  if (!found.daysOfWeek) {
    out.unresolved.push({ id: t.id, label: t.label, reason: found.reason });
    return;
  }
  run(`UPDATE test_resources SET data = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
    [colEncrypt(JSON.stringify({ ...t.data, daysOfWeek: found.daysOfWeek })), t.id, companyId]);
  out.updated.push({ id: t.id, label: t.label, daysOfWeek: found.daysOfWeek });
}

// ── POST /v1/company/test-resources/fill-calendars (#717) ─────────────────────
// Train sets without operating days learn them from the provider: their route
// is searched over the next 7 days (POST /offers, as Discovery does), and a
// set gets the days on which every one of its services was seen. A set that
// cannot be decided is reported with the reason, never guessed.
router.post('/test-resources/fill-calendars', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const targets = all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [targetCompanyId, 'TRAIN'])
    .map(r => {
      let data = {};
      try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
      return { id: r.id, label: r.label, data };
    })
    .filter(t => !(Array.isArray(t.data.daysOfWeek) && t.data.daysOfWeek.length) && t.data.originURN && t.data.destinationURN);
  if (targets.length === 0) return res.json({ updated: [], unresolved: [], routes: [] });

  const session = await _vendorSession(req, res, targetCompanyId);
  if (!session) return;

  const byRoute = new Map();
  for (const t of targets) {
    const key = `${t.data.originURN}>${t.data.destinationURN}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(t);
  }
  const out = { updated: [], unresolved: [], routes: [] };
  // One route after the other, one day after the other: a provider's gateway
  // may block a burst of searches (#646).
  await [...byRoute.values()].reduce((previous, sets) => previous.then(async () => {
    const { originURN: origin, destinationURN: destination } = sets[0].data;
    const { harvested, daysAnswered } = await _searchRouteDays(session, origin, destination, 7);
    out.routes.push({ origin, destination, daysAnswered });
    for (const t of sets) _fillCalendar(t, daysAnswered, harvested, targetCompanyId, out);
  }), Promise.resolve());
  const { updated, unresolved, routes } = out;
  log.info({ companyId: targetCompanyId, updated: updated.length, unresolved: unresolved.length }, 'Missing train calendars filled');
  return res.json({ updated, unresolved, routes });
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

  const origin = _stnUrn(req.body?.originURN);
  const destination = _stnUrn(req.body?.destinationURN);
  if (!origin || !destination) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'originURN and destinationURN are required.' });
  }
  let days = Number.parseInt(req.body?.days, 10);
  if (!Number.isInteger(days) || days < 1) days = 7;
  if (days > 14) days = 14;
  const endpoints = req.body?.searchWith === 'trips-collection' ? TRIP_SEARCH_ENDPOINTS : DISCOVERY_ENDPOINTS;

  const session = await _vendorSession(req, res, targetCompanyId);
  if (!session) return;
  const { company, token, extraHeaders } = session;

  // Search day-by-day. For each day we try the endpoints in preference order
  // (trips-collection → offers); both responses carry `trips[]`. Once one
  // endpoint actually returns trips, we lock onto it for the remaining days so
  // we don't keep probing the unsupported one (issue #159).
  const dates = searchDates(days, new Date());
  const harvested = [];
  const connections = [];   // #715: trips of 2 or 3 legs, made journeys below
  const dayResults = [];
  // Accumulate the offer "catalog" (travel/service classes + ancillaries the
  // sandbox actually offered) across days, to prefill Service Configuration.
  const cat = { travelClasses: new Set(), serviceClasses: new Set(), ancillaries: new Set() };
  // #365: offer-availability probe accumulator (offers-endpoint days only).
  const probe = { daysProbed: 0, daysWithOffers: 0, classes: new Set(), flex: new Set(), noOffer: [] };
  let preferred = null;   // endpoint that worked on a previous day

  for (const date of dates) {
    const order = preferred ? [preferred] : endpoints;
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
      connections.push(...harvestConnections(dayJson, { searchedOrigin: origin, searchedDestination: destination }));
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
      // Surface the offer count alongside the trip count: a 2xx day with
      // offers>0 but trips==0 means the provider returned offers we couldn't
      // harvest as a timetable (parse/shape issue), vs offers==0 meaning no
      // service for that day/time — so a future "0 trips" is self-diagnosing.
      const jsonOffers = Array.isArray(dayJson?.offers) ? dayJson.offers.length : 0;
      const dayOffers = pc ? pc.offers : jsonOffers;
      dayResults.push({ date, status: lastStatus, via, trips: dayTrips, legs: dayRecs.length, offers: dayOffers });
    } else {
      dayResults.push({ date, status: lastStatus, trips: 0, legs: 0, offers: 0, error: lastError });
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

  // #715: the provider's connections, as journeys over the services just stored.
  const journeys = createConnectionJourneys(targetCompanyId, connections);

  log.info({ companyId: targetCompanyId, origin, destination, days, ...summary, journeysCreated: journeys.created.length }, 'Timetable discovery completed');
  return res.json({ summary, created, updated, dayResults, offerProbe, journeys });
});

// #787: a search at midnight may not list every train of the day: a service
// no answer showed is asked for once more at its own time, on the first day
// answered (at most MAX_SERVICE_SEARCHES per route, each time once).
const MAX_SERVICE_SEARCHES = 6;

// One provider call after the other, never several at once.
function inSequence(items, fn) {
  return items.reduce((done, item) => done.then(() => fn(item)), Promise.resolve());
}

async function askUnseenServices(od, harvest, ask, keep) {
  const date = harvest.days[0]?.date;
  if (!date) return;
  const times = [...new Set(od.trains.flatMap((t) => servicesUnseen(t.data, harvest.records))
    .map((svc) => /(\d{2}:\d{2})/.exec(String(svc.departureTime))?.[1]).filter(Boolean))].slice(0, MAX_SERVICE_SEARCHES);
  await inSequence(times, async (time) => {
    const r = await ask(date, od, `${time}:00`);
    if (r?.ok && classifyOfferProbe(r.json)) keep(r.json, date);
  });
}

// ── POST /v1/company/test-resources/reprobe-offers (#369) ────────────────────
// Manual refresh of the offer-availability findings: for every DISTINCT O&D
// across the existing TRAIN resources, re-run the anonymous-adult offer probe
// (3 dates) and update data.offerProbe on the affected sets. No timetable
// harvest, no train create/update besides the probe member.
router.post('/test-resources/reprobe-offers', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;

  const company = get('SELECT id, slug, api_base, extra_headers FROM companies WHERE id = ?', [targetCompanyId]);
  if (!company?.api_base) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No OSDM API base URL is configured for this company.' });
  }
  const userRow = credentialsFor(req.user.id, targetCompanyId);
  if (!userRow) return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User credentials not found.' });
  let token;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) });
  } catch (err) {
    return res.status(502).json({ status: 502, title: 'Auth Failed', detail: `Could not obtain an access token: ${err.message}` });
  }
  const extraHeaders = {};
  try { const r = userRow.requestor_enc ? decrypt(userRow.requestor_enc) : null; if (r) extraHeaders.Requestor = r; } catch { /* optional header: a value that will not decrypt is left out */ }
  try { const k = userRow.subscription_key_enc ? decrypt(userRow.subscription_key_enc) : null; if (k) extraHeaders['Ocp-Apim-Subscription-Key'] = k; } catch { /* optional header: a value that will not decrypt is left out */ }
  // #477: company-wide Dedicated Headers (API Config) — previously only the
  // Bruno run path applied these; Re-probe silently ignored them.
  mergeDedicatedHeaders(extraHeaders, company, token);

  const rows = all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [targetCompanyId, 'TRAIN']);
  const trains = rows.map(r => {
    let data = {};
    try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
    return { id: r.id, label: r.label, data };
  }).filter(t => t.data?.originURN && t.data.destinationURN);
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
  const ask = async (date, od, atTime) => {
    try {
      return await _postJson(company.api_base, 'offers', token, _discoveryBody('offers', date, od.origin, od.destination, company.api_base, atTime), extraHeaders);
    } catch (_err) { return null; }
  };
  await inSequence([...byOd.values()], async (od) => {
    const probe = { daysProbed: 0, daysWithOffers: 0, classes: new Set(), flex: new Set(), noOffer: [] };
    // #787: the direct trains each answer shows, and the days answered.
    const harvest = { records: [], days: [] };
    const keep = (json, date) => harvest.records.push(...harvestTrips(json, { searchedOrigin: od.origin, searchedDestination: od.destination })
      .map((r) => ({ ...r, dayOfWeek: r.dayOfWeek || dayOfWeekCode(`${date}T12:00:00`) })));
    await inSequence(searchDates(3, new Date()), async (date) => {
      const r2 = await ask(date, od);
      if (!r2?.ok) return;
      const pc = classifyOfferProbe(r2.json);
      if (!pc) return;
      keep(r2.json, date);
      harvest.days.push({ date, dayOfWeek: dayOfWeekCode(`${date}T12:00:00`) });
      probe.daysProbed++;
      if (pc.offers > 0) {
        probe.daysWithOffers++;
        pc.classes.forEach(c => probe.classes.add(c));
        pc.flexibilities.forEach(f => probe.flex.add(f));
      } else {
        probe.noOffer.push({ date, finding: pc.finding });
      }
    });
    const offerProbe = summarizeOfferProbe(probe);
    if (offerProbe) {
      await askUnseenServices(od, harvest, ask, keep);
      for (const t of od.trains) {
        const own = serviceFindings(t.data, harvest.records, harvest.days);
        t.data.offerProbe = { ...offerProbe, findings: [...offerProbe.findings, ...own] };
        run(`UPDATE test_resources SET data = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
          [colEncrypt(JSON.stringify(t.data)), t.id, targetCompanyId]);
        updatedCount++;
      }
    }
    routes.push({
      origin: od.origin, destination: od.destination, trains: od.trains.length,
      probed: !!offerProbe, findings: offerProbe ? offerProbe.findings : ['probe got no usable offers response']
    });
  });

  log.info({ companyId: targetCompanyId, routes: routes.length, updatedCount }, 'Offer re-probe completed');
  return res.json({ routes, updated: updatedCount });
});

// #813: one day of a journey probe. The trip search first, /offers when it
// fails or is not there; `state.endpoint` keeps the one that answered.
async function _probeJourneyDay({ company, token, extraHeaders }, plan, date, state) {
  const origin = plan.legs[0].origin;
  const destination = plan.legs.at(-1).destination;
  const atTime = plan.legs[0].departure ? `${plan.legs[0].departure}:00` : undefined;
  const endpoints = state.endpoint ? [state.endpoint] : TRIP_SEARCH_ENDPOINTS;
  let last = { date, status: null, via: null, error: 'not searched' };
  for (const endpoint of endpoints) {
    let r;
    try {
      r = await _postJson(company.api_base, endpoint, token, _discoveryBody(endpoint, date, origin, destination, company.api_base, atTime), extraHeaders);
    } catch (err) {
      last = { date, status: null, via: endpoint, error: err.name === 'AbortError' ? 'no answer within 20 s' : 'the call failed' };
      continue;
    }
    if (!r.ok) {
      last = { date, status: r.status, via: endpoint, error: `HTTP ${r.status}` };
      continue;
    }
    state.endpoint = endpoint;
    return { date, status: r.status, via: endpoint, ...compareAnswer(plan.legs, r.json) };
  }
  return last;
}

// Test Data entries of a company, decrypted: [{ id, resource_type, label, data }].
function _resourcesOf(companyId, type) {
  return all('SELECT * FROM test_resources WHERE company_id = ? AND resource_type = ?', [companyId, type]).map((r) => {
    let data = {};
    try { data = JSON.parse(colDecrypt(r.data)); } catch (_) {}
    return { id: r.id, resource_type: r.resource_type, label: r.label, data };
  });
}

// #813: probe `journey` (its legs name `trains`) and answer the request.
async function _probeJourney(req, res, companyId, journey, trains) {
  const plan = journeyPlan(journey, trains);
  const refuse = (detail) => res.status(400).json({ status: 400, title: 'Bad Request', detail });
  if (plan.legs.length === 0) return refuse('This journey has no leg whose train set is in Test Data.');
  if (plan.missingLegs > 0) return refuse(`${plan.missingLegs} leg(s) of this journey name a train set that is no longer in Test Data.`);
  if (!plan.legs[0].origin || !plan.legs.at(-1).destination) return refuse('The journey has no first stop place or no last stop place.');
  const dates = probeDates(plan.days, new Date());
  if (dates.length === 0) return refuse('The trains of this journey have no operating day in common.');

  const session = await _vendorSession(req, res, companyId);
  if (!session) return;

  // One day after the other: a provider's gateway may block a burst (#646).
  const state = { endpoint: null };
  const days = [];
  await inSequence(dates, async (date) => { days.push(await _probeJourneyDay(session, plan, date, state)); });
  const offeredTrips = collectOfferedTrips(days);
  log.info({ companyId, journey: journey.id || null, days: days.map(d => d.outcome || d.error) }, 'Journey probed');
  return res.json({ journey: { id: journey.id || null, label: journey.label || '' }, legs: plan.legs, days, offeredTrips, summary: probeSummary(days) });
}

// ── POST /v1/company/test-resources/:id/probe-journey (#813) ──────────────────
// Does the provider offer this Test Data journey? Its trips are searched from
// the first stop place to the last, at the first departure, on the next days
// all its trains run, and each answer is compared with the journey's legs.
// Nothing is written.
router.post('/test-resources/:id/probe-journey', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;
  const journey = _resourcesOf(targetCompanyId, 'JOURNEY').find((j) => j.id === req.params.id);
  if (!journey) return res.status(404).json({ status: 404, title: 'Not Found' });
  return _probeJourney(req, res, targetCompanyId, journey, _resourcesOf(targetCompanyId, 'TRAIN'));
});

// ── POST /v1/company/test-resources/probe-journey (#815) ──────────────────────
// The same, for a journey not saved yet: a result of Find journeys, whose
// legs ({ trainResourceId, serviceIndex }) name saved train sets.
router.post('/test-resources/probe-journey', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;
  const raw = req.body?.legs;
  const legOk = (l) => l && typeof l.trainResourceId === 'string' && Number.isInteger(l.serviceIndex) && l.serviceIndex >= 0;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5 || !raw.every(legOk)) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'legs must hold 1 to 5 { trainResourceId, serviceIndex }.' });
  }
  const journey = { id: null, label: '', data: { legs: raw.map((l) => ({ trainResourceId: l.trainResourceId, serviceIndex: l.serviceIndex })) } };
  return _probeJourney(req, res, targetCompanyId, journey, _resourcesOf(targetCompanyId, 'TRAIN'));
});

// #815: store a trip a probe listed (`trip` from tripToKeep): its legs as
// train services the way Discover timetable stores them (manual edits kept),
// on the weekdays the probe saw it, then a journey made of them. A journey
// with the same legs is named, not made twice. { journey, created,
// trainsCreated, trainsUpdated } or { error } when no journey can be made.
function keepTrip(companyId, trip) {
  const { toCreate, toUpdate } = groupAndMerge(trip.records, _resourcesOf(companyId, 'TRAIN'), {});
  const trainsCreated = toCreate.map((c) => {
    const id = uuidv4();
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', ?, ?)`,
      [id, companyId, c.label, colEncrypt(JSON.stringify(c.data))]);
    return { id, label: c.label };
  });
  const trainsUpdated = toUpdate.map((u) => {
    run(`UPDATE test_resources SET data = ?, updated_at = datetime('now') WHERE id = ? AND company_id = ?`,
      [colEncrypt(JSON.stringify(u.data)), u.id, companyId]);
    return { id: u.id, label: u.label };
  });

  // The journey, from the records of the first weekday seen.
  const firstDay = trip.records.filter((r) => r.dayOfWeek === trip.days[0]);
  const { toCreate: made } = journeysFromConnections([firstDay], _resourcesOf(companyId, 'TRAIN'), []);
  if (made.length === 0) {
    // Not expected: the trains were just stored with these services.
    return { error: 'The journey could not be made from the train services stored.', trainsCreated, trainsUpdated };
  }
  const legsKey = (legs) => legs.map((l) => `${l.trainResourceId}#${l.serviceIndex}`).join('>');
  const same = _resourcesOf(companyId, 'JOURNEY').find((j) => Array.isArray(j.data.legs) && legsKey(j.data.legs) === legsKey(made[0].data.legs));
  if (same) return { journey: { id: same.id, label: same.label }, created: false, trainsCreated, trainsUpdated };
  const id = uuidv4();
  run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'JOURNEY', ?, ?)`,
    [id, companyId, made[0].label, colEncrypt(JSON.stringify(made[0].data))]);
  return { journey: { id, label: made[0].label }, created: true, trainsCreated, trainsUpdated };
}

// A trip of a request body, checked before anything is written: { trip } or { error }.
function checkedTrip(body) {
  const trip = tripToKeep(body);
  if (trip.error) return { error: trip.error };
  if (!fitsOneTripDate(trip.legs)) return { error: 'These legs do not make one journey on one trip date: a leg leaves before the previous one arrives.' };
  return { trip };
}

// ── POST /v1/company/test-resources/journey-from-trip (#815) ──────────────────
// Keep one trip a probe listed, as a journey.
router.post('/test-resources/journey-from-trip', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;
  const checked = checkedTrip(req.body);
  if (checked.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: checked.error });
  const kept = keepTrip(targetCompanyId, checked.trip);
  if (kept.error) return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: kept.error, trainsCreated: kept.trainsCreated, trainsUpdated: kept.trainsUpdated });
  if (kept.created) log.info({ companyId: targetCompanyId, journey: kept.journey.id, trainsCreated: kept.trainsCreated.length, trainsUpdated: kept.trainsUpdated.length }, 'Journey kept from a probe');
  return res.status(kept.created ? 201 : 200).json(kept);
});

// ── POST /v1/company/test-resources/:id/replace-journey (#865) ────────────────
// A journey the provider does not offer as defined is replaced by every trip
// its probe offered: { trips: [{ legs, days }, …] }, 1 to MAX_REPLACING. All
// trips are checked before anything is written; then, in one transaction,
// each is kept as a journey (as journey-from-trip does) and the journey
// probed is removed, unless one of the trips is that very journey. Train sets
// stay: other journeys or a direct run may use them.
const MAX_REPLACING = 10;
router.post('/test-resources/:id/replace-journey', (req, res) => {
  if (!requireTestManager(req, res)) return;
  const targetCompanyId = resolveCompanyScope(req, res);
  if (targetCompanyId === null) return;
  const old = get(`SELECT id, label FROM test_resources WHERE id = ? AND company_id = ? AND resource_type = 'JOURNEY'`, [req.params.id, targetCompanyId]);
  if (!old) return res.status(404).json({ status: 404, title: 'Not Found' });
  const raw = req.body?.trips;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REPLACING) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: `trips must hold 1 to ${MAX_REPLACING} trips offered by the probe.` });
  }
  const trips = [];
  for (let i = 0; i < raw.length; i++) {
    const checked = checkedTrip(raw[i]);
    if (checked.error) return res.status(400).json({ status: 400, title: 'Bad Request', detail: `Trip ${i + 1}: ${checked.error} Nothing was changed.` });
    trips.push(checked.trip);
  }
  let result;
  try {
    transaction(() => {
      const kept = trips.map((t) => keepTrip(targetCompanyId, t));
      const failed = kept.find((k) => k.error);
      if (failed) throw new Error(failed.error);
      const stays = kept.some((k) => k.journey.id === old.id);
      if (!stays) run('DELETE FROM test_resources WHERE id = ? AND company_id = ?', [old.id, targetCompanyId]);
      result = {
        replaced: { id: old.id, label: old.label, removed: !stays },
        journeys: kept.map((k) => ({ ...k.journey, created: k.created })),
        trainsCreated: kept.flatMap((k) => k.trainsCreated),
        trainsUpdated: kept.flatMap((k) => k.trainsUpdated),
      };
    });
  } catch (err) {
    log.error({ err, companyId: targetCompanyId, journey: old.id }, 'Journey replacement failed');
    return res.status(500).json({ status: 500, title: 'Internal Server Error', detail: 'The journey could not be replaced. Nothing was changed.' });
  }
  log.info({ companyId: targetCompanyId, journey: old.id, journeys: result.journeys.length }, 'Journey replaced by the trips offered');
  return res.json(result);
});

module.exports = router;
