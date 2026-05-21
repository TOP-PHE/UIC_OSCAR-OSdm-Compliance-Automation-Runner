'use strict';

/**
 * bruno-osdm-compliance.test.js — Layer-1 OSDM response-compliance helpers
 * (Bruno_Collection/library-bruno/osdmCompliance.js).
 *
 * These helpers are pure (no `bru`, no `expect`, no network), so they unit-test
 * cleanly and pull only themselves into coverage — they cannot endanger the CI
 * global coverage gate. Added for the OSDM compliance-assertion initiative,
 * increment 1: GET /versions → array<ApiVersion>.
 */

const { isType, isDateTime, validateApiVersions } =
  require('../../../Bruno_Collection/library-bruno/osdmCompliance.js');

describe('osdmCompliance.isType', () => {
  test('classifies primitives the JSON-Schema way', () => {
    expect(isType('x', 'string')).toBe(true);
    expect(isType(1, 'number')).toBe(true);
    expect(isType(NaN, 'number')).toBe(false);
    expect(isType(2, 'integer')).toBe(true);
    expect(isType(1.5, 'integer')).toBe(false);
    expect(isType(true, 'boolean')).toBe(true);
    expect(isType([], 'array')).toBe(true);
    expect(isType({}, 'object')).toBe(true);
    expect(isType([], 'object')).toBe(false);
    expect(isType(null, 'object')).toBe(false);
    expect(isType(null, 'null')).toBe(true);
    expect(isType('x', 'bogus')).toBe(false);
  });
});

describe('osdmCompliance.isDateTime', () => {
  test('accepts RFC 3339 date-times', () => {
    expect(isDateTime('2026-05-21T00:00:00Z')).toBe(true);
    expect(isDateTime('2026-12-31T23:59:59+02:00')).toBe(true);
  });
  test('rejects non-date-time values', () => {
    expect(isDateTime('soon')).toBe(false);
    expect(isDateTime('')).toBe(false);
    expect(isDateTime('   ')).toBe(false);
    expect(isDateTime('12345')).toBe(false);
    expect(isDateTime(123)).toBe(false);
    expect(isDateTime(null)).toBe(false);
  });
});

describe('osdmCompliance.validateApiVersions', () => {
  const allOk = (checks) => checks.every((c) => c.ok);
  const find = (checks, sub) => checks.find((c) => c.name.includes(sub));

  test('valid array<ApiVersion> passes every rule', () => {
    const checks = validateApiVersions([
      { version: '3.8.0' },
      { version: '3.5.0', sunset: '2027-01-01T00:00:00Z', nextVersion: { version: '3.8.0' } },
    ]);
    expect(allOk(checks)).toBe(true);
  });

  test('non-array body fails the array rule and short-circuits', () => {
    const checks = validateApiVersions({ version: '3.8.0' });
    expect(find(checks, 'is an array').ok).toBe(false);
    expect(checks).toHaveLength(1);
  });

  test('null body is reported as null in the message', () => {
    const checks = validateApiVersions(null);
    expect(find(checks, 'is an array').ok).toBe(false);
    expect(find(checks, 'is an array').message).toMatch(/null/);
  });

  test('empty array fails the "at least one" rule', () => {
    const checks = validateApiVersions([]);
    expect(find(checks, 'at least one').ok).toBe(false);
  });

  test('entry missing version fails required-version rule and names the index', () => {
    const checks = validateApiVersions([{ version: '3.8.0' }, { foo: 1 }]);
    const c = find(checks, 'required "version"');
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/index 1/);
  });

  test('empty/whitespace-only version is rejected', () => {
    const checks = validateApiVersions([{ version: '   ' }]);
    expect(find(checks, 'required "version"').ok).toBe(false);
  });

  test('non-date-time sunset is rejected and names the index', () => {
    const checks = validateApiVersions([{ version: '3.8.0', sunset: 'soon' }]);
    const c = find(checks, '"sunset"');
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/index 0/);
  });

  test('null sunset / nextVersion are tolerated (optional fields)', () => {
    const checks = validateApiVersions([{ version: '3.8.0', sunset: null, nextVersion: null }]);
    expect(allOk(checks)).toBe(true);
  });

  test('non-object nextVersion is rejected', () => {
    const checks = validateApiVersions([{ version: '3.8.0', nextVersion: 'x' }]);
    expect(find(checks, '"nextVersion"').ok).toBe(false);
  });
});
