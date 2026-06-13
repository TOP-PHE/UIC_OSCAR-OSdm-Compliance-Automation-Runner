/**
 * loopback.js — Multi-scenario loopback helper
 *
 * When a request fails mid-scenario (HTTP error, JSON parse error, etc.),
 * this helper checks whether more scenarios remain in the run.
 *   - If YES  -> loops back to "01. POST Get Offer" for the next scenario.
 *   - If NO   -> calls stopExecution() to end the run.
 *
 * Usage (inside a .yml after-response script):
 *   const { loopbackOrStop } = require(bru.getEnvVar("library_base") + "loopback.js");
 *   loopbackOrStop("POST Create Booking");
 *   return;   // <-- important: exit the script cleanly after calling this
 */

const { parseEnvJson } = require('./envUtils.js');

function loopbackOrStop(label) {
  const _scList    = parseEnvJson('__scenariosList', []);
  const _scNextIdx = parseInt(bru.getEnvVar('scenariosToRunIndex') || '0', 10);

  if (_scList.length > 0 && _scNextIdx < _scList.length) {
    console.log(
      '[INFO] \u{1F504} ' + label + ' failed \u2014 skipping to scenario [' +
      (_scNextIdx + 1) + '/' + _scList.length + ']: ' + _scList[_scNextIdx]
    );
    bru.setEnvVar('__loopback', 'true');
    bru.runner.setNextRequest('01. POST Get Offer');
  } else {
    console.log('[INFO] \u2705 All scenarios attempted \u2014 run finished');
    bru.runner.stopExecution();
  }
}

// #361: step-failure policy. HARD_STOP (default — historical behaviour)
// abandons the scenario via loopbackOrStop; CONTINUE records the failure,
// logs ONE warning and routes to the step the success path would have taken,
// so the remaining endpoints still get coverage (the scenario verdict stays
// FAILED). Critical steps (offer / booking — nothing downstream is
// meaningful without them) always hard-stop regardless of the policy.
function failStepOrContinue(label, nextStep, opts) {
  const critical = !!(opts && opts.critical);
  const policy = String(bru.getEnvVar('stepFailurePolicy') || 'HARD_STOP').toUpperCase();
  if (!critical && policy === 'CONTINUE' && nextStep) {
    console.log(
      '[WARNING] ' + label + ' failed — step-failure policy CONTINUE: proceeding to "' +
      nextStep + '" (failure stays recorded; booking state unchanged).'
    );
    bru.runner.setNextRequest(nextStep);
    return;
  }
  loopbackOrStop(label);
}

// #398: known-deviation baseline. A provider's documented gaps (declared in the
// UI, persisted to the datafile as top-level `knownDeviations` and exposed by
// scenarioParser as the `__knownDeviations` env) should not drag every run to
// FAILED. knownDeviationFor() returns the matching record when a step's HTTP
// status equals a documented deviation, so the call site can emit a PASSING
// "known deviation" row instead of throwing. Matching is tolerant of the
// "NN. " request-name prefix, so the tester can declare "GET Passenger" and it
// still matches the "04. GET Passenger" request.
function _normStep(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/^\d+\.\s*/, '');
}
function knownDeviationFor(stepLabel, status) {
  const list = parseEnvJson('__knownDeviations', []);
  if (!Array.isArray(list) || list.length === 0) return null;
  const target = _normStep(stepLabel);
  return list.find(function (d) {
    // `active === false` = checklist item un-ticked (kept on record, not enforced).
    return d && d.active !== false && _normStep(d.step) === target && Number(d.expectedStatus) === Number(status);
  }) || null;
}

// Log the documented deviation as a WARNING (visibility — NOT a failure) and
// bump the per-run tally so a future end-of-run summary can report it. Records
// which deviations were actually seen, so the baseline can later flag any that
// no longer reproduce.
function noteKnownDeviation(stepLabel, status, dev) {
  console.log(
    '[WARNING] Known deviation (documented): ' + stepLabel + ' returned HTTP ' + status +
    ' — ' + (dev && dev.note ? dev.note : 'declared in the provider baseline') +
    '. Not counted as a failure; surfaced for visibility.'
  );
  const n = parseInt(bru.getEnvVar('__knownDeviationHits') || '0', 10) + 1;
  bru.setEnvVar('__knownDeviationHits', String(n));
  const seen = parseEnvJson('__knownDeviationsSeen', []);
  const key = _normStep(stepLabel) + '#' + String(status);
  if (seen.indexOf(key) === -1) { seen.push(key); bru.setEnvVar('__knownDeviationsSeen', JSON.stringify(seen)); }
}

module.exports = { loopbackOrStop, failStepOrContinue, knownDeviationFor, noteKnownDeviation };
