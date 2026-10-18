// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiMask.js — a request or response body as the AI analysis may send it
 * (#827 PR C). Pure.
 *
 * The maintainer's rule (2026-10-18): what a run sends and receives is test
 * data and may be sent, except the personal data of passengers and
 * purchasers and anything about the connection. So:
 *  - the members that hold a person's data are masked wherever they are:
 *    names, date of birth, gender, e-mail, phone, address, documents of
 *    identity, reduction and loyalty cards, and a contact or address object
 *    as a whole;
 *  - connection data never appears: tokens, client ids and secrets,
 *    passwords, the requestor, authorisation; headers are never read at all;
 *    and an address of the web (http…) is replaced, since it names the
 *    provider's host;
 *  - a Problem's title and detail are masked, its code kept: they are free
 *    text and often quote a passenger's name;
 *  - long text (a document's content, base64) is replaced by its length.
 * Lists are cut to a few items and the whole is cut to a size: the model
 * needs the shape and the values that matter, not every offer.
 */

const MASK = '<masked>';
const MAX_ITEMS = 3;
const MAX_DEPTH = 10;
const MAX_STRING = 300;
const MAX_SAMPLE_CHARS = 6000;

// Compared lower-case, without "_" or "-".
const PERSONAL = new Set([
  'firstname', 'lastname', 'middlename', 'fullname', 'givenname', 'familyname', 'surname', 'nameprefix', 'namesuffix',
  'dateofbirth', 'birthdate', 'birthday', 'gender', 'sex',
  'email', 'emailaddress', 'mail', 'phone', 'phonenumber', 'mobile', 'mobilenumber', 'fax',
  'address', 'addresses', 'street', 'streetname', 'housenumber', 'postalcode', 'postcode', 'zipcode',
  'contact', 'contacts', 'contactinformation',
  'reductioncards', 'reductioncard', 'cardnumber', 'cardid', 'loyaltycards', 'loyaltycard', 'loyaltynumber',
  'identificationcard', 'identificationnumber', 'identitydocument', 'identitydocuments', 'travelaccount', 'travelaccounts',
  'passportnumber', 'documentnumber', 'nationality', 'customeraccount', 'customernumber', 'companyname', 'taxid', 'vatnumber',
  'personalinformation', 'personaldetails',
]);
const CONNECTION = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer', 'authorization', 'auth', 'apikey', 'key', 'secret',
  'clientid', 'clientsecret', 'password', 'passwd', 'pwd', 'requestor', 'requestorid', 'session', 'sessionid', 'cookie',
]);
const PROBLEM_TEXT = new Set(['title', 'detail']);

const norm = (k) => String(k).toLowerCase().replaceAll(/[_-]/g, '');

// A Problem (RFC 9457) as OSDM gives it: a code and a title or detail.
const isProblem = (o) => typeof o.code === 'string' && (Object.hasOwn(o, 'title') || Object.hasOwn(o, 'detail'));

function maskString(s) {
  if (/^https?:\/\//i.test(s.trim())) return '<url>';
  if (s.length > MAX_STRING) return `<${s.length} characters>`;
  return s;
}

function maskValue(value, depth) {
  if (depth > MAX_DEPTH) return '<…>';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_ITEMS).map((v) => maskValue(v, depth + 1));
    if (value.length > MAX_ITEMS) shown.push(`<${value.length - MAX_ITEMS} more>`);
    return shown;
  }
  if (typeof value === 'object') {
    const problem = isProblem(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const n = norm(k);
      if (PERSONAL.has(n) || CONNECTION.has(n) || (problem && PROBLEM_TEXT.has(n))) out[k] = v === null ? null : MASK;
      else out[k] = maskValue(v, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * A body as stored by a run (text), masked: the JSON value, or a sentence
 * when it is not JSON; null when there is none. Cut to MAX_SAMPLE_CHARS of
 * JSON, in which case `{ cut: true, start: "<first characters>" }`.
 */
function maskBody(text) {
  if (text === null || text === undefined || text === '') return null;
  let value;
  try { value = JSON.parse(String(text)); } catch { return `<not JSON, ${String(text).length} characters>`; }
  const masked = maskValue(value, 0);
  const json = JSON.stringify(masked);
  if (json.length <= MAX_SAMPLE_CHARS) return masked;
  return { cut: true, start: json.slice(0, MAX_SAMPLE_CHARS) };
}

module.exports = { maskBody, maskValue, MASK, MAX_SAMPLE_CHARS, PERSONAL, CONNECTION };
