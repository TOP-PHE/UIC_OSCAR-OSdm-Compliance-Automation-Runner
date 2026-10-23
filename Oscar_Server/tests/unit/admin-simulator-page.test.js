// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-simulator-page.test.js — #930 PR 2: what the OSDM Simulator page
 * draws. The pure functions are lifted out of public/js/admin-simulator.js by
 * text, as api-keys-page.test.js does; the menu entry is checked in nav.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n');
const SOURCE = read('js/admin-simulator.js');

function lift(name, context) {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `admin-simulator.js#${name}` });
}

const AUDIT_WHAT = (() => {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex(l => l.startsWith('const AUDIT_WHAT'));
  const end = lines.findIndex((l, i) => i > start && l === '};');
  return vm.runInNewContext(`${lines.slice(start, end + 1).join('\n')}\nAUDIT_WHAT`);
})();

const whenText = lift('whenText', { parseServerTs: undefined, Number });
const providerHtml = lift('providerHtml', { esc, whenText });
const secretHtml = lift('secretHtml', { esc });
const auditWhat = lift('auditWhat', { AUDIT_WHAT });
const auditHtml = lift('auditHtml', { esc, whenText, auditWhat });

const GAMMA = {
  provider: 'gamma', name: 'Gamma <Rail>', osdmVersion: '3.8.0',
  accounts: [{ clientId: 'gamma.tst01', createdAt: '2026-10-23T07:00:00.000Z', lastTokenAt: null }],
};

test('a provider shows its accounts, each with New secret and Delete, and the add row; text is escaped', () => {
  const html = providerHtml(GAMMA);
  expect(html).toContain('Gamma &lt;Rail&gt;');
  expect(html).toContain('OSDM 3.8.0 · 1 accounts');
  expect(html).toContain('<code>gamma.tst01</code>');
  expect(html).toContain('none since the start');
  expect(html).toContain('data-action="reset" data-provider="gamma" data-client="gamma.tst01"');
  expect(html).toContain('data-action="delete" data-provider="gamma" data-client="gamma.tst01"');
  expect(html).toContain('data-action="add" data-provider="gamma"');
  expect(html).toContain('id="add-id-gamma"');
  expect(html).toContain('<option value="tstmgr">');
});

test('a provider without accounts says so', () => {
  expect(providerHtml({ ...GAMMA, accounts: [] })).toContain('No account.');
});

test('a client id cannot break out of its attribute', () => {
  const html = providerHtml({ ...GAMMA, accounts: [{ clientId: 'a"><img src=x>', createdAt: null }] });
  expect(html).not.toContain('<img');
  expect(html).toContain('data-client="a&quot;&gt;&lt;img src=x&gt;"');
});

test('a new secret is shown with Copy and Done, escaped', () => {
  const html = secretHtml({ provider: 'gamma', clientId: 'gamma<x>', clientSecret: 'ab'.repeat(32) });
  expect(html).toContain('shown only once');
  expect(html).toContain(`<code id="new-secret-value">${'ab'.repeat(32)}</code>`);
  expect(html).toContain('gamma&lt;x&gt;');
  expect(html).toContain('data-action="copy"');
  expect(html).toContain('data-action="hide-secret"');
});

test('the audit says who did what, in words', () => {
  expect(auditWhat({ action: 'account_added', provider: 'zeta', clientId: 'zeta.tst04' })).toBe('added zeta/zeta.tst04');
  expect(auditWhat({ action: 'secret_reset', provider: 'zeta', clientId: 'zeta.tst04' })).toBe('new secret for zeta/zeta.tst04');
  expect(auditWhat({ action: 'imported_clients_file', count: 36 })).toBe('imported the clients file (36 accounts)');
  expect(auditWhat({ action: 'admin_key_refused', address: '203.0.113.9' })).toBe('refused a wrong key from 203.0.113.9');
  expect(auditWhat({ action: 'something_new' })).toBe('something_new');
  const html = auditHtml([{ at: '2026-10-23T07:00:00Z', by: 'admin<b>@x', action: 'account_deleted', provider: 'beta', clientId: 'beta.x' }]);
  expect(html).toContain('admin&lt;b&gt;@x');
  expect(html).toContain('deleted beta/beta.x');
  expect(auditHtml([])).toContain('Nothing yet.');
});

test('the menu offers the page to administrators, and the page loads its script after esc.js and nav.js', () => {
  const nav = read('nav.js');
  const adminBlock = nav.slice(nav.indexOf('if (isAdmin) {'), nav.indexOf('} else if (isCertif) {'));
  expect(adminBlock).toContain("{ href: '/admin-simulator.html',     label: 'OSDM Simulator',   page: 'admin-simulator' }");
  const html = read('admin-simulator.html');
  expect(html.indexOf('/js/esc.js')).toBeLessThan(html.indexOf('/js/admin-simulator.js'));
  expect(html.indexOf('/nav.js')).toBeLessThan(html.indexOf('/js/admin-simulator.js'));
  expect(html).toContain("renderOscarNav('oscar-nav', 'admin-simulator')");
});

test('the page never keeps the key: the key field is cleared after a save and never filled from an answer', () => {
  expect(SOURCE).toContain("keyField.value = '';");
  expect(SOURCE).not.toMatch(/sim-key'\)\.value\s*=\s*cfg/);
  expect(SOURCE).not.toMatch(/localStorage|sessionStorage/);
});
