// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Whether a run's exit is a test result (#1287) ────────────────────────────
// Bruno CLI ends a run with 0 when every check passed and 1 when a check or a
// request failed: those two are test results. Any other code says the run did
// not go to its end: Bruno could not run the collection (2–13), stopped on an
// unexpected error (255, "Something went wrong"), or, on a cluster, the run's
// pod ended otherwise (the dispatcher's 124, 125, 143; 137 when killed). Seen
// on 2026-11-16: a k3s restart made three runs end with 255 partway through,
// all their checks passed, and they read as FAILED like a provider's defect.
//
// One implementation for the runner (worker/runner.js), the start-up
// reconciliation (worker/reconcile.js), the coverage report and the run page
// (run-detail.html, browser global OscarRunExit).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarRunExit = api;
}(globalThis, function () {
  'use strict';

  // The runs' error_message for an exit that is not a test result.
  const NOT_FINISHED = 'RUN_NOT_FINISHED';

  // What a server start writes on the runs it finds still RUNNING or QUEUED
  // (worker/reconcile.js, #1291): nothing resumes them. Rows of earlier
  // releases hold the same text, so it must not change.
  const RESTART_INTERRUPTED =
    'Interrupted by a server restart — the run process was terminated and cannot be resumed. Please resubmit.';
  const RESTART_CANCELLED =
    'Cancelled by a server restart before this run started. Please resubmit.';
  const RESTARTED = Object.freeze([RESTART_INTERRUPTED, RESTART_CANCELLED]);

  // error_message values that say a run is not a test result: nothing, or not
  // all, was tested. The coverage report leaves such a run out (the scenario's
  // finished run before it stands, or none).
  const NOT_A_RESULT = Object.freeze(['NO_CHECKS', 'RUN_PROCESS_ERROR', NOT_FINISHED, ...RESTARTED]);

  // Bruno CLI 4.3's codes (src/constants.js), then the run pod's and the
  // dispatcher's (run-dispatcher/dispatcher.js, run-pod/runPod.js).
  const MEANINGS = Object.freeze({
    2: 'Bruno could not run the collection: an output folder is missing (or, on a cluster, the run pod was given wrong inputs)',
    3: 'Bruno stopped the run: its request chain went round in a loop',
    4: 'Bruno could not run the collection: it was not started in a collection folder',
    5: 'Bruno could not run the collection: a file it needs was not found',
    6: 'Bruno could not run the collection: the run\'s environment was not found',
    7: 'Bruno could not run the collection: an environment override was malformed',
    8: 'Bruno could not run the collection: an environment override was malformed',
    9: 'Bruno could not run the collection: an output format was refused',
    10: 'Bruno could not run the collection: a data file was not found or not readable',
    11: 'Bruno could not run the collection: a JSON file or workspace was not found',
    12: 'Bruno could not run the collection: a global environment needs a workspace',
    13: 'Bruno could not run the collection: a global environment was not found',
    124: 'the run reached its time limit and its pod was stopped',
    125: 'the run\'s pod never started',
    127: 'Bruno could not be started',
    137: 'the run was killed, most often for using more memory than it may',
    143: 'the run was stopped',
    255: 'Bruno stopped on an unexpected error ("Something went wrong"), for example when the machine or cluster running it was restarted under it',
  });

  // Bruno's two exits that are test results: 0 (passed) and 1 (failed).
  const RESULT_EXITS = new Set([0, 1]);

  /** Whether Bruno's exit code is a test result: 0 (passed) or 1 (failed). */
  function isTestResultExit(code) {
    return RESULT_EXITS.has(code);
  }

  /** What an exit code that is not a test result says, in words. */
  function exitMeaning(code) {
    if (Number.isInteger(code) && Object.hasOwn(MEANINGS, code)) return MEANINGS[code];
    return 'the run ended with a code Bruno does not give a test result';
  }

  /** Whether a run's error_message says it is not a test result. */
  function isNotAResult(errorMessage) {
    return NOT_A_RESULT.includes(errorMessage);
  }

  /** Whether a run's error_message says a server restart failed it. */
  function isRestarted(errorMessage) {
    return RESTARTED.includes(errorMessage);
  }

  return {
    NOT_FINISHED, RESTART_INTERRUPTED, RESTART_CANCELLED, NOT_A_RESULT,
    isTestResultExit, exitMeaning, isNotAResult, isRestarted,
  };
}));
