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

module.exports = { loopbackOrStop, failStepOrContinue };
