/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * A provider's answer holds no "{{": the test engine fills a "{{name}}" in
 * with the value of a variable wherever a value is used, and values read
 * from an answer go into the next requests. An answer holding one ends the
 * run before the next request is sent (the collection's after-response).
 * Pure but for checkAnswerTemplates().
 */

const OPEN = '{' + '{';

// The text of an answer body, whatever form the engine gives it in.
function bodyText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) return body.toString('utf8');
  try { return JSON.stringify(body); } catch { return String(body); }
}

/** True when the answer body holds "{{". */
function holdsTemplate(body) {
  return bodyText(body).includes(OPEN);
}

/**
 * Fails one check and stops the run when the answer holds "{{". Returns true
 * when it did. Never throws.
 */
function checkAnswerTemplates(res, bruTest, expectFn) {
  let body;
  try { body = typeof res.getBody === 'function' ? res.getBody() : res.body; } catch { return false; }
  if (!holdsTemplate(body)) return false;
  try {
    bruTest('[OSDM] The answer holds no template text ("{' + '{")', () => {
      expectFn(false, 'The answer holds "{' + '{", which the test engine would fill in with its own variables in the next requests. The run stops here.').to.equal(true);
    });
  } catch { /* the check is recorded or not; the run stops either way */ }
  try { bru.runner.stopExecution(); } catch { /* not in a runner context */ }
  return true;
}

module.exports = { holdsTemplate, checkAnswerTemplates };
