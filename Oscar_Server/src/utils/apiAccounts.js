// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * apiAccounts.js — the rules of a Company API account (#1342, decision D1).
 *
 * A Company API account is the user a company's own test automation acts as:
 * a row of `users` with the role `api_client`, so its OSDM credentials per
 * provider, its provider access, its runs and the audit log work as they do
 * for a person, and a row of `api_account` for its name and state.
 *
 * It never signs in to OSCAR's pages: it has no password anyone knows, no
 * reset link, no web session (sessionUser() refuses its role). That is what
 * keeps it apart from the page routes, many of which only refuse
 * administrators and certifiers. Its e-mail is made up under `.invalid`
 * (RFC 6761: never resolved, so never delivered), unique, and is only an id.
 *
 * Pure functions: no database, no clock.
 */

const crypto = require('node:crypto');

const ROLE = 'api_client';
const MAX_NAME = 60;
const MAX_PER_COMPANY = 20;
const EMAIL_DOMAIN = 'api-account.invalid';

/** Whether a stored or normalised role is a Company API account's. */
function isApiAccountRole(role) {
  return role === ROLE;
}

/**
 * A name as given: { name } trimmed, or { error }. Printable text, 1 to 60
 * characters, no line break or control character.
 */
function nameOf(value) {
  if (typeof value !== 'string') return { error: 'name is required: a text of 1 to 60 characters.' };
  const name = value.trim();
  if (name === '' || name.length > MAX_NAME) return { error: `name must be 1 to ${MAX_NAME} characters.` };
  // Any character below the space, DEL and the C1 controls.
  for (const ch of name) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return { error: 'name must not hold control characters or line breaks.' };
  }
  return { name };
}

/** The name's letters and digits, lower case, joined by single dashes, at most 30. */
function slugOf(name) {
  // NFD writes an accented letter as the letter and a combining mark
  // (U+0300 to U+036F): the mark is skipped, so "É" counts as "e".
  const plain = String(name).normalize('NFD').toLowerCase();
  let out = '';
  let dash = false;
  for (const ch of plain) {
    const code = ch.codePointAt(0);
    if (code >= 0x300 && code <= 0x36f) continue;
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      if (dash && out) out += '-';
      out += ch;
      dash = false;
    } else {
      dash = true;
    }
    if (out.length >= 30) break;
  }
  return out.slice(0, 30) || 'account';
}

/** A made-up, never delivered, unique e-mail for an account of that name. */
function emailFor(name, random = crypto.randomBytes(4).toString('hex')) {
  return `${slugOf(name)}.${random}@${EMAIL_DOMAIN}`;
}

/**
 * A list of provider ids as given: { ids } (distinct strings), or { error }.
 * Absent = none. Each id is checked against the company by the route.
 */
function providerIdsOf(value) {
  if (value === undefined || value === null) return { ids: [] };
  if (!Array.isArray(value) || value.length > 100) return { error: 'providers must be a list of provider ids.' };
  const ids = [];
  for (const id of value) {
    if (typeof id !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(id)) return { error: 'providers must be a list of provider ids.' };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids };
}

module.exports = {
  ROLE, MAX_NAME, MAX_PER_COMPANY, EMAIL_DOMAIN,
  isApiAccountRole, nameOf, slugOf, emailFor, providerIdsOf,
};
