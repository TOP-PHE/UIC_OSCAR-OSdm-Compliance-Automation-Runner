/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * optionNotDeclared.js — an offer search option the Test Framework leaves
 * out, asked on purpose (#780 PR C).
 *
 * A probe (`offerOptionExpectRejection`) asks for offers with one option value
 * the framework does not declare (a travel class, a service class, an offer
 * part, a flexibility or a product tag). OSDM does not say what a provider must
 * then do, so the grading is the currency probe's (#781):
 * - a refusal (4xx) is graded as one (`validateProblemResponse()`, 501 = not
 *   supported, a WARNING);
 * - no offer, or offers with the member said ignored (PARAMETER_NOT_SUPPORTED),
 *   pass;
 * - offers that keep to the value fail: the provider takes it, so the Test
 *   Framework should declare it;
 * - offers that do not keep to it, with nothing saying it was ignored, pass
 *   with a WARNING: a distributor cannot tell the value was not taken.
 * The scenario ends after 01.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { askedOptions, checkOfferCriteria } = require('./offerCriteria.js');

/** The option values a request asks, as "<member> <value>" texts. */
function askedValues(criteria) {
  const asked = askedOptions(criteria);
  return Object.entries(asked).flatMap(([option, values]) => values.map((v) => `${option} ${v}`));
}

/**
 * What the provider did with the undeclared value: 'refused' (4xx or 5xx),
 * 'none' (no offer), 'ignored' (said so), 'kept' (every option check passes:
 * it takes the value) or 'silent' (offers that do not keep to it, nothing said).
 */
function undeclaredOutcome(status, body, criteria, ignored = []) {
  if (Number(status) >= 400) return 'refused';
  const offers = Array.isArray(body?.offers) ? body.offers.filter(Boolean) : [];
  if (offers.length === 0) return 'none';
  const checks = checkOfferCriteria(criteria, body, ignored);
  if (checks.some((c) => !c.ok && /PARAMETER_NOT_SUPPORTED/.test(c.message))) return 'ignored';
  return checks.length > 0 && checks.every((c) => c.ok) ? 'kept' : 'silent';
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readCriteria() {
  const raw = bru.getEnvVar('offerSearchCriteria');
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/**
 * Step 01, after the response, before the status check. True when the probe
 * is armed: it is graded here and the scenario ends.
 */
function checkUndeclaredOption(status, body) {
  if (String(bru.getEnvVar('offerOptionExpectRejection')) !== 'true') return false;
  const criteria = readCriteria();
  const values = askedValues(criteria);
  const label = `🧪 Undeclared option probe [${values.join(', ') || 'no option'}, POST /offers]`;
  if (values.length === 0) {
    test(`${label}: the request asks for an option value`, () => {
      throw new Error('the scenario arms the undeclared option probe but its offer search criteria name no option value');
    });
    return true;
  }
  validationLogger(`[INFO] 🧪 Undeclared option probe — ${values.join(', ')} is not declared in the Test Framework; the provider should refuse it, offer nothing, or say it ignored it.`);
  const { ignoredParameters } = require('./ignoredParameters.js');
  const outcome = undeclaredOutcome(status, body, criteria, ignoredParameters(body));
  if (outcome === 'refused') {
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status, body, targets: [], prefix: '🧪 Undeclared option probe', label: `${values.join(', ')}, POST /offers`,
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => validationLogger(`[${level}] ${msg}`),
    });
    return true;
  }
  test(`${label}: the offers do not keep to the value asked`, () => {
    if (outcome === 'kept') {
      throw new Error(`every offer keeps to ${values.join(', ')}: the provider takes it, so the Test Framework should declare it`);
    }
  });
  if (outcome === 'ignored') validationLogger('[INFO] 🧪 Undeclared option probe: the provider says it ignored the option (PARAMETER_NOT_SUPPORTED).');
  if (outcome === 'silent') {
    validationLogger(`[WARNING] 🧪 Undeclared option probe: offers that do not keep to ${values.join(', ')}, with nothing saying it was not taken; a refusal or a PARAMETER_NOT_SUPPORTED problem helps a distributor.`);
  }
  return true;
}

module.exports = { askedValues, undeclaredOutcome, checkUndeclaredOption };
