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

// What came from the caller is reduced to printable ASCII before it is
// written, so that a request cannot start a log line of its own.
const printable = (value) => String(value).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '?');

function logLine(entry) {
  const parts = [new Date().toISOString(), printable(entry.method), printable(entry.path), entry.status, `${entry.ms}ms`];
  if (entry.provider) parts.push(`provider=${printable(entry.provider)}`);
  if (entry.client) parts.push(`client=${printable(entry.client)}`);
  console.log(parts.join(' '));
  if (entry.error) console.error(entry.error);
}

function start(env = process.env, baseDir = __dirname) {
  const settings = loadSettings(env, baseDir);
  const providers = loadProviders(settings.providersDir);
  const clients = loadClients(settings.clientsFile, providers);
  const app = createApp({
    providers,
    clients,
    tokens: createTokenService(),
    store: createStore({
      limits: { offer: settings.limits.offersPerClient, trip: settings.limits.offersPerClient, booking: settings.limits.bookingsPerClient },
      ttlMs: settings.limits.ttlSeconds * 1000,
    }),
    limits: settings.limits,
    trustProxy: settings.trustProxy,
    log: logLine,
  });
  const server = http.createServer(app);
  // A slow or silent caller does not hold a connection for long.
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  server.listen(settings.port, settings.host, () => {
    const { port } = server.address();
    console.log(`OSDM simulator listening on ${settings.host}:${port}, providers: ${[...providers.keys()].join(', ')}`);
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
