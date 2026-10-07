// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-templates.test.js — audit tracker NEW-10, through the real
 * routes: a save may not add a double-brace template to scenario text.
 *
 * Bruno fills such a template in when the text is used in a request, and the
 * one naming the run's token gives the token of whoever runs the scenario. The
 * rule itself is tested in tests/unit/datafile-templates.test.js; here, the
 * first of the three ways a datafile is written: a tester's save, which is merged
 * into the stored file. The Test Manager's save and upload are in
 * company-datafile-templates-manager.test.js: the write limiter allows twenty
 * writes per app instance, and each test file gets an instance of its own.
 *
 * One company, two testers (Ana, Ben) and a Test Manager, one stored datafile
 * seeded straight to disk before every test — the same shape as
 * company-datafile-tester-merge.test.js.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-datafile-templates';

jest.mock('../../src/worker/queue', () => ({
  enqueue: jest.fn(), purge: jest.fn(), queueStatus: jest.fn(() => ({})),
}));

const { templatesCompany, OPEN, CLOSE, TOKEN } = require('../helpers/datafile-templates-company');

const { ANA, scenario, storedFile, seed, unseed, onDisk, isStored, hash, byCode, getAs, putAs, expectRefused } = templatesCompany();

// ── A tester's save ──────────────────────────────────────────────────────────
describe('PUT /v1/company/datafile/json by a tester', () => {
  test('a template added to their own scenario is refused, and nothing is stored', async () => {
    const before = onDisk();
    const hashBefore = hash();
    const view = (await getAs(ANA)).body;
    byCode(view, 'ANA_1').label = `Paris ${TOKEN}`;

    expectRefused(await putAs(ANA, view), 'scenario "ANA_1": label');
    expect(onDisk()).toBe(before);
    expect(hash()).toBe(hashBefore);
  });

  test('so is one in an entry their scenario uses', async () => {
    const before = onDisk();
    const view = (await getAs(ANA)).body;
    view.passengersList.find(p => p.id === 31).passengers[0].firstName = TOKEN;
    expectRefused(await putAs(ANA, view), 'passengers[0].firstName');
    expect(onDisk()).toBe(before);
  });

  test('so is a new scenario that holds one, and the name of a field', async () => {
    const before = onDisk();
    const view = (await getAs(ANA)).body;
    view.scenarios.push({ ...scenario('ANA_NEW', ANA, 30), comment: `${OPEN}access_token${CLOSE}` });
    expectRefused(await putAs(ANA, view), 'scenario "ANA_NEW": comment');

    const second = (await getAs(ANA)).body;
    byCode(second, 'ANA_1')[`${OPEN}k`] = 'v';
    expectRefused(await putAs(ANA, second), '(the name of the field)');
    expect(onDisk()).toBe(before);
  });

  test('an ordinary save still works, single braces included', async () => {
    const view = (await getAs(ANA)).body;
    byCode(view, 'ANA_1').label = 'Paris {one} } {';
    const res = await putAs(ANA, view);
    expect(res.status).toBe(200);
    expect(byCode(JSON.parse(onDisk()), 'ANA_1').label).toBe('Paris {one} } {');
  });

  test('text stored earlier, in other people\'s scenarios or their own, does not block a save of something else', async () => {
    seed(storedFile({ legacy: true }));
    const view = (await getAs(ANA)).body;                          // holds SHARED_1 and ANA_1, both with an old template
    view.scenarios.push(scenario('ANA_2', ANA, 30));               // Ana adds a clean scenario
    const res = await putAs(ANA, view);
    expect(res.status).toBe(200);
    const stored = JSON.parse(onDisk());
    expect(stored.scenarios.map(s => s.code)).toEqual(expect.arrayContaining(['SHARED_1', 'ANA_1', 'BEN_1', 'ANA_2']));
    expect(byCode(stored, 'BEN_1').label).toBe(`ben ${TOKEN}`);    // kept as stored; the run-time rule covers it
  });

  test('one put into a shared scenario is not stored, like any other edit to a read-only scenario', async () => {
    const before = byCode(JSON.parse(onDisk()), 'SHARED_1');
    const view = (await getAs(ANA)).body;
    byCode(view, 'SHARED_1').label = TOKEN;                        // Ana cannot change a shared scenario
    const res = await putAs(ANA, view);
    expect(res.status).toBe(200);                                  // nothing of hers is refused
    expect(res.body.read_only_ignored).toEqual(['SHARED_1']);
    expect(byCode(JSON.parse(onDisk()), 'SHARED_1')).toEqual(before);
    expect(onDisk()).not.toContain('OSCAR_ACCESS_TOKEN');
  });

  test('a scenario that already holds one can still be edited elsewhere, and cleaned', async () => {
    seed(storedFile({ legacy: true }));
    const view = (await getAs(ANA)).body;
    byCode(view, 'ANA_1').scenarioType = 'REFUND';                 // the old template is not touched: nothing is added
    expect((await putAs(ANA, view)).status).toBe(200);

    byCode(view, 'ANA_1').label = 'ana';                           // the template is taken out
    expect((await putAs(ANA, view)).status).toBe(200);
    expect(byCode(JSON.parse(onDisk()), 'ANA_1')).toMatchObject({ label: 'ana', scenarioType: 'REFUND' });
  });

  test('but one more copy of an old one, or a change to its text, is refused', async () => {
    seed(storedFile({ legacy: true }));
    const before = onDisk();
    const copyIt = (await getAs(ANA)).body;
    byCode(copyIt, 'ANA_1').comment = byCode(copyIt, 'ANA_1').label;
    expectRefused(await putAs(ANA, copyIt), 'scenario "ANA_1"');

    const changeIt = (await getAs(ANA)).body;
    byCode(changeIt, 'ANA_1').label = `ana ${OPEN}access_token${CLOSE}`;
    expectRefused(await putAs(ANA, changeIt), 'scenario "ANA_1": label');
    expect(onDisk()).toBe(before);
  });

  test('a first save into an empty company cannot put one in the two root texts a tester may set', async () => {
    unseed();
    const first = { osdmVersion: TOKEN, collection: 'OTST', scenarios: [scenario('ANA_FIRST', ANA, 30)], scenariosToRun: ['ANA_FIRST'] };
    expectRefused(await putAs(ANA, first), 'osdmVersion');
    expect(isStored()).toBe(false);

    first.osdmVersion = '3.7';
    expect((await putAs(ANA, first)).status).toBe(200);
  });
});

