// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * body-limits.test.js — #1371: how large a JSON body OSCAR reads, and when.
 *
 *   - every route reads at most 1 MB;
 *   - the Test Config save reads up to 5 MB, with a parser of its own that
 *     comes after the route's authorisation: a caller refused there has had
 *     no byte of its body read;
 *   - ALLOW_PRIVATE_TARGETS is said when it is on.
 */

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const B = require('../../src/utils/bodyLimits');

const SRC = path.join(__dirname, '..', '..', 'src');
const bodyOf = megabytes => JSON.stringify({ text: 'x'.repeat(Math.round(megabytes * 1024 * 1024)) });

describe('which request is the data file save', () => {
  test('PUT /v1/company/datafile/json, with or without case and a last slash', () => {
    for (const p of ['/v1/company/datafile/json', '/v1/company/datafile/json/', '/V1/Company/Datafile/JSON']) {
      expect(B.isDatafileSave({ method: 'PUT', path: p })).toBe(true);
    }
  });

  test('no other method, and no other path', () => {
    for (const method of ['POST', 'GET', 'PATCH', 'DELETE', 'put', undefined]) {
      expect(B.isDatafileSave({ method, path: '/v1/company/datafile/json' })).toBe(false);
    }
    for (const p of ['/v1/company/datafile', '/v1/company/datafile/json/x', '/v1/company/datafile/jsonx', '/x/v1/company/datafile/json',
      '/v1/company/test-framework', '/v1/auth/login', '', undefined, 42]) {
      expect(B.isDatafileSave({ method: 'PUT', path: p })).toBe(false);
    }
    expect(B.isDatafileSave(undefined)).toBe(false);
  });

  test('the limits', () => {
    expect([B.GENERAL_JSON_LIMIT, B.DATAFILE_JSON_LIMIT]).toEqual(['1mb', '5mb']);
  });
});

describe('an app wired as the server is', () => {
  // The general parser first, then routes; the save's own parser after its
  // authorisation, as routes/company.js has it.
  let readBeforeAuthorisation;
  const app = express();
  app.use(B.generalJsonParser());
  app.post('/v1/auth/login', (req, res) => res.json({ read: Object.keys(req.body || {}).length }));
  app.put('/v1/company/datafile/json',
    (req, res, next) => {
      readBeforeAuthorisation = req.body !== undefined;
      return req.get('x-allowed') === 'yes' ? next() : res.status(403).json({ status: 403 });
    },
    B.datafileJsonParser(),
    (req, res) => res.json({ size: JSON.stringify(req.body).length }));
  app.use((err, req, res, _next) => res.status(err.type === 'entity.too.large' ? 413 : 400).json({ type: err.type }));

  const send = (method, url, megabytes, headers = {}) => request(app)[method](url)
    .set('Content-Type', 'application/json').set(headers).send(bodyOf(megabytes));

  test('a route reads a body under 1 MB', async () => {
    expect((await send('post', '/v1/auth/login', 0.5)).body).toEqual({ read: 1 });
  });

  test('a route refuses a body over 1 MB with 413', async () => {
    const res = await send('post', '/v1/auth/login', 2);
    expect(res.status).toBe(413);
    expect(res.body.type).toBe('entity.too.large');
  });

  test('the data file save reads 2 MB, and 4.5 MB', async () => {
    for (const megabytes of [2, 4.5]) {
      const res = await send('put', '/v1/company/datafile/json', megabytes, { 'x-allowed': 'yes' });
      expect(res.status).toBe(200);
      expect(res.body.size).toBeGreaterThan(megabytes * 1024 * 1024);
    }
  });

  test('the data file save refuses over 5 MB with 413', async () => {
    expect((await send('put', '/v1/company/datafile/json', 5.5, { 'x-allowed': 'yes' })).status).toBe(413);
  });

  test('a caller refused at the save has had no body read: 403, not 413', async () => {
    const res = await send('put', '/v1/company/datafile/json', 0.5);
    expect(res.status).toBe(403);
    expect(readBeforeAuthorisation).toBe(false);
  });

  // With a real client on a real port: supertest closes its server as soon as
  // an answer comes, which resets a request still being sent.
  test('and gets its 403 whatever the size sent, 20 MB included', async () => {
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    try {
      const { port } = listener.address();
      for (const megabytes of [2, 20]) {
        const res = await fetch(`http://127.0.0.1:${port}/v1/company/datafile/json`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: bodyOf(megabytes) });
        expect(res.status).toBe(403);
        await res.arrayBuffer();
      }
      expect(readBeforeAuthorisation).toBe(false);
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });

  test('another method on the save\'s path is an ordinary route: 1 MB', async () => {
    app.post('/v1/company/datafile/json', (req, res) => res.json({ ok: true }));
    expect((await send('post', '/v1/company/datafile/json', 2)).status).toBe(413);
  });
});

describe('the server is wired so', () => {
  const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
  const company = fs.readFileSync(path.join(SRC, 'api', 'routes', 'company.js'), 'utf8');

  test('the general parser is the only JSON parser of the public app', () => {
    expect(server).toContain('app.use(generalJsonParser());');
    expect(server).not.toMatch(/^app\.use\(express\.json\(/m);
  });

  test('the save names its parser after the limiter and the authorisation', () => {
    expect(company).toContain("router.put('/datafile/json', datafileMutationLimiter, authorizeDatafileWrite(savePolicy), datafileJsonParser(), async (req, res) => {");
  });

  test('no other route of the server asks for a JSON body over the general limit', () => {
    const files = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) return files(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
    const users = files(path.join(SRC, 'api')).filter(file => /datafileJsonParser\(\)/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.basename(file));
    expect(users).toEqual(['company.js']);
  });
});

describe('ALLOW_PRIVATE_TARGETS is said when it is on', () => {
  const { allowPrivate, PRIVATE_TARGETS_WARNING } = require('../../src/utils/urlPolicy');
  let before;
  beforeEach(() => { before = process.env.ALLOW_PRIVATE_TARGETS; });
  afterEach(() => {
    if (before === undefined) delete process.env.ALLOW_PRIVATE_TARGETS; else process.env.ALLOW_PRIVATE_TARGETS = before;
  });

  test('on for 1, true, yes; off for anything else', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes']) {
      process.env.ALLOW_PRIVATE_TARGETS = value;
      expect(allowPrivate()).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'on']) {
      process.env.ALLOW_PRIVATE_TARGETS = value;
      expect(allowPrivate()).toBe(false);
    }
    delete process.env.ALLOW_PRIVATE_TARGETS;
    expect(allowPrivate()).toBe(false);
  });

  test('the warning names the setting, what it turns off and what it is for', () => {
    expect(PRIVATE_TARGETS_WARNING).toMatch(/^ALLOW_PRIVATE_TARGETS is on/);
    expect(PRIVATE_TARGETS_WARNING).toMatch(/not kept to public https addresses/);
    expect(PRIVATE_TARGETS_WARNING).toMatch(/development PC/);
  });

  test('the server says it at its start, and gives the page a flag', () => {
    const server = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8');
    expect(server).toContain('if (privateTargetsAllowed()) log.warn(PRIVATE_TARGETS_WARNING);');
    const admin = fs.readFileSync(path.join(SRC, 'api', 'routes', 'admin.js'), 'utf8');
    expect(admin).toContain('private_targets_allowed: allowPrivate(),');
  });
});

describe("a 413 names the limit that applied", () => {
  test("whole megabytes, a fraction, and a limit that is no number", () => {
    expect(B.tooLargeText(1024 * 1024)).toBe("The request body is larger than 1 MB.");
    expect(B.tooLargeText(5 * 1024 * 1024)).toBe("The request body is larger than 5 MB.");
    expect(B.tooLargeText(512 * 1024)).toBe("The request body is larger than 0.5 MB.");
    for (const limit of [undefined, null, 0, -1, "many", Number.NaN]) {
      expect(B.tooLargeText(limit)).toBe("The request body is too large.");
    }
  });
});
