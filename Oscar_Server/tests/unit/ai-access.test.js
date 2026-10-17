// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801, PR 1: the rules of access to the AI analysis (utils/aiAccess.js), the
 * page that shows them (public/js/ai-analysis.js) and its menu entry.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../../src/utils/aiAccess');
const { esc } = require('../../public/js/esc');

describe('#801 the commitment text', () => {
  test('it says what leaves OSCAR, who may send it, whose terms, whose costs, what an analysis is, and that it is recorded', () => {
    const text = A.commitmentText();
    for (const words of ['Data leaves OSCAR', 'You must be allowed to send it', 'own terms apply', 'Costs are yours',
      'An AI analysis is an opinion', 'It is recorded', 'confidentiality agreement', 'trains on your data']) {
      expect(text).toContain(words);
    }
    expect(text.split('\n')).toHaveLength(1 + A.COMMITMENT.points.length);
  });

  test('the hash pins the text: one character changed, another hash', () => {
    expect(A.commitmentHash()).toMatch(/^[0-9a-f]{64}$/);
    const changed = { ...A.COMMITMENT, points: [...A.COMMITMENT.points.slice(0, -1), A.COMMITMENT.points.at(-1) + '!'] };
    expect(A.commitmentHash(changed)).not.toBe(A.commitmentHash());
    expect(A.commitmentForPage()).toMatchObject({ version: A.COMMITMENT.version, hash: A.commitmentHash() });
  });

  test('an acceptance counts only for the version and hash in force', () => {
    expect(A.acceptsCurrentText({ version: A.COMMITMENT.version, hash: A.commitmentHash() })).toBe(true);
    expect(A.acceptsCurrentText({ version: String(A.COMMITMENT.version), hash: A.commitmentHash() })).toBe(true);
    expect(A.acceptsCurrentText({ version: A.COMMITMENT.version + 1, hash: A.commitmentHash() })).toBe(false);
    expect(A.acceptsCurrentText({ version: A.COMMITMENT.version, hash: 'abc' })).toBe(false);
    expect(A.acceptsCurrentText(null)).toBe(false);
  });
});

describe('#801 where a Test Manager stands', () => {
  const v = A.COMMITMENT.version;
  test.each([
    [false, { state: 'approved', text_version: v }, 'disabled'],
    [true, null, 'none'],
    [true, { state: 'pending', text_version: v }, 'pending'],
    [true, { state: 'approved', text_version: v }, 'approved'],
    [true, { state: 'approved', text_version: v - 1 }, 'needs_acceptance'],
    [true, { state: 'refused', text_version: v }, 'none'],
    [true, { state: 'revoked', text_version: v }, 'none'],
    [true, { state: 'odd', text_version: v }, 'none'],
  ])('enabled %s, request %j → %s', (enabled, request, state) => {
    expect(A.accessState(enabled, request)).toBe(state);
  });

  test('a request may be made from none and needs_acceptance only', () => {
    expect(['disabled', 'none', 'pending', 'approved', 'needs_acceptance'].filter(A.mayRequest)).toEqual(['none', 'needs_acceptance']);
  });
});

describe('#801 the page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = lines.filter((l) => /^const (NOTE|INFO|WARN|OK) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  vm.runInContext(`${consts}\n${lift('commitmentHtml')}\n${lift('requestFormHtml')}\n${lift('pastRequestHtml')}\n${lift('accessHtml')}\nthis.accessHtml = accessHtml;`, ctx);
  const commitment = A.commitmentForPage();
  const page = (state, request = null) => ctx.accessHtml({ state, request, commitment, company: { name: 'Acme <b>' } });

  test('switched off: no text, no button, the company named as text', () => {
    const html = page('disabled');
    expect(html).toContain('not enabled for Acme &lt;b&gt;');
    expect(html).not.toContain('data-ai-action="request"');
  });

  test('no request: the whole text, a box to tick, and a button that starts disabled', () => {
    const html = page('none');
    for (const p of commitment.points) expect(html).toContain(esc(p));
    expect(html).toContain('data-ai-action="accept"');
    expect(html).toMatch(/data-ai-action="request" disabled>Ask for access</);
  });

  test('refused or withdrawn: the reason is shown, escaped, and a new request is offered', () => {
    const html = page('none', { state: 'refused', reason: 'No <contract>' });
    expect(html).toContain('was refused: No &lt;contract&gt;');
    expect(html).toContain('Ask for access');
    expect(page('none', { state: 'revoked', reason: 'Ended' })).toContain('was withdrawn: Ended');
  });

  test('pending, approved, and a text to accept again', () => {
    expect(page('pending', { textVersion: 1, acceptedAt: '2026-10-17 06:00:00' })).toContain('waiting for an OSCAR administrator');
    expect(page('pending', { textVersion: 1 })).not.toContain('data-ai-action="request"');
    expect(page('approved')).toContain('Your access is approved');
    expect(page('needs_acceptance')).toContain('Accept the new text');
  });

  test('the page sends back the version and hash it showed', () => {
    expect(source).toContain('JSON.stringify({ version: current.commitment.version, hash: current.commitment.hash })');
  });

  test('the menu offers it to Test Managers only', () => {
    const nav = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'nav.js'), 'utf8');
    const block = nav.slice(nav.indexOf("if (role === 'test_manager') {"), nav.indexOf("if (role === 'test_manager') {") + 500);
    expect(block).toContain("href: '/ai-analysis.html'");
    expect(nav.split("'/ai-analysis.html'")).toHaveLength(2);
  });
});
