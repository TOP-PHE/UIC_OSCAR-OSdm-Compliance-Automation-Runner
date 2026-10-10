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
const MAX_REDUCTION_CARDS = 20;
const MAX_PRODUCTS = 10;
const MAX_GROUP_PASSENGERS = 19;
const FLEXIBILITY_KEYS = new Set(['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE']);

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
  const reductionCards = checkReductionCards(raw.reductionCards, bad);
  const products = checkProducts(raw.products, bad);
  const secondClassOnlyCategories = checkCategories(raw.secondClassOnlyCategories, bad);
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
    ...(reductionCards ? { reductionCards } : {}),
    ...(products ? { products } : {}),
    ...(secondClassOnlyCategories ? { secondClassOnlyCategories } : {}),
  };
}

// The named products a provider sells (#598): a code, a name, a flexibility,
// a price factor and whether it is bound to the train. Absent: one product
// per flexibility, as before. A group product (#599) adds its `group` rules.
function checkProducts(products, bad) {
  if (products === undefined) return null;
  if (!Array.isArray(products) || products.length === 0 || products.length > MAX_PRODUCTS) throw bad('products');
  const ok = (p) => p && OVERRULE_CODE.test(p.code) && isText(p.name, 1, 80) && FLEXIBILITY_KEYS.has(p.flexibility)
    && Number.isFinite(p.factor) && p.factor >= 0.5 && p.factor <= 3 && typeof p.isTrainBound === 'boolean';
  if (!products.every(ok) || new Set(products.map((p) => p.code)).size !== products.length) throw bad('products');
  return products.map((p) => ({
    code: p.code, name: p.name, flexibility: p.flexibility, factor: p.factor, isTrainBound: p.isTrainBound,
    ...(p.group === undefined ? {} : { group: checkGroup(p.group, bad) }),
  }));
}

// The rules of a group product (#599): how many passengers, how many of them
// aged 15 or more, whether only on a Saturday or a Sunday, only in second
// class, on one ticket for every direction; and its price: the full fare of a
// fixed number of passengers (`pricedPassengers`), or the full fare for the
// first and a percentage of it for each other one (`followerPercent`).
function checkGroup(group, bad) {
  const count = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_GROUP_PASSENGERS;
  const flag = (v) => typeof v === 'boolean';
  const ok = group && typeof group === 'object'
    && count(group.minPassengers) && group.minPassengers >= 1
    && count(group.maxPassengers) && group.maxPassengers >= group.minPassengers
    && (group.maxOver15 === undefined || count(group.maxOver15))
    && flag(group.weekendOnly) && flag(group.secondClassOnly) && flag(group.oneFulfillment)
    && ((group.pricedPassengers === undefined) !== (group.followerPercent === undefined))
    && (group.pricedPassengers === undefined || (count(group.pricedPassengers) && group.pricedPassengers >= 1))
    && (group.followerPercent === undefined || (Number.isInteger(group.followerPercent) && group.followerPercent >= 1 && group.followerPercent <= 100));
  if (!ok) throw bad('products');
  const out = {
    minPassengers: group.minPassengers,
    maxPassengers: group.maxPassengers,
    weekendOnly: group.weekendOnly,
    secondClassOnly: group.secondClassOnly,
    oneFulfillment: group.oneFulfillment,
  };
  if (group.maxOver15 !== undefined) out.maxOver15 = group.maxOver15;
  if (group.pricedPassengers === undefined) out.followerPercent = group.followerPercent;
  else out.pricedPassengers = group.pricedPassengers;
  return out;
}

// The train categories (their short names) that run in second class only
// (#600). A first-class offer then gives a second-class admission and an
// upgrade part on the other legs. Absent: every train has a first class.
function checkCategories(categories, bad) {
  if (categories === undefined) return null;
  const ok = Array.isArray(categories) && categories.length > 0 && categories.length <= 10
    && categories.every((c) => typeof c === 'string' && /^[A-Za-z0-9]{1,10}$/.test(c)) && new Set(categories).size === categories.length;
  if (!ok) throw bad('secondClassOnlyCategories');
  return [...categories];
}

// The reduction cards a provider knows (#597): a code, a name and the
// reduction in percent. Absent: GET /reduction-cards answers 501 and every
// card is unknown.
function checkReductionCards(cards, bad) {
  if (cards === undefined) return null;
  if (!Array.isArray(cards) || cards.length === 0 || cards.length > MAX_REDUCTION_CARDS) throw bad('reductionCards');
  const ok = (c) => c && OVERRULE_CODE.test(c.code) && isText(c.name, 1, 80)
    && Number.isInteger(c.percent) && c.percent >= 1 && c.percent <= 90;
  if (!cards.every(ok) || new Set(cards.map((c) => c.code)).size !== cards.length) throw bad('reductionCards');
  return cards.map((c) => ({ code: c.code, name: c.name, percent: c.percent }));
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
