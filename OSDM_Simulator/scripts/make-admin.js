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
 * `add` and `reset` ask for the password, twice, without showing it on a
 * terminal (from a pipe: its first line, once). It is kept nowhere but as a
 * scrypt digest in `admins.json`, and never written out. `local`
 * writes into `data/` next to `server.js` (`SIM_DATA_DIR=./data`), `deploy`
 * into `deploy/data/`, the folder the compose file gives the container. There
 * is no other destination: both are ignored by git, and a path given on the
 * command line could put the file where it would be committed.
 *
 * The simulator reads the file at each sign-in: no restart is needed. A
 * removed administrator's sessions end at their next request.
 */

const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, ADMINS_FILE, ADMIN_NAME } = require('../src/admin');
const { writeAtomically } = require('../src/accounts');

const baseDir = path.join(__dirname, '..');
const LOCAL_DIR = path.join(baseDir, 'data');
const DEPLOY_DIR = path.join(baseDir, 'deploy', 'data');
const MIN_PASSWORD = 16;
const MAX_PASSWORD = 200;

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
 * Change the administrators of a data folder: `password` for `add` and
 * `reset`. Throws an Error with a message for the user when the change cannot
 * be made.
 */
async function changeAdmins(dir, action, name, password, now = Date.now) {
  if (!ADMIN_NAME.test(name || '')) throw new Error('A name is 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter.');
  if (action !== 'remove' && (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD)) {
    throw new Error(`A password is ${MIN_PASSWORD} to ${MAX_PASSWORD} characters.`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, ADMINS_FILE);
  const admins = readFile(file);
  const index = admins.findIndex((a) => a?.name === name);
  if (action === 'add' && index >= 0) throw new Error(`"${name}" is already an administrator: use reset for a new password.`);
  if (action !== 'add' && index < 0) throw new Error(`"${name}" is not an administrator.`);
  if (action === 'remove') {
    admins.splice(index, 1);
  } else {
    const entry = { name, password: await hashPassword(password), changedAt: new Date(now()).toISOString() };
    if (index >= 0) admins[index] = entry;
    else admins.push(entry);
  }
  writeAtomically(file, `${JSON.stringify({ format: 1, admins }, null, 2)}\n`);
}

// One line typed on a terminal, not shown; Ctrl-C gives null.
function readHidden(input, output, prompt) {
  return new Promise((resolve) => {
    output.write(prompt);
    let text = '';
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0003') {
          input.removeListener('data', onData);
          input.setRawMode(false);
          input.pause();
          output.write('\n');
          resolve(ch === '\u0003' ? null : text);
          return;
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    input.on('data', onData);
  });
}

// The first line of a pipe.
async function readFirstLine(input) {
  let text = '';
  for await (const chunk of input) {
    text += chunk;
    if (text.includes('\n') || text.length > MAX_PASSWORD * 4) break;
  }
  return text.split(/\r?\n/)[0];
}

/** The password: typed twice on a terminal, else the first line of the input. */
async function askPassword(input, output) {
  if (!input.isTTY) return readFirstLine(input);
  const first = await readHidden(input, output, 'Password (16 characters or more): ');
  if (first === null) return null;
  const again = await readHidden(input, output, 'Again: ');
  if (again !== first) throw new Error('The two passwords differ.');
  return first;
}

// `dirs`: the two destinations; a test gives folders of its own.
async function main(args, { input = process.stdin, output = process.stderr, dirs = { local: LOCAL_DIR, deploy: DEPLOY_DIR } } = {}) {
  const [where, action, name] = args;
  if (!['local', 'deploy'].includes(where) || !['add', 'reset', 'remove'].includes(action) || !name || args.length !== 3) {
    console.error('Usage: node scripts/make-admin.js <local|deploy> <add|reset|remove> <name>');
    return 1;
  }
  const dir = where === 'deploy' ? dirs.deploy : dirs.local;
  try {
    const password = action === 'remove' ? undefined : await askPassword(input, output);
    if (password === null) return 1;
    await changeAdmins(dir, action, name, password);
  } catch (error) {
    console.error(error.code ? `Could not write ${dir}: ${error.code}` : error.message);
    return 1;
  }
  console.log(action === 'remove'
    ? `Removed administrator "${name}" from ${path.join(dir, ADMINS_FILE)}`
    : `Administrator "${name}" in ${path.join(dir, ADMINS_FILE)}`);
  return 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { changeAdmins, askPassword, main, LOCAL_DIR, DEPLOY_DIR, MIN_PASSWORD };
