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

**Multi-tenancy:** Company users are automatically scoped to their own company. Platform users (admin/certifier) can target a specific company via \`?company_id=\` query param or \`X-Company-Id\` header.`,
    version: pkg.version,
    contact: { name: 'UIC — Union Internationale des Chemins de fer' },
  },
  servers: [
    { url: '/', description: 'Current server' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
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
            type: 'object', required: ['email', 'companyName'],
            properties: { email: { type: 'string', format: 'email' }, companyName: { type: 'string' } },
          } } },
        },
        responses: {
          200: { description: 'Email sent (or dev-mode URL returned)' },
          400: { description: 'Email does not match company name', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
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
  },
};
