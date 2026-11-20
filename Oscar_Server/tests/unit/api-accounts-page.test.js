// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-accounts-page.test.js — #1342: what the Company API accounts page
 * draws. The pure functions are lifted out of public/js/api-accounts.js by
 * text, as api-keys-page.test.js does, and the menu entry is checked in nav.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n');
const SOURCE = read('js/api-accounts.js').split('\n');

function lift(name, context) {
  const start = SOURCE.findIndex(l => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = SOURCE.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${SOURCE.slice(start, end + 1).join('\n')})`, context, { filename: `api-accounts.js#${name}` });
}

const STYLE = (() => {
  const start = SOURCE.findIndex(l => l.startsWith('const ACCOUNT_STATE_STYLE'));
  const end = SOURCE.findIndex((l, i) => i > start && l === '};');
  return vm.runInNewContext(`${SOURCE.slice(start, end + 1).join('\n')}\nACCOUNT_STATE_STYLE`);
})();

const whenText = lift('whenText', { parseServerTs: undefined, Number });
const providerBoxesHtml = lift('providerBoxesHtml', { esc, Set });
const credentialsHtml = lift('credentialsHtml', { esc });
const accountRowHtml = lift('accountRowHtml', { esc, whenText, providerBoxesHtml, credentialsHtml, encodeURIComponent, ACCOUNT_STATE_STYLE: STYLE });

const PROVIDERS = [{ id: 'p1', name: 'Alpha <a>' }, { id: 'p2', name: 'Beta' }];
const ACCOUNT = {
  id: 'a1', name: 'Nightly <CI>', status: 'active', account_email: 'nightly-ci.12345678@api-account.invalid',
  providers: [{ id: 'p1', name: 'Alpha <a>' }], created_by: 'tm@x.test', created_at: '2026-11-20 10:00:00',
  credentials: [{ company_id: 'c', company_name: 'Co', set: true }, { company_id: 'p1', company_name: 'Alpha <a>', set: false }],
};

test('an active account: its name escaped, its providers ticked, a link to set its credentials, Suspend', () => {
  const html = accountRowHtml(ACCOUNT, PROVIDERS);
  expect(html).toContain('Nightly &lt;CI&gt;');
  expect(html).not.toContain('<CI>');
  expect(html).toMatch(/value="p1" data-action="toggle-provider" data-id="a1" checked/);
  expect(html).toMatch(/value="p2" data-action="toggle-provider" data-id="a1">/);
  expect(html).toContain('href="/profile.html?api_account=a1"');
  expect(html).toContain('data-action="suspend" data-id="a1"');
  expect(html).not.toContain('data-action="resume"');
  expect(html).toContain('Alpha &lt;a&gt; <span class="muted">(not set)</span>');
});

test('a suspended account offers Resume and says who suspended it', () => {
  const html = accountRowHtml({ ...ACCOUNT, status: 'suspended', suspended_by: 'tm2@x.test', suspended_at: '2026-11-20 11:00:00' }, PROVIDERS);
  expect(html).toContain('data-action="resume" data-id="a1"');
  expect(html).not.toContain('data-action="suspend"');
  expect(html).toContain('by tm2@x.test');
});

test('an unknown state reads as suspended, never as active', () => {
  expect(accountRowHtml({ ...ACCOUNT, status: 'whatever' }, PROVIDERS)).toContain('data-action="resume"');
});

test('the form\'s boxes are not tied to an account; a company without providers says so', () => {
  expect(providerBoxesHtml(PROVIDERS, [], null)).toContain('data-new-provider="1"');
  expect(providerBoxesHtml(PROVIDERS, [], null)).not.toContain('toggle-provider');
  expect(providerBoxesHtml([], [], null)).toContain('no provider');
});

test('the menu offers the page to Test Managers only, and the page loads its script', () => {
  const nav = read('nav.js');
  const tmStart = nav.indexOf("if (role === 'test_manager') {");
  expect(nav.slice(tmStart, tmStart + 1200)).toContain("href: '/api-accounts.html'");
  expect(nav.match(/api-accounts\.html/g)).toHaveLength(1);
  const page = read('api-accounts.html');
  expect(page).toContain('<script src="/js/api-accounts.js"></script>');
  expect(page).toContain("renderOscarNav('oscar-nav', 'api-accounts')");
});
