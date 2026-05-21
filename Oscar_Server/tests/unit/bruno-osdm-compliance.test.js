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

const {
  isType,
  isDateTime,
  validateApiVersions,
  validateOsdmCollection,
  validateOsdmResource,
  validateReductionCards,
  validateZones,
  validatePromotionCodes,
  validatePassengerCategories,
  validateProductTags,
  validateProducts,
  validateProduct,
  validateCoachLayouts,
  validateCoachDeckLayouts,
  validateCoachLayout,
  validateCoachDeckLayout,
} = require('../../../Bruno_Collection/library-bruno/osdmCompliance.js');

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

describe('osdmCompliance.validateOsdmCollection (generic engine)', () => {
  const spec = {
    endpoint: '/things', payloadKey: 'things', itemLabel: 'Thing',
    required: { id: 'string' }, optional: { n: 'number' },
  };
  const allOk = (c) => c.every((x) => x.ok);
  const find = (c, s) => c.find((x) => x.name.includes(s));

  test('valid envelope passes every rule', () => {
    expect(allOk(validateOsdmCollection({ things: [{ id: 'a' }, { id: 'b', n: 1 }] }, spec))).toBe(true);
  });

  test('non-object body fails the envelope rule and short-circuits', () => {
    const c = validateOsdmCollection([1, 2], spec);
    expect(find(c, 'collection object').ok).toBe(false);
    expect(c).toHaveLength(1);
  });

  test('missing payload array fails and short-circuits', () => {
    const c = validateOsdmCollection({ other: [] }, spec);
    expect(find(c, 'is an array').ok).toBe(false);
    expect(c).toHaveLength(2); // envelope-ok + payload-array-fail
  });

  test('missing required field is named by index', () => {
    const c = validateOsdmCollection({ things: [{ id: 'a' }, { x: 1 }] }, spec);
    expect(find(c, 'required "id"').ok).toBe(false);
    expect(find(c, 'required "id"').message).toMatch(/index 1/);
  });

  test('wrong-typed optional field is rejected', () => {
    const c = validateOsdmCollection({ things: [{ id: 'a', n: 'no' }] }, spec);
    expect(find(c, '"n" (when present)').ok).toBe(false);
  });

  test('"problems" must be an array when present', () => {
    const c = validateOsdmCollection({ things: [{ id: 'a' }], problems: {} }, spec);
    expect(find(c, '"problems"').ok).toBe(false);
  });

  test('empty collection fails the "at least one" rule', () => {
    expect(find(validateOsdmCollection({ things: [] }, spec), 'at least one').ok).toBe(false);
  });

  test('enum membership enforced when present', () => {
    const espec = Object.assign({}, spec, { enums: { kind: ['A', 'B'] } });
    const c = validateOsdmCollection({ things: [{ id: 'a', kind: 'Z' }] }, espec);
    expect(find(c, '"kind"').ok).toBe(false);
  });
});

describe('osdmCompliance per-endpoint wrappers', () => {
  const allOk = (c) => c.every((x) => x.ok);
  const find = (c, s) => c.find((x) => x.name.includes(s));

  test('validateReductionCards: valid passes; missing issuer fails', () => {
    expect(allOk(validateReductionCards({
      reductionCardTypes: [{ code: 'BC', issuer: 'urn:uic:rics:0080:000001', name: { id: 't', text: 'BahnCard' } }],
    }))).toBe(true);
    const c = validateReductionCards({ reductionCardTypes: [{ code: 'BC', name: { id: 't', text: 'x' } }] });
    expect(find(c, 'required "issuer"').ok).toBe(false);
  });

  test('validateZones: requires id + carrier', () => {
    expect(allOk(validateZones({ zones: [{ id: 'z1', carrier: 'urn:uic:rics:1185:000011' }] }))).toBe(true);
    expect(find(validateZones({ zones: [{ carrier: 'urn:x' }] }), 'required "id"').ok).toBe(false);
  });

  test('validatePromotionCodes: requires code', () => {
    expect(allOk(validatePromotionCodes({ promotionCodes: [{ code: 'SUMMER' }] }))).toBe(true);
    expect(find(validatePromotionCodes({ promotionCodes: [{}] }), 'required "code"').ok).toBe(false);
  });

  test('validatePassengerCategories: bare array; requires title + specification', () => {
    expect(allOk(validatePassengerCategories([
      { title: { id: 't', text: 'Adult' }, specification: {} },
    ]))).toBe(true);
    const c = validatePassengerCategories({ not: 'an array' });
    expect(find(c, 'is an array').ok).toBe(false);
    expect(c).toHaveLength(1);
  });

  test('validateProductTags: dual arrays + item required fields', () => {
    expect(allOk(validateProductTags({
      productTagNames: [{ tag: 'SPLIT_RESERVATION', description: { id: 'd', text: 'x' } }],
      productTagGroups: [{ code: 'G1', description: { id: 'd', text: 'x' } }],
    }))).toBe(true);
    expect(find(validateProductTags({ productTagGroups: [] }), '"productTagNames"').ok).toBe(false);
    expect(find(validateProductTags({
      productTagNames: [{ description: {} }], productTagGroups: [],
    }), 'required "tag"').ok).toBe(false);
  });
});

describe('osdmCompliance Products (collection + single resource)', () => {
  const allOk = (c) => c.every((x) => x.ok);
  const find = (c, s) => c.find((x) => x.name.includes(s));
  const product = { id: 'p1', code: 'PASS', owner: 'urn:uic:rics:1185:000011', flexibility: 'FULL_FLEXIBLE' };

  test('validateProducts: valid collection passes', () => {
    expect(allOk(validateProducts({ products: [product] }))).toBe(true);
  });

  test('validateProducts: missing required flexibility fails and names index', () => {
    const c = validateProducts({ products: [product, { id: 'p2', code: 'X', owner: 'urn:x' }] });
    expect(find(c, 'required "flexibility"').ok).toBe(false);
    expect(find(c, 'required "flexibility"').message).toMatch(/index 1/);
  });

  test('validateProducts: extensible-enum "type" is type-checked only (unknown value OK)', () => {
    expect(allOk(validateProducts({ products: [Object.assign({}, product, { type: 'SOME_FUTURE_TYPE' })] }))).toBe(true);
    expect(find(validateProducts({ products: [Object.assign({}, product, { type: 123 })] }), '"type"').ok).toBe(false);
  });

  test('validateProduct: valid ProductResponse passes', () => {
    expect(allOk(validateProduct({ product }))).toBe(true);
  });

  test('validateProduct: missing "product" wrapper fails', () => {
    const c = validateProduct({ warnings: {}, problems: [] });
    expect(find(c, '"product" is a Product object').ok).toBe(false);
  });

  test('validateProduct: product missing required code fails', () => {
    const c = validateProduct({ product: { id: 'p1', owner: {}, flexibility: 'NON_FLEXIBLE' } });
    expect(find(c, 'required "code"').ok).toBe(false);
  });

  test('validateProduct: non-object body short-circuits', () => {
    const c = validateProduct(null);
    expect(find(c, 'resource object').ok).toBe(false);
    expect(c).toHaveLength(1);
  });
});

describe('osdmCompliance Coach layouts (layouts vs deck variants)', () => {
  const allOk = (c) => c.every((x) => x.ok);
  const find = (c, s) => c.find((x) => x.name.includes(s));

  test('validateCoachLayouts: valid CoachLayoutCollectionResponse passes', () => {
    expect(allOk(validateCoachLayouts({ layouts: [{ id: 'L1', gridSize: { x: 10, y: 5 } }] }))).toBe(true);
  });

  test('validateCoachLayouts: missing gridSize fails', () => {
    const c = validateCoachLayouts({ layouts: [{ id: 'L1' }] });
    expect(find(c, 'required "gridSize"').ok).toBe(false);
  });

  test('validateCoachDeckLayouts: valid CoachDeckLayoutCollectionResponse passes', () => {
    expect(allOk(validateCoachDeckLayouts({
      coachDeckLayouts: [{ id: 'D1', name: 'Deck 1', dimension: { width: 4, height: 20 }, deckLevel: 'UPPER_DECK' }],
    }))).toBe(true);
  });

  test('validateCoachDeckLayouts: payload key is "coachDeckLayouts", not "layouts"', () => {
    const c = validateCoachDeckLayouts({ layouts: [{ id: 'D1', name: 'x', dimension: {}, deckLevel: 'UPPER_DECK' }] });
    expect(find(c, '"coachDeckLayouts" is an array').ok).toBe(false);
  });

  test('validateCoachDeckLayouts: missing required name fails (deckLevel type-checked as string)', () => {
    const c = validateCoachDeckLayouts({
      coachDeckLayouts: [{ id: 'D1', dimension: { width: 1, height: 1 }, deckLevel: 'LOWER_DECK' }],
    });
    expect(find(c, 'required "name"').ok).toBe(false);
  });

  test('validateCoachLayout: single resource under "coachLayout"', () => {
    expect(allOk(validateCoachLayout({ coachLayout: { id: 'L1', gridSize: { x: 1, y: 1 } } }))).toBe(true);
    expect(find(validateCoachLayout({ warnings: {} }), '"coachLayout" is a CoachLayout object').ok).toBe(false);
  });

  test('validateCoachDeckLayout: single resource under "coachDeckLayout"', () => {
    expect(allOk(validateCoachDeckLayout({
      coachDeckLayout: { id: 'D1', name: 'Deck', dimension: { width: 1, height: 1 }, deckLevel: 'SINGLE_DECK' },
    }))).toBe(true);
  });

  test('coach validators reflect the passed endpoint in check names', () => {
    const c = validateCoachDeckLayouts({ coachDeckLayouts: [] }, '/coach-deck-layouts');
    expect(c.some((x) => x.name.includes('/coach-deck-layouts'))).toBe(true);
  });
});
