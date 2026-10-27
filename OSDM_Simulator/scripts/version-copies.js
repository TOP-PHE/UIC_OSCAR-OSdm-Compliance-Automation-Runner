// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * version-copies.js — brings the `_36`, `_37`, `_39`, `_310` and `_312`
 * copies of the simulator data file's `_38` scenarios up to date (#914, #920,
 * #925), with each provider's copy of the trips naming gamma's carrier (#1022):
 *
 *   node scripts/version-copies.js
 *
 * Run it after adding or changing a scenario or a trip for gamma;
 * `tests/datafile.test.js` fails until the copies are there. Only the copies'
 * entries are written, never the whole file (its layout is hand-kept). Then
 * regenerate the reference configurations
 * (Oscar_Server/scripts/generate-reference-configurations.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { syncedText } = require('./version-copies-lib');

const DATA_FILE = path.join(__dirname, '..', '..', 'Bruno_Collection', 'data_base', 'simulator_datafile.json');

if (require.main === module) {
  const { text, done } = syncedText(fs.readFileSync(DATA_FILE, 'utf8'));
  fs.writeFileSync(DATA_FILE, text);
  process.stdout.write(`Trips: ${done.tripsAdded} added, ${done.tripsChanged} changed, ${done.tripsRemoved} removed. `
    + `Scenarios: ${done.added} added, ${done.changed} changed.\n`);
}
