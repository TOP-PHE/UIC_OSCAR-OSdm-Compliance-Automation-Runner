// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * pointPositions.js — the provider's position on a point of the coverage by
 * capability (#994). Pure.
 *
 * A Test Manager or a tester of the company or provider answers a point: a
 * defect it will fix, a function it does not offer, something done on
 * purpose, OSCAR's test, the specification, its own declaration, or a fix to
 * run again. The position is kept on the point's finding (Test Findings &
 * Open Points, #398), whose category it sets, and counts at once (maintainer,
 * 2026-10-27); the Test Manager can change the category afterwards, as for
 * any finding.
 *
 * "Not supported" is refused on an expected refusal (say it is done on
 * purpose instead) and on the capabilities every provider must have: the sale
 * itself and offers by search (`ALWAYS_REQUIRED`, maintainer, 2026-10-27).
 */

const { ALWAYS_REQUIRED } = require('./capabilities');

const MAX_COMMENT = 4000;
const MAX_TITLE = 200;

// In the order the page offers them. `status` is the finding's after the
// position: every position but "on purpose" leaves it under discussion,
// because a resolved provider_deviation reads as an accepted deviation.
const POSITIONS = Object.freeze({
  fix: { label: 'Agreed, we will fix it', category: 'provider_deviation', status: 'discussing' },
  notSupported: { label: 'Not supported: optional, not a blocker', category: 'not_supported', status: 'discussing', severity: 'not_supported' },
  onPurpose: { label: 'Done this way on purpose', category: 'provider_deviation', status: 'resolved' },
  oscar: { label: "OSCAR's test is wrong", category: 'oscar_issue', status: 'discussing' },
  specification: { label: 'The OSDM specification is unclear', category: 'spec_question', status: 'discussing' },
  declaration: { label: 'Our declaration was wrong (Test Framework or Test Data)', category: 'open', status: 'discussing' },
  fixed: { label: 'Fixed, please run again', category: 'provider_deviation', status: 'discussing' },
});

const ROLE_TEXT = Object.freeze({ test_manager: 'Test Manager', company_user: 'tester' });

const isPosition = (value) => typeof value === 'string' && Object.hasOwn(POSITIONS, value);

/** Whether a point of this capability may be answered "not supported". */
const notSupportedAllowed = (point) => !point?.expectedRefusal && !ALWAYS_REQUIRED.includes(point?.capability);

/**
 * Why a position cannot be taken on a point, or null. A known deviation is
 * documented already (its finding is changed on Test Findings); a point OSCAR
 * owns by its check or by the Test Manager's choice has nothing for the
 * provider to answer.
 */
function positionRefusal(point, position) {
  if (!isPosition(position)) return 'Unknown position.';
  if (point.source !== 'check') return 'A known deviation is documented already: change its finding on Test Findings & Open Points.';
  if (point.kind === 'oscar' && point.finding?.category !== 'oscar_issue') return "This point is OSCAR's own: there is nothing for the provider to answer.";
  if (position === 'notSupported' && point.expectedRefusal) {
    return 'An expected refusal cannot be "not supported": say it is done on purpose, or that it will be fixed.';
  }
  if (position === 'notSupported' && !notSupportedAllowed(point)) {
    return `${point.capabilityLabel || point.capability} is required of every provider: it cannot be "not supported".`;
  }
  return null;
}

/** A comment of 1 to MAX_COMMENT characters, trimmed, or null. */
function commentOf(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  return text.length >= 1 && text.length <= MAX_COMMENT ? text : null;
}

const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const isError = (status) => Number.isInteger(status) && status >= 400;

function runLine(r) {
  return `Run ${r.runId} (${[r.code, r.at].filter(Boolean).join(', ')})`;
}

/**
 * The finding a first position opens, from the point (so nothing is typed
 * twice): the createFinding() fields.
 */
function findingFields(point, position) {
  const codes = (point.tests || []).flatMap((t) => t.codes || []);
  const observed = [`Expected: ${point.check}`, point.observed?.text ? `Seen: ${point.observed.text}` : null]
    .filter(Boolean).join('\n');
  return {
    title: clip(`${point.capabilityLabel || point.capability}: ${point.check}`, MAX_TITLE),
    step: point.step || null,
    scenarioCode: codes.length === 1 ? codes[0] : null,
    expectedStatus: isError(point.status) ? point.status : null,
    observed,
    interpretation: '',
    evidence: (point.runs || []).map(runLine).join('\n'),
    category: POSITIONS[position].category,
  };
}

/** What a position changes on the finding: { category, status, severity|null }. */
function findingChange(position) {
  const p = POSITIONS[position];
  return { category: p.category, status: p.status, severity: p.severity || null };
}

/** The thread's line for a position: its label, then the comment. */
const threadText = (position, comment) => `Position: ${POSITIONS[position].label}.\n\n${comment}`;

/** The position as the coverage shows it, from an API finding; null when none. */
function positionView(finding) {
  if (!finding || !isPosition(finding.position)) return null;
  return {
    value: finding.position, label: POSITIONS[finding.position].label, by: finding.positionBy || null,
    role: ROLE_TEXT[finding.positionRole] || null, at: finding.positionAt || null, comment: finding.positionComment || '',
  };
}

/** The choices the page offers, in order: [{ key, label }]. */
const choices = () => Object.entries(POSITIONS).map(([key, p]) => ({ key, label: p.label }));

module.exports = {
  POSITIONS, ROLE_TEXT, MAX_COMMENT, isPosition, notSupportedAllowed, positionRefusal, commentOf, findingFields, findingChange,
  threadText, positionView, choices,
};
