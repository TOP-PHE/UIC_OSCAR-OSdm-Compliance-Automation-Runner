#!/usr/bin/env node
/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * Generates Bruno_Collection/data_base/reference/simulator-<provider>.json
 * (#838): the reference configuration of each simulated provider (alpha,
 * beta, gamma, delta), which companies testing the simulator are updated from.
 *
 *   cd Oscar_Server && node scripts/generate-reference-configurations.js
 *
 * Reads the provider's checklist (Documentation/Server_Operations/Simulator
 * checklists/), its profile (OSDM_Simulator/providers/) and the simulator's
 * data file. Regenerate after any of them changes: a test fails until the
 * stored files agree. The paths are fixed.
 */

const fs = require('node:fs');
const path = require('node:path');
const R = require('../src/utils/referenceConfiguration');
const { answersOfDocx } = require('../src/utils/checklistAnswers');
const { checklistFile } = require('../src/utils/checklistFiles');

const REPO = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'Bruno_Collection', 'data_base', 'reference');

function referenceOf(provider) {
  const checklist = checklistFile(path.join(REPO, 'Documentation', 'Server_Operations', 'Simulator checklists'), `Simulator-${provider}`);
  const read = answersOfDocx(fs.readFileSync(checklist));
  if (read.refusal) throw new Error(`${provider}: ${read.refusal}`);
  return R.buildReference({
    provider,
    profile: JSON.parse(fs.readFileSync(path.join(REPO, 'OSDM_Simulator', 'providers', `${provider}.json`), 'utf8')),
    answers: read.answers,
    datafile: JSON.parse(fs.readFileSync(path.join(REPO, 'Bruno_Collection', 'data_base', R.DATAFILE_NAME), 'utf8')),
  });
}

const textOf = (reference) => JSON.stringify(reference, null, 2) + '\n';

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const provider of R.PROVIDERS) {
    const file = path.join(OUT_DIR, `${R.referenceName(provider)}.json`);
    const reference = referenceOf(provider);
    fs.writeFileSync(file, textOf(reference));
    process.stdout.write(`${path.relative(REPO, file)}: ${reference.testResources.length} Test Data entries, ${reference.scenariosToRun.length} scenarios to run\n`);
  }
}

module.exports = { referenceOf, textOf, OUT_DIR };
