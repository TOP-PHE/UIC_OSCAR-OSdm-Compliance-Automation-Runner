// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * currencies.test.js — #781: the currencies a provider sells in, declared in
 * the Test Framework, tested by the catalogue, and kept by a sale through the
 * booking, the refund and the exchange.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { currenciesOf, currencyDeclared, currencyNotSold, NOT_SOLD_CANDIDATES } = require('../../src/utils/currencies');
const { annotateDatafile } = require('../../src/utils/frameworkGating');
const { catalogueFor } = require('../../src/utils/scenarioCatalogue');
const { withCurrencies } = require('../../src/utils/catalogueMatch');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
const DATA = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'data_base');
const lib = require(path.join(LIB, 'currencies.js'));
const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));

const price = (amount, currency) => ({ amount, currency, scale: 2 });
const offer = (id, currency) => ({ offerId: id, offerSummary: { minimalPrice: price(100, currency) }, admissionOfferParts: [{ price: price(100, currency) }] });

describe('#781 the declared currencies (server)', () => {
  test('sold and default: codes only, once each, the default always among those sold', () => {
    expect(currenciesOf({ currencies: { sold: ['EUR', 'eur', 'EUR', 'CZK', 7], default: 'CHF' } })).toEqual({ sold: ['CHF', 'EUR', 'CZK'], default: 'CHF' });
    expect(currenciesOf({})).toEqual({ sold: [], default: null });
    expect(currenciesOf({ currencies: { default: 'EURO' } })).toEqual({ sold: [], default: null });
  });

  test('nothing declared accepts every currency; a list accepts its own', () => {
    expect(currencyDeclared({}, 'USD')).toBe(true);
    expect(currencyDeclared({ currencies: { sold: ['EUR'] } }, 'USD')).toBe(false);
    expect(currencyDeclared({ currencies: { sold: ['EUR'] } }, 'EUR')).toBe(true);
  });

  test('the not-sold probe takes the first common currency not declared', () => {
    expect(currencyNotSold({})).toBeNull();
    expect(currencyNotSold({ currencies: { sold: ['EUR'] } })).toBe('USD');
    expect(currencyNotSold({ currencies: { sold: ['USD', 'JPY'] } })).toBe('GBP');
    expect(currencyNotSold({ currencies: { sold: NOT_SOLD_CANDIDATES } })).toBeNull();
  });

  test('a scenario asking for an undeclared currency is warned, the not-sold probe is not', () => {
    const datafile = {
      scenarios: [
        { code: 'A', offerSearchCriteria: { currency: 'USD' } },
        { code: 'B', offerSearchCriteria: { currency: 'EUR' } },
        { code: 'C', offerSearchCriteria: { currency: 'USD' }, currencyExpectRejection: 'on' },
        { code: 'D', offerSearchCriteriaListId: 1 },
      ],
      offerSearchCriteriaList: [{ id: 1, offerSearchCriteria: [{ currency: 'JPY' }] }],
    };
    annotateDatafile(datafile, { currencies: { sold: ['EUR'] } });
    const warned = (code) => (datafile.scenarios.find((s) => s.code === code).__featureNotDeclaredWarnings || []).filter((w) => w.startsWith('currency:'));
    expect([warned('A'), warned('B'), warned('C'), warned('D')]).toEqual([['currency:USD'], [], [], ['currency:JPY']]);
    annotateDatafile(datafile, {});
    expect(warned('A')).toEqual([]);
  });
});

describe('#781 the catalogue\'s currency entries', () => {
  const codes = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => /CURRENCY/.test(e.code));
  const fw = { salesFlows: ['SALE', 'REFUND_FULL', 'EXCHANGE_FULL'] };

  test('nothing declared: each entry listed once, not copiable', () => {
    const entries = codes(fw);
    expect(entries.map((e) => e.code)).toEqual(['OTST_SALE_CURRENCY', 'OTST_EXCHANGE_CURRENCY', 'OTST_SALE_DEFAULT_CURRENCY', 'NHF_CURRENCY_NOT_SOLD']);
    for (const e of entries) expect(e.missing.some((m) => /currenc/i.test(m))).toBe(true);
  });

  test('declared: one sale and one exchange per currency, the default, and a currency not sold', () => {
    const entries = codes({ ...fw, currencies: { sold: ['EUR', 'CZK'], default: 'CZK' } });
    expect(entries.map((e) => [e.code, e.currencyOf || e.expectedCurrencyOf, !!e.notSold])).toEqual([
      ['OTST_SALE_CURRENCY_EUR', 'EUR', false],
      ['OTST_SALE_CURRENCY_CZK', 'CZK', false],
      ['OTST_EXCHANGE_CURRENCY_EUR', 'EUR', false],
      ['OTST_EXCHANGE_CURRENCY_CZK', 'CZK', false],
      ['OTST_SALE_DEFAULT_CURRENCY', 'CZK', false],
      ['NHF_CURRENCY_NOT_SOLD', 'USD', true],
    ]);
    for (const e of entries) expect(e.missing.filter((m) => /currenc/i.test(m))).toEqual([]);
  });

  test('the copies ask for the currency, ask none and expect the default, or arm the probe', () => {
    const datafile = { scenarios: [
      { code: 'OTST_SALE_CURRENCY', offerSearchCriteria: { currency: 'EUR', returnOffsetDays: 3 } },
      { code: 'OTST_SALE_DEFAULT_CURRENCY', offerSearchCriteria: { currency: 'EUR' } },
      { code: 'NHF_CURRENCY_NOT_SOLD', offerSearchCriteria: { currency: 'USD' } },
      { code: 'OTHER' },
    ] };
    const entries = [
      { code: 'OTST_SALE_CURRENCY_CZK', variantOf: 'OTST_SALE_CURRENCY', currencyOf: 'CZK', purpose: 'p' },
      { code: 'OTST_SALE_DEFAULT_CURRENCY', expectedCurrencyOf: 'CZK' },
      { code: 'NHF_CURRENCY_NOT_SOLD', currencyOf: 'GBP', notSold: true },
    ];
    const out = withCurrencies(datafile, entries).scenarios;
    expect(out.map((s) => [s.code, s.offerSearchCriteria?.currency, s.expectedCurrency, s.currencyExpectRejection])).toEqual([
      ['OTST_SALE_CURRENCY_CZK', 'CZK', undefined, undefined],
      ['OTST_SALE_DEFAULT_CURRENCY', undefined, 'CZK', undefined],
      ['NHF_CURRENCY_NOT_SOLD', 'GBP', undefined, 'on'],
      ['OTHER', undefined, undefined, undefined],
    ]);
    expect(out[0].offerSearchCriteria.returnOffsetDays).toBe(3);
    expect(datafile.scenarios[0].offerSearchCriteria.currency).toBe('EUR');
    expect(withCurrencies(datafile, [])).toBe(datafile);
  });
});

describe('#781 the Test Framework page', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };

  test('a list typed is stored as codes, the default added to it; a wrong word changes nothing', () => {
    const wizData = { framework: {} };
    const set = lift('fwSetCurrencies', { wizData });
    expect(set('sold', 'eur, chf;EUR')).toBe(true);
    expect(wizData.framework.currencies).toEqual({ sold: ['EUR', 'CHF'] });
    expect(set('default', 'czk')).toBe(true);
    expect(wizData.framework.currencies).toEqual({ sold: ['CZK', 'EUR', 'CHF'], default: 'CZK' });
    expect(set('sold', 'EUR, EURO')).toBe(false);
    expect(set('default', 'EUR CHF')).toBe(false);
    expect(wizData.framework.currencies.sold).toEqual(['CZK', 'EUR', 'CHF']);
    expect(set('default', '')).toBe(true);
    expect(set('sold', '')).toBe(true);
    expect(wizData.framework.currencies).toBeUndefined();
  });

  test('the fields are drawn with their values, labelled, and wired', () => {
    const html = lift('currenciesHtml', { esc: (v) => String(v) })({ currencies: { sold: ['EUR', 'CZK'], default: 'CZK' } });
    expect(html).toContain('id="fw-currencies-sold" value="EUR, CZK"');
    expect(html).toContain('id="fw-currencies-default" value="CZK"');
    expect(html).toContain('<label for="fw-currencies-sold"');
    expect(html).toContain('<label for="fw-currencies-default"');
    const page = lines.join('\n');
    expect(page).toContain('${currenciesHtml(fw)}');
    expect(page).toContain("if (action !== 'fw-currencies') return false;");
  });
});

describe('#781 the collection keeps the sale\'s currency', () => {
  test('the offers against the currency expected: all in it, some not (warning), none (failure)', () => {
    const both = { offers: [offer('o1', 'EUR'), offer('o2', 'CZK')] };
    expect(lib.checkOffersCurrency('EUR', { offers: [offer('o1', 'EUR')] })).toEqual([expect.objectContaining({ ok: true, name: 'Offer request: the offers are in EUR (asked)' })]);
    expect(lib.checkOffersCurrency('EUR', both)[0]).toEqual(expect.objectContaining({ ok: false, level: 'warn', message: '1 of 2 offer(s) are priced in another currency (offer o2: CZK)' }));
    expect(lib.checkOffersCurrency('USD', both)[0]).toEqual(expect.objectContaining({ ok: false, level: 'fail' }));
    expect(lib.checkOffersCurrency(null, both)).toEqual([]);
    expect(lib.checkOffersCurrency('EUR', { offers: [] })).toEqual([]);
  });

  test('an after-sale answer in another currency fails; none known or no price checks nothing', () => {
    const refund = { refundableAmount: price(10, 'EUR'), refundFee: price(0, 'CZK') };
    expect(lib.checkAfterSaleCurrency('Refund offer[0]', 'EUR', refund)).toEqual([{
      name: "Refund offer[0]: priced in the sale's currency (EUR)", ok: false, message: 'priced in EUR, CZK; the sale was in EUR',
    }]);
    expect(lib.checkAfterSaleCurrency('x', 'EUR', { refundableAmount: price(10, 'EUR') })[0].ok).toBe(true);
    expect(lib.checkAfterSaleCurrency('x', null, refund)).toEqual([]);
    expect(lib.checkAfterSaleCurrency('x', 'EUR', { id: 'no price' })).toEqual([]);
  });

  test('what a provider did with a currency it does not sell', () => {
    expect(lib.notSoldOutcome(400, { code: 'CURRENCY_NOT_SUPPORTED' }, 'USD')).toBe('refused');
    expect(lib.notSoldOutcome(200, { offers: [] }, 'USD')).toBe('no-offer');
    expect(lib.notSoldOutcome(200, { offers: [offer('o', 'USD')] }, 'USD')).toBe('sold');
    expect(lib.notSoldOutcome(200, { offers: [offer('o', 'EUR')] }, 'USD')).toBe('other');
  });

  test('prices are found anywhere, not other members named currency', () => {
    expect([...lib.currenciesIn({ a: [{ b: price(1, 'EUR') }], currency: 'XXX', c: { amount: 2, currency: 'CZK' } })]).toEqual(['EUR', 'CZK']);
  });

  describe('the glue, with a stand-in Bruno', () => {
    let env;
    let results;
    let logs;
    beforeEach(() => {
      env = {};
      results = [];
      logs = [];
      global.bru = { getEnvVar: (k) => env[k], setEnvVar: (k, v) => { env[k] = v; } };
      global.test = (name, fn) => { try { fn(); results.push({ name, ok: true }); } catch (e) { results.push({ name, ok: false, message: e.message }); } };
      global.validationLogger = (l) => logs.push(l);
    });
    afterEach(() => { delete global.bru; delete global.test; });

    test('step 01: the currency asked, else the scenario\'s default; the sale\'s currency kept', () => {
      env.offerSearchCriteria = JSON.stringify({ currency: 'EUR' });
      lib.checkSaleCurrency({ offers: [offer('o1', 'CZK')] }, offer('o1', 'CZK'));
      expect(results).toEqual([expect.objectContaining({ ok: false, name: 'Offer request: the offers are in EUR (asked)' })]);
      expect(env.__saleCurrency).toBe('CZK');
      results = [];
      env.offerSearchCriteria = '{}';
      env.expectedCurrency = 'CZK';
      lib.checkSaleCurrency({ offers: [offer('o1', 'CZK')] }, offer('o1', 'CZK'));
      expect(results).toEqual([]);
      expect(logs.some((l) => l.includes('✔ Offer request: the offers are in CZK (no currency asked: the default currency)'))).toBe(true);
    });

    test('after-sales are held to the sale\'s currency', () => {
      env.__saleCurrency = 'EUR';
      lib.checkAfterSale('Exchange offer[0]', { exchangePrice: price(5, 'CZK') });
      expect(results).toEqual([expect.objectContaining({ ok: false, name: "Exchange offer[0]: priced in the sale's currency (EUR)" })]);
    });

    test('the not-sold probe: off does nothing; a refusal or no offer passes; offers in it fail; in another, a warning', () => {
      expect(lib.checkCurrencyNotSold(400, {})).toBe(false);
      env.currencyExpectRejection = 'true';
      env.offerSearchCriteria = JSON.stringify({ currency: 'USD' });
      expect(lib.checkCurrencyNotSold(200, { offers: [offer('o', 'USD')] })).toBe(true);
      expect(results).toEqual([expect.objectContaining({ ok: false, name: '🧪 Currency probe [USD, POST /offers]: no offer is sold in USD' })]);
      results = [];
      lib.checkCurrencyNotSold(200, { offers: [offer('o', 'EUR')] });
      expect(results.every((r) => r.ok)).toBe(true);
      expect(logs.some((l) => l.startsWith('[WARNING] 🧪 Currency probe: offers in EUR instead of USD'))).toBe(true);
      results = [];
      lib.checkCurrencyNotSold(200, { offers: [] });
      expect(results).toEqual([expect.objectContaining({ ok: true })]);
      env.offerSearchCriteria = '{}';
      results = [];
      lib.checkCurrencyNotSold(400, {});
      expect(results).toEqual([expect.objectContaining({ ok: false, name: '🧪 Currency probe [no currency, POST /offers]: the request asks for a currency' })]);
    });
  });
});
