'use strict';

/**
 * #766 PR 3 — a named place or compartment, chosen on the place map: what is
 * asked, what is chosen, and how the booking is graded. Also run end to end
 * against the simulator's own functions.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'Bruno_Collection', 'library-bruno');
const np = require(path.join(LIB, 'namedPlaces.js'));
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const ref = (id) => ({ contextId: 'O1', contextType: 'OFFER', resourceId: id, resourceType: 'RESERVATION' });
const place = (number, extra = {}) => ({ number, status: 'FREE', reservationRefs: [ref('R1')], ...extra });
const fee = (amount) => ({ selectionFee: { price: { amount, currency: 'EUR', scale: 2 } } });
const vehicle = (compartments) => ({ coaches: [{ number: '7', travelDirection: 'IN_DIRECTION', decks: [{ layoutId: 'L', compartments }] }] });
const saloon = (...places) => ({ serviceClass: 'STANDARD', accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT', isSelectable: false, places });
const MAP = vehicle([
  saloon(place('11', { status: 'ALLOCATED' }), place('12'), place('13'), place('21', fee(240)), place('22', fee(240))),
  { serviceClass: 'STANDARD', accommodationType: 'SEAT', accommodationSubType: 'COMPARTMENT', isSelectable: true, number: 'C1', status: 'FREE', reservationRefs: [ref('R1')], places: [place('61'), place('62'), place('63')] },
]);

describe('#766 PR 3 — the scenario and the request', () => {
  test('manual flows and the kind of named place', () => {
    expect(np.isManual('manual_place_selection_with_fee')).toBe(true);
    expect(np.isManual('AUTOMATIC_PLACE_SELECTION')).toBe(false);
    expect(np.kindOfScenario({ namedPlaceKind: 'compartment' })).toBe('COMPARTMENT');
    expect(np.kindOfScenario({ namedPlaceKind: 'SOFA' })).toBe('PLACE');
    expect(np.kindOfScenario(null)).toBe('PLACE');
  });

  test('the map is asked for the offer\'s reservations', () => {
    expect(np.placeMapRequest('O1', ['R1', 'R2'])).toEqual({ placeRestrictions: [{ reservationRef: ref('R1') }, { reservationRef: ref('R2') }] });
  });
});

describe('#766 PR 3 — the map answer', () => {
  test('read flat: places with status, fee and compartment; compartments booked as a whole', () => {
    const map = np.readMap(MAP);
    expect(map.places.map((p) => [p.number, p.status, p.fee, p.selectable])).toEqual([
      ['11', 'ALLOCATED', null, false], ['12', 'FREE', null, false], ['13', 'FREE', null, false], ['21', 'FREE', 240, false], ['22', 'FREE', 240, false],
      ['61', 'FREE', null, true], ['62', 'FREE', null, true], ['63', 'FREE', null, true],
    ]);
    expect(map.compartments).toEqual([{ coach: '7', number: 'C1', status: 'FREE', places: ['61', '62', '63'], reservationIds: ['R1'], fee: null }]);
    expect(np.readMap(null)).toEqual({ places: [], compartments: [] });
  });

  test('2xx with places: checks pass and the map is kept; a place without status or reservations fails', () => {
    const ok = np.checkPlaceMapAnswer(200, { vehicle: MAP });
    expect(ok.checks.every((c) => c.ok)).toBe(true);
    expect(ok.map.places).toHaveLength(8);
    expect(ok.lines[0].text).toBe('POST /availabilities/vehicle-place-map: 8 place(s), 7 free, 2 with a selection fee, 1 compartment(s) booked as a whole.');
    const broken = np.checkPlaceMapAnswer(200, { vehicle: vehicle([saloon({ number: '12', status: 'MAYBE', reservationRefs: [] })]) });
    expect(broken.checks[1]).toMatchObject({ ok: false, message: '1 place(s) without a known status or reservationRefs, e.g. 7/12' });
  });

  test('501/404/405: not provided, a warning; another error fails; no place: a warning', () => {
    for (const status of [404, 405, 501]) expect(np.checkPlaceMapAnswer(status, null)).toMatchObject({ checks: [], map: null, lines: [{ level: 'WARNING' }] });
    expect(np.checkPlaceMapAnswer(500, null).checks).toEqual([{ name: 'POST /availabilities/vehicle-place-map is answered with 2xx', ok: false, message: 'HTTP 500' }]);
    expect(np.checkPlaceMapAnswer(200, { vehicle: { coaches: [] } })).toMatchObject({ map: null, lines: [{ level: 'WARNING' }] });
  });
});

describe('#766 PR 3 — what is chosen', () => {
  const map = np.readMap(MAP);
  const two = [{ id: 'R1', passengerRefs: ['P1', 'P2'] }];

  test('without fee: free seats without a fee, never taken ones, never compartment seats', () => {
    const out = np.chooseNamedPlaces(map, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'PLACE', reservations: two });
    expect(out.choices.R1.places).toEqual([{ coachNumber: '7', placeNumber: '12', passengerRef: 'P1' }, { coachNumber: '7', placeNumber: '13', passengerRef: 'P2' }]);
    expect(out.fees).toEqual({ R1: 0 });
    expect(out.lines).toEqual([]);
  });

  test('with fee: fee seats first, and their fees added', () => {
    const out = np.chooseNamedPlaces(map, { flow: 'MANUAL_PLACE_SELECTION_WITH_FEE', kind: 'PLACE', reservations: [{ id: 'R1', passengerRefs: ['P1', 'P2', 'P3'] }] });
    expect(out.choices.R1.places.map((p) => p.placeNumber)).toEqual(['21', '22', '12']);
    expect(out.fees).toEqual({ R1: 480 });
  });

  test('with fee but no fee seat: a warning, free seats are named', () => {
    const plain = np.readMap(vehicle([saloon(place('12'), place('13'))]));
    const out = np.chooseNamedPlaces(plain, { flow: 'MANUAL_PLACE_SELECTION_WITH_FEE', kind: 'PLACE', reservations: two });
    expect(out.lines.map((l) => l.text)).toEqual(['Reservation R1: the place map gives no seat with a selection fee; the fee is not tested.']);
    expect(out.choices.R1.places).toHaveLength(2);
  });

  test('too few seats: a warning, nothing named for that reservation', () => {
    const out = np.chooseNamedPlaces(map, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'PLACE', reservations: [{ id: 'R1', passengerRefs: ['P1', 'P2', 'P3'] }] });
    expect(out.choices).toEqual({});
    expect(out.lines[0]).toEqual({ level: 'WARNING', text: 'Reservation R1: the place map has 2 free seat(s) without fee for 3 passenger(s); no place is named.' });
  });

  test('a seat is never given to two reservations; a seat for another reservation is not taken', () => {
    const shared = np.readMap(vehicle([saloon(place('12'), place('13'), place('14', { reservationRefs: [ref('R9')] }))]));
    const out = np.chooseNamedPlaces(shared, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'PLACE', reservations: [{ id: 'R1', passengerRefs: ['P1'] }, { id: 'R2', passengerRefs: ['P2'] }, { id: 'R1b', passengerRefs: ['P3'] }] });
    expect(Object.values(out.choices).map((c) => c.places[0].placeNumber)).toEqual(['12']);
    expect(out.lines).toHaveLength(2);
  });

  test('compartment: a free one large enough, booked as a whole', () => {
    const out = np.chooseNamedPlaces(map, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'COMPARTMENT', reservations: two });
    expect(out.choices).toEqual({ R1: { compartments: [{ coachNumber: '7', compartmentNumber: 'C1', passengerRefs: ['P1', 'P2'] }] } });
    const big = np.chooseNamedPlaces(map, { flow: 'MANUAL_PLACE_SELECTION_WITHOUT_FEE', kind: 'COMPARTMENT', reservations: [{ id: 'R1', passengerRefs: ['1', '2', '3', '4'] }] });
    expect(big.choices).toEqual({});
    expect(big.lines[0].level).toBe('WARNING');
  });

  test('the choices go into the placeSelections of their reservation only', () => {
    const sel = [{ reservationId: 'R1', tripLegCoverage: { tripId: 'T', legId: 'L' } }, { reservationId: 'R2' }];
    const choices = { R1: { places: [{ coachNumber: '7', placeNumber: '12', passengerRef: 'P1' }] } };
    expect(np.withNamedPlaces(sel, choices)).toEqual([{ ...sel[0], ...choices.R1 }, sel[1]]);
    expect(np.withNamedPlaces(sel, null)).toEqual(sel);
    expect(np.describeChoice(choices.R1)).toBe('7/12');
    expect(np.describeChoice({ compartments: [{ coachNumber: '7', compartmentNumber: 'C1' }] })).toBe('compartment 7/C1');
  });
});

describe('#766 PR 3 — the booking', () => {
  const offer = { reservationOfferParts: [{ id: 'R1', price: { amount: 7200 } }] };
  const booking = (places, amount, extra = {}) => ({ bookedOffers: [{ reservations: [{ id: 'R1', price: { amount }, placeAllocation: { reservedPlaces: [{ coachNumber: '7', placeNumbers: places, ...extra }] } }] }] });
  const seats = { R1: { places: [{ coachNumber: '7', placeNumber: '21', passengerRef: 'P1' }] } };

  test('the places named, at the offer price plus the fee: both checks pass', () => {
    expect(np.checkNamedPlacesBooked(booking(['21'], 7440), offer, seats, { R1: 240 })).toEqual([
      { name: 'Booking: reservation R1 gives the places named (7/21)', ok: true, message: 'given: 7/21' },
      { name: "Booking: reservation R1 costs the offer's price plus the selection fee (7200 + 240)", ok: true, message: 'booked at 7440' },
    ]);
  });

  test('another place fails; a fee not charged, or charged without fee seats, fails', () => {
    const [placeCheck, priceCheck] = np.checkNamedPlacesBooked(booking(['22'], 7200), offer, seats, { R1: 240 });
    expect([placeCheck.ok, placeCheck.message, priceCheck.ok]).toEqual([false, 'given: 7/22', false]);
    expect(np.checkNamedPlacesBooked(booking(['21'], 7440), offer, seats, { R1: 0 })[1]).toMatchObject({ ok: false, message: 'booked at 7440 (more than asked)' });
  });

  test('a compartment is found by its number; a booking that renamed the only reservation is still checked', () => {
    const comp = { R1: { compartments: [{ coachNumber: '7', compartmentNumber: 'C1', passengerRefs: ['P1'] }] } };
    expect(np.checkNamedPlacesBooked(booking(['61', '62'], 7200, { compartmentNumber: 'C1' }), offer, comp, {})[0].ok).toBe(true);
    expect(np.checkNamedPlacesBooked(booking(['61'], 7200), offer, comp, {})[0].ok).toBe(false);
    const renamed = booking(['21'], 7440);
    renamed.bookedOffers[0].reservations[0].id = 'B-9';
    expect(np.checkNamedPlacesBooked(renamed, offer, seats, { R1: 240 })[0]).toMatchObject({ name: 'Booking: reservation B-9 gives the places named (7/21)', ok: true });
  });

  test('a named reservation the booking lacks fails; nothing named, nothing checked', () => {
    expect(np.checkNamedPlacesBooked({ bookedOffers: [] }, offer, seats, {})).toEqual([{ name: 'Booking: holds the reservation R1 with the places named (7/21)', ok: false, message: 'no booked reservation R1' }]);
    expect(np.checkNamedPlacesBooked(booking(['21'], 1), offer, {}, {})).toEqual([]);
  });
});

describe('#766 PR 3 — with the simulator\'s answers', () => {
  const SIM = path.join(ROOT, 'OSDM_Simulator');
  const { loadProviders } = require(path.join(SIM, 'src', 'config'));
  const { buildOfferCollection } = require(path.join(SIM, 'src', 'osdm', 'offers'));
  const { createBooking } = require(path.join(SIM, 'src', 'osdm', 'bookings'));
  const { vehiclePlaceMap } = require(path.join(SIM, 'src', 'osdm', 'placeMap'));
  const gamma = loadProviders(path.join(SIM, 'providers')).get('gamma');
  const NOW = Date.parse('2026-10-11T08:00:00Z');

  function sale(flow, kind, passengers) {
    const leg = { timedLeg: {
      start: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: gamma.placeMap.from }, serviceDeparture: { timetabledTime: '2026-11-20T08:00:00+02:00' } },
      end: { stopPlaceRef: { objectType: 'StopPlaceRef', stopPlaceRef: 'urn:uic:stn:0000002' }, serviceArrival: { timetabledTime: '2026-11-20T10:00:00+02:00' } },
      service: { vehicleNumbers: ['521'], productCategory: { name: 'SC', shortName: 'SC' } },
    } };
    const refs = Array.from({ length: passengers }, (_, i) => `P${i + 1}`);
    const { response, remembered } = buildOfferCollection({ anonymousPassengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON' })), tripSpecifications: [{ legs: [leg] }] }, gamma, NOW);
    const offer = response.offers[0];
    const found = remembered.find((e) => e.offer.offerId === offer.offerId);
    const part = offer.reservationOfferParts[0];
    const answer = np.checkPlaceMapAnswer(200, vehiclePlaceMap(np.placeMapRequest(offer.offerId, [part.id]), () => found, gamma, (amount) => ({ amount, currency: gamma.currency, scale: 2 })));
    const chosen = np.chooseNamedPlaces(answer.map, { flow, kind, reservations: [{ id: part.id, passengerRefs: part.passengerRefs }] });
    const trip = response.trips[0];
    const booking = createBooking({
      offers: [{ offerId: offer.offerId, passengerRefs: refs, placeSelections: np.withNamedPlaces([{ reservationId: part.id, tripLegCoverage: { tripId: trip.id, legId: trip.legs[0].id } }], chosen.choices) }],
      passengerSpecifications: refs.map((externalRef) => ({ externalRef, type: 'PERSON', detail: { firstName: 'A', lastName: 'B' } })),
    }, () => found, gamma, NOW);
    return { answer, chosen, checks: np.checkNamedPlacesBooked(booking, offer, chosen.choices, chosen.fees) };
  }

  test('without fee, with fee and a compartment: the map is answered, places chosen and given, prices right', () => {
    for (const [flow, kind, n, names] of [
      ['MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'PLACE', 2, ['13', '14']],
      ['MANUAL_PLACE_SELECTION_WITH_FEE', 'PLACE', 1, ['21']],
      ['MANUAL_PLACE_SELECTION_WITHOUT_FEE', 'COMPARTMENT', 2, null],
    ]) {
      const { answer, chosen, checks } = sale(flow, kind, n);
      expect(answer.checks.every((c) => c.ok)).toBe(true);
      const choice = Object.values(chosen.choices)[0];
      if (names) expect(choice.places.map((p) => p.placeNumber)).toEqual(names);
      else expect(choice.compartments[0].compartmentNumber).toBe('C1');
      expect(checks.map((c) => [c.name.replace(/reservation \S+/, 'reservation R'), c.ok]).every(([, ok]) => ok)).toBe(true);
    }
  });
});

describe('#766 PR 3 — the collection wiring', () => {
  afterEach(() => { delete global.bru; delete global.validationLogger; });
  test('parser, reset lists, 02, the builder, 07 and the price comparison', () => {
    const parser = read('Bruno_Collection', 'library-bruno', 'scenarioParser.js');
    expect(parser).toContain('bru.setEnvVar("namedPlaceKind", _namedPlace ? _np.kindOfScenario(scenario) : null);');
    expect(parser).toContain('|| (_placePreferences.length > 0 || _namedPlace || _nearby || _nearbyAuto ? "PLACE_SELECTION" : null));');
    const vars = '"namedPlaceKind", "__namedPlacesAskedFor", "__namedPlaceChoices", "__namedPlaceFees", "__namedPlacesOutcome"';
    for (const text of [parser, read('Bruno_Collection', 'opencollection.yml')]) expect(text).toContain(vars);
    const step02 = read('Bruno_Collection', '02-Common Requests', '02. POST Create Booking.yml');
    expect(step02.indexOf('offers.js").askNamedPlaces();')).toBeGreaterThan(step02.indexOf('offers.js").askPlacePreferences();'));
    expect(step02.indexOf('offers.js").askNamedPlaces();')).toBeLessThan(step02.indexOf('        buildBookingRequest();'));
    expect(read('Bruno_Collection', 'library-bruno', 'requestsBuilder.js')).toContain('_np.withNamedPlaces(withSeatPreferences([');
    expect(read('Bruno_Collection', '02-Common Requests', '07. GET Booking after Fulfillments.yml')).toContain('namedPlaces.js").checkNamedPlacesBooked(');
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

  test('askNamedPlaces posts the map request once per offer and keeps the choices and fees', async () => {
    const env = {
      namedPlaceKind: 'PLACE', placeSelectionFlow: 'MANUAL_PLACE_SELECTION_WITH_FEE', offerId: 'O1', api_base: 'https://p.example/osdm', access_token: 't', osdmVersion: '3.8.0',
      reservationPlaceSelections: '[{"reservationId":"R1"}]',
      offer: JSON.stringify({ offerId: 'O1', reservationOfferParts: [{ id: 'R1', passengerRefs: ['P1'] }] }),
    };
    const sent = [];
    const send = (req, cb) => { sent.push([req.method, req.url, JSON.parse(req.data)]); cb(null, { status: 200, data: { vehicle: MAP } }); };
    await withBru(env, (o) => o.askNamedPlaces(), send).result;
    expect(sent).toEqual([['POST', 'https://p.example/osdm/availabilities/vehicle-place-map', np.placeMapRequest('O1', ['R1'])]]);
    expect(JSON.parse(env.__namedPlaceChoices)).toEqual({ R1: { places: [{ coachNumber: '7', placeNumber: '21', passengerRef: 'P1' }] } });
    expect(JSON.parse(env.__namedPlaceFees)).toEqual({ R1: 240 });
    await withBru(env, (o) => o.askNamedPlaces(), send).result;
    expect(sent).toHaveLength(1);
  });

  test('not a manual flow, or no kind: nothing is asked', async () => {
    const calls = [];
    for (const env of [{ namedPlaceKind: 'PLACE', placeSelectionFlow: 'AUTOMATIC_PLACE_SELECTION', offerId: 'O1' }, { placeSelectionFlow: 'MANUAL_PLACE_SELECTION_WITH_FEE', offerId: 'O1' }]) {
      await withBru(env, (o) => o.askNamedPlaces(), () => calls.push(1)).result;
    }
    expect(calls).toEqual([]);
  });
});
