// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #704: how far ahead the provider sells. A trip from the profile's
// `salesHorizon.from` stop place that departs in the past is refused (400
// DEPARTURE_IN_PAST); one that departs more than `salesHorizon.days` days
// ahead gets no offer, and a Problem saying why. Only that stop place, so
// that the other scenarios and the tests, which use fixed dates, keep their
// answers whatever the day they run.

const { HttpError } = require('../http');

const DAY_MS = 86400000;

/** Whole days from today (UTC) to the date written in a trip's start time. */
function daysAhead(startTime, nowMs) {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(startTime));
  if (!date) return 0;
  const now = new Date(nowMs);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) - today) / DAY_MS);
}

/**
 * Throws when a trip of the horizon's stop place departs in the past; returns
 * the Problem of a trip beyond the horizon, or null.
 */
function horizonProblem(trips, provider, nowMs) {
  const horizon = provider.salesHorizon;
  if (!horizon) return null;
  const own = trips.filter((t) => t.origin?.stopPlaceRef === horizon.from);
  const ahead = own.map((t) => daysAhead(t.startTime, nowMs));
  if (ahead.some((d) => d < 0)) {
    throw new HttpError(400, 'DEPARTURE_IN_PAST', 'The departure is in the past', 'A trip that has already departed cannot be sold.');
  }
  const furthest = Math.max(-1, ...ahead);
  if (furthest <= horizon.days) return null;
  return {
    code: 'SALES_HORIZON_EXCEEDED',
    title: 'Beyond the sales horizon',
    detail: `Departures are sold up to ${horizon.days} days ahead; this one is ${furthest} days ahead.`,
  };
}

module.exports = { daysAhead, horizonProblem };
