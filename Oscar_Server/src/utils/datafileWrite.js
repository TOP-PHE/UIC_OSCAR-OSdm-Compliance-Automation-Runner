// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileWrite.js — storing a company's datafile built by the server.
 *
 * Used by the Test Config save (PUT /v1/company/datafile/json) and the
 * scenario copy between providers (#540). The caller holds
 * withDatafileLock(company.id) and has already applied the template rule
 * (utils/datafileTemplates); this writes what it is given:
 *   - knownDeviations is the server's projection of the company's findings,
 *     never the caller's (a failure there is logged and the save goes on);
 *   - the file is written encrypted, atomically (temp + rename);
 *   - datafile_path, datafile_hash (sha256 of the plaintext) and
 *     datafile_updated_at are updated.
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { run } = require('../db/db');
const { encryptToFileAsync } = require('./at-rest');
const log = require('./logger').child({ module: 'datafile-write' });

// One live file per company, data/datafiles/{slug}-datafile.json. The slug
// comes from the companies row, never from the request; the prefix check keeps
// that property local to this function.
const DATAFILES_DIR = path.resolve(__dirname, '../../data/datafiles');

function liveDatafilePath(slug) {
  const p = path.resolve(DATAFILES_DIR, `${slug}-datafile.json`);
  if (!p.startsWith(DATAFILES_DIR + path.sep)) {
    throw new Error('Datafile path escaped the datafiles directory.');
  }
  return p;
}

/**
 * Store `datafile` (an object) as the live datafile of `company` ({ id, slug }).
 * Returns { hash, filePath }. Throws when the file cannot be written.
 */
async function writeDatafile(company, datafile) {
  try {
    const { buildProjection } = require('./knownDeviationProjection');
    datafile.knownDeviations = buildProjection(company.id);
  } catch (err) {
    log.warn({ err: err.message, companyId: company.id }, 'datafile write: knownDeviations projection failed');
  }
  const content = JSON.stringify(datafile, null, 4);
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  const filePath = liveDatafilePath(company.slug);
  await encryptToFileAsync(content, filePath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  run(
    `UPDATE companies SET datafile_path = ?, datafile_hash = ?, datafile_updated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [filePath, hash, company.id]
  );
  return { hash, filePath };
}

module.exports = { writeDatafile, liveDatafilePath, DATAFILES_DIR };
