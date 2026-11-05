// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A tester's credentials go to the OSDM endpoint they were saved for, and to
 * no other. Each tester_credentials row keeps the endpoint's origin at the
 * time of the save (credentials_endpoint, migration 48). When the company's
 * or provider's endpoint is changed to another origin, no token is asked and
 * no stored token is sent with those credentials until the tester saves them
 * again (API Config): resolveAccessToken() refuses, the pages warn.
 */

const { get } = require('../db/db');

/** The origin of an endpoint address ("https://host:port"), or null. */
function endpointOrigin(apiBase) {
  if (typeof apiBase !== 'string' || apiBase.trim() === '') return null;
  try { return new URL(apiBase.trim()).origin; } catch { return null; }
}

/**
 * Pure: the sentence that refuses the credentials, or null. `savedFor` is the
 * origin stored with them, `current` the endpoint now. Nothing stored (no
 * endpoint at the time of the save) refuses nothing.
 */
function endpointChangeProblem(savedFor, current) {
  if (!savedFor) return null;
  const now = endpointOrigin(current);
  if (!now || now === savedFor) return null;
  return `The OSDM endpoint changed since these credentials were saved (saved for ${savedFor}, now ${now}). `
    + 'OSCAR does not send them to another address: check them on API Config and save them again.';
}

/**
 * The refusal for a credentials row (as credentialsFor() returns it), read
 * against the endpoint of its company or provider now. Administrators keep one
 * set for every company (credentialsFor), so it is not tied to one endpoint.
 */
function credentialsEndpointProblem(credRow) {
  if (!credRow || credRow.role === 'administrator' || !credRow.credentials_endpoint) return null;
  const company = get('SELECT api_base FROM companies WHERE id = ?', [credRow.company_id]);
  return endpointChangeProblem(credRow.credentials_endpoint || null, company?.api_base);
}

module.exports = { endpointOrigin, endpointChangeProblem, credentialsEndpointProblem };
