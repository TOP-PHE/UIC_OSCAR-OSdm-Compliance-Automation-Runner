// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * testSuites.js — a named suite (#1342 PR 4): a series of tests a company
 * names once and asks by its name through the API.
 *
 * A suite belongs to the distributor and holds a selection (the Run page's
 * filters, utils/runFilters.js), a list of scenario codes, or both: it then
 * runs the codes the selection keeps and the codes listed. It is resolved on
 * each provider at each launch, so a suite of filters follows the data file;
 * a list of codes names exactly what runs, and a code a provider does not
 * have is said, never a refusal. Tags on scenarios were not chosen: they would
 * live in every provider's data file (#1342, "Series").
 *
 * Pure: no database.
 */

const RF = require('./runFilters');
const { nameOf } = require('./apiAccounts');

const MAX_CODES = 500;
const MAX_PER_COMPANY = 100;

/**
 * A suite as given: { name, selection, codes } (selection or codes null when
 * absent, at least one present), or { error }.
 */
function suiteOf(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const name = nameOf(b.name);
  if (name.error) return { error: name.error };
  let selection = null;
  if (b.selection !== undefined && b.selection !== null) {
    const problem = RF.selectionProblem(b.selection);
    if (problem) return { error: problem };
    selection = RF.withDefaults({ ...b.selection, base: 'all' });
  }
  let codes = null;
  if (b.codes !== undefined && b.codes !== null) {
    if (!Array.isArray(b.codes) || b.codes.length === 0 || b.codes.length > MAX_CODES
        || b.codes.some(c => typeof c !== 'string' || c === '' || c.length > 200)) {
      return { error: `codes must be a list of 1 to ${MAX_CODES} scenario codes.` };
    }
    codes = [...new Set(b.codes)];
  }
  if (!selection && !codes) return { error: 'A suite holds a selection, a list of codes, or both.' };
  return { name: name.name, selection, codes };
}

/**
 * What a suite runs on one provider: { codes, notFound }. `seen` is every
 * scenario the caller sees there; `selected` the codes its selection keeps
 * (null without a selection).
 */
function suiteCodes(suite, seen, selected) {
  const listed = suite.codes || [];
  const known = new Set(seen);
  const out = [...(selected || [])];
  for (const code of listed) if (known.has(code) && !out.includes(code)) out.push(code);
  return { codes: out, notFound: listed.filter(c => !known.has(c)) };
}

module.exports = { MAX_CODES, MAX_PER_COMPANY, suiteOf, suiteCodes };
