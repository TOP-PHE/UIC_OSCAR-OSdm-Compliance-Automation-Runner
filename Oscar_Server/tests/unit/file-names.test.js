// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * file-names.test.js — a download's file name starts with the company or
 * provider it is about (#1002).
 */

const { fileNamePrefix, fileNameFor, MAX_PREFIX } = require('../../src/utils/fileNames');
const { SAMPLES } = require('../helpers/file-name-samples');

describe('the start of a file name', () => {
  test.each(SAMPLES)('%p gives %p', (name, prefix) => {
    expect(fileNamePrefix(name)).toBe(prefix);
  });

  test('60 characters at most, never ending with a dash', () => {
    const cut = fileNamePrefix(`${'a'.repeat(59)} b`);
    expect(cut).toBe('a'.repeat(59));
    expect(fileNamePrefix('x'.repeat(200))).toHaveLength(MAX_PREFIX);
  });

  test('always safe in a Content-Disposition header', () => {
    for (const [name] of SAMPLES) expect(fileNamePrefix(name)).toMatch(/^[A-Za-z0-9-]*$/);
  });

  test('a name with nothing left keeps the file name as it was', () => {
    expect(fileNameFor('Provider A', 'oscar-coverage-2026-10-27.xlsx')).toBe('Provider-A-oscar-coverage-2026-10-27.xlsx');
    expect(fileNameFor('日本', 'oscar-coverage-report-3.xlsx')).toBe('oscar-coverage-report-3.xlsx');
    expect(fileNameFor(null, 'x.md')).toBe('x.md');
  });

  test('linear on a long name', () => {
    const started = Date.now();
    fileNamePrefix('-é'.repeat(200000));
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

