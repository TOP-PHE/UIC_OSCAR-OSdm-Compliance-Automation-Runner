// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * versionInfo.js — Server / collection version + compatibility check.
 *
 * Reads three sources at boot:
 *   1. Server version  → server's own package.json
 *   2. Collection version → VERSION file in COLLECTION_PATH (single line)
 *   3. Compatibility matrix → compatibility.json (monorepo-level manifest
 *      that lists tested-together combinations)
 *
 * On import, evaluates whether the running combination is listed in the
 * matrix and exposes the result via getVersionInfo() so /health (and any
 * future endpoint) can surface it. Logs a single warning at boot if the
 * combination is not formally tested. Does NOT block startup — operators
 * can always run unsupported combinations at their own risk.
 *
 * Configuration env vars (all optional, sensible fallbacks):
 *   COMPATIBILITY_FILE  — absolute path to compatibility.json
 *                         (default: ../../compatibility.json from this file)
 *   COLLECTION_PATH     — already used elsewhere; we read VERSION from there
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

function readTrimmedSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_e) {
    return null;
  }
}

// ── 1. Server version (from package.json) ─────────────────────────────────────
let serverVersion = 'unknown';
try {
  // Resolve relative to this file: src/utils/versionInfo.js → ../../package.json
  serverVersion = require('../../package.json').version || 'unknown';
} catch (_e) {
  // package.json missing in image is recoverable; just report 'unknown'.
}

// ── 2. Collection version (from VERSION file in COLLECTION_PATH) ──────────────
const COLLECTION_PATH = process.env.COLLECTION_PATH || '';
let collectionVersion = 'unknown';
if (COLLECTION_PATH) {
  const v = readTrimmedSafe(path.join(COLLECTION_PATH, 'VERSION'));
  if (v) collectionVersion = v;
}

// ── 3. Compatibility matrix ───────────────────────────────────────────────────
const COMPAT_FILE = process.env.COMPATIBILITY_FILE
  || path.resolve(__dirname, '../../../compatibility.json');

const compat = readJsonSafe(COMPAT_FILE);

// Find a matching release entry (server == AND collection within range)
function findMatchingRelease(matrix, serverV, collV) {
  if (!matrix || !Array.isArray(matrix.releases)) return null;
  return matrix.releases.find(r => {
    if (r.server !== serverV) return false;
    // Exact match on collection
    if (r.collection === collV) return true;
    // Wildcard pattern (e.g. "OTST_V2.0.x" matches "OTST_V2.0.1")
    if (typeof r.max_collection === 'string' && r.max_collection.endsWith('.x')) {
      const prefix = r.max_collection.slice(0, -1); // "OTST_V2.0."
      if (collV && collV.startsWith(prefix)) return true;
    }
    return false;
  });
}

const matchedRelease = findMatchingRelease(compat, serverVersion, collectionVersion);

// ── Boot-time warning (logged once) ───────────────────────────────────────────
if (!compat) {
  log.warn(
    { compat_file: COMPAT_FILE },
    'compatibility.json not found — server↔collection combo cannot be verified.'
  );
} else if (!matchedRelease) {
  log.warn(
    {
      server_version: serverVersion,
      collection_version: collectionVersion,
      compat_file: COMPAT_FILE,
    },
    'Server↔collection combination is not in compatibility.json. Running at your own risk.'
  );
} else {
  log.info(
    {
      server_version: serverVersion,
      collection_version: collectionVersion,
      release: matchedRelease.release,
    },
    'Server↔collection combination is a tested release.'
  );
}

// ── Public API ────────────────────────────────────────────────────────────────
function getVersionInfo() {
  return {
    server_version:     serverVersion,
    collection_version: collectionVersion,
    release_label:      matchedRelease ? matchedRelease.release : null,
    compatibility_status: matchedRelease
      ? 'tested'
      : (compat ? 'untested_combination' : 'matrix_missing'),
    compatibility_file: COMPAT_FILE,
  };
}

module.exports = { getVersionInfo };
