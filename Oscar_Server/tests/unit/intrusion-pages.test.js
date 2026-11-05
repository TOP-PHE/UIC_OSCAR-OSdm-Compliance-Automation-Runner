// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The pages say an intrusion attempt was met, as text: the run page's red
 * banner and the administrators' list never read a value as markup.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const read = rel => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

function loadFunction(rel, name, context = {}) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

// A small DOM: elements keep their text, children and attributes.
function fakeDocument() {
  const byId = {};
  const make = (tag) => {
    const el = { tag, children: [], attrs: {}, style: {}, textContent: '', id: '', className: '',
      append(...c) { this.children.push(...c); }, appendChild(c) { this.children.push(c); return c; },
      replaceChildren(...c) { this.children = c; }, setAttribute(k, v) { this.attrs[k] = v; },
      insertAdjacentElement(_where, e) { byId[e.id] = e; this.inserted = e; } };
    Object.defineProperty(el, 'innerHTML', { set() { throw new Error('innerHTML used'); } });
    return el;
  };
  byId.meta = make('div');
  return { byId, document: { getElementById: id => byId[id] || null, createElement: make } };
}
const textOf = el => [el.textContent, ...(el.children || []).map(textOf)].join(' ');

test('the run page shows a red banner for a run that met an intrusion attempt, as text', () => {
  const { byId, document } = fakeDocument();
  const src = read('run-detail.html');
  const kinds = vm.runInNewContext(`(${src.slice(src.indexOf('const INTRUSION_KINDS = ') + 24, src.indexOf('};', src.indexOf('const INTRUSION_KINDS = ')) + 1)})`);
  const show = loadFunction('run-detail.html', 'showIntrusionBanner', { document, INTRUSION_KINDS: kinds });
  show({ intrusion: { kind: 'script', step: '<img src=x onerror=alert(1)>' } });
  const banner = byId['intrusion-banner'];
  expect(banner.attrs.role).toBe('alert');
  expect(textOf(banner)).toContain('Intrusion attempt detected');
  expect(textOf(banner)).toContain('<img src=x onerror=alert(1)>');   // as text, never parsed
  show({ intrusion: null });
});

test('a run without one shows nothing', () => {
  const { byId, document } = fakeDocument();
  loadFunction('run-detail.html', 'showIntrusionBanner', { document, INTRUSION_KINDS: {} })({});
  expect(byId['intrusion-banner']).toBeUndefined();
});

test('the administrators\' list is drawn as text', () => {
  const { document } = fakeDocument();
  const drText = loadFunction('admin-dashboard.html', 'drText', { document });
  const secRender = loadFunction('admin-dashboard.html', 'secRender', { document, drText });
  const body = document.createElement('div');
  secRender(body, [{ detected_at: '2026-11-05 10:00:00', company_name: '<b>X</b>', kind: 'template', step: 's', started_by: 'a@b', resumed_at: null }]);
  expect(textOf(body.children[0])).toContain('<b>X</b>');
  expect(textOf(body.children[0])).toContain('SUSPENDED');
  secRender(body, []);
  expect(textOf(body.children[0])).toContain('None recorded.');
});
