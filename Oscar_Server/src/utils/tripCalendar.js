// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * tripCalendar.js — the days a scenario's trip can run (#717). Pure.
 *
 * A trip requirement is filled from Test Data trains, but keeps only their
 * stop places, times and numbers, not the days they run. When the server
 * hands the data file to a run, each trip requirement is matched against the
 * company's TRAIN resources and annotated:
 *   - `__operatingDays`: the days every matched leg runs ('MON'..'SUN'),
 *     absent when no leg has a known calendar;
 *   - `__calendarNotes`: [{ level, text }] for the run log — a leg with no
 *     calendar or no train, a departure time that is not the train's, legs
 *     that do not connect.
 *   - `__returnServices` (#778): the Test Data services of the way back (the
 *     trip's last stop place to its first), each `{ departure: 'HH:MM',
 *     number, days }`, `days` absent when its train has no calendar. The
 *     collection dates a return scenario on a day one of them runs.
 * Matching at run time, not when the trip is filled, means old scenarios get
 * it too, and a calendar filled later is used by the next run.
 */

const { stopKey } = require('../../public/js/journey-planner.js');

const DAY_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// Test Data text goes into the run's data file, which Bruno reads as a
// template: never let it carry `{{` (CLAUDE.md, "Datafile text is never a
// template").
const safe = (v) => String(v ?? '').replaceAll('{{', '{ {').replaceAll('}}', '} }');

// "%TRIP_DATE%T09:10:00+02:00", "2026-10-19T09:10:00" or "09:10:00": "09:10".
// (The first "HH:MM" of the text: the date part holds no colon.)
function clockOf(value) {
  const m = /(\d{2}):(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[1]}:${m[2]}` : '';
}

const minutes = (clock) => (clock ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)) : null);

function trainsOf(resources) {
  return (resources || []).filter((r) => r && (!r.resource_type || r.resource_type === 'TRAIN')).map((r) => {
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = {}; } }
    return { id: r.id, label: r.label || '', data: d && typeof d === 'object' ? d : {} };
  });
}

/**
 * The train service a leg of a trip names: same stop places, then the same
 * train number, else the same departure time. { train, service, by } or null.
 */
function matchLeg(leg, trains) {
  const from = stopKey(leg.origin);
  const to = stopKey(leg.destination);
  if (!from || !to) return null;
  const number = String(leg.vehicleNumber ?? '').trim();
  const clock = clockOf(leg.startDatetime);
  const onRoute = trains.filter((t) => stopKey(t.data.originURN) === from && stopKey(t.data.destinationURN) === to);
  const pairs = onRoute.flatMap((train) => (Array.isArray(train.data.services) ? train.data.services : []).map((service) => ({ train, service })));
  const byNumber = number && pairs.find(({ service }) => String(service?.vehicleNumber ?? '').trim() === number);
  if (byNumber) return { ...byNumber, by: 'number' };
  const byTime = clock && pairs.find(({ service }) => clockOf(service?.departureTime) === clock);
  return byTime ? { ...byTime, by: 'time' } : null;
}

// The legs of a trip requirement, as { origin, destination, vehicleNumber, startDatetime, endDatetime }.
function legsOf(trip) {
  if (trip?.tripType === 'SPECIFICATION') return Array.isArray(trip.legs) ? trip.legs.filter(Boolean) : [];
  return trip?.trip && typeof trip.trip === 'object' ? [trip.trip] : [];
}

const legName = (leg, i, count) => {
  const route = `${safe(stopKey(leg.origin).split(':').pop())} → ${safe(stopKey(leg.destination).split(':').pop())}`;
  return count > 1 ? `leg ${i + 1} (${route})` : `the trip ${route}`;
};

// Legs of a SPECIFICATION that do not connect.
function continuityNotes(legs) {
  const notes = [];
  for (let i = 1; i < legs.length; i++) {
    const prev = legs[i - 1];
    const cur = legs[i];
    if (stopKey(prev.destination) && stopKey(cur.origin) && stopKey(prev.destination) !== stopKey(cur.origin)) {
      notes.push({ level: 'WARNING', text: `Leg ${i + 1} starts at ${safe(stopKey(cur.origin).split(':').pop())}, but leg ${i} ends at ${safe(stopKey(prev.destination).split(':').pop())}: the legs do not connect.` });
    }
    const prevStart = minutes(clockOf(prev.startDatetime));
    const prevEnd = minutes(clockOf(prev.endDatetime));
    const start = minutes(clockOf(cur.startDatetime));
    // A leg arriving after midnight runs into the next day: its clock says nothing here.
    if (prevEnd !== null && start !== null && (prevStart === null || prevEnd >= prevStart) && start < prevEnd) {
      notes.push({ level: 'WARNING', text: `Leg ${i + 1} leaves at ${clockOf(cur.startDatetime)}, before leg ${i} arrives at ${clockOf(prev.endDatetime)}.` });
    }
  }
  return notes;
}

/**
 * The calendar of one trip requirement against the TRAIN resources.
 * @returns {{ operatingDays: string[]|null, notes: Array<{level, text}> }}
 *   operatingDays null when no leg has a known calendar; [] when the legs'
 *   calendars have no day in common.
 */
function tripCalendar(trip, resources) {
  const trains = trainsOf(resources);
  const legs = legsOf(trip);
  const notes = trip?.tripType === 'SPECIFICATION' ? continuityNotes(legs) : [];
  let days = null;
  legs.forEach((leg, i) => {
    if (!stopKey(leg.origin) || !stopKey(leg.destination)) return;   // nothing to match yet
    const name = legName(leg, i, legs.length);
    const m = matchLeg(leg, trains);
    if (!m) {
      notes.push({ level: 'INFO', text: `No Test Data train matches ${name}: the days it runs are not checked.` });
      return;
    }
    const label = safe(m.train.label || m.service.vehicleNumber || '');
    const wanted = clockOf(leg.startDatetime);
    const own = clockOf(m.service.departureTime);
    if (m.by === 'number' && wanted && own && wanted !== own) {
      notes.push({ level: 'WARNING', text: `${name[0].toUpperCase()}${name.slice(1)} leaves at ${wanted}, but train ${safe(m.service.vehicleNumber)} (${label}) leaves at ${own} in Test Data.` });
    }
    const legDays = Array.isArray(m.train.data.daysOfWeek) ? m.train.data.daysOfWeek.filter((x) => DAY_ORDER.includes(x)) : [];
    if (legDays.length === 0) {
      notes.push({ level: 'INFO', text: `Train ${safe(m.service.vehicleNumber)} (${label}) has no calendar in Test Data: the days it runs are not checked. Test Data → Fill missing calendars asks the provider.` });
      return;
    }
    days = days === null ? legDays.slice() : days.filter((x) => legDays.includes(x));
  });
  if (days !== null) days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  if (days !== null && days.length === 0) {
    notes.push({ level: 'WARNING', text: 'The trains of this trip have no day in common in Test Data: no date suits them all.' });
  }
  return { operatingDays: days, notes };
}

/**
 * The Test Data services going back from the trip's last stop place to its
 * first (#778), in departure order, each { departure, number, days? }.
 * [] when no train makes that journey directly.
 */
function returnServices(trip, resources) {
  const legs = legsOf(trip);
  if (legs.length === 0) return [];
  const from = stopKey(legs.at(-1).destination);
  const to = stopKey(legs[0].origin);
  if (!from || !to) return [];
  return trainsOf(resources)
    .filter((train) => stopKey(train.data.originURN) === from && stopKey(train.data.destinationURN) === to)
    .flatMap(servicesOf)
    .sort((a, b) => a.departure.localeCompare(b.departure));
}

// The timed services of one train, each { departure, number, days? }.
function servicesOf(train) {
  const days = Array.isArray(train.data.daysOfWeek) ? train.data.daysOfWeek.filter((x) => DAY_ORDER.includes(x)) : [];
  days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const services = Array.isArray(train.data.services) ? train.data.services : [];
  return services.filter((service) => clockOf(service?.departureTime)).map((service) => {
    const entry = { departure: clockOf(service.departureTime), number: safe(String(service.vehicleNumber ?? '').trim()) };
    if (days.length) entry.days = days.slice();
    return entry;
  });
}

/**
 * Annotate every trip requirement of `datafile` (changed in place).
 * @returns {number} how many trip requirements got an annotation.
 */
function annotateTripCalendars(datafile, resources) {
  let annotated = 0;
  for (const trip of Array.isArray(datafile?.tripRequirements) ? datafile.tripRequirements : []) {
    if (!trip || typeof trip !== 'object') continue;
    const { operatingDays, notes } = tripCalendar(trip, resources);
    const back = returnServices(trip, resources);
    if (operatingDays === null && notes.length === 0 && back.length === 0) continue;
    if (operatingDays !== null) trip.__operatingDays = operatingDays;
    if (notes.length) trip.__calendarNotes = notes;
    if (back.length) trip.__returnServices = back;
    annotated++;
  }
  return annotated;
}

module.exports = { DAY_ORDER, clockOf, matchLeg, tripCalendar, returnServices, annotateTripCalendars };
