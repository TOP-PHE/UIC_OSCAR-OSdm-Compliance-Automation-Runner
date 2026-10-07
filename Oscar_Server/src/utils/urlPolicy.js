// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * urlPolicy.js — where a run or a token fetch is allowed to go (tracker S5,
 * v1.11.211).
 *
 * Two fields a company's members control become outbound requests the server,
 * or the Bruno child, makes: `companies.api_base` (every OSDM request of every
 * run) and a tester's `users.token_url` (the OAuth token fetch). Neither was
 * checked. A `token_url` of `http://127.0.0.1:3001/…`, or an `api_base` of
 * `http://grafana:3000`, turned the server into a request-forgery tool that
 * reaches loopback, the private network and the Docker service mesh, and the
 * reply (a token, another service's page) comes back in the run log or the
 * token error. S8 removed the loopback *trust* on the two OSCAR routes; this
 * stops the request being aimed at an internal address at all.
 *
 * The rule: a target must be `https` and resolve to a public (`unicast`)
 * address. Blocked are loopback, private (RFC 1918), link-local (incl. the
 * cloud metadata address 169.254.169.254), unique-local, carrier-grade NAT,
 * the unspecified / broadcast / multicast / reserved ranges, and any bare
 * single-label host name (a Docker service name, `localhost`). IP ranges are
 * classified by `ipaddr.js`, not by hand.
 *
 * `ALLOW_PRIVATE_TARGETS=1` turns the whole policy off, for a self-hosted or
 * development box whose providers sit on `http://localhost` or the LAN. It is
 * read at call time, so a deployment can set it without a restart and a test
 * can scope it.
 *
 * Two entry points:
 *   - `storedUrlRefusal(raw, label)` — synchronous, structural only (scheme and
 *     host shape). For the save/PATCH routes: a fast, deterministic 400 with no
 *     DNS in the request path. Returns a sentence, or null when allowed.
 *   - `usableUrlRefusal(raw, label)` — async, structural + a DNS lookup of the
 *     host, so a name that resolves to a private address is caught too (the
 *     backstop for values stored before this policy, and for DNS that points
 *     inward). For the use sites: the token fetch, the server's OSDM calls, and
 *     the start of a run. Returns a sentence, or null.
 */

const dns = require('node:dns').promises;
const net = require('node:net');
const ipaddr = require('ipaddr.js');

function allowPrivate() {
  const v = String(process.env.ALLOW_PRIVATE_TARGETS || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// url.hostname keeps the brackets on an IPv6 literal ("[::1]"); strip them so
// net.isIP / the DNS lookup see the bare address.
const hostOf = url => url.hostname.replace(/^\[|\]$/g, '');

// A literal IP is public when ipaddr.js calls it 'unicast'. An IPv4-mapped
// IPv6 address (::ffff:10.0.0.1) is unwrapped first, or the mapping would hide
// a private v4 behind a v6 that looks unicast.
function ipIsPublic(ip) {
  let addr;
  try { addr = ipaddr.parse(ip); } catch { return false; }
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  return addr.range() === 'unicast';
}

// Structural check. Returns null when allowed, else a short reason (no value).
function structuralReason(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return 'is empty';
  let url;
  try { url = new URL(raw.trim()); } catch { return 'is not a valid URL'; }
  if (allowPrivate()) return null;
  if (url.protocol !== 'https:') return 'must use https';
  const host = hostOf(url);
  if (net.isIP(host)) {
    if (!ipIsPublic(host)) return 'points at a private, loopback or link-local address';
  } else if (!host.includes('.')) {
    return 'points at an internal host name (no public domain)';  // "localhost", "grafana", …
  }
  return null;
}

// Does the host resolve only to public addresses? A literal IP is judged
// directly. A name that will not resolve is treated as blocked: a usable
// target has to resolve, and failing open here would defeat the point.
async function resolvesPublic(host) {
  if (net.isIP(host)) return ipIsPublic(host);
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return false; }
  return addrs.length > 0 && addrs.every(a => ipIsPublic(a.address));
}

const what = label => label || 'address';

/** The sentence to refuse a stored value (structural only), or null. */
function storedUrlRefusal(raw, label) {
  const reason = structuralReason(raw);
  return reason ? `This ${what(label)} ${reason}. It must be an https address on a public host.` : null;
}

/** The sentence to refuse a value about to be used (structural + DNS), or null. */
async function usableUrlRefusal(raw, label) {
  const reason = structuralReason(raw);
  if (reason) return `This ${what(label)} ${reason}. It must be an https address on a public host.`;
  if (allowPrivate()) return null;
  const host = hostOf(new URL(raw.trim()));
  if (!(await resolvesPublic(host))) {
    return `This ${what(label)} resolves to a private, loopback or link-local address. It must be an https address on a public host.`;
  }
  return null;
}

module.exports = { storedUrlRefusal, usableUrlRefusal, ipIsPublic, allowPrivate };
