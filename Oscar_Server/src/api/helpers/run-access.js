// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-access.js — single source of truth for "can this user see this run".
 *
 * Centralises the per-run visibility rules introduced/tightened in v1.10.0
 * (issue #60). Every endpoint that returns run-scoped data — JSON results,
 * artifacts, HTTP traffic, assertions, comparison snapshots — calls
 * canUserSeeRun() before disclosing anything. Returns either the run row
 * or null; null means "treat as not-found" (we never disclose existence
 * to a user who shouldn't see it, mirroring the v15 certifier privacy
 * guard).
 *
 * Visibility matrix (v1.10.0):
 *
 *   Role               | Can see runs in own company | Can see runs in other companies
 *   -------------------+-----------------------------+----------------------------------
 *   tester             | Yes                         | No
 *   test_manager       | Yes                         | No
 *   certification_user | n/a (no own company)        | Only runs explicitly shared with
 *                      |                             | certifier (per-run flag set by
 *                      |                             | the company's test_manager)
 *   administrator      | n/a (platform company)      | NO — admin role no longer reads
 *                      |                             | test data (issue #60 strict mode)
 *
 * The strict admin posture is the v1.10.0 change. Before this release
 * administrators had blanket read access; now their role is operations +
 * security only. The break-glass override has not been implemented; if a
 * future release adds one, it goes here with explicit audit logging.
 */

const { get } = require('../../db/db');

/**
 * Resolve a run for the given user. Returns the run row if the user is
 * permitted to see it, null otherwise. Never throws.
 */
function canUserSeeRun(runId, user) {
  if (!runId || !user) return null;

  // DELETED runs are always hidden — they're tombstoned for audit but no
  // longer surfaced to anyone.
  const run = get(
    "SELECT * FROM runs WHERE id = ? AND status != 'DELETED'",
    [runId],
  );
  if (!run) return null;

  // Administrator: locked out of test-data read. Operations role only.
  if (user.role === 'administrator') return null;

  // Tester / test_manager: must own the run's company.
  if (user.role === 'tester' || user.role === 'company_user' || user.role === 'test_manager') {
    return run.company_id === user.companyId ? run : null;
  }

  // Certifier: only sees runs the test_manager has explicitly shared.
  // Sole gate (v1.11.15): the per-run shared_with_certifier_at column is set.
  // The legacy company-wide share_reports_with_certifier master toggle was
  // removed — sharing is now decided per-report by the test_manager from the
  // dashboard. Default is private (column null → certifier sees nothing).
  if (user.role === 'certification_user') {
    return run.shared_with_certifier_at ? run : null;
  }

  // Unknown role — fail closed.
  return null;
}

module.exports = { canUserSeeRun };
