/**
 * osdmEnums.js — Single source of truth for OSDM enum values used by
 * assertion helpers across the collection.
 *
 * Before this module the PassengerType allow-list was duplicated in two
 * places that had drifted out of sync:
 *   - passengers.js (20 values — matches the OSDM PassengerType enum)
 *   - offers.js     (6 values — narrower, rejected valid OSDM types like
 *                    YOUNG_CHILD, DOG, BICYCLE as if they were unknown)
 * Importing from here prevents that class of drift from coming back.
 */

// OSDM PassengerType values. The type is an `x-extensible-enum` in every
// version: the spec says "Values from the Passenger Type Code List … Listed
// values here are examples" (3.8 PassengerType and ActualPassengerType). So a
// value outside this list is not a failure; checkExtensibleCode() reports it
// as a WARNING. Two values are spelt differently across versions, and both
// spellings are listed: COMPANION_DOG and MOTORCYCLE in 3.5
// (json_validator/openapi3_0.json), ACCOMP_DOG and MOTOCYCLE in 3.8 (the
// spec's own spelling). #613 F4.
const OSDM_PASSENGER_TYPES = [
  // Human passengers
  'YOUNG_CHILD', 'CHILD', 'YOUTH', 'ADULT', 'SENIOR',
  'FAMILY_CHILD', 'PERSON',
  // Persons with Reduced Mobility and companions
  'PRM', 'PRM_CHILD', 'WHEELCHAIR', 'ACCOMP_PRM', 'ACCOMP_DOG', 'COMPANION_DOG',
  // Non-human payload types
  'DOG', 'PET', 'LUGGAGE',
  'BICYCLE', 'PRAM',
  'CAR', 'MOTOCYCLE', 'MOTORCYCLE', 'TRAILER',
];

// Grades a value of an extensible OSDM code list (#613 F4). Pure.
//   ok    — the value is a non-empty string (the only hard rule the spec sets)
//   known — the value is one of the listed values
function classifyExtensibleCode(value, listed) {
  const ok = typeof value === 'string' && value.trim() !== '';
  return { ok, known: ok && listed.includes(value) };
}

// Registers one check (FAIL only when the value is missing or not text) and
// logs a WARNING for a value outside the listed ones. `test`, `expect` and
// `log` are passed in so the function can run outside Bruno.
function checkExtensibleCode({ test, expect, log }, label, value, listed, codeList) {
  const { ok, known } = classifyExtensibleCode(value, listed);
  test(`${label} is a non-empty ${codeList} code - value: ${value}`, () => {
    expect(ok, `${label} should be a non-empty string (${codeList})`).to.equal(true);
  });
  if (ok && !known) {
    log(`[WARNING] ${label} '${value}' is not one of the ${codeList} values listed in the OSDM specification. ` +
      `The list is extensible (values come from the ${codeList} code list on osdm.io), so this is not a failure, ` +
      `but a code other than the published ones is unlikely to be understood by other distributors.`);
  }
  return { ok, known };
}

module.exports = {
  OSDM_PASSENGER_TYPES,
  classifyExtensibleCode,
  checkExtensibleCode,
};
