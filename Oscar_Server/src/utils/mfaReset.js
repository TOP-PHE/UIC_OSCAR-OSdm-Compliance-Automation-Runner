// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mfaReset.js — what removing an account's second factor writes (#1414), pure.
 *
 * Shared by the server (api/helpers/mfa.js: an administrator's reset, an
 * account turning its own factor off) and by the command run on the server
 * for the last administrator (src/cli/reset-mfa.js), which opens the
 * database by itself and must not load the server's modules. Every session
 * of the account ends in the same UPDATE, as for a password change.
 */

const REMOVE_FACTOR_SET = [
  'mfa_secret_enc = NULL',
  'mfa_pending_enc = NULL',
  'mfa_enabled_at = NULL',
  'mfa_last_step = NULL',
  'mfa_failures = 0',
  'mfa_failures_since = NULL',
  "sessions_valid_after = CAST(strftime('%s','now') AS INTEGER)",
].join(', ');

const REMOVE_FACTOR_SQL = `UPDATE users SET ${REMOVE_FACTOR_SET} WHERE id = ?`;

module.exports = { REMOVE_FACTOR_SET, REMOVE_FACTOR_SQL };
