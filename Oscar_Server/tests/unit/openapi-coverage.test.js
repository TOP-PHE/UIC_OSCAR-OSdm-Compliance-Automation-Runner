// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Every route the server answers is in the OpenAPI document served at
 * /v1/docs, and the document names no route the server does not have.
 *
 * The routes are read from the routers themselves (each route file is
 * required and its stack walked) and from the app-level handlers of
 * server.js, mounted where server.js mounts them. A new route without its
 * entry in src/api/openapi.js fails here, and so does an entry left behind
 * after a route is removed.
 */

const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '../../src');
const SERVER = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
const spec = require('../../src/api/openapi');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// Handlers server.js declares on the app itself, outside any route file.
// Not documented on purpose: the page fallback and the Swagger UI itself.
const NOT_API = new Set(['GET /{*splat}']);
const APP_ROUTE = /^app\.(get|post|put|patch|delete)\('([^']+)'/gm;
const MOUNT = /^app\.use\('([^']+)',\s*require\('\.\/api\/routes\/([^']+)'\)\)/gm;

const asOpenApi = p => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function join(mount, route) {
  if (route === '/') return mount;
  return `${mount}${route}`;
}

function routesOfRouter(router) {
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const p of paths) {
      if (typeof p !== 'string') throw new Error(`route path that is not text: ${String(p)}`);
      for (const m of Object.keys(layer.route.methods)) {
        if (METHODS.includes(m)) out.push({ method: m.toUpperCase(), path: p });
      }
    }
  }
  return out;
}

function codeRoutes() {
  const found = new Set();
  for (const [, method, p] of SERVER.matchAll(APP_ROUTE)) {
    const key = `${method.toUpperCase()} ${asOpenApi(p)}`;
    if (!NOT_API.has(key)) found.add(key);
  }
  for (const [, mount, file] of SERVER.matchAll(MOUNT)) {
    const router = require(path.join(SRC, 'api/routes', file));
    for (const r of routesOfRouter(router)) found.add(`${r.method} ${asOpenApi(join(mount, r.path))}`);
  }
  return found;
}

function documentedRoutes() {
  const found = new Set();
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of Object.keys(item)) {
      if (METHODS.includes(m)) found.add(`${m.toUpperCase()} ${p}`);
    }
  }
  return found;
}

describe('OpenAPI document (/v1/docs) matches the server\'s routes', () => {
  const code = codeRoutes();
  const docs = documentedRoutes();

  test('the routes were found (the reading itself works)', () => {
    expect(code.size).toBeGreaterThan(150);
    expect(code).toContain('POST /v1/auth/login');
    expect(code).toContain('GET /v1/runs/{id}');
    expect(code).toContain('GET /health');
  });

  test('every route of the server is documented', () => {
    const missing = [...code].filter(r => !docs.has(r)).sort();
    expect(missing).toEqual([]);
  });

  test('every documented route exists on the server', () => {
    const stale = [...docs].filter(r => !code.has(r)).sort();
    expect(stale).toEqual([]);
  });

  test('every operation says what it does and who may call it', () => {
    const weak = [];
    for (const [p, item] of Object.entries(spec.paths)) {
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        const key = `${m.toUpperCase()} ${p}`;
        if (!op.summary) weak.push(`${key}: no summary`);
        if (!Array.isArray(op.tags) || op.tags.length === 0) weak.push(`${key}: no tag`);
        if (!op.responses || Object.keys(op.responses).length === 0) weak.push(`${key}: no response`);
        for (const name of (p.match(/\{([^}]+)\}/g) || []).map(s => s.slice(1, -1))) {
          const params = [...(item.parameters || []), ...(op.parameters || [])];
          if (!params.some(x => x.in === 'path' && x.name === name)) weak.push(`${key}: path parameter ${name} not described`);
        }
      }
    }
    expect(weak).toEqual([]);
  });

  test('every tag used is declared', () => {
    const declared = new Set(spec.tags.map(t => t.name));
    const used = new Set();
    for (const item of Object.values(spec.paths)) {
      for (const m of METHODS) for (const t of item[m]?.tags || []) used.add(t);
    }
    expect([...used].filter(t => !declared.has(t))).toEqual([]);
  });
});
