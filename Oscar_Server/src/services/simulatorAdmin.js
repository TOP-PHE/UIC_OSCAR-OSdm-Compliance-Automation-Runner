// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulatorAdmin.js — OSCAR's side of the simulator's administration API
 * (#930, PR 2).
 *
 * OSCAR's administrators manage the OSDM simulator's accounts from OSCAR. The
 * simulator's address and its administration key are kept in `server_config`
 * (the key encrypted with ENCRYPTION_KEY, never returned), and this module is
 * the one place OSCAR calls the simulator: through urlPolicy.js, with
 * `redirect: 'manual'`, 15 s, a 256 KB answer at most. The key is sent to
 * the address it was saved with and to no other (`keyRefusal()`), and is
 * masked in any text that could carry it back.
 *
 * Every call names the OSCAR administrator who asked (`X-Admin-Actor`), which
 * the simulator keeps in its audit.
 */

const { get, run, encrypt, decrypt } = require('../db/db');
const { usableUrlRefusal } = require('../utils/urlPolicy');

const URL_KEY = 'SIMULATOR_ADMIN_URL';
const KEY_KEY = 'SIMULATOR_ADMIN_KEY_ENC';
// The address the stored key was saved with: it goes there and nowhere else.
const KEY_URL_KEY = 'SIMULATOR_ADMIN_KEY_URL';
// An address and key being tried, before they are saved. Every call reads its
// address and key from server_config, the ones being tried included.
const PENDING_URL_KEY = 'SIMULATOR_ADMIN_PENDING_URL';
const PENDING_KEY_KEY = 'SIMULATOR_ADMIN_PENDING_KEY_ENC';
const ALL_KEYS = [URL_KEY, KEY_KEY, KEY_URL_KEY, PENDING_URL_KEY, PENDING_KEY_KEY];
const TIMEOUT_MS = 15000;
const MAX_ANSWER_BYTES = 256 * 1024;
const MIN_KEY = 32;
const MAX_KEY = 512;

class SimulatorError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

const configValue = (key) => get('SELECT value FROM server_config WHERE key = ?', [key])?.value || '';

function setConfig(key, value, by) {
  run(
    `INSERT INTO server_config (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, value, by]
  );
}

/** The simulator's address as stored: no trailing slash, no query, no fragment. */
function normaliseUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 300) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** What the page may know of the set-up: the address, and whether a key is saved. */
function configView() {
  const url = configValue(URL_KEY);
  return { url: url || null, keySet: Boolean(configValue(KEY_KEY)) && configValue(KEY_URL_KEY) === url };
}

function storedKey(column = KEY_KEY) {
  const enc = configValue(column);
  if (!enc) return null;
  try { return decrypt(enc); } catch { return null; }
}

/** Why the stored key may not go to `url`, or null. */
function keyRefusal(url) {
  return configValue(KEY_URL_KEY) === url ? null : 'The saved key belongs to another address: enter the key again.';
}

const mask = (text, key) => (key ? String(text).split(key).join('<key>') : String(text));

// The answer, read up to the cap; the rest is not downloaded.
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_ANSWER_BYTES) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    const part = Buffer.from(value).subarray(0, MAX_ANSWER_BYTES - size);
    chunks.push(part);
    size += part.length;
  }
  await reader.cancel().catch(() => {});
  throw new SimulatorError(502, 'The simulator answered with more than 256 KB.');
}

function failureText(err) {
  if (err?.name === 'AbortError') return `The simulator did not answer within ${TIMEOUT_MS / 1000} s.`;
  const code = err?.cause?.code;
  if (typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code)) return `The simulator could not be reached (${code}).`;
  return 'The simulator could not be reached.';
}

// What a refusal of the simulator means for the administrator.
function refusalText(status, body) {
  if (status === 401) return 'The simulator refused the key: the key saved in OSCAR is not the one whose SHA-256 the simulator holds.';
  if (status === 404 && body?.code === 'NOT_FOUND') return 'The simulator has no administration API at this address: check the address, its data folder and its key (SIM_ADMIN_KEY_SHA256).';
  if (status === 429) return 'The simulator refuses this server for 15 minutes after 10 wrong keys.';
  const said = typeof body?.detail === 'string' ? body.detail : (typeof body?.title === 'string' ? body.title : '');
  return said ? `The simulator answered ${status}: ${said.slice(0, 300)}` : `The simulator answered ${status}.`;
}

/**
 * One call to the simulator's administration API. Returns { status, body }
 * for a 2xx answer, or throws a SimulatorError whose status is the one OSCAR
 * answers with (the simulator's own 4xx, else 502).
 */
// The address and key a call uses: the saved ones, or (`pending`) the ones being tried.
function target(pending) {
  if (pending) return { url: configValue(PENDING_URL_KEY), secret: storedKey(PENDING_KEY_KEY) };
  const url = configValue(URL_KEY);
  if (!url) throw new SimulatorError(409, 'No simulator is set up yet: enter its address and key first.');
  const refused = keyRefusal(url);
  if (refused) throw new SimulatorError(409, refused);
  const secret = storedKey();
  if (!secret) throw new SimulatorError(409, 'No key is saved for the simulator: enter it first.');
  return { url, secret };
}

async function call({ method, path, body, actor, pending = false }) {
  const { url, secret } = target(pending);
  const address = `${url}/admin/api/${path}`;
  const refusal = await usableUrlRefusal(address, 'simulator address');
  if (refusal) throw new SimulatorError(422, refusal);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(address, {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        'X-Admin-Actor': actor,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: controller.signal,
    });
    text = await readCapped(res);
  } catch (err) {
    if (err instanceof SimulatorError) throw err;
    throw new SimulatorError(502, failureText(err));
  } finally {
    clearTimeout(timer);
  }
  let parsed;
  try { parsed = text ? JSON.parse(mask(text, secret)) : undefined; } catch { parsed = undefined; }
  if (res.status >= 300 && res.status < 400) throw new SimulatorError(502, 'The simulator answered with a redirect, which OSCAR does not follow.');
  if (res.status < 200 || res.status >= 300) {
    const status = [400, 404, 409].includes(res.status) && parsed?.code !== 'NOT_FOUND' ? res.status : 502;
    throw new SimulatorError(status, mask(refusalText(res.status, parsed), secret));
  }
  if (parsed === undefined || parsed === null || typeof parsed !== 'object') throw new SimulatorError(502, 'The simulator answered with something that is not JSON.');
  return { status: res.status, body: parsed };
}

/**
 * Save the simulator's address and key, after trying them: the list of
 * accounts must answer. No key = keep the saved one, for the same address only.
 */
async function saveConfig({ url: rawUrl, key: rawKey }, actor) {
  const url = normaliseUrl(rawUrl);
  if (!url) throw new SimulatorError(400, 'The address must be a plain URL, without user, query or fragment.');
  let key;
  if (rawKey === undefined || rawKey === null || rawKey === '') {
    const refused = keyRefusal(url);
    if (refused) throw new SimulatorError(400, refused);
    key = storedKey();
    if (!key) throw new SimulatorError(400, 'Enter the simulator\'s administration key.');
  } else {
    key = String(rawKey).trim();
    if (key.length < MIN_KEY || key.length > MAX_KEY || /\s/.test(key)) {
      throw new SimulatorError(400, `The key is ${MIN_KEY} to ${MAX_KEY} characters, without spaces.`);
    }
  }
  setConfig(PENDING_URL_KEY, url, actor);
  setConfig(PENDING_KEY_KEY, encrypt(key), actor);
  try {
    await call({ method: 'GET', path: 'accounts', actor, pending: true });
  } catch (err) {
    if (err instanceof SimulatorError) throw new SimulatorError(422, `Not saved: ${err.detail}`);
    throw err;
  } finally {
    run('DELETE FROM server_config WHERE key IN (?, ?)', [PENDING_URL_KEY, PENDING_KEY_KEY]);
  }
  setConfig(URL_KEY, url, actor);
  setConfig(KEY_KEY, encrypt(key), actor);
  setConfig(KEY_URL_KEY, url, actor);
  return configView();
}

function removeConfig() {
  run(`DELETE FROM server_config WHERE key IN (${ALL_KEYS.map(() => '?').join(', ')})`, ALL_KEYS);
}

module.exports = { call, saveConfig, removeConfig, configView, normaliseUrl, SimulatorError, URL_KEY, KEY_KEY, KEY_URL_KEY };
