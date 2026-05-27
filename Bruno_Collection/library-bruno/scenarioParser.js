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
  buildReturnSearchParameters
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
    "expiredBookingTest", "__expiredBookingArmed",
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
        console.log('✅ All ' + effectiveList.length + ' scenarios attempted — stopping run (index ' + idx + ')');
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

      // Trip requirements
      jsonData.tripRequirements?.some(function (tripRequirement) {
        if (tripRequirement.id === scenario.tripRequirementId) {
          bru.setEnvVar("TripType", tripRequirement.tripType);

          switch (tripRequirement.tripType) {
            case "SPECIFICATION":
              validationLogger('[INFO] ⏳ processing a specification');
              const legDefinitions = [];

              tripRequirement.legs.forEach(function (leg, legIndex) {
                const legPrefix = `leg${legIndex + 1}`;
                const startDatetime = leg.startDatetime.replace("%TRIP_DATE%", nextWeekdayString);
                const endDatetime = leg.endDatetime.replace("%TRIP_DATE%", nextWeekdayString);

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
              bru.setEnvVar("tripStartStopPlaceRef", tripRequirement.trip.origin);
              bru.setEnvVar("tripEndStopPlaceRef", tripRequirement.trip.destination);
              bru.setEnvVar("tripStartDatetime", tripRequirement.trip.startDatetime.replace("%TRIP_DATE%", nextWeekdayString));
              bru.setEnvVar("tripEndDatetime", tripRequirement.trip.endDatetime.replace("%TRIP_DATE%", nextWeekdayString));
              bru.setEnvVar("tripVehicleNumber", tripRequirement.trip.vehicleNumber);
              bru.setEnvVar("tripOperatorCode", tripRequirement.trip.operatorCode);
              bru.setEnvVar("tripProductCategoryRef", tripRequirement.trip.productCategoryRef || null);
              bru.setEnvVar("tripProductCategoryName", tripRequirement.trip.productCategoryName || null);
              bru.setEnvVar("tripProductCategoryShortName", tripRequirement.trip.productCategoryShortName || null);

              osdmTripSearchCriteria([
                new TripLegDefinition(
                  tripRequirement.trip.origin,
                  tripRequirement.trip.startDatetime.replace("%TRIP_DATE%", nextWeekdayString),
                  tripRequirement.trip.destination,
                  tripRequirement.trip.endDatetime.replace("%TRIP_DATE%", nextWeekdayString),
                  tripRequirement.trip.productCategoryRef,
                  tripRequirement.trip.productCategoryName,
                  tripRequirement.trip.productCategoryShortName,
                  tripRequirement.trip.vehicleNumber,
                  tripRequirement.trip.operatorCode
                )
              ], returnOptsFromScenario(scenario));
              break;
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

        validationLogger('[INFO] Pushed purchaserSpec to environment: ' + JSON.stringify(purchaserSpecs));
        bru.setEnvVar("bookingPurchaserSpecifications", JSON.stringify(purchaserSpecs[0]));
        return true;
      });

      // Passengers
      jsonData.passengersList?.some(function (passengersList) {
        if (passengersList.id === scenario.passengersListId) {
          validationLogger('[INFO] Found number of passengers: ' + passengersList.passengers.length);
          bru.setEnvVar("offerPassengerNumber", passengersList.passengers.length);
          const offerPassengerSpecs = [];
          const passengerSpecs = [];
          const passengerReferences = [];
          const passengerAdditionalData = [];
          let passengerIndex = 0;

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

          validationLogger('[INFO] Pushed passengerSpec to environment: ' + JSON.stringify(passengerSpecs));
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

      // Requested fulfillment options
      if (Array.isArray(jsonData.requestedFulfillmentOptionsList) && jsonData.requestedFulfillmentOptionsList.length > 0) {
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
