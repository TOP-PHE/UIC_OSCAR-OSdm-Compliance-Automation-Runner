/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * tripCalendar.js — a date on which the trip's trains run (#717). Pure.
 *
 * OSCAR's server annotates each trip requirement it hands to a run with the
 * days its Test Data trains run (`__operatingDays`, 'MON'..'SUN') and notes
 * for the log (`__calendarNotes`). With no day named by the scenario, the
 * date moves from the usual one (today + lead time) to the first following
 * day they all run. A day the scenario names is kept, with a warning when the
 * trains do not run then.
 */

const DAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** 'MON'..'SUN' of a 'YYYY-MM-DD' date (its calendar day), '' when not a date. */
function weekdayCode(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoDate || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? '' : DAY_CODES[d.getUTCDay()];
}

function addDays(isoDate, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return d.toISOString().slice(0, 10);
}

/** The days of the annotation, or null when there is none to follow. */
function operatingDaysOf(trip) {
  if (!trip || !Array.isArray(trip.__operatingDays)) return null;
  return trip.__operatingDays.filter((d) => DAY_CODES.includes(d));
}

/**
 * The trip date: `date` as the usual rules gave it (`named` when the scenario
 * named the day itself), checked against the trip's calendar.
 * @returns {{ date: string, lines: string[] }} lines for the run log.
 */
function dateForTrip(date, named, trip) {
  const days = operatingDaysOf(trip);
  const lines = [];
  const notes = trip && Array.isArray(trip.__calendarNotes) ? trip.__calendarNotes : [];
  for (const n of notes) {
    if (n && typeof n.text === 'string') lines.push(`[${n.level === 'WARNING' ? 'WARNING' : 'INFO'}] 📅 ${n.text}`);
  }
  if (!days || days.length === 0 || !weekdayCode(date)) return { date, lines };
  const list = days.join(', ');
  if (named) {
    if (!days.includes(weekdayCode(date))) {
      lines.push(`[WARNING] 📅 Departure ${date} (${weekdayCode(date)}) is the day the scenario names, but its trains run on ${list} in Test Data: the provider may not offer them that day.`);
    }
    return { date, lines };
  }
  for (let shift = 0; shift < 7; shift++) {
    const candidate = addDays(date, shift);
    if (days.includes(weekdayCode(candidate))) {
      lines.push(shift === 0
        ? `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}): the trip's trains run that day (${list}).`
        : `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}), ${shift} day(s) after ${date}: the first day the trip's trains run (${list}).`);
      return { date: candidate, lines };
    }
  }
  return { date, lines };
}

module.exports = { weekdayCode, operatingDaysOf, dateForTrip };
