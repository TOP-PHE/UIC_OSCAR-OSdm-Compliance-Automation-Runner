'use strict';

/**
 * classifier.js — Assertion classification engine
 *
 * Classifies Bruno test assertions into structured categories, OSDM domains,
 * offer part types, and severity levels based on pattern matching on the
 * assertion name string.
 *
 * Used by structureResults.js to enrich run_assertions rows with metadata
 * for filtering, reporting, and trend analysis.
 */

// ── Category classification ──────────────────────────────────────────────────
// Determines what KIND of check the assertion performs.
function classifyCategory(name) {
  const n = name.toLowerCase();

  if (['api base is available', 'library base is available', 'data file is available',
       'trip search criteria has at least one leg'].some(k => n.includes(k))) {
    return 'environment_check';
  }
  if (/status code is \d|→ \d{3}|-> \d{3}|→ unexpected status|server error|unauthorized|forbidden|not found/.test(n)) {
    return 'http_status';
  }
  if (n.includes('content-type')) return 'content_type';
  if (['post-response script error', 'pre-request script error'].some(k => n.includes(k))) return 'script_error';
  if (n.includes('prerequisite')) return 'prerequisite';
  if (['matches between offer and booking', 'matches offer currency', 'member in common between',
       'in both offer and booking', 'matches confirmedprice', 'matches offersummary',
       'currency consistency'].some(k => n.includes(k))) {
    return 'data_consistency';
  }
  if (['array exists', 'object exists', 'is a non-empty string', 'response body is present',
       'response contains at least one', 'structure exists', 'fields exist',
       'is present', 'is defined'].some(k => n.includes(k))) {
    return 'response_structure';
  }
  if (['is a valid iso', 'is a valid date', 'is a valid value', 'is a valid osdm',
       'is a known value', 'is a boolean', 'is a valid future', 'is valid and in the past',
       'valid datetime', 'temporal order'].some(k => n.includes(k))) {
    return 'field_validation';
  }
  if (['baseline request', 'offer baseline', 'param probe'].some(k => n.includes(k))) {
    return 'parameter_probe';
  }
  if (['scenario', 'version used is', 'version consistency'].some(k => n.includes(k))) {
    return 'scenario_config';
  }
  return 'business_logic';
}

// ── OSDM Domain classification ───────────────────────────────────────────────
// Determines which OSDM business domain the assertion validates.
function classifyDomain(name, suite) {
  const n = name.toLowerCase();
  const s = (suite || '').toLowerCase();

  if (['api base', 'library base', 'data file', 'content-type', 'trip search criteria'].some(k => n.includes(k))) {
    return 'infrastructure';
  }
  // Word-boundary match on "refund" and "exchange" so assertions that mention
  // e.g. "exchangeable" or "refundable" (offer fields present in every flow)
  // don't get misclassified into the refund/exchange domains. The suite-folder
  // check still uses substring — "03-Refund" / "04-Exchange" are safe.
  if (s.includes('refund') || /\brefund\b/.test(n)) return 'refund';
  if (s.includes('exchange') || /\bexchange\b/.test(n)) return 'exchange';
  if (['fulfillment', 'fulfil'].some(k => n.includes(k))) return 'fulfillment';
  if (['passenger', 'first name', 'last name', 'date of birth', 'phone number',
       'email is correct'].some(k => n.includes(k))) {
    return 'passenger';
  }
  if (['booking', 'bookedoffer', 'provisionalp', 'confirmedp', 'bookingcode'].some(k => n.includes(k))) {
    return 'booking';
  }
  if (['offer', 'admission', 'reservation', 'ancillary', 'trip ', 'leg ',
       'offerpart', 'offermode', 'flexibility', 'serviceclass', 'travelclass',
       'accommodation', 'prebookable', 'coveredleg', 'coveredtrip', 'minimalp'].some(k => n.includes(k))) {
    return 'offer';
  }
  if (['system infos', 'version', 'coach', 'product', 'zone', 'reduction',
       'promotion', 'passenger categor', 'place map'].some(k => s.includes(k))) {
    return 'system';
  }
  if (n.includes('scenario') || n.includes('version used')) return 'system';
  return 'offer'; // default
}

// ── Offer Part classification ────────────────────────────────────────────────
function classifyOfferPart(name) {
  const n = name.toLowerCase();
  if (n.includes('admission')) return 'admission';
  if (n.includes('reservation')) return 'reservation';
  if (n.includes('ancillary')) return 'ancillary';
  if (n.includes('fee') && !n.includes('refund') && !n.includes('exchange')) return 'fee';
  if (n.includes('fare')) return 'fare';
  return null;
}

// ── Severity auto-detection ──────────────────────────────────────────────────
// Determines assertion severity based on category and assertion context.
function classifySeverity(name, category, passed) {
  // Passed assertions are always 'info' severity
  if (passed) return 'info';

  const n = name.toLowerCase();

  // Critical: auth failures, script errors, prerequisites
  if (category === 'script_error') return 'critical';
  if (category === 'prerequisite') return 'critical';
  if (/401|unauthorized|forbidden|token.*error|auth.*failed/.test(n)) return 'critical';
  if (/500|server error/.test(n)) return 'critical';

  // Major: HTTP status failures, business logic failures, data consistency
  if (category === 'http_status') return 'major';
  if (category === 'business_logic') return 'major';
  if (category === 'data_consistency') return 'major';
  if (category === 'field_validation') return 'major';

  // Minor: structure checks, content-type
  if (category === 'response_structure') return 'minor';
  if (category === 'content_type') return 'minor';

  // Info: environment checks, scenario config
  if (category === 'environment_check') return 'info';
  if (category === 'scenario_config') return 'info';

  return 'major'; // default for failed assertions
}

// ── Parameterization detection ───────────────────────────────────────────────
// Checks if the assertion name contains dynamic values (UUIDs, dates, amounts).
function isParameterized(name) {
  if (/[0-9a-f]{8}-[0-9a-f]{4}/.test(name)) return true;
  if (/expected:\s*\S+,\s*actual:/.test(name)) return true;
  if (/https?:\/\//.test(name)) return true;
  if (/\d{4}-\d{2}-\d{2}T/.test(name)) return true;
  if (/amount:\s*\d/.test(name)) return true;
  if (/count\s*:\s*\d/.test(name)) return true;
  if (/length:\s*\d/.test(name)) return true;
  return false;
}

// ── Value extraction ─────────────────────────────────────────────────────────
function extractExpected(name) {
  let m = name.match(/expected:\s*([^,)]+)/);
  if (m) return m[1].trim();
  m = name.match(/→ (\d{3})/);
  if (m) return m[1];
  m = name.match(/Status code is (\d+)/);
  if (m) return m[1];
  m = name.match(/-> (\d{3})/);
  if (m) return m[1];
  return null;
}

function extractActual(name) {
  const m = name.match(/actual:\s*([^,)]+)/);
  if (m) return m[1].trim();
  return null;
}

module.exports = {
  classifyCategory,
  classifyDomain,
  classifyOfferPart,
  classifySeverity,
  isParameterized,
  extractExpected,
  extractActual
};
