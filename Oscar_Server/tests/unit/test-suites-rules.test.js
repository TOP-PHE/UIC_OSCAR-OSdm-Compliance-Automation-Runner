// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * test-suites-rules.test.js — #1342 PR 4: the rules of a named suite
 * (utils/testSuites.js) and what the Run page draws of them
 * (public/js/test-suites.js, its pure functions lifted by text).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../../src/utils/testSuites');
const { esc } = require('../../public/js/esc');

describe('suiteOf()', () => {
  test('a selection, a list of codes, or both; the selection always cut from every scenario', () => {
    expect(S.suiteOf({ name: ' nightly ', codes: ['A', 'A', 'B'] })).toEqual({ name: 'nightly', selection: null, codes: ['A', 'B'] });
    const both = S.suiteOf({ name: 'both', selection: { base: 'list', groups: [] }, codes: ['A'] });
    expect(both.selection.base).toBe('all');
    expect(both.codes).toEqual(['A']);
  });

  test.each([
    ['no name', { codes: ['A'] }],
    ['a name with a line break', { name: 'a\nb', codes: ['A'] }],
    ['neither', { name: 'x' }],
    ['an empty list', { name: 'x', codes: [] }],
    ['a code that is not text', { name: 'x', codes: [1] }],
    ['a bad selection', { name: 'x', selection: { categories: ['nonsense'] } }],
  ])('refused: %s', (_, body) => {
    expect(S.suiteOf(body).error).toEqual(expect.any(String));
  });
});

test('suiteCodes(): what the selection keeps, then the codes listed the provider has; the others named', () => {
  const suite = { codes: ['B', 'GONE', 'A'] };
  expect(S.suiteCodes(suite, ['A', 'B', 'C'], ['C', 'A'])).toEqual({ codes: ['C', 'A', 'B'], notFound: ['GONE'] });
  expect(S.suiteCodes({ codes: null }, ['A'], ['A'])).toEqual({ codes: ['A'], notFound: [] });
  expect(S.suiteCodes({ codes: ['A'] }, ['A'], null)).toEqual({ codes: ['A'], notFound: [] });
});

describe('the Run page\'s suites card', () => {
  const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/js/test-suites.js'), 'utf8').replaceAll('\r\n', '\n').split('\n');
  const lift = (name, context) => {
    const start = SOURCE.findIndex(l => l.startsWith(`function ${name}(`));
    const end = SOURCE.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${SOURCE.slice(start, end + 1).join('\n')})`, context);
  };
  const words = vm.runInNewContext(`${SOURCE.find(l => l.startsWith('const SUITE_FILTER_WORDS'))}\nSUITE_FILTER_WORDS`);
  const selectionText = lift('selectionText', { SUITE_FILTER_WORDS: words, Array });
  const suitesHtml = lift('suitesHtml', { esc, selectionText });

  test('a selection in words', () => {
    expect(selectionText({ categories: ['happy'], groups: ['refund', 'sale'], forms: [], lastRun: 'failed' }))
      .toBe('category: happy · capability: refund, sale · last run: failed');
    expect(selectionText({ categories: [], lastRun: 'all' })).toBe('every scenario');
  });

  test('each suite escaped; Delete for a Test Manager only', () => {
    const list = [{ id: 's1', name: 'night<ly>', selection: { categories: ['happy'] }, codes: ['A<1>'] }];
    const html = suitesHtml(list, true);
    expect(html).toContain('night&lt;ly&gt;');
    expect(html).toContain('A&lt;1&gt;');
    expect(html).toContain('data-suite-action="delete" data-id="s1"');
    expect(suitesHtml(list, false)).not.toContain('data-suite-action');
    expect(suitesHtml([], true)).toContain('No suite yet');
  });

  test('only a UUID read from an answer goes in a request address (S8476)', () => {
    const idLine = SOURCE.find(l => l.startsWith('const SUITE_ID = '));
    const start = SOURCE.findIndex(l => l.startsWith('function suiteIdOf('));
    const end = SOURCE.findIndex((l, i) => i > start && l === '}');
    const suiteIdOf = vm.runInNewContext(`${idLine}\n(${SOURCE.slice(start, end + 1).join('\n')})`);
    expect(suiteIdOf('3F2A91C0-1D2E-4C5B-8A9F-0123456789AB')).toBe('3f2a91c0-1d2e-4c5b-8a9f-0123456789ab');
    for (const bad of ['../x', '', null, 'nightly']) expect(suiteIdOf(bad)).toBeNull();
  });

  test('the Run page holds the card and loads the script after its own', () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../public/run.html'), 'utf8');
    expect(page).toContain('id="suites-card"');
    expect(page.lastIndexOf('<script src="/js/test-suites.js"></script>')).toBeGreaterThan(page.lastIndexOf('</script>\n<footer'));
  });
});
