/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * ignoredParameters.js — the request members a provider says it ignored
 * (#729, #774). An answer may carry problems such as PARAMETER_NOT_SUPPORTED
 * "Parameter 'offers.optionalReservationSelections' was ignored." next to
 * HTTP 200. The member is named by the problem's `pointers` (OSDM 3.x:
 * ProblemPointer objects, or text from some providers), else by the quoted
 * name in its title. Only the last segment is kept, lower-cased:
 * "offers.placeSelections.accommodations" is `accommodations`, not
 * `placeselections`.
 *
 * Pure module: no Bruno globals.
 */

// A pointer as text. OSDM's Problem.pointers holds ProblemPointer objects
// ({ requestPointer: '/offers/0/…' }, #833); some providers send plain text.
function pointerText(pointer) {
  if (typeof pointer === 'string') return pointer;
  if (pointer && typeof pointer === 'object') return pointer.requestPointer || pointer.responsePointer || '';
  return '';
}

// The members one problem says were ignored, lower-cased; [] for any other problem.
function ignoredNamesOf(p) {
  if (!p || typeof p !== 'object') return [];
  const code = String(p.code || '');
  const title = String(p.title || '');
  if (!code.endsWith('PARAMETER_NOT_SUPPORTED') && !/\bignored\b/i.test(title)) return [];
  let refs = Array.isArray(p.pointers) ? p.pointers.map(pointerText).filter(Boolean) : [];
  if (!refs.length) {
    const m = /'([^']+)'/.exec(title);
    refs = m ? [m[1]] : [];
  }
  return refs
    .map((ref) => ref.split(/[./]/).findLast(Boolean))
    .filter(Boolean)
    .map((name) => name.toLowerCase());
}

/** The members an answer says were ignored, lower-cased, each once. */
function ignoredParameters(response) {
  const problems = Array.isArray(response?.problems) ? response.problems : [];
  return [...new Set(problems.flatMap(ignoredNamesOf))];
}

module.exports = { ignoredParameters, ignoredNamesOf, pointerText };
