'use strict';

/**
 * #774 — two gradings a real provider's seat reservation batch showed wrong:
 * a data file at "3.8" read as a mismatch with an API at "3.8.0", and a
 * reservation the provider said it ignored graded as a failure.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const { sameOsdmVersion } = require(path.join(LIB, 'osdmCompliance.js'));
const { ignoredParameters } = require(path.join(LIB, 'ignoredParameters.js'));
const sr = require(path.join(LIB, 'seatReservations.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const ignoredProblem = (name) => ({ code: 'urn:uic:problem:PARAMETER_NOT_SUPPORTED', title: `Parameter '${name}' was ignored.`, status: 501 });

describe('#774 — the OSDM version of the data file against the API\'s', () => {
  test('major.minor in the data file matches any patch of it', () => {
    expect(sameOsdmVersion('3.8', '3.8.0')).toBe(true);
    expect(sameOsdmVersion('3.8', '3.8.2')).toBe(true);
    expect(sameOsdmVersion('v3.8', '3.8.0')).toBe(true);
    expect(sameOsdmVersion(' 3.8 ', 'V3.8.0')).toBe(true);
  });

  test('a patch in the data file must be the API\'s; a missing API patch reads as 0', () => {
    expect(sameOsdmVersion('3.8.1', '3.8.1')).toBe(true);
    expect(sameOsdmVersion('3.8.1', '3.8.0')).toBe(false);
    expect(sameOsdmVersion('3.8.0', '3.8')).toBe(true);
    expect(sameOsdmVersion('3.8.1', '3.8')).toBe(false);
  });

  test('another minor, a longer number, a major alone or text are not the same version', () => {
    expect(sameOsdmVersion('3.8', '3.7.0')).toBe(false);
    expect(sameOsdmVersion('3.8', '3.80')).toBe(false);
    expect(sameOsdmVersion('3.8', '3')).toBe(false);
    expect(sameOsdmVersion('3.8', '3.x')).toBe(false);
    expect(sameOsdmVersion('3', '3.8.0')).toBe(false);
    expect(sameOsdmVersion('beta', 'beta')).toBe(true);
    expect(sameOsdmVersion(undefined, '3.8.0')).toBe(false);
  });

  test('the version check step compares through it', () => {
    const step = read('Bruno_Collection', '01-System Infos Requests', '00. GET System Version Check.yml');
    expect(step).toContain('return sameOsdmVersion(expectedVersion, versionString);');
    expect(step).not.toContain('return versionString === expectedVersion;');
  });
});

describe('#774 — a reservation the provider says it ignored', () => {
  test('the ignored member is the last segment of the name, from the pointers or the title', () => {
    expect(ignoredParameters({ problems: [ignoredProblem('offers.optionalReservationSelections'), ignoredProblem('offers.placeSelections.accommodations')] }))
      .toEqual(['optionalreservationselections', 'accommodations']);
    expect(ignoredParameters({ problems: [{ code: 'urn:uic:problem:PARAMETER_NOT_SUPPORTED', pointers: ['/offers/0/placeSelections'] }] })).toEqual(['placeselections']);
    expect(ignoredParameters({ problems: [{ code: 'urn:uic:problem:PROPERTY_SUBSTITUTED', title: "The value of item 'type' has been changed." }] })).toEqual([]);
    expect(ignoredParameters(null)).toEqual([]);
  });

  test('reservationsIgnored names the reservations sent through an ignored member', () => {
    const asked = { placeSelections: ['P1'], optionalReservationSelections: ['O1', 'O2'] };
    expect(sr.reservationsIgnored({ problems: [ignoredProblem('offers.optionalReservationSelections')] }, asked))
      .toEqual({ O1: 'optionalReservationSelections', O2: 'optionalReservationSelections' });
    expect(sr.reservationsIgnored({ problems: [ignoredProblem('offers.placeSelections')] }, asked)).toEqual({ P1: 'placeSelections' });
    // Ignoring the preferences inside a placeSelection is not ignoring the reservation.
    expect(sr.reservationsIgnored({ problems: [ignoredProblem('offers.placeSelections.accommodations')] }, asked)).toEqual({});
    expect(sr.reservationsIgnored({}, asked)).toEqual({});
    expect(sr.reservationsIgnored({ problems: [ignoredProblem('offers.placeSelections')] })).toEqual({});
  });

  const offer = { reservationOfferParts: [{ id: 'O1', summary: 'Seat 2nd class' }, { id: 'O2', summary: 'Seat 2nd class' }] };
  const emptyBooking = { bookedOffers: [{ reservations: [] }] };

  test('missing and said ignored: a warning that says "not supported"', () => {
    const checks = sr.checkBookedReservations(emptyBooking, offer, ['O1', 'O2'], { places: false, ignored: { O1: 'optionalReservationSelections', O2: 'optionalReservationSelections' } });
    expect(checks).toHaveLength(2);
    for (const c of checks) {
      expect(c).toMatchObject({ ok: false, level: 'warn' });
      expect(c.message).toContain('not supported: the provider says it ignored offers.optionalReservationSelections');
    }
  });

  test('missing without such a problem stays a failure; held stays a pass', () => {
    const [missing] = sr.checkBookedReservations(emptyBooking, offer, ['O1'], { places: false, ignored: { O2: 'optionalReservationSelections' } });
    expect(missing.ok).toBe(false);
    expect(missing.level).toBeUndefined();
    const held = { bookedOffers: [{ reservations: [{ id: 'R1' }] }] };
    const [ok] = sr.checkBookedReservations(held, offer, ['O1'], { places: false, ignored: { O1: 'optionalReservationSelections' } });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.level).toBeUndefined();
  });

  test('02, 07 and 09 pass the ignored reservations on, and log a warning as a warning', () => {
    const step02 = read('Bruno_Collection', '02-Common Requests', '02. POST Create Booking.yml');
    expect(step02).toContain('const _ignored = reservationsIgnored(_body, { placeSelections: _idsOf("reservationPlaceSelections"), optionalReservationSelections: _idsOf("optionalReservationSelections") });');
    expect(step02).toContain('bru.setEnvVar("__reservationsIgnored", JSON.stringify(_ignored));');
    expect(step02).toMatch(/ignored: _ignored \}\)\.forEach\(\(c\) => \{\n\s+if \(c\.level === "warn"\)/);
    expect(read('Bruno_Collection', '02-Common Requests', '07. GET Booking after Fulfillments.yml'))
      .toContain('ignored: fromEnv(bru.getEnvVar("__reservationsIgnored"), {})');
    const step09 = read('Bruno_Collection', '02-Common Requests', '09. POST Add Reservation to Booking.yml');
    expect(step09).toContain('...reservationsIgnored(body, { placeSelections: _ids })');
    expect(step09).toContain('ignored: _ignored }).forEach((c) => {');
  });

  test('the per-sale variable is in both reset lists and in the sub-run sale state', () => {
    expect(read('Bruno_Collection', 'opencollection.yml')).toContain('"__reservationsAddedLater", "__reservationsIgnored",');
    expect(read('Bruno_Collection', 'library-bruno', 'scenarioParser.js')).toContain('"__reservationsAddedLater", "__reservationsIgnored",');
    expect(read('Bruno_Collection', 'library-bruno', 'expiredFlow.js')).toContain("'__reservationsAddedLater', '__reservationsIgnored',");
  });
});
