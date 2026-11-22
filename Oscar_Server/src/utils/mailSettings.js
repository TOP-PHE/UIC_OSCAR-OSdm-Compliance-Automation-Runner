// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mailSettings.js — where the mail server's settings come from (#1363).
 *
 * The mail server is part of the deployment, as the encryption key and the
 * collection path are: it is set where the server is installed. When the
 * environment names one (SMTP_HOST), every mail setting is read from the
 * environment and what server_config holds for them is not read. Until then
 * the settings an earlier version saved from Server Config keep working
 * ("stored"), so no e-mail stops at an upgrade.
 *
 * No page writes a mail setting: PATCH /v1/admin/config refuses them
 * (routes/admin.js), and db.js getConfig() asks this module first.
 *
 * Pure: the environment is given (process.env by default) and nothing is
 * read from the database here.
 */

const MAIL_KEYS = Object.freeze(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
const MAIL_KEY_SET = new Set(MAIL_KEYS);

/** True for a setting of the mail server. */
const isMailKey = key => MAIL_KEY_SET.has(key);

const textOf = value => (typeof value === 'string' ? value.trim() : '');

/** True when the environment names a mail server: its values are the ones in use. */
function fromEnvironment(env = process.env) {
  return textOf(env.SMTP_HOST) !== '';
}

/** A mail setting as the environment gives it, or null when it gives none. */
function environmentValue(key, env = process.env) {
  if (!isMailKey(key)) return null;
  const value = textOf(env[key]);
  return value === '' ? null : value;
}

/**
 * Where the mail settings in use come from:
 *   'environment'  the environment names a mail server;
 *   'stored'       it names none, and server_config holds one, saved from
 *                  Server Config by an earlier version;
 *   'none'         no mail server anywhere: no e-mail is sent.
 * `storedHost` is server_config's SMTP_HOST, if any.
 */
function sourceOf(storedHost, env = process.env) {
  if (fromEnvironment(env)) return 'environment';
  return textOf(storedHost) === '' ? 'none' : 'stored';
}

// What a mail setting is when nothing gives it (the mailer's own defaults).
const DEFAULTS = Object.freeze({ SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_FROM: 'OSCAR Platform <noreply@oscar.uic.org>' });

/**
 * The names of the settings saved earlier (`stored`: { KEY: value }) that the
 * environment now replaces with another value; none when the environment
 * names no mail server. An `.env` may still hold the mail server of the
 * first installation, changed since from the page: at the upgrade that old
 * one becomes the one read, and this is what says so. Names only, never a value.
 */
function replacedByEnvironment(stored, env = process.env) {
  if (!fromEnvironment(env)) return [];
  return MAIL_KEYS.filter((key) => {
    const kept = textOf(stored?.[key]);
    if (kept === '') return false;
    return kept !== (environmentValue(key, env) ?? DEFAULTS[key] ?? '');
  });
}

/**
 * What the server says once at its start about them: { level, text }.
 * `replaced`: replacedByEnvironment()'s names.
 */
function startLine(source, replaced = []) {
  if (source === 'environment' && replaced.length > 0) {
    return {
      level: 'warn',
      text: "Mail settings: read from the server's environment. The ones saved earlier from Server Config are no longer read, "
        + `and held another value for: ${replaced.join(', ')}. Check that the environment's are the current ones `
        + '(Server Config shows them and sends a test e-mail).',
    };
  }
  if (source === 'environment') return { level: 'info', text: "Mail settings: read from the server's environment." };
  if (source === 'stored') {
    return {
      level: 'warn',
      text: 'Mail settings: read from the database, where an earlier version saved them from Server Config. '
        + "They are no longer changed from the page: set SMTP_HOST and the other SMTP_* values in the server's environment, "
        + 'which is then the one read.',
    };
  }
  return { level: 'info', text: "Mail settings: no mail server is set (SMTP_HOST in the server's environment): no e-mail is sent." };
}

module.exports = { MAIL_KEYS, isMailKey, fromEnvironment, environmentValue, sourceOf, replacedByEnvironment, startLine };
