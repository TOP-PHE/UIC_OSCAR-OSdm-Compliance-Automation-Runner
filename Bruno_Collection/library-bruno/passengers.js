/**
 * passengers.js — validate the per-passenger PATCH/GET responses (`03`/`04`).
 *
 * After OSCAR PATCHes each passenger's details (name, DOB, gender, contact),
 * this checks the response echoed the sent data back correctly and that the
 * passenger object is OSDM-conformant (e.g. type in the PassengerType enum).
 */
const { validationLogger } = require('./displays.js');
const { bruTest: test } = require('./testCapture.js');
const { OSDM_PASSENGER_TYPES, checkExtensibleCode } = require('./osdmEnums.js');

module.exports = {
  patchMultiPassengerResponse
};

// Function to validate passenger data
function patchMultiPassengerResponse(response, passengerIndex) {
  const { firstName, lastName } = response.passenger?.detail || {};
  const dateOfBirth = response.passenger?.dateOfBirth;
  const gender      = response.passenger?.gender;

  // Email/phone moved from detail.{email,phoneNumber} (now deprecated) into
  // detail.contact.{email,phoneNumber} (ContactDetail) at OSDM 3.1. Read
  // contact-first, then fall back to the deprecated flat fields — robust across
  // 3.0.x and 3.1+ with no version guessing. (Replaces an earlier `>= 3.4`
  // boundary that false-failed on 3.1–3.3 servers returning contact-only, and
  // mis-parsed a bare "3" osdmVersion.)
  const detail = response.passenger?.detail || {};
  const phoneNumber = detail.contact?.phoneNumber ?? detail.phoneNumber ?? "";
  const email       = detail.contact?.email       ?? detail.email       ?? "";

  const totalPassengers = Number(bru.getEnvVar("offerPassengerNumber")) || 0;
  const passengerDataRaw = bru.getEnvVar("passengerAdditionalData") || "[]";
  const passenger = (typeof passengerDataRaw === "string" ? JSON.parse(passengerDataRaw) : passengerDataRaw)[passengerIndex];

  if (passengerIndex >= totalPassengers || !passenger) {
    validationLogger("[INFO] ✅ All passengers already processed. Skipping further validation.");
    return;
  }

  // G2: passenger.type is an extensible OSDM code list (#613 F4): FAIL only
  // when it is not text; a value outside the listed ones is a WARNING.
  const _passengerType = response.passenger?.type;
  if (_passengerType !== undefined) {
    checkExtensibleCode({ test, expect, log: validationLogger },
      `Passenger ${passengerIndex} - type`, _passengerType, OSDM_PASSENGER_TYPES, 'PassengerType');
  }

  // G1: passenger.id must remain a non-empty string after PATCH (OSDM: id must not change)
  const _passengerId = response.passenger?.id;
  test(`Passenger ${passengerIndex} - id is a non-empty string after PATCH (OSDM: Passenger.id immutable)`, () => {
    expect(_passengerId).to.be.a('string').and.not.be.empty;
    validationLogger(`[DEBUG] Passenger ${passengerIndex} id after PATCH: ${_passengerId}`);
  });
  // G1: id must still be in the list from the original booking
  const _passengerIdListRaw = bru.getEnvVar("passengerIdList");
  const _passengerIdList = _passengerIdListRaw
    ? (Array.isArray(_passengerIdListRaw) ? _passengerIdListRaw : JSON.parse(_passengerIdListRaw))
    : [];
  if (_passengerIdList.length > 0 && _passengerId) {
    test(`Passenger ${passengerIndex} - id unchanged after PATCH (still in booking passengerIdList)`, () => {
      expect(_passengerIdList).to.include(_passengerId,
        `Passenger id '${_passengerId}' is not in the original booking passengerIdList`);
    });
  }

  validationLogger(`[DEBUG] Comparing passenger ${passengerIndex} values with expected values from data file.`);

  // A member the booking or the update gave must come back with the same
  // value: a different value is a FAIL. One the provider does not return at
  // all is a WARNING: OSDM does not oblige a provider to keep what it does not
  // need (some providers keep only the main passenger's names, and no date of birth).
  const sameOrAbsent = (label, expected, actual) => {
    const name = `Passenger ${passengerIndex} - ${label} is correct (expected: ${expected}, actual: ${actual})`;
    const absent = actual === undefined || actual === null || actual === "";
    const wanted = expected !== undefined && expected !== null && expected !== "";
    if (absent && wanted) {
      validationLogger(`[WARNING] Passenger ${passengerIndex} - ${label} not returned by the provider (sent: ${expected}); OSDM does not require it to be kept.`);
      test(`Passenger ${passengerIndex} - ${label} not returned by the provider (WARNING, optional member)`, () => {});
      return;
    }
    test(name, () => {
      validationLogger(`[DEBUG] ${name}`);
      if (absent && !wanted) return; // nothing sent, nothing returned
      expect(actual).to.equal(expected);
    });
  };
  sameOrAbsent('First name', passenger.updateFirstName, firstName);
  sameOrAbsent('Last name', passenger.updateLastName, lastName);
  sameOrAbsent('Date of birth', passenger.updateDateOfBirth, dateOfBirth);
  sameOrAbsent('Phone number', passenger.updatePhoneNumber, phoneNumber);
  sameOrAbsent('Email', passenger.updateEmail, email);

  if (gender != null) {
    test(`Passenger ${passengerIndex} - Gender is correct (expected: ${passenger.updateGender}, actual: ${gender})`, () => {
      validationLogger(`[DEBUG] Passenger ${passengerIndex} - Gender is correct (expected: ${passenger.updateGender}, actual: ${gender})`);
      expect(gender).to.equal(passenger.updateGender);
    });
  }
}

// Expose to global for convenience in eval/require loader flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
