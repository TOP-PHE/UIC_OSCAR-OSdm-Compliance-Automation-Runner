// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * accounts.js — the providers' client accounts, kept in a file the simulator
 * writes (#930).
 *
 * With a data folder (`SIM_DATA_DIR`), the accounts are in
 * `<data>/accounts.json` and an administrator changes them while the
 * simulator runs: a new account, a deleted one or a new secret takes effect at
 * once, and the bookings and tokens of the other accounts stay. On the first
 * start the file does not exist yet and is made from the clients file.
 *
 * The file holds the SHA-256 of each secret, never the secret: a new secret is
 * answered once, to whoever asked for it, and is then nowhere. The digests are
 * the same as the clients file's (`config.js`), so the token endpoint and the
 * Bearer check read `clients` as before; this module changes that Map in
 * place.
 *
 * Every change is a line of `<data>/audit.log`: when, who, what, never a
 * secret.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError, CLIENT_ID, clientsOf, readJson } = require('./config');

const FORMAT = 1;
const MAX_ACCOUNTS_PER_PROVIDER = 500;
const ACCOUNTS_FILE = 'accounts.json';
const AUDIT_FILE = 'audit.log';
// The audit is read from its end: the last 256 kB hold far more lines than a page shows.
const AUDIT_TAIL_BYTES = 256 * 1024;
// The kinds of account the naming of make-clients.js knows (#585).
const KINDS = new Set(['tst', 'tstmgr']);

class AccountError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();
const newSecret = () => crypto.randomBytes(32).toString('hex');
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isTime = (v) => Number.isInteger(v) && v >= 0;

// Write a file so that a reader sees the old content or the new, never half.
function writeAtomically(file, text) {
  const temp = `${file}.tmp.${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* the error that matters is the one thrown below */ }
    throw error;
  }
}

// The accounts file, checked entry by entry: a file that is wrong stops the
// start, as a wrong clients file does.
function readAccountsFile(file, providers) {
  const raw = readJson(file, 'the accounts file');
  if (!raw || raw.format !== FORMAT || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
    throw new ConfigError(`the accounts file is not an accounts file of format ${FORMAT} (${file})`);
  }
  const accounts = new Map();
  for (const [key, list] of Object.entries(raw.providers)) {
    if (!providers.has(key)) throw new ConfigError(`the accounts file names an unknown provider: "${key}"`);
    if (!Array.isArray(list)) throw new ConfigError(`accounts of "${key}": must be a list`);
    const byId = new Map();
    for (const entry of list) {
      const ok = entry && typeof entry.clientId === 'string' && CLIENT_ID.test(entry.clientId)
        && typeof entry.secretSha256 === 'string' && SHA256_HEX.test(entry.secretSha256)
        && isTime(entry.createdAt);
      if (!ok) throw new ConfigError(`accounts of "${key}": an entry is missing a member or holds one that is not valid`);
      if (byId.has(entry.clientId)) throw new ConfigError(`accounts of "${key}": client_id "${entry.clientId}" appears twice`);
      byId.set(entry.clientId, { digest: Buffer.from(entry.secretSha256, 'hex'), createdAt: entry.createdAt });
    }
    accounts.set(key, byId);
  }
  return accounts;
}

// The accounts of a clients file, for the first start with a data folder.
function importClientsFile(file, providers, at) {
  const raw = readJson(file, 'the clients file');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('the clients file must be an object keyed by provider');
  const accounts = new Map();
  for (const [key, list] of Object.entries(raw)) {
    if (!providers.has(key)) throw new ConfigError(`the clients file names an unknown provider: "${key}"`);
    const byId = new Map();
    for (const [id, d] of clientsOf(key, list)) byId.set(id, { digest: d, createdAt: at });
    accounts.set(key, byId);
  }
  return accounts;
}

/**
 * The accounts of a data folder. `clientsFile` is read only when the folder
 * holds no accounts file yet; it may be missing then, and the simulator starts
 * with no account (an administrator adds them).
 */
function createAccounts({ dataDir, providers, clientsFile, now = Date.now, log = () => {} }) {
  try {
    fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new ConfigError(error.code === 'ENOENT'
      ? `the data folder does not exist (${dataDir})`
      : `the data folder cannot be written by this user (${dataDir}): ${error.code}`);
  }
  const file = path.join(dataDir, ACCOUNTS_FILE);
  const auditFile = path.join(dataDir, AUDIT_FILE);
  // Per provider: client_id → { digest, createdAt }.
  let accounts;
  let imported = null;
  if (fs.existsSync(file)) {
    accounts = readAccountsFile(file, providers);
  } else if (clientsFile && fs.existsSync(clientsFile)) {
    accounts = importClientsFile(clientsFile, providers, now());
    imported = [...accounts.values()].reduce((n, byId) => n + byId.size, 0);
  } else {
    accounts = new Map();
  }
  // Since the start: when each account last received a token. Not stored, so
  // that a token request costs no write.
  const lastToken = new Map();

  // What the token endpoint and the Bearer check read (config.js): provider →
  // client_id → digest. Kept in step with `accounts`, the same Map object for
  // the life of the process.
  const clients = new Map();
  function syncClients(key) {
    const byId = accounts.get(key);
    if (!byId || byId.size === 0) {
      clients.delete(key);
      return;
    }
    clients.set(key, new Map([...byId].map(([id, a]) => [id, a.digest])));
  }

  function serialise(state) {
    const out = {};
    for (const [key, byId] of [...state].sort(([a], [b]) => a.localeCompare(b))) {
      out[key] = [...byId].map(([clientId, a]) => ({
        clientId, secretSha256: a.digest.toString('hex'), createdAt: a.createdAt,
      }));
    }
    return `${JSON.stringify({ format: FORMAT, providers: out }, null, 2)}\n`;
  }

  // A change is written first, then applied: a write that fails changes nothing.
  function commit(key, byId) {
    const next = new Map(accounts);
    next.set(key, byId);
    writeAtomically(file, serialise(next));
    accounts = next;
    syncClients(key);
  }

  function audit(entry) {
    const line = JSON.stringify({ at: new Date(now()).toISOString(), ...entry });
    try {
      fs.appendFileSync(auditFile, `${line}\n`, { mode: 0o600 });
    } catch (error) {
      // The change is made; the audit line is lost, and the log says so.
      log({ auditError: error.code || error.message });
    }
  }

  function providerOf(key) {
    if (typeof key !== 'string' || !providers.has(key)) throw new AccountError(404, 'UNKNOWN_PROVIDER', 'No such provider.');
    return accounts.get(key) || new Map();
  }

  function accountOf(key, clientId) {
    const byId = providerOf(key);
    if (typeof clientId !== 'string' || !byId.has(clientId)) throw new AccountError(404, 'UNKNOWN_ACCOUNT', 'No such account.');
    return byId;
  }

  // The next free "<provider>.<kind>NN", in the naming of make-clients.js.
  function nextId(key, kind, byId) {
    for (let n = 1; n <= MAX_ACCOUNTS_PER_PROVIDER; n += 1) {
      const id = `${key}.${kind}${String(n).padStart(2, '0')}`;
      if (!byId.has(id)) return id;
    }
    throw new AccountError(409, 'TOO_MANY_ACCOUNTS', 'No free account name is left for this provider.');
  }

  /** Every provider with its accounts, sorted by client id. No secret, no digest. */
  function list() {
    return [...providers.values()].map((p) => ({
      provider: p.key,
      name: p.name,
      osdmVersion: p.osdmVersion,
      accounts: [...(accounts.get(p.key) || new Map())]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([clientId, a]) => ({
          clientId,
          createdAt: new Date(a.createdAt).toISOString(),
          lastTokenAt: lastToken.has(`${p.key}\n${clientId}`) ? new Date(lastToken.get(`${p.key}\n${clientId}`)).toISOString() : null,
        })),
    }));
  }

  /**
   * A new account: the id given, or the next free one of its kind. Returns its
   * id and its secret, the only time the secret is seen.
   */
  function add(key, { clientId, kind } = {}, by = 'system') {
    const byId = providerOf(key);
    if (byId.size >= MAX_ACCOUNTS_PER_PROVIDER) throw new AccountError(409, 'TOO_MANY_ACCOUNTS', `A provider holds at most ${MAX_ACCOUNTS_PER_PROVIDER} accounts.`);
    let id = clientId;
    if (id === undefined || id === '') {
      const k = kind === undefined ? 'tst' : kind;
      if (!KINDS.has(k)) throw new AccountError(400, 'INVALID_KIND', 'The kind of account is "tst" or "tstmgr".');
      id = nextId(key, k, byId);
    } else if (typeof id !== 'string' || !CLIENT_ID.test(id)) {
      throw new AccountError(400, 'INVALID_CLIENT_ID', 'A client id is 3 to 64 printable characters, without a colon or a space.');
    } else if (byId.has(id)) {
      throw new AccountError(409, 'ACCOUNT_EXISTS', 'This provider already has an account with this id.');
    }
    const secret = newSecret();
    const at = now();
    const next = new Map(byId);
    next.set(id, { digest: digest(secret), createdAt: at });
    commit(key, next);
    audit({ by, action: 'account_added', provider: key, clientId: id });
    return { provider: key, clientId: id, clientSecret: secret };
  }

  /** Delete an account: its tokens are refused from now on, even if the id comes back. */
  function remove(key, clientId, by = 'system') {
    const next = new Map(accountOf(key, clientId));
    next.delete(clientId);
    commit(key, next);
    lastToken.delete(`${key}\n${clientId}`);
    audit({ by, action: 'account_deleted', provider: key, clientId });
  }

  /** A new secret: the old one and every token issued before stop working. */
  function resetSecret(key, clientId, by = 'system') {
    const byId = accountOf(key, clientId);
    const secret = newSecret();
    const next = new Map(byId);
    next.set(clientId, { ...byId.get(clientId), digest: digest(secret) });
    commit(key, next);
    audit({ by, action: 'secret_reset', provider: key, clientId });
    return { provider: key, clientId, clientSecret: secret };
  }

  /**
   * The tag a token carries of the secret it was asked with: 16 hex
   * characters of the secret's digest, which tell secrets apart and say
   * nothing usable about them.
   */
  function secretTag(key, clientId) {
    const account = accounts.get(key)?.get(clientId);
    return account ? account.digest.toString('hex').slice(0, 16) : '';
  }

  /** Was a token with this tag asked with the account's current secret? */
  function tokenAccepted(key, clientId, tag) {
    const current = secretTag(key, clientId);
    return current !== '' && typeof tag === 'string' && tag === current;
  }

  function noteToken(key, clientId) {
    lastToken.set(`${key}\n${clientId}`, now());
  }

  /** The last `limit` audit lines, newest first. */
  function auditTail(limit = 200) {
    let text;
    try {
      const fd = fs.openSync(auditFile, 'r');
      try {
        const { size } = fs.fstatSync(fd);
        const length = Math.min(size, AUDIT_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        text = buffer.toString('utf8');
        // A tail that starts inside a line drops that line.
        if (length < size) text = text.slice(text.indexOf('\n') + 1);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const line of text.split('\n').reverse()) {
      if (entries.length >= limit) break;
      if (!line) continue;
      try { entries.push(JSON.parse(line)); } catch { /* a line cut by a crash is left out */ }
    }
    return entries;
  }

  for (const key of accounts.keys()) syncClients(key);
  if (imported !== null) {
    writeAtomically(file, serialise(accounts));
    audit({ by: 'system', action: 'imported_clients_file', count: imported });
  }

  const count = () => [...accounts.values()].reduce((n, byId) => n + byId.size, 0);
  return { clients, list, add, remove, resetSecret, secretTag, tokenAccepted, noteToken, auditTail, count, imported, audit };
}

module.exports = { createAccounts, AccountError, writeAtomically, MAX_ACCOUNTS_PER_PROVIDER, ACCOUNTS_FILE, AUDIT_FILE };
