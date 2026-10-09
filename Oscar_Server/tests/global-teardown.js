// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * global-teardown.js — runs once, in Jest's own process, after every test file.
 *
 * Removes the test databases of this run (#583). By now the worker processes
 * have ended and closed them, which is what makes the removal possible on
 * Windows. With --runInBand, and when a single test file is run, the tests
 * ran in this very process and the database is still open: on Windows it then
 * stays until the next run's sweep (tests/global-setup.js).
 */

const os = require('node:os');
const { isTestDbOfRun, removeTempEntries } = require('./helpers/temp-files');

module.exports = async function globalTeardown() {
  const runId = process.env.OSCAR_TEST_RUN;
  if (!runId) return;
  removeTempEntries({ dir: os.tmpdir(), matches: (name) => isTestDbOfRun(name, runId) });
};
