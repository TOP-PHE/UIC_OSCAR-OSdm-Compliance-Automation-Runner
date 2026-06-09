/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * osdmSchema.js — Layer-2 (deep, version-matched) OSDM compliance validation
 * ===========================================================================
 * Validates a System-Information response item against the compact, version-
 * matched schema for the OSDM version the test framework declares
 * (getComplianceVersion()). Pure JS — no AJV, no node modules, no network — so
 * it runs identically in the Bruno UI sandbox and the OSCAR server CLI.
 *
 * Schemas live in osdmSchemas.js (generated, depth-2: top level + one nested
 * level; extensible-enums as plain strings; polymorphic types relaxed). Layer 2
 * complements Layer 1 (osdmCompliance.js) by validating nested objects/arrays —
 * e.g. Product.serviceClass.{type,name}, which Layer 1 only checks is an object.
 *
 * Usage (mapped into bruTest by the scenario, like the Layer-1 validators):
 *   const { validateSchema } = require(bru.getEnvVar("library_base") + "osdmSchema.js");
 *   validateSchema('Product', body.products, { endpoint: '/products' })
 *     .forEach((c) => bruTest(c.name, () => { expect(c.ok, c.message).to.be.true; }));
 */

const { schemas } = require('./osdmSchemas.js');
const { getComplianceVersion, versionScore } = require('./osdmVersion.js');

function isType(value, type) {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number' && !Number.isNaN(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':    return value === null;
    default:        return true; // no/unknown type → no constraint
  }
}

// Nearest bundled schema version for a target compliance version: the highest
// available version <= target; if none is <= target, the lowest available
// (so e.g. 3.9 → 3.8, and a hypothetical 3.2 → 3.4).
function pickSchemaVersion(target, available) {
  const avail = (available || []).slice().sort((a, b) => versionScore(a) - versionScore(b));
  if (avail.length === 0) return null;
  const t = versionScore(target);
  let best = null;
  avail.forEach((v) => { if (versionScore(v) <= t) best = v; });
  return best || avail[0];
}

// Recursively collect schema violations as readable "path: message" strings.
function collectIssues(value, schema, path, issues) {
  if (!schema || typeof schema !== 'object') return;
  const t = schema.type;
  if (t && !isType(value, t)) {
    issues.push(`${path}: expected ${t}, got ${value === null ? 'null' : (Array.isArray(value) ? 'array' : typeof value)}`);
    return; // wrong type — can't recurse meaningfully
  }
  if (schema.enum && value != null && !schema.enum.includes(value)) {
    issues.push(`${path}: '${value}' not in [${schema.enum.join(', ')}]`);
  }
  if (t === 'object' && isType(value, 'object')) {
    (schema.required || []).forEach((req) => {
      if (value[req] == null) issues.push(`${path}.${req}: required property missing`);
    });
    if (schema.properties) {
      Object.keys(schema.properties).forEach((pn) => {
        if (value[pn] != null) collectIssues(value[pn], schema.properties[pn], `${path}.${pn}`, issues);
      });
    }
  }
  if (t === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((it, i) => collectIssues(it, schema.items, `${path}[${i}]`, issues));
  }
}

// Validate a single item against the matched version's component schema.
// Returns { version, component, issues:[...], hasSchema:boolean }.
function validateItemSchema(component, item, version) {
  const v = pickSchemaVersion(version || getComplianceVersion(), Object.keys(schemas));
  const compSchema = v && schemas[v] ? schemas[v][component] : null;
  if (!compSchema) return { version: v, component, issues: [], hasSchema: false };
  const issues = [];
  collectIssues(item, compSchema, component, issues);
  return { version: v, component, issues, hasSchema: true };
}

// Validate one item OR an array of items and return aggregated bruTest-style
// results: one check per component naming the matched OSDM version, with the
// (capped) list of deep issues in the failure message.
function validateSchema(component, items, opts) {
  opts = opts || {};
  const endpoint = opts.endpoint || '';
  const version = opts.version || getComplianceVersion();
  const v = pickSchemaVersion(version, Object.keys(schemas));
  const compSchema = v && schemas[v] ? schemas[v][component] : null;

  if (!compSchema) {
    return [{
      name: `GET ${endpoint} → deep ${component} schema — no bundled schema for OSDM ${version} (skipped)`,
      ok: true,
      message: '',
    }];
  }

  const list = Array.isArray(items) ? items : [items];
  const allIssues = [];
  list.forEach((it, i) => collectIssues(it, compSchema, `${component}[${i}]`, allIssues));

  const capped = allIssues.slice(0, 8);
  return [{
    name: `GET ${endpoint} → conforms to OSDM ${v} ${component} schema (deep)`,
    ok: allIssues.length === 0,
    message: allIssues.length === 0
      ? ''
      : `${allIssues.length} schema issue(s): ${capped.join(' | ')}${allIssues.length > capped.length ? ' …' : ''}`,
  }];
}

module.exports = {
  isType,
  pickSchemaVersion,
  collectIssues,
  validateItemSchema,
  validateSchema,
};

// Expose to globalThis for convenience inside the Bruno sandbox (convention).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
