'use strict';

/**
 * bruno-transportables.test.js — a passenger that is not a person (a
 * bicycle, a dog…) is sent with its reference, type and cards only, and the
 * passenger steps 03 and 04 leave it out; an offer request for fare parts
 * only asks no fulfilment option (#1045, a fare expert's review of the
 * simulator's bicycle scenario).
 */

const path = require('path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
let store = {};
global.bru = {
  getEnvVar: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : undefined),
  setEnvVar: (k, v) => { store[k] = v; },
  deleteEnvVar: (k) => { delete store[k]; },
};

const T = require(path.join(LIB, 'transportables.js'));
const { passengerSpecsOf } = require(path.join(LIB, 'scenarioParser.js'));
const rb = require(path.join(LIB, 'requestsBuilder.js'));
const { asksFaresOnly } = require(path.join(LIB, 'fares.js'));
const steps = require(path.join(LIB, 'passengerSteps.js'));
const displays = require(path.join(LIB, 'displays.js'));

let logs = [];
beforeEach(() => {
  store = {};
  logs = [];
  global.validationLogger = (line) => { logs.push(line); };
});

const BICYCLE = { reference: '00002', type: 'BICYCLE', dateOfBirth: '1985-06-01', firstName: 'Sam', lastName: 'Example', phoneNumber: '+33199000003', email: 'sam.example@example.org' };
const PERSON = { reference: '00001', type: 'PERSON', dateOfBirth: '1985-06-01', gender: 'X', firstName: 'Sam', lastName: 'Example', phoneNumber: '+33199000003', email: 'sam.example@example.org' };

describe('transportables.js', () => {
  test('OSDM\'s transportable types, in either spelling, are not persons', () => {
    for (const type of ['BICYCLE', 'bicycle', ' DOG ', 'ACCOMP_DOG', 'COMPANION_DOG', 'PET', 'LUGGAGE', 'PRAM', 'CAR', 'SPECIAL_VEHICLE', 'MOTOCYCLE', 'MOTORCYCLE', 'TRAILER']) {
      expect([type, T.isTransportable(type)]).toEqual([type, true]);
    }
    for (const type of ['PERSON', 'ADULT', 'YOUTH', 'PRM', 'FAMILY_CHILD', 'WHEELCHAIR', '', null, undefined, 7]) {
      expect([type, T.isTransportable(type)]).toEqual([type, false]);
    }
  });

  test('the personal fields a passenger holds; a transportable\'s specification', () => {
    expect(T.personalFieldsOf(BICYCLE)).toEqual(['dateOfBirth', 'firstName', 'lastName', 'email', 'phoneNumber']);
    expect(T.personalFieldsOf({ type: 'BICYCLE', email: '', gender: null })).toEqual([]);
    expect(T.personalFieldsOf(null)).toEqual([]);
    expect(T.transportableSpec('00002', 'BICYCLE')).toEqual({ externalRef: '00002', type: 'BICYCLE' });
    expect(T.transportableSpec('00002', 'DOG', [{ code: 'C' }])).toEqual({ externalRef: '00002', type: 'DOG', cards: [{ code: 'C' }] });
    expect(T.transportableSpec('00002', 'DOG', [])).toEqual({ externalRef: '00002', type: 'DOG' });
  });

  test('the types of the passengers sent, from an array or JSON text', () => {
    expect(T.typesOf([{ type: 'PERSON' }, null, { type: 'BICYCLE' }])).toEqual(['PERSON', undefined, 'BICYCLE']);
    expect(T.typesOf('[{"type":"PERSON"},{"type":"BICYCLE"}]')).toEqual(['PERSON', 'BICYCLE']);
    expect(T.typesOf('not json')).toEqual([]);
    expect(T.typesOf('{"type":"PERSON"}')).toEqual([]);
    expect(T.typesOf(undefined)).toEqual([]);
  });
});

describe('the parser sends a transportable without a person\'s data', () => {
  test('a bicycle: reference and type only, and one INFO line naming what is left out', () => {
    const specs = passengerSpecsOf(BICYCLE, [], '3.8.0');
    expect(specs.offer).toEqual({ externalRef: '00002', type: 'BICYCLE' });
    expect(specs.booking).toEqual({ externalRef: '00002', type: 'BICYCLE' });
    expect(logs).toEqual(['[INFO] 🚲 Passenger 00002 is a BICYCLE, not a person: its dateOfBirth, firstName, lastName, email, phoneNumber from the data file are not sent.']);
  });

  test('a dog holding a card keeps it; nothing to say when the data gives it nothing', () => {
    const specs = passengerSpecsOf({ reference: '00003', type: 'DOG' }, [{ type: 'REDUCTION_CARD', code: 'C' }], '3.8.0');
    expect(specs.offer).toEqual({ externalRef: '00003', type: 'DOG', cards: [{ type: 'REDUCTION_CARD', code: 'C' }] });
    expect(logs).toEqual([]);
  });

  test('a person goes as before: date of birth, gender, the contact by version, cards', () => {
    const cards = [{ type: 'REDUCTION_CARD', code: 'C' }];
    const now = passengerSpecsOf(PERSON, cards, '3.8.0');
    expect(JSON.parse(JSON.stringify(now.offer))).toEqual({ externalRef: '00001', type: 'PERSON', dateOfBirth: '1985-06-01', gender: 'X', cards });
    expect(JSON.parse(JSON.stringify(now.booking))).toEqual({
      externalRef: '00001', type: 'PERSON', dateOfBirth: '1985-06-01', gender: 'X',
      detail: { firstName: 'Sam', lastName: 'Example', contact: { email: 'sam.example@example.org', phoneNumber: '+33199000003' } }, cards,
    });
    const old = passengerSpecsOf({ ...PERSON, gender: undefined }, [], '3.3.0');
    expect(JSON.parse(JSON.stringify(old.booking))).toEqual({
      externalRef: '00001', type: 'PERSON', dateOfBirth: '1985-06-01',
      detail: { firstName: 'Sam', lastName: 'Example', email: 'sam.example@example.org', phoneNumber: '+33199000003' },
    });
    expect(logs).toEqual([]);
  });
});

describe('an offer request for fare parts only asks no fulfilment option', () => {
  const offerEnv = (parts) => ({
    TripType: 'SEARCH',
    api_base: 'https://x',
    offerTripSearchCriteria: '{"departureTime":"2026-11-20T08:00:00"}',
    offerPassengerSpecifications: '[{"externalRef":"00001","type":"PERSON"}]',
    offerSearchCriteria: JSON.stringify({ requestedOfferParts: parts }),
    offerFulfillmentOptions: '[{"type":"ETICKET","media":"PDF_A4"}]',
  });

  test('asksFaresOnly: every part asked a FARE_ one', () => {
    expect(asksFaresOnly({ requestedOfferParts: ['FARE_ADMISSION', 'FARE_ANCILLARY'] })).toBe(true);
    expect(asksFaresOnly({ requestedOfferParts: ['FARE_RESERVATION'] })).toBe(true);
    expect(asksFaresOnly({ requestedOfferParts: ['ADMISSION', 'FARE_ADMISSION'] })).toBe(false);
    expect(asksFaresOnly({ requestedOfferParts: ['ALL'] })).toBe(false);
    expect(asksFaresOnly({ requestedOfferParts: [] })).toBe(false);
    expect(asksFaresOnly(null)).toBe(false);
  });

  test('fare parts only: none sent, one INFO line; products asked too, or nothing named: sent as before', () => {
    Object.assign(store, offerEnv(['FARE_ADMISSION', 'FARE_ANCILLARY']));
    rb.buildOfferCollectionRequest();
    expect(JSON.parse(store.OfferCollectionRequest)).not.toHaveProperty('requestedFulfillmentOptions');
    expect(logs).toContain('[INFO] [fares] Fare parts only asked: no requestedFulfillmentOptions (a fare fulfilment holds no document).');

    for (const parts of [['ADMISSION', 'FARE_ADMISSION'], undefined]) {
      store = {};
      Object.assign(store, offerEnv(parts));
      rb.buildOfferCollectionRequest();
      expect(JSON.parse(store.OfferCollectionRequest).requestedFulfillmentOptions).toEqual([{ type: 'ETICKET', media: 'PDF_A4' }]);
    }
  });
});

describe('the exchange request sends a transportable without a date of birth or gender', () => {
  test('the person keeps its updated date of birth and gender; the bicycle has neither', () => {
    Object.assign(store, {
      fulfillmentIds: '["F1"]',
      offerPassengerSpecifications: '[{"externalRef":"00001","type":"PERSON","dateOfBirth":"1985-06-01"},{"externalRef":"00002","type":"BICYCLE"}]',
      offerTripSearchCriteria: '{"departureTime":"x"}',
      offerSearchCriteria: '{"currency":"EUR"}',
      updateDateOfBirth_0: '1985-06-02', updateGender_0: 'X',
      updateDateOfBirth_1: '1985-06-01', updateGender_1: 'X',
    });
    rb.requestExchangeOffersBody();
    const body = JSON.parse(store.requestExchangeOffersBodyData);
    expect(body.anonymousPassengerSpecifications).toEqual([
      { externalRef: '00001', dateOfBirth: '1985-06-02', type: 'PERSON', gender: 'X' },
      { externalRef: '00002', type: 'BICYCLE' },
    ]);
  });
});

describe('steps 03 and 04 leave a transportable out', () => {
  test('nextPassengerWithId: the predicate\'s indices are passed over and listed apart', () => {
    const isBike = (i) => i === 1;
    expect(steps.nextPassengerWithId(['a', 'b', 'c'], 1, 3, isBike)).toEqual({ index: 2, skipped: [], transportables: [1] });
    expect(steps.nextPassengerWithId(['a', 'b'], 1, 2, isBike)).toEqual({ index: -1, skipped: [], transportables: [1] });
    expect(steps.nextPassengerWithId(['a', 'b'], 0, 2, isBike)).toEqual({ index: 0, skipped: [] });
  });

  test('the glue says it once, by type and externalRef, and goes to the next person', () => {
    Object.assign(store, {
      offerPassengerNumber: '3',
      passengerIdList: ['p1', 'p2', 'p3'],
      bookingPassengerReferences: '["00001","00002","00003"]',
      bookingPassengerSpecifications: [{ type: 'PERSON' }, { type: 'BICYCLE' }, { type: 'PERSON' }],
    });
    const spy = jest.spyOn(displays, 'validationLogger').mockImplementation((l) => { logs.push(l); });
    let picked;
    try {
      picked = [steps.choosePassenger('update', 1), steps.choosePassenger('read', 0)];
    } finally { spy.mockRestore(); }
    expect(picked).toEqual([2, 0]);
    expect(logs).toEqual(['[INFO] Passenger 1 (externalRef 00002) is a BICYCLE, not a person: no update (03. PATCH Multi Passenger).']);
  });
});
