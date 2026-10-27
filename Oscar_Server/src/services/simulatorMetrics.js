// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * simulatorMetrics.js — the simulator's metrics for OSCAR's Prometheus
 * (#1005), read through the administration API that Admin → OSDM Simulator
 * set up (`simulatorAdmin.js`: the saved address, the key sent to it only).
 * Prometheus scrapes `GET /metrics?source=simulator` inside the Docker network
 * and so holds no key of its own; nothing is opened on the simulator's host.
 *
 * One read every CACHE_MS at most, whatever the number of scrapes.
 */

const simulatorAdmin = require('./simulatorAdmin');
const { renderSimulatorMetrics } = require('../utils/simulatorMetricsText');
const log = require('../utils/logger').child({ module: 'simulator-metrics' });

const CACHE_MS = 10000;
const ACTOR = 'prometheus';

let cached = null; // { at, text }

async function freshText({ call, configView }) {
  const view = configView();
  if (!view.url || !view.keySet) return renderSimulatorMetrics(null, { up: false, configured: false });
  try {
    const { body } = await call({ method: 'GET', path: 'metrics', actor: ACTOR });
    return renderSimulatorMetrics(body, { up: true, configured: true });
  } catch (err) {
    log.warn({ err: err.message }, 'The simulator did not answer its metrics');
    return renderSimulatorMetrics(null, { up: false, configured: true });
  }
}

/** The Prometheus text; `deps` and `now` are for the tests. */
async function simulatorMetricsText({ call = simulatorAdmin.call, configView = simulatorAdmin.configView, now = Date.now } = {}) {
  if (cached && now() - cached.at < CACHE_MS) return cached.text;
  const text = await freshText({ call, configView });
  cached = { at: now(), text };
  return text;
}

function forgetCache() {
  cached = null;
}

module.exports = { simulatorMetricsText, forgetCache, CACHE_MS };
