// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #833: a booking read answered with something that is not a JSON object (a
 * gateway's HTML page, the simulator fault answer.html) fails by name and
 * stops the scenario, instead of crashing the step's script.
 */

const env = {};
const tests = [];
let stopped = 0;
global.bru = {
  getEnvVar: (k) => env[k],
  setEnvVar: (k, v) => { env[k] = v; },
  runner: { setNextRequest: () => {}, stopExecution: () => { stopped++; } },
};
// Bruno's test(), recorded; put in place only while the module is called.
const bruTest = (name, fn) => { try { fn(); tests.push({ name, ok: true }); } catch (e) { tests.push({ name, ok: false, error: e.message }); } };

const { jsonObjectOrStop } = require('../../../Bruno_Collection/library-bruno/loopback.js');

afterAll(() => { delete global.bru; });
beforeEach(() => { tests.length = 0; stopped = 0; });

function check(body, label) {
  const jestTest = global.test;
  global.test = bruTest;
  try { return jsonObjectOrStop(body, label); } finally { global.test = jestTest; }
}

test('an object goes on, with no check recorded', () => {
  expect(check({ booking: {} }, 'GET Booking')).toBe(true);
  expect(tests).toEqual([]);
  expect(stopped).toBe(0);
});

test('an HTML page fails one check naming what came, and stops the scenario', () => {
  expect(check('<html><head><title>Request Rejected</title>', 'GET Booking before Fulfillments')).toBe(false);
  expect(tests).toEqual([{ name: 'The answer is a JSON object — got string starting "<html><head><title>Request Rejected</tit"', ok: false,
    error: 'GET Booking before Fulfillments: the answer is not a JSON object (string). See the Content-Type check and the HTTP traffic.' }]);
  expect(stopped).toBe(1);
});

test('nothing and a list are not a booking either', () => {
  expect(check(undefined, 'x')).toBe(false);
  expect(check([1], 'x')).toBe(false);
  expect(tests.map((t) => t.name)).toEqual(['The answer is a JSON object — got nothing', 'The answer is a JSON object — got a list']);
});
