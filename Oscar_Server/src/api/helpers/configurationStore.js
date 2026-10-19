// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * configurationStore.js — reading and writing a company's Test Framework and
 * Test Data, shared by the configuration import (#810), the reference
 * configuration (#838) and the provider checklist (#862).
 */

const crypto = require('node:crypto');
const { get, all, run, colDecrypt, colEncrypt } = require('../../db/db');
const configurationBundle = require('../../utils/configurationBundle');

function frameworkConfigOf(companyId) {
  const row = get('SELECT config FROM test_frameworks WHERE company_id = ?', [companyId]);
  if (!row) return null;
  try {
    const config = JSON.parse(colDecrypt(row.config));
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch {
    return null;
  }
}

function testResourcesOf(companyId) {
  return all('SELECT id, resource_type, label, data FROM test_resources WHERE company_id = ? ORDER BY created_at ASC, id ASC', [companyId])
    .map(r => {
      let data = {};
      try { data = JSON.parse(colDecrypt(r.data)); } catch { data = {}; }
      return { id: r.id, resource_type: r.resource_type, label: r.label, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} };
    });
}

function storeFramework(companyId, config) {
  const json = colEncrypt(JSON.stringify(config));
  const existing = get('SELECT id FROM test_frameworks WHERE company_id = ?', [companyId]);
  if (existing) {
    run(`UPDATE test_frameworks SET config = ?, updated_at = datetime('now') WHERE company_id = ?`, [json, companyId]);
  } else {
    run('INSERT INTO test_frameworks (id, company_id, config) VALUES (?, ?, ?)', [crypto.randomUUID(), companyId, json]);
  }
}

function storeTestData(companyId, incoming, mode) {
  const plan = configurationBundle.planTestData(testResourcesOf(companyId), incoming, mode, () => crypto.randomUUID());
  for (const id of plan.deleteIds) run('DELETE FROM test_resources WHERE id = ? AND company_id = ?', [id, companyId]);
  for (const r of plan.create) {
    run('INSERT INTO test_resources (id, company_id, resource_type, label, data) VALUES (?, ?, ?, ?, ?)',
      [r.id, companyId, r.resource_type, r.label, colEncrypt(JSON.stringify(r.data))]);
  }
  return {
    mode,
    removed: plan.deleteIds.length,
    trains_added: plan.trainsAdded,
    journeys_added: plan.journeysAdded,
    already_there: plan.alreadyThere,
    unresolved_legs: plan.unresolvedLegs,
  };
}

module.exports = { frameworkConfigOf, testResourcesOf, storeFramework, storeTestData };
