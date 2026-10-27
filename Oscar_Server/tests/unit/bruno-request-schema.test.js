'use strict';

/**
 * #736: OSCAR's own request body is checked against the OSDM request schema
 * of the version under test (library-bruno/osdmRequestSchema.js).
 *
 * The two bodies a real provider refused, and that read as its findings until
 * the requests were opened by hand, fail here naming their paths; a request
 * the collection sends to the simulator passes; deliberate negative tests are
 * said to be on purpose; no value of the body reaches the message.
 */

const path = require('node:path');
const fs = require('node:fs');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const {
  pickVersion, operationFor, requestIssues, negativeTestOf, checkRequestBody, recordRequestConformance, isDataGap, TAG,
} = require(path.join(LIB, 'osdmRequestSchema.js'));
const { requestSchemas } = require(path.join(LIB, 'osdmRequestSchemas.js'));

const BASE = 'https://osdm.example.org/api/v3';
const stop = (n) => ({ objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:000000${n}` });

// What 01 sends for a one-way search (from a simulator run).
const searchBody = () => ({
  tripSearchCriteria: { departureTime: '2026-10-24T08:00:00', origin: stop(1), destination: stop(2) },
  anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15' }],
  offerSearchCriteria: {},
  requestedFulfillmentOptions: [{ type: 'ETICKET', media: 'PDF_A4' }],
});

// What 02 sends (from a simulator run).
const bookingBody = () => ({
  offers: [{ offerId: 'GAMMA-OFR-1', passengerRefs: ['00001'] }],
  passengerSpecifications: [{
    externalRef: '00001', type: 'PERSON', dateOfBirth: '1990-01-15', gender: 'X',
    detail: { firstName: 'Alex', lastName: 'Example', contact: { email: 'alex.example@example.org', phoneNumber: '+33199000001' } },
  }],
  purchaser: { detail: { firstName: 'Paula', lastName: 'Purchaser', contact: { email: 'paula.purchaser@example.org', phoneNumber: '+33199000010' } } },
  externalRef: '00001',
});

// The offer request with a trip specification (#729: productCategory {}).
const tripSpecBody = (productCategory) => ({
  tripSpecifications: [{
    externalRef: 'trip-1',
    legs: [{
      externalRef: 'leg-1',
      timedLeg: {
        start: { stopPlaceRef: stop(1), serviceDeparture: { timetabledTime: '2026-10-24T08:00:00+02:00' } },
        end: { stopPlaceRef: stop(2), serviceArrival: { timetabledTime: '2026-10-24T10:00:00+02:00' } },
        service: { productCategory, vehicleNumbers: ['IC 1'], carriers: [{ ref: 'urn:x_swi:org:1' }] },
      },
    }],
  }],
  anonymousPassengerSpecifications: [{ externalRef: '00001', type: 'PERSON' }],
});

describe('#736 the operation a request goes to', () => {
  test('the path template is matched on the end of the URL, base path and query aside', () => {
    expect(operationFor('POST', `${BASE}/offers`, '3.8.0')).toMatchObject({ path: '/offers', schema: 'OfferCollectionRequest' });
    expect(operationFor('POST', 'http://127.0.0.1:3002/gamma/bookings/B1/exchange-offers?embed=ALL', '3.8.0'))
      .toMatchObject({ path: '/bookings/{bookingId}/exchange-offers', schema: 'ExchangeOfferCollectionRequest' });
    expect(operationFor('PATCH', `${BASE}/bookings/B1/refund-offers/R1`, '3.8.0'))
      .toMatchObject({ schema: 'RefundOfferPatchRequest' });
  });

  test('the longest template wins: /bookings/{id}/purchaser is not /bookings', () => {
    expect(operationFor('POST', `${BASE}/bookings/B1/purchaser`, '3.8.0').schema).toBe('Purchaser');
    expect(operationFor('POST', `${BASE}/bookings`, '3.8.0').schema).toBe('BookingRequest');
  });

  test('no OSDM body to check: a GET, a token request, a refund offer read', () => {
    expect(operationFor('GET', `${BASE}/bookings/B1`, '3.8.0')).toBeNull();
    expect(operationFor('POST', `${BASE}/oauth/token`, '3.8.0')).toBeNull();
    expect(checkRequestBody('GET', `${BASE}/offers`, '', '3.8.0')).toBeNull();
  });

  test('the version is the highest bundled one not above the target, else the lowest', () => {
    expect(pickVersion('3.8.1')).toBe('3.8.0');
    expect(pickVersion('3.9.0')).toBe('3.9.0');
    expect(pickVersion('3.9.1')).toBe('3.9.0');
    // #920: 3.10 is after 3.9, never read as 3.1.
    expect(pickVersion('3.10.0')).toBe('3.10.0');
    expect(pickVersion('3.10')).toBe('3.10.0');
    expect(pickVersion('3.11.0')).toBe('3.11.0');
    expect(pickVersion('3.12.0')).toBe('3.12.0');
    expect(pickVersion('3.13.0')).toBe('3.12.0');
    expect(pickVersion('3.6')).toBe('3.6.0');
    expect(pickVersion('3.2.0')).toBe('3.4.0');
    expect(Object.keys(requestSchemas)).toEqual(['3.4.0', '3.5.0', '3.6.0', '3.7.0', '3.8.0', '3.9.0', '3.10.0', '3.11.0', '3.12.0']);
    // #858: 3.9 changed no request body OSCAR sends (only date-time formats,
    // which the generator does not keep).
    expect(requestSchemas['3.9.0']).toEqual(requestSchemas['3.8.0']);
    // #920: 3.10 adds POST /trips-collections (OSDM#1487) and
    // changes no other body OSCAR sends.
    const ten = requestSchemas['3.10.0'];
    expect(ten.operations.filter((o) => o.path === '/trips-collections')).toEqual([{ method: 'POST', path: '/trips-collections', schema: 'TripSearchCriteria' }]);
    expect({ ...ten, operations: ten.operations.filter((o) => o.path !== '/trips-collections') }).toEqual(requestSchemas['3.9.0']);
    // #925: 3.11 adds optional members only (and deprecates the fulfilment
    // type and media of a booking, which OSCAR does not send); 3.12, in
    // development on master, is 3.11 so far.
    expect(Object.keys(requestSchemas['3.11.0'].operations)).toEqual(Object.keys(ten.operations));
    expect(requestSchemas['3.12.0']).toEqual(requestSchemas['3.11.0']);
  });

  test('offer-parts exists from 3.7 only', () => {
    expect(operationFor('POST', `${BASE}/bookings/B1/booked-offers/O1/offer-parts`, '3.6.0')).toBeNull();
    expect(operationFor('POST', `${BASE}/bookings/B1/booked-offers/O1/offer-parts`, '3.8.0').schema).toBe('BookedOfferPartRequest');
  });
});

describe('#736 the two bodies a real provider refused', () => {
  test('"productCategory": {} in a trip specification fails, naming the path and the members', () => {
    const issues = requestIssues(tripSpecBody({}), 'OfferCollectionRequest', '3.8.0');
    expect(issues).toEqual([
      'tripSpecifications[0].legs[0].timedLeg.service.productCategory: missing name, shortName, productCategoryRef',
    ]);
  });

  test('a full productCategory, or none, passes', () => {
    const full = { productCategoryRef: 'IC', name: 'InterCity', shortName: 'IC' };
    expect(requestIssues(tripSpecBody(full), 'OfferCollectionRequest', '3.8.0')).toEqual([]);
    const none = tripSpecBody(undefined);
    delete none.tripSpecifications[0].legs[0].timedLeg.service.productCategory;
    expect(requestIssues(none, 'OfferCollectionRequest', '3.8.0')).toEqual([]);
  });

  test('"tripLegCoverage": {} in a booking\'s placeSelections fails, naming tripId and legId', () => {
    const body = bookingBody();
    body.offers[0].placeSelections = [{ reservationId: 'RES-1', tripLegCoverage: {} }];
    const check = checkRequestBody('POST', `${BASE}/bookings`, JSON.stringify(body), '3.8.0');
    expect(check.ok).toBe(false);
    expect(check.name).toBe(`${TAG} POST /bookings conforms to OSDM 3.8.0 BookingRequest`);
    expect(check.message).toContain('offers[0].placeSelections[0].tripLegCoverage: missing tripId, legId');
    expect(check.message).toContain('an OSCAR issue, not the provider');
  });

  test('"tripLegCoverage": {} in an add-later request fails the same way', () => {
    const body = { offerId: 'OFR-2', passengerRefs: ['00001'], placeSelections: [{ reservationId: 'RES-1', tripLegCoverage: {} }] };
    const check = checkRequestBody('POST', `${BASE}/bookings/B1/booked-offers/BO1/offer-parts`, body, '3.8.0');
    expect(check.ok).toBe(false);
    expect(check.message).toContain('placeSelections[0].tripLegCoverage: missing tripId, legId');
  });

  test('a placeSelection with its leg passes', () => {
    const body = bookingBody();
    body.offers[0].placeSelections = [{ reservationId: 'RES-1', tripLegCoverage: { tripId: 'T1', legId: 'L1' } }];
    expect(checkRequestBody('POST', `${BASE}/bookings`, body, '3.8.0')).toMatchObject({ ok: true, message: '' });
  });
});

// #1019: one defect, one check. A leg without carrier is the scenario's data,
// which the data check "Trip specification leg N names its carrier" reports.
describe('#1019 what the scenario\'s data lacks is not counted again as OSCAR\'s', () => {
  const withoutCarrier = () => {
    const body = tripSpecBody(undefined);
    delete body.tripSpecifications[0].legs[0].timedLeg.service.productCategory;
    delete body.tripSpecifications[0].legs[0].timedLeg.service.carriers;
    return body;
  };

  test('a leg without carrier passes, and says why', () => {
    const check = checkRequestBody('POST', `${BASE}/offers`, withoutCarrier(), '3.8.0');
    expect(check).toMatchObject({ ok: true, message: '', dataGaps: 1 });
    expect(check.name).toBe(`${TAG} POST /offers conforms to OSDM 3.8.0 OfferCollectionRequest, but for what the scenario's data lacks (its own check says so)`);
    expect(checkRequestBody('POST', `${BASE}/offers`, withoutCarrier(), '3.6.0').ok).toBe(true);
  });

  test('another problem in the same request still fails, without the carrier', () => {
    const body = withoutCarrier();
    body.tripSpecifications[0].legs[0].timedLeg.service.productCategory = {};
    const check = checkRequestBody('POST', `${BASE}/offers`, body, '3.8.0');
    expect(check.ok).toBe(false);
    expect(check.name).toBe(`${TAG} POST /offers conforms to OSDM 3.8.0 OfferCollectionRequest`);
    expect(check.message).toContain('productCategory: missing');
    expect(check.message).not.toContain('missing carriers');
  });

  test('only a missing carrier of a trip specification leg is the data\'s', () => {
    expect(isDataGap('tripSpecifications[0].legs[0].timedLeg.service: missing carriers')).toBe(true);
    expect(isDataGap('tripSpecifications[1].legs[12].timedLeg.service: missing carriers')).toBe(true);
    expect(isDataGap('tripSpecifications[0].legs[0].timedLeg.service: missing vehicleNumbers, carriers')).toBe(false);
    expect(isDataGap('offers[0].placeSelections[0].tripLegCoverage: missing tripId, legId')).toBe(false);
    expect(isDataGap('x tripSpecifications[0].legs[0].timedLeg.service: missing carriers')).toBe(false);
  });
});

describe('#736 what the collection sends to the simulator passes', () => {
  test.each(['3.6.0', '3.7.0', '3.8.0'])('a search and a booking, OSDM %s', (v) => {
    expect(checkRequestBody('POST', `${BASE}/offers`, searchBody(), v).ok).toBe(true);
    expect(checkRequestBody('POST', `${BASE}/bookings`, JSON.stringify(bookingBody()), v).ok).toBe(true);
  });

  test('the place reference is read as the subtype its objectType names', () => {
    const body = searchBody();
    body.tripSearchCriteria.origin = { objectType: 'StopPlaceRef' };
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0')).toEqual(['tripSearchCriteria.origin: missing stopPlaceRef']);
    body.tripSearchCriteria.origin = { objectType: 'NoSuchPlaceRef', stopPlaceRef: 'x' };
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0')).toEqual(['tripSearchCriteria.origin.objectType: names no type of PlaceRef']);
  });
});

describe('#736 what a body may not hold', () => {
  test('a member OSDM does not define, where the schema closes the object', () => {
    const body = bookingBody();
    body.offers[0].seatWish = 'window';
    expect(requestIssues(body, 'BookingRequest', '3.8.0')).toEqual(['offers[0].seatWish: not a member of OfferSelection']);
  });

  test('null where OSDM does not allow it (#719 lineNumbers: null)', () => {
    const body = tripSpecBody({ productCategoryRef: 'IC', name: 'InterCity', shortName: 'IC' });
    body.tripSpecifications[0].legs[0].timedLeg.service.lineNumbers = null;
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0'))
      .toEqual(['tripSpecifications[0].legs[0].timedLeg.service.lineNumbers: expected array, got null']);
  });

  test('a member sent to a version that does not have it (inboundDate before 3.7)', () => {
    const body = searchBody();
    body.offerSearchCriteria = { inboundDate: '2026-10-30' };
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0')).toEqual([]);
    expect(requestIssues(body, 'OfferCollectionRequest', '3.6.0'))
      .toEqual(['offerSearchCriteria.inboundDate: not a member of OfferSearchCriteria']);
  });

  test('an empty list where OSDM asks for one item at least, a closed code list, no body, not JSON', () => {
    const body = searchBody();
    body.anonymousPassengerSpecifications = [];
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0'))
      .toEqual(['anonymousPassengerSpecifications: at least 1 item(s), got 0']);
    const pax = { id: 'P1', externalRef: '00001', type: 'PERSON', gender: 'ZZZ' };
    expect(requestIssues(pax, 'Passenger', '3.8.0')).toEqual(['gender: not one of the listed values (MALE, FEMALE, X)']);
    expect(checkRequestBody('POST', `${BASE}/offers`, '', '3.8.0').message).toContain('(body): no body sent');
    expect(checkRequestBody('POST', `${BASE}/offers`, '{"tripSearch', '3.8.0').message).toContain('(body): not JSON');
  });

  test('an extensible code list takes any text (PassengerType)', () => {
    const body = searchBody();
    body.anonymousPassengerSpecifications[0].type = 'SOMETHING_NEW';
    expect(requestIssues(body, 'OfferCollectionRequest', '3.8.0')).toEqual([]);
  });

  test('no value of the body reaches the message, only paths and member names', () => {
    const body = bookingBody();
    body.passengerSpecifications[0].gender = 'Paula-secret';
    body.passengerSpecifications[0].detail.firstName = 42;
    const check = checkRequestBody('POST', `${BASE}/bookings`, body, '3.8.0');
    expect(check.ok).toBe(false);
    expect(check.message).not.toContain('Paula');
    expect(check.message).not.toContain('42');
    expect(check.message).toContain('passengerSpecifications[0].detail.firstName: expected string or null, got integer');
  });

  test('a long list of problems is cut at ten', () => {
    const body = searchBody();
    body.anonymousPassengerSpecifications = Array.from({ length: 12 }, () => ({ externalRef: 'x', type: 'PERSON', bogus: 1 }));
    const check = checkRequestBody('POST', `${BASE}/offers`, body, '3.8.0');
    expect(check.message).toContain('; and 2 more');
  });
});

describe('#736 a request wrong on purpose is said to be', () => {
  const vars = (v) => (name) => v[name];

  test('the passenger sweep, the purchaser sweep and the empty passenger list', () => {
    const pax = { id: 'P1', externalRef: '00001', type: 'PERSON', gender: 'ZZZ' };
    const sweep = checkRequestBody('PATCH', `${BASE}/bookings/B1/passengers/P1`, pax, '3.8.0',
      vars({ requestedInformationProbe: 'invalid' }));
    expect(sweep).toMatchObject({ ok: true, negative: 'passenger negative sweep' });
    expect(sweep.name).toBe(`${TAG} PATCH /bookings/{bookingId}/passengers/{passengerId} does not conform to OSDM 3.8.0 Passenger, on purpose (negative test: passenger negative sweep)`);

    const purchaser = checkRequestBody('POST', `${BASE}/bookings/B1/purchaser`, { detail: { lastName: 'P' } }, '3.8.0',
      vars({ bookingPurchaserMode: 'INVALID' }));
    expect(purchaser).toMatchObject({ ok: true, negative: 'purchaser negative sweep' });

    const empty = searchBody();
    empty.anonymousPassengerSpecifications = [];
    expect(checkRequestBody('POST', `${BASE}/offers`, empty, '3.8.0', vars({ emptyPassengersExpectRejection: 'true' })))
      .toMatchObject({ ok: true, negative: 'empty passenger list' });
  });

  test('the flag of another step does not excuse a request', () => {
    const empty = searchBody();
    empty.anonymousPassengerSpecifications = [];
    expect(checkRequestBody('POST', `${BASE}/offers`, empty, '3.8.0', vars({ requestedInformationProbe: 'invalid' })).ok).toBe(false);
    expect(negativeTestOf({ method: 'POST', path: '/bookings' }, vars({ emptyPassengersExpectRejection: 'true' }))).toBeNull();
  });

  test('a conformant request under a negative test is an ordinary pass', () => {
    const pax = { id: 'P1', externalRef: '00001', type: 'PERSON', gender: 'X' };
    expect(checkRequestBody('PATCH', `${BASE}/bookings/B1/passengers/P1`, pax, '3.8.0', vars({ requestedInformationProbe: 'invalid' })))
      .toEqual({ name: `${TAG} PATCH /bookings/{bookingId}/passengers/{passengerId} conforms to OSDM 3.8.0 Passenger`, ok: true, message: '' });
  });
});

describe('#736 the glue the global after-response calls', () => {
  const fakeReq = (method, url, body) => ({ getMethod: () => method, getUrl: () => url, getBody: () => body });

  beforeEach(() => {
    global.bru = { getEnvVar: (n) => ({ osdmVersion: '3.8.0', complianceVersion: '3.8.0' })[n] };
  });
  afterEach(() => { delete global.bru; });

  test('records one check with bruTest, failing with the message', () => {
    const recorded = [];
    const bruTest = (name, fn) => { try { fn(); recorded.push([name, 'pass']); } catch (e) { recorded.push([name, e.message]); } };
    const body = bookingBody();
    body.offers[0].placeSelections = [{ reservationId: 'RES-1', tripLegCoverage: {} }];
    recordRequestConformance(fakeReq('POST', `${BASE}/bookings`, body), bruTest);
    expect(recorded).toHaveLength(1);
    expect(recorded[0][0]).toMatch(/^\[OSCAR request\] POST \/bookings conforms to OSDM 3\.8\.0 BookingRequest$/);
    expect(recorded[0][1]).toContain('tripLegCoverage: missing tripId, legId');
  });

  test('records nothing for a GET, and never throws', () => {
    const recorded = [];
    expect(recordRequestConformance(fakeReq('GET', `${BASE}/bookings/B1`, ''), (n) => recorded.push(n))).toBeNull();
    expect(recorded).toEqual([]);
    expect(recordRequestConformance({ getMethod: () => { throw new Error('boom'); } }, () => {})).toBeNull();
  });
});

describe('#736 the bundled schemas are the generator\'s output', () => {
  test.each(['3.8.0', '3.9.0', '3.10.0', '3.11.0', '3.12.0'])('the %s set is what the repository\'s OSDM file gives', (v) => {
    const { forVersion } = require('../../scripts/generate-osdm-request-schemas.js');
    const yaml = require('js-yaml');
    const spec = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Test_Coverage',
      'OSDM_reference', `OSDM-online-api-v${v}.yml`), 'utf8'));
    expect(forVersion(spec)).toEqual(requestSchemas[v]);
  });

  test('every reference resolves, in every version', () => {
    for (const [v, set] of Object.entries(requestSchemas)) {
      const refs = JSON.stringify(set).match(/"\$ref":"[^"]+"/g) || [];
      for (const r of refs) expect([v, r, !!set.schemas[r.slice(8, -1)]]).toEqual([v, r, true]);
      for (const op of set.operations) expect(set.schemas[op.schema]).toBeDefined();
    }
  });
});
