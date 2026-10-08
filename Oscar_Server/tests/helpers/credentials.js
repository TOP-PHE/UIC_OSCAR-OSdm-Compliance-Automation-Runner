// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Test fixtures written before #540 put a tester's credentials on the users
 * row. The server now reads them from tester_credentials, per (user, company).
 * credentialsAsMigrated(userId) does for one user what migration 29 did for
 * every user: copies the users-row credentials into a row for the user's own
 * company. Fixtures call it right after inserting the user.
 */

const { run } = require('../../src/db/db');

function credentialsAsMigrated(userId) {
  run(`INSERT OR REPLACE INTO tester_credentials
         (user_id, company_id, auth_mode, access_token_enc, client_id_enc, client_secret_enc,
          token_url, oauth_profile, oauth_scope, oauth_extra_enc, oauth_custom_template,
          cached_token_enc, cached_token_expires_at, cached_token_cred_fp,
          requestor_enc, subscription_key_enc)
       SELECT id, company_id, auth_mode, access_token_enc, client_id_enc, client_secret_enc,
          token_url, oauth_profile, oauth_scope, oauth_extra_enc, oauth_custom_template,
          cached_token_enc, cached_token_expires_at, cached_token_cred_fp,
          requestor_enc, subscription_key_enc
       FROM users WHERE id = ?`, [userId]);
}

module.exports = { credentialsAsMigrated };
