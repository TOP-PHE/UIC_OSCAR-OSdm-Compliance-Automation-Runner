// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * frameworkGating.js — pure helpers that enforce the "framework declares =>
 * scenario may exercise" rule.
 *
 * The Test Framework (per-company config in test_frameworks.config) declares
 * the OSDM capabilities the provider implements. Scenarios in the datafile
 * arm those capabilities (e.g. `partialRefundByLeg='on'`). The golden rule:
 * a scenario must not arm a capability the framework hasn't declared,
 * because there is no way to verify the result of an undeclared capability.
 *
 * This module is the single source of truth for the mapping between a
 * scenario field and the framework declaration it depends on, used by:
 *
 *   1. Server lazy migration (company-test-framework.js GET): derives the
 *      missing salesFlows entries from existing scenarios so an upgrade
 *      doesn't silently break a Test Manager's running configuration. The
 *      migration is conservative — it ADDS declarations to match the
 *      scenarios; it never removes anything.
 *
 *   2. Server datafile annotator (company.js GET /datafile): when the
 *      datafile is served to Bruno, each scenario whose armed field
 *      isn't declared in the current framework gets a
 *      `__featureNotDeclaredWarnings: [field, ...]` array — the Bruno
 *      collection emits a [WARNING] log line per entry at scenario load.
 *
 *   3. Wizard UI (scenarios.js): inline ⚠ chip next to an armed-but-not-
 *      declared dropdown, and a top-of-page banner with the count of
 *      scenarios in that state.
 *
 * Scope today (#218 follow-up):
 *   - partialRefundByLeg / partialRefundByPax  ↔  salesFlows: REFUND_PARTIAL
 *   - (future) partialExchangeByLeg / partialExchangeByPax  ↔  EXCHANGE_PARTIAL
 *   - (future) requestedInformationProbe                    ↔  ???
 *
 * The function `gatingRules()` returns the active rule table. Each rule has:
 *   - `field`            : the scenario field to inspect
 *   - `isArmed(value)`   : returns true when the field value represents "ON"
 *   - `requiresFlow`     : the salesFlows[] entry that must be declared
 *   - `requiresScenarioType` : optional, scopes the rule to a scenario type
 */

module.exports = {
  gatingRules,
  isScenarioArmedForField,
  scenarioWarnings,
  deriveSalesFlowsAdditions,
  applyFrameworkMigration,
  annotateDatafile,
};

// Truthy values used across the codebase to mean "on" for scenario flags.
// Keep aligned with Bruno_Collection/library-bruno/scenarioParser.js (which
// treats 'on', 'true', 'yes', boolean true as armed).
const ARMED_VALUES = new Set(['on', 'true', 'yes', '1', true, 1]);

function isArmedValue(v) {
  if (v === true || v === 1) return true;
  if (v == null) return false;
  return ARMED_VALUES.has(String(v).toLowerCase());
}

/**
 * The rule table. Add new rules here as features are added.
 * Pure data — no side effects.
 */
function gatingRules() {
  return [
    {
      field: 'partialRefundByLeg',
      isArmed: isArmedValue,
      requiresFlow: 'REFUND_PARTIAL',
      requiresScenarioType: 'REFUND',
      humanLabel: 'Partial refund per-leg',
    },
    {
      field: 'partialRefundByPax',
      isArmed: isArmedValue,
      requiresFlow: 'REFUND_PARTIAL',
      requiresScenarioType: 'REFUND',
      humanLabel: 'Partial refund per-passenger',
    },
  ];
}

/**
 * True if scenario[field] represents an armed value AND the rule applies
 * to this scenario's type. Returns false for unrelated scenario types.
 */
function isScenarioArmedForField(scenario, rule) {
  if (!scenario || !rule) return false;
  if (rule.requiresScenarioType) {
    const t = String(scenario.scenarioType || 'SALE').toUpperCase();
    if (t !== rule.requiresScenarioType) return false;
  }
  return rule.isArmed(scenario[rule.field]);
}

/**
 * Return the list of fields the scenario has armed but the framework
 * hasn't declared. Empty array when the scenario is fully covered.
 */
function scenarioWarnings(scenario, framework, rules) {
  rules = rules || gatingRules();
  const flows = (framework && Array.isArray(framework.salesFlows)) ? framework.salesFlows : [];
  const out = [];
  for (const rule of rules) {
    if (!isScenarioArmedForField(scenario, rule)) continue;
    if (flows.includes(rule.requiresFlow)) continue;
    out.push(rule.field);
  }
  return out;
}

/**
 * Walk all scenarios; return the set of `requiresFlow` strings that should
 * be added to `framework.salesFlows[]` to cover everything that's currently
 * armed. Conservative: only ADDS, never removes — so the migration never
 * silently breaks a Test Manager's existing configuration.
 *
 * @param {object[]} scenarios
 * @param {object}   framework
 * @returns {string[]} flow entries to add (no duplicates)
 */
function deriveSalesFlowsAdditions(scenarios, framework) {
  const rules = gatingRules();
  const have  = new Set((framework && Array.isArray(framework.salesFlows)) ? framework.salesFlows : []);
  const want  = new Set();
  for (const sc of (Array.isArray(scenarios) ? scenarios : [])) {
    for (const rule of rules) {
      if (isScenarioArmedForField(sc, rule)) want.add(rule.requiresFlow);
    }
  }
  const additions = [];
  for (const flow of want) {
    if (!have.has(flow)) additions.push(flow);
  }
  return additions;
}

/**
 * Apply the lazy migration to a framework config in place. Returns
 * `{ migrated: boolean, additions: string[] }`. Caller decides whether to
 * persist the result.
 *
 * Idempotent: when `_salesFlowsMigratedAt` is already set, the migration
 * skips (no second derivation). When there is nothing to add, the stamp is
 * still set so we don't keep re-scanning every GET.
 *
 * @param {object} framework  the decrypted config object (mutated)
 * @param {object[]} scenarios  the company datafile scenarios array (may be empty)
 * @param {string} nowIso  ISO timestamp for the audit stamp
 * @returns {{migrated: boolean, additions: string[]}}
 */
function applyFrameworkMigration(framework, scenarios, nowIso) {
  if (!framework || typeof framework !== 'object') {
    return { migrated: false, additions: [] };
  }
  if (framework._salesFlowsMigratedAt) {
    return { migrated: false, additions: [] };
  }
  if (!Array.isArray(framework.salesFlows)) framework.salesFlows = [];
  const additions = deriveSalesFlowsAdditions(scenarios, framework);
  if (additions.length > 0) {
    framework.salesFlows = [...framework.salesFlows, ...additions];
  }
  framework._salesFlowsMigratedAt = nowIso || new Date().toISOString();
  return { migrated: true, additions };
}

/**
 * Annotate a datafile object in place: each scenario that arms an
 * undeclared feature gets `__featureNotDeclaredWarnings: [field, ...]`.
 * Removes the field when there are no warnings (avoids stale annotations
 * surviving a framework change).
 *
 * @param {object} datafile  parsed datafile (mutated)
 * @param {object} framework  the framework config
 * @returns {{annotatedCount: number}}
 */
function annotateDatafile(datafile, framework) {
  if (!datafile || !Array.isArray(datafile.scenarios)) return { annotatedCount: 0 };
  let count = 0;
  for (const sc of datafile.scenarios) {
    const warnings = scenarioWarnings(sc, framework);
    if (warnings.length > 0) {
      sc.__featureNotDeclaredWarnings = warnings;
      count++;
    } else if (Object.prototype.hasOwnProperty.call(sc, '__featureNotDeclaredWarnings')) {
      delete sc.__featureNotDeclaredWarnings;
    }
  }
  return { annotatedCount: count };
}
