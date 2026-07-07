// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-places.js — OSDM stop-place cache + lookup (issue #450)
 *
 * POST /v1/company/places/refresh — bulk-download the vendor's GET /places list
 *                                   and cache it (test_manager only).
 * GET  /v1/company/places          — cache metadata, or ?q= full-text lookup
 *                                    (tester + test_manager; admin/certifier
 *                                    denied, mirroring test resources #60).
 *
 * The cache backs a stop-place typeahead in Test Config (Timetable Discovery +
 * Train Resource editor) so testers pick real place URNs instead of typing
 * `urn:uic:stn:8500010` by hand — while manual entry still works.
 */

const express = require('express');
const { get, run } = require('../../db/db');
const { requireAuth } = require('../middleware/auth');
const { enforceTenant } = require('../middleware/tenant');
const { resolveCompanyScope, denyAdminAndCertifier, requireTestManager } = require('../helpers/shared');
const { resolveAccessToken } = require('../../worker/access-token');
const { osdmGet, buildTesterHeaders, mergeDedicatedHeaders } = require('../../utils/osdm-client');
const log = require('../../utils/logger').child({ module: 'places' });

const router = express.Router();
router.use(requireAuth, enforceTenant);

// Bulk download safety rails. A place list is reference data (usually a few
// hundred to a few thousand rows) — these caps stop a misbehaving or hostile
// vendor from pinning the handler or exhausting memory. If a cap is hit we log
// it loudly so truncation is never silent.
const MAX_PAGES = 100;
const MAX_PLACES = 100000;

/**
 * Normalize an OSDM Place/StopPlace to the compact shape we cache and search.
 * OSDM: Place = { objectType, id (URN), ... }; StopPlace adds required name.
 * Falls back to id when a place carries no name (non-StopPlace subtypes).
 */
function normalizePlace(p) {
  if (!p || typeof p !== 'object' || !p.id) return null;
  return {
    id: String(p.id),
    name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : String(p.id),
    objectType: p.objectType ? String(p.objectType) : ''
  };
}

function readCache(companyId) {
  const row = get('SELECT places_json, place_count, cached_at FROM places_cache WHERE company_id = ?', [companyId]);
  if (!row) return { places: [], place_count: 0, cached_at: null };
  let places = [];
  try { places = JSON.parse(row.places_json) || []; } catch (_) { places = []; }
  return { places, place_count: row.place_count, cached_at: row.cached_at };
}

// ── POST /v1/company/places/refresh ───────────────────────────────────────────
router.post('/places/refresh', async (req, res) => {
  if (!requireTestManager(req, res)) return;
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return;

  const company = get('SELECT id, slug, api_base, extra_headers FROM companies WHERE id = ?', [companyId]);
  if (!company || !company.api_base) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'No OSDM API base URL is configured for this company.' });
  }
  const userRow = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!userRow) {
    return res.status(400).json({ status: 400, title: 'Bad Request', detail: 'User credentials not found.' });
  }

  let token;
  try {
    token = await resolveAccessToken(userRow, { info: (m) => log.debug(m), error: (m) => log.warn(m) });
  } catch (err) {
    return res.status(502).json({ status: 502, title: 'Auth Failed', detail: `Could not obtain an access token: ${err.message}` });
  }
  const extraHeaders = buildTesterHeaders(userRow);
  // #477: company-wide Dedicated Headers (API Config) were never applied on
  // this server-side direct-call path — only the Bruno run path read them.
  mergeDedicatedHeaders(extraHeaders, company, token);

  // Page through /places, deduping by id. OSDM's `page` query param is an
  // opaque, vendor-defined cursor; we page 1..N and stop as soon as a page adds
  // no new ids (covers both true pagination and a vendor that ignores `page`
  // and returns the full list every time). First call is page-less to get the
  // vendor's default page/full list.
  const seen = new Map();
  let capHit = false;
  for (let page = 0; page <= MAX_PAGES; page++) {
    const path = page === 0 ? 'places' : `places?page=${page}`;
    let r;
    try {
      r = await osdmGet(company.api_base, path, token, extraHeaders);
    } catch (err) {
      const detail = err.name === 'AbortError' ? 'timeout' : err.message;
      // If the very first request fails, surface it; otherwise keep what we have.
      if (page === 0) {
        return res.status(502).json({ status: 502, title: 'Vendor API Error', detail: `GET /places failed: ${detail}` });
      }
      log.warn({ companyId, page, detail }, 'places pagination stopped on error — keeping places gathered so far');
      break;
    }
    if (!r.ok) {
      if (page === 0) {
        return res.status(502).json({ status: 502, title: 'Vendor API Error',
          detail: `GET /places returned HTTP ${r.status}${r.text ? ': ' + String(r.text).slice(0, 300) : ''}` });
      }
      break; // a later page errored (e.g. page out of range) — we're done
    }
    const places = (r.json && Array.isArray(r.json.places)) ? r.json.places : [];
    let added = 0;
    for (const p of places) {
      const np = normalizePlace(p);
      if (np && !seen.has(np.id)) {
        seen.set(np.id, np);
        added++;
        if (seen.size >= MAX_PLACES) { capHit = true; break; }
      }
    }
    if (capHit) { log.warn({ companyId, cap: MAX_PLACES }, 'places cap hit — cache truncated'); break; }
    if (added === 0) break; // no new ids this page → exhausted (or vendor ignores `page`)
    if (page === MAX_PAGES) { capHit = true; log.warn({ companyId, cap: MAX_PAGES }, 'places page cap hit — cache may be incomplete'); }
  }

  const list = Array.from(seen.values());
  run(
    `INSERT INTO places_cache (company_id, places_json, place_count, cached_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(company_id) DO UPDATE SET
       places_json = excluded.places_json,
       place_count = excluded.place_count,
       cached_at   = excluded.cached_at`,
    [companyId, JSON.stringify(list), list.length]
  );
  log.info({ companyId, count: list.length }, 'places cache refreshed');

  const fresh = get('SELECT place_count, cached_at FROM places_cache WHERE company_id = ?', [companyId]);
  return res.json({ place_count: fresh.place_count, cached_at: fresh.cached_at, truncated: capHit });
});

// ── GET /v1/company/places ────────────────────────────────────────────────────
// No ?q= → cache metadata. With ?q= → ranked full-text matches (prefix first).
router.get('/places', (req, res) => {
  if (denyAdminAndCertifier(req, res)) return;
  const companyId = resolveCompanyScope(req, res);
  if (companyId === null) return;

  const cache = readCache(companyId);
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) {
    return res.json({ place_count: cache.place_count, cached_at: cache.cached_at });
  }

  let limit = Number.parseInt(req.query.limit, 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;

  const scored = [];
  for (const p of cache.places) {
    const name = (p.name || '').toLowerCase();
    const id   = (p.id || '').toLowerCase();
    const inName = name.indexOf(q);
    const inId   = id.indexOf(q);
    if (inName === -1 && inId === -1) continue;
    // Rank: name-prefix (0) < name-substring (1) < id match (2); then by name.
    let rank;
    if (inName === 0) rank = 0;
    else if (inName > 0) rank = 1;
    else rank = 2;
    scored.push({ p, rank, pos: inName === -1 ? inId : inName });
  }
  scored.sort((a, b) => (a.rank - b.rank) || (a.pos - b.pos) || a.p.name.localeCompare(b.p.name));
  const results = scored.slice(0, limit).map(s => s.p);
  return res.json({ places: results, place_count: cache.place_count, cached_at: cache.cached_at });
});

module.exports = router;
