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
};
