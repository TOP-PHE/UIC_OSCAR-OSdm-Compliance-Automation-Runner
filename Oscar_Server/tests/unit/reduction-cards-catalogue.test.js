// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #887 PR 1: the reduction cards a provider accepts, declared in the Test
 * Framework (or read from its checklist), and the catalogue's card scenarios
 * copied with the first one.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { declaredCards, cardsFromChecklist, passengersWithCard, percentOf, withCardRates } = require('../../src/utils/reductionCards');
const { catalogueFor, catalogueDatafile } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');
const { frameworkFromChecklist } = require('../../src/utils/referenceConfiguration');
const { schemaProblems } = require('../../src/utils/datafileSchema');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
const CODES = ['OTST_SALE_REDUCTION_CARD_1ADT', 'OTST_SALE_REDUCTION_CARD_2ADT'];
const IN25 = { code: '1', issuer: 'urn:uic:rics:1154', name: 'IN 25' };

describe('the cards a framework declares', () => {
  test('each with a code, each code once, trimmed, in order; absent or odd = none', () => {
    expect(declaredCards({ reductionCards: [{ code: ' 1 ', issuer: ' urn:uic:rics:1154 ', name: 'IN 25' }, { code: '' }, null, 'x', { code: '1', name: 'again' }, { code: '18' }] }))
      .toEqual([IN25, { code: '18' }]);
    expect(declaredCards({})).toEqual([]);
    expect(declaredCards({ reductionCards: 'IN 25' })).toEqual([]);
    expect(declaredCards({ config: { reductionCards: [IN25] } })).toEqual([IN25]);
  });

  test('lengths are bounded', () => {
    const [card] = declaredCards({ reductionCards: [{ code: 'C'.repeat(100), issuer: 'I'.repeat(500), name: 'N'.repeat(500) }] });
    expect([card.code.length, card.issuer.length, card.name.length]).toEqual([60, 200, 120]);
  });
});

describe('#889: a card\'s reduction rate', () => {
  test('a number or a text, above 0 and at most 100; anything else is no rate', () => {
    for (const [v, want] of [[25, 25], ['25', 25], ['25 %', 25], [' 12,5% ', 12.5], ['100', 100], ['0.5', 0.5]]) expect(percentOf(v)).toBe(want);
    for (const v of [0, '0', 101, '-5', 'abc', '25 %%', '', null, undefined, Number.NaN, '1e2', '12.555']) expect(percentOf(v)).toBeNull();
  });

  test('declared with the card; a card without a valid one has none', () => {
    expect(declaredCards({ reductionCards: [{ code: '1', percent: '25' }, { code: '2', percent: 'half' }] }))
      .toEqual([{ code: '1', percent: 25 }, { code: '2' }]);
  });

  test('read from A3.7\'s "Reduction %" column', () => {
    expect(cardsFromChecklist({ 'data.reductionCards=YES': true, 'data.card.1.code': '1', 'data.card.1.percent': '25 %', 'data.card.2.code': '18' }))
      .toEqual([{ code: '1', percent: 25 }, { code: '18' }]);
  });

  test('the run\'s copy writes each declared rate on the passengers\' cards of that code; a card\'s own rate stays', () => {
    const fw = { reductionCards: [{ code: '1', issuer: 'urn:uic:rics:1154', percent: 25 }, { code: '2', issuer: 'urn:uic:rics:1154' }] };
    const df = { passengersList: [{ id: 1, passengers: [
      { reference: '00001', reductionCards: ['1', { code: '1', issuer: 'urn:other' }, { code: '1', issuer: 'urn:uic:rics:1154', number: '7' }, { code: '1', percent: 30 }, '2', 'X'] },
      { reference: '00002' }, null,
    ] }, null] };
    expect(withCardRates(df, fw)).toBe(2);
    expect(df.passengersList[0].passengers[0].reductionCards).toEqual([
      { code: '1', percent: 25 }, { code: '1', issuer: 'urn:other' }, { code: '1', issuer: 'urn:uic:rics:1154', number: '7', percent: 25 },
      { code: '1', percent: 30 }, '2', 'X',
    ]);
    expect(withCardRates({ passengersList: [] }, { reductionCards: [{ code: '1' }] })).toBe(0);
    expect(withCardRates(null, fw)).toBe(0);
  });
});

describe('a checklist\'s A3.7', () => {
  const ČD = {
    'data.reductionCards=YES': true,
    'data.card.1.code': '1', 'data.card.1.issuer': 'urn:uic:rics:1154', 'data.card.1.name': 'IN 25',
    'data.card.2.code': '2', 'data.card.2.issuer': 'urn:uic:rics:1154', 'data.card.2.name': 'IN 50',
    'data.card.10.code': '1001', 'data.card.10.name': 'Interrail Global Pass',
    'data.card.3.name': 'a row without a code',
  };

  test('YES: the table\'s rows by number; NO: none; no tick: nothing to say', () => {
    expect(cardsFromChecklist(ČD).map((c) => c.code)).toEqual(['1', '2', '1001']);
    expect(cardsFromChecklist({ 'data.reductionCards=NO': true, 'data.card.1.code': '1' })).toEqual([]);
    expect(cardsFromChecklist({ 'data.card.1.code': '1' })).toBeNull();
    expect(cardsFromChecklist(null)).toBeNull();
  });

  test('an import puts them in the framework; no answer keeps what it had', () => {
    expect(frameworkFromChecklist(ČD).reductionCards[0]).toEqual(IN25);
    const base = { reductionCards: [{ code: 'KEPT' }] };
    expect(frameworkFromChecklist({}, { base }).reductionCards).toEqual([{ code: 'KEPT' }]);
    expect(frameworkFromChecklist({ 'data.reductionCards=NO': true }, { base }).reductionCards).toEqual([]);
  });
});

describe('the passengers of a card scenario\'s copy', () => {
  test('the holder takes the card (code and issuer), the others are left alone; the source is not changed', () => {
    const source = [{ reference: '00001', reductionCards: ['SIM_CARD_50'] }, { reference: '00002', reductionCards: null }];
    const copy = passengersWithCard(source, IN25);
    expect(copy).toEqual([{ reference: '00001', reductionCards: [{ code: '1', issuer: 'urn:uic:rics:1154' }] }, { reference: '00002', reductionCards: null }]);
    expect(source[0].reductionCards).toEqual(['SIM_CARD_50']);
    expect(passengersWithCard(source, { code: 'X' })[0].reductionCards).toEqual([{ code: 'X' }]);
  });
});

describe('the catalogue\'s card scenarios', () => {
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const entries = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => CODES.includes(e.code));

  test('two entries, from the simulator\'s card scenarios; not copiable without a declared card', () => {
    const found = entries(FW);
    expect(found.map((e) => e.code)).toEqual(CODES);
    for (const e of found) {
      expect(e.limit).toBe('REDUCTION_CARDS');
      expect(e.missing).toEqual(['a reduction card the provider accepts (Passenger Types › Reduction cards)']);
      expect(e.needsText[0]).toBe('the first reduction card the Test Framework declares, on the passenger holding a card');
    }
    expect(entries({ ...FW, reductionCards: [IN25] }).every((e) => e.missing.length === 0)).toBe(true);
  });

  test('the copy gives the holder the first declared card, in a list of its own; nothing left to check about the card', () => {
    const fw = { ...FW, reductionCards: [IN25, { code: '2' }] };
    const all = catalogueFor(catalogue, simulator, fw);
    const source = catalogueDatafile(catalogue, simulator);
    const { datafile, notes } = adaptCatalogueDatafile(source, all, fw);
    const listOf = (code) => {
      const sc = datafile.scenarios.find((s) => s.code === code);
      return datafile.passengersList.find((l) => l.id === sc.passengersListId).passengers;
    };
    expect(listOf(CODES[0]).map((p) => p.reductionCards)).toEqual([[{ code: '1', issuer: 'urn:uic:rics:1154' }]]);
    expect(listOf(CODES[1]).map((p) => p.reductionCards ?? null)).toEqual([[{ code: '1', issuer: 'urn:uic:rics:1154' }], null]);
    const own = datafile.scenarios.find((s) => s.code === CODES[0]).passengersListId;
    expect(source.passengersList.some((l) => l.id === own)).toBe(false);
    for (const code of CODES) expect(notes[code].toCheck.join(' ')).not.toMatch(/reduction card/);
    const schema = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
  });
});

describe('the Test Framework page', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8');
  const lift = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)) + 3);
  const consts = src.slice(src.indexOf('const FW_CARD_FIELDS'), src.indexOf('};\n', src.indexOf('const FW_LISTS')) + 3);

  const page = () => {
    const ctx = { wizData: { framework: {} }, saves: 0, renders: 0 };
    ctx.esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    ctx.saveFrameworkDebounced = () => { ctx.saves += 1; };
    ctx.renderWizardStep1InSection = () => { ctx.renders += 1; };
    vm.createContext(ctx);
    const fns = ['fwListFieldHtml', 'fwListRowHtml', 'fwListHtml', 'fwReductionCardsHtml', 'fwProductsHtml', 'fwListOf', 'clickFwList', 'changeFwList'].map(lift).join('\n');
    vm.runInContext(`${consts}\n${fns}\nthis.html = fwReductionCardsHtml; this.products = fwProductsHtml; this.click = clickFwList; this.change = changeFwList;`, ctx);
    return ctx;
  };

  test('each field is labelled and its value escaped; none declared says so', () => {
    const ctx = page();
    const html = ctx.html({ reductionCards: [{ code: '1', issuer: 'urn:uic:rics:1154', name: 'IN "25" <b>' }] });
    for (const f of ['code', 'issuer', 'name', 'percent']) expect(html).toContain(`<label for="fw-card-0-${f}"`);
    expect(html).toContain('value="IN &quot;25&quot; &lt;b&gt;"');
    expect(ctx.html({})).toContain('None declared');
  });

  test('add, edit, remove; an odd index or field changes nothing', () => {
    const ctx = page();
    expect(ctx.click('fw-card-add', {})).toBe(true);
    expect(ctx.change('fw-card-field', { dataset: { index: '0', field: 'code' }, value: ' 1 ' })).toBe(true);
    ctx.change('fw-card-field', { dataset: { index: '0', field: 'percent' }, value: ' 25 ' });
    expect(ctx.wizData.framework.reductionCards).toEqual([{ code: '1', issuer: '', name: '', percent: '25' }]);
    ctx.change('fw-card-field', { dataset: { index: '0', field: '__proto__' }, value: 'x' });
    ctx.change('fw-card-field', { dataset: { index: '5', field: 'code' }, value: 'x' });
    ctx.click('fw-card-remove', { dataset: { index: 'NaN' } });
    expect(ctx.wizData.framework.reductionCards).toEqual([{ code: '1', issuer: '', name: '', percent: '25' }]);
    ctx.click('fw-card-remove', { dataset: { index: '0' } });
    expect(ctx.wizData.framework.reductionCards).toEqual([]);
    expect(ctx.click('fw-other', {})).toBe(false);
    expect(ctx.change('fw-other', {})).toBe(false);
    expect([ctx.saves, ctx.renders]).toEqual([4, 2]);
  });

  test('wired: drawn under Passenger Types, the click before the switch, the change in the chain', () => {
    expect(src).toContain('${fwReductionCardsHtml(fw)}');
    expect(src).toContain("if (clickFwList(action, el)) return;");
    expect(src).toContain('changePassengerUpdate(action, el) || changeFwList(action, el)');
  });
});
