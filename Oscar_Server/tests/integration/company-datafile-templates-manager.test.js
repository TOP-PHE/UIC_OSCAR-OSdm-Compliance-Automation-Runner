// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * company-datafile-templates-manager.test.js — audit tracker NEW-10, through the real
 * routes: a save may not add a double-brace template to scenario text.
 *
 * Bruno fills such a template in when the text is used in a request, and the
 * one naming the run's token gives the token of whoever runs the scenario. The
 * rule itself is tested in tests/unit/datafile-templates.test.js; here, the
 * two ways a Test Manager writes a datafile: the whole-file save and the upload.
 * A tester's save is in company-datafile-templates.test.js.
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

const { TM, scenario, storedFile, seed, unseed, onDisk, isStored, byCode, getAs, putAs, uploadAs, expectRefused } = templatesCompany();

// ── A Test Manager's save and upload ─────────────────────────────────────────
describe('PUT /v1/company/datafile/json by a Test Manager', () => {
  test('a template added to any scenario is refused, and nothing is stored', async () => {
    const before = onDisk();
    const file = storedFile();
    byCode(file, 'BEN_1').label = TOKEN;
    expectRefused(await putAs(TM, file), 'scenario "BEN_1": label');
    expect(onDisk()).toBe(before);
  });

  test('saving the file back while it holds old ones is not refused', async () => {
    seed(storedFile({ legacy: true }));
    const file = storedFile({ legacy: true });
    file.scenarios.push(scenario('TM_NEW', TM, 10));
    expect((await putAs(TM, file)).status).toBe(200);
    expect(JSON.parse(onDisk()).scenarios.map(s => s.code)).toContain('TM_NEW');
  });

  // The editor sends every scenario back with two fields it fills in on its own,
  // and with what the server added when it served the file. An untouched
  // scenario is then not byte-equal to the stored one, and must not be taken
  // for a new one because of that.
  test('nor is it when the editor has filled in its own fields, reordered or removed scenarios', async () => {
    seed(storedFile({ legacy: true }));
    const file = (await getAs(TM)).body;                           // what the editor loads
    for (const sc of file.scenarios) {
      sc.salesFlowActions = { patchPassengers: true, placeSelection: true, addAncillary: true, getBooking: true, deleteAncillary: true };
      sc.offerSearchCriteria = {};
    }
    file.scenarios.reverse();
    file.scenarios.pop();                                          // SHARED_1 is deleted
    file.passengersList.shift();
    expect((await putAs(TM, file)).status).toBe(200);
    expect(byCode(JSON.parse(onDisk()), 'BEN_1').label).toBe(`ben ${TOKEN}`);
  });

  test('the keys only a Test Manager writes are not this rule\'s business', async () => {
    const file = storedFile();
    file.systemInfoParameters.note = `${OPEN}requestor${CLOSE}`;
    expect((await putAs(TM, file)).status).toBe(200);
  });
});

describe('POST /v1/company/datafile (upload)', () => {
  test('a file that adds a template is refused, and the stored file stays', async () => {
    const before = onDisk();
    const file = storedFile();
    file.passengersList[0].passengers[0].firstName = TOKEN;
    expectRefused(await uploadAs(TM, file), 'passengersList, entry 1: passengers[0].firstName');
    expect(onDisk()).toBe(before);
  });

  test('the same file uploaded again, old templates and all, is accepted', async () => {
    seed(storedFile({ legacy: true }));
    expect((await uploadAs(TM, storedFile({ legacy: true }))).status).toBe(200);
  });

  test('a clean file is accepted; JSON that is not a datafile no longer is (#549)', async () => {
    expect((await uploadAs(TM, storedFile())).status).toBe(200);
    expect((await uploadAs(TM, '[1, 2, 3]')).status).toBe(400);
  });

  test('a first upload, with nothing stored, is looked at whole', async () => {
    unseed();
    const file = storedFile();
    byCode(file, 'SHARED_1').label = TOKEN;
    expectRefused(await uploadAs(TM, file), 'scenario "SHARED_1": label');
    expect(isStored()).toBe(false);
    expect((await uploadAs(TM, storedFile())).status).toBe(200);
  });
});
