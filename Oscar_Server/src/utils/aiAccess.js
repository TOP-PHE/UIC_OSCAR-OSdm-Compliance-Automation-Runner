// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiAccess.js — who may use the AI analysis of results (#801, PR 1). Pure.
 *
 * A Test Manager asks for access, accepting the commitment text, for the
 * company and each provider they choose; the OSCAR administrator approves or
 * refuses each one on its own, so a refusal for one provider leaves the others
 * open. A new version of the text asks the Test Manager to accept again,
 * without a new approval.
 */

const crypto = require('node:crypto');

const COMMITMENT = Object.freeze({
  version: 2,   // 2 (#827): request and answer samples, the provider's checklist answers
  title: 'AI analysis of test results — what you accept',
  points: Object.freeze([
    'Data leaves OSCAR. When you run an analysis, the test results of the batches you choose are sent to the AI service configured for your company. This is a service outside OSCAR and outside the UIC: the checks, statuses, error codes, scenario names and findings of the provider whose results you analyse, for the most frequent failures one request OSCAR sent and the answer it received, and the provider\'s answers to the set-up checklist when one is imported. OSCAR masks credentials, tokens, endpoints and the personal data of passengers and purchasers, but the results themselves describe how the provider\'s system behaves.',
    'You must be allowed to send it. You confirm that your company may share these results with that AI service, under its agreements with the providers concerned. That includes any confidentiality agreement covering test results.',
    'The AI service\'s own terms apply. What it keeps, for how long, and whether it trains on your data depends on your contract with it, not on OSCAR. Check those terms before you start.',
    'Costs are yours. Each analysis is billed by the AI service to the account whose key you configure. OSCAR shows an estimate before each analysis, but the bill comes from the AI service.',
    'An AI analysis is an opinion. It can be wrong. It is not a test result, not a finding and not a certification. A finding is only opened by a person.',
    'It is recorded. Your acceptance and every analysis are recorded: who, when, which batches, which model.',
  ]),
});

/** The text as it is hashed: title, then each point on its own numbered line. */
function commitmentText(commitment = COMMITMENT) {
  return [commitment.title, ...commitment.points.map((p, i) => `${i + 1}. ${p}`)].join('\n');
}

/** sha256 of the text, hex. What a Test Manager accepts is pinned by it. */
function commitmentHash(commitment = COMMITMENT) {
  return crypto.createHash('sha256').update(commitmentText(commitment), 'utf8').digest('hex');
}

/** The text with its version and hash, as the page shows it. */
function commitmentForPage() {
  return { version: COMMITMENT.version, title: COMMITMENT.title, points: [...COMMITMENT.points], hash: commitmentHash() };
}

/**
 * Does an acceptance name the text in force? `accepted` is { version, hash }
 * as the page sends it back.
 */
function acceptsCurrentText(accepted) {
  return !!accepted && Number(accepted.version) === COMMITMENT.version
    && typeof accepted.hash === 'string' && accepted.hash === commitmentHash();
}

const STATES = Object.freeze(['pending', 'approved', 'refused', 'revoked']);

/**
 * Where a Test Manager stands for one company or provider. `request` is the
 * stored row ({ state, text_version, … }) or null.
 *
 *   none                no request yet (or the last was refused or revoked:
 *                       `request` then says which)
 *   pending             waiting for the administrator
 *   needs_acceptance    approved, but the text changed since it was accepted
 *   approved            open
 */
function accessState(request) {
  if (!request || !STATES.includes(request.state)) return 'none';
  if (request.state === 'pending') return 'pending';
  if (request.state === 'approved') {
    return Number(request.text_version) === COMMITMENT.version ? 'approved' : 'needs_acceptance';
  }
  return 'none';
}

/** May a request be made now, from this state? */
function mayRequest(state) {
  return state === 'none' || state === 'needs_acceptance';
}

module.exports = {
  COMMITMENT, STATES, commitmentText, commitmentHash, commitmentForPage, acceptsCurrentText, accessState, mayRequest,
};
