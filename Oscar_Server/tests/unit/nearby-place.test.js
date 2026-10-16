'use strict';

/**
 * #766 PR 4 — a place near a reference place (AUTOMATIC_PLACE_SELECTION_NEARBY):
 * the scenario's reference, GET /availabilities/nearby, the booking request
 * and how the booking is graded. Also run end to end against the simulator's
 * own functions.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const np = require(path.join(LIB, 'namedPlaces.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const REF = { coachNumber: '7', placeNumber: '15' };
const available = (extra = {}) => ({ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', tripLegCoverage: { tripId: 'T1', legId: 'L1' }, ...extra });
const booked = (id, coachNumber, ...placeNumbers) => ({ id, placeAllocation: { reservedPlaces: [{ coachNumber, placeNumbers }] } });
const bookingOf = (...reservations) => ({ bookedOffers: [{ reservations }] });

describe('#766 PR 4 — the scenario and the request', () => {
  test('the reference place is "coach/place" text, anything else is none', () => {
    expect(np.referenceOfScenario({ referencePlace: ' 7 / 15 ' })).toEqual(REF);
    for (const referencePlace of ['7', '/15', '7/', '7/15/2', '', null, 715, { coachNumber: '7', placeNumber: '15' }]) {
      expect(np.referenceOfScenario({ referencePlace })).toBeNull();
    }
    expect(np.referenceOfScenario(null)).toBeNull();
  });

  test('the nearby query names the offer, the reservation and the place, encoded', () => {
    expect(np.nearbyQuery('O 1', 'R/1', REF)).toBe('/availabilities/nearby?contextId=O%201&contextType=OFFER&resourceId=R%2F1&resourceType=RESERVATION&coachNumber=7&placeNumber=15');
  });

  test('the reference place goes in every selection naming no place or compartment', () => {
    const named = { reservationId: 'R2', places: [{ coachNumber: '7', placeNumber: '13' }] };
    const box = { reservationId: 'R3', compartments: [{ coachNumber: '7', compartmentNumber: 'C1' }] };
    const out = np.withReferencePlace([{ reservationId: 'R1' }, named, box], REF);
    expect(out).toEqual([{ reservationId: 'R1', referencePlace: REF }, named, box]);
    expect(out[0].referencePlace).not.toBe(REF);
    expect(np.withReferencePlace([{ reservationId: 'R1' }], null)).toEqual([{ reservationId: 'R1' }]);
    expect(np.withReferencePlace(null, REF)).toEqual([]);
  });
});

describe('#766 PR 4 — the nearby answer', () => {
  test('2xx with free places: every check passes, the count is said', () => {
    const out = np.checkNearbyAnswer(200, { availablePlaces: [available({ numericAvailability: 17 })] }, 'R1', REF);
    expect(out.checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(out.lines).toEqual([{ level: 'INFO', text: 'GET /availabilities/nearby (reservation R1, near 7/15): 17 free place(s) near it.' }]);
  });

  test('no count: the entries are said; none free: a warning, not a failure', () => {
    expect(np.checkNearbyAnswer(200, { availablePlaces: [available()] }, 'R1', REF).lines[0].text).toMatch(/: 1 available place entry\.$/);
    expect(np.checkNearbyAnswer(200, { availablePlaces: [] }, 'R1', REF).lines[0].text).toMatch(/: 0 available place entries\.$/);
    const none = np.checkNearbyAnswer(200, { availablePlaces: [available({ numericAvailability: 0 })] }, 'R1', REF);
    expect(none.checks.every((c) => c.ok)).toBe(true);
    expect(none.lines[0].level).toBe('WARNING');
  });

  test('501, 404, 405: not provided, a warning; another status fails; a broken body fails', () => {
    for (const status of [404, 405, 501]) {
      const out = np.checkNearbyAnswer(status, null, 'R1', REF);
      expect(out.checks).toEqual([]);
      expect(out.lines[0].level).toBe('WARNING');
    }
    expect(np.checkNearbyAnswer(500, null, 'R1', REF).checks).toEqual([expect.objectContaining({ ok: false, message: 'HTTP 500' })]);
    expect(np.checkNearbyAnswer(200, {}, 'R1', REF).checks[1]).toMatchObject({ ok: false, message: 'availablePlaces is absent' });
    expect(np.checkNearbyAnswer(200, { availablePlaces: [available({ tripLegCoverage: { tripId: 'T1' } })] }, 'R1', REF).checks[2]).toMatchObject({ ok: false, message: '1 incomplete' });
  });
});

describe('#766 PR 4 — the booking', () => {
  test('seats in the reference coach, not the reference itself: both pass', () => {
    const checks = np.checkNearPlaceGiven(bookingOf(booked('R1', '7', '16', '17')), REF, ['R1']);
    expect(checks.map((c) => [c.level ?? 'test', c.ok])).toEqual([['warn', true], ['test', true]]);
  });

  test('another coach is a warning; the reference place given is a failure', () => {
    expect(np.checkNearPlaceGiven(bookingOf(booked('R1', '8', '52')), REF, ['R1'])[0]).toMatchObject({ level: 'warn', ok: false, message: 'given: 8/52' });
    expect(np.checkNearPlaceGiven(bookingOf(booked('R1', '7', '15', '16')), REF, ['R1'])[1]).toMatchObject({ ok: false, message: 'given: 7/15, 7/16' });
  });

  test('only the reservations booked are graded; a booking that renamed them is graded whole', () => {
    const booking = bookingOf(booked('R1', '7', '16'), booked('MANDATORY', '3', '1'));
    expect(np.checkNearPlaceGiven(booking, REF, ['R1'])).toHaveLength(2);
    expect(np.checkNearPlaceGiven(booking, REF, ['OLD'])).toHaveLength(4);
    expect(np.checkNearPlaceGiven(bookingOf({ id: 'R1' }), REF, ['R1'])[0]).toMatchObject({ ok: false, message: 'given: no place' });
    expect(np.checkNearPlaceGiven(booking, null, ['R1'])).toEqual([]);
  });
});

describe('#766 PR 4 — with the simulator\'s answers', () => {
  const SIM = path.join(ROOT, 'OSDM_Simulator');
  const { loadProviders } = require(path.join(SIM, 'src', 'config'));
  const { buildOfferCollection } = require(path.join(SIM, 'src', 'osdm', 'offers'));
  const { createBooking } = require(path.join(SIM, 'src', 'osdm', 'bookings'));
  const { nearbyAvailability } = require(path.join(SIM, 'src', 'osdm', 'placeMap'));
  const gamma = loadProviders(path.join(SIM, 'providers')).get('gamma');
  const NOW = Date.parse('2026-10-11T08:00:00Z');

  function sale(lastName) {
    const leg = { timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: gamma.placeMap.from }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
      service: { vehicleNumbers: ['521'], productCategory: { name: 'SC', shortName: 'SC' } },
    } };
    const refs = ['P1', 'P2'];
    const { response, remembered } = buildOfferCollection({ anonymousPassengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON' })), tripSpecifications: [{ legs: [leg] }] }, gamma, NOW);
    const offer = response.offers[0];
    const found = remembered.find((e) => e.offer.offerId === offer.offerId);
    const part = offer.reservationOfferParts[0];
    const answer = np.checkNearbyAnswer(200, nearbyAvailability(new URL(`https://x${np.nearbyQuery(offer.offerId, part.id, REF)}`).searchParams, found, gamma), part.id, REF);
    const trip = response.trips[0];
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: refs, placeSelections: np.withReferencePlace([{ reservationId: part.id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } }], REF) }],
      passengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON', detail: { firstName: 'A', lastName } })),
    }, () => found, gamma, NOW);
    return { part, answer, checks: np.checkNearPlaceGiven(booking, REF, [part.id]) };
  }

  test('the offer lists the flow, nearby is answered, the seats are near and not the reference', () => {
    const { part, answer, checks } = sale('B');
    expect(part.supportedPlaceSelectionFlows).toContain('AUTOMATIC_PLACE_SELECTION_NEARBY');
    expect(answer.checks.every((c) => c.ok)).toBe(true);
    expect(answer.lines[0].level).toBe('INFO');
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test('the ignores-reference-place variant: another coach, a warning only', () => {
    const checks = sale('Simvariant-Ignores-Reference-Place').checks;
    expect(checks.map((c) => [c.level ?? 'test', c.ok])).toEqual([['warn', false], ['test', true]]);
  });
});

describe('#766 PR 4 — the collection wiring', () => {
  afterEach(() => { delete global.bru; delete global.validationLogger; });

  test('parser, reset lists, 02, the builder and 07', () => {
    const parser = read('Bruno_Collection', 'library-bruno', 'scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("nearbyReference", _nearby ? JSON.stringify(_nearby) : null);');
    expect(parser).toContain('|| (_placePreferences.length > 0 || _namedPlace || _nearby ? "PLACE_SELECTION" : null));');
    const vars = '"__namedPlacesOutcome", "nearbyReference", "__nearbyAskedFor", "__nearbyOutcome"';
    for (const text of [parser, read('Bruno_Collection', 'opencollection.yml')]) expect(text).toContain(vars);
    const step02 = read('Bruno_Collection', '02-Common Requests', '02. POST Create Booking.yml');
    expect(step02.indexOf('offers.js").askNearbyPlace();')).toBeGreaterThan(step02.indexOf('offers.js").askNamedPlaces();'));
    expect(step02.indexOf('offers.js").askNearbyPlace();')).toBeLessThan(step02.indexOf('        buildBookingRequest();'));
    expect(read('Bruno_Collection', 'library-bruno', 'requestsBuilder.js')).toContain('_np.withReferencePlace(_np.withNamedPlaces(withSeatPreferences([');
    expect(read('Bruno_Collection', '02-Common Requests', '07. GET Booking after Fulfillments.yml')).toContain('namedPlaces.js").checkNearPlaceGiven(');
  });

  function withBru(env, run, sendRequest) {
    const logs = [];
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; }, sendRequest };
    global.validationLogger = (l) => logs.push(l);
    let result;
    jest.isolateModules(() => {
      jest.doMock(path.join(LIB, 'displays.js'), () => ({ validationLogger: (l) => logs.push(l), logStepStart: () => {} }));
      result = run(require(path.join(LIB, 'offers.js')));
    });
    return { logs, result };
  }

  const nearbyEnv = (extra = {}) => ({
    placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_NEARBY', nearbyReference: JSON.stringify(REF), offerId: 'O1',
    api_base: 'https://p.example/osdm', access_token: 't', osdmVersion: '3.8.0',
    placeSelections: '[{"reservationId":"R1"}]', reservationPlaceSelections: '[{"reservationId":"R1"},{"reservationId":"R2"}]', ...extra,
  });

  test('askNearbyPlace asks once per offer and reservation, and keeps the checks for 02', async () => {
    const env = nearbyEnv();
    const sent = [];
    const send = (req, cb) => { sent.push([req.method, req.url]); cb(null, { status: 200, data: { availablePlaces: [available({ numericAvailability: 3 })] } }); };
    const { logs, result } = withBru(env, (o) => o.askNearbyPlace(), send);
    await result;
    expect(sent).toEqual([
      ['GET', `https://p.example/osdm${np.nearbyQuery('O1', 'R1', REF)}`],
      ['GET', `https://p.example/osdm${np.nearbyQuery('O1', 'R2', REF)}`],
    ]);
    expect(logs).toEqual([
      '[INFO] GET /availabilities/nearby (reservation R1, near 7/15): 3 free place(s) near it.',
      '[INFO] GET /availabilities/nearby (reservation R2, near 7/15): 3 free place(s) near it.',
    ]);
    expect(JSON.parse(env.__nearbyOutcome).checks).toHaveLength(6);
    expect(env.__nearbyAskedFor).toBe('O1');
    await withBru(env, (o) => o.askNearbyPlace(), send).result;
    expect(sent).toHaveLength(2);
  });

  test('no reservation placed: a warning and nothing asked; another flow or no reference: nothing', async () => {
    const calls = [];
    const send = () => calls.push(1);
    const { logs, result } = withBru(nearbyEnv({ placeSelections: '[]', reservationPlaceSelections: '[]' }), (o) => o.askNearbyPlace(), send);
    await result;
    expect(logs).toEqual(['[WARNING] Nearby place: no reservation is placed in the booking, so no place near the reference is asked.']);
    for (const env of [nearbyEnv({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION' }), nearbyEnv({ nearbyReference: undefined }), nearbyEnv({ offerId: undefined })]) {
      await withBru(env, (o) => o.askNearbyPlace(), send).result;
    }
    expect(calls).toEqual([]);
  });
});
