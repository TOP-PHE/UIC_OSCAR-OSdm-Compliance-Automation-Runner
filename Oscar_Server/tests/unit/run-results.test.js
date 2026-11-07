// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The result files a run sends to the server (utils/runResults.js, #1130):
 * kept encrypted in a folder the server owns, one file per name, within a
 * run's limits.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const R = require('../../src/utils/runResults');
const { isEncryptedBuffer } = require('../../src/utils/at-rest');

const ARTIFACTS_DIR = path.resolve(__dirname, '../../data/artifacts');
const runs = [];
function newRun() {
  const id = randomUUID();
  runs.push(id);
  return id;
}
afterAll(() => {
  for (const id of runs) fs.rmSync(path.join(ARTIFACTS_DIR, id), { recursive: true, force: true });
});

describe('result file names', () => {
  test.each([
    '20261107_uic-zeta_1a2b3c4d_SIM_SALE_1ADT_312_Report.html',
    '20261107_uic-zeta_1a2b3c4d_Report.html',
    '.bru_results_1a2b3c4d.json',
    '.report_tmp.json',
  ])('%s is a result file', (name) => {
    expect(R.resultNameProblem(name)).toBeNull();
  });

  test.each([
    '', '.', '..', '../oscar.db', 'a/b.json', 'a\\b.json', '..json', 'a..b.json',
    'report.html.exe', 'report', 'oscar.db', '.bru_results.json\0', 7, null,
  ])('%p is not', (name) => {
    expect(R.resultNameProblem(name)).not.toBeNull();
  });
});

describe('keeping a run\'s result files', () => {
  test('a file is kept encrypted, listed and read back as it was sent', async () => {
    const runId = newRun();
    const content = Buffer.from('{"results":[]}');
    await R.storeRunResult(runId, '.bru_results_1a2b3c4d.json', content);
    expect(await R.listRunResults(runId)).toEqual(['.bru_results_1a2b3c4d.json']);
    const onDisk = fs.readFileSync(path.join(ARTIFACTS_DIR, runId, 'incoming', '.bru_results_1a2b3c4d.json'));
    expect(isEncryptedBuffer(onDisk)).toBe(true);
    expect((await R.readRunResult(runId, '.bru_results_1a2b3c4d.json')).equals(content)).toBe(true);
  });

  test('a name is sent once', async () => {
    const runId = newRun();
    await R.storeRunResult(runId, 'a_Report.html', Buffer.from('<html>1</html>'));
    await expect(R.storeRunResult(runId, 'a_Report.html', Buffer.from('<html>2</html>')))
      .rejects.toMatchObject({ status: 409 });
    expect((await R.readRunResult(runId, 'a_Report.html')).toString()).toBe('<html>1</html>');
  });

  test('a run sends at most so many files', async () => {
    const runId = newRun();
    for (let i = 0; i < R.MAX_RESULT_FILES; i++) await R.storeRunResult(runId, `f${i}_Report.html`, Buffer.from('x'));
    await expect(R.storeRunResult(runId, 'one_more_Report.html', Buffer.from('x'))).rejects.toMatchObject({ status: 413 });
  });

  test('a bad name, an empty file, a body that is not bytes and a bad run id are refused', async () => {
    const runId = newRun();
    await expect(R.storeRunResult(runId, '../oscar.db', Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
    await expect(R.storeRunResult(runId, 'a_Report.html', Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
    await expect(R.storeRunResult(runId, 'a_Report.html', { not: 'bytes' })).rejects.toMatchObject({ status: 400 });
    await expect(R.storeRunResult('../x', 'a_Report.html', Buffer.from('x'))).rejects.toMatchObject({ status: 400 });
    expect(await R.listRunResults(runId)).toEqual([]);
  });

  test('a file over the limit is refused before anything is written', async () => {
    const runId = newRun();
    const big = { length: R.MAX_RESULT_BYTES + 1 };
    Object.setPrototypeOf(big, Buffer.prototype);           // a Buffer by type, without 100 MB of memory
    await expect(R.storeRunResult(runId, 'big_Report.html', big)).rejects.toMatchObject({ status: 413 });
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, runId, 'incoming'))).toBe(false);
  });

  test('the files go once linked; a run that sent none lists none', async () => {
    const runId = newRun();
    await R.storeRunResult(runId, 'a_Report.html', Buffer.from('x'));
    await R.removeRunResults(runId);
    expect(await R.listRunResults(runId)).toEqual([]);
    expect(await R.listRunResults(newRun())).toEqual([]);
    expect(await R.listRunResults('not-a-run')).toEqual([]);
  });
});
