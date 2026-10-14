'use strict';

/**
 * #735: a batch's failures grouped into candidate findings, matched against
 * the company's findings, with a category proposed by fixed rules.
 * The records below have the shapes a real provider's batch gave.
 */

const S = require('../../src/utils/findingSuggestions');

const rec = (over) => ({
  runId: 'run-1', at: '2026-10-14 17:11:35', scenarioCode: 'OTST_SALE_1ADT',
  step: '02. POST Create Booking', check: 'HTTP response status — expected 200, actual: 400',
  error: null, status: 400, problemCode: 'urn:uic:problem:MISSING_INFORMATION',
  problemTitle: 'Purchaser is missing', problemDetail: null, ...over,
});

describe('#735 normalisation', () => {
  test('values a run met are left out of a check text', () => {
    expect(S.checkText('Booking: holds the reservation on leg 7b75ec5a-758f-4ddb-9cb1-99b5e312bb96'))
      .toBe('Booking: holds the reservation on leg <id>');
    expect(S.checkText('Offer: passenger 00001 is priced as CHILD — applied: ADULT'))
      .toBe('Offer: passenger N is priced as CHILD — applied: ADULT');
    expect(S.checkText('Offer GAMMA-OFR-3e6b2eab040a9585 valid until 2026-10-14T18:00:00+02:00'))
      .toBe('Offer <id> valid until <instant>');
    expect(S.checkText('Name is "Paula"')).toBe('Name is "…"');
  });

  test('a long word without digits is kept', () => {
    expect(S.checkText('confirmableUntil is ignored after PREBOOKED')).toBe('confirmableUntil is ignored after PREBOOKED');
  });

  test('a step is read as the known-deviation engine reads it', () => {
    expect(S.stepKey('03-Refund/10. POST Refund Offers')).toBe('post refund offers');
    expect(S.stepKey('10. POST Refund Offers')).toBe('post refund offers');
    expect(S.stepKey('01b. POST Get Return Offer')).toBe('post get return offer');
  });

  test('a problem is read from an RFC 9457 body or from problems[]', () => {
    expect(S.problemOf({ code: 'urn:uic:problem:VALUE_NOT_SUPPORTED', title: 'Not supported' }))
      .toEqual({ code: 'VALUE_NOT_SUPPORTED', title: 'Not supported', detail: null });
    expect(S.problemOf('{"problems":[{"code":"PARAMETER_NOT_SUPPORTED","detail":"x"}]}'))
      .toEqual({ code: 'PARAMETER_NOT_SUPPORTED', title: null, detail: 'x' });
    expect(S.problemOf('<html>Request Rejected</html>')).toBeNull();
    expect(S.problemOf([{ version: '3.8.0' }])).toBeNull();
    expect(S.problemCodeOf('urn:x_vendor:err:10504')).toBe('10504');
  });
});

describe('#735 grouping', () => {
  test('the same failure in several scenarios is one group, with its scenarios and runs', () => {
    const groups = S.groupFailures([
      rec({ runId: 'r1', scenarioCode: 'A' }),
      rec({ runId: 'r2', scenarioCode: 'B' }),
      rec({ runId: 'r2', scenarioCode: 'B' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 3, scenarios: ['A', 'B'], status: 400, problemCode: 'MISSING_INFORMATION' });
    expect(groups[0].runs.map((r) => r.runId)).toEqual(['r1', 'r2']);
  });

  test('another status, another problem code or another check is another group', () => {
    const groups = S.groupFailures([
      rec(),
      rec({ status: 404, problemCode: 'RESOURCE_NOT_FOUND', check: 'HTTP response status — expected 200, actual: 404' }),
      rec({ problemCode: 'INVALID_INPUT' }),
      rec({ check: 'Booking: holds the reservation on leg aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }),
    ]);
    expect(groups).toHaveLength(4);
  });

  test('a problem in a 2xx answer is a warning, not part of the key', () => {
    const a = rec({ status: 200, problemCode: 'PARAMETER_NOT_SUPPORTED', check: 'Offer: passenger 00001 is priced as CHILD' });
    const b = rec({ status: 200, problemCode: null, check: 'Offer: passenger 00002 is priced as CHILD' });
    const groups = S.groupFailures([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ problemCode: null, warningCode: 'PARAMETER_NOT_SUPPORTED' });
  });

  test('the key does not depend on the folder or number of the step, nor on ids in the check', () => {
    expect(S.groupKeyOf(rec({ step: '03-Refund/10. POST Refund Offers' })))
      .toBe(S.groupKeyOf(rec({ step: '10. POST Refund Offers' })));
    expect(S.groupKeyOf(rec({ check: 'leg 7b75ec5a-758f-4ddb-9cb1-99b5e312bb96' })))
      .toBe(S.groupKeyOf(rec({ check: 'leg 45459c1a-cf12-40f9-9d2d-783c83becea8' })));
  });
});

describe('#735 the category a draft starts with', () => {
  const cat = (over) => S.proposeCategory(S.groupFailures([rec(over)])[0]).category;

  test('501, or a problem saying the operation is not supported → not_supported', () => {
    expect(cat({ status: 501, problemCode: 'VALUE_NOT_SUPPORTED' })).toBe('not_supported');
    expect(cat({ status: 403, problemCode: 'urn:uic:problem:OPERATION_NOT_PERMITTED' })).toBe('not_supported');
  });

  test('a parameter, a value or a limit the provider does not accept → spec_question', () => {
    expect(cat({ problemCode: 'PARAMETER_NOT_SUPPORTED' })).toBe('spec_question');
    expect(cat({ problemCode: 'BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE', step: '03. PATCH Multi Passenger' })).toBe('spec_question');
  });

  test('a success where a refusal was expected → provider_deviation', () => {
    expect(cat({ status: 200, problemCode: null, check: '🧪 Refund again [1 refunded fulfillment(s)]: provider rejects with a client error (4xx)' }))
      .toBe('provider_deviation');
    expect(cat({ status: 201, problemCode: null, scenarioCode: 'NHF_SOMETHING', check: 'Booking refused' })).toBe('provider_deviation');
  });

  test('OSCAR\'s own request → oscar_issue, whatever the status', () => {
    expect(cat({ status: 400, check: '[OSCAR request] POST /bookings conforms to OSDM 3.8.0 BookingRequest' })).toBe('oscar_issue');
  });

  test('anything else → open, with a reason', () => {
    const p = S.proposeCategory(S.groupFailures([rec()])[0]);
    expect(p).toEqual({ category: 'open', reason: 'No rule applies; to be read.' });
    expect(cat({ status: 200, problemCode: 'PARAMETER_NOT_SUPPORTED', check: 'Offer: passenger 1 is priced as CHILD' })).toBe('open');
  });
});

describe('#735 matching the company\'s findings', () => {
  const finding = (over) => ({
    id: 'F1', status: 'open', title: 'Purchaser required at booking', step: '02-Common Requests/02. POST Create Booking',
    scenarioCode: null, expectedStatus: null, observed: 'Answer 400 MISSING_INFORMATION', evidence: '', interpretation: '', ...over,
  });
  const group = (over) => S.groupFailures([rec(over)])[0];

  test('same step and problem code, or same step and error status → still seen', () => {
    expect(S.matchFinding(group(), [finding()], {})).toMatchObject({ strength: 'same', why: 'same step and problem code' });
    expect(S.matchFinding(group({ problemCode: 'X' }), [finding({ observed: '', expectedStatus: 400 })], {}))
      .toMatchObject({ strength: 'same', why: 'same step and HTTP status' });
  });

  test('a 2xx status matches nothing by itself', () => {
    const g = group({ status: 200, problemCode: null, check: 'Idempotency-Key: a new booking' });
    expect(S.matchFinding(g, [finding({ observed: '', expectedStatus: 200 })], {})).toBeNull();
  });

  test('another step never matches', () => {
    expect(S.matchFinding(group({ step: '06. POST Obtaining Fulfillments' }), [finding()], {})).toBeNull();
  });

  test('same step and scenario only → maybe: the draft is still made', () => {
    const g = group({ status: 200, problemCode: null, check: 'Offer: priced as CHILD', step: '01. POST Get Offer', scenarioCode: 'OTST_AGE' });
    expect(S.matchFinding(g, [finding({ step: '01. POST Get Offer', observed: '', scenarioCode: 'OTST_AGE' })], {}))
      .toMatchObject({ strength: 'maybe', why: 'same step and scenario' });
  });

  test('a finding a past draft became is the surest match', () => {
    const g = group({ step: '09. POST Add Reservation', problemCode: 'E1' });
    expect(S.matchFinding(g, [finding({ id: 'F9', step: 'something else' })], { [g.key]: 'F9' }))
      .toMatchObject({ strength: 'same', why: 'accepted from the same failure before' });
  });

  test('an open finding whose scenario ran and that nothing matched is not seen', () => {
    const fs = [finding({ id: 'A', scenarioCode: 'S1' }), finding({ id: 'B', scenarioCode: 'S2' }),
      finding({ id: 'C', scenarioCode: 'S1', status: 'resolved' }), finding({ id: 'D', scenarioCode: null })];
    expect(S.notSeen(fs, ['B'], ['S1', 'S2']).map((f) => f.id)).toEqual(['A']);
    expect(S.notSeen(fs, [], ['S3'])).toEqual([]);
  });
});

describe('#735 the draft', () => {
  test('an error answer: title, step, the status to baseline, observed and evidence', () => {
    const g = S.groupFailures([rec({ runId: 'r1', scenarioCode: 'A', error: 'expected 400 to equal 200' }), rec({ runId: 'r2', scenarioCode: 'B' })])[0];
    const d = S.draftOf(g, { batchLabel: 'b-123' });
    expect(d).toMatchObject({
      title: '02. POST Create Booking answers 400 MISSING_INFORMATION',
      step: '02. POST Create Booking', scenarioCode: null, expectedStatus: 400, category: 'open', interpretation: '',
    });
    expect(d.observed).toContain('answered HTTP 400 MISSING_INFORMATION "Purchaser is missing"');
    expect(d.observed).toContain('the check "HTTP response status — expected 200, actual: 400" failed in 2 scenario(s): A, B.');
    expect(d.observed).toContain('First failure: expected 400 to equal 200');
    expect(d.evidence.split('\n')).toEqual(['Batch b-123.', 'Run r1 (A), 2026-10-14 17:11:35.', 'Run r2 (B), 2026-10-14 17:11:35.']);
  });

  test('a check of a 2xx answer: the check is the title, no status to baseline, one scenario named', () => {
    const g = S.groupFailures([rec({ status: 200, problemCode: 'PARAMETER_NOT_SUPPORTED', check: 'Trips collection: holds trips — 0' })])[0];
    const d = S.draftOf(g);
    expect(d).toMatchObject({ title: '02. POST Create Booking: Trips collection: holds trips — N', expectedStatus: null, scenarioCode: 'OTST_SALE_1ADT' });
    expect(d.observed).toContain('The answer also carried the problem PARAMETER_NOT_SUPPORTED.');
  });

  test('"Status code is …" and "→ 500 (FAIL)" checks are titled by the answer', () => {
    expect(S.draftOf(S.groupFailures([rec({ status: 501, problemCode: 'X', check: 'Status code is 204, offer is deleted' })])[0]).title)
      .toBe('02. POST Create Booking answers 501 X');
    expect(S.draftOf(S.groupFailures([rec({ status: 500, problemCode: '10504', check: 'POST /bookings/{id}/x → 500 (FAIL)' })])[0]).title)
      .toBe('02. POST Create Booking answers 500 10504');
  });
});

describe('#735 from a Bruno report', () => {
  const report = [{
    results: [
      { test: { filename: '00-Access Token/Provider Access Token.yml' }, response: { status: 400 },
        postResponseTestResults: [{ description: 'token', status: 'fail' }] },
      { test: { filename: '02-Common Requests/02. POST Create Booking.yml' },
        response: { status: 400, data: { code: 'urn:uic:problem:MISSING_INFORMATION', title: 'Purchaser is missing' } },
        preRequestTestResults: [{ description: 'Trip Search Criteria has at least one leg', status: 'pass' }],
        postResponseTestResults: [{ description: 'HTTP response status — expected 200, actual: 400', status: 'fail', error: 'expected 400 to equal 200' }] },
      { skipped: true, test: { filename: '02-Common Requests/03. PATCH Multi Passenger.yml' }, postResponseTestResults: [{ description: 'x', status: 'fail' }] },
    ],
  }];

  test('failed checks only, token requests and skipped requests left out', () => {
    expect(S.failuresFromBruReport(report, { runId: 'r1', scenarioCode: 'S' })).toEqual([{
      runId: 'r1', at: null, scenarioCode: 'S', step: '02. POST Create Booking',
      check: 'HTTP response status — expected 200, actual: 400', error: 'expected 400 to equal 200',
      status: 400, problemCode: 'MISSING_INFORMATION', problemTitle: 'Purchaser is missing', problemDetail: null,
    }]);
    expect(S.failuresFromBruReport(null)).toEqual([]);
  });
});
