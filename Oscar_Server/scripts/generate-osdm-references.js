#!/usr/bin/env node
/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * Generates Oscar_Server/src/utils/osdm-references.json (#827 PR B): for each
 * OSDM version, every operation (its summary, its request body and its
 * success responses, by schema name) and every schema in a short text form,
 * for the AI analysis to quote the specification of the version a provider
 * declares. Never hand-edit the output.
 *
 * Input: the OSDM specification files, named OSDM-online-api-v<X>.0.yml, in
 * the folder OSDM_SPEC_DIR (default: Documentation/Test_Coverage/OSDM_reference,
 * which holds 3.8). The others come from
 *   https://raw.githubusercontent.com/UnionInternationalCheminsdeFer/OSDM/gh-pages/specification/v<X>/OSDM-online-api-v<X>.0.yml
 *
 * Copy the repository's 3.8 file into that folder first: it is the one
 * pinned by tests/unit/osdm-references.test.js (gh-pages carries an older
 * 3.8.0 print).
 *
 *   OSDM_SPEC_DIR=/tmp/osdm node scripts/generate-osdm-references.js
 *
 * A schema's text: its kind, the first sentence of its description, its
 * required members, and each member with its type (a schema name, a list of
 * one, a closed enum with its values, an extensible one with its examples).
 * Member descriptions are left out: they would triple the size.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '..', '..');
const SPEC_DIR = process.env.OSDM_SPEC_DIR
  || path.join(REPO, 'Documentation', 'Test_Coverage', 'OSDM_reference');
const OUT = path.join(REPO, 'Oscar_Server', 'src', 'utils', 'osdm-references.json');
const VERSIONS = ['3.4', '3.5', '3.6', '3.7', '3.8'];
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_VALUES = 12;

const refName = (ref) => String(ref).replace('#/components/schemas/', '');

function firstSentence(text, max = 160) {
  const t = String(text || '').replaceAll(/\s+/g, ' ').trim();
  if (!t) return '';
  const dot = t.search(/\.(\s|$)/);
  const s = dot > 0 ? t.slice(0, dot + 1) : t;
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function values(list) {
  const shown = list.slice(0, MAX_VALUES).map(String).join('|');
  return list.length > MAX_VALUES ? `${shown}|…` : shown;
}

// The type of a member, in a few words, and the schema names it refers to.
function typeOf(schema, refs) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) { refs.add(refName(schema.$ref)); return refName(schema.$ref); }
  for (const key of ['oneOf', 'anyOf']) {
    if (Array.isArray(schema[key])) return `one of (${schema[key].map((s) => typeOf(s, refs)).join(' | ')})`;
  }
  if (Array.isArray(schema.allOf)) return schema.allOf.map((s) => typeOf(s, refs)).join(' & ');
  if (schema.type === 'array') return `${typeOf(schema.items, refs)}[]`;
  const extras = [];
  if (Array.isArray(schema.enum)) extras.push(`closed enum: ${values(schema.enum)}`);
  if (Array.isArray(schema['x-extensible-enum'])) extras.push(`extensible, examples: ${values(schema['x-extensible-enum'])}`);
  if (schema.format) extras.push(schema.format);
  if (schema.nullable) extras.push('nullable');
  if (schema.deprecated) extras.push('deprecated');
  const base = schema.type || (schema.properties ? 'object' : 'any');
  return extras.length ? `${base} (${extras.join('; ')})` : base;
}

// allOf parts merged: their members, their required lists, the schemas extended.
function flatten(schema) {
  const out = { properties: {}, required: [], extends: [], description: schema.description };
  const parts = Array.isArray(schema.allOf) ? schema.allOf : [schema];
  for (const part of parts) {
    if (part.$ref) { out.extends.push(refName(part.$ref)); continue; }
    Object.assign(out.properties, part.properties || {});
    out.required.push(...(part.required || []));
    out.description ||= part.description;
  }
  if (parts !== schema.allOf) return out;
  Object.assign(out.properties, schema.properties || {});
  out.required.push(...(schema.required || []));
  return out;
}

function schemaText(name, schema) {
  const refs = new Set();
  const lines = [];
  if (schema.type === 'array') {
    lines.push(`${name}: a list of ${typeOf(schema.items, refs)}.`);
  } else if (Array.isArray(schema.enum) || Array.isArray(schema['x-extensible-enum']) || (schema.type && schema.type !== 'object' && !schema.properties)) {
    lines.push(`${name}: ${typeOf(schema, refs)}.`);
  } else if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
    lines.push(`${name}: ${typeOf(schema, refs)}.`);
  } else {
    const f = flatten(schema);
    const kind = f.extends.length ? `object, extends ${f.extends.join(', ')}` : 'object';
    f.extends.forEach((e) => refs.add(e));
    lines.push(`${name} (${kind}).`);
    const required = [...new Set(f.required)];
    if (required.length) lines.push(`Required: ${required.join(', ')}.`);
    const members = Object.entries(f.properties).map(([m, s]) => `${m}: ${typeOf(s, refs)}`);
    if (members.length) lines.push(`Members: ${members.join('; ')}.`);
    if (schema.discriminator?.propertyName) lines.push(`Subtype named by ${schema.discriminator.propertyName}.`);
  }
  const about = firstSentence(schema.description);
  if (about) lines.splice(1, 0, about);
  return { text: lines.join(' '), refs: [...refs].sort((a, b) => a.localeCompare(b)) };
}

// The schema name of a request body or response, through components.responses.
function bodySchema(spec, node) {
  let n = node;
  if (n?.$ref?.startsWith('#/components/responses/')) n = spec.components?.responses?.[n.$ref.split('/').pop()];
  const schema = n?.content?.['application/json']?.schema;
  if (!schema) return null;
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === 'array' && schema.items?.$ref) return `${refName(schema.items.$ref)}[]`;
  return null;
}

function versionOf(spec) {
  const operations = {};
  for (const [p, item] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const responses = {};
      for (const [code, r] of Object.entries(op.responses || {})) {
        if (!/^2\d\d$/.test(code)) continue;
        responses[code] = bodySchema(spec, r);
      }
      operations[`${method.toUpperCase()} ${p}`] = {
        summary: firstSentence(op.summary || op.description, 200),
        request: bodySchema(spec, op.requestBody),
        responses,
      };
    }
  }
  const schemas = {};
  for (const [name, schema] of Object.entries(spec.components?.schemas || {})) schemas[name] = schemaText(name, schema);
  return { operations, schemas };
}

function main() {
  const out = { $comment: 'GENERATED by Oscar_Server/scripts/generate-osdm-references.js (#827) - do not hand-edit.', versions: {} };
  for (const v of VERSIONS) {
    const file = path.join(SPEC_DIR, `OSDM-online-api-v${v}.0.yml`);
    if (!fs.existsSync(file)) { console.warn(`missing ${file}: skipped`); continue; }
    const spec = yaml.load(fs.readFileSync(file, 'utf8'));
    out.versions[`${v}.0`] = versionOf(spec);
    console.log(`${v}.0: ${Object.keys(out.versions[`${v}.0`].operations).length} operations, ${Object.keys(out.versions[`${v}.0`].schemas).length} schemas`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log(`${OUT}: ${fs.statSync(OUT).size} bytes`);
}

if (require.main === module) main();

module.exports = { schemaText, typeOf, versionOf, firstSentence };
