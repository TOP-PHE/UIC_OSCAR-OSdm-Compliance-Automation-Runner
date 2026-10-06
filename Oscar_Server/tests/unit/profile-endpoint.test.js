// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * profile-endpoint.test.js — #544, the API Config page.
 *
 * The company's OSDM endpoint is shared by every tester: each run goes to it
 * with the token of the tester who started it. Only a Test Manager may change
 * it. The server enforces that (tests/integration/company-routes.test.js);
 * this file checks that the page agrees: for anyone else the field is
 * read-only and the save does not send the endpoint, so saving one's own
 * credentials keeps working.
 *
 * No browser. The page's own `loadProfile` and `saveConfig` are lifted out of
 * public/profile.html and run in a `vm` context with a fake `document` and a
 * fake `fetch`, as scenarios-load-guard.test.js does for scenarios.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'profile.html'), 'utf8')
  .replaceAll('\r\n', '\n').split('\n');

function sourceOf(name) {
  const start = SOURCE.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`profile.html: no top-level function ${name} at column 0`);
  const end = SOURCE.findIndex((l, i) => i > start && l === '}');
  return SOURCE.slice(start, end + 1).join('\n');
}

// The page's own one-line declaration of a constant, so the rule under test is the page's.
function declarationOf(name) {
  const line = SOURCE.find(l => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`profile.html: no top-level "const ${name} = " at column 0`);
  return line;
}

const STORED = 'https://provider.example/osdm';

// Opens the page as `role`, with `typed` in the endpoint field once it has loaded.
function openPage(role) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { id, value: '', readOnly: false, disabled: false, style: {}, textContent: '' });
    return elements.get(id);
  };
  const calls = [];
  const messages = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : undefined });
    const json = async () => {
      if (method === 'GET' && url === '/v1/company') return { api_base: STORED, extra_headers: [], datafile_updated_at: '2026-10-06' };
      if (method === 'GET' && url === '/v1/me/credentials') return { auth_mode: 'bearer', has_token: true };
      return {};
    };
    return { ok: true, status: 200, json };
  };
  const context = vm.createContext({
    console,
    user: { role },
    fetch,
    document: { getElementById: element, querySelectorAll: () => [] },
    showMsg: (text, ok) => messages.push({ text, ok }),
    switchMode: () => {},
    switchProfile: () => {},
    renderExtraHeaders: () => {},
    collectExtraHeaders: () => [{ name: 'X-Test', value: '1' }],
  });
  const code = [declarationOf('CAN_EDIT_HEADERS'), declarationOf('CAN_EDIT_ENDPOINT'), sourceOf('loadProfile'), sourceOf('saveConfig')].join('\n\n');
  vm.runInContext(code, context, { filename: 'profile.html (extract)' });
  return { context, element, calls, messages };
}

describe('API Config page — the shared endpoint (#544)', () => {
  describe.each([['company_user'], ['certification_user'], ['administrator'], [undefined]])('opened as %s', (role) => {
    test('the endpoint is shown read-only, with the note that says who can change it', async () => {
      const page = openPage(role);
      await page.context.loadProfile();
      expect(page.element('api_base').value).toBe(STORED);
      expect(page.element('api_base').readOnly).toBe(true);
      expect(page.element('api-base-readonly-note').style.display).toBe('block');
    });

    test('saving sends the credentials and nothing to the company', async () => {
      const page = openPage(role);
      await page.context.loadProfile();
      page.element('api_base').value = 'https://elsewhere.example/collect';   // however it got there
      page.element('auth_mode').value = 'bearer';
      page.element('access_token').value = 'new-token';
      page.calls.length = 0;

      await page.context.saveConfig();

      expect(page.calls.map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /v1/me/credentials']);
      expect(page.calls[0].body).toEqual({ auth_mode: 'bearer', access_token: 'new-token' });
      expect(page.messages).toEqual([{ text: 'Configuration saved.', ok: true }]);
    });
  });

  describe('opened as a Test Manager', () => {
    test('the endpoint is editable and the note stays hidden', async () => {
      const page = openPage('test_manager');
      await page.context.loadProfile();
      expect(page.element('api_base').value).toBe(STORED);
      expect(page.element('api_base').readOnly).toBe(false);
      expect(page.element('api-base-readonly-note').style.display).toBeUndefined();
    });

    test('saving sends the endpoint and the headers to the company, then the credentials', async () => {
      const page = openPage('test_manager');
      await page.context.loadProfile();
      page.element('api_base').value = '  https://new.example/osdm  ';
      page.element('auth_mode').value = 'bearer';
      page.calls.length = 0;

      await page.context.saveConfig();

      expect(page.calls.map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /v1/company', 'PATCH /v1/me/credentials']);
      expect(page.calls[0].body).toEqual({ api_base: 'https://new.example/osdm', extra_headers: [{ name: 'X-Test', value: '1' }] });
    });
  });

  test('the page has the note element the script shows', () => {
    expect(SOURCE.some(l => l.includes('id="api-base-readonly-note"'))).toBe(true);
  });
});
