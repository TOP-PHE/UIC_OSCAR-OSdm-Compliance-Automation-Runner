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
// The members a provider says it ignored (#729): a PATCH answer may carry
// PARAMETER_NOT_SUPPORTED "Parameter 'dateOfBirth' was ignored." next to
// HTTP 200, and the passenger then keeps the value it had.
const { ignoredParameters } = require('./ignoredParameters.js');

module.exports = {
  patchMultiPassengerResponse,
  ignoredParameters
};

// The ignored members are kept per passenger from 03 so that 04 (a GET, with
// no problem to read) grades the same members the same way.
function ignoredFor(response, passengerIndex) {
  let kept = {};
  try {
    const raw = bru.getEnvVar("__passengerIgnoredFields");
    if (typeof raw === "string" && raw) kept = JSON.parse(raw);
    else if (raw && typeof raw === "object") kept = raw;
  } catch { kept = {}; }
  const fromAnswer = ignoredParameters(response);
  if (fromAnswer.length) {
    const merged = [...new Set([...(kept[passengerIndex] || []), ...fromAnswer])];
    kept[passengerIndex] = merged;
    bru.setEnvVar("__passengerIgnoredFields", JSON.stringify(kept));
  }
  return new Set(kept[passengerIndex] || []);
}

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
  let _passengerIdList = [];
  if (Array.isArray(_passengerIdListRaw)) _passengerIdList = _passengerIdListRaw;
  else if (_passengerIdListRaw) _passengerIdList = JSON.parse(_passengerIdListRaw);
  if (_passengerIdList.length > 0 && _passengerId) {
    test(`Passenger ${passengerIndex} - id unchanged after PATCH (still in booking passengerIdList)`, () => {
      expect(_passengerIdList).to.include(_passengerId,
        `Passenger id '${_passengerId}' is not in the original booking passengerIdList`);
    });
  }

  validationLogger(`[DEBUG] Comparing passenger ${passengerIndex} values with expected values from data file.`);
  const ignored = ignoredFor(response, passengerIndex);

  // A member the booking or the update gave must come back with the same
  // value: a different value is a FAIL. One the provider does not return at
  // all is a WARNING: OSDM does not oblige a provider to keep what it does not
  // need (some providers keep only the main passenger's names, and no date of birth).
  // A member the provider said it ignored and that came back different is a
  // WARNING too (#729): the provider told the caller, and OSDM lets it refuse a
  // change it does not support.
  const sameOrAbsent = (label, expected, actual, member) => {
    const name = `Passenger ${passengerIndex} - ${label} is correct (expected: ${expected}, actual: ${actual})`;
    const absent = actual === undefined || actual === null || actual === "";
    const wanted = expected !== undefined && expected !== null && expected !== "";
    if (wanted && !absent && actual !== expected && member && ignored.has(member.toLowerCase())) {
      validationLogger(`[WARNING] Passenger ${passengerIndex} - ${label}: the provider said it ignored '${member}' (sent: ${expected}, kept: ${actual}).`);
      test(`Passenger ${passengerIndex} - ${label} not changed: the provider ignored '${member}' (WARNING)`, () => {});
      return;
    }
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
  sameOrAbsent('First name', passenger.updateFirstName, firstName, 'firstName');
  sameOrAbsent('Last name', passenger.updateLastName, lastName, 'lastName');
  sameOrAbsent('Date of birth', passenger.updateDateOfBirth, dateOfBirth, 'dateOfBirth');
  sameOrAbsent('Phone number', passenger.updatePhoneNumber, phoneNumber, 'phoneNumber');
  sameOrAbsent('Email', passenger.updateEmail, email, 'email');

  if (gender != null && gender !== passenger.updateGender && ignored.has('gender')) {
    validationLogger(`[WARNING] Passenger ${passengerIndex} - Gender: the provider said it ignored 'gender' (sent: ${passenger.updateGender}, kept: ${gender}).`);
    test(`Passenger ${passengerIndex} - Gender not changed: the provider ignored 'gender' (WARNING)`, () => {});
  } else if (gender != null) {
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
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e?.message));
}
