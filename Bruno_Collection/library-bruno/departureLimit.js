/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * departureLimit.js — the departure-date probe (#704).
 *
 * A scenario may set its own departure date (`departureDaysFromToday`, read by
 * scenarioParser). With `departureExpectRejection` on, the date is one the
 * provider must not sell: past (yesterday), or one day beyond the sales
 * horizon the Test Framework declares (`salesHorizonDays`). POST /offers must
 * then refuse it (a 4xx Problem) or give no offer. Either passes and ends the
 * scenario; offers given fail, and the scenario ends too: nothing is booked.
 */

require('./displays.js');

/** What the provider did with the request: 'refused', 'no-offer' or 'accepted'. */
function departureOutcome(status, body) {
  if (typeof status !== 'number' || status >= 300) return 'refused';
  const offers = body && typeof body === 'object' ? body.offers : undefined;
  if (!Array.isArray(offers) || offers.length === 0) return 'no-offer';
  return 'accepted';
}

/** The words for the date asked: "1 day(s) ago" or "91 day(s) from today". */
function describeDays(days) {
  const n = typeof days === 'string' && /^-?\d+$/.test(days.trim()) ? Number(days) : days;
  if (!Number.isInteger(n)) return 'a date the provider must not sell';
  return n < 0 ? `${-n} day(s) ago` : `${n} day(s) from today`;
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

const armed = () => String(bru.getEnvVar('departureExpectRejection')) === 'true';

/**
 * Step 01, after the response. True when the probe is armed: it is graded
 * here, and the scenario ends.
 */
function checkDepartureRefused(status, body) {
  if (!armed()) return false;
  const when = describeDays(bru.getEnvVar('departureDaysFromToday'));
  validationLogger(`[INFO] 🧪 Departure date probe — departure ${when}; the provider must not sell it.`);
  const outcome = departureOutcome(status, body);
  if (outcome === 'refused') {
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status,
      body,
      targets: [],
      prefix: '🧪 Departure date probe',
      label: `departure ${when}, POST /offers`,
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => validationLogger(`[${level}] ${msg}`),
    });
    return true;
  }
  test(`🧪 Departure date probe [departure ${when}, POST /offers]: no offer is given`, () => {
    if (outcome === 'accepted') {
      throw new Error(`POST /offers gave ${body.offers.length} offer(s) for a departure ${when}`);
    }
  });
  if (outcome === 'no-offer') {
    const problems = Array.isArray(body?.problems) ? body.problems : [];
    validationLogger(problems.length
      ? `[INFO] 🧪 Departure date probe: the answer explains it with ${problems.length} problem(s): ${problems.map((p) => p?.code || p?.title).filter(Boolean).join(', ')}.`
      : '[WARNING] 🧪 Departure date probe: no offer and no problem saying why; a Problem naming the date helps a distributor.');
  }
  return true;
}

module.exports = { departureOutcome, describeDays, checkDepartureRefused };
