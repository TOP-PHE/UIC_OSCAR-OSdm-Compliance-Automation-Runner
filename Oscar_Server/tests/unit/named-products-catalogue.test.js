// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #887 PR 2: the products a provider sells, declared in the Test Framework
 * (or read from its checklist), and the catalogue's named-product scenario
 * copied with the first one.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { flexibilityOf, declaredProducts, productsFromChecklist } = require('../../src/utils/namedProducts');
const { catalogueFor, catalogueDatafile } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile } = require('../../src/utils/catalogueMatch');
const { frameworkFromChecklist } = require('../../src/utils/referenceConfiguration');
const { schemaProblems } = require('../../src/utils/datafileSchema');

const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
const CODE = 'OTST_SALE_NAMED_PRODUCT_1ADT';
const SAVER = { code: '1_FLEXI_ZV', name: 'Flexi zvýhodněná', flexibility: 'FULL_FLEXIBLE' };

describe('the products a framework declares', () => {
  test('each with a code, each code once, trimmed, in order; absent or odd = none', () => {
    expect(declaredProducts({ products: [{ code: ' 1_FLEXI_ZV ', name: ' Flexi zvýhodněná ', flexibility: 'full flexible' }, { code: '' }, null, 'x', { code: '1_FLEXI_ZV', name: 'again' }, { code: 'P2', flexibility: 'cheap' }] }))
      .toEqual([SAVER, { code: 'P2' }]);
    expect(declaredProducts({})).toEqual([]);
    expect(declaredProducts({ products: 'P1' })).toEqual([]);
    expect(declaredProducts({ config: { products: [SAVER] } })).toEqual([SAVER]);
  });

  test('a flexibility in any spelling of the three OSDM ones; anything else is none', () => {
    for (const [v, want] of [['FULL_FLEXIBLE', 'FULL_FLEXIBLE'], ['semi flexible', 'SEMI_FLEXIBLE'], ['Non-flexible', 'NON_FLEXIBLE']]) expect(flexibilityOf(v)).toBe(want);
    for (const v of ['', 'FLEXIBLE', null, 3]) expect(flexibilityOf(v)).toBeNull();
  });

  test('lengths are bounded', () => {
    const [p] = declaredProducts({ products: [{ code: 'C'.repeat(100), name: 'N'.repeat(500) }] });
    expect([p.code.length, p.name.length]).toEqual([60, 120]);
  });
});

describe('a checklist\'s A4.18', () => {
  const answers = {
    'data.products=YES': true,
    'data.product.1.code': '1_FLEXI_ZV', 'data.product.1.name': 'Flexi zvýhodněná', 'data.product.1.flexibility': 'FULL_FLEXIBLE',
    'data.product.10.code': 'P10',
    'data.product.2.name': 'a row without a code',
  };

  test('YES: the table\'s rows by number; NO: none; no tick: nothing to say', () => {
    expect(productsFromChecklist(answers)).toEqual([SAVER, { code: 'P10' }]);
    expect(productsFromChecklist({ 'data.products=NO': true, 'data.product.1.code': 'P' })).toEqual([]);
    expect(productsFromChecklist({ 'data.product.1.code': 'P' })).toBeNull();
    expect(productsFromChecklist(null)).toBeNull();
  });

  test('an import puts them in the framework; no answer keeps what it had', () => {
    expect(frameworkFromChecklist(answers).products[0]).toEqual(SAVER);
    const base = { products: [{ code: 'KEPT' }] };
    expect(frameworkFromChecklist({}, { base }).products).toEqual([{ code: 'KEPT' }]);
    expect(frameworkFromChecklist({ 'data.products=NO': true }, { base }).products).toEqual([]);
  });
});

describe('the catalogue\'s named-product scenario', () => {
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const entry = (fw) => catalogueFor(catalogue, simulator, fw).find((e) => e.code === CODE);

  test('one entry, from the simulator\'s product scenario; not copiable without a declared product', () => {
    const e = entry(FW);
    expect(e.limit).toBe('NAMED_PRODUCTS');
    expect(e.missing).toEqual(['a product the provider sells (Tariff Flexibility › Products)']);
    expect(e.needsText).toEqual(['the first product the Test Framework declares, by its code, in its flexibility', '1 passenger']);
    expect(entry({ ...FW, products: [SAVER] }).missing).toEqual([]);
  });

  const copy = (fw) => {
    const all = catalogueFor(catalogue, simulator, fw);
    const { datafile, notes } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), all, fw);
    return { scenario: datafile.scenarios.find((s) => s.code === CODE), note: notes[CODE], datafile };
  };

  test('the copy sells the first declared product by its code, in its flexibility; nothing left to complete about it', () => {
    const { scenario, note, datafile } = copy({ ...FW, products: [SAVER, { code: 'P2', flexibility: 'NON_FLEXIBLE' }] });
    expect([scenario.expectedProduct, scenario.desiredFlexibility]).toEqual(['1_FLEXI_ZV', 'FULL_FLEXIBLE']);
    expect(note.toComplete.join(' ')).not.toMatch(/expectedProduct/);
    const schema = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
  });

  test('a product without flexibility keeps the scenario\'s own; none declared leaves the product to complete', () => {
    expect(copy({ ...FW, products: [{ code: 'P1' }] }).scenario.desiredFlexibility).toBe('NON_FLEXIBLE');
    const { scenario, note } = copy(FW);
    expect(scenario.expectedProduct).toBeUndefined();
    expect(note.toComplete).toContain('the provider\'s product (expectedProduct)');
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
    const fns = ['fwListFieldHtml', 'fwListRowHtml', 'fwListHtml', 'fwProductsHtml', 'fwListOf', 'clickFwList', 'changeFwList'].map(lift).join('\n');
    vm.runInContext(`${consts}\n${fns}\nthis.html = fwProductsHtml; this.click = clickFwList; this.change = changeFwList;`, ctx);
    return ctx;
  };

  test('each field labelled and its value escaped; none declared says so', () => {
    const ctx = page();
    const html = ctx.html({ products: [{ code: 'P<1>', name: 'Saver', flexibility: 'NON_FLEXIBLE' }] });
    for (const f of ['code', 'name', 'flexibility']) expect(html).toContain(`<label for="fw-product-0-${f}"`);
    expect(html).toContain('value="P&lt;1&gt;"');
    expect(html).toContain('data-action="fw-product-remove"');
    expect(ctx.html({})).toContain('None declared');
  });

  test('add, edit, remove a product; the cards are left alone', () => {
    const ctx = page();
    ctx.wizData.framework.reductionCards = [{ code: '1' }];
    expect(ctx.click('fw-product-add', {})).toBe(true);
    expect(ctx.change('fw-product-field', { dataset: { index: '0', field: 'code' }, value: ' P1 ' })).toBe(true);
    ctx.change('fw-product-field', { dataset: { index: '0', field: 'percent' }, value: '25' });
    expect(ctx.wizData.framework.products).toEqual([{ code: 'P1', name: '', flexibility: '' }]);
    ctx.click('fw-product-remove', { dataset: { index: '0' } });
    expect(ctx.wizData.framework.products).toEqual([]);
    expect(ctx.wizData.framework.reductionCards).toEqual([{ code: '1' }]);
    expect(ctx.click('fw-product-other', {})).toBe(false);
  });

  test('drawn in Tariff Flexibility, under the sales horizon', () => {
    expect(src.indexOf('${fwProductsHtml(fw)}')).toBeGreaterThan(src.indexOf('id="fw-sales-horizon"'));
  });
});
