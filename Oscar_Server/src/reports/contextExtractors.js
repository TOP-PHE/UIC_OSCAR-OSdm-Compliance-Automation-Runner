'use strict';

/**
 * contextExtractors.js — Per-endpoint request-context extraction
 *
 * Certifiers need to know _how_ a request was parameterised to interpret its
 * result. A refund that succeeds on a non-refundable offer is only explicable
 * if you know the request carried an `overruleCode` (reason-code refund). The
 * same logic applies to exchange flows, offer flexibility filters, etc.
 *
 * This module reads the request body Bruno sent (`entry.request.data` from
 * .bru_results.json) and returns a small JSON object surfaced by the Report
 * Builder as inline tags on the capability matrix.
 *
 * Design is intentionally narrow: one extractor per endpoint family, dispatch
 * by URL pattern (resilient to folder renames), additive — adding a new
 * endpoint means one new extractor, no churn elsewhere.
 */

function parseBody(entry) {
  const data = entry && entry.request && entry.request.data;
  if (data == null) return null;
  if (typeof data === 'object') return data;           // already parsed
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (_) { return null; }
  }
  return null;
}

// Extractors — each returns a plain object or null. The result is serialised
// to JSON and stored in run_requests.context.
// Convention for rendering:
//   { key1: value1, key2: value2 }  → tags: "key1: value1", "key2: value2"
//   values that are null/undefined/empty are dropped at render time.

function refundContext(entry) {
  const body = parseBody(entry);
  if (!body) return null;
  const overrule = body.overruleCode || body.reasonCode || null;
  // If the refund request carries an explicit overruleCode, it's a
  // reason-code refund (vendor refunds despite offer.refundable = NO).
  // Otherwise the request is a voluntary refund.
  return {
    mode: overrule ? 'reason-code' : 'voluntary',
    overruleCode: overrule || null,
  };
}

function exchangeContext(entry) {
  const body = parseBody(entry);
  if (!body) return null;
  const overrule = body.overruleCode || body.reasonCode || null;
  return {
    mode: overrule ? 'reason-code' : 'voluntary',
    overruleCode: overrule || null,
  };
}

function offerContext(entry) {
  const body = parseBody(entry);
  if (!body) return null;
  const ctx = {};
  // OSDM offer-request criteria we care about for certifier context
  const crit = body.tripSearchCriteria || body.offerSearchCriteria || body;
  if (crit && crit.flexibility)        ctx.flexibility = crit.flexibility;
  if (crit && crit.desiredFlexibility) ctx.flexibility = crit.desiredFlexibility;
  if (Array.isArray(crit && crit.anonymousPassengerSpecifications)) {
    ctx.paxCount = crit.anonymousPassengerSpecifications.length;
  } else if (Array.isArray(body.passengerSpecifications)) {
    ctx.paxCount = body.passengerSpecifications.length;
  }
  return Object.keys(ctx).length ? ctx : null;
}

function bookingContext(entry) {
  const body = parseBody(entry);
  if (!body) return null;
  const ctx = {};
  if (Array.isArray(body.passengers)) ctx.paxCount = body.passengers.length;
  if (body.currency)                   ctx.currency = body.currency;
  return Object.keys(ctx).length ? ctx : null;
}

// URL pattern → extractor. Order matters: first match wins.
// Patterns are tested against the request URL's pathname portion only.
const DISPATCH = [
  { re: /\/refund-offers(\/|$|\?)/i,   fn: refundContext   },
  { re: /\/exchange-offers(\/|$|\?)/i, fn: exchangeContext },
  { re: /\/offers(\/|$|\?)/i,          fn: offerContext    },
  { re: /\/bookings(\/|$|\?)(?!.*refund|.*exchange)/i, fn: bookingContext },
];

/**
 * Extract context for a Bruno result entry. Returns the JSON-serialised
 * string ready for insertion, or null if no extractor matched or the
 * extractor returned nothing useful.
 */
function extractRequestContext(entry) {
  const url = (entry && entry.request && entry.request.url) || '';
  if (!url) return null;
  for (const { re, fn } of DISPATCH) {
    if (re.test(url)) {
      try {
        const ctx = fn(entry);
        if (ctx && Object.keys(ctx).length) return JSON.stringify(ctx);
      } catch (_) { /* never break extraction on a single bad entry */ }
      return null;
    }
  }
  return null;
}

module.exports = { extractRequestContext };
