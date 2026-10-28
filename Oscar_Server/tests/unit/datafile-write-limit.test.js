// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1025: the data file write limit's key and message.

const L = require('../../src/utils/datafileWriteLimit');

test('one bucket per user and company or provider; the address only without a user', () => {
  expect(L.writeKeyOf({ user: { id: 'u1', companyId: 'top' }, companyId: 'p1' }, '1.2.3.4')).toBe('datafile:u1:p1');
  expect(L.writeKeyOf({ user: { id: 'u1', companyId: 'top' }, companyId: 'p2' }, '1.2.3.4')).toBe('datafile:u1:p2');
  expect(L.writeKeyOf({ user: { id: 'u2', companyId: 'top' }, companyId: 'p1' }, '1.2.3.4')).toBe('datafile:u2:p1');
  // The company comes from enforceTenant (req.companyId), never the token.
  expect(L.writeKeyOf({ user: { id: 'u1', companyId: 'top' } }, '1.2.3.4')).toBe('datafile:u1:');
  expect(L.writeKeyOf({}, '1.2.3.4')).toBe('datafile-address:1.2.3.4');
});

test('minutes to wait, rounded up, at least one', () => {
  const now = Date.UTC(2026, 9, 28, 8, 0, 0);
  expect(L.minutesUntil(new Date(now + 14 * 60000 + 1), now)).toBe(15);
  expect(L.minutesUntil(new Date(now + 60000), now)).toBe(1);
  expect(L.minutesUntil(new Date(now - 5000), now)).toBe(1);
  expect(L.minutesUntil(now + 90000, now)).toBe(2);
  expect(L.minutesUntil(undefined, now)).toBe(15);
});

test('the message: what, how long, and that nothing is lost', () => {
  const now = Date.UTC(2026, 9, 28, 8, 0, 0);
  const p = L.limitProblem(new Date(now + 60000), now);
  expect(p.status).toBe(429);
  expect(p.detail).toBe('Too many data file changes for this company or provider (60 in 15 minutes). '
    + 'Try again in 1 minute. Unsaved edits stay on the page: do not reload it.');
  expect(L.limitProblem(new Date(now + 7 * 60000), now).detail).toContain('Try again in 7 minutes.');
  expect(L.MAX_WRITES).toBe(60);
});
