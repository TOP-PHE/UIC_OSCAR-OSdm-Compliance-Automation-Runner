/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fareDetails.js — what a fare says of its passengers, cards, class, dates
 * and coverage, against the request (#1045, after the simulator's fares
 * became realistic, #1048). Pure: each function returns the places that
 * break its rule; `fares.js` turns them into checks.
 *
 *   O16 a fare requiring cards names one its passengers hold     WARNING
 *       (OSDM: "one of the listed cards is required to be valid at
 *       the time of travel"); an empty requiredCards list          WARNING
 *   O17 a fare's passenger constraints hold its passenger's age   WARNING
 *   O18 a fare offer in a travel class asked                       WARNING
 *   O19 valid travel dates: utcOffset agrees with their offset     WARNING
 *   O20 an offer's covered sections name legs of its trip, and
 *       train legs, not transfers                                  WARNING
 *
 * Warnings, not failures: each is the provider's data disagreeing with the
 * request or with itself, where OSDM leaves the reading open (a card may be
 * shown at the gate, an age counted on another day, classes may differ,
 * #780). The maintainer may raise any to a failure.
 */

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The age of a passenger on a day (YYYY-MM-DD), from its date of birth, else
// its age; null when neither says.
function ageOn(passenger, day) {
  const dob = passenger?.dateOfBirth;
  if (typeof dob === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dob) && typeof day === 'string' && /^\d{4}-\d{2}-\d{2}/.test(day)) {
    const [y, m, d] = dob.slice(0, 10).split('-').map(Number);
    const [ty, tm, td] = day.slice(0, 10).split('-').map(Number);
    return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  }
  return Number.isInteger(passenger?.age) ? passenger.age : null;
}

const passengersOf = (request) => new Map(list(request?.anonymousPassengerSpecifications).map((p) => [p.externalRef, p]));

// A card a passenger holds is the one required: same code, and the same
// issuer when both name one.
function holds(passenger, required) {
  return list(passenger?.cards).some((card) => card.code === required.code
    && (!card.issuer || !required.issuer || card.issuer === required.issuer));
}

/** O16: fares requiring cards none of their passengers holds; empty lists. */
function cardIssues(all, request) {
  const passengers = passengersOf(request);
  const notHeld = [];
  const empty = [];
  for (const { fare, path } of all) {
    if (!Array.isArray(fare?.requiredCards)) continue;
    if (fare.requiredCards.length === 0) { empty.push(`${path}.requiredCards`); continue; }
    const refs = list(fare.passengerRefs);
    const held = refs.some((ref) => list(fare.requiredCards).some((card) => holds(passengers.get(ref), card)));
    if (!held) notHeld.push(`${path} requires ${list(fare.requiredCards).map((c) => c.code).join(' or ')}, held by none of ${refs.join(', ') || 'its passengers'}`);
  }
  return { notHeld, empty };
}

// An age within a passenger constraint: each limit it names holds.
const withinLimits = (c, age) => (!Number.isInteger(c.lowerAgeLimit) || age >= c.lowerAgeLimit)
  && (!Number.isInteger(c.upperAgeLimit) || age <= c.upperAgeLimit);
const namesAgeLimit = (c) => Number.isInteger(c?.lowerAgeLimit) || Number.isInteger(c?.upperAgeLimit);
const rangesOf = (constraints) => constraints.map((c) => `${c.lowerAgeLimit ?? '…'}–${c.upperAgeLimit ?? '…'}`).join(', ');

/** O17: fares whose passenger constraints leave out their passenger's age on the travel day. */
function ageIssues(all, request, travelDay) {
  const passengers = passengersOf(request);
  const out = [];
  for (const { fare, path } of all) {
    const constraints = list(fare?.passengerConstraints).filter(namesAgeLimit);
    if (constraints.length === 0) continue;
    for (const ref of list(fare.passengerRefs)) {
      const age = ageOn(passengers.get(ref), travelDay);
      if (age !== null && !constraints.some((c) => withinLimits(c, age))) {
        out.push(`${path}: passenger ${ref}, aged ${age}, outside ${rangesOf(constraints)}`);
      }
    }
  }
  return out;
}

/**
 * O18: the travel classes asked (OSDM travelClasses) that no fare offer keeps
 * to. An offer keeps to a class when every fare of a person in it is in that
 * class: a bicycle travels in second class whatever the class.
 */
function classIssues(response, request) {
  const asked = list(request?.offerSearchCriteria?.travelClasses);
  if (asked.length === 0) return [];
  const bicycles = new Set(list(request?.anonymousPassengerSpecifications).filter((p) => p.type === 'BICYCLE').map((p) => p.externalRef));
  const offers = list(response?.offers).filter((o) => list(o.fares).length > 0);
  const classOf = (offer) => {
    const classes = new Set(list(offer.fares).filter((f) => !list(f.passengerRefs).every((r) => bicycles.has(r))).map((f) => f.travelClass));
    return classes.size === 1 ? [...classes][0] : null;
  };
  const given = new Set(offers.map(classOf).filter(Boolean));
  return asked.filter((c) => !given.has(c)).map((c) => `${c} asked, the fare offers are in ${[...given].join(', ') || 'mixed classes'}`);
}

// The offset of an instant written with one, in minutes east of UTC; null
// without one.
function offsetOf(instant) {
  const m = /(Z|([+-])(\d{2}):?(\d{2}))$/.exec(String(instant || ''));
  if (!m) return null;
  if (m[1] === 'Z') return 0;
  return (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
}

/**
 * O19: valid travel dates whose utcOffset ("number of minutes to be added to
 * get UTC dates", OSDM 3.8 Calendar) says another offset than their own.
 */
function datesOffsetIssues(all) {
  const out = [];
  for (const { fare, path } of all) {
    const dates = fare?.travelValidityConstraint?.validTravelDates;
    if (!isObject(dates) || !Number.isInteger(dates.utcOffset)) continue;
    const own = offsetOf(dates.from) ?? offsetOf(dates.until);
    if (own === null || dates.utcOffset === -own) continue;
    out.push(`${path}.travelValidityConstraint.validTravelDates: utcOffset ${dates.utcOffset} with dates at ${own >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(own) / 60)).padStart(2, '0')}:${String(Math.abs(own) % 60).padStart(2, '0')} (${-own} expected)`);
  }
  return out;
}

const kindOfLeg = (leg) => {
  if (leg?.timedLeg) return 'timed';
  if (leg?.transferLeg) return 'transfer';
  if (leg?.continuousLeg) return 'continuous';
  return 'unknown';
};

// What is wrong with the legs one covered section names, at `at`.
function sectionLegIssues(section, at, trip, legs) {
  const out = [];
  for (const key of ['startLegId', 'endLegId']) {
    const id = section?.[key];
    if (id == null) continue;
    const leg = legs.get(id);
    if (!leg) out.push(`${at}.${key} = ${JSON.stringify(id)}, not a leg of trip ${trip.id}`);
    else if (kindOfLeg(leg) !== 'timed') out.push(`${at}.${key} = ${JSON.stringify(id)}, a ${kindOfLeg(leg)} leg`);
  }
  return out;
}

// What is wrong with the covered sections of one fare offer.
function offerLegIssues(offer, i, trips) {
  const coverage = offer.tripCoverage;
  if (list(offer.fares).length === 0 || !isObject(coverage) || list(coverage.coveredSections).length === 0) return [];
  const trip = trips.get(coverage.coveredTripId);
  if (!trip) return [`offers[${i}].tripCoverage names trip ${coverage.coveredTripId}, not in the answer`];
  const legs = new Map(list(trip.legs).map((l) => [l.id, l]));
  return list(coverage.coveredSections).flatMap((section, k) => sectionLegIssues(section, `offers[${i}].tripCoverage.coveredSections[${k}]`, trip, legs));
}

/** O20: covered sections of fare offers naming legs their trip does not have, or legs that are not trains. */
function offerCoverageIssues(response) {
  const trips = new Map(list(response?.trips).map((t) => [t.id, t]));
  return list(response?.offers).flatMap((offer, i) => offerLegIssues(offer, i, trips));
}

/**
 * The stations a fare offer's covered sections run from and to: the first
 * section's start, the last one's end. null when the offer names none.
 */
function offerSectionEnds(offer) {
  const sections = list(offer?.tripCoverage?.coveredSections);
  const station = (place) => (isObject(place) ? place.stopPlaceRef || place.id || null : null);
  const start = station(sections[0]?.startPlace);
  const end = station(sections.at(-1)?.endPlace);
  return start && end ? { start: [start], end: [end] } : null;
}

module.exports = { ageOn, cardIssues, ageIssues, classIssues, datesOffsetIssues, offerCoverageIssues, offerSectionEnds, offsetOf };
