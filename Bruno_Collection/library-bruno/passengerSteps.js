/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * passengerSteps.js — which passenger steps 03 (PATCH) and 04 (GET) go to
 * next (#881).
 *
 * The steps go through the passengers by index, pairing the booking's ids
 * (`passengerIdList`, aligned to the order sent) with the data of each
 * passenger. A booking that lacks a passenger has no id at that index: step
 * 02 already fails it ("Booking contains exactly the expected number of
 * passengers"), so 03 and 04 leave that passenger out with one WARNING
 * instead of sending `…/passengers/undefined` with a body without `id`.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const isId = (v) => typeof v === 'string' ? v.trim() !== '' : (typeof v === 'number' && Number.isFinite(v));

/** The booking's passenger ids, from an env value that may be an array or JSON text. */
function idsOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : raw.split(','); } catch { return raw.split(','); }
  }
  return [];
}

const withTransportables = (result, found) => (found.length > 0 ? { ...result, transportables: found } : result);

/**
 * The first index at or after `from` (below `total`) whose passenger has an
 * id, and the indices left out on the way. `index` is -1 when none is left.
 * #1045: a passenger `isTransportableAt(i)` says is not a person has no
 * personal data to update or read back; its index goes in `transportables`.
 */
function nextPassengerWithId(ids, from, total, isTransportableAt) {
  const skipped = [];
  const found = [];
  for (let i = Math.max(0, from); i < total; i++) {
    if (isTransportableAt?.(i)) { found.push(i); continue; }
    if (isId(ids[i])) return withTransportables({ index: i, skipped }, found);
    skipped.push(i);
  }
  return withTransportables({ index: -1, skipped }, found);
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

const WHAT = { update: 'update (03. PATCH Multi Passenger)', read: 'read-back (04. GET Passenger)' };

/**
 * The passenger a step goes to from `from`: its index, or -1 when none is
 * left. A WARNING per passenger left out because the booking does not hold it.
 */
function choosePassenger(step, from) {
  const { validationLogger } = require('./displays.js');
  const total = Number(bru.getEnvVar('offerPassengerNumber')) || 0;
  let refs = [];
  try { refs = JSON.parse(bru.getEnvVar('bookingPassengerReferences') || '[]'); } catch { refs = []; }
  const { isTransportable, typesOf } = require('./transportables.js');
  const types = typesOf(bru.getEnvVar('bookingPassengerSpecifications'));
  const { index, skipped, transportables = [] } = nextPassengerWithId(
    idsOf(bru.getEnvVar('passengerIdList')), Number(from) || 0, total, (i) => isTransportable(types[i]));
  const refOf = (i) => (refs[i] !== undefined ? ` (externalRef ${refs[i]})` : '');
  for (const i of transportables) {
    validationLogger(`[INFO] Passenger ${i}${refOf(i)} is a ${types[i]}, not a person: no ${WHAT[step] || step}.`);
  }
  for (const i of skipped) {
    validationLogger(`[WARNING] Passenger ${i}${refOf(i)} is not in the booking: its ${WHAT[step] || step} is not tested. Step 02 reports the missing passenger.`);
  }
  return index;
}

module.exports = { idsOf, nextPassengerWithId, choosePassenger };
