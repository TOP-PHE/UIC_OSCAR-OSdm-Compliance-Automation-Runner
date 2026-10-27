// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #227 part 3: the offer request options report read back from a run's log
 * (utils/offerOptionReport.js), against the collection's own reportLines().
 */

const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const { reportLines } = require(path.join(LIB, 'offerOptions.js'));
const { RESULTS, reportOf, optionOf, countsOf } = require('../../src/utils/offerOptionReport');
const { LogParser } = require('../../src/worker/runner');

// The same seeded generator as the collection's combinations (mulberry32).
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPTIONS = ['offerSearchCriteria.currency', 'passenger.cards', 'embed', 'promotionCodes', 'corporateCodes', 'tripSearchCriteria.vias', 'passenger.age'];
const VALUES = ['EUR', [{ type: 'REDUCTION_CARD', code: 'X: honoured' }], 'a — b', { code: 'P, refused' }, 35, 'x'.repeat(120)];
const MESSAGES = [null, 'the request budget ran out', 'unknown card — said twice', 'HTTP 400, refused', 'no offer: ignored-silent'];

// A report of the shape discover() builds, drawn from `seed`.
function reportFrom(seed) {
  const r = random(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const options = OPTIONS.map((option) => {
    const row = { option, group: 'g', result: pick(RESULTS) };
    if (r() < 0.7) { row.value = pick(VALUES); row.source = pick(['declared', 'scenario', 'default', 'random']); }
    if (r() < 0.7) row.status = pick([200, 400, 422, 500, 501]);
    const message = pick(MESSAGES);
    if (message) row.message = message;
    const declared = pick([true, false, undefined]);
    if (declared !== undefined) row.declared = declared;
    return row;
  });
  return {
    version: '3.8.0', budget: 30, used: 9, seed,
    mandatory: { ok: r() < 0.8, message: '3 offer(s)' },
    options,
    combinations: [{ options: ['embed', 'passenger.age'], status: 200, result: 'honoured', message: '2 offer(s)' }],
    all: r() < 0.5 ? null : { options: ['embed', 'passenger.age', 'promotionCodes'], status: 200, result: 'accepted' },
  };
}

// What the log keeps of a row (the value is shortened as reportLines() does).
const shortValue = (v) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};
function expectedRow(row) {
  const out = { option: row.option, result: row.result };
  if (row.declared !== undefined) out.declared = row.declared;
  if (row.status) out.status = row.status;
  if (row.value !== undefined) { out.value = shortValue(row.value); out.source = row.source; }
  if (row.message) out.message = row.message;
  return out;
}

describe('the report read back from the collection\'s log lines', () => {
  test('every row of 300 drawn reports comes back as it was written', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const report = reportFrom(seed);
      const back = reportOf(reportLines(report).map((l) => `  ${l}`));
      expect(back.options).toEqual(report.options.map(expectedRow));
      expect(back).toMatchObject({ version: '3.8.0', budget: 30, used: 9, seed, mandatory: { ok: report.mandatory.ok, message: '3 offer(s)' } });
      expect(back.combinations).toEqual([{ options: ['embed', 'passenger.age'], status: 200, result: 'honoured', message: '2 offer(s)' }]);
      expect(back.all).toEqual(report.all ? { count: 3, status: 200, result: 'accepted' } : null);
    }
  });

  test('a value or message naming a result does not move the row', () => {
    expect(optionOf('passenger.cards = [{"code":"X: honoured"}] (random): HTTP 400, invalid-said — unknown: refused'))
      .toEqual({ option: 'passenger.cards', value: '[{"code":"X: honoured"}]', source: 'random', status: 400, result: 'invalid-said', message: 'unknown: refused' });
    expect(optionOf('Offer set: 3 offer(s).')).toBeNull();
  });

  test('silent options, counts, and no report without its first line', () => {
    const report = reportFrom(5);
    report.options[0].result = 'ignored-silent';
    const back = reportOf(reportLines(report));
    expect(back.silent).toContain(report.options[0].option);
    expect(Object.values(countsOf(back)).reduce((a, b) => a + b, 0)).toBe(report.options.length);
    expect(reportOf(reportLines(report).slice(1))).toBeNull();
    expect(reportOf(['[INFO] 🧭 Offer set: 3 offer(s).'])).toBeNull();
    expect(reportOf(null)).toBeNull();
  });

  test('phase 1 says "parameters" (#990); a log written before still reads', () => {
    const report = reportFrom(3);
    const lines = reportLines(report);
    expect(lines[1]).toContain('Phase 1, mandatory parameters only: ');
    const before = lines.map((l) => l.replace('mandatory parameters only', 'mandatory members only'));
    expect(before[1]).toContain('Phase 1, mandatory members only: ');
    for (const written of [lines, before]) {
      expect(reportOf(written).mandatory).toEqual({ ok: report.mandatory.ok, message: '3 offer(s)' });
    }
  });
});

describe('the runner files the report\'s lines apart', () => {
  test('a tagged line holding the mark gets category offer_options; others do not', () => {
    expect(new LogParser().parse('[INFO] 🧭   embed: HTTP 500, error').category).toBe('offer_options');
    expect(new LogParser().parse('[INFO] Offer set: 3').category).not.toBe('offer_options');
    expect(new LogParser().parse('🧭 no level tag').category).not.toBe('offer_options');
  });
});
