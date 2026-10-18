// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * api-keys-page.test.js — #503: what the API keys page draws. The pure
 * functions are lifted out of public/js/api-keys.js by text, as
 * ui-scripts.test.js does, and the menu entry is checked in nav.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n');

function lift(name, context) {
  const lines = read('js/api-keys.js').split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `api-keys.js#${name}` });
}

const styleBlock = (() => {
  const lines = read('js/api-keys.js').split('\n');
  const start = lines.findIndex(l => l.startsWith('const KEY_STATE_STYLE'));
  const end = lines.findIndex((l, i) => i > start && l === '};');
  return vm.runInNewContext(`${lines.slice(start, end + 1).join('\n')}\nKEY_STATE_STYLE`);
})();

const whenText = lift('whenText', { parseServerTs: undefined, Number });
const keyRowHtml = lift('keyRowHtml', { esc, whenText, KEY_STATE_STYLE: styleBlock });
const newKeyHtml = lift('newKeyHtml', { esc, whenText });

const KEY = { id: 'k1', name: 'Nightly <CI>', hint: 'oscar_abcdef12_…', state: 'active', created_by: 'tm@x.test',
  created_at: '2026-10-18 10:00:00', expires_at: '2027-01-16 10:00:00', last_used_at: null };

test('an active key has a Revoke button and its name and hint escaped', () => {
  const html = keyRowHtml(KEY);
  expect(html).toContain('Nightly &lt;CI&gt;');
  expect(html).toContain('<code>oscar_abcdef12_…</code>');
  expect(html).toContain('data-action="revoke" data-id="k1"');
  expect(html).toContain('>active<');
});

test.each(['revoked', 'expired'])('a %s key has no Revoke button', (state) => {
  const html = keyRowHtml({ ...KEY, state });
  expect(html).not.toContain('data-action="revoke"');
  expect(html).toContain(`>${state}<`);
});

test('an unknown state reads as expired, never as active', () => {
  expect(keyRowHtml({ ...KEY, state: 'whatever' })).not.toContain('data-action="revoke"');
});

test('the new key is shown once, escaped, with where to send it', () => {
  const html = newKeyHtml({ key: 'oscar_abcdef12_<x>', expires_at: '2027-01-16 10:00:00' });
  expect(html).toContain('shown only once');
  expect(html).toContain('oscar_abcdef12_&lt;x&gt;');
  expect(html).toContain('Authorization: Bearer &lt;key&gt;');
  expect(html).toContain('/v1/api');
});

test('a missing date reads as a dash', () => {
  expect(whenText(null)).toBe('—');
  expect(whenText('2026-10-18 10:00:00')).toBe('2026-10-18 10:00:00');
});

test('the menu offers the page to Test Managers only, and the page loads its script', () => {
  const nav = read('nav.js');
  const tmBlock = nav.slice(nav.indexOf("if (role === 'test_manager') {"), nav.indexOf("if (role === 'test_manager') {") + 800);
  expect(tmBlock).toContain("href: '/api-keys.html'");
  expect(nav.match(/api-keys\.html/g)).toHaveLength(1);
  const page = read('api-keys.html');
  expect(page).toContain('<script src="/js/api-keys.js"></script>');
  expect(page).toContain("renderOscarNav('oscar-nav', 'api-keys')");
});
