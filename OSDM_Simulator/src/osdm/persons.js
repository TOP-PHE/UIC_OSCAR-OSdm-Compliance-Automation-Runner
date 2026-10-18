// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * persons.js — checks on passenger and purchaser data, and requested
 * information (#611), on a provider whose profile sets `personChecks`.
 *
 *   - A passenger update (PATCH) is refused when a value it sends is not
 *     valid: gender not in the OSDM list, a date of birth that is no date,
 *     an e-mail or phone number of the wrong form, an empty name.
 *   - A purchaser written (POST, PATCH) must have a first and a last name, and
 *     valid contact data.
 *   - The offers of a trip from `personChecks.requestedInformationFrom` ask
 *     for each passenger's date of birth and phone number
 *     (`requestedInformation`), and so does the booking while one is missing.
 *     A passenger update that leaves a demanded field empty is refused.
 *
 * A refusal is a 400 Problem whose detail names the field, with a pointer.
 */

const { HttpError } = require('../http');

const GENDERS = ['MALE', 'FEMALE', 'X'];
const REQUESTED = 'passengerSpecifications[ANY].dateOfBirth AND passengerSpecifications[ANY].detail.contact.phoneNumber';
const REQUESTED_FIELDS = ['dateOfBirth', 'phoneNumber'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?\d[\d ()-]{5,19}$/;

const refused = (field, pointer, detail) => new HttpError(400, 'INVALID_PERSON_DATA', 'Person data not valid',
  `${field}: ${detail}`, {}, { pointers: [{ requestPointer: pointer }] });

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

const contactOf = (detail) => ({
  email: detail?.contact?.email ?? detail?.email,
  phoneNumber: detail?.contact?.phoneNumber ?? detail?.phoneNumber,
});

// The contact and name fields of a person detail; `required` names the names that must be there.
function checkDetail(detail, pointer, { requireNames = false } = {}) {
  for (const field of ['firstName', 'lastName']) {
    const value = detail?.[field];
    if (value === undefined && !requireNames) continue;
    if (typeof value !== 'string' || value.trim() === '') throw refused(field, `${pointer}/${field}`, 'is required and must not be empty');
  }
  const { email, phoneNumber } = contactOf(detail);
  if (email !== undefined && (typeof email !== 'string' || !EMAIL.test(email))) {
    throw refused('email', `${pointer}/contact/email`, `"${String(email).slice(0, 60)}" is not an e-mail address`);
  }
  if (phoneNumber !== undefined && (typeof phoneNumber !== 'string' || !PHONE.test(phoneNumber))) {
    throw refused('phoneNumber', `${pointer}/contact/phoneNumber`, `"${String(phoneNumber).slice(0, 60)}" is not a phone number`);
  }
}

/** A passenger update, before it is applied. */
function checkPassengerPatch(body, provider) {
  if (!provider.personChecks) return;
  if (body.gender !== undefined && !GENDERS.includes(body.gender)) {
    throw refused('gender', '/gender', `"${String(body.gender).slice(0, 30)}" is not one of ${GENDERS.join(', ')}`);
  }
  if (body.dateOfBirth !== undefined && !isDate(body.dateOfBirth)) {
    throw refused('dateOfBirth', '/dateOfBirth', `"${String(body.dateOfBirth).slice(0, 30)}" is not a date (YYYY-MM-DD)`);
  }
  if (body.detail !== undefined) checkDetail(body.detail, '/detail');
}

/** A purchaser written: names required, contact data valid. */
function checkPurchaser(body, provider) {
  if (!provider.personChecks) return;
  checkDetail(body?.detail, '/detail', { requireNames: true });
}

/** Whether the offers of these trips ask for requested information. */
function asksForInformation(trips, provider) {
  const from = provider.personChecks?.requestedInformationFrom;
  return !!from && trips.some((t) => t.origin?.stopPlaceRef === from);
}

const RI = Symbol('requested information');

function markRequestedInformation(booking, asked) {
  Object.defineProperty(booking, RI, { value: asked === true });
}

const missingOf = (passenger) => REQUESTED_FIELDS.filter((field) => {
  const value = field === 'phoneNumber' ? contactOf(passenger.detail).phoneNumber : passenger[field];
  return value === undefined || value === '';
});

/** The booking's requestedInformation while a demanded field is missing. */
function showRequestedInformation(booking) {
  if (!booking[RI]) return;
  if (booking.passengers.some((p) => missingOf(p).length > 0)) booking.requestedInformation = REQUESTED;
  else delete booking.requestedInformation;
}

/** After a passenger update on such a booking: every demanded field set. */
function checkDemanded(booking, passenger) {
  if (!booking[RI]) return;
  const [missing] = missingOf(passenger);
  if (missing) {
    throw refused(missing, missing === 'phoneNumber' ? '/detail/contact/phoneNumber' : `/${missing}`,
      `is requested (requestedInformation: ${REQUESTED}) and must be provided`);
  }
}

module.exports = {
  REQUESTED, checkPassengerPatch, checkPurchaser, asksForInformation, markRequestedInformation,
  showRequestedInformation, checkDemanded,
};
