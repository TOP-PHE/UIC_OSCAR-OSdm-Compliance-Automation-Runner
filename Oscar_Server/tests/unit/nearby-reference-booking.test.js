'use strict';

/**
 * #776 — the reference place of the NEARBY flow taken from a first booking:
 * the scenario's AUTO, the offer and booking for passenger A, the place read
 * from it, the scenario's booking near it, and A's booking deleted. Also run
 * against the simulator's own functions.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const rb = require(path.join(LIB, 'referenceBooking.js'));
const np = require(path.join(LIB, 'namedPlaces.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const NEARBY = 'AUTOMATIC_PLACE_SELECTION_NEARBY';
const part = (id, extra = {}) => ({ id, passengerRefs: ['P1'], ...extra });
const summary = (overallFlexibility, amount) => ({ offerSummary: { overallFlexibility, overallTravelClass: 'SECOND', minimalPrice: { amount } } });
const offerOf = (offerId, parts, extra = {}) => ({ offerId, reservationOfferParts: parts, ...summary('FULL_FLEXIBLE', 1000), ...extra });
const trips = [{ id: 'T1', legs: [{ id: 'L1' }] }];
const placed = (id, coachNumber, ...placeNumbers) => ({ booking: { id, bookedOffers: [{ reservations: [{ id: 'R', placeAllocation: { reservedPlaces: [{ coachNumber, placeNumbers }] } }] }] } });

describe('#776 — the scenario', () => {
  test('the NEARBY flow with referencePlace empty, absent or AUTO takes it from a first booking', () => {
    for (const referencePlace of [undefined, null, '', '  ', 'AUTO', ' auto ']) {
      expect(rb.isAutoReference({ placeSelectionFlow: NEARBY, referencePlace })).toBe(true);
    }
  });

  test('a place written, another flow, or no flow: not', () => {
    expect(rb.isAutoReference({ placeSelectionFlow: NEARBY, referencePlace: '7/15' })).toBe(false);
    expect(rb.isAutoReference({ placeSelectionFlow: NEARBY, referencePlace: 15 })).toBe(false);
    expect(rb.isAutoReference({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION', referencePlace: 'AUTO' })).toBe(false);
    expect(rb.isAutoReference({ referencePlace: 'AUTO' })).toBe(false);
    expect(rb.isAutoReference(null)).toBe(false);
    // "AUTO" is no coach/place for the older rule.
    expect(np.referenceOfScenario({ referencePlace: 'AUTO' })).toBeNull();
  });
});

describe('#776 — the requests for passenger A', () => {
  test('the offer request keeps the first passenger only, under the name it has', () => {
    const request = { anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }], tripSearchCriteria: { x: 1 } };
    expect(rb.referenceOfferRequest(request)).toEqual({ body: { anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }], tripSearchCriteria: { x: 1 } }, passengerRef: 'P1' });
    expect(request.anonymousPassengerSpecifications).toHaveLength(2);
    expect(rb.referenceOfferRequest({ passengerSpecifications: [{ externalRef: 'A' }, { externalRef: 'B' }] }).body.passengerSpecifications).toEqual([{ externalRef: 'A' }]);
    for (const bad of [null, {}, { anonymousPassengerSpecifications: [] }, { anonymousPassengerSpecifications: [{ type: 'PERSON' }] }]) {
      expect(rb.referenceOfferRequest(bad)).toBeNull();
    }
  });

  test('the offer booked holds a reservation and stands for the chosen one', () => {
    const chosen = offerOf('MAIN', [part('X')]);
    const without = offerOf('NO-RES', []);
    const other = offerOf('FIRST', [part('R')], summary('NON_FLEXIBLE', 1000));
    const same = offerOf('SAME', [part('R')], summary('FULL_FLEXIBLE', 500));
    expect(rb.referenceOffer(chosen, [without, other, same])).toMatchObject({ offer: { offerId: 'SAME' } });
    expect(rb.referenceOffer(chosen, [without])).toBeNull();
    expect(rb.referenceOffer(chosen, null)).toBeNull();
  });

  test('the booking request: A alone, each reservation placed on its leg, else named as optional', () => {
    const offer = offerOf('O1', [part('R1', { tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } }), part('R2', { tripCoverage: { coveredTripId: 'T9' } })]);
    const passenger = { externalRef: 'old', type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } };
    expect(rb.referenceBookingRequest({ offer, trips, passenger, purchaser: { detail: { firstName: 'P' } }, passengerRef: 'P1' })).toEqual({
      offers: [{ offerId: 'O1', passengerRefs: ['P1'], placeSelections: [{ reservationId: 'R1', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }], optionalReservationSelections: [{ reservationId: 'R2' }] }],
      passengerSpecifications: [{ ...passenger, externalRef: 'P1' }],
      purchaser: { detail: { firstName: 'P' } },
    });
    const onlyPlaced = rb.referenceBookingRequest({ offer: offerOf('O2', [part('R1')]), trips, passenger, passengerRef: 'P1' });
    expect(onlyPlaced.offers[0]).toEqual({ offerId: 'O2', passengerRefs: ['P1'], placeSelections: [{ reservationId: 'R1', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }] });
    expect(onlyPlaced.purchaser).toBeUndefined();
    expect(rb.referenceBookingRequest({ offer: offerOf('O3', []), trips, passenger, passengerRef: 'P1' })).toBeNull();
    expect(rb.referenceBookingRequest({ offer: offerOf('O4', [part('R1')]), trips, passenger: null, passengerRef: 'P1' })).toBeNull();
  });

  test('the place given: the first coach and place number of a reservation, else why there is none', () => {
    expect(rb.placeOfReferenceBooking(placed('B1', '7', '11', '12'))).toEqual({ bookingId: 'B1', coachNumber: '7', placeNumber: '11' });
    const noNumber = { booking: { id: 'B2', bookedOffers: [{ reservations: [{ placeAllocation: { reservedPlaces: [{ coachNumber: '7', placeNumbers: [] }] } }] }] } };
    expect(rb.placeOfReferenceBooking(noNumber)).toEqual({ bookingId: 'B2', missing: 'its reservation names no coach and place number' });
    expect(rb.placeOfReferenceBooking({ booking: { id: 'B3', bookedOffers: [{ reservations: [] }] } })).toEqual({ bookingId: 'B3', missing: 'the booking holds no reservation' });
    expect(rb.placeOfReferenceBooking(null)).toEqual({ bookingId: null, missing: 'the booking holds no reservation' });
  });
});

describe('#776 — in the run (offers.js)', () => {
  afterEach(() => { delete global.bru; delete global.validationLogger; });

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

  const env = (extra = {}) => ({
    placeSelectionFlow: NEARBY, nearbyReferenceAuto: 'true', offerId: 'O1',
    api_base: 'https://p.example/osdm', access_token: 't', osdmVersion: '3.8.0',
    placeSelections: '[]', reservationPlaceSelections: '[{"reservationId":"R1"}]',
    OfferCollectionRequest: JSON.stringify({ anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }] }),
    bookingPassengerSpecifications: JSON.stringify([{ externalRef: 'P1', type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } }, { externalRef: 'P2', type: 'PERSON' }]),
    bookingPurchaserSpecifications: JSON.stringify({ detail: { firstName: 'P' } }),
    offer: JSON.stringify(offerOf('O1', [part('R1')])),
    ...extra,
  });

  // The provider: answers by method and path; records what was sent.
  function provider(sent, answers) {
    return (req, cb) => {
      const where = req.url.replace('https://p.example/osdm', '').split('?')[0];
      sent.push([req.method, where, req.data ? JSON.parse(req.data) : undefined]);
      const a = answers[`${req.method} ${where}`] || answers[`${req.method} *`] || { status: 404, data: null };
      cb(null, { status: a.status, data: a.data });
    };
  }
  const offersAnswer = { status: 200, data: { offers: [offerOf('A1', [part('RA')], summary('FULL_FLEXIBLE', 500))], trips } };
  const nearby = { status: 200, data: { availablePlaces: [] } };

  test('A is booked first, the place given becomes the reference, nearby is asked for it, A deleted after', async () => {
    const e = env();
    const sent = [];
    const send = provider(sent, { 'POST /offers': offersAnswer, 'POST /bookings': { status: 200, data: placed('BA', '7', '13') }, 'GET /availabilities/nearby': nearby, 'DELETE /bookings/BA': { status: 204, data: '' } });
    const { logs, result } = withBru(e, (o) => o.askNearbyPlace(), send);
    await result;
    expect(sent.map(([m, w]) => `${m} ${w}`)).toEqual(['POST /offers', 'POST /bookings', 'GET /availabilities/nearby']);
    expect(sent[0][2].anonymousPassengerSpecifications).toEqual([{ externalRef: 'P1', type: 'PERSON' }]);
    expect(sent[1][2]).toEqual({
      offers: [{ offerId: 'A1', passengerRefs: ['P1'], placeSelections: [{ reservationId: 'RA', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }] }],
      passengerSpecifications: [{ externalRef: 'P1', type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } }],
      purchaser: { detail: { firstName: 'P' } },
    });
    expect(JSON.parse(e.nearbyReference)).toEqual({ coachNumber: '7', placeNumber: '13' });
    expect(e.__referenceBookingId).toBe('BA');
    expect(logs[0]).toBe('[INFO] Nearby place: the reference place is 7/13, given to passenger P1 alone in booking BA (offer A1, the same flexibility and travel class); the scenario\'s booking asks for places near it.');
    // Once per sale.
    await withBru(e, (o) => o.askNearbyPlace(), send).result;
    expect(sent.filter(([m]) => m === 'POST')).toHaveLength(2);
    // Released once the scenario's booking is answered.
    const released = withBru(e, (o) => o.releaseReferenceBooking(), send);
    await released.result;
    expect(sent.at(-1)).toEqual(['DELETE', '/bookings/BA', undefined]);
    expect(released.logs).toEqual(['[INFO] Nearby place: passenger A\'s booking BA (the reference place) is deleted (HTTP 204).']);
    expect(e.__referenceBookingId).toBeNull();
    await withBru(e, (o) => o.releaseReferenceBooking(), send).result;
    expect(sent.filter(([m]) => m === 'DELETE')).toHaveLength(1);
  });

  test('a delete refused is a warning naming the booking', async () => {
    const e = env({ __referenceBookingId: 'BA' });
    const { logs, result } = withBru(e, (o) => o.releaseReferenceBooking(), provider([], { 'DELETE /bookings/BA': { status: 409, data: { code: 'BOOKING_CONFIRMED' } } }));
    await result;
    expect(logs).toEqual(['[WARNING] Nearby place: passenger A\'s booking BA (the reference place) could not be deleted (HTTP 409, BOOKING_CONFIRMED); it stays pre-booked until it expires.']);
  });

  const skipped = async (answers, extra = {}) => {
    const e = env(extra);
    const sent = [];
    const { logs, result } = withBru(e, (o) => o.askNearbyPlace(), provider(sent, answers));
    await result;
    return { e, sent, logs };
  };

  test('no offer with a reservation, a booking refused or without a place: a warning, and no reference place', async () => {
    let out = await skipped({ 'POST /offers': { status: 500, data: null } });
    expect(out.logs).toEqual(['[WARNING] Nearby place: no reference place, the offers asked for passenger P1 alone (HTTP 500) hold no reservation; the place near another passenger is not tested.']);
    expect(out.e.nearbyReference).toBeUndefined();
    expect(out.sent).toHaveLength(1);

    out = await skipped({ 'POST /offers': offersAnswer, 'POST /bookings': { status: 500, data: { code: 'urn:uic:problem:UNKNOWN_ERROR' } } });
    expect(out.logs[0]).toBe('[WARNING] Nearby place: no reference place, passenger P1\'s booking on offer A1 was refused (HTTP 500, urn:uic:problem:UNKNOWN_ERROR); the place near another passenger is not tested.');
    expect(out.e.__referenceBookingId).toBeUndefined();

    out = await skipped({ 'POST /offers': offersAnswer, 'POST /bookings': { status: 200, data: { booking: { id: 'BX', bookedOffers: [{ reservations: [] }] } } } });
    expect(out.logs[0]).toBe('[WARNING] Nearby place: no reference place, passenger P1\'s booking BX: the booking holds no reservation; the place near another passenger is not tested.');
    // Kept so that it is deleted all the same.
    expect(out.e.__referenceBookingId).toBe('BX');
    expect(out.e.nearbyReference).toBeUndefined();
  });

  test('nothing to book A with: a warning, nothing sent', async () => {
    let out = await skipped({}, { OfferCollectionRequest: '{}' });
    expect(out.logs).toEqual(['[WARNING] Nearby place: no reference place, the offer request names no passenger to book first; the place near another passenger is not tested.']);
    expect(out.sent).toEqual([]);
    out = await skipped({ 'POST /offers': offersAnswer }, { bookingPassengerSpecifications: '[]' });
    expect(out.logs).toEqual(['[WARNING] Nearby place: no reference place, passenger A\'s booking could not be built; the place near another passenger is not tested.']);
  });

  test('not asked: a place written in the scenario, another flow, no reservation placed, or the choice made after the booking', async () => {
    for (const extra of [{ nearbyReferenceAuto: undefined }, { placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION' }, { reservationPlaceSelections: '[]' },
      { reservationBookingForm: 'ADD_LATER', reservationAddLaterSelections: '[{"reservationId":"R9"}]' }]) {
      const out = await skipped({ '* *': offersAnswer }, extra);
      expect(out.sent.filter(([m]) => m === 'POST')).toEqual([]);
    }
  });

  test('ADD_LATER: A is booked before 09, for the reservations added after the booking', async () => {
    const e = env({ reservationBookingForm: 'ADD_LATER', reservationAddLaterSelections: '[{"reservationId":"R9"}]', bookingId: 'MAIN', reservationPlaceSelections: '[]' });
    const sent = [];
    const { result } = withBru(e, (o) => o.askPlacesAfterBooking(), provider(sent, { 'POST /offers': offersAnswer, 'POST /bookings': { status: 200, data: placed('BA', '7', '13') }, 'GET /availabilities/nearby': nearby }));
    await result;
    expect(sent.map(([m, w]) => `${m} ${w}`)).toEqual(['POST /offers', 'POST /bookings', 'GET /availabilities/nearby']);
    expect(e.nearbyReference).toBe('{"coachNumber":"7","placeNumber":"13"}');
  });
});

describe('#776 — with the simulator\'s answers', () => {
  const SIM = path.join(ROOT, 'OSDM_Simulator');
  const { loadProviders } = require(path.join(SIM, 'src', 'config'));
  const { buildOfferCollection } = require(path.join(SIM, 'src', 'osdm', 'offers'));
  const { createBooking } = require(path.join(SIM, 'src', 'osdm', 'bookings'));
  const gamma = loadProviders(path.join(SIM, 'providers')).get('gamma');
  const NOW = Date.parse('2026-10-11T08:00:00Z');
  const leg = { timedLeg: {
    start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: gamma.placeMap.from }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
    end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
    service: { vehicleNumbers: ['521'], productCategory: { name: 'SC', shortName: 'SC' } },
  } };
  const request = { anonymousPassengerSpecifications: [{ externalRef: 'P1', type: 'PERSON' }, { externalRef: 'P2', type: 'PERSON' }], tripSpecifications: [{ legs: [leg] }] };
  const people = (refs) => refs.map((externalRef) => ({ externalRef, type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } }));

  test('A gets a seat of the map; the others are given seats near it, not A\'s', () => {
    const first = rb.referenceOfferRequest(request);
    const forA = buildOfferCollection(first.body, gamma, NOW);
    const pick = rb.referenceOffer(null, forA.response.offers);
    const body = rb.referenceBookingRequest({ offer: pick.offer, trips: forA.response.trips, passenger: people(['P1'])[0], passengerRef: 'P1' });
    const bookingA = createBooking(body, (id) => forA.remembered.find((x) => x.offer.offerId === id), gamma, NOW);
    const ref = rb.placeOfReferenceBooking({ booking: bookingA });
    expect(ref.coachNumber).toBe('7');

    const sale = buildOfferCollection(request, gamma, NOW);
    const offer = sale.response.offers[0];
    const reservation = offer.reservationOfferParts[0];
    const trip = sale.response.trips[0];
    const near = { coachNumber: ref.coachNumber, placeNumber: ref.placeNumber };
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: ['P1', 'P2'], placeSelections: np.withReferencePlace([{ reservationId: reservation.id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } }], near) }],
      passengerSpecifications: people(['P1', 'P2']),
    }, (id) => sale.remembered.find((x) => x.offer.offerId === id), gamma, NOW);
    expect(np.checkNearPlaceGiven(booking, near, [reservation.id]).every((c) => c.ok)).toBe(true);
  });
});

describe('#776 — the wiring', () => {
  test('the parser flags AUTO, books its reservations by placeSelections, and every per-sale variable is reset', () => {
    const parser = read('Bruno_Collection', 'library-bruno', 'scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("nearbyReferenceAuto", _nearbyAuto ? "true" : null);');
    expect(parser).toContain('|| (_placePreferences.length > 0 || _namedPlace || _nearby || _nearbyAuto ? "PLACE_SELECTION" : null));');
    const vars = '"nearbyReference", "nearbyReferenceAuto", "__referenceBookingTried", "__referenceBookingId", "__nearbyAskedFor"';
    for (const text of [parser, read('Bruno_Collection', 'opencollection.yml')]) expect(text).toContain(vars);
    expect(read('Bruno_Collection', 'library-bruno', 'expiredFlow.js')).toContain("'__referenceBookingTried', '__referenceBookingId',");
  });

  test('02 and 09 delete A\'s booking once theirs is answered', () => {
    for (const step of ['02. POST Create Booking.yml', '09. POST Add Reservation to Booking.yml']) {
      const text = read('Bruno_Collection', '02-Common Requests', step);
      const after = text.indexOf('- type: after-response');
      expect(text.indexOf('offers.js").releaseReferenceBooking();')).toBeGreaterThan(after);
      expect(text).toContain('await require(bru.getEnvVar("library_base") + "offers.js").releaseReferenceBooking();');
    }
  });

  test('the catalogue does not ask for a place when AUTO takes it from the provider', () => {
    const { dataNeedsOf } = require(path.join(ROOT, 'Oscar_Server', 'src', 'utils', 'scenarioCatalogue.js'));
    expect(typeof dataNeedsOf).toBe('function');
    expect(read('Oscar_Server', 'src', 'utils', 'scenarioCatalogue.js')).toContain("!['', 'AUTO'].includes(scenario.referencePlace.trim().toUpperCase())");
  });
});
