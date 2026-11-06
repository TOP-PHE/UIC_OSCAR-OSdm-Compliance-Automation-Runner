// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A token request's failure as the run log, the run's error and the
 * collection may show it: never a value of the tester's saved credentials,
 * never a quoted answer of the token endpoint (cleanTokenError()).
 */

const { decrypt } = require('../db/db');
const { cleanTokenError } = require('./credentialTestOutcome');

const SECRET_COLUMNS = ['access_token_enc', 'client_id_enc', 'client_secret_enc', 'oauth_extra_enc', 'requestor_enc', 'subscription_key_enc'];

/** The saved values of a tester's credentials row, decrypted. */
function secretsOf(credentialsRow) {
  return SECRET_COLUMNS
    .map((column) => {
      try { return credentialsRow?.[column] ? decrypt(credentialsRow[column]) : null; } catch { return null; }
    })
    .filter(Boolean);
}

/** The message of a token failure, cleaned of every secret of the row. */
function tokenErrorText(err, credentialsRow) {
  return cleanTokenError(err?.message || String(err || ''), secretsOf(credentialsRow));
}

module.exports = { secretsOf, tokenErrorText };
