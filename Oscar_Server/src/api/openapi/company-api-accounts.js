// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { bearer, pathParam, jsonBody } = require('./common');

// Company API accounts (#1342): the user a company's own test automation acts as.
const ACCOUNT = [pathParam('id', 'The Company API account')];
const WHO = 'Test Managers only. An account belongs to the company (the request\'s company, or the distributor of the provider it names); others get 404.';
const VIEW = '{ id, name, status (active | suspended), account_email (made up, under .invalid: never delivered), providers: [{ id, name }], credentials: [{ company_id, company_name, set }], created_by, created_at, suspended_at, suspended_by }';
const CREDS_WHERE = 'For the company or provider the request names (X-Provider-Id), which the account must be given (409 otherwise).';
const TM_ONLY = { 403: { description: 'Test Managers only' } };
const NO_ACCOUNT = { 404: { description: 'No such account here' } };

module.exports = {
  '/v1/company/api-accounts': {
    get: { tags: ['Company'], summary: 'The Company API accounts of the company (#1342)', security: bearer,
      description: `${WHO} { company: { id, name }, max_accounts, accounts: [${VIEW}] }, newest first. An account never signs in to the pages and has no password anyone knows.`,
      responses: { 200: { description: 'The accounts' }, ...TM_ONLY } },
    post: { tags: ['Company'], summary: 'Make a Company API account (#1342)', security: bearer,
      description: `${WHO} Body: { name (1-60 characters, no control character, unique in the company), providers: [provider id] (the providers it may use, besides the company) }. At most 20 a company. Answer 201 ${VIEW}.`,
      requestBody: jsonBody('{ name, providers }'),
      responses: { 201: { description: 'The account' }, 400: { description: 'A bad name, or a provider not of the company' }, ...TM_ONLY, 409: { description: 'The name is taken, or the company has 20 accounts' } } },
  },
  '/v1/company/api-accounts/{id}': {
    get: { tags: ['Company'], summary: 'One Company API account (#1342)', security: bearer,
      description: `${WHO} ${VIEW}.`, parameters: ACCOUNT,
      responses: { 200: { description: 'The account' }, ...TM_ONLY, ...NO_ACCOUNT } },
    patch: { tags: ['Company'], summary: 'Rename a Company API account or set its providers (#1342)', security: bearer,
      description: `${WHO} Body: { name, providers }, either or both; providers replaces the list. A provider taken away stops at once.`,
      parameters: ACCOUNT, requestBody: jsonBody('{ name, providers }'),
      responses: { 200: { description: 'The account' }, 400: { description: 'Nothing to change, a bad name or provider' }, ...TM_ONLY, ...NO_ACCOUNT, 409: { description: 'The name is taken' } } },
    delete: { tags: ['Company'], summary: 'Delete a Company API account and its runs (#1342)', security: bearer,
      description: `${WHO} Its runs, their checks and logs go with it, as a person's. Suspend it to keep them. Answer { deleted: true, id }.`,
      parameters: ACCOUNT,
      responses: { 200: { description: 'Deleted' }, ...TM_ONLY, ...NO_ACCOUNT } },
  },
  '/v1/company/api-accounts/{id}/suspend': {
    post: { tags: ['Company'], summary: 'Suspend a Company API account (#1342)', security: bearer,
      description: `${WHO} It stops at once: no run pod is kept for it. Suspending a suspended account changes nothing.`,
      parameters: ACCOUNT,
      responses: { 200: { description: 'The account' }, ...TM_ONLY, ...NO_ACCOUNT } },
  },
  '/v1/company/api-accounts/{id}/resume': {
    post: { tags: ['Company'], summary: 'Let a suspended Company API account work again (#1342)', security: bearer,
      description: `${WHO}`, parameters: ACCOUNT,
      responses: { 200: { description: 'The account' }, ...TM_ONLY, ...NO_ACCOUNT } },
  },
  '/v1/company/api-accounts/{id}/credentials': {
    get: { tags: ['Company'], summary: 'What is saved of a Company API account\'s OSDM credentials (#1342)', security: bearer,
      description: `${WHO} ${CREDS_WHERE} The same shape as GET /v1/me/credentials: whether each secret is set, never its value.`,
      parameters: ACCOUNT,
      responses: { 200: { description: 'The credentials, shown as set or not' }, ...TM_ONLY, ...NO_ACCOUNT, 409: { description: 'The account is not given this provider' } } },
    patch: { tags: ['Company'], summary: 'Save a Company API account\'s OSDM credentials (#1342)', security: bearer,
      description: `${WHO} ${CREDS_WHERE} The body and checks of PATCH /v1/me/credentials; the credentials are tied to the endpoint as it is now.`,
      parameters: ACCOUNT, requestBody: jsonBody('The credential fields'),
      responses: { 200: { description: 'The credentials, shown as set or not' }, 400: { description: 'A field refused, or nothing to change' }, ...TM_ONLY, ...NO_ACCOUNT, 409: { description: 'The account is not given this provider' } } },
  },
  '/v1/company/api-accounts/{id}/credentials/test': {
    post: { tags: ['Company'], summary: 'Test a Company API account\'s saved OSDM credentials (#1342)', security: bearer,
      description: `${WHO} ${CREDS_WHERE} As POST /v1/me/credentials/test: a token the way a run gets one, then GET {endpoint}/versions with it. Never the token. At most 10 a minute.`,
      parameters: ACCOUNT,
      responses: { 200: { description: 'The test\'s outcome' }, ...TM_ONLY, ...NO_ACCOUNT, 409: { description: 'The account is not given this provider' }, 429: { description: 'Too many tests' } } },
  },
  '/v1/company/api-accounts/{id}/keys': {
    get: { tags: ['Company'], summary: "A Company API account's public keys and how it asks a token (#1342)", security: bearer,
      description: `${WHO} { client_id, token_url, active_keys, max_active_keys, algorithms, keys: [{ id, alg, fingerprint, created_by, created_at, last_used_at, revoked_at, revoked_by, state }] }. A key is public: OSCAR never holds the private key.`,
      parameters: ACCOUNT,
      responses: { 200: { description: 'The keys' }, ...TM_ONLY, ...NO_ACCOUNT } },
    post: { tags: ['Company'], summary: 'Give a Company API account a public key (#1342)', security: bearer,
      description: `${WHO} Body: { public_key }: a PEM public key, EC P-256 (ES256) or RSA of 2048 bits or more (PS256). A private key is refused. Two active keys at most, for a rotation. Answer 201, the key.`,
      parameters: ACCOUNT, requestBody: jsonBody('{ public_key }'),
      responses: { 201: { description: 'The key' }, 400: { description: 'Not a public key of a kind accepted, or a private key' }, ...TM_ONLY, ...NO_ACCOUNT, 409: { description: 'The key is already there, or two keys are active' } } },
  },
  '/v1/company/api-accounts/{id}/keys/{keyId}': {
    delete: { tags: ['Company'], summary: "Revoke a Company API account's public key (#1342)", security: bearer,
      description: `${WHO} Effective at once for new tokens; a token already given lives its 15 minutes. Revoking a revoked key changes nothing.`,
      parameters: [...ACCOUNT, pathParam('keyId', 'The key')],
      responses: { 200: { description: 'The key, revoked' }, ...TM_ONLY, 404: { description: 'No such account or key here' } } },
  },
  '/v1/api/oauth/token': {
    post: { tags: ['API'], summary: 'An access token for a Company API account: client credentials with private_key_jwt (#1342)', security: [],
      description: `application/x-www-form-urlencoded (RFC 6749 §4.4, RFC 7523): grant_type=client_credentials, client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer, client_assertion=<JWT>, scope (optional, "runs:read runs:write" by default), client_id (optional, the iss of the assertion). The assertion is signed ES256 or PS256 with the account's private key: iss = sub = the account's client_id, aud = this token endpoint (or OSCAR's address), exp at most 5 minutes after iat, a jti used once. Answer { access_token, token_type: "Bearer", expires_in: 900, scope }, never cached. Errors are RFC 6749 §5.2: { error, error_description }. 30 requests a minute per address.`,
      requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['grant_type', 'client_assertion_type', 'client_assertion'],
        properties: { grant_type: { type: 'string', enum: ['client_credentials'] }, client_assertion_type: { type: 'string' }, client_assertion: { type: 'string' }, scope: { type: 'string' }, client_id: { type: 'string' } } } } } },
      responses: { 200: { description: 'The access token' }, 400: { description: 'invalid_request, unsupported_grant_type or invalid_scope' }, 401: { description: 'invalid_client: the account, its key or the assertion was not accepted' }, 429: { description: 'slow_down' }, 503: { description: 'APP_URL is not set in production' } } },
  },
  '/v1/api/test-requests': {
    post: { tags: ['API'], summary: 'Run scenarios on one or more providers, as a Company API account (#1342)', security: [{ apiAccountAuth: ['runs:write'] }],
      description: `A Company API account's access token with runs:write; a read-only key gets 403. Body: { providers: [company or provider id] (1 to 20), scenarios: [code] (1 to 500) or selection (the Run page's: categories, groups, forms, modes, lastRun) or suite (the name of one of the company's suites, GET /v1/api/suites; 404 if none has it), reference (your own id, at most 100 characters) }. Header Idempotency-Key (optional, 8 to 100 of letters, digits, . _ : -): the same key and request answer the same test request (200); with another request, 422. Every provider is checked before anything is queued: one the account is not given is 404; an endpoint suspended, or the account's credentials, the endpoint or the data file missing there is 409, naming the provider (and \`missing\`). The account runs the company's shared scenarios, never a tester's own; a code a provider does not have is listed in its not_found. One batch per provider. Answer 202 with Location and the test request (as GET). 30 requests in 10 minutes per account.`,
      requestBody: jsonBody('{ providers, scenarios | selection, reference }'),
      responses: { 200: { description: 'The test request already made with this Idempotency-Key' }, 202: { description: 'The test request, queued' }, 400: { description: 'A bad body, or nothing would run' }, 401: { description: 'No valid token' }, 403: { description: 'A read-only key, or a token without runs:write' }, 404: { description: 'A provider unknown or not given to the account' }, 409: { description: 'A provider cannot run now' }, 422: { description: 'The Idempotency-Key was used for another request' }, 429: { description: 'Too many requests' } } },
  },
  '/v1/api/test-requests/{id}': {
    get: { tags: ['API'], summary: 'A test request\'s state and verdicts (#1342)', security: [{ apiAccountAuth: ['runs:read'] }],
      description: 'The account\'s own test requests only (another\'s, or a key, is 404). ?wait=<seconds> (0 to 60) answers as soon as the request is finished, or at the end of the wait; an account holds five waits at a time, and a sixth call answers at once. { id, reference, created_at, asked, state (queued | running | finished), verdict (null until finished; passed | failed | incomplete; a known deviation is accepted and still passes), counts: { queued, running, passed, passed_with_deviation, failed, not_a_result, cancelled }, providers: [{ id, name, batch_id, not_found, state, verdict, counts, runs: [{ id, scenario_code, state, verdict (passed | passed_with_deviation | failed | not_a_result | cancelled), reason, checks: { total, passed, failed }, queued_at, started_at, completed_at, run_url }] }] }. A pipeline is green on verdict passed only. No body, log or person is answered: run_url opens the run in OSCAR.',
      parameters: [pathParam('id', 'The test request')],
      responses: { 200: { description: 'The test request' }, 400: { description: 'wait is not 0 to 60' }, 401: { description: 'No valid token' }, 404: { description: 'No such test request of this account' } } },
  },
  '/v1/api/suites': {
    get: { tags: ['API'], summary: 'The named suites a Company API account may ask by name (#1342)', security: [{ apiAccountAuth: ['runs:read'] }],
      description: 'The suites of the account\'s company: { suites: [{ name, selection, codes, created_at, updated_at }] }. A suite holds a selection (the Run page\'s filters), a list of codes, or both; POST /v1/api/test-requests with { suite: name } runs, on each provider, the codes its selection keeps and the codes it lists. A read-only key gets 404.',
      responses: { 200: { description: 'The suites' }, 401: { description: 'No valid token' }, 404: { description: 'A read-only key' } } },
  },
  '/v1/company/test-suites': {
    get: { tags: ['Company'], summary: 'The named suites of the company (#1342)', security: bearer,
      description: 'Members of the company (the request\'s company, or the distributor of the provider it names); administrators and certifiers get 403. { company: { id, name }, suites: [{ id, name, selection, codes, created_by, created_at, updated_at }] }, by name.',
      responses: { 200: { description: 'The suites' }, 403: { description: 'Administrators and certifiers' } } },
    post: { tags: ['Company'], summary: 'Save a named suite (#1342)', security: bearer,
      description: 'Test Managers only. Body: { name (1-60 characters, unique in the company without case), selection (the Run page\'s), codes (1 to 500) }: a selection, a list of codes, or both. At most 100 a company. Answer 201, the suite.',
      requestBody: jsonBody('{ name, selection, codes }'),
      responses: { 201: { description: 'The suite' }, 400: { description: 'A bad name, selection or list, or neither' }, 403: { description: 'Not a Test Manager' }, 409: { description: 'The name is taken, or 100 suites' } } },
  },
  '/v1/company/test-suites/{id}': {
    patch: { tags: ['Company'], summary: 'Change a named suite (#1342)', security: bearer,
      description: 'Test Managers only. Any of name, selection, codes (null removes it); the suite as it would be is checked whole.',
      parameters: [pathParam('id', 'The suite')], requestBody: jsonBody('{ name, selection, codes }'),
      responses: { 200: { description: 'The suite' }, 400: { description: 'The suite would not be valid' }, 403: { description: 'Not a Test Manager' }, 404: { description: 'No such suite here' }, 409: { description: 'The name is taken' } } },
    delete: { tags: ['Company'], summary: 'Delete a named suite (#1342)', security: bearer,
      description: 'Test Managers only. Test requests already made keep what they asked.',
      parameters: [pathParam('id', 'The suite')],
      responses: { 200: { description: 'Deleted' }, 403: { description: 'Not a Test Manager' }, 404: { description: 'No such suite here' } } },
  },
  '/v1/api/test-requests/{id}/results': {
    get: { tags: ['API'], summary: 'Where each run of a test request failed and warned, as JSON or JUnit XML (#1342)', security: [{ apiAccountAuth: ['runs:read'] }],
      description: 'The account\'s own test requests only. The answer of GET /v1/api/test-requests/{id} with, for each run, failures: [{ step, check, message, expected, actual, http_status, problem_code }], warnings: [{ step, message }] (its [WARNING] log lines), deviations: [{ step, status, note }] (the known deviations it applied) and truncated: { failures, warnings } (50 of each at most; texts one line of 500 characters). Results only: no request or response body, no other log line. ?format=junit answers JUnit XML (application/xml): a testsuite per provider, a testcase per run, <failure> for failed checks, <error> for a run without result, <skipped> for a cancelled or unfinished one, warnings and deviations in <system-out>, the verdict and run_url as properties.',
      parameters: [pathParam('id', 'The test request'), { name: 'format', in: 'query', required: false, schema: { type: 'string', enum: ['json', 'junit'] } }],
      responses: { 200: { description: 'The results' }, 400: { description: 'format is not json or junit' }, 401: { description: 'No valid token' }, 404: { description: 'No such test request of this account' } } },
  },
};
