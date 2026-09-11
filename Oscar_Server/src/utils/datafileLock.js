// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileLock.js — one datafile write at a time, per company (v1.11.197).
 *
 * A tester's save is now read-merge-write: read the stored file, merge their
 * scenarios in, write it back. The handler awaits between the read and the
 * write, so two saves arriving together could interleave and the second would
 * overwrite the first one's scenarios — one tester's work silently lost. The
 * findings re-projection (utils/knownDeviationProjection) has always been
 * read-modify-write too. Every datafile writer goes through here.
 *
 * In-process on purpose: OSCAR is a single Node process (one container, see
 * the Watchtower deploy). A second process would need a file lock instead.
 */

const chains = new Map();

/**
 * Run fn after every earlier call for the same key has settled, whatever its
 * outcome. Resolves or rejects with fn's own result.
 */
function withDatafileLock(key, fn) {
  const previous = chains.get(key) || Promise.resolve();
  const result = previous.then(() => fn());
  const settled = result.then(() => {}, () => {});
  chains.set(key, settled);
  settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return result;
}

module.exports = { withDatafileLock };
