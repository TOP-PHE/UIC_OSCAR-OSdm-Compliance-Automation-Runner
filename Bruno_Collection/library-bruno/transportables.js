/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * transportables.js — passengers that are not persons (#1045, a fare
 * expert's review of the simulator's bicycle scenario).
 *
 * OSDM lists them as TransportableType (3.8: PET, DOG, ACCOMP_DOG, BICYCLE,
 * LUGGAGE, PRAM, CAR, SPECIAL_VEHICLE, MOTOCYCLE, TRAILER; 3.5 spelt two of
 * them COMPANION_DOG and MOTORCYCLE). Such a passenger is sent with its
 * reference, type and cards only: a date of birth, a gender, a name or a
 * contact describe a person. The data file's schema asks every passenger
 * for them, so they are left out here, when the requests are built, and the
 * passenger steps 03 and 04 leave a transportable out.
 *
 * Pure: no Bruno globals.
 */

const TRANSPORTABLE_TYPES = new Set([
  'PET', 'DOG', 'ACCOMP_DOG', 'COMPANION_DOG', 'BICYCLE', 'LUGGAGE', 'PRAM',
  'CAR', 'SPECIAL_VEHICLE', 'MOTOCYCLE', 'MOTORCYCLE', 'TRAILER',
]);

// What the data file may give a passenger that only a person has.
const PERSONAL_FIELDS = ['dateOfBirth', 'gender', 'firstName', 'lastName', 'email', 'phoneNumber'];

/** Is a passenger of this type a transportable (not a person)? */
function isTransportable(type) {
  return typeof type === 'string' && TRANSPORTABLE_TYPES.has(type.trim().toUpperCase());
}

/** The personal fields the data file gives a passenger (with a value). */
function personalFieldsOf(passenger) {
  return PERSONAL_FIELDS.filter((key) => passenger?.[key] != null && passenger[key] !== '');
}

/** A transportable as a passenger specification: reference, type and cards. */
function transportableSpec(externalRef, type, cards) {
  const spec = { externalRef, type };
  if (Array.isArray(cards) && cards.length > 0) spec.cards = cards;
  return spec;
}

/** The types of the passengers sent, by index, from an env value (array or JSON text). */
function typesOf(raw) {
  let specs = raw;
  if (typeof raw === 'string') {
    try { specs = JSON.parse(raw); } catch { specs = []; }
  }
  return Array.isArray(specs) ? specs.map((s) => (s && typeof s === 'object' ? s.type : undefined)) : [];
}

module.exports = { TRANSPORTABLE_TYPES, PERSONAL_FIELDS, isTransportable, personalFieldsOf, transportableSpec, typesOf };
