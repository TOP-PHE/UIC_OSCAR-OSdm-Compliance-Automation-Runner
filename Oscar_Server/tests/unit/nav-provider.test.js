// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * nav-provider.test.js — the browser side of #540: which requests carry the
 * selected provider.
 *
 * nav.js wraps window.fetch for every page. With a provider selected in the
 * tab (sessionStorage), it adds X-Provider-Id to same-origin /v1/ calls of a
 * company member, except the routes that always act on the own company. A
 * provider the server refuses (404 "Provider not found.") clears the choice.
 *
 * No browser: nav.js runs in a vm context with fake storage, location and
 * fetch, as the other public/ tests do.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const NAV = fs.readFileSync(path.join(__dirname, '../../public/nav.js'), 'utf8');

function storage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
  };
}

function openNav({ role = 'company_user', provider = { id: 'p1', name: 'Carrier X' }, answer } = {}) {
  const calls = [];
  const local = storage({ oscar_user: JSON.stringify({ email: 'a@x', role }) });
  const session = storage(provider ? { oscar_provider: JSON.stringify(provider) } : {});
  let reloaded = 0;
  const location = { href: 'https://oscar.example/dashboard.html', origin: 'https://oscar.example', reload: () => { reloaded++; } };
  const fetch = (input, init) => {
    calls.push({ url: input, headers: new Headers(init.headers || {}) });
    const res = answer ? answer(input) : new Response('{}', { status: 200 });
    return Promise.resolve(res);
  };
  const win = { fetch, localStorage: local, sessionStorage: session, location, esc: s => String(s) };
  win.window = win;
  const context = vm.createContext({ ...win, URL, Headers, Response, console, setTimeout, document: {} });
  context.window = context;
  vm.runInContext(NAV, context, { filename: 'nav.js' });
  return { context, calls, session, reloads: () => reloaded };
}

const headerOn = (env, url) => env.calls.find(c => c.url === url)?.headers.get('X-Provider-Id') ?? null;

describe('nav.js — X-Provider-Id on API calls (#540)', () => {
  test('a member\'s company-scoped call carries the selected provider', async () => {
    const env = openNav();
    for (const url of ['/v1/company', '/v1/company/datafile', '/v1/runs', '/v1/me/credentials', '/v1/reports/templates',
      'https://oscar.example/v1/company/findings']) {
      await env.context.fetch(url, {});
      expect(headerOn(env, url)).toBe('p1');
    }
  });

  test('routes on the own company, other origins and non-API paths do not', async () => {
    const env = openNav();
    for (const url of ['/v1/auth/me', '/v1/company/users', '/v1/company/providers', '/v1/company/providers/p1/access',
      '/v1/admin/users', '/health', '/news/index.json', 'https://elsewhere.example/v1/company']) {
      await env.context.fetch(url, {});
      expect(headerOn(env, url)).toBeNull();
    }
  });

  test('platform roles never send it', async () => {
    for (const role of ['administrator', 'certification_user']) {
      const env = openNav({ role });
      await env.context.fetch('/v1/company', {});
      expect(headerOn(env, '/v1/company')).toBeNull();
    }
  });

  test('no selection, no header', async () => {
    const env = openNav({ provider: null });
    await env.context.fetch('/v1/company', {});
    expect(headerOn(env, '/v1/company')).toBeNull();
  });

  test('a provider named by the caller is kept', async () => {
    const env = openNav();
    await env.context.fetch('/v1/company', { headers: { 'X-Provider-Id': 'p2' } });
    expect(headerOn(env, '/v1/company')).toBe('p2');
  });

  test('a refused provider is dropped and the page reloads on the own company', async () => {
    const env = openNav({ answer: () => new Response(JSON.stringify({ status: 404, detail: 'Provider not found.' }), { status: 404 }) });
    await env.context.fetch('/v1/company', {});
    await new Promise(r => setImmediate(r));
    expect(env.session.getItem('oscar_provider')).toBeNull();
    expect(env.reloads()).toBe(1);
  });

  test('an ordinary 404 keeps the selection', async () => {
    const env = openNav({ answer: () => new Response(JSON.stringify({ detail: 'No data file uploaded yet.' }), { status: 404 }) });
    await env.context.fetch('/v1/company/datafile', {});
    await new Promise(r => setImmediate(r));
    expect(JSON.parse(env.session.getItem('oscar_provider')).id).toBe('p1');
    expect(env.reloads()).toBe(0);
  });
});
