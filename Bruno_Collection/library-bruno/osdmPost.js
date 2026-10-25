/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * osdmPost.js — a POST to the provider sent from a step's script
 * (`bru.sendRequest`), with the headers the request files carry: the
 * version's Content-Type, the run's token, the Requestor when set, and the
 * simulator faults of the scenario (#833). A script-sent request is not
 * skipped by the run filter (#652).
 *
 * Resolves { status, body } (the body parsed when it is JSON, kept as text
 * otherwise), an error answer included; rejects only when nothing came back.
 */
async function postOsdm(path, body) {
  const { requestorHeader, simulatorFaultsValue } = require('./requestHeaders.js');
  const faults = simulatorFaultsValue(bru.getEnvVar('simulatorFaults'));
  const res = await new Promise((resolve, reject) => {
    bru.sendRequest({
      url: `${bru.getEnvVar('api_base')}${path}`,
      method: 'POST',
      headers: {
        'Content-Type': `application/json;version=${bru.getEnvVar('osdmVersion')}`,
        Accept: 'application/json',
        Authorization: `Bearer ${bru.getEnvVar('access_token')}`,
        ...requestorHeader(bru.getEnvVar('requestor')),
        ...(faults ? { 'X-Simulator-Faults': faults } : {}),
      },
      data: JSON.stringify(body),
    }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
  });
  let data = res?.data ?? res?.body ?? null;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { /* not JSON: kept as text */ }
  }
  return { status: res?.status || res?.statusCode || 0, body: data };
}

module.exports = { postOsdm };
