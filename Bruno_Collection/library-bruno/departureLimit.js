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

// #721: the words of a refusal (code, title, detail of the Problem or of each
// of its problems), lower case; '' when it gives none.
function refusalText(body) {
  if (!body || typeof body !== 'object') return '';
  const items = Array.isArray(body.problems) ? body.problems : [body];
  return items.filter((p) => p && typeof p === 'object')
    .flatMap((p) => [p.code, p.title, p.detail])
    .filter((t) => typeof t === 'string' && t.trim())
    .join(' | ');
}

// Words that say a refusal is about the departure date. A date of birth is
// about a passenger, so it is taken out first; word starts keep "validation"
// and "invalidated" out.
const DATE_WORDS = /\bdate|\btime\b|\bdepart|\bpast\b|horizon|\bperiod|\bfuture|\badvance|\bdays?\b|calendar|too (early|late)|not (yet )?bookable/i;
const BIRTH_WORDS = /date[ _-]?of[ _-]?birth|birth[ _-]?date/gi;

/**
 * #721: whether a refusal is about the date: 'date' when its words say so,
 * 'unknown' when it gives no reason, 'other' when it names something else.
 */
function refusalReason(body) {
  const text = refusalText(body);
  if (!text) return 'unknown';
  return DATE_WORDS.test(text.replace(BIRTH_WORDS, ' ')) ? 'date' : 'other';
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
    gradeRefusalReason(body, when);
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

// #721: a refusal for another reason shows nothing about dates.
function gradeRefusalReason(body, when) {
  const reason = refusalReason(body);
  if (reason === 'unknown') {
    validationLogger(`[INFO] 🧪 Departure date probe: the refusal gives no reason, so it cannot be checked that it is about the date.`);
    return;
  }
  const text = refusalText(body).slice(0, 300);
  test(`🧪 Departure date probe [departure ${when}, POST /offers]: the refusal is for the departure date`, () => {
    if (reason === 'other') {
      throw new Error(`the provider refused for another reason: "${text}". The probe shows nothing about dates until the rest of the request is accepted: check its filters, passengers and format (a request without the date problem must give offers).`);
    }
  });
}

module.exports = { departureOutcome, describeDays, refusalText, refusalReason, checkDepartureRefused };
