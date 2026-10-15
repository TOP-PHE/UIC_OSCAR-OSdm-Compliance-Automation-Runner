// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #749: a trip switched to SPECIFICATION in Test Config had no legs, and the
 * run stopped before step 01 ("tripType=SPECIFICATION but .legs[] is empty").
 * The editor only changed the type and kept drawing the SEARCH fields, so
 * what the user typed went to trip{}, which the SPECIFICATION branch never
 * reads. Also, a night leg's arrival was put on its departure day.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js');
const source = fs.readFileSync(FILE, 'utf8');

function loadFunction(name, context) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

// The const the function reads, lifted from the page as it is.
const fieldsLine = source.slice(source.indexOf('const TRIP_LEG_FIELDS'), source.indexOf('];', source.indexOf('const TRIP_LEG_FIELDS')) + 2);
const TRIP_LEG_FIELDS = vm.runInNewContext(`${fieldsLine.replace('const TRIP_LEG_FIELDS =', '(')}`.replace(/\];$/, '])'));
const convertTripType = loadFunction('convertTripType', { TRIP_LEG_FIELDS });

// The provider's night train as Test Config stores a SEARCH trip.
const searchTrip = () => ({
  id: 1,
  tripType: 'SEARCH',
  trip: {
    origin: 'urn:uic:stn:8101003', destination: 'urn:uic:stn:8001071',
    startDatetime: '%TRIP_DATE%T19:36:00+02:00', endDatetime: '%TRIP_DATE%T08:38:00+01:00',
    vehicleNumber: '492', operatorCode: 'urn:uic:rics:1181',
    productCategoryRef: 'urn:uic:sbc:244', productCategoryName: 'Nightjet', productCategoryShortName: 'NJ',
    searchCriteria: { trainFilter: '' },
  },
});

describe('#749 — switching a trip to SPECIFICATION keeps what was typed', () => {
  test('a trip without legs gets one leg, copied from trip{}', () => {
    const t = convertTripType(searchTrip(), 'SPECIFICATION');
    expect(t.tripType).toBe('SPECIFICATION');
    expect(t.legs).toEqual([{
      origin: 'urn:uic:stn:8101003', destination: 'urn:uic:stn:8001071',
      startDatetime: '%TRIP_DATE%T19:36:00+02:00', endDatetime: '%TRIP_DATE%T08:38:00+01:00',
      vehicleNumber: '492', operatorCode: 'urn:uic:rics:1181',
      productCategoryRef: 'urn:uic:sbc:244', productCategoryName: 'Nightjet', productCategoryShortName: 'NJ',
    }]);
  });

  test('legs that are there are kept as they are', () => {
    const t = searchTrip();
    t.legs = [{ origin: 'A', destination: 'B' }, { origin: 'B', destination: 'C' }];
    expect(convertTripType(t, 'SPECIFICATION').legs).toEqual([{ origin: 'A', destination: 'B' }, { origin: 'B', destination: 'C' }]);
  });

  test('a trip with nothing typed gets one empty leg', () => {
    expect(convertTripType({ id: 2, tripType: 'SEARCH' }, 'SPECIFICATION').legs).toEqual([{}]);
  });

  test('back to SEARCH: an empty trip{} is filled from the legs, first departure to last arrival', () => {
    const t = { id: 3, tripType: 'SPECIFICATION', legs: [
      { origin: 'A', destination: 'B', startDatetime: '%TRIP_DATE%T07:00:00+01:00', endDatetime: '%TRIP_DATE%T08:00:00+01:00', vehicleNumber: '1' },
      { origin: 'B', destination: 'C', startDatetime: '%TRIP_DATE%T08:30:00+01:00', endDatetime: '%TRIP_DATE%T09:30:00+01:00', vehicleNumber: '2' },
    ] };
    const out = convertTripType(t, 'SEARCH');
    expect(out.trip).toEqual({ origin: 'A', destination: 'C', startDatetime: '%TRIP_DATE%T07:00:00+01:00', endDatetime: '%TRIP_DATE%T09:30:00+01:00', vehicleNumber: '1' });
    expect(out.legs).toHaveLength(2);
  });

  test('back to SEARCH: a trip{} that holds data is not overwritten', () => {
    const t = searchTrip();
    t.tripType = 'SPECIFICATION';
    t.legs = [{ origin: 'X', destination: 'Y' }];
    expect(convertTripType(t, 'SEARCH').trip.origin).toBe('urn:uic:stn:8101003');
  });

  test('the type select goes through it, and the editor never draws SEARCH fields for a SPECIFICATION trip', () => {
    expect(source).toMatch(/if \(el\.dataset\.field === 'tripType' && tIdxF >= 0\) \{\s*convertTripType\(state\.tripRequirements\[tIdxF\], el\.value\);/);
    const editor = source.slice(source.indexOf("if (trip.tripType === 'SPECIFICATION') {"), source.indexOf('} else {', source.indexOf("if (trip.tripType === 'SPECIFICATION') {")));
    expect(editor).toContain("const legs = Array.isArray(trip.legs) && trip.legs.length > 0 ? trip.legs : [{}];");
    expect(editor).toContain('inner += legs.map((leg, li) =>');
  });
});

describe('#749 — a night leg arrives the next day', () => {
  global.bru = { getEnvVar: () => undefined, setEnvVar: () => {}, deleteEnvVar: () => {}, getVar: () => undefined, setVar: () => {} };
  global.validationLogger = () => {};
  const { arrivalAfterDeparture } = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');

  test('an arrival before the departure is moved to the next day, its time and offset kept', () => {
    expect(arrivalAfterDeparture('2026-11-03T19:36:00+02:00', '2026-11-03T08:38:00+01:00')).toBe('2026-11-04T08:38:00+01:00');
    expect(arrivalAfterDeparture('2026-12-31T23:00:00+01:00', '2026-12-31T06:00:00+01:00')).toBe('2027-01-01T06:00:00+01:00');
    expect(arrivalAfterDeparture('2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z')).toBe('2026-11-04T10:00:00Z');
  });

  test('a day leg, or anything that cannot be read, is left as it is', () => {
    expect(arrivalAfterDeparture('2026-11-03T07:00:00+01:00', '2026-11-03T09:00:00+01:00')).toBe('2026-11-03T09:00:00+01:00');
    expect(arrivalAfterDeparture('not a date', '2026-11-03T08:38:00+01:00')).toBe('2026-11-03T08:38:00+01:00');
    expect(arrivalAfterDeparture('2026-11-03T19:36:00+02:00', 'later')).toBe('later');
  });

  test('the SPECIFICATION branch of the parser uses it for every leg', () => {
    const parser = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno', 'scenarioParser.js'), 'utf8');
    expect(parser).toMatch(/const endDatetime = arrivalAfterDeparture\(startDatetime, _sameDayEnd\);/);
  });
});
