// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * make-clients.js — write a clients file with random secrets.
 *
 *   node scripts/make-clients.js [local|deploy] [clients-per-provider]
 *
 * `local` (the default) writes `clients.json` next to `server.js`, where the
 * simulator looks for it when run by hand. `deploy` writes
 * `deploy/clients.json`, where the compose file looks for it. There is no
 * other destination: both are ignored by git, and a path given on the command
 * line could put the secrets where they would be committed.
 *
 * One or more clients for each provider profile, each with a secret drawn
 * from the system's random source. The file is created readable by its owner
 * only and an existing file is never replaced. The secrets are in the file;
 * nothing but its path is printed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProviders } = require('../src/config');

const baseDir = path.join(__dirname, '..');
const LOCAL_FILE = path.join(baseDir, 'clients.json');
const DEPLOY_FILE = path.join(baseDir, 'deploy', 'clients.json');

/**
 * Write a clients file for these providers. Throws when the file is already
 * there (error code EEXIST): secrets in use are never replaced.
 */
function writeClientsFile(file, providers, perProvider) {
  const clients = {};
  for (const key of providers.keys()) {
    clients[key] = Array.from({ length: perProvider }, (_, i) => ({
      client_id: `${key}-client-${i + 1}`,
      client_secret: crypto.randomBytes(32).toString('hex'),
    }));
  }
  // 'wx': fail if the file is already there.
  fs.writeFileSync(file, JSON.stringify(clients, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function main(args) {
  const [where = 'local', count = '2'] = args;
  if (where !== 'local' && where !== 'deploy') {
    console.error('Usage: node scripts/make-clients.js [local|deploy] [clients-per-provider]');
    return 1;
  }
  const perProvider = Number(count);
  if (!Number.isInteger(perProvider) || perProvider < 1 || perProvider > 50) {
    console.error('The number of clients per provider must be a whole number between 1 and 50.');
    return 1;
  }
  const file = where === 'deploy' ? DEPLOY_FILE : LOCAL_FILE;
  const providers = loadProviders(process.env.SIM_PROVIDERS_DIR || path.join(baseDir, 'providers'));
  try {
    writeClientsFile(file, providers, perProvider);
  } catch (error) {
    console.error(error.code === 'EEXIST'
      ? `${file} already exists and was left as it is. Delete it first to draw new secrets.`
      : `Could not write ${file}: ${error.code || error.message}`);
    return 1;
  }
  console.log(`Wrote ${file}: ${perProvider} client(s) for each of ${[...providers.keys()].join(', ')}.`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writeClientsFile, main, LOCAL_FILE, DEPLOY_FILE };
