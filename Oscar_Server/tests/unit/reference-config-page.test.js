// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reference-config-page.test.js — #838 PR 2: what Test Config's
 * "Reference configuration" box and the run page's notice say. The two pure
 * functions are lifted out of the page files by text, as ui-scripts.test.js
 * does.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { esc } = require('../../public/js/esc');

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

function lift(rel, name, context) {
  const lines = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`${name} not found in ${rel}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `${rel}#${name}` });
}

const styleLine = fs.readFileSync(path.join(PUBLIC_DIR, 'js/reference-config.js'), 'utf8')
  .split('\n').find(l => l.startsWith('const REFERENCE_BOX_STYLE'));
const REFERENCE_BOX_STYLE = vm.runInNewContext(`${styleLine}\nREFERENCE_BOX_STYLE`);

const boxHtml = lift('js/reference-config.js', 'referenceBoxHtml', { esc, REFERENCE_BOX_STYLE });
const noticeText = lift('run.html', 'referenceNoticeText', { esc });

const AVAILABLE = [
  { name: 'simulator-alpha', provider: 'alpha', osdmVersion: '3.6.0' },
  { name: 'simulator-beta', provider: 'beta', osdmVersion: '3.7.0' },
];

describe('Test Config box', () => {
  test('a tester sees nothing when no reference is followed', () => {
    expect(boxHtml({ available: AVAILABLE, linked: null }, false)).toBe('');
  });

  test('a Test Manager can choose a reference, and has no update button before', () => {
    const html = boxHtml({ available: AVAILABLE, linked: null }, true);
    expect(html).toContain('Follows no reference');
    expect(html).toContain('<option value="simulator-beta">simulator-beta (OSDM 3.7.0)</option>');
    expect(html).not.toContain('data-ref-action="apply"');
  });

  test('linked and up to date, then stale, then not yet updated', () => {
    const up = boxHtml({ available: AVAILABLE, linked: 'simulator-beta', up_to_date: true, applied_version: 'v', applied_at: '2026-10-18' }, true);
    expect(up).toContain('up to date (updated 2026-10-18)');
    expect(up).toContain('<option value="simulator-beta" selected>');
    expect(up).toContain('data-ref-action="apply"');
    const stale = boxHtml({ available: AVAILABLE, linked: 'simulator-beta', up_to_date: false, applied_version: 'v', applied_at: '2026-10-18' }, false);
    expect(stale).toContain('the reference has changed since the last update');
    expect(stale).not.toContain('<select');
    expect(boxHtml({ linked: 'simulator-beta', up_to_date: false, applied_version: null }, false)).toContain('not updated from it yet');
  });

  test('a reference the server cannot read offers no update, and names are escaped', () => {
    const html = boxHtml({ available: [], linked: 'simulator-<b>', missing: true }, true);
    expect(html).toContain('simulator-&lt;b&gt;, which this server cannot read');
    expect(html).not.toContain('data-ref-action="apply"');
  });
});

describe('run page notice', () => {
  test('nothing when no reference is followed or it is up to date', () => {
    expect(noticeText(null)).toBeNull();
    expect(noticeText({ linked: null })).toBeNull();
    expect(noticeText({ linked: 'simulator-gamma', up_to_date: true })).toBeNull();
  });

  test('a stale or unreadable reference is said', () => {
    expect(noticeText({ linked: 'simulator-gamma', up_to_date: false })).toContain('not up to date with the reference simulator-gamma');
    expect(noticeText({ linked: 'simulator-<i>', missing: true })).toBe('This configuration follows the reference simulator-&lt;i&gt;, which this server cannot read.');
  });
});
