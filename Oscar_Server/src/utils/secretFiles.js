// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * secretFiles.js — a secret of the environment may come from a file (#1430).
 *
 * NAME_FILE names a file that holds NAME's value: a Docker Compose secret
 * (/run/secrets/…) or a Kubernetes Secret mounted as a volume. The value is
 * then not in the container's environment, where `docker inspect`, a dump of
 * the environment or /proc/<pid>/environ shows it. NAME itself keeps working.
 *
 * Read once at the start, before anything uses the value, and put in
 * process.env under NAME, so every reader stays as it is. Only `node:` modules:
 * the runner agent and the dispatcher use it too, and must load nothing that
 * opens the database.
 */

const fs = require('node:fs');

/** The secrets a server's .env may hold. */
const SECRET_NAMES = Object.freeze(['ENCRYPTION_KEY', 'SMTP_PASS', 'PLATFORM_BOOTSTRAP_TOKEN', 'METRICS_TOKEN', 'RUN_AGENT_TOKEN']);
const MAX_BYTES = 4096;

/**
 * Reads each NAME_FILE of `names` into env[NAME]. Answers the names read.
 * Throws, with a sentence for the log, when a file cannot be read, is empty or
 * too long, or when NAME is set as well (one or the other, never both).
 * `warn` is told when a file can be read by others than its owner.
 */
function loadSecretFiles(env = process.env, {
  names = SECRET_NAMES,
  statSync = fs.statSync,
  readFileSync = fs.readFileSync,
  platform = process.platform,
  warn = (message) => console.warn(message),
} = {}) {
  const read = [];
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (file === undefined || file === '') continue;
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`${name} and ${name}_FILE are both set: keep one of them.`);
    }
    env[name] = valueOfFile(`${name}_FILE`, file, { statSync, readFileSync, platform, warn });
    read.push(name);
  }
  return read;
}

/** The value a secret's file holds: its text but for one line end at the end. */
function valueOfFile(variable, file, { statSync, readFileSync, platform, warn }) {
  let stat;
  let text;
  try {
    stat = statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_BYTES) throw new Error(`longer than ${MAX_BYTES} bytes`);
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${variable} (${file}) cannot be read: ${err.code || err.message}.`);
  }
  // One line end at the end, as an editor or `echo` writes it, is not the value's.
  const value = text.replace(/\r?\n$/, '');
  if (value === '') throw new Error(`${variable} (${file}) is empty.`);
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    warn(`${variable} (${file}) can be read by others than its owner (mode ${(stat.mode & 0o777).toString(8)}): chmod 400 it.`);
  }
  return value;
}

module.exports = { loadSecretFiles, SECRET_NAMES, MAX_BYTES };
