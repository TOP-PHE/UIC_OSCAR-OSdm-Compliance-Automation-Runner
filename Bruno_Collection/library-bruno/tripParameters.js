/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * tripParameters.js — do the trips of an offer answer keep to the trip search
 * parameters sent? (#780 PR B)
 *
 * One check per parameter the search carried that a trip shows: the transfer
 * limit (transfers of each trip), the vias (each trip passes them), the
 * not-vias (no trip changes or stops there) and the number of results (no
 * more trips than asked). An arrival-time basis, real-time data and the train
 * filter are not checked here (the train filter has its own check, #722).
 *
 * Graded as the offer search options (offerCriteria.js): no trip keeping to
 * it is a WARNING, some trips not keeping to it INFO, a member the provider
 * says it ignored (PARAMETER_NOT_SUPPORTED) a WARNING. In an offer search
 * probe each is a test.
 *
 * Pure module: no Bruno globals.
 */

const { sameStopPlace } = require('./returnJourney.js');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
const refOf = (p) => (isObj(p) ? p.stopPlaceRef : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

// The timed legs of a trip (TripLeg.timedLeg), in order.
const timedLegs = (trip) => list(trip?.legs).map((l) => l.timedLeg).filter(isObj);

/** The transfers of a trip: its own count, else its timed legs less one. */
function transfersOf(trip) {
  if (count(trip?.transfers) !== null) return trip.transfers;
  return Math.max(timedLegs(trip).length - 1, 0);
}

/**
 * The places a trip passes, its ends left out: where a leg starts or ends
 * (a change) and the intermediate stops a leg names.
 */
function placesPassed(trip) {
  const legs = timedLegs(trip);
  const places = [];
  legs.forEach((leg, i) => {
    if (i > 0) places.push(refOf(leg.start?.stopPlaceRef));
    for (const stop of list(leg.intermediates)) places.push(refOf(stop.stopPlaceRef));
    if (i < legs.length - 1) places.push(refOf(leg.end?.stopPlaceRef));
  });
  return places.filter((p) => typeof p === 'string' && p !== '');
}

const passes = (trip, place) => placesPassed(trip).some((p) => sameStopPlace(p, place));

/** The parameters a TripSearchCriteria carried, in the form the checks read. */
function askedParameters(criteria) {
  const c = isObj(criteria) ? criteria : {};
  const params = isObj(c.parameters) ? c.parameters : {};
  return {
    transferLimit: count(params.transferLimit),
    vias: list(c.vias).map((v) => refOf(v.viaPlace)).filter(Boolean),
    notVias: list(c.notVias).flatMap((n) => list(n.notViaPlace).map(refOf)).filter(Boolean),
    numberOfResults: count(params.numberOfResults),
  };
}

const tripName = (trip, i) => (trip?.id ? `trip ${trip.id}` : `trip ${i + 1}`);

// One check over the trips: the trips that do not keep to it, named.
function overTrips(trips, keeps, describe) {
  const off = trips.map((trip, i) => ({ trip, i })).filter(({ trip }) => !keeps(trip));
  const shown = off.slice(0, 3).map(({ trip, i }) => `${tripName(trip, i)}: ${describe(trip)}`).join('; ');
  return {
    ok: off.length === 0, level: off.length === trips.length ? 'warn' : 'info',
    message: `${off.length} of ${trips.length} trip(s) do not (${shown}${off.length > 3 ? '; …' : ''})`,
  };
}

/**
 * The checks of an offer answer's trips against the trip search criteria sent.
 * @param {object} criteria  the request's tripSearchCriteria
 * @param {object} response  the OfferCollectionResponse (its `trips`)
 * @param {string[]} ignored the members the answer says were ignored, lower-cased
 * @returns {Array<{name, ok, level: 'warn'|'info', message}>}
 */
function checkTripParameters(criteria, response, ignored = []) {
  const trips = list(response?.trips);
  if (trips.length === 0) return [];
  const asked = askedParameters(criteria);
  // Each check: its name, the member (and its lower-cased name in a
  // PARAMETER_NOT_SUPPORTED answer) and how the trips are graded.
  const wanted = [];
  if (asked.transferLimit !== null) {
    wanted.push({
      name: `Trip search: the trips keep to the transfer limit asked (${asked.transferLimit})`, member: 'parameters.transferLimit', key: 'transferlimit',
      grade: () => overTrips(trips, (t) => transfersOf(t) <= asked.transferLimit, (t) => `${transfersOf(t)} transfer(s)`),
    });
  }
  for (const via of asked.vias) {
    wanted.push({
      name: `Trip search: the trips pass the via asked (${via})`, member: 'vias', key: 'vias',
      grade: () => overTrips(trips, (t) => passes(t, via), () => 'does not pass it'),
    });
  }
  if (asked.notVias.length) {
    const passed = (t) => asked.notVias.filter((p) => passes(t, p));
    wanted.push({
      name: `Trip search: the trips avoid the places asked (${asked.notVias.join(', ')})`, member: 'notVias', key: 'notvias',
      grade: () => overTrips(trips, (t) => passed(t).length === 0, (t) => `passes ${passed(t).join(', ')}`),
    });
  }
  if (asked.numberOfResults !== null) {
    const ok = trips.length <= asked.numberOfResults;
    wanted.push({
      name: `Trip search: no more trips than asked (${asked.numberOfResults})`, member: 'parameters.numberOfResults', key: 'numberofresults',
      grade: () => ({ ok, level: 'warn', message: ok ? '' : `${trips.length} trips given` }),
    });
  }
  // #1035: each check names its parameter, and whether the answer said it was not taken.
  return wanted.map(({ name, member, key, grade }) => (ignored.includes(key)
    ? { name, parameter: `tripSearchCriteria.${member}`, said: true, ok: false, level: 'warn', message: `the provider says it ignored tripSearchCriteria.${member} (PARAMETER_NOT_SUPPORTED): not supported` }
    : { name, parameter: `tripSearchCriteria.${member}`, said: false, ...grade() }));
}

module.exports = { askedParameters, transfersOf, placesPassed, checkTripParameters };
