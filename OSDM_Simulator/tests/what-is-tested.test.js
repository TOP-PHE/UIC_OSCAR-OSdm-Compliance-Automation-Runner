// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #640: the reference scenarios listed in "OSCAR - What is tested" are those
// of the scenario catalogue, with the same source and number of checks.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const catalogue = require(path.join(root, 'Bruno_Collection', 'data_base', 'scenario_catalogue.json'));
const text = fs.readFileSync(path.join(root, 'Documentation', 'Test_Coverage', 'OSCAR - What is tested.md'), 'utf8');

// The rows of section 4.2: | `CODE` | scope | needs | checks | `SOURCE` |
const ROW = /^\| `((?:OTST|NHF)_[A-Z0-9_]+)` \|[^|\n]*\|[^|\n]*\| (\d+) \| `(SIM_[A-Z0-9_]+)` \|$/gm;
const rows = new Map([...text.matchAll(ROW)].map((m) => [m[1], { checks: Number(m[2]), source: m[3] }]));

test('every reference scenario of the catalogue has its row, with its source and checks', () => {
  for (const entry of catalogue.entries) {
    assert.ok(rows.has(entry.code), `${entry.code} has no row`);
    assert.deepEqual(rows.get(entry.code), { checks: entry.checks, source: entry.source }, entry.code);
  }
});

test('the document lists no reference scenario the catalogue does not have', () => {
  const codes = new Set(catalogue.entries.map((e) => e.code));
  assert.deepEqual([...rows.keys()].filter((code) => !codes.has(code)), []);
  assert.equal(rows.size, catalogue.entries.length);
});
