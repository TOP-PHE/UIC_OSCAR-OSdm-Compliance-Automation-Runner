// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * distributionModes.js — how a provider distributes (#936). Pure.
 *
 * OSDM has two modes. In product mode the provider sells products and
 * tickets. In fare mode it sells fares for a requested section, and the
 * distributor builds the ticket (#242). The Test Framework declares the
 * modes in `distributionModes`: `PRODUCT`, `FARE`, or both.
 *
 * Absent means product only (decision E1 of #935): every framework from
 * before 1.11.386 keeps its scenarios and its catalogue. An empty list is
 * refused, since a provider that sells nothing has nothing to test.
 *
 * A scenario's modes are read from the scenario itself:
 *   - FARE when it asks a FARE_* offer part, or expects no fare
 *     (`expectFares: false`, #905), which tests a fare provider;
 *   - PRODUCT when it asks no fare, or books a product (`bookMode:
 *     PRODUCT`, #207).
 * A scenario asking fares and booking the product needs both.
 */

const { scenarioOfferCriteria } = require('./frameworkGating');

const DISTRIBUTION_MODES = Object.freeze(['PRODUCT', 'FARE']);
const DISTRIBUTION_MODE_TEXT = Object.freeze({ PRODUCT: 'product-based', FARE: 'fare-based' });
const DEFAULT_MODES = Object.freeze(['PRODUCT']);
const FARE_PARTS = new Set(['FARE_ADMISSION', 'FARE_RESERVATION', 'FARE_ANCILLARY']);

/** The modes a framework declares, in DISTRIBUTION_MODES order: product only when it says nothing. */
function declaredDistributionModes(framework) {
  const raw = framework?.distributionModes;
  if (!Array.isArray(raw)) return [...DEFAULT_MODES];
  const known = DISTRIBUTION_MODES.filter((m) => raw.includes(m));
  return known.length > 0 ? known : [...DEFAULT_MODES];
}

/** True when the framework declares this mode. */
function distributionModeDeclared(framework, mode) {
  return declaredDistributionModes(framework).includes(mode);
}

/** The modes a scenario needs, in DISTRIBUTION_MODES order. */
function distributionModesOf(scenario, datafile) {
  if (!scenario || typeof scenario !== 'object') return [];
  const parts = scenarioOfferCriteria(scenario, datafile)?.requestedOfferParts;
  const asksFares = Array.isArray(parts) && parts.some((p) => FARE_PARTS.has(p));
  const fare = asksFares || String(scenario.expectFares) === 'false';
  const product = !fare || scenario.bookMode === 'PRODUCT';
  return DISTRIBUTION_MODES.filter((m) => (m === 'FARE' ? fare : product));
}

/** The modes a scenario needs that the framework does not declare. */
function undeclaredDistributionModes(scenario, framework, datafile) {
  return distributionModesOf(scenario, datafile).filter((m) => !distributionModeDeclared(framework, m));
}

/**
 * Why a framework's `distributionModes` cannot be stored, as a sentence, or
 * null when it can. Absent is fine (product only); a list must hold one or
 * both modes, each once.
 */
function distributionModesProblem(value) {
  if (value === undefined) return null;
  const listed = DISTRIBUTION_MODES.join(' and ');
  if (!Array.isArray(value) || value.length === 0) {
    return `distributionModes must list the modes the provider sells: ${listed}, one or both.`;
  }
  const unknown = value.filter((m) => !DISTRIBUTION_MODES.includes(m));
  if (unknown.length > 0) {
    return `distributionModes holds ${unknown.map((m) => JSON.stringify(m).slice(0, 40)).join(', ')}, which is not a mode: ${listed}.`;
  }
  if (new Set(value).size !== value.length) return 'distributionModes names a mode twice.';
  return null;
}

module.exports = {
  DISTRIBUTION_MODES,
  DISTRIBUTION_MODE_TEXT,
  declaredDistributionModes,
  distributionModeDeclared,
  distributionModesOf,
  undeclaredDistributionModes,
  distributionModesProblem,
};
