'use strict';

/**
 * #772 — two defects of OSCAR's own seen on a real provider's run: a
 * specification trip kept the summer offset after the clock change, and the
 * passenger update sent `detail.contact` to a provider below OSDM 3.4.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const tz = require(path.join(LIB, 'stationTimeZones.js'));
const pc = require(path.join(LIB, 'personContact.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const NL = 'urn:uic:stn:8400058';
const DE = 'urn:uic:stn:8000152';
const UK = 'urn:uic:stn:7015400';
const FI = 'urn:uic:stn:1000001';

describe('#772 — a timetable time takes the offset of the trip date', () => {
  test('the time zone comes from the UIC country of a 7-digit station code', () => {
    expect(tz.zoneOfStopPlace(NL)).toBe('Europe/Amsterdam');
    expect(tz.zoneOfStopPlace(` ${DE} `)).toBe('Europe/Berlin');
    for (const ref of ['urn:uic:stn:0000091', 'urn:uic:stn:840058', 'urn:x:stn:8400058', '', null]) expect(tz.zoneOfStopPlace(ref)).toBeNull();
  });

  test('a summer offset on a winter day, and a winter one on a summer day, are given the day\'s', () => {
    expect(tz.onTheDay('2026-10-26T08:00:00+02:00', NL)).toBe('2026-10-26T08:00:00+01:00');
    expect(tz.onTheDay('2026-06-01T08:00+01:00', DE)).toBe('2026-06-01T08:00+02:00');
    expect(tz.onTheDay('2026-07-01T08:00:00+00:00', UK)).toBe('2026-07-01T08:00:00+01:00');
    expect(tz.onTheDay('2026-12-01T08:00:00+03:00', FI)).toBe('2026-12-01T08:00:00+02:00');
  });

  test('the right offset already, one that is not the zone\'s, an unknown station or a malformed time: unchanged', () => {
    expect(tz.onTheDay('2026-07-26T08:00:00+02:00', NL)).toBe('2026-07-26T08:00:00+02:00');
    expect(tz.onTheDay('2026-10-26T08:00:00+00:00', NL)).toBe('2026-10-26T08:00:00+00:00');
    expect(tz.onTheDay('2026-10-26T08:00:00+02:00', 'urn:uic:stn:0000091')).toBe('2026-10-26T08:00:00+02:00');
    expect(tz.onTheDay('2026-10-26T08:00:00Z', NL)).toBe('2026-10-26T08:00:00Z');
    expect(tz.onTheDay(undefined, NL)).toBeUndefined();
  });

  test('around the clock change: the day after and the day of, both ways', () => {
    expect(tz.onTheDay('2026-10-25T08:00:00+02:00', NL)).toBe('2026-10-25T08:00:00+01:00');
    expect(tz.onTheDay('2026-10-24T23:30:00+02:00', NL)).toBe('2026-10-24T23:30:00+02:00');
    expect(tz.onTheDay('2026-03-29T08:00:00+01:00', NL)).toBe('2026-03-29T08:00:00+02:00');
    expect(tz.onTheDay('2026-03-28T23:30:00+01:00', NL)).toBe('2026-03-28T23:30:00+01:00');
  });

  test('a sandbox without time zones leaves the time as it is', () => {
    const real = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function () { throw new RangeError('no time zone data'); };
    try {
      expect(tz.onTheDay('2026-10-26T08:00:00+02:00', NL)).toBe('2026-10-26T08:00:00+02:00');
    } finally {
      Intl.DateTimeFormat = real;
    }
  });

  test('the parser gives each leg its stop places\' offset, and says so', () => {
    const parser = read('Bruno_Collection', 'library-bruno', 'scenarioParser.js');
    expect(parser).toContain("const startDatetime = onTheDay(_storedStart, leg.origin);");
    expect(parser).toContain("const endDatetime = onTheDay(_storedEnd, leg.destination);");
  });
});

describe('#772 — email and phone where the version takes them', () => {
  test('from 3.4 in detail.contact, below flat in detail, as the booking does', () => {
    expect(pc.usesContactDetail('3.4.0')).toBe(true);
    expect(pc.usesContactDetail('3.8.0')).toBe(true);
    expect(pc.usesContactDetail('3.0.5')).toBe(false);
    expect(pc.usesContactDetail('3.3')).toBe(false);
    const detail = { firstName: 'A', lastName: 'B', contact: { email: 'e@x', phoneNumber: '+1' } };
    expect(pc.withContactShape(detail, '3.8.0')).toEqual(detail);
    expect(pc.withContactShape(detail, '3.0.5')).toEqual({ firstName: 'A', lastName: 'B', email: 'e@x', phoneNumber: '+1' });
  });

  test('the value under contact wins; flat values move under contact from 3.4; nothing to place, nothing added', () => {
    const mixed = { firstName: 'A', email: 'old@x', phoneNumber: '+0', contact: { email: 'new@x' } };
    expect(pc.withContactShape(mixed, '3.0.5')).toEqual({ firstName: 'A', email: 'new@x', phoneNumber: '+0' });
    expect(pc.withContactShape(mixed, '3.8.0')).toEqual({ firstName: 'A', contact: { email: 'new@x', phoneNumber: '+0' } });
    expect(pc.withContactShape({ firstName: 'A', contact: {} }, '3.8.0')).toEqual({ firstName: 'A' });
    expect(pc.withContactShape({ firstName: 'A', contact: { preferredLanguage: 'fr' } }, '3.0.5')).toEqual({ firstName: 'A', contact: { preferredLanguage: 'fr' } });
    expect(pc.withContactShape(null, '3.8.0')).toEqual({});
  });

  test('the passenger update and the purchaser body take the shape from the run\'s version', () => {
    expect(read('Bruno_Collection', '02-Common Requests', '03. PATCH Multi Passenger.yml'))
      .toContain('personContact.js").withContactShape(_patch.detail, bru.getEnvVar("osdmVersion"));');
    let store = {};
    global.bru = { getEnvVar: (k) => store[k], setEnvVar: (k, v) => { store[k] = v; }, setVar: (k, v) => { store[k] = v; } };
    global.validationLogger = () => {};
    try {
      let rb;
      jest.isolateModules(() => { rb = require(path.join(LIB, 'requestsBuilder.js')); });
      const spec = JSON.stringify({ detail: { firstName: 'P', lastName: 'Q', email: 'p@x', phoneNumber: '+1' } });
      store = { osdmVersion: '3.0.5', bookingPurchaserSpecifications: spec, purchaserAdditionalData: '{"updateEmail":"new@x"}' };
      expect(rb.buildBookingPurchaserBody().detail).toEqual({ firstName: 'P', lastName: 'Q', email: 'new@x', phoneNumber: '+1' });
      store = { osdmVersion: '3.8.0', bookingPurchaserSpecifications: spec, purchaserAdditionalData: '{"updateEmail":"new@x"}' };
      expect(rb.buildBookingPurchaserBody().detail).toEqual({ firstName: 'P', lastName: 'Q', contact: { email: 'new@x', phoneNumber: '+1' } });
    } finally {
      delete global.bru;
      delete global.validationLogger;
    }
  });
});
