/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * requestHeaders.js — headers the collection adjusts on every request.
 *
 * #692: 47 request files carry `Requestor: {{requestor}}`. The runner writes
 * the `requestor` variable only when the tester's API Config has one, and
 * Bruno sends a template whose variable is missing as its text: every request
 * of a real provider's run went out with `Requestor: {{requestor}}`. With no
 * requestor, the header is left out instead.
 */

const isUnset = (value) => value == null || String(value).trim() === '';

/**
 * Remove every `Requestor` header (any case) when no requestor is set.
 * Returns true when one was removed.
 */
function dropUnsetRequestor(req, requestor) {
  if (!isUnset(requestor)) return false;
  const headers = (req && typeof req.getHeaders === 'function' && req.getHeaders()) || {};
  const names = Object.keys(headers).filter((name) => name.toLowerCase() === 'requestor');
  names.forEach((name) => req.deleteHeader(name));
  return names.length > 0;
}

/** The Requestor header for a request a script sends itself: none when unset. */
function requestorHeader(requestor) {
  return isUnset(requestor) ? {} : { Requestor: String(requestor) };
}

module.exports = { dropUnsetRequestor, requestorHeader };
