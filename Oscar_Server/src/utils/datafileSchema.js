// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * datafileSchema.js — is an uploaded file a data file? (#549)
 *
 * The collection checks the data file against
 * Bruno_Collection/json_validator/datafile.schema.json at the start of every
 * run (validateDataFileJsonWithTemplate in library-bruno/validators.js). An
 * upload used to be checked only for being JSON, so `{}` or any other JSON
 * file replaced the company's data file and the first sign was a failed run.
 *
 * schemaProblems() applies the same rules as that run-time check, and no
 * others: type, enum, minLength / maxLength, required, properties of a
 * schema whose type is the string "object", items of a schema whose type is
 * the string "array", and the same reading of null (allowed when the schema
 * type or enum lists it, or for the field names the collection lists). A file
 * this refuses is one every run would refuse; a stricter check (AJV, minimum,
 * maximum) would refuse files the runs accept. Keep the two in step.
 *
 * The walk follows the schema, so its depth is the schema's (a handful of
 * levels), whatever the file holds. It stops at MAX_PROBLEMS.
 *
 * The schema is read from the collection the runs use (COLLECTION_PATH), at
 * each call: the collection is updated in place on deploy, without a restart.
 * In a checkout the repository's own copy is the fallback.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_PROBLEMS = 50;
const MAX_VALUE_TEXT = 60;

// The collection's list of field names whose null it accepts whatever their
// schema says (validators.js, "_legacyNullableNames").
const LEGACY_NULLABLE = new Set([
  'gender', 'updateGender', 'requiresPlaceSelection', 'offerMode',
  'updateFirstName', 'updateLastName', 'updateDateOfBirth',
  'updatePhoneNumber', 'updateEmail', 'requestedOfferParts',
  'serviceClass', 'travelClass', 'refundDate', 'flexibilities',
  'desiredFlexibility', 'overruleCode', 'scenarioAction',
  'accommodationSelection', 'loggingType',
]);

function schemaCandidates() {
  const collection = path.resolve(process.env.COLLECTION_PATH || '/collection');
  return [
    path.join(collection, 'json_validator', 'datafile.schema.json'),
    path.resolve(__dirname, '../../../Bruno_Collection/json_validator/datafile.schema.json'),
  ];
}

/** The datafile schema as an object. Throws when no copy can be read. */
function loadDatafileSchema() {
  let lastErr = null;
  for (const file of schemaCandidates()) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`datafile schema not readable: ${lastErr?.message}`);
}

function typesOf(schema) {
  return Array.isArray(schema.type) ? schema.type : [schema.type];
}

function hasType(type, value) {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':   return Array.isArray(value);
    case 'null':    return value === null;
    case 'number':  return typeof value === 'number' && !Number.isNaN(value);
    default:        return false;
  }
}

function valueText(value) {
  const text = String(value);
  return text.length > MAX_VALUE_TEXT ? `${text.slice(0, MAX_VALUE_TEXT)}…` : text;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The problems that would make a run refuse `datafile`, as sentences naming
 * the place (`scenarios[3].loggingType`). Empty when there are none.
 * Returns { problems, more }: `more` is true when the walk stopped at
 * MAX_PROBLEMS.
 */
function schemaProblems(datafile, schema) {
  const problems = [];
  const full = () => problems.length >= MAX_PROBLEMS;
  const add = text => { if (!full()) problems.push(text); };

  if (!hasType('object', datafile)) {
    let kind = typeof datafile;
    if (datafile === null) kind = 'null';
    else if (Array.isArray(datafile)) kind = 'array';
    return { problems: [`The file holds a JSON ${kind}, not a data file (a JSON object).`], more: false };
  }

  function checkValue(key, value, propSchema, parent) {
    if (full()) return;
    const place = parent ? (key ? `${parent}.${key}` : parent) : key;
    const types = typesOf(propSchema);
    if (value == null) {
      const nullable = types.includes('null')
        || (Array.isArray(propSchema.enum) && propSchema.enum.includes(null));
      if (!nullable && !LEGACY_NULLABLE.has(key)) {
        add(`'${place}' is null, which its type (${types.join(', ')}) does not allow.`);
      }
      return;
    }
    if (!types.some(t => hasType(t, value))) {
      add(`'${place}' has the wrong type: expected ${types.join(', ')}.`);
      return;
    }
    if (propSchema.enum && !propSchema.enum.includes(value)) {
      add(`'${place}' is '${valueText(value)}', which is not one of: ${propSchema.enum.join(', ')}.`);
    }
    if (typeof value === 'string') {
      if (propSchema.minLength && value.length < propSchema.minLength) {
        add(`'${place}' is too short (at least ${propSchema.minLength} characters).`);
      }
      if (propSchema.maxLength && value.length > propSchema.maxLength) {
        add(`'${place}' is too long (at most ${propSchema.maxLength} characters).`);
      }
    }
    if (propSchema.type === 'object' && propSchema.properties) {
      checkObject(value, propSchema, place);
    }
    if (propSchema.type === 'array' && propSchema.items) {
      for (let i = 0; i < value.length && !full(); i++) {
        checkValue('', value[i], propSchema.items, `${place}[${i}]`);
      }
    }
  }

  function checkObject(obj, objSchema, place) {
    for (const key of Object.keys(objSchema.properties || {})) {
      if (own(obj, key)) checkValue(key, obj[key], objSchema.properties[key], place);
    }
    for (const key of objSchema.required || []) {
      if (!(key in obj)) add(`'${place ? place + '.' : ''}${key}' is missing.`);
    }
  }

  // The root: required first, as the collection reports it.
  for (const key of schema.required || []) {
    if (!(key in datafile)) add(`'${key}' is missing.`);
  }
  for (const key of Object.keys(schema.properties || {})) {
    if (own(datafile, key)) checkValue(key, datafile[key], schema.properties[key], '');
  }
  return { problems, more: full() };
}

module.exports = { schemaProblems, loadDatafileSchema, MAX_PROBLEMS, LEGACY_NULLABLE };
