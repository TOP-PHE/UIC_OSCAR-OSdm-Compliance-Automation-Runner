// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A company's data files are named after its slug ({slug}-datafile.json and
 * {slug}-datafile.previous.json). When the slug changes, the files follow, so
 * Restore previous file and the company's deletion still find them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { all, run } = require('../db/db');
const { liveDatafilePath, previousDatafilePath, DATAFILES_DIR } = require('./datafileWrite');
const log = require('./logger').child({ module: 'datafile-rename' });

const LIVE_SUFFIX = '-datafile.json';

// The previous file that goes with a live file of the data files folder, or null.
function previousOf(livePath) {
  if (path.dirname(livePath) !== DATAFILES_DIR || !livePath.endsWith(LIVE_SUFFIX)) return null;
  return `${livePath.slice(0, -LIVE_SUFFIX.length)}-datafile.previous.json`;
}

/**
 * The renames that give the files at `livePath` the name of `newSlug`:
 * { moves: [[from, to]…] } or { refusal } when a file already has a new name.
 */
function planMove(livePath, newSlug) {
  const newLive = liveDatafilePath(newSlug);
  if (!livePath || path.resolve(livePath) === newLive) return { moves: [] };
  const pairs = [[path.resolve(livePath), newLive], [previousOf(path.resolve(livePath)), previousDatafilePath(newSlug)]]
    .filter(([from]) => from && fs.existsSync(from));
  if (pairs.some(([, to]) => fs.existsSync(to))) {
    return { refusal: 'A data file already has the name this slug gives; remove it from the server first.' };
  }
  return { moves: pairs };
}

/** Renames the files; undoes the ones done when one fails, then throws. */
function applyMoves(moves) {
  const done = [];
  try {
    for (const [from, to] of moves) { fs.renameSync(from, to); done.push([from, to]); }
  } catch (err) {
    for (const [from, to] of done.reverse()) {
      try { fs.renameSync(to, from); } catch { /* left as it is; logged below */ }
    }
    throw err;
  }
  return () => { for (const [from, to] of [...moves].reverse()) fs.renameSync(to, from); };
}

/**
 * Once at start: a company whose live file does not carry its slug's name
 * (its slug was changed before 1.11.471) gets its files renamed.
 */
function alignDatafileNames() {
  for (const company of all('SELECT id, slug, datafile_path FROM companies WHERE datafile_path IS NOT NULL')) {
    try {
      if (path.dirname(path.resolve(company.datafile_path)) !== DATAFILES_DIR) continue;
      const plan = planMove(company.datafile_path, company.slug);
      if (plan.refusal || plan.moves.length === 0) continue;
      applyMoves(plan.moves);
      if (plan.moves[0][0] === path.resolve(company.datafile_path)) {
        run('UPDATE companies SET datafile_path = ? WHERE id = ?', [liveDatafilePath(company.slug), company.id]);
      }
      log.info({ companyId: company.id }, 'data files renamed after the slug');
    } catch (err) {
      log.warn({ companyId: company.id, err: err.message }, 'data files not renamed after the slug');
    }
  }
}

module.exports = { planMove, applyMoves, alignDatafileNames };
