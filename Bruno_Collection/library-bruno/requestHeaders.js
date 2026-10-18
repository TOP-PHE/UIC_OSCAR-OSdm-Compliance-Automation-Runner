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

// #833: the simulator's fault codes ("offer.price-below-parts"): nothing else
// reaches the header, so a template or a line break never does.
// Any word of safe characters goes out: the simulator refuses a code it does
// not know (400 UNKNOWN_FAULT), so a typing mistake shows instead of being dropped.
const FAULT_CODE = /^[A-Za-z0-9._-]{1,60}$/;
const MAX_FAULTS = 20;

/**
 * The X-Simulator-Faults value of a scenario's simulatorFaults (#833): a
 * list or "a, b", its codes joined by commas; '' when none.
 */
function simulatorFaultsValue(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
  return [...new Set(list.map((c) => String(c).trim()).filter((c) => FAULT_CODE.test(c)))].slice(0, MAX_FAULTS).join(',');
}

/**
 * Put the scenario's faults on the request, for the OSDM simulator (#833 PR C):
 * the run variable `simulatorFaults`, set by the scenario parser. Returns the
 * value sent, or '' when the scenario names none (no header then).
 */
function applySimulatorFaults(req, value) {
  const faults = simulatorFaultsValue(value);
  if (faults && req && typeof req.setHeader === 'function') req.setHeader('X-Simulator-Faults', faults);
  return faults;
}

module.exports = { dropUnsetRequestor, requestorHeader, simulatorFaultsValue, applySimulatorFaults };
