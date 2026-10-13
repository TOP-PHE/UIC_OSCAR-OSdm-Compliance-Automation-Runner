// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #692: with no requestor configured, the Requestor header is left out
 * instead of being sent as the text "{{requestor}}".
 */

const fs = require('node:fs');
const path = require('node:path');
const { dropUnsetRequestor, requestorHeader } = require('../../../Bruno_Collection/library-bruno/requestHeaders.js');

function fakeReq(headers) {
  const h = { ...headers };
  return { headers: h, getHeaders: () => h, deleteHeader: (n) => { delete h[n]; } };
}

describe('Requestor header (#692)', () => {
  test.each([undefined, null, '', '   '])('removed when the requestor is %p, whatever its case', (requestor) => {
    const req = fakeReq({ Requestor: '{{requestor}}', requestor: '', Accept: 'application/json' });
    expect(dropUnsetRequestor(req, requestor)).toBe(true);
    expect(req.headers).toEqual({ Accept: 'application/json' });
  });

  test('kept when a requestor is configured', () => {
    const req = fakeReq({ Requestor: '{{requestor}}' });
    expect(dropUnsetRequestor(req, 'ABC123')).toBe(false);
    expect(req.headers).toEqual({ Requestor: '{{requestor}}' });
  });

  test('nothing to remove says so', () => {
    expect(dropUnsetRequestor(fakeReq({ Accept: 'x' }), '')).toBe(false);
  });

  test('a request a script sends itself carries the header only when set', () => {
    expect(requestorHeader('')).toEqual({});
    expect(requestorHeader(undefined)).toEqual({});
    expect(requestorHeader('R1')).toEqual({ Requestor: 'R1' });
  });

  test('the collection calls it on every request, and the idempotency replay uses it', () => {
    const root = path.join(__dirname, '..', '..', '..', 'Bruno_Collection');
    const collection = fs.readFileSync(path.join(root, 'opencollection.yml'), 'utf8');
    const before = collection.slice(collection.indexOf('type: before-request'), collection.indexOf('type: after-response'));
    expect(before).toContain('dropUnsetRequestor(req, bru.getEnvVar("requestor"))');
    const idem = fs.readFileSync(path.join(root, 'library-bruno', 'idempotencySteps.js'), 'utf8');
    expect(idem).toContain("...requestorHeader(bru.getEnvVar('requestor'))");
    expect(idem).not.toContain("Requestor: bru.getEnvVar('requestor')");
  });
});
