// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * companyRunMetrics.js — runs and their requests by company or provider, for
 * Prometheus (#1017).
 *
 * The labels are the company's name and its distributor's name (empty for a
 * top-level company). Never a user: an e-mail in Prometheus would be personal
 * data in a store without access control by company, and the number of series
 * would grow with every user. Who is running what is on Admin → Server
 * Activity instead.
 *
 * Bruno's requests go from its process straight to the provider, so OSCAR
 * counts them when a run ends, from what it stored (`run_requests`). Requests
 * a script sends itself (`bru.sendRequest`) are not stored, so not counted.
 */

// A label value Prometheus and Grafana show as written; the text format
// escapes it, this only keeps it short and on one line.
const MAX_LABEL = 80;
function labelText(value) {
  const text = typeof value === 'string' ? value.replaceAll(/\s+/g, ' ').trim() : '';
  return text.length > MAX_LABEL ? text.slice(0, MAX_LABEL) : text;
}

/** { company, distributor } of a row { name, parent_name }; unknown = its id. */
function labelsOf(row, companyId) {
  const company = labelText(row?.name) || `company ${labelText(String(companyId ?? '')) || 'unknown'}`;
  return { company, distributor: labelText(row?.parent_name) };
}

/**
 * Running and queued counts per company, as label sets for the gauges.
 * `counts` is a Map companyId → { running, queued }; `labelFor(companyId)` gives
 * its labels. Two companies of the same name stay two series only when their
 * distributors differ; otherwise their counts are added.
 */
function gaugeSamples(counts, labelFor) {
  const samples = new Map();
  for (const [companyId, { running = 0, queued = 0 }] of counts) {
    const labels = labelFor(companyId);
    const key = `${labels.distributor}\u0000${labels.company}`;
    const sample = samples.get(key) || { labels, running: 0, queued: 0 };
    sample.running += running;
    sample.queued += queued;
    samples.set(key, sample);
  }
  return [...samples.values()];
}

/**
 * The labels of a company, read once from the database and kept: the scrape
 * and every finished run ask. A rename shows at the next start.
 */
function labelCache(readRow) {
  const cache = new Map();
  return (companyId) => {
    if (!cache.has(companyId)) {
      let row = null;
      try { row = readRow(companyId); } catch { row = null; }
      cache.set(companyId, labelsOf(row, companyId));
    }
    return cache.get(companyId);
  };
}

const COMPANY_ROW_SQL = `SELECT c.name AS name, p.name AS parent_name
                           FROM companies c LEFT JOIN companies p ON p.id = c.parent_id
                          WHERE c.id = ?`;

module.exports = { labelsOf, gaugeSamples, labelCache, labelText, COMPANY_ROW_SQL, MAX_LABEL };
