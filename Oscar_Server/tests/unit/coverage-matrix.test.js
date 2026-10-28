// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #956 part 3: the coverage by flow and element tested
 * (utils/coverageMatrix.js), and its Excel workbook
 * (utils/xlsxWorkbook.js, utils/coverageWorkbook.js).
 */

const path = require('node:path');
const M = require('../../src/utils/coverageMatrix');
const C = require('../../src/utils/frameworkCoverage');
const X = require('../../src/utils/xlsxWorkbook');
const { coverageWorkbook } = require('../../src/utils/coverageWorkbook');
const { readZipEntry } = require('../../src/utils/zip');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const simulator = require(path.join(DATA, 'simulator_datafile.json'));

const datafile = (scenarios) => ({
  scenarios,
  tripRequirements: [{ id: 1, tripType: 'SEARCH', trip: {} }],
  passengersList: [{ id: 1, passengers: [{ type: 'PERSON' }] }, { id: 2, passengers: [{ type: 'PERSON' }, { type: 'PERSON', reductionCards: [{ code: 'CARD_A' }] }] }],
});
const framework = {
  salesFlows: ['SALE', 'REFUND_FULL'], currencies: { sold: ['EUR'], default: 'EUR' },
  reductionCards: [{ code: 'CARD_A', name: 'Card A' }], passengerUpdate: false, offerSearchOptions: { travelClasses: [] },
};
const scenarios = [
  { code: 'SALE_OK', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, description: 'A sale' },
  { code: 'SALE_CARD', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 2 },
  { code: 'SALE_CHF', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offerSearchCriteria: { currency: 'CHF' } },
  { code: 'SALE_NOT_SOLD', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, offerSearchCriteria: { currency: 'PLN' }, currencyExpectRejection: true },
  { code: 'REFUND', scenarioType: 'REFUND', tripRequirementId: 1, passengersListId: 1 },
  { code: 'EXCHANGE', scenarioType: 'EXCHANGE', tripRequirementId: 1, passengersListId: 1 },
];
const run = (id, failed = 0) => ({ id, status: 'COMPLETED', queued_at: '2026-10-24 10:00:00', completed_at: '2026-10-24 10:05:00', total: 10, failed });

describe('the coverage by flow and element', () => {
  const m = M.coverageMatrixOf({
    framework, datafile: datafile(scenarios),
    runs: { SALE_OK: run('r1'), SALE_CARD: run('r2', 2), SALE_CHF: run('r3'), SALE_NOT_SOLD: run('r4'), REFUND: run('r5') },
    refusals: { REFUND: ['[DEBUG] x', '🧪 [WARNING] the provider answers 501 (Not Implemented) for the refund'] },
    findings: [{ id: 'f', title: 'Card refused', category: 'open', status: 'open', scenario_code: 'SALE_CARD' }],
  });
  const row = (flow, label) => m.matrix.find((r) => r.flow === flow && r.label === label);

  test('one row per flow and element, the flow first', () => {
    expect(m.matrix[0]).toMatchObject({ flow: 'SALE', group: 'Whole flow', label: 'Sale (every scenario)', result: 'failed', counts: { scenarios: 4, passed: 3, failed: 1 } });
    expect(row('SALE', 'Card A (CARD_A)')).toMatchObject({ result: 'failed', declaration: 'declared', findings: [{ title: 'Card refused' }] });
    expect(row('SALE', 'EUR')).toMatchObject({ result: 'failed', declaration: 'declared', scenarios: ['SALE_OK', 'SALE_CARD'] });
    expect([...new Set(m.matrix.map((r) => r.flow))]).toEqual(['SALE', 'REFUND_FULL', 'EXCHANGE_FULL']);
  });

  test('not supported: not declared (warned) and declared; what the provider says is beside the result', () => {
    // CHF is warned by #218: not supported (not declared), whatever the run.
    expect(row('SALE', 'CHF')).toMatchObject({ result: 'not-declared', declaration: 'not-declared' });
    // The not-sold probe is not warned: it keeps its run's result.
    expect(row('SALE', 'PLN')).toMatchObject({ result: 'passed', declaration: 'not-declared' });
    // The refund's run says the provider does not support something: told
    // beside the result, which stays the run's.
    expect(row('REFUND_FULL', 'Full refund (every scenario)')).toMatchObject({ result: 'passed', providerNotSupported: 1 });
    expect(row('SALE', 'Sale (every scenario)').providerNotSupported).toBe(0);
    // The exchange flow is not declared: its scenario is warned.
    expect(row('EXCHANGE_FULL', 'Full exchange (every scenario)')).toMatchObject({ result: 'not-declared', declaration: 'not-declared' });
    // What the framework says the provider does not do.
    expect(row('SALE', 'Passenger update after the booking')).toMatchObject({ result: 'declared-not-supported', scenarios: [] });
    expect(row('SALE', 'Offer request option offerSearchCriteria.travelClasses')).toMatchObject({ result: 'declared-not-supported' });
  });

  test('one row per scenario, with its flow, elements and what the provider refused', () => {
    expect(m.scenarios.find((s) => s.code === 'SALE_OK')).toMatchObject({ description: 'A sale', flow: 'SALE', result: 'passed', elements: expect.arrayContaining(['Adult', 'EUR']) });
    expect(m.scenarios.find((s) => s.code === 'REFUND')).toMatchObject({ flow: 'REFUND_FULL', providerNotSupported: ['the provider answers 501 (Not Implemented) for the refund'] });
    expect(m.scenarios.find((s) => s.code === 'SALE_CHF').notDeclared).toContain('currency:CHF');
  });

  test('under an after-sale flow, only what the after-sale tests', () => {
    const refundRows = m.matrix.filter((r) => r.flow === 'REFUND_FULL').map((r) => r.label);
    expect(refundRows).toEqual(['Full refund (every scenario)']);
    const partial = M.coverageMatrixOf({ framework, datafile: datafile([{ code: 'P', scenarioType: 'REFUND', partialRefundByLeg: true, overruleCode: 'STRIKE', tripRequirementId: 1, passengersListId: 1 }]) });
    expect(partial.matrix.filter((r) => r.flow === 'REFUND_IROPS').map((r) => r.label)).toEqual(['Refund for irregular operations (IROPS) (every scenario)', 'By leg', 'STRIKE']);
    expect(partial.scenarios[0].elements).toEqual(expect.arrayContaining(['Adult', 'By leg']));
  });

  test('a row with only defects passes with defects; a blocked scenario fails it, listed first', () => {
    const failing = (id, blocking) => ({ ...run(id, 2), failure: { blocking, step: '07. GET Booking', check: 'a field' } });
    const two = [scenarios[0], { ...scenarios[0], code: 'SALE_TWO' }];
    const defects = M.coverageMatrixOf({ framework, datafile: datafile(two), runs: { SALE_OK: failing('r1', false), SALE_TWO: run('r2') } });
    expect(defects.matrix[0]).toMatchObject({ result: 'defects', counts: { scenarios: 2, passed: 1, withDefects: 1, failed: 0 },
      failedScenarios: [{ code: 'SALE_OK', result: 'defects', runId: 'r1', step: '07. GET Booking', check: 'a field' }] });
    const blocked = M.coverageMatrixOf({ framework, datafile: datafile(two), runs: { SALE_OK: failing('r1', false), SALE_TWO: failing('r2', true) } });
    expect(blocked.matrix[0]).toMatchObject({ result: 'failed', counts: { withDefects: 1, failed: 1 } });
    expect(blocked.matrix[0].failedScenarios.map((f) => f.code)).toEqual(['SALE_TWO', 'SALE_OK']);
  });

  test('the warning names and the provider lines read', () => {
    expect([...M.warnedElements(['currency:CHF', 'offerOption:travelClasses=FIRST', 'placeSelectionBy:X', 'partialRefundByLeg', 'passengerUpdate'], new Set())])
      .toEqual(['currency:CHF', 'offerOption:travelClasses:FIRST', 'placeSelection:X', null]);
    const lines = Array.from({ length: 8 }, (_, i) => `[WARNING] PARAMETER_NOT_SUPPORTED ${i} ${'x'.repeat(500)}`);
    const out = M.providerRefusalsOf([...lines, '[INFO] not supported', 42]);
    expect(out).toHaveLength(5);
    expect(out[0].length).toBe(400);
    expect(M.providerRefusalsOf(['[WARNING] all good'])).toEqual([]);
    expect(M.declarationOf('offerOptionDiscovery', {}, new Set())).toBe('every-value');
    expect(M.declarationOf('passengerType:CHILD', { passengerTypes: ['ADULT'] }, new Set())).toBe('not-declared');
  });

  test('every simulator reference: no row of its run list reads "not declared"', () => {
    for (const p of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      const ref = require(path.join(DATA, 'reference', `simulator-${p}.json`));
      const sub = { ...simulator, scenarios: simulator.scenarios.filter((s) => ref.scenariosToRun.includes(s.code)) };
      const r = M.coverageMatrixOf({ framework: ref.framework, datafile: sub });
      expect([p, r.matrix.filter((x) => x.result === 'not-declared').map((x) => x.label)]).toEqual([p, []]);
      expect(r.scenarios).toHaveLength(sub.scenarios.length);
    }
  });
});

describe('the Excel workbook', () => {
  const sheet = (buf, n) => readZipEntry(buf, `xl/worksheets/sheet${n}.xml`).toString('utf8');

  test('text is escaped, never a formula, control characters dropped', () => {
    expect(X.xmlText('a<b>&"c"\u0001\u0008\tz')).toBe('a&lt;b&gt;&amp;&quot;c&quot;\tz');
    expect(X.xmlText('ok 😀 lone \uD800 end')).toBe('ok 😀 lone  end');
    const buf = X.workbook([{ name: 'A/B:[x]', columns: [{ title: 'Text', width: 10 }, { title: 'N' }], rows: [['=HYPERLINK("x")', 3], [null, 'y']] }]);
    const xml = sheet(buf, 1);
    expect(xml).toContain('<c r="A2" s="2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;x&quot;)</t></is></c>');
    expect(xml).toContain('<c r="B2" s="2"><v>3</v></c>');
    expect(xml).not.toContain('<f>');
    expect(xml).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(xml).toContain('<autoFilter ref="A1:B3"/>');
    expect(readZipEntry(buf, 'xl/workbook.xml').toString()).toContain('<sheet name="A B  x" sheetId="1" r:id="rId1"/>');
  });

  test('columns and sheet names', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(X.columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
    const used = new Set();
    expect([X.sheetName('Same', used), X.sheetName('same', used), X.sheetName('', used)]).toEqual(['Same', 'same 2', 'Sheet']);
    expect(X.sheetName('x'.repeat(40), new Set())).toHaveLength(31);
  });

  test('the coverage workbook has its seven sheets, the capabilities first (#972)', () => {
    const input = { framework, datafile: datafile(scenarios), runs: { SALE_OK: run('r1') } };
    const report = { days: 30, framework: true, datafile: true, collectionVersion: 'V', ...C.coverageOf(input), ...M.coverageMatrixOf(input) };
    const buf = coverageWorkbook(report, { title: 'Gamma <&>', generatedAt: '2026-10-25 10:00:00 UTC' });
    const book = readZipEntry(buf, 'xl/workbook.xml').toString();
    const names = ['Summary', 'Capabilities', 'Expected refusals', 'Points to look at', 'By flow and element', 'By scenario', 'By function'];
    expect([...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(names);
    expect(sheet(buf, 1)).toContain('Gamma &lt;&amp;&gt;');
    expect(sheet(buf, 5)).toContain('Not supported (not declared)');
    expect(sheet(buf, 6)).toContain('SALE_OK');
    expect(readZipEntry(buf, '[Content_Types].xml').toString()).toContain('/xl/worksheets/sheet7.xml');
  });

  test('the capability sheets hold the server\'s own coverage by capability (#972)', () => {
    const { capabilityCoverageOf } = require('../../src/utils/capabilityCoverage');
    const { KIND_TEXT } = require('../../src/utils/coverageWorkbook');
    const { KIND_ORDER } = require('../../src/utils/coveragePoints');
    expect(Object.keys(KIND_TEXT)).toEqual([...KIND_ORDER]);
    const steps = ['01. POST Get Offer', '02. POST Create Booking', '06. POST Obtaining Fulfillments from Booking'].map((n) => ({ request_name: n, http_status: 200 }));
    const failed = (code) => ({ id: `run-${code}`, status: 'FAILED', completed_at: '2026-10-24 10:05:00', steps,
      checks: [{ request_name: '02. POST Create Booking', assertion_name: 'Booking price is <12.50>', category: 'business_logic', severity: 'major', http_status: 200,
        error_msg: 'expected <12.40> to equal <12.50>' }] });
    const df = datafile([
      { code: 'A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1 },
      { code: 'NHF_A', scenarioType: 'SALE', tripRequirementId: 1, passengersListId: 1, description: 'Must <refuse>' },
    ]);
    const byCapability = capabilityCoverageOf({ framework: { salesFlows: ['SALE'] }, datafile: df, runs: { A: failed('A'), NHF_A: failed('NHF_A') } });
    const buf = coverageWorkbook({ days: 30, summary: {}, byCapability }, {});
    expect(sheet(buf, 1)).toContain('Passed with points');
    // #1027: the refusals blocked before the request to refuse have their row.
    expect(sheet(buf, 1)).toContain('Blocked before the request to refuse');
    const caps = sheet(buf, 2);
    expect(caps).toContain('Sale: pre-booking and confirmation');
    expect(caps).toContain('A: Passed with points\n  A (SEARCH): Passed with points at 02. POST Create Booking — Booking price is &lt;12.50&gt;');
    expect(caps).toContain('>#1<');
    expect(sheet(buf, 3)).toContain('Must &lt;refuse&gt;');
    const points = sheet(buf, 4);
    expect(points).toContain('Booking price is &lt;N&gt;');
    // #990: the check is what was expected, the run's failure text what was seen.
    expect(points).toContain('Expected (the check)');
    expect(points).toContain('Seen (latest run)');
    expect(points).toContain('expected &lt;12.40&gt; to equal &lt;12.50&gt;');
    expect(points).toContain('For the provider');
    expect(points).toContain('run-A');
    expect(points).not.toContain('<f>');
  });

  test('#995: an Offer request parameters sheet after the points, only when a run of the options scenario holds a report', () => {
    const C = require('../../src/utils/offerOptionCoverage');
    const names = (buf) => [...readZipEntry(buf, 'xl/workbook.xml').toString().matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    const report = {
      mandatory: { ok: false, message: 'HTTP 400 <m>' },
      options: [{ option: 'offerSearchCriteria.currency', value: 'EUR', source: 'declared', declared: true, status: 200, result: 'honoured', message: 'kept' },
        { option: 'embed', status: 501, result: 'not-implemented' }],
      combinations: [{ options: ['offerSearchCriteria.currency', 'embed'], status: 400, result: 'refused', message: 'COMBO <c>' }],
      all: { count: 2, status: 200, result: 'no-offer-said' },
    };
    const entries = C.offerOptionCoverageOf([{ code: 'OPT', run: { id: 'r1', completed_at: '2026-10-26 08:00:00' }, report }]);
    const byCapability = C.withOfferOptions({ capabilities: [], expectedRefusals: [], points: [] }, entries);
    const buf = coverageWorkbook({ days: 30, summary: {}, byCapability }, {});
    expect(names(buf)).toEqual(['Summary', 'Capabilities', 'Expected refusals', 'Points to look at', 'Offer request parameters',
      'By flow and element', 'By scenario', 'By function']);
    const xml = sheet(buf, 5);
    for (const text of ['Request', 'Parameter(s)', 'Test Framework', entries[0].text, 'NOT answered', 'HTTP 400 &lt;m&gt;', 'One parameter',
      'Supported, kept to', 'Declared', 'Not implemented', 'Not declared', 'Combination', 'offerSearchCriteria.currency + embed',
      'Refused (a point)', 'COMBO &lt;c&gt;', 'Every supported parameter at once', 'No offer']) {
      expect(xml).toContain(text);
    }
    expect(xml.match(/<row /g)).toHaveLength(1 + 6);
    expect(names(coverageWorkbook({ days: 30, summary: {}, byCapability: { capabilities: [] } }, {}))).not.toContain('Offer request parameters');
  });
});
