// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fareDeclarations.js — what a fare-based provider declares in its Test
 * Framework (#937, part B of #935). Pure.
 *
 * The declarations live in `fares` and matter only when the framework
 * declares the FARE distribution mode (#936). Each key absent means:
 *   - `clusters`: every cluster of OSDM (BUSINESS, FULL_FLEX, SEMI_FLEX,
 *     NON_FLEX, PROMO);
 *   - `combinationModels`: either model (CLUSTERING, COMBINING);
 *   - `statedRefundFee`: no, the provider does not take a fee the
 *     distributor states (`RefundSpecification.refundFee`, OSDM 3.8+, the
 *     provisional form of #242 D6);
 *   - `reservations`: none (`FARE_RESERVATION` for a BICYCLE, OSDM 3.8+, #255);
 *   - `salesFlows`: SALE only (a refund of fares, #907, is REFUND_FULL);
 *   - `freeUnderAge`: not declared.
 *
 * A reference scenario needs what its source exercises (fareRequirementsOf),
 * and fareMissing() says what a framework lacks for it, as sentences.
 */

const FARE_CLUSTERS = Object.freeze(['BUSINESS', 'FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX', 'PROMO']);
const COMBINATION_MODELS = Object.freeze(['CLUSTERING', 'COMBINING']);
const FARE_RESERVATIONS = Object.freeze(['BICYCLE']);
const FARE_SALES_FLOWS = Object.freeze(['SALE', 'REFUND_FULL']);
const FARE_KEYS = Object.freeze(['clusters', 'combinationModels', 'statedRefundFee', 'reservations', 'salesFlows', 'freeUnderAge']);
const MAX_FREE_UNDER_AGE = 30;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configOf = (framework) => (isObj(framework?.config) ? framework.config : framework);

/** The `fares` object of a framework, or {} when it has none. */
function faresOf(framework) {
  const fares = configOf(framework)?.fares;
  return isObj(fares) ? fares : {};
}

// A list key as declared: the known values in the list's order, or null when
// the key is absent (the caller says what absent means).
function listed(framework, key, known) {
  const raw = faresOf(framework)[key];
  return Array.isArray(raw) ? known.filter((v) => raw.includes(v)) : null;
}

/** The clusters a framework declares, most flexible first: every cluster when it names none. */
function declaredFareClusters(framework) {
  return listed(framework, 'clusters', FARE_CLUSTERS) ?? [...FARE_CLUSTERS];
}

/** True when the framework takes this combination model (either when none is named). */
function combinationModelDeclared(framework, model) {
  const models = listed(framework, 'combinationModels', COMBINATION_MODELS);
  return models === null || models.includes(model);
}

/** True when the provider takes a refund fee the distributor states. */
function statedRefundFeeDeclared(framework) {
  return faresOf(framework).statedRefundFee === true;
}

/** True when the provider sells this fare reservation (none when none is named). */
function fareReservationDeclared(framework, kind) {
  return (listed(framework, 'reservations', FARE_RESERVATIONS) || []).includes(kind);
}

/** True when the provider takes this sales flow on fares (SALE only when none is named). */
function fareSalesFlowDeclared(framework, flow) {
  return (listed(framework, 'salesFlows', FARE_SALES_FLOWS) || ['SALE']).includes(flow);
}

/** The age under which a fare is priced 0, or null when it is not declared. */
function freeUnderAgeOf(framework) {
  const n = faresOf(framework).freeUnderAge;
  return Number.isInteger(n) && n >= 1 && n <= MAX_FREE_UNDER_AGE ? n : null;
}

/**
 * The cluster a copied scenario asks for: its own when the framework declares
 * it, else the most flexible declared; null when it asks none, or the
 * framework declares none (the scenario then takes the first fare offer).
 */
function fareClusterFor(own, framework) {
  if (!own) return null;
  const declared = declaredFareClusters(framework);
  if (declared.includes(own)) return own;
  return declared[0] || null;
}

// The problem of a list key: not a list, or a value OSCAR does not know.
function listProblem(value, key, known) {
  if (!Array.isArray(value)) return `fares.${key} must be a list of ${known.join(', ')}.`;
  const unknown = value.filter((v) => !known.includes(v));
  if (unknown.length) return `fares.${key} holds ${unknown.map((v) => JSON.stringify(v).slice(0, 40)).join(', ')}, which is not one of ${known.join(', ')}.`;
  if (new Set(value).size !== value.length) return `fares.${key} names a value twice.`;
  return null;
}

/**
 * Why a framework's `fares` cannot be stored, as a sentence, or null when it
 * can. Absent is fine (nothing declared); an unknown key is refused, so a
 * typo does not read as "not declared".
 */
function fareDeclarationsProblem(value) {
  if (value === undefined) return null;
  if (!isObj(value)) return 'fares must be an object of fare declarations.';
  const unknown = Object.keys(value).filter((k) => !FARE_KEYS.includes(k));
  if (unknown.length) return `fares holds ${unknown.map((k) => JSON.stringify(k).slice(0, 40)).join(', ')}, which is not a fare declaration: ${FARE_KEYS.join(', ')}.`;
  const lists = [['clusters', FARE_CLUSTERS], ['combinationModels', COMBINATION_MODELS], ['reservations', FARE_RESERVATIONS], ['salesFlows', FARE_SALES_FLOWS]];
  for (const [key, known] of lists) {
    const problem = value[key] === undefined ? null : listProblem(value[key], key, known);
    if (problem) return problem;
  }
  if (value.salesFlows !== undefined && !value.salesFlows.includes('SALE')) return 'fares.salesFlows must hold SALE: a fare is sold before it is refunded.';
  if (value.statedRefundFee !== undefined && typeof value.statedRefundFee !== 'boolean') return 'fares.statedRefundFee must be true or false.';
  if (value.freeUnderAge !== undefined && (!Number.isInteger(value.freeUnderAge) || value.freeUnderAge < 1 || value.freeUnderAge > MAX_FREE_UNDER_AGE)) {
    return `fares.freeUnderAge must be a whole number of years, 1 to ${MAX_FREE_UNDER_AGE}.`;
  }
  return null;
}

/**
 * What a fare scenario needs declared in `fares`, from the scenario and its
 * catalogue entry: a refund of fares, a fee the distributor states, a model,
 * a fare reservation, the free age. Nothing for a scenario asking no fare.
 */
function fareRequirementsOf(scenario, parts, entry = {}) {
  const asked = Array.isArray(parts) ? parts : [];
  if (!asked.some((p) => String(p).startsWith('FARE_'))) return {};
  const refund = String(scenario?.scenarioType || 'SALE').toUpperCase() === 'REFUND';
  const statedFee = refund && scenario?.fareRefundFee != null && scenario.fareRefundFee !== '';
  const out = {};
  if (refund) out.salesFlow = 'REFUND_FULL';
  if (statedFee) out.statedRefundFee = true;
  const model = entry.combinationModel || (statedFee ? 'CLUSTERING' : null);
  if (model) out.combinationModel = model;
  if (asked.includes('FARE_RESERVATION')) out.reservation = 'BICYCLE';
  if (entry.limit === 'FREE_CHILD') out.freeUnderAge = true;
  // OSDM 3.8 brought RefundSpecification.refundFee and fare reservations.
  if (out.statedRefundFee || out.reservation) out.minOsdmVersion = '3.8';
  return out;
}

/** True when an OSDM version ("3.10.0", "3.8") is major.minor or later; never compared as a decimal. */
function versionAtLeast(version, major, minor) {
  const [a, b] = String(version || '').split('.').map((n) => Number.parseInt(n, 10));
  return Number.isInteger(a) && Number.isInteger(b) && (a > major || (a === major && b >= minor));
}

/**
 * The fare declarations of a simulated provider (#838 references): its
 * profile's clusters and free age, both models (COMBINING from station
 * 0000087), refunds of fares, and from OSDM 3.8 the stated fee and the
 * bicycle reservation. None when its profile sells no fare.
 */
function referenceFares(profile) {
  const f = profile?.fares;
  if (!isObj(f)) return undefined;
  const at38 = versionAtLeast(profile.osdmVersion, 3, 8);
  const clusters = Array.isArray(f.clusters) ? FARE_CLUSTERS.filter((c) => f.clusters.includes(c)) : [...FARE_CLUSTERS];
  const out = {
    clusters,
    combinationModels: [...COMBINATION_MODELS],
    statedRefundFee: at38,
    reservations: at38 ? [...FARE_RESERVATIONS] : [],
    salesFlows: [...FARE_SALES_FLOWS],
  };
  if (Number.isInteger(f.freeUnderAge) && f.freeUnderAge >= 1 && f.freeUnderAge <= MAX_FREE_UNDER_AGE) out.freeUnderAge = f.freeUnderAge;
  return out;
}

/** The fare declarations a framework lacks for these requirements, as sentences. */
function fareMissing(requirements, framework) {
  const r = isObj(requirements) ? requirements : {};
  const missing = [];
  if (r.salesFlow && !fareSalesFlowDeclared(framework, r.salesFlow)) missing.push('a refund of fares (Fares › Sales flows)');
  if (r.statedRefundFee && !statedRefundFeeDeclared(framework)) missing.push('a refund fee the distributor states (Fares)');
  if (r.combinationModel && !combinationModelDeclared(framework, r.combinationModel)) missing.push(`fares combined by ${r.combinationModel} (Fares › Combination models)`);
  if (r.reservation && !fareReservationDeclared(framework, r.reservation)) missing.push('a fare reservation for a bicycle (Fares › Reservations)');
  if (r.freeUnderAge && freeUnderAgeOf(framework) === null) missing.push('the age under which a fare is free (Fares)');
  return missing;
}

module.exports = {
  FARE_CLUSTERS, COMBINATION_MODELS, FARE_RESERVATIONS, FARE_SALES_FLOWS, FARE_KEYS, MAX_FREE_UNDER_AGE,
  faresOf, declaredFareClusters, combinationModelDeclared, statedRefundFeeDeclared, fareReservationDeclared,
  fareSalesFlowDeclared, freeUnderAgeOf, fareClusterFor, fareDeclarationsProblem, fareRequirementsOf, fareMissing,
  versionAtLeast, referenceFares,
};
