// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #801 PR 2: the AI service's rules (utils/aiConfig.js) and the page's
 * section (public/js/ai-analysis.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../../src/utils/aiConfig');
const { esc } = require('../../public/js/esc');

const good = (over = {}) => ({ connector: 'anthropic', baseUrl: 'https://api.anthropic.com/', model: 'claude-opus-5-5', apiKey: 'sk-test-1234', ...over });

describe('#801 PR 2 checkConfig', () => {
  // The address rule is the one of every outbound call (urlPolicy.js); the
  // test set-up turns it off for local stubs, so turn it back on here.
  let saved;
  beforeEach(() => { saved = process.env.ALLOW_PRIVATE_TARGETS; process.env.ALLOW_PRIVATE_TARGETS = ''; });
  afterEach(() => { if (saved === undefined) delete process.env.ALLOW_PRIVATE_TARGETS; else process.env.ALLOW_PRIVATE_TARGETS = saved; });

  test('a good configuration is cleaned: trailing slash, trimmed key, empty optional fields', () => {
    const { value, refusal } = C.checkConfig(good({ apiKey: '  sk-test-1234 ', monthlyTokenCap: '', instruction: '  ' }));
    expect(refusal).toBeUndefined();
    expect(value).toEqual({ connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5',
      apiKey: 'sk-test-1234', monthlyTokenCap: null, instruction: null, priceInput: null, priceOutput: null });
  });

  test('a long run of trailing slashes is trimmed', () => {
    expect(C.checkConfig(good({ baseUrl: 'https://x.example/v1' + '/'.repeat(300) })).value.baseUrl).toBe('https://x.example/v1');
  });

  test.each([
    [{ connector: 'other' }, 'kind of AI service'],
    [{ baseUrl: '' }, 'address of the AI service'],
    [{ baseUrl: 'http://api.example.com' }, 'https'],
    [{ baseUrl: 'https://127.0.0.1' }, 'private'],
    [{ baseUrl: 'https://localhost' }, 'internal host'],
    [{ baseUrl: 'https://u:p@api.example.com' }, 'name or password'],
    [{ baseUrl: 'https://api.example.com/?key=1' }, 'query'],
    [{ baseUrl: 'https://' + 'a'.repeat(600) + '.com' }, 'longer than'],
    [{ model: '' }, 'model to use'],
    [{ model: 'gpt 4' }, 'letters, digits'],
    [{ apiKey: 'has space' }, 'printable'],
    [{ apiKey: 42 }, 'printable'],
    [{ monthlyTokenCap: 10 }, 'monthly token limit'],
    [{ monthlyTokenCap: 1.5e3 + 0.5 }, 'monthly token limit'],
    [{ instruction: 7 }, 'is text'],
    [{ instruction: 'x'.repeat(2001) }, 'longer than 2000'],
  ])('refuses %j', (over, words) => {
    const { refusal } = C.checkConfig(good(over));
    expect(refusal).toContain(words);
  });

  test('no body is refused, an absent or empty key is kept out', () => {
    expect(C.checkConfig(null).refusal).toBeTruthy();
    expect(C.checkConfig(good({ apiKey: '' })).value).not.toHaveProperty('apiKey');
    expect(C.checkConfig(good({ apiKey: undefined })).value).not.toHaveProperty('apiKey');
  });
});

describe('#801 PR 2 when the key is asked again, and when a save is tested', () => {
  const stored = { connector: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-opus-5-5', api_key_enc: 'x', tested_at: '2026-10-17T06:00:00Z' };
  const next = (over = {}) => ({ connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', monthlyTokenCap: null, instruction: null, ...over });

  test('a stored key is never sent to another host or another kind of service', () => {
    expect(C.keyRefusal(stored, next())).toBeNull();
    expect(C.keyRefusal(stored, next({ baseUrl: 'https://api.anthropic.com/v1' }))).toBeNull();
    expect(C.keyRefusal(stored, next({ baseUrl: 'https://evil.example.com' }))).toContain('Type the key again');
    expect(C.keyRefusal(stored, next({ connector: 'openai_compatible' }))).toContain('Type the key again');
    expect(C.keyRefusal(stored, next({ baseUrl: 'https://evil.example.com', apiKey: 'k' }))).toBeNull();
  });

  test('Anthropic needs a key; an OpenAI-compatible service may have none', () => {
    expect(C.keyRefusal(null, next())).toContain('Give the key');
    expect(C.keyRefusal(null, next({ connector: 'openai_compatible' }))).toBeNull();
  });

  test('a new service, address, model or key is tested; a limit or an instruction is not', () => {
    expect(C.needsTest(null, next())).toBe(true);
    expect(C.needsTest({ ...stored, tested_at: null }, next())).toBe(true);
    expect(C.needsTest(stored, next())).toBe(false);
    expect(C.needsTest(stored, next({ monthlyTokenCap: 5000, instruction: 'Be short.' }))).toBe(false);
    expect(C.needsTest(stored, next({ model: 'claude-sonnet-5-5' }))).toBe(true);
    expect(C.needsTest(stored, next({ baseUrl: 'https://api.anthropic.com/v1' }))).toBe(true);
    expect(C.needsTest(stored, next({ connector: 'openai_compatible' }))).toBe(true);
    expect(C.needsTest(stored, next({ apiKey: 'new' }))).toBe(true);
  });

  test('the audit names the changed fields, never a value', () => {
    expect(C.changedFields(stored, next({ model: 'm2', apiKey: 'secret-key' }))).toEqual(['model', 'apiKey']);
    expect(C.changedFields(null, next()).join(',')).not.toContain('secret');
  });
});

describe('#801 PR 2 the test request and its answer', () => {
  test('Anthropic: /v1/messages, with or without /v1 in the address, its version and key headers', () => {
    const r = C.testRequest({ connector: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', apiKey: 'k1' });
    expect(r.url).toBe('https://api.anthropic.com/v1/messages');
    expect(C.anthropicEndpoint('https://gw.example.com/v1/')).toBe('https://gw.example.com/v1/messages');
    expect(r.headers).toMatchObject({ 'x-api-key': 'k1', 'anthropic-version': '2023-06-01' });
    expect(r.body).toEqual({ model: 'claude-opus-5-5', max_tokens: C.TEST_MAX_TOKENS, messages: [{ role: 'user', content: C.TEST_PROMPT }] });
  });

  test('OpenAI-compatible: /chat/completions, a bearer key only when there is one, no token field', () => {
    const r = C.testRequest({ connector: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', model: 'mistral-large-latest', apiKey: 'k2' });
    expect(r.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(r.headers.authorization).toBe('Bearer k2');
    expect(r.body).not.toHaveProperty('max_tokens');
    expect(C.testRequest({ connector: 'openai_compatible', baseUrl: 'https://x.example', model: 'm' }).headers).not.toHaveProperty('authorization');
  });

  test('answers are read per connector; an unknown shape is null', () => {
    expect(C.readAnswer('anthropic', { model: 'claude-opus-5-5', stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'OK' }], usage: { input_tokens: 20, output_tokens: 2 } }))
      .toEqual({ answer: 'OK', text: 'OK', stopReason: 'end_turn', model: 'claude-opus-5-5', usage: { input: 20, output: 2 } });
    expect(C.readAnswer('openai_compatible', { model: 'gpt-4o', choices: [{ message: { content: ' OK\n' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 18, completion_tokens: 1 } }))
      .toEqual({ answer: 'OK', text: ' OK\n', stopReason: 'stop', model: 'gpt-4o', usage: { input: 18, output: 1 } });
    expect(C.readAnswer('anthropic', { choices: [] })).toBeNull();
    expect(C.readAnswer('openai_compatible', { content: [] })).toBeNull();
    expect(C.readAnswer('anthropic', null)).toBeNull();
    expect(C.readAnswer('anthropic', { content: [{ type: 'text', text: 'x'.repeat(500) }] }).answer).toHaveLength(201);
  });

  test('an error names the status and the service\'s message, with the key masked', () => {
    expect(C.describeError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-abcdef' } }, '', 'sk-abcdef'))
      .toBe('The AI service answered HTTP 401: invalid x-api-key ***');
    expect(C.describeError(404, { error: 'model not found' }, '', 'k')).toBe('The AI service answered HTTP 404: model not found');
    expect(C.describeError(502, null, '<html>Bad gateway</html>', null)).toBe('The AI service answered HTTP 502: <html>Bad gateway</html>');
    expect(C.describeError(500, null, '', null)).toBe('The AI service answered HTTP 500');
  });

  test('the page never sees the key', () => {
    const view = C.configView({ connector: 'anthropic', base_url: 'https://a.example', model: 'm', api_key_enc: 'enc', monthly_token_cap: null, instruction: null });
    expect(view.hasKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('enc');
    expect(C.configView(null)).toBeNull();
  });
});

describe('#801 PR 2 the page section', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'ai-analysis.js'), 'utf8');
  const lines = source.split('\n');
  const lift = (name) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return lines.slice(start, end + 1).join('\n');
  };
  const consts = lines.filter((l) => /^const (NOTE|INFO|OK|CELL|FIELD|WIDE) =/.test(l)).join('\n');
  const ctx = vm.createContext({ esc });
  vm.runInContext(`${consts}\n${['connectorOptionsHtml', 'priceText', 'modelOptionsHtml', 'testedHtml', 'serviceHtml', 'testResultHtml'].map(lift).join('\n')}
    this.serviceHtml = serviceHtml; this.testResultHtml = testResultHtml;`, ctx);
  const answer = (config) => ({ config, connectors: C.connectorsForPage(), limits: { instruction: 2000, minTokenCap: 1000 } });
  const target = { id: 'p1', name: 'Beta <b>', provider: true };

  test('a new section starts from the first kind and its usual address, names its target, escapes its name', () => {
    const html = ctx.serviceHtml(target, answer(null), 3);
    expect(html).toContain('AI service — Beta &lt;b&gt;');
    expect(html).toContain('data-ai-target="p1" data-ai-provider="1"');
    expect(html).toContain('value="https://api.anthropic.com"');
    expect(html).toContain('Not configured yet');
    expect(html).not.toContain('data-ai-action="remove"');
    for (const f of ['connector', 'baseUrl', 'model', 'apiKey', 'cap', 'instruction', 'priceIn', 'priceOut']) {
      expect(html).toContain(`<label for="ai-${f}-3"`);
      expect(html).toContain(`id="ai-${f}-3"`);
    }
  });

  test('a stored service shows its values but never a key, and can be removed', () => {
    const html = ctx.serviceHtml({ ...target, provider: false }, answer({ connector: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1',
      model: 'mistral-large-latest', hasKey: true, monthlyTokenCap: 50000, instruction: 'Be <short>', testedAt: '2026-10-17T06:00:00Z' }), 0);
    expect(html).toContain('data-ai-provider=""');
    expect(html).toMatch(/<option value="openai_compatible" selected>/);
    expect(html).toContain('value="mistral-large-latest"');
    expect(html).toMatch(/data-f="apiKey" style="[^"]*" type="password" value=""/);
    expect(html).toContain('A key is stored. Leave empty to keep it.');
    expect(html).toContain('Be &lt;short&gt;</textarea>');
    expect(html).toContain('data-ai-action="remove"');
  });

  test('a test result in words, escaped', () => {
    expect(ctx.testResultHtml({ ok: true, answer: 'OK <i>', ms: 120, usage: { input: 20, output: 2 }, model: 'm' }))
      .toContain('answered in 120 ms · 20 tokens in, 2 out: “OK &lt;i&gt;” — model m');
    expect(ctx.testResultHtml({ ok: false, error: 'HTTP 401: <bad>' })).toContain('HTTP 401: &lt;bad&gt;');
    expect(ctx.testResultHtml(null)).toBe('');
  });

  test('every request of a section names its company or provider', () => {
    expect(source).toContain("headers: { ...init.headers, 'X-Provider-Id': provider }");
    expect(source.match(/fetch\(url[^\n]*\n?/g).every(l => l.includes('inTarget(section'))).toBe(true);
  });
});
