// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A company's data files are named after its slug: a new slug renames them,
 * so Restore previous file and the company's deletion still find them. Files
 * left under an old slug name are renamed at start.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-slug-rename';

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const fs = require('node:fs');
const { randomUUID: uuidv4 } = require('node:crypto');
const { run, get } = require('../../src/db/db');
const { ensurePlatformCompany } = require('../../src/api/helpers/shared');
const { liveDatafilePath, previousDatafilePath, DATAFILES_DIR } = require('../../src/utils/datafileWrite');
const { alignDatafileNames } = require('../../src/utils/datafileRename');

const app = express();
app.use(express.json());
app.use('/v1/admin', require('../../src/api/routes/admin'));

const PLAT = ensurePlatformCompany();
const ADMIN = uuidv4();
let token;

beforeAll(() => {
  fs.mkdirSync(DATAFILES_DIR, { recursive: true });
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', 'administrator')`,
    [ADMIN, PLAT.id, `adm-${ADMIN.slice(0, 8)}@slug.test`]);
  token = `Bearer ${jwt.sign({ sub: ADMIN, email: `adm-${ADMIN.slice(0, 8)}@slug.test`, companyId: PLAT.id, role: 'administrator' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
});

// A company with its live and previous files under its slug's names.
function companyWithFiles() {
  const id = uuidv4();
  const slug = `old-${id.slice(0, 8)}`;
  fs.writeFileSync(liveDatafilePath(slug), 'live');
  fs.writeFileSync(previousDatafilePath(slug), 'previous');
  run(`INSERT INTO companies (id, name, slug, datafile_path) VALUES (?, ?, ?, ?)`, [id, `Co ${id.slice(0, 8)}`, slug, liveDatafilePath(slug)]);
  return { id, slug };
}
const patch = (id, body) => request(app).patch(`/v1/admin/companies/${id}`).set('Authorization', token).send(body);

test('a new slug renames the live and previous files and the stored path', async () => {
  const { id, slug } = companyWithFiles();
  const newSlug = `new-${id.slice(0, 8)}`;
  expect((await patch(id, { slug: newSlug })).status).toBe(200);
  expect(fs.readFileSync(liveDatafilePath(newSlug), 'utf8')).toBe('live');
  expect(fs.readFileSync(previousDatafilePath(newSlug), 'utf8')).toBe('previous');
  expect(fs.existsSync(liveDatafilePath(slug))).toBe(false);
  expect(fs.existsSync(previousDatafilePath(slug))).toBe(false);
  expect(get('SELECT slug, datafile_path FROM companies WHERE id = ?', [id])).toEqual({ slug: newSlug, datafile_path: liveDatafilePath(newSlug) });
});

test('a slug whose file name is taken by a file left on the server is refused, nothing moved', async () => {
  const { id, slug } = companyWithFiles();
  const newSlug = `taken-${id.slice(0, 8)}`;
  fs.writeFileSync(liveDatafilePath(newSlug), 'left over');
  const res = await patch(id, { slug: newSlug });
  expect(res.status).toBe(409);
  expect(get('SELECT slug FROM companies WHERE id = ?', [id]).slug).toBe(slug);
  expect(fs.readFileSync(liveDatafilePath(slug), 'utf8')).toBe('live');
  expect(fs.readFileSync(liveDatafilePath(newSlug), 'utf8')).toBe('left over');
});

test('a name change alone touches no file', async () => {
  const { id, slug } = companyWithFiles();
  expect((await patch(id, { name: `Renamed ${id.slice(0, 8)}` })).status).toBe(200);
  expect(fs.existsSync(liveDatafilePath(slug))).toBe(true);
});

test('files left under an old slug are renamed at start', () => {
  const { id, slug } = companyWithFiles();
  const newSlug = `moved-${id.slice(0, 8)}`;
  run('UPDATE companies SET slug = ? WHERE id = ?', [newSlug, id]);   // as before 1.11.471
  alignDatafileNames();
  expect(get('SELECT datafile_path FROM companies WHERE id = ?', [id]).datafile_path).toBe(liveDatafilePath(newSlug));
  expect(fs.readFileSync(previousDatafilePath(newSlug), 'utf8')).toBe('previous');
  expect(fs.existsSync(liveDatafilePath(slug))).toBe(false);
});

test('deleting a company removes a live file still under an old name', async () => {
  const { id, slug } = companyWithFiles();
  run('UPDATE companies SET slug = ? WHERE id = ?', [`gone-${id.slice(0, 8)}`, id]);
  expect((await request(app).delete(`/v1/admin/companies/${id}`).set('Authorization', token)).status).toBe(200);
  expect(fs.existsSync(liveDatafilePath(slug))).toBe(false);
});
