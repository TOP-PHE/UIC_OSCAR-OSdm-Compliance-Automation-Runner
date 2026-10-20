// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-shares.test.js — a distributor shares runs of a provider with the
 * company that operates it (#901).
 *
 * D (the distributor) owns provider P. O operates P and has its own company;
 * X is an unrelated company. The link P → O waits for O's Test Manager, a
 * share counts only while it is accepted, and the company shared with reads
 * the run, read only, with the distributor's people named "D…", never by
 * e-mail. Nothing it does reaches a write route.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-run-shares';

const express = require('express');
const jwt     = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get, colEncrypt } = require('../../src/db/db');

const app = express();
app.use(express.json());
app.use('/v1/company/providers', require('../../src/api/routes/company-providers'));
app.use('/v1/company',           require('../../src/api/routes/company-run-shares'));
app.use('/v1/runs',              require('../../src/api/routes/runs'));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => res.status(500).json({ status: 500, detail: err.message }));

const tag = uuidv4().slice(0, 8);
const ids = {};
for (const k of ['D', 'P', 'O', 'X', 'TMD', 'TD', 'TMO', 'TO', 'TMX', 'CERT', 'run1', 'run2', 'run3', 'run4']) ids[k] = uuidv4();

const users = {
  TMD:  { company: 'D', role: 'test_manager' },
  TD:   { company: 'D', role: 'company_user' },
  TMO:  { company: 'O', role: 'test_manager' },
  TO:   { company: 'O', role: 'company_user' },
  TMX:  { company: 'X', role: 'test_manager' },
  CERT: { company: 'X', role: 'certification_user' },
};
const emailOf = (who) => `${who.toLowerCase()}-${tag}@share.example`;
const distributorName = `UIC ${tag}`;

function token(who) {
  const u = users[who];
  return jwt.sign({ sub: ids[who], email: emailOf(who), companyId: ids[u.company], role: u.role },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
}
const as = (who) => ({ Authorization: `Bearer ${token(who)}` });

beforeAll(() => {
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [ids.D, distributorName, `d-${tag}`]);
  run('INSERT INTO companies (id, name, slug, parent_id) VALUES (?, ?, ?, ?)', [ids.P, `CHAPS provider ${tag}`, `p-${tag}`, ids.D]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [ids.O, `CHAPS ${tag}`, `o-${tag}`]);
  run('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)', [ids.X, `Other ${tag}`, `x-${tag}`]);
  for (const [who, u] of Object.entries(users)) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`,
      [ids[who], ids[u.company], emailOf(who), u.role]);
  }
  // run1, run2: the provider's; run3: the distributor's own; run4: still running.
  for (const [r, company, status] of [['run1', 'P', 'COMPLETED'], ['run2', 'P', 'FAILED'], ['run3', 'D', 'COMPLETED'], ['run4', 'P', 'RUNNING']]) {
    run(`INSERT INTO runs (id, company_id, user_id, status, batch_id, api_base_used) VALUES (?, ?, ?, ?, ?, ?)`,
      [ids[r], ids[company], ids.TD, status, `batch-${tag}`, 'https://provider.example/osdm']);
  }
  run(`UPDATE runs SET error_message = ? WHERE id = ?`, [`refused for ${emailOf('TD')}`, ids.run1]);
  run('INSERT INTO run_events (run_id, level, message) VALUES (?, ?, ?)',
    [ids.run1, 'info', colEncrypt(`[runner] Run started — company=p-${tag} user=${emailOf('TD')} auth_mode=oauth2`)]);
  run('INSERT INTO run_events (run_id, level, message) VALUES (?, ?, ?)',
    [ids.run1, 'info', colEncrypt(`scenario created by ${emailOf('TMD').toUpperCase()}`)]);
});

afterAll(() => {
  run('DELETE FROM run_share WHERE company_id IN (?, ?)', [ids.O, ids.X]);
  run('DELETE FROM provider_operator WHERE provider_id = ?', [ids.P]);
  run('DELETE FROM runs WHERE id IN (?, ?, ?, ?)', [ids.run1, ids.run2, ids.run3, ids.run4]);
  run('DELETE FROM auth_events WHERE email LIKE ?', [`%-${tag}@share.example`]);
  run('DELETE FROM companies WHERE parent_id = ?', [ids.D]);
  run('DELETE FROM companies WHERE id IN (?, ?, ?)', [ids.D, ids.O, ids.X]);
  run('DELETE FROM users WHERE email LIKE ?', [`%-${tag}@share.example`]);
});

const share = (who, r) => request(app).post(`/v1/runs/${ids[r]}/share-with-operator`).set(as(who));
const unshare = (who, r) => request(app).delete(`/v1/runs/${ids[r]}/share-with-operator`).set(as(who));
const readRun = (who, r) => request(app).get(`/v1/runs/${ids[r]}`).set(as(who));
const link = (company) => request(app).put(`/v1/company/providers/${ids.P}/operator`).set(as('TMD')).send({ company_id: ids[company] });
const decide = (who, verb) => request(app).post(`/v1/company/run-share-links/${ids.P}/${verb}`).set(as(who));

describe('the link, and its acceptance', () => {
  test('nothing can be shared before a link exists', async () => {
    const res = await share('TMD', 'run1');
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/linked to no company/);
  });

  test('only the distributor\'s Test Manager links, to another company of OSCAR', async () => {
    expect((await request(app).put(`/v1/company/providers/${ids.P}/operator`).set(as('TD')).send({ company_id: ids.O })).status).toBe(403);
    expect((await request(app).put(`/v1/company/providers/${ids.P}/operator`).set(as('TMD')).send({ company_id: ids.D })).status).toBe(400);
    expect((await request(app).put(`/v1/company/providers/${ids.P}/operator`).set(as('TMD')).send({ company_id: ids.P })).status).toBe(400);
    expect((await request(app).put(`/v1/company/providers/${ids.P}/operator`).set(as('TMO')).send({ company_id: ids.O })).status).toBe(404);
    const candidates = await request(app).get('/v1/company/providers/operator-companies').set(as('TMD'));
    expect(candidates.body.companies.map((c) => c.id)).toEqual(expect.arrayContaining([ids.O, ids.X]));
    expect(candidates.body.companies.map((c) => c.id)).not.toContain(ids.D);
    expect(candidates.body.companies.map((c) => c.id)).not.toContain(ids.P);
  });

  test('a link waits for the other company, and nothing is shared meanwhile', async () => {
    const res = await link('O');
    expect(res.status).toBe(200);
    expect(res.body.provider.operator).toMatchObject({ company_id: ids.O, status: 'waiting' });
    expect((await share('TMD', 'run1')).body.detail).toMatch(/not accepted the link \(waiting\)/);
  });

  test('the other company\'s Test Manager sees the link and accepts it; its testers and others do not', async () => {
    const links = await request(app).get('/v1/company/run-share-links').set(as('TMO'));
    expect(links.status).toBe(200);
    expect(links.body.links).toEqual([expect.objectContaining({ provider_id: ids.P, distributor_name: distributorName, status: 'waiting' })]);
    expect((await request(app).get('/v1/company/run-share-links').set(as('TO'))).status).toBe(403);
    expect((await request(app).get('/v1/company/run-share-links').set(as('TMX'))).body.links).toEqual([]);
    expect((await decide('TMX', 'accept')).status).toBe(404);
    expect((await decide('TO', 'accept')).status).toBe(403);
    const accepted = await decide('TMO', 'accept');
    expect(accepted.status).toBe(200);
    expect(accepted.body.link.status).toBe('accepted');
  });
});

describe('sharing runs', () => {
  test('only terminal runs of the provider, by the distributor\'s Test Manager', async () => {
    expect((await share('TD', 'run1')).status).toBe(403);
    expect((await share('TMO', 'run1')).status).toBe(404);
    expect((await share('TMD', 'run3')).body.detail).toMatch(/Only runs of a provider/);
    expect((await share('TMD', 'run4')).status).toBe(409);
    expect((await share('TMD', 'run1')).status).toBe(200);
  });

  test('the company shared with reads the run, with the distributor named, never a person', async () => {
    const res = await readRun('TMO', 'run1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ids.run1, status: 'COMPLETED', submitted_by: distributorName,
      shared: { distributor: distributorName, provider: `CHAPS provider ${tag}` } });
    expect(res.body).not.toHaveProperty('user_id');
    expect(res.body).not.toHaveProperty('error_message');
    expect(JSON.stringify(res.body)).not.toContain('@share.example');

    const logs = await request(app).get(`/v1/runs/${ids.run1}/logs`).set(as('TMO'));
    expect(logs.status).toBe(200);
    const text = logs.body.events.map((e) => e.message).join('\n');
    expect(text).toContain(`user=${distributorName} auth_mode`);
    expect(text).toContain(`scenario created by ${distributorName}`);
    expect(text).not.toContain('@share.example');
    expect(text.toLowerCase()).not.toContain('@share.example');

    const list = await request(app).get('/v1/company/shared-runs').set(as('TMO'));
    expect(list.body.runs.map((r) => r.id)).toEqual([ids.run1]);
    expect(list.body.runs[0].submitted_by).toBe(distributorName);
  });

  test('the distributor still sees its own run as it is', async () => {
    const res = await readRun('TMD', 'run1');
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(ids.TD);
    const logs = await request(app).get(`/v1/runs/${ids.run1}/logs`).set(as('TMD'));
    expect(logs.body.events.map((e) => e.message).join('\n')).toContain(emailOf('TD'));
  });

  test('nobody else reads it: the other company\'s testers, an unrelated Test Manager, a certifier', async () => {
    for (const who of ['TO', 'TMX', 'CERT']) {
      expect((await readRun(who, 'run1')).status).toBe(404);
      expect((await request(app).get(`/v1/runs/${ids.run1}/logs`).set(as(who))).status).toBe(404);
    }
    expect((await readRun('TMO', 'run2')).status).toBe(404);
    expect((await request(app).get('/v1/company/shared-runs').set(as('TMX'))).body.runs).toEqual([]);
  });

  test('read only: every write route answers 404 to the company shared with', async () => {
    expect((await request(app).delete(`/v1/runs/${ids.run1}`).set(as('TMO'))).status).toBe(404);
    expect((await request(app).delete(`/v1/runs/${ids.run1}/cancel`).set(as('TMO'))).status).toBe(404);
    expect((await request(app).post(`/v1/runs/${ids.run1}/share`).set(as('TMO'))).status).toBe(404);
    expect((await unshare('TMO', 'run1')).status).toBe(404);
    expect((await request(app).post('/v1/runs/bulk-delete').set(as('TMO')).send({ run_ids: [ids.run1] })).body).not.toMatchObject({ deleted: 1 });
    expect(get('SELECT status FROM runs WHERE id = ?', [ids.run1]).status).toBe('COMPLETED');
    expect(get('SELECT shared_with_certifier_at FROM runs WHERE id = ?', [ids.run1]).shared_with_certifier_at).toBeNull();
  });
});

describe('what stops a share', () => {
  test('revoking it, then sharing again', async () => {
    expect((await unshare('TMD', 'run1')).status).toBe(200);
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    expect((await share('TMD', 'run1')).status).toBe(200);
    expect((await readRun('TMO', 'run1')).status).toBe(200);
  });

  test('the other company refusing the link', async () => {
    expect((await decide('TMO', 'refuse')).body.link.status).toBe('refused');
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    expect((await request(app).get('/v1/company/shared-runs').set(as('TMO'))).body.runs).toEqual([]);
    expect((await decide('TMO', 'accept')).body.link.status).toBe('accepted');
    expect((await readRun('TMO', 'run1')).status).toBe(200);
  });

  test('the sharer no longer a Test Manager of the distributor', async () => {
    run(`UPDATE users SET role = 'company_user' WHERE id = ?`, [ids.TMD]);
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    run(`UPDATE users SET role = 'test_manager' WHERE id = ?`, [ids.TMD]);
    expect((await readRun('TMO', 'run1')).status).toBe(200);
  });

  test('the reader no longer a Test Manager of the company', async () => {
    run(`UPDATE users SET role = 'company_user' WHERE id = ?`, [ids.TMO]);
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    run(`UPDATE users SET role = 'test_manager' WHERE id = ?`, [ids.TMO]);
  });

  test('the link moved to another company: neither reads the old shares', async () => {
    expect((await link('X')).body.provider.operator.status).toBe('waiting');
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    expect((await readRun('TMX', 'run1')).status).toBe(404);
  });

  test('the link removed', async () => {
    await link('O');
    await decide('TMO', 'accept');
    expect((await readRun('TMO', 'run1')).status).toBe(200);
    expect((await request(app).delete(`/v1/company/providers/${ids.P}/operator`).set(as('TMD'))).status).toBe(200);
    expect((await readRun('TMO', 'run1')).status).toBe(404);
  });
});

describe('the audit log', () => {
  test('names each link, decision and share', () => {
    const events = require('../../src/db/db').all('SELECT event_type FROM auth_events WHERE email LIKE ?', [`%-${tag}@share.example`])
      .map((e) => e.event_type.split(':')[0]);
    for (const kind of ['provider_operator_linked', 'run_share_link_accepted', 'run_share_link_refused',
      'run_shared_with_operator', 'run_unshared_with_operator', 'provider_operator_unlinked']) {
      expect(events).toContain(kind);
    }
  });
});

describe('a whole batch', () => {
  test('shares every terminal run of the provider, says why for the others, and revokes them all', async () => {
    await link('O');
    await decide('TMO', 'accept');
    const res = await request(app).post(`/v1/runs/batch/batch-${tag}/share-with-operator`).set(as('TMD'));
    expect(res.status).toBe(200);
    expect(res.body.shared).toBe(2);
    const byId = Object.fromEntries(res.body.runs.map((r) => [r.id, r]));
    expect(byId[ids.run3].reason).toMatch(/Only runs of a provider/);
    expect(byId[ids.run4].reason).toMatch(/RUNNING/);
    expect((await readRun('TMO', 'run2')).status).toBe(200);
    expect((await request(app).post(`/v1/runs/batch/batch-${tag}/share-with-operator`).set(as('TMO'))).status).toBe(404);
    expect((await request(app).delete(`/v1/runs/batch/batch-${tag}/share-with-operator`).set(as('TMD'))).status).toBe(200);
    expect((await readRun('TMO', 'run1')).status).toBe(404);
    expect((await readRun('TMO', 'run2')).status).toBe(404);
  });
});
