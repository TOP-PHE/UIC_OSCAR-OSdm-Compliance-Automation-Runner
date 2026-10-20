// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-shares.js — runs a distributor shares with the company that operates
 * one of its providers (#901).
 *
 *   provider_operator  one row per provider: the company that operates it,
 *                      'waiting' until that company's Test Manager accepts.
 *   run_share          one row per (run, company), revocable.
 *
 * A share counts while all of this holds, checked at every read:
 *   - the share is not revoked;
 *   - the run belongs to a provider whose link names that company, accepted;
 *   - the Test Manager who shared it is still an active Test Manager of the
 *     distributor (one who left takes their shares with them);
 *   - the reader is an active Test Manager of that company.
 *
 * Read-only by construction: only canUserReadRun() (run-access.js) uses it,
 * and only read routes call that. Every write keeps canUserSeeRun().
 */

const { get, all } = require('../../db/db');

const ROLE_TM = new Set(['test_manager']);

/** The user as stored now: { id, company_id, role, status } or null. */
function storedUser(id) {
  if (typeof id !== 'string' || id === '') return null;
  return get('SELECT id, company_id, role, status FROM users WHERE id = ?', [id]) || null;
}

/** Is this stored user an active Test Manager of that company? */
function activeTestManagerOf(user, companyId) {
  return !!user && user.company_id === companyId && ROLE_TM.has(user.role)
    && (user.status || 'active') === 'active';
}

/** The provider (a child company) and its distributor, or null. */
function providerAndDistributor(companyId) {
  const provider = get('SELECT id, name, parent_id FROM companies WHERE id = ?', [companyId]);
  if (!provider?.parent_id) return null;
  const distributor = get('SELECT id, name FROM companies WHERE id = ?', [provider.parent_id]);
  return distributor ? { provider, distributor } : null;
}

/** The link of a provider: { provider_id, operator_id, status, … } or null. */
function operatorLinkOf(providerId) {
  return get('SELECT * FROM provider_operator WHERE provider_id = ?', [providerId]) || null;
}

/**
 * The shared view of a run for this reader, or null when the reader may not
 * read it through a share: { distributor: { id, name }, provider: { id, name } }.
 * `run` is the runs row; `user` is { id, role } as requireAuth sets it.
 */
function sharedViewOf(run, user) {
  if (!run || user?.role !== 'test_manager') return null;
  const reader = storedUser(user.id);
  if (!reader || !ROLE_TM.has(reader.role) || (reader.status || 'active') !== 'active') return null;
  const share = get(
    'SELECT shared_by FROM run_share WHERE run_id = ? AND company_id = ? AND revoked_at IS NULL',
    [run.id, reader.company_id],
  );
  if (!share) return null;
  const family = providerAndDistributor(run.company_id);
  if (!family) return null;
  const link = operatorLinkOf(family.provider.id);
  if (link?.operator_id !== reader.company_id || link.status !== 'accepted') return null;
  if (!activeTestManagerOf(storedUser(share.shared_by), family.distributor.id)) return null;
  return {
    distributor: { id: family.distributor.id, name: family.distributor.name },
    provider: { id: family.provider.id, name: family.provider.name },
  };
}

/** Every e-mail of the distributor's users, to be replaced by its name. */
function distributorEmails(distributorId) {
  return all('SELECT email FROM users WHERE company_id = ?', [distributorId]).map((r) => r.email).filter(Boolean);
}

module.exports = { sharedViewOf, operatorLinkOf, providerAndDistributor, activeTestManagerOf, storedUser, distributorEmails };
