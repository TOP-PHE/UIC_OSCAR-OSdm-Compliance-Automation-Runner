// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * stationZones.js — the UTC offset of a station's country (#862). Pure.
 *
 * A provider's checklist gives local times ("08:00"). Test Data keeps a time
 * with an offset, as Discover timetable writes it; the collection then moves
 * it to the offset of the trip date (`onTheDay()`, #772), but only when the
 * stored offset is one its zone uses. So the time gets the offset of the
 * station's zone today.
 *
 * The table is the collection's (`library-bruno/stationTimeZones.js`): the
 * server cannot load the collection's code (it is mounted beside the image,
 * not in it), so `tests/unit/station-zones.test.js` keeps the two equal.
 */

const UIC_COUNTRY_ZONES = Object.freeze({
  10: 'Europe/Helsinki', 21: 'Europe/Minsk', 22: 'Europe/Kyiv', 24: 'Europe/Vilnius', 25: 'Europe/Riga',
  26: 'Europe/Tallinn', 41: 'Europe/Tirane', 44: 'Europe/Sarajevo', 49: 'Europe/Sarajevo', 50: 'Europe/Sarajevo',
  51: 'Europe/Warsaw', 52: 'Europe/Sofia', 53: 'Europe/Bucharest', 54: 'Europe/Prague', 55: 'Europe/Budapest',
  56: 'Europe/Bratislava', 60: 'Europe/Dublin', 62: 'Europe/Podgorica', 65: 'Europe/Skopje', 70: 'Europe/London',
  71: 'Europe/Madrid', 72: 'Europe/Belgrade', 73: 'Europe/Athens', 74: 'Europe/Stockholm', 76: 'Europe/Oslo',
  78: 'Europe/Zagreb', 79: 'Europe/Ljubljana', 80: 'Europe/Berlin', 81: 'Europe/Vienna', 82: 'Europe/Luxembourg',
  83: 'Europe/Rome', 84: 'Europe/Amsterdam', 85: 'Europe/Zurich', 86: 'Europe/Copenhagen', 87: 'Europe/Paris',
  88: 'Europe/Brussels', 94: 'Europe/Lisbon',
});

/** The time zone of a stop place, from its UIC station code, or null. */
function zoneOfStopPlace(stopPlaceRef) {
  const m = /^urn:uic:stn:(\d{7})$/.exec(String(stopPlaceRef || '').trim());
  return m ? UIC_COUNTRY_ZONES[Number(m[1].slice(0, 2))] || null : null;
}

/** The offset ("+01:00") of a stop place's zone at `atMs`, or null when it cannot be told. */
function offsetOfStopPlace(stopPlaceRef, atMs = Date.now()) {
  const zone = zoneOfStopPlace(stopPlaceRef);
  if (!zone) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName');
    if (part?.value === 'GMT') return '+00:00';
    const m = /^GMT([+-]\d{2}:\d{2})$/.exec(part?.value || '');
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

module.exports = { UIC_COUNTRY_ZONES, zoneOfStopPlace, offsetOfStopPlace };
