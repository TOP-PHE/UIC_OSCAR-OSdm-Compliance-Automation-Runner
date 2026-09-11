// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafile-ownership.test.js — the rules for what a tester may see and change
 * in the company datafile (S3 second half, v1.11.197). Pure functions, so the
 * edge cases are exercised directly; the HTTP wiring is covered by
 * tests/integration/company-datafile-tester-merge.test.js.
 */

const {
  isOwnedBy, isVisibleTo, canonical, resolveRunList, viewForTester, mergeTesterSave,
} = require('../../src/utils/datafileOwnership');

const ANA = 'ana@vendor.test';     // the tester saving
const BEN = 'ben@vendor.test';     // another tester
const TM  = 'tm@vendor.test';      // the Test Manager

// One scenario and its four resource entries, ids base..base+3.
function scenario(code, owner, { shared = false, base, extra = {} } = {}) {
  return {
    code, shared, ...(owner === undefined ? {} : { created_by: owner }),
    tripRequirementId: base, passengersListId: base + 1, purchaserListId: base + 2,
    requestedFulfillmentOptionsListId: base + 3, ...extra,
  };
}
function resources(base, tag) {
  return {
    tripRequirements:                [{ id: base,     tag }],
    passengersList:                  [{ id: base + 1, tag }],
    purchaserList:                   [{ id: base + 2, tag }],
    requestedFulfillmentOptionsList: [{ id: base + 3, tag }],
  };
}
function datafile(parts, extra = {}) {
  const df = { scenarios: [], tripRequirements: [], passengersList: [], purchaserList: [], requestedFulfillmentOptionsList: [], ...extra };
  for (const [sc, res] of parts) {
    df.scenarios.push(sc);
    for (const k of Object.keys(res)) df[k].push(...res[k]);
  }
  return df;
}
const clone = v => JSON.parse(JSON.stringify(v));
const codes = df => df.scenarios.map(s => s.code);
const byCode = (df, code) => df.scenarios.find(s => s.code === code);

// A company file: a shared scenario, a company one with no owner, Ana's, Ben's, the TM's private one.
function companyFile() {
  return datafile([
    [scenario('SHARED_1', TM,        { shared: true, base: 10 }), resources(10, 'shared')],
    [scenario('LEGACY_1', undefined, { base: 20 }),               resources(20, 'legacy')],
    [scenario('ANA_1',    ANA,       { base: 30 }),               resources(30, 'ana')],
    [scenario('BEN_1',    BEN,       { base: 40 }),               resources(40, 'ben')],
    [scenario('TM_PRIV',  TM,        { base: 50 }),               resources(50, 'tm')],
  ], { scenariosToRun: ['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV'], systemInfoParameters: { v: 'company' } });
}

// ── Ownership and visibility ─────────────────────────────────────────────────
describe('isOwnedBy / isVisibleTo', () => {
  const file = companyFile();
  test.each([
    ['SHARED_1', false, true ],
    ['LEGACY_1', false, true ],   // no owner: a company scenario, visible read-only
    ['ANA_1',    true,  true ],
    ['BEN_1',    false, false],   // another tester's private scenario
    ['TM_PRIV',  false, false],   // the Test Manager's private scenario
  ])('%s → owned %s, visible %s (for Ana)', (code, owned, visible) => {
    expect(isOwnedBy(byCode(file, code), ANA)).toBe(owned);
    expect(isVisibleTo(byCode(file, code), ANA)).toBe(visible);
  });

  test('email comparison ignores case and surrounding spaces', () => {
    expect(isOwnedBy({ code: 'X', created_by: ' Ana@Vendor.TEST ' }, ANA)).toBe(true);
  });
  test('a shared scenario is never "owned", even by its creator', () => {
    expect(isOwnedBy({ code: 'X', created_by: ANA, shared: true }, ANA)).toBe(false);
  });
  test('an empty caller email owns nothing', () => {
    expect(isOwnedBy({ code: 'X', created_by: '' }, '')).toBe(false);
  });
});

describe('canonical', () => {
  test('ignores key order and the GET-time __ annotations', () => {
    expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1, __featureNotDeclaredWarnings: ['x'] }));
  });
  test('still sees a real difference', () => {
    expect(canonical({ a: 1 })).not.toBe(canonical({ a: 2 }));
  });
});

describe('resolveRunList', () => {
  test('keeps order, drops duplicates and codes outside the allowed set', () => {
    expect(resolveRunList(['C', 'A', 'C', 'Z'], ['A', 'B', 'C'])).toEqual(['C', 'A']);
  });
  test('"ALL" means every allowed code', () => {
    expect(resolveRunList('ALL', ['A', 'B'])).toEqual(['A', 'B']);
  });
  test('accepts Bruno\'s comma-separated form', () => {
    expect(resolveRunList('B, A', ['A', 'B'])).toEqual(['B', 'A']);
  });
});

// ── The tester's view ─────────────────────────────────────────────────────────
describe('viewForTester', () => {
  test('hides other people\'s private scenarios and the resource entries only they use', () => {
    const view = viewForTester(companyFile(), ANA, null);
    expect(codes(view)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1']);
    expect(view.tripRequirements.map(e => e.id)).toEqual([10, 20, 30]);
    expect(JSON.stringify(view)).not.toContain('"ben"');
    expect(JSON.stringify(view)).not.toContain('"tm"');
  });

  test('an entry shared with a visible scenario stays visible', () => {
    const file = companyFile();
    byCode(file, 'BEN_1').tripRequirementId = 10;          // Ben's scenario also points at the shared trip
    const view = viewForTester(file, ANA, null);
    expect(view.tripRequirements.map(e => e.id)).toContain(10);
  });

  test('with no personal list, the run list is the company default limited to what they see', () => {
    expect(viewForTester(companyFile(), ANA, null).scenariosToRun).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1']);
  });

  test('with a personal list, that list is shown — minus anything no longer visible', () => {
    expect(viewForTester(companyFile(), ANA, ['ANA_1', 'BEN_1', 'GONE']).scenariosToRun).toEqual(['ANA_1']);
  });

  test('other top-level keys are passed through untouched', () => {
    expect(viewForTester(companyFile(), ANA, null).systemInfoParameters).toEqual({ v: 'company' });
  });
});

// ── The merge ─────────────────────────────────────────────────────────────────
describe('mergeTesterSave — scenarios', () => {
  // What Ana's editor sends back: her view, with her changes applied.
  const anaSends = (mutate) => { const v = clone(viewForTester(companyFile(), ANA, null)); mutate(v); return v; };

  test('an unchanged save changes nothing', () => {
    const stored = companyFile();
    const { datafile, ignoredReadOnly, renamed, forked } = mergeTesterSave(stored, anaSends(() => {}), ANA);
    expect(canonical(datafile)).toBe(canonical(stored));
    expect([ignoredReadOnly, renamed, forked]).toEqual([[], [], []]);
  });

  test('her own scenario is updated; every other scenario is byte-for-byte as stored', () => {
    const stored = companyFile();
    const { datafile } = mergeTesterSave(stored, anaSends(v => { byCode(v, 'ANA_1').note = 'edited'; }), ANA);
    expect(byCode(datafile, 'ANA_1').note).toBe('edited');
    for (const code of ['SHARED_1', 'LEGACY_1', 'BEN_1', 'TM_PRIV']) {
      expect(canonical(byCode(datafile, code))).toBe(canonical(byCode(stored, code)));
    }
  });

  test('the scenarios she cannot see survive her save (the original S3 hole)', () => {
    const { datafile } = mergeTesterSave(companyFile(), anaSends(() => {}), ANA);
    expect(codes(datafile)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV']);
  });

  test('an edit to a shared or company scenario is not kept, and is reported', () => {
    const stored = companyFile();
    const { datafile, ignoredReadOnly } = mergeTesterSave(stored, anaSends(v => {
      byCode(v, 'SHARED_1').note = 'hijack';
      byCode(v, 'LEGACY_1').note = 'hijack';
    }), ANA);
    expect(canonical(byCode(datafile, 'SHARED_1'))).toBe(canonical(byCode(stored, 'SHARED_1')));
    expect(canonical(byCode(datafile, 'LEGACY_1'))).toBe(canonical(byCode(stored, 'LEGACY_1')));
    expect(ignoredReadOnly).toEqual(['SHARED_1', 'LEGACY_1']);
  });

  test('she cannot delete a shared, company or someone else\'s scenario by leaving it out', () => {
    const sent = { scenarios: [byCode(companyFile(), 'ANA_1')], scenariosToRun: [] };
    const { datafile } = mergeTesterSave(companyFile(), sent, ANA);
    expect(codes(datafile)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV']);
  });

  test('she can delete her own scenario, and its resource entries go with it', () => {
    const { datafile } = mergeTesterSave(companyFile(), anaSends(v => { v.scenarios = v.scenarios.filter(s => s.code !== 'ANA_1'); }), ANA);
    expect(codes(datafile)).not.toContain('ANA_1');
    expect(datafile.tripRequirements.map(e => e.id)).not.toContain(30);
    expect(datafile.tripRequirements.map(e => e.id)).toEqual(expect.arrayContaining([10, 20, 40, 50]));
  });

  test('a new scenario she creates is stored as hers, unshared', () => {
    const { datafile } = mergeTesterSave(companyFile(), anaSends(v => {
      v.scenarios.push(scenario('ANA_NEW', ANA, { base: 60 }));
      Object.entries(resources(60, 'ana-new')).forEach(([k, e]) => v[k].push(...e));
    }), ANA);
    const added = byCode(datafile, 'ANA_NEW');
    expect(added.created_by).toBe(ANA);
    expect(added.shared).toBe(false);
  });

  test('a new scenario marked shared, or credited to someone else, is not stored — it can only be a stale or forged copy', () => {
    for (const [owner, shared] of [[BEN, false], [ANA, true], [BEN, true]]) {
      const { datafile } = mergeTesterSave(companyFile(), anaSends(v => {
        v.scenarios.push(scenario('ODD_NEW', owner, { shared, base: 60 }));
        Object.entries(resources(60, 'odd')).forEach(([k, e]) => v[k].push(...e));
      }), ANA);
      expect(codes(datafile)).not.toContain('ODD_NEW');
      expect(datafile.tripRequirements.map(e => e.tag)).not.toContain('odd');
    }
  });

  test('she cannot claim someone else\'s scenario by rewriting created_by', () => {
    const stored = companyFile();
    const sent = anaSends(v => { v.scenarios.push({ ...byCode(stored, 'SHARED_1'), created_by: ANA, shared: false, note: 'mine now' }); });
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    expect(canonical(byCode(datafile, 'SHARED_1'))).toBe(canonical(byCode(stored, 'SHARED_1')));
  });

  test('scenarios keep their places: hers fill her slots, new ones go at the end', () => {
    const { datafile } = mergeTesterSave(companyFile(), anaSends(v => {
      v.scenarios.push(scenario('ANA_NEW', ANA, { base: 60 }));
      Object.entries(resources(60, 'n')).forEach(([k, e]) => v[k].push(...e));
    }), ANA);
    expect(codes(datafile)).toEqual(['SHARED_1', 'LEGACY_1', 'ANA_1', 'BEN_1', 'TM_PRIV', 'ANA_NEW']);
  });

  test('an unchanged read-only scenario echoed with a GET annotation is not reported', () => {
    const { ignoredReadOnly } = mergeTesterSave(companyFile(), anaSends(v => {
      byCode(v, 'SHARED_1').__featureNotDeclaredWarnings = ['placeSelection'];
    }), ANA);
    expect(ignoredReadOnly).toEqual([]);
  });
});

describe('mergeTesterSave — resource entries', () => {
  test('her edit to her own entry is kept; others\' entries are untouched', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    sent.passengersList.find(e => e.id === 31).tag = 'ana-edited';
    sent.passengersList.find(e => e.id === 11).tag = 'shared-hijack';   // the shared scenario's passengers
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    expect(datafile.passengersList.find(e => e.id === 31).tag).toBe('ana-edited');
    expect(datafile.passengersList.find(e => e.id === 11).tag).toBe('shared');
  });

  test('an id her editor minted that a hidden scenario already uses is copied to a fresh id', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    // Her editor only sees ids up to 33, so it can hand out 40 — Ben's trip.
    sent.scenarios.push(scenario('ANA_NEW', ANA, { base: 40 }));
    Object.entries(resources(40, 'ana-new')).forEach(([k, e]) => sent[k].push(...e));
    const { datafile, forked } = mergeTesterSave(stored, sent, ANA);
    expect(datafile.tripRequirements.find(e => e.id === 40).tag).toBe('ben');        // Ben's entry intact
    const mine = byCode(datafile, 'ANA_NEW');
    expect(mine.tripRequirementId).not.toBe(40);
    expect(datafile.tripRequirements.find(e => e.id === mine.tripRequirementId).tag).toBe('ana-new');
    expect(forked.map(f => f.list)).toEqual(['tripRequirements', 'passengersList', 'purchaserList', 'requestedFulfillmentOptionsList']);
  });

  test('fresh ids never collide with anything in the stored file or the request', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    sent.scenarios.push(scenario('ANA_NEW', ANA, { base: 40 }));
    Object.entries(resources(40, 'x')).forEach(([k, e]) => sent[k].push(...e));
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    for (const list of ['tripRequirements', 'passengersList', 'purchaserList', 'requestedFulfillmentOptionsList']) {
      const ids = datafile[list].map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test('an entry her scenario shares with a shared scenario (old aliasing) is copied on write, not overwritten', () => {
    const stored = companyFile();
    byCode(stored, 'ANA_1').passengersListId = 11;                  // aliased to the shared scenario's passengers
    const sent = clone(viewForTester(stored, ANA, null));
    sent.passengersList.find(e => e.id === 11).tag = 'ana-change';
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    expect(datafile.passengersList.find(e => e.id === 11).tag).toBe('shared');
    const anaPax = byCode(datafile, 'ANA_1').passengersListId;
    expect(anaPax).not.toBe(11);
    expect(datafile.passengersList.find(e => e.id === anaPax).tag).toBe('ana-change');
    expect(byCode(datafile, 'SHARED_1').passengersListId).toBe(11);
  });

  test('her entry is kept even when a hidden scenario dangles on the same id', () => {
    const stored = companyFile();
    byCode(stored, 'BEN_1').tripRequirementId = 99;                // Ben points at a trip that does not exist
    const sent = clone(viewForTester(stored, ANA, null));
    sent.scenarios.push(scenario('ANA_NEW', ANA, { base: 60, extra: { tripRequirementId: 99 } }));
    sent.tripRequirements.push({ id: 99, tag: 'ana-trip' });
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    const tid = byCode(datafile, 'ANA_NEW').tripRequirementId;
    expect(datafile.tripRequirements.find(e => e.id === tid).tag).toBe('ana-trip');
  });

  test('stored entries no scenario references are company data and survive', () => {
    const stored = companyFile();
    stored.tripRequirements.push({ id: 900, tag: 'orphan' });
    const { datafile } = mergeTesterSave(stored, clone(viewForTester(stored, ANA, null)), ANA);
    expect(datafile.tripRequirements.find(e => e.id === 900)).toBeTruthy();
  });
});

describe('mergeTesterSave — run lists and other keys', () => {
  test('what she ticks becomes her personal list; the company list is left alone', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    sent.scenariosToRun = ['ANA_1'];
    const { datafile, selection } = mergeTesterSave(stored, sent, ANA);
    expect(selection).toEqual(['ANA_1']);
    expect(datafile.scenariosToRun).toEqual(stored.scenariosToRun);
  });

  test('her personal list can only hold scenarios she can see', () => {
    const sent = clone(viewForTester(companyFile(), ANA, null));
    sent.scenariosToRun = ['BEN_1', 'SHARED_1', 'TM_PRIV'];
    expect(mergeTesterSave(companyFile(), sent, ANA).selection).toEqual(['SHARED_1']);
  });

  test('deleting her own scenario drops it from the company list too', () => {
    const sent = clone(viewForTester(companyFile(), ANA, null));
    sent.scenarios = sent.scenarios.filter(s => s.code !== 'ANA_1');
    expect(mergeTesterSave(companyFile(), sent, ANA).datafile.scenariosToRun).not.toContain('ANA_1');
  });

  test('company-level keys are the stored values, whatever she sends', () => {
    const sent = clone(viewForTester(companyFile(), ANA, null));
    sent.systemInfoParameters = { v: 'hijack' };
    sent.somethingNew = 1;
    const { datafile } = mergeTesterSave(companyFile(), sent, ANA);
    expect(datafile.systemInfoParameters).toEqual({ v: 'company' });
    expect(datafile).not.toHaveProperty('somethingNew');   // testers never add company-level keys (A)
  });

  test('a first save into an empty company takes her file, owned by her', () => {
    const sent = datafile([[scenario('FIRST', ANA, { base: 1 }), resources(1, 'f')]], { scenariosToRun: ['FIRST'] });
    const { datafile: out, selection } = mergeTesterSave({}, sent, ANA);
    expect(codes(out)).toEqual(['FIRST']);
    expect(out.scenariosToRun).toEqual(['FIRST']);
    expect(selection).toEqual(['FIRST']);
    expect(byCode(out, 'FIRST').created_by).toBe(ANA);
  });

  test('a stored "ALL" company list is kept; a comma-separated one is pruned to codes that exist', () => {
    const all = { ...companyFile(), scenariosToRun: 'ALL' };
    expect(mergeTesterSave(all, clone(viewForTester(all, ANA, null)), ANA).datafile.scenariosToRun).toBe('ALL');
    const csv = { ...companyFile(), scenariosToRun: 'SHARED_1,LEGACY_1' };
    expect(mergeTesterSave(csv, clone(viewForTester(csv, ANA, null)), ANA).datafile.scenariosToRun).toEqual(['SHARED_1', 'LEGACY_1']);
  });

  test('the stored object is never mutated', () => {
    const stored = companyFile();
    const before = clone(stored);
    const sent = clone(viewForTester(stored, ANA, null));
    sent.scenarios.push(scenario('ANA_NEW', ANA, { base: 40 }));
    Object.entries(resources(40, 'x')).forEach(([k, e]) => sent[k].push(...e));
    mergeTesterSave(stored, sent, ANA);
    expect(stored).toEqual(before);
  });
});

// ── Adversarial review, 2026-09-11 ────────────────────────────────────────────
// Each test below is a defect an independent review reproduced against the first
// version of the merge; it failed before the fix it pins.
describe('adversarial review — findings pinned', () => {
  const add = (v, code, owner, base, extra = {}) => {
    v.scenarios.push(scenario(code, owner, { base, extra }));
    Object.entries(resources(base, code)).forEach(([k, e]) => v[k].push(...e));
    return v;
  };

  test('A: a tester cannot plant a company-level key — systemInfoParameters becomes Bruno env vars for every run', () => {
    const stored = companyFile();
    delete stored.systemInfoParameters;                       // the normal state of a wizard-built file
    const sent = clone(viewForTester(stored, ANA, null));
    sent.systemInfoParameters = { api_base: 'https://attacker.example' };
    sent.anythingElse = { x: 1 };
    const { datafile } = mergeTesterSave(stored, sent, ANA);
    expect(datafile).not.toHaveProperty('systemInfoParameters');
    expect(datafile).not.toHaveProperty('anythingElse');
  });

  test('A: not even on the first save into an empty company — only the wizard skeleton strings are taken', () => {
    const sent = datafile([[scenario('FIRST', ANA, { base: 1 }), resources(1, 'f')]],
      { scenariosToRun: ['FIRST'], osdmVersion: '3.4', collection: 'OTST_V2.0.1', systemInfoParameters: { api_base: 'https://attacker.example' } });
    const { datafile: out } = mergeTesterSave({}, sent, ANA);
    expect(out).not.toHaveProperty('systemInfoParameters');
    expect(out.osdmVersion).toBe('3.4');
    expect(out.collection).toBe('OTST_V2.0.1');
  });

  test('C: a new scenario that reuses a shared code is kept under a free code — not silently dropped', () => {
    const stored = companyFile();
    const sent = add(clone(viewForTester(stored, ANA, null)), 'SHARED_1', ANA, 60);
    sent.scenariosToRun.push('SHARED_1');                     // the wizard ticks what it adds
    const r = mergeTesterSave(stored, sent, ANA);
    expect(canonical(byCode(r.datafile, 'SHARED_1'))).toBe(canonical(byCode(stored, 'SHARED_1')));
    expect(r.renamed).toEqual([{ from: 'SHARED_1', to: 'SHARED_1_2' }]);
    const mine = byCode(r.datafile, 'SHARED_1_2');
    expect(mine.created_by).toBe(ANA);
    expect(r.datafile.tripRequirements.find(e => e.id === mine.tripRequirementId).tag).toBe('SHARED_1');
    expect(r.selection).toContain('SHARED_1_2');
    expect(r.ignoredReadOnly).toEqual([]);
  });

  test('C: a new scenario whose code a hidden one uses is renamed, not refused (second tester duplicating the same scenario)', () => {
    const stored = companyFile();
    const r = mergeTesterSave(stored, add(clone(viewForTester(stored, ANA, null)), 'BEN_1', ANA, 70), ANA);
    expect(r.renamed).toEqual([{ from: 'BEN_1', to: 'BEN_1_2' }]);
    expect(canonical(byCode(r.datafile, 'BEN_1'))).toBe(canonical(byCode(stored, 'BEN_1')));
    expect(byCode(r.datafile, 'BEN_1_2').created_by).toBe(ANA);
  });

  test('C: a stale copy of a scenario the Test Manager deleted is not brought back as the tester\'s', () => {
    const stale = clone(viewForTester(companyFile(), ANA, null));   // Ana's editor, opened before the delete
    const stored = companyFile();
    stored.scenarios = stored.scenarios.filter(s => s.code !== 'SHARED_1');
    const r = mergeTesterSave(stored, stale, ANA);
    expect(codes(r.datafile)).not.toContain('SHARED_1');
    expect(r.renamed).toEqual([]);
  });

  test('C: a stale copy of a scenario the Test Manager un-shared neither collides nor is reported', () => {
    const stale = clone(viewForTester(companyFile(), ANA, null));
    const stored = companyFile();
    byCode(stored, 'SHARED_1').shared = false;                // now the TM's private scenario
    const r = mergeTesterSave(stored, stale, ANA);
    expect(canonical(byCode(r.datafile, 'SHARED_1'))).toBe(canonical(byCode(stored, 'SHARED_1')));
    expect(r.renamed).toEqual([]);
    expect(r.ignoredReadOnly).toEqual([]);
  });

  test('I: but a field the editor does not backfill, or a backfill key with a non-default value, is still a reported edit', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    byCode(sent, 'SHARED_1').offerSearchCriteria = { currency: 'CHF' };
    byCode(sent, 'LEGACY_1').passengerExternalRefFormat = 'PAX%04d';
    expect(mergeTesterSave(stored, sent, ANA).ignoredReadOnly).toEqual(['SHARED_1', 'LEGACY_1']);
  });

  test('I: the editor legacy backfill (keys it adds) is not reported as a read-only edit', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    for (const sc of sent.scenarios) { sc.salesFlowActions = sc.salesFlowActions || { book: true }; sc.offerSearchCriteria = sc.offerSearchCriteria || {}; }
    const r = mergeTesterSave(stored, sent, ANA);
    expect(r.ignoredReadOnly).toEqual([]);
    expect(byCode(r.datafile, 'SHARED_1')).not.toHaveProperty('salesFlowActions');
  });

  test('J: copies never share an id, even past Number.MAX_SAFE_INTEGER', () => {
    const BIG = 2 ** 53;
    const stored = companyFile();
    add(stored, 'ANA_BIG', ANA, BIG - 3);                      // ids BIG-3 .. BIG, all Ana's own
    const benSent = add(clone(viewForTester(stored, BEN, null)), 'BEN_NEW', BEN, 30);   // 30..33 are Ana's (hidden to Ben)
    const r = mergeTesterSave(stored, benSent, BEN);
    const mine = byCode(r.datafile, 'BEN_NEW');
    for (const [list, ref] of [['tripRequirements', 'tripRequirementId'], ['passengersList', 'passengersListId'],
      ['purchaserList', 'purchaserListId'], ['requestedFulfillmentOptionsList', 'requestedFulfillmentOptionsListId']]) {
      const ids = r.datafile[list].map(e => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Number.isSafeInteger(mine[ref])).toBe(true);
      expect(r.datafile[list].find(e => e.id === mine[ref]).tag).toBe('BEN_NEW');
    }
  });

  test('K: purchaserList[0] is everyone\'s purchaser (Bruno uses the first entry) — a tester cannot change or remove it', () => {
    const stored = companyFile();
    stored.purchaserList.unshift(stored.purchaserList.splice(stored.purchaserList.findIndex(e => e.id === 32), 1)[0]);  // Ana's first
    const edit = clone(viewForTester(stored, ANA, null));
    edit.purchaserList.find(e => e.id === 32).tag = 'attacker@evil.example';
    expect(mergeTesterSave(stored, edit, ANA).datafile.purchaserList[0]).toEqual({ id: 32, tag: 'ana' });

    const del = clone(viewForTester(stored, ANA, null));
    del.scenarios = del.scenarios.filter(s => s.code !== 'ANA_1');
    expect(mergeTesterSave(stored, del, ANA).datafile.purchaserList[0]).toEqual({ id: 32, tag: 'ana' });
  });

  test('L: a tester cannot newly point her scenario at an entry only hidden scenarios use (it would appear in her view)', () => {
    const stored = companyFile();
    const sent = clone(viewForTester(stored, ANA, null));
    byCode(sent, 'ANA_1').tripRequirementId = 40;             // Ben's trip, which she cannot see
    const r = mergeTesterSave(stored, sent, ANA);
    expect(byCode(r.datafile, 'ANA_1').tripRequirementId).not.toBe(40);
    expect(JSON.stringify(viewForTester(r.datafile, ANA, null))).not.toContain('"ben"');
  });

  test('L: an old link she already had is kept (she could see that entry before this change)', () => {
    const stored = companyFile();
    byCode(stored, 'ANA_1').tripRequirementId = 40;           // legacy aliasing from the old duplicate bug
    const r = mergeTesterSave(stored, clone(viewForTester(stored, ANA, null)), ANA);
    expect(byCode(r.datafile, 'ANA_1').tripRequirementId).toBe(40);
  });

  test('H: a comma-separated company list is pruned like an array when her codes go away', () => {
    const stored = { ...companyFile(), scenariosToRun: 'ANA_1,SHARED_1' };
    const sent = clone(viewForTester(stored, ANA, null));
    sent.scenarios = sent.scenarios.filter(s => s.code !== 'ANA_1');
    const out = mergeTesterSave(stored, sent, ANA).datafile.scenariosToRun;
    expect(resolveRunList(out, codes(companyFile()))).toEqual(['SHARED_1']);
  });
});
