// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #881: steps 03 (PATCH) and 04 (GET Passenger) leave out a passenger the
 * booking lacks instead of sending …/passengers/undefined.
 */

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const STEPS = path.join(LIB, '..', '02-Common Requests');
const { idsOf, nextPassengerWithId, choosePassenger } = require(path.join(LIB, 'passengerSteps.js'));

describe('the next passenger with an id', () => {
  test('ids from an array or JSON text; anything else is none', () => {
    expect(idsOf(['a', 'b'])).toEqual(['a', 'b']);
    expect(idsOf('["a","b"]')).toEqual(['a', 'b']);
    expect(idsOf('a,b')).toEqual(['a', 'b']);
    expect(idsOf(undefined)).toEqual([]);
    expect(idsOf('')).toEqual([]);
  });

  test('the first at or after the index, with those left out on the way', () => {
    expect(nextPassengerWithId(['a', 'b'], 0, 2)).toEqual({ index: 0, skipped: [] });
    expect(nextPassengerWithId(['a'], 1, 2)).toEqual({ index: -1, skipped: [1] });
    expect(nextPassengerWithId([undefined, '', 'c'], 0, 3)).toEqual({ index: 2, skipped: [0, 1] });
    expect(nextPassengerWithId([7], 0, 1)).toEqual({ index: 0, skipped: [] });
    expect(nextPassengerWithId(['a', 'b'], 2, 2)).toEqual({ index: -1, skipped: [] });
    expect(nextPassengerWithId(['a'], -3, 1)).toEqual({ index: 0, skipped: [] });
  });

  test('the glue warns once per passenger left out, naming its externalRef and the step', () => {
    const env = { offerPassengerNumber: '3', passengerIdList: ['a', null, 'c'], bookingPassengerReferences: '["00001","00002","00003"]' };
    const logs = [];
    global.bru = { getEnvVar: (k) => env[k] };
    const displays = require(path.join(LIB, 'displays.js'));
    const spy = jest.spyOn(displays, 'validationLogger').mockImplementation((l) => { logs.push(l); });
    let picked;
    try {
      picked = [choosePassenger('update', 1), choosePassenger('read', 3)];
    } finally { delete global.bru; spy.mockRestore(); }
    expect(picked).toEqual([2, -1]);
    expect(logs.filter((l) => l.startsWith('[WARNING] Passenger'))).toEqual([
      '[WARNING] Passenger 1 (externalRef 00002) is not in the booking: its update (03. PATCH Multi Passenger) is not tested. Step 02 reports the missing passenger.',
    ]);
  });
});

describe('steps 03 and 04 use it', () => {
  for (const [file, step] of [['03. PATCH Multi Passenger.yml', 'update'], ['04. GET Passenger.yml', 'read']]) {
    test(`${file}: before the request and to choose the next one; nothing left skips the request`, () => {
      const text = fs.readFileSync(path.join(STEPS, file), 'utf8');
      expect(text.split(`passengerSteps.js").choosePassenger("${step}", currentIndex)`).length - 1).toBe(1);
      expect(text).toContain(`passengerSteps.js").choosePassenger("${step}", currentIndex + 1)`);
      expect(text).not.toContain('currentIndex++;');
      const before = text.slice(0, text.indexOf('type: after-response'));
      const skip = before.indexOf('bru.runner.skipRequest();');
      expect(skip).toBeGreaterThan(before.indexOf(`choosePassenger("${step}", currentIndex)`));
      expect(before.slice(skip, before.indexOf('return;', skip))).not.toMatch(/bru\.(setEnvVar|getEnvVar)/);
    });
  }
});
