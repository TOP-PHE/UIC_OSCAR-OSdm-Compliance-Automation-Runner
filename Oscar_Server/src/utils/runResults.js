// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The result files a run sends to the server (run isolation, option 4,
 * #1130): its reports, Bruno's results and the report data. A run in a pod of
 * its own shares no folder with the server, so it sends them over the
 * internal port (PUT /v1/runs/:runId/results/:name). They are kept in a
 * folder the server owns, data/artifacts/<runId>/incoming/, encrypted at rest
 * like every artifact, until the runner links them and removes the folder.
 *
 * File system only: no database, no network.
 */

const fs = require('node:fs');
const path = require('node:path');
const { encryptToFileAsync, decryptFromFileAsync } = require('./at-rest');
const { safeJoinUuid } = require('./paths');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const INCOMING = 'incoming';
// One file: as worker/runFolder.js reads from a run's folder (ten times the
// largest report seen). One run: every file together.
const MAX_RESULT_BYTES = 100 * 1024 * 1024;
const MAX_RUN_RESULT_BYTES = 200 * 1024 * 1024;
const MAX_RESULT_FILES = 50;

// The names Bruno and the collection give a run's results:
// {date}_{env}[_{code}]_Report.html, .bru_results_<id>.json, .report_tmp.json.
// One file name, no folder, nothing that reads as "..".
const RESULT_NAME_RE = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:html|json)$/;

class ResultRefusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Why `name` cannot be a result file's name, or null. */
function resultNameProblem(name) {
  if (typeof name !== 'string' || !RESULT_NAME_RE.test(name) || name.includes('..')) {
    return 'not the name of a run\'s result file';
  }
  return null;
}

/** The folder the run's results are kept in, or null for a run id that is not one. */
function incomingDir(runId) {
  const runDir = safeJoinUuid(ARTIFACTS_DIR, runId);
  return runDir ? path.join(runDir, INCOMING) : null;
}

// What the folder holds already: names and their sizes (encrypted).
async function storedResults(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const kept = names.filter(n => resultNameProblem(n) === null);
  return Promise.all(kept.map(async (name) => ({ name, size: (await fs.promises.stat(path.join(dir, name))).size })));
}

/**
 * Keeps one result file of a run. A file is sent once: a second file of the
 * same name is refused, as are a name that is not a result file's, an empty
 * or oversized file, and more files or bytes than a run sends.
 * @throws {ResultRefusal} with the HTTP status to answer
 */
async function storeRunResult(runId, name, content) {
  const dir = incomingDir(runId);
  if (!dir) throw new ResultRefusal(400, 'Invalid run id.');
  const problem = resultNameProblem(name);
  if (problem) throw new ResultRefusal(400, `"${String(name).slice(0, 80)}" is ${problem}.`);
  if (!Buffer.isBuffer(content) || content.length === 0) throw new ResultRefusal(400, 'The file is empty.');
  if (content.length > MAX_RESULT_BYTES) throw new ResultRefusal(413, `A result file holds at most ${MAX_RESULT_BYTES} bytes.`);
  await fs.promises.mkdir(dir, { recursive: true });
  const stored = await storedResults(dir);
  if (stored.some(f => f.name === name)) throw new ResultRefusal(409, `${name} was sent already.`);
  if (stored.length >= MAX_RESULT_FILES) throw new ResultRefusal(413, `A run sends at most ${MAX_RESULT_FILES} result files.`);
  const total = stored.reduce((sum, f) => sum + f.size, 0);
  if (total + content.length > MAX_RUN_RESULT_BYTES) throw new ResultRefusal(413, `A run's result files hold at most ${MAX_RUN_RESULT_BYTES} bytes together.`);
  await encryptToFileAsync(content, path.join(dir, name));
}

/** The names of the result files a run sent, sorted. */
async function listRunResults(runId) {
  const dir = incomingDir(runId);
  if (!dir) return [];
  return (await storedResults(dir)).map(f => f.name).sort((a, b) => a.localeCompare(b));
}

/** One result file of a run, decrypted. */
async function readRunResult(runId, name) {
  const dir = incomingDir(runId);
  if (!dir || resultNameProblem(name)) throw new ResultRefusal(400, 'Not a result file of this run.');
  return decryptFromFileAsync(path.join(dir, name));
}

/** Removes the run's result files once they are linked. */
async function removeRunResults(runId) {
  const dir = incomingDir(runId);
  if (dir) await fs.promises.rm(dir, { recursive: true, force: true });
}

module.exports = {
  storeRunResult,
  listRunResults,
  readRunResult,
  removeRunResults,
  resultNameProblem,
  ResultRefusal,
  MAX_RESULT_BYTES,
  MAX_RUN_RESULT_BYTES,
  MAX_RESULT_FILES,
};
