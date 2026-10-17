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

describe('#801 where a Test Manager stands, for one company or provider', () => {
  const v = A.COMMITMENT.version;
  test.each([
    [null, 'none'],
    [{ state: 'pending', text_version: v }, 'pending'],
    [{ state: 'approved', text_version: v }, 'approved'],
    [{ state: 'approved', text_version: v - 1 }, 'needs_acceptance'],
    [{ state: 'refused', text_version: v }, 'none'],
    [{ state: 'revoked', text_version: v }, 'none'],
    [{ state: 'odd', text_version: v }, 'none'],
  ])('request %j → %s', (request, state) => {
    expect(A.accessState(request)).toBe(state);
  });

  test('a request may be made from none and needs_acceptance only', () => {
    expect(['none', 'pending', 'approved', 'needs_acceptance'].filter(A.mayRequest)).toEqual(['none', 'needs_acceptance']);
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
  const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  const names = ['commitmentHtml', 'requestFormHtml', 'pastRequestHtml', 'stateHtml', 'mayAsk', 'targetRowHtml', 'accessHtml'];
  vm.runInContext(`${consts}\n${names.map(lift).join('\n')}\nthis.accessHtml = accessHtml;`, ctx);
  const commitment = A.commitmentForPage();
  const target = (id, state, request = null, provider = true) => ({ id, name: `${id} <b>`, provider, state, request });
  const page = (...targets) => ctx.accessHtml({ targets, commitment, company: { name: 'Acme' } });

  test('nothing asked yet: one box per company or provider, the whole text, a box to tick, a button that starts disabled', () => {
    const html = page(target('own', 'none', null, false), target('p1', 'none'));
    for (const p of commitment.points) expect(html).toContain(esc(p));
    expect(html).toContain('value="own"');
    expect(html).toContain('value="p1"');
    expect(html).toContain('p1 &lt;b&gt;');
    expect(html).toContain('data-ai-action="accept"');
    expect(html).toMatch(/data-ai-action="request" disabled>Send the request</);
  });

  test('a refused provider shows its reason and can be asked again; the others keep their state, without a box', () => {
    const html = page(target('own', 'approved', null, false), target('p1', 'none', { state: 'refused', reason: 'No <contract>' }),
      target('p2', 'pending', { textVersion: 1, acceptedAt: '2026-10-17 06:00:00' }));
    expect(html).toContain('Refused: No &lt;contract&gt;');
    expect(html).toContain('value="p1"');
    expect(html).not.toContain('value="own"');
    expect(html).not.toContain('value="p2"');
    expect(html).toContain('Waiting for an OSCAR administrator');
    expect(page(target('p1', 'none', { state: 'revoked', reason: 'Ended' }))).toContain('Withdrawn: Ended');
  });

  test('nothing to ask: the text without a button; approved says what comes next', () => {
    const waiting = page(target('own', 'pending', { textVersion: 1 }, false));
    expect(waiting).not.toContain('data-ai-action="request"');
    const open = page(target('own', 'approved', null, false));
    expect(open).toContain('Approved');
    expect(open).toContain('comes in the next releases');
    expect(open).not.toContain('data-ai-action="request"');
  });

  test('a changed text is accepted again, from a box like the others', () => {
    const html = page(target('own', 'needs_acceptance', { state: 'approved', textVersion: 0 }, false));
    expect(html).toContain('accept it again');
    expect(html).toContain('value="own"');
    expect(html).toContain('data-ai-action="request"');
  });

  test('the page sends back the version and hash it showed, and the ticked targets', () => {
    expect(source).toContain('JSON.stringify({ version: current.commitment.version, hash: current.commitment.hash, companies })');
  });

  test('the menu offers it to Test Managers only', () => {
    const nav = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'nav.js'), 'utf8');
    const block = nav.slice(nav.indexOf("if (role === 'test_manager') {"), nav.indexOf("if (role === 'test_manager') {") + 500);
    expect(block).toContain("href: '/ai-analysis.html'");
    expect(nav.split("'/ai-analysis.html'")).toHaveLength(2);
  });
});
