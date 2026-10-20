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

// ── PR 3: group products ────────────────────────────────────────────────────

const { declaredGroupProducts, groupProductsFromChecklist, sizeOf } = require('../../src/utils/namedProducts');
const GROUP = { code: 'SKUP', name: 'Skupinová', flexibility: 'FULL_FLEXIBLE', minPassengers: 2, maxPassengers: 19 };

describe('the group products a framework declares', () => {
  test('a product plus the group sizes it takes; a size outside 1–99 or a maximum below the minimum is left out', () => {
    expect(declaredGroupProducts({ groupProducts: [{ ...GROUP, minPassengers: '2', maxPassengers: ' 19 ' }, { code: 'G2', min: 5, max: 3 }, { code: 'G3', min: 0, max: 100 }, { code: 'SKUP' }] }))
      .toEqual([GROUP, { code: 'G2', minPassengers: 5 }, { code: 'G3' }]);
    for (const [v, want] of [[1, 1], ['99', 99], [0, null], ['1.5', null], [100, null], [null, null]]) expect(sizeOf(v)).toBe(want);
  });

  test('read from A4.19; NO = none; no answer keeps what the framework had', () => {
    const answers = { 'data.groupProducts=YES': true, 'data.groupProduct.1.code': 'SKUP', 'data.groupProduct.1.name': 'Skupinová', 'data.groupProduct.1.flexibility': 'full flexible', 'data.groupProduct.1.min': '2', 'data.groupProduct.1.max': '19', 'data.groupProduct.1.other': 'x' };
    expect(groupProductsFromChecklist(answers)).toEqual([GROUP]);
    expect(groupProductsFromChecklist({ 'data.groupProducts=NO': true })).toEqual([]);
    expect(groupProductsFromChecklist({})).toBeNull();
    expect(frameworkFromChecklist(answers).groupProducts).toEqual([GROUP]);
    expect(frameworkFromChecklist({}, { base: { groupProducts: [{ code: 'KEPT' }] } }).groupProducts).toEqual([{ code: 'KEPT' }]);
  });
});

describe('the catalogue\'s group scenarios', () => {
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const CODES = ['OTST_SALE_GROUP_TARIFF', 'NHF_SALE_GROUP_TOO_LARGE'];
  const entries = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => CODES.includes(e.code));
  const copy = (fw) => {
    const all = catalogueFor(catalogue, simulator, fw);
    const { datafile, notes } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), all, fw);
    const of = (code) => {
      const scenario = datafile.scenarios.find((s) => s.code === code);
      const passengers = datafile.passengersList.find((l) => l.id === scenario.passengersListId).passengers;
      return { scenario, passengers, note: notes[code] };
    };
    return { of, datafile };
  };

  test('not copiable without a group product; the too-large one needs a maximum', () => {
    const [sale, over] = entries(FW);
    expect([sale.limit, over.limit, over.kind]).toEqual(['GROUP_TARIFF', 'OVER_GROUP_SIZE', 'NHF']);
    expect(sale.missing).toEqual(['a group product the provider sells (Tariff Flexibility › Group products)']);
    expect(entries({ ...FW, groupProducts: [{ code: 'G' }] }).map((e) => e.missing)).toEqual([[], ['a group product with its maximum group size (Tariff Flexibility › Group products)']]);
    expect(entries({ ...FW, groupProducts: [GROUP] }).every((e) => e.missing.length === 0)).toBe(true);
    expect(over.needsText[0]).toMatch(/^one passenger more than the maximum/);
  });

  test('the sale: the first group product by its code, a group of its sizes; the probe: its maximum plus one, product absent', () => {
    const { of, datafile } = copy({ ...FW, groupProducts: [{ code: 'G', flexibility: 'NON_FLEXIBLE', minPassengers: 8 }, GROUP] });
    const sale = of('OTST_SALE_GROUP_TARIFF');
    expect([sale.scenario.expectedProduct, sale.scenario.desiredFlexibility, sale.passengers.length]).toEqual(['G', 'NON_FLEXIBLE', 8]);
    expect(sale.note.toComplete.join(' ')).not.toMatch(/expectedProduct/);
    const over = of('NHF_SALE_GROUP_TOO_LARGE');
    expect([over.scenario.expectedProduct, over.scenario.expectedProductAbsent, over.passengers.length]).toEqual(['SKUP', 'on', 20]);
    expect(new Set(over.passengers.map((p) => p.reference)).size).toBe(20);
    const schema = JSON.parse(fs.readFileSync(path.join(DATA, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
    expect(copy({ ...FW, groupProducts: [{ code: 'G', maxPassengers: 4 }] }).of('OTST_SALE_GROUP_TARIFF').passengers).toHaveLength(4);
    expect(copy({ ...FW, groupProducts: [{ code: 'G' }] }).of('OTST_SALE_GROUP_TARIFF').passengers).toHaveLength(6);
  });

  test('the page draws the group list in Tariff Flexibility', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8');
    expect(src.indexOf('${fwGroupProductsHtml(fw)}')).toBeGreaterThan(src.indexOf('${fwProductsHtml(fw)}'));
    expect(src).toContain("group: { key: 'groupProducts', fields: FW_GROUP_FIELDS, noun: 'group product' }");
  });
});
