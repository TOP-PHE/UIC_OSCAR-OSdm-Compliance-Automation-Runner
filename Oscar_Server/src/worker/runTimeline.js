// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Where a run's time goes (#1312): the moments the server itself sees for a
 * run, on its own clock, and the steps between them. Nothing here is read
 * from what the run prints: a scenario cannot move a mark. No database, no
 * metric: the runner observes what stepsOf() gives.
 *
 * The marks, in the order a run meets them:
 *   slot      the run is given a slot (executeRun)
 *   launched  it is handed to the launcher
 *   job       pod mode: the dispatcher made its Secret and its Job
 *   pod       pod mode: the pod's container runs
 *   output    pod mode: the pod's first line (its work folder is ready)
 *   call      Bruno's first call to the server (its data file, a token)
 *   upload    pod mode: the first result file arrives
 *   uploaded  pod mode: the last result file is kept
 *   exit      the run's process ended, as the server sees it
 *   linked    its reports are linked to the run
 *   done      its checks are stored and its final status written
 *
 * A run in progress has one entry, removed by drop() when executeRun ends,
 * however it ends. A mark for a run that is not in progress is ignored, so a
 * call from outside never adds an entry.
 */

const MARKS = Object.freeze(['slot', 'launched', 'job', 'pod', 'output', 'call', 'upload', 'uploaded', 'exit', 'linked', 'done']);
const KNOWN = new Set(MARKS);

// A step runs from the first of `from` that was seen to the first of `to`
// that was seen. A step with an end missing, or ending before it started, is
// not given: a figure is either measured or absent.
const SPANS = Object.freeze([
  { step: 'prepare', from: ['slot'], to: ['launched'] },
  { step: 'job', from: ['launched'], to: ['job'] },
  { step: 'pod', from: ['job'], to: ['pod'] },
  { step: 'folder', from: ['pod'], to: ['output'] },
  { step: 'bruno_start', from: ['output', 'pod', 'job', 'launched'], to: ['call'] },
  // Split in two by stepsOf() when Bruno's own times of the requests are known.
  { step: 'scenario', from: ['call'], to: ['upload', 'exit'] },
  { step: 'send', from: ['upload'], to: ['uploaded'] },
  { step: 'end', from: ['uploaded'], to: ['exit'] },
  { step: 'link', from: ['exit'], to: ['linked'] },
  { step: 'store', from: ['linked'], to: ['done'] },
]);

// Every step a run can give, in the order they follow each other; the label
// values of oscar_run_step_seconds (utils/metrics.js RUN_STEPS, pinned by a
// test). `scenario` is given only in place of `requests` + `reports`.
const STEP_NAMES = Object.freeze([
  'prepare', 'job', 'pod', 'folder', 'bruno_start', 'requests', 'reports', 'scenario', 'send', 'end', 'link', 'store',
]);

// What each step is, in the words of the run's log.
const STEP_WORDS = Object.freeze({
  prepare: 'preparing the run',
  job: 'asking for its pod',
  pod: 'waiting for its pod',
  folder: 'its pod preparing the work folder',
  bruno_start: 'Bruno starting',
  requests: 'the requests',
  reports: 'the reports',
  scenario: 'the requests and the reports',
  send: 'sending the results',
  end: 'its pod ending',
  link: 'linking the reports',
  store: 'storing the checks',
});

const going = new Map();   // runId -> Map(mark -> ns, a BigInt of process.hrtime)
const clock = () => process.hrtime.bigint();

/** The run is given a slot: its marks start here. */
function begin(runId, at = clock()) {
  going.set(runId, new Map([['slot', at]]));
}

/** Notes a moment of a run in progress, the first time only. True when noted. */
function mark(runId, name, at = clock()) {
  const marks = going.get(runId);
  if (!marks || !KNOWN.has(name) || marks.has(name)) return false;
  marks.set(name, at);
  return true;
}

/** Notes a moment that may come several times: the last one counts. */
function markAgain(runId, name, at = clock()) {
  const marks = going.get(runId);
  if (!marks || !KNOWN.has(name)) return false;
  marks.set(name, at);
  return true;
}

const firstSeen = (marks, names) => names.map((name) => marks.get(name)).find((at) => at !== undefined);
const secondsBetween = (from, to) => Number(to - from) / 1e9;

// The scenario's span, in two: the requests as Bruno timed each (its scripts
// and the provider's answers), never more than the span itself, and the rest
// (Bruno between requests, its reports, their merging). One step, `scenario`,
// when Bruno's times are not known.
function scenarioSteps(seconds, requestSeconds) {
  if (!Number.isFinite(requestSeconds) || requestSeconds < 0) return [{ step: 'scenario', seconds }];
  const requests = Math.min(requestSeconds, seconds);
  return [{ step: 'requests', seconds: requests }, { step: 'reports', seconds: seconds - requests }];
}

/**
 * The steps of a run in progress, in order, each { step, seconds }, and the
 * whole from its slot to its final status (`total`, null until the run is
 * done). `requestSeconds` is the sum of the requests' own times, when known.
 */
function stepsOf(runId, { requestSeconds } = {}) {
  const marks = going.get(runId);
  if (!marks) return { steps: [], total: null };
  const steps = [];
  for (const { step, from, to } of SPANS) {
    const start = firstSeen(marks, from);
    const end = firstSeen(marks, to);
    if (start === undefined || end === undefined || end < start) continue;
    const seconds = secondsBetween(start, end);
    if (step === 'scenario') steps.push(...scenarioSteps(seconds, requestSeconds));
    else steps.push({ step, seconds });
  }
  const slot = marks.get('slot');
  const done = marks.get('done');
  const total = slot !== undefined && done !== undefined && done >= slot ? secondsBetween(slot, done) : null;
  return { steps, total };
}

/** The run ended: its marks are forgotten. */
function drop(runId) {
  going.delete(runId);
}

const shown = (seconds) => `${seconds.toFixed(1)} s`;

/** One line for the run's log: the whole, then each step in words. */
function textOf({ steps, total }) {
  const parts = steps.map(({ step, seconds }) => `${STEP_WORDS[step]} ${shown(seconds)}`);
  const whole = total === null ? '' : ` (${shown(total)} from its slot to its final status)`;
  return `Where this run's time went${whole}: ${parts.join(', ')}.`;
}

/** Tests only: how many runs have marks. */
function _going() {
  return going.size;
}

/** Tests only: the moments noted for a run, in the order they were noted. */
function _marksOf(runId) {
  return [...(going.get(runId)?.keys() || [])];
}

module.exports = { begin, mark, markAgain, stepsOf, drop, textOf, MARKS, STEP_NAMES, STEP_WORDS, _going, _marksOf };
