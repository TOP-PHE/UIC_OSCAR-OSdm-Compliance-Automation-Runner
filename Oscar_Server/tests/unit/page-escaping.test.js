// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';
const { pageSource } = require('../helpers/page-source');

/**
 * Values a user stores (a scenario code, an endpoint, a list id, an e-mail)
 * reach other users' pages as text, never as markup; the CSV export never
 * hands a spreadsheet a formula.
 */

const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const read = rel => pageSource(path.join(PUBLIC_DIR, rel), 'utf8');

function loadFunction(rel, name, context = {}) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`${rel}: no top-level "function ${name}(" at column 0`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `${rel}#${name}` });
}

// The shared escaper, as the pages load it.
const esc = (() => {
  const window = {};
  vm.runInNewContext(read('js/esc.js'), { window });
  return window.esc;
})();

describe('run detail page', () => {
  // updateStatus() draws the run's details; run it with a small fake page.
  function drawn(run) {
    const els = {};
    const element = () => ({ innerHTML: '', textContent: '', className: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, remove() {}, querySelector: () => null, appendChild() {}, insertAdjacentHTML() {} });
    const document = { getElementById: id => (els[id] ||= element()), createElement: element, querySelector: () => null };
    const fn = loadFunction('run-detail.html', 'updateStatus', {
      document, escHtml: esc, currentRun: null,
      fmtDate: d => String(d), duration: () => '1s', showSharedNote() {},
    });
    try { fn(run); } catch { /* later parts of the page need more than this fake */ }
    return els.meta.innerHTML;
  }

  const run = {
    id: '00000000-0000-4000-8000-000000000000', status: 'COMPLETED',
    api_base_used: 'https://a.example/<svg onload=alert(1)>',
    scenario_code: '<img src=x onerror=alert(2)>',
    batch_id: '11111111-1111-4111-8111-111111111111',
  };

  test('the scenario code and the endpoint are text', () => {
    const html = drawn(run);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  test('the batch link is still a link', () => {
    expect(drawn(run)).toContain('<a href="/dashboard.html"');
  });
});

// The pages' own template text, as it stands in their source ("$" + "{…}").
const sub = expr => '$' + '{' + expr + '}';

describe('other pages', () => {
  test('compare: the endpoints and the error text go through esc()', () => {
    const src = read('compare.html');
    expect(src).toContain(sub("esc(data.run_a.api_base || '-')"));
    expect(src).toContain(sub("esc(data.run_b.api_base || '-')"));
    expect(src).toContain(sub("esc(data.detail || data.title || 'Failed to compute comparison.')"));
  });

  test('Test Config: the trip requirement id goes through esc()', () => {
    expect(read('js/scenarios.js')).toContain('requirement #' + sub('esc(sc.tripRequirementId)'));
  });

  test('dashboard: the e-mail in the title goes through esc()', () => {
    expect(read('dashboard.html')).toContain("' — shared by ' + esc(r.shared_with_certifier_by)");
  });
});

describe('CSV export', () => {
  const csvCell = loadFunction('report-builder.html', 'csvCell');

  test.each(['=HYPERLINK("http://x")', '+1', '-1+1', '@SUM(A1)', '\tx', '\rx'])('%j is not read as a formula', (v) => {
    expect(csvCell(v).startsWith(`"'`)).toBe(true);
  });

  test('other text is quoted once', () => {
    expect(csvCell('a "b" c')).toBe('"a ""b"" c"');
    expect(csvCell('OTST_SALE')).toBe('"OTST_SALE"');
  });
});

// #1423: once the pages' code became files, SonarCloud traced values of an
// answer, the address or browser storage to innerHTML without esc(). The
// queue panel was the one that mattered: a Test Manager sees the scenario
// codes of the company's testers there, and a code is text a tester writes.
describe('values traced to innerHTML (#1423)', () => {
  test('run: the queue panel escapes the scenario code, the e-mail and the counts', () => {
    const src = read('run.html');
    expect(src).toContain("<td style=\"padding:6px 8px\">' + esc(scenario) + '</td>'");
    expect(src).toContain("<td style=\"padding:6px 8px\">' + esc(email) + youBadge + '</td>'");
    expect(src).toContain("' + esc(used) + '/' + esc(total) + ' slots used</div>'");
  });

  test("reset-password: the server's message is set as text, the link is the page's own", () => {
    const src = read('reset-password.html');
    expect(src).toContain('box.textContent = msg;');
    expect(src).not.toMatch(/innerHTML\s*=\s*\n?\s*msg/);
  });

  test('admin: user and company ids reach the page through esc()', () => {
    const src = read('admin.html');
    expect(src).not.toMatch(/\$\{(u|c)\.id\}/);
    // '$' + '{…}': the page's own template text, not one of this file's.
    expect(src).toContain('data-user-id="$' + '{esc(u.id)}"');
  });

  test('welcome: the name taken from the stored e-mail goes through esc()', () => {
    expect(read('welcome.html')).toContain('heading.innerHTML = `Welcome, $' + '{esc(displayName)}! $' + '{pill}`;');
  });
});
