// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * OpenAPI entries of the run routes (routes/runs.js, /v1/runs) and of the
 * report routes (routes/reports.js, /v1/reports) that openapi.js does not
 * describe itself.
 */

const { bearer, pathParam, queryParam, jsonBody } = require('./common');

const runs = ['Runs'];
const reports = ['Reports'];

const runId = pathParam('id', 'Run id');
const batchId = pathParam('batchId', 'Batch id (batch_id of its runs)');
const integerPath = (name, description) => ({ name, in: 'path', required: true, description, schema: { type: 'integer' } });

const ok = (description) => ({ 200: { description } });
const noRun = { 404: { description: 'No run the caller may see' } };
const noBatch = { 404: { description: 'No run of the batch the caller may see' } };
const testManagersOnly = { 403: { description: 'Test Managers only' } };

// Who reads a run: the visibility rule, widened for a run shared with the reader's company.
const READ_RULE = 'Readable by whoever may see the run (own company or provider; a certifier only for a run shared with certifiers; never an administrator), or by a Test Manager of a company the run is shared with (#901), for whom the distributor\'s people are named by the distributor.';

/** A read of one run: GET, with the run id and the read rule. */
function runRead(summary, description, extra = {}) {
  return {
    get: {
      tags: runs, summary, security: bearer,
      description: `${READ_RULE} ${description}`,
      parameters: [runId, ...(extra.parameters || [])],
      responses: { ...ok(extra.ok || 'The answer'), ...noRun, ...(extra.responses || {}) },
    },
  };
}

/** Share with certifiers or with the operating company, one run or one batch. */
function shareOps(target, one, summaries, descriptions, conflicts) {
  const param = one ? runId : batchId;
  const missing = one ? noRun : noBatch;
  return {
    post: { tags: runs, summary: summaries[0], security: bearer, description: descriptions[0], parameters: [param],
      responses: { ...ok(`Shared ${target}`), ...testManagersOnly, ...missing, ...(conflicts || {}) } },
    delete: { tags: runs, summary: summaries[1], security: bearer, description: descriptions[1], parameters: [param],
      responses: { ...ok('Revoked'), ...testManagersOnly, ...missing } },
  };
}

const TM_SEES = 'Test Managers only, on runs they may see (own company or its providers; 404 otherwise).';

module.exports = {
  '/v1/runs/queue-status': {
    get: { tags: runs, summary: 'The queued and running runs of the company, and its run slots', security: bearer,
      description: 'For the request\'s company (or provider). { company_id, concurrent_limit (Test Framework concurrentSessionLimit, default 1), slots_used, slots_available, runs: [{ id, status, scenario_code, batch_id, user_email, is_current_user, position, queued_at, started_at }] }; position is the place in the queue of a QUEUED run.',
      responses: ok('Queue state') },
  },
  '/v1/runs/stop-all': {
    post: { tags: runs, summary: 'Stop the caller\'s queued and running runs at once', security: bearer,
      description: 'Queued runs leave the queue, running ones have their process ended; all are marked CANCELLED. A tester or Test Manager stops only the runs they started; an administrator stops every active run of the server. Audited. Answer: { stopped, running_cancelled, queued_cancelled, processes_killed, scope: own | platform }.',
      responses: { ...ok('What was stopped'), 403: { description: 'Certifiers cannot stop runs' } } },
  },
  '/v1/runs/batch/{batchId}': {
    get: { tags: runs, summary: 'The runs of a batch and their status counts', security: bearer,
      description: 'Only the runs of the batch the caller may see (the run visibility rule). { batch_id, total, completed, running, queued, failed, cancelled, runs: [{ id, status, scenario_code, queued_at, started_at, completed_at, exit_code }] }.',
      parameters: [batchId],
      responses: { ...ok('The batch'), ...noBatch } },
  },
  '/v1/runs/batch/{batchId}/reports.zip': {
    get: { tags: runs, summary: 'Every report of a batch in one ZIP file', security: bearer,
      description: 'application/zip, one entry per stored artifact of each run of the batch in the request\'s company that the caller may see, named after its scenario. Limited to 30 downloads a minute.',
      parameters: [batchId],
      responses: { 200: { description: 'The ZIP file', content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } } },
        403: { description: 'No company context' }, 404: { description: 'No run of the batch the caller may see, or no report yet' },
        429: { description: 'Too many downloads' }, 500: { description: 'The archive could not be built' } } },
  },
  '/v1/runs/batch/{batchId}/share': shareOps('with certifiers', false,
    ['Share the finished runs of a batch with certifiers (#1041)', 'Revoke certifier access to every run of a batch (#1041)'],
    [`${TM_SEES} Runs not finished are not shared and come back with their reason; runs already shared keep who shared them and when. Audited per run. Answer: { shared, runs: [{ id, shared, reason? }] }.`,
      `${TM_SEES} Audited per run changed. Answer: { runs: [{ id, shared: false }] }.`]),
  '/v1/runs/batch/{batchId}/share-with-operator': shareOps('with the operating company', false,
    ['Share the runs of a batch with the company that operates the provider (#901)', 'Stop sharing the runs of a batch with the operating company (#901)'],
    [`${TM_SEES} Each finished run of a provider whose operator link is accepted is shared; the others come back with their reason. Audited per run. Answer: { shared, runs: [{ id, shared, reason? }] }.`,
      `${TM_SEES} Answer: { runs: [{ id, shared: false }] }.`]),
  '/v1/runs/{id}/logs': runRead('The log lines of a run',
    'Up to 500 lines after since_id, oldest first: { run_id, status, events: [{ id, ts, level, message, category, phase, suite_name, request_name, http_status }], has_more }. With search, up to 5,000 lines are read and the matching ones (at most 500) returned.',
    { ok: 'Log lines', parameters: [
      queryParam('since_id', 'Only lines with a larger id (the last id received)', { type: 'integer' }),
      queryParam('category', 'Only lines of this category'),
      queryParam('phase', 'Only lines of this phase'),
      queryParam('suite', 'Only lines of this suite'),
      queryParam('search', 'Only lines holding this text (case ignored)'),
    ] }),
  '/v1/runs/{id}/assertions': runRead('The checks of a run, by suite and request',
    '{ run_id, summary: { total, passed, failed }, by_category, by_domain, suites: [{ …, requests: [{ …, request_body, request_headers, response_body, response_headers, context, assertions }] }] }; bodies and headers as stored for the run.',
    { ok: 'The checks', parameters: [
      queryParam('status', 'passed or failed: only those checks', { type: 'string', enum: ['passed', 'failed'] }),
      queryParam('category', 'Only checks of this category'),
      queryParam('domain', 'Only checks of this domain'),
      queryParam('suite', 'Only this suite'),
    ] }),
  '/v1/runs/{id}/requests': runRead('The HTTP requests of a run, without bodies',
    '{ run_id, total, filter, scenario, requests: [{ id, suite_id, scenario_name, suite_name, request_name, http_method, http_url, http_status, duration_ms, parent_request_id, passed, failed, has_request_body, has_response_body }] }, in the order sent.',
    { ok: 'The requests', parameters: [
      queryParam('status_filter', 'failed: a non-2xx status or a failed check; non2xx: a non-2xx status; all (default)', { type: 'string', enum: ['all', 'failed', 'non2xx'], default: 'all' }),
      queryParam('scenario', 'Only this scenario'),
    ] }),
  '/v1/runs/{id}/requests/{reqId}': runRead('One HTTP request of a run, with its bodies and headers',
    '{ request (bodies, headers and context as stored for the run), parent, children }; parent and children are short summaries without bodies.',
    { ok: 'The request', parameters: [integerPath('reqId', 'Request id within the run')],
      responses: { 404: { description: 'No run the caller may see, or no such request in it' } } }),
  '/v1/runs/{id}/artifacts': runRead('The stored reports of a run',
    '{ run_id, artifacts: [{ id, type, filename }] }; type html_report or json_results.',
    { ok: 'The artifacts' }),
  '/v1/runs/{id}/artifacts/{aid}': runRead('Download one stored report of a run',
    'Served inline: text/html for an HTML report, else application/json.',
    { ok: 'The file', parameters: [pathParam('aid', 'Artifact id')],
      responses: { 403: { description: 'The stored file is not where artifacts are kept' },
        404: { description: 'No run the caller may see, no such artifact, or its file is missing' },
        500: { description: 'The file could not be read' } } }),
  '/v1/runs/{id}/share': shareOps('with certifiers', true,
    ['Share a finished run with certifiers', 'Revoke certifier access to a run'],
    [`${TM_SEES} A certifier can read a run only once it is shared. Audited. Answer: { ok, run: { id, shared_with_certifier_at, shared_with_certifier_by } }.`,
      `${TM_SEES} Certifiers lose access at once. Audited. Answer: { ok, run: { id, shared_with_certifier_at: null } }.`],
    { 409: { description: 'The run is not finished (COMPLETED, FAILED or CANCELLED)' } }),
  '/v1/runs/{id}/share-with-operator': shareOps('with the operating company', true,
    ['Share a finished run of a provider with the company that operates it (#901)', 'Stop sharing a run with the operating company (#901)'],
    [`${TM_SEES} The provider must be linked to that company and the link accepted; that company\'s Test Managers can then read the run. Audited. Answer: { ok, run: { id, shared } }.`,
      `${TM_SEES} Audited when a share was revoked. Answer: { ok, run: { id, shared: false } }.`],
    { 409: { description: 'Not a provider\'s run, no accepted operator link, or the run is not finished' } }),

  '/v1/reports/comparisons': {
    get: { tags: reports, summary: 'The stored run comparisons', security: bearer,
      description: 'The request\'s company: up to 100, newest first, of runs not deleted. A certifier naming no company gets up to 200 across companies, only those whose two runs are shared with certifiers; an administrator gets an empty list. { comparisons: [{ id, run_a_id, run_b_id, created_at, run_a_date, run_b_date }] }.',
      responses: ok('The comparisons') },
  },
  '/v1/reports/comparisons/{id}': {
    get: { tags: reports, summary: 'One stored run comparison', security: bearer,
      description: 'Only when the caller may see both runs (the run visibility rule). { id, created_at, run_a, run_b, …the stored diff }.',
      parameters: [pathParam('id', 'Comparison id')],
      responses: { ...ok('The comparison'), 404: { description: 'No such comparison, or one of its runs not visible to the caller' } } },
  },
  '/v1/reports/configured': {
    post: { tags: reports, summary: 'A filtered report over several runs (Report Builder)', security: bearer,
      description: 'Body: { run_ids, filters: { status: passed | failed, categories, domains, severities }, title }. Every run must be one the caller may see. Answer: { title, generated_at, filters, run_ids, summary, by_domain, by_category, suites, events, capability_matrix, offer_options, assertions }.',
      requestBody: jsonBody('{ run_ids, filters?, title? }'),
      responses: { ...ok('The report'), 400: { description: 'No run_ids' }, 403: { description: 'A run the caller may not see: foreign_run_ids' } } },
  },
  '/v1/reports/requests/{id}/messages': {
    get: { tags: reports, summary: 'The HTTP exchange of one request of a run, with its neighbours', security: bearer,
      description: 'Only for a run the caller may see. { id, run_id, request_name, suite_name, scenario_name, http_method, http_url, http_status, result, duration_ms, req_headers, req_body, resp_headers, resp_body, prev_id, next_id, position, total, failed_only }; bodies and headers as stored for the run.',
      parameters: [integerPath('id', 'Request id'), queryParam('failed_only', 'true: prev_id, next_id, position and total count failed requests only', { type: 'string', enum: ['true', 'false'] })],
      responses: { ...ok('The exchange'), 400: { description: 'Not a positive integer id' }, 404: { description: 'No such request in a run the caller may see' } } },
  },
  '/v1/reports/templates': {
    get: { tags: reports, summary: 'The saved Report Builder templates', security: bearer,
      description: 'Those of the request\'s company and those of no company. { templates: [{ id, name, config, created_at, updated_at, created_by }] }.',
      responses: ok('The templates') },
    post: { tags: reports, summary: 'Save a Report Builder template', security: bearer,
      description: 'Body: { name, config } (config: the Report Builder\'s choices). Stored for the request\'s company. Answer: { id, name, config }.',
      requestBody: jsonBody('{ name, config? }'),
      responses: { 201: { description: 'Saved' }, 400: { description: 'No name' } } },
  },
  '/v1/reports/templates/{id}': {
    delete: { tags: reports, summary: 'Delete a Report Builder template', security: bearer,
      description: 'The caller\'s own templates; a platform role may delete any.',
      parameters: [pathParam('id', 'Template id')],
      responses: { ...ok('{ deleted: true }'), 403: { description: 'Not the caller\'s template' }, 404: { description: 'No such template' } } },
  },
  '/v1/reports/trends/summary': {
    get: { tags: reports, summary: 'The most failing checks of the company over 30 days', security: bearer,
      description: 'Finished runs of the request\'s company, last 30 days; a certifier counts runs shared with certifiers only, an administrator gets an empty list. { company_id, top_failures: [{ assertion_key, assertion_name, category, domain, severity, run_count, fail_count, pass_rate }] }.',
      parameters: [queryParam('limit', 'At most this many (default 20, at most 50)', { type: 'integer', default: 20, maximum: 50 })],
      responses: { ...ok('The checks'), 400: { description: 'No company context' } } },
  },
  '/v1/reports/trends': {
    get: { tags: reports, summary: 'The last results of one check across runs', security: bearer,
      description: 'Finished runs of the request\'s company, newest first, same role rules as /v1/reports/trends/summary. { assertion_key, points: [{ run_id, passed, error, category, severity, scenario_code, completed_at }] }.',
      parameters: [
        { name: 'assertion_key', in: 'query', required: true, description: 'The check', schema: { type: 'string' } },
        queryParam('limit', 'At most this many (default 20, at most 100)', { type: 'integer', default: 20, maximum: 100 }),
      ],
      responses: { ...ok('The results'), 400: { description: 'No assertion_key, or no company context' } } },
  },
};
