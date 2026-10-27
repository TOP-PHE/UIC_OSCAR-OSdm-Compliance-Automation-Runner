/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * osdmRequestSchema.js — OSCAR's own request, checked against OSDM (#736)
 * ======================================================================
 * Two of OSCAR's defects reached a real provider as `"productCategory": {}`
 * and `"tripLegCoverage": {}`, and read as the provider's findings because
 * only the provider's refusal showed them. A body that does not conform to
 * the OSDM request schema of the version under test is OSCAR's problem,
 * whatever the provider answers.
 *
 * The global after-response checks the body that was sent, against
 * osdmRequestSchemas.js (generated from the OSDM files). One check per
 * request with a body, named "[OSCAR request] …", so a reader and later the
 * suggested findings (#735) never take it for the provider's. The request has
 * already gone out: the provider's answer is still recorded.
 *
 * A request a scenario makes wrong on purpose (a negative test) is checked
 * too, but its check passes and says so (NEGATIVE_TESTS).
 *
 * Paths and member names only, never values: a body holds passengers' names.
 *
 * Pure apart from recordRequestConformance(), which reads req and bru.
 */

const { requestSchemas } = require('./osdmRequestSchemas.js');
const { getComplianceVersion, versionScore } = require('./osdmVersion.js');

const TAG = '[OSCAR request]';

// #1019: what a request lacks because the scenario's data lacks it, which the
// scenario's own check reports: a trip specification leg without carrier. The
// collection leaves `carriers` out only when the leg's train has no operator
// code (#809), and "Trip specification leg N names its carrier (operator
// code)" fails for it. One defect, one check: not counted again as OSCAR's.
const DATA_GAP = /^tripSpecifications\[\d+\]\.legs\[\d+\]\.timedLeg\.service: missing carriers$/;
const isDataGap = (issue) => DATA_GAP.test(issue);
const MAX_SHOWN = 10;
const MAX_DEPTH = 64;

// The highest bundled version not above the target, else the lowest.
function pickVersion(target) {
  const avail = Object.keys(requestSchemas).sort((a, b) => versionScore(a) - versionScore(b));
  const t = versionScore(target);
  let best = null;
  avail.forEach((v) => { if (versionScore(v) <= t) best = v; });
  return best || avail[0];
}

function pathSegments(url) {
  const noQuery = String(url || '').split(/[?#]/)[0];
  const noOrigin = noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  return noOrigin.split('/').filter(Boolean);
}

function templateMatches(template, segments) {
  const parts = template.split('/').filter(Boolean);
  if (parts.length > segments.length) return false;
  const tail = segments.slice(segments.length - parts.length);
  return parts.every((p, i) => p.startsWith('{') || p === tail[i]);
}

// The OSDM operation a request goes to: the longest path template the end of
// its URL matches, so that a base URL with a path of its own does not count.
function operationFor(method, url, version) {
  const v = pickVersion(version);
  const segments = pathSegments(url);
  const m = String(method || '').toUpperCase();
  let found = null;
  for (const op of requestSchemas[v].operations) {
    if (op.method !== m || !templateMatches(op.path, segments)) continue;
    if (!found || op.path.split('/').length > found.path.split('/').length) found = op;
  }
  return found ? { version: v, method: m, path: found.path, schema: found.schema } : null;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeFits(value, schema) {
  if (value === null) return schema.nullable === true;
  if (!schema.type) return true;
  const t = typeOf(value);
  if (schema.type === 'number') return t === 'number' || t === 'integer';
  return t === schema.type;
}

function checkObject(value, schema, ctx, path) {
  const missing = (schema.required || []).filter((name) => value[name] === undefined);
  if (missing.length) ctx.issues.push(`${path || '(body)'}: missing ${missing.join(', ')}`);
  const props = schema.properties || {};
  for (const name of Object.keys(value)) {
    const child = path ? `${path}.${name}` : name;
    if (props[name]) visit(value[name], props[name], ctx, child);
    else if (schema.additionalProperties === false) ctx.issues.push(`${child}: not a member of ${ctx.owner}`);
    else if (schema.additionalProperties) visit(value[name], schema.additionalProperties, ctx, child);
  }
}

function checkArray(value, schema, ctx, path) {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    ctx.issues.push(`${path}: at least ${schema.minItems} item(s), got ${value.length}`);
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    ctx.issues.push(`${path}: at most ${schema.maxItems} item(s), got ${value.length}`);
  }
  if (schema.items) value.forEach((item, i) => visit(item, schema.items, ctx, `${path}[${i}]`));
}

function checkString(value, schema, ctx, path) {
  if (schema.enum && !schema.enum.includes(value)) {
    const listed = schema.enum.slice(0, 8).join(', ') + (schema.enum.length > 8 ? ', …' : '');
    ctx.issues.push(`${path}: not one of the listed values (${listed})`);
  }
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    ctx.issues.push(`${path}: shorter than ${schema.minLength} character(s)`);
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    ctx.issues.push(`${path}: longer than ${schema.maxLength} character(s)`);
  }
}

// A value must fit one of the forms; when none fits, the closest one's
// problems are reported.
function checkAlternatives(value, schema, ctx, path) {
  let best = null;
  for (const alt of schema.anyOf) {
    const trial = { schemas: ctx.schemas, owner: ctx.owner, depth: ctx.depth, issues: [] };
    visit(value, alt, trial, path);
    if (!trial.issues.length) return;
    if (!best || trial.issues.length < best.length) best = trial.issues;
  }
  ctx.issues.push(`${path || '(body)'}: fits none of the ${schema.anyOf.length} forms OSDM allows; the closest says:`, ...best);
}

// A discriminated type (PlaceRef) stands for the subtype its value names in
// the discriminator member (objectType: StopPlaceRef). Returns the subtype's
// name, '' when the value names none that OSDM has, null when the value is
// not one to dispatch.
function subtypeNamed(value, schema, ctx) {
  const d = schema.discriminator;
  if (!d || typeOf(value) !== 'object' || typeof value[d.propertyName] !== 'string') return null;
  const named = value[d.propertyName];
  const target = d.mapping?.[named] || named;
  if (target === ctx.owner) return null;
  return ctx.schemas[target] ? target : '';
}

function visitRef(value, name, ctx, path) {
  const inner = { schemas: ctx.schemas, owner: name, depth: ctx.depth + 1, issues: ctx.issues };
  visit(value, ctx.schemas[name], inner, path);
}

function visit(value, schema, ctx, path) {
  if (!schema || ctx.depth > MAX_DEPTH) return;
  if (schema.$ref) { visitRef(value, schema.$ref, ctx, path); return; }
  const subtype = subtypeNamed(value, schema, ctx);
  if (subtype) { visitRef(value, subtype, ctx, path); return; }
  if (subtype === '') {
    const member = schema.discriminator.propertyName;
    ctx.issues.push(`${path ? path + '.' : ''}${member}: names no type of ${ctx.owner}`);
    return;
  }
  if (schema.anyOf) { checkAlternatives(value, schema, ctx, path); return; }
  if (!typeFits(value, schema)) {
    ctx.issues.push(`${path || '(body)'}: expected ${schema.type}${schema.nullable ? ' or null' : ''}, got ${typeOf(value)}`);
    return;
  }
  if (value === null) return;
  const t = typeOf(value);
  if (t === 'object') checkObject(value, schema, ctx, path);
  else if (t === 'array') checkArray(value, schema, ctx, path);
  else if (t === 'string') checkString(value, schema, ctx, path);
}

// The issues of one body against a named schema of a version.
function requestIssues(body, schemaName, version) {
  const v = pickVersion(version);
  const schemas = requestSchemas[v].schemas;
  const ctx = { schemas, owner: schemaName, depth: 0, issues: [] };
  visit(body, { $ref: schemaName }, ctx, '');
  return ctx.issues;
}

// The requests a scenario makes wrong on purpose, to see the provider refuse
// them (#258 sweeps, #703): not OSCAR's mistake, so their check is not a FAIL.
const NEGATIVE_TESTS = [
  { method: 'PATCH', path: '/bookings/{bookingId}/passengers/{passengerId}', variable: 'requestedInformationProbe', value: 'invalid', label: 'passenger negative sweep' },
  { method: 'POST', path: '/bookings/{bookingId}/purchaser', variable: 'bookingPurchaserMode', value: 'invalid', label: 'purchaser negative sweep' },
  { method: 'PATCH', path: '/bookings/{bookingId}/purchaser', variable: 'bookingPurchaserMode', value: 'invalid', label: 'purchaser negative sweep' },
  { method: 'POST', path: '/offers', variable: 'emptyPassengersExpectRejection', value: 'true', label: 'empty passenger list' },
  { method: 'POST', path: '/bookings', variable: '__purchaserAtBookingProbe', value: 'true', label: 'purchaser negative sweep in the booking' },
];

// The negative test a request belongs to, from the run's variables
// (readVariable(name) → value), or null.
function negativeTestOf(op, readVariable) {
  if (!op || typeof readVariable !== 'function') return null;
  const hit = NEGATIVE_TESTS.find((n) => n.method === op.method && n.path === op.path
    && String(readVariable(n.variable) || '').toLowerCase() === n.value);
  return hit ? hit.label : null;
}

function parseBody(body) {
  if (body === undefined || body === null || body === '') return { missing: true };
  if (typeof body !== 'string') return { value: body };
  try { return { value: JSON.parse(body) }; } catch { return { notJson: true }; }
}

/**
 * The check for one request: null when the request has no OSDM body to check
 * (a GET, a token request, an endpoint OSCAR does not know a schema for).
 * Returns { name, ok, message }.
 */
function checkRequestBody(method, url, body, version, readVariable) {
  const op = operationFor(method, url, version || getComplianceVersion());
  if (!op) return null;
  const name = `${TAG} ${op.method} ${op.path} conforms to OSDM ${op.version} ${op.schema}`;
  const negative = negativeTestOf(op, readVariable);
  const parsed = parseBody(body);
  let issues;
  if (parsed.missing) issues = ['(body): no body sent'];
  else if (parsed.notJson) issues = ['(body): not JSON'];
  else issues = requestIssues(parsed.value, op.schema, op.version);
  if (!issues.length) return { name, ok: true, message: '' };
  if (negative) {
    const onPurpose = `${TAG} ${op.method} ${op.path} does not conform to OSDM ${op.version} ${op.schema}, on purpose (negative test: ${negative})`;
    return { name: onPurpose, ok: true, message: '', negative };
  }
  const own = issues.filter((issue) => !isDataGap(issue));
  if (!own.length) {
    const dataName = `${TAG} ${op.method} ${op.path} conforms to OSDM ${op.version} ${op.schema}, but for what the scenario's data lacks (its own check says so)`;
    return { name: dataName, ok: true, message: '', dataGaps: issues.length };
  }
  const shown = own.slice(0, MAX_SHOWN).join('; ');
  const more = own.length > MAX_SHOWN ? `; and ${own.length - MAX_SHOWN} more` : '';
  return {
    name,
    ok: false,
    message: `OSCAR's own request does not conform to OSDM (an OSCAR issue, not the provider's): ${shown}${more}`,
  };
}

// Glue for the global after-response: reads the request that was sent and
// records the check with bruTest. Never throws.
function recordRequestConformance(req, bruTest) {
  try {
    const method = typeof req.getMethod === 'function' ? req.getMethod() : req.method;
    const url = typeof req.getUrl === 'function' ? String(req.getUrl()) : req.url;
    const body = typeof req.getBody === 'function' ? req.getBody() : req.body;
    const check = checkRequestBody(method, url, body, undefined, (n) => bru.getEnvVar(n));
    if (!check) return null;
    bruTest(check.name, () => { if (!check.ok) throw new Error(check.message); });
    return check;
  } catch (e) {
    console.log(`[WARNING] OSCAR request conformance check could not run: ${e?.message}`);
    return null;
  }
}

module.exports = {
  TAG,
  pickVersion,
  operationFor,
  requestIssues,
  negativeTestOf,
  checkRequestBody,
  recordRequestConformance,
  isDataGap,
};
