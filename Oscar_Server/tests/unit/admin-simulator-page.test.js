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

// A stand-in document: elements keep their attributes and children as data,
// so a test sees exactly what the page would put on screen, and that nothing
// was ever parsed as HTML.
const fakeDoc = {
  createElement: (tag) => ({
    tag, attrs: {}, children: [],
    setAttribute(name, value) { this.attrs[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    set textContent(v) { this.children = [{ text: v }]; },
  }),
  createTextNode: (text) => ({ text }),
};
const textOf = (n) => (n.text !== undefined ? n.text : n.children.map(textOf).join(''));
const all = (n, pred, out = []) => {
  if (n.tag && pred(n)) out.push(n);
  for (const c of n.children || []) all(c, pred, out);
  return out;
};

const whenText = lift('whenText', { parseServerTs: undefined, Number });
const el = lift('el', { Object, String });
const accountRow = lift('accountRow', { el, whenText });
const providerNode = lift('providerNode', { el, accountRow });
const secretNode = lift('secretNode', { el });
const auditWhat = lift('auditWhat', { AUDIT_WHAT });
const auditNode = lift('auditNode', { el, whenText, auditWhat });

const GAMMA = {
  provider: 'gamma', name: 'Gamma <Rail>', osdmVersion: '3.8.0',
  accounts: [{ clientId: 'gamma.tst01', createdAt: '2026-10-23T07:00:00.000Z', lastTokenAt: null }],
};

test('a provider shows its accounts, each with New secret and Delete, and the add row', () => {
  const card = providerNode(fakeDoc, GAMMA);
  const text = textOf(card);
  expect(text).toContain('gamma Gamma <Rail>');
  expect(text).toContain('OSDM 3.8.0 · 1 accounts');
  expect(text).toContain('gamma.tst01');
  expect(text).toContain('none since the start');
  const buttons = all(card, (n) => n.tag === 'button').map((b) => b.attrs);
  expect(buttons).toEqual([
    expect.objectContaining({ 'data-action': 'reset', 'data-provider': 'gamma', 'data-client': 'gamma.tst01' }),
    expect.objectContaining({ 'data-action': 'delete', 'data-provider': 'gamma', 'data-client': 'gamma.tst01' }),
    expect.objectContaining({ 'data-action': 'add', 'data-provider': 'gamma' }),
  ]);
  expect(all(card, (n) => n.tag === 'input')[0].attrs.id).toBe('add-id-gamma');
  expect(all(card, (n) => n.tag === 'label')[0].attrs.for).toBe('add-id-gamma');
  expect(all(card, (n) => n.tag === 'option').map((o) => o.attrs.value)).toEqual(['tst', 'tstmgr']);
});

test('a provider without accounts says so', () => {
  expect(textOf(providerNode(fakeDoc, { ...GAMMA, accounts: [] }))).toContain('No account.');
});

test('text from an answer stays text: a client id with markup is a text node and an attribute value, never HTML', () => {
  const card = providerNode(fakeDoc, { ...GAMMA, accounts: [{ clientId: 'a"><img src=x>', createdAt: null }] });
  expect(all(card, (n) => n.tag === 'img')).toEqual([]);
  expect(all(card, (n) => n.tag === 'button')[0].attrs['data-client']).toBe('a"><img src=x>');
  expect(textOf(card)).toContain('a"><img src=x>');
});

test('a new secret is shown with Copy and Done', () => {
  const box = secretNode(fakeDoc, { provider: 'gamma', clientId: 'gamma<x>', clientSecret: 'ab'.repeat(32) });
  expect(textOf(box)).toContain('shown only once');
  expect(textOf(box)).toContain('Account gamma<x> on gamma:');
  expect(textOf(all(box, (n) => n.attrs.id === 'new-secret-value')[0])).toBe('ab'.repeat(32));
  expect(all(box, (n) => n.tag === 'button').map((b) => b.attrs['data-action'])).toEqual(['copy', 'hide-secret']);
});

test('the audit says who did what, in words', () => {
  expect(auditWhat({ action: 'account_added', provider: 'zeta', clientId: 'zeta.tst04' })).toBe('added zeta/zeta.tst04');
  expect(auditWhat({ action: 'secret_reset', provider: 'zeta', clientId: 'zeta.tst04' })).toBe('new secret for zeta/zeta.tst04');
  expect(auditWhat({ action: 'imported_clients_file', count: 36 })).toBe('imported the clients file (36 accounts)');
  expect(auditWhat({ action: 'admin_key_refused', address: '203.0.113.9' })).toBe('refused a wrong key from 203.0.113.9');
  expect(auditWhat({ action: 'something_new' })).toBe('something_new');
  const table = auditNode(fakeDoc, [{ at: '2026-10-23T07:00:00Z', by: 'admin<b>@x', action: 'account_deleted', provider: 'beta', clientId: 'beta.x' }]);
  expect(textOf(table)).toContain('admin<b>@x');
  expect(all(table, (n) => n.tag === 'b')).toEqual([]);
  expect(textOf(table)).toContain('deleted beta/beta.x');
  expect(textOf(auditNode(fakeDoc, []))).toBe('Nothing yet.');
});

test('the page sets no HTML from data: no innerHTML at all', () => {
  expect(SOURCE).not.toContain('innerHTML');
});

test('the menu offers the page to administrators, and the page loads its script after nav.js', () => {
  const nav = read('nav.js');
  const adminBlock = nav.slice(nav.indexOf('if (isAdmin) {'), nav.indexOf('} else if (isCertif) {'));
  expect(adminBlock).toContain("{ href: '/admin-simulator.html',     label: 'OSDM Simulator',   page: 'admin-simulator' }");
  const html = read('admin-simulator.html');
  expect(html.indexOf('/nav.js')).toBeLessThan(html.indexOf('/js/admin-simulator.js'));
  expect(html).toContain("renderOscarNav('oscar-nav', 'admin-simulator')");
});

test('the page never keeps the key: the key field is cleared after a save and never filled from an answer', () => {
  expect(SOURCE).toContain("keyField.value = '';");
  expect(SOURCE).not.toMatch(/sim-key'\)\.value\s*=\s*cfg/);
  expect(SOURCE).not.toMatch(/localStorage|sessionStorage/);
});
