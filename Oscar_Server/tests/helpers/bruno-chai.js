// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The part of chai's BDD `expect` that the tested validators use (bookings.js,
 * offers.js, exchanges.js, osdmEnums.js),
 * for running a validator's own assertions in a unit test (extend it as other
 * validators need). Bruno supplies chai inside its sandbox; the server has no
 * chai dependency.
 *
 * withBrunoExpect(fn) installs it as the global `expect` while fn runs and
 * puts Jest's back afterwards. Assertions are recorded by a mocked
 * testCapture.js (see bruno-bookings-part-pairing.test.js).
 */

const { isDeepStrictEqual } = require('node:util');

const sorted = (list) => list.map((v) => JSON.stringify(v)).sort((a, b) => a.localeCompare(b));

function chaiExpect(actual, message) {
  let negate = false;
  const describe = () => JSON.stringify(actual);
  const check = (ok, text) => {
    if (negate ? ok : !ok) throw new Error(message || `expected ${describe()} ${negate ? 'not ' : ''}${text}`);
    return api;
  };
  const api = {
    eql: (v) => check(isDeepStrictEqual(actual, v), `to deeply equal ${JSON.stringify(v)}`),
    include: (v, m) => {
      if (m) message = m;
      return check((Array.isArray(actual) || typeof actual === 'string') && actual.includes(v), `to include ${JSON.stringify(v)}`);
    },
    a: (type) => check(type === 'array' ? Array.isArray(actual) : typeof actual === type, `to be a ${type}`),
    above: (n) => check(actual > n, `to be above ${n}`),
    below: (n, m) => { if (m) message = m; return check(actual < n, `to be below ${n}`); },
    members: (arr) => check(Array.isArray(actual) && isDeepStrictEqual(sorted(actual), sorted(arr)), `to have members ${JSON.stringify(arr)}`),
    lengthOf: (n) => check(actual != null && actual.length === n, `to have length ${n}`),
    equal: (v, m) => { if (m) message = m; return check(actual === v, `to equal ${JSON.stringify(v)}`); },
    oneOf: (list, m) => { if (m) message = m; return check(Array.isArray(list) && list.includes(actual), `to be one of ${JSON.stringify(list)}`); },
    property: (name) => check(actual != null && Object.prototype.hasOwnProperty.call(actual, name), `to have property ${name}`),
    least: (n, m) => { if (m) message = m; return check(actual >= n, `to be at least ${n}`); },
    most: (n, m) => { if (m) message = m; return check(actual <= n, `to be at most ${n}`); },
  };
  api.an = api.a;
  const getters = {
    exist: () => check(actual != null, 'to exist'),
    empty: () => check(actual != null && actual.length === 0, 'to be empty'),
    true: () => check(actual === true, 'to be true'),
    false: () => check(actual === false, 'to be false'),
    not: () => { negate = !negate; return api; },
  };
  ['to', 'be', 'and', 'have', 'with', 'at', 'that', 'is', 'of'].forEach((w) => { getters[w] = () => api; });
  Object.entries(getters).forEach(([name, get]) => Object.defineProperty(api, name, { get }));
  return api;
}

function withBrunoExpect(fn) {
  const jestExpect = global.expect;
  global.expect = chaiExpect;
  try {
    return fn();
  } finally {
    global.expect = jestExpect;
  }
}

module.exports = { chaiExpect, withBrunoExpect };
