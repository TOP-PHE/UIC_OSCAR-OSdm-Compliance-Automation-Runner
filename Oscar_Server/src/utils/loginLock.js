// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * loginLock.js — the rules of the sign-in's lock per e-mail address (#1421),
 * pure: every function takes the address's state and the time (seconds) and
 * answers a new state; api/helpers/loginLock.js reads and writes it.
 *
 * Maintainer's rules (2026-11-24):
 * - 10 wrong passwords within 15 minutes lock the address;
 * - the lock lasts 15 minutes and doubles when locks follow each other
 *   within 24 hours (15, 30, 60 minutes… up to 24 hours);
 * - while it lasts, every password is refused, the right one too;
 * - an address without an account is counted the same way, so the answers
 *   never tell which addresses have one;
 * - a password reset carried through lifts it (the helper deletes the state).
 *
 * An attempt is counted as wrong when it starts (`begin`) and taken back when
 * its password proves right (`finish`): attempts sent together cannot pass
 * the limit while their passwords are being checked.
 */

const MAX_FAILURES = 10;
const WINDOW_SECONDS = 15 * 60;
const FIRST_LOCK_SECONDS = 15 * 60;
const MAX_LOCK_SECONDS = 24 * 60 * 60;
const SERIES_SECONDS = 24 * 60 * 60;   // a lock this soon after the last one ended doubles

/** The state of an address never seen, or whose state has expired. */
function emptyState() {
  return { failures: 0, failuresSince: 0, lockedUntil: 0, lockLevel: 0 };
}

/** How long the `level`-th lock of a series lasts: 15 minutes, doubled each time, 24 hours at most. */
function lockSecondsFor(level) {
  const doublings = Math.min(Math.max(level, 1) - 1, 16);
  return Math.min(FIRST_LOCK_SECONDS * 2 ** doublings, MAX_LOCK_SECONDS);
}

/** Seconds left of the lock, 0 when there is none. */
function lockedFor(state, now) {
  return state.lockedUntil > now ? state.lockedUntil - now : 0;
}

function windowOpen(state, now) {
  return state.failuresSince > 0 && now - state.failuresSince < WINDOW_SECONDS;
}

/**
 * An attempt starts: { refused: seconds, state } — refused is the wait when
 * the address is locked (or its attempts of the window are all in flight),
 * else 0 and the attempt is counted.
 */
function begin(state, now) {
  const wait = lockedFor(state, now);
  if (wait) return { refused: wait, state };
  const failures = windowOpen(state, now) ? state.failures : 0;
  const since = failures ? state.failuresSince : now;
  if (failures >= MAX_FAILURES) {
    return { refused: Math.max(1, since + WINDOW_SECONDS - now), state };
  }
  return { refused: 0, state: { ...state, failures: failures + 1, failuresSince: since } };
}

/**
 * An attempt ends: { lockedNow: seconds, state }. A right password clears the
 * count (the lock, and the series it belongs to, stay). A wrong one stays
 * counted, and the tenth of the window locks the address: lockedNow is then
 * the lock's length.
 */
function finish(state, now, ok) {
  if (ok) return { lockedNow: 0, state: { ...state, failures: 0, failuresSince: 0 } };
  if (state.failures < MAX_FAILURES || lockedFor(state, now)) return { lockedNow: 0, state };
  const inSeries = state.lockedUntil > 0 && now - state.lockedUntil < SERIES_SECONDS;
  const level = inSeries ? state.lockLevel + 1 : 1;
  const seconds = lockSecondsFor(level);
  return {
    lockedNow: seconds,
    state: { failures: 0, failuresSince: 0, lockedUntil: now + seconds, lockLevel: level },
  };
}

/** When the state stops mattering: its window has passed and so has any series it could start. */
function expiresAt(state) {
  const windowEnd = state.failuresSince ? state.failuresSince + WINDOW_SECONDS : 0;
  const seriesEnd = state.lockedUntil ? state.lockedUntil + SERIES_SECONDS : 0;
  return Math.max(windowEnd, seriesEnd);
}

/** A wait in words for an answer or an e-mail: "15 minutes", "1 minute", "4 hours". */
function durationText(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 120) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hours`;
}

module.exports = {
  emptyState, lockSecondsFor, lockedFor, begin, finish, expiresAt, durationText,
  MAX_FAILURES, WINDOW_SECONDS, FIRST_LOCK_SECONDS, MAX_LOCK_SECONDS, SERIES_SECONDS,
};
