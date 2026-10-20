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
 *   tester             | Yes                         | Only providers of their company
 *                      |                             | listed for them in provider_access
 *   test_manager       | Yes                         | Every provider of their company
 *   certification_user | n/a (no own company)        | Only runs explicitly shared with
 *                      |                             | certifier (per-run flag set by
 *                      |                             | the company's test_manager)
 *   administrator      | n/a (platform company)      | NO — admin role no longer reads
 *                      |                             | test data (issue #60 strict mode)
 *   api_key (#503)     | Only the key's company or   | No
 *                      | provider, not its children  |
 *
 * The strict admin posture is the v1.10.0 change. Before this release
 * administrators had blanket read access; now their role is operations +
 * security only. The break-glass override has not been implemented; if a
 * future release adds one, it goes here with explicit audit logging.
 */

const { get } = require('../../db/db');
const { canUseCompany } = require('./provider-access');

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

  // Tester / test_manager: the run's company must be one they may act in,
  // their own or a provider of it (#540) — the rule enforceTenant uses.
  if (user.role === 'tester' || user.role === 'company_user' || user.role === 'test_manager') {
    return canUseCompany(user, run.company_id) ? run : null;
  }

  // API key (#503): the runs of the one company or provider the key was made
  // for, never its providers. requireApiKey has checked that the key's
  // creator may still use that company.
  if (user.role === 'api_key') {
    const keyCompany = user.keyCompanyId;
    return typeof keyCompany === 'string' && keyCompany !== '' && run.company_id === keyCompany ? run : null;
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

/**
 * #901: canUserSeeRun(), or else a run shared with the reader's company
 * (helpers/run-shares.js). For READ routes only: the run comes back with a
 * non-enumerable `sharedView` ({ distributor, provider }) when it is read
 * through a share, so the route shows it as the company shared with sees it
 * (utils/sharedRunView.js). Every route that changes a run, or writes
 * anything about it, keeps canUserSeeRun(): a share never lets the other
 * company delete, cancel, re-share or compare the distributor's runs.
 */
function canUserReadRun(runId, user) {
  const own = canUserSeeRun(runId, user);
  if (own) return own;
  if (!runId || user?.role !== 'test_manager') return null;
  const run = get(
    "SELECT * FROM runs WHERE id = ? AND status NOT IN ('DELETED', 'DELETION_REQUESTED', 'DELETED_BY_ADMIN')",
    [runId],
  );
  if (!run) return null;
  const view = require('./run-shares').sharedViewOf(run, user);
  if (!view) return null;
  Object.defineProperty(run, 'sharedView', { value: view, enumerable: false });
  return run;
}

module.exports = { canUserSeeRun, canUserReadRun };
