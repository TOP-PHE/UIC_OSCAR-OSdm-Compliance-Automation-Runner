// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * trips.js — the answer to POST /trips-collection (#602).
 *
 * The body is a TripSearchCriteria. There is no timetable: the answer holds
 * four direct departures of the line between the two places, half an hour
 * before the time asked, at that time, one hour and two hours after, each
 * with a train number of its own. The departure at the time asked is the trip
 * a search for offers with the same criteria gets, with the same id. Offers
 * can then be asked for these trips by id (`tripIds` in POST /offers).
 */

const crypto = require('node:crypto');
const { HttpError } = require('../http');
const { tripFromSearch } = require('./offers');

// Each departure: its step from the one asked for, and how much later it is.
const DEPARTURES = [
  { departure: -1, shiftMs: -30 * 60000 },
  { departure: 0, shiftMs: 0 },
  { departure: 1, shiftMs: 60 * 60000 },
  { departure: 2, shiftMs: 120 * 60000 },
];

/** The TripCollectionResponse for this search, and the trips to remember. */
function buildTripCollection(body, provider) {
  if (body.returnSearchParameters !== undefined && body.returnSearchParameters !== null) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'The trip request is not valid', 'returnSearchParameters: a return is not provided by this simulator');
  }
  const trips = DEPARTURES.map((d) => tripFromSearch(body, provider, d));
  const id = `${provider.idPrefix}-TRIPS-${crypto.randomBytes(8).toString('hex')}`;
  return { response: { id, trips }, trips };
}

module.exports = { buildTripCollection, DEPARTURES };
