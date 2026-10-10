// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * config.js — what the simulator reads when it starts.
 *
 * Two things: the provider profiles, which are in the repository, and the
 * clients file, which is not. Both are checked completely before the server
 * listens. A profile or a clients file that is wrong stops the start: there is
 * no default provider and no default credential.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_KEY = /^[a-z][a-z0-9-]{1,30}$/;
// Names the router keeps for itself; a provider cannot take them.
const RESERVED_KEYS = new Set(['healthz']);
const MIN_SECRET_LENGTH = 32;
// Printable ASCII without the colon: a client id travels in a Basic header as
// "id:secret", and a colon in it would shift the split.
const CLIENT_ID = /^[\x21-\x39\x3B-\x7E]{3,64}$/;
const OVERRULE_CODE = /^[A-Z][A-Z0-9_]{1,59}$/;
const MAX_OVERRULE_CODES = 30;

class ConfigError extends Error {}

const isText = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`${what} cannot be read (${file}): ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ConfigError(`${what} is not valid JSON (${file})`);
  }
}

function checkProvider(key, raw) {
  const bad = (field) => new ConfigError(`provider "${key}": "${field}" is missing or not valid`);
  if (!PROVIDER_KEY.test(key) || RESERVED_KEYS.has(key)) throw new ConfigError(`"${key}" is not a usable provider key`);
  if (!raw || typeof raw !== 'object') throw new ConfigError(`provider "${key}": the profile must be an object`);
  if (!isText(raw.name, 1, 80)) throw bad('name');
  if (!raw.carrier || !isText(raw.carrier.ref, 1, 80) || !isText(raw.carrier.name, 1, 80)) throw bad('carrier');
  if (!isText(raw.currency, 3, 3) || !/^[A-Z]{3}$/.test(raw.currency)) throw bad('currency');
  if (!Number.isFinite(raw.priceFactor) || raw.priceFactor <= 0 || raw.priceFactor > 100) throw bad('priceFactor');
  if (!isText(raw.osdmVersion, 1, 20)) throw bad('osdmVersion');
  if (!isText(raw.idPrefix, 1, 12) || !/^[A-Z0-9]+$/.test(raw.idPrefix)) throw bad('idPrefix');
  if (typeof raw.utcOffset !== 'string' || !/^[+-]\d{2}:\d{2}$/.test(raw.utcOffset)) throw bad('utcOffset');
  if (!Number.isInteger(raw.tokenLifetimeSeconds) || raw.tokenLifetimeSeconds < 30 || raw.tokenLifetimeSeconds > 86400) throw bad('tokenLifetimeSeconds');
  const overruleCodes = checkOverruleCodes(raw.overruleCodes, bad);
  return {
    key,
    name: raw.name,
    carrier: { ref: raw.carrier.ref, name: raw.carrier.name },
    currency: raw.currency,
    priceFactor: raw.priceFactor,
    osdmVersion: raw.osdmVersion,
    idPrefix: raw.idPrefix,
    utcOffset: raw.utcOffset,
    tokenLifetimeSeconds: raw.tokenLifetimeSeconds,
    ...(overruleCodes ? { overruleCodes } : {}),
  };
}

// The overrule codes a provider accepts in a refund request (#596). Absent:
// any code is accepted, as before.
function checkOverruleCodes(codes, bad) {
  if (codes === undefined) return null;
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_OVERRULE_CODES) throw bad('overruleCodes');
  if (!codes.every((c) => typeof c === 'string' && OVERRULE_CODE.test(c)) || new Set(codes).size !== codes.length) throw bad('overruleCodes');
  return [...codes];
}

/** Every `<key>.json` of the directory, as a Map key → profile. */
function loadProviders(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    throw new ConfigError(`the provider profiles cannot be read (${dir}): ${e.code || e.message}`);
  }
  if (names.length === 0) throw new ConfigError(`no provider profile in ${dir}`);
  const providers = new Map();
  const prefixes = new Set();
  for (const name of names) {
    const key = name.slice(0, -'.json'.length);
    const profile = checkProvider(key, readJson(path.join(dir, name), `the profile of provider "${key}"`));
    // The prefix is what tells providers apart in a report: two may not share one.
    if (prefixes.has(profile.idPrefix)) throw new ConfigError(`provider "${key}": idPrefix "${profile.idPrefix}" is already used`);
    prefixes.add(profile.idPrefix);
    providers.set(key, profile);
  }
  return providers;
}

const digest = (text) => crypto.createHash('sha256').update(text, 'utf8').digest();

// The clients of one provider, as a Map client_id → SHA-256 of the secret.
function clientsOf(key, list) {
  if (!Array.isArray(list)) throw new ConfigError(`clients of "${key}": must be a list`);
  const byId = new Map();
  for (const entry of list) {
    const id = entry?.client_id;
    const secret = entry?.client_secret;
    if (typeof id !== 'string' || !CLIENT_ID.test(id)) throw new ConfigError(`clients of "${key}": a client_id is missing or not valid`);
    if (byId.has(id)) throw new ConfigError(`clients of "${key}": client_id "${id}" appears twice`);
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
      throw new ConfigError(`clients of "${key}": the secret of "${id}" is shorter than ${MIN_SECRET_LENGTH} characters`);
    }
    if (/REPLACE|CHANGE|EXAMPLE/i.test(secret)) {
      throw new ConfigError(`clients of "${key}": the secret of "${id}" is the placeholder of the example file`);
    }
    byId.set(id, digest(secret));
  }
  return byId;
}

/**
 * The clients file: `{ "<provider>": [ { "client_id", "client_secret" } ] }`.
 * Returns a Map provider → Map client_id → SHA-256 of the secret. Only the
 * digests are kept in memory.
 */
function loadClients(file, providers) {
  const raw = readJson(file, 'the clients file');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('the clients file must be an object keyed by provider');
  const clients = new Map();
  let total = 0;
  for (const [key, list] of Object.entries(raw)) {
    if (!providers.has(key)) throw new ConfigError(`the clients file names an unknown provider: "${key}"`);
    const byId = clientsOf(key, list);
    clients.set(key, byId);
    total += byId.size;
  }
  if (total === 0) throw new ConfigError('the clients file defines no client');
  return clients;
}

/** Is this id and secret a client of this provider? Constant-time on the secret. */
function clientMatches(clients, providerKey, clientId, secret) {
  const byId = clients.get(providerKey);
  const stored = typeof clientId === 'string' ? byId?.get(clientId) : undefined;
  // Compare against something even when the client is unknown, so that an
  // unknown id and a wrong secret take the same time.
  const reference = stored || digest('no such client');
  const same = crypto.timingSafeEqual(reference, digest(typeof secret === 'string' ? secret : ''));
  return Boolean(stored) && same;
}

function intFromEnv(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be a whole number between ${min} and ${max}`);
  return n;
}

/** Settings read from the environment, with their defaults. */
function loadSettings(env, baseDir) {
  return {
    host: env.SIM_HOST || '127.0.0.1',
    port: intFromEnv(env, 'SIM_PORT', 3002, 0, 65535),
    providersDir: env.SIM_PROVIDERS_DIR || path.join(baseDir, 'providers'),
    clientsFile: env.SIM_CLIENTS_FILE || path.join(baseDir, 'clients.json'),
    // Behind a reverse proxy the caller's address is in X-Forwarded-For.
    trustProxy: env.SIM_TRUST_PROXY === '1',
    limits: {
      bodyBytes: intFromEnv(env, 'SIM_MAX_BODY_BYTES', 256 * 1024, 1024, 8 * 1024 * 1024),
      offersPerClient: intFromEnv(env, 'SIM_MAX_OFFERS_PER_CLIENT', 600, 10, 100000),
      bookingsPerClient: intFromEnv(env, 'SIM_MAX_BOOKINGS_PER_CLIENT', 200, 1, 100000),
      ttlSeconds: intFromEnv(env, 'SIM_TTL_SECONDS', 3600, 60, 86400),
      requestsPerMinute: intFromEnv(env, 'SIM_REQUESTS_PER_MINUTE', 3000, 10, 1000000),
    },
  };
}

module.exports = { ConfigError, loadProviders, loadClients, clientMatches, loadSettings, MIN_SECRET_LENGTH };
