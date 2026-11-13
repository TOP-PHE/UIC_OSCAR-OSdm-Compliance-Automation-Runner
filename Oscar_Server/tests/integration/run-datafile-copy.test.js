// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1235: the run's copy of the data file (GET /data/:filename with a run's
// secret) is made once per version of the data file, the Test Framework and
// the Test Data, then served from memory. Before, every run of a batch
// decrypted, parsed and rewrote the same file on the server's thread.

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');

jest.mock('../../src/worker/access-token');
process.env.PORT = '0';
const app = require('../../src/server');
const { run, colEncrypt } = require('../../src/db/db');
const { encryptToFile } = require('../../src/utils/at-rest');
const runSecrets = require('../../src/utils/runSecrets');
const metrics = require('../../src/utils/metrics');
const runDatafile = require('../../src/utils/runDatafile');

const DATAFILES_DIR = path.resolve(__dirname, '../../data/datafiles');
const made = [];

function seedCompany(name) {
  const id = uuidv4();
  const slug = `rdc-${name}-${id.slice(0, 8)}`;
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [id, `${name} ${id}`, slug]);
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  const filePath = path.join(DATAFILES_DIR, `${slug}-datafile.json`);
  made.push({ id, filePath });
  return { id, slug, filePath };
}

function storeDatafile(company, datafile) {
  encryptToFile(Buffer.from(JSON.stringify(datafile)), company.filePath);
}

function storeFramework(company, framework) {
  run('DELETE FROM test_frameworks WHERE company_id = ?', [company.id]);
  run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [uuidv4(), company.id, colEncrypt(JSON.stringify(framework))]);
}

// The run's copy, as a run of `company` reads it.
async function runCopy(company) {
  const runId = uuidv4();
  const secret = runSecrets.issue(runId, company.id);
  try {
    return await request(app).get(`/data/${company.slug}-datafile.json`)
      .set('X-OSCAR-Run-Id', runId)
      .set('X-OSCAR-Run-Secret', secret);
  } finally {
    runSecrets.revoke(runId);
  }
}

async function reads(from) {
  const text = await metrics.register.getSingleMetricAsString('oscar_run_datafile_reads_total');
  const m = new RegExp(`\\{use="copy",from="${from}"\\} (\\d+)`).exec(text);
  return m ? Number(m[1]) : 0;
}

beforeEach(() => runDatafile.forgetAll());

afterAll(() => {
  for (const c of made) {
    fs.rmSync(c.filePath, { force: true });
    run('DELETE FROM companies WHERE id = ?', [c.id]);
  }
});

describe('the run\'s copy of the data file, made once per version (#1235)', () => {
  test('the second run gets the same bytes, from memory', async () => {
    const c = seedCompany('same');
    storeFramework(c, { osdmVersion: '3.8.0', salesFlows: ['SALE'] });
    storeDatafile(c, { scenarios: [{ code: 'S1' }, { code: 'S2', osdmVersion: '3.6.0' }] });
    const fileBefore = await reads('file');
    const memoryBefore = await reads('memory');
    const first = await runCopy(c);
    const second = await runCopy(c);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.text).toBe(first.text);
    expect(first.body.scenarios[0].osdmVersion).toBe('3.8.0');
    expect(await reads('file')).toBe(fileBefore + 1);
    expect(await reads('memory')).toBe(memoryBefore + 1);
    // Made again from nothing, the same bytes.
    runDatafile.forgetAll();
    expect((await runCopy(c)).text).toBe(first.text);
  });

  test('a new data file, a new framework or a new train makes a new copy', async () => {
    const c = seedCompany('change');
    storeFramework(c, { osdmVersion: '3.8.0' });
    storeDatafile(c, { scenarios: [{ code: 'S1' }] });
    expect((await runCopy(c)).body.scenarios[0].osdmVersion).toBe('3.8.0');

    storeFramework(c, { osdmVersion: '3.7.0' });
    expect((await runCopy(c)).body.scenarios[0].osdmVersion).toBe('3.7.0');

    storeDatafile(c, { scenarios: [{ code: 'S1' }, { code: 'NEW' }] });
    expect((await runCopy(c)).body.scenarios.map((s) => s.code)).toEqual(['S1', 'NEW']);

    const fileBefore = await reads('file');
    run(`INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, 'TRAIN', 'T', ?)`,
      [uuidv4(), c.id, colEncrypt(JSON.stringify({ services: [] }))]);
    expect((await runCopy(c)).status).toBe(200);
    expect(await reads('file')).toBe(fileBefore + 1);
  });

  test('each company gets its own copy', async () => {
    const a = seedCompany('alpha');
    const b = seedCompany('beta');
    storeDatafile(a, { scenarios: [{ code: 'ONLY_A' }] });
    storeDatafile(b, { scenarios: [{ code: 'ONLY_B' }] });
    for (let i = 0; i < 2; i++) {
      expect((await runCopy(a)).body.scenarios.map((s) => s.code)).toEqual(['ONLY_A']);
      expect((await runCopy(b)).body.scenarios.map((s) => s.code)).toEqual(['ONLY_B']);
    }
  });

  test('a copy holding "{{" is still refused when it is kept', async () => {
    const c = seedCompany('template');
    storeFramework(c, { products: [{ code: '{{access_token}}' }] });
    storeDatafile(c, { scenarios: [{ code: 'A', offerOptionDiscovery: true }] });
    for (let i = 0; i < 2; i++) {
      const res = await runCopy(c);
      expect(res.status).toBe(409);
      expect(res.text).not.toContain('access_token');
    }
  });
});

describe('the runner\'s checks read the data file once per version (#1235)', () => {
  test('the parsed file is kept, frozen, shared, and read again once it changes', async () => {
    const c = seedCompany('checks');
    storeDatafile(c, { scenarios: [{ code: 'S1' }] });
    const [one, two] = await Promise.all([runDatafile.forChecks(c.filePath), runDatafile.forChecks(c.filePath)]);
    expect([one.from, two.from].sort()).toEqual(['file', 'memory']);
    expect(two.value).toBe(one.value);
    expect(Object.isFrozen(one.value.scenarios[0])).toBe(true);
    expect(() => { one.value.scenarios[0].code = 'CHANGED'; }).toThrow(TypeError);
    expect((await runDatafile.forChecks(c.filePath)).from).toBe('memory');

    storeDatafile(c, { scenarios: [{ code: 'S2' }] });
    const after = await runDatafile.forChecks(c.filePath);
    expect(after.from).toBe('file');
    expect(after.value.scenarios[0].code).toBe('S2');
  });

  test('a file that cannot be read is tried again at the next run', async () => {
    const c = seedCompany('broken');
    fs.writeFileSync(c.filePath, 'not json');
    await expect(runDatafile.forChecks(c.filePath)).rejects.toThrow();
    storeDatafile(c, { scenarios: [{ code: 'FIXED' }] });
    expect((await runDatafile.forChecks(c.filePath)).value.scenarios[0].code).toBe('FIXED');
  });

  test('kept for at most MAX_ENTRIES companies, the least recent dropped first', () => {
    let makes = 0;
    const make = () => { makes += 1; return { body: Buffer.from('{}'), holdsTemplates: false }; };
    for (let i = 0; i <= runDatafile.MAX_ENTRIES; i++) runDatafile.runCopy(`company-${i}`, 'v1', make);
    expect(makes).toBe(runDatafile.MAX_ENTRIES + 1);
    expect(runDatafile.runCopy(`company-${runDatafile.MAX_ENTRIES}`, 'v1', make).from).toBe('memory');
    expect(runDatafile.runCopy('company-0', 'v1', make).from).toBe('file');
  });
});
