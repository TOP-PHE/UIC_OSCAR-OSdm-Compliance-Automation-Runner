// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileVersion.js — "the data file this page loaded is still the current
 * one" (#540).
 *
 * GET /v1/company/datafile sends an ETag; Test Config sends it back with its
 * save as If-Match (or If-None-Match: * when it loaded no file), and a save
 * made from a version that is no longer current answers 412 instead of
 * writing over what someone else saved in between.
 *
 * The version is of what the person was shown, not of the bytes on disk:
 *   - a tester's is their view (viewForTester, with their run list), so a
 *     colleague saving their own private scenarios does not make every other
 *     tester's page stale; the merge already keeps those;
 *   - knownDeviations is left out for everyone: the server rewrites it when a
 *     finding is baselined, and every save replaces what the page sent anyway;
 *   - `__` annotations are added after the version is taken.
 *
 * Pure: the route reads the file and the run list, this only computes.
 */

const crypto = require('node:crypto');
const { viewForTester } = require('./datafileOwnership');

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The version of `plaintext` (the stored file, Buffer or string) as `viewer`
 * sees it. `viewer` is { role, email, selection } (selection: the tester's run
 * list, or null). A file that is not a JSON object is versioned by its bytes,
 * since that is what GET serves for it.
 */
function datafileVersion(plaintext, viewer) {
  let df = null;
  try { df = JSON.parse(Buffer.isBuffer(plaintext) ? plaintext.toString('utf8') : String(plaintext)); } catch { /* bytes below */ }
  if (!isObj(df)) return sha256(plaintext);
  if (viewer?.role === 'company_user') df = viewForTester(df, viewer.email, viewer.selection ?? null);
  const rest = { ...df };
  delete rest.knownDeviations;
  return sha256(JSON.stringify(rest));
}

const etag = version => `"${version}"`;

// The entity tags of an If-Match / If-None-Match header, as a list: [] when
// there is none, ['*'] for '*', else the quoted tags unquoted. Weak ones
// (W/"…") are compared as strong (RFC 9110 §13.1.1 asks for strong
// comparison; the server never sends weak tags, so a weak one is a client's
// rewrite of ours).
function parseTags(header) {
  if (typeof header !== 'string') return [];
  const value = header.trim();
  if (value === '*') return ['*'];
  return value.split(',')
    .map(t => t.trim().replace(/^W\//, ''))
    .map(t => (t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t))
    .filter(Boolean);
}

/**
 * Whether a save may go ahead. `current` is the version of the stored file as
 * this person sees it, or null when there is no file. Returns null to go
 * ahead, or a sentence for the 412.
 *
 * Neither header: go ahead. A page loaded before this release sends none, and
 * refusing it would stop every save until each open page is reloaded.
 */
function staleSaveRefusal({ ifMatch, ifNoneMatch }, current) {
  const match = parseTags(ifMatch);
  const noneMatch = parseTags(ifNoneMatch);
  if (noneMatch.includes('*') && current !== null) {
    return 'A data file was saved since this page found none. Nothing was saved: reload the page to see it, then make your change again.';
  }
  if (match.length === 0) return null;
  if (current === null) {
    return 'The data file this page loaded has been deleted since. Nothing was saved: reload the page, then make your change again.';
  }
  if (match.includes('*') || match.includes(current)) return null;
  return 'The data file has changed since this page loaded it (another tab or another person saved). Nothing was saved: reload the page to see the current version, then make your change again.';
}

module.exports = { datafileVersion, etag, parseTags, staleSaveRefusal };
