// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-backup-status.test.js — #572: GET /v1/admin/backup-status is read
 * only and for administrators only, and nothing under it creates, schedules
 * or downloads a backup.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-backup-status';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const request = require('supertest');
const { buildAppWithRoute } = require('../helpers/test-app');
const { run } = require('../../src/db/db');

const app = buildAppWithRoute('/v1/admin', '../../src/api/routes/admin');
const companyId = randomUUID();
const adminId = randomUUID();
const token = (role) => jwt.sign({ sub: adminId, email: `${role}@bs-test.com`, companyId, role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-bs-route-'));
  process.env.OSCAR_BACKUP_STATUS_PATH = path.join(dir, 'backup-status.json');
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'BS Test Co', ?)`, [companyId, `bs-test-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, 'administrator@bs-test.com', 'x', 'administrator')`, [adminId, companyId]);
});
afterAll(() => {
  delete process.env.OSCAR_BACKUP_STATUS_PATH;
  run('DELETE FROM companies WHERE id = ?', [companyId]);
  run('DELETE FROM users WHERE id = ?', [adminId]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('401 without a token, 403 for every other role', async () => {
  expect((await request(app).get('/v1/admin/backup-status')).status).toBe(401);
  for (const role of ['company_user', 'test_manager', 'certification_user']) {
    const res = await request(app).get('/v1/admin/backup-status').set('Authorization', `Bearer ${token(role)}`);
    expect([role, res.status]).toEqual([role, 403]);
  }
});

test('no backup recorded yet', async () => {
  const res = await request(app).get('/v1/admin/backup-status').set('Authorization', `Bearer ${token('administrator')}`);
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ state: 'none' });
});

test('a recorded status, with only the members the page knows', async () => {
  fs.writeFileSync(process.env.OSCAR_BACKUP_STATUS_PATH, JSON.stringify({
    format: 1, updated_at: '2026-10-19T02:31:00Z', frequency: 'weekly', next_run: '2099-01-05T02:30:00Z', retention_keep: 6,
    archives_present: 2, last_backup_at: '2026-10-19T02:31:00Z', last_backup_ok: true, last_backup_size_bytes: 1000,
    last_success_at: '2026-10-19T02:31:00Z', last_failure_at: null, last_restore_drill_at: null, archive: '/root/oscar-backups/x.gpg',
  }));
  const res = await request(app).get('/v1/admin/backup-status').set('Authorization', `Bearer ${token('administrator')}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ state: 'reported', frequency: 'weekly', archives_present: 2, last_backup_ok: true, warnings: ['no_restore_drill'] });
  expect(JSON.stringify(res.body)).not.toContain('/root');
});

test('nothing creates, schedules or downloads a backup', async () => {
  const auth = { Authorization: `Bearer ${token('administrator')}` };
  for (const [method, url] of [['post', '/v1/admin/backup-status'], ['put', '/v1/admin/backup-status'], ['patch', '/v1/admin/backup-status'],
    ['delete', '/v1/admin/backup-status'], ['post', '/v1/admin/backup'], ['get', '/v1/admin/backup/download'], ['get', '/v1/admin/backup-status/download']]) {
    const res = await request(app)[method](url).set(auth);
    expect([method, url, res.status]).toEqual([method, url, 404]);
  }
  const router = require('../../src/api/routes/admin');
  const paths = router.stack.filter((l) => l.route).map((l) => l.route.path).filter((p) => /backup/i.test(p));
  expect(paths).toEqual(['/backup-status']);
  const layer = router.stack.find((l) => l.route && l.route.path === '/backup-status');
  expect(Object.keys(layer.route.methods)).toEqual(['get']);
});
