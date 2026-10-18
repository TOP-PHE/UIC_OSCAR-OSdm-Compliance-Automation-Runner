#!/usr/bin/env node
/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * Generates Oscar_Server/src/utils/simulator-checks.json (#735, part 3): how
 * each check fared on the simulator, read from a replay recording, so that a
 * suggested finding can say whether the same check passes there.
 *
 *   cd OSDM_Simulator && node scripts/replay.js record after
 *   cd ../Oscar_Server && node scripts/generate-simulator-checks.js
 *
 * Reads OSDM_Simulator/replay/after.json (and after.about.json); both paths
 * are fixed. A check is keyed as findingSuggestions keys a failure: the step
 * as the known-deviation engine reads it, and the check text with the run's
 * values left out. The SIM_WRONG_* and SIM_FAULT_* (#833) scenarios fail on
 * purpose and are left out.
 */

const fs = require('node:fs');
const path = require('node:path');
const { hintKey } = require('../src/utils/findingSuggestions');

const failsOnPurpose = (code) => code.startsWith('SIM_WRONG_') || code.startsWith('SIM_FAULT_');

const REPO = path.resolve(__dirname, '..', '..');
const RECORDING = path.join(REPO, 'OSDM_Simulator', 'replay', 'after.json');
const ABOUT = path.join(REPO, 'OSDM_Simulator', 'replay', 'after.about.json');
const OUT = path.join(__dirname, '..', 'src', 'utils', 'simulator-checks.json');

/** The table from a recording: { key: [passed, failed] }, keys sorted. */
function tableOf(recording) {
  const counts = new Map();
  for (const [code, record] of Object.entries(recording)) {
    if (failsOnPurpose(code)) continue;
    for (const [step, check, result] of record.list || []) {
      const key = hintKey(step, check);
      const c = counts.get(key) || [0, 0];
      c[result === 'pass' ? 0 : 1]++;
      counts.set(key, c);
    }
  }
  const checks = {};
  for (const key of [...counts.keys()].sort()) checks[key] = counts.get(key);
  return checks;
}

function main() {
  const recording = JSON.parse(fs.readFileSync(RECORDING, 'utf8'));
  const about = fs.existsSync(ABOUT) ? JSON.parse(fs.readFileSync(ABOUT, 'utf8')) : {};
  const checks = tableOf(recording);
  const out = { about: { ...about, scenarios: Object.keys(recording).filter((c) => !failsOnPurpose(c)).length }, checks };
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`${OUT}: ${Object.keys(checks).length} checks from ${out.about.scenarios} scenarios`);
}

if (require.main === module) main();

module.exports = { tableOf };
