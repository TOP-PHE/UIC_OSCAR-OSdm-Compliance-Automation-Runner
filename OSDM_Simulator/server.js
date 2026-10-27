// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * server.js — start the OSDM provider simulator.
 *
 *   node server.js
 *
 * Settings come from the environment (see README.md). The provider profiles
 * and the clients file are checked before the server listens; if either is
 * wrong the process ends with a message and status 1.
 */

const http = require('node:http');
const { ConfigError, loadProviders, loadClients, loadSettings } = require('./src/config');
const { createTokenService } = require('./src/tokens');
const { createStore } = require('./src/store');
const { createApp } = require('./src/app');
const { createAccounts } = require('./src/accounts');
const { createAdmin } = require('./src/admin');
const { createStats } = require('./src/stats');
const { createMetrics } = require('./src/metrics');
const { version } = require('./package.json');

// What came from the caller is reduced to printable ASCII before it is
// written, so that a request cannot start a log line of its own.
const printable = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '?');

function logLine(entry) {
  const parts = [new Date().toISOString(), printable(entry.method), printable(entry.path), entry.status, `${entry.ms}ms`];
  if (entry.provider) parts.push(`provider=${printable(entry.provider)}`);
  if (entry.client) parts.push(`client=${printable(entry.client)}`);
  if (entry.auditError) {
    console.error(`${parts[0]} the audit line could not be written: ${printable(entry.auditError)}`);
    return;
  }
  console.log(parts.join(' '));
  if (entry.error) console.error(entry.error);
}

// Without a data folder, the clients file as before: read once, never changed.
// With one (#930), the accounts kept there, made from the clients file on the
// first start, and the administration API when its key is set.
function accountsOf(settings, providers, metrics = null) {
  if (!settings.dataDir) return { clients: loadClients(settings.clientsFile, providers), accounts: null, admin: null, stats: null };
  const accounts = createAccounts({ dataDir: settings.dataDir, providers, clientsFile: settings.clientsFile, log: logLine });
  if (accounts.count() === 0 && !settings.adminKeySha256) {
    throw new ConfigError(`the data folder holds no account, there is no clients file to start from, and no administration key to add one (${settings.dataDir})`);
  }
  if (accounts.imported !== null) console.log(`Imported ${accounts.imported} accounts from ${settings.clientsFile} into ${settings.dataDir}`);
  // #930 PR 3: the usage of each account, kept next to the accounts.
  const stats = createStats({ dataDir: settings.dataDir, providers, retentionDays: settings.statsRetentionDays });
  if (!settings.adminKeySha256) {
    console.log('No administration key (SIM_ADMIN_KEY_SHA256): the administration API is closed.');
    return { clients: accounts.clients, accounts, admin: null, stats };
  }
  return { clients: accounts.clients, accounts, admin: createAdmin({ keySha256: settings.adminKeySha256, accounts, stats, metrics }), stats };
}

function start(env = process.env, baseDir = __dirname) {
  const settings = loadSettings(env, baseDir);
  const providers = loadProviders(settings.providersDir);
  const store = createStore({
    limits: { offer: settings.limits.offersPerClient, trip: settings.limits.offersPerClient, booking: settings.limits.bookingsPerClient, fulfillment: settings.limits.offersPerClient, idempotency: settings.limits.offersPerClient },
    ttlMs: settings.limits.ttlSeconds * 1000,
  });
  // #1005: read by OSCAR through the administration API only.
  const metrics = createMetrics({ version, store, dataDir: settings.dataDir });
  const { clients, accounts, admin, stats } = accountsOf(settings, providers, metrics);
  const app = createApp({
    providers,
    clients,
    accounts,
    admin,
    stats,
    metrics,
    tokens: createTokenService(),
    store,
    limits: settings.limits,
    trustProxy: settings.trustProxy,
    log: logLine,
  });
  const server = http.createServer(app);
  // The counts of the last minute are written when the server stops.
  if (stats) server.on('close', () => stats.close());
  // A slow or silent caller does not hold a connection for long.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  server.listen(settings.port, settings.host, () => {
    const { port } = server.address();
    console.log(`OSDM simulator ${version} listening on ${settings.host}:${port}, providers: ${[...providers.keys()].join(', ')}`);
  });
  return server;
}

if (require.main === module) {
  try {
    const server = start();
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`OSDM simulator not started: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { start, logLine };
