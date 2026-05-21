'use strict';

/**
 * bruno-osdm-version.test.js — OSDM version resolution (issue #105, Stage 1)
 * (Bruno_Collection/library-bruno/osdmVersion.js).
 *
 * Confirms the two distinct version concepts:
 *   - getComplianceVersion()    → test-framework truth (osdmVersion); IGNORES the
 *                                 system's /versions (apiVersionsAvailable).
 *   - resolveEffectiveVersion() → negotiated version for endpoint selection;
 *                                 DOES use the system's /versions.
 * The module reads a global `bru`, mocked here before require (harness pattern).
 */

let store = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
  setEnvVar: (k, v) => { store[k] = v; },
};

const {
  DEFAULT_OSDM_VERSION,
  parseVersion,
  compareVersions,
  atLeast,
  pickLatestFromList,
  getComplianceVersion,
  resolveEffectiveVersion,
} = require('../../../Bruno_Collection/library-bruno/osdmVersion.js');

beforeEach(() => { store = {}; });

describe('osdmVersion parsing & comparison', () => {
  test('parseVersion: full, partial, decorated, invalid, null', () => {
    expect(parseVersion('3.8.1')).toEqual({ major: 3, minor: 8, patch: 1 });
    expect(parseVersion('3.7')).toEqual({ major: 3, minor: 7, patch: 0 });
    expect(parseVersion(' v3.5.0 ')).toEqual({ major: 3, minor: 5, patch: 0 });
    expect(parseVersion('nope')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  test('compareVersions & atLeast', () => {
    expect(compareVersions('3.8.0', '3.8.0')).toBe(0);
    expect(compareVersions('3.7', '3.8.0')).toBe(-1);
    expect(compareVersions('3.9', '3.8.0')).toBe(1);
    expect(atLeast('3.8', '3.8.0')).toBe(true);
    expect(atLeast('3.7.5', '3.8.0')).toBe(false);
    expect(atLeast('3.9.0', '3.8.0')).toBe(true);
  });

  test('pickLatestFromList', () => {
    expect(pickLatestFromList('3.5, 3.8, 3.7')).toEqual({ major: 3, minor: 8, patch: 0 });
    expect(pickLatestFromList('')).toBeNull();
    expect(pickLatestFromList(null)).toBeNull();
  });
});

describe('getComplianceVersion (test-framework truth)', () => {
  test('uses the data-file osdmVersion, normalised to X.Y.Z', () => {
    store.osdmVersion = '3.7';
    expect(getComplianceVersion()).toBe('3.7.0');
  });

  test('apiVersion override wins when set', () => {
    store.apiVersion = '3.6.0';
    store.osdmVersion = '3.7';
    expect(getComplianceVersion()).toBe('3.6.0');
  });

  test('IGNORES the system /versions (apiVersionsAvailable)', () => {
    store.apiVersionsAvailable = '3.9.0'; // system claims 3.9 …
    // … but neither requestor override nor osdmVersion is set → must NOT adopt
    // the system version; falls back to the default instead.
    expect(getComplianceVersion()).toBe(DEFAULT_OSDM_VERSION);
  });

  test('treats "null"/empty osdmVersion as absent → default', () => {
    store.osdmVersion = 'null';
    expect(getComplianceVersion()).toBe(DEFAULT_OSDM_VERSION);
    store.osdmVersion = '   ';
    expect(getComplianceVersion()).toBe(DEFAULT_OSDM_VERSION);
  });

  test('nothing set → default', () => {
    expect(getComplianceVersion()).toBe(DEFAULT_OSDM_VERSION);
  });
});

describe('resolveEffectiveVersion (endpoint negotiation)', () => {
  test('prefers explicit apiVersion', () => {
    store.apiVersion = '3.6';
    store.apiVersionsAvailable = '3.9';
    store.osdmVersion = '3.4';
    expect(resolveEffectiveVersion()).toEqual({ major: 3, minor: 6, patch: 0 });
  });

  test('uses the system /versions when apiVersion absent', () => {
    store.apiVersionsAvailable = '3.5,3.9,3.8';
    store.osdmVersion = '3.4';
    expect(resolveEffectiveVersion()).toEqual({ major: 3, minor: 9, patch: 0 });
  });

  test('falls back to osdmVersion, then default', () => {
    store.osdmVersion = '3.4';
    expect(resolveEffectiveVersion()).toEqual({ major: 3, minor: 4, patch: 0 });
    store = {};
    expect(resolveEffectiveVersion()).toEqual(parseVersion(DEFAULT_OSDM_VERSION));
  });

  test('coach endpoint rule: >= 3.8 uses deck layouts', () => {
    store.osdmVersion = '3.7';
    expect(atLeast(resolveEffectiveVersion(), '3.8.0')).toBe(false); // → coach-layouts
    store = {};
    store.apiVersionsAvailable = '3.8.0';
    expect(atLeast(resolveEffectiveVersion(), '3.8.0')).toBe(true); // → coach-deck-layouts
  });
});
