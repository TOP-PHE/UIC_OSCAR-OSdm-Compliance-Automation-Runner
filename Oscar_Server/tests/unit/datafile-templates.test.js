// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafile-templates.test.js — utils/datafileTemplates.js (audit tracker NEW-10).
 *
 * Bruno fills in a double-brace template in datafile text, and the template
 * naming the run's token gives that token. The collection hands the whole
 * datafile to Bruno before every run, so the two rules look at the whole file:
 * what a save may not add, and what a datafile may not hold when a run starts.
 * The module is pure, so nothing is mocked.
 *
 * Several tests come from an independent review that broke the first version:
 * one large save stalled the server (every place was compared with every
 * other), deep nesting ended in a RangeError, the fields the editor fills in on
 * its own made old text look new, and a save could point a clean scenario at an
 * entry that already held a template.
 */

const { templatePaths, templatesInDatafile, templatesForRunner, templatesAddedBy, saveRefusal, runRefusal, TEST_MANAGER_ROOT_KEYS } = require('../../src/utils/datafileTemplates');

const OPEN = '{'.repeat(2);
const CLOSE = '}'.repeat(2);
const TOKEN = `${OPEN}process.env.OSCAR_ACCESS_TOKEN${CLOSE}`;
const OTHER = `${OPEN}access_token${CLOSE}`;
const copy = v => JSON.parse(JSON.stringify(v));
const plain = found => [...found];                 // the places, without the `total` the list carries

// A small company file: two scenarios with their own entries.
function datafile() {
  return {
    osdmVersion: '3.7',
    collection: 'OTST',
    systemInfoParameters: { note: `a Test Manager may write ${OPEN}requestor${CLOSE} here` },
    knownDeviations: [{ step: '02', expectedStatus: 400, note: `and ${OPEN}here${CLOSE}` }],
    scenariosToRun: ['MINE', 'THEIRS'],
    scenarios: [
      { code: 'MINE', created_by: 'tester@example.test', tripRequirementId: 1, passengersListId: 10, purchaserListId: 100 },
      { code: 'THEIRS', created_by: 'other@example.test', tripRequirementId: 2, passengersListId: 20, purchaserListId: 100 },
    ],
    tripRequirements: [{ id: 1, legs: [{ origin: 'urn:a', destination: 'urn:b' }] }, { id: 2, legs: [] }],
    passengersList: [{ id: 10, passengers: [{ firstName: 'Ada', lastName: 'Lovelace' }] }, { id: 20, passengers: [{ firstName: 'Bob' }] }],
    purchaserList: [{ id: 100, purchaser: [{ firstName: 'Pat' }] }],
    requestedFulfillmentOptionsList: [{ id: 1000, options: [{ type: 'ETICKET', media: 'PDF_A4' }] }],
    offerSearchCriteriaList: [{ id: 5, criteria: { currency: 'EUR' } }],
  };
}

describe('templatePaths — where text holds two opening braces', () => {
  test('finds strings at any depth and says where', () => {
    const value = { a: 'plain', b: { c: [`x ${TOKEN}`, 'y'], d: OPEN }, e: [[{ f: OTHER }]] };
    expect(templatePaths(value)).toEqual(['b.c[0]', 'b.d', 'e[0][0].f']);
  });

  test('finds them in the name of a field too', () => {
    expect(templatePaths({ [`k${TOKEN}`]: 1, ok: { [OPEN]: 'v' } }))
      .toEqual([`k${TOKEN} (the name of the field)`, `ok.${OPEN} (the name of the field)`]);
  });

  test('a string on its own, and things that are not text', () => {
    expect(templatePaths(`${OPEN}x`)).toEqual(['(the value itself)']);
    for (const clean of ['{ one } brace', '}} closing only', '{ {', '', 0, 42, true, null, undefined, [], {}, [1, [2, [3]]]]) {
      expect(templatePaths(clean)).toEqual([]);
    }
  });

  test('a very long field name is cut in the path', () => {
    const [path] = templatePaths({ ['n'.repeat(500)]: OPEN });
    expect(path.length).toBeLessThan(70);
    expect(path.endsWith('…')).toBe(true);
  });

  test('100,000 levels deep is walked, not recursed into', () => {
    let deep = `${OPEN}bottom`;
    for (let i = 0; i < 100000; i++) deep = [deep];
    expect(templatePaths(deep)).toHaveLength(1);
  });
});

describe('templatesInDatafile — what a datafile may not hold when a run starts', () => {
  const asManager = { showAll: true };

  test('a clean file gives nothing', () => {
    const found = templatesInDatafile(datafile(), asManager);
    expect(plain(found)).toEqual([]);
    expect(found.total).toBe(0);
  });

  test('the two root keys only a Test Manager writes are left alone, and only those two', () => {
    expect(TEST_MANAGER_ROOT_KEYS).toEqual(['systemInfoParameters', 'knownDeviations']);
    expect(plain(templatesInDatafile(datafile(), asManager))).toEqual([]);      // both hold one in the fixture
    const df = datafile();
    df.somethingElse = { note: TOKEN };
    expect(plain(templatesInDatafile(df, asManager))).toEqual(['somethingElse: note']);
  });

  test.each([
    ['a scenario', df => { df.scenarios[0].label = TOKEN; }, 'scenario "MINE": label'],
    ['a scenario, in the name of a field', df => { df.scenarios[0][`${OPEN}k`] = 1; }, `scenario "MINE": ${OPEN}k (the name of the field)`],
    ['a trip', df => { df.tripRequirements[0].legs[0].origin = TOKEN; }, 'tripRequirements, entry 1: legs[0].origin'],
    ['a passenger', df => { df.passengersList[1].passengers[0].firstName = TOKEN; }, 'passengersList, entry 2: passengers[0].firstName'],
    ['a purchaser', df => { df.purchaserList[0].purchaser[0].firstName = TOKEN; }, 'purchaserList, entry 1: purchaser[0].firstName'],
    ['fulfillment options', df => { df.requestedFulfillmentOptionsList[0].options[0].media = TOKEN; }, 'requestedFulfillmentOptionsList, entry 1: options[0].media'],
    ['offer criteria', df => { df.offerSearchCriteriaList[0].criteria.currency = TOKEN; }, 'offerSearchCriteriaList, entry 1: criteria.currency'],
    ['an entry no scenario points to', df => { df.passengersList.push({ passengers: [{ firstName: TOKEN }] }); }, 'passengersList, entry 3: passengers[0].firstName'],
    ['a list this module has never heard of', df => { df.somethingNew = [{ a: TOKEN }]; }, 'somethingNew, entry 1: a'],
    ['the run list', df => { df.scenariosToRun.push(TOKEN); }, 'scenariosToRun, entry 3: (the value itself)'],
    ['a root text a tester may set on a first save', df => { df.osdmVersion = TOKEN; }, 'osdmVersion: (the value itself)'],
    ['the name of a root key', df => { df[`${OPEN}root`] = 'v'; }, `${OPEN}root (the name of a root key): (the value itself)`],
    ['a scenario that is not an object', df => { df.scenarios.push(TOKEN); }, 'a scenario with no code: (the value itself)'],
  ])('in %s', (_what, plant, expected) => {
    const df = datafile();
    plant(df);
    expect(plain(templatesInDatafile(df, asManager))).toEqual([expected]);
  });

  test('40,000 of them: counted in well under a second, twenty kept', () => {
    const df = datafile();
    df.scenarios[0].many = Array.from({ length: 40000 }, () => OPEN);
    const began = Date.now();
    const found = templatesInDatafile(df, asManager);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(found).toHaveLength(20);
    expect(found.total).toBe(40000);
  });

  test('what is not a datafile holds nothing', () => {
    for (const odd of [null, undefined, 'text', 7, [], [TOKEN]]) expect(plain(templatesInDatafile(odd, asManager))).toEqual([]);
  });
});

// The review's second round: a tester's message named "another scenario" and
// still gave the field, the position of entries they cannot see, and how many
// places there were. A tester is now told about what Test Config shows them,
// and for the rest only that there is something.
describe('templatesForRunner — what the person running is told', () => {
  const ME = 'tester@example.test';
  const everywhere = () => {
    const df = datafile();
    df.scenarios[0].label = TOKEN;                                // MINE: mine
    df.passengersList[0].passengers[0].firstName = TOKEN;         // entry 10: used by MINE
    df.scenarios[1].scenarioType = TOKEN;                         // THEIRS: someone else's, private
    df.tripRequirements[1].secretField = TOKEN;                   // entry 2: used by THEIRS only
    df.passengersList[1].passengers[0].firstName = TOKEN;         // entry 20: used by THEIRS only
    return df;
  };

  test('a Test Manager is told every place', () => {
    const found = templatesForRunner(everywhere(), { testManager: true, email: 'tm@example.test' });
    expect(plain(found)).toEqual([
      'scenario "MINE": label', 'scenario "THEIRS": scenarioType', 'tripRequirements, entry 2: secretField',
      'passengersList, entry 1: passengers[0].firstName', 'passengersList, entry 2: passengers[0].firstName',
    ]);
    expect(found.total).toBe(5);
    expect(found.elsewhere).toBe(false);
  });

  test('a tester is told the places they can see, and only that there is more', () => {
    const found = templatesForRunner(everywhere(), { testManager: false, email: ME });
    expect(plain(found)).toEqual(['scenario "MINE": label', 'passengersList, entry 1: passengers[0].firstName']);
    expect(found.total).toBe(2);                                   // not 5: the others are not counted for them
    expect(found.elsewhere).toBe(true);
    const sentence = runRefusal(found);
    for (const hidden of ['THEIRS', 'scenarioType', 'secretField', 'tripRequirements', 'entry 2', '5', '3 more']) {
      expect(sentence).not.toContain(hidden);
    }
    expect(sentence).toContain('It is also in a part of the data file that you cannot see');
  });

  test('when everything is someone else\'s, a tester is told that much and nothing else', () => {
    const df = datafile();
    df.scenarios[1].scenarioType = TOKEN;
    df.tripRequirements[1].secretField = TOKEN;
    const found = templatesForRunner(df, { testManager: false, email: ME });
    expect(plain(found)).toEqual([]);
    expect(found.total).toBe(0);
    expect(found.elsewhere).toBe(true);
    const sentence = runRefusal(found);
    expect(sentence).toContain('was not started');
    expect(sentence).toContain('It is in a part of the data file that you cannot see: ask your Test Manager');
    expect(sentence).not.toContain('Where:');
    for (const hidden of ['THEIRS', 'scenarioType', 'secretField', 'tripRequirements', 'entry']) expect(sentence).not.toContain(hidden);
  });

  test('a shared scenario, and one with no owner, are theirs to see', () => {
    const df = datafile();
    df.scenarios[1].shared = true;
    df.scenarios[1].label = TOKEN;
    df.scenarios.push({ code: 'OLD_COMPANY_ONE', note: TOKEN });
    const found = templatesForRunner(df, { testManager: false, email: ME });
    expect(plain(found)).toEqual(['scenario "THEIRS": label', 'scenario "OLD_COMPANY_ONE": note']);
    expect(found.elsewhere).toBe(false);
  });

  test('nothing hidden, nothing "elsewhere"; nothing at all, nothing said', () => {
    const mine = datafile();
    mine.scenarios[0].label = TOKEN;
    expect(templatesForRunner(mine, { testManager: false, email: ME }).elsewhere).toBe(false);
    const clean = templatesForRunner(datafile(), { testManager: false, email: ME });
    expect([plain(clean), clean.total, clean.elsewhere]).toEqual([[], 0, false]);
    expect(runRefusal(clean)).toBeNull();
  });

  test('only a real `testManager: true` is told everything', () => {
    for (const notTrue of [undefined, 'true', 1, {}, 'test_manager', false]) {
      const found = templatesForRunner(everywhere(), { testManager: notTrue, email: ME });
      expect(plain(found)).toEqual(['scenario "MINE": label', 'passengersList, entry 1: passengers[0].firstName']);
    }
    expect(templatesForRunner(everywhere()).elsewhere).toBe(true);   // no one named: nothing of anyone's is shown
    expect(plain(templatesForRunner(everywhere()))).not.toContain('scenario "THEIRS": scenarioType');
  });

  test('650,000 of them, the size of the largest body: counted in about a second, twenty kept', () => {
    const df = datafile();
    df.scenarios[0].many = Array.from({ length: 650000 }, () => OPEN);
    const began = Date.now();
    const found = templatesForRunner(df, { testManager: false, email: ME });
    expect(Date.now() - began).toBeLessThan(4000);
    expect(found).toHaveLength(20);
    expect(found.total).toBe(650000);
  });
});

describe('templatesAddedBy — what a save may not add', () => {
  const legacy = () => {
    const df = datafile();
    df.scenarios[1].label = `theirs ${TOKEN}`;                    // stored earlier, by someone
    df.passengersList[1].passengers[0].firstName = TOKEN;
    return df;
  };

  test('saving the stored file back adds nothing, whatever it already holds', () => {
    const found = templatesAddedBy(legacy(), legacy());
    expect(plain(found)).toEqual([]);
    expect(found.total).toBe(0);
  });

  test('a new template is added, wherever it is put', () => {
    const cases = [
      [df => { df.scenarios[0].label = TOKEN; }, 'scenario "MINE": label'],
      [df => { df.scenarios.push({ code: 'NEW_ONE', comment: OTHER }); }, 'scenario "NEW_ONE": comment'],
      [df => { df.tripRequirements[0].remark = TOKEN; }, 'tripRequirements, entry 1: remark'],
      [df => { df.purchaserList.push({ id: 999, [`${OPEN}k`]: 'v' }); }, `purchaserList, entry 2: ${OPEN}k (the name of the field)`],
      [df => { df.osdmVersion = TOKEN; }, 'osdmVersion: (the value itself)'],
      [df => { df.collection = OTHER; }, 'collection: (the value itself)'],
      [df => { df.scenarios[0].__hidden = TOKEN; }, 'scenario "MINE": __hidden'],
    ];
    for (const [plant, expected] of cases) {
      const sent = legacy();
      plant(sent);
      expect(plain(templatesAddedBy(legacy(), sent))).toEqual([expected]);
    }
  });

  test('a scenario that already holds one can be edited elsewhere: nothing is added', () => {
    const sent = legacy();
    sent.scenarios[1].scenarioType = 'REFUND';
    sent.scenarios[1].tripRequirementId = 1;
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual([]);
  });

  test('the fields the editor fills in on its own do not make old text look new', () => {
    const sent = legacy();
    for (const sc of sent.scenarios) {
      sc.salesFlowActions = { patchPassengers: true, placeSelection: true, addAncillary: true, getBooking: true, deleteAncillary: true };
      sc.offerSearchCriteria = {};
      sc.__featureNotDeclaredWarnings = ['something the server added when it served the file'];
    }
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual([]);
  });

  test('reordering the file, or deleting what came before, does not either', () => {
    const reordered = legacy();
    reordered.scenarios.reverse();
    reordered.passengersList.reverse();
    expect(plain(templatesAddedBy(legacy(), reordered))).toEqual([]);

    const shorter = legacy();
    shorter.scenarios.shift();
    shorter.passengersList.shift();                                // the old template is now entry 1, not entry 2
    expect(plain(templatesAddedBy(legacy(), shorter))).toEqual([]);
  });

  test('one more copy of a stored template is new', () => {
    const sent = legacy();
    sent.scenarios[0].label = `theirs ${TOKEN}`;                   // the same text as THEIRS already holds
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual(['scenario "MINE": label']);
  });

  test('changing the text of a stored template is new', () => {
    const sent = legacy();
    sent.scenarios[1].label = `theirs ${OTHER}`;
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual(['scenario "THEIRS": label']);
  });

  test('moving a stored template to another place is not new, as long as there is still one', () => {
    const sent = legacy();
    sent.scenarios[1].comment = sent.scenarios[1].label;
    delete sent.scenarios[1].label;
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual([]);
  });

  test('pointing a clean scenario at an entry that holds one adds nothing, and needs nothing: no run starts while the file holds it', () => {
    const sent = legacy();
    sent.scenarios[0].passengersListId = 20;                       // MINE now uses the entry with the old template
    expect(plain(templatesAddedBy(legacy(), sent))).toEqual([]);
    expect(plain(templatesInDatafile(sent, { ownCode: 'MINE' }))).toContain('passengersList, entry 2: passengers[0].firstName');
    expect(plain(templatesInDatafile(legacy(), { ownCode: 'MINE' }))).toContain('passengersList, entry 2: passengers[0].firstName');
  });

  test('a first save, with nothing stored, is looked at whole', () => {
    for (const nothing of [{}, null, undefined, 'text', []]) {
      expect(plain(templatesAddedBy(nothing, legacy()))).toEqual(['scenario "THEIRS": label', 'passengersList, entry 2: passengers[0].firstName']);
    }
  });

  test('the two root keys only a Test Manager writes are left alone', () => {
    const sent = datafile();
    sent.systemInfoParameters.other = TOKEN;
    sent.knownDeviations.push({ step: 'x', note: TOKEN });
    expect(plain(templatesAddedBy(datafile(), sent))).toEqual([]);
  });

  test('what is sent is not an object: nothing to look at', () => {
    for (const odd of [null, undefined, 'text', 3, [], [TOKEN]]) expect(plain(templatesAddedBy(datafile(), odd))).toEqual([]);
  });

  test('40,000 new ones in one save: answered in well under a second', () => {
    const sent = datafile();
    sent.scenarios[0].many = Array.from({ length: 40000 }, () => OPEN);
    const began = Date.now();
    const found = templatesAddedBy(datafile(), sent);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(found).toHaveLength(20);
    expect(found.total).toBe(40000);
  });

  test('40,000 stored ones, saved back: still nothing added, still fast', () => {
    const stored = datafile();
    stored.scenarios[0].many = Array.from({ length: 40000 }, (_, i) => `${OPEN}${i}`);
    const began = Date.now();
    expect(plain(templatesAddedBy(stored, copy(stored)))).toEqual([]);
    expect(Date.now() - began).toBeLessThan(2000);
  });

  test('a scenario nested 20,000 levels deep does not end in a RangeError', () => {
    const nested = (leaf) => { let v = leaf; for (let i = 0; i < 20000; i++) v = { a: [v] }; return v; };
    const stored = datafile();
    stored.scenarios[0].deep = nested('clean');
    const sent = datafile();
    sent.scenarios[0].deep = nested(TOKEN);
    expect(() => templatesAddedBy(stored, stored)).not.toThrow();
    expect(templatesAddedBy(stored, sent).total).toBe(1);
  });
});

describe('the two sentences', () => {
  test('nothing found, nothing said', () => {
    expect(saveRefusal([])).toBeNull();
    expect(runRefusal([])).toBeNull();
    expect(saveRefusal(templatesAddedBy(datafile(), datafile()))).toBeNull();
    expect(runRefusal(templatesInDatafile(datafile(), { showAll: true }))).toBeNull();
  });

  test('they say what, why and where, and never repeat the text itself', () => {
    const df = datafile();
    df.scenarios[0].label = `secret-looking ${TOKEN}`;
    const found = templatesInDatafile(df);
    for (const sentence of [saveRefusal(found), runRefusal(found)]) {
      expect(sentence).toContain(`"${OPEN}"`);
      expect(sentence).toContain('value of a variable');
      expect(sentence).toContain('scenario "MINE": label');
      expect(sentence).not.toContain('OSCAR_ACCESS_TOKEN');
      expect(sentence).not.toContain('secret-looking');
    }
    expect(saveRefusal(found)).toContain('cannot be saved');
    expect(runRefusal(found)).toContain('was not started');
    expect(runRefusal(found)).not.toContain('ask your Test Manager');   // nothing is hidden from this reader
  });

  test('more than three places are counted, not listed', () => {
    const df = datafile();
    df.scenarios[0].many = [OPEN, OPEN, OPEN, OPEN, OPEN];
    const sentence = saveRefusal(templatesInDatafile(df, { showAll: true }));
    expect(sentence).toContain('many[0]; scenario "MINE": many[1]; scenario "MINE": many[2]; and 2 more.');
    expect(sentence).not.toContain('many[3]');
  });

  test('a plain list of places works too', () => {
    expect(saveRefusal(['a', 'b', 'c', 'd', 'e'])).toContain('a; b; c; and 2 more.');
    expect(runRefusal(['a'])).toContain('Where: a.');
  });
});
