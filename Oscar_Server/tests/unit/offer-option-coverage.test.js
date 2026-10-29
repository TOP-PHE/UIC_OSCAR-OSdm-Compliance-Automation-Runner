// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #995: the offer request options' results in the coverage by capability
 * (utils/offerOptionCoverage.js), read from a report the collection writes
 * and the server reads back.
 */

const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const { reportLines } = require(path.join(LIB, 'offerOptions.js'));
const { RESULTS, reportOf } = require('../../src/utils/offerOptionReport');
const C = require('../../src/utils/offerOptionCoverage');

const written = {
  version: '3.8.0', budget: 30, used: 12, seed: 7,
  mandatory: { ok: true, message: '3 offer(s)' },
  options: [
    { option: 'offerSearchCriteria.currency', value: 'EUR', source: 'declared', declared: true, status: 200, result: 'honoured', message: '3 offer(s) keep to it' },
    { option: 'offerSearchCriteria.flexibilities', value: ['FULL_FLEXIBLE'], source: 'declared', declared: true, status: 200, result: 'ignored-said', message: 'said ignored: flexibilities' },
    { option: 'passenger.cards', value: [{ code: 'X1' }], source: 'invalid', status: 400, result: 'invalid-said', message: 'CARD_UNKNOWN' },
    { option: 'promotionCodes', value: [{ code: 'Y' }], source: 'invalid', status: 200, result: 'invalid-silent', message: 'taken' },
    { option: 'embed', source: 'default', status: 501, result: 'not-implemented', message: 'HTTP 501' },
    { option: 'tripSearchCriteria.arrivalTime', source: 'default', status: 200, result: 'accepted', message: '3 offer(s)' },
    { option: 'offerSearchCriteria.productSelections', source: 'default', status: 200, result: 'no-offer-silent', message: 'no offer' },
    { option: 'passenger.gender', result: 'not-reached', message: 'the request budget ran out' },
  ],
  combinations: [
    { options: ['offerSearchCriteria.currency', 'tripSearchCriteria.arrivalTime'], status: 200, result: 'honoured', message: '3 offer(s) keep to it' },
    { options: ['offerSearchCriteria.currency', 'embed'], status: 400, result: 'refused', message: 'COMBINATION' },
    { options: ['tripSearchCriteria.arrivalTime', 'embed'], status: 200, result: 'no-offer-said', message: 'NO_OFFER' },
  ],
  all: { options: ['offerSearchCriteria.currency', 'tripSearchCriteria.arrivalTime'], status: 200, result: 'accepted', message: '3 offer(s)' },
};
const report = reportOf(reportLines(written));
const run = (id, at) => ({ id, completed_at: at, queued_at: '2026-10-01 00:00:00' });

describe('the offer request options in the coverage (#995)', () => {
  test('the words are the page\'s, for every result the report can hold', () => {
    expect(Object.keys(C.RESULT_TEXT).sort()).toEqual([...RESULTS].sort());
    expect(C.GROUPS.flatMap(([, , results]) => results).sort()).toEqual([...RESULTS].sort());
  });

  test('a combination is refused for a 4xx or 5xx, without offer, answered, or not sent', () => {
    expect([400, 404, 501, 503, 599].map((status) => C.combinationState({ status, result: 'refused' }))).toEqual(Array(5).fill('refused'));
    expect(C.combinationState({ status: 200, result: 'no-offer-silent' })).toBe('no-offer');
    expect(C.combinationState({ status: 200, result: 'ignored-silent' })).toBe('answered');
    expect([C.combinationState({ status: 0, result: 'error' }), C.combinationState({ status: 302 }), C.combinationState(null)]).toEqual(['not-sent', 'not-sent', 'not-sent']);
  });

  test('one entry per run: the mandatory request, each parameter in words, the combinations, the summary', () => {
    const [e] = C.offerOptionCoverageOf([{ code: 'OTST_OFFER_OPTION_DISCOVERY', run: run('r1', '2026-10-26 20:22:07'), report }]);
    expect(e).toMatchObject({ code: 'OTST_OFFER_OPTION_DISCOVERY', runId: 'r1', at: '2026-10-26 20:22:07', version: '3.8.0', budget: 30, used: 12,
      mandatory: { ok: true, message: '3 offer(s)' } });
    expect(e.parameters).toHaveLength(8);
    expect(e.parameters[1]).toEqual({ option: 'offerSearchCriteria.flexibilities', value: '["FULL_FLEXIBLE"]', source: 'declared', declared: true, status: 200,
      result: 'ignored-said', resultText: 'Ignored, said', message: 'said ignored: flexibilities' });
    // A parameter sent without a value names no source in the log line.
    expect(e.parameters[4]).toEqual({ option: 'embed', status: 501, result: 'not-implemented', resultText: 'Not implemented', message: 'HTTP 501' });
    expect(e.parameters[7]).toMatchObject({ option: 'passenger.gender', status: null, resultText: 'Not reached (request budget)' });
    expect(e.combinations.map((c) => c.state)).toEqual(['answered', 'refused', 'no-offer']);
    expect(e.all).toEqual({ count: 2, status: 200, result: 'accepted', state: 'answered', message: '3 offer(s)' });
    expect(e.text).toBe('mandatory parameters only: answered · 8 parameter(s): 2 supported, 1 made-up value refused or said, '
      + '1 made-up value taken without a word, 1 ignored, 1 no offer, 1 refused or not implemented, 1 not tested'
      + ' · 3 combination(s): 1 answered, 1 without offer, 1 refused · every supported parameter at once: answered');
  });

  test('the latest run first; a run without report, or nothing at all, gives nothing', () => {
    const list = C.offerOptionCoverageOf([
      { code: 'B', run: run('r1', '2026-10-20 10:00:00'), report },
      { code: 'A', run: run('r2', '2026-10-26 10:00:00'), report },
      { code: 'C', run: run('r3', '2026-10-27 10:00:00') },
      { code: 'D', report },
      null,
    ]);
    expect(list.map((e) => e.code)).toEqual(['A', 'B']);
    expect([C.offerOptionCoverageOf(null), C.offerOptionCoverageOf([])]).toEqual([[], []]);
  });

  test('a report holding only the header says so; an unknown result counts as other', () => {
    const [bare] = C.offerOptionCoverageOf([{ code: 'X', run: run('r', null), report: { options: [{ option: 'a', result: 'strange' }], combinations: [] } }]);
    expect(bare).toMatchObject({ at: '2026-10-01 00:00:00', mandatory: null, all: null, text: '1 parameter(s): 1 other' });
    expect(bare.parameters[0].resultText).toBe('strange');
    const sent = C.summaryText({ ...C.summaryOf({ options: [], combinations: [{ status: 0 }], all: { status: 0 } }) });
    expect(sent).toBe('0 parameter(s) · 1 combination(s): 0 answered, 0 without offer, 0 refused, 1 not sent · every supported parameter at once: not sent');
  });

  test('the latest run\'s summary goes on the capability\'s row, and the list with the coverage', () => {
    const entries = C.offerOptionCoverageOf([{ code: 'A', run: run('r', '2026-10-26 10:00:00'), report }]);
    const byCapability = { capabilities: [{ id: 'offers.search' }, { id: 'offers.requestOptions', label: 'L' }], points: [] };
    const out = C.withOfferOptions(byCapability, entries);
    expect(out.capabilities[0]).toEqual({ id: 'offers.search' });
    expect(out.capabilities[1]).toEqual({ id: 'offers.requestOptions', label: 'L', parameters: entries[0].text });
    expect(out.offerOptions).toBe(entries);
    expect(byCapability.capabilities[1].parameters).toBeUndefined();
    expect(C.withOfferOptions(byCapability, [])).toBe(byCapability);
    expect(C.withOfferOptions(null, entries)).toBeNull();
  });

  test('texts are cut, and a long report keeps its first 400 parameters', () => {
    const many = { options: Array.from({ length: 450 }, (_, i) => ({ option: `o${i}`, result: 'accepted', message: 'm'.repeat(900) })), combinations: [] };
    const [e] = C.offerOptionCoverageOf([{ code: 'L', run: run('r', 'd'), report: many }]);
    expect(e.parameters).toHaveLength(400);
    expect(e.parameters[0].message).toHaveLength(500);
    expect(e.summary.parameters).toBe(450);
  });
});

// #1053: the row of each distribution mode carries the same line.
describe('withOfferOptions on a report split by distribution mode (#1053)', () => {
  const { withOfferOptions: withOptions } = require('../../src/utils/offerOptionCoverage');
  test('every requestOptions row gets the line; a report without the split gets no byMode', () => {
    const row = { id: 'offers.requestOptions' };
    const out = withOptions({ capabilities: [row], byMode: [{ mode: 'PRODUCT', capabilities: [row, { id: 'sale' }] }, { mode: 'FARE', capabilities: [] }] }, [{ text: 'line' }]);
    expect(out.byMode[0].capabilities).toEqual([{ id: 'offers.requestOptions', parameters: 'line' }, { id: 'sale' }]);
    expect(out.capabilities[0].parameters).toBe('line');
    expect(withOptions({ capabilities: [row] }, [{ text: 'line' }]).byMode).toBeUndefined();
  });
});
