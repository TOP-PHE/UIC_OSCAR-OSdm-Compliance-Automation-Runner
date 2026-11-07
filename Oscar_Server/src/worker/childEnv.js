// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * What a run's child process may inherit (tracker NEW-01). process.env holds
 * ENCRYPTION_KEY, JWT_SECRET and the SMTP credentials; no child process is
 * handed it. The Bruno CLI and library-bruno/mergeReport.js start from this
 * list and nothing else (plus, for Bruno, the run's own credentials). Windows
 * needs ComSpec + PATHEXT for shell:true to find .cmd files.
 *
 * No dependency: the runner agent (src/runner-agent/agent.js) uses it too,
 * and must load nothing that opens the database.
 */

const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'ComSpec', 'SystemRoot', 'SystemDrive',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'USERNAME',
  'TEMP', 'TMP', 'HOME', 'HOMEDRIVE', 'HOMEPATH',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'NODE_ENV', 'NODE_PATH',
]);

/** The allowlisted variables of `source` (this process's environment by default). */
function childBaseEnv(source = process.env) {
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

/** The run's own credentials, the only other variables Bruno is given. */
const RUN_ENV_KEYS = Object.freeze(['OSCAR_ACCESS_TOKEN', 'OSCAR_SUBSCRIPTION_KEY', 'OSCAR_OAUTH_EXTRA', 'OSCAR_RUN_SECRET']);

module.exports = { CHILD_ENV_ALLOWLIST, childBaseEnv, RUN_ENV_KEYS };
