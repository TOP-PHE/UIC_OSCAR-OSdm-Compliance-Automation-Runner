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
 *
 * A return (#778): the server also lists the services of the way back
 * (`__returnServices`). Those leaving at or after the return time can answer
 * the return request; the date then moves to the first day on which the
 * outbound trains run and one of them runs `offsetDays` later.
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

// The server's notes, as run log lines.
function noteLines(trip) {
  const notes = Array.isArray(trip?.__calendarNotes) ? trip.__calendarNotes : [];
  return notes.filter((n) => typeof n?.text === 'string')
    .map((n) => `[${n.level === 'WARNING' ? 'WARNING' : 'INFO'}] 📅 ${n.text}`);
}

// The first day from `date` on, within a week, that is one of `days`.
function firstRunningDay(date, days) {
  for (let shift = 0; shift < 7; shift++) {
    const candidate = addDays(date, shift);
    if (days.includes(weekdayCode(candidate))) return { candidate, shift };
  }
  return null;
}

const namedDayWarning = (date, days) => `[WARNING] 📅 Departure ${date} (${weekdayCode(date)}) is the day the scenario names, but its trains run on ${days.join(', ')} in Test Data: the provider may not offer them that day.`;

const clockOf = (value) => {
  const m = /(\d{2}):(\d{2})/.exec(String(value ?? ''));
  return m ? `${m[1]}:${m[2]}` : '';
};

/**
 * The days a return can go back (#778), from the server's `__returnServices`.
 * `ret` = { offsetDays, time, outboundClock }: the return leaves `offsetDays`
 * after the outbound, at `time` ('HH:MM'), else at the outbound's clock.
 * @returns {{ days: string[]|null, offset: number, at: string, lines: string[] }}
 *   days null when nothing is known to check.
 */
function returnDays(trip, ret) {
  const offset = Number.parseInt(ret?.offsetDays, 10);
  const none = { days: null, offset: 0, at: '', lines: [] };
  if (!ret || !Number.isInteger(offset) || offset < 0) return none;
  const services = (Array.isArray(trip?.__returnServices) ? trip.__returnServices : [])
    .filter((s) => /^\d{2}:\d{2}$/.test(String(s?.departure)));
  if (services.length === 0) return none;
  const at = /^\d{2}:\d{2}$/.test(String(ret.time ?? '').trim()) ? String(ret.time).trim() : clockOf(ret.outboundClock);
  const later = at ? services.filter((s) => s.departure >= at) : services;
  if (later.length === 0) {
    const times = services.map((s) => (s.number ? `${s.departure} (${s.number})` : s.departure)).join(', ');
    return { ...none, lines: [`[WARNING] 📅 Return at ${at}: no Test Data train goes back after that time (they leave at ${times}). The provider may find no return trip: set the scenario's return time before the last one.`] };
  }
  if (later.some((s) => !Array.isArray(s.days) || s.days.length === 0)) return { ...none, offset, at };
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].filter((d) => later.some((s) => s.days.includes(d)));
  return { days, offset, at, lines: [] };
}

// The first day from `date` on, within a week, on which the outbound runs
// (`outDays`, null = any) and a return runs `offset` days later.
function firstDayWithReturn(date, outDays, backDays, offset) {
  for (let shift = 0; shift < 7; shift++) {
    const candidate = addDays(date, shift);
    if (outDays && !outDays.includes(weekdayCode(candidate))) continue;
    if (backDays.includes(weekdayCode(addDays(candidate, offset)))) return { candidate, shift };
  }
  return null;
}

// dateForTrip() for a return whose way back has a known calendar.
function dateWithReturn(date, named, outDays, back, lines) {
  const { days: backDays, offset, at } = back;
  const backList = backDays.join(', ');
  const backDate = (d) => addDays(d, offset);
  if (named) {
    if (!backDays.includes(weekdayCode(backDate(date)))) {
      lines.push(`[WARNING] 📅 Return ${backDate(date)} (${weekdayCode(backDate(date))}) follows the day the scenario names, but the trains going back after ${at} run on ${backList} in Test Data: the provider may find no return trip.`);
    }
    return { date, lines };
  }
  const found = firstDayWithReturn(date, outDays && outDays.length ? outDays : null, backDays, offset);
  if (!found) {
    lines.push(`[WARNING] 📅 No day suits both the outbound trains and the trains going back ${offset} day(s) later after ${at} (${backList}) in Test Data.`);
    return { date, lines };
  }
  const { candidate, shift } = found;
  const back2 = `return ${backDate(candidate)} (${weekdayCode(backDate(candidate))}) after ${at}`;
  lines.push(shift === 0
    ? `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}), ${back2}: the trains run on both days.`
    : `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}), ${shift} day(s) after ${date}, ${back2}: the first such pair of days the trains run.`);
  return { date: candidate, lines };
}

/**
 * The trip date: `date` as the usual rules gave it (`named` when the scenario
 * named the day itself), checked against the trip's calendar.
 * `ret` (#778): { offsetDays, time, outboundClock } of a return scenario.
 * @returns {{ date: string, lines: string[] }} lines for the run log.
 */
function dateForTrip(date, named, trip, ret = null) {
  const days = operatingDaysOf(trip);
  const lines = noteLines(trip);
  const back = returnDays(trip, ret);
  lines.push(...back.lines);
  if (back.days && back.days.length && weekdayCode(date)) {
    if (named && days && days.length && !days.includes(weekdayCode(date))) lines.push(namedDayWarning(date, days));
    return dateWithReturn(date, named, days, back, lines);
  }
  if (!days || days.length === 0 || !weekdayCode(date)) return { date, lines };
  const list = days.join(', ');
  if (named) {
    if (!days.includes(weekdayCode(date))) lines.push(namedDayWarning(date, days));
    return { date, lines };
  }
  const found = firstRunningDay(date, days);
  if (!found) return { date, lines };
  const { candidate, shift } = found;
  lines.push(shift === 0
    ? `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}): the trip's trains run that day (${list}).`
    : `[INFO] 📅 Departure ${candidate} (${weekdayCode(candidate)}), ${shift} day(s) after ${date}: the first day the trip's trains run (${list}).`);
  return { date: candidate, lines };
}

module.exports = { weekdayCode, operatingDaysOf, returnDays, dateForTrip };
