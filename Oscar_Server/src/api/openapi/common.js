// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Small builders shared by the OpenAPI path modules of this folder, so that
 * each operation reads as one short entry.
 */

/** Signed in with the session's JWT. */
const bearer = [{ bearerAuth: [] }];

/** Signed in, or not: the route checks something else (a token in the body or the address). */
const open = [];

/** A path parameter, required. `format` 'uuid' unless said otherwise. */
function pathParam(name, description, format = 'uuid') {
  const schema = format ? { type: 'string', format } : { type: 'string' };
  return { name, in: 'path', required: true, description, schema };
}

/** An optional query parameter. */
function queryParam(name, description, schema = { type: 'string' }) {
  return { name, in: 'query', required: false, description, schema };
}

/** A JSON body, described in words (the routes check their own fields). */
function jsonBody(description, required = true) {
  return { required, description, content: { 'application/json': { schema: { type: 'object' } } } };
}

/** A file upload (multipart/form-data) with one file field. */
function fileBody(field, description) {
  return {
    required: true,
    description,
    content: { 'multipart/form-data': { schema: { type: 'object', properties: { [field]: { type: 'string', format: 'binary' } } } } },
  };
}

/**
 * Merge path modules into one paths object. Two modules may describe the
 * same path, each with its own methods; the same method twice throws, so a
 * route is never described in two places.
 */
function mergePaths(...modules) {
  const out = {};
  for (const mod of modules) {
    for (const [p, item] of Object.entries(mod)) {
      out[p] = out[p] || {};
      for (const [k, v] of Object.entries(item)) {
        if (k in out[p]) throw new Error(`OpenAPI: ${k} ${p} is described twice`);
        out[p][k] = v;
      }
    }
  }
  return out;
}

module.exports = { bearer, open, pathParam, queryParam, jsonBody, fileBody, mergePaths };
