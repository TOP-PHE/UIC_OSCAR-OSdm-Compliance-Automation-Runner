// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * login-lock.test.js — the rules of the sign-in's lock per address (#1421),
 * utils/loginLock.js: counting, the lock, its series and the attempts in
 * flight. The sign-in itself is integration/login-lock.test.js.
 */

const L = require('../../src/utils/loginLock');

const T0 = 1_800_000_000;   // a time, in seconds

/** `n` wrong passwords one second apart from `state` at `now`: the last finish's answer. */
function wrong(state, now, n) {
  let result = { state, lockedNow: 0 };
  for (let i = 0; i < n; i++) {
    const started = L.begin(result.state, now + i);
    expect(started.refused).toBe(0);
    result = L.finish(started.state, now + i, false);
  }
  return result;
}

describe('counting wrong passwords', () => {
  test('the tenth wrong password of 15 minutes locks the address for 15 minutes', () => {
    const nine = wrong(L.emptyState(), T0, 9);
    expect(nine.lockedNow).toBe(0);
    expect(nine.state.failures).toBe(9);
    const ten = wrong(nine.state, T0 + 9, 1);
    expect(ten.lockedNow).toBe(15 * 60);
    expect(ten.state).toEqual({ failures: 0, failuresSince: 0, lockedUntil: T0 + 9 + 900, lockLevel: 1 });
  });

  test('while locked every attempt is refused, with the seconds left, and nothing is counted', () => {
    const { state } = wrong(L.emptyState(), T0, 10);
    const at = T0 + 9 + 100;
    expect(L.begin(state, at)).toEqual({ refused: 800, state });
    expect(L.lockedFor(state, at)).toBe(800);
    expect(L.begin(state, T0 + 9 + 900).refused).toBe(0);   // the lock has ended
  });

  test('wrong passwords spread over more than 15 minutes do not add up', () => {
    const nine = wrong(L.emptyState(), T0, 9);
    const later = wrong(nine.state, T0 + 15 * 60 + 1, 1);
    expect(later.lockedNow).toBe(0);
    expect(later.state.failures).toBe(1);
  });

  test('a right password clears the count', () => {
    const nine = wrong(L.emptyState(), T0, 9);
    const started = L.begin(nine.state, T0 + 20);
    const right = L.finish(started.state, T0 + 20, true);
    expect(right).toEqual({ lockedNow: 0, state: { failures: 0, failuresSince: 0, lockedUntil: 0, lockLevel: 0 } });
    expect(wrong(right.state, T0 + 21, 9).lockedNow).toBe(0);
  });

  test('attempts in flight together never pass the limit', () => {
    let state = L.emptyState();
    for (let i = 0; i < 10; i++) {
      const started = L.begin(state, T0);
      expect(started.refused).toBe(0);
      state = started.state;
    }
    const eleventh = L.begin(state, T0 + 5);
    expect(eleventh.refused).toBe(15 * 60 - 5);
    expect(eleventh.state).toBe(state);
    // Their passwords prove wrong one after the other: the tenth locks.
    const locks = [];
    for (let i = 0; i < 10; i++) {
      const done = L.finish(state, T0 + 6, false);
      locks.push(done.lockedNow);
      state = done.state;
    }
    expect(locks.filter(Boolean)).toEqual([900]);
  });
});

describe('a series of locks doubles', () => {
  test('15, 30, 60 minutes… when each lock comes within 24 hours of the last one\'s end', () => {
    let state = L.emptyState();
    let now = T0;
    const lengths = [];
    for (let i = 0; i < 9; i++) {
      const result = wrong(state, now, 10);
      lengths.push(result.lockedNow);
      state = result.state;
      now = state.lockedUntil + 60;   // a minute after the lock ends
    }
    expect(lengths.map(s => s / 60)).toEqual([15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
  });

  test('a lock more than 24 hours after the last one ended starts a new series', () => {
    const first = wrong(L.emptyState(), T0, 10);
    const second = wrong(first.state, first.state.lockedUntil + 60, 10);
    expect(second.lockedNow).toBe(1800);
    const fresh = wrong(second.state, second.state.lockedUntil + 24 * 3600, 10);
    expect(fresh.lockedNow).toBe(900);
    expect(fresh.state.lockLevel).toBe(1);
  });

  test('a right password between locks does not end the series', () => {
    const first = wrong(L.emptyState(), T0, 10);
    const now = first.state.lockedUntil + 10;
    const right = L.finish(L.begin(first.state, now).state, now, true);
    expect(wrong(right.state, now + 1, 10).lockedNow).toBe(1800);
  });

  test('the length is never more than 24 hours, however long the series', () => {
    expect(L.lockSecondsFor(0)).toBe(900);
    expect(L.lockSecondsFor(1)).toBe(900);
    expect(L.lockSecondsFor(8)).toBe(24 * 3600);
    expect(L.lockSecondsFor(1e6)).toBe(24 * 3600);
  });
});

describe('what the state keeps', () => {
  test('it matters until its window, or the series its lock could start, has passed', () => {
    expect(L.expiresAt(L.emptyState())).toBe(0);
    const one = wrong(L.emptyState(), T0, 1);
    expect(L.expiresAt(one.state)).toBe(T0 + 900);
    const locked = wrong(L.emptyState(), T0, 10);
    expect(L.expiresAt(locked.state)).toBe(locked.state.lockedUntil + 24 * 3600);
  });

  test('a wait in words', () => {
    expect(L.durationText(1)).toBe('1 minute');
    expect(L.durationText(60)).toBe('1 minute');
    expect(L.durationText(61)).toBe('2 minutes');
    expect(L.durationText(900)).toBe('15 minutes');
    expect(L.durationText(119 * 60)).toBe('119 minutes');
    expect(L.durationText(4 * 3600)).toBe('4 hours');
    expect(L.durationText(24 * 3600)).toBe('24 hours');
  });
});
