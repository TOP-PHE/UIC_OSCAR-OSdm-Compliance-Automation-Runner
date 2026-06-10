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

// scenarioParser-bruno.js

// Pure-JS UUID v4 generator — no external package, works in all Bruno sandbox modes
function randomUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

module.exports = {
  getScenarioData,
  parseScenarioData,
  resetScenarioEnvVars,
  resolveSalesFlowActions,
  osdmTripSearchCriteria,
  osdmTripSpecification,
  osdmOfferSearchCriteria,
  osdmFulfillmentOptions,
  buildReturnSearchParameters,
  applyExternalRefFormat
};

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
    out[k] = Object.prototype.hasOwnProperty.call(src, k) ? (src[k] === true) : defaults[k];
  });
  return out;
}

// Deletes all business-logic env vars so a new scenario starts with a clean slate.
// Must stay in sync with the _deleteList in opencollection.yml.
function resetScenarioEnvVars() {
  const deleteList = [
    // Scenario / trip
    "scenario_override",
    "loggingType", "scenarioType", "scenarioAction", "osdmVersion",
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
    "__expiredFlowQueue", "__expiredFlowQueueIndex", "__expiredFlowSubRunPending",
    "bookingPurchaserMode", "purchaserAdditionalData", "requestedInfoPurchaserProbeTargets", "__purchaserStepDone", "__purchaserWriteMethod",
    "__purchaserSweepIndex", "__purchaserSweepTotal", "bookingPurchaserSweepTarget",
    "desiredFlexibility", "accommodationSelection", "requiresPlaceSelection",
    "overruleCode", "refundDate", "TripType",
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
    "refundOffersOfferId", "refundRefundAmount", "refundFee", "isRefundConfirmed",
    "requestRefundOffersBodyData",
    "afterSaleCondition_EXCHANGE_amount", "afterSaleCondition_EXCHANGE_currency", "afterSaleCondition_EXCHANGE_scale",
    "afterSaleCondition_REFUND_amount",   "afterSaleCondition_REFUND_currency",   "afterSaleCondition_REFUND_scale",
    // Partial refund (issue #218)
    "partialRefundByLeg", "partialRefundLegSelection",
    "partialRefundByPax", "partialRefundPaxSelection",
    "__partialRefundDegradedToFull", "__partialRefundResolvedSpec",
    "__bookingForRefund",
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
    const w = parseInt(width || '0', 10);
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
    throw new Error(
      `Data file error: ${ctx} is missing a valid '${fieldLabel}' ` +
      `(got ${value === undefined ? 'undefined' : JSON.stringify(value)}). ` +
      `Each trip requirement needs both a startDatetime and an endDatetime. ` +
      `Add it to the data file, or regenerate the data file via the Test Config UI.`
    );
  }
  return value.replace("%TRIP_DATE%", replacement);
}

// Helper: GET JSON via Bruno's sendRequest
function getJson(url) {
  // Normalize double-slashes in path (e.g. http://host//path → http://host/path)
  const cleanUrl = url.replace(/([^:])\/\/+/g, '$1/');
  if (cleanUrl !== url) {
    validationLogger(`[INFO] 🔧 data_base URL had double-slash, normalized: "${cleanUrl}"`);
  }
  return new Promise((resolve, reject) => {
    bru.sendRequest({ url: cleanUrl, method: "GET", proxy: false }, function (err, res) {
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
    const _q = JSON.parse(bru.getEnvVar('__expiredFlowQueue') || '[]');
    const _i = parseInt(bru.getEnvVar('__expiredFlowQueueIndex') || '0', 10) || 0;
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

// Function to parse scenario data from JSON
function parseScenarioData(jsonData) {
  // Apply root-level systemInfoParameters as env vars (e.g. masterDataLayoutId)
  setSystemInfoParameters(jsonData);

  const plusDays = parseInt(bru.getEnvVar("departureDateFromToday"), 10) || 10;
  const today = new Date();
  today.setDate(today.getDate() + plusDays);

  function pad(n) {
    return String(n).padStart(2, '0');
  }

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
      throw new Error(
        `[ERROR] ❌ scenario_override "${scenarioOverride}" not found in scenarios list. ` +
        `Available: ${allCodes.join(', ')}`
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
    const _asNum = parseInt(_scenarioTarget, 10);
    if (!isNaN(_asNum) && String(_asNum) === _scenarioTarget) {
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
    let idx = parseInt(bru.getEnvVar("scenariosToRunIndex") || "0", 10);
    if (isNaN(idx) || idx < 0) idx = 0;
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
        validationLogger(
          `[WARNING] Scenario "${scenario.code}" arms ${_field}=on but the Test Framework does not declare the corresponding capability (REFUND_PARTIAL / EXCHANGE_PARTIAL in salesFlows). The run will proceed; the runtime will degrade where the wire cannot convey the requested scope. Declare the capability in the Test Framework wizard to silence this warning, or unset ${_field} on the scenario.`
        );
      }

      // Set environment variables for the scenario
      bru.setEnvVar("osdmVersion", ["", "null"].includes(scenario.osdmVersion) ? null : scenario.osdmVersion);
      bru.setEnvVar("loggingType", ["", "null"].includes(scenario.loggingType) ? null : scenario.loggingType);
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
      bru.setEnvVar("requiresPlaceSelection", ["", "null"].includes(scenario.requiresPlaceSelection) ? null : scenario.requiresPlaceSelection);
      bru.setEnvVar("overruleCode", ["", "null"].includes(scenario.overruleCode) ? null : scenario.overruleCode);
      bru.setEnvVar("refundDate", ["", "null"].includes(scenario.refundDate) ? null : scenario.refundDate);

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
      bru.setEnvVar("partialRefundLegSelection",
        ["", "null", null, undefined].includes(scenario.partialRefundLegSelection)
          ? (_prByLeg ? "first" : "")  // default to first when armed
          : String(scenario.partialRefundLegSelection));
      bru.setEnvVar("partialRefundPaxSelection",
        ["", "null", null, undefined].includes(scenario.partialRefundPaxSelection)
          ? (_prByPax ? "first" : "")
          : String(scenario.partialRefundPaxSelection));

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
            validationLogger(`[WARNING] Scenario "${scenario.code}": partialRefundByPax is on but passengersList #${scenario.passengersListId} ${_passengersList ? `has only ${_paxCount} passenger(s)` : `was not found in the data file's passengersList[]`} — per-pax partial refund cannot fire. ${_passengersList ? 'Add a passenger or turn partialRefundByPax off.' : 'Check the scenario’s passengersListId linkage in Test Config.'}`);
          }
        }
        // Per-leg with SPECIFICATION trip can be statically validated.
        // (SEARCH mode is checked at offer time in 10.yml.)
        if (_prByLeg) {
          const _tripReq = jsonData.tripRequirements?.find(
            (tr) => tr && tr.id === scenario.tripRequirementId);
          if (_tripReq && _tripReq.tripType === "SPECIFICATION") {
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
        validationLogger(`[ERROR] expiredFlow queue build failed: ${_e && _e.message} — armed expiry-timer tests will NOT run their extra passes this scenario.`);
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
        const _availIds = _tripList.map(function (tr) { return tr && tr.id; }).filter(function (id) { return id != null; });
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
            case "SPECIFICATION":
              validationLogger('[INFO] ⏳ processing a specification');
              const legDefinitions = [];

              tripRequirement.legs.forEach(function (leg, legIndex) {
                const legPrefix = `leg${legIndex + 1}`;
                const _legCtx = `tripRequirement (SPECIFICATION) leg ${legIndex + 1}`;
                const startDatetime = subTripDate(leg.startDatetime, nextWeekdayString, 'startDatetime', _legCtx);
                const endDatetime = subTripDate(leg.endDatetime, nextWeekdayString, 'endDatetime', _legCtx);

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

            case "SEARCH":
              validationLogger('[INFO] ⏳ processing a search');
              const _searchStart = subTripDate(tripRequirement.trip.startDatetime, nextWeekdayString, 'startDatetime', 'tripRequirement (SEARCH)');
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
                ? subTripDate(tripRequirement.trip.endDatetime, nextWeekdayString, 'endDatetime', 'tripRequirement (SEARCH)')
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
              ], returnOptsFromScenario(scenario));
              break;
          }
          } catch (_branchErr) {
            // #330 (v1.11.110): name the context so the user sees which
            // tripRequirement and which branch failed instead of a bare
            // "Cannot read property X of undefined" propagating up.
            validationLogger(
              '[ERROR] Scenario "' + scenario.code + '": building TripType=' +
              tripRequirement.tripType + ' criteria for ' + _trCtx +
              ' threw: ' + (_branchErr && _branchErr.message ? _branchErr.message : String(_branchErr)) +
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
          if (parseFloat(osdmVersion) >= 3.4) {
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
        const _availIds = _paxLists.map(function (pl) { return pl && pl.id; }).filter(function (id) { return id != null; });
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
            offerPassengerSpecs.push(new AnonymousPassengerSpec(
              passenger.reference,
              passenger.type,
              passenger.dateOfBirth,
              passenger.gender || null,
            ));

            const osdmVersion = bru.getEnvVar("osdmVersion");
            if (parseFloat(osdmVersion) >= 3.4) {
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

            passengerAdditionalData.push(passengerAdditionalDataStruct);
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

      if (criteria && typeof criteria === 'object') {
        osdmOfferSearchCriteria(
          criteria.currency || null,
          criteria.offerMode || null,
          criteria.requestedOfferParts || null,
          criteria.flexibilities || null,
          criteria.serviceClass || null,
          criteria.travelClass || null,
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
          const _availIds = _ffLists.map(function (ff) { return ff && ff.id; }).filter(function (id) { return id != null; });
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
      validationLogger("[INFO] ✅ Correct data set was found for this scenario : " + scenarioCode);
    }
    dataFileIndex++;
  }

  if (foundCorrectDataSet === false) {
    validationLogger(`[ERROR] ⛔ Scenario code with name :  "${scenarioCode}" not found, please check`);
    validationLogger(`[ERROR] ⛔ Stopping execution of further requests`);
    throw new Error(`Scenario code "${scenarioCode}" not found`);
  }
}

// Function to set trip search criteria
function osdmTripSearchCriteria(legDefinitions, returnOpts) {
  test('Trip Search Criteria has at least one leg', function () {
    expect(legDefinitions).to.be.an("array");
    expect(legDefinitions.length).to.be.above(0);
    if (legDefinitions.length === 0) return;
  });

  if (legDefinitions.length > 1) {
    validationLogger("[WARNING] TripSearchCriteria currently doesn't generate via points when multiple legs are provided");
  }

  const legDef = legDefinitions[0];

  const carrierFilter = legDef.carrier ? new CarrierFilter([legDef.carrier], false) : null;
  const vehicleFilter = legDef.vehicleNumber ? new VehicleFilter([legDef.vehicleNumber], null, false) : null;

  const tripDataFilter = (carrierFilter || vehicleFilter) ? new TripDataFilter(carrierFilter, vehicleFilter) : null;
  const tripParameters = tripDataFilter ? new TripParameters(tripDataFilter) : null;

  // TripSearchCriteria must use LocalDateTime (no offset, no trailing Z)
  // for all providers except Bileto.
  const _osdmVersionRaw = bru.getEnvVar("osdmVersion");
  const _osdmVersionForDatetime = parseFloat(_osdmVersionRaw || "0");
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

  // Return trip (#176): derive inwardReturnDate from the outbound departure.
  const rsp = returnOpts && buildReturnSearchParameters(returnOpts.offsetDays, returnOpts.time, _startDateTime);
  if (rsp) tripSearchCriteria.returnSearchParameters = rsp;

  bru.setEnvVar("offerTripSearchCriteria", JSON.stringify(tripSearchCriteria));
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

    const productCategory = legDef.productCategoryRef === null
      ? null
      : new ProductCategory(legDef.productCategoryRef, legDef.productCategoryName, legDef.productCategoryShortName);

    const datedJourney = new DatedJourney(productCategory, [legDef.vehicleNumber], [new NamedCompany(legDef.carrier)]);

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

  // Return trip (#176): derive inwardReturnDate from the first leg's departure.
  const rsp = returnOpts && buildReturnSearchParameters(returnOpts.offsetDays, returnOpts.time, outboundStartDateTime);
  if (rsp) tripSpecification.returnSearchParameters = rsp;

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
  const offset = parseInt(offsetDays, 10);
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

// Read the return-trip options the OSCAR scenario stores on offerSearchCriteria
// (returnOffsetDays + optional returnTime). These are authoring data only — they
// are routed to the TRIP, never echoed into the OSDM offerSearchCriteria.
function returnOptsFromScenario(scenario) {
  const c = (scenario && scenario.offerSearchCriteria) || {};
  return { offsetDays: c.returnOffsetDays, time: c.returnTime };
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

// Expose globally for convenience (includes resetScenarioEnvVars)
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  // no-op
}
