// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fileNames.js — a download's file name starts with the company or provider
 * it is about (#1002), so that a distributor's files for several providers
 * keep apart. Pure.
 *
 * Letters and digits only, accents dropped (Č → C), every other run of
 * characters one dash, 60 characters at most: the name is always safe in a
 * Content-Disposition header. The page's coverageFilePrefix() is the same
 * rule (pinned by ui-scripts.test.js).
 */

const MAX_PREFIX = 60;

/** The start of a file name made from a company's name; '' when nothing is left. */
function fileNamePrefix(name) {
  const plain = String(name ?? '').normalize('NFKD').replace(/\p{M}/gu, '');
  // Runs are one dash after the first replace, so one dash at most is left at each end.
  return plain.replace(/[^A-Za-z0-9]+/g, '-').slice(0, MAX_PREFIX).replace(/^-|-$/g, '');
}

/** "<prefix>-<rest>", or `rest` alone when the name gives no prefix. */
function fileNameFor(name, rest) {
  const prefix = fileNamePrefix(name);
  return prefix ? `${prefix}-${rest}` : rest;
}

module.exports = { fileNamePrefix, fileNameFor, MAX_PREFIX };
