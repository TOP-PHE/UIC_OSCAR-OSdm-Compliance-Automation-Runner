// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bootstrapToken.js — the first administrator of an installation (#1365).
 *
 * POST /v1/auth/bootstrap/platform-user (routes/auth.js) creates an account
 * with the password sent, on the word of PLATFORM_BOOTSTRAP_TOKEN alone. It
 * is there for the first administrator: once an active one exists it creates
 * nobody, and every other account is made by invitation, its owner choosing
 * the password. With no active administrator (a new installation, or every
 * administrator suspended or deleted) it works: the way back in for an
 * installation locked out, for whoever can set the token on the server.
 *
 * A token left in the environment after that is of no use: the server says
 * so at its start and Server Config shows it, until it is removed.
 */

const { get } = require('../db/db');

/**
 * True when an administrator who can sign in exists (status active, as
 * sessionUser() asks): the bootstrap route then creates nobody.
 */
function administratorExists() {
  return Boolean(get("SELECT 1 AS ok FROM users WHERE role = 'administrator' AND status = 'active' LIMIT 1"));
}

/** True when the environment holds a bootstrap token. */
function tokenSet(env = process.env) {
  return typeof env.PLATFORM_BOOTSTRAP_TOKEN === 'string' && env.PLATFORM_BOOTSTRAP_TOKEN !== '';
}

// The route's refusal once an administrator exists.
const ALREADY_AN_ADMINISTRATOR = 'An administrator already exists: this route creates the first one only. '
  + 'Further administrators and certifiers are invited from Admin → Manage Users. '
  + "Remove PLATFORM_BOOTSTRAP_TOKEN from the server's environment.";

/**
 * What the server says once at its start, or null when there is nothing to
 * say: { level, text }. `set` is tokenSet(), `exists` administratorExists().
 */
function startLine(set, exists) {
  if (!set) return null;
  if (exists) {
    return {
      level: 'warn',
      text: 'PLATFORM_BOOTSTRAP_TOKEN is still set and an administrator exists: the bootstrap route creates no account any more. '
        + "Remove the token from the server's environment and create the server again.",
    };
  }
  return { level: 'info', text: 'PLATFORM_BOOTSTRAP_TOKEN is set and no administrator exists yet: the bootstrap route creates the first one.' };
}

module.exports = { administratorExists, tokenSet, startLine, ALREADY_AN_ADMINISTRATOR };
