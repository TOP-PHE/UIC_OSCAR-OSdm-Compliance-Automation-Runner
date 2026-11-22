// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bodyLimits.js — how large a JSON body OSCAR reads, and when (#1371).
 *
 * One parser of 5 MB used to come first on every route, sized for the
 * largest data file: a body of that size was read and parsed on the server's
 * one thread before any route's authentication or rate limit, for a caller
 * who was then refused. Now:
 *
 *   - every route reads at most GENERAL_JSON_LIMIT, which is far above what
 *     any of them takes;
 *   - the Test Config save, PUT /v1/company/datafile/json, is left alone by
 *     the general parser and reads up to DATAFILE_JSON_LIMIT with a parser of
 *     its own, placed after the route's authorisation (routes/company.js):
 *     authorise before you parse, as the data file upload does.
 */

const express = require('express');

const GENERAL_JSON_LIMIT = '1mb';
const DATAFILE_JSON_LIMIT = '5mb';

// Express matches a route without case and with or without a last slash.
const DATAFILE_SAVE_PATH = /^\/v1\/company\/datafile\/json\/?$/i;

/** True for the one request whose JSON is read by the route's own parser. */
function isDatafileSave(req) {
  return req?.method === 'PUT' && typeof req.path === 'string' && DATAFILE_SAVE_PATH.test(req.path);
}

/** The JSON parser of every route but the data file save. */
function generalJsonParser() {
  const parse = express.json({ limit: GENERAL_JSON_LIMIT });
  return (req, res, next) => (isDatafileSave(req) ? next() : parse(req, res, next));
}

/** The data file save's own parser: put it after the route's authorisation. */
function datafileJsonParser() {
  return express.json({ limit: DATAFILE_JSON_LIMIT });
}

/**
 * The 413's sentence: it names the limit that applied, which the parser gives
 * in bytes (1 MB for a route, 5 MB for the data file save).
 */
function tooLargeText(limitBytes) {
  const megabytes = Number(limitBytes) / (1024 * 1024);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return 'The request body is too large.';
  return `The request body is larger than ${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB.`;
}

module.exports = { GENERAL_JSON_LIMIT, DATAFILE_JSON_LIMIT, isDatafileSave, generalJsonParser, datafileJsonParser, tooLargeText };
