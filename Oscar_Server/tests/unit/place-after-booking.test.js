'use strict';

/**
 * #766 PR 5 — the place choices made after the booking: with
 * reservationBookingForm ADD_LATER, step 09 asks the availability resources
 * for the booking (BOOKING context) and sends the same choices as a booking
 * would in its offer-parts request. Also run end to end against the
 * simulator's own functions.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const np = require(path.join(LIB, 'namedPlaces.js'));
const ps = require(path.join(LIB, 'placeSelection.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const REF = { coachNumber: '7', placeNumber: '15' };
const bookingRef = (id) => ({ contextId: 'B1', contextType: 'BOOKING', resourceId: id, resourceType: 'RESERVATION' });
const place = (number, extra = {}) => ({ number, status: 'FREE', reservationRefs: [bookingRef('R2')], ...extra });
const MAP = { coaches: [{ number: '7', decks: [{ compartments: [{ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', isSelectable: false, places: [place('11', { status: 'ALLOCATED' }), place('12'), place('13')] }] }] }] };

describe('#766 PR 5 — the requests in a BOOKING context', () => {
  test('place map, nearby and preferences name the booking; OFFER stays the default', () => {
    expect(np.placeMapRequest('B1', ['R2'], 'BOOKING')).toEqual({ placeRestrictions: [{ reservationRef: bookingRef('R2') }] });
    expect(np.placeMapRequest('O1', ['R1']).placeRestrictions[0].reservationRef.contextType).toBe('OFFER');
    expect(np.nearbyQuery('B 1', 'R2', REF, 'BOOKING')).toBe('/availabilities/nearby?contextId=B%201&contextType=BOOKING&resourceId=R2&resourceType=RESERVATION&coachNumber=7&placeNumber=15');
    expect(np.nearbyQuery('O1', 'R1', REF)).toContain('contextType=OFFER');
    expect(ps.preferencesQuery('B1', 'R2', 'BOOKING')).toBe('/availabilities/preferences?contextId=B1&contextType=BOOKING&resourceId=R2&resourceType=RESERVATION');
    expect(ps.preferencesQuery('O1', 'R1')).toContain('contextType=OFFER');
  });
});

describe('#766 PR 5 — asking after the booking', () => {
  afterEach(() => { delete global.bru; delete global.validationLogger; });

  function withBru(env, run, sendRequest = () => {}) {
    const logs = [];
    global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; }, sendRequest };
    global.validationLogger = (l) => logs.push(l);
    let result;
    jest.isolateModules(() => {
      jest.doMock(path.join(LIB, 'displays.js'), () => ({ validationLogger: (l) => logs.push(l), logStepStart: () => {} }));
      result = run(require(path.join(LIB, 'offers.js')), require(path.join(LIB, 'requestsBuilder.js')));
    });
    return { logs, result };
  }

  const later = JSON.stringify([{ reservationId: 'R2', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }]);
  const env = (extra) => ({
    reservationBookingForm: 'ADD_LATER', reservationAddLaterSelections: later, bookingId: 'B1', offerId: 'O1',
    api_base: 'https://p.example/osdm', access_token: 't', osdmVersion: '3.8.0', placeSelections: '[]', reservationPlaceSelections: '[{"reservationId":"R1"}]',
    offer: JSON.stringify({ offerId: 'O1', reservationOfferParts: [{ id: 'R1', passengerRefs: ['P1'] }, { id: 'R2', passengerRefs: ['P1', 'P2'] }] }),
    ...extra,
  });
  const answering = (sent, data) => (req, cb) => { sent.push([req.method, req.url, req.data ? JSON.parse(req.data) : undefined]); cb(null, { status: 200, data }); };

  test('a manual flow: the BOOKING place map once per booking, choices added to those of the booking', async () => {
    const e = env({ namedPlaceKind: 'PLACE', placeSelectionFlow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
      __namedPlacesAskedFor: 'O1', __namedPlaceChoices: '{"R1":{"places":[{"coachNumber":"7","placeNumber":"20","passengerRef":"P1"}]}}', __namedPlaceFees: '{}' });
    const sent = [];
    await withBru(e, (o) => o.askPlacesAfterBooking(), answering(sent, { vehicle: MAP })).result;
    expect(sent).toEqual([['POST', 'https://p.example/osdm/availabilities/vehicle-place-map', np.placeMapRequest('B1', ['R2'], 'BOOKING')]]);
    expect(JSON.parse(e.__namedPlaceChoices)).toEqual({
      R1: { places: [{ coachNumber: '7', placeNumber: '20', passengerRef: 'P1' }] },
      R2: { places: [{ coachNumber: '7', placeNumber: '12', passengerRef: 'P1' }, { coachNumber: '7', placeNumber: '13', passengerRef: 'P2' }] },
    });
    expect(e.__namedPlacesAskedFor).toBe('BOOKING:B1');
    expect(JSON.parse(e.__namedPlacesOutcome).checks.every((c) => c.ok)).toBe(true);
    await withBru(e, (o) => o.askPlacesAfterBooking(), answering(sent, { vehicle: MAP })).result;
    expect(sent).toHaveLength(1);
  });

  test('the NEARBY and PREFERENCES flows: the BOOKING context, each for the reservations added', async () => {
    const sent = [];
    const near = env({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_NEARBY', nearbyReference: JSON.stringify(REF) });
    await withBru(near, (o) => o.askPlacesAfterBooking(), answering(sent, { availablePlaces: [] })).result;
    const prefs = env({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_PREFERENCES', __placePreferencesSent: '["WINDOW"]' });
    await withBru(prefs, (o) => o.askPlacesAfterBooking(), answering(sent, { availablePlaces: [{ accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', placeProperties: ['WINDOW'], numericAvailability: 3, tripLegCoverage: { tripId: 'T1', legId: 'L1' } }] })).result;
    expect(sent.map(([method, url]) => [method, url])).toEqual([
      ['GET', `https://p.example/osdm${np.nearbyQuery('B1', 'R2', REF, 'BOOKING')}`],
      ['GET', `https://p.example/osdm${ps.preferencesQuery('B1', 'R2', 'BOOKING')}`],
    ]);
    expect(near.__nearbyAskedFor).toBe('BOOKING:B1');
    expect(JSON.parse(prefs.__placePreferencesSent)).toEqual(['WINDOW']);
  });

  test('before the booking, nothing placed but reservations added later: no misleading warning', async () => {
    const quiet = env({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_NEARBY', nearbyReference: JSON.stringify(REF), reservationPlaceSelections: '[]' });
    expect(withBru(quiet, (o) => o.placeChoiceAfterBooking()).result).toBe(true);
    const { logs, result } = withBru(quiet, (o) => o.askNearbyPlace());
    await result;
    expect(logs).toEqual([]);
    const loud = withBru({ ...quiet, __nearbyAskedFor: undefined, reservationBookingForm: 'PLACE_SELECTION' }, (o) => o.askNearbyPlace());
    await loud.result;
    expect(loud.logs).toEqual(['[WARNING] Nearby place: no reservation is placed in the booking, so no place near the reference is asked.']);
  });

  test('09\'s selections: the preference, the places named and the reference place, as at the booking', () => {
    const selections = [{ reservationId: 'R2', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }];
    const named = env({ __namedPlaceChoices: '{"R2":{"places":[{"coachNumber":"7","placeNumber":"12","passengerRef":"P1"}]}}' });
    expect(withBru(named, (o, rb) => rb.laterPlaceSelections(selections)).result[0].places).toEqual([{ coachNumber: '7', placeNumber: '12', passengerRef: 'P1' }]);
    const near = env({ placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION_NEARBY', nearbyReference: JSON.stringify(REF) });
    expect(withBru(near, (o, rb) => rb.laterPlaceSelections(selections)).result[0].referencePlace).toEqual(REF);
    const prefs = env({ __placePreferencesSent: '["WINDOW"]', __placePreferencesFor: '["R1"]' });
    const out = withBru(prefs, (o, rb) => rb.laterPlaceSelections(selections));
    expect(out.result[0].accommodations[0].placeProperties).toEqual(['WINDOW']);
    expect(JSON.parse(prefs.__placePreferencesFor)).toEqual(['R1', 'R2']);
    expect(out.logs).toEqual(['[INFO] Seat preferences WINDOW asked for reservation(s) R2.']);
    expect(withBru(env({}), (o, rb) => rb.laterPlaceSelections(selections)).result).toEqual(selections);
  });

  test('wiring: 09 asks and builds within the ADD_LATER form, records the checks; 07 grades the reservations added', () => {
    const step09 = read('Bruno_Collection', '02-Common Requests', '09. POST Add Reservation to Booking.yml');
    const form = step09.indexOf('if (_addLaterForm) {');
    expect(step09.indexOf('offers.js").askPlacesAfterBooking();')).toBeGreaterThan(form);
    expect(step09.indexOf('requestsBuilder.js").laterPlaceSelections(_later);')).toBeGreaterThan(step09.indexOf('askPlacesAfterBooking();'));
    expect(step09.indexOf('offers.js").recordPlacePreferenceChecks();')).toBeLessThan(step09.indexOf('__expiredAddReservationOfferArmed")) === "true"'));
    expect(read('Bruno_Collection', '02-Common Requests', '07. GET Booking after Fulfillments.yml'))
      .toContain('[...fromEnv(bru.getEnvVar("__reservationsBooked"), []), ...fromEnv(bru.getEnvVar("__reservationsAddedLater"), [])]');
  });
});

describe('#766 PR 5 — with the simulator\'s answers', () => {
  const SIM = path.join(ROOT, 'OSDM_Simulator');
  const { loadProviders } = require(path.join(SIM, 'src', 'config'));
  const { buildOfferCollection } = require(path.join(SIM, 'src', 'osdm', 'offers'));
  const { createBooking, addOfferParts } = require(path.join(SIM, 'src', 'osdm', 'bookings'));
  const { vehiclePlaceMap } = require(path.join(SIM, 'src', 'osdm', 'placeMap'));
  const gamma = loadProviders(path.join(SIM, 'providers')).get('gamma');
  const NOW = Date.parse('2026-10-11T08:00:00Z');

  test('an optional EuroCity reservation added later with the seats named on the BOOKING map', () => {
    const leg = { timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: gamma.placeMap.from }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
      service: { vehicleNumbers: ['171'], productCategory: { name: 'EC', shortName: 'EC' } },
    } };
    const refs = ['P1', 'P2'];
    const { response, remembered } = buildOfferCollection({ anonymousPassengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON' })), tripSpecifications: [{ legs: [leg] }] }, gamma, NOW);
    const offer = response.offers[0];
    const found = remembered.find((e) => e.offer.offerId === offer.offerId);
    const part = offer.reservationOfferParts[0];
    const trip = response.trips[0];
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: refs }],
      passengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } })),
    }, () => found, gamma, NOW);
    expect(booking.bookedOffers[0].reservations).toEqual([]);
    const price = (amount) => ({ amount, currency: gamma.currency, scale: 2 });
    const answer = np.checkPlaceMapAnswer(200, vehiclePlaceMap(np.placeMapRequest(booking.id, [part.id], 'BOOKING'), (id, type) => (type === 'BOOKING' && id === booking.id ? found : null), gamma, price));
    expect(answer.checks.every((c) => c.ok)).toBe(true);
    const chosen = np.chooseNamedPlaces(answer.map, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'PLACE', reservations: [{ id: part.id, passengerRefs: part.passengerRefs }] });
    const added = addOfferParts(booking, offer.offerId, {
      offerId: offer.offerId, passengerRefs: refs,
      placeSelections: np.withNamedPlaces([{ reservationId: part.id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } }], chosen.choices),
    }, () => found, gamma);
    const checks = np.checkNamedPlacesBooked({ bookedOffers: added.bookedOffers }, offer, chosen.choices, chosen.fees);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.ok)).toBe(true);
  });
});
