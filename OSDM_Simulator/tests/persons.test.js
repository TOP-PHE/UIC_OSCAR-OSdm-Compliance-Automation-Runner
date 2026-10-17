// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #611: passenger and purchaser checks, and requested information.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { SECRETS, startSimulator, tokenFor, call, offerRequest, bookingRequest } = require('./helpers');

let sim;
before(async () => { sim = await startSimulator(); });
after(async () => { await sim.close(); });

const clientOf = { alpha: SECRETS.alpha[0], beta: SECRETS.beta[0], gamma: SECRETS.gamma[0], plain: SECRETS.plain[0] };
const from = (stopPlaceRef) => offerRequest({ tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } } });

async function booked(provider, { stop = 'urn:uic:stn:0000001', purchaser = true } = {}) {
  const token = await tokenFor(sim.base, provider, clientOf[provider]);
  const offers = (await call(sim.base, token, 'POST', `/${provider}/offers`, from(stop))).body.offers;
  const body = bookingRequest(offers[0]);
  if (!purchaser) delete body.purchaser;
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, body)).body.booking;
  return { token, offers, booking, base: `/${provider}/bookings/${booking.id}` };
}

test('gamma refuses an invalid passenger update, naming the field, as alpha and beta do; a provider without person checks keeps any value', async () => {
  const { token, booking, base } = await booked('gamma');
  const url = `${base}/passengers/${booking.passengers[0].id}`;
  const cases = [
    [{ gender: 'ZZZ' }, 'gender', '/gender'],
    [{ dateOfBirth: 'not-a-date' }, 'dateOfBirth', '/dateOfBirth'],
    [{ dateOfBirth: '2026-02-30' }, 'dateOfBirth', '/dateOfBirth'],
    [{ detail: { firstName: '' } }, 'firstName', '/detail/firstName'],
    [{ detail: { contact: { email: 'not-an-email' } } }, 'email', '/detail/contact/email'],
    [{ detail: { contact: { phoneNumber: 'not-a-phone' } } }, 'phoneNumber', '/detail/contact/phoneNumber'],
  ];
  for (const [body, field, pointer] of cases) {
    const res = await call(sim.base, token, 'PATCH', url, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, 'INVALID_PERSON_DATA');
    assert.ok(res.body.detail.startsWith(`${field}:`), res.body.detail);
    assert.deepEqual(res.body.pointers, [pointer]);
  }
  const ok = await call(sim.base, token, 'PATCH', url, { gender: 'FEMALE', dateOfBirth: '1990-02-28', detail: { firstName: 'A', contact: { email: 'a@example.org', phoneNumber: '+33 1 23 45 67' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.passenger.gender, 'FEMALE');
  for (const provider of ['alpha', 'beta']) {
    const other = await booked(provider);
    const refused = await call(sim.base, other.token, 'PATCH', `${other.base}/passengers/${other.booking.passengers[0].id}`, { detail: { contact: { email: 'x' } } });
    assert.equal(refused.status, 400, provider);
    assert.equal(refused.body.code, 'INVALID_PERSON_DATA');
  }
  const plain = await booked('plain');
  assert.equal((await call(sim.base, plain.token, 'PATCH', `${plain.base}/passengers/${plain.booking.passengers[0].id}`, { detail: { contact: { email: 'x' } } })).status, 200);
});

test('a refused update changes nothing', async () => {
  const { token, booking, base } = await booked('gamma');
  const url = `${base}/passengers/${booking.passengers[0].id}`;
  assert.equal((await call(sim.base, token, 'PATCH', url, { gender: 'MALE', dateOfBirth: 'x' })).status, 400);
  assert.deepEqual((await call(sim.base, token, 'GET', url)).body.passenger, booking.passengers[0]);
});

test('requested information: asked on the offers and the booking from station 0000097, until given', async () => {
  const { token, offers, booking, base } = await booked('gamma', { stop: 'urn:uic:stn:0000097' });
  for (const part of offers[0].admissionOfferParts) assert.match(part.requestedInformation, /dateOfBirth AND .*phoneNumber/);
  assert.equal(booking.requestedInformation, undefined, 'the booking request gave both');
  const url = `${base}/passengers/${booking.passengers[0].id}`;
  const omitted = await call(sim.base, token, 'PATCH', url, { detail: { contact: { phoneNumber: '' } } });
  assert.equal(omitted.status, 400);
  assert.ok(omitted.body.detail.startsWith('phoneNumber:'), omitted.body.detail);
  const plain = await booked('gamma');
  assert.equal(plain.offers[0].admissionOfferParts[0].requestedInformation, undefined);
});

test('a booking made without a purchaser has none until one is written, and it needs its names', async () => {
  const { token, base } = await booked('gamma', { purchaser: false });
  assert.equal((await call(sim.base, token, 'GET', `${base}/purchaser`)).status, 404);
  const noName = await call(sim.base, token, 'POST', `${base}/purchaser`, { detail: { lastName: 'P', contact: { email: 'p@example.org' } } });
  assert.equal(noName.status, 400);
  assert.deepEqual(noName.body.pointers, ['/detail/firstName']);
  const made = await call(sim.base, token, 'POST', `${base}/purchaser`, { detail: { firstName: 'Paula', lastName: 'P', contact: { email: 'p@example.org' } } });
  assert.equal(made.status, 200);
  assert.equal((await call(sim.base, token, 'GET', `${base}/purchaser`)).body.purchaser.detail.firstName, 'Paula');
});

// Only the main passenger may be changed, and only the main
// passenger's names are kept (no date of birth, no contact).
async function bookedTwo(lastNames) {
  const token = await tokenFor(sim.base, 'gamma', clientOf.gamma);
  const two = [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }, { externalRef: '00002', type: 'PERSON', dateOfBirth: '1991-02-16' }];
  const offers = (await call(sim.base, token, 'POST', '/gamma/offers', offerRequest({ anonymousPassengerSpecifications: two }))).body.offers;
  const body = bookingRequest(offers[0]);
  lastNames.forEach((name, i) => { body.passengerSpecifications[i].detail.lastName = name; });
  const booking = (await call(sim.base, token, 'POST', '/gamma/bookings', body)).body.booking;
  return { token, booking, url: (i) => `/gamma/bookings/${booking.id}/passengers/${booking.passengers[i].id}` };
}

test('main-passenger-only: the main passenger may be changed, another one is refused and left as it was', async () => {
  const { token, booking, url } = await bookedTwo(['Simvariant-main-passenger-only', 'Example']);
  assert.equal((await call(sim.base, token, 'PATCH', url(0), { detail: { firstName: 'Main', lastName: 'Changed' } })).status, 200);
  const refused = await call(sim.base, token, 'PATCH', url(1), { detail: { firstName: 'Other', lastName: 'Changed' } });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE');
  assert.match(refused.body.detail, /Only the main passenger '00001'/);
  assert.deepEqual((await call(sim.base, token, 'GET', url(1))).body.passenger, booking.passengers[1]);
  const plain = await bookedTwo(['Example', 'Example']);
  assert.equal((await call(sim.base, plain.token, 'PATCH', plain.url(1), { detail: { firstName: 'Other', lastName: 'Changed' } })).status, 200);
});

test('main-names-only: the main passenger keeps its names, nothing else is kept, before or after an update', async () => {
  const { token, booking, url } = await bookedTwo(['Simvariant-main-names-only', 'Example']);
  assert.deepEqual(booking.passengers.map((p) => [p.dateOfBirth, p.detail]), [
    [undefined, { firstName: 'Alex', lastName: 'Simvariant-main-names-only' }],
    [undefined, undefined],
  ]);
  const patched = await call(sim.base, token, 'PATCH', url(0), { dateOfBirth: '1980-05-05', detail: { firstName: 'New', lastName: 'Name', contact: { email: 'n@example.org' } } });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.passenger.detail, { firstName: 'New', lastName: 'Name' });
  assert.equal(patched.body.passenger.dateOfBirth, undefined);
  const plain = await bookedTwo(['Example', 'Example']);
  assert.equal(plain.booking.passengers[1].dateOfBirth, '1990-01-15', 'without the variant, kept as booked');
});
