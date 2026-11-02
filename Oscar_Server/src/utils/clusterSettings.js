// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Two settings that matter once OSCAR runs behind a cluster's router instead
 * of the VPS's nginx (#1059). Pure: the server reads the environment and
 * passes the values in.
 *
 * TRUST_PROXY_HOPS: how many proxies in front of OSCAR each add an
 * X-Forwarded-For entry. One by default, as before: nginx on the VPS, the
 * OpenShift router or ingress-nginx alone. A load balancer that adds its own
 * entry in front of the router makes two. Too few, and every client is seen
 * at the proxy's address (one rate-limit bucket for everybody, so one person's
 * failed logins lock everyone out); too many, and a client chooses the
 * address it is counted under.
 *
 * METRICS_TOKEN: when set, /metrics answers only a request carrying it as a
 * bearer token, and 404 to anything else. Unset, as before: nginx keeps
 * /metrics from the outside. A Route or an Ingress has no such rule, and the
 * metrics name companies and providers (`oscar_company_*`).
 */

const crypto = require('node:crypto');

const MAX_PROXY_HOPS = 5;

function trustProxyHops(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return 1;
  const text = String(raw).trim();
  const hops = /^\d$/.test(text) ? Number(text) : Number.NaN;
  if (Number.isNaN(hops) || hops > MAX_PROXY_HOPS) {
    throw new Error(`TRUST_PROXY_HOPS must be a whole number from 0 to ${MAX_PROXY_HOPS}, not "${text.slice(0, 20)}".`);
  }
  return hops;
}

const BEARER = 'Bearer ';

function digestOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest();
}

// Compared through their digests, so that neither the length nor the content
// of the token shows in the time taken.
function metricsAllowed(authorization, token) {
  if (!token) return true;
  const header = typeof authorization === 'string' ? authorization : '';
  const given = header.startsWith(BEARER) ? header.slice(BEARER.length) : '';
  return crypto.timingSafeEqual(digestOf(given), digestOf(String(token))) && given !== '';
}

module.exports = { trustProxyHops, metricsAllowed, MAX_PROXY_HOPS };
