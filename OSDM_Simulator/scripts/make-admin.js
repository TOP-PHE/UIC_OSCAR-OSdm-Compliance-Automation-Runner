// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * make-admin.js — the administrators of the simulator's administration API
 * (#930), run on the simulator's host.
 *
 *   node scripts/make-admin.js <local|deploy> add <name>
 *   node scripts/make-admin.js <local|deploy> reset <name>
 *   node scripts/make-admin.js <local|deploy> remove <name>
 *
 * `add` and `reset` draw a password from the system's random source and print
 * it once: it is kept nowhere but as a scrypt digest in `admins.json`. `local`
 * writes into `data/` next to `server.js` (`SIM_DATA_DIR=./data`), `deploy`
 * into `deploy/data/`, the folder the compose file gives the container. There
 * is no other destination: both are ignored by git, and a path given on the
 * command line could put the file where it would be committed.
 *
 * The simulator reads the file at each sign-in: no restart is needed. A
 * removed administrator's sessions end at their next request.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, ADMINS_FILE, ADMIN_NAME } = require('../src/admin');
const { writeAtomically } = require('../src/accounts');

const baseDir = path.join(__dirname, '..');
const LOCAL_DIR = path.join(baseDir, 'data');
const DEPLOY_DIR = path.join(baseDir, 'deploy', 'data');

function readFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw?.admins) ? raw.admins : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Change the administrators of a data folder. Returns the new password for
 * `add` and `reset`, null for `remove`. Throws an Error with a message for
 * the user when the change cannot be made.
 */
async function changeAdmins(dir, action, name, now = Date.now) {
  if (!ADMIN_NAME.test(name || '')) throw new Error('A name is 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ADMINS_FILE);
  const admins = readFile(file);
  const index = admins.findIndex((a) => a?.name === name);
  if (action === 'add' && index >= 0) throw new Error(`"${name}" is already an administrator: use reset for a new password.`);
  if (action !== 'add' && index < 0) throw new Error(`"${name}" is not an administrator.`);
  let password = null;
  if (action === 'remove') {
    admins.splice(index, 1);
  } else {
    password = crypto.randomBytes(24).toString('base64url');
    const entry = { name, password: await hashPassword(password), changedAt: new Date(now()).toISOString() };
    if (index >= 0) admins[index] = entry;
    else admins.push(entry);
  }
  writeAtomically(file, `${JSON.stringify({ format: 1, admins }, null, 2)}\n`);
  return password;
}

async function main(args) {
  const [where, action, name] = args;
  if (!['local', 'deploy'].includes(where) || !['add', 'reset', 'remove'].includes(action) || !name || args.length !== 3) {
    console.error('Usage: node scripts/make-admin.js <local|deploy> <add|reset|remove> <name>');
    return 1;
  }
  const dir = where === 'deploy' ? DEPLOY_DIR : LOCAL_DIR;
  let password;
  try {
    password = await changeAdmins(dir, action, name);
  } catch (error) {
    console.error(error.code ? `Could not write ${dir}: ${error.code}` : error.message);
    return 1;
  }
  if (password === null) {
    console.log(`Removed administrator "${name}" from ${path.join(dir, ADMINS_FILE)}`);
  } else {
    console.log(`Administrator "${name}" in ${path.join(dir, ADMINS_FILE)}`);
    console.log(`Password (shown once, kept nowhere): ${password}`);
  }
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { changeAdmins, main, LOCAL_DIR, DEPLOY_DIR };
