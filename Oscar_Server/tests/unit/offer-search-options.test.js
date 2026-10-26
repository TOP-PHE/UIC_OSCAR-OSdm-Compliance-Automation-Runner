// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #780 (PR 1): the Test Framework declares the offer search options a provider
 * takes (offerSearchOptions); a scenario sending a value not declared warns at
 * the run. After 01, the collection says whether the offers keep to each
 * option sent, as warnings.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  OFFER_SEARCH_OPTIONS, scenarioOfferCriteria, offerSearchOptionsOf, offerSearchOptionDeclared, annotateDatafile,
} = require('../../src/utils/frameworkGating');

const LIB = path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'library-bruno');
// offers.js logs through the global validationLogger, which requiring it resets.
const logs = [];
const { askedOptions, admissionProducts, checkOfferCriteria } = require(path.join(LIB, 'offerCriteria.js'));

// An offer as OSDM 3.8 gives it: products on the offer, parts naming them.
function offer(id, { mode = 'INDIVIDUAL', flexibility = 'FULL_FLEXIBLE', travelClass = 'SECOND', service = 'STANDARD', reservation = false, tags = [], type = 'ADMISSION_POINT2POINT' } = {}) {
  const products = [{ id: `${id}-A`, type, flexibility, travelClass, serviceClass: { type: service }, productTags: tags }];
  const o = {
    offerId: id,
    products,
    admissionOfferParts: [{ id: `${id}-AP`, offerMode: mode, products: [{ productId: `${id}-A` }] }],
  };
  if (reservation) {
    products.push({ id: `${id}-R`, type: 'RESERVATION', flexibility: 'NON_FLEXIBLE', travelClass: 'FIRST', serviceClass: { type: 'HIGH' } });
    o.reservationOfferParts = [{ id: `${id}-RP`, offerMode: 'COLLECTIVE', products: [{ productId: `${id}-R` }] }];
  }
  return o;
}
const byName = (checks) => Object.fromEntries(checks.map((c) => [c.name.replace(/^Offer request: the offers keep to the /, '').replace(/ asked.*$/, ''), c]));

describe('collection: askedOptions', () => {
  test('only what the request carried; ALL, FARE_* and ANY_CLASS ask for nothing to check', () => {
    expect(askedOptions({ offerMode: ' COLLECTIVE ', requestedOfferParts: ['ADMISSION', 'ALL', 'FARE_ADMISSION'], travelClasses: ['ANY_CLASS'], serviceClassTypes: ['HIGH', 'ANY_CLASS'], flexibilities: [], productTags: ['RESERVATION', ''] })).toEqual({
      offerMode: ['COLLECTIVE'], requestedOfferParts: ['ADMISSION'], flexibilities: [], travelClasses: [], serviceClassTypes: ['HIGH'], productTags: ['RESERVATION'],
    });
    expect(askedOptions(null)).toEqual({ offerMode: [], requestedOfferParts: [], flexibilities: [], travelClasses: [], serviceClassTypes: [], productTags: [] });
  });
});

describe('collection: checkOfferCriteria', () => {
  test('offers that keep to every option: one passing check per option sent', () => {
    const checks = checkOfferCriteria(
      { offerMode: 'INDIVIDUAL', requestedOfferParts: ['ADMISSION', 'RESERVATION'], flexibilities: ['FULL_FLEXIBLE'], travelClasses: ['SECOND'], serviceClassTypes: ['STANDARD'], productTags: ['ADMISSION_POINT2POINT'] },
      { offers: [offer('o1', { reservation: true }), offer('o2')] },
    );
    expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual([
      ['Offer request: the offers keep to the offer mode asked (INDIVIDUAL)', true, 'info'],
      ['Offer request: the offers keep to the offer parts asked (ADMISSION, RESERVATION)', true, 'info'],
      ['Offer request: the offers keep to the flexibilities asked (FULL_FLEXIBLE)', true, 'info'],
      ['Offer request: the offers keep to the travel classes asked (SECOND)', true, 'info'],
      ['Offer request: the offers keep to the service classes asked (STANDARD)', true, 'info'],
      ['Offer request: the offers keep to the product tags asked (ADMISSION_POINT2POINT)', true, 'info'],
    ]);
  });

  test('a reservation sold with the admission says nothing of the tariff, class or mode asked', () => {
    // The reservation is NON_FLEXIBLE, FIRST, HIGH and COLLECTIVE: none of it counts.
    const checks = checkOfferCriteria({ offerMode: 'INDIVIDUAL', flexibilities: ['FULL_FLEXIBLE'], travelClasses: ['SECOND'], serviceClassTypes: ['STANDARD'] }, { offers: [offer('o1', { reservation: true })] });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  test('offers that do not keep to an option: named, a warning when none does, INFO when some do', () => {
    const response = { offers: [offer('o1', { mode: 'COLLECTIVE', flexibility: 'NON_FLEXIBLE', travelClass: 'FIRST', service: 'HIGH', reservation: true }), offer('o2')] };
    const c = byName(checkOfferCriteria({ offerMode: 'INDIVIDUAL', requestedOfferParts: ['ADMISSION'], flexibilities: ['FULL_FLEXIBLE'], travelClasses: ['SECOND'], serviceClassTypes: ['STANDARD'], productTags: ['UPGRADE_POINT2POINT'] }, response));
    expect(c['offer mode'].message).toBe('1 of 2 offer(s) do not (offer o1: COLLECTIVE)');
    expect(c['offer parts'].ok).toBe(true);
    expect(c.flexibilities.message).toBe('1 of 2 offer(s) do not (offer o1: NON_FLEXIBLE)');
    expect(c['travel classes'].message).toBe('1 of 2 offer(s) do not (offer o1: FIRST)');
    expect(c['service classes'].message).toBe('1 of 2 offer(s) do not (offer o1: HIGH)');
    expect(c['product tags'].message).toBe('2 of 2 offer(s) do not (offer o1: no product tagged so; offer o2: no product tagged so)');
    expect(Object.entries(c).filter(([k]) => k !== 'offer parts').map(([k, x]) => [k, x.ok, x.level])).toEqual([
      ['offer mode', false, 'info'], ['flexibilities', false, 'info'], ['travel classes', false, 'info'], ['service classes', false, 'info'], ['product tags', false, 'warn'],
    ]);
  });

  test('offer parts: a reservation sold with an admission is part of it; otherwise every part kind must be asked', () => {
    const reservationOnly = { offerId: 'r', reservationOfferParts: [{ id: 'rp' }] };
    const withReservation = offer('o1', { reservation: true });
    expect(checkOfferCriteria({ requestedOfferParts: ['ADMISSION'] }, { offers: [withReservation] })[0].ok).toBe(true);
    expect(checkOfferCriteria({ requestedOfferParts: ['ADMISSION'] }, { offers: [reservationOnly] })[0].message).toBe('1 of 1 offer(s) do not (offer r: RESERVATION)');
    expect(checkOfferCriteria({ requestedOfferParts: ['RESERVATION'] }, { offers: [withReservation, reservationOnly] })[0].message).toBe('1 of 2 offer(s) do not (offer o1: ADMISSION, RESERVATION)');
  });

  test('a product tag or a product type asked: one product carrying it is enough', () => {
    const response = { offers: [offer('o1', { tags: ['SPLIT_RESERVATION'] }), offer('o2', { type: 'UPGRADE_POINT2POINT' })] };
    expect(checkOfferCriteria({ productTags: ['SPLIT_RESERVATION', 'UPGRADE_POINT2POINT'] }, response)[0].ok).toBe(true);
  });

  test('more than three offers off: three named, then an ellipsis', () => {
    const offers = ['a', 'b', 'c', 'd'].map((id) => offer(id, { travelClass: 'FIRST' }));
    expect(checkOfferCriteria({ travelClasses: ['SECOND'] }, { offers })[0].message).toBe('4 of 4 offer(s) do not (offer a: FIRST; offer b: FIRST; offer c: FIRST; …)');
  });

  test('an option the provider says it ignored is a warning saying so', () => {
    const [c] = checkOfferCriteria({ serviceClassTypes: ['HIGH'] }, { offers: [offer('o1')] }, ['serviceclasstypes']);
    expect(c).toEqual({ name: 'Offer request: the offers keep to the service classes asked (HIGH)', ok: false, level: 'warn', message: 'the provider says it ignored offerSearchCriteria.serviceClassTypes (PARAMETER_NOT_SUPPORTED): not supported' });
  });

  test('nothing asked, no offer, or an offer that says nothing: no warning', () => {
    expect(checkOfferCriteria({}, { offers: [offer('o1')] })).toEqual([]);
    expect(checkOfferCriteria({ travelClasses: ['SECOND'] }, { offers: [] })).toEqual([]);
    expect(checkOfferCriteria({ travelClasses: ['SECOND'] }, null)).toEqual([]);
    expect(checkOfferCriteria({ travelClasses: ['SECOND'], offerMode: 'INDIVIDUAL' }, { offers: [{ offerId: 'x' }] }).every((c) => c.ok)).toBe(true);
  });

  test('admission products: by productId, by summaryProductId, else every product', () => {
    expect(admissionProducts(offer('o1', { reservation: true })).map((p) => p.id)).toEqual(['o1-A']);
    expect(admissionProducts({ products: [{ id: 'p1' }, { id: 'p2' }], admissionOfferParts: [{ summaryProductId: 'p2' }] }).map((p) => p.id)).toEqual(['p2']);
    expect(admissionProducts({ products: [{ id: 'p1' }], admissionOfferParts: [{}] }).map((p) => p.id)).toEqual(['p1']);
    expect(admissionProducts({})).toEqual([]);
  });
});

describe('collection: after 01', () => {
  test('checkOfferSearchCriteria reads the request sent and logs a line per option', () => {
    global.bru = { getEnvVar: (k) => (k === 'offerSearchCriteria' ? JSON.stringify({ travelClasses: ['SECOND'], offerMode: 'INDIVIDUAL', serviceClassTypes: ['STANDARD'], flexibilities: ['FULL_FLEXIBLE'] }) : undefined), setEnvVar: () => {} };
    logs.length = 0;
    try {
      const offers = require(path.join(LIB, 'offers.js'));
      global.validationLogger = (line) => { logs.push(line); };
      offers.checkOfferSearchCriteria({
        offers: [offer('o1', { travelClass: 'FIRST' }), offer('o2', { travelClass: 'FIRST', service: 'HIGH' })],
        problems: [{ code: 'PARAMETER_NOT_SUPPORTED', title: "Parameter 'offerSearchCriteria.offerMode' was ignored." }],
      });
    } finally { delete global.bru; }
    expect(logs).toEqual([
      '[WARNING] Offer request: the offers keep to the offer mode asked (INDIVIDUAL) — the provider says it ignored offerSearchCriteria.offerMode (PARAMETER_NOT_SUPPORTED): not supported',
      '[INFO] ✔ Offer request: the offers keep to the flexibilities asked (FULL_FLEXIBLE)',
      '[WARNING] Offer request: the offers keep to the travel classes asked (SECOND) — 2 of 2 offer(s) do not (offer o1: FIRST; offer o2: FIRST)',
      '[INFO] Offer request: the offers keep to the service classes asked (STANDARD) — 1 of 2 offer(s) do not (offer o2: HIGH)',
    ]);
  });

  test('01 calls it, and the scenario parser words the framework warning', () => {
    const step = fs.readFileSync(path.join(LIB, '..', '02-Common Requests', '01. POST Get Offer.yml'), 'utf8');
    expect(step).toContain('offers.js").checkOfferSearchCriteria(jsonData);');
    global.bru = { getEnvVar: () => undefined, setEnvVar: () => {} };
    let sp;
    try { sp = require(path.join(LIB, 'scenarioParser.js')); } finally { delete global.bru; }
    expect(sp.featureNotDeclaredWarning({ code: 'S1' }, 'offerOption:serviceClassTypes=HIGH')).toBe(
      '[WARNING] Scenario "S1" asks for offers with offerSearchCriteria.serviceClassTypes HIGH, which the Test Framework does not declare (Offer search options). The run will proceed; the provider may refuse or ignore it. Declare the value in the Test Framework, or change the scenario\'s offer search criteria.');
  });
});

describe('server: the framework declares the options', () => {
  test('a scenario\'s criteria: its own, else the first of its list entry', () => {
    const df = { offerSearchCriteriaList: [{ id: 3, offerSearchCriteria: [{ offerMode: 'COLLECTIVE' }] }] };
    expect(scenarioOfferCriteria({ offerSearchCriteria: { offerMode: 'INDIVIDUAL' }, offerSearchCriteriaListId: 3 }, df)).toEqual({ offerMode: 'INDIVIDUAL' });
    expect(scenarioOfferCriteria({ offerSearchCriteriaListId: 3 }, df)).toEqual({ offerMode: 'COLLECTIVE' });
    expect(scenarioOfferCriteria({ offerSearchCriteriaListId: 9 }, df)).toBeNull();
    expect(scenarioOfferCriteria({}, df)).toBeNull();
    expect(scenarioOfferCriteria(null, df)).toBeNull();
  });

  test('the values a scenario sends, by framework key', () => {
    expect(offerSearchOptionsOf({ offerSearchCriteria: { offerMode: 'COLLECTIVE', requestedOfferParts: ['ADMISSION', 'ADMISSION', ''], travelClass: ['FIRST'], serviceClass: null } }, {})).toEqual({
      offerModes: ['COLLECTIVE'], requestedOfferParts: ['ADMISSION'], travelClasses: ['FIRST'], serviceClassTypes: [], productTags: [], productSelections: [],
    });
  });

  test('absent = every value, [] = none', () => {
    expect(offerSearchOptionDeclared({}, 'travelClasses', 'FIRST')).toBe(true);
    expect(offerSearchOptionDeclared({ offerSearchOptions: { travelClasses: [] } }, 'travelClasses', 'FIRST')).toBe(false);
    expect(offerSearchOptionDeclared({ offerSearchOptions: { travelClasses: ['FIRST'] } }, 'travelClasses', 'FIRST')).toBe(true);
    expect(offerSearchOptionDeclared(null, 'offerModes', 'COLLECTIVE')).toBe(true);
  });

  test('the run\'s data file names each value not declared', () => {
    const df = { scenarios: [
      { code: 'A', offerSearchCriteria: { offerMode: 'COLLECTIVE', travelClass: ['FIRST', 'SECOND'] } },
      { code: 'B', offerSearchCriteria: { offerMode: 'INDIVIDUAL' } },
    ] };
    annotateDatafile(df, { offerSearchOptions: { offerModes: ['INDIVIDUAL'], travelClasses: ['SECOND'] } });
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['offerOption:offerModes=COLLECTIVE', 'offerOption:travelClasses=FIRST']);
    expect(df.scenarios[1].__featureNotDeclaredWarnings).toBeUndefined();
  });

  test('no simulator scenario warns against a framework that declares nothing', () => {
    const sim = JSON.parse(fs.readFileSync(path.join(LIB, '..', 'data_base', 'simulator_datafile.json'), 'utf8'));
    annotateDatafile(sim, { salesFlows: ['SALE', 'REFUND_FULL', 'REFUND_PARTIAL', 'REFUND_IROPS', 'EXCHANGE_FULL', 'EXCHANGE_PARTIAL', 'EXCHANGE_IROPS'], returnModels: ['SEPARATE', 'COMBINED'] });
    const options = sim.scenarios.flatMap((s) => (s?.__featureNotDeclaredWarnings || []).filter((w) => w.startsWith('offerOption:')));
    expect(options).toEqual([]);
  });
});

describe('the Test Framework page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').replaceAll('\r\n', '\n');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const start = lines.indexOf('const FW_OFFER_SEARCH_OPTIONS = [');
  const FW_OFFER_SEARCH_OPTIONS = vm.runInNewContext(lines.slice(start, lines.indexOf('];', start) + 1).join('\n').replace('const FW_OFFER_SEARCH_OPTIONS = ', ''));

  test('the page\'s options and values are the server\'s', () => {
    expect(Object.fromEntries(FW_OFFER_SEARCH_OPTIONS.map(([k, , v]) => [k, v]))).toEqual(
      Object.fromEntries(Object.entries(OFFER_SEARCH_OPTIONS).map(([k, o]) => [k, o.values])));
  });

  test('the first click starts from every value; the pills follow; the panel is drawn and wired', () => {
    const wizData = { framework: {} };
    const toggle = lift('fwToggleOfferSearchOption', { wizData, FW_OFFER_SEARCH_OPTIONS });
    const el = { classList: { toggle: (_c, on) => { el.on = on; } } };
    toggle(el, 'travelClasses', 'ANY_CLASS');
    expect(wizData.framework.offerSearchOptions).toEqual({ travelClasses: ['FIRST', 'SECOND'] });
    expect(el.on).toBe(false);
    toggle(el, 'travelClasses', 'ANY_CLASS');
    expect(wizData.framework.offerSearchOptions.travelClasses).toEqual(['FIRST', 'SECOND', 'ANY_CLASS']);
    expect(el.on).toBe(true);
    toggle(el, 'nothing', 'X');
    expect(Object.keys(wizData.framework.offerSearchOptions)).toEqual(['travelClasses']);
    const declared = lift('fwOfferSearchOptionDeclared', {});
    const esc = (v) => String(v);
    const html = lift('offerSearchOptionsPanelHtml', { FW_OFFER_SEARCH_OPTIONS, fwOfferSearchOptionDeclared: declared, esc, offerCombinationsHtml: () => '', currenciesHtml: () => '' })({ offerSearchOptions: { offerModes: ['INDIVIDUAL'] } });
    expect(html).toContain('data-key="offerModes" data-val="INDIVIDUAL"');
    expect((html.match(/class="pill selected"/g) || []).length).toBe(1 + 8 + 3 + 5 + 13 + 2);
    expect(page).toContain('${offerSearchOptionsPanelHtml(fw)}');
    expect(page).toContain("case 'fw-offer-search-option':");
  });
});

// ── #780 part 2: the offer search probes ────────────────────────────────────

const { catalogueFor, catalogueDatafile, declaredOptionValues } = require('../../src/utils/scenarioCatalogue');
const { adaptCatalogueDatafile, withOfferOptions } = require('../../src/utils/catalogueMatch');
const { schemaProblems } = require('../../src/utils/datafileSchema');

describe('#780 part 2: the catalogue makes one probe per declared value', () => {
  const DATA = path.join(LIB, '..', 'data_base');
  const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'] };
  const probes = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => e.code.startsWith('OTST_OFFER_') && !e.code.startsWith('OTST_OFFER_COMBO') && e.code !== 'OTST_OFFER_OPTION_COMBINATIONS' && e.code !== 'OTST_OFFER_OPTION_NOT_DECLARED' && e.code !== 'OTST_OFFER_OPTION_DISCOVERY');

  test('the values worth a probe: declared lists only, without ALL, FARE_*, ANY_CLASS or COLLECTIVE', () => {
    expect(declaredOptionValues({}).map((o) => o.value)).toEqual([]);
    expect(declaredOptionValues({
      offerSearchOptions: { offerModes: ['INDIVIDUAL', 'COLLECTIVE'], requestedOfferParts: ['ALL', 'FARE_ADMISSION', 'ADMISSION'], travelClasses: ['ANY_CLASS', 'FIRST'], serviceClassTypes: ['HIGH'] },
      offerCriteria: { flexibilities: ['SEMI_FLEXIBLE'] },
    }).map((o) => `${o.key}=${o.value}`)).toEqual([
      'offerModes=INDIVIDUAL', 'requestedOfferParts=ADMISSION', 'travelClasses=FIRST', 'serviceClassTypes=HIGH', 'flexibilities=SEMI_FLEXIBLE',
    ]);
  });

  test('nothing declared: the probe entry is listed once and cannot be copied', () => {
    const [entry] = probes(FW);
    expect(entry.code).toBe('OTST_OFFER_OPTION_PROBE');
    expect(entry.missing).toEqual(['an offer search option value to probe (Offer search options, Tariff Flexibility)']);
    expect(entry.requirements.offerRequest.convertible).toBe(false);
  });

  test('declared values: one twin each, in the order of the options, and no form variant of them', () => {
    const fw = { ...FW, offerRequestForms: ['SEARCH', 'SPECIFICATION'], offerSearchOptions: { travelClasses: ['FIRST', 'SECOND'] }, offerCriteria: { flexibilities: ['NON_FLEXIBLE'] } };
    const list = probes(fw);
    expect(list.map((e) => e.code)).toEqual(['OTST_OFFER_TRAVEL_CLASS_FIRST', 'OTST_OFFER_TRAVEL_CLASS_SECOND', 'OTST_OFFER_FLEXIBILITY_NON_FLEXIBLE']);
    expect(list.every((e) => e.variantOf === 'OTST_OFFER_OPTION_PROBE' && e.missing.length === 0)).toBe(true);
    expect(list[0].optionOf).toEqual({ key: 'travelClasses', field: 'travelClass', value: 'FIRST' });
    expect(list[0].purpose).toBe('Offer search probe: offers asked with offerSearchCriteria.travelClasses FIRST alone; no offer keeping to it, or the provider ignoring it, fails. The scenario ends after the offer.');
  });

  test('the copy: each twin asks for its value alone, probe on; the probe entry gives way; the file stays valid', () => {
    const fw = { ...FW, offerSearchOptions: { offerModes: ['INDIVIDUAL'], serviceClassTypes: ['HIGH'] }, offerCriteria: { flexibilities: ['SEMI_FLEXIBLE'] } };
    const entries = catalogueFor(catalogue, simulator, fw);
    const file = catalogueDatafile(catalogue, simulator);
    const { datafile } = adaptCatalogueDatafile(file, entries, fw);
    const byCode = Object.fromEntries(datafile.scenarios.map((s) => [s.code, s]));
    expect(byCode.OTST_OFFER_OPTION_PROBE).toBeUndefined();
    expect(byCode.OTST_OFFER_OFFER_MODE_INDIVIDUAL.offerSearchCriteria).toEqual({ serviceClass: [], travelClass: [], flexibilities: [], offerMode: 'INDIVIDUAL', requestedOfferParts: [] });
    expect(byCode.OTST_OFFER_SERVICE_CLASS_HIGH.offerSearchCriteria.serviceClass).toEqual(['HIGH']);
    expect(byCode.OTST_OFFER_FLEXIBILITY_SEMI_FLEXIBLE.offerSearchCriteria.flexibilities).toEqual(['SEMI_FLEXIBLE']);
    expect(byCode.OTST_OFFER_FLEXIBILITY_SEMI_FLEXIBLE.desiredFlexibility).toBe('SEMI_FLEXIBLE');
    for (const code of ['OTST_OFFER_OFFER_MODE_INDIVIDUAL', 'OTST_OFFER_SERVICE_CLASS_HIGH', 'OTST_OFFER_FLEXIBILITY_SEMI_FLEXIBLE']) {
      expect(byCode[code].offerSearchProbe).toBe('on');
      expect(byCode[code].description).toMatch(/^Offer search probe: /);
    }
    const schema = JSON.parse(fs.readFileSync(path.join(LIB, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
    // The file given is not changed, and without probes nothing happens.
    expect(file.scenarios.some((s) => s.code === 'OTST_OFFER_OPTION_PROBE')).toBe(true);
    expect(withOfferOptions(file, [])).toBe(file);
  });
});

describe('#780 part 2: an offer search probe grades the options', () => {
  function run(criteria, response) {
    const results = [];
    global.bru = { getEnvVar: (k) => ({ offerSearchCriteria: JSON.stringify(criteria), offerSearchProbe: 'true' })[k], setEnvVar: () => {} };
    global.test = (name, fn) => { try { fn(); results.push([name, 'pass']); } catch (e) { results.push([name, 'fail', e.message]); } };
    logs.length = 0;
    try {
      const offers = require(path.join(LIB, 'offers.js'));
      global.validationLogger = (line) => { logs.push(line); };
      offers.checkOfferSearchCriteria(response);
    } finally { delete global.bru; delete global.test; }
    return results;
  }

  test('kept: a passing test; none kept or ignored: a failed one; some not kept: a pass and an INFO line', () => {
    expect(run({ travelClasses: ['FIRST'] }, { offers: [offer('a', { travelClass: 'FIRST' })] })).toEqual([['Offer request: the offers keep to the travel classes asked (FIRST)', 'pass']]);
    expect(run({ travelClasses: ['FIRST'] }, { offers: [offer('a')] })).toEqual([['Offer request: the offers keep to the travel classes asked (FIRST)', 'fail', '1 of 1 offer(s) do not (offer a: SECOND)']]);
    expect(run({ travelClasses: ['FIRST'] }, { offers: [offer('a')], problems: [{ code: 'PARAMETER_NOT_SUPPORTED', pointers: ['offerSearchCriteria.travelClasses'] }] })[0][1]).toBe('fail');
    expect(run({ travelClasses: ['FIRST'] }, { offers: [offer('a'), offer('b', { travelClass: 'FIRST' })] })).toEqual([['Offer request: the offers keep to the travel classes asked (FIRST)', 'pass']]);
    expect(logs).toEqual(['[INFO] Offer request: the offers keep to the travel classes asked (FIRST) — 1 of 2 offer(s) do not (offer a: SECOND)']);
  });

  test('01 ends a probe after its checks, and the parser arms it', () => {
    const step = fs.readFileSync(path.join(LIB, '..', '02-Common Requests', '01. POST Get Offer.yml'), 'utf8');
    expect(step).toContain('if (bru.getEnvVar("offerSearchProbe") === "true") {');
    expect(step.indexOf('checkOfferSearchCriteria(jsonData);')).toBeLessThan(step.indexOf('loopbackOrStop("POST Get Offer (offer search probe)")'));
    const parser = fs.readFileSync(path.join(LIB, 'scenarioParser.js'), 'utf8');
    expect(parser).toContain('bru.setEnvVar("offerSearchProbe",');
    for (const file of [path.join(LIB, 'scenarioParser.js'), path.join(LIB, '..', 'opencollection.yml')]) {
      expect(fs.readFileSync(file, 'utf8')).toContain('"expectedProductAbsent", "offerSearchProbe",');
    }
  });
});

// ── #780 part 3: random combinations ────────────────────────────────────────

const { combinationSettings, drawCombinations, MAX_COUNT } = require('../../src/utils/offerCombinations');

describe('#780 part 3: combinations drawn from a seed', () => {
  const OPTIONS = [
    { key: 'offerModes', values: ['INDIVIDUAL'] },
    { key: 'requestedOfferParts', values: ['ADMISSION', 'RESERVATION'] },
    { key: 'travelClasses', values: ['FIRST', 'SECOND'], group: 'class' },
    { key: 'serviceClassTypes', values: ['HIGH', 'STANDARD'], group: 'class' },
    { key: 'flexibilities', values: ['FULL_FLEXIBLE', 'NON_FLEXIBLE'] },
  ];
  const text = (list) => list.map((c) => c.map((o) => `${o.key}=${o.value}`).join('&'));

  test('the settings: a count of 1 to 20 and a 32-bit seed, both whole numbers', () => {
    expect(combinationSettings({ offerCombinations: { count: 5, seed: 0 } })).toEqual({ count: 5, seed: 0 });
    expect(combinationSettings({ offerCombinations: { count: MAX_COUNT, seed: 4294967295 } })).toEqual({ count: 20, seed: 4294967295 });
    for (const c of [{ count: 0, seed: 1 }, { count: 21, seed: 1 }, { count: 2.5, seed: 1 }, { count: 2 }, { count: 2, seed: -1 }, { count: 2, seed: 4294967296 }, { count: '2', seed: 1 }]) {
      expect(combinationSettings({ offerCombinations: c })).toBeNull();
    }
    expect(combinationSettings({})).toBeNull();
    expect(combinationSettings(null)).toBeNull();
  });

  test('the same seed gives the same combinations; another seed, others', () => {
    expect(text(drawCombinations(OPTIONS, 5, 42))).toEqual(text(drawCombinations(OPTIONS, 5, 42)));
    expect(text(drawCombinations(OPTIONS, 5, 42))).not.toEqual(text(drawCombinations(OPTIONS, 5, 43)));
  });

  test('each has two or more options, one value each, declared, in order; no two alike; never both classes', () => {
    const order = OPTIONS.map((o) => o.key);
    for (let seed = 0; seed < 500; seed++) {
      const list = drawCombinations(OPTIONS, 8, seed);
      expect(new Set(text(list)).size).toBe(list.length);
      for (const combination of list) {
        const keys = combination.map((c) => c.key);
        expect(keys.length).toBeGreaterThanOrEqual(2);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...keys].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(keys);
        expect(keys.includes('travelClasses') && keys.includes('serviceClassTypes')).toBe(false);
        for (const c of combination) expect(OPTIONS.find((o) => o.key === c.key).values).toContain(c.value);
      }
    }
  });

  test('fewer when there are not that many; none from fewer than two usable options', () => {
    expect(drawCombinations([{ key: 'a', values: ['1'] }, { key: 'b', values: ['2'] }], 10, 1)).toEqual([[{ key: 'a', value: '1' }, { key: 'b', value: '2' }]]);
    expect(drawCombinations([{ key: 'a', values: ['1'] }, { key: 'b', values: [] }], 3, 1)).toEqual([]);
    expect(drawCombinations([{ key: 't', values: ['F'], group: 'c' }, { key: 's', values: ['H'], group: 'c' }], 3, 1)).toEqual([]);
    expect(drawCombinations(null, 3, 1)).toEqual([]);
  });
});

describe('#780 part 3: the catalogue offers the combinations', () => {
  const DATA = path.join(LIB, '..', 'data_base');
  const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
  const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
  const FW = { salesFlows: ['SALE'], passengerTypes: ['ADULT'], offerSearchOptions: { travelClasses: ['FIRST'], requestedOfferParts: ['ADMISSION'] }, offerCriteria: { flexibilities: ['NON_FLEXIBLE', 'FULL_FLEXIBLE'] } };
  const combos = (fw) => catalogueFor(catalogue, simulator, fw).filter((e) => e.code.startsWith('OTST_OFFER_COMBO') || e.code === 'OTST_OFFER_OPTION_COMBINATIONS');

  test('no count or seed, or nothing to combine: listed once, not copiable', () => {
    expect(combos(FW).map((e) => [e.code, e.missing])).toEqual([['OTST_OFFER_OPTION_COMBINATIONS', ['the number of random combinations and their seed (Offer search options)']]]);
    const lonely = { ...FW, offerSearchOptions: {}, offerCriteria: { flexibilities: ['NON_FLEXIBLE'] }, offerCombinations: { count: 3, seed: 7 } };
    expect(combos(lonely).map((e) => e.missing)).toEqual([['two offer search options with a value to combine (Offer search options, Tariff Flexibility)']]);
  });

  test('a count and a seed: that many combinations, each copied with all its values and the probe on', () => {
    const fw = { ...FW, offerCombinations: { count: 3, seed: 12345 } };
    const entries = combos(fw);
    expect(entries.map((e) => e.code)).toEqual(['OTST_OFFER_COMBO_1', 'OTST_OFFER_COMBO_2', 'OTST_OFFER_COMBO_3']);
    expect(entries.every((e) => e.variantOf === 'OTST_OFFER_OPTION_COMBINATIONS' && e.missing.length === 0 && e.optionsOf.length >= 2)).toBe(true);
    expect(entries[0].purpose).toMatch(/^Offer search combination 1 of seed 12345: offers asked with .+ together; /);
    // The same framework draws the same combinations.
    expect(combos(fw).map((e) => e.optionsOf)).toEqual(entries.map((e) => e.optionsOf));
    const { datafile } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), catalogueFor(catalogue, simulator, fw), fw);
    for (const entry of entries) {
      const scenario = datafile.scenarios.find((s) => s.code === entry.code);
      expect(scenario.offerSearchProbe).toBe('on');
      for (const { field, value } of entry.optionsOf) {
        expect(field === 'offerMode' ? scenario.offerSearchCriteria[field] : scenario.offerSearchCriteria[field]).toEqual(field === 'offerMode' ? value : [value]);
        if (field === 'flexibilities') expect(scenario.desiredFlexibility).toBe(value);
      }
    }
    expect(datafile.scenarios.some((s) => s.code === 'OTST_OFFER_OPTION_COMBINATIONS')).toBe(false);
    const schema = JSON.parse(fs.readFileSync(path.join(LIB, '..', 'json_validator', 'datafile.schema.json'), 'utf8'));
    expect(schemaProblems(datafile, schema).problems).toEqual([]);
  });
});

describe('#780 part 3: the Test Framework page', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').replaceAll('\r\n', '\n');
  const lines = page.split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };

  test('a typed count or seed is kept when in range, refused otherwise; empty removes it', () => {
    const wizData = { framework: {} };
    const set = lift('fwSetOfferCombination', { wizData });
    expect(set('count', '5')).toBe(true);
    expect(set('seed', '4294967295')).toBe(true);
    expect(wizData.framework.offerCombinations).toEqual({ count: 5, seed: 4294967295 });
    for (const [field, raw] of [['count', '0'], ['count', '21'], ['count', '2.5'], ['seed', '4294967296'], ['seed', '-1'], ['seed', 'abc']]) {
      expect(set(field, raw)).toBe(false);
    }
    expect(wizData.framework.offerCombinations).toEqual({ count: 5, seed: 4294967295 });
    expect(set('count', ' ')).toBe(true);
    expect(wizData.framework.offerCombinations).toEqual({ seed: 4294967295 });
  });

  test('a new seed comes from the browser\'s random source and is kept', () => {
    const wizData = { framework: { offerCombinations: { count: 2 } } };
    const crypto = { getRandomValues: (a) => { a[0] = 987654321; return a; } };
    expect(lift('fwNewOfferCombinationSeed', { wizData, crypto, Uint32Array })()).toBe(987654321);
    expect(wizData.framework.offerCombinations).toEqual({ count: 2, seed: 987654321 });
  });

  test('the fields are drawn with their values, labelled, and wired', () => {
    const html = lift('offerCombinationsHtml', { esc: (v) => String(v) })({ offerCombinations: { count: 4, seed: 99 } });
    expect(html).toContain('id="fw-offer-combinations-count" min="1" max="20" value="4"');
    expect(html).toContain('id="fw-offer-combinations-seed" min="0" max="4294967295" value="99"');
    expect(html).toContain('<label for="fw-offer-combinations-count"');
    expect(html).toContain('<label for="fw-offer-combinations-seed"');
    expect(page).toContain('${offerCombinationsHtml(fw)}');
    expect(page).toContain("if (action !== 'fw-offer-combinations') return false;");
    expect(page).toContain('|| changeOfferCombination(action, el) || changeCurrencies(action, el) || changeMandatoryReservationForm(action, el) || changeOsdmVersion(action, el) || changeExchange(action, el)) return;');
    expect(page).toContain("case 'fw-offer-combinations-new-seed': {");
  });
});

// ── #780 PR A: product tags and product selections ──────────────────────────

describe('#780 PR A: product tags and product selections', () => {
  test('the framework: tags from the OSDM list, selections by code or by tag; a scenario\'s selections read as their forms', () => {
    expect(OFFER_SEARCH_OPTIONS.productTags.values).toEqual(expect.arrayContaining(['ADMISSION_POINT2POINT', 'RESERVATION', 'SPLIT_RESERVATION', 'TICKET_LOST']));
    expect(OFFER_SEARCH_OPTIONS.productTags.values).toHaveLength(13);
    expect(OFFER_SEARCH_OPTIONS.productSelections.values).toEqual(['PRODUCT_CODE', 'PRODUCT_TAG']);
    const sc = { offerSearchCriteria: { productTags: ['RESERVATION', ' '], productSelections: [{ productCode: 'P1' }, { productTag: 'RESERVATION' }, { productCode: 'P2' }, {}, null, 'x'] } };
    expect(offerSearchOptionsOf(sc, {})).toMatchObject({ productTags: ['RESERVATION'], productSelections: ['PRODUCT_CODE', 'PRODUCT_TAG'] });
    expect(offerSearchOptionsOf({ offerSearchCriteria: { productSelections: 'PRODUCT_CODE' } }, {}).productSelections).toEqual([]);
  });

  test('the run\'s data file warns for a tag or a selection form not declared', () => {
    const df = { scenarios: [{ code: 'A', offerSearchCriteria: { productTags: ['RESERVATION', 'ADMISSION_PASS'], productSelections: [{ productCode: 'P1' }] } }] };
    annotateDatafile(df, { offerSearchOptions: { productTags: ['RESERVATION'], productSelections: ['PRODUCT_TAG'] } });
    expect(df.scenarios[0].__featureNotDeclaredWarnings).toEqual(['offerOption:productTags=ADMISSION_PASS', 'offerOption:productSelections=PRODUCT_CODE']);
  });

  test('the collection: one check per selection, kept by code, type or tag; none a warning; ignored a warning', () => {
    const offers = { offers: [offer('O1', { type: 'ADMISSION_POINT2POINT' }), offer('O2', { type: 'ADMISSION', tags: ['SPECIAL'] })] };
    offers.offers[0].products[0].code = 'P1';
    const checks = checkOfferCriteria({ productSelections: [{ productCode: 'P1', numberOfItems: 1 }, { productTag: 'SPECIAL' }, { productTag: 'ADMISSION_POINT2POINT' }, { productCode: 'NOPE' }, {}] }, offers);
    expect(checks.map((c) => [c.name, c.ok, c.level])).toEqual([
      ['Offer request: an offer holds the product selected (product code P1)', true, 'warn'],
      ['Offer request: an offer holds the product selected (product tag SPECIAL)', true, 'warn'],
      ['Offer request: an offer holds the product selected (product tag ADMISSION_POINT2POINT)', true, 'warn'],
      ['Offer request: an offer holds the product selected (product code NOPE)', false, 'warn'],
    ]);
    expect(checks[3].message).toBe('none of the 2 offer(s) holds it');
    const ignored = checkOfferCriteria({ productSelections: [{ productCode: 'P1' }] }, offers, ['productselections']);
    expect(ignored[0]).toMatchObject({ ok: false, level: 'warn' });
    expect(ignored[0].message).toMatch(/PARAMETER_NOT_SUPPORTED/);
    expect(checkOfferCriteria({ productSelections: [{ productCode: 'P1' }] }, { offers: [] })).toEqual([]);
  });

  test('the catalogue probes each declared tag a trip can hold, never in a combination', () => {
    const DATA = path.join(LIB, '..', 'data_base');
    const catalogue = JSON.parse(fs.readFileSync(path.join(DATA, 'scenario_catalogue.json'), 'utf8'));
    const simulator = JSON.parse(fs.readFileSync(path.join(DATA, 'simulator_datafile.json'), 'utf8'));
    const fw = { salesFlows: ['SALE'], passengerTypes: ['ADULT'], offerSearchOptions: { productTags: ['ADMISSION_PASS', 'RESERVATION', 'ADMISSION_POINT2POINT'] } };
    expect(declaredOptionValues(fw).map((o) => o.value)).toEqual(['ADMISSION_POINT2POINT', 'RESERVATION']);
    const entries = catalogueFor(catalogue, simulator, fw);
    expect(entries.filter((e) => e.variantOf === 'OTST_OFFER_OPTION_PROBE').map((e) => e.code)).toEqual(['OTST_OFFER_PRODUCT_TAG_ADMISSION_POINT2POINT', 'OTST_OFFER_PRODUCT_TAG_RESERVATION']);
    const { datafile } = adaptCatalogueDatafile(catalogueDatafile(catalogue, simulator), entries, fw);
    expect(datafile.scenarios.find((s) => s.code === 'OTST_OFFER_PRODUCT_TAG_RESERVATION').offerSearchCriteria.productTags).toEqual(['RESERVATION']);
    // Tags alone give nothing to combine.
    const combos = catalogueFor(catalogue, simulator, { ...fw, offerSearchOptions: { ...fw.offerSearchOptions, travelClasses: ['FIRST'] }, offerCombinations: { count: 3, seed: 7 } });
    expect(combos.find((e) => e.code === 'OTST_OFFER_OPTION_COMBINATIONS').missing.join()).toMatch(/two offer search options/);
  });
});
