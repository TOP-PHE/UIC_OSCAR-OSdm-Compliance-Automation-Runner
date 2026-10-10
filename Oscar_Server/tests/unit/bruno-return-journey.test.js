// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-return-journey.test.js — the return journey in its two OSDM models
 * (#594): what the first call sends by version, the inbound request of each
 * model, and the checks of the inbound response and of the fulfillments.
 */

let envStore = {};
global.bru = {
  getEnvVar:    (k) => (Object.prototype.hasOwnProperty.call(envStore, k) ? envStore[k] : undefined),
  setEnvVar:    (k, v) => { envStore[k] = v; },
  deleteEnvVar: (k) => { delete envStore[k]; },
  getVar:       () => undefined,
  setVar:       () => {},
};
global.validationLogger = () => {};

const rj = require('../../../Bruno_Collection/library-bruno/returnJourney.js');
const sp = require('../../../Bruno_Collection/library-bruno/scenarioParser.js');
const { TripLegDefinition } = require('../../../Bruno_Collection/library-bruno/model.js');
const { withBrunoExpect } = require('../helpers/bruno-chai');

const logs = [];
beforeEach(() => {
  envStore = {};
  logs.length = 0;
  global.validationLogger = (line) => { logs.push(line); };
});

const place = (n) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:000000${n}` });
const outboundCriteria = { departureTime: '2026-11-20T08:00:00', origin: place(1), destination: place(2) };
const trip = (id, from, to, direction) => ({ id, origin: place(from), destination: place(to), ...(direction ? { direction } : {}) });

describe('the first call: where the inbound date goes, by version', () => {
  // osdmTripSearchCriteria records Bruno checks of its own: run them in place,
  // with the chai stand-in, and fail on any of them.
  const search = (version, returnOpts) => {
    envStore.osdmVersion = version;
    const jestTest = global.test;
    global.test = (name, fn) => fn();
    try {
      withBrunoExpect(() => sp.osdmTripSearchCriteria([
        new TripLegDefinition('urn:uic:stn:0000001', '2026-11-20T08:00:00', 'urn:uic:stn:0000002', null),
      ], returnOpts, null));
    } finally {
      global.test = jestTest;
    }
    return JSON.parse(envStore.offerTripSearchCriteria);
  };

  test('before 3.7: returnSearchParameters.inwardReturnDate on the trip', () => {
    const tsc = search('3.6.0', { offsetDays: 2, time: '17:00' });
    expect(tsc.returnSearchParameters).toEqual({ inwardReturnDate: '2026-11-22T17:00:00' });
    expect(envStore.returnInboundDate).toBe('2026-11-22T17:00:00');
    expect(envStore.returnModel).toBe('SEPARATE');
  });

  test('from 3.7: nothing on the trip; the date is kept for offerSearchCriteria.inboundDate', () => {
    const tsc = search('3.7.0', { offsetDays: 2, time: '17:00', model: 'COMBINED', fulfillments: 'PER_DIRECTION' });
    expect(tsc.returnSearchParameters).toBeUndefined();
    expect(envStore.returnInboundDate).toBe('2026-11-22T17:00:00');
    expect(envStore.returnModel).toBe('COMBINED');
    expect(envStore.returnFulfillments).toBe('PER_DIRECTION');
  });

  test('one-way: no inbound date, so no return', () => {
    envStore.returnInboundDate = 'left over';
    const tsc = search('3.8.0', { offsetDays: null });
    expect(tsc.returnSearchParameters).toBeUndefined();
    expect(envStore.returnInboundDate).toBeNull();
  });

  test('COMBINED declared below 3.7 is sent, with a warning', () => {
    search('3.6.0', { offsetDays: 1, model: 'COMBINED' });
    expect(logs.some((l) => l.startsWith('[WARNING] Return model COMBINED'))).toBe(true);
    expect(envStore.returnModel).toBe('COMBINED');
  });

  test('an unknown model or fulfillment expectation falls back to SEPARATE / no check', () => {
    search('3.8.0', { offsetDays: 1, model: 'BOTH', fulfillments: 'MANY' });
    expect(envStore.returnModel).toBe('SEPARATE');
    expect(envStore.returnFulfillments).toBeNull();
  });
});

describe('buildInboundOfferRequest', () => {
  const base = { outboundCriteria, inboundDateTime: '2026-11-22T17:00:00', outboundOfferId: 'OFR-1', outboundTripId: 'TRIP-OUT', version: '3.8.0' };

  test('SEPARATE names the outbound offer; COMBINED the outbound trip', () => {
    expect(rj.buildInboundOfferRequest({ ...base, model: 'SEPARATE' }).body.tripSearchCriteria).toEqual({
      departureTime: '2026-11-22T17:00:00', origin: place(2), destination: place(1),
      returnSearchParameters: { outwardOfferIds: ['OFR-1'] },
    });
    expect(rj.buildInboundOfferRequest({ ...base, model: 'COMBINED' }).body.tripSearchCriteria.returnSearchParameters)
      .toEqual({ outboundTripIds: ['TRIP-OUT'] });
  });

  test('says why when it cannot build', () => {
    expect(rj.buildInboundOfferRequest({ ...base, inboundDateTime: null }).reason).toMatch(/not a return/);
    expect(rj.buildInboundOfferRequest({ ...base, outboundCriteria: {} }).reason).toMatch(/origin or destination/);
    expect(rj.buildInboundOfferRequest({ ...base, model: 'SEPARATE', outboundOfferId: null }).reason).toMatch(/no outbound offer/);
    expect(rj.buildInboundOfferRequest({ ...base, model: 'COMBINED', outboundTripId: null }).reason).toMatch(/names no trip/);
  });

  test('localDateTime drops an offset and keeps a local date-time', () => {
    expect(rj.localDateTime('2026-11-22T17:00:00+01:00')).toBe('2026-11-22T17:00:00');
    expect(rj.localDateTime('2026-11-22T17:00:00Z')).toBe('2026-11-22T17:00:00');
    expect(rj.localDateTime('2026-11-22T17:00:00')).toBe('2026-11-22T17:00:00');
  });
});

describe('checkReturnOffers', () => {
  const failing = (checks) => checks.filter((c) => !c.ok && c.level === 'fail').map((c) => c.name);
  const passengers = [{ externalRef: 'P1' }, { externalRef: 'P2' }];
  const combined = {
    anonymousPassengerSpecifications: passengers,
    trips: [trip('OUT', 1, 2, 'OUT_BOUND'), trip('IN', 2, 1, 'IN_BOUND')],
    offers: [
      { offerId: 'O1', tripCoverage: { coveredTripId: 'OUT' }, inboundTripCoverage: { coveredTripId: 'IN' } },
      { offerId: 'O2', tripCoverage: { coveredTripId: 'OUT' }, inboundTripCoverage: { coveredTripId: 'IN' } },
    ],
  };
  const ctx = { model: 'COMBINED', outboundCriteria, outboundTripId: 'OUT', passengerRefs: ['P2', 'P1'] };

  test('COMBINED: a conformant answer passes every check', () => {
    const checks = rj.checkReturnOffers(combined, ctx);
    expect(failing(checks)).toEqual([]);
    expect(checks.length).toBe(6);
  });

  test('COMBINED: an offer without inboundTripCoverage, or on another outbound trip, fails', () => {
    const answer = structuredClone(combined);
    delete answer.offers[0].inboundTripCoverage;
    answer.offers[1].tripCoverage.coveredTripId = 'OTHER';
    const names = failing(rj.checkReturnOffers(answer, ctx));
    expect(names).toEqual([
      'Return offer 1 (O1) covers an inbound trip of the response (inboundTripCoverage.coveredTripId)',
      'Return offer 2 (O2) covers the chosen outbound trip (tripCoverage.coveredTripId)',
    ]);
  });

  test('COMBINED: an inbound coverage naming the outbound trip, or no trip of the response, fails', () => {
    const answer = structuredClone(combined);
    answer.offers[0].inboundTripCoverage.coveredTripId = 'OUT';
    answer.offers[1].inboundTripCoverage.coveredTripId = 'GHOST';
    expect(failing(rj.checkReturnOffers(answer, ctx))).toHaveLength(2);
  });

  test('no trip back, or other passengers, fails', () => {
    const answer = structuredClone(combined);
    answer.trips[1] = trip('IN', 2, 3);
    answer.anonymousPassengerSpecifications = [{ externalRef: 'P1' }];
    expect(failing(rj.checkReturnOffers(answer, ctx))).toEqual([
      'Return: a trip goes back, from urn:uic:stn:0000002 to urn:uic:stn:0000001',
      'Return: the passengers are those of the outbound search',
    ]);
  });

  test('an inbound trip marked OUT_BOUND is a warning only; an absent direction is nothing', () => {
    const answer = structuredClone(combined);
    answer.trips[1].direction = 'OUT_BOUND';
    const checks = rj.checkReturnOffers(answer, ctx);
    expect(failing(checks)).toEqual([]);
    expect(checks.filter((c) => c.level === 'warn').map((c) => c.ok)).toEqual([false]);
    delete answer.trips[1].direction;
    expect(rj.checkReturnOffers(answer, ctx).filter((c) => c.level === 'warn')).toEqual([]);
  });

  test('SEPARATE: inbound offers cover an inbound trip, never the outbound one', () => {
    const answer = {
      trips: [trip('IN', 2, 1)],
      offers: [{ offerId: 'I1', tripCoverage: { coveredTripId: 'IN' } }, { offerId: 'I2', tripCoverage: { coveredTripId: 'OUT' } }, { offerId: 'I3' }],
    };
    const names = failing(rj.checkReturnOffers(answer, { ...ctx, model: 'SEPARATE' }));
    expect(names).toEqual(['Inbound offer 2 (I2) covers an inbound trip, not the outbound one']);
  });

  test('passengers are not compared when the answer does not list them', () => {
    const answer = structuredClone(combined);
    delete answer.anonymousPassengerSpecifications;
    expect(rj.checkReturnOffers(answer, ctx).some((c) => c.name.includes('passengers'))).toBe(false);
  });
});

describe('checkReturnFulfillmentCount', () => {
  test('ONE, PER_DIRECTION, PER_PASSENGER', () => {
    const f = (n) => Array.from({ length: n }, (_, i) => ({ id: `F${i}` }));
    expect(rj.checkReturnFulfillmentCount(f(1), 'ONE', 2).ok).toBe(true);
    expect(rj.checkReturnFulfillmentCount(f(2), 'ONE', 2).ok).toBe(false);
    expect(rj.checkReturnFulfillmentCount(f(2), 'PER_DIRECTION', 3).ok).toBe(true);
    expect(rj.checkReturnFulfillmentCount(f(3), 'PER_PASSENGER', 3).ok).toBe(true);
    expect(rj.checkReturnFulfillmentCount(undefined, 'PER_DIRECTION', 1)).toMatchObject({ ok: false, message: 'expected 2 (PER_DIRECTION), actual 0' });
  });

  test('no expectation, or an unknown one: no check', () => {
    expect(rj.checkReturnFulfillmentCount([], null, 1)).toBeNull();
    expect(rj.checkReturnFulfillmentCount([], 'MANY', 1)).toBeNull();
  });
});
