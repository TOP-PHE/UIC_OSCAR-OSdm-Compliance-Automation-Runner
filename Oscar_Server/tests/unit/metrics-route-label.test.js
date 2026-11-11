// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1196: the `route` label of oscar_http_request_duration_seconds is the
// router's mount path and the route's pattern. With the pattern alone, the
// root of every router read "/" (the run list, a batch, the company…), and
// the slowest route of a load test could not be named.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const metrics = require('../../src/utils/metrics');

const SERVER = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');

function appLikeServer(publicDir) {
  const app = express();
  app.use(metrics.httpDurationMiddleware);
  const runs = express.Router();
  runs.get('/', (req, res) => res.json({ list: true }));
  runs.post('/', (req, res) => res.status(202).json({ queued: true }));
  // Answers later, as the database-backed handlers do.
  runs.get('/:id', (req, res) => setTimeout(() => res.json({ id: req.params.id }), 5));
  app.use('/v1/runs', runs);
  const company = express.Router();
  company.use((req, res, next) => (req.headers.authorization ? next() : res.status(401).json({ status: 401 })));
  company.get('/datafile', (req, res) => res.json({}));
  app.use('/v1/company', company);
  app.get('/v1/health', (req, res) => res.json({ ok: true }));
  app.use(express.static(publicDir));
  app.get('/{*splat}', (req, res) => res.status(200).send('page'));
  return app;
}

async function labelsOf() {
  const text = await metrics.register.getSingleMetricAsString('oscar_http_request_duration_seconds');
  return new Set([...text.matchAll(/route="([^"]*)"/g)].map(m => m[1]));
}

let dir;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-route-label-'));
  fs.writeFileSync(path.join(dir, 'esc.js'), '// a page script');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a route reads its router\'s path and its pattern, never an id', async () => {
  const app = appLikeServer(dir);
  await request(app).get('/v1/runs');
  await request(app).post('/v1/runs');
  await request(app).get('/v1/runs/3f2a9c1e-0000-4000-8000-000000000001');
  await request(app).get('/v1/company/datafile').set('Authorization', 'Bearer x');
  await request(app).get('/v1/health');
  const labels = await labelsOf();
  for (const l of ['/v1/runs', '/v1/runs/:id', '/v1/company/datafile', '/v1/health']) expect(labels).toContain(l);
  expect([...labels].some(l => l.includes('3f2a9c1e'))).toBe(false);
  expect(labels).not.toContain('/');
  expect(labels).not.toContain('/:id');
});

test('without a route: the router that stopped it, a static file, else "unmatched"', async () => {
  const app = appLikeServer(dir);
  await request(app).get('/v1/company/datafile');                 // 401 in the router
  await request(app).get('/esc.js');                              // a static file
  await request(app).get('/a/page/the/browser/asks');             // the page fallback
  await request(app).post('/wp-login.php').send('x');             // nothing matches
  await request(app).delete('/v1/nothing/here');
  const labels = await labelsOf();
  expect(labels).toContain('/v1/company');
  expect(labels).toContain('/esc.js');
  expect(labels).toContain('/{*splat}');
  expect(labels).toContain('unmatched');
  expect(labels).not.toContain('/wp-login.php');
  expect(labels).not.toContain('/v1/nothing/here');
});

test('routeLabel() alone', () => {
  const { routeLabel } = metrics;
  expect(routeLabel({ baseUrl: '/v1/runs', route: { path: '/' } }, 200)).toBe('/v1/runs');
  expect(routeLabel({ baseUrl: '/v1/company', route: { path: '/datafile' } }, 200)).toBe('/v1/company/datafile');
  expect(routeLabel({ baseUrl: '', route: { path: '/v1/health' } }, 200)).toBe('/v1/health');
  expect(routeLabel({ baseUrl: '', path: '/js/nav.js' }, 304)).toBe('/js/nav.js');
  expect(routeLabel({ baseUrl: '', path: '/old' }, 301)).toBe('unmatched');
  expect(routeLabel({ baseUrl: '', path: '/x' }, 404)).toBe('unmatched');
});

test('server.js mounts no router on a path with a parameter (the label would hold its value)', () => {
  const mounts = [...SERVER.matchAll(/^app\.use\('([^']+)'/gm)].map(m => m[1]);
  expect(mounts.length).toBeGreaterThan(10);
  expect(mounts.filter(m => m.includes(':') || m.includes('*'))).toEqual([]);
});
