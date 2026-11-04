// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { bearer, pathParam, jsonBody, fileBody } = require('./common');

const FINDING = [pathParam('id', 'The finding')];
const SUGGESTION = [pathParam('id', 'The suggested finding')];
const SCOPE = 'For the company or provider of the request (X-Provider-Id).';
const READERS = `${SCOPE} Testers and Test Managers; administrators and certifiers get 403.`;
const WRITERS = `${SCOPE} Test Managers only.`;
const FINDING_FIELDS = '{ title, step, scenarioCode, expectedStatus, observed, interpretation, category (open | provider_deviation | oscar_issue | not_supported | spec_question), severity (major | minor | not_supported), evidence, baselineInRun, raiseToOsdm }';
const BASELINE = 'A finding is played in the runs as a known deviation only with a step and a numeric expectedStatus; the data file\'s knownDeviations are then written again.';
const TM_ONLY = { 403: { description: 'Test Managers only' } };
const NO_FINDING = { 404: { description: 'No such finding here' } };
const DECIDED = { ...TM_ONLY, 404: { description: 'No such suggestion here' }, 409: { description: 'Already decided' } };
const CHECKLIST_WHO = 'Test Managers of the company or provider of the request (X-Provider-Id); no AI access is needed. At most 60 requests a minute.';
const CHECKLIST_VIEW = '{ checklist: { fileName, answers, importedAt, importedBy, sent, cut } | null }';

module.exports = {
  '/v1/company/findings': {
    get: { tags: ['Company'], summary: 'The Test Findings & Open Points of the company or provider', security: bearer,
      description: `${READERS} { findings: [{ id, title, step, scenarioCode, expectedStatus, observed, interpretation, category, severity, status, baselineInRun, raiseToOsdm, evidence, createdBy, createdAt, updatedAt, …, commentCount }] }, oldest first.`,
      responses: { 200: { description: 'The findings' }, 403: { description: 'Administrators and certifiers' } } },
    post: { tags: ['Company'], summary: 'Open a finding', security: bearer,
      description: `${WRITERS} Body: ${FINDING_FIELDS}; only title is required. The finding starts open. ${BASELINE}`,
      requestBody: jsonBody('The finding'),
      responses: { 201: { description: '{ finding }' }, 400: { description: 'No title' }, ...TM_ONLY } },
  },
  '/v1/company/findings/{id}': {
    get: { tags: ['Company'], summary: 'One finding with its thread', security: bearer,
      description: `${READERS} { finding, comments: [{ id, findingId, author, role, body, createdAt }] }.`,
      parameters: FINDING,
      responses: { 200: { description: 'The finding' }, 403: { description: 'Administrators and certifiers' }, ...NO_FINDING } },
    patch: { tags: ['Company'], summary: 'Edit, classify or baseline a finding', security: bearer,
      description: `${WRITERS} Body: any of ${FINDING_FIELDS}, and status (open | discussing | resolved); values outside a list are ignored. ${BASELINE}`,
      parameters: FINDING,
      requestBody: jsonBody('The fields to change'),
      responses: { 200: { description: '{ finding }' }, 400: { description: 'No field recognised' }, ...TM_ONLY, ...NO_FINDING } },
    delete: { tags: ['Company'], summary: 'Remove a finding and its thread', security: bearer,
      description: `${WRITERS} A baselined finding leaves the data file's knownDeviations. Answer { deleted: true }.`,
      parameters: FINDING,
      responses: { 200: { description: 'Removed' }, ...TM_ONLY, ...NO_FINDING } },
  },
  '/v1/company/findings/{id}/comments': {
    post: { tags: ['Company'], summary: 'Reply on a finding\'s thread', security: bearer,
      description: `${WRITERS} Body: { body }. The reply names its author and role; a first reply moves an open finding to discussing. Answer 201 { comment }.`,
      parameters: FINDING,
      requestBody: jsonBody('{ body }'),
      responses: { 201: { description: 'The reply' }, 400: { description: 'No text' }, ...TM_ONLY, ...NO_FINDING } },
  },
  '/v1/company/findings/suggestions': {
    get: { tags: ['Company'], summary: 'Findings suggested from runs, waiting for a decision (#735)', security: bearer,
      description: `${WRITERS} { drafts: [suggestion], oscarIssues: [suggestion], rejected: <count> }; a suggestion is { id, state, draft, scenarios, runs, occurrences, maybeFindingId, findingId, lastBatchId, decidedBy, decidedAt, createdAt, updatedAt }, the most frequent first.`,
      responses: { 200: { description: 'The suggestions' }, ...TM_ONLY } },
  },
  '/v1/company/findings/suggestions/batches': {
    get: { tags: ['Company'], summary: 'The latest batches whose failures can be read for suggestions (#735)', security: bearer,
      description: `${WRITERS} { batches: [{ batchId, runs, finishedRuns, started, finished }] }, the 30 latest.`,
      responses: { 200: { description: 'The batches' }, ...TM_ONLY } },
  },
  '/v1/company/findings/suggestions/analyse': {
    post: { tags: ['Company'], summary: 'Group a batch\'s failed checks into finding drafts (#735)', security: bearer,
      description: `${WRITERS} Body: { batchId }. By rules only, no model. A failure that matches a finding is reported as still seen and makes no draft; a waiting draft of the same failure is brought up to date; a rejected one or one marked OSCAR's is not suggested again. Answer: { batch: { batchId, runs, finishedRuns, failures, truncated }, groups, created, updated, suppressed, stillSeen, notSeen }. At most 10 a minute.`,
      requestBody: jsonBody('{ batchId }'),
      responses: { 200: { description: 'The result' }, ...TM_ONLY, 404: { description: 'No batch of this company with that id' }, 429: { description: 'Too many analyses' } } },
  },
  '/v1/company/findings/suggestions/{id}/accept': {
    post: { tags: ['Company'], summary: 'Accept a draft: it becomes a finding (#735)', security: bearer,
      description: `${WRITERS} Body: optional, any of ${FINDING_FIELDS}, over the draft's. Answer 201 { finding, suggestion }. ${BASELINE}`,
      parameters: SUGGESTION,
      requestBody: jsonBody('Fields changed from the draft', false),
      responses: { 201: { description: 'The finding' }, 400: { description: 'No title' }, ...DECIDED } },
  },
  '/v1/company/findings/suggestions/{id}/oscar-issue': {
    post: { tags: ['Company'], summary: 'Mark a draft as an issue of OSCAR itself, never a finding (#735)', security: bearer,
      description: `${WRITERS} The draft stays listed under oscarIssues and that failure is not suggested again. Answer { suggestion }.`,
      parameters: SUGGESTION,
      responses: { 200: { description: 'Marked' }, ...DECIDED } },
  },
  '/v1/company/findings/suggestions/{id}/reject': {
    post: { tags: ['Company'], summary: 'Reject a draft; that failure is not suggested again (#735)', security: bearer,
      description: `${WRITERS} Answer { suggestion }.`,
      parameters: SUGGESTION,
      responses: { 200: { description: 'Rejected' }, ...DECIDED } },
  },
  '/v1/company/ai-analysis/checklist': {
    get: { tags: ['Company'], summary: 'The provider\'s set-up checklist given to the AI analysis, if one is imported (#827)', security: bearer,
      description: `${CHECKLIST_WHO} ${CHECKLIST_VIEW}: sent is the number of answers the analysis receives, cut whether some were left out for size.`,
      responses: { 200: { description: 'The checklist, or null' }, ...TM_ONLY } },
    post: { tags: ['Company'], summary: 'Import a filled set-up checklist for the AI analysis (#827)', security: bearer,
      description: `${CHECKLIST_WHO} The role is checked before the upload is read; the file (.docx, 5 MB at most) is read in memory and not kept. Only its answers are stored, encrypted, never the API configuration or contact answers; an import replaces the previous one. Answers ${CHECKLIST_VIEW}.`,
      requestBody: fileBody('checklist', 'The filled checklist (.docx)'),
      responses: { 200: { description: 'Imported' }, 400: { description: 'No file, not a .docx, or not a readable checklist' }, ...TM_ONLY, 413: { description: 'Over 5 MB' }, 429: { description: 'Too many requests' } } },
    delete: { tags: ['Company'], summary: 'Remove the imported checklist (#827)', security: bearer,
      description: CHECKLIST_WHO,
      responses: { 204: { description: 'Removed' }, ...TM_ONLY, 404: { description: 'No checklist imported here' } } },
  },
};
