'use strict';

/**
 * bruno-standalone-token.test.js — a standalone run renews its own token when
 * it names its token endpoint (#914): the simulator replay's long waits
 * outlive beta's two-minute tokens.
 */

const env = {};
const sent = [];
let answer = { status: 200, data: { access_token: 'fresh-token' } };
global.bru = {
  getEnvVar: (k) => env[k],
  setEnvVar: (k, v) => { env[k] = v; },
  sendRequest: (req, cb) => { sent.push(req); cb(null, answer); },
};
const logs = [];
// validationLogger (displays.js) writes with console.log.
jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
const { refreshAccessTokenIfNeeded } = require('../../../Bruno_Collection/library-bruno/auth.js');

beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  sent.length = 0;
  logs.length = 0;
  answer = { status: 200, data: { access_token: 'fresh-token' } };
  Object.assign(env, { client_id: 'beta.tst01', client_secret: 's&cret', access_token: 'old-token' });
});

test('without a token endpoint, a standalone run keeps its token, as before', async () => {
  expect(await refreshAccessTokenIfNeeded({ callerLabel: 'x' })).toBe(false);
  expect(sent).toHaveLength(0);
  expect(env.access_token).toBe('old-token');
});

test('with one, it asks a new token by client credentials, at most once a minute', async () => {
  env.standalone_token_url = 'http://127.0.0.1:3002/beta/oauth/token';
  expect(await refreshAccessTokenIfNeeded({ callerLabel: 'x' })).toBe(true);
  expect(env.access_token).toBe('fresh-token');
  expect(sent[0]).toMatchObject({ url: env.standalone_token_url, method: 'POST' });
  expect(sent[0].data).toBe('grant_type=client_credentials&client_id=beta.tst01&client_secret=s%26cret');
  expect(await refreshAccessTokenIfNeeded({ callerLabel: 'x' })).toBe(false);
  expect(sent).toHaveLength(1);
  expect(logs.join('\n')).not.toContain('fresh-token');
});

test('a refusal keeps the token and says so, without the secret', async () => {
  env.standalone_token_url = 'http://127.0.0.1:3002/beta/oauth/token';
  answer = { status: 401, data: { error: 'invalid_client' } };
  expect(await refreshAccessTokenIfNeeded({ callerLabel: '14b' })).toBe(false);
  expect(env.access_token).toBe('old-token');
  expect(logs.join('\n')).toMatch(/standalone token renewal before 14b answered 401/);
  expect(logs.join('\n')).not.toContain('s&cret');
});

test('under OSCAR (a run id), the OSCAR route is used, never the standalone one', async () => {
  env.standalone_token_url = 'http://127.0.0.1:3002/beta/oauth/token';
  env.__runId = 'r1';
  answer = { status: 200, body: JSON.stringify({ access_token: 'from-oscar' }) };
  await refreshAccessTokenIfNeeded({ callerLabel: 'x' });
  expect(sent[0].url).toContain('/v1/runs/r1/refresh-access-token');
});
