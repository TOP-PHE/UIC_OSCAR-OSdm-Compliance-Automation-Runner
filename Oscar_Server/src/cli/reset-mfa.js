// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reset-mfa.js — removes the second factor of one account, from the server's
 * own shell (#1414).
 *
 * For the administrator who lost their phone when no other administrator can
 * reset it on the Admin page. Whoever can run a command in OSCAR's container
 * holds the database already; nothing here opens a way a person without that
 * access could use. Every session of the account ends; an administrator sets
 * up a new factor at the next sign-in.
 *
 *   VPS (Docker):  cd /opt/OSCAR/OSCAR_Deploy && docker compose exec oscar node src/cli/reset-mfa.js <e-mail>
 *   Kubernetes:    kubectl -n oscar exec deploy/oscar -c oscar -- node src/cli/reset-mfa.js <e-mail>
 *
 * It opens the database by itself (node:sqlite) and loads none of the
 * server's modules: no migration runs, no setting is read but the
 * database's place. The server may keep running meanwhile.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REMOVE_FACTOR_SQL } = require('../utils/mfaReset');

const USAGE = 'usage: node src/cli/reset-mfa.js <e-mail of the account>';

function main(args, { log = console.log, file = process.env.OSCAR_DB_PATH || path.resolve(__dirname, '../../data/oscar.db') } = {}) {
  const email = String(args[0] || '').trim().toLowerCase();
  if (args.length !== 1 || !email.includes('@')) {
    log(USAGE);
    return 2;
  }
  if (!fs.existsSync(file)) {
    log(`no database at ${file}`);
    return 1;
  }
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { timeout: 30000 });
  try {
    const user = db.prepare('SELECT id, company_id, email, role, mfa_enabled_at, mfa_pending_enc FROM users WHERE email = ?').get(email);
    if (!user) {
      log(`no account with the e-mail ${email}`);
      return 1;
    }
    db.prepare(REMOVE_FACTOR_SQL).run(user.id);
    db.prepare("INSERT INTO auth_events (user_id, company_id, email, event_type, created_at) VALUES (?, ?, ?, 'mfa_reset_by_command', datetime('now'))")
      .run(user.id, user.company_id, user.email);
    const had = user.mfa_enabled_at || user.mfa_pending_enc ? 'removed' : 'was not on';
    const next = user.role === 'administrator'
      ? 'a new one is set up at the next sign-in'
      : 'the next sign-in asks for the password only';
    log(`${user.email} (${user.role}): second factor ${had}; every session of the account ended; ${next}.`);
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, USAGE };
