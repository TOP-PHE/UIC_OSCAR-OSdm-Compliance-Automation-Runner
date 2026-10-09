// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * global-setup.js — runs once, in Jest's own process, before any test file.
 *
 * It names the run, so that the databases of this run can be told from those
 * of another run going on at the same time (another checkout, another
 * session), and it sweeps what earlier runs left in the temporary folder
 * (#583). The name reaches the test files through the environment: Jest
 * starts its worker processes after this.
 */

const crypto = require('node:crypto');
const os = require('node:os');
const { isTestLeftover, removeTempEntries } = require('./helpers/temp-files');

// Old enough that no run still going on can own it.
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

module.exports = async function globalSetup() {
  process.env.OSCAR_TEST_RUN = crypto.randomBytes(4).toString('hex');
  removeTempEntries({ dir: os.tmpdir(), matches: isTestLeftover, olderThanMs: STALE_AFTER_MS });
};
