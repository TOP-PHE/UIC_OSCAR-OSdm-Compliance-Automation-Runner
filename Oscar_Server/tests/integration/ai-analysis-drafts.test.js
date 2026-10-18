// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #823 PR 2: a group of an AI analysis becomes a draft in Test Findings'
 * suggested findings (#735). The draft names the analysis and its model; the
 * AI's owner is shown, the category stays "open"; one draft per group.
 */

process.env.JWT_SECRET = 'test-jwt-secret-for-ai-analysis-drafts';

const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID: uuidv4 } = require('node:crypto');
const request = require('supertest');
const { run, get, colEncrypt } = require('../../src/db/db');

const app = express();
app.use(express.json());
app.use('/v1/company', require('../../src/api/routes/company-ai-analysis-results'));
app.use('/v1/company', require('../../src/api/routes/company-finding-suggestions'));

const companyId = uuidv4();
const otherId = uuidv4();
const tmId = uuidv4();
const testerId = uuidv4();
const BASE = '/v1/company/ai-analysis/history';

const token = (role, uid, cid = companyId) => `Bearer ${jwt.sign({ sub: uid, email: `${role}@ai-drafts.com`, companyId: cid, role },
  process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })}`;
const tm = () => token('test_manager', tmId);

const result = {
  summary: 'Two problems.',
  groups: [
    { title: 'Refund receipt <never> shown', cause: 'No INFORMATION document after the refund.', owner: 'provider', why: 'The booking is REFUNDED.',
      action: 'The provider adds the receipt.', steps: ['14b. GET Booking Refund Receipt'], scenarios: ['SIM_REFUND_RECEIPT_RETURN_1ADT_38'] },
    { title: 'Scenario of another version', cause: 'A 3.8 scenario on a 3.6 provider.', owner: 'configuration', why: '', action: '',
      steps: ['01. POST Get Offer', '01b. POST Get Return Offer'], scenarios: ['A_38', 'B_38'] },
  ],
};

function analysis(company, status = 'done', body = result) {
  const id = uuidv4();
  run(`INSERT INTO ai_analysis (id, company_id, user_id, mode, batch_a, language, connector, model, input_hash, input_chars, status, result_enc)
       VALUES (?, ?, ?, 'one', 'batch-7', 'English', 'anthropic', 'claude-opus-5-5', 'h', 10, ?, ?)`,
  [id, company, tmId, status, body ? colEncrypt(JSON.stringify(body)) : null]);
  return id;
}

let doneId;
beforeAll(() => {
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Drafts', ?)`, [companyId, `ai-drafts-${companyId.slice(0, 8)}`]);
  run(`INSERT INTO companies (id, name, slug) VALUES (?, 'AI Drafts Other', ?)`, [otherId, `ai-drafts-o-${otherId.slice(0, 8)}`]);
  for (const [id, role] of [[tmId, 'test_manager'], [testerId, 'company_user']]) {
    run(`INSERT INTO users (id, company_id, email, password_hash, role) VALUES (?, ?, ?, 'x', ?)`, [id, companyId, `${id}@ai-drafts.com`, role]);
  }
  doneId = analysis(companyId);
});

const makeDraft = (id, index, auth = tm()) => request(app).post(`${BASE}/${id}/groups/${index}/draft`).set('Authorization', auth);

test('a group becomes a draft naming the analysis and its model; the AI\'s owner is shown, the category stays open', async () => {
  const res = await makeDraft(doneId, 0);
  expect(res.status).toBe(201);
  const { draft } = res.body.suggestion;
  expect(draft).toMatchObject({ title: 'Refund receipt <never> shown', step: '14b. GET Booking Refund Receipt',
    scenarioCode: 'SIM_REFUND_RECEIPT_RETURN_1ADT_38', category: 'open', expectedStatus: null,
    observed: 'No INFORMATION document after the refund.' });
  expect(draft.source).toMatchObject({ kind: 'ai_analysis', analysisId: doneId, model: 'claude-opus-5-5', owner: 'provider', group: 0 });
  expect(draft.evidence).toContain(`From an AI analysis (id ${doneId}, model claude-opus-5-5`);
  expect(draft.evidence).toContain('The AI names as the one to act: the provider.');
  expect(draft.reason).toContain('The category is yours to choose.');

  const list = await request(app).get('/v1/company/findings/suggestions').set('Authorization', tm());
  const mine = list.body.drafts.find((d) => d.id === res.body.suggestion.id);
  expect(mine).toMatchObject({ state: 'draft', occurrences: 0, scenarios: ['SIM_REFUND_RECEIPT_RETURN_1ADT_38'], lastBatchId: 'batch-7' });
  expect(get("SELECT COUNT(*) AS n FROM auth_events WHERE event_type = ?", [`ai_analysis_draft:${doneId}:0`]).n).toBe(1);
});

test('one draft per group: the second ask is a 409, and the analysis lists the drafts made from it', async () => {
  expect((await makeDraft(doneId, 0)).status).toBe(409);
  const read = await request(app).get(`${BASE}/${doneId}`).set('Authorization', tm());
  expect(read.status).toBe(200);
  expect(Object.keys(read.body.drafts)).toEqual(['0']);
  expect(read.body.drafts['0'].state).toBe('draft');
});

test('several steps or scenarios name none in the draft; accepting it opens a finding of category open', async () => {
  const made = await makeDraft(doneId, 1);
  expect(made.status).toBe(201);
  expect(made.body.suggestion.draft).toMatchObject({ step: null, scenarioCode: null });
  expect(made.body.suggestion.draft.evidence).toContain('Steps: 01. POST Get Offer, 01b. POST Get Return Offer');
  const accepted = await request(app).post(`/v1/company/findings/suggestions/${made.body.suggestion.id}/accept`).set('Authorization', tm()).send({});
  expect(accepted.status).toBe(201);
  expect(accepted.body.finding).toMatchObject({ title: 'Scenario of another version', category: 'open' });
  const read = await request(app).get(`${BASE}/${doneId}`).set('Authorization', tm());
  expect(read.body.drafts['1'].state).toBe('accepted');
});

test('no draft from a missing group, an analysis not done, another company\'s, or for a tester', async () => {
  for (const index of ['2', '-1', 'abc', '1e3', '0001']) expect((await makeDraft(doneId, index)).status).toBe(404);
  expect((await makeDraft(analysis(companyId, 'running', null), 0)).status).toBe(404);
  expect((await makeDraft(analysis(companyId, 'unreadable', { raw: 'x' }), 0)).status).toBe(404);
  expect((await makeDraft(analysis(otherId), 0)).status).toBe(404);
  expect((await makeDraft(doneId, 0, token('company_user', testerId))).status).toBe(403);
  expect(get("SELECT COUNT(*) AS n FROM finding_suggestion WHERE company_id = ?", [otherId]).n).toBe(0);
});
