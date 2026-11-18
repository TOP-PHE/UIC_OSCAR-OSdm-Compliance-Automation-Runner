'use strict';

/**
 * bruno-token-renewal.test.js — a run renews its token before it expires
 * (#1327). OSCAR's refresh answers how long the token has left (`expires_in`);
 * the collection's before-request renews once that time, less a margin, has
 * passed, and makes no call before.
 */

const fs = require('node:fs');
const path = require('node:path');

const env = {};
const sent = [];
let answers = [];
global.bru = {
  getEnvVar: (k) => env[k],
  setEnvVar: (k, v) => { env[k] = v; },
  deleteEnvVar: (k) => { delete env[k]; },
  getProcessEnv: () => undefined,
  sendRequest: (req, cb) => { sent.push(req); cb(null, answers.shift()); },
};
const logs = [];
// validationLogger (displays.js) writes with console.log.
jest.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
const A = require('../../../Bruno_Collection/library-bruno/auth.js');

const oscarAnswer = (body) => ({ status: 200, body: JSON.stringify(body) });

let clock = 1_800_000_000_000;
jest.spyOn(Date, 'now').mockImplementation(() => clock);
beforeEach(() => {
  for (const k of Object.keys(env)) delete env[k];
  sent.length = 0;
  logs.length = 0;
  answers = [];
  clock = 1_800_000_000_000;
  Object.assign(env, { __runId: 'r1', access_token: 'old-token' });
});

describe('when to renew', () => {
  test('expires_in less the margin, never sooner than the gap; none without expires_in', () => {
    expect(A.RENEW_MARGIN_S).toBeLessThan(60);                 // OSCAR's cache gives a new token below 60 s
    expect(A.renewalTime(120, 0)).toBe((120 - A.RENEW_MARGIN_S) * 1000);
    expect(A.renewalTime(3600, 5)).toBe(5 + (3600 - A.RENEW_MARGIN_S) * 1000);
    expect(A.renewalTime(30, 0)).toBe(A.MIN_RENEWAL_GAP_S * 1000);
    expect(A.renewalTime(0, 0)).toBe(A.MIN_RENEWAL_GAP_S * 1000);
    for (const none of [undefined, null, '', 'soon', Number.NaN]) expect(A.renewalTime(none, 0)).toBeNull();
  });
});

describe('the renewal at step 01 keeps the time', () => {
  test('OSCAR names expires_in: the time is kept', async () => {
    answers = [oscarAnswer({ access_token: 'new-token', forced: false, expires_in: 120 })];
    expect(await A.refreshAccessTokenIfNeeded({ callerLabel: '01' })).toBe(true);
    expect(env.access_token).toBe('new-token');
    expect(env[A.RENEW_AFTER_VAR]).toBe(String(clock + (120 - A.RENEW_MARGIN_S) * 1000));
  });

  test('a static token (no expires_in): no time, so never renewed by time', async () => {
    env[A.RENEW_AFTER_VAR] = '1';
    answers = [oscarAnswer({ access_token: 'static', forced: false })];
    await A.refreshAccessTokenIfNeeded({ callerLabel: '01' });
    expect(env).not.toHaveProperty(A.RENEW_AFTER_VAR);
    clock += 3600 * 1000;
    expect(await A.renewTokenWhenDue('13. PATCH Refund Offer')).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

describe('before each request', () => {
  test('no call before the time; one once it has passed, and the new time kept', async () => {
    answers = [oscarAnswer({ access_token: 't1', expires_in: 120 })];
    await A.refreshAccessTokenIfNeeded({ callerLabel: '01' });
    clock += 60 * 1000;
    expect(await A.renewTokenWhenDue('07. GET Booking')).toBe(false);
    expect(sent).toHaveLength(1);
    clock += 10 * 1000;                                         // 70 s after 01: past 120 - 55
    answers = [oscarAnswer({ access_token: 't2', expires_in: 120 })];
    expect(await A.renewTokenWhenDue('13. PATCH Refund Offer')).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1].url).toContain('/v1/runs/r1/refresh-access-token');
    expect(sent[1].url).not.toContain('force');
    expect(env.access_token).toBe('t2');
    expect(env[A.RENEW_AFTER_VAR]).toBe(String(clock + (120 - A.RENEW_MARGIN_S) * 1000));
  });

  test('a renewal that fails is tried again 10 s later at the soonest, not before each request', async () => {
    env[A.RENEW_AFTER_VAR] = String(clock - 1);
    answers = [{ status: 502, body: JSON.stringify({ detail: 'down' }) }];
    expect(await A.renewTokenWhenDue('13')).toBe(false);
    expect(env.access_token).toBe('old-token');
    expect(await A.renewTokenWhenDue('14')).toBe(false);
    expect(sent).toHaveLength(1);
    clock += A.MIN_RENEWAL_GAP_S * 1000;
    answers = [oscarAnswer({ access_token: 't3', expires_in: 120 })];
    expect(await A.renewTokenWhenDue('15')).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test('a token is never written to the log', async () => {
    env[A.RENEW_AFTER_VAR] = String(clock - 1);
    answers = [oscarAnswer({ access_token: 'secret-token-value', expires_in: 120 })];
    await A.renewTokenWhenDue('13');
    expect(logs.join('\n')).not.toContain('secret-token-value');
  });
});

// The runner writes the first token's expiry; it holds until a renewal, so a
// run that waits before step 01 renews that token too (a k3s restart froze
// every run for 2 min and one was refused at step 09).
describe('the run\'s first token, before step 01', () => {
  test('renewed once its expiry, less the margin, has passed; then the answer\'s time holds', async () => {
    env[A.FIRST_EXPIRY_VAR] = String(clock + 90 * 1000);
    expect(await A.renewTokenWhenDue('05. GET Promotion Codes')).toBe(false);
    expect(sent).toHaveLength(0);
    clock += (90 - A.RENEW_MARGIN_S) * 1000;
    answers = [oscarAnswer({ access_token: 'renewed', expires_in: 300 })];
    expect(await A.renewTokenWhenDue('09. GET Product By ProductId')).toBe(true);
    expect(env.access_token).toBe('renewed');
    expect(env).not.toHaveProperty(A.FIRST_EXPIRY_VAR);
    expect(env[A.RENEW_AFTER_VAR]).toBe(String(clock + (300 - A.RENEW_MARGIN_S) * 1000));
  });

  test('step 01\'s renewal replaces it', async () => {
    env[A.FIRST_EXPIRY_VAR] = String(clock + 70 * 1000);
    answers = [oscarAnswer({ access_token: 't01', expires_in: 120 })];
    await A.refreshAccessTokenIfNeeded({ callerLabel: '01' });
    expect(env).not.toHaveProperty(A.FIRST_EXPIRY_VAR);
    clock += 30 * 1000;                                         // past the first token's time, not the new one's
    expect(await A.renewTokenWhenDue('02')).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test('a renewal that fails keeps trying 10 s apart, not before each request', async () => {
    env[A.FIRST_EXPIRY_VAR] = String(clock + 10 * 1000);
    answers = [{ status: 502, body: '{}' }];
    expect(await A.renewTokenWhenDue('03')).toBe(false);
    expect(await A.renewTokenWhenDue('04')).toBe(false);
    expect(sent).toHaveLength(1);
  });
});

test('the collection\'s before-request renews when due, after the run filter, for every request', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'Bruno_Collection', 'opencollection.yml'), 'utf8');
  const normal = yml.indexOf('── 2. Normal before-request');
  const call = yml.indexOf('await renewTokenWhenDue(');
  expect(normal).toBeGreaterThan(0);
  expect(call).toBeGreaterThan(normal);
  expect(yml.indexOf('renewTokenWhenDue', call + 'await renewTokenWhenDue('.length)).toBe(-1);    // once
});
