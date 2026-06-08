// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-externalrefformat.test.js — unit tests for the printf-style
 * passenger externalRef format helper exported by
 * `Bruno_Collection/library-bruno/scenarioParser.js`.
 *
 * The same parser is duplicated in `Oscar_Server/public/js/scenarios.js`
 * (previewExternalRef) for the wizard's live preview. This test anchors the
 * canonical behaviour against the runtime side — if you change the regex or
 * padding semantics here, change the wizard preview to match.
 *
 * scenarioParser.js depends on Bruno-runtime globals (`bru`, validationLogger)
 * for its other exports; we only require `applyExternalRefFormat`, which is
 * pure, so we provide the minimal stubs the module needs at require-time.
 */

global.bru = {
  getEnvVar:    () => undefined,
  setEnvVar:    () => {},
  deleteEnvVar: () => {},
};

jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: () => {},
}));

const { applyExternalRefFormat } = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');

describe('applyExternalRefFormat — passenger externalRef NHF probe', () => {
  describe('zero-padded width — the documented happy paths', () => {
    test('PAX%04d expands to PAX0001, PAX0002, PAX0042', () => {
      expect(applyExternalRefFormat('PAX%04d', 1)).toBe('PAX0001');
      expect(applyExternalRefFormat('PAX%04d', 2)).toBe('PAX0002');
      expect(applyExternalRefFormat('PAX%04d', 42)).toBe('PAX0042');
    });

    test('%05d (no prefix) reproduces the wizard default shape', () => {
      expect(applyExternalRefFormat('%05d', 1)).toBe('00001');
      expect(applyExternalRefFormat('%05d', 17)).toBe('00017');
    });

    test('ABC-%03d-XYZ keeps a literal suffix', () => {
      expect(applyExternalRefFormat('ABC-%03d-XYZ', 7)).toBe('ABC-007-XYZ');
      expect(applyExternalRefFormat('ABC-%03d-XYZ', 999)).toBe('ABC-999-XYZ');
    });
  });

  describe('width edge cases', () => {
    test('%d (no width) prints the bare integer with no padding', () => {
      expect(applyExternalRefFormat('%d', 1)).toBe('1');
      expect(applyExternalRefFormat('PAX%d', 5)).toBe('PAX5');
    });

    test('%2d (no leading zero) still pads with zero — there is no space-pad mode for externalRef', () => {
      expect(applyExternalRefFormat('%2d', 1)).toBe('01');
      expect(applyExternalRefFormat('%2d', 12)).toBe('12');
    });

    test('width smaller than the integer width does not truncate', () => {
      expect(applyExternalRefFormat('%03d', 12345)).toBe('12345');
    });

    test('width of 0 is the same as no padding', () => {
      expect(applyExternalRefFormat('%0d', 5)).toBe('5');
    });
  });

  describe('graceful degradation', () => {
    test('empty pattern returns the index as a string', () => {
      expect(applyExternalRefFormat('', 1)).toBe('1');
      expect(applyExternalRefFormat('', 99)).toBe('99');
    });

    test('null / undefined pattern returns the index as a string', () => {
      expect(applyExternalRefFormat(null, 3)).toBe('3');
      expect(applyExternalRefFormat(undefined, 3)).toBe('3');
    });

    test('pattern without %d / %0Nd returns the pattern unchanged', () => {
      // The caller should validate up-front and skip the rewrite; we silent-
      // degrade rather than throw so the run survives a malformed probe value.
      expect(applyExternalRefFormat('PAX', 1)).toBe('PAX');
      expect(applyExternalRefFormat('00001', 1)).toBe('00001');
    });

    test('only the first %d / %0Nd is substituted — extras are left untouched', () => {
      expect(applyExternalRefFormat('PAX%04d-EXT%d', 7)).toBe('PAX0007-EXT%d');
    });
  });

  describe('parity with the wizard preview', () => {
    // Wizard inlines its own copy of the parser to avoid a server round-trip
    // per keystroke. Both must agree on identical patterns/indices — if this
    // test passes here but the wizard renders something different, the
    // duplicate is out of sync.
    const pairs = [
      ['PAX%04d',     1, 'PAX0001'],
      ['PAX%04d',     5, 'PAX0005'],
      ['%05d',        1, '00001'],
      ['ABC-%03d',   42, 'ABC-042'],
      ['%d',          9, '9'],
    ];
    test.each(pairs)('pattern=%s n=%i -> %s', (pattern, n, expected) => {
      expect(applyExternalRefFormat(pattern, n)).toBe(expected);
    });
  });
});
