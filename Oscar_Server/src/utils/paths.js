// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * paths.js — Filesystem path-traversal guards.
 *
 * Centralised validators / safe-join helpers used wherever a user- or
 * caller-supplied identifier is concatenated into a filesystem path.
 * Sonar (rule "Tainted path traversal", CWE-22) flags every such
 * concatenation as a vulnerability unless it can prove the input is
 * sanitised; routing every untrusted path component through these
 * helpers makes that proof local and explicit.
 */

const path = require('path');

// UUID v4 in the canonical 8-4-4-4-12 hex layout. We don't accept braces,
// upper/lower mixing in the hyphens, or trailing garbage. Run IDs and
// company IDs both originate as `uuid.v4()`, so this regex matches the
// generator's output exactly.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Returns true if the value looks like a UUID. Returns false for null,
 * undefined, non-strings, empty strings, and anything containing path
 * separators or "..".
 */
function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/**
 * Joins `untrusted` (a single path component) onto `baseDir` and verifies
 * the resolved absolute path stays inside `baseDir`. Returns the resolved
 * absolute path, or null if the input fails validation.
 *
 * Use this for run IDs / company IDs / artifact IDs / any other UUID-shaped
 * identifier that the caller wants to use as a directory or filename
 * segment under a known base directory.
 *
 * Why not just regex-validate? Defence in depth — even if a future change
 * widens the regex (e.g. accepting collection codes that aren't UUIDs),
 * the absolute-path containment check still blocks traversal.
 */
function safeJoinUuid(baseDir, untrusted, ...rest) {
  if (!isUuid(untrusted)) return null;

  const resolved = path.resolve(baseDir, untrusted, ...rest);
  // path.sep guards against the "/foo" + "bar" → "/foobar" trick where
  // baseDir doesn't end with a separator. We append it explicitly.
  const baseWithSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(baseWithSep)) return null;
  return resolved;
}

module.exports = {
  isUuid,
  safeJoinUuid,
  UUID_RE,
};
