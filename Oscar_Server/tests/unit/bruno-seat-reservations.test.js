// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-seat-reservations.test.js — #601: mandatory and optional seat
 * reservations.
 *
 * Before, a reservation was booked only when a scenario switch said so, and
 * then every reservation part of the offer; minGroupItemsToBeBooked was read
 * on the admission, where OSDM never puts it, so nothing knew a reservation
 * was mandatory. Now the admission's relations say it: mandatory ones are
 * always booked, optional ones in the form the scenario names.
 */

const fs = require('node:fs');
const path = require('node:path');
const { withBrunoExpect } = require('../helpers/bruno-chai.js');

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
};

let mockResults = [];
let mockLogs = [];
jest.mock('../../../Bruno_Collection/library-bruno/displays.js', () => ({
  validationLogger: (line) => { mockLogs.push(line); },
  logStepStart: () => {},
}));
jest.mock('../../../Bruno_Collection/library-bruno/testCapture.js', () => ({
  bruTest: (name, fn) => {
    try { fn(); mockResults.push({ name, ok: true }); } catch (e) { mockResults.push({ name, ok: false, message: e.message }); }
  },
  expectTypeOrNull: () => {},
  expectScale: () => {},
}));
global.validationLogger = (line) => { mockLogs.push(line); };

const sr = require('../../../Bruno_Collection/library-bruno/seatReservations.js');
const offers = require('../../../Bruno_Collection/library-bruno/offers.js');

beforeEach(() => { envStore = {}; mockResults = []; mockLogs = []; });

const reservation = (id, leg, refs = ['P1', 'P2']) => ({ id, passengerRefs: refs, tripCoverage: { coveredTripId: 'T1', coveredLegIds: [leg] } });
const relation = (min, ...refs) => ({ minGroupItemsToBeBooked: min, maxGroupItemsToBeBooked: 1, reservationGroup: { id: 'g', name: 'g', reservationRefs: refs.map((id) => ({ id })) } });
// A SuperCity leg (L1, mandatory) and a EuroCity leg (L2, optional).
const offer = {
  offerId: 'O1',
  admissionOfferParts: [
    { id: 'A1', reservations: [relation(1, 'R1'), relation(0, 'R2')] },
    { id: 'A2', reservations: [relation(1, 'R1'), relation(0, 'R2')] },
  ],
  reservationOfferParts: [reservation('R1', 'L1'), reservation('R2', 'L2')],
};

describe('what is booked', () => {
  test('the form is one of three, upper case; anything else is none', () => {
    expect(sr.normaliseForm(' place_selection ')).toBe('PLACE_SELECTION');
    expect(sr.normaliseForm('ADD_LATER')).toBe('ADD_LATER');
    expect(sr.normaliseForm('SOMETIMES')).toBeNull();
    expect(sr.normaliseForm(null)).toBeNull();
  });

  test('mandatory ones always, once each; optional ones when asked', () => {
    expect(sr.reservationsToBook(offer, { bookOptional: false })).toEqual({ mandatory: ['R1'], optional: [] });
    expect(sr.reservationsToBook(offer, { bookOptional: true })).toEqual({ mandatory: ['R1'], optional: ['R2'] });
  });

  test('a mandatory group gives its first minGroupItemsToBeBooked reservations; a ref to no part is left out', () => {
    const two = { admissionOfferParts: [{ id: 'A', reservations: [relation(2, 'R1', 'R2', 'R3'), relation(1, 'GONE')] }], reservationOfferParts: [reservation('R1', 'L1'), reservation('R2', 'L1'), reservation('R3', 'L1')] };
    expect(sr.reservationsToBook(two, { bookOptional: false }).mandatory).toEqual(['R1', 'R2']);
  });

  test('parts that no relation names are optional ones (some providers leave the relation out)', () => {
    const unlinked = { admissionOfferParts: [{ id: 'A' }], reservationOfferParts: [reservation('R1', 'L1')] };
    expect(sr.reservationsToBook(unlinked, { bookOptional: false })).toEqual({ mandatory: [], optional: [] });
    expect(sr.reservationsToBook(unlinked, { bookOptional: true })).toEqual({ mandatory: [], optional: ['R1'] });
  });

  test('a place selection names the trip and leg of its reservation', () => {
    expect(sr.placeSelectionsFor(offer, ['R2'])).toEqual([{ reservationId: 'R2', tripLegCoverage: { tripId: 'T1', legId: 'L2' } }]);
  });
});

describe('the checks', () => {
  test('relations naming parts of the offer and fitting their group pass; a dangling ref or a min above the group fails', () => {
    expect(sr.checkRelations(offer).every((c) => c.ok)).toBe(true);
    expect(sr.checkRelations(offer)[0].name).toBe('Admission A1 reservation relation 1: names reservation parts of the offer — 1 named, mandatory');
    const broken = { admissionOfferParts: [{ id: 'A', reservations: [relation(2, 'R9')] }], reservationOfferParts: [reservation('R1', 'L1')] };
    expect(sr.checkRelations(broken).map((c) => [c.ok, c.message])).toEqual([
      [false, 'not in reservationOfferParts: [R9]'],
      [false, 'minGroupItemsToBeBooked / maxGroupItemsToBeBooked do not fit the group'],
    ]);
    expect(sr.checkRelations({ admissionOfferParts: [{ id: 'A', reservations: [relation(0)] }] })[0].message).toBe('its reservationGroup names no reservation');
  });

  test('the provider rules are warnings: a reservation for some passengers only, or on two legs', () => {
    const odd = { reservationOfferParts: [reservation('R1', 'L1', ['P1']), { id: 'R2', passengerRefs: ['P1', 'P2'], tripCoverage: { coveredLegIds: ['L1', 'L2'] } }] };
    const checks = sr.checkProviderRules(odd, ['P1', 'P2']);
    expect(checks.every((c) => c.level === 'warn')).toBe(true);
    expect(checks.filter((c) => !c.ok).map((c) => c.message)).toEqual(['it holds [P1] of [P1, P2]', 'it covers 2 legs']);
    expect(sr.checkProviderRules(offer, ['P1', 'P2']).every((c) => c.ok)).toBe(true);
  });

  test('the booking holds each reservation on its leg, whatever its id, and says where the seats are', () => {
    const booking = { bookedOffers: [{ reservations: [{ id: 'B-R1', tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] }, placeAllocation: { reservedPlaces: [{ coachNumber: '7', placeNumbers: ['21', '22'] }] } }] }] };
    expect(sr.checkBookedReservations(booking, offer, ['R1'])).toEqual([
      { name: 'Booking: holds the reservation on leg L1', ok: true, message: undefined },
      { name: 'Booking: reservation B-R1 gives a place — coach 7, places 21, 22', ok: true, level: 'warn', message: 'no placeAllocation.reservedPlaces' },
    ]);
    expect(sr.checkBookedReservations(booking, offer, ['R1', 'R2'])[2]).toEqual({ name: 'Booking: holds the reservation on leg L2', ok: false, message: 'the booking holds 1 reservation(s), none for the reservation R2 on leg L2' });
    const noPlace = { bookedOffers: [{ reservations: [{ id: 'X', tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } }] }] };
    expect(sr.checkBookedReservations(noPlace, offer, ['R1'])[1]).toMatchObject({ ok: false, level: 'warn' });
  });

  // #644: a provider's reservation part without a trip coverage, asked for and
  // left out of the booking. The old check read "on leg ", and would not have
  // matched a booked reservation that does carry a coverage.
  test('a reservation part without trip coverage: named by its summary, matched by any booked reservation', () => {
    const bare = { reservationOfferParts: [{ id: 'RX', summary: 'Rezervace 2.třída', tripCoverage: null }] };
    const none = { bookedOffers: [{ reservations: [] }] };
    expect(sr.checkBookedReservations(none, bare, ['RX'], { places: false })).toEqual([
      { name: 'Booking: holds the reservation Rezervace 2.třída (the offer gives it no leg)', ok: false, message: 'the booking holds 0 reservation(s), none for the reservation RX Rezervace 2.třída (the offer gives it no leg)' },
    ]);
    const one = { bookedOffers: [{ reservations: [{ id: 'B-RX', tripCoverage: { coveredTripId: 'T1', coveredLegIds: ['L1'] } }] }] };
    expect(sr.checkBookedReservations(one, bare, ['RX'], { places: false })).toEqual([
      { name: 'Booking: holds the reservation Rezervace 2.třída (the offer gives it no leg)', ok: true, message: undefined },
    ]);
    // One booked reservation answers one asked for, not two.
    const two = { reservationOfferParts: [...bare.reservationOfferParts, { id: 'RY', tripCoverage: null }] };
    expect(sr.checkBookedReservations(one, two, ['RX', 'RY'], { places: false }).map((c) => c.ok)).toEqual([true, false]);
  });
});

describe('the offer step', () => {
  const choose = () => withBrunoExpect(() => offers.handleOptionalReservationSelections(offer));

  // #742: a provider refused the mandatory one named in
  // optionalReservationSelections ("not covered by any placeSelection").
  test('no form: the mandatory one goes in placeSelections with its leg, nothing later', () => {
    envStore.offerPassengerSpecifications = JSON.stringify([{ externalRef: 'P1' }, { externalRef: 'P2' }]);
    choose();
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([]);
    expect(JSON.parse(envStore.reservationPlaceSelections)).toEqual([{ reservationId: 'R1', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }]);
    expect(JSON.parse(envStore.reservationAddLaterSelections)).toEqual([]);
    expect(JSON.parse(envStore.__reservationsBooked)).toEqual(['R1']);
    expect(mockResults.every((r) => r.ok)).toBe(true);
    expect(mockResults.length).toBe(8);
  });

  test('RESERVATION_SELECTION names the optional one; PLACE_SELECTION sends both as place selections; ADD_LATER keeps the optional one for 09', () => {
    envStore.reservationBookingForm = 'RESERVATION_SELECTION';
    choose();
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([{ reservationId: 'R2' }]);
    expect(JSON.parse(envStore.reservationPlaceSelections).map((s) => s.reservationId)).toEqual(['R1']);
    envStore.reservationBookingForm = 'PLACE_SELECTION';
    choose();
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([]);
    expect(JSON.parse(envStore.reservationPlaceSelections).map((s) => [s.reservationId, s.tripLegCoverage.legId])).toEqual([['R1', 'L1'], ['R2', 'L2']]);
    envStore.reservationBookingForm = 'ADD_LATER';
    choose();
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([]);
    expect(JSON.parse(envStore.reservationPlaceSelections).map((s) => s.reservationId)).toEqual(['R1']);
    expect(JSON.parse(envStore.reservationAddLaterSelections)).toEqual([{ reservationId: 'R2', tripLegCoverage: { tripId: 'T1', legId: 'L2' } }]);
    expect(JSON.parse(envStore.__reservationsBooked)).toEqual(['R1']);
  });

  test('the older switch books the optional ones too; an offer without reservations books none and warns only when asked', () => {
    envStore.bookMandatoryReservations = 'true';
    choose();
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([{ reservationId: 'R2' }]);
    expect(JSON.parse(envStore.reservationPlaceSelections).map((s) => s.reservationId)).toEqual(['R1']);
    withBrunoExpect(() => offers.handleOptionalReservationSelections({ admissionOfferParts: [] }));
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([]);
    expect(mockLogs.some((l) => l.startsWith('[WARNING] The scenario books reservations (bookMandatoryReservations)'))).toBe(true);
  });
});

describe('the steps, the builder and the parser', () => {
  const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
  const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

  test('02 goes to 09 for ADD_LATER without the seat map; 09 sends the reservations kept and checks them; 07 checks the booking', () => {
    const create = read('02-Common Requests', '02. POST Create Booking.yml');
    expect(create).toMatch(/_addLater = bru\.getEnvVar\("reservationBookingForm"\) === "ADD_LATER"/);
    expect(create).toMatch(/_postBookMap = _addRes && !_addLater/);
    expect(create).toMatch(/else if \(_addRes \|\| _addLater\)/);
    const add = read('02-Common Requests', '09. POST Add Reservation to Booking.yml');
    expect(add).toMatch(/placeSelections\.push\(\.\.\._later\)/);
    expect(add).toMatch(/body\.reservationOfferId = _addLaterForm \? _later\[0\]\.reservationId : reservationOfferId/);
    expect(add).toMatch(/__reservationsAddedLater/);
    expect(read('02-Common Requests', '07. GET Booking after Fulfillments.yml')).toMatch(/checkBookedReservations\(/);
  });

  test('#644: step 02 checks the reservations asked for, without the place check', () => {
    expect(read('02-Common Requests', '02. POST Create Booking.yml')).toMatch(/__reservationsBooked"\), \[\]\);\n\s+if \(_asked\.length > 0\) \{\n\s+checkBookedReservations\([^\n]*_asked, \{ places: false, offerTrips: fromEnv\(bru\.getEnvVar\("__offerTripLegs"\), \[\]\) \}\)/);
  });

  test('the booking request carries the reservation place selections; the misplaced admission checks are gone', () => {
    expect(read('library-bruno', 'requestsBuilder.js')).toMatch(/\.\.\.parseEnvJson\("reservationPlaceSelections", \[\]\)/);
    expect(read('library-bruno', 'offers.js')).not.toMatch(/"minGroupItemsToBeBooked" in admission/);
  });

  test('the parser reads the form, and both reset lists name the variables', () => {
    const parser = read('library-bruno', 'scenarioParser.js');
    expect(parser).toMatch(/reservationBookingForm", require\('\.\/seatReservations\.js'\)\.normaliseForm\(scenario\.reservationBookingForm\)/);
    for (const text of [parser, read('opencollection.yml')]) {
      expect(text).toMatch(/"reservationBookingForm", "reservationPlaceSelections", "reservationAddLaterSelections", "__reservationsBooked", "__reservationsAddedLater"/);
    }
  });
});

// #652: after a failed seat map, step 09 added a reservation the booking
// request had already asked for; the provider answered 200 with nothing added.
describe('reservationInBookingRequest', () => {
  const { reservationInBookingRequest } = require('../../../Bruno_Collection/library-bruno/seatReservations.js');
  test('found in placeSelections or optionalReservationSelections, of any offer', () => {
    const request = { offers: [
      { offerId: 'O1', placeSelections: [{ reservationId: 'R1' }] },
      { offerId: 'O2', optionalReservationSelections: [{ reservationId: 'R2' }] },
    ] };
    expect(reservationInBookingRequest(request, 'R1')).toBe(true);
    expect(reservationInBookingRequest(request, 'R2')).toBe(true);
    expect(reservationInBookingRequest(request, 'R3')).toBe(false);
  });
  test('nothing to compare: false', () => {
    expect(reservationInBookingRequest(null, 'R1')).toBe(false);
    expect(reservationInBookingRequest({ offers: [{ offerId: 'O1' }] }, 'R1')).toBe(false);
    expect(reservationInBookingRequest({ offers: [{ placeSelections: [{ reservationId: 'R1' }] }] }, undefined)).toBe(false);
  });
});

// #669: one PlaceSelection per reservation part.
describe('splitByReservation', () => {
  const sel = {
    reservationId: 'R1', tripLegCoverage: { tripId: 'T1', legId: 'L1' },
    accommodations: [{ passengerRefs: ['P1', 'P2'], accommodationType: 'SEAT' }],
    places: [{ coachNumber: 'A', placeNumber: '1', passengerRef: 'P1' }, { coachNumber: 'A', placeNumber: '2', passengerRef: 'P2' }],
  };
  const per = { reservationOfferParts: [reservation('R1', 'L1', ['P1']), reservation('R2', 'L1', ['P2']), reservation('R9', 'L2', ['P1'])] };

  test('a part per passenger on the leg: one selection each, the other leg left out', () => {
    expect(sr.splitByReservation(sel, per)).toEqual([
      { reservationId: 'R1', tripLegCoverage: sel.tripLegCoverage, accommodations: [{ passengerRefs: ['P1'], accommodationType: 'SEAT' }], places: [sel.places[0]] },
      { reservationId: 'R2', tripLegCoverage: sel.tripLegCoverage, accommodations: [{ passengerRefs: ['P2'], accommodationType: 'SEAT' }], places: [sel.places[1]] },
    ]);
  });

  test('kept as it is: one part for all, a passenger no part holds, no offer', () => {
    expect(sr.splitByReservation(sel, { reservationOfferParts: [reservation('R1', 'L1', ['P1', 'P2'])] })).toEqual([sel]);
    expect(sr.splitByReservation(sel, { reservationOfferParts: [reservation('R1', 'L1', ['P1']), reservation('R2', 'L1', ['P3'])] })).toEqual([sel]);
    expect(sr.splitByReservation(sel, null)).toEqual([sel]);
  });

  test('the booking request does not name a reservation twice', () => {
    expect(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno', 'requestsBuilder.js'), 'utf8'))
      .toMatch(/parseEnvJson\("reservationPlaceSelections", \[\]\)\.filter\(\(p\) => !seatMapIds\.has\(p\?\.reservationId\)\)/);
  });
});

// #737: shapes from a real provider. Its offer covers a 3-leg trip; the
// mandatory reservation names its leg, the optional one names none; its
// booking gives the trip new leg ids, in the same order.
describe('a reservation without a leg, and a booking that renames the legs (#737)', () => {
  const tripLegs = [{ id: 'T9', legIds: ['a', 'b', 'c'] }];
  const realOffer = {
    offerId: 'O9',
    tripCoverage: { coveredTripId: 'T9' },
    admissionOfferParts: [{ id: 'A9', reservations: [relation(1, 'RM'), relation(0, 'RX')] }],
    reservationOfferParts: [
      { id: 'RM', passengerRefs: ['P1', 'P2'], tripCoverage: { coveredTripId: 'T9', coveredLegIds: ['a'] } },
      { id: 'RX', passengerRefs: ['P1', 'P2'], summary: 'Second class reservation' },
    ],
  };

  test('a part naming its leg keeps it; one naming none gets no leg when two or more are free', () => {
    expect(sr.legOfReservation(realOffer, 'RM', tripLegs)).toEqual({ tripId: 'T9', legId: 'a' });
    expect(sr.legOfReservation(realOffer, 'RX', tripLegs)).toBeNull();
    expect(sr.legOfReservation(realOffer, 'nope', tripLegs)).toBeNull();
  });

  test('…and the one free leg when exactly one is left', () => {
    const twoLegs = [{ id: 'T9', legIds: ['a', 'b'] }];
    expect(sr.legOfReservation(realOffer, 'RX', twoLegs)).toEqual({ tripId: 'T9', legId: 'b' });
    const noTripOnOffer = { ...realOffer, tripCoverage: undefined };
    expect(sr.legOfReservation(noTripOnOffer, 'RX', twoLegs)).toEqual({ tripId: 'T9', legId: 'b' });
    expect(sr.legOfReservation(noTripOnOffer, 'RX', [])).toBeNull();
  });

  test('placeSelections never carry an empty tripLegCoverage', () => {
    const sels = sr.placeSelectionsFor(realOffer, ['RM', 'RX'], tripLegs);
    expect(sels).toEqual([{ reservationId: 'RM', tripLegCoverage: { tripId: 'T9', legId: 'a' } }]);
    expect(sr.reservationsWithoutLeg(realOffer, ['RM', 'RX'], tripLegs)).toEqual(['RX']);
  });

  test('in an optional group, a part naming its leg is chosen first', () => {
    const group = { ...realOffer, admissionOfferParts: [{ id: 'A9', reservations: [relation(0, 'RX', 'RM')] }] };
    expect(sr.reservationsToBook(group, { bookOptional: true }).optional).toEqual(['RM']);
  });

  test('a booked reservation on the renamed leg at the same place matches', () => {
    const booking = {
      trips: [{ id: 'T9', legs: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] }],
      bookedOffers: [{ reservations: [{ id: 'BR', tripCoverage: { coveredTripId: 'T9', coveredLegIds: ['x'] } }] }],
    };
    const ok = sr.checkBookedReservations(booking, realOffer, ['RM'], { places: false, offerTrips: tripLegs });
    expect(ok.filter((c) => !c.ok)).toEqual([]);
    // Without the offer's trips, the renamed leg cannot be told: the old failure.
    expect(sr.checkBookedReservations(booking, realOffer, ['RM'], { places: false }).filter((c) => !c.ok)).toHaveLength(1);
    // A reservation on another leg (place 2) does not match leg a (place 1).
    const elsewhere = { ...booking, bookedOffers: [{ reservations: [{ id: 'BR', tripCoverage: { coveredTripId: 'T9', coveredLegIds: ['y'] } }] }] };
    expect(sr.checkBookedReservations(elsewhere, realOffer, ['RM'], { places: false, offerTrips: tripLegs }).filter((c) => !c.ok)).toHaveLength(1);
  });

  test('the offer step: PLACE_SELECTION sends the leg-less one through optionalReservationSelections', () => {
    envStore.reservationBookingForm = 'PLACE_SELECTION';
    const both = { ...realOffer, admissionOfferParts: [{ id: 'A9', reservations: [relation(1, 'RM'), relation(1, 'RX')] }] };
    withBrunoExpect(() => offers.handleOptionalReservationSelections(both, [{ id: 'T9', legs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]));
    expect(JSON.parse(envStore.reservationPlaceSelections)).toEqual([{ reservationId: 'RM', tripLegCoverage: { tripId: 'T9', legId: 'a' } }]);
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([{ reservationId: 'RX' }]);
    expect(JSON.parse(envStore.__offerTripLegs)).toEqual(tripLegs);
    expect(mockLogs.some((l) => l.includes('Reservation RX: the offer gives no leg for it — booked through optionalReservationSelections'))).toBe(true);
  });

  test('the offer step (#742): with no form, a mandatory one without a leg is still named in optionalReservationSelections', () => {
    const both = { ...realOffer, admissionOfferParts: [{ id: 'A9', reservations: [relation(1, 'RM'), relation(1, 'RX')] }] };
    withBrunoExpect(() => offers.handleOptionalReservationSelections(both, [{ id: 'T9', legs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]));
    expect(JSON.parse(envStore.reservationPlaceSelections)).toEqual([{ reservationId: 'RM', tripLegCoverage: { tripId: 'T9', legId: 'a' } }]);
    expect(JSON.parse(envStore.optionalReservationSelections)).toEqual([{ reservationId: 'RX' }]);
    expect(mockLogs).toContain('[INFO] Reservations: 2 mandatory, 0 optional booked; 2 with the booking (1 in placeSelections, 1 in optionalReservationSelections), 0 added after it.');
  });

  test('bookingSelections never names a reservation in both lists', () => {
    const sel = sr.bookingSelections(realOffer, { atBooking: ['RM', 'RX'], mandatory: ['RM', 'RX'], form: null }, tripLegs);
    const placed = sel.placeSelections.map((s) => s.reservationId);
    const named = sel.optionalReservationSelections.map((s) => s.reservationId);
    expect(placed.filter((id) => named.includes(id))).toEqual([]);
    expect([...placed, ...named].sort()).toEqual(['RM', 'RX']);
    expect(sel.noLeg).toEqual(['RX']);
  });

  test('the offer step: ADD_LATER leaves out what cannot be added', () => {
    envStore.reservationBookingForm = 'ADD_LATER';
    withBrunoExpect(() => offers.handleOptionalReservationSelections(realOffer, [{ id: 'T9', legs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]));
    expect(JSON.parse(envStore.reservationAddLaterSelections)).toEqual([]);
    expect(mockLogs.some((l) => l.includes('Reservation RX: the offer gives no leg for it — it cannot be added after the booking'))).toBe(true);
  });
});
