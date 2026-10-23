// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fareSections.js — a fare scenario's requested sections moved onto the trip
 * it is copied to (#937). Pure.
 *
 * A section names two stations of its trip (#903). A copy rebuilds the trip
 * from the company's Test Data, so the simulator's stations mean nothing
 * there. Each end is placed by its position among the trip's stations: the
 * first station stays the first, the last stays the last, a station between
 * them becomes one between them on the new trip (the last one before the
 * destination when the new trip has as few). A section from the border to
 * the destination thus stays "the last leg", and one of the whole trip stays
 * the whole trip. A section whose stations are not on its trip is left as it
 * is: the run's check (sectionsOutsideTrip, #904) says so.
 */

const arr = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A station compared without its URN prefix or leading zeros (as stopKey).
function stationKey(value) {
  const text = String(value ?? '').trim();
  const code = text.replace(/^urn:uic:stn:/i, '');
  return /^\d+$/.test(code) ? String(Number.parseInt(code, 10)) : text;
}

/** The stations of a trip entry, in order: a specification's legs, else a search's ends. */
function tripStations(entry) {
  if (!isObj(entry)) return [];
  const legs = arr(entry.legs).filter(isObj);
  if (entry.tripType === 'SPECIFICATION' && legs.length) {
    return [legs[0].origin, ...legs.map((l) => l.destination)].filter((s) => s != null && s !== '');
  }
  const trip = isObj(entry.trip) ? entry.trip : {};
  return [trip.origin, trip.destination].filter((s) => s != null && s !== '');
}

// The position on a trip of `last + 1` stations for position `k` of `n + 1`.
function placed(k, n, last) {
  if (k === 0) return 0;
  if (k === n) return last;
  return Math.max(1, last - 1);
}

/**
 * The sections moved from the trip `from` onto the trip `to`; the list given
 * is not changed. An empty list stays empty (a negative test sends it so).
 */
function mappedSections(sections, from, to) {
  if (!Array.isArray(sections)) return sections;
  const source = tripStations(from).map(stationKey);
  const target = tripStations(to);
  if (source.length < 2 || target.length < 2) return structuredClone(sections);
  const n = source.length - 1;
  const last = target.length - 1;
  return sections.map((section) => {
    if (!isObj(section)) return section;
    const i = source.indexOf(stationKey(section.startPlace));
    const j = source.indexOf(stationKey(section.endPlace));
    if (i < 0 || j < 0 || i >= j) return { ...section };
    let start = placed(i, n, last);
    let end = placed(j, n, last);
    if (start >= end) [start, end] = [0, last];
    return { ...section, startPlace: target[start], endPlace: target[end] };
  });
}

module.exports = { stationKey, tripStations, mappedSections };
