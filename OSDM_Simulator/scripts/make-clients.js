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
 *   node scripts/make-clients.js [local|deploy] [test-managers] [testers]
 *
 * For each provider profile it creates client ids that say who they are for
 * (#585):
 *
 *   <provider>.tstmgr01, <provider>.tstmgr02, ...   one per Test Manager
 *   <provider>.tst01,    <provider>.tst02,    ...   one per tester
 *
 * Three of each by default. The role is in the name only: the simulator
 * treats every client of a provider alike. Giving each OSCAR account a client
 * of its own is what keeps their bookings apart.
 *
 * `local` (the default) writes `clients.json` next to `server.js`, where the
 * simulator looks for it when run by hand. `deploy` writes
 * `deploy/clients.json`, where the compose file looks for it. There is no
 * other destination: both are ignored by git, and a path given on the command
 * line could put the secrets where they would be committed.
 *
 * Each secret is drawn from the system's random source. The file is created
 * readable by its owner only and an existing file is never replaced. The
 * secrets are in the file; the ids are printed, a secret never is.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProviders } = require('../src/config');

const baseDir = path.join(__dirname, '..');
const LOCAL_FILE = path.join(baseDir, 'clients.json');
const DEPLOY_FILE = path.join(baseDir, 'deploy', 'clients.json');

const DEFAULT_PER_ROLE = 3;
// The number is written with two digits.
const MAX_PER_ROLE = 99;

/** The client ids of one provider: its Test Managers' first, then its testers'. */
function clientIds(providerKey, { managers, testers }) {
  const numbered = (role, count) => Array.from({ length: count }, (_, i) => `${providerKey}.${role}${String(i + 1).padStart(2, '0')}`);
  return [...numbered('tstmgr', managers), ...numbered('tst', testers)];
}

/**
 * Write a clients file for these providers. Throws when the file is already
 * there (error code EEXIST): secrets in use are never replaced. Returns the
 * ids it created, by provider.
 */
function writeClientsFile(file, providers, counts) {
  const clients = {};
  const created = {};
  for (const key of providers.keys()) {
    created[key] = clientIds(key, counts);
    clients[key] = created[key].map((id) => ({ client_id: id, client_secret: crypto.randomBytes(32).toString('hex') }));
  }
  // 'wx': fail if the file is already there.
  fs.writeFileSync(file, JSON.stringify(clients, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return created;
}

// A count given on the command line: one or two digits, or null when the
// text is anything else (an empty argument is not a zero).
function countFrom(text) {
  return /^\d{1,2}$/.test(text) ? Number(text) : null;
}

function main(args) {
  const [where = 'local', managersText = String(DEFAULT_PER_ROLE), testersText = String(DEFAULT_PER_ROLE)] = args;
  if (where !== 'local' && where !== 'deploy') {
    console.error('Usage: node scripts/make-clients.js [local|deploy] [test-managers] [testers]');
    return 1;
  }
  const counts = { managers: countFrom(managersText), testers: countFrom(testersText) };
  if (counts.managers === null || counts.testers === null || counts.managers + counts.testers === 0) {
    console.error(`The numbers of Test Manager and tester clients per provider must be whole numbers from 0 to ${MAX_PER_ROLE}, and not both 0.`);
    return 1;
  }
  const file = where === 'deploy' ? DEPLOY_FILE : LOCAL_FILE;
  const providers = loadProviders(process.env.SIM_PROVIDERS_DIR || path.join(baseDir, 'providers'));
  let created;
  try {
    created = writeClientsFile(file, providers, counts);
  } catch (error) {
    console.error(error.code === 'EEXIST'
      ? `${file} already exists and was left as it is. Delete it first to draw new secrets.`
      : `Could not write ${file}: ${error.code || error.message}`);
    return 1;
  }
  console.log(`Wrote ${file}`);
  for (const [key, ids] of Object.entries(created)) console.log(`  ${key}: ${ids.join(' ')}`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { writeClientsFile, clientIds, main, LOCAL_FILE, DEPLOY_FILE };
