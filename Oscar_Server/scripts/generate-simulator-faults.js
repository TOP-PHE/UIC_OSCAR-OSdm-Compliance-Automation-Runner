#!/usr/bin/env node
/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * Generates Oscar_Server/src/utils/simulator-faults.json (#833 PR D): the
 * OSDM simulator's fault catalogue (code, feature, title, detail, expect), so
 * the server can say whether a run detected the faults it asked for. The
 * simulator is not deployed with the server, hence the copy.
 *
 *   cd Oscar_Server && node scripts/generate-simulator-faults.js
 *
 * Regenerate it whenever OSDM_Simulator/src/osdm/faults.js changes: a test
 * fails until the two agree.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const { catalogue } = require(path.join(REPO, 'OSDM_Simulator', 'src', 'osdm', 'faults.js'));
const OUT = path.join(__dirname, '..', 'src', 'utils', 'simulator-faults.json');

fs.writeFileSync(OUT, JSON.stringify(catalogue(), null, 2) + '\n');
process.stdout.write(`Wrote ${catalogue().length} faults to ${path.relative(REPO, OUT)}\n`);
