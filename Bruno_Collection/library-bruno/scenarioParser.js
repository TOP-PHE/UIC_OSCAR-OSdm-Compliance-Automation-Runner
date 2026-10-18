/**
 * scenarioParser.js — load the active scenario from the data file into env vars.
 *
 * The bridge from a data-file scenario to the Bruno run: it resets the per-scenario
 * env vars (so one scenario can't leak into the next), then sets everything the
 * request builders and steps consume — trip(s), passengers, purchaser, flexibility,
 * fulfillment options, place-selection mode, and the negative-probe modes
 * (requestedInformationProbe / bookingPurchaserMode). Runs at collection start.
 */
// Import needed library files
require('./displays.js');
require('./validators.js');
require('./model.js');
const { simulatorFaultsValue } = require('./requestHeaders.js');
const { getComplianceVersion } = require('./osdmVersion.js');
const { cardsOfPassenger } = require('./reductionCards.js');
const { birthDateFor, expectedTypesOf } = require('./passengerAges.js');
const {
  normaliseReturnModel, normaliseReturnFulfillments, returnUsesInboundDate, combinedReturnDefined,
} = require('./returnJourney.js');

// scenarioParser-bruno.js

// A UUID v4 for a request's externalRef. Bruno's sandbox gives scripts
// `crypto` in developer mode; without it, a time-and-counter value, unique
// within the run, as the Idempotency-Key test does. Never Math.random (Sonar
// S2245): an externalRef needs to be unique, not secret, but there is no
// reason to use a weak generator when a strong one is at hand.
let uuidCounter = 0;
function randomUUID() {
  try {
    return require('node:crypto').randomUUID();
  } catch {
    // Time in the first 6 bytes, the counter in the last 10: never cut, so
    // two calls of one run never give the same bytes.
    uuidCounter += 1;
    const hex = Date.now().toString(16).padStart(12, '0') + uuidCounter.toString(16).padStart(20, '0');
    const bytes = Array.from({ length: 16 }, (_, i) => Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16));
    return require('./idempotency.js').uuidFromBytes(bytes);
  }
}

module.exports = {
  getScenarioData,
  randomUUID,
  parseScenarioData,
  resetScenarioEnvVars,
  resolveSalesFlowActions,
  passengerUpdateScope,
  osdmTripSearchCriteria,
  osdmTripSpecification,
  osdmOfferSearchCriteria,
  osdmFulfillmentOptions,
  buildReturnSearchParameters,
  featureNotDeclaredWarning,
  applyExternalRefFormat,
  scenarioTripDate,
  tripDateFor,
  productCategoryOf,
  arrivalAfterDeparture
};

// Which passengers step 03 updates: "MAIN" (the first only) when the scenario
// says so, else "ALL".
function passengerUpdateScope(scenario) {
  return String(scenario?.passengerUpdateScope || "").toUpperCase() === "MAIN" ? "MAIN" : "ALL";
}

// Resolve the optional intermediate booking-flow actions for a scenario.
// The OPTIONAL features (placeSelection, addAncillary, deleteAncillary) default
// OFF: they are not implemented yet, and existing scenarios must not claim to
// exercise them (issue #107). patchPassengers / getBooking default ON, which
// preserves historic behaviour (patchPassengers is the only flag consumed by
// the collection today — POST Create Booking skips the PATCH only when it is
// explicitly "false"). An explicit boolean in the scenario's salesFlowActions
// always overrides the default.
function resolveSalesFlowActions(salesFlowActions) {
  const defaults = {
    patchPassengers: true,  placeSelection: false, addAncillary: false,
    getBooking: true,       deleteAncillary: false
  };
  const src = (salesFlowActions && typeof salesFlowActions === 'object') ? salesFlowActions : {};
  const out = {};
  Object.keys(defaults).forEach(function (k) {
    out[k] = Object.hasOwn(src, k) ? (src[k] === true) : defaults[k];
  });
  return out;
}

// Deletes all business-logic env vars so a new scenario starts with a clean slate.
// Must stay in sync with the _deleteList in opencollection.yml.
function resetScenarioEnvVars() {
  const deleteList = [
    // Scenario / trip
    "scenario_override",
    "loggingType", "scenarioType", "scenarioAction", "osdmVersion", "stepFailurePolicy",
    "selectedAccommodation",
    "requestedInformationProbe", "requestedInfoAutoFed", "requestedInfoProbeTargets",
    "__passengerSweepIndex", "__passengerSweepTotal", "__passengerSweepTarget",
    "expiredBookingTest", "__expiredBookingArmed", "expiredBookingMaxWaitMinutes",
    "expiredOfferTest", "__expiredOfferArmed", "expiredOfferMaxWaitMinutes",
    "offerValidUntil", "offerValidUntilSource",
    "expiredAddReservationOfferTest", "__expiredAddReservationOfferArmed", "expiredAddReservationOfferMaxWaitMinutes",
    "addReservationOfferValidUntil", "addReservationOfferValidUntilSource",
    "expiredAddAncillaryOfferTest", "__expiredAddAncillaryOfferArmed", "expiredAddAncillaryOfferMaxWaitMinutes",
    "addAncillaryOfferValidUntil", "addAncillaryOfferValidUntilSource",
    "expiredRefundOfferTest", "__expiredRefundOfferArmed", "expiredRefundOfferMaxWaitMinutes",
    "refundOfferValidUntil", "refundOfferValidUntilSource",
    "expiredExchangeOfferTest", "__expiredExchangeOfferArmed", "expiredExchangeOfferMaxWaitMinutes",
    "exchangeOfferPreBookableUntil", "exchangeOfferPreBookableUntilSource",
    // PR B: auto-expansion queue state — cleared between top-level scenarios so
    // a fresh queue is built per scenario. Sub-run continuations skip
    // resetScenarioEnvVars (early-return in getScenarioData) so these survive
    // within a multi-timer scenario.
    "__expiredFlowQueue", "__expiredFlowQueueIndex", "__expiredFlowSubRunPending", "__expiredFlowSkipCount",
    "bookingPurchaserMode", "purchaserAdditionalData", "requestedInfoPurchaserProbeTargets", "__purchaserStepDone", "__purchaserWriteMethod",
    "__purchaserSweepIndex", "__purchaserSweepTotal", "bookingPurchaserSweepTarget",
    "placeSelectionProbes", "__placeProbeIndex", "placeProbeTarget", "__placeProbeSkipWarned",
    "__bookingFindingKeys",
    "desiredFlexibility", "accommodationSelection", "accommodationGenderPreference", "bookMandatoryReservations", "optionalReservationSelections", "requiresPlaceSelection",
    "overruleCode", "overruleCodeExpectRejection", "refundDate", "TripType", "__cardPriceCompareDone", "OfferCollectionRequestWithoutCards", "__travelDay", "__expectedPassengerTypes", "expectedProduct", "__productNotOffered", "expectedProductAbsent", "offerSearchProbe", "__groupPriceCompareDone", "OfferCollectionRequestIndividual", "expectedCurrency", "currencyExpectRejection", "__saleCurrency", "legTravelClasses", "__legClassesNotOffered", "__legClassesSold", "placeSelectionFlow", "placePreferences", "__placePreferencesSent", "__placePreferencesFor", "__placePreferencesAskedFor", "__placePreferencesOutcome", "__placePreferencesListed", "__placePreferencesRetried", "__placePreferencesRefused", "namedPlaceKind", "__namedPlacesAskedFor", "__namedPlaceChoices", "__namedPlaceFees", "__namedPlacesOutcome", "nearbyReference", "nearbyReferenceAuto", "__referenceBookingTried", "__referenceBookingId", "__nearbyAskedFor", "__nearbyOutcome", "reservationBookingForm", "reservationPlaceSelections", "reservationAddLaterSelections", "__reservationsBooked", "__reservationsAddedLater", "__reservationsIgnored", "mandatoryReservationForm", "__mandatoryReservationIds", "offersByTripIds", "tripIdsExpectRejection", "__searchTrainFilter", "__passengerIgnoredFields", "__offerTripLegs", "passengerLimitExpectRejection", "emptyPassengersExpectRejection", "refundAgainProbe", "exchangeRefundedProbe", "confirmAgainProbe", "__tripIdsOutcome", "refundReceiptMaxWaitMinutes", "__fulfillmentsToRead", "__fulfillmentDocHolders", "fulfillmentToReadId", "__infoDocKeysBeforeRefund", "__refundReceiptStart", "__refundReceiptDeadline", "idempotencyCheck", "passengerUpdateScope", "__idempotencyKey_booking", "__idempotencyKey_confirmation", "simulatorFaults",
    "tripStartStopPlaceRef", "tripEndStopPlaceRef", "tripStartDatetime", "tripEndDatetime",
    "tripOperatorCode", "tripVehicleNumber", "tripProductCategoryRef",
    "tripProductCategoryName", "tripProductCategoryShortName",
    // Offer
    "offer", "offerId", "offers", "OfferCollectionRequest",
    "offerSearchCriteria", "offerTripSearchCriteria", "offerTripSpecifications",
    "offerFulfillmentOptions", "offerPassengerSpecifications",
    // Two-step return (#178/#180)
    "outboundOfferId", "inboundOfferId", "outboundOfferTag",
    "ReturnOfferCollectionRequest", "__returnInboundDone",
    "outboundBookingId", "__returnBookMode",
    "returnInboundDate", "returnModel", "returnFulfillments", "outboundTripId",
    "admissionReservationAncillaryOfferPartsIds",
    "admissionReservationAncillaryOfferPartsAftersalesConditions",
    "overallFlexibility", "coveredTripId", "minimalPrice",
    "admissionPartsPrice", "reservationPartsPrice", "ancillaryPartsPrice",
    "referencedAncillaryIds", "passengerCount",
    // Booking
    "BookingRequest", "bookingId", "bookedOfferId", "__addReservationDone", "__addAncillaryDone",
    "admissionReservationAncillaryBookingPartsIds",
    "provisionalPrice", "provisionalPriceAmount",
    "confirmedPriceAmount", "bookingConfirmedPrice",
    // Passengers
    "passengerIdList", "passengerId", "passengerSpecificationExternalRef",
    "passengerAdditionalData", "bookingPassengerSpecifications",
    "bookingPassengerReferences", "bookingPurchaserSpecifications",
    "currentPassengerIndex", "skipPatchPassengerRequest",
    "patchDateOfBirth", "patchFirstName", "patchLastName",
    "patchEmail", "patchPhoneNumber", "patchGender",
    // Sales-flow action flags (opt-in intermediate steps for SALE scenarios)
    "salesFlow_patchPassengers", "salesFlow_placeSelection",
    "salesFlow_addAncillary",   "salesFlow_getBooking", "salesFlow_deleteAncillary",
    // Place selection
    "placeSelectionMode", "__placeMapAtOfferFailed", "__postBookingPlaceMapDone",
    "placeSelections", "layoutId", "preselectedCoach", "preselectedPlace", "preselectedPlaces",
    "reservationId", "reservationIds", "tripLegCoverage",
    // Fulfillment
    "fulfillmentIds",
    // Exchange / Refund
    "exchangeOffersOfferId", "exchangeOperationId",
    "requestExchangeOffersBodyData", "requestExchangeOperationsBodyData",
    "refundOffersOfferId", "refundRefundAmount", "refundFee", "isRefundConfirmed", "__refundProposed", "__refundedFulfillmentIds", "__bookingFulfillmentIds",
    "requestRefundOffersBodyData",
    "afterSaleCondition_EXCHANGE_amount", "afterSaleCondition_EXCHANGE_currency", "afterSaleCondition_EXCHANGE_scale",
    "afterSaleCondition_REFUND_amount",   "afterSaleCondition_REFUND_currency",   "afterSaleCondition_REFUND_scale",
    // Partial refund (issue #218)
    "partialRefundByLeg", "partialRefundLegSelection",
    "partialRefundByPax", "partialRefundPaxSelection",
    "partialRefundByFulfillment", "partialRefundFulfillmentSelection",
    "__partialRefundDegradedToFull", "__partialRefundResolvedSpec",
    "__partialRefundExpectedAmount", "__partialRefundExpectedPartIds", "__partialRefundScopeFulfillmentId",
    "__refundOfferRetryCount", "__refundOfferIds", "__refundOfferIndex",
    "__bookingForRefund",
    "__partIdsBeforeExchange",
    // Misc
    "data_base_tmp", "scriptContent", "swaggerJson",
    "scenarioCode",
    // Offer retry
    "__offerRetryCount"
  ];
  deleteList.forEach(function(key) { bru.deleteEnvVar(key); });
  validationLogger('[INFO] resetScenarioEnvVars: all business env vars cleared');
}

// Helper: stringify any error (bru.sendRequest gives plain objects, not JS Errors)
function _errMsg(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  if (e.code || e.status) return `code=${e.code || e.status} ${e.message || JSON.stringify(e)}`;
  try { return JSON.stringify(e); } catch (_) { return String(e); }
}

// Apply a printf-style pattern to a passenger index, producing the
// externalRef that will be sent on every offer / booking / refund / exchange
// call for that passenger. Recognises:
//   "%d"        → no padding         → "1", "2", "3", ...
//   "%0Nd"      → N-wide zero padding → "00001", "00042", ...
//   "%Nd"       → treated same as %0Nd (pad with zero — there is no
//                 space-padding case for an externalRef)
// The pattern may carry leading / trailing literals: "PAX%04d" → "PAX0001",
// "ABC-%03d-XYZ" → "ABC-001-XYZ". Only the FIRST %d / %0Nd is substituted —
// passing a second placeholder leaves it untouched (we have only one index
// per passenger). If the pattern lacks any placeholder, returns the pattern
// unchanged (the caller should validate up-front and skip the rewrite, but
// we don't throw — silent degrade keeps the run alive).
//
// Mirrors previewExternalRef() in Oscar_Server/public/js/scenarios.js so the
// wizard preview matches the runtime output exactly. A unit test in
// Oscar_Server/tests/unit/bruno-externalrefformat.test.js anchors the
// canonical behaviour against this function — keep both in sync.
function applyExternalRefFormat(pattern, n) {
  if (pattern == null || pattern === '') return String(n);
  return String(pattern).replace(/%0?(\d*)d/, function (_, width) {
    const w = Number.parseInt(width || '0', 10);
    return String(n).padStart(w, '0');
  });
}

// Normalize to OffsetDateTime string (required for TripSpecifications in this suite):
// - "...Z"       -> "...+00:00"
// - "...Z+02:00" -> "...+02:00" (broken source format seen in some data files)
// - "..." local  -> "...+00:00"
function toOffsetDateTime(raw) {
  if (typeof raw !== 'string') return raw;
  let v = raw.trim();

  v = v.replace(/Z([+-]\d{2}:\d{2})$/, '$1');
  if (/Z$/i.test(v)) {
    v = v.replace(/Z$/i, '+00:00');
  }
  if (!/[+-]\d{2}:\d{2}$/.test(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(v)) {
    v = `${v}+00:00`;
  }
  return v;
}

// #749: a leg's departure and arrival both get the trip date, so a night leg
// (18:36 → 08:38) arrived before it left. An arrival that is not after the
// departure is moved to the next day; anything that cannot be read is left
// as it is.
function arrivalAfterDeparture(start, end) {
  const s = Date.parse(toOffsetDateTime(start));
  const e = Date.parse(toOffsetDateTime(end));
  const m = typeof end === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(T.*)$/.exec(end) : null;
  if (Number.isNaN(s) || Number.isNaN(e) || e > s || !m) return end;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return next.toISOString().slice(0, 10) + m[4];
}

// Normalize to LocalDateTime string (TripSearchCriteria rule for non-Bileto):
// - strips trailing offset and any trailing Z.
function toLocalDateTime(raw) {
  const normalized = toOffsetDateTime(raw);
  if (typeof normalized !== 'string') return normalized;
  return normalized.replace(/[+-]\d{2}:\d{2}$/, '').replace(/Z$/i, '');
}

// Apply the "%TRIP_DATE%" placeholder substitution to a trip datetime, with a
// guard (#210 pt.3). A minimal/hand-authored data file that omits startDatetime
// or endDatetime previously crashed with an opaque
// `TypeError: Cannot read properties of undefined (reading 'replace')`.
// This converts that into a clear, actionable message naming the missing field.
// UI-generated data files always include both, so they are unaffected.
function subTripDate(value, replacement, fieldLabel, ctx) {
  if (typeof value !== 'string') {
    throw new TypeError(
      `Data file error: ${ctx} is missing a valid '${fieldLabel}' ` +
      `(got ${value === undefined ? 'undefined' : JSON.stringify(value)}). ` +
      `Each trip requirement needs both a startDatetime and an endDatetime. ` +
      `Add it to the data file, or regenerate the data file via the Test Config UI.`
    );
  }
  return value.replace("%TRIP_DATE%", replacement);
}

// #704: a scenario may set its own departure date, `departureDaysFromToday`
// days from today (negative = in the past), for the sales-horizon and
// past-departure tests. It replaces the run's lead time and the weekday
// adjustment: the exact day is what is tested. Otherwise, as before.
function scenarioTripDate(scenario, baseIso, departureDay, now = new Date()) {
  const n = scenario ? scenario.departureDaysFromToday : undefined;
  if (!Number.isInteger(n) || n < -366 || n > 1000) return resolveTripDateForWeekday(baseIso, departureDay);
  // Counted on the UTC calendar, so that a server in any time zone names the
  // same day.
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + n);
  const out = d.toISOString().slice(0, 10);
  validationLogger('[INFO] 📅 Departure ' + (n >= 0 ? n + ' day(s) from today' : (-n) + ' day(s) ago') + ' (departureDaysFromToday) → ' + out);
  return out;
}

// #717: the trip date, on a day the trip's Test Data trains run (OSCAR's
// annotation), unless the scenario names the day itself. Logs the trip's
// calendar notes.
function tripDateFor(scenario, baseIso, tripRequirement, now = new Date()) {
  const date = scenarioTripDate(scenario, baseIso, tripRequirement?.departureDay, now);
  const n = scenario ? scenario.departureDaysFromToday : undefined;
  const named = (Number.isInteger(n) && n >= -366 && n <= 1000)
    || ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
      .includes(String(tripRequirement?.departureDay || '').trim().toUpperCase());
  const { dateForTrip } = require('./tripCalendar.js');
  // #778: a return is dated on a day a train goes back after its time.
  const _ret = returnOptsFromScenario(scenario);
  let _firstLeg = tripRequirement?.trip;
  if (tripRequirement?.tripType === 'SPECIFICATION') _firstLeg = Array.isArray(tripRequirement.legs) ? tripRequirement.legs[0] : null;
  const out = dateForTrip(date, named, tripRequirement,
    { offsetDays: _ret.offsetDays, time: _ret.time, outboundClock: _firstLeg?.startDatetime });
  out.lines.forEach((line) => validationLogger(line));
  return out.date;
}

// #363: optional per-trip departure DAY (weekend-only trains). Keeps the
// configured lead time (today + departureDateFromToday — the aftersales
// buffer), then advances 0–6 days to the NEXT date matching the requested
// weekday. Empty / unknown value → base date unchanged (Auto, the default).
function resolveTripDateForWeekday(baseIso, departureDay) {
  const _days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
  const want = _days.indexOf(String(departureDay || '').trim().toUpperCase());
  if (want < 0) return baseIso;
  const d = new Date(baseIso + 'T12:00:00'); // noon — immune to DST edges
  const shift = (want - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + shift);
  const pad = n => String(n).padStart(2, '0');
  const out = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  validationLogger('[INFO] 📅 Departure day ' + _days[want] + ' → ' + out +
    (shift > 0 ? ' (base ' + baseIso + ' advanced ' + shift + ' day(s), lead time preserved)' : ' (base date already matches)'));
  return out;
}

// Helper: GET JSON via Bruno's sendRequest
// S8-loopback: OSCAR's /data and refresh-access-token routes require the run's
// secret, handed to this child in OSCAR_RUN_SECRET (with the runId in __runId).
// Returned here as request headers. Standalone Bruno has neither, so this is
// empty and the local data-file server just ignores it.
function oscarRunHeaders() {
  try {
    const secret = bru.getProcessEnv('OSCAR_RUN_SECRET');
    const runId = bru.getEnvVar('__runId');
    if (secret && runId) return { 'X-OSCAR-Run-Id': runId, 'X-OSCAR-Run-Secret': secret };
  } catch (_e) { /* standalone Bruno — no OSCAR environment */ }
  return {};
}

function getJson(url) {
  // Normalize double-slashes in path (e.g. http://host//path → http://host/path)
  const cleanUrl = url.replace(/([^:])\/\/+/g, '$1/');
  if (cleanUrl !== url) {
    validationLogger(`[INFO] 🔧 data_base URL had double-slash, normalized: "${cleanUrl}"`);
  }
  return new Promise((resolve, reject) => {
    bru.sendRequest({ url: cleanUrl, method: "GET", proxy: false, headers: oscarRunHeaders() }, function (err, res) {
      if (err) return reject(new Error(`Network error fetching data file from "${cleanUrl}": ${_errMsg(err)}. Is the data-file server running and reachable? When testing locally in Bruno, serve the data_base folder over HTTP (e.g. run "python -m http.server 8000" in Bruno_Collection/data_base) and point the data_base env var at it.`));
      const status = res.status || res.statusCode || 200;
      if (status < 200 || status >= 300) {
        return reject(new Error(`HTTP ${status} fetching data file from "${cleanUrl}". A 404 usually means the filename/path is wrong; otherwise check the data-file server is running and serving that file.`));
      }
      try {
        const body = res.data;
        const json = typeof body === "string" ? JSON.parse(body) : body;
        resolve(json);
      } catch (e) {
        reject(new Error(`Failed to parse data file JSON: ${_errMsg(e)}`));
      }
    });
  });
}

// Set systemInfoParameters env vars from data file root level.
// This allows System Info request files (e.g. coach deck layouts by ID)
// to use env vars populated from the data file at collection start.
function setSystemInfoParameters(jsonData) {
  const params = jsonData.systemInfoParameters;
  if (!params || typeof params !== 'object') return;
  Object.keys(params).forEach(function(key) {
    const value = params[key];
    // Set null values as null (not as the string "null")
    bru.setEnvVar(key, value === null ? null : String(value));
    validationLogger('[INFO] systemInfoParameters: ' + key + ' = ' + (value === null ? 'null' : value));
  });
}

// #398: known-deviation baseline. The provider's documented gaps are declared
// in the UI and persisted at the datafile root as `knownDeviations` (sibling of
// systemInfoParameters). Stow the list as a JSON env var so loopback.js can
// consult it at the call sites; a matched response becomes a passing "known
// deviation" row instead of a FAILED assertion. Datafile-derived, so it lives
// outside resetScenarioEnvVars — re-set fresh here on every parse.
function setKnownDeviations(jsonData) {
  const list = Array.isArray(jsonData.knownDeviations) ? jsonData.knownDeviations : [];
  bru.setEnvVar('__knownDeviations', JSON.stringify(list));
  bru.setEnvVar('__knownDeviationHits', '0');
  bru.setEnvVar('__knownDeviationsSeen', '[]');
  if (list.length > 0) {
    validationLogger('[INFO] Known-deviation baseline: ' + list.length +
      ' documented provider deviation(s) loaded — ' +
      list.map(function (d) { return (d?.step) + '→' + (d?.expectedStatus); }).join(', ') +
      '. A matching response is reported as a documented deviation, not a failure.');
  }
}

// Wrapper to validate data file JSON (uses global or validators module)
async function validateDataFileJsonWithTemplateSafe(json) {
  if (typeof validateDataFileJsonWithTemplate === "function") {
    return validateDataFileJsonWithTemplate(json);
  }
  try {
    const validators = require("./validators.js");
    if (validators && typeof validators.validateDataFileJsonWithTemplate === "function") {
      return validators.validateDataFileJsonWithTemplate(json);
    }
  } catch (e) {
    // ignore if validators not found; optional validation
  }
  // If no validator is available, just continue
}

// Function to get scenario data
async function getScenarioData() {
  validationLogger("[DEBUG] 🪲 getScenarioData");
  validationLogger("[INFO] ⏳ Getting scenario data");

  // ── Expired-flow auto-expansion sub-run continuation (PR B) ─────────────
  // When the previous request's after-response queued another expired-flow
  // timer for THIS SAME scenario, the next loop back to "01. POST Get Offer"
  // should NOT re-parse the scenario from the data file — the queue
  // advancement helper has already flipped the timer flags, and the rest of
  // the env state (passenger refs, trip data, offerSearchCriteria, …) is
  // still valid because it's the same scenario.
  //
  // Skipping the full re-init also avoids resetScenarioEnvVars() — which
  // would WIPE the queue state we just carefully advanced.
  if (bru.getEnvVar('__expiredFlowSubRunPending') === 'true') {
    bru.deleteEnvVar('__expiredFlowSubRunPending');
    let _q = [];
    try { _q = JSON.parse(bru.getEnvVar('__expiredFlowQueue') || '[]'); }
    catch (_e) { _q = []; }
    const _i = Number.parseInt(bru.getEnvVar('__expiredFlowQueueIndex') || '0', 10) || 0;
    const _cur = _q[_i] || {};
    validationLogger(`[INFO] expiredFlow sub-run continuation: scenario "${bru.getEnvVar('scenarioCode') || '?'}" pass ${_i + 1}/${_q.length} — ${_cur.code || '?'} (${_cur.label || '?'}). Skipping full scenario re-init.`);
    return;
  }

  const hasDataFile = bru.getEnvVar('data_file') != null && bru.getEnvVar('data_file') !== '';

  if (!hasDataFile) {
    const dataBase = bru.getEnvVar("data_base");
    validationLogger("[INFO] 🌐 Grabbing data base url from environment : " + dataBase);

    if (!/^https?:\/\//i.test(String(dataBase || ""))) {
      throw new Error(`data_base must be an absolute http(s) URL pointing to the data file. Got: "${dataBase}". When testing locally in Bruno, serve the data_base folder over HTTP (e.g. run "python -m http.server 8000" in Bruno_Collection/data_base) and set data_base to e.g. http://localhost:8000/sqills_datafile.json.`);
    }

    try {
      const jsonData = await getJson(dataBase);
      bru.setEnvVar("data_base_tmp", jsonData);

      // Validate JSON with template
      validationLogger(`[INFO] 🛠️ Check data file structure schema`);
      await validateDataFileJsonWithTemplateSafe(bru.getEnvVar("data_base_tmp"));

      validationLogger("[DEBUG] 🪲 getScenarioData after fetch");
      parseScenarioData(jsonData);
    } catch (err) {
      validationLogger(`[ERROR] ${_errMsg(err)}`);
      throw err;
    }
  } else {
    const dataStr = bru.getEnvVar("data_file");
    const json = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;

    // Validate JSON with template
    await validateDataFileJsonWithTemplateSafe(json);

    validationLogger("[INFO] Data file was set, expecting running in postman/bruno from env");
    parseScenarioData(json);
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// Function to parse scenario data from JSON
function parseScenarioData(jsonData) {
  // Apply root-level systemInfoParameters as env vars (e.g. masterDataLayoutId)
  setSystemInfoParameters(jsonData);
  // #398: load the provider's known-deviation baseline (root-level).
  setKnownDeviations(jsonData);

  const plusDays = Number.parseInt(bru.getEnvVar("departureDateFromToday"), 10) || 10;
  const today = new Date();
  today.setDate(today.getDate() + plusDays);

  const nextWeekdayString = today.getFullYear() + "-" +
    pad(today.getMonth() + 1) + "-" +
    pad(today.getDate());

  // ── Resolve which scenario to run ────────────────────────────────────────
  // scenariosToRun (data file root) is the sole source of truth:
  //   "ALL"                   → all scenarios in the file, in order
  //   ["code1","code2",...]   → only those codes, in that order
  //
  // An index counter (scenariosToRunIndex env var) advances on each collection run.
  // This lets you click "Run Collection" N times and each run picks the next scenario.
  // The index wraps back to 0 after the last scenario so the cycle repeats.
  //
  // NOTE: The scenarioCode env var static initial value in environment files is no longer
  // used as a fallback. scenarioCode is only written at runtime by this function after
  // the scenario is resolved from scenariosToRun.
  const allCodes = (jsonData.scenarios || []).map(s => s.code);
  let scenarioCode = null; // always resolved from scenariosToRun — no env var fallback

  if (jsonData.scenariosToRun == null) {
    throw new Error(
      `[ERROR] ❌ scenariosToRun is missing from the data file. ` +
      `Add "scenariosToRun": "ALL" or a list of scenario codes to the root of the data file.`
    );
  }

  // Build effective list
  let effectiveList;
  if (jsonData.scenariosToRun === "ALL") {
    effectiveList = allCodes.slice();
  } else {
    // Accept either a JSON array OR a comma-separated string:
    //   ["code1","code2"]  →  array
    //   "code1,code2"      →  split on comma
    const rawList = Array.isArray(jsonData.scenariosToRun)
      ? jsonData.scenariosToRun
      : String(jsonData.scenariosToRun).split(',').map(s => s.trim()).filter(Boolean);

    if (rawList.length === 0) {
      effectiveList = allCodes.slice();
      validationLogger(`[WARNING] ⚠️ scenariosToRun was empty — falling back to ALL`);
    } else {
      effectiveList = rawList.filter(c => {
        if (!allCodes.includes(c)) {
          validationLogger(`[WARNING] ⚠️ scenariosToRun: code "${c}" not found in scenarios list — skipped`);
          return false;
        }
        return true;
      });
    }
  }

  if (effectiveList.length === 0) {
    throw new Error(
      `[ERROR] ❌ scenariosToRun resolved to an empty list. ` +
      `Check that the codes in scenariosToRun match the codes in the scenarios array of the data file.`
    );
  }

  // ── Parallel execution mode ──────────────────────────────────────────────
  // If scenario_override is set (by OSCAR runner for parallel batch runs),
  // run only that specific scenario instead of the full list.
  const scenarioOverride = bru.getEnvVar('scenario_override');
  if (scenarioOverride) {
    if (!allCodes.includes(scenarioOverride)) {
      // The codes in the file are counted, not listed. Under OSCAR this message
      // lands in the run log of whoever started the run, and the data file
      // holds every tester's scenarios, private ones included.
      throw new Error(
        `[ERROR] ❌ scenario_override "${scenarioOverride}" not found in scenarios list ` +
        `(the data file holds ${allCodes.length} scenario${allCodes.length === 1 ? '' : 's'}). ` +
        `It may have been renamed or deleted after the run was started.`
      );
    }
    effectiveList = [scenarioOverride];
    validationLogger(`[INFO] ⚡ Parallel mode — running only: ${scenarioOverride}`);
  }

  // Persist the full resolved list so terminal requests can decide whether to
  // loop back for the next scenario or truly stop the runner.
  bru.setEnvVar('__scenariosList', JSON.stringify(effectiveList));

  // ── scenarioTarget override (manual unitary targeting) ───────────────────
  // If scenarioTarget is set (non-empty), it takes absolute priority over
  // scenariosToRunIndex. Accepts either:
  //   - a numeric index (e.g. "0", "2") into effectiveList
  //   - a scenario code string (e.g. "OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG")
  // scenariosToRunIndex is NOT advanced when scenarioTarget is set, so
  // the normal multi-scenario sequence is not disrupted.
  const _scenarioTarget = (bru.getEnvVar('scenarioTarget') || '').trim();
  if (_scenarioTarget !== '') {
    const _asNum = Number.parseInt(_scenarioTarget, 10);
    if (!Number.isNaN(_asNum) && String(_asNum) === _scenarioTarget) {
      // Numeric index
      if (_asNum < 0 || _asNum >= effectiveList.length) {
        throw new Error(
          `[ERROR] ❌ scenarioTarget index ${_asNum} is out of range. ` +
          `effectiveList has ${effectiveList.length} entries (0–${effectiveList.length - 1}).`
        );
      }
      scenarioCode = effectiveList[_asNum];
      validationLogger(`[INFO] 🎯 scenarioTarget (index ${_asNum}): "${scenarioCode}" — scenariosToRunIndex NOT advanced`);
    } else {
      // Scenario code string
      if (!allCodes.includes(_scenarioTarget)) {
        throw new Error(
          `[ERROR] ❌ scenarioTarget "${_scenarioTarget}" not found in scenarios list. ` +
          `Available: ${allCodes.join(', ')}`
        );
      }
      scenarioCode = _scenarioTarget;
      validationLogger(`[INFO] 🎯 scenarioTarget (name): "${scenarioCode}" — scenariosToRunIndex NOT advanced`);
    }
    // scenariosToRunIndex is intentionally left unchanged
  } else {
    // ── Normal sequential mode — read and advance scenariosToRunIndex ───────
    let idx = Number.parseInt(bru.getEnvVar("scenariosToRunIndex") || "0", 10);
    if (Number.isNaN(idx) || idx < 0) idx = 0;
    // If index exceeds list length, all scenarios have been attempted.
    // In a loopback context (__loopback was recently true), stop execution.
    // Otherwise (fresh run or unitary run), wrap to 0 so the run can proceed.
    if (idx >= effectiveList.length) {
      if (effectiveList.length > 0 && bru.getEnvVar('__scenariosList')) {
        // Multi-scenario run completed — stop gracefully
        console.log('[INFO] ✅ All ' + effectiveList.length + ' scenarios attempted — stopping run (index ' + idx + ')');
        bru.runner.stopExecution();
        return;
      }
      // Fresh run or stale index from previous session — wrap to 0
      console.log('[INFO] Index ' + idx + ' exceeds list length ' + effectiveList.length + ' — resetting to 0');
      idx = 0;
    }

    scenarioCode = effectiveList[idx];

    // Advance index WITHOUT wrapping back to 0.
    const nextIdx = idx + 1;
    bru.setEnvVar("scenariosToRunIndex", String(nextIdx));

    // v1.11.10: keep the unitary-load wrapper in opencollection.yml synchronised
    // with the index we just consumed. The wrapper's reload condition is
    //   (_targetNow === '' && _lastUnitaryIdx !== _idxNow)
    // which fires on every non-/versions request in an OSCAR collection run
    // when __unitaryLoadedIdx is undefined while scenariosToRunIndex is post-
    // advance. Setting __unitaryLoadedIdx here (i.e. wherever the parser is
    // invoked — /versions, loop-back, or the wrapper itself) keeps the
    // wrapper from re-firing on requests #2..N within the same scenario
    // iteration. See Documentation/Bruno_Collection/PR68-loop-regression-
    // root-cause.md for the full trace.
    bru.setEnvVar("__unitaryLoadedIdx", String(nextIdx));

    validationLogger(
      `[INFO] 🎯 scenariosToRun [${idx + 1}/${effectiveList.length}]: selected "${scenarioCode}"` +
      (nextIdx >= effectiveList.length ? ` — last in list, run will stop after this scenario` : ` — next will pick index ${nextIdx}`)
    );
  }

  let dataFileIndex = 0;
  const dataFileLength = (jsonData.scenarios || []).length;
  let foundCorrectDataSet = false;

  while (foundCorrectDataSet === false && dataFileIndex < dataFileLength) {
    const scenario = jsonData.scenarios[dataFileIndex];

    if (scenario.code === scenarioCode) {
      // ── Framework-gating warnings (#218 follow-up) ─────────────────────
      // The Oscar_Server's GET /v1/company/datafile annotator injects
      // __featureNotDeclaredWarnings on each scenario whose armed feature
      // isn't declared in the test framework's salesFlows[]. Emit one
      // [WARNING] per entry so the test report explains that the scenario
      // is exercising an undeclared capability (soft validation — the run
      // proceeds anyway, the runtime will degrade as the underlying
      // feature requires).
      const _fwWarnings = Array.isArray(scenario.__featureNotDeclaredWarnings)
        ? scenario.__featureNotDeclaredWarnings : [];
      for (const _field of _fwWarnings) {
        validationLogger(featureNotDeclaredWarning(scenario, _field));
      }

      // Set environment variables for the scenario
      bru.setEnvVar("osdmVersion", ["", "null"].includes(scenario.osdmVersion) ? null : scenario.osdmVersion);
      bru.setEnvVar("loggingType", ["", "null"].includes(scenario.loggingType) ? null : scenario.loggingType);
      // #361: step-failure policy — HARD_STOP (default) vs CONTINUE; read by
      // failStepOrContinue() in loopback.js at the non-critical call sites.
      bru.setEnvVar("stepFailurePolicy", ["", "null", null, undefined].includes(scenario.stepFailurePolicy) ? "HARD_STOP" : String(scenario.stepFailurePolicy).toUpperCase());
      bru.setEnvVar("scenarioCode", scenario.code);
      bru.setEnvVar("scenarioType", ["", "null"].includes(scenario.scenarioType) ? null : scenario.scenarioType);
      bru.setEnvVar("scenarioAction", ["", "null"].includes(scenario.scenarioAction) ? null : scenario.scenarioAction);
      // RI negative probe (#258 Phase 3c): off (default) | omit | invalid.
      bru.setEnvVar("requestedInformationProbe", ["", "null", null, undefined].includes(scenario.requestedInformationProbe) ? "off" : String(scenario.requestedInformationProbe).toLowerCase());
      // Purchaser at booking (#258 / #203): inline (default — purchaser in the
      // booking request) | deferred (omit, then POST it to satisfy the demand) |
      // omit (never supply) | invalid (POST a bad purchaser → expect rejection).
      bru.setEnvVar("bookingPurchaserMode", ["", "null", null, undefined].includes(scenario.bookingPurchaserMode) ? "inline" : String(scenario.bookingPurchaserMode).toLowerCase());
      // Expired-booking negative test (#204): when true, OSCAR waits until just
      // past booking.confirmationTimeLimit, then attempts fulfillment and asserts
      // the provider rejects it (booking expired). Default false.
      bru.setEnvVar("expiredBookingTest", (scenario.expiredBookingTest === true || ["true", "on", "yes"].includes(String(scenario.expiredBookingTest).toLowerCase())) ? "true" : "false");

      // Per-scenario max wait budget for the expired-booking test (#204), in
      // minutes (1..60). When set AND expiredBookingTest is 'on', 06.yml uses
      // this as the wait budget instead of the runner-injected runHardDeadlineMs
      // (which reflects the server-wide RUN_TIMEOUT_MS). The runner also
      // auto-extends the worker SIGTERM to cover this wait, clamped to
      // RUN_HARD_MAX_TIMEOUT_MS. Empty / null / out-of-range = unset (default).
      const _maxWaitRaw = scenario.expiredBookingMaxWaitMinutes;
      const _maxWaitN   = Number(_maxWaitRaw);
      if (Number.isFinite(_maxWaitN) && _maxWaitN >= 1 && _maxWaitN <= 60) {
        bru.setEnvVar("expiredBookingMaxWaitMinutes", String(Math.floor(_maxWaitN)));
      } else {
        bru.setEnvVar("expiredBookingMaxWaitMinutes", "");
      }

      // Expired-offer negative test (Phase 2 of the expired-flow generalization):
      // when true, OSCAR waits until just past the earliest OfferPart.validUntil
      // from the selected offer, then attempts POST /bookings and asserts the
      // provider rejects it (offer expired). Default false. Mirrors the
      // expiredBookingTest plumbing above.
      bru.setEnvVar("expiredOfferTest", (scenario.expiredOfferTest === true || ["true", "on", "yes"].includes(String(scenario.expiredOfferTest).toLowerCase())) ? "true" : "false");

      // Per-scenario max wait budget for the expired-offer test, in minutes
      // (1..60). Same semantics as expiredBookingMaxWaitMinutes (see above): the
      // runner auto-extends the worker SIGTERM to cover this wait, clamped to
      // RUN_HARD_MAX_TIMEOUT_MS. Empty / null / out-of-range = unset (default).
      const _maxOfferWaitRaw = scenario.expiredOfferMaxWaitMinutes;
      const _maxOfferWaitN   = Number(_maxOfferWaitRaw);
      if (Number.isFinite(_maxOfferWaitN) && _maxOfferWaitN >= 1 && _maxOfferWaitN <= 60) {
        bru.setEnvVar("expiredOfferMaxWaitMinutes", String(Math.floor(_maxOfferWaitN)));
      } else {
        bru.setEnvVar("expiredOfferMaxWaitMinutes", "");
      }

      // Phase 3+4+5a+5b: expired-X negative tests for refund / exchange /
      // add-reservation / add-ancillary. All follow the same shape as
      // expiredOfferTest / expiredBookingTest above. Each has a per-scenario
      // Max wait input with identical semantics (1..60 min, auto-extends the
      // runner SIGTERM via EXPIRED_FLOW_TIMERS in runner.js).
      const _expiredFlowFields = [
        ["expiredAddReservationOfferTest", "expiredAddReservationOfferMaxWaitMinutes"],
        ["expiredAddAncillaryOfferTest",   "expiredAddAncillaryOfferMaxWaitMinutes"],
        ["expiredRefundOfferTest",         "expiredRefundOfferMaxWaitMinutes"],
        ["expiredExchangeOfferTest",       "expiredExchangeOfferMaxWaitMinutes"],
      ];
      for (const [_flagKey, _waitKey] of _expiredFlowFields) {
        const _raw = scenario[_flagKey];
        bru.setEnvVar(_flagKey,
          (_raw === true || ["true", "on", "yes"].includes(String(_raw).toLowerCase())) ? "true" : "false");
        const _wRaw = scenario[_waitKey];
        const _wN   = Number(_wRaw);
        bru.setEnvVar(_waitKey,
          (Number.isFinite(_wN) && _wN >= 1 && _wN <= 60) ? String(Math.floor(_wN)) : "");
      }

      // osdmVersion priority: scenario value (data file) > environment file value > null
      // The data file is the per-scenario source of truth; the env file is the fallback
      // when the scenario does not explicitly define an osdmVersion.
      //const _scenarioOsdmVersion = (scenario.osdmVersion && !["", "null"].includes(String(scenario.osdmVersion)))
      //  ? String(scenario.osdmVersion)
      //  : null;
      validationLogger(`[INFO] 📋 Scenario selected: "${scenario.code}" ; Scenario Type: "${bru.getEnvVar("scenarioType")}" ; Scenario Action: "${bru.getEnvVar("scenarioAction")}" ; OSDM version: "${bru.getEnvVar("osdmVersion")}"`);
      bru.setEnvVar("desiredFlexibility", ["", "null"].includes(scenario.desiredFlexibility) ? null : scenario.desiredFlexibility);
      bru.setEnvVar("accommodationSelection", ["", "null"].includes(scenario.accommodationSelection) ? null : scenario.accommodationSelection);
      // #211 — desired gender-segregated placeProperties value (MEN/LADIES/MIXED)
      // for COUCHETTE/BERTH night-train compartments. Sibling of accommodationSelection.
      bru.setEnvVar("accommodationGenderPreference", ["", "null"].includes(scenario.accommodationGenderPreference) ? null : scenario.accommodationGenderPreference);
      // #239 — book mandatory reservations via optionalReservationSelections.
      bru.setEnvVar("bookMandatoryReservations",
        (scenario.bookMandatoryReservations === true || String(scenario.bookMandatoryReservations).toLowerCase() === "true") ? "true" : "false");
      // #601: how the optional reservations are booked (mandatory ones always are).
      // #766: seat preferences (PlaceProperty codes) asked in the booking; a
      // scenario that asks for some books its optional reservations by
      // placeSelections unless it names another form.
      const _placePreferences = require('./placeSelection.js').preferencesOfScenario(scenario);
      bru.setEnvVar("placePreferences", JSON.stringify(_placePreferences));
      // #766 PR 3: a scenario naming a manual flow itself (and no older seat
      // map mode) names a place or compartment on the place map.
      const _np = require('./namedPlaces.js');
      const _namedPlace = _np.isManual(scenario.placeSelectionFlow) && !["SEATMAP_AT_OFFER", "ADD_TO_BOOKING"].includes(String(scenario.placeSelectionMode || "").toUpperCase());
      bru.setEnvVar("namedPlaceKind", _namedPlace ? _np.kindOfScenario(scenario) : null);
      // #766 PR 4: the reference place of the NEARBY flow ("7/15").
      // #776: empty or "AUTO", it comes from a first booking made in the run.
      const _nearby = String(scenario.placeSelectionFlow || "").toUpperCase() === "AUTOMATIC_PLACE_SELECTION_NEARBY" ? _np.referenceOfScenario(scenario) : null;
      const _nearbyAuto = require('./referenceBooking.js').isAutoReference(scenario);
      bru.setEnvVar("nearbyReference", _nearby ? JSON.stringify(_nearby) : null);
      bru.setEnvVar("nearbyReferenceAuto", _nearbyAuto ? "true" : null);
      bru.setEnvVar("reservationBookingForm", require('./seatReservations.js').normaliseForm(scenario.reservationBookingForm)
        || (_placePreferences.length > 0 || _namedPlace || _nearby || _nearbyAuto ? "PLACE_SELECTION" : null));
      // #793: a mandatory reservation without a seat choice: a placeSelection
      // (default) or nothing; the run's copy carries the Test Framework's.
      bru.setEnvVar("mandatoryReservationForm", require('./seatReservations.js').normaliseMandatoryForm(scenario.mandatoryReservationForm));
      // Which passengers step 03 updates (ALL, or MAIN = the first only).
      bru.setEnvVar("passengerUpdateScope", passengerUpdateScope(scenario));
      // #378: place-selection NHF probe sweep. The wizard stores an object of
      // booleans; the env carries an ORDERED array of the enabled probe keys
      // (omit → unknown type → wrong id). Default: no probes. The booking step
      // self-loops once per key (corrupted passes), then books clean.
      const _ppSel = scenario.placeSelectionProbes;
      const _ppOrder = ["omitPlaceSelections", "unknownAccommodationType", "wrongReservationId"];
      let _ppKeys = [];
      if (Array.isArray(_ppSel)) _ppKeys = _ppOrder.filter((k) => _ppSel.includes(k));
      else if (_ppSel && typeof _ppSel === "object") _ppKeys = _ppOrder.filter((k) => _ppSel[k] === true);
      bru.setEnvVar("placeSelectionProbes", JSON.stringify(_ppKeys));
      bru.setEnvVar("__placeProbeIndex", "0");
      if (_ppKeys.length > 0) {
        validationLogger(`[INFO] 🧪 Place-selection probe sweep ARMED (${_ppKeys.length} probe(s): ${_ppKeys.join(", ")}) — the booking step will first fire ${_ppKeys.length} corrupted request(s), then book clean.`);
      }
      bru.setEnvVar("requiresPlaceSelection", ["", "null"].includes(scenario.requiresPlaceSelection) ? null : scenario.requiresPlaceSelection);
      bru.setEnvVar("overruleCode", ["", "null"].includes(scenario.overruleCode) ? null : scenario.overruleCode);
      // #598: the product (tariff) the scenario expects: a code, or words of its name.
      bru.setEnvVar("expectedProduct", typeof scenario.expectedProduct === "string" && scenario.expectedProduct.trim() ? scenario.expectedProduct.trim() : null);
      // #833: the faults the OSDM simulator answers this scenario with (header X-Simulator-Faults).
      bru.setEnvVar("simulatorFaults", simulatorFaultsValue(scenario.simulatorFaults) || null);
      // #600: the travel class expected on each leg, in the order of the legs.
      const _legClasses = require('./legClasses.js').normaliseLegClasses(scenario.legTravelClasses);
      bru.setEnvVar("legTravelClasses", _legClasses ? JSON.stringify(_legClasses) : null);
      // #766: the place selection flow the scenario exercises (null: none).
      bru.setEnvVar("placeSelectionFlow", require('./placeSelection.js').flowOfScenario(scenario));
      // #599: the expected product must NOT be offered (a group its rules exclude).
      bru.setEnvVar("expectedProductAbsent", (scenario.expectedProductAbsent === true || ["true", "on", "yes"].includes(String(scenario.expectedProductAbsent).toLowerCase())) ? "true" : "false");
      // #780: the scenario tests its offer search criteria and ends after the offer.
      bru.setEnvVar("offerSearchProbe", (scenario.offerSearchProbe === true || ["true", "on", "yes"].includes(String(scenario.offerSearchProbe).toLowerCase())) ? "true" : "false");
      // #596: negative probe — the provider is expected to refuse this overrule code.
      bru.setEnvVar("overruleCodeExpectRejection", (scenario.overruleCodeExpectRejection === true || ["true", "on", "yes"].includes(String(scenario.overruleCodeExpectRejection).toLowerCase())) ? "true" : "false");
      bru.setEnvVar("refundDate", ["", "null"].includes(scenario.refundDate) ? null : scenario.refundDate);
      // #602: offers asked for a trip of POST /trips-collection, by its id.
      // Only a one-way journey from a SEARCH trip is asked this way.
      const _flagOn = (v) => v === true || ["true", "on", "yes"].includes(String(v).toLowerCase());
      let _byTripIds = _flagOn(scenario.offersByTripIds);
      if (_byTripIds) {
        const _tr = (jsonData.tripRequirements || []).find((t) => t && t.id === scenario.tripRequirementId);
        const _offset = returnOptsFromScenario(scenario).offsetDays;
        if (_tr && _tr.tripType !== "SEARCH") {
          validationLogger(`[WARNING] Scenario "${scenario.code}": offers by trip id need a SEARCH trip (origin, destination, time); this one is ${_tr.tripType}. The offers are asked by the trip as it is.`);
          _byTripIds = false;
        } else if (_offset !== undefined && _offset !== null && _offset !== "") {
          validationLogger(`[WARNING] Scenario "${scenario.code}": offers by trip id are asked for a one-way journey only; this scenario is a return. The offers are asked by search criteria.`);
          _byTripIds = false;
        }
      }
      bru.setEnvVar("offersByTripIds", _byTripIds ? "true" : "false");
      // #603: how long to wait for the refund receipt after a refund, 1 to 60 minutes.
      const _receiptWait = Number.parseInt(scenario.refundReceiptMaxWaitMinutes, 10);
      bru.setEnvVar("refundReceiptMaxWaitMinutes", _receiptWait >= 1 && _receiptWait <= 60 ? String(_receiptWait) : null);
      // #604: send the booking and the confirmation again with the same Idempotency-Key.
      bru.setEnvVar("idempotencyCheck", _flagOn(scenario.idempotencyCheck) ? "true" : "false");
      // #602: negative probe — offers asked for a trip id the provider never gave.
      bru.setEnvVar("tripIdsExpectRejection", _flagOn(scenario.tripIdsExpectRejection) ? "true" : "false");
      // #699: negative probe — one passenger over the provider's maximum.
      bru.setEnvVar("passengerLimitExpectRejection", _flagOn(scenario.passengerLimitExpectRejection) ? "true" : "false");
      // #703: negative probe — an offer request with no passenger.
      bru.setEnvVar("emptyPassengersExpectRejection", _flagOn(scenario.emptyPassengersExpectRejection) ? "true" : "false");
      // #704: a departure date of the scenario's own, and the probe that
      // expects it refused (past, or beyond the sales horizon).
      bru.setEnvVar("departureDaysFromToday", Number.isInteger(scenario.departureDaysFromToday) ? String(scenario.departureDaysFromToday) : null);
      bru.setEnvVar("departureExpectRejection", _flagOn(scenario.departureExpectRejection) ? "true" : "false");
      // #781: the currency the offers are in when none is asked, and the probe
      // asking for one the provider does not sell.
      bru.setEnvVar("expectedCurrency", typeof scenario.expectedCurrency === "string" && /^[A-Z]{3}$/.test(scenario.expectedCurrency) ? scenario.expectedCurrency : null);
      bru.setEnvVar("currencyExpectRejection", _flagOn(scenario.currencyExpectRejection) ? "true" : "false");
      // #700: after-sale requests that must be refused.
      bru.setEnvVar("refundAgainProbe", _flagOn(scenario.refundAgainProbe) ? "true" : "false");
      bru.setEnvVar("exchangeRefundedProbe", _flagOn(scenario.exchangeRefundedProbe) ? "true" : "false");
      bru.setEnvVar("confirmAgainProbe", _flagOn(scenario.confirmAgainProbe) ? "true" : "false");

      // ── Partial refund (issue #218) ─────────────────────────────────────
      // Two orthogonal scope axes: by leg (subset of admissions/reservations)
      // and by passenger (subset of pax). The wizard blocks save in the
      // OBVIOUSLY-impossible cases (per-pax with only 1 passenger; per-leg
      // with a SPECIFICATION trip that's already single-leg); the SEARCH-mode
      // per-leg case is validated at offer-runtime in 10. POST Refund Offers'
      // before-request and degrades to full refund with a [WARNING].
      const _prByLeg = (scenario.partialRefundByLeg === true ||
                        ["true", "on", "yes"].includes(String(scenario.partialRefundByLeg).toLowerCase()));
      const _prByPax = (scenario.partialRefundByPax === true ||
                        ["true", "on", "yes"].includes(String(scenario.partialRefundByPax).toLowerCase()));
      bru.setEnvVar("partialRefundByLeg", _prByLeg ? "true" : "false");
      bru.setEnvVar("partialRefundByPax", _prByPax ? "true" : "false");
      const _legDefault = _prByLeg ? "first" : "";  // default to first when armed
      const _paxDefault = _prByPax ? "first" : "";
      bru.setEnvVar("partialRefundLegSelection",
        ["", "null", null, undefined].includes(scenario.partialRefundLegSelection)
          ? _legDefault
          : String(scenario.partialRefundLegSelection));
      bru.setEnvVar("partialRefundPaxSelection",
        ["", "null", null, undefined].includes(scenario.partialRefundPaxSelection)
          ? _paxDefault
          : String(scenario.partialRefundPaxSelection));
      // #595: the refund of one whole fulfillment (first, last, outbound,
      // inbound), for providers that refund per fulfillment only.
      const _prByFf = (scenario.partialRefundByFulfillment === true ||
                       ["true", "on", "yes"].includes(String(scenario.partialRefundByFulfillment).toLowerCase()));
      bru.setEnvVar("partialRefundByFulfillment", _prByFf ? "true" : "false");
      const _prFfDefault = _prByFf ? "first" : "";
      bru.setEnvVar("partialRefundFulfillmentSelection",
        ["", "null", null, undefined].includes(scenario.partialRefundFulfillmentSelection)
          ? _prFfDefault
          : String(scenario.partialRefundFulfillmentSelection));

      // Setup-time consistency checks. The wizard does these proactively too;
      // re-check here so a hand-edited data file can't bypass the wizard.
      if (_prByPax || _prByLeg) {
        // Per-pax requires >=2 passengers in the resolved passenger list.
        if (_prByPax) {
          // Log-audit round 2: the root property in the data file is
          // `passengersList` (an ARRAY of lists — the schema's required root
          // field), not `passengersLists`. The old plural lookup was always
          // undefined, so _paxCount was 0 for EVERY per-pax scenario and this
          // warning fired even with 3 passengers correctly linked (list #62
          // false-positive, 2026-06-10). Keep the plural as a fallback for
          // hand-edited files, and compare ids loosely ("62" vs 62) since
          // hand-edited files are exactly what this re-check exists for.
          const _plRoot = jsonData.passengersList || jsonData.passengersLists;
          const _passengersList = Array.isArray(_plRoot)
            ? _plRoot.find((pl) => pl && String(pl.id) === String(scenario.passengersListId))
            : undefined;
          const _paxCount = Array.isArray(_passengersList?.passengers)
            ? _passengersList.passengers.length : 0;
          if (_paxCount < 2) {
            const _listState = _passengersList ? `has only ${_paxCount} passenger(s)` : `was not found in the data file's passengersList[]`;
            validationLogger(`[WARNING] Scenario "${scenario.code}": partialRefundByPax is on but passengersList #${scenario.passengersListId} ${_listState} — per-pax partial refund cannot fire. ${_passengersList ? 'Add a passenger or turn partialRefundByPax off.' : 'Check the scenario’s passengersListId linkage in Test Config.'}`);
          }
        }
        // Per-leg with SPECIFICATION trip can be statically validated.
        // (SEARCH mode is checked at offer time in 10.yml.)
        if (_prByLeg) {
          const _tripReq = jsonData.tripRequirements?.find(
            (tr) => tr && tr.id === scenario.tripRequirementId);
          if (_tripReq?.tripType === "SPECIFICATION") {
            const _legCount = Array.isArray(_tripReq.legs) ? _tripReq.legs.length : 0;
            if (_legCount < 2) {
              validationLogger(`[WARNING] Scenario "${scenario.code}": partialRefundByLeg is on but the SPECIFICATION trip has ${_legCount} leg(s) — per-leg partial refund cannot fire. Either turn partialRefundByLeg off, or use a multi-leg trip.`);
            }
            const _hasReturn = !!(_tripReq.returnSearchParameters || _tripReq.tripType === "RETURN");
            const _legSel = String(scenario.partialRefundLegSelection || "first");
            if ((_legSel === "outbound" || _legSel === "inbound") && !_hasReturn) {
              validationLogger(`[WARNING] Scenario "${scenario.code}": partialRefundLegSelection='${_legSel}' is only valid for return-trips; this trip is one-way. OSCAR will fall back to 'first'.`);
              bru.setEnvVar("partialRefundLegSelection", "first");
            }
          }
        }
      }

      // Optional intermediate booking-flow actions. The scenario may carry a
      // `salesFlowActions` map { patchPassengers, placeSelection, addAncillary,
      // getBooking, deleteAncillary } indicating which steps to exercise
      // between POST /bookings and POST /fulfillments. Resolution + defaults are
      // centralised in resolveSalesFlowActions() (issue #107): the optional
      // features default OFF, patchPassengers/getBooking default ON. Each flag
      // is exported as `salesFlow_<key>` = "true"/"false" so individual .bru
      // files can branch on it with a simple getEnvVar.
      const _salesActions = resolveSalesFlowActions(scenario.salesFlowActions);
      Object.keys(_salesActions).forEach(function (k) {
        bru.setEnvVar("salesFlow_" + k, _salesActions[k] ? "true" : "false");
      });
      validationLogger("[INFO] 🛒 Sales-flow actions: " +
        Object.keys(_salesActions).map(function (k) {
          return k + "=" + bru.getEnvVar("salesFlow_" + k);
        }).join(", "));

      // Place-selection mode (issue #107): SEATMAP_AT_OFFER (seat map → booking)
      // or ADD_TO_BOOKING (reservation added to an existing booking). Chosen per
      // scenario from the framework-authorised set; null when not applicable.
      bru.setEnvVar("placeSelectionMode", ["", "null"].includes(scenario.placeSelectionMode) ? null : scenario.placeSelectionMode);

      // ── Expired-flow auto-expansion: build the per-scenario queue (PR B) ──
      // When 2+ expired-X timers are armed on this scenario, OSCAR runs the
      // scenario N times — one pass per armed timer. The queue builder reads
      // the timer flags + the gating env vars set above (scenarioType,
      // salesFlow_*, placeSelectionMode) so we MUST call it after those are
      // resolved. Single-timer scenarios behave identically to today — the
      // queue has length 1 and the existing after-response short-circuit
      // routes straight to the next scenario.
      try {
        // Log-audit round 2: sibling-relative require. This file lives IN
        // library-bruno/, so the YML-style library_base prefix
        // ("./library-bruno/") double-nested to
        // library-bruno/library-bruno/expiredFlow.js and FAILED ON EVERY RUN
        // ("Cannot find module ..."), emitting a confusing [WARNING] even
        // with zero timers armed — and silently disabling the multi-timer
        // auto-expansion for scenarios that DID arm 2+ timers. Same sibling
        // pattern as loopback.js → envUtils.js; reportGenerator.js documents
        // the identical trap.
        const { buildAndArmExpiredFlowQueue } = require("./expiredFlow.js");
        buildAndArmExpiredFlowQueue();
        // With 0 timers armed the builder is silent (empty queue, no log) —
        // so this block emits nothing on ordinary scenarios.
      } catch (_e) {
        // With the path fixed, a throw here is a genuine feature failure:
        // armed expiry timers would not run their extra passes.
        validationLogger(`[ERROR] expiredFlow queue build failed: ${_e?.message} — armed expiry-timer tests will NOT run their extra passes this scenario.`);
      }

      // Trip requirements — verify the scenario's reference resolves BEFORE
      // walking the list. #328 (v1.11.109): when a new user authors a
      // datafile in the wizard and the scenario's tripRequirementId doesn't
      // match any tripRequirements[].id, every downstream variable
      // (offerTripSearchCriteria, offerTripSpecifications, leg*StopPlaceRef,
      // …) stays unset and the user only sees the downstream symptom:
      // "Required scenario variable 'offerTripSearchCriteria' is empty or
      // not set." That message points at data_base but doesn't tell them
      // the cause is the unresolved tripRequirementId. Emit a precise
      // ERROR up front so the next reader sees the linkage gap directly.
      const _tripList    = Array.isArray(jsonData.tripRequirements) ? jsonData.tripRequirements : [];
      const _tripWantId  = scenario.tripRequirementId;
      const _tripFound   = _tripList.some(function (tr) { return tr && tr.id === _tripWantId; });
      if (!_tripFound) {
        const _availIds = _tripList.map(function (tr) { return tr?.id; }).filter(function (id) { return id != null; });
        validationLogger(
          '[ERROR] Scenario "' + scenario.code + '" references tripRequirementId=' +
          JSON.stringify(_tripWantId) + ' but no matching entry exists in datafile.tripRequirements[]. ' +
          'Available ids: [' + _availIds.join(', ') + ']. ' +
          'Fix in the wizard: open the Test Data → Trip Requirements section, ' +
          'confirm at least one entry exists and that the scenario\'s tripRequirementId points at one of them. ' +
          'When tripRequirementId is unresolved, every downstream variable ' +
          '(offerTripSearchCriteria, offerTripSpecifications, leg*StopPlaceRef, …) stays unset and the request body cannot be built.'
        );
      }
      jsonData.tripRequirements?.some(function (tripRequirement) {
        if (tripRequirement.id === scenario.tripRequirementId) {
          bru.setEnvVar("TripType", tripRequirement.tripType);

          // #330 (v1.11.110): the SEARCH branch reads tripRequirement.trip.*
          // and the SPECIFICATION branch reads tripRequirement.legs[*].* —
          // without these the silent failure mode is that osdmTripSearchCriteria
          // / osdmTripSpecification never get called and the downstream symptom
          // is "Required scenario variable offerTripSearchCriteria is empty".
          // Validate the shape BEFORE entering the branch so the user sees the
          // precise data-shape gap instead of the downstream consequence.
          // [DEBUG] dump of the actual structure is included for deeper
          // investigation but stays invisible at default INFO logging level.
          const _trCtx = 'tripRequirement #' + JSON.stringify(tripRequirement.id);
          if (tripRequirement.tripType === "SEARCH") {
            const _missing = [];
            if (!tripRequirement.trip || typeof tripRequirement.trip !== 'object') {
              _missing.push('trip (sub-object missing)');
            } else {
              if (!tripRequirement.trip.origin)        _missing.push('trip.origin');
              if (!tripRequirement.trip.destination)   _missing.push('trip.destination');
              if (!tripRequirement.trip.startDatetime) _missing.push('trip.startDatetime');
            }
            if (_missing.length > 0) {
              validationLogger(
                '[ERROR] Scenario "' + scenario.code + '": ' + _trCtx +
                ' has tripType=SEARCH but the .trip sub-object is missing required field(s): [' +
                _missing.join(', ') + ']. The SEARCH branch needs origin / destination / startDatetime to build a TripSearchCriteria; offerTripSearchCriteria stays unset and the request body cannot be built. ' +
                'Fix in the wizard: open Test Data → Trip Requirements, open this entry and complete the SEARCH trip\'s origin, destination, and start datetime.'
              );
              validationLogger('[DEBUG] ' + _trCtx + '.trip dump = ' + JSON.stringify(tripRequirement.trip));
              return true;  // stop iterating; the downstream parseEnvJson error will name the same problem.
            }
          } else if (tripRequirement.tripType === "SPECIFICATION") {
            if (!Array.isArray(tripRequirement.legs) || tripRequirement.legs.length === 0) {
              validationLogger(
                '[ERROR] Scenario "' + scenario.code + '": ' + _trCtx +
                ' has tripType=SPECIFICATION but .legs[] is empty or missing. The SPECIFICATION branch needs at least one leg with origin / destination / startDatetime / endDatetime to build a TripSpecification; offerTripSpecifications stays unset and the request body cannot be built. ' +
                'Fix in the wizard: open Test Data → Trip Requirements, open this entry and add at least one leg.'
              );
              validationLogger('[DEBUG] ' + _trCtx + ' dump = ' + JSON.stringify(tripRequirement));
              return true;
            }
            const _badLegs = [];
            tripRequirement.legs.forEach(function (leg, i) {
              const _m = [];
              if (!leg || typeof leg !== 'object') { _badLegs.push({ index: i, missing: ['leg (not an object)'] }); return; }
              if (!leg.origin)        _m.push('origin');
              if (!leg.destination)   _m.push('destination');
              if (!leg.startDatetime) _m.push('startDatetime');
              if (!leg.endDatetime)   _m.push('endDatetime');
              if (_m.length > 0) _badLegs.push({ index: i, missing: _m });
            });
            if (_badLegs.length > 0) {
              const _summary = _badLegs.map(function (b) { return 'legs[' + b.index + '] missing [' + b.missing.join(', ') + ']'; }).join('; ');
              validationLogger(
                '[ERROR] Scenario "' + scenario.code + '": ' + _trCtx +
                ' has tripType=SPECIFICATION but ' + _badLegs.length + ' leg(s) are incomplete: ' + _summary + '. ' +
                'Fix in the wizard: open Test Data → Trip Requirements, open this entry and complete each leg\'s origin / destination / start+end datetimes.'
              );
              validationLogger('[DEBUG] ' + _trCtx + '.legs dump = ' + JSON.stringify(tripRequirement.legs));
              return true;
            }
          }

          // #330: wrap the switch so any unexpected throw inside the SEARCH /
          // SPECIFICATION branches (e.g. subTripDate refusing the format, a
          // deeper malformed sub-field the validators above didn't catch)
          // surfaces with the tripRequirement context rather than propagating
          // as an opaque "Cannot read property X of undefined" or
          // "Invalid date format".
          try {
          switch (tripRequirement.tripType) {
            case "SPECIFICATION": {
              validationLogger('[INFO] ⏳ processing a specification');
              const legDefinitions = [];
              // #363: per-trip departure day (Auto when unset).
              const _specTripDate = tripDateFor(scenario, nextWeekdayString, tripRequirement);
              // #705: the day ages are counted on.
              bru.setEnvVar("__travelDay", _specTripDate);

              tripRequirement.legs.forEach(function (leg, legIndex) {
                const legPrefix = `leg${legIndex + 1}`;
                const _legCtx = `tripRequirement (SPECIFICATION) leg ${legIndex + 1}`;
                const _storedStart = subTripDate(leg.startDatetime, _specTripDate, 'startDatetime', _legCtx);
                const _sameDayEnd = subTripDate(leg.endDatetime, _specTripDate, 'endDatetime', _legCtx);
                const _storedEnd = arrivalAfterDeparture(_storedStart, _sameDayEnd);
                if (_storedEnd !== _sameDayEnd) {
                  validationLogger(`[INFO] ${_legCtx}: arrival ${_sameDayEnd} is not after the departure ${_storedStart} — taken as the next day, ${_storedEnd}.`);
                }
                // #772: the stored offset is that of the day the service was
                // seen; the trip date may be on the other side of a clock change.
                const { onTheDay } = require('./stationTimeZones.js');
                const startDatetime = onTheDay(_storedStart, leg.origin);
                const endDatetime = onTheDay(_storedEnd, leg.destination);
                if (startDatetime !== _storedStart || endDatetime !== _storedEnd) {
                  validationLogger(`[INFO] ${_legCtx}: times given the offset of the trip date in the stop places' time zone — ${startDatetime} to ${endDatetime} (stored ${_storedStart} to ${_storedEnd}).`);
                }

                bru.setEnvVar(`${legPrefix}StartStopPlaceRef`, leg.origin);
                bru.setEnvVar(`${legPrefix}EndStopPlaceRef`, leg.destination);
                bru.setEnvVar(`${legPrefix}StartDatetime`, startDatetime);
                bru.setEnvVar(`${legPrefix}EndDatetime`, endDatetime);
                bru.setEnvVar(`${legPrefix}VehicleNumber`, leg.vehicleNumber);
                bru.setEnvVar(`${legPrefix}OperatorCode`, leg.operatorCode);
                bru.setEnvVar(`${legPrefix}ProductCategoryRef`, leg.productCategoryRef || null);
                bru.setEnvVar(`${legPrefix}ProductCategoryName`, leg.productCategoryName || null);
                bru.setEnvVar(`${legPrefix}ProductCategoryShortName`, leg.productCategoryShortName || null);
                validationLogger("[DEBUG] 🪲 parseScenarioData1");

                legDefinitions.push(new TripLegDefinition(
                  leg.origin,
                  startDatetime,
                  leg.destination,
                  endDatetime,
                  leg.productCategoryRef,
                  leg.productCategoryName,
                  leg.productCategoryShortName,
                  leg.vehicleNumber,
                  leg.operatorCode
                ));
              });

              osdmTripSpecification(legDefinitions, returnOptsFromScenario(scenario));
              break;
            }

            case "SEARCH": {
              validationLogger('[INFO] ⏳ processing a search');
              // #363: per-trip departure day (Auto when unset).
              const _searchTripDate = tripDateFor(scenario, nextWeekdayString, tripRequirement);
              // #705: the day ages are counted on.
              bru.setEnvVar("__travelDay", _searchTripDate);
              const _searchStart = subTripDate(tripRequirement.trip.startDatetime, _searchTripDate, 'startDatetime', 'tripRequirement (SEARCH)');
              // #333 (v1.11.112): endDatetime is OPTIONAL on a TripSearchCriteria
              // per OSDM spec — you specify a departure time, not a window. And
              // osdmTripSearchCriteria() below doesn't use the endDateTime
              // anyway (only `startDateTime` is passed to TripSearchCriteria —
              // see line 1171 below). Requiring it via subTripDate() was
              // rejecting valid OSDM data (e.g. the OBB Nightjet datafile).
              // Pass null when absent; SPECIFICATION branch keeps its strict
              // both-required check (legs[*].endDatetime IS required when
              // you're specifying exact trips).
              const _searchEnd = tripRequirement.trip.endDatetime
                ? subTripDate(tripRequirement.trip.endDatetime, _searchTripDate, 'endDatetime', 'tripRequirement (SEARCH)')
                : null;
              bru.setEnvVar("tripStartStopPlaceRef", tripRequirement.trip.origin);
              bru.setEnvVar("tripEndStopPlaceRef", tripRequirement.trip.destination);
              bru.setEnvVar("tripStartDatetime", _searchStart);
              bru.setEnvVar("tripEndDatetime", _searchEnd);
              bru.setEnvVar("tripVehicleNumber", tripRequirement.trip.vehicleNumber);
              bru.setEnvVar("tripOperatorCode", tripRequirement.trip.operatorCode);
              bru.setEnvVar("tripProductCategoryRef", tripRequirement.trip.productCategoryRef || null);
              bru.setEnvVar("tripProductCategoryName", tripRequirement.trip.productCategoryName || null);
              bru.setEnvVar("tripProductCategoryShortName", tripRequirement.trip.productCategoryShortName || null);

              osdmTripSearchCriteria([
                new TripLegDefinition(
                  tripRequirement.trip.origin,
                  _searchStart,
                  tripRequirement.trip.destination,
                  _searchEnd,
                  tripRequirement.trip.productCategoryRef,
                  tripRequirement.trip.productCategoryName,
                  tripRequirement.trip.productCategoryShortName,
                  tripRequirement.trip.vehicleNumber,
                  tripRequirement.trip.operatorCode
                )
              ], returnOptsFromScenario(scenario),
                // #359: optional OSDM search options from the wizard's
                // Trip Search Criteria sub-panel (flat fields).
                tripRequirement.trip.searchCriteria || null);
              break;
            }
          }
          } catch (_branchErr) {
            // #330 (v1.11.110): name the context so the user sees which
            // tripRequirement and which branch failed instead of a bare
            // "Cannot read property X of undefined" propagating up.
            validationLogger(
              '[ERROR] Scenario "' + scenario.code + '": building TripType=' +
              tripRequirement.tripType + ' criteria for ' + _trCtx +
              ' threw: ' + (_branchErr?.message ? _branchErr.message : String(_branchErr)) +
              '. offerTripSearchCriteria / offerTripSpecifications stays unset and the request body cannot be built. ' +
              'Fix in the wizard: open Test Data → Trip Requirements, open this entry and verify the trip data is complete and dates parse correctly.'
            );
            validationLogger('[DEBUG] ' + _trCtx + ' dump = ' + JSON.stringify(tripRequirement));
            // Don't rethrow — the downstream parseEnvJson error (with the
            // v1.11.109 hint) is the actionable signal the user follows. We
            // just want the named [ERROR] above to appear FIRST so the report
            // surfaces the root cause before the consequence.
          }
          return true;
        }
      });

      // Purchaser details
      jsonData.purchaserList?.some(function (purchaserList) {
        validationLogger('[INFO] Found number of purchaser: ' + purchaserList.purchaser.length);
        const purchaserSpecs = [];
        purchaserList.purchaser.forEach(function (purchaser) {
          const osdmVersion = bru.getEnvVar("osdmVersion");
          if (Number.parseFloat(osdmVersion) >= 3.4) {
            purchaserSpecs.push(new PurchaserContact(
              new DetailContact(
                purchaser.purchaserFirstName,
                purchaser.purchaserLastName,
                new Contact(
                  purchaser.purchaserEmail,
                  purchaser.purchaserPhoneNumber
                )
              )
            ));
          } else {
            purchaserSpecs.push(new Purchaser(
              new Detail(
                purchaser.purchaserFirstName,
                purchaser.purchaserLastName,
                purchaser.purchaserEmail,
                purchaser.purchaserPhoneNumber
              )
            ));
          }
        });

        validationLogger('[DEBUG] Pushed purchaserSpec to environment: ' + JSON.stringify(purchaserSpecs));
        bru.setEnvVar("bookingPurchaserSpecifications", JSON.stringify(purchaserSpecs[0]));
        return true;
      });

      // Passengers — same upfront check as tripRequirements above. #328
      // (v1.11.109): when scenario.passengersListId doesn't resolve, the
      // downstream symptom is a missing `offerPassengerSpecifications` env
      // var. Emit a precise [ERROR] naming the linkage gap.
      const _paxLists    = Array.isArray(jsonData.passengersList) ? jsonData.passengersList : [];
      const _paxWantId   = scenario.passengersListId;
      const _paxFound    = _paxLists.some(function (pl) { return pl && pl.id === _paxWantId; });
      if (!_paxFound) {
        const _availIds = _paxLists.map(function (pl) { return pl?.id; }).filter(function (id) { return id != null; });
        validationLogger(
          '[ERROR] Scenario "' + scenario.code + '" references passengersListId=' +
          JSON.stringify(_paxWantId) + ' but no matching entry exists in datafile.passengersList[]. ' +
          'Available ids: [' + _availIds.join(', ') + ']. ' +
          'Fix in the wizard: open the Test Data → Passengers section, ' +
          'confirm at least one entry exists and that the scenario\'s passengersListId points at one of them.'
        );
      }
      jsonData.passengersList?.some(function (passengersList) {
        if (passengersList.id === scenario.passengersListId) {
          validationLogger('[INFO] Found number of passengers: ' + passengersList.passengers.length);
          bru.setEnvVar("offerPassengerNumber", passengersList.passengers.length);
          const offerPassengerSpecs = [];
          const passengerSpecs = [];
          const passengerReferences = [];
          const passengerAdditionalData = [];
          let passengerIndex = 0;

          // ── Passenger external-ref format probe ────────────────────────────
          // NHF parameter: when scenario.passengerExternalRefFormat is set to
          // a printf-style pattern (e.g. "PAX%04d"), rewrite every passenger
          // reference in-place BEFORE the loop below uses it. The rewrite
          // propagates through every downstream env var (offerPassengerSpecs,
          // bookingPassengerSpecifications, bookingPassengerReferences,
          // updateFirstName_<i> etc.) because they all read passenger.reference.
          // Empty / missing pattern → no rewrite, default 00001-style is kept.
          //
          // Mutating the loaded data is safe: jsonData is parsed fresh from the
          // data file on each scenario load (see getScenarioData()), so the
          // rewrite doesn't leak across runs.
          const _refFormatProbe = scenario.passengerExternalRefFormat;
          if (_refFormatProbe && /%0?\d*d/.test(String(_refFormatProbe))) {
            passengersList.passengers.forEach(function (p, i) {
              p.reference = applyExternalRefFormat(_refFormatProbe, i + 1);
            });
            validationLogger('[INFO] 🪪 passengerExternalRefFormat probe armed (pattern: "' + _refFormatProbe + '") — refs rewritten to: ' + passengersList.passengers.map(function (p) { return p.reference; }).join(', '));
          } else if (_refFormatProbe) {
            validationLogger('[WARNING] passengerExternalRefFormat set ("' + _refFormatProbe + '") but missing a %d / %0Nd placeholder — probe ignored, default refs kept.');
          }

          passengersList.passengers.forEach(function (passenger) {
            // #705: an age on the day of travel gives the date of birth.
            const _born = birthDateFor(passenger, bru.getEnvVar("__travelDay"));
            if (_born) {
              passenger.dateOfBirth = _born;
              validationLogger('[INFO] 🎂 Passenger ' + passenger.reference + ': born ' + _born + ', ' + passenger.bornYearsBeforeTravel + ' years before the day of travel' + (passenger.bornDaysAfter ? ' plus ' + passenger.bornDaysAfter + ' day(s)' : '') + (passenger.expectedPassengerType ? '; expected to be priced as ' + passenger.expectedPassengerType : ''));
            }
            // #597: the passenger's reduction cards, sent with the offer and
            // the booking requests.
            const cards = cardsOfPassenger(passenger);
            const offerSpec = new AnonymousPassengerSpec(
              passenger.reference,
              passenger.type,
              passenger.dateOfBirth,
              passenger.gender || null,
            );
            if (cards.length > 0) offerSpec.cards = cards;
            offerPassengerSpecs.push(offerSpec);

            const osdmVersion = bru.getEnvVar("osdmVersion");
            if (Number.parseFloat(osdmVersion) >= 3.4) {
              passengerSpecs.push(new PassengerSpec(
                passenger.reference,
                passenger.type,
                passenger.dateOfBirth,
                passenger.gender || null,
                new DetailContact(
                  passenger.firstName,
                  passenger.lastName,
                  new Contact(
                    passenger.email || null,
                    passenger.phoneNumber || null
                  )
                )
              ));
            } else {
              passengerSpecs.push(new PassengerSpec(
                passenger.reference,
                passenger.type,
                passenger.dateOfBirth,
                passenger.gender || null,
                new Detail(
                  passenger.firstName,
                  passenger.lastName,
                  passenger.email || null,
                  passenger.phoneNumber || null
                )
              ));
            }

            if (cards.length > 0) passengerSpecs.at(-1).cards = cards;
            passengerReferences.push(passenger.reference);

            const passengerDataStruct = {
              updateFirstName: passenger.firstName,
              updateLastName: passenger.lastName,
              updateDateOfBirth: passenger.dateOfBirth,
              updateEmail: passenger.email,
              updatePhoneNumber: passenger.phoneNumber,
              updateGender: passenger.gender ?? "X",
            };

            const passengerAdditionalDataStruct = {
              updateFirstName: passenger.updateFirstName ?? passengerDataStruct.updateFirstName,
              updateLastName: passenger.updateLastName ?? passengerDataStruct.updateLastName,
              updateDateOfBirth: passenger.updateDateOfBirth ?? passengerDataStruct.updateDateOfBirth,
              updateEmail: passenger.updateEmail ?? passengerDataStruct.updateEmail,
              updatePhoneNumber: passenger.updatePhoneNumber ?? passengerDataStruct.updatePhoneNumber,
              updateGender: passenger.updateGender ?? passengerDataStruct.updateGender,
            };

            // A passenger step 03 does not update is read back at step 04
            // against the values the booking sent: every passenger when the
            // scenario turns the PATCH off, the others than the first when
            // only the main passenger is updated.
            const _updated = resolveSalesFlowActions(scenario.salesFlowActions).patchPassengers
              && (passengerUpdateScope(scenario) === "ALL" || passengerIndex === 0);
            passengerAdditionalData.push(_updated ? passengerAdditionalDataStruct : passengerDataStruct);
            passengerIndex++;

            if (
              passenger.updateFirstName == null &&
              passenger.updateLastName == null &&
              passenger.updateDateOfBirth == null &&
              passenger.updateEmail == null &&
              passenger.updatePhoneNumber == null &&
              passenger.updateGender == null
            ) {
              bru.setEnvVar("skipPatchPassengerRequest", "true");
            }
          });

          validationLogger('[DEBUG] Pushed passengerSpec to environment: ' + JSON.stringify(passengerSpecs));
          bru.setEnvVar("__expectedPassengerTypes", JSON.stringify(expectedTypesOf(passengersList.passengers)));
          bru.setEnvVar("offerPassengerSpecifications", JSON.stringify(offerPassengerSpecs));
          bru.setEnvVar("bookingPassengerSpecifications", JSON.stringify(passengerSpecs));
          bru.setEnvVar("bookingPassengerReferences", JSON.stringify(passengerReferences));
          bru.setEnvVar("passengerAdditionalData", JSON.stringify(passengerAdditionalData));

          let passengerData = bru.getEnvVar("passengerAdditionalData");
          passengerData = typeof passengerData === 'string' ? JSON.parse(passengerData) : passengerData;
          passengerData.forEach((data, index) => {
            Object.entries(data).forEach(([key, value]) => {
              bru.setEnvVar(`${key}_${index}`, value);
            });
          });
          return true;
        }
      });

      // Offer search criteria
      // Priority: inline offerSearchCriteria > offerSearchCriteriaListId reference > legacy defaults
      let criteria = scenario.offerSearchCriteria || null;

      // Resolve offerSearchCriteriaListId reference when no inline criteria
      if (!criteria && scenario.offerSearchCriteriaListId != null && Array.isArray(jsonData.offerSearchCriteriaList)) {
        const listEntry = jsonData.offerSearchCriteriaList.find(e => e.id === scenario.offerSearchCriteriaListId);
        if (listEntry && Array.isArray(listEntry.offerSearchCriteria) && listEntry.offerSearchCriteria.length > 0) {
          criteria = listEntry.offerSearchCriteria[0];
          validationLogger(`[INFO] offerSearchCriteria resolved from offerSearchCriteriaListId=${scenario.offerSearchCriteriaListId}`);
        }
      }

      // #600: a class per leg asks for every class it names.
      const _perLeg = require('./legClasses.js').normaliseLegClasses(scenario.legTravelClasses);
      if (criteria && typeof criteria === 'object') {
        osdmOfferSearchCriteria(
          criteria.currency || null,
          criteria.offerMode || null,
          criteria.requestedOfferParts || null,
          criteria.flexibilities || null,
          criteria.serviceClass || null,
          _perLeg ? require('./legClasses.js').requestedClasses(_perLeg) : (criteria.travelClass || null),
          criteria.productTags || null,
          criteria.productSelections || null
        );
      } else {
        // Legacy scenario without any offerSearchCriteria — use safe defaults
        validationLogger(`[WARN] No offerSearchCriteria on scenario '${scenario.code}' — using defaults.`);
        osdmOfferSearchCriteria('EUR', 'INDIVIDUAL', ['ADMISSION', 'RESERVATION'],
          null, null, null, null, null);
      }

      // Requested fulfillment options — same upfront check. #328
      // (v1.11.109): unresolved requestedFulfillmentOptionsListId leaves
      // `offerFulfillmentOptions` unset; the request goes out without a
      // requestedFulfillmentOptions[] array.
      if (Array.isArray(jsonData.requestedFulfillmentOptionsList) && jsonData.requestedFulfillmentOptionsList.length > 0) {
        const _ffLists   = jsonData.requestedFulfillmentOptionsList;
        const _ffWantId  = scenario.requestedFulfillmentOptionsListId;
        const _ffFound   = _ffLists.some(function (ff) { return ff && ff.id === _ffWantId; });
        if (!_ffFound) {
          const _availIds = _ffLists.map(function (ff) { return ff?.id; }).filter(function (id) { return id != null; });
          validationLogger(
            '[ERROR] Scenario "' + scenario.code + '" references requestedFulfillmentOptionsListId=' +
            JSON.stringify(_ffWantId) + ' but no matching entry exists in datafile.requestedFulfillmentOptionsList[]. ' +
            'Available ids: [' + _availIds.join(', ') + ']. ' +
            'Fix in the wizard: open the Test Data → Requested Fulfillment Options section ' +
            'and link this scenario to a defined entry.'
          );
        }
        jsonData.requestedFulfillmentOptionsList.some(function (requestedFulfillmentOptionList) {
          if (requestedFulfillmentOptionList.id === scenario.requestedFulfillmentOptionsListId) {
            const requestedFulfillmentOptions = [];
            requestedFulfillmentOptionList.requestedFulfillmentOptions.forEach(function (requestedFulfillmentOption) {
              const fulfillmentType = requestedFulfillmentOption.fulfillmentType ?? null;
              const fulfillmentMedia = requestedFulfillmentOption.fulfillmentMedia ?? null;
              if (fulfillmentType != null && fulfillmentMedia != null) {
                requestedFulfillmentOptions.push(new FulfillmentOption(fulfillmentType, fulfillmentMedia));
              }
            });

            osdmFulfillmentOptions(requestedFulfillmentOptions);
            return true;
          }
        });
      } else {
        validationLogger("[INFO] requestedFulfillmentOptionsList is empty");
      }

      foundCorrectDataSet = true;
      // Log-audit round 2: "Correct data set was found" never said WHICH
      // data — testers read it as a mystery term. Say what actually
      // happened: the scenario definition was matched by code in the data
      // file and its linked Test Data sections were resolved into the
      // run's variables.
      validationLogger('[INFO] ✅ Scenario "' + scenarioCode + '" loaded from the data file — linked test data resolved' +
        ' (tripRequirement #' + scenario.tripRequirementId +
        ', passengersList #' + scenario.passengersListId +
        ', fulfillmentOptions #' + scenario.requestedFulfillmentOptionsListId + ')');
    }
    dataFileIndex++;
  }

  if (foundCorrectDataSet === false) {
    const _availCodes = (jsonData.scenarios || []).map(function (s) { return s?.code; }).filter(Boolean);
    validationLogger('[ERROR] ⛔ Scenario "' + scenarioCode + '" not found in the data file\'s scenarios[]. ' +
      'Available code(s): [' + _availCodes.slice(0, 20).join(', ') + (_availCodes.length > 20 ? ', …' : '') + ']. ' +
      'Fix in the wizard: open Test Config and check the scenario list / scenariosToRun selection.');
    validationLogger(`[ERROR] ⛔ Stopping execution of further requests`);
    throw new Error(`Scenario code "${scenarioCode}" not found`);
  }
}

// Function to set trip search criteria
function osdmTripSearchCriteria(legDefinitions, returnOpts, searchCriteria) {
  test('Trip Search Criteria has at least one leg', function () {
    expect(legDefinitions).to.be.an("array");
    expect(legDefinitions.length).to.be.above(0);
    if (legDefinitions.length === 0) return;
  });

  if (legDefinitions.length > 1) {
    validationLogger("[WARNING] TripSearchCriteria currently doesn't generate via points when multiple legs are provided");
  }

  const legDef = legDefinitions[0];

  // #722: the train and operator filters are optional in OSDM, and a provider
  // that does not take them refuses the whole search. They are sent only when
  // the trip's Trip Search Criteria turn "Train filter" on (the filter's own
  // test); otherwise the train is chosen in the answer (searchTrain.js).
  const { trainFilterOn } = require('./searchTrain.js');
  const _withFilter = trainFilterOn(searchCriteria);
  bru.setEnvVar("__searchTrainFilter", _withFilter ? "true" : "");
  const carrierFilter = _withFilter && legDef.carrier ? new CarrierFilter([legDef.carrier], false) : null;
  const vehicleFilter = _withFilter && legDef.vehicleNumber ? new VehicleFilter([legDef.vehicleNumber], null, false) : null;
  if (!_withFilter && (legDef.carrier || legDef.vehicleNumber)) {
    const _train = legDef.vehicleNumber ? ' ' + legDef.vehicleNumber : '';
    const _operator = legDef.carrier ? ' (operator ' + legDef.carrier + ')' : '';
    validationLogger(`[INFO] 🔎 Search by place and time only: the train${_train}${_operator} is chosen in the answer, not sent as a filter. Trip Search Criteria → Train filter sends it.`);
  }

  const tripDataFilter = (carrierFilter || vehicleFilter) ? new TripDataFilter(carrierFilter, vehicleFilter) : null;
  const tripParameters = tripDataFilter ? new TripParameters(tripDataFilter) : null;

  // TripSearchCriteria must use LocalDateTime (no offset, no trailing Z)
  // for all providers except Bileto.
  const _osdmVersionRaw = bru.getEnvVar("osdmVersion");
  const _osdmVersionForDatetime = Number.parseFloat(_osdmVersionRaw || "0");
  let _startDateTime = toLocalDateTime(legDef.startDateTime);

  // Bileto exception: keep OffsetDateTime in TripSearchCriteria.
  const _apiBase = bru.getEnvVar("api_base") || "";
  if (_apiBase.includes("bileto")) {
    _startDateTime = toOffsetDateTime(legDef.startDateTime);
    validationLogger(`[INFO] Bileto exception — TripSearchCriteria uses OffsetDateTime: "${_startDateTime}"`);
  }

  validationLogger(
    `[INFO] 📅 TripSearchCriteria datetime — osdmVersion: "${_osdmVersionRaw}" (parsed: ${_osdmVersionForDatetime}) → ` +
    (_apiBase.includes("bileto")
      ? `OffsetDateTime format (Bileto exception) → "${_startDateTime}"`
      : `LocalDateTime format (offset/Z stripped) → "${_startDateTime}" (raw: "${legDef.startDateTime}")`)
  );

  const sandbox = bru.getEnvVar("api_base") || "";
  let tripSearchCriteria;
  if (sandbox.includes("paxone")) {
    tripSearchCriteria = new TripSearchCriteria(
      _startDateTime,
      new StopPlaceRef(legDef.startStopPlaceRef),
      new StopPlaceRef(legDef.endStopPlaceRef),
      null
    );
  } else {
    tripSearchCriteria = new TripSearchCriteria(
      _startDateTime,
      new StopPlaceRef(legDef.startStopPlaceRef),
      new StopPlaceRef(legDef.endStopPlaceRef),
      tripParameters
    );
  }

  // Return trip (#176, #594): the inbound date, from the outbound departure.
  applyReturnOpts(tripSearchCriteria, returnOpts, _startDateTime);

  // ── #359: optional OSDM TripSearchCriteria members from the wizard's
  // Trip Search Criteria sub-panel. Only filled fields are sent; the wire
  // shape is unchanged when nothing is configured.
  if (searchCriteria && typeof searchCriteria === 'object') {
    const _set = v => v != null && String(v).trim() !== '';
    const _applied = [];

    // Arrival-time basis (OSDM: exactly one of departureTime/arrivalTime).
    // Uses the trip's Arrival field, same datetime convention as departure
    // (LocalDateTime; OffsetDateTime for the Bileto exception).
    if (searchCriteria.timeBasis === 'ARRIVAL') {
      if (legDef.endDateTime) {
        tripSearchCriteria.arrivalTime = _apiBase.includes("bileto")
          ? toOffsetDateTime(legDef.endDateTime)
          : toLocalDateTime(legDef.endDateTime);
        delete tripSearchCriteria.departureTime;
        _applied.push(`arrival-time basis (${tripSearchCriteria.arrivalTime})`);
      } else {
        validationLogger('[WARNING] Trip Search Criteria asks for ARRIVAL-time search but the trip has no Arrival time — falling back to departure-time search. Fill the Arrival field in the Trip requirement.');
      }
    }

    // Vias (ordered; optional dwellTime per via).
    const _vias = [];
    [['via1Place', 'via1Dwell'], ['via2Place', 'via2Dwell']].forEach(([pf, df]) => {
      if (_set(searchCriteria[pf])) {
        const v = { viaPlace: new StopPlaceRef(String(searchCriteria[pf]).trim()) };
        if (_set(searchCriteria[df])) v.dwellTime = String(searchCriteria[df]).trim();
        _vias.push(v);
      }
    });
    if (_vias.length) {
      tripSearchCriteria.vias = _vias;
      _applied.push(`${_vias.length} via(s): ${_vias.map(v => v.viaPlace.stopPlaceRef).join(', ')}`);
    }

    // Not-vias (comma-separated refs → one NotVia entry with the list).
    if (_set(searchCriteria.notVias)) {
      const _places = String(searchCriteria.notVias).split(',').map(s => s.trim()).filter(Boolean);
      if (_places.length) {
        tripSearchCriteria.notVias = [{ notViaPlace: _places.map(pl => new StopPlaceRef(pl)) }];
        _applied.push(`notVia: ${_places.join(', ')}`);
      }
    }

    // Simple TripParameters. Merged with the train-binding dataFilter; the
    // paxone exception (no parameters member at all) is preserved.
    const _params = {};
    ['transferLimit', 'numberOfResults', 'numberOfResultsBefore', 'numberOfResultsAfter'].forEach(k => {
      if (_set(searchCriteria[k])) {
        const n = Number.parseInt(searchCriteria[k], 10);
        if (Number.isInteger(n) && n >= 0) { _params[k] = n; _applied.push(`${k} ${n}`); }
        else validationLogger(`[WARNING] Trip Search Criteria ${k}="${searchCriteria[k]}" is not a non-negative integer — ignored.`);
      }
    });
    if (_set(searchCriteria.ignoreRealtimeData)) {
      _params.ignoreRealtimeData = String(searchCriteria.ignoreRealtimeData) === 'true';
      _applied.push(`ignoreRealtimeData ${_params.ignoreRealtimeData}`);
    }
    if (Object.keys(_params).length > 0) {
      if (sandbox.includes("paxone")) {
        validationLogger('[INFO] paxone exception — TripParameters omitted from the request; the configured transfer/result/realtime options are not sent (vias/notVias/arrival basis still apply).');
      } else {
        const _merged = tripSearchCriteria.parameters || {};
        Object.assign(_merged, _params);
        tripSearchCriteria.parameters = _merged;
      }
    }

    if (_applied.length) {
      validationLogger(`[INFO] 🔎 Trip search criteria applied — ${_applied.join('; ')}`);
    }
  }

  bru.setEnvVar("offerTripSearchCriteria", JSON.stringify(tripSearchCriteria));
}

// #809: why a trip specification leg has no carrier, and what to do.
function carrierMissingText(n, legDef) {
  const train = isText(legDef.vehicleNumber) ? `train ${legDef.vehicleNumber}` : 'its train';
  return `Leg ${n} (${train}, ${legDef.startStopPlaceRef} → ${legDef.endStopPlaceRef}) has no operator code. ` +
    'OSDM requires the carrier in a trip specification (DatedJourney.carriers), so the provider cannot read the request. ' +
    'Give the train its operator code in Test Data (e.g. urn:uic:rics:1185), then Apply test data to this trip.';
}

// Function to set trip specifications
function osdmTripSpecification(legDefinitions, returnOpts) {
  test('Trip Specification has at least one leg', function () {
    expect(legDefinitions).to.be.an("array");
    expect(legDefinitions.length).to.be.above(0);
    if (legDefinitions.length === 0) return;
  });

  bru.setEnvVar(TRIP.EXTERNAL_REF, randomUUID());

  const legSpecs = [];
  let outboundStartDateTime = null;   // first leg's departure — basis for the return date

  for (let n = 1; n <= legDefinitions.length; n++) {
    const legKey = TRIP.LEG_SPECIFICATION_REF_PATTERN.replace("%LEG_COUNT%", n);
    const legDef = legDefinitions[n - 1];

    // TripSpecifications should use OffsetDateTime and must not use trailing Z.
    const _specStartDateTime = toOffsetDateTime(legDef.startDateTime);
    const _specEndDateTime = toOffsetDateTime(legDef.endDateTime);
    if (n === 1) outboundStartDateTime = _specStartDateTime;

    if (_specStartDateTime !== legDef.startDateTime || _specEndDateTime !== legDef.endDateTime) {
      validationLogger(
        `[INFO] 📅 TripSpecification datetime normalized: start "${legDef.startDateTime}" -> "${_specStartDateTime}", ` +
        `end "${legDef.endDateTime}" -> "${_specEndDateTime}"`
      );
    }

    const boardSpec = new BoardSpecification(new StopPlaceRef(legDef.startStopPlaceRef), new ServiceTime(_specStartDateTime));
    const alignSpec = new AlightSpecification(new StopPlaceRef(legDef.endStopPlaceRef), new ServiceTime(_specEndDateTime));

    // OSDM's ProductCategory requires productCategoryRef, name and shortName
    // (#729): one with any of them missing is not sent at all. A provider
    // refused `"productCategory": {}` as a malformed request.
    const productCategory = productCategoryOf(legDef);
    if (!productCategory && [legDef.productCategoryRef, legDef.productCategoryName, legDef.productCategoryShortName].some(isText)) {
      validationLogger(`[INFO] Leg ${n}: product category not sent — OSDM needs its reference, name and short name together.`);
    }

    // #809: OSDM's DatedJourney requires the carrier (NamedCompany.ref). It
    // comes from the Test Data train's operator code; `[{}]` went out when the
    // train had none, and the provider refused the whole request.
    // A check only when it is missing, so that a run with carriers keeps its count.
    const carrier = isText(legDef.carrier) ? legDef.carrier.trim() : null;
    if (!carrier) {
      validationLogger(`[ERROR] ${carrierMissingText(n, legDef)}`);
      test(`Trip specification leg ${n} names its carrier (operator code)`, function () {
        expect(carrier, carrierMissingText(n, legDef)).to.be.a('string');
      });
    }
    const datedJourney = new DatedJourney(productCategory, [legDef.vehicleNumber], carrier ? [new NamedCompany(carrier)] : undefined);

    const timedLegSpec = new TimedLegSpecification(
      boardSpec,
      alignSpec,
      datedJourney
    );

    bru.setEnvVar(legKey, randomUUID());

    legSpecs.push(new TripLegSpecification(
      bru.getEnvVar(legKey),
      timedLegSpec
    ));
  }

  const tripSpecification = new TripSpecification(
    bru.getEnvVar(TRIP.EXTERNAL_REF),
    legSpecs
  );

  // Return trip (#176, #594): the inbound date, from the first leg's departure.
  applyReturnOpts(tripSpecification, returnOpts, outboundStartDateTime);

  bru.setEnvVar("offerTripSpecifications", JSON.stringify([tripSpecification]));
}

// Return trip (#176): OSDM expresses a return via TripSearchCriteria /
// TripSpecification → returnSearchParameters.inwardReturnDate — NOT inside
// offerSearchCriteria (which is strict; an unknown field like the old
// `inboundDate` 400s on spec-strict vendors such as Bileto). The return date is
// DERIVED from the dynamically-resolved outbound departure: outbound date +
// offsetDays, at the outbound departure time-of-day (or an optional HH:MM
// override). The trailing offset (e.g. +00:00 for Bileto, none otherwise) is
// mirrored from the outbound so the format matches the outbound exactly.
// Returns { inwardReturnDate } or null (one-way / unparseable).
function buildReturnSearchParameters(offsetDays, returnTime, outboundStart) {
  if (offsetDays == null || offsetDays === '') return null;
  const offset = Number.parseInt(offsetDays, 10);
  if (!Number.isInteger(offset) || offset < 0) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2}:\d{2})(.*)$/.exec(String(outboundStart || ''));
  if (!m) {
    validationLogger(`[WARN] Return trip skipped — could not parse outbound datetime "${outboundStart}"`);
    return null;
  }
  const tz = m[5] || '';
  let timePart = m[4];
  if (typeof returnTime === 'string' && /^\d{2}:\d{2}$/.test(returnTime.trim())) {
    timePart = returnTime.trim() + ':00';
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + offset);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const inwardReturnDate = `${yyyy}-${mm}-${dd}T${timePart}${tz}`;
  validationLogger(`[INFO] 🔁 Return trip — inwardReturnDate "${inwardReturnDate}" (outbound "${outboundStart}" + ${offset} day(s))`);
  return { inwardReturnDate };
}

const OFFER_REQUEST_TEXT = { SEARCH: 'by trip search', SPECIFICATION: 'by trip specification', TRIP_IDS: 'by trip id' };
// #780: the framework key of an offer search option → the OSDM member.
const OFFER_OPTION_MEMBER = { offerModes: 'offerMode', requestedOfferParts: 'requestedOfferParts', travelClasses: 'travelClasses', serviceClassTypes: 'serviceClassTypes' };
const PARTIAL_REFUND_SCOPE_OF = { partialRefundByFulfillment: 'fulfillment', partialRefundByLeg: 'leg', partialRefundByPax: 'passenger' };

// The [WARNING] for one entry of __featureNotDeclaredWarnings: a field the
// scenario arms that the Test Framework does not declare (#218, #619, #713).
function featureNotDeclaredWarning(scenario, field) {
  // #766: a place chosen in a way the framework does not declare.
  if (typeof field === 'string' && field.startsWith('placeSelectionBy:')) {
    const flow = field.slice('placeSelectionBy:'.length);
    const text = require('./placeSelection.js').FLOW_TEXT[flow] || flow;
    return `[WARNING] Scenario "${scenario.code}" chooses a place ${text} (${flow}), which the Test Framework does not declare (Seat Selection). The run will proceed; the provider may refuse or ignore the choice. Declare the flow in the Test Framework, or change the scenario's place selection.`;
  }
  // #780: an offer search option value (offerOption:<framework key>=<value>).
  if (typeof field === 'string' && field.startsWith('offerOption:')) {
    const [key, value] = field.slice('offerOption:'.length).split('=');
    const member = OFFER_OPTION_MEMBER[key] || key;
    return `[WARNING] Scenario "${scenario.code}" asks for offers with offerSearchCriteria.${member} ${value}, which the Test Framework does not declare (Offer search options). The run will proceed; the provider may refuse or ignore it. Declare the value in the Test Framework, or change the scenario's offer search criteria.`;
  }
  // #781: a currency the framework does not declare (currency:<code>).
  if (typeof field === 'string' && field.startsWith('currency:')) {
    const currency = field.slice('currency:'.length);
    return `[WARNING] Scenario "${scenario.code}" asks for offers in ${currency}, which the Test Framework does not declare (Currencies). The run will proceed; the provider may refuse the currency or answer in another one. Declare the currency in the Test Framework, or change the scenario's offer search criteria.`;
  }
  // #748: the offer request's form (offerRequestBy:SEARCH|SPECIFICATION|TRIP_IDS).
  if (typeof field === 'string' && field.startsWith('offerRequestBy:')) {
    const form = OFFER_REQUEST_TEXT[field.slice('offerRequestBy:'.length)] || field.slice('offerRequestBy:'.length);
    return `[WARNING] Scenario "${scenario.code}" asks for offers ${form}, which the Test Framework does not declare (Offer requests). The run will proceed; the provider may refuse the request. Declare the form in the Test Framework, or change the trip type of the scenario's trip.`;
  }
  // #809: steps the Test Framework says the provider does not offer.
  if (field === 'passengerUpdate') {
    return `[WARNING] Scenario "${scenario.code}" updates its passengers, but the Test Framework says the provider does not (Passenger Types). Step 03 is skipped in this run. Turn the passenger update off on the scenario to silence this warning.`;
  }
  if (field === 'purchaserAfterBooking') {
    return `[WARNING] Scenario "${scenario.code}" writes its purchaser after the booking (bookingPurchaserMode deferred), but the Test Framework says the provider does not take it (Passenger Types). The run will proceed; the provider may refuse POST /bookings/{id}/purchaser.`;
  }
  if (field === 'returnModel') {
    const model = scenario?.offerSearchCriteria?.returnModel || 'SEPARATE';
    return `[WARNING] Scenario "${scenario.code}" asks for a return in the ${model} model, which the Test Framework does not declare (Return journeys). The run will proceed. Declare the model in the Test Framework, or choose a declared one on the scenario.`;
  }
  // #713: a partial refund needs REFUND_PARTIAL and, when the framework lists
  // them, the scope (Partial refund scopes: fulfillment, leg, passenger).
  if (PARTIAL_REFUND_SCOPE_OF[field]) {
    return `[WARNING] Scenario "${scenario.code}" arms ${field}=on but the Test Framework does not declare a partial refund by ${PARTIAL_REFUND_SCOPE_OF[field]} (REFUND_PARTIAL in the sales flows, and its scope under Partial refund scopes). The run will proceed; the provider may refuse the refund. Declare it in the Test Framework, or unset ${field} on the scenario.`;
  }
  return `[WARNING] Scenario "${scenario.code}" arms ${field}=on but the Test Framework does not declare the corresponding capability (REFUND_PARTIAL / EXCHANGE_PARTIAL in salesFlows). The run will proceed; the runtime will degrade where the wire cannot convey the requested scope. Declare the capability in the Test Framework wizard to silence this warning, or unset ${field} on the scenario.`;
}

// Read the return-trip options the OSCAR scenario stores on offerSearchCriteria
// (returnOffsetDays + optional returnTime, returnModel, returnFulfillments).
// These are authoring data only — never echoed into the OSDM offerSearchCriteria.
function returnOptsFromScenario(scenario) {
  const c = (scenario?.offerSearchCriteria) || {};
  return { offsetDays: c.returnOffsetDays, time: c.returnTime, model: c.returnModel, fulfillments: c.returnFulfillments };
}

// The return of a scenario (#594), on the first offer call's trip. The inbound
// date is kept in returnInboundDate, which is what marks a return scenario.
// From OSDM 3.7 it is sent as offerSearchCriteria.inboundDate (requestsBuilder);
// before, as the deprecated returnSearchParameters.inwardReturnDate on the trip.
function applyReturnOpts(trip, returnOpts, outboundStart) {
  const rsp = returnOpts && buildReturnSearchParameters(returnOpts.offsetDays, returnOpts.time, outboundStart);
  bru.setEnvVar("returnInboundDate", rsp ? rsp.inwardReturnDate : null);
  if (!rsp) return;
  const version = getComplianceVersion();
  const model = normaliseReturnModel(returnOpts.model);
  bru.setEnvVar("returnModel", model);
  bru.setEnvVar("returnFulfillments", normaliseReturnFulfillments(returnOpts.fulfillments));
  validationLogger(`[INFO] 🔁 Return — model ${model} (${model === 'COMBINED' ? 'outboundTripIds: offers covering both directions' : 'outwardOfferIds: one offer per direction'})`);
  if (model === 'COMBINED' && !combinedReturnDefined(version)) {
    validationLogger(`[WARNING] Return model COMBINED (returnSearchParameters.outboundTripIds) is defined from OSDM 3.7; this scenario declares ${version}. The request is sent as it is.`);
  }
  if (returnUsesInboundDate(version)) {
    validationLogger(`[INFO] 🔁 Return — OSDM ${version}: the inbound date goes in offerSearchCriteria.inboundDate (returnSearchParameters.inwardReturnDate is deprecated since 3.7)`);
  } else {
    trip.returnSearchParameters = rsp;
  }
}

// Function to set offer search criteria
function osdmOfferSearchCriteria(
  currency,
  offerMode,
  offerParts,
  flexibilities,
  serviceClassTypes,
  travelClasses,
  productTags,
  productSelections,
) {
  const offerSearchCriteria = {};

  if (currency != null && currency !== '') {
    offerSearchCriteria.currency = currency;
  }
  if (offerMode != null && offerMode !== '') {
    offerSearchCriteria.offerMode = offerMode;
  }
  if (Array.isArray(offerParts) && offerParts.length > 0) {
    offerSearchCriteria.requestedOfferParts = offerParts;
  }
  if (Array.isArray(flexibilities) && flexibilities.length > 0) {
    offerSearchCriteria.flexibilities = flexibilities;
  }
  if (Array.isArray(serviceClassTypes) && serviceClassTypes.length > 0) {
    offerSearchCriteria.serviceClassTypes = serviceClassTypes;
  }
  if (Array.isArray(travelClasses) && travelClasses.length > 0) {
    offerSearchCriteria.travelClasses = travelClasses;
  }
  if (Array.isArray(productTags) && productTags.length > 0) {
    offerSearchCriteria.productTags = productTags;
  }
  if (Array.isArray(productSelections) && productSelections.length > 0) {
    offerSearchCriteria.productSelections = productSelections;
  }

  bru.setEnvVar("offerSearchCriteria", JSON.stringify(offerSearchCriteria));
}

// Function to set fulfillment options
function osdmFulfillmentOptions(requestedFulfillmentOptions) {
  if (Array.isArray(requestedFulfillmentOptions) && requestedFulfillmentOptions.length > 0) {
    bru.setEnvVar("offerFulfillmentOptions", JSON.stringify(requestedFulfillmentOptions));
  }
}

function isText(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// The leg's ProductCategory, or null when the Test Data does not give all
// three members OSDM requires (#729).
function productCategoryOf(legDef) {
  const ref = legDef?.productCategoryRef;
  const name = legDef?.productCategoryName;
  const shortName = legDef?.productCategoryShortName;
  if (!isText(ref) || !isText(name) || !isText(shortName)) return null;
  return new ProductCategory(ref, name, shortName);
}

// Expose globally for convenience (includes resetScenarioEnvVars)
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  // no-op
}
