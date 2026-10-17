// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-catalogue.test.js — the scenario catalogue (#612): the file in the
 * collection is sound against the simulator's data file, the data file it
 * makes passes the upload's schema check, and the golden rule names what a
 * framework lacks.
 */

const path = require('node:path');

// The real schema, not the stub another test file writes into the shared dummy collection.
process.env.COLLECTION_PATH = path.resolve(__dirname, '../../../Bruno_Collection');
const {
  catalogueProblems, catalogueDatafile, catalogueFor, requirementsOf, missingFor, salesFlowsOf,
  dataNeedsOf, needsText, simulatorFacts,
} = require('../../src/utils/scenarioCatalogue');
const { schemaProblems, loadDatafileSchema } = require('../../src/utils/datafileSchema');

const DATA = path.resolve(__dirname, '../../../Bruno_Collection/data_base');
const catalogue = require(path.join(DATA, 'scenario_catalogue.json'));
const simulator = require(path.join(DATA, 'simulator_datafile.json'));
// The reference scenarios' sources are the simulator's 3.8 ones, answered by gamma.
const gamma = require(path.resolve(__dirname, '../../../OSDM_Simulator/providers/gamma.json'));

describe('the catalogue file', () => {
  test('is sound against the simulator data file', () => {
    expect(catalogueProblems(catalogue, simulator)).toEqual([]);
  });

  test('makes a data file the upload accepts, with each reference scenario and only the entries they use', () => {
    const df = catalogueDatafile(catalogue, simulator);
    expect(df.scenarios.map(s => s.code)).toEqual(catalogue.entries.map(e => e.code));
    expect(schemaProblems(df, loadDatafileSchema()).problems).toEqual([]);
    for (const [field, list] of [['tripRequirementId', 'tripRequirements'], ['passengersListId', 'passengersList']]) {
      const used = new Set(df.scenarios.map(s => s[field]));
      expect(df[list].map(e => e.id).sort()).toEqual([...used].sort());
    }
    for (const s of df.scenarios) {
      expect(s.description).toBe(catalogue.entries.find(e => e.code === s.code).purpose);
      expect(s.code.startsWith('SIM_')).toBe(false);
      expect(s.created_by).toBeUndefined();
    }
  });

  test('has no provider-specific or deliberately wrong scenario, and waits long enough on a real provider', () => {
    for (const e of catalogue.entries) {
      expect(e.source).not.toMatch(/^SIM_(WRONG|VARIANT|SALE_CARD|SALE_PRODUCT|GROUP)_/);
      if (e.code.startsWith('NHF_EXPIRED_')) expect(Object.values(e.set)).toEqual([40]);
    }
  });

  test('every reference scenario is a happy flow or a negative probe of its own kind', () => {
    const kinds = catalogueFor(catalogue, simulator, {}).map(e => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['OTST', 'NHF']));
  });
});

describe('problems a catalogue can have', () => {
  const sim = { scenarios: [{ code: 'SIM_A_38', scenarioType: 'SALE' }, { code: 'SIM_WRONG_X_38' }] };
  const entry = (over) => ({ code: 'OTST_A_ONE', source: 'SIM_A_38', purpose: 'A sale for one person.', checks: 10, needs: {}, ...over });
  test.each([
    [[], /no entry/],
    [[entry({ code: 'A_ONE' })], /OTST_/],
    [[entry(), entry()], /appears twice/],
    [[entry({ source: 'SIM_NONE' })], /not a scenario/],
    [[entry({ purpose: '' })], /purpose/],
    [[entry({ checks: 0 })], /checks/],
    [[entry({ set: { tripRequirementId: 2 } })], /may change/],
    [[entry({ source: 'SIM_WRONG_X_38' })], /deliberately wrong/],
    [[entry({ needs: undefined })], /needs is missing/],
    [[entry({ needs: { train: 'SC' } })], /needs\.train is not a known need/],
  ])('%#', (entries, problem) => {
    expect(catalogueProblems({ entries }, sim).join('; ')).toMatch(problem);
    expect(() => catalogueDatafile({ entries }, sim)).toThrow(/not valid/);
  });
});

describe('requirements and the golden rule', () => {
  test('sales flows by type and partial refund', () => {
    expect(salesFlowsOf({ scenarioType: 'SALE' })).toEqual(['SALE']);
    expect(salesFlowsOf({ scenarioType: 'REFUND' })).toEqual(['SALE', 'REFUND_FULL']);
    expect(salesFlowsOf({ scenarioType: 'REFUND', partialRefundByFulfillment: 'on' })).toEqual(['SALE', 'REFUND_PARTIAL']);
    expect(salesFlowsOf({ scenarioType: 'EXCHANGE' })).toEqual(['SALE', 'EXCHANGE_FULL']);
  });

  test('a combined return needs its model and OSDM 3.7; passenger types other than PERSON must be declared', () => {
    const df = { passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }, { type: 'YOUTH' }] }] };
    const r = requirementsOf({ scenarioType: 'SALE', passengersListId: 1, offerSearchCriteria: { returnOffsetDays: 2, returnModel: 'COMBINED' } }, df);
    expect(r).toEqual({ salesFlows: ['SALE'], partialRefundScopes: [], returnModel: 'COMBINED', minOsdmVersion: '3.7', passengerTypes: ['YOUTH'],
      offerRequest: { form: 'SEARCH', convertible: false }, placeSelectionFlow: null, purchaserAfterBooking: false });
    expect(missingFor(r, { salesFlows: ['SALE'], returnModels: ['SEPARATE'], osdmVersion: '3.6.0', passengerTypes: ['ADULT'] }))
      .toEqual(['return model COMBINED', 'OSDM 3.7 or later', 'passenger type YOUTH']);
    expect(missingFor(r, { config: { salesFlows: ['SALE'], returnModels: ['COMBINED'], osdmVersion: '3.8.0', passengerTypes: ['YOUTH'] } })).toEqual([]);
    // A framework from before returnModels does not restrict the model.
    expect(missingFor(r, { salesFlows: ['SALE'], osdmVersion: '3.8', passengerTypes: ['YOUTH'] })).toEqual([]);
    expect(missingFor({ salesFlows: ['SALE', 'REFUND_FULL'], returnModel: null, minOsdmVersion: null, passengerTypes: [] }, null))
      .toEqual(['sales flow SALE', 'sales flow REFUND_FULL']);
  });

  test('#713: a partial refund needs its scope declared, when the framework lists scopes', () => {
    const df = { passengersList: [{ id: 1, passengers: [{ type: 'ADULT' }] }] };
    const byPax = requirementsOf({ scenarioType: 'REFUND', passengersListId: 1, partialRefundByPax: 'on' }, df);
    expect(byPax.salesFlows).toEqual(['SALE', 'REFUND_PARTIAL']);
    expect(byPax.partialRefundScopes).toEqual(['PASSENGER']);
    const fw = { salesFlows: ['SALE', 'REFUND_PARTIAL'], passengerTypes: ['ADULT'] };
    // No list: every scope (frameworks from before 1.11.271).
    expect(missingFor(byPax, fw)).toEqual([]);
    expect(missingFor(byPax, { ...fw, partialRefundScopes: ['FULFILLMENT'] })).toEqual(['partial refund by passenger']);
    expect(missingFor(byPax, { ...fw, partialRefundScopes: ['FULFILLMENT', 'PASSENGER'] })).toEqual([]);
    const both = requirementsOf({ scenarioType: 'REFUND', passengersListId: 1, partialRefundByLeg: 'on', partialRefundByFulfillment: true }, df);
    expect(missingFor(both, { ...fw, partialRefundScopes: [] })).toEqual(['partial refund by fulfillment', 'partial refund by leg']);
    // A scope flag on a sale or an exchange is not a partial refund.
    expect(requirementsOf({ scenarioType: 'EXCHANGE', passengersListId: 1, partialRefundByLeg: 'on' }, df).partialRefundScopes).toEqual([]);
  });

  test('#713: the catalogue\'s partial refunds by passenger and by leg are refused to a fulfillment-only provider', () => {
    const fw = {
      osdmVersion: '3.8.0', salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL'], partialRefundScopes: ['FULFILLMENT'],
      passengerTypes: ['ADULT', 'CHILD', 'YOUTH', 'SENIOR', 'YOUNG_CHILD'], returnModels: ['SEPARATE', 'COMBINED'],
    };
    const listed = catalogueFor(catalogue, simulator, fw);
    const scopeMissing = listed.filter((e) => e.missing.some((m) => m.startsWith('partial refund by')));
    expect(scopeMissing.map((e) => e.code)).toEqual(expect.arrayContaining(['OTST_REFUND_PARTIAL_PASSENGER_2ADT', 'OTST_REFUND_PARTIAL_LEG_1ADT']));
    for (const e of scopeMissing) expect(e.requirements.partialRefundScopes).not.toContain('FULFILLMENT');
    const byFulfillment = listed.filter((e) => e.requirements.partialRefundScopes.includes('FULFILLMENT'));
    expect(byFulfillment.length).toBeGreaterThan(0);
    for (const e of byFulfillment) expect(e.missing.filter((m) => m.startsWith('partial refund by'))).toEqual([]);
  });
});

describe('#681 what a reference scenario needs from the provider\'s data', () => {
  const facts = simulatorFacts(gamma);

  test('every entry\'s needs are those of its source scenario on the simulator', () => {
    for (const e of catalogue.entries) {
      const source = simulator.scenarios.find(s => s.code === e.source);
      expect([e.code, e.needs]).toEqual([e.code, dataNeedsOf(source, simulator, facts)]);
    }
  });

  const df = {
    tripRequirements: [
      { id: 1, tripType: 'SEARCH', trip: { origin: 'urn:A', destination: 'urn:B' } },
      { id: 2, tripType: 'SPECIFICATION', legs: [{ productCategoryShortName: 'SC' }, { productCategoryShortName: 'EC' }] },
      { id: 3, tripType: 'SEARCH', trip: { origin: 'urn:RI', destination: 'urn:B' } },
    ],
    passengersList: [
      { id: 1, passengers: [{ type: 'PERSON' }] },
      { id: 2, passengers: [{ type: 'PERSON', reductionCards: [{ code: 'C' }] }, { type: 'PERSON' }] },
    ],
  };
  const f = { reservations: { SC: 'MANDATORY', EC: 'OPTIONAL' }, requestedInformationFrom: 'urn:RI' };
  const sc = (over) => ({ scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, ...over });

  test('a plain sale needs a searched trip and its passengers, nothing else', () => {
    expect(dataNeedsOf(sc(), df, f)).toEqual({ trip: 'SEARCH', passengers: 1 });
  });

  test('the reservation exercised, not every one the trip carries', () => {
    expect(dataNeedsOf(sc({ tripRequirementId: 2 }), df, f)).toEqual({ trip: 'SPECIFICATION', legs: 2, reservations: ['MANDATORY'], passengers: 1 });
    expect(dataNeedsOf(sc({ tripRequirementId: 2, reservationBookingForm: 'PLACE_SELECTION' }), df, f).reservations).toEqual(['OPTIONAL']);
    expect(dataNeedsOf(sc({ reservationBookingForm: 'PLACE_SELECTION' }), df, f).reservations).toBeUndefined();
  });

  test('the tariff an after-sale needs; an overrule code refunds any tariff and is the provider\'s own value', () => {
    expect(dataNeedsOf(sc({ scenarioType: 'REFUND' }), df, f).tariff).toBe('REFUNDABLE');
    expect(dataNeedsOf(sc({ scenarioType: 'EXCHANGE' }), df, f).tariff).toBe('EXCHANGEABLE');
    expect(dataNeedsOf(sc({ desiredFlexibility: 'NON_FLEXIBLE' }), df, f).tariff).toBe('NON_FLEXIBLE');
    const overrule = dataNeedsOf(sc({ scenarioType: 'REFUND', overruleCode: 'TECHNICAL_FAILURE' }), df, f);
    expect(overrule.tariff).toBeUndefined();
    expect(overrule.providerValues).toEqual(['overruleCode']);
    expect(dataNeedsOf(sc({ scenarioType: 'REFUND', overruleCode: 'CODE_DOES_NOT_EXIST' }), df, f).tariff).toBe('REFUNDABLE');
  });

  test('return model, classes per leg, cards, product, requested information, deadlines', () => {
    const n = dataNeedsOf(sc({
      passengersListId: 2, tripRequirementId: 3, legTravelClasses: ['FIRST', 'SECOND'], expectedProduct: 'P1',
      offerSearchCriteria: { returnOffsetDays: 2, returnModel: 'COMBINED' }, expiredOfferTest: 'on', expiredBookingTest: 'off',
    }), df, f);
    expect(n).toEqual({
      trip: 'SEARCH', return: 'COMBINED', legClasses: ['FIRST', 'SECOND'], passengers: 2, reductionCards: true,
      providerValues: ['expectedProduct'], requestedInformation: true, expiry: ['OFFER'],
    });
    expect(dataNeedsOf(sc({ requestedInformationProbe: 'omit' }), df, f).requestedInformation).toBe(true);
  });

  test('said to the person copying, and given with each entry of the catalogue', () => {
    expect(needsText({ trip: 'SPECIFICATION', legs: 2, reservations: ['MANDATORY'], tariff: 'REFUNDABLE', passengers: 2, providerValues: ['overruleCode'], expiry: ['REFUND_OFFER'] }))
      .toEqual(['a journey of 2 legs', 'a train with a mandatory seat reservation', 'a refundable tariff', '2 passengers',
        'the provider\'s own overruleCode', 'waits for the provider\'s deadline: refund offer']);
    expect(needsText(undefined)).toEqual([]);
    const listed = catalogueFor(catalogue, simulator, {});
    for (const e of listed) {
      expect(e.needs).toEqual(catalogue.entries.find(x => x.code === e.code).needs);
      if (!e.limit) expect(e.needsText).toEqual(needsText(e.needs));
    }
  });
});

describe('#699 the passenger limit entries', () => {
  const limits = catalogue.entries.filter(e => ['MAX_PASSENGERS', 'OVER_MAX_PASSENGERS'].includes(e.limit));

  test('three entries: the maximum, one over it, a third of them refunded', () => {
    expect(limits.map(e => [e.code, e.limit])).toEqual([
      ['OTST_SALE_MAX_PASSENGERS', 'MAX_PASSENGERS'],
      ['OTST_REFUND_PARTIAL_PASSENGERS_THIRD', 'MAX_PASSENGERS'],
      ['NHF_SALE_TOO_MANY_PASSENGERS', 'OVER_MAX_PASSENGERS'],
    ]);
  });

  test('cannot be copied without a declared maximum; can with one; others are not affected', () => {
    const fw = { salesFlows: ['SALE', 'REFUND_PARTIAL'], passengerTypes: ['ADULT'] };
    const without = catalogueFor(catalogue, simulator, fw);
    const withMax = catalogueFor(catalogue, simulator, { ...fw, maxPassengers: 9 });
    for (const e of limits) {
      expect(without.find(x => x.code === e.code).missing).toContain('the maximum number of passengers (Passenger Types)');
      expect(withMax.find(x => x.code === e.code).missing).toEqual([]);
    }
    const other = without.find(x => x.code === 'OTST_SALE_ONE_WAY_1ADT');
    expect(other.missing).toEqual([]);
    expect(catalogueFor(catalogue, simulator, { ...fw, config: undefined, maxPassengers: 0 })
      .find(x => x.code === 'OTST_SALE_MAX_PASSENGERS').missing).toContain('the maximum number of passengers (Passenger Types)');
  });

  test('say the framework\'s number, not the simulator\'s', () => {
    const listed = catalogueFor(catalogue, simulator, {});
    expect(listed.find(x => x.code === 'NHF_SALE_TOO_MANY_PASSENGERS').needsText[0])
      .toBe('one passenger more than the maximum the Test Framework declares');
    expect(listed.find(x => x.code === 'OTST_SALE_MAX_PASSENGERS').needsText)
      .toEqual(['the maximum number of passengers the Test Framework declares']);
  });

  test('an unknown limit is a problem of the file', () => {
    const broken = structuredClone(catalogue);
    broken.entries[0].limit = 'MANY';
    expect(catalogueProblems(broken, simulator)).toEqual([expect.stringContaining('limit "MANY"')]);
  });
});

describe('#704 the departure-date entries', () => {
  const horizon = catalogue.entries.filter(e => ['SALES_HORIZON', 'OVER_SALES_HORIZON'].includes(e.limit));
  const fw = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };

  test('the last day of the horizon, the day after, and yesterday', () => {
    expect(horizon.map(e => [e.code, e.limit])).toEqual([
      ['OTST_SALE_AT_SALES_HORIZON', 'SALES_HORIZON'],
      ['NHF_SALE_BEYOND_SALES_HORIZON', 'OVER_SALES_HORIZON'],
    ]);
    expect(catalogue.entries.find(e => e.code === 'NHF_SALE_DEPARTURE_IN_PAST').limit).toBeUndefined();
  });

  test('a horizon entry cannot be copied without a declared horizon; can with one; the past one always can', () => {
    const without = catalogueFor(catalogue, simulator, fw);
    const withHorizon = catalogueFor(catalogue, simulator, { ...fw, salesHorizonDays: 60 });
    for (const e of horizon) {
      expect(without.find(x => x.code === e.code).missing).toEqual(['the sales horizon (Tariff Flexibility)']);
      expect(withHorizon.find(x => x.code === e.code).missing).toEqual([]);
    }
    expect(without.find(x => x.code === 'NHF_SALE_DEPARTURE_IN_PAST').missing).toEqual([]);
    for (const bad of [0, 1001, 2.5, '60']) {
      expect(catalogueFor(catalogue, simulator, { ...fw, salesHorizonDays: bad })
        .find(x => x.code === 'OTST_SALE_AT_SALES_HORIZON').missing).toEqual(['the sales horizon (Tariff Flexibility)']);
    }
  });

  test('say the day of the framework\'s horizon', () => {
    const listed = catalogueFor(catalogue, simulator, {});
    expect(listed.find(x => x.code === 'OTST_SALE_AT_SALES_HORIZON').needsText[0])
      .toBe('a departure on the last day of the sales horizon the Test Framework declares');
    expect(listed.find(x => x.code === 'NHF_SALE_BEYOND_SALES_HORIZON').needsText[0])
      .toBe('a departure on the day after the last day of the sales horizon the Test Framework declares');
  });
});

describe('#705 the age entry', () => {
  const fw = { salesFlows: ['SALE'], passengerTypes: ['ADULT', 'CHILD'], passengerAgeRanges: { ADULT: { min: 26, max: 99 }, CHILD: { min: 4, max: 15 } } };
  const ageEntry = (config) => catalogueFor(catalogue, simulator, config).find(x => x.code === 'OTST_SALE_AGE_LIMITS');

  test('needs CHILD and ADULT declared with whole-year ranges', () => {
    expect(catalogue.entries.find(e => e.code === 'OTST_SALE_AGE_LIMITS').limit).toBe('AGE_RANGES');
    expect(ageEntry(fw).missing).toEqual([]);
    const missing = ['passenger types CHILD and ADULT with their age ranges (Passenger Types)'];
    expect(ageEntry({ ...fw, passengerTypes: ['ADULT'] }).missing).toEqual(missing);
    expect(ageEntry({ ...fw, passengerAgeRanges: { ADULT: fw.passengerAgeRanges.ADULT } }).missing).toEqual(missing);
    expect(ageEntry({ ...fw, passengerAgeRanges: { ...fw.passengerAgeRanges, CHILD: { min: 9, max: 4 } } }).missing).toEqual(missing);
    expect(ageEntry({ config: fw }).missing).toEqual([]);
    expect(ageEntry(fw).needsText[0]).toMatch(/^a child on the last day of the CHILD age range/);
  });
});

describe('#700 the after-sale refusals', () => {
  test('three negative entries; the exchange of a refunded ticket needs the exchange declared', () => {
    const listed = catalogueFor(catalogue, simulator, { salesFlows: ['SALE', 'REFUND_FULL'], passengerTypes: ['ADULT'] });
    const byCode = Object.fromEntries(listed.map(e => [e.code, e]));
    expect(byCode.NHF_CONFIRM_TWICE.missing).toEqual([]);
    expect(byCode.NHF_REFUND_TWICE.missing).toEqual([]);
    expect(byCode.NHF_EXCHANGE_REFUNDED.missing).toEqual(['sales flow EXCHANGE_FULL']);
    expect(byCode.NHF_EXCHANGE_REFUNDED.requirements.salesFlows).toEqual(['SALE', 'REFUND_FULL', 'EXCHANGE_FULL']);
    expect(salesFlowsOf({ scenarioType: 'EXCHANGE', exchangeRefundedProbe: 'on' })).toEqual(['SALE', 'EXCHANGE_FULL']);
  });
});
