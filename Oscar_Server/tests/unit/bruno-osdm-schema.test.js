'use strict';

/**
 * bruno-osdm-schema.test.js — Layer-2 deep, version-matched schema validation
 * (Bruno_Collection/library-bruno/osdmSchema.js + the generated osdmSchemas.js).
 *
 * Pure JS; getComplianceVersion() reads `bru`, mocked here before require
 * (harness pattern). #105 Stage 3.
 */

let store = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
  setEnvVar: (k, v) => { store[k] = v; },
};

const { schemas } = require('../../../Bruno_Collection/library-bruno/osdmSchemas.js');
const {
  pickSchemaVersion,
  collectIssues,
  validateItemSchema,
  validateSchema,
} = require('../../../Bruno_Collection/library-bruno/osdmSchema.js');

const VERSIONS = Object.keys(schemas);

beforeEach(() => { store = {}; });

describe('osdmSchemas bundle', () => {
  test('has all 5 versions and the expected per-version components', () => {
    expect(VERSIONS).toEqual(['3.4.0', '3.5.0', '3.6.0', '3.7.0', '3.8.0']);
    expect(schemas['3.8.0'].Product).toBeDefined();
    expect(schemas['3.4.0'].PassengerCategory).toBeUndefined(); // introduced 3.6
    expect(schemas['3.8.0'].PassengerCategory).toBeDefined();
    expect(schemas['3.4.0'].PromotionCode).toBeUndefined(); // introduced 3.8
  });

  test('depth-2 nesting captured (Product.serviceClass.{type,name})', () => {
    const sc = schemas['3.8.0'].Product.properties.serviceClass;
    expect(sc.type).toBe('object');
    expect(sc.required).toEqual(expect.arrayContaining(['type', 'name']));
  });
});

describe('pickSchemaVersion (nearest-known fallback)', () => {
  test('exact / above-max / between / below-min', () => {
    expect(pickSchemaVersion('3.6.0', VERSIONS)).toBe('3.6.0');
    expect(pickSchemaVersion('3.9.0', VERSIONS)).toBe('3.8.0'); // above max → highest available
    expect(pickSchemaVersion('3.6.5', VERSIONS)).toBe('3.6.0'); // between → highest <=
    expect(pickSchemaVersion('3.2.0', VERSIONS)).toBe('3.4.0'); // below min → lowest available
  });
});

describe('collectIssues (recursive)', () => {
  const spec = {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string' },
      n: { type: 'number' },
      inner: { type: 'object', required: ['x'], properties: { x: { type: 'string' } } },
      list: { type: 'array', items: { type: 'string' } },
    },
  };

  test('clean object → no issues', () => {
    const issues = [];
    collectIssues({ id: 'a', n: 1, inner: { x: 'y' }, list: ['p'] }, spec, 'R', issues);
    expect(issues).toEqual([]);
  });

  test('missing top required + wrong type + nested missing + bad array item', () => {
    const issues = [];
    collectIssues({ n: 'no', inner: {}, list: [1] }, spec, 'R', issues);
    const joined = issues.join('\n');
    expect(joined).toMatch(/R\.id: required property missing/);
    expect(joined).toMatch(/R\.n: expected number/);
    expect(joined).toMatch(/R\.inner\.x: required property missing/);
    expect(joined).toMatch(/R\.list\[0\]: expected string/);
  });
});

describe('validateItemSchema / validateSchema (version-matched)', () => {
  const product = { id: 'p1', code: 'PASS', owner: 'urn:uic:rics:1185:000011', flexibility: 'FULL_FLEXIBLE' };

  test('valid Product passes against 3.8', () => {
    const r = validateItemSchema('Product', product, '3.8.0');
    expect(r.hasSchema).toBe(true);
    expect(r.version).toBe('3.8.0');
    expect(r.issues).toEqual([]);
  });

  test('Layer-2 catches nested serviceClass.name missing (Layer-1 would not)', () => {
    const r = validateItemSchema('Product', Object.assign({}, product, { serviceClass: { type: 'STANDARD' } }), '3.8.0');
    expect(r.issues.join('\n')).toMatch(/serviceClass\.name: required property missing/);
  });

  test('validateSchema aggregates, names the matched version, uses getComplianceVersion', () => {
    store.osdmVersion = '3.8';
    const checks = validateSchema('Product', [product], { endpoint: '/products' });
    expect(checks).toHaveLength(1);
    expect(checks[0].ok).toBe(true);
    expect(checks[0].name).toMatch(/OSDM 3\.8\.0 Product schema/);
  });

  test('validateSchema fails with a capped issue list', () => {
    const checks = validateSchema('Product', [{ id: 5 }], { version: '3.8.0', endpoint: '/products' });
    expect(checks[0].ok).toBe(false);
    expect(checks[0].message).toMatch(/schema issue/);
  });

  test('component not present in the matched version → skipped (ok)', () => {
    const checks = validateSchema('PassengerCategory', [{}], { version: '3.4.0', endpoint: '/passenger-categories' });
    expect(checks[0].ok).toBe(true);
    expect(checks[0].name).toMatch(/no bundled schema/);
  });
});
