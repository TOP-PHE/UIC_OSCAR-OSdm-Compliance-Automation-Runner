/**
 * stationTimeZones.js — the offset a timetable time has on the day of travel
 * (#772).
 *
 * Test Data keeps a service's times as seen at discovery, with that day's
 * offset: "08:00:00+02:00" seen in summer. A run on a winter day must send
 * 08:00 local, "+01:00"; keeping "+02:00" asks for a train an hour earlier,
 * which a provider answers with "trip not found". The local time is the
 * timetable, so the offset is worked out again for the trip date, in the
 * time zone of the stop place's country.
 *
 * The country is the first two digits of a 7-digit UIC station code
 * (`urn:uic:stn:8400058` = 84, the Netherlands). A time is changed only when
 * its stored offset is one of the two its zone uses in the year: otherwise it
 * was not written in local time, and is left as it is. An unknown country
 * (the simulator's `00…` stations) or a sandbox without time zones leaves it
 * as it is too. Pure: no `bru`.
 */

// UIC country code → IANA time zone, for the countries OSDM providers sell.
const UIC_COUNTRY_ZONES = {
  10: 'Europe/Helsinki', 21: 'Europe/Minsk', 22: 'Europe/Kyiv', 24: 'Europe/Vilnius', 25: 'Europe/Riga',
  26: 'Europe/Tallinn', 41: 'Europe/Tirane', 44: 'Europe/Sarajevo', 49: 'Europe/Sarajevo', 50: 'Europe/Sarajevo',
  51: 'Europe/Warsaw', 52: 'Europe/Sofia', 53: 'Europe/Bucharest', 54: 'Europe/Prague', 55: 'Europe/Budapest',
  56: 'Europe/Bratislava', 60: 'Europe/Dublin', 62: 'Europe/Podgorica', 65: 'Europe/Skopje', 70: 'Europe/London',
  71: 'Europe/Madrid', 72: 'Europe/Belgrade', 73: 'Europe/Athens', 74: 'Europe/Stockholm', 76: 'Europe/Oslo',
  78: 'Europe/Zagreb', 79: 'Europe/Ljubljana', 80: 'Europe/Berlin', 81: 'Europe/Vienna', 82: 'Europe/Luxembourg',
  83: 'Europe/Rome', 84: 'Europe/Amsterdam', 85: 'Europe/Zurich', 86: 'Europe/Copenhagen', 87: 'Europe/Paris',
  88: 'Europe/Brussels', 94: 'Europe/Lisbon',
};

/** The time zone of a stop place, from its UIC station code, or null. */
function zoneOfStopPlace(stopPlaceRef) {
  const m = /^urn:uic:stn:(\d{7})$/.exec(String(stopPlaceRef || '').trim());
  return m ? UIC_COUNTRY_ZONES[Number(m[1].slice(0, 2))] || null : null;
}

// Minutes east of UTC that `zone` shows at the instant `ms`, or null.
function offsetAt(zone, ms) {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
    if (part?.value === 'GMT') return 0;
    const m = /^GMT([+-])(\d{2}):(\d{2})$/.exec(part?.value || '');
    if (!m) return null;
    const sign = m[1] === '-' ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  } catch {
    return null;
  }
}

const text = (minutes) => {
  const a = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};

/**
 * `dateTime` ("YYYY-MM-DDTHH:MM[:SS]±HH:MM") with the offset its local time
 * has on its own date in the stop place's zone; unchanged when it cannot be
 * told (see the file's comment).
 */
function onTheDay(dateTime, stopPlaceRef) {
  const zone = zoneOfStopPlace(stopPlaceRef);
  const m = typeof dateTime === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(:\d{2}(?:\.\d+)?)?([+-])(\d{2}):(\d{2})$/.exec(dateTime) : null;
  if (!zone || !m) return dateTime;
  const stored = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  const year = Number(m[1]);
  const winter = offsetAt(zone, Date.UTC(year, 0, 15));
  const summer = offsetAt(zone, Date.UTC(year, 6, 15));
  if (winter === null || summer === null || (stored !== winter && stored !== summer)) return dateTime;
  // The zone's offset at the instant the stored time names: the same as at the
  // local time, but within the hour of a clock change, where the local time
  // is ambiguous or missing and the stored offset is kept.
  const wall = Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const offset = offsetAt(zone, wall - stored * 60000);
  if (offset === null || offset === stored) return dateTime;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}${m[6] || ''}${text(offset)}`;
}

module.exports = { UIC_COUNTRY_ZONES, zoneOfStopPlace, onTheDay };
