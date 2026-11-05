// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The company's own data: profile and endpoint, data file, Test Framework,
 * Test Data (trains and journeys, timetable discovery, journey probes), the
 * runs shared with the company (#901), provider operator links and the
 * approval of self-registered users (#449).
 */

const { bearer, pathParam, queryParam, jsonBody, fileBody } = require('./common');

/** One operation of the Company tag. */
function op(summary, description, responses, more = {}) {
  return { tags: ['Company'], summary, security: bearer, description, ...more, responses };
}

// ── Shared pieces ─────────────────────────────────────────────────────────────
const PROVIDER = {
  name: 'X-Provider-Id', in: 'header', required: false, schema: { type: 'string' },
  description: 'A provider of the caller\'s company to act in (#540); absent or empty = the own company. A provider the caller may not use answers 404.',
};
const IF_MATCH = {
  name: 'If-Match', in: 'header', required: false, schema: { type: 'string' },
  description: 'The ETag of the data file the page loaded. A save from a file that changed since answers 412. No header = go ahead.',
};
const IF_NONE_MATCH = {
  name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' },
  description: '`*` when the page loaded no data file: answers 412 if one was stored since.',
};
const SCOPED = { parameters: [PROVIDER] };
const RESOURCE_ID = pathParam('id', 'The Test Data resource (train set or journey)');
const ON_RESOURCE = { parameters: [RESOURCE_ID, PROVIDER] };
const PROVIDER_ID = pathParam('id', 'A provider of the caller\'s company');

const TM_ONLY = { description: 'Test Managers only' };
const NO_PLATFORM = { description: 'Administrators and certifiers' };
const NO_PROVIDER = { description: 'A provider the caller may not use' };
const NOT_HERE = { description: 'No such resource in this company or provider' };
const TOO_MANY_WRITES = { description: 'Too many data file changes (60 in 15 minutes per user and company or provider)' };
const TOO_MANY_READS = { description: 'More than 60 reads a minute' };
const NO_SESSION = { description: 'No OSDM endpoint configured, or no saved credentials for it' };
const TOKEN_FAILED = { description: 'No access token could be obtained' };

const TM_DATAFILE = 'Test Managers only, for the company or provider of the request (X-Provider-Id); administrators and certifiers are refused before anything is read.';
const PROVIDER_CALL = 'Calls the OSDM endpoint of the company or provider with the Test Manager\'s own saved credentials, the Requestor and subscription key saved with them, and the company\'s dedicated headers; one search after the other, 20 s each.';
const TRIP_LEGS = 'legs (1-5, each { originURN, destinationURN, departureTime, arrivalTime, … } as text, as a probe\'s offeredTrips gives them) and days (MON … SUN)';

module.exports = {
  '/v1/company/endpoint/resume': {
    post: {
      tags: ['Company'], summary: 'Resume an endpoint suspended after an intrusion attempt', security: bearer,
      description: 'Test Manager only. After a run met an answer meant to attack OSCAR, the endpoint of the company or provider takes no run until resumed here (or until another endpoint is saved).',
      responses: { 200: { description: 'Resumed' }, 403: { description: 'Test Managers only' }, 409: { description: 'The endpoint is not suspended' } },
    },
  },
  '/v1/company': {
    get: op('The company profile (no secret)',
      'Members only: administrators and certifiers get 403. The company or provider of the request: { id, name, slug, parent_id, api_base, datafile_hash, datafile_updated_at, extra_headers, created_at, updated_at }. Dedicated header values are returned to a Test Manager only; others get each name with has_value.',
      { 200: { description: 'The profile, or the list for an administrator' }, 403: { description: 'Certifiers' }, 404: { description: 'No such company or provider' } },
      { parameters: [PROVIDER, queryParam('company_id', 'Administrators: the company to read')] }),
    patch: op('Change the OSDM endpoint or the dedicated headers (#544, #426)',
      'Body: { api_base?, extra_headers?: [{ name, value }], allow_duplicate_endpoint? }. Members only: administrators and certifiers get 403. Only a Test Manager changes api_base, which must be a public https address; a tester sending back the stored value gets 200 and nothing is written. An endpoint already used by the distributor or another of its providers answers 409 unless allow_duplicate_endpoint is true (audited). Dedicated headers: Test Managers, at most 25, header-token names, values without line breaks, 4096 characters. Credential fields are refused with a pointer to PATCH /v1/me/credentials.',
      { 200: { description: 'The updated profile' }, 400: { description: 'A field refused, a credential field, or nothing to update' }, 403: { description: 'A tester changing the endpoint or the dedicated headers, or a certifier' }, 404: NO_PROVIDER, 409: { description: 'Endpoint already used in the family' } },
      { parameters: [PROVIDER], requestBody: jsonBody('{ api_base?, extra_headers?, allow_duplicate_endpoint? }') }),
  },
  '/v1/company/datafile': {
    get: op('The data file, as this person sees it, annotated for the run',
      'Testers and Test Managers. A Test Manager gets the whole file; a tester their own, the shared and the unowned scenarios, and their personal run list as scenariosToRun. Scenarios that arm what the Test Framework does not declare carry __featureNotDeclaredWarnings (#218); the stored file is not changed. ETag: the version a save from this load names in If-Match (#540).',
      { 200: { description: 'The data file (JSON), with an ETag' }, 403: NO_PLATFORM, 404: { description: 'No data file yet, or a provider the caller may not use' }, 429: TOO_MANY_READS },
      SCOPED),
    post: op('Upload a data file, replacing the stored one (#549)',
      `${TM_DATAFILE} Multipart, field "datafile", JSON, 5 MB at most. Refused unless it passes the collection's schema check, is not a download marked as not the stored file (a tester's view, unsaved edits, a full configuration) and adds no template. Stored byte for byte; the file it replaces becomes the previous file. Not checked against If-Match. Answer: { filename, size, hash, uploaded_at, scenarios_count, previous }.`,
      { 200: { description: 'Stored' }, 400: { description: 'No file, not JSON, not the company\'s file, schema problems (listed) or a template' }, 403: TM_ONLY, 413: { description: 'Larger than 5 MB' }, 429: TOO_MANY_WRITES, 503: { description: 'The schema could not be read; nothing changed' } },
      { parameters: [PROVIDER], requestBody: fileBody('datafile', 'The data file (JSON)') }),
    delete: op('Delete the data file and the previous file',
      `${TM_DATAFILE} Cannot be undone. Answer: { deleted, message }.`,
      { 200: { description: 'Deleted' }, 403: TM_ONLY, 404: NO_PROVIDER, 429: TOO_MANY_WRITES },
      SCOPED),
  },
  '/v1/company/datafile/json': {
    put: op('Save the data file from Test Config (Save & Apply)',
      'Testers and Test Managers. Body: the data file, with scenarios and scenariosToRun arrays. A Test Manager replaces the whole file. A tester\'s save is merged: only their own scenarios change, every other scenario and company-level key is kept, and what they tick becomes their personal run list. A save that adds a template is refused; knownDeviations is the server\'s. Answer: { filename, hash, version, saved_at, scenarios_count, to_run_count, to_run } and, for a tester, { read_only_ignored, renamed, resources_copied, run_list_saved }; ETag of the new version.',
      { 200: { description: 'Saved' }, 400: { description: 'Not a data file, or a template added' }, 403: { description: 'Administrators, certifiers, or an account that no longer exists' }, 404: NO_PROVIDER, 409: { description: 'Tester save: the stored file cannot be read' }, 412: { description: 'The file changed since it was loaded' }, 429: TOO_MANY_WRITES },
      { parameters: [PROVIDER, IF_MATCH, IF_NONE_MATCH], requestBody: jsonBody('The data file') }),
  },
  '/v1/company/datafile/download': {
    get: op('The data file to save: the stored bytes, or a tester\'s marked view (#549)',
      'Testers and Test Managers. A Test Manager gets the stored file byte for byte, so uploading it again changes nothing. A tester gets their view under a root __oscarPersonalView marker, which the upload refuses. As an attachment named by company and date.',
      { 200: { description: 'The file' }, 403: NO_PLATFORM, 404: { description: 'No data file yet, or a provider the caller may not use' }, 409: { description: 'Tester: the stored file cannot be read' }, 429: TOO_MANY_READS },
      SCOPED),
  },
  '/v1/company/datafile/previous': {
    get: op('What the last upload or restore replaced (#549)',
      `${TM_DATAFILE} { exists } and, when it does, { hash, size, replaced_at, scenarios_count }.`,
      { 200: { description: 'The previous file\'s summary' }, 403: TM_ONLY, 404: NO_PROVIDER, 429: TOO_MANY_READS },
      SCOPED),
  },
  '/v1/company/datafile/previous/restore': {
    post: op('Put the previous data file back (#549)',
      `${TM_DATAFILE} Swaps the two files, so a restore can itself be undone; the template rule applies. Answer: { restored, hash, scenarios_count, previous_kept }.`,
      { 200: { description: 'Restored' }, 400: { description: 'It would add a template' }, 403: TM_ONLY, 404: { description: 'No previous file, or a provider the caller may not use' }, 409: { description: 'The previous file is not a JSON object' }, 429: TOO_MANY_WRITES },
      SCOPED),
  },
  '/v1/company/test-framework': {
    get: op('The Test Framework of the company or provider',
      'Testers and Test Managers. { id, config, created_at, updated_at }. A framework missing declarations added since is completed from the company\'s scenarios on this read, and stored (#218). 60 reads a minute.',
      { 200: { description: 'The framework' }, 403: NO_PLATFORM, 404: { description: 'No framework yet, or a provider the caller may not use' }, 429: TOO_MANY_READS },
      SCOPED),
    put: op('Create or replace the Test Framework',
      'Test Managers only. Body: { config } or the config itself. Refused: an OSDM version that is not digits and dots (#785), no or an unknown distribution mode (#936), an unknown fare declaration (#937), and other malformed declarations. Answer: { saved, updated_at }.',
      { 200: { description: 'Saved' }, 400: { description: 'A declaration refused' }, 403: TM_ONLY, 404: NO_PROVIDER },
      { parameters: [PROVIDER], requestBody: jsonBody('{ config } or the config') }),
    delete: op('Delete the Test Framework',
      'Test Managers only. Answer: { deleted }, also when there was none.',
      { 200: { description: 'Deleted' }, 403: TM_ONLY, 404: NO_PROVIDER },
      SCOPED),
  },
  '/v1/company/test-resources': {
    get: op('The Test Data: train sets and journeys',
      'Testers and Test Managers. An array of { id, resource_type, label, data, created_at, updated_at }, oldest first.',
      { 200: { description: 'The resources' }, 403: NO_PLATFORM, 404: NO_PROVIDER },
      SCOPED),
    post: op('Add a Test Data resource',
      'Test Managers only. Body: { resource_type: TRAIN | JOURNEY | MULTIMODAL, label, data }. Answer: the resource.',
      { 201: { description: 'Created' }, 400: { description: 'No valid type, or no label' }, 403: TM_ONLY, 404: NO_PROVIDER },
      { parameters: [PROVIDER], requestBody: jsonBody('{ resource_type, label, data }') }),
  },
  '/v1/company/test-resources/{id}': {
    put: op('Change a Test Data resource',
      'Test Managers only. Body: { label?, data }; data replaces the stored data. Answer: the resource.',
      { 200: { description: 'Updated' }, 403: TM_ONLY, 404: NOT_HERE },
      { ...ON_RESOURCE, requestBody: jsonBody('{ label?, data }') }),
    delete: op('Delete a Test Data resource',
      'Test Managers only. Answer: { deleted }.',
      { 200: { description: 'Deleted' }, 403: TM_ONLY, 404: NOT_HERE },
      ON_RESOURCE),
  },
  '/v1/company/test-resources/discover-timetable': {
    post: op('Discover train sets from what the provider offers (#157, #715)',
      `Test Managers only. Body: { originURN, destinationURN (URN or station code), days (1-14, default 7), searchWith? (trips-collection: trip search first, offers on a day it fails) }. ${PROVIDER_CALL} Services are merged into the TRAIN resources without replacing manual edits, connections of 2 or 3 legs become journeys. Answer: { summary, created, updated, dayResults, offerProbe, journeys }.`,
      { 200: { description: 'Discovered' }, 400: { description: 'No origin or destination, or no endpoint or credentials' }, 403: TM_ONLY, 404: NO_PROVIDER, 502: { description: 'No access token, or no usable answer on any day (dayResults)' } },
      { parameters: [PROVIDER], requestBody: jsonBody('{ originURN, destinationURN, days?, searchWith? }') }),
  },
  '/v1/company/test-resources/fill-calendars': {
    post: op('Give train sets without operating days the days the provider runs them (#717)',
      `Test Managers only. No body. Each route of such a set is searched over the next 7 days; a set gets the days every one of its services was seen, else it is reported with the reason. ${PROVIDER_CALL} Answer: { updated, unresolved, routes }.`,
      { 200: { description: 'Done' }, 400: NO_SESSION, 403: TM_ONLY, 404: NO_PROVIDER, 502: TOKEN_FAILED },
      SCOPED),
  },
  '/v1/company/test-resources/reprobe-offers': {
    post: op('Ask the provider again for the offers of each train set\'s route (#787)',
      `Test Managers only. No body. Three days per route, then once more at the time of each service no answer showed (6 a route at most); each set's offerProbe is rewritten with what was offered and how its services differ. ${PROVIDER_CALL} Answer: { routes, updated }.`,
      { 200: { description: 'Done' }, 400: { description: 'No endpoint or credentials, or no train set with a route' }, 403: TM_ONLY, 404: NO_PROVIDER, 502: TOKEN_FAILED },
      SCOPED),
  },
  '/v1/company/test-resources/{id}/probe-journey': {
    post: op('Ask the provider whether a saved journey is offered (#813)',
      `Test Managers only. From the first stop place to the last, at the first departure, on the next 3 days all its trains run. ${PROVIDER_CALL} Writes nothing. Answer: { journey, legs, days, offeredTrips, summary }.`,
      { 200: { description: 'The probe' }, 400: { description: 'A leg names a train set no longer there, no common operating day, or no endpoint or credentials' }, 403: TM_ONLY, 404: NOT_HERE, 502: TOKEN_FAILED },
      ON_RESOURCE),
  },
  '/v1/company/test-resources/probe-journey': {
    post: op('Ask the provider whether legs not saved as a journey are offered (#815)',
      'Test Managers only. Body: { legs: 1-5 × { trainResourceId, serviceIndex } }. The same probe and answer as for a saved journey; writes nothing.',
      { 200: { description: 'The probe' }, 400: { description: 'legs refused, or the probe cannot be made' }, 403: TM_ONLY, 404: NO_PROVIDER, 502: TOKEN_FAILED },
      { parameters: [PROVIDER], requestBody: jsonBody('{ legs }') }),
  },
  '/v1/company/test-resources/journey-from-trip': {
    post: op('Keep a trip a probe found, as train sets and a journey (#815)',
      `Test Managers only. Body: { ${TRIP_LEGS} }. The legs must make one journey on one trip date. Answer: { journey, created, trainsCreated, trainsUpdated }; 200 when the same journey already exists.`,
      { 200: { description: 'The journey already existed' }, 201: { description: 'Journey created' }, 400: { description: 'The trip refused' }, 403: TM_ONLY, 404: NO_PROVIDER, 500: { description: 'The journey could not be made from the services stored' } },
      { parameters: [PROVIDER], requestBody: jsonBody(`{ ${TRIP_LEGS} }`) }),
  },
  '/v1/company/test-resources/{id}/replace-journey': {
    post: op('Replace a saved journey with the trips a probe found (#865)',
      `Test Managers only. Body: { trips: 1-10 × { ${TRIP_LEGS} } }. Every trip is checked first, then all are kept and the old journey removed (unless it is one of them) in one transaction; train sets stay. Answer: { replaced, journeys, trainsCreated, trainsUpdated }.`,
      { 200: { description: 'Replaced' }, 400: { description: 'A trip refused; nothing changed' }, 403: TM_ONLY, 404: { description: 'No such journey here' }, 500: { description: 'Not replaced; nothing changed' } },
      { ...ON_RESOURCE, requestBody: jsonBody('{ trips }') }),
  },
  '/v1/company/run-share-links': {
    get: op('The providers of other companies linked to this company, for run sharing (#901)',
      'Test Managers only, for their own company (a provider of the request reads as its distributor). { links: [{ provider_id, provider_name, distributor_name, status: waiting | accepted | refused, requested_at, decided_at }] }. 60 requests a minute.',
      { 200: { description: 'The links' }, 403: TM_ONLY, 404: NO_PROVIDER },
      SCOPED),
  },
  '/v1/company/run-share-links/{providerId}/accept': {
    post: op('Accept a link: the runs shared through it become readable (#901)',
      'Test Managers of the linked company only. Answer: { link }. Audited.',
      { 200: { description: 'Accepted' }, 403: TM_ONLY, 404: { description: 'No such link to this company' } },
      { parameters: [pathParam('providerId', 'The provider linked to this company'), PROVIDER] }),
  },
  '/v1/company/run-share-links/{providerId}/refuse': {
    post: op('Refuse a link, or stop an accepted one (#901)',
      'Test Managers of the linked company only. Its shared runs are no longer readable. Answer: { link }. Audited.',
      { 200: { description: 'Refused' }, 403: TM_ONLY, 404: { description: 'No such link to this company' } },
      { parameters: [pathParam('providerId', 'The provider linked to this company'), PROVIDER] }),
  },
  '/v1/company/shared-runs': {
    get: op('The runs other companies shared with this company (#901)',
      'Test Managers only. Each run passes the same rule as a read of a shared run (link accepted, share not revoked, sharer still a Test Manager of the distributor). { total, runs: [{ …run fields, submitted_by, shared: { distributor, provider }, shared_at }] }; the distributor\'s users are named by the distributor, never by e-mail.',
      { 200: { description: 'The runs' }, 403: TM_ONLY, 404: NO_PROVIDER },
      { parameters: [PROVIDER, queryParam('limit', 'At most this many, 1-500 (default 100)', { type: 'integer', minimum: 1, maximum: 500, default: 100 })] }),
  },
  '/v1/company/providers/operator-companies': {
    get: op('The companies a provider can be linked to as its operator (#901)',
      'Test Managers of the distributor only; administrators and certifiers are refused. { companies: [{ id, name }] }: the other top-level companies, names only.',
      { 200: { description: 'The companies' }, 403: { description: 'Not a Test Manager of the distributor' } }),
  },
  '/v1/company/providers/{id}/operator': {
    put: op('Link the company that operates a provider (#901)',
      'Test Managers of the distributor only. Body: { company_id }. The link waits for that company\'s Test Manager to accept it; naming the company already linked changes nothing and keeps its acceptance. Answer: { provider }. Audited.',
      { 200: { description: 'Linked' }, 400: { description: 'company_id names no other company' }, 403: { description: 'Not a Test Manager of the distributor' }, 404: { description: 'Not a provider of this company' }, 429: { description: 'Too many provider changes' } },
      { parameters: [PROVIDER_ID], requestBody: jsonBody('{ company_id }') }),
    delete: op('Remove the operator link of a provider (#901)',
      'Test Managers of the distributor only. Runs shared through it are no longer readable by that company. Answer: { provider }. Audited.',
      { 200: { description: 'Removed' }, 403: { description: 'Not a Test Manager of the distributor' }, 404: { description: 'Not a provider of this company, or no link' }, 429: { description: 'Too many provider changes' } },
      { parameters: [PROVIDER_ID] }),
  },
  '/v1/company/users/{id}/approve': {
    post: op('Approve a self-registered user waiting for review (#449)',
      'Test Managers only, for a user of their own company whose status is pending; the user can then sign in. Answer: { user: { id, email, role, status, company_id, company_name, created_at } }. Audited.',
      { 200: { description: 'Approved' }, 400: { description: 'Not waiting for approval' }, 403: TM_ONLY, 404: { description: 'Not a user of this company' }, 429: { description: 'Too many user changes' } },
      { parameters: [pathParam('id', 'The user')] }),
  },
};
