// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * bruno-specified-carriers.test.js — the carrier a trip specification asks
 * for, against the one the provider's answer names (#1021).
 */

const { answeredTrip, carrierDifferences, carrierWarning } = require('../../../Bruno_Collection/library-bruno/specifiedCarriers.js');

const leg = (carriers) => ({ timedLeg: { service: { vehicleNumbers: ['1'], ...(carriers ? { carriers: carriers.map((ref) => ({ ref })) } : {}) } } });
const spec = (...legs) => [{ externalRef: 'trip-1', legs }];
const trip = (id, ...legs) => ({ id, legs });

describe('the trip answered', () => {
  test('the one the chosen offer covers, else the first with as many timed legs', () => {
    const one = trip('T1', leg(['a']));
    const two = trip('T2', leg(['a']), { transferLeg: {} }, leg(['b']));
    expect(answeredTrip([one, two], 2, 'T1')).toBe(one);
    expect(answeredTrip([one, two], 2, null)).toBe(two);
    expect(answeredTrip([one, two], 3, 'nope')).toBeNull();
    expect(answeredTrip(undefined, 1)).toBeNull();
  });
});

describe('the carriers that differ', () => {
  test('a leg answered with another carrier is listed, leg by leg', () => {
    const asked = spec(leg(['urn:x:gamma']), leg(['urn:x:gamma']));
    const answer = [trip('T', leg(['urn:x:zeta']), leg(['urn:x:gamma']))];
    expect(carrierDifferences(asked, answer, 'T')).toEqual([{ leg: 1, asked: ['urn:x:gamma'], offered: ['urn:x:zeta'] }]);
  });

  test('the same carrier, compared without case, or one of several: nothing', () => {
    expect(carrierDifferences(spec(leg(['urn:uic:rics:1185'])), [trip('T', leg(['URN:UIC:RICS:1185']))], 'T')).toEqual([]);
    expect(carrierDifferences(spec(leg(['a', 'b'])), [trip('T', leg(['c', 'b']))], 'T')).toEqual([]);
  });

  test('nothing said when either side names no carrier, or there is nothing to compare', () => {
    expect(carrierDifferences(spec(leg(null)), [trip('T', leg(['x']))], 'T')).toEqual([]);
    expect(carrierDifferences(spec(leg(['x'])), [trip('T', leg(null))], 'T')).toEqual([]);
    expect(carrierDifferences(spec(leg(['x'])), [trip('T', leg([' ']))], 'T')).toEqual([]);
    expect(carrierDifferences(spec(leg(['x'])), [], 'T')).toEqual([]);
    expect(carrierDifferences([], [trip('T', leg(['y']))], 'T')).toEqual([]);
    expect(carrierDifferences(undefined, undefined)).toEqual([]);
  });

  test('a transfer leg of the answer is not a train: the timed legs are compared in order', () => {
    const asked = spec(leg(['a']), leg(['b']));
    const answer = [trip('T', leg(['a']), { transferLeg: { start: {}, end: {} } }, leg(['z']))];
    expect(carrierDifferences(asked, answer, 'T')).toEqual([{ leg: 2, asked: ['b'], offered: ['z'] }]);
  });

  test('the warning says what was asked and answered', () => {
    expect(carrierWarning({ leg: 1, asked: ['urn:x:gamma'], offered: ['urn:x:zeta'] }))
      .toBe('Leg 1: the trip specification asks for a train of urn:x:gamma, the provider\'s answer names urn:x:zeta. It may be offering another train than the one asked.');
  });
});

describe('step 01 says it (validateTripsAndLegs)', () => {
  let envStore = {};
  let logs = [];
  beforeAll(() => {
    global.bru = {
      getEnvVar: (k) => envStore[k],
      setEnvVar: (k, v) => { envStore[k] = v; },
      deleteEnvVar: (k) => { delete envStore[k]; },
      getVar: () => undefined, setVar: () => {},
    };
    global.validationLogger = (line) => { logs.push(line); };
    global.test = global.test || (() => {});
  });

  const run = (tripType) => {
    const { withBrunoExpect } = require('../helpers/bruno-chai.js');
    const offers = require('../../../Bruno_Collection/library-bruno/offers.js');
    global.validationLogger = (line) => { logs.push(line); };
    envStore = {
      TripType: tripType, coveredTripId: 'T',
      offerTripSpecifications: JSON.stringify(spec(leg(['urn:x_osdm_simulator:carrier:gamma']))),
    };
    logs = [];
    const jestTest = global.test;
    global.test = (name, fn) => { try { fn(); } catch { /* the trip checks are not under test here */ } };
    try {
      withBrunoExpect(() => offers.validateTripsAndLegs({ trips: [{ id: 'T', startTime: '2030-01-01T08:00:00Z', endTime: '2030-01-01T10:00:00Z', legs: [leg(['urn:x_osdm_simulator:carrier:zeta'])] }] }));
    } finally { global.test = jestTest; }
    return logs.filter((l) => l.startsWith('[WARNING] Leg 1: the trip specification asks for a train of'));
  };

  test('a specification answered with another carrier: one WARNING', () => {
    expect(run('SPECIFICATION')).toEqual(['[WARNING] Leg 1: the trip specification asks for a train of urn:x_osdm_simulator:carrier:gamma, '
      + 'the provider\'s answer names urn:x_osdm_simulator:carrier:zeta. It may be offering another train than the one asked.']);
  });

  test('a search names no carrier to compare: nothing', () => {
    expect(run('SEARCH')).toEqual([]);
  });
});
