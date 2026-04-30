'use strict';

/**
 * test-app.js — Build a minimal Express app with one route mounted, for
 * supertest integration tests. Avoids loading the full server.js (which
 * starts the queue worker, attaches event listeners, and binds a port).
 */

const express = require('express');

/**
 * @param {string} mountPath — e.g. '/v1/auth'
 * @param {string} routerPath — relative require path, e.g. '../../src/api/routes/auth'
 */
function buildAppWithRoute(mountPath, routerPath) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, require(routerPath));
  // Generic JSON 500 so failed promises don't dump HTML stack traces in tests
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    res.status(500).json({ status: 500, title: 'Internal Server Error', detail: err.message });
  });
  return app;
}

module.exports = { buildAppWithRoute };
