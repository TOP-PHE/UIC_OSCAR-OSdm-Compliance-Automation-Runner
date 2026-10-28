// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileWriteLimit.js — the limit on data file writes (#1025), pure.
 *
 * Every route that writes a company's data file (save, upload, restore,
 * delete, reference choice and update, configuration import) shares one
 * limiter. It used to count 20 writes per 15 minutes per address: one person
 * setting up six providers ran out, and two people behind one address shared
 * it. It now counts per user and company or provider.
 */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_WRITES = 60;

/** The bucket: the user and the company or provider the request acts on. */
function writeKeyOf(req, addressKey) {
  const user = req.user?.id;
  if (!user) return `datafile-address:${addressKey}`;
  return `datafile:${user}:${req.companyId ?? ''}`;
}

/** Whole minutes until the window resets, at least 1. */
function minutesUntil(resetTime, now = Date.now()) {
  const reset = resetTime instanceof Date ? resetTime.getTime() : Number(resetTime);
  if (!Number.isFinite(reset)) return Math.ceil(WINDOW_MS / 60000);
  return Math.max(1, Math.ceil((reset - now) / 60000));
}

/** The 429's body: what was refused, for how long, and that nothing is lost. */
function limitProblem(resetTime, now = Date.now()) {
  const minutes = minutesUntil(resetTime, now);
  return {
    status: 429,
    title: 'Too Many Requests',
    detail: `Too many data file changes for this company or provider (${MAX_WRITES} in ${WINDOW_MS / 60000} minutes). `
      + `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}. `
      + 'Unsaved edits stay on the page: do not reload it.',
  };
}

module.exports = { WINDOW_MS, MAX_WRITES, writeKeyOf, minutesUntil, limitProblem };
