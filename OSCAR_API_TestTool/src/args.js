// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * args.js — the command line, read into one plain object. Each setting may
 * come from an option or from an environment variable (the option wins), so a
 * CI job keeps its secrets in its own variables.
 *
 *   --oscar <url>            OSCAR_URL
 *   --client-id <id>         OSCAR_CLIENT_ID
 *   --key <file>             OSCAR_PRIVATE_KEY_FILE   (or OSCAR_PRIVATE_KEY: the PEM text)
 *   --provider <name|id>     repeatable, or comma-separated
 *   --suite <name> | --scenarios <A,B,…> | --selection <file.json>
 *   --reference <text>  --idempotency-key <key>
 *   --timeout <minutes>      how long to wait for the verdict (60)
 *   --junit <file>  --json <file>
 *   --whoami | --suites | --status <test request id>
 *   --help
 */

const USAGE = String.raw`oscar-test — ask OSCAR for tests as a Company API account, wait, read the verdict.

  node oscar-test.js --oscar https://<oscar> --client-id <id> --key <private key file> \
    --provider alpha --provider beta --suite smoke [--junit result.xml]

What to run (one of):
  --suite <name>             a named suite of the company (see --suites)
  --scenarios <A,B,…>        scenario codes
  --selection <file.json>    a selection as the Run page makes it

Other choices:
  --provider <name|id>       a provider (or the company) to test; repeat it, or separate with commas
  --reference <text>         your own id, given back as it is (a pipeline number)
  --idempotency-key <key>    a retry with the same key and request runs nothing twice
  --timeout <minutes>        how long to wait for the verdict (default 60)
  --junit <file>             write the JUnit XML report
  --json <file>              write the results as JSON

Other commands:
  --whoami                   the account, its company and providers
  --suites                   the company's named suites
  --status <id>              wait for a test request already made, then report

Settings may come from the environment instead: OSCAR_URL, OSCAR_CLIENT_ID,
OSCAR_PRIVATE_KEY_FILE (or OSCAR_PRIVATE_KEY with the PEM text).

Exit code: 0 passed, 1 failed, 2 incomplete (a run gave no result or was
cancelled), 3 not finished within --timeout, 4 an error (settings, network,
refusal).`;

const WITH_VALUE = new Set(['oscar', 'client-id', 'key', 'provider', 'suite', 'scenarios', 'selection',
  'reference', 'idempotency-key', 'timeout', 'junit', 'json', 'status']);
const FLAGS = new Set(['whoami', 'suites', 'help']);

const list = value => String(value).split(',').map(s => s.trim()).filter(Boolean);

// One option and its value into o: an error text, or null.
function setOption(o, name, value) {
  if (name === 'provider') o.providers.push(...list(value));
  else if (name === 'scenarios') o.scenarios = list(value);
  else if (name === 'timeout') {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) return '--timeout is a number of minutes, 1 to 1440.';
    o.timeoutMinutes = minutes;
  } else o[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  return null;
}

// The command line's options: { …settings } or { error }.
function optionsOf(argv) {
  const o = { providers: [], timeoutMinutes: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) return { error: `Unexpected argument "${raw}". See --help.` };
    const name = raw.slice(2);
    if (FLAGS.has(name)) { o[name] = true; continue; }
    if (!WITH_VALUE.has(name)) return { error: `Unknown option --${name}. See --help.` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `--${name} needs a value.` };
    i += 1;
    const error = setOption(o, name, value);
    if (error) return { error };
  }
  return o;
}

// What the settings lack or say twice: an error text, or null.
function problemOf(o) {
  if (!o.oscar) return 'Say which OSCAR: --oscar https://<oscar host> (or OSCAR_URL).';
  if (!o.clientId) return 'Say which account: --client-id <the account\'s client id> (or OSCAR_CLIENT_ID).';
  if (!o.key && !o.keyText) return 'Say where the private key is: --key <file> (or OSCAR_PRIVATE_KEY_FILE).';
  if (o.whoami || o.suites || o.status) return null;
  const chosen = ['suite', 'scenarios', 'selection'].filter(k => o[k] !== undefined);
  if (chosen.length !== 1) return 'Say what to run: exactly one of --suite, --scenarios and --selection.';
  if (o.providers.length === 0) return 'Say where to run it: --provider <name or id> (one or more).';
  return null;
}

/** The command line and environment as { …settings } or { error }. */
function argsOf(argv, env = {}) {
  const o = optionsOf(argv);
  if (o.error || o.help) return o;
  o.oscar = o.oscar || env.OSCAR_URL;
  o.clientId = o.clientId || env.OSCAR_CLIENT_ID;
  o.key = o.key || env.OSCAR_PRIVATE_KEY_FILE;
  o.keyText = o.key ? null : env.OSCAR_PRIVATE_KEY || null;
  const error = problemOf(o);
  return error ? { error } : o;
}

module.exports = { argsOf, USAGE };
