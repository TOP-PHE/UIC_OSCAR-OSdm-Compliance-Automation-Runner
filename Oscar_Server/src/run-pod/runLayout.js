// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * What a run's working folder holds and how Bruno is started in it, shared by
 * the server's runner (worker/runner.js) and the run pod's entrypoint
 * (run-pod/runPod.js, run isolation option 4, #1130), so that a run in a pod
 * of its own is the same run. Pure: no file system, no network, and nothing
 * of the server: the run image copies this folder only.
 */

// The collection's folders and files a run's working folder is made of.
const COLLECTION_DIRS = Object.freeze([
  '00-Access Token', '01-System Infos Requests', '02-Common Requests',
  '03-Refund', '04-Exchange', 'library-bruno', 'data_base',
]);
const COLLECTION_FILES = Object.freeze(['opencollection.yml', '.gitignore']);

// The folders Bruno and the collection write in.
const ENVIRONMENTS_DIR = 'environments';
const REPORTS_DIR = 'Validation_Reports';

// The name mergeReport.js reads Bruno's results under (hardcoded there).
const MERGE_RESULTS_NAME = '.bru_results.json';

/** The run's own name for Bruno's results, so concurrent runs never share one. */
function bruResultsName(runId) {
  return `.bru_results_${String(runId).slice(0, 8)}.json`;
}

/** Bruno's arguments for a run: the environment, and where its results go. */
function bruRunArgs(envName, runId) {
  return ['run', '--sandbox=developer', '--env', envName, '--reporter-json', `${REPORTS_DIR}/${bruResultsName(runId)}`];
}

// The names Bruno and the collection give a run's result files:
// {date}_{env}[_{code}]_Report.html, .bru_results_<id>.json, .report_tmp.json.
// One file name, no folder, nothing that reads as "..". The server keeps only
// files of such a name (utils/runResults.js); the run pod sends only those.
const RESULT_NAME_RE = /^\.?[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(?:html|json)$/;

/** Why `name` cannot be a result file's name, or null. */
function resultNameProblem(name) {
  if (typeof name !== 'string' || !RESULT_NAME_RE.test(name) || name.includes('..')) {
    return 'not the name of a run\'s result file';
  }
  return null;
}

module.exports = {
  COLLECTION_DIRS,
  COLLECTION_FILES,
  ENVIRONMENTS_DIR,
  REPORTS_DIR,
  MERGE_RESULTS_NAME,
  bruResultsName,
  bruRunArgs,
  resultNameProblem,
};
