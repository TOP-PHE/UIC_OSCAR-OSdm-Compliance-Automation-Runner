// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * framework-gating.test.js — unit tests for the framework-gating helpers
 * (Oscar_Server/src/utils/frameworkGating.js, #218 follow-up — golden rule).
 *
 * The module exposes four pure functions:
 *   - isScenarioArmedForField(scenario, rule)
 *   - scenarioWarnings(scenario, framework)
 *   - deriveSalesFlowsAdditions(scenarios, framework)
 *   - applyFrameworkMigration(framework, scenarios, nowIso)
 *   - annotateDatafile(datafile, framework)
 *
 * Plus one rule-table accessor (gatingRules()).
 */

const {
  gatingRules,
  isScenarioArmedForField,
  scenarioWarnings,
  deriveSalesFlowsAdditions,
  applyFrameworkMigration,
  annotateDatafile,
} = require('../../src/utils/frameworkGating');

const PARTIAL_LEG_RULE = gatingRules().find(r => r.field === 'partialRefundByLeg');
const PARTIAL_PAX_RULE = gatingRules().find(r => r.field === 'partialRefundByPax');

describe('gatingRules', () => {
  test('returns the partial-refund pair', () => {
    const rules = gatingRules();
    const fields = rules.map(r => r.field);
    expect(fields).toEqual(expect.arrayContaining(['partialRefundByLeg', 'partialRefundByPax']));
  });

  test('partialRefund rules require REFUND scenario type and REFUND_PARTIAL flow', () => {
    for (const r of [PARTIAL_LEG_RULE, PARTIAL_PAX_RULE]) {
      expect(r.requiresScenarioType).toBe('REFUND');
      expect(r.requiresFlow).toBe('REFUND_PARTIAL');
    }
  });
});

describe('isScenarioArmedForField', () => {
  test('accepts the canonical truthy values', () => {
    for (const v of ['on', 'true', 'yes', '1', true, 1]) {
      expect(isScenarioArmedForField(
        { scenarioType: 'REFUND', partialRefundByLeg: v }, PARTIAL_LEG_RULE
      )).toBe(true);
    }
  });

  test('rejects falsy / off / unrelated values', () => {
    for (const v of ['off', 'false', 'no', '0', false, 0, null, undefined, '']) {
      expect(isScenarioArmedForField(
        { scenarioType: 'REFUND', partialRefundByLeg: v }, PARTIAL_LEG_RULE
      )).toBe(false);
    }
  });

  test('rejects when scenario type does not match (scope guard)', () => {
    expect(isScenarioArmedForField(
      { scenarioType: 'SALE', partialRefundByLeg: 'on' }, PARTIAL_LEG_RULE
    )).toBe(false);
    expect(isScenarioArmedForField(
      { scenarioType: 'EXCHANGE', partialRefundByLeg: 'on' }, PARTIAL_LEG_RULE
    )).toBe(false);
  });

  test('null inputs are safe', () => {
    expect(isScenarioArmedForField(null, PARTIAL_LEG_RULE)).toBe(false);
    expect(isScenarioArmedForField({}, null)).toBe(false);
  });
});

describe('scenarioWarnings', () => {
  test('returns empty array when framework declares the flow', () => {
    const sc = { scenarioType: 'REFUND', partialRefundByLeg: 'on', partialRefundByPax: 'on' };
    const fw = { salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL'] };
    expect(scenarioWarnings(sc, fw)).toEqual([]);
  });

  test('returns both fields when neither is declared', () => {
    const sc = { scenarioType: 'REFUND', partialRefundByLeg: 'on', partialRefundByPax: 'on' };
    const fw = { salesFlows: ['SALE', 'REFUND_FULL'] };
    expect(scenarioWarnings(sc, fw)).toEqual(['partialRefundByLeg', 'partialRefundByPax']);
  });

  test('returns only armed-and-undeclared fields, not all rules', () => {
    const sc = { scenarioType: 'REFUND', partialRefundByLeg: 'on', partialRefundByPax: 'off' };
    const fw = { salesFlows: ['REFUND_FULL'] };
    expect(scenarioWarnings(sc, fw)).toEqual(['partialRefundByLeg']);
  });

  test('returns empty array on SALE scenarios regardless of accidental field presence', () => {
    const sc = { scenarioType: 'SALE', partialRefundByLeg: 'on' };
    const fw = { salesFlows: ['SALE'] };
    expect(scenarioWarnings(sc, fw)).toEqual([]);
  });

  test('missing framework treated as nothing declared', () => {
    const sc = { scenarioType: 'REFUND', partialRefundByLeg: 'on' };
    expect(scenarioWarnings(sc, null)).toEqual(['partialRefundByLeg']);
    expect(scenarioWarnings(sc, {})).toEqual(['partialRefundByLeg']);
  });
});

describe('deriveSalesFlowsAdditions', () => {
  test('returns REFUND_PARTIAL when at least one scenario arms it and framework lacks it', () => {
    const scs = [
      { scenarioType: 'REFUND', partialRefundByPax: 'on' },
      { scenarioType: 'SALE' },
    ];
    const fw = { salesFlows: ['SALE', 'REFUND_FULL'] };
    expect(deriveSalesFlowsAdditions(scs, fw)).toEqual(['REFUND_PARTIAL']);
  });

  test('returns empty when framework already declares the flow', () => {
    const scs = [{ scenarioType: 'REFUND', partialRefundByPax: 'on' }];
    const fw = { salesFlows: ['REFUND_PARTIAL'] };
    expect(deriveSalesFlowsAdditions(scs, fw)).toEqual([]);
  });

  test('returns empty when no scenarios arm any rule', () => {
    const scs = [
      { scenarioType: 'REFUND', partialRefundByLeg: 'off' },
      { scenarioType: 'SALE' },
    ];
    const fw = { salesFlows: ['SALE'] };
    expect(deriveSalesFlowsAdditions(scs, fw)).toEqual([]);
  });

  test('dedupes additions across multiple scenarios', () => {
    const scs = [
      { scenarioType: 'REFUND', partialRefundByLeg: 'on' },
      { scenarioType: 'REFUND', partialRefundByPax: 'on' },
    ];
    const fw = { salesFlows: [] };
    // Both fields map to the same flow → single entry in additions.
    expect(deriveSalesFlowsAdditions(scs, fw)).toEqual(['REFUND_PARTIAL']);
  });

  test('null / empty scenarios array is safe', () => {
    expect(deriveSalesFlowsAdditions(null, { salesFlows: [] })).toEqual([]);
    expect(deriveSalesFlowsAdditions([], { salesFlows: [] })).toEqual([]);
  });
});

describe('applyFrameworkMigration', () => {
  test('adds derived flows and stamps the framework', () => {
    const fw = { salesFlows: ['REFUND_FULL'] };
    const scs = [{ scenarioType: 'REFUND', partialRefundByLeg: 'on' }];
    const { migrated, additions } = applyFrameworkMigration(fw, scs, '2026-06-08T18:00:00Z');
    expect(migrated).toBe(true);
    expect(additions).toEqual(['REFUND_PARTIAL']);
    expect(fw.salesFlows).toEqual(['REFUND_FULL', 'REFUND_PARTIAL']);
    expect(fw._salesFlowsMigratedAt).toBe('2026-06-08T18:00:00Z');
  });

  test('is idempotent — second call is a no-op', () => {
    const fw = { salesFlows: ['REFUND_FULL'], _salesFlowsMigratedAt: '2026-06-01T00:00:00Z' };
    const scs = [{ scenarioType: 'REFUND', partialRefundByLeg: 'on' }];
    const r = applyFrameworkMigration(fw, scs, '2026-06-08T18:00:00Z');
    expect(r.migrated).toBe(false);
    expect(r.additions).toEqual([]);
    expect(fw.salesFlows).toEqual(['REFUND_FULL']);
    expect(fw._salesFlowsMigratedAt).toBe('2026-06-01T00:00:00Z'); // unchanged
  });

  test('stamps even when there are no additions (avoids re-scanning every GET)', () => {
    const fw = { salesFlows: ['REFUND_FULL', 'REFUND_PARTIAL'] };
    const scs = [{ scenarioType: 'REFUND', partialRefundByLeg: 'on' }];
    const r = applyFrameworkMigration(fw, scs, '2026-06-08T18:00:00Z');
    expect(r.migrated).toBe(true);
    expect(r.additions).toEqual([]);
    expect(fw._salesFlowsMigratedAt).toBe('2026-06-08T18:00:00Z');
  });

  test('initialises salesFlows when absent', () => {
    const fw = {};
    const scs = [{ scenarioType: 'REFUND', partialRefundByPax: 'on' }];
    applyFrameworkMigration(fw, scs, '2026-06-08T18:00:00Z');
    expect(fw.salesFlows).toEqual(['REFUND_PARTIAL']);
  });

  test('null framework is safe and returns no-op', () => {
    const r = applyFrameworkMigration(null, [], '2026-06-08T18:00:00Z');
    expect(r).toEqual({ migrated: false, additions: [] });
  });
});

describe('annotateDatafile', () => {
  test('adds __featureNotDeclaredWarnings to each non-conformant scenario', () => {
    const df = {
      scenarios: [
        { code: 'A', scenarioType: 'REFUND', partialRefundByLeg: 'on' },
        { code: 'B', scenarioType: 'REFUND', partialRefundByPax: 'on' },
        { code: 'C', scenarioType: 'SALE' }, // unrelated
        { code: 'D', scenarioType: 'REFUND', partialRefundByLeg: 'off' }, // conformant
      ],
    };
    const fw = { salesFlows: ['SALE', 'REFUND_FULL'] };
    const r = annotateDatafile(df, fw);
    expect(r.annotatedCount).toBe(2);
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['partialRefundByLeg']);
    expect(df.scenarios[1].__featureNotDeclaredWarnings).toEqual(['partialRefundByPax']);
    expect(df.scenarios[2].__featureNotDeclaredWarnings).toBeUndefined();
    expect(df.scenarios[3].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('removes stale annotations when framework now declares the feature', () => {
    const df = {
      scenarios: [
        { code: 'A', scenarioType: 'REFUND', partialRefundByLeg: 'on',
          __featureNotDeclaredWarnings: ['partialRefundByLeg'] }, // stale
      ],
    };
    const fw = { salesFlows: ['REFUND_PARTIAL'] };
    annotateDatafile(df, fw);
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('no scenarios array → no-op', () => {
    const df = { something: 'else' };
    const r = annotateDatafile(df, { salesFlows: [] });
    expect(r.annotatedCount).toBe(0);
  });

  test('null inputs are safe', () => {
    expect(annotateDatafile(null, {}).annotatedCount).toBe(0);
    expect(annotateDatafile({ scenarios: [] }, null).annotatedCount).toBe(0);
  });
});

describe('integration: migration + annotation', () => {
  test('after migration runs, annotation finds nothing to warn about', () => {
    const fw = { salesFlows: ['REFUND_FULL'] };
    const df = {
      scenarios: [
        { code: 'A', scenarioType: 'REFUND', partialRefundByLeg: 'on' },
        { code: 'B', scenarioType: 'REFUND', partialRefundByPax: 'on' },
      ],
    };
    // Pre-migration: 2 warnings (the symptom that prompted this PR).
    expect(annotateDatafile(df, fw).annotatedCount).toBe(2);
    // Apply lazy migration.
    applyFrameworkMigration(fw, df.scenarios, '2026-06-08T18:00:00Z');
    expect(fw.salesFlows).toContain('REFUND_PARTIAL');
    // Re-annotate; the previously-warned scenarios are now conformant.
    expect(annotateDatafile(df, fw).annotatedCount).toBe(0);
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toBeUndefined();
    expect(df.scenarios[1].__featureNotDeclaredWarnings).toBeUndefined();
  });
});
