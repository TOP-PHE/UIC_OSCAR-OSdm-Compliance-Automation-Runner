// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Deleting an account: the one place both the administrator's and the Test
 * Manager's Delete go through. Every table naming the user either follows by
 * itself (ON DELETE CASCADE / SET NULL) or is handled here; the account's runs
 * go with it, their requests, checks and logs by cascade.
 */

const { run, transaction } = require('../db/db');

function deleteUserAccount(userId) {
  transaction(() => {
    // The login history stays, without the account.
    run('UPDATE auth_events SET user_id = NULL WHERE user_id = ?', [userId]);
    // Comparisons naming one of its runs, and its report templates: no cascade.
    run(`DELETE FROM report_comparisons
         WHERE run_a_id IN (SELECT id FROM runs WHERE user_id = ?)
            OR run_b_id IN (SELECT id FROM runs WHERE user_id = ?)`, [userId, userId]);
    run('DELETE FROM report_templates WHERE user_id = ?', [userId]);
    run('DELETE FROM runs WHERE user_id = ?', [userId]);
    run('DELETE FROM users WHERE id = ?', [userId]);
  });
}

module.exports = { deleteUserAccount };
