// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

const { bearer, open, pathParam, queryParam } = require('./common');

const RUN_SECRET = { name: 'X-OSCAR-Run-Secret', in: 'header', required: false, description: 'The secret the runner gave the run\'s Bruno process', schema: { type: 'string' } };
const FILE_LIMIT = 'At most 300 file reads a minute per address.';

module.exports = {
  '/artifacts/{runId}/{filename}': {
    get: { tags: ['Runs'], summary: 'One file of a run: its HTML report or a JSON result', security: bearer,
      description: `Whoever may read the run (canUserReadRun: own company, a certifier for a run shared with certifiers, a Test Manager of a company the run is shared with); any other reader gets 404, as for a run that does not exist. The session is read from the cookie or the Authorization header. Decrypted and sent inline as text/html or application/json; in a run shared with another company, the distributor's e-mail addresses are replaced by its name. ${FILE_LIMIT}`,
      parameters: [pathParam('runId', 'The run'), pathParam('filename', 'A file name of letters, digits, dot, dash and underscore', null)],
      responses: { 200: { description: 'The file' }, 400: { description: 'Not a run id or not a file name' }, 401: { description: 'Not signed in' }, 404: { description: 'No such run or file for this reader' }, 429: { description: 'Too many reads' }, 500: { description: 'The file could not be decrypted' } } },
  },
  '/data/{filename}': {
    get: { tags: ['Internal'], summary: 'A company\'s data file, as a run reads it', security: open,
      description: `Called by a run's Bruno process with X-OSCAR-Run-Id and X-OSCAR-Run-Secret, for its own company only; the run's copy carries the Test Framework's warnings and the trains' calendars. Without a run secret, a signed-in Test Manager of the company (or of its distributor) gets the stored file as it is; testers read their own view from GET /v1/company/datafile. Every refusal about a provider reads as 404. No page calls it. ${FILE_LIMIT}`,
      parameters: [pathParam('filename', '<slug>-datafile.json', null),
        { name: 'X-OSCAR-Run-Id', in: 'header', required: false, description: 'The run, with its secret', schema: { type: 'string', format: 'uuid' } }, RUN_SECRET],
      responses: { 200: { description: 'The data file (JSON)' }, 400: { description: 'Not a data file name' }, 401: { description: 'No run secret and not signed in' }, 403: { description: 'Not a Test Manager of that company' }, 404: { description: 'No such company or file, or another company\'s run' }, 429: { description: 'Too many reads' }, 500: { description: 'The file could not be decrypted' } } },
  },
  '/json_validator/datafile.schema.json': {
    get: { tags: ['Internal'], summary: 'The data file\'s JSON schema, from the installed Bruno collection', security: open,
      description: `No session needed: the schema is part of the collection, read by the runs. Cached for 5 minutes. ${FILE_LIMIT}`,
      responses: { 200: { description: 'The schema' }, 404: { description: 'The collection holds no schema' }, 429: { description: 'Too many reads' } } },
  },
  '/metrics': {
    get: { tags: ['Internal'], summary: 'Prometheus metrics of the server, or of the OSDM simulator', security: open,
      description: 'For the monitoring stack; the reverse proxy configuration in OSCAR_Deploy/nginx answers 404 to it from outside. When the server sets METRICS_TOKEN, a request without that bearer token gets 404. With source=simulator, the simulator\'s metrics read through the address and key saved in Admin → OSDM Simulator. Text in the Prometheus exposition format.',
      parameters: [queryParam('source', 'simulator, for the simulator\'s metrics; any other value is a 404', { type: 'string', enum: ['simulator'] })],
      responses: { 200: { description: 'The metrics', content: { 'text/plain': { schema: { type: 'string' } } } }, 404: { description: 'Not allowed, or an unknown source' }, 500: { description: 'The metrics could not be read' } } },
  },
  '/v1/openapi.json': {
    get: { tags: ['Internal'], summary: 'This OpenAPI document', security: open,
      description: 'The document the Swagger UI at /v1/docs shows. It describes the routes; each route still checks its own access.',
      responses: { 200: { description: 'The OpenAPI 3.0 document' } } },
  },
  '/v1/runs/{runId}/refresh-access-token': {
    post: { tags: ['Internal'], summary: 'A fresh OSDM access token for a running run', security: open,
      description: `Called by a run's Bruno process only, with the run's own secret in X-OSCAR-Run-Secret (no session): before a scenario, and after a long wait that may outlive the token. The token is resolved from the credentials of the run's user for the run's company, refused when that user may no longer use the company. Answer { access_token, forced }, not cached. ${FILE_LIMIT}`,
      parameters: [pathParam('runId', 'The run'), queryParam('force', '1 or true: fetch a new token even when the cached one is still valid'), RUN_SECRET],
      responses: { 200: { description: 'The token' }, 400: { description: 'Not a run id' }, 403: { description: 'No run secret, a secret of another run, or the user may no longer use the company' }, 404: { description: 'No such run, or no credentials for its user' }, 429: { description: 'Too many requests' }, 502: { description: 'The provider\'s token endpoint refused or did not answer' } } },
  },
};
