#!/usr/bin/env node
/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * Generates Bruno_Collection/library-bruno/osdmRequestSchemas.js (#736): the
 * request-body schemas of the OSDM endpoints OSCAR sends to, one set per
 * OSDM version, for osdmRequestSchema.js to check OSCAR's own requests.
 *
 * Input: the OSDM specification files, named OSDM-online-api-v<X>.0.yml, in
 * the folder OSDM_SPEC_DIR (default: Documentation/Test_Coverage/OSDM_reference,
 * which holds 3.8). The others come from
 *   https://raw.githubusercontent.com/UnionInternationalCheminsdeFer/OSDM/gh-pages/specification/v<X>/OSDM-online-api-v<X>.0.yml
 *
 *   OSDM_SPEC_DIR=/tmp/osdm node scripts/generate-osdm-request-schemas.js
 *
 * What is kept of a schema: type, nullable, required, properties,
 * additionalProperties, items, minItems/maxItems, minLength/maxLength and a
 * closed enum and a discriminator (with the subtypes it can name). allOf is
 * merged; oneOf/anyOf stay alternatives. An
 * x-extensible-enum is a plain string (its values are examples), and
 * descriptions, examples, formats and patterns are dropped. $ref stays a
 * name, so recursive schemas cost nothing.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..');
const SPEC_DIR = process.env.OSDM_SPEC_DIR
  || path.join(REPO, 'Documentation', 'Test_Coverage', 'OSDM_reference');
const OUT = path.join(REPO, 'Bruno_Collection', 'library-bruno', 'osdmRequestSchemas.js');
const VERSIONS = ['3.4', '3.5', '3.6', '3.7', '3.8'];

// The endpoints OSCAR sends a body to (request files and scripts alike).
const OPERATIONS = [
  ['POST', '/offers'],
  ['POST', '/trips-collection'],
  ['POST', '/bookings'],
  ['PATCH', '/bookings/{bookingId}/passengers/{passengerId}'],
  ['PATCH', '/bookings/{bookingId}/purchaser'],
  ['POST', '/bookings/{bookingId}/purchaser'],
  ['POST', '/bookings/{bookingId}/booked-offers/{bookedOfferId}/offer-parts'],
  ['POST', '/bookings/{bookingId}/booked-offers/{bookedOfferId}/reservations'],
  ['POST', '/bookings/{bookingId}/booked-offers/{bookedOfferId}/ancillaries'],
  ['POST', '/bookings/{bookingId}/fulfillments'],
  ['PATCH', '/bookings/{bookingId}/fulfillments'],
  ['POST', '/bookings/{bookingId}/refund-offers'],
  ['PATCH', '/bookings/{bookingId}/refund-offers/{refundOfferId}'],
  ['POST', '/bookings/{bookingId}/exchange-offers'],
  ['POST', '/bookings/{bookingId}/exchange-operations'],
];

const refName = (ref) => String(ref).replace('#/components/schemas/', '');

function compact(schema, all, seen, queue) {
  if (!schema || typeof schema !== 'object') return {};
  if (schema.$ref) {
    const name = refName(schema.$ref);
    if (!seen.has(name)) { seen.add(name); queue.push(name); }
    return { $ref: name };
  }
  const out = {};
  if (schema.allOf) {
    const merged = { properties: {}, required: [] };
    for (const part of schema.allOf) {
      const c = compact(part, all, seen, queue);
      const r = c.$ref ? resolveForMerge(c.$ref, all, seen, queue) : c;
      Object.assign(merged.properties, r.properties || {});
      merged.required.push(...(r.required || []));
      for (const k of ['type', 'additionalProperties', 'nullable']) if (r[k] !== undefined) merged[k] = r[k];
    }
    Object.assign(out, merged);
    if (!out.required.length) delete out.required;
    if (!Object.keys(out.properties).length) delete out.properties;
  }
  for (const k of ['oneOf', 'anyOf']) {
    if (schema[k]) out.anyOf = schema[k].map((s) => compact(s, all, seen, queue));
  }
  if (schema.type) out.type = schema.type;
  if (schema.nullable === true) out.nullable = true;
  if (Array.isArray(schema.enum) && !schema['x-extensible-enum']) out.enum = schema.enum;
  for (const k of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (typeof schema[k] === 'number') out[k] = schema[k];
  }
  if (Array.isArray(schema.required) && schema.required.length) {
    out.required = [...new Set([...(out.required || []), ...schema.required])];
  }
  if (schema.properties) {
    out.properties = out.properties || {};
    for (const [n, s] of Object.entries(schema.properties)) out.properties[n] = compact(s, all, seen, queue);
  }
  if (schema.discriminator && schema.discriminator.propertyName) {
    const d = { propertyName: schema.discriminator.propertyName };
    if (schema.discriminator.mapping) {
      d.mapping = {};
      for (const [k, ref] of Object.entries(schema.discriminator.mapping)) {
        d.mapping[k] = compact({ $ref: ref }, all, seen, queue).$ref;
      }
    }
    out.discriminator = d;
  }
  if (schema.additionalProperties === false) out.additionalProperties = false;
  else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    out.additionalProperties = compact(schema.additionalProperties, all, seen, queue);
  }
  if (schema.items) out.items = compact(schema.items, all, seen, queue);
  return out;
}

// allOf members that are references are inlined for the merge.
function resolveForMerge(name, all, seen, queue) {
  return compact(all[name] || {}, all, seen, queue);
}

// The schemas that extend each schema through allOf.
function subtypesOf(all) {
  const subs = {};
  for (const [name, schema] of Object.entries(all)) {
    for (const part of (schema && schema.allOf) || []) {
      if (part && part.$ref) (subs[refName(part.$ref)] = subs[refName(part.$ref)] || []).push(name);
    }
  }
  return subs;
}

function forVersion(spec) {
  const all = (spec.components && spec.components.schemas) || {};
  const seen = new Set();
  const queue = [];
  const operations = [];
  for (const [method, p] of OPERATIONS) {
    const op = spec.paths && spec.paths[p] && spec.paths[p][method.toLowerCase()];
    const body = op && op.requestBody && op.requestBody.content;
    const schema = body && (body['application/json'] || Object.values(body)[0] || {}).schema;
    if (!schema) continue;
    const c = compact(schema, all, seen, queue);
    if (!c.$ref) throw new Error(`${method} ${p}: inline request schema not supported`);
    operations.push({ method, path: p, schema: c.$ref });
  }
  const schemas = {};
  const subtypes = subtypesOf(all);
  while (queue.length) {
    const name = queue.shift();
    if (!all[name]) throw new Error(`unknown schema ${name}`);
    schemas[name] = compact(all[name], all, seen, queue);
    // A discriminated base stands for its subtypes: the value names one.
    if (schemas[name].discriminator) {
      for (const sub of subtypes[name] || []) compact({ $ref: sub }, all, seen, queue);
    }
  }
  const sorted = {};
  for (const k of Object.keys(schemas).sort()) sorted[k] = schemas[k];
  return { operations, schemas: sorted };
}

function main() {
  const out = {};
  for (const v of VERSIONS) {
    const file = path.join(SPEC_DIR, `OSDM-online-api-v${v}.0.yml`);
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
    out[`${v}.0`] = forVersion(yaml.load(fs.readFileSync(file, 'utf8')));
  }
  const text = `/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * osdmRequestSchemas.js — the request bodies of the OSDM endpoints OSCAR sends
 * to, one set per OSDM version (#736). GENERATED FILE — do not hand-edit:
 * Oscar_Server/scripts/generate-osdm-request-schemas.js writes it from the
 * OSDM specification files. Read by osdmRequestSchema.js.
 */

'use strict';

const requestSchemas = ${JSON.stringify(out)};

module.exports = { requestSchemas };
`;
  fs.writeFileSync(OUT, text);
  console.log(`${OUT}: ${text.length} bytes`);
}

if (require.main === module) main();

module.exports = { forVersion, OPERATIONS, compact, subtypesOf };
