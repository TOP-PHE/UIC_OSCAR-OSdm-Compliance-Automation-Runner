// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * replay.js — run every scenario of the simulator's data file with `bru`,
 * standalone, and record what each run checked (#611).
 *
 *   node scripts/replay.js record before   [CODE ...]   → replay/before.json
 *   node scripts/replay.js record after    [CODE ...]   → replay/after.json
 *   node scripts/replay.js compare                       before.json vs after.json
 *   node scripts/replay.js coverage                      library-bruno lines run
 *
 * Needs: the simulator listening (REPLAY_SIM_BASE, default
 * http://127.0.0.1:3002), the repository root served over HTTP
 * (REPLAY_DATA_URL, default http://localhost:8080/Bruno_Collection/data_base/simulator_datafile.json),
 * the Bruno CLI at the version OSCAR pins, and `clients.json` next to
 * server.js. The CLI is run with this Node, from REPLAY_BRU_JS when set, else
 * from Oscar_Server/bruno-cli (after `npm ci` there), else from the global
 * install next to this Node. Each scenario runs on the provider of its version; the
 * environment file `bru` rewrites is put back after each run.
 *
 * Everything is written under OSDM_Simulator/replay/ (ignored by git), under
 * fixed names: nothing from the command line becomes a path.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { providerOf, recordOf, compareRecordings, lineCoverage } = require('./replay-lib');

const ROOT = path.join(__dirname, '..', '..');
const COLLECTION = path.join(ROOT, 'Bruno_Collection');
const DATA_FILE = path.join(COLLECTION, 'data_base', 'simulator_datafile.json');
const ENV_FILE = path.join(COLLECTION, 'environments', 'OTST_Simulator_Env.yml');
const CLIENTS_FILE = path.join(__dirname, '..', 'clients.json');
const OUT = path.join(__dirname, '..', 'replay');
const RUNS = path.join(OUT, 'runs');
const COVERAGE = path.join(OUT, 'coverage');
const RECORDINGS = { before: path.join(OUT, 'before.json'), after: path.join(OUT, 'after.json') };
const FOLDERS = ['00-Access Token', '01-System Infos Requests', '02-Common Requests', '03-Refund', '04-Exchange'];
const SIM_BASE = process.env.REPLAY_SIM_BASE || 'http://127.0.0.1:3002';
const DATA_URL = process.env.REPLAY_DATA_URL || 'http://localhost:8080/Bruno_Collection/data_base/simulator_datafile.json';

// The CLI's own script, run with this Node rather than looked up on the PATH.
function bruScript() {
  const cli = path.join('node_modules', '@usebruno', 'cli', 'bin', 'bru.js');
  const nodeDir = path.dirname(process.execPath);
  const places = [
    process.env.REPLAY_BRU_JS,
    path.join(ROOT, 'Oscar_Server', 'bruno-cli', cli),
    path.join(nodeDir, '..', 'lib', cli),
    path.join(nodeDir, cli),
  ].filter(Boolean);
  const found = places.find((place) => fs.existsSync(place));
  if (!found) throw new Error(`The Bruno CLI is not installed; looked at: ${places.join(', ')}`);
  return found;
}

function clientOf(provider) {
  const clients = JSON.parse(fs.readFileSync(CLIENTS_FILE, 'utf8'))[provider] || [];
  const client = clients.find((c) => /\.tst\d/.test(c.client_id)) || clients[0];
  if (!client) throw new Error(`clients.json has no client of ${provider}`);
  return client;
}

// One scenario: its record, or why it could not run.
function runOne(code, index) {
  const provider = providerOf(code);
  if (!provider) return { error: 'no provider for this version' };
  const client = clientOf(provider);
  const report = path.join(RUNS, `${index}.json`);
  const envBefore = fs.readFileSync(ENV_FILE);
  let run;
  try {
    run = spawnSync(process.execPath, [bruScript(), 'run', ...FOLDERS, '--sandbox=developer', '--env', 'OTST_Simulator_Env',
      '--env-var', `client_id=${client.client_id}`, '--env-var', `client_secret=${client.client_secret}`,
      '--env-var', `api_base=${SIM_BASE}/${provider}`, '--env-var', `data_base=${DATA_URL}`,
      '--env-var', `scenario_override=${code}`, '--reporter-json', report], {
      cwd: COLLECTION,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_V8_COVERAGE: COVERAGE },
    });
  } finally {
    fs.writeFileSync(ENV_FILE, envBefore);
  }
  if (!fs.existsSync(report)) return { error: `bru wrote no report (status ${run.status}): ${String(run.stderr).slice(0, 300)}` };
  return recordOf(JSON.parse(fs.readFileSync(report, 'utf8')), run.stdout);
}

function record(which, only) {
  if (!RECORDINGS[which]) throw new Error('record what: before or after');
  fs.rmSync(COVERAGE, { recursive: true, force: true });
  fs.mkdirSync(RUNS, { recursive: true });
  const codes = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).scenarios.map((s) => s.code)
    .filter((code) => only.length === 0 || only.includes(code));
  const recording = {};
  codes.forEach((code, i) => {
    const started = Date.now();
    recording[code] = runOne(code, i);
    const r = recording[code];
    const outcome = r.error || `${r.checks} checks, ${r.failed} failed`;
    process.stderr.write(`${code}: ${outcome} (${Math.round((Date.now() - started) / 1000)} s)\n`);
  });
  fs.writeFileSync(RECORDINGS[which], `${JSON.stringify(recording, null, 1)}\n`);
  process.stderr.write(`Recorded ${codes.length} scenario(s) in replay/${which}.json\n`);
}

function compare() {
  const [before, after] = [RECORDINGS.before, RECORDINGS.after].map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const differences = compareRecordings(before, after);
  if (differences.length === 0) {
    process.stdout.write(`The two recordings are the same (${Object.keys(after).length} scenarios).\n`);
    return 0;
  }
  process.stdout.write(`${differences.join('\n')}\n`);
  return 1;
}

function coverage() {
  const results = fs.readdirSync(COVERAGE).filter((f) => f.endsWith('.json'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(COVERAGE, f), 'utf8')).result);
  const { files, total } = lineCoverage(results, `${path.sep}library-bruno${path.sep}`, (file) => fs.readFileSync(file, 'utf8'));
  const percent = (f) => (f.lines === 0 ? 100 : (100 * f.covered) / f.lines).toFixed(1);
  const known = new Set(Object.keys(files).map((f) => path.basename(f)));
  const all = fs.readdirSync(path.join(COLLECTION, 'library-bruno')).filter((f) => f.endsWith('.js'));
  for (const [file, f] of Object.entries(files).sort((x, y) => x[0].localeCompare(y[0]))) process.stdout.write(`${percent(f).padStart(6)} %  ${f.covered}/${f.lines}  ${path.basename(file)}\n`);
  for (const file of all.filter((f) => !known.has(f))) process.stdout.write(`   0.0 %  never loaded  ${file}\n`);
  process.stdout.write(`${percent(total)} % of the lines of the ${known.size} loaded file(s) ran; ${all.length - known.size} file(s) never loaded.\n`);
}

if (require.main === module) {
  const [command, which, ...only] = process.argv.slice(2);
  try {
    if (command === 'record') record(which, only);
    else if (command === 'compare') process.exitCode = compare();
    else if (command === 'coverage') coverage();
    else throw new Error('usage: replay.js record before|after [CODE ...] | compare | coverage');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
