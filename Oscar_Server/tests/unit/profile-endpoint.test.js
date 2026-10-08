// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * profile-endpoint.test.js — the API Config page (#544, #580).
 *
 * #544. A company's OSDM endpoint is shared by every tester: each run goes to
 * it with the token of the tester who started it. Only a Test Manager may
 * change it. The server enforces that (tests/integration/company-routes.test.js);
 * this file checks that the page agrees: for anyone else the field is
 * read-only and the save does not send the endpoint, so saving one's own
 * credentials keeps working.
 *
 * #580. The page holds one section for the user's company and one for each
 * provider they may use. Every request of a section names that section's
 * company or provider, the menu's "Working on" choice plays no part, and
 * saving one section sends nothing about another.
 *
 * No browser. The page's own functions are lifted out of public/profile.html
 * and run in a `vm` context with fake sections and a fake `fetch`, as
 * scenarios-load-guard.test.js does for scenarios.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', '..', 'public', 'profile.html'), 'utf8')
  .replaceAll('\r\n', '\n').split('\n');

function sourceOf(name) {
  const start = SOURCE.findIndex(l => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`));
  if (start === -1) throw new Error(`profile.html: no top-level function ${name} at column 0`);
  const end = SOURCE.findIndex((l, i) => i > start && l === '}');
  return SOURCE.slice(start, end + 1).join('\n');
}

// The page's own one-line declaration of a constant, so the rule under test is the page's.
function declarationOf(name) {
  const line = SOURCE.find(l => l.startsWith(`const ${name} = `));
  if (!line) throw new Error(`profile.html: no top-level "const ${name} = " at column 0`);
  return line;
}

const OWN = 'company-own';
const ALPHA = 'provider-alpha';
const BETA = 'provider-beta';
const NAMES = { [OWN]: 'PENTEST', [ALPHA]: 'Alpha', [BETA]: 'Beta' };
const endpointOf = id => `https://${id}.example/osdm`;

// A section of the page: fields are found by their data-f name, as on the page.
function makeCard(id) {
  const fields = new Map();
  const element = (name) => {
    if (!fields.has(name)) {
      fields.set(name, {
        name, value: '', textContent: '', innerHTML: '', readOnly: false, disabled: false, className: '', style: {},
        classList: { toggle() {} },
        querySelectorAll: () => [],
      });
    }
    return fields.get(name);
  };
  return {
    dataset: { targetId: id },
    element,
    querySelector(selector) {
      const match = /^\[data-f="([^"]+)"\]$/.exec(selector);
      if (!match) throw new Error(`a section is only searched by data-f, not by ${selector}`);
      return element(match[1]);
    },
  };
}

// Opens the page as `role`. `server` answers the requests; by default every
// company or provider exists and the user has a bearer token for each.
function openPage(role, { selected = null, failing = () => false } = {}) {
  const calls = [];
  const messages = [];
  const pageMessages = [];
  const fetch = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    const target = headers['X-Provider-Id'];
    const call = { method, url, target, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const status = failing(call) || 200;
    const json = async () => {
      if (method !== 'GET') return {};
      if (url === '/v1/company/providers') return { providers: [{ id: ALPHA, name: 'Alpha' }, { id: BETA, name: 'Beta' }] };
      const id = target || OWN;   // '' names no provider: the own company
      if (url === '/v1/company') {
        return { id, name: NAMES[id], parent_id: id === OWN ? null : OWN, api_base: endpointOf(id), extra_headers: [], datafile_updated_at: '2026-10-06' };
      }
      if (url === '/v1/me/credentials') return { auth_mode: 'bearer', has_token: true };
      return {};
    };
    return { ok: status >= 200 && status < 300, status, json };
  };
  const context = vm.createContext({
    console,
    user: { role },
    fetch,
    confirm: () => true,
    esc: s => String(s),
    oscarSelectedProvider: () => selected,
    showMsg: (text, ok) => pageMessages.push({ text, ok }),
    showTargetMsg: (card, text, ok) => messages.push({ target: card.dataset.targetId, text, ok }),
    switchMode: () => {},
    switchProfile: () => {},
    renderExtraHeaders: () => {},
    collectExtraHeaders: card => [{ name: 'X-Section', value: card.dataset.targetId }],
    renderSummary: () => {},
  });
  const code = [
    declarationOf('CAN_EDIT_HEADERS'), declarationOf('CAN_EDIT_ENDPOINT'), declarationOf('targets'),
    ...['field', 'inTarget', 'credentialsSet', 'badge', 'markUnsaved', 'nameTarget', 'fillShared', 'fillCredentials',
      'fillTarget', 'targetUnavailable', 'loadTarget', 'sharedPayload', 'credentialsPayload', 'saveShared',
      'saveTarget', 'clearCredentials', 'listTargets'].map(sourceOf),
    // Expose the page's `const` to the test.
    'this.targets = targets;',
  ].join('\n\n');
  vm.runInContext(code, context, { filename: 'profile.html (extract)' });
  const cards = Object.fromEntries([OWN, ALPHA, BETA].map(id => [id, makeCard(id)]));
  return { context, cards, calls, messages, pageMessages };
}

const sent = page => page.calls.map(c => `${c.method} ${c.url} @${c.target}`);

describe('API Config page — the shared endpoint (#544)', () => {
  describe.each([['company_user'], ['certification_user'], ['administrator'], [undefined]])('opened as %s', (role) => {
    test('the endpoint is shown read-only, with the note that says who can change it', async () => {
      const page = openPage(role);
      const card = page.cards[ALPHA];
      await page.context.loadTarget(card);
      expect(card.element('api_base').value).toBe(endpointOf(ALPHA));
      expect(card.element('api_base').readOnly).toBe(true);
      expect(card.element('api-base-readonly-note').style.display).toBe('block');
    });

    test('saving sends the credentials and nothing to the company', async () => {
      const page = openPage(role);
      const card = page.cards[ALPHA];
      await page.context.loadTarget(card);
      card.element('api_base').value = 'https://elsewhere.example/collect';   // however it got there
      card.element('auth_mode').value = 'bearer';
      card.element('access_token').value = 'new-token';
      page.calls.length = 0;

      await page.context.saveTarget(card);

      expect(page.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /v1/me/credentials']);
      expect(page.calls[0].body).toEqual({ auth_mode: 'bearer', access_token: 'new-token' });
      expect(page.messages).toEqual([{ target: ALPHA, text: 'Configuration saved for Alpha.', ok: true }]);
    });
  });

  describe('opened as a Test Manager', () => {
    test('the endpoint is editable and the note stays hidden', async () => {
      const page = openPage('test_manager');
      const card = page.cards[OWN];
      await page.context.loadTarget(card);
      expect(card.element('api_base').value).toBe(endpointOf(OWN));
      expect(card.element('api_base').readOnly).toBe(false);
      expect(card.element('api-base-readonly-note').style.display).toBeUndefined();
    });

    test('saving sends the endpoint and the headers to the company, then the credentials', async () => {
      const page = openPage('test_manager');
      const card = page.cards[OWN];
      await page.context.loadTarget(card);
      card.element('api_base').value = '  https://new.example/osdm  ';
      card.element('auth_mode').value = 'bearer';
      page.calls.length = 0;

      await page.context.saveTarget(card);

      expect(page.calls.filter(c => c.method !== 'GET').map(c => `${c.method} ${c.url}`)).toEqual(['PATCH /v1/company', 'PATCH /v1/me/credentials']);
      expect(page.calls[0].body).toEqual({ api_base: 'https://new.example/osdm', extra_headers: [{ name: 'X-Section', value: OWN }] });
    });
  });

  test('the page has the note element the script shows', () => {
    expect(SOURCE.some(l => l.includes('data-f="api-base-readonly-note"'))).toBe(true);
  });
});

describe('API Config page — one section per company or provider (#580)', () => {
  test('the sections are the own company, then the providers the server lists', async () => {
    const page = openPage('test_manager', { selected: { id: BETA, name: 'Beta' } });
    const list = await page.context.listTargets();
    expect(JSON.parse(JSON.stringify(list))).toEqual([
      { id: OWN, name: 'PENTEST', provider: false },
      { id: ALPHA, name: 'Alpha', provider: true },
      { id: BETA, name: 'Beta', provider: true },
    ]);
    // The own company is asked for with an empty X-Provider-Id: nav.js adds the
    // "Working on" provider only to a request that names none, and the server
    // reads an empty one as "the own company".
    expect(sent(page)).toEqual(['GET /v1/company @', 'GET /v1/company/providers @undefined']);
  });

  test('a list of providers that cannot be read is said, not taken for "none"', async () => {
    const page = openPage('test_manager', { failing: c => (c.url === '/v1/company/providers' ? 500 : 0) });
    const list = await page.context.listTargets();
    expect(list.map(t => t.id)).toEqual([OWN]);
    expect(page.pageMessages).toHaveLength(1);
    expect(page.pageMessages[0].ok).toBe(false);
    expect(page.pageMessages[0].text).toMatch(/could not be loaded/);
  });

  test('without the own company there is no page to build', async () => {
    const page = openPage('test_manager', { failing: c => (c.url === '/v1/company' ? 500 : 0) });
    expect(await page.context.listTargets()).toBeNull();
  });

  test('every request of a section names that section, whatever "Working on" says', async () => {
    const page = openPage('test_manager', { selected: { id: ALPHA, name: 'Alpha' } });
    for (const id of [OWN, ALPHA, BETA]) {
      const card = page.cards[id];
      await page.context.loadTarget(card);
      card.element('access_token').value = 'token-of-' + id;
      await page.context.saveTarget(card);
      await page.context.clearCredentials(card);
    }
    for (const id of [OWN, ALPHA, BETA]) {
      const mine = page.calls.filter(c => c.target === id);
      // load, save (2 PATCH + reload), clear (1 PATCH + reload)
      expect(mine.map(c => `${c.method} ${c.url}`)).toEqual([
        'GET /v1/company', 'GET /v1/me/credentials',
        'PATCH /v1/company', 'PATCH /v1/me/credentials', 'GET /v1/company', 'GET /v1/me/credentials',
        'PATCH /v1/me/credentials', 'GET /v1/company', 'GET /v1/me/credentials',
      ]);
    }
    // Nothing was sent without naming its section.
    expect(page.calls.every(c => [OWN, ALPHA, BETA].includes(c.target))).toBe(true);
  });

  test('saving one section sends that section\'s values and nothing about another', async () => {
    const page = openPage('test_manager');
    for (const id of [OWN, ALPHA, BETA]) await page.context.loadTarget(page.cards[id]);
    // Typed in two sections, saved in one.
    page.cards[ALPHA].element('api_base').value = 'https://typed-in-alpha.example/osdm';
    page.cards[ALPHA].element('access_token').value = 'alpha-secret';
    page.cards[BETA].element('api_base').value = 'https://typed-in-beta.example/osdm';
    page.cards[BETA].element('access_token').value = 'beta-secret';
    page.calls.length = 0;

    await page.context.saveTarget(page.cards[BETA]);

    expect(page.calls.every(c => c.target === BETA)).toBe(true);
    const written = page.calls.filter(c => c.method === 'PATCH').map(c => c.body);
    expect(written).toEqual([
      { api_base: 'https://typed-in-beta.example/osdm', extra_headers: [{ name: 'X-Section', value: BETA }] },
      { auth_mode: 'bearer', access_token: 'beta-secret' },
    ]);
    expect(JSON.stringify(written)).not.toMatch(/alpha/);
    // What was typed in the other section is still there, and still not saved.
    expect(page.cards[ALPHA].element('api_base').value).toBe('https://typed-in-alpha.example/osdm');
    expect(page.cards[ALPHA].element('access_token').value).toBe('alpha-secret');
    // The saved section was read again: its secret field is empty.
    expect(page.cards[BETA].element('access_token').value).toBe('');
    expect(page.messages).toEqual([{ target: BETA, text: 'Configuration saved for Beta.', ok: true }]);
  });

  test('OAuth2: what was typed is sent, a secret left blank is not, scope and template always are', async () => {
    const page = openPage('company_user');
    const card = page.cards[BETA];
    await page.context.loadTarget(card);
    const type = (name, value) => { card.element(name).value = value; };
    type('auth_mode', 'oauth2');
    type('oauth_profile', 'oauth2_post');
    type('token_url', '  https://beta.example/oauth/token ');
    type('client_id', ' beta-client ');
    type('client_secret', '');                 // blank: the stored secret is kept
    type('oauth_scope', '');                   // blank: sent, so that it can be cleared
    type('oauth_custom_template', '');
    type('oauth_extra', '');
    type('access_token', 'a bearer token typed before switching mode');
    type('requestor', ' req-1 ');
    type('subscription_key', '');
    page.calls.length = 0;

    await page.context.saveTarget(card);

    const patch = page.calls.filter(c => c.method === 'PATCH');
    expect(patch.map(c => `${c.url} @${c.target}`)).toEqual([`/v1/me/credentials @${BETA}`]);
    expect(patch[0].body).toEqual({
      auth_mode: 'oauth2',
      oauth_profile: 'oauth2_post',
      oauth_scope: '',
      oauth_custom_template: '',
      token_url: 'https://beta.example/oauth/token',
      client_id: 'beta-client',
      requestor: 'req-1',
    });
  });

  test('a duplicate endpoint is confirmed before it is sent again, and a refusal to confirm stops the save', async () => {
    const duplicate = { status: 409, title: 'Conflict', detail: 'Alpha already uses this endpoint. Send allow_duplicate_endpoint: true to use it anyway.' };
    const open = (answer) => {
      const page = openPage('test_manager', { failing: c => (c.method === 'PATCH' && c.url === '/v1/company' && !c.body.allow_duplicate_endpoint ? 409 : 0) });
      const asked = [];
      page.context.confirm = (text) => { asked.push(text); return answer; };
      const realFetch = page.context.fetch;
      page.context.fetch = async (url, opts) => {
        const res = await realFetch(url, opts);
        return res.status === 409 ? { ...res, json: async () => duplicate } : res;
      };
      return { page, asked };
    };

    const yes = open(true);
    await yes.page.context.loadTarget(yes.page.cards[BETA]);
    yes.page.calls.length = 0;
    await yes.page.context.saveTarget(yes.page.cards[BETA]);
    expect(yes.asked).toEqual(['Alpha already uses this endpoint.\n\nUse this endpoint anyway?']);
    const patches = yes.page.calls.filter(c => c.method === 'PATCH');
    expect(patches.map(c => `${c.url} @${c.target}`)).toEqual([`/v1/company @${BETA}`, `/v1/company @${BETA}`, `/v1/me/credentials @${BETA}`]);
    expect(patches[1].body.allow_duplicate_endpoint).toBe(true);

    const no = open(false);
    await no.page.context.loadTarget(no.page.cards[BETA]);
    no.page.calls.length = 0;
    await no.page.context.saveTarget(no.page.cards[BETA]);
    expect(no.page.calls.filter(c => c.method === 'PATCH').map(c => c.url)).toEqual(['/v1/company']);
    expect(no.page.messages).toEqual([]);
  });

  test('a save the server refuses is reported in its own section and stops there', async () => {
    const page = openPage('test_manager', { failing: c => (c.method === 'PATCH' && c.url === '/v1/company' ? 400 : 0) });
    const card = page.cards[BETA];
    await page.context.loadTarget(card);
    card.element('access_token').value = 'beta-secret';
    page.calls.length = 0;

    await page.context.saveTarget(card);

    expect(sent(page)).toEqual([`PATCH /v1/company @${BETA}`]);
    expect(page.messages).toEqual([{ target: BETA, text: 'Saving the shared settings failed.', ok: false }]);
    expect(card.element('access_token').value).toBe('beta-secret');
  });

  test('every section says what its credentials are for, the company\'s own included', async () => {
    const page = openPage('company_user');
    for (const id of [OWN, BETA]) {
      const card = page.cards[id];
      await page.context.loadTarget(card);
      expect(card.element('name').textContent).toBe(NAMES[id]);
      expect(card.element('name-2').textContent).toBe(NAMES[id]);
      expect(card.element('save-btn').textContent).toBe(`💾 Save configuration for ${NAMES[id]}`);
      expect(card.element('clear-creds-btn').textContent).toBe(`🗑 Clear my credentials for ${NAMES[id]}`);
    }
    expect(page.cards[OWN].element('kind').textContent).toBe('your company');
    expect(page.cards[BETA].element('kind').textContent).toBe('provider');
    expect(SOURCE.some(l => l.includes('Your Credentials for <span data-f="name-2">'))).toBe(true);
  });

  test('clearing asks first, names the section, and clears only there', async () => {
    const page = openPage('company_user');
    const asked = [];
    page.context.confirm = (text) => { asked.push(text); return asked.length > 1; };
    const card = page.cards[ALPHA];
    await page.context.loadTarget(card);
    page.calls.length = 0;

    await page.context.clearCredentials(card);            // declined
    expect(page.calls).toEqual([]);
    await page.context.clearCredentials(card);            // confirmed

    expect(asked[0]).toMatch(/^Wipe your stored credentials for Alpha\?/);
    expect(asked[0]).toMatch(/any other company or provider are not touched/);
    const patch = page.calls.filter(c => c.method === 'PATCH');
    expect(patch.map(c => `${c.url} @${c.target}`)).toEqual([`/v1/me/credentials @${ALPHA}`]);
    expect(Object.values(patch[0].body).every(v => v === null)).toBe(true);
    expect(page.messages.at(-1)).toEqual({ target: ALPHA, text: 'Your credentials for Alpha were cleared.', ok: true });
  });

  test('a section that cannot be read says so and loses its buttons', async () => {
    const gone = openPage('company_user', { failing: c => (c.target === BETA ? 404 : 0) });
    await gone.context.loadTarget(gone.cards[BETA]);
    expect(gone.cards[BETA].element('notice-unavailable').textContent).toMatch(/no longer available to you/);
    expect(gone.cards[BETA].element('notice-unavailable').style.display).toBe('block');
    expect(gone.cards[BETA].element('save-btn').disabled).toBe(true);
    expect(gone.cards[BETA].element('clear-creds-btn').disabled).toBe(true);

    const failed = openPage('company_user', { failing: c => (c.target === BETA ? 500 : 0) });
    await failed.context.loadTarget(failed.cards[BETA]);
    expect(failed.cards[BETA].element('notice-unavailable').textContent).toMatch(/could not be loaded/);
    // The other sections are not affected.
    await failed.context.loadTarget(failed.cards[ALPHA]);
    expect(failed.cards[ALPHA].element('save-btn').disabled).toBe(false);
  });

  test('"credentials set" means what a run needs, as POST /v1/runs checks it', () => {
    const { credentialsSet } = openPage('company_user').context;
    expect(credentialsSet({ auth_mode: 'bearer', has_token: true })).toBe(true);
    expect(credentialsSet({ auth_mode: 'bearer', has_token: false, has_client_id: true, has_client_secret: true, token_url: 'https://t' })).toBe(false);
    expect(credentialsSet({ auth_mode: 'oauth2', token_url: 'https://t', has_client_id: true, has_client_secret: true })).toBe(true);
    expect(credentialsSet({ auth_mode: 'oauth2', token_url: null, has_client_id: true, has_client_secret: true })).toBe(false);
    expect(credentialsSet({ auth_mode: 'oauth2', token_url: 'https://t', has_client_id: true, has_client_secret: false })).toBe(false);
    expect(credentialsSet({ auth_mode: 'oauth2', token_url: 'https://t', has_token: true })).toBe(false);
  });

  test('a section is marked "not saved" on its own, and the mark goes when it is read again', async () => {
    const page = openPage('test_manager');
    const { markUnsaved } = page.context;
    for (const id of [ALPHA, BETA]) await page.context.loadTarget(page.cards[id]);
    markUnsaved(page.cards[ALPHA], true);
    expect(page.cards[ALPHA].dataset.unsaved).toBe('1');
    expect(page.cards[ALPHA].element('unsaved').style.display).toBe('inline');
    expect(page.cards[BETA].dataset.unsaved).toBe('');
    await page.context.saveTarget(page.cards[ALPHA]);
    expect(page.cards[ALPHA].dataset.unsaved).toBe('');
    expect(page.cards[ALPHA].element('unsaved').style.display).toBe('none');
  });

  describe('the section template is copied once per company or provider', () => {
    const from = SOURCE.findIndex(l => l.includes('<template id="target-template">'));
    const to = SOURCE.findIndex((l, i) => i > from && l.includes('</template>'));
    const template = SOURCE.slice(from + 1, to).join('\n');
    const script = SOURCE.slice(to).join('\n');

    test('every id in it is a labelled field, named like its data-f: the ones addTarget() makes unique', () => {
      expect(from).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      const ids = [...template.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
      const labelled = [...template.matchAll(/<label for="([^"]+)"/g)].map(m => m[1]);
      expect(ids).toHaveLength(12);
      // An id without a label would be copied as it is, and exist once per section.
      expect([...ids].sort()).toEqual([...labelled].sort());
      for (const id of ids) expect(template).toContain(` id="${id}" data-f="${id}"`);
    });

    test('a copy gets its own ids before it enters the page', () => {
      const addTarget = sourceOf('addTarget');
      const rewritten = addTarget.indexOf("input.id = label.htmlFor + '-' + index;");
      const inserted = addTarget.indexOf("document.getElementById('targets').appendChild(card);");
      expect(rewritten).toBeGreaterThan(-1);
      expect(inserted).toBeGreaterThan(rewritten);
      expect(addTarget).toContain("card.querySelectorAll('label[for]').forEach(label => {");
      expect(addTarget).toContain('label.htmlFor = input.id;');
    });

    test('the script finds a field inside its section, never by id across the page', () => {
      const byId = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
      expect([...new Set(byId)].sort()).toEqual(['msg', 'page-hint', 'providers-link', 'target-template', 'targets', 'targets-summary', 'targets-summary-rows']);
      expect(script).not.toMatch(/querySelector\('#/);
    });
  });
});
