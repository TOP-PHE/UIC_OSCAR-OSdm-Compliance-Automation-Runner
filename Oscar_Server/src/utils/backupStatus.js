// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * backupStatus.js — the disaster-recovery status the Admin Dashboard shows
 * (#572). Read only.
 *
 * The host's backup scripts write `data/backup-status.json`
 * (`OSCAR_Deploy/scripts/oscar-backup-status.sh`): dates, a size, counts and
 * the frequency. This module reads that file and answers only the members it
 * knows, each checked for its type, so nothing else the file might hold
 * reaches the page. There is no write path: creating, scheduling or
 * downloading a backup stays a host operation (#543, #572).
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 16 * 1024;
const FREQUENCIES = Object.freeze(['daily', 'weekly', 'monthly', 'custom', 'on-demand']);
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATES = Object.freeze(['updated_at', 'next_run', 'last_backup_at', 'last_success_at', 'last_failure_at', 'last_restore_drill_at']);
const COUNTS = Object.freeze(['retention_keep', 'archives_present', 'last_backup_size_bytes']);

/** Where the scripts write it: next to the database, in data/. */
function statusPath(env = process.env) {
  if (env.OSCAR_BACKUP_STATUS_PATH) return env.OSCAR_BACKUP_STATUS_PATH;
  const db = env.OSCAR_DB_PATH || path.resolve(__dirname, '../../data/oscar.db');
  return path.join(path.dirname(db), 'backup-status.json');
}

const instant = (v) => (typeof v === 'string' && INSTANT.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * The page's view of a parsed status file, `now` a Date. Unknown members are
 * dropped; a member of the wrong type reads as null.
 */
function viewOf(raw, now = new Date()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'unreadable' };
  const view = { state: 'reported' };
  for (const k of DATES) view[k] = instant(raw[k]);
  for (const k of COUNTS) view[k] = count(raw[k]);
  view.frequency = FREQUENCIES.includes(raw.frequency) ? raw.frequency : null;
  view.last_backup_ok = typeof raw.last_backup_ok === 'boolean' ? raw.last_backup_ok : null;
  // What the page warns about, worked out here so it is tested once.
  const warnings = [];
  if (view.last_backup_ok === false) warnings.push('last_backup_failed');
  if (view.next_run && Date.parse(view.next_run) < now.getTime()) warnings.push('next_run_past');
  if (view.retention_keep !== null && view.archives_present !== null && view.archives_present > view.retention_keep) warnings.push('more_archives_than_kept');
  if (!view.last_restore_drill_at) warnings.push('no_restore_drill');
  view.warnings = warnings;
  return view;
}

/** Read the file: { state: 'none' } when there is none yet. */
function readBackupStatus({ file = statusPath(), now = new Date() } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { state: 'none' }; }
  if (!stat.isFile() || stat.size > MAX_BYTES) return { state: 'unreadable' };
  try {
    return viewOf(JSON.parse(fs.readFileSync(file, 'utf8')), now);
  } catch {
    return { state: 'unreadable' };
  }
}

module.exports = { statusPath, viewOf, readBackupStatus, FREQUENCIES, MAX_BYTES };
