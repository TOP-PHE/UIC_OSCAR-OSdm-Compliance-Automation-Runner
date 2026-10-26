// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * openapi.js — OpenAPI 3.0 spec for OSCAR API.
 *
 * Hand-maintained (no auto-generation) so it stays accurate to actual
 * behavior rather than echoing route comments. Served at:
 *   GET /v1/docs        → Swagger UI (interactive)
 *   GET /v1/openapi.json → raw spec
 *
 * Keep in sync when adding/changing routes.
 */

const pkg = require('../../package.json');

const errorSchema = {
  type: 'object',
  properties: {
    status: { type: 'integer', example: 400 },
    title:  { type: 'string',  example: 'Bad Request' },
    detail: { type: 'string',  example: 'email is required.' },
  },
};

const userSchema = {
  type: 'object',
  properties: {
    id:    { type: 'string', format: 'uuid' },
    email: { type: 'string', format: 'email' },
    role:  { type: 'string', enum: ['administrator', 'certification_user', 'company_user', 'test_manager'] },
  },
};

const runSchema = {
  type: 'object',
  properties: {
    id:                  { type: 'string', format: 'uuid' },
    company_id:          { type: 'string', format: 'uuid' },
    user_id:             { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DELETION_REQUESTED', 'DELETED_BY_ADMIN', 'DELETED'],
    },
    scenario_code:       { type: 'string', nullable: true },
    batch_id:            { type: 'string', format: 'uuid', nullable: true },
    exit_code:           { type: 'integer', nullable: true },
    queued_at:           { type: 'string', format: 'date-time' },
    started_at:          { type: 'string', format: 'date-time', nullable: true },
    completed_at:        { type: 'string', format: 'date-time', nullable: true },
    error_message:       { type: 'string', nullable: true },
  },
};

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'OSCAR API',
    description: `OSDM Conformance Automation Runner — REST API for managing test runs, companies, users, and reports.

**Authentication:** Most endpoints require a Bearer JWT obtained from \`POST /v1/auth/login\`.

**Roles:**
- \`administrator\` — platform-wide access (manage users, companies, server config)
- \`certification_user\` — read-only access across companies (audit/compare reports)
- \`test_manager\` — manages shared scenarios for a company
- \`company_user\` — runs tests for their own company only

**Multi-tenancy:** Company users are automatically scoped to their own company, or to one of its providers named with the \`X-Provider-Id\` header or \`?provider_id=\` (Test Managers: every provider of their company; testers: the providers granted to them; anything else answers 404). Platform users (admin/certifier) can target a specific company via \`?company_id=\` query param or \`X-Company-Id\` header.`,
    version: pkg.version,
    contact: { name: 'UIC — Union Internationale des Chemins de fer' },
  },
  servers: [
    { url: '/', description: 'Current server' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKeyAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'oscar_<prefix>_<secret>', description: 'A read-only API key (#503), on the /v1/api routes only.' },
    },
    schemas: { Error: errorSchema, User: userSchema, Run: runSchema },
  },
  tags: [
    { name: 'Auth',    description: 'Registration, login, JWT issuance' },
    { name: 'Company', description: 'Company profile, datafile, test framework, test resources' },
    { name: 'Runs',    description: 'Test run lifecycle (submit, list, delete, artifacts)' },
    { name: 'Reports', description: 'Run comparison and diff' },
    { name: 'Admin',   description: 'Administrator-only — users, companies, server config, activity' },
    { name: 'Health',  description: 'Liveness/readiness probes' },
    { name: 'API',     description: 'Read-only, by API key (#503)' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Returns 200 if all subsystems healthy, 503 if degraded. Checks DB connectivity, queue, data dir, disk space.',
        responses: {
          200: { description: 'All systems OK' },
          503: { description: 'One or more checks failed' },
        },
      },
    },
    '/v1/auth/register/request': {
      post: {
        tags: ['Auth'],
        summary: 'Request registration (sends verification email)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['email', 'companySlug'],
            properties: {
              email: { type: 'string', format: 'email' },
              companySlug: { type: 'string', description: 'Stable slug of an existing company (from GET /v1/auth/register/companies)' },
            },
          } } },
        },
        responses: {
          200: { description: 'Email sent (or dev-mode URL returned)' },
          400: { description: 'Unknown company (no company with that slug)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          503: { description: 'SMTP failure' },
        },
      },
    },
    '/v1/auth/register/confirm': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm email + set password → creates account',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['token', 'password'],
            properties: { token: { type: 'string', format: 'uuid' }, password: { type: 'string', minLength: 12 } },
          } } },
        },
        responses: {
          201: { description: 'Account created, JWT returned', content: { 'application/json': { schema: {
            type: 'object',
            properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' }, company: { type: 'object' } },
          } } } },
          400: { description: 'Password too short or lacks complexity' },
          404: { description: 'Invalid or already-used token' },
          410: { description: 'Token expired (24h limit)' },
          409: { description: 'Account already created' },
        },
      },
    },
    '/v1/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Authenticate with email + password',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['email', 'password'],
          properties: { email: { type: 'string' }, password: { type: 'string' } },
        } } } },
        responses: {
          200: { description: 'JWT issued', content: { 'application/json': { schema: {
            type: 'object',
            properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' }, company: { type: 'object' } },
          } } } },
          401: { description: 'Invalid credentials' },
        },
      },
    },
    '/v1/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current authenticated user + company',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'User profile' }, 401: { description: 'Unauthorized' } },
      },
    },
    '/v1/runs': {
      get: {
        tags: ['Runs'],
        summary: 'List runs (paginated, scoped to caller\'s company)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'limit',  in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: { 200: { description: 'List of runs', content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            total:  { type: 'integer' },
            limit:  { type: 'integer' },
            offset: { type: 'integer' },
            runs:   { type: 'array', items: { $ref: '#/components/schemas/Run' } },
          },
        } } } } },
      },
      post: {
        tags: ['Runs'],
        summary: 'Submit a new batch of runs (one per scenario, parallel)',
        security: [{ bearerAuth: [] }],
        description: 'Reads scenarios from the company datafile and enqueues one run per scenario. Rate limited to 30 batches/hour/user.',
        requestBody: { content: { 'application/json': { schema: {
          type: 'object', properties: { parallel: { type: 'boolean', default: true } },
        } } } },
        responses: {
          202: { description: 'Batch accepted', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              batch_id:         { type: 'string', format: 'uuid' },
              parallel:         { type: 'boolean' },
              concurrent_limit: { type: 'integer' },
              runs:             { type: 'array', items: { $ref: '#/components/schemas/Run' } },
            },
          } } } },
          400: { description: 'Company config invalid (no datafile, missing creds, etc.)' },
          403: { description: 'certification_user cannot start runs' },
          429: { description: 'Rate limit exceeded' },
        },
      },
    },
    '/v1/runs/{id}': {
      get: {
        tags: ['Runs'],
        summary: 'Get a single run',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Run detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/Run' } } } }, 404: { description: 'Not found' } },
      },
      delete: {
        tags: ['Runs'],
        summary: 'Soft-delete a run',
        description: 'Tester → DELETION_REQUESTED. Admin → DELETED_BY_ADMIN.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Soft-deleted' },
          403: { description: 'certification_user cannot delete; tester cannot delete other users\' runs' },
          409: { description: 'Run is QUEUED/RUNNING and not stale' },
          404: { description: 'Not found' },
        },
      },
    },
    '/v1/runs/{id}/cancel': {
      delete: {
        tags: ['Runs'],
        summary: 'Cancel a queued run',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Cancelled' }, 409: { description: 'Run is not QUEUED' } },
      },
    },
    '/v1/runs/bulk-delete': {
      post: {
        tags: ['Runs'],
        summary: 'Soft-delete up to 50 runs in one call',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['run_ids'],
          properties: { run_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 } },
        } } } },
        responses: { 200: { description: 'Bulk delete result with deleted/skipped/not_found arrays + new_status' } },
      },
    },
    '/v1/runs/bulk-admin-action': {
      post: {
        tags: ['Runs'],
        summary: 'Admin batch operation on deleted runs',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['action', 'run_ids'],
          properties: {
            action:  { type: 'string', enum: ['soft_delete', 'confirm_delete', 'purge', 'restore'] },
            run_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 50 },
          },
        } } } },
        responses: { 200: { description: 'Action result' }, 403: { description: 'Administrator only' } },
      },
    },
    '/v1/reports/compare': {
      post: {
        tags: ['Reports'],
        summary: 'Compare two runs and produce a diff',
        security: [{ bearerAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['run_a_id', 'run_b_id'],
          properties: { run_a_id: { type: 'string', format: 'uuid' }, run_b_id: { type: 'string', format: 'uuid' } },
        } } } },
        responses: { 200: { description: 'Diff result' } },
      },
    },
    '/v1/admin/users': {
      get: { tags: ['Admin'], summary: 'List/search users', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: { 200: { description: 'User list' }, 403: { description: 'Administrator only' } } },
      post: { tags: ['Admin'], summary: 'Create user', security: [{ bearerAuth: [] }],
        responses: { 201: { description: 'User created' }, 409: { description: 'Email already used' } } },
    },
    '/v1/admin/backup-status': {
      get: { tags: ['Admin'], summary: 'Disaster-recovery status (read only, #572)', security: [{ bearerAuth: [] }],
        description: 'What the host backup scripts recorded in data/backup-status.json: last backup (date, size, ok), frequency, next run, retention, archives present, last restore drill, and warnings. state is none (no backup recorded yet), unreadable, or reported. No route creates, schedules or downloads a backup.',
        responses: { 200: { description: 'The status' }, 403: { description: 'Administrators only' }, 429: { description: 'Too many reads' } } },
    },
    '/v1/admin/config': {
      get: { tags: ['Admin'], summary: 'Get server config + server info', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Current config and server info' } } },
      patch: { tags: ['Admin'], summary: 'Update one or more config values (takes effect immediately)', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Updated config' }, 400: { description: 'Validation failed' } } },
    },
    '/v1/admin/rotate-jwt-secret': {
      post: { tags: ['Admin'], summary: 'Rotate the JWT secret — invalidates ALL existing sessions', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Rotated' } } },
    },
    '/v1/company/ai-analysis/access': {
      get: { tags: ['Company'], summary: 'Where the Test Manager stands on the AI analysis, and the commitment text to accept (#801)', security: [{ bearerAuth: [] }],
        description: 'Asked and decided per company or provider. targets: the distributor and each provider the Test Manager may use, each { id, name, provider, state, request }; state: none | pending | approved | needs_acceptance. commitment: { version, title, points, hash }.',
        responses: { 200: { description: 'Access state' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/ai-analysis/access/request': {
      post: { tags: ['Company'], summary: 'Ask for access to the AI analysis, accepting the commitment text (#801)', security: [{ bearerAuth: [] }],
        description: 'Body: { version, hash, companies } — the text accepted, as GET returned it, and the ids of the targets asked for. A new request waits for an administrator (201); an approved Test Manager accepting a new version keeps the approval (200).',
        responses: { 200: { description: 'New text accepted, access kept' }, 201: { description: 'Request waiting for an administrator' }, 400: { description: 'Not the text in force, or no target named' }, 403: { description: 'Test Managers only' }, 404: { description: 'A target the Test Manager may not use' }, 409: { description: 'A target already waiting or already approved' } } },
    },
    '/v1/company/ai-analysis/config': {
      get: { tags: ['Company'], summary: 'The Test Manager\'s AI service for the request\'s company or provider (#801)', security: [{ bearerAuth: [] }],
        description: 'Per (company or provider, Test Manager), where that Test Manager\'s access is approved; the company or provider is the request\'s (X-Provider-Id). config: { connector, baseUrl, model, hasKey, monthlyTokenCap, instruction, testedAt, updatedAt } or null; the key is never returned. connectors: [{ id, label, defaultBaseUrl, keyRequired }]. #848: mode (shared | per_provider) and serviceOf { id, name }, the company whose service is used (the distributor\'s when shared); PUT, test and DELETE act on that service.',
        responses: { 200: { description: 'The AI service' }, 403: { description: 'Test Managers only, with approved access' } } },
      put: { tags: ['Company'], summary: 'Save the AI service; a new service, address, model or key is tested first (#801)', security: [{ bearerAuth: [] }],
        description: 'Body: { connector: anthropic | openai_compatible, baseUrl (https, public host), model, apiKey (empty = keep the stored one; required again for another service or host), monthlyTokenCap, instruction }. Nothing is saved when the test fails (422, with the test).',
        responses: { 200: { description: '{ config, test }' }, 201: { description: 'First save: { config, test }' }, 400: { description: 'A field refused, or the key to type again' }, 403: { description: 'Test Managers only, with approved access' }, 422: { description: 'The connection test failed: { detail, test }' } } },
      delete: { tags: ['Company'], summary: 'Remove the AI service, key included (#801)', security: [{ bearerAuth: [] }],
        description: 'Allowed whether or not the access is still approved.',
        responses: { 204: { description: 'Removed' }, 404: { description: 'Nothing configured' } } },
    },
    '/v1/company/ai-analysis/config/test': {
      post: { tags: ['Company'], summary: 'Test the AI service: the stored one, or the one given, without saving (#801)', security: [{ bearerAuth: [] }],
        description: 'One small request ("reply with the single word OK"). Body: empty to test the stored service, or the same fields as PUT. Answer: { test: { ok, answer, stopReason, model, usage: { input, output }, ms } | { ok: false, error, status } }.',
        responses: { 200: { description: 'The test result' }, 400: { description: 'A field refused' }, 403: { description: 'Test Managers only, with approved access' }, 404: { description: 'Nothing configured, and nothing given' } } },
    },
    '/v1/company/ai-analysis/config/models': {
      post: { tags: ['Company'], summary: 'The models an Anthropic AI service offers (#831)', security: [{ bearerAuth: [] }],
        description: 'Body: empty for the stored service, or { connector: anthropic, baseUrl, apiKey? }; a stored key only goes to the host it was typed for. Asks the service\'s GET /v1/models. Answer: { models: [{ id, label, input, output, note, above }] }, prices in US dollars per million tokens when OSCAR knows them, else null.',
        responses: { 200: { description: 'The models' }, 400: { description: 'Not an Anthropic service, or a field refused' }, 403: { description: 'Test Managers only, with approved access' }, 404: { description: 'Nothing configured, and nothing given' }, 502: { description: 'The service refused or did not answer' } } },
    },
    '/v1/company/ai-analysis/setup': {
      get: { tags: ['Company'], summary: 'One AI service for all, or one per provider, and the services stored (#848)', security: [{ bearerAuth: [] }],
        description: 'Per (distributor, Test Manager). { company, mode: shared | per_provider, modes, services: [{ company: { id, name, provider }, connector, model, inUse }] }. No choice made reads as shared: the distributor\'s service is used for every company or provider whose access is approved.',
        responses: { 200: { description: 'The set-up' }, 403: { description: 'Test Managers only' } } },
      put: { tags: ['Company'], summary: 'Choose one AI service for all, or one per provider (#848)', security: [{ bearerAuth: [] }],
        description: 'Body: { mode: shared | per_provider }. No service is deleted: those not used by the new mode are kept and listed with inUse false. Access stays per company or provider.',
        responses: { 200: { description: 'The set-up' }, 400: { description: 'Not one of the two modes' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/ai-analysis/overview': {
      get: { tags: ['Company'], summary: 'Per company or provider: access, AI service used, analyses and their cost, with the totals (#848)', security: [{ bearerAuth: [] }],
        description: '{ company, mode, currency, targets: [{ id, name, provider, access, service: { connector, model, of: { id, name } } | null, analyses, tokens, cost, unpriced }], totals: { analyses, tokens, cost, unpriced } }. The analyses are every Test Manager\'s, as the history shows them; the service is the reader\'s. Costs at the model\'s list price in US dollars, an estimate.',
        responses: { 200: { description: 'The overview' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/ai-analysis/spend': {
      get: { tags: ['Company'], summary: 'What the AI analyses of the request\'s company or provider cost (#831)', security: [{ bearerAuth: [] }],
        description: 'Every Test Manager\'s analyses, at the model\'s list price in US dollars (or the price entered for a model OSCAR does not know). { currency, today, month, months: [{ month, … }], models: [{ model, … }], mine: { cap, used } }, each with { analyses, tokens, cost, unpriced }.',
        responses: { 200: { description: 'Spend' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/ai-analysis/batches': {
      get: { tags: ['Company'], summary: 'The batches an AI analysis can read, for the request\'s company or provider (#801)', security: [{ bearerAuth: [] }],
        description: 'Test Managers with approved access only. { batches: [{ batchId, runs, finishedRuns, started, finished }], languages }.',
        responses: { 200: { description: 'Batches' }, 403: { description: 'Test Managers only, with approved access' } } },
    },
    '/v1/company/ai-analysis/preview': {
      post: { tags: ['Company'], summary: 'Exactly what an AI analysis would send, its size and estimated tokens (#801)', security: [{ bearerAuth: [] }],
        description: 'Body: { batches: [id] | [id, id], language, model? } (#831: model, the configured one by default; price, estimatedCost { input, atMost }, configuredModel and contentHash in the answer). Two batches are compared, the earlier first. Sends nothing. Answer: { mode, batches, model, instructions, input, chars, estimatedTokens, summarisedByStep, tooLarge, counts, monthly: { cap, used }, hash }. The input holds the failed checks with the run\'s values replaced, the scenario codes and descriptions, the Test Framework\'s declarations and the findings (title, category, step); never a token, credential, endpoint, response body or passenger detail.',
        responses: { 200: { description: 'The preview' }, 400: { description: 'No batch, or the same one twice' }, 403: { description: 'Test Managers only, with approved access' }, 404: { description: 'No such batch here' }, 409: { description: 'No AI service configured here' } } },
    },
    '/v1/company/ai-analysis/run': {
      post: { tags: ['Company'], summary: 'Send what the preview showed and analyse it (#801)', security: [{ bearerAuth: [] }],
        description: 'Body: the preview\'s { batches, language, model } and its { hash }. Answers 202 { id, status: running }; read the result with GET /history/{id}. Refused when what would be sent changed since the preview, when the monthly token limit would be passed, or when another of the Test Manager\'s analyses is running.',
        responses: { 202: { description: 'Started' }, 403: { description: 'Test Managers only, with approved access' }, 409: { description: 'Changed since the preview, monthly limit, another analysis running, or no AI service' }, 422: { description: 'Too large to send' } } },
    },
    '/v1/company/ai-analysis/history': {
      get: { tags: ['Company'], summary: 'The AI analyses of the request\'s company or provider (#801)', security: [{ bearerAuth: [] }],
        description: 'Every Test Manager who may use the company or provider. { analyses: [{ id, mode, batches, language, connector, model, status, by, inputChars, summarisedByStep, inputHash, contentHash, tokens, cost, error, createdAt, finishedAt }] } (cost in US dollars, #831), the 50 latest. status: running | done | unreadable | failed | interrupted.',
        responses: { 200: { description: 'Analyses' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/ai-analysis/fault-detection': {
      get: { tags: ['Company'], summary: 'Which faults asked of the OSDM simulator a batch detected, and whether an AI analysis explained them (#833)', security: [{ bearerAuth: [] }],
        description: 'For the runs of a batch whose scenario names `simulatorFaults`: { batch, runs, faults: [{ runId, scenarioCode, code, title, known, expectations: [{ step, check, level, found }], detected, asExpected }], summary: { injected, unknown, detected, asExpected }, analysis }. With `analysis` (an analysis that read the batch): { id, model, status, judged: [{ code, verdict: explained | misattributed | missed, group }], summary: { judged, explained, misattributed, missed, score } }. Reads the runs only; no model is called.',
        parameters: [{ name: 'batch', in: 'query', required: true, schema: { type: 'string' } }, { name: 'analysis', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { 200: { description: 'The report' }, 400: { description: 'That analysis did not read this batch' }, 403: { description: 'Test Managers only' }, 404: { description: 'No such batch or analysis here' } } },
    },
    '/v1/company/ai-analysis/history/{id}': {
      get: { tags: ['Company'], summary: 'One AI analysis with its result (#801)', security: [{ bearerAuth: [] }],
        description: 'The same fields, plus result: { summary, groups: [{ title, cause, owner: provider | oscar | configuration | unclear, why, action, steps, scenarios }], comparison: { fixed, stillFailing, new } }, or { raw } when the answer could not be read; and drafts: { <group index>: { id, state } }, the finding drafts made from its groups (#823).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The analysis' }, 404: { description: 'Not one of this company or provider' } } },
    },
    '/v1/company/ai-analysis/history/{id}/download': {
      get: { tags: ['Company'], summary: 'An AI analysis\'s groups with the failing requests of each, as one Markdown file (#867)', security: [{ bearerAuth: [] }],
        description: 'The readers of GET /history/{id}. `oscar-analysis-<date>-<company>.md`: per group (in the analysis\'s order) its owner, title, explanation, evidence, next step, steps and scenarios, then the failing requests of the analysed batches at those steps and scenarios: the first of each run and step, at most 3 a group, the others counted. Each request gives its method, the path and query of its address, its body, the HTTP status and the body received, as stored (not masked). Never written: headers, the endpoint\'s host, credentials in the query or in a body member named like one. A body is cut at 20 KB, the file at 4 MB, each saying where.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The Markdown file', content: { 'text/markdown': { schema: { type: 'string' } } } }, 403: { description: 'Test Managers only' }, 404: { description: 'Not one of this company or provider' }, 409: { description: 'The analysis has no result' } } },
    },
    '/v1/company/ai-analysis/history/{id}/groups/{index}/draft': {
      post: { tags: ['Company'], summary: 'A group of an AI analysis as a finding draft (#823)', security: [{ bearerAuth: [] }],
        description: 'The group joins the suggested findings of Test Findings (#735), where a Test Manager accepts, edits or rejects it. The draft names the analysis and its model; the AI\'s owner is shown in it, and the category stays "open". One draft per group. Answers 201 { suggestion: { id, state, draft } }.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'index', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }],
        responses: { 201: { description: 'The draft' }, 403: { description: 'Test Managers only' }, 404: { description: 'No such analysis or group here, or the analysis is not done' }, 409: { description: 'This group already has a draft' } } },
    },
    '/v1/admin/ai-access-requests': {
      get: { tags: ['Admin'], summary: 'Test Managers\' requests for the AI analysis (#801)', security: [{ bearerAuth: [] }],
        responses: { 200: { description: '{ textVersion, requests: [{ id, state, textVersion, acceptedAt, decidedAt, decidedBy, reason, company, user }] }' } } },
    },
    '/v1/admin/ai-access-requests/{id}/{decision}': {
      post: { tags: ['Admin'], summary: 'Approve or refuse a pending request, or withdraw an approved access (#801)', security: [{ bearerAuth: [] }],
        description: 'decision: approve | refuse | revoke. Body: { reason } (required to refuse or withdraw; the Test Manager reads it). The Test Manager is told by e-mail.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'decision', in: 'path', required: true, schema: { type: 'string', enum: ['approve', 'refuse', 'revoke'] } }],
        responses: { 200: { description: '{ id, state }' }, 400: { description: 'No reason given' }, 404: { description: 'Unknown request or decision' }, 409: { description: 'Not in a state this decision applies to' } } },
    },
    '/v1/company/configuration/download': {
      get: { tags: ['Company'], summary: 'The full configuration: data file, Test Framework and Test Data trains and journeys in one file (#810)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only, for the company the request names (X-Provider-Id). { "__oscarConfiguration": { format: 1, company, exported_by, exported_at }, datafile, framework, testResources: [{ id, resource_type, label, data }] }. No credential, endpoint or dedicated header. The data-file upload refuses this file.',
        responses: { 200: { description: 'The configuration file' }, 403: { description: 'Test Managers only' }, 404: { description: 'No data file, no Test Framework and no Test Data' }, 409: { description: 'The stored data file is not a JSON object' } } },
    },
    '/v1/company/configuration/import': {
      post: { tags: ['Company'], summary: 'Take the chosen parts of a full configuration (#810)', security: [{ bearerAuth: [] }],
        description: 'Multipart: the file in the field "configuration", and the fields scenarios = replace | keep, framework = replace | keep, testData = add | replace | keep. add adds the trains and journeys whose data is not already there; replace removes the trains and journeys first. Journeys name the trains\' new ids. A replaced data file is kept as the previous file. Every part is checked before anything is written; if the database step fails, the data file is put back.',
        responses: { 200: { description: '{ imported, choices, scenarios, framework, testData: { mode, removed, trains_added, journeys_added, already_there, unresolved_legs } }' }, 400: { description: 'Not a configuration, a choice missing, or a part refused (schema problems, template, OSDM version)' }, 403: { description: 'Test Managers only' }, 413: { description: 'Larger than 5 MB' } } },
    },
    '/v1/company/api-keys': {
      get: { tags: ['Company'], summary: 'The read-only API keys of the company or provider (#503)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only, for the company or provider the request names (X-Provider-Id). { company: { id, name }, max_days, default_days, keys: [{ id, name, hint, scopes, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, state: active | expired | revoked }] }. Never the key or its hash.',
        responses: { 200: { description: 'The keys' }, 403: { description: 'Test Managers only' } } },
      post: { tags: ['Company'], summary: 'Make a read-only API key (#503)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only. Body: { name (1-80 characters), expires_in_days (1-365, default 90) }. The answer carries `key`, shown this once; OSCAR keeps only its sha256. The key reads the runs of this company or provider, on /v1/api only.',
        responses: { 201: { description: 'The key, with `key`' }, 400: { description: 'No name, or a lifetime outside 1-365 days' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/api-keys/{id}': {
      delete: { tags: ['Company'], summary: 'Revoke an API key (#503)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only. Effective at once. Revoking a revoked key changes nothing.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The key, revoked' }, 403: { description: 'Test Managers only' }, 404: { description: 'Not a key of this company or provider' } } },
    },
    '/v1/api/key': {
      get: { tags: ['API'], summary: 'The API key making the request: name, company, scopes, expiry (#503)', security: [{ apiKeyAuth: [] }],
        description: 'Authorization: Bearer <key> only (never a cookie or a URL parameter). Any refusal is the same 401. Every other route outside /v1/api refuses a key.',
        responses: { 200: { description: '{ name, hint, company: { id, name }, scopes, created_at, expires_at }' }, 401: { description: 'Missing, invalid, expired or revoked key' }, 429: { description: 'Too many requests' } } },
    },
    '/v1/api/runs': {
      get: { tags: ['API'], summary: 'The runs of the key\'s company or provider, newest first (#503)', security: [{ apiKeyAuth: [] }],
        description: 'Only the runs of the company or provider the key was made for (not its providers), never a deleted one. Each run: { id, status, scenario_code, batch_id, queued_at, started_at, completed_at, exit_code, checks: { total, passed, failed } }. No body, log, URL, endpoint or person is answered.',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] } },
          { name: 'batch_id', in: 'query', schema: { type: 'string', maxLength: 200 } },
          { name: 'scenario_code', in: 'query', schema: { type: 'string', maxLength: 200 } },
        ],
        responses: { 200: { description: '{ total, limit, offset, runs: [run] }' }, 400: { description: 'A parameter that is not one of the values above' }, 401: { description: 'Missing, invalid, expired or revoked key' }, 429: { description: 'Too many requests' } } },
    },
    '/v1/api/runs/{id}': {
      get: { tags: ['API'], summary: 'One run and its check counts (#503)', security: [{ apiKeyAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'The run, as in the list' }, 401: { description: 'Missing, invalid, expired or revoked key' }, 404: { description: 'No such run, or not one of the key\'s company' } } },
    },
    '/v1/api/runs/{id}/assertions': {
      get: { tags: ['API'], summary: 'The checks of a run: suites, requests, checks (#503)', security: [{ apiKeyAuth: [] }],
        description: '{ run, suites: [{ scenario, name, duration_ms, checks, requests: [{ name, method, http_status, result, capability, duration_ms, checks, assertions: [{ name, type, passed, category, domain, offer_part, severity, error, expected, actual }] }] }] }. No request or response body, header or URL.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'result', in: 'query', schema: { type: 'string', enum: ['passed', 'failed'] }, description: 'Only the checks that passed, or failed' },
        ],
        responses: { 200: { description: 'The checks' }, 400: { description: 'result is not passed or failed' }, 401: { description: 'Missing, invalid, expired or revoked key' }, 404: { description: 'No such run, or not one of the key\'s company' } } },
    },
    '/v1/api/batches/{batchId}': {
      get: { tags: ['API'], summary: 'The runs of one batch, with counts by status (#503)', security: [{ apiKeyAuth: [] }],
        parameters: [{ name: 'batchId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: '{ batch_id, total, queued, running, completed, failed, cancelled, runs: [run] }' }, 401: { description: 'Missing, invalid, expired or revoked key' }, 404: { description: 'No such batch in the key\'s company' } } },
    },
    '/v1/api/queue': {
      get: { tags: ['API'], summary: 'The queued and running runs of the key\'s company or provider (#503)', security: [{ apiKeyAuth: [] }],
        responses: { 200: { description: '{ running, queued, runs: [{ id, status, scenario_code, batch_id, position, queued_at, started_at }] }' }, 401: { description: 'Missing, invalid, expired or revoked key' } } },
    },
    '/v1/company/reference': {
      get: { tags: ['Company'], summary: 'Which reference configuration of the repository the company or provider follows, and whether it is up to date (#838)', security: [{ bearerAuth: [] }],
        description: '{ available: [{ name, provider, osdmVersion }], linked, applied_version, applied_at, current_version, up_to_date, missing }. The references are read from the collection on the server, never from GitHub.',
        responses: { 200: { description: 'The state' }, 403: { description: 'Administrators and certifiers have no access' } } },
      put: { tags: ['Company'], summary: 'Follow a reference configuration, or none (#838)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only. Body: { name } (simulator-alpha | simulator-beta | simulator-gamma) or { name: null }. Nothing is replaced until the update; another reference forgets the applied version.',
        responses: { 200: { description: 'The new state' }, 400: { description: 'Not one of the references' }, 403: { description: 'Test Managers only' } } },
    },
    '/v1/company/checklists': {
      get: { tags: ['Company'], summary: 'The provider checklists imported here, newest first (#862)', security: [{ bearerAuth: [] }],
        description: 'Test Managers of the company or provider (X-Provider-Id). Each import with its file name, sha256, date, who imported it and what became of it (waiting, applied, discarded). At most 50.',
        responses: { 200: { description: '{ imports: [{ id, fileName, sha256, answers, importedAt, importedBy, status, decidedAt, decidedBy }] }' }, 403: { description: 'Test Managers only' } } },
      post: { tags: ['Company'], summary: 'Import a filled provider checklist (#862)', security: [{ bearerAuth: [] }],
        description: 'Multipart, the .docx in the field "checklist" (5 MB). Changes nothing: the answers are kept encrypted (never api.* or meta.*), the file is not, and an earlier checklist waiting for a decision is discarded. Answers the preview of applying it with testData add and scenarios copy.',
        responses: { 201: { description: 'The preview: { import, previous, answerChanges, framework: { changes, unplaced, created }, testData: { mode, add, remove, alreadyThere, unresolvedLegs }, scenarios: { choice, copy, alreadyThere, notDeclared, noJourney, noTestData } or { choice, unavailable }, skipped, notes, hash }' }, 400: { description: 'Not a filled checklist' }, 403: { description: 'Test Managers only' }, 413: { description: 'Over 5 MB' } } },
    },
    '/v1/company/checklists/{id}/preview': {
      get: { tags: ['Company'], summary: 'What applying a provider checklist would change (#862)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'testData', in: 'query', schema: { type: 'string', enum: ['add', 'replace'] } }, { name: 'scenarios', in: 'query', schema: { type: 'string', enum: ['copy', 'none'] } }],
        description: 'Set against the checklist applied before (else the one imported for the AI analysis): the answers changed, the Test Framework values that change, the Test Data added or removed, and the hash the apply must carry.',
        responses: { 200: { description: 'The preview' }, 400: { description: 'testData is not add or replace, or scenarios not copy or none' }, 404: { description: 'No such checklist here' } } },
    },
    '/v1/company/checklists/{id}/apply': {
      post: { tags: ['Company'], summary: 'Apply a provider checklist to the Test Framework and the Test Data (#862)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['hash'], properties: { hash: { type: 'string' }, testData: { type: 'string', enum: ['add', 'replace'] }, scenarios: { type: 'string', enum: ['copy', 'none'] } } } } } },
        description: 'Only a checklist waiting for a decision, and only with the hash of the preview read: if the Test Framework or the Test Data changed since, 409 with the new preview. Writes both in one transaction and makes the checklist the one the AI analysis is told about. The scenarios, endpoint and credentials are not changed.',
        responses: { 200: { description: '{ applied, import, framework: { changes }, testData, scenarios: { choice, copied, report } or { choice, copied: [], error } }' }, 400: { description: 'No hash, testData not add or replace, or scenarios not copy or none' }, 404: { description: 'No such checklist here' }, 409: { description: 'Not waiting, or changed since the preview' } } },
    },
    '/v1/company/checklists/{id}/discard': {
      post: { tags: ['Company'], summary: 'Set a provider checklist aside (#862)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        description: 'Only a checklist waiting for a decision. It stays in the list of imports.',
        responses: { 200: { description: '{ import }' }, 404: { description: 'No such checklist here' }, 409: { description: 'Not waiting' } } },
    },
    '/v1/company/reference/apply': {
      post: { tags: ['Company'], summary: 'Update the configuration from the reference it follows (#838)', security: [{ bearerAuth: [] }],
        description: 'Test Managers only. Replaces the scenarios (the replaced data file is kept as the previous file), the Test Framework and the Test Data trains and journeys with the reference\'s, as a full configuration import with every part replaced. The endpoint and the credentials are not changed.',
        responses: { 200: { description: '{ applied, reference, scenarios, framework, testData, state }' }, 403: { description: 'Test Managers only' }, 409: { description: 'No reference followed' }, 503: { description: 'The reference cannot be read on this server' } } },
    },
    '/v1/company/scenario-copy/preview': {
      post: { tags: ['Company'], summary: 'Prepare a copy of scenarios from another company or provider of yours into this one', security: [{ bearerAuth: [] }],
        description: 'Body: { source_id } (a company or provider id, or "catalogue" for the scenario catalogue). Returns the source scenarios with warnings (features the target Test Framework does not declare, fulfillment reduced, OSDM version), each trip entry to map once, and the target trains and journeys. The target is the request\'s company (X-Provider-Id).',
        responses: { 200: { description: 'Copy plan' }, 404: { description: 'Unknown or refused source, or no source data file' }, 409: { description: 'The target has no Test Framework or no Test Data' } } },
    },
    '/v1/company/scenario-copy': {
      post: { tags: ['Company'], summary: 'Copy scenarios from another company or provider of yours into this one', security: [{ bearerAuth: [] }],
        description: 'Body: { source_id, codes: [..], trip_map: { "<source trip id>": { type: "train", train_id, service_index } | { type: "journey", journey_id } } }. Copies belong to the caller; a code already used gets the next free one. Endpoint, credentials, known deviations and findings are never copied.',
        responses: { 200: { description: '{ copied: [{ from, to }], hash }' }, 400: { description: 'A trip without a mapping, a missing scenario or entry, a template, or a catalogue entry the Test Framework does not cover' }, 404: { description: 'Unknown or refused source' } } },
    },
    '/v1/company/scenario-catalogue': {
      get: { tags: ['Company'], summary: 'List the reference scenarios of the scenario catalogue, with what each needs the Test Framework to declare', security: [{ bearerAuth: [] }],
        description: 'Each entry: { code, kind, area, purpose, checks, requirements, missing }. missing lists what the company\'s Test Framework does not declare; such an entry cannot be copied. Copy with source_id "catalogue".',
        responses: { 200: { description: 'Catalogue entries' }, 403: { description: 'Administrators and certifiers have no access' }, 503: { description: 'The catalogue cannot be read' } } },
    },
    '/v1/company/coverage': {
      get: { tags: ['Company'], summary: 'How far what the Test Framework declares is tested, from the latest run of each scenario (#956)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 3650, default: 365 }, description: 'Runs queued within this many days are read' }],
        description: 'Answers { days, framework, datafile, collectionVersion, summary, functions, notDeclared, matrix, scenarios }. matrix (#956 part 3): one row per flow and element tested { flow, flowLabel, element, group, label, result (passed | failed | never-run | not-covered | not-declared | declared-not-supported), declaration (declared | not-declared | every-value | declared-not-supported), counts, providerNotSupported, toRunAgain, scenarios, findings }; scenarios: one row per scenario { code, description, flow, elements, result, run, toRunAgain, notDeclared, providerNotSupported }. Each function: { id, group, label, state (passed | failed | never-run | not-covered), toRunAgain, scenarios: [{ code, result, toRunAgain, run }], findings }. byCapability (#972): { summary, capabilities: [{ id, group, label, optional, result (passed | deviation | points | blocked | not-supported | not-tested | out-of-scope), declaration, tests: [{ key, entry, purpose, result, forms: [{ code, form, result, toRunAgain, runId, at, step, check }] }], provenBy: { count, codes }, sideProblems, points }], expectedRefusals: [{ key, entry, purpose, capability, capabilityLabel, result (refused | deviation | not-refused | not-run), forms, points }], points (parts 2 and 3): [{ number, key, keys (its #735 keys), kind (provider | accepted | question | oscar: not counted against the provider), source (check | known-deviation), capability, capabilityLabel, step, steps (one problem at several steps is one point), check, status, problemCode, blocking, occurrences, tests: [{ key, entry, codes }], runs, firstSeen, lastSeen, finding, possibleFinding, expectedRefusal }], apart: [{ code, entry }], notTested: [{ id, group, label, state }] }: a failed check counts only against the capability its scenario is for, the steps a run went through prove theirs, a catalogue entry is one test whatever its forms; a point is one problem whatever the runs that showed it, and a point whose finding is a resolved provider_deviation, or a known deviation the run applied, reads deviation (Passed with deviation). A tester reads the scenarios of their view; the runs and findings are the company\'s or provider\'s of the request.',
        responses: { 200: { description: 'The coverage' }, 400: { description: 'days is not a whole number from 1 to 3650' }, 403: { description: 'Administrators and certifiers have no access' }, 409: { description: 'The data file cannot be read' } } },
    },
    '/v1/company/coverage/download': {
      get: { tags: ['Company'], summary: 'The Test Framework coverage as an Excel workbook (#956 part 3)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'days', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 3650, default: 365 }, description: 'Runs queued within this many days are read' }],
        description: 'The same report as GET /v1/company/coverage, as an .xlsx file: sheets Summary, By flow and element, By scenario, By function. Every text is an inline string (never a formula).',
        responses: { 200: { description: 'The workbook' }, 400: { description: 'days is not a whole number from 1 to 3650' }, 403: { description: 'Administrators and certifiers have no access' }, 409: { description: 'The data file cannot be read' } } },
    },
    '/v1/company/providers': {
      get: { tags: ['Company'], summary: 'List the providers of the caller\'s company (Test Manager: all; tester: those granted)', security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Providers' } } },
      post: { tags: ['Company'], summary: 'Create a provider (Test Manager only)', security: [{ bearerAuth: [] }],
        description: 'Body: { name, api_base?, allow_duplicate_endpoint? }. An endpoint already used by the distributor or another of its providers answers 409 unless allow_duplicate_endpoint is true (audited).',
        responses: { 201: { description: 'Provider created' }, 400: { description: 'Validation failed' }, 403: { description: 'Test Manager role required' }, 409: { description: 'Name or endpoint already used' } } },
    },
    '/v1/company/providers/{id}': {
      patch: { tags: ['Company'], summary: 'Rename a provider (Test Manager only)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Renamed' }, 404: { description: 'Not a provider of this company' } } },
    },
    '/v1/company/providers/{id}/access': {
      get: { tags: ['Company'], summary: 'Testers granted this provider (Test Manager only)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Granted testers' }, 404: { description: 'Not a provider of this company' } } },
    },
    '/v1/company/providers/{id}/access/{userId}': {
      put: { tags: ['Company'], summary: 'Grant a tester of this company the provider (Test Manager only)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
                     { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Granted' }, 404: { description: 'Provider or tester not found' } } },
      delete: { tags: ['Company'], summary: 'Withdraw a tester\'s access to the provider (Test Manager only)', security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
                     { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Withdrawn' }, 404: { description: 'Provider or tester not found' } } },
    },
    '/v1/company/users': {
      get: {
        tags: ['Company'],
        summary: 'List users in the caller\'s company (test_manager only)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
        responses: {
          200: { description: 'Users in this company' },
          403: { description: 'test_manager role required' },
        },
      },
      post: {
        tags: ['Company'],
        summary: 'Create a user in the caller\'s company (test_manager only)',
        description: 'Role must be one of: company_user, test_manager. Platform roles (administrator, certification_user) cannot be assigned through this endpoint.',
        security: [{ bearerAuth: [] }],
        responses: {
          201: { description: 'User created' },
          400: { description: 'Validation failed (invalid role / weak password)' },
          409: { description: 'Email already used' },
        },
      },
    },
    '/v1/company/users/{id}': {
      patch: {
        tags: ['Company'],
        summary: 'Update a user in this company (email or role)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'User updated' },
          400: { description: 'Self-demotion or last-test_manager guard tripped' },
          404: { description: 'User not in this company' },
        },
      },
      delete: {
        tags: ['Company'],
        summary: 'Delete a user in this company (cannot delete self or last test_manager)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'User deleted' },
          400: { description: 'Self-delete or last-test_manager guard tripped' },
          404: { description: 'User not in this company' },
        },
      },
    },
    '/v1/company/users/{id}/reset-password': {
      post: {
        tags: ['Company'],
        summary: 'Reset a company user\'s password (test_manager only)',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Password reset' },
          400: { description: 'Password too weak' },
          404: { description: 'User not in this company' },
        },
      },
    },
    '/v1/me/credentials/test': {
      post: {
        tags: ['Company'],
        summary: 'Test my saved credentials for the company or provider of the request (#872)',
        description: 'Testers and Test Managers; administrators and certifiers get 403. The company or provider is named by X-Provider-Id (none or empty = the own company; one not allowed = 404). Two steps, on what is saved: a token by the path a run takes, forced fresh (the token cache is written as a run writes it, nothing else), then one GET {api_base}/versions with the token and the headers a run sends (Requestor, subscription key, dedicated headers), redirect not followed, 15 s, answer read up to 64 KB. The answer never holds the token or a secret. Ten tests a minute per user. Audited as credentials_tested:<outcome>.',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'X-Provider-Id', in: 'header', required: false, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'The test ran; what it found is in the body, whatever the outcome', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              token: { type: 'object', properties: {
                ok: { type: 'boolean' },
                mode: { type: 'string', enum: ['bearer', 'oauth2'] },
                profile: { type: 'string', nullable: true, description: 'The OAuth profile; null for a bearer token' },
                expiresInSeconds: { type: 'integer', description: 'When known: the token endpoint\'s expires_in, or the exp of a bearer JWT (negative = expired)' },
                error: { type: 'string', description: 'The resolver\'s message (missing fields, the token endpoint\'s HTTP status), secrets masked' },
              } },
              api: { type: 'object', properties: {
                ok: { type: 'boolean', description: 'The token was not refused' },
                outcome: { type: 'string', enum: ['accepted', 'token_refused', 'not_offered', 'redirect', 'unexpected', 'no_answer', 'url_refused', 'no_endpoint', 'not_tried'] },
                status: { type: 'integer', description: 'The HTTP status of GET /versions' },
                versions: { type: 'array', items: { type: 'string' }, description: 'The OSDM versions listed (2xx only)' },
                versionsReadable: { type: 'boolean', description: 'false when a 2xx answer is not a list of ApiVersion' },
                frameworkVersion: { type: 'string', description: 'The Test Framework\'s osdmVersion' },
                frameworkVersionListed: { type: 'boolean' },
                error: { type: 'string', description: 'Why no answer: the kind of failure, or the address policy\'s refusal' },
              } },
              outcome: { type: 'string', description: 'token_failed, else api.outcome' },
              summary: { type: 'string' },
            },
          } } } },
          401: { description: 'Not signed in' },
          403: { description: 'Administrators and certifiers' },
          404: { description: 'A provider the user may not use' },
          429: { description: 'More than ten tests a minute' },
        },
      },
    },
    '/v1/company/places/refresh': {
      post: {
        tags: ['Company'],
        summary: 'Bulk-download the vendor\'s OSDM GET /places list and cache it (test_manager only, #450)',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Cache refreshed', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              place_count: { type: 'integer' },
              cached_at: { type: 'string' },
              truncated: { type: 'boolean', description: 'true if a safety cap stopped the download early' },
            },
          } } } },
          400: { description: 'No OSDM api_base configured for the company' },
          502: { description: 'Token fetch or vendor /places call failed' },
        },
      },
    },
    '/v1/company/places': {
      get: {
        tags: ['Company'],
        summary: 'Cached stop-place metadata, or ?q= full-text lookup (tester + test_manager; admin/certifier denied)',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' }, description: 'Case-insensitive substring over place name + id; omit for cache metadata only' },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 20, maximum: 50 } },
        ],
        responses: {
          200: { description: 'Metadata (no q) or ranked matches (with q)', content: { 'application/json': { schema: {
            type: 'object',
            properties: {
              place_count: { type: 'integer' },
              cached_at: { type: 'string', nullable: true },
              places: {
                type: 'array',
                items: { type: 'object', properties: {
                  id: { type: 'string', example: 'urn:uic:stn:8500010' },
                  name: { type: 'string', example: 'Zürich HB' },
                  objectType: { type: 'string' },
                } },
              },
            },
          } } } },
          403: { description: 'Administrators and certifiers are denied' },
        },
      },
    },
  },
};
