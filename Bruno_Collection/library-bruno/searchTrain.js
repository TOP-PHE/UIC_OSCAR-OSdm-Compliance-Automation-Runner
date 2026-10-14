/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * searchTrain.js — the train of a SEARCH trip, chosen in the answer (#722).
 *
 * An offer search sends origin, destination and time only. The train and
 * operator filters (`parameters.dataFilter`) are optional in OSDM, and a
 * provider that does not take them refuses the whole request, so they are
 * sent only when the trip's Trip Search Criteria turn "Train filter" on: that
 * is the test of the filter itself.
 *
 * Without the filter, the train is chosen in the answer: the trip running the
 * Test Data train when the trip names one, else the first trip leaving at the
 * time asked or later. The offers kept are those covering that trip.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-search-train.test.js.
 */

const { chooseTrip, vehicleNumbersOf, coveredTripsOf } = require('./tripIds.js');

const listOf = (value) => (Array.isArray(value) ? value : []);
const textOf = (value) => String(value ?? '').trim();

/** Whether a trip's Trip Search Criteria ask for the train filter. */
function trainFilterOn(searchCriteria) {
  const v = searchCriteria?.trainFilter;
  return v === true || textOf(v).toLowerCase() === 'true';
}

/**
 * The trip of the answer the search was for: the one running `vehicleNumber`,
 * else the first leaving at `departureTime` or later.
 * @returns {{ trip: object|null, how: string, reason?: string, trainMissing?: string }}
 *   `trainMissing` says why the train was not found when the time was used.
 */
function chooseSearchTrip(trips, { vehicleNumber, departureTime } = {}) {
  const train = textOf(vehicleNumber);
  if (!train) return chooseTrip(trips, { departureTime });
  const byTrain = chooseTrip(trips, { vehicleNumber: train });
  if (byTrain.trip) return byTrain;
  return { ...chooseTrip(trips, { departureTime }), trainMissing: byTrain.reason };
}

/**
 * The offers of `body` on the trip the search was for, and the log lines that
 * say how it was chosen. An answer of one trip, or offers that name no trip,
 * are left as they are.
 * @returns {{ offers: object[], lines: string[], tripId: string|null }}
 */
function offersOnSearchTrip(body, wanted) {
  const offers = listOf(body?.offers);
  const trips = listOf(body?.trips);
  if (trips.length === 0) return { offers, lines: [], tripId: null };
  const choice = chooseSearchTrip(trips, wanted);
  const lines = [];
  if (choice.trainMissing) {
    lines.push(`[WARNING] 🚆 Search: ${choice.trainMissing}; the train of Test Data is not offered at that time.`);
  }
  if (!choice.trip) {
    lines.push(`[WARNING] 🚆 Search: ${choice.reason}; the offers of every trip are kept.`);
    return { offers, lines, tripId: null };
  }
  const tripId = choice.trip.id;
  if (trips.length === 1) {
    if (choice.trainMissing) lines.push(`[WARNING] 🚆 Search: the one trip of the answer (train ${vehicleNumbersOf(choice.trip).join('+') || '?'}) is used.`);
    return { offers, lines, tripId };
  }
  const kept = offers.filter((o) => coveredTripsOf(o).includes(tripId));
  if (kept.length === 0) {
    lines.push(`[WARNING] 🚆 Search: no offer names the trip of ${choice.how} (${tripId}) in its trip coverage; the offers of every trip are kept.`);
    return { offers, lines, tripId: null };
  }
  lines.push(`[INFO] 🚆 Search: ${trips.length} trips in the answer; ${kept.length} of ${offers.length} offer(s) cover ${choice.how} (train ${vehicleNumbersOf(choice.trip).join('+') || '?'}).`);
  return { offers: kept, lines, tripId };
}

/**
 * The checks of an answer to a search sent with the train filter: a trip of
 * that train (failure), and no trip of another train (warning: the provider
 * may add connections or neighbours).
 * @returns {Array<{name: string, ok: boolean, message?: string, level?: string}>}
 */
function checkTrainFilter(body, vehicleNumber) {
  const train = textOf(vehicleNumber);
  if (!train) return [];
  const trips = listOf(body?.trips);
  const trains = trips.map((t) => vehicleNumbersOf(t));
  const holding = trains.filter((numbers) => numbers.includes(train)).length;
  const others = trains.filter((numbers) => !numbers.includes(train)).map((numbers) => numbers.join('+') || '?');
  return [
    {
      name: `🔎 Train filter: the answer holds a trip of train ${train} — ${holding} of ${trips.length} trip(s)`,
      ok: holding > 0,
      message: trips.length === 0 ? 'the answer holds no trip' : `trains of the answer: ${trains.map((n) => n.join('+') || '?').join(', ')}`,
    },
    {
      name: `🔎 Train filter: every trip of the answer runs train ${train}`,
      ok: others.length === 0,
      level: 'warn',
      message: `other trains in the answer: ${others.join(', ')}`,
    },
  ];
}

module.exports = { trainFilterOn, chooseSearchTrip, offersOnSearchTrip, checkTrainFilter };
