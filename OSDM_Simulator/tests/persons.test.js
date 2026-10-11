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

const [alphaOne] = SECRETS.alpha;
const [gammaOne] = SECRETS.gamma;
const from = (stopPlaceRef) => offerRequest({ tripSearchCriteria: { ...offerRequest().tripSearchCriteria, origin: { objectType: 'StopPlaceRef', stopPlaceRef } } });

async function booked(provider, { stop = 'urn:uic:stn:0000001', purchaser = true } = {}) {
  const token = await tokenFor(sim.base, provider, provider === 'gamma' ? gammaOne : alphaOne);
  const offers = (await call(sim.base, token, 'POST', `/${provider}/offers`, from(stop))).body.offers;
  const body = bookingRequest(offers[0]);
  if (!purchaser) delete body.purchaser;
  const booking = (await call(sim.base, token, 'POST', `/${provider}/bookings`, body)).body.booking;
  return { token, offers, booking, base: `/${provider}/bookings/${booking.id}` };
}

test('gamma refuses an invalid passenger update, naming the field; alpha keeps any value', async () => {
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
  const alpha = await booked('alpha');
  assert.equal((await call(sim.base, alpha.token, 'PATCH', `${alpha.base}/passengers/${alpha.booking.passengers[0].id}`, { detail: { contact: { email: 'x' } } })).status, 200);
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
