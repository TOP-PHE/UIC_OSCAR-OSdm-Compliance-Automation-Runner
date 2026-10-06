// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * ui-scripts.test.js — the scripts under Oscar_Server/public, without a browser.
 *
 * 1. Every inline <script> block and every file under public/js compiles.
 *    ESLint ignores public/, and the inline-script lint only looks for a stray
 *    closing script tag, so until now nothing in CI would notice a syntax
 *    error in a page.
 * 2. The pure helpers rewritten for #525 (file-name and code clean-up, the
 *    report builder's JSON label) are pulled out of their page and run in a
 *    bare `vm` context. Their old regular expressions could backtrack
 *    quadratically; the tests pin what the helpers return and that a
 *    pathological input is now handled in linear time.
 *
 * A helper is located by its `function name(` line at column 0 and the next
 * line that is just `}`. That is how every top-level function in these files
 * is laid out; if one is ever reformatted, `loadFunction` fails loudly.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8').replaceAll('\r\n', '\n');

// Walks the page the way the HTML parser does, as dashboard-pages.test.js does:
// a script element ends at the first "</script" followed by whitespace, "/" or ">".
function inlineScripts(html) {
  const blocks = [];
  const openRe = /<script\b([^>]*)>/gi;
  let position = 0;
  while (position < html.length) {
    openRe.lastIndex = position;
    const open = openRe.exec(html);
    if (!open) break;
    const attrs = open[1] || '';
    const start = open.index + open[0].length;
    const closeRe = /<\/script[\s/>]/gi;
    closeRe.lastIndex = start;
    const close = closeRe.exec(html);
    const end = close ? close.index : html.length;
    const tagEnd = close ? html.indexOf('>', end) : -1;
    position = tagEnd === -1 ? html.length : tagEnd + 1;
    if (/\bsrc\s*=/i.test(attrs)) continue;                                  // external file
    if (/\btype\s*=\s*["']?(?!text\/javascript|module)[\w/+-]+/i.test(attrs)) continue; // data block, not code
    blocks.push({
      code: html.slice(start, end),
      line: html.slice(0, open.index).split('\n').length,
      module: /\btype\s*=\s*["']?module/i.test(attrs),
    });
  }
  return blocks;
}

function loadFunction(rel, name, context = {}) {
  const lines = read(rel).split('\n');
  const start = lines.findIndex(l => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`${rel}: no top-level "function ${name}(" at column 0`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (end === -1) throw new Error(`${rel}: no closing brace at column 0 after function ${name}`);
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context, { filename: `${rel}#${name}` });
}

// Generous on purpose: the old patterns needed seconds on these inputs.
const LINEAR_BUDGET_MS = 500;
function elapsedMs(fn) {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

describe('every script under public/ compiles', () => {
  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  const jsFiles = fs.readdirSync(path.join(PUBLIC_DIR, 'js')).filter(f => f.endsWith('.js')).map(f => `js/${f}`);

  test('there is something to check', () => {
    expect(htmlFiles.length).toBeGreaterThan(10);
    expect(jsFiles).toContain('js/scenarios.js');
    // The walker must actually find the inline scripts, or the checks below pass on nothing.
    expect(htmlFiles.flatMap(f => inlineScripts(read(f))).length).toBeGreaterThan(10);
  });

  test.each(htmlFiles)('%s: inline scripts', (file) => {
    for (const block of inlineScripts(read(file))) {
      if (block.module) continue;   // import/export need a module loader; none of the pages uses one today
      expect(() => new vm.Script(block.code, { filename: `${file} (inline script at line ${block.line})` })).not.toThrow();
    }
  });

  test.each(jsFiles)('%s', (file) => {
    expect(() => new vm.Script(read(file), { filename: file })).not.toThrow();
  });
});

describe('report-builder.html — jsonBlockLabel', () => {
  const jsonBlockLabel = loadFunction('report-builder.html', 'jsonBlockLabel');
  const label = (message) => jsonBlockLabel({ message });

  test.each([
    ['[JSON:Offer] {"offerId":"x"}', 'Offer'],
    ['[JSON:Booking request]', 'Booking request'],
    ['[JSON:Refund offer]   \n', 'Refund offer'],
    ['  [JSON:Trimmed first]  ', 'Trimmed first'],
  ])('explicit marker: %j → %j', (message, expected) => {
    expect(label(message)).toBe(expected);
  });

  test.each([
    ['Request body: {', 'Request body'],
    ['Selected offer {', 'Selected offer'],
    ['passengers:   [', 'passengers'],
    ['payload = [', 'payload ='],
  ])('text before the brace: %j → %j', (message, expected) => {
    expect(label(message)).toBe(expected);
  });

  test.each([
    ['no brace here'],
    ['key: value, then {'],
    ['{"starts":"with a brace"}'],
    ['[JSON:label] first line\nsecond line'],
    [''],
    [undefined],
  ])('falls back to "object": %j', (message) => {
    expect(label(message)).toBe('object');
  });

  test('a long run of spaces with no brace is rejected in linear time', () => {
    const message = 'label' + ' '.repeat(50000) + 'x';
    let out;
    expect(elapsedMs(() => { out = label(message); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(out).toBe('object');
  });
});

describe('file-name and code clean-up helpers', () => {
  const rb = loadFunction('report-builder.html', '_rbSanitiseFilename');
  const msg = loadFunction('run-detail.html', '_msgSanitiseFilename');
  const trimUnderscores = loadFunction('js/scenarios.js', 'trimUnderscores');
  const wizNormaliseCustomCode = loadFunction('js/scenarios.js', 'wizNormaliseCustomCode');

  test.each([
    ['OTST SALE/1: GET *offers?', 'OTST_SALE_1_GET_offers'],
    ['  leading and trailing  ', 'leading_and_trailing'],
    ['__a__b__', 'a_b'],
    ['a\\b|c<d>e"f', 'a_b_c_d_e_f'],
    ['///', ''],
    ['', ''],
  ])('both file-name sanitisers: %j → %j', (input, expected) => {
    expect(rb(input)).toBe(expected);
    expect(msg(input)).toBe(expected);
  });

  test('the sanitisers accept a missing value', () => {
    expect(rb(null)).toBe('');
    expect(rb(undefined)).toBe('');
    expect(msg(null)).toBe('');
  });

  test.each([
    ['__A__B__', 'A__B'],
    ['A', 'A'],
    ['___', ''],
    ['', ''],
    ['_A', 'A'],
    ['A_', 'A'],
  ])('trimUnderscores keeps the inside as it is: %j → %j', (input, expected) => {
    expect(trimUnderscores(input)).toBe(expected);
  });

  test.each([
    [' my code-1 ', 'MY_CODE_1'],
    ['__x__y__', 'X_Y'],
    ['sale / refund', 'SALE_REFUND'],
    ['***', ''],
    [null, ''],
  ])('wizNormaliseCustomCode: %j → %j', (input, expected) => {
    expect(wizNormaliseCustomCode(input)).toBe(expected);
  });

  test('a long run of underscores in the middle costs one pass', () => {
    const s = 'a' + '_'.repeat(200000) + 'b';
    let out;
    expect(elapsedMs(() => { out = trimUnderscores(s); })).toBeLessThan(LINEAR_BUDGET_MS);
    expect(out).toBe(s);
  });
});

describe('admin.html — autoSlug', () => {
  function slugOf(name) {
    const els = { 'new-co-name': { value: name }, 'new-co-slug': { value: 'unset' } };
    loadFunction('admin.html', 'autoSlug', { document: { getElementById: (id) => els[id] } })();
    return els['new-co-slug'].value;
  }

  test.each([
    ['Société Générale — Test!', 'societe-generale-test'],
    ['  SBB CFF FFS  ', 'sbb-cff-ffs'],
    ['--already--dashed--', 'already-dashed'],
    ['ČD / CHAPS', 'cd-chaps'],
    ['!!!', ''],
  ])('%j → %j', (name, expected) => {
    expect(slugOf(name)).toBe(expected);
  });
});

describe('run-detail.html — friendlyArtifactBase', () => {
  function baseFor(run) {
    return loadFunction('run-detail.html', 'friendlyArtifactBase', {
      currentRun: run,
      parseServerTs: (s) => new Date(s),
    })();
  }

  test('sandbox, date and scenario, with unsafe characters collapsed', () => {
    expect(baseFor({ env_name_used: 'OTST_Bileto_Env', started_at: '2026-10-05T10:00:00Z', scenario_code: 'OTST SALE/1' }))
      .toBe('Bileto_2026-10-05_OTST-SALE-1');
  });

  test('a name cut at 120 characters does not end on a separator', () => {
    // 18 characters of prefix + 99 X = 117, then "-.-" lands on 118-120.
    const scenario = 'X'.repeat(99) + '-.-' + 'Y'.repeat(40);
    const base = baseFor({ env_name_used: 'OTST_Bileto_Env', started_at: '2026-10-05T10:00:00Z', scenario_code: scenario });
    expect(base).toBe('Bileto_2026-10-05_' + 'X'.repeat(99));
  });

  test('nothing usable falls back to "sandbox_run"', () => {
    expect(baseFor(null)).toBe('sandbox_run');
  });
});
