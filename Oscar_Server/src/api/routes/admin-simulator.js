// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * admin-simulator.js — the OSDM simulator's accounts, managed by OSCAR's
 * administrators (#930, PR 2).
 *
 * GET    /v1/admin/simulator/config                           — the address, and whether a key is saved
 * PUT    /v1/admin/simulator/config                           — { url, key? }: tried, then saved
 * DELETE /v1/admin/simulator/config                           — forget the address and the key
 * GET    /v1/admin/simulator/accounts                         — every provider and its accounts
 * POST   /v1/admin/simulator/accounts/:provider               — { clientId } or { kind }: a new account and its secret, once
 * DELETE /v1/admin/simulator/accounts/:provider/:clientId     — delete it
 * POST   /v1/admin/simulator/accounts/:provider/:clientId/reset-secret — a new secret, once
 * GET    /v1/admin/simulator/audit                            — the simulator's audit
 * GET    /v1/admin/simulator/stats?days=1|7|30|90|365         — what each account did, per provider and per day
 *
 * Administrators only. The simulator is called by services/simulatorAdmin.js,
 * naming the administrator; every change is in OSCAR's audit too. Answers are
 * built field by field from the simulator's, and carry no-store.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireRole } = require('../middleware/auth');
const { auditLog } = require('../helpers/shared');
const S = require('../../services/simulatorAdmin');

const router = express.Router();

// Each request is one call to another host: a limit of its own, counted before
// anything else is done.
const simulatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, title: 'Too Many Requests', detail: 'Too many simulator requests in a minute. Wait a moment.' },
});
router.use(simulatorLimiter);
router.use(requireAuth, requireRole('administrator'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// The simulator's own rules (config.js there): a provider key and a client id.
const PROVIDER = /^[a-z][a-z0-9-]{1,30}$/;
const CLIENT_ID = /^[\x21-\x39\x3B-\x7E]{3,64}$/;
const KINDS = new Set(['tst', 'tstmgr']);

const problem = (res, status, detail) => res.status(status).json({ status, title: status === 400 ? 'Bad Request' : 'Simulator', detail });

function failed(res, err) {
  if (err instanceof S.SimulatorError) return problem(res, err.status, err.detail);
  throw err;
}

const text = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

// The accounts list, member by member.
function accountsView(body) {
  const providers = Array.isArray(body?.providers) ? body.providers : [];
  return {
    providers: providers.filter((p) => typeof p?.provider === 'string' && PROVIDER.test(p.provider)).map((p) => ({
      provider: p.provider,
      name: text(p.name, 80),
      osdmVersion: text(p.osdmVersion, 20),
      accounts: (Array.isArray(p.accounts) ? p.accounts : [])
        .filter((a) => typeof a?.clientId === 'string' && CLIENT_ID.test(a.clientId))
        .map((a) => ({ clientId: a.clientId, createdAt: text(a.createdAt, 40), lastTokenAt: text(a.lastTokenAt, 40) })),
    })),
  };
}

// A new secret, member by member.
function secretView(body) {
  if (typeof body?.clientId !== 'string' || typeof body?.clientSecret !== 'string' || !/^[0-9a-f]{64}$/.test(body.clientSecret)) {
    throw new S.SimulatorError(502, 'The simulator answered without a usable secret.');
  }
  return { provider: text(body.provider, 40), clientId: body.clientId, clientSecret: body.clientSecret };
}

function auditView(body) {
  const entries = Array.isArray(body?.entries) ? body.entries.slice(0, 200) : [];
  return {
    entries: entries.map((e) => ({
      at: text(e?.at, 40), by: text(e?.by, 120), action: text(e?.action, 40),
      provider: text(e?.provider, 40), clientId: text(e?.clientId, 64),
      count: Number.isInteger(e?.count) ? e.count : null, address: text(e?.address, 64),
    })),
  };
}

function checkProvider(provider) {
  if (!PROVIDER.test(provider)) throw new S.SimulatorError(400, 'Not a provider of the simulator.');
}

function checkClient(clientId) {
  if (!CLIENT_ID.test(clientId)) throw new S.SimulatorError(400, 'A client id is 3 to 64 printable characters, without a colon or a space.');
}

const actorOf = (req) => req.user.email;

router.get('/config', (req, res) => res.json(S.configView()));

router.put('/config', async (req, res) => {
  const { url, key } = req.body || {};
  try {
    const view = await S.saveConfig({ url, key }, actorOf(req));
    auditLog(req.user.id, null, req.user.email, `simulator_config_saved:${key ? 'new_key' : 'same_key'}`);
    return res.json(view);
  } catch (err) {
    return failed(res, err);
  }
});

router.delete('/config', (req, res) => {
  S.removeConfig();
  auditLog(req.user.id, null, req.user.email, 'simulator_config_removed');
  return res.json(S.configView());
});

router.get('/accounts', async (req, res) => {
  try {
    const answer = await S.call({ method: 'GET', path: 'accounts', actor: actorOf(req) });
    return res.json(accountsView(answer.body));
  } catch (err) {
    return failed(res, err);
  }
});

router.post('/accounts/:provider', async (req, res) => {
  const { provider } = req.params;
  const { clientId, kind } = req.body || {};
  try {
    checkProvider(provider);
    const body = {};
    if (clientId !== undefined && clientId !== '') {
      if (typeof clientId !== 'string') throw new S.SimulatorError(400, 'The client id is text.');
      checkClient(clientId);
      body.clientId = clientId;
    } else if (kind !== undefined) {
      if (!KINDS.has(kind)) throw new S.SimulatorError(400, 'The kind of account is "tst" or "tstmgr".');
      body.kind = kind;
    }
    const answer = await S.call({ method: 'POST', path: `accounts/${encodeURIComponent(provider)}`, body, actor: actorOf(req) });
    const view = secretView(answer.body);
    auditLog(req.user.id, null, req.user.email, `simulator_account_added:${provider}/${view.clientId}`);
    return res.status(201).json(view);
  } catch (err) {
    return failed(res, err);
  }
});

router.delete('/accounts/:provider/:clientId', async (req, res) => {
  const { provider, clientId } = req.params;
  try {
    checkProvider(provider);
    checkClient(clientId);
    await S.call({ method: 'DELETE', path: `accounts/${encodeURIComponent(provider)}/${encodeURIComponent(clientId)}`, actor: actorOf(req) });
    auditLog(req.user.id, null, req.user.email, `simulator_account_deleted:${provider}/${clientId}`);
    return res.json({ provider, clientId, deleted: true });
  } catch (err) {
    return failed(res, err);
  }
});

router.post('/accounts/:provider/:clientId/reset-secret', async (req, res) => {
  const { provider, clientId } = req.params;
  try {
    checkProvider(provider);
    checkClient(clientId);
    const answer = await S.call({ method: 'POST', path: `accounts/${encodeURIComponent(provider)}/${encodeURIComponent(clientId)}/reset-secret`, actor: actorOf(req) });
    const view = secretView(answer.body);
    auditLog(req.user.id, null, req.user.email, `simulator_secret_reset:${provider}/${clientId}`);
    return res.json(view);
  } catch (err) {
    return failed(res, err);
  }
});

router.get('/audit', async (req, res) => {
  try {
    const answer = await S.call({ method: 'GET', path: 'audit', actor: actorOf(req) });
    return res.json(auditView(answer.body));
  } catch (err) {
    return failed(res, err);
  }
});

// #930 PR 3: the counters the simulator keeps, as it names them.
const COUNTERS = ['tokens', 'requests', 'offers', 'bookings', 'confirmations', 'refunds', 'exchanges', 'clientErrors', 'serverErrors'];
const PERIODS = new Set([1, 7, 30, 90, 365]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const countersOf = (v) => Object.fromEntries(COUNTERS.map((c) => [c, Number.isInteger(v?.[c]) && v[c] >= 0 ? v[c] : 0]));

// The statistics, member by member.
function statsView(body, days) {
  const providers = Array.isArray(body?.providers) ? body.providers : [];
  return {
    days,
    from: DAY.test(body?.from || '') ? body.from : null,
    to: DAY.test(body?.to || '') ? body.to : null,
    providers: providers.filter((p) => typeof p?.provider === 'string' && PROVIDER.test(p.provider)).map((p) => ({
      provider: p.provider,
      name: text(p.name, 80),
      totals: countersOf(p.totals),
      unidentified: countersOf(p.unidentified),
      accounts: (Array.isArray(p.accounts) ? p.accounts : [])
        .filter((a) => typeof a?.clientId === 'string' && CLIENT_ID.test(a.clientId))
        .map((a) => ({ clientId: a.clientId, ...countersOf(a) })),
    })),
    daily: (Array.isArray(body?.daily) ? body.daily : [])
      .filter((d) => DAY.test(d?.day || ''))
      .map((d) => ({ day: d.day, ...countersOf(d) })),
  };
}

// The last `days` days, today (UTC) included.
function periodOf(days, now = Date.now()) {
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(now - (days - 1) * 86400000), to: day(now) };
}

router.get('/stats', async (req, res) => {
  const days = req.query.days === undefined ? 30 : Number(req.query.days);
  try {
    if (!PERIODS.has(days)) throw new S.SimulatorError(400, 'The period is 1, 7, 30, 90 or 365 days.');
    const { from, to } = periodOf(days);
    const answer = await S.call({ method: 'GET', path: `stats?from=${from}&to=${to}`, actor: actorOf(req) });
    return res.json(statsView(answer.body, days));
  } catch (err) {
    return failed(res, err);
  }
});

module.exports = router;
module.exports.views = { accountsView, secretView, auditView, statsView, periodOf };
