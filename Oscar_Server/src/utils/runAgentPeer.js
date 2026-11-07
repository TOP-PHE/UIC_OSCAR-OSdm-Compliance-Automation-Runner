// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The runner agent's address, as the server sees its requests (run
 * isolation, option 2b). With RUN_ISOLATION=isolated and the agent in another
 * container (RUN_AGENT_HOST a name such as `oscar-runner`), Bruno's calls back
 * to the server (data file, token refresh) come from that container, not from
 * 127.0.0.1. The run's secret is still required on both routes; this only
 * extends "from this machine" to that one container. The name is looked up
 * again every 30 s, as a recreated container may get another address.
 */

const dns = require('node:dns');

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
const REFRESH_MS = 30_000;
let addresses = new Set();
let timer = null;

const plain = (address) => String(address || '').replace(/^::ffff:/, '');

// The agent's host name, when it is another machine of the network.
function agentHost(env = process.env) {
  const isolated = String(env.RUN_ISOLATION || '').trim().toLowerCase() === 'isolated';
  const host = String(env.RUN_AGENT_HOST || '').trim();
  return isolated && host && !LOOPBACK_NAMES.has(host.toLowerCase()) ? host : '';
}

/** Looks the agent's address up again (none when it is not another container). */
async function refreshRunAgentPeer(lookup = dns.promises.lookup) {
  const host = agentHost();
  if (!host) { addresses = new Set(); return addresses; }
  try {
    const found = await lookup(host, { all: true });
    addresses = new Set(found.map((a) => plain(a.address)));
  } catch {
    addresses = new Set();
  }
  return addresses;
}

/** Whether a request's source address is the runner agent's container. */
function isRunAgentPeer(remoteAddress) {
  return addresses.size > 0 && addresses.has(plain(remoteAddress));
}

/** Starts the lookups (no-op when the agent is not another container). */
function watchRunAgentPeer() {
  if (timer || !agentHost()) return;
  refreshRunAgentPeer().catch(() => {});
  timer = setInterval(() => { refreshRunAgentPeer().catch(() => {}); }, REFRESH_MS);
  timer.unref();
}

module.exports = { isRunAgentPeer, refreshRunAgentPeer, watchRunAgentPeer, agentHost };
