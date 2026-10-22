// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #827 PR B: extracts of the OSDM specification for the AI analysis
 * (utils/osdmReferences.js, generated osdm-references.json).
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const R = require('../../src/utils/osdmReferences');
const G = require('../../scripts/generate-osdm-references');
const AN = require('../../src/utils/aiAnalysis');
const generated = require('../../src/utils/osdm-references.json');

describe('#827 the generated file', () => {
  test('it holds OSDM 3.4 to 3.12, and its 3.8 to 3.12 are the repository\'s specifications', () => {
    expect(Object.keys(generated.versions)).toEqual(['3.4.0', '3.5.0', '3.6.0', '3.7.0', '3.8.0', '3.9.0', '3.10.0', '3.11.0', '3.12.0']);
    for (const v of ['3.8.0', '3.9.0', '3.10.0', '3.11.0', '3.12.0']) {
      const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Test_Coverage', 'OSDM_reference', `OSDM-online-api-v${v}.yml`), 'utf8'));
      expect(generated.versions[v]).toEqual(G.versionOf(spec));
    }
  });

  test('a version without outboundTripIds does not get it from a later one', () => {
    const returnSearch = (v) => generated.versions[v].schemas.ReturnSearchParameters.text;
    expect(returnSearch('3.6.0')).not.toContain('outboundTripIds');
    expect(returnSearch('3.8.0')).toContain('outboundTripIds');
  });
});

describe('#827 a schema in a few words', () => {
  test('required members, member types, lists, closed and extensible enums, extension and alternatives', () => {
    const spec = {
      A: { type: 'object', description: 'An a. More text.', required: ['x'], properties: { x: { type: 'string', nullable: true }, y: { type: 'array', items: { $ref: '#/components/schemas/B' } },
        s: { type: 'string', enum: ['ON', 'OFF'] }, t: { type: 'string', 'x-extensible-enum': ['P', 'Q'] }, o: { oneOf: [{ $ref: '#/components/schemas/B' }, { type: 'integer' }] } } },
      C: { allOf: [{ $ref: '#/components/schemas/A' }, { type: 'object', required: ['z'], properties: { z: { type: 'number', format: 'double' } } }] },
    };
    const a = G.schemaText('A', spec.A);
    expect(a.text).toBe('A (object). An a. Required: x. Members: x: string (nullable); y: B[]; s: string (closed enum: ON|OFF); t: string (extensible, examples: P|Q); o: one of (B | integer).');
    expect(a.refs).toEqual(['B']);
    const c = G.schemaText('C', spec.C);
    expect(c.text).toBe('C (object, extends A). Required: z. Members: z: number (double).');
    expect(c.refs).toEqual(['A']);
  });
});

describe('#827 the version quoted', () => {
  test('the declared version, else the nearest, else the latest', () => {
    expect(R.versionFor('3.8')).toEqual({ version: '3.8.0', exact: true });
    expect(R.versionFor('3.6.0')).toEqual({ version: '3.6.0', exact: true });
    expect(R.versionFor('3.0.5')).toEqual({ version: '3.4.0', exact: false });
    expect(R.versionFor('3.9')).toEqual({ version: '3.9.0', exact: true });
    expect(R.versionFor('3.10')).toEqual({ version: '3.10.0', exact: true });
    expect(R.versionFor('3.11')).toEqual({ version: '3.11.0', exact: true });
    expect(R.versionFor('3.12')).toEqual({ version: '3.12.0', exact: true });
    expect(R.versionFor('3.13')).toEqual({ version: '3.12.0', exact: false });
    // #920, #925: none declared takes the latest released version (3.11), not
    // the one in development (3.12).
    expect(R.versionFor(null)).toEqual({ version: '3.11.0', exact: false });
    expect(R.versionFor('three')).toEqual({ version: '3.11.0', exact: false });
    expect(R.versionFor('3.5', ['3.4.0', '3.6.0'])).toEqual({ version: '3.4.0', exact: false });
  });
});

describe('#827 the operation of a request', () => {
  test('found from the end of the URL\'s path, whatever the provider\'s base path', () => {
    expect(R.operationOf('POST', 'https://h/alpha/offers?x=1', '3.6.0')).toBe('POST /offers');
    expect(R.operationOf('patch', 'https://h/p/q/bookings/B1/passengers/P%201', '3.8.0')).toBe('PATCH /bookings/{bookingId}/passengers/{passengerId}');
    expect(R.operationOf('POST', 'https://h/a/bookings/B1/fulfillments', '3.8.0')).toBe('POST /bookings/{bookingId}/fulfillments');
    expect(R.operationOf('GET', 'https://h/a/bookings/B1', '3.8.0')).toBe('GET /bookings/{bookingId}');
    expect(R.operationOf('GET', '/bookings/B1/purchaser', '3.8.0')).toBe('GET /bookings/{bookingId}/purchaser');
  });

  test('another method, an unknown path, no URL, an unknown version: none', () => {
    expect(R.operationOf('DELETE', 'https://h/a/offers', '3.8.0')).toBeNull();
    expect(R.operationOf('GET', 'https://h/a/nothing-here', '3.8.0')).toBeNull();
    expect(R.operationOf('GET', null, '3.8.0')).toBeNull();
    expect(R.operationOf('POST', 'https://h/a/offers', '9.9.9')).toBeNull();
  });
});

describe('#827 the extract', () => {
  test('each operation gets its request and response before any schema two levels down', () => {
    const ops = ['POST /offers', 'POST /bookings', 'POST /bookings/{bookingId}/refund-offers', 'PATCH /bookings/{bookingId}/passengers/{passengerId}', 'GET /nothing'];
    const r = R.referencesFor(ops, '3.6');
    expect(r).toMatchObject({ version: '3.6.0', declared: '3.6', exact: true });
    expect(r.operations.map((o) => o.operation)).toEqual(ops.slice(0, 4));
    for (const name of ['OfferCollectionRequest', 'OfferCollectionResponse', 'BookingRequest', 'BookingResponse', 'RefundOfferRequest', 'RefundOfferCollectionResponse']) {
      expect(Object.keys(r.schemas)).toContain(name);
    }
    expect(Object.values(r.schemas).join('').length).toBeLessThanOrEqual(R.MAX_REFERENCE_CHARS);
  });

  test('many operations: the size stays bounded, at most 12 operations, and what is left out is counted', () => {
    const all = ['POST /offers', 'POST /bookings', 'POST /bookings/{bookingId}/refund-offers', 'PATCH /bookings/{bookingId}/passengers/{passengerId}',
      'POST /bookings/{bookingId}/exchange-offers', 'POST /bookings/{bookingId}/fulfillments', 'GET /bookings/{bookingId}', 'POST /trips-collection',
      ...Object.keys(generated.versions['3.8.0'].operations)];
    const r = R.referencesFor(all, '3.8');
    expect(r.operations).toHaveLength(12);
    expect(r.operations[0].operation).toBe('POST /offers');
    expect(Object.values(r.schemas).join('').length).toBeLessThanOrEqual(R.MAX_REFERENCE_CHARS);
    expect(r.cut).toBeGreaterThan(0);
  });

  test('no operation, no schema; a version OSCAR has no file of says so', () => {
    expect(R.referencesFor([], '3.0.5')).toEqual({ version: '3.4.0', declared: '3.0.5', exact: false, operations: [], schemas: {}, cut: 0 });
  });

  test('the analysis input names each group\'s operation and carries the extract, never the URL', () => {
    const rec = { runId: 'r1', scenarioCode: 'S', step: '01. POST Get Offer', check: 'offers', status: 200, method: 'POST', url: 'https://secret-host.example/alpha/offers' };
    const { input, text } = AN.buildInput({ batches: [{ batchId: 'b', runs: 1, finishedRuns: 1, records: [rec], truncated: false }],
      framework: { osdmVersion: '3.6' }, findings: [], scenarios: [] });
    expect(input.failures[0].operation).toBe('POST /offers');
    expect(input.osdmReference.operations[0].operation).toBe('POST /offers');
    expect(input.osdmReference.schemas.OfferCollectionResponse).toContain('offers: Offer[]');
    expect(text).not.toContain('secret-host');
    expect(AN.systemPrompt({})).toContain('osdmReference is an extract');
  });
});

describe('#920, #925 a specification in development (3.12 on master)', () => {
  const dev = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Test_Coverage', 'OSDM_reference', 'osdm-dev.json'), 'utf8'));

  test('the generated file names it, with the pinned branch and commit', () => {
    expect(generated.development).toEqual({ [dev.version]: { branch: dev.branch, commit: dev.commit } });
    expect(generated.versions[dev.version]).toBeDefined();
    expect(dev.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the repository file says where it comes from', () => {
    const head = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Test_Coverage', 'OSDM_reference', dev.file), 'utf8').slice(0, 600);
    expect(head).toContain('IN DEVELOPMENT');
    expect(head).toContain(dev.commit);
    expect(head).toContain(dev.branch);
  });

  test('an extract of it says so; a released one does not', () => {
    expect(dev.version).toBe('3.12.0');
    expect(R.referencesFor(['POST /trips-collections'], '3.12').development).toEqual({ branch: dev.branch, commit: dev.commit });
    // 3.10 and 3.11 are released (#925): no development note.
    expect(R.referencesFor(['POST /trips-collections'], '3.10').development).toBeUndefined();
    expect(R.referencesFor(['POST /trips-collections'], '3.11').development).toBeUndefined();
    expect(R.referencesFor(['POST /offers'], '3.9').development).toBeUndefined();
  });

  test('3.10 and 3.11 are released: their files say so', () => {
    for (const v of ['3.10.0', '3.11.0']) {
      const head = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Test_Coverage', 'OSDM_reference', `OSDM-online-api-v${v}.yml`), 'utf8').slice(0, 600);
      expect(head).toContain(`OSDM ${v}, released`);
      expect(head).not.toContain('IN DEVELOPMENT');
    }
  });
});
