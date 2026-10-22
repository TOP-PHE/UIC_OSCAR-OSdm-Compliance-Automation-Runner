// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * referenceStore.js — the reference configurations as the server reads them
 * (#838 PR 2).
 *
 * They are read from the collection the runs use (COLLECTION_PATH), which
 * refresh-collection.yml pulls from the repository on every push to main:
 * no call to GitHub. In a checkout the repository's own copy is the fallback,
 * as for the data file schema (datafileSchema.js). Each read is fresh, since
 * the collection is updated in place without a restart.
 *
 * A reference is named by one of a fixed list (`simulator-alpha`…), never by
 * a path from the request.
 */

const fs = require('node:fs');
const path = require('node:path');
const R = require('./referenceConfiguration');

const NAMES = Object.freeze(R.PROVIDERS.map(R.referenceName));

function dataBaseCandidates() {
  const collection = path.resolve(process.env.COLLECTION_PATH || '/collection');
  return [
    path.join(collection, 'data_base'),
    path.resolve(__dirname, '../../../Bruno_Collection/data_base'),
  ];
}

/**
 * The reference `name` with its data file: { reference, datafile, version }
 * or null when the name is not one of the list or no copy can be read.
 */
function loadReference(name) {
  if (!NAMES.includes(name)) return null;
  for (const dir of dataBaseCandidates()) {
    try {
      const reference = JSON.parse(fs.readFileSync(path.join(dir, 'reference', `${name}.json`), 'utf8'));
      const datafile = JSON.parse(fs.readFileSync(path.join(dir, R.DATAFILE_NAME), 'utf8'));
      return { reference, datafile, version: R.versionOf(reference, datafile) };
    } catch {
      // Not in this copy: the next one.
    }
  }
  return null;
}

/** The references the server can read: [{ name, provider, osdmVersion }]. */
function availableReferences() {
  return NAMES.map((name) => {
    const loaded = loadReference(name);
    if (!loaded) return null;
    const meta = loaded.reference[R.REFERENCE_KEY] || {};
    return { name, provider: meta.provider || null, osdmVersion: meta.osdmVersion || null };
  }).filter(Boolean);
}

module.exports = { NAMES, loadReference, availableReferences };
