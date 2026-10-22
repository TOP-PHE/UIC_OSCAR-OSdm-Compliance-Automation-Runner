// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * version-copies.js — appends to the simulator's data file the `_36`, `_37`
 * and `_39` copies of its `_38` scenarios that are missing (#914):
 *
 *   node scripts/version-copies.js
 *
 * Run it after adding a scenario for gamma; `tests/datafile.test.js` fails
 * until the copies are there. The file's text is appended to, never
 * re-dumped (its layout is hand-kept). Then regenerate the reference
 * configurations (Oscar_Server/scripts/generate-reference-configurations.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { missingCopies, appendScenarios } = require('./version-copies-lib');

const DATA_FILE = path.join(__dirname, '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json');

if (require.main === module) {
  const text = fs.readFileSync(DATA_FILE, 'utf8');
  const copies = missingCopies(JSON.parse(text));
  const next = appendScenarios(text, copies);
  JSON.parse(next);
  fs.writeFileSync(DATA_FILE, next);
  process.stdout.write(`${copies.length} scenario(s) added.\n`);
}
