// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #862: a provider's filled checklist, imported in Test Config, kept with its
 * date, previewed against the one applied before, and applied to the Test
 * Framework and the Test Data only once the Test Manager validates the
 * preview. The simulator's alpha and gamma checklists stand for two versions
 * of one provider's.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-checklist';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, all, colDecrypt } = require('../../src/db/db');
const { storeFramework, frameworkConfigOf } = require('../../src/api/helpers/configurationStore');
const { buildZip } = require('../../src/utils/zip');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-checklist'));

const companyId = uuidv4();
const providerId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const otherTmId = uuidv4();
const testerId = uuidv4();
const BASE = '/v1/company/checklists';
const sheet = name => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Documentation', 'Server_Operations', 'Simulator checklists',
  `OSCAR_Test_Config_Checklist_Simulator_${name}.docx`));
const ALPHA = sheet('alpha');
const GAMMA = sheet('gamma');

function token(role, uid, cid = companyId) {
  return `Bearer ${jwt.sign({ sub: uid, email: `${role}-${uid.slice(0, 4)}@cl-cfg.com`, companyId: cid, role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
}
const tm = () => token('test_manager', tmId);
const upload = (buf, { auth = tm(), name = 'filled.docx', provider = providerId } = {}) => request(app).post(BASE)
  .set('Authorization', auth).set('X-Provider-Id', provider)
  .attach('checklist', buf, { filename: name, contentType: 'application/octet-stream' });
const call = (method, url, { provider = providerId, body } = {}) => {
  const r = request(app)[method](url).set('Authorization', tm()).set('X-Provider-Id', provider);
  return body ? r.send(body) : r;
};
const resourcesOf = cid => all('SELECT resource_type, label FROM test_resources WHERE company_id = ? ORDER BY created_at, id', [cid]);

beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'CL CFG', 'cl-cfg')`, [companyId]);
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'CL CFG Provider', 'cl-cfg-provider', ?)`, [providerId, companyId]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'CL CFG Other', 'cl-cfg-other')`, [otherId]);
  for (const [id, cid, role] of [[tmId, companyId, 'test_manager'], [testerId, companyId, 'company_user'], [otherTmId, otherId, 'test_manager']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, cid, `${id}@cl-cfg.com`, role]);
  }
});

describe('#862 who may import', () => {
  test('testers and certifiers are refused before the file is read; another company\'s provider is not found', async () => {
    for (const t of [token('company_user', testerId), token('certification_user', uuidv4())]) {
      expect((await upload(ALPHA, { auth: t, provider: '' })).status).toBe(403);
      expect((await request(app).get(BASE).set('Authorization', t)).status).toBe(403);
    }
    // A tester without access to the provider does not see it at all.
    expect((await upload(ALPHA, { auth: token('company_user', testerId) })).status).toBe(404);
    expect((await upload(ALPHA, { auth: token('test_manager', otherTmId, otherId) })).status).toBe(404);
    expect(get('SELECT COUNT(*) AS n FROM checklist_import').n).toBe(0);
  });

  test('only a Word file with answers', async () => {
    expect((await upload(Buffer.from('{}'), { name: 'x.json' })).status).toBe(400);
    const empty = buildZip([{ name: 'word/document.xml', data: Buffer.from('<w:document/>') }]);
    const res = await upload(empty);
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/No answer found/);
    expect(get('SELECT COUNT(*) AS n FROM checklist_import').n).toBe(0);
  });
});

describe('#862 a first checklist', () => {
  let first;
  test('an import changes nothing and answers a preview', async () => {
    const res = await upload(ALPHA, { name: 'Provider 2026-10-01.docx' });
    expect(res.status).toBe(201);
    first = res.body;
    expect(first.import).toMatchObject({ fileName: 'Provider 2026-10-01.docx', status: 'waiting', importedBy: `${tmId}@cl-cfg.com` });
    expect(first.import.importedAt).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    expect(first.import.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.previous).toBeNull();
    expect(first.answerChanges).toBeNull();
    expect(first.framework.created).toBe(true);
    expect(first.framework.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'osdmVersion', before: null, after: '3.6' })]));
    expect(first.testData.add.length).toBeGreaterThan(0);
    expect(first.testData.add.some(r => r.type === 'JOURNEY')).toBe(true);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toHaveProperty('proposedFramework');
    expect(frameworkConfigOf(providerId)).toBeNull();
    expect(resourcesOf(providerId)).toEqual([]);
  });

  test('the answers are kept encrypted, never the API Config or contact ones', () => {
    const row = get('SELECT * FROM checklist_import WHERE id = ?', [first.import.id]);
    expect(row.answers_enc).not.toMatch(/fw\./);
    const answers = JSON.parse(colDecrypt(row.answers_enc));
    expect(Object.keys(answers).some(t => /^(api|meta)\./.test(t))).toBe(false);
    expect(Object.keys(answers).length).toBe(row.answer_count);
  });

  test('applying needs the preview\'s hash', async () => {
    expect((await call('post', `${BASE}/${first.import.id}/apply`, { body: {} })).status).toBe(400);
    const wrong = await call('post', `${BASE}/${first.import.id}/apply`, { body: { hash: 'f'.repeat(64) } });
    expect(wrong.status).toBe(409);
    expect(wrong.body.preview.hash).toBe(first.hash);
    expect(frameworkConfigOf(providerId)).toBeNull();
  });

  test('applied: the framework and the Test Data are written, and the AI analysis is told about the checklist', async () => {
    const res = await call('post', `${BASE}/${first.import.id}/apply`, { body: { hash: first.hash, testData: 'add' } });
    expect(res.status).toBe(200);
    expect(res.body.import.status).toBe('applied');
    expect(res.body.testData.trains_added + res.body.testData.journeys_added).toBe(first.testData.add.length);
    expect(frameworkConfigOf(providerId).osdmVersion).toBe('3.6');
    expect(resourcesOf(providerId)).toHaveLength(first.testData.add.length);
    expect(get('SELECT file_name FROM provider_checklist WHERE company_id = ?', [providerId]).file_name).toBe('Provider 2026-10-01.docx');
    // The distributor is untouched.
    expect(frameworkConfigOf(companyId)).toBeNull();
    // Applied once only.
    expect((await call('post', `${BASE}/${first.import.id}/apply`, { body: { hash: first.hash } })).status).toBe(409);
  });
});

describe('#862 a newer checklist', () => {
  let second;
  test('its preview is set against the one applied, and keeps what the checklist does not ask', async () => {
    const fw = frameworkConfigOf(providerId);
    storeFramework(providerId, { ...fw, offerCombinations: { count: 3, seed: 7 } });
    const res = await upload(GAMMA, { name: 'Provider 2026-10-15.docx' });
    expect(res.status).toBe(201);
    second = res.body;
    expect(second.previous).toMatchObject({ kind: 'applied', fileName: 'Provider 2026-10-01.docx' });
    expect(second.answerChanges).toEqual(expect.arrayContaining([
      { question: 'fw.osdmVersion', before: '3.6', after: '3.8' },
    ]));
    expect(second.framework.created).toBe(false);
    expect(second.framework.changes).toEqual(expect.arrayContaining([{ path: 'osdmVersion', before: '3.6', after: '3.8' }]));
    expect(second.framework.changes.some(c => c.path.startsWith('offerCombinations'))).toBe(false);
    expect(second.testData.alreadyThere).toBeGreaterThan(0);
  });

  test('a change after the preview asks for a new one', async () => {
    // A setting the checklist does not ask, so only the hash tells.
    storeFramework(providerId, { ...frameworkConfigOf(providerId), customNote: 'set by hand' });
    const res = await call('post', `${BASE}/${second.import.id}/apply`, { body: { hash: second.hash } });
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/changed since this preview/);
    expect(frameworkConfigOf(providerId).osdmVersion).toBe('3.6');
  });

  test('replace: the preview names the trains removed, and the apply follows it', async () => {
    const preview = await call('get', `${BASE}/${second.import.id}/preview?testData=replace`);
    expect(preview.status).toBe(200);
    expect(preview.body.testData.mode).toBe('replace');
    expect(preview.body.testData.remove.length).toBe(resourcesOf(providerId).length);
    expect((await call('get', `${BASE}/${second.import.id}/preview?testData=wipe`)).status).toBe(400);
    const res = await call('post', `${BASE}/${second.import.id}/apply`, { body: { hash: preview.body.hash, testData: 'replace' } });
    expect(res.status).toBe(200);
    const fw = frameworkConfigOf(providerId);
    expect(fw.osdmVersion).toBe('3.8');
    expect(fw.offerCombinations).toEqual({ count: 3, seed: 7 });
    expect(fw.customNote).toBe('set by hand');
    expect(resourcesOf(providerId)).toHaveLength(preview.body.testData.add.length);
  });
});

describe('#862 discarding and the list', () => {
  test('a new import sets aside the one waiting; a discarded one cannot be applied', async () => {
    const a = (await upload(ALPHA)).body;
    const b = (await upload(GAMMA)).body;
    expect(get('SELECT status FROM checklist_import WHERE id = ?', [a.import.id]).status).toBe('discarded');
    const discard = await call('post', `${BASE}/${b.import.id}/discard`);
    expect(discard.status).toBe(200);
    expect(discard.body.import.status).toBe('discarded');
    expect((await call('post', `${BASE}/${b.import.id}/apply`, { body: { hash: b.hash } })).status).toBe(409);
    expect((await call('post', `${BASE}/${b.import.id}/discard`)).status).toBe(409);
  });

  test('every import is kept with its date, newest first, per company or provider', async () => {
    const res = await call('get', BASE);
    expect(res.status).toBe(200);
    expect(res.body.imports.map(i => i.status)).toEqual(['discarded', 'discarded', 'applied', 'applied']);
    expect(res.body.imports.every(i => i.importedAt && i.fileName)).toBe(true);
    expect((await call('get', BASE, { provider: '' })).body.imports).toEqual([]);
    expect((await call('get', `${BASE}/${res.body.imports[0].id}/preview`, { provider: '' })).status).toBe(404);
  });
});
