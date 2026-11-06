// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Two companies never share a name: the administrator could not tell them
 * apart when placing an access request. The platform company counts too.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-company-names';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');
const { ensurePlatformCompany } = require('../../src/api/helpers/shared');

const app = express();
app.use(express.json());
app.use('/v1/admin', require('../../src/api/routes/admin'));

const PLAT = ensurePlatformCompany();
const ADMIN = uuidv4();
const ACME = uuidv4();
const OLD_TWIN = uuidv4();
let token;

beforeAll(() => {
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`,
    [ADMIN, PLAT.id, `adm-${ADMIN.slice(0, 8)}@names.test`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'Acme Rail', ?)`, [ACME, `acme-${ACME.slice(0, 8)}`]);
  // A company that shares the platform's name since before the rule.
  run(`INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)`, [OLD_TWIN, PLAT.name, `twin-${OLD_TWIN.slice(0, 8)}`]);
  token = `Bearer ${jwt.sign({ sub: ADMIN, email: `adm-${ADMIN.slice(0, 8)}@names.test`, companyId: PLAT.id, role: 'administrator' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
});

const create = (name, slug) => request(app).post('/v1/admin/companies').set('Authorization', token).send({ name, slug });
const rename = (id, name) => request(app).patch(`/v1/admin/companies/${id}`).set('Authorization', token).send({ name });

test('a new company may not take a name already used, whatever its case or spaces', async () => {
  for (const name of ['Acme Rail', '  acme rail ', 'ACME RAIL', PLAT.name]) {
    const res = await create(name, `n-${uuidv4().slice(0, 8)}`);
    expect(res.status).toBe(409);
    expect(res.body.detail).toMatch(/already has this name/);
  }
  const ok = await create('  Beta Rail ', `beta-${uuidv4().slice(0, 8)}`);
  expect(ok.status).toBe(201);
  expect(ok.body.company.name).toBe('Beta Rail');
});

test('a rename may not take another company\'s name; keeping its own name passes', async () => {
  expect((await rename(ACME, 'beta rail')).status).toBe(409);
  expect((await rename(ACME, 'ACME RAIL')).status).toBe(200);
  // The old twin can still be saved under its name, and renamed away from it.
  expect((await rename(OLD_TWIN, PLAT.name)).status).toBe(200);
  expect((await rename(OLD_TWIN, 'UIC Tests')).status).toBe(200);
  expect(get('SELECT name FROM companies WHERE id = ?', [OLD_TWIN]).name).toBe('UIC Tests');
});

test('a provider may share a company\'s name', async () => {
  const provider = uuidv4();
  run(`INSERT INTO companies (id, name, slug, parent_id) VALUES (?, 'Gamma', ?, ?)`, [provider, `gamma-${provider.slice(0, 8)}`, ACME]);
  expect((await create('Gamma', `gamma-top-${uuidv4().slice(0, 8)}`)).status).toBe(201);
});
