/**
 * offers.js — validate the OFFER response (POST /offers → OfferCollection).
 *
 * First validation step of the sale flow (after `01. POST Get Offer`). Checks the
 * offer parts one array at a time — admissions / reservations / ancillaries —
 * selects an offer for the rest of the flow (sets offerId, etc.), and surfaces any
 * `requestedInformation` the provider attached. Response-side counterpart to
 * requestsBuilder.js (which builds the request bodies).
 */
// Import needed library files
require('./displays.js');
require('./requestsBuilder.js');
const { bruTest: test, expectTypeOrNull, expectScale } = require('./testCapture.js');
const { OSDM_PASSENGER_TYPES, checkExtensibleCode } = require('./osdmEnums.js');
const { parseEnvJson } = require('./envUtils.js');
const { processRequestedInformation } = require('./requestedInformation.js');

module.exports = {
  checkWarningsAndProblems,
  envelopeWarnings,
  providerReasons,
  postOfferResponsePreRequest,
  ensureAuthorizationOr403,
  postOfferResponse,
  selectAndSetOffer,
  validateOfferSummary,
  validatePassengers,
  validateTripsAndLegs,
  otherLegOf,
  validateOfferParts,
  validateAdmissions,
  validateReservations,
  validateAncillaries,
  getTripLegCoverage,
  handleAccommodationAndPlaceSelection,
  handleOptionalReservationSelections,
  ensureYesWhenRefundOrExchangeSelected,
  deriveOfferFlexibilityFromProducts,
  offerFlexibility,
  checkOfferCards,
  compareOfferWithoutCards,
  checkGroupOffer,
  compareGroupOfferIndividual,
  checkOfferLegClasses,
  prepareOfferRequestByTripIds,
  checkOfferPlaceSelection,
  checkOfferSearchCriteria,
  checkOfferCurrency,
  askPlacePreferences,
  askNamedPlaces,
  askNearbyPlace,
  askPlacesAfterBooking,
  placeChoiceAfterBooking,
  bookingWithoutPreferences,
  recordPlacePreferenceChecks,
  releaseReferenceBooking,
  checkOfferRequestByTripIds,
  routeAfterOfferStep,
  searchTripOffers,
};

// The envelope `warnings` member (#613 F10). From OSDM 3.5 on it is a
// WarningCollection object, `{ warnings: Warning[] }`, deprecated in 3.8; it
// used to be read as a bare array, so a conformant object was never read.
// Returns the Warning list either way; a bare array is still read, with a
// WARNING because it is not the OSDM shape.
function envelopeWarnings(jsonData, log) {
  const w = jsonData?.warnings;
  if (w && typeof w === "object" && !Array.isArray(w)) {
    return Array.isArray(w.warnings) ? w.warnings : [];
  }
  if (Array.isArray(w)) {
    if (w.length > 0 && typeof log === "function") {
      log(`[WARNING] Response envelope 'warnings' is a bare array; OSDM (3.5 and later) defines it as a WarningCollection object { "warnings": [ … ] }.`);
    }
    return w;
  }
  return [];
}

// #786: what the provider says about an answer, for a failure message: the
// first three warnings and problems as "code: detail", or that it says nothing.
function providerReasons(jsonData) {
  const problems = Array.isArray(jsonData?.problems) ? jsonData.problems : [];
  const said = [...envelopeWarnings(jsonData), ...problems]
    .filter((w) => w && typeof w === "object")
    .map((w) => [w.code, w.detail || w.title].filter((v) => v != null && v !== "").join(": "))
    .filter(Boolean);
  if (!said.length) return "The provider gives no warning or problem saying why.";
  return `The provider says: ${said.slice(0, 3).join("; ")}${said.length > 3 ? "; …" : ""}.`;
}

// Check the OSDM response ENVELOPE for warnings[] / problems[] — both can
// accompany a 2xx payload (partial success, deprecation notices, …).
//
// Log-audit round 2 rewrite — the old version had inverted semantics and a
// broken present-path:
//   - happy path emitted '[WARNING] ⚠️ No warnings found.' + '[WARNING] ⚠️
//     No problems found.' on EVERY offer/refund/exchange response —
//     warning-level lines announcing good news → ONE [DEBUG] line;
//   - warnings present printed `Warning: ${jsonData.warnings}` → the OSDM
//     Warning OBJECTS rendered as '[object Object]' (and an EMPTY warnings
//     array, being truthy, hit this path too);
//   - problems present spent 6+ lines per problem, and the 'Problems found
//     (N):' header carried no [LEVEL] tag at all.
// Now: one structured line per warning ([WARNING]) and per problem
// ([ERROR] — a problem in the envelope means part of the request was not
// honoured), each carrying the OSDM/RFC-9457 fields (code, title, status,
// detail) + pointers, so the log line is directly actionable — same spirit
// as the urn:uic:problem:OPERATION_NOT_PERMITTED decoding in
// classifySystemInfoStatus.
function checkWarningsAndProblems(jsonData) {
  try {
    const _fmt = (p) => {
      const parts = ["code", "type", "title", "status", "detail"]
        .filter((k) => p?.[k] != null && p[k] !== "")
        .map((k) => `${k}=${JSON.stringify(p[k])}`);
      return parts.length ? parts.join(", ") : JSON.stringify(p);
    };
    const warnings = envelopeWarnings(jsonData, validationLogger);
    const problems = Array.isArray(jsonData.problems) ? jsonData.problems : [];

    warnings.forEach((w, i) => {
      validationLogger(`[WARNING] ⚠️ Response envelope warning ${i + 1}/${warnings.length}: ${_fmt(w)}`);
    });
    problems.forEach((p, i) => {
      const pointerText = (x) => `${(x?.code) || "?"} @ ${(x?.requestPointer) || "?"}`;
      const ptr = Array.isArray(p.pointers) && p.pointers.length > 0
        ? ` — pointer(s): ${p.pointers.map(pointerText).join("; ")}`
        : "";
      validationLogger(`[ERROR] ⛔ Response envelope problem ${i + 1}/${problems.length}: ${_fmt(p)}${ptr}`);
    });

    // Shape conformance (log-audit round 2): OSDM structures envelope
    // warnings/problems (RFC-9457 style — a `code` from the urn:uic:*
    // catalogue + human-readable title/detail) precisely so problem
    // determination is machine-readable across vendors. Grade each
    // NON-EMPTY array once, against the same bar as the NHF Problem
    // probes (code + title/detail present); a clean envelope registers
    // no assertion at all. Vendor-specific (non-URN) codes get a
    // [WARNING] note, not a failure.
    const _shapeCheck = (kind, arr) => {
      if (arr.length === 0) return;
      const bad = [];
      arr.forEach((e, i) => {
        const isObj = e !== null && typeof e === "object";
        const hasCode = isObj && typeof e.code === "string" && e.code.trim() !== "";
        const hasText = isObj && ((typeof e.title === "string" && e.title.trim() !== "") ||
                                  (typeof e.detail === "string" && e.detail.trim() !== ""));
        if (!(hasCode && hasText)) {
          bad.push(`${kind}[${i}] missing ${[!hasCode && "code", !hasText && "title/detail"].filter(Boolean).join(" and ")}`);
        } else if (!/^urn:/i.test(e.code)) {
          validationLogger(`[WARNING] Response envelope ${kind}[${i}].code "${e.code}" is not a urn:uic:* catalogue code — vendor-specific codes weaken cross-vendor problem determination.`);
        }
      });
      try {
        const { bruTest } = require("./testCapture.js");
        bruTest(`Response envelope ${kind}[] entries are structured OSDM ${kind === "problems" ? "Problems" : "Warnings"} (code + title/detail)`, () => {
          if (bad.length > 0) {
            throw new Error(`${bad.length} of ${arr.length} entr${arr.length === 1 ? "y is" : "ies are"} non-conformant: ${bad.join("; ")}. OSDM structures envelope ${kind} (RFC-9457 style) so problem determination is machine-readable across vendors.`);
          }
        });
      } catch (_te) { /* test runner unavailable (unit harness) — the log lines above suffice */ }
    };
    _shapeCheck("warnings", warnings);
    _shapeCheck("problems", problems);

    if (warnings.length === 0 && problems.length === 0) {
      validationLogger("[DEBUG] Response envelope clean — no warnings[], no problems[].");
    }
  } catch (error) {
    validationLogger(`[WARNING] ⚠️ Error reading response envelope warnings/problems: ${error.message}`);
  }
}

function postOfferResponsePreRequest() {
  const requestName = (typeof req !== 'undefined' && typeof req.getName === 'function') ? req.getName() : '';
  console.log("[INFO] ⏩ [STEP] Executing request : " + requestName);
  validationLogger("[DEBUG] ➤ postOfferResponsePreRequest");

  if (typeof buildOfferCollectionRequest === "function") {
    buildOfferCollectionRequest();
  }

  ensureAuthorizationOr403();

  // Swagger capture and header logging are intentionally omitted/disabled here as in original (commented-out).
}

function resolveVars(str) {
  if (!str) return str;
  return String(str).replace(/\{\{([^{}]+)\}\}/g, (match, varName) => {
    const v = bru.getEnvVar(varName);
    return v == null ? '' : String(v);
  });
}

function ensureAuthorizationOr403() {
  // Log-audit round 2: this helper PREFLIGHTS the offer request — it sends
  // the same POST /offers once via bru.sendRequest purely to surface auth
  // problems with a clear message BEFORE the real call. Running it on every
  // offer was redundant and chatty (4 log lines to say "auth works"), and it
  // doubled the provider's /offers load: by this point the system-info
  // requests have already succeeded with the same token, the #204
  // token-watchdog refreshes it at every scenario start, and
  // checkAuthRejection decodes any real 401/403 downstream. Now:
  //   - SKIPPED (one [DEBUG] line) when this run already proved the token:
  //     a 200 on /versions (systemVersionCheckCompleted) or an earlier
  //     successful preflight (__authPreflightOk);
  //   - otherwise ONE [INFO] line carries the whole story on success.
  if (bru.getEnvVar('systemVersionCheckCompleted') === 'true' ||
      bru.getEnvVar('__authPreflightOk') === 'true') {
    validationLogger("[DEBUG] Authorization preflight skipped — this token already returned 200 earlier in the run.");
    return;
  }
  validationLogger("[DEBUG] ➤ ensureAuthorizationOr403 — preflighting POST /offers to surface auth problems early");

  try {
    const urlStr = (typeof req !== 'undefined' && req.getUrl) ? String(req.getUrl()) : '';
    const method = (typeof req !== 'undefined' && req.getMethod) ? req.getMethod() : 'GET';

    const resolvedUrl = resolveVars(urlStr);

    // Attempt to copy headers if possible
    let resolvedHeaders = {};
    try {
      const headersObj = req.getHeaders?.();
      // Try common shapes: getAll() or entries()
      if (headersObj && typeof headersObj.getAll === 'function') {
        const arr = headersObj.getAll();
        arr.forEach(h => {
          if (h?.key) resolvedHeaders[h.key] = resolveVars(h.value);
        });
      } else if (headersObj && typeof headersObj.entries === 'function') {
        for (const { key, value } of headersObj.entries()) {
          resolvedHeaders[key] = resolveVars(value);
        }
      }
    } catch (e) {
      // #357: validationLogger so the [DEBUG] diagnostic obeys loggingType.
      validationLogger('[DEBUG] [offers] preflight header extraction failed, continuing without headers: ' + (e?.message));
    }

    // Best-effort body resolve (may be empty in pre-request)
    let resolvedBody = null;
    try {
      const rawBody = req.getBody?.();
      const rawStr = rawBody && typeof rawBody.toString === 'function' ? rawBody.toString() : null;
      if (rawStr) {
        const replaced = resolveVars(rawStr);
        try {
          resolvedBody = JSON.parse(replaced);
        } catch {
          resolvedBody = replaced;
        }
      }
    } catch (e) {
      // #357: validationLogger so the [DEBUG] diagnostic obeys loggingType.
      validationLogger('[DEBUG] [offers] preflight body resolution failed, continuing without body: ' + (e?.message));
    }

    // Preflight call using bru.sendRequest
    if (resolvedBody) {
      resolvedHeaders['Content-Type'] = resolvedHeaders['Content-Type'] || 'application/json';
    }
    // bru.sendRequest expects headers as array of {key, value} objects (Postman/Bruno format)
    const headersArray = Object.entries(resolvedHeaders).map(([key, value]) => ({ key, value }));
    let bodyStr;
    if (resolvedBody) bodyStr = typeof resolvedBody === 'string' ? resolvedBody : JSON.stringify(resolvedBody);
    bru.sendRequest({
      url: resolvedUrl,
      method: method,
      header: headersArray,
      body: bodyStr ? { mode: 'raw', raw: bodyStr } : undefined,
      proxy: false
    }, function (err, res) {
      if (err) {
        //console.log("⛔ Authorization precheck error:", err);
        return; // do not stop run on precheck transport errors
      }
      const code = res && (res.code || res.status || res.statusCode);
      if (code === 403 || code === 401) {
        console.log("[ERROR] ⛔ Stop: Access forbidden (403) or Unauthorized (401). Check permissions. Access token could be expired.");
        console.error("[ERROR] Authorization precheck failed with " + code);
      } else if (code === 400) {
        console.log("[ERROR] ⛔ Stop: Bad Request (400). Check request parameters and body. Possibly due to authorization.");
        console.error("[ERROR] Authorization precheck failed with 400");
      } else {
        bru.setEnvVar('__authPreflightOk', 'true');
        validationLogger("[INFO] ✅ Authorization OK — preflight POST /offers accepted (HTTP " + code + "); continuing with the real request. (Checked once per run.)");
      }
    });
  } catch (e) {
    console.log("[ERROR] ensureAuthorizationOr403 error: " + (e.stack || e));
    // Don't throw here unless you want to halt the entire run
  }
}

// Function to validate offer response
function postOfferResponse(jsonData) {
  validationLogger("[DEBUG] ➤ postOfferResponse");
  if (typeof checkWarningsAndProblems === "function") {
    checkWarningsAndProblems(jsonData);
  }
  // Stop flow if offers invalid.
  // Log-audit round 2: 'No offers found or offers is not an array' conflated
  // two very different situations and said nothing about what the response
  // DID contain. Split them and summarise the whole envelope in ONE line
  // (the thrown message doubles as the test failure text):
  //   - offers[] MISSING / not an array → malformed OfferCollectionResponse
  //     envelope → provider bug, [ERROR];
  //   - offers[] EMPTY in a 200 → structurally valid per OSDM (collections
  //     may be empty), but when the response carries trips + passengers and
  //     neither a warning nor a problem explains the empty result, that is
  //     an interoperability gap worth raising with the provider — [WARNING]
  //     with the full picture. The throw still drives the existing
  //     retry-3-then-skip flow in 01. POST Get Offer.yml.
  if (!Array.isArray(jsonData.offers) || jsonData.offers.length === 0) {
    const _trips = Array.isArray(jsonData.trips) ? jsonData.trips.length : 0;
    // #355: the passenger echo location varies by provider/version —
    // 'passengers', 'anonymousPassengerSpecifications' (the field this very
    // function uses below for the requested count) or 'passengersList'.
    // Reading only jsonData.passengers showed a false "0 passenger(s)" on
    // providers that echo elsewhere; when nothing is echoed, SAY so instead
    // of claiming zero.
    const _paxArr = [jsonData.passengers, jsonData.anonymousPassengerSpecifications, jsonData.passengersList].find(Array.isArray);
    const _paxTxt = _paxArr ? `${_paxArr.length} passenger(s)` : 'no echoed passenger list';
    const _wrn   = envelopeWarnings(jsonData).length;
    const _prb   = Array.isArray(jsonData.problems)   ? jsonData.problems.length   : 0;
    // #355: no standalone validationLogger before the throw — the caller
    // re-throws inside bruTest("Offers found in response", …) whose failure
    // echo prints this exact message, so logging here showed it TWICE.
    // #786: a provider may leave offers[] out when it has none, with a
    // warning saying why: say "no offer" and quote the provider first.
    if (jsonData.offers === undefined) {
      throw new Error(`POST /offers returned no offer: the response has no 'offers' property. ${providerReasons(jsonData)}`);
    }
    if (!Array.isArray(jsonData.offers)) {
      throw new TypeError(`POST /offers response has no offers[] array (got ${typeof jsonData.offers}) — malformed OfferCollectionResponse envelope. ${providerReasons(jsonData)}`);
    }
    throw new Error(`POST /offers returned 200 with 0 offers — the response carries ${_trips} trip(s) and ${_paxTxt}, but no offer, and ` +
      ((_wrn + _prb) > 0
        ? `${_wrn} warning(s) / ${_prb} problem(s) (see envelope lines above for why)`
        : `NO warning or problem explaining why`) +
      `. An empty offers[] is structurally valid per OSDM, but a provider that finds the journey and prices nothing should explain the empty result via warnings[]/problems[] (e.g. no fares available for this date/route). OSCAR retries in case of transient inventory.`);
  }

  // Check offers exist
  test(`'offers' array exists with ${jsonData.offers.length} offer(s)`, () => {
    expect(jsonData.offers, "[ERROR] 'offers' is missing or empty").to.be.an("array").that.is.not.empty;
    validationLogger(`[INFO] 'offers' array exists with ${jsonData.offers.length} offer(s)`);
  });

  // A1/A3/A4: Per-offer mandatory field assertions (OSDM v3.8 spec)
  const requestedPassengerCount = (jsonData.anonymousPassengerSpecifications || []).length;
  jsonData.offers.forEach((offer, i) => {
    test(`offers[${i}].offerId is a non-empty string (OSDM: Offer.offerId required)`, () => {
      expect(offer.offerId).to.be.a('string').and.not.be.empty;
    });
    const createdOnDate = new Date(offer.createdOn);
    test(`offers[${i}].createdOn is a valid ISO datetime (OSDM: Offer.createdOn required)`, () => {
      expect(Number.isNaN(createdOnDate.getTime()), `createdOn is not a valid date: ${offer.createdOn}`).to.be.false;
    });
    test(`offers[${i}].passengerRefs is a non-empty array (OSDM: Offer.passengerRefs minItems:1)`, () => {
      expect(offer.passengerRefs).to.be.an('array').with.lengthOf.at.least(1);
    });
    if (requestedPassengerCount > 0) {
      test(`offers[${i}].passengerRefs count matches requested passengers (expected: ${requestedPassengerCount}, actual: ${offer.passengerRefs?.length})`, () => {
        expect(offer.passengerRefs.length).to.eql(requestedPassengerCount,
          `Expected ${requestedPassengerCount} passengerRefs, got ${offer.passengerRefs.length}`);
      });
    }
  });
  // H3: Store offer currency for cross-flow consistency checks
  const _offerCurrency = jsonData.offers[0]?.offerSummary?.minimalPrice?.currency;
  if (_offerCurrency) {
    bru.setEnvVar("offerCurrency", _offerCurrency);
    validationLogger(`[DEBUG] Stored offerCurrency: ${_offerCurrency}`);
  }

  let selectedOffer = selectAndSetOffer(jsonData);

  captureExpiredOfferDeadline(selectedOffer);

  validateOfferSummary(selectedOffer);
  validatePassengers(jsonData);
  validateOfferParts(selectedOffer);
  validateTripsAndLegs(jsonData);
  validateAdmissions(selectedOffer);
  validateReservations(selectedOffer);
  validateAncillaries(selectedOffer);

  handleAccommodationAndPlaceSelection(selectedOffer);
  handleOptionalReservationSelections(selectedOffer, jsonData.trips);

  // Expired-add-reservation-offer test (Phase 5a): capture the validUntil of
  // the SPECIFIC reservationOfferPart that the post-booking
  // `09. POST Add Reservation to Booking` will send. handleAccommodationAnd-
  // PlaceSelection just set `reservationId` to the chosen part's id; look it
  // up by id and stash its validUntil. The earliest-across-parts logic above
  // (which drives the pre-booking expiredOfferTest) is the wrong source here:
  // 09.yml sends a single reservation, not the whole offer, so we want THAT
  // specific part's deadline.
  if (selectedOffer && typeof selectedOffer === 'object') {
    const _resId = bru.getEnvVar('reservationId');
    if (_resId) {
      const _resParts = Array.isArray(selectedOffer.reservationOfferParts)
        ? selectedOffer.reservationOfferParts : [];
      const _matchPart = _resParts.find(function (p) { return p && p.id === _resId; });
      if (_matchPart?.validUntil) {
        bru.setEnvVar('addReservationOfferValidUntil', String(_matchPart.validUntil));
        bru.setEnvVar('addReservationOfferValidUntilSource',
          `selectedOffer.reservationOfferParts[id=${_resId}].validUntil`);
        validationLogger(`[INFO] Captured add-reservation offer-part validUntil = ${_matchPart.validUntil} — drives the #expiredAddReservationOfferTest deadline if enabled.`);
      } else {
        bru.setEnvVar('addReservationOfferValidUntil', '');
        bru.setEnvVar('addReservationOfferValidUntilSource', '');
      }
    }
  }

  ensureYesWhenRefundOrExchangeSelected(selectedOffer);

  // #393: the verdict above covers only the SELECTED offer — sweep the whole
  // response for flag-vs-schedule contradictions (one summary line, R9).
  sweepCatalogFlagVsSchedule(jsonData.offers);
}

// OSDM Flexibility ordered least → most restrictive. An offer's overall
// flexibility is the MOST RESTRICTIVE of its products: a multi-leg journey is
// only as flexible as its least-flexible leg (e.g. TGV FULL_FLEXIBLE + TER
// NON_FLEXIBLE → the offer is NON_FLEXIBLE). Unknown/vendor-specific values are
// ignored for the aggregation. (#223)
const FLEX_ORDER = ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'];

function deriveOfferFlexibilityFromProducts(offer) {
  const flits = ((offer?.products) || []).map(p => p?.flexibility).filter(Boolean);
  let result;
  flits.forEach(f => {
    const rank = FLEX_ORDER.indexOf(f);
    if (rank === -1) return; // unknown value → ignore for aggregation
    if (result === undefined || rank > FLEX_ORDER.indexOf(result)) result = f;
  });
  return result;
}

// Overall flexibility of an offer: the provider's offerSummary.overallFlexibility
// when present (it is OPTIONAL in OSDM), otherwise derived from the offer's
// products (#223 — providers that omit offerSummary). Returns undefined if
// neither is available.
function offerFlexibility(offer) {
  return (offer?.offerSummary?.overallFlexibility)
    || deriveOfferFlexibilityFromProducts(offer);
}

// select and set offer based on criteria
// #expired-offer: stash the BOOKABILITY deadline of the SELECTED offer for
// the expiredOfferTest (read by 02. POST Create Booking's before-request).
//
// #385 — two clocks, take the EARLIEST:
//   - part-level validUntil (OSDM AbstractOfferPart.validUntil: "Time until
//     the offer can be used, e.g. travel"). Bileto-style providers put their
//     booking-hold window here (~15 min); OBB puts TRAVEL validity here
//     (trip arrival — days away), which made the test wait on the wrong clock.
//   - Offer.preBookableUntil ("time until the offer can be pre-booked,
//     however its availability is not guaranteed") — the spec's purchasability
//     gate, which is what an expired-OFFER test is really about.
// Earliest, not latest: a SINGLE expired clock is enough for the booking to
// be rejectable.
function captureExpiredOfferDeadline(selectedOffer) {
  if (!selectedOffer || typeof selectedOffer !== 'object') return;
  const _partLists = [
    'admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts',
    'fareAdmissionOfferParts', 'fareReservationOfferParts', 'fareAncillaryOfferParts',
  ];
  let _earliestMs = Infinity;
  let _earliestRaw = null;
  let _earliestSrc = null;
  _partLists.forEach(function (pt) {
    const parts = Array.isArray(selectedOffer[pt]) ? selectedOffer[pt] : [];
    parts.forEach(function (p, i) {
      if (p?.validUntil) {
        const t = new Date(p.validUntil).getTime();
        if (!Number.isNaN(t) && t < _earliestMs) {
          _earliestMs  = t;
          _earliestRaw = p.validUntil;
          _earliestSrc = `selectedOffer.${pt}[${i}].validUntil`;
        }
      }
    });
  });
  if (selectedOffer.preBookableUntil) {
    const _pbu = new Date(selectedOffer.preBookableUntil).getTime();
    if (!Number.isNaN(_pbu) && _pbu < _earliestMs) {
      _earliestMs  = _pbu;
      _earliestRaw = selectedOffer.preBookableUntil;
      _earliestSrc = 'selectedOffer.preBookableUntil';
    }
  }
  if (_earliestRaw) {
    bru.setEnvVar('offerValidUntil', String(_earliestRaw));
    bru.setEnvVar('offerValidUntilSource', String(_earliestSrc));
    validationLogger(`[INFO] Expired-offer deadline = ${_earliestRaw} (${_earliestSrc}; earliest of part validUntil and offer.preBookableUntil) — drives the #expiredOfferTest if enabled.`);
  } else {
    bru.setEnvVar('offerValidUntil', '');
    bru.setEnvVar('offerValidUntilSource', '');
    validationLogger('[DEBUG] Selected offer has no part validUntil and no preBookableUntil — #expiredOfferTest (if on) will skip with a WARNING.');
  }
}

// ── The train of a search (#722) ─────────────────────────────────────────────

// Whether this offer answer is the outbound of a one-way SEARCH trip (not
// offers by trip id, not a return).
function oneWaySearch() {
  return bru.getEnvVar("TripType") === "SEARCH"
    && String(bru.getEnvVar("offersByTripIds")) !== "true"
    && !bru.getEnvVar("returnInboundDate");
}

/**
 * The offers of `body` on the trip a one-way search was for; every offer for
 * any other answer. With `log`, says how the trip was chosen and records the
 * train filter's checks when the filter was sent.
 */
function searchTripOffers(body, { log = false } = {}) {
  const all = Array.isArray(body?.offers) ? body.offers : [];
  if (!oneWaySearch()) return all;
  const { offersOnSearchTrip, checkTrainFilter } = require('./searchTrain.js');
  const vehicleNumber = bru.getEnvVar("tripVehicleNumber");
  if (log && String(bru.getEnvVar("__searchTrainFilter")) === "true") recordChecks(checkTrainFilter(body, vehicleNumber));
  const criteria = parseEnvJson("offerTripSearchCriteria", {}) || {};
  const { offers, lines } = offersOnSearchTrip(body, { vehicleNumber, departureTime: criteria.departureTime });
  if (log) lines.forEach((line) => validationLogger(line));
  return offers;
}

function validateSelectedOfferAdmission(selOffer, scenarioTypeStr, overallFlexibility) {
  if (!selOffer?.admissionOfferParts) return;

  // Do nothing if not FULL_FLEXIBLE or SEMI_FLEXIBLE
  if (overallFlexibility !== "FULL_FLEXIBLE" && overallFlexibility !== "SEMI_FLEXIBLE") {
    validationLogger(`[DEBUG] overallFlexibility is '${overallFlexibility}' - skipping admissionOfferParts validation`);
    return;
  }

  function validateField(field, type) {
    // #387: context only — the scenario-vs-offer verdict row is OWNED by
    // ensureYesWhenRefundOrExchangeSelected. This used to be the FIRST of
    // THREE rows registered for the same root cause (a REFUND/EXCHANGE
    // scenario on a part that does not permit it).
    const parts = selOffer.admissionOfferParts;
    const allYes = parts.every(p => p[field] === "YES");
    validationLogger(`[DEBUG] Selected offer admission ${type} flags (FULL/SEMI_FLEXIBLE context): [${parts.map(p => p[field]).join(", ")}]${allYes ? "" : " — not all YES; see the scenario-vs-offer verdict row."}`);
  }

  if (scenarioTypeStr?.includes("EXCHANGE")) validateField("exchangeable", "exchangeable");
  if (scenarioTypeStr?.includes("REFUND")) validateField("refundable", "refundable");
}

function selectAndSetOffer(jsonData) {
  validationLogger("[DEBUG] ➤ selectAndSetOffer");

  // #379: 🧭 one orientation line over the WHOLE offer set BEFORE any filter —
  // the certifier reading the log sees at a glance what the provider returned
  // (accommodation families, their subtypes, how many offers carry each).
  (function orientOfferSet(offers) {
    if (!Array.isArray(offers) || offers.length === 0) return;
    const fam = {};
    let noRes = 0;
    offers.forEach((o) => {
      const parts = (o?.reservationOfferParts) || [];
      if (parts.length === 0) { noRes++; return; }
      parts.forEach((p) => ((p?.availablePlaces) || []).forEach((pl) => {
        const t = pl?.accommodationType;
        if (!t) return;
        if (!fam[t]) fam[t] = { offers: new Set(), subs: new Set() };
        fam[t].offers.add(o.offerId);
        if (pl.accommodationSubType) fam[t].subs.add(pl.accommodationSubType);
      }));
    });
    const subtypesOf = (t) => (fam[t].subs.size ? ` (subtypes: ${[...fam[t].subs].join(", ")})` : "");
    const famLine = Object.keys(fam)
      .map((t) => `${t} ×${fam[t].offers.size} offer(s)${subtypesOf(t)}`)
      .join("; ");
    const famNote = famLine ? ` — reservation accommodations: ${famLine}` : "";
    const noResNote = noRes > 0 ? `; ${noRes} offer(s) without reservation parts` : "";
    console.log(`[INFO] 🧭 Offer set: ${offers.length} offer(s)${famNote}${noResNote}.`);
  })(jsonData?.offers);

  const desiredFlexibility = bru.getEnvVar("desiredFlexibility");
  const accommodationSelection = bru.getEnvVar("accommodationSelection");
  const scenarioType = bru.getEnvVar("scenarioType");

  // match accommodation type in reservationOfferParts
  function matchesAccommodation(offer, expectedType, requireAll = false) {
    return (offer.reservationOfferParts || []).some(part => {
      if (!Array.isArray(part.availablePlaces)) return true;

      return requireAll
        ? part.availablePlaces.every(place => place.accommodationType === expectedType)
        : part.availablePlaces.some(place => place.accommodationType === expectedType);
    });
  }

  // #722: a one-way search asks by place and time; keep the offers of the trip
  // it was for (the Test Data train, else the first at the time asked).
  const onSearchTrip = searchTripOffers(jsonData, { log: true });
  let filteredOffers = onSearchTrip;

  // Different accommodation selection handling
  if (accommodationSelection === "SEAT") {
    validationLogger("[DEBUG] Filter: only SEAT (all places must be SEAT)");
    filteredOffers = filteredOffers.filter(o => matchesAccommodation(o, "SEAT", true));
  }
  else if (accommodationSelection === "COUCHETTE") {
    validationLogger("[DEBUG] Filter: COUCHETTE (at least 1 place)");
    filteredOffers = filteredOffers.filter(o => matchesAccommodation(o, "COUCHETTE"));
  }
  else if (accommodationSelection === "BERTH") {
    validationLogger("[DEBUG] Filter: BERTH (at least 1 place)");
    filteredOffers = filteredOffers.filter(o => matchesAccommodation(o, "BERTH"));
  }
  else {
    validationLogger("[DEBUG] No accommodation filter applied");
  }

  // #598: the product the scenario expects. No offer holding it fails the
  // scenario, which the offer step then stops (__productNotOffered).
  // #599: with expectedProductAbsent, no offer may hold it (a group the
  // product's rules exclude); the scenario then ends there either way.
  const expectedProduct = bru.getEnvVar("expectedProduct");
  if (expectedProduct) {
    const { offersWithProduct, offeredProducts } = require('./products.js');
    const holding = offersWithProduct(filteredOffers, expectedProduct);
    if (String(bru.getEnvVar("expectedProductAbsent")) === "true") {
      test(`Offer: no offer holds the product "${expectedProduct}", as the scenario expects — ${holding.length} offer(s)`, () => {
        if (holding.length > 0) throw new Error(`offered by: [${holding.map((o) => o.offerId).join(", ")}]`);
      });
      bru.setEnvVar("__productNotOffered", "true");
    } else {
      test(`Offer: an offer holds the expected product "${expectedProduct}" — ${holding.length} offer(s)`, () => {
        if (holding.length === 0) throw new Error(`no offer holds it; offered: [${offeredProducts(jsonData.offers).join(", ")}]`);
      });
      if (holding.length === 0) bru.setEnvVar("__productNotOffered", "true");
      else filteredOffers = holding;
    }
  }

  // #600: the class the scenario expects on each leg. #762: no offer giving
  // them is a warning, not a failure: a provider answers with what it has,
  // and selling that offer or not is the retailer's choice. The sale goes on
  // with the offer chosen as usual (__legClassesNotOffered), and the booking
  // is then held to the classes of that offer (checkOfferLegClasses).
  const legTravelClasses = parseEnvJson("legTravelClasses", null);
  if (Array.isArray(legTravelClasses)) {
    const { offerMatches, offeredCombinations } = require('./legClasses.js');
    const matching = filteredOffers.filter((o) => offerMatches(o, jsonData.trips, legTravelClasses));
    if (matching.length === 0) {
      validationLogger(`[WARNING] Offer: no offer gives each leg its class [${legTravelClasses.join(", ")}] — classes per leg offered: ${offeredCombinations(jsonData.offers, jsonData.trips).join("; ") || "none"}. The class per leg is not tested; the sale goes on with the offer chosen.`);
      bru.setEnvVar("__legClassesNotOffered", "true");
    } else {
      test(`Offer: an offer gives each leg its class [${legTravelClasses.join(", ")}] — ${matching.length} offer(s)`, () => {});
      filteredOffers = matching;
    }
  }

  // Apply flexibility filter if specified. offerSummary is OPTIONAL in OSDM, so
  // when a provider omits it we derive the offer's overall flexibility from its
  // products (most restrictive wins) instead of dropping every offer. (#223)
  if (desiredFlexibility) {
    validationLogger(`[DEBUG] Applying flexibility filter: ${desiredFlexibility}`);
    if (!filteredOffers.some(o => o.offerSummary?.overallFlexibility)) {
      validationLogger(`[DEBUG] No offerSummary.overallFlexibility on these offers — deriving flexibility from offer products (most restrictive leg wins).`);
    }
    filteredOffers = filteredOffers.filter(o => offerFlexibility(o) === desiredFlexibility);
  }

  // Select the first matching offer or default to the first offer
  const selectedOffer = filteredOffers[0] || onSearchTrip[0] || jsonData.offers[0];

  validationLogger(`[DEBUG] Selected Offer ID: ${selectedOffer.offerId}`);
  // Per-part summary first, so a certifier reading the log can tell at a glance
  // which part(s) carry which flags. An Offer has no top-level refundable /
  // exchangeable — only its parts do, and a "refundable: NO" on an ancillary
  // (e.g. luggage fee) is often misread as the whole offer being non-refundable.
  // #351: every line carries its own [INFO] tag — the runner stores each
  // stdout line separately, and untagged lines would be level-guessed.
  const _partSummary = (parts, label) =>
    (parts || []).map((p, i) =>
      `[INFO]   ${label}[${i}] type=${p.type || p.objectType || '?'} refundable=${p.refundable} exchangeable=${p.exchangeable}`
    ).join('\n');
  const _admissionLines   = _partSummary(selectedOffer.admissionOfferParts,   'admission');
  const _reservationLines = _partSummary(selectedOffer.reservationOfferParts, 'reservation');
  const _ancillaryLines   = _partSummary(selectedOffer.ancillaryOfferParts,   'ancillary');
  console.log(`[INFO] 🔍 Selected Offer: ${selectedOffer.offerId}`);
  if (_admissionLines)   console.log(_admissionLines);
  if (_reservationLines) console.log(_reservationLines);
  if (_ancillaryLines)   console.log(_ancillaryLines);
  // #351 (R6 — never replay the payload in the log): the full Selected Offer
  // object dump is gone. Only its FIRST line carried [DEBUG]; the ~30
  // continuation lines were level-guessed as info and polluted the tester's
  // INFO view. The complete offer is one click away in the run page's
  // HTTP-traffic viewer (and in the report); the [INFO] id + per-part scope
  // lines above are the log-side summary.
  console.log("[INFO] 🔍 Selected Offer:", selectedOffer);

  // Store selected offer and related info in environment
  bru.setEnvVar("offer", selectedOffer);
  bru.setEnvVar("offerId", selectedOffer.offerId);
  bru.setEnvVar("offers", jsonData.offers);

  // #379: the selected offer's coverage must reference this response's
  // trips/legs (R8 — silent when OK, one decoded failure when broken).
  assertOfferCoverageIntegrity(selectedOffer, jsonData);

  if (desiredFlexibility) {
    const _summaryFlex = selectedOffer.offerSummary?.overallFlexibility;
    const actual = offerFlexibility(selectedOffer);
    if (!_summaryFlex) {
      validationLogger(`[DEBUG] Selected offer has no offerSummary — overall flexibility derived from products [${(selectedOffer.products || []).map(p => p.flexibility).filter(Boolean).join(', ')}] → most restrictive = ${actual}`);
    }
    test(`Selected offer has expected flexibility - expected: ${desiredFlexibility}, actual: ${actual}${_summaryFlex ? '' : ' (derived from products; no offerSummary)'}`, () => {
      validationLogger(`[DEBUG] Selected offer has expected flexibility - expected: ${desiredFlexibility}, actual: ${actual}`);
      expect(actual).to.eql(desiredFlexibility);
    });

    const matchingProducts = (selectedOffer.products || []).filter(p => p.flexibility === desiredFlexibility);
    test(`At least one matching product has the expected flexibility - count : ${matchingProducts.length}`, () => {
      validationLogger(`[DEBUG] At least one matching product has the expected flexibility - count : ${matchingProducts.length}`);
      expect(matchingProducts.length).to.be.above(0);
    });
  }

  validateSelectedOfferAdmission(selectedOffer, scenarioType, selectedOffer.offerSummary?.overallFlexibility);

  return selectedOffer;
}

// Offer summary validation
function validateOfferSummary(selectedOffer) {
  validationLogger("[DEBUG] ➤ validateOfferSummary");
  const offerSummary = selectedOffer.offerSummary || {};
  const mini = offerSummary.minimalPrice;
  const minimalPrice = offerSummary.minimalPrice?.amount;
  const overallFlexibility = offerSummary.overallFlexibility;
  const overallServiceClass = offerSummary.overallServiceClass?.name;
  const overallTravelClass = offerSummary.overallTravelClass;

  // Minimal price validation
  test(`Offer summary - minimalPrice structure exists, is a number >= 0 : ${minimalPrice}`, function () {
    validationLogger(`[DEBUG] Offer summary - minimalPrice structure exists, is a number >= 0 : ${minimalPrice}`);
    expect(minimalPrice).to.exist.and.is.a("number");
    expect(minimalPrice).to.be.at.least(0);
  });

  // minimalOriginalPrice structure (optional field)
  const minimalOriginalPrice = offerSummary.minimalOriginalPrice;
  if (minimalOriginalPrice) {
    test(`Offer summary - minimalOriginalPrice structure is valid`, function () {
      validationLogger(`[DEBUG] minimalOriginalPrice: ${minimalOriginalPrice.amount} ${minimalOriginalPrice.currency}`);
      expect(minimalOriginalPrice.amount, "minimalOriginalPrice.amount should be a number").to.be.a("number");
      expect(minimalOriginalPrice.amount, "minimalOriginalPrice.amount should be >= 0").to.be.at.least(0);
      expect(minimalOriginalPrice.currency, "minimalOriginalPrice.currency should exist").to.exist.and.be.a("string");
    });
  }

  // minimalPrice has a currency. `scale` is optional in OSDM (Price.scale,
  // default 2): its absence is logged, not failed (#613 F11).
  test(`Price fields exist (currency) in minimalPrice`, () => {
    expect(mini, 'minimalPrice is missing').to.exist;
    expect(mini.currency, 'minimalPrice.currency missing').to.exist;
  });
  if (mini && mini.scale == null) {
    validationLogger(`[INFO] minimalPrice.scale is absent: optional in OSDM, the default scale 2 applies.`);
  }

  // Overall flexibility validation
  bru.setEnvVar("overallFlexibility", overallFlexibility);
  test(`Offer summary - overallFlexibility is defined - overallFlexibility: ${overallFlexibility}`, function () {
    validationLogger(`[DEBUG] Offer summary - overallFlexibility is defined - overallFlexibility: ${overallFlexibility}`);
    expect(overallFlexibility).to.be.a("string");
  });

  // overallServiceClass.type is a known value
  const overallServiceClassType = offerSummary.overallServiceClass?.type;
  if (overallServiceClassType) {
  test(`Offer summary - overallServiceClass is defined - overallServiceClass: ${overallServiceClass}`, function () {
    validationLogger(`[DEBUG] Offer summary - overallServiceClass is defined - overallServiceClass: ${overallServiceClass}`);
      expect(overallServiceClassType).to.be.oneOf(["BEST", "HIGH", "STANDARD", "BASIC", "ANY_CLASS"]);
    });
  }

  // Overall travel class validation
  if (overallTravelClass) {
    test(`Offer summary - overallTravelClass is defined - overallTravelClass: ${overallTravelClass}`, function () {
      validationLogger(`[DEBUG] Offer summary - overallTravelClass is defined - overallTravelClass: ${overallTravelClass}`);
      expect(overallTravelClass).to.be.a("string");
    });
  } else {
    validationLogger(`[DEBUG] overallTravelClass is not present in offer summary → test skipped`);
  }

  // overallFlexibility is a known OSDM value
  test(`Offer summary - overallFlexibility is a valid OSDM value: ${overallFlexibility}`, function () {
    validationLogger(`[DEBUG] Offer summary - overallFlexibility valid value check: ${overallFlexibility}`);
    expect(overallFlexibility).to.be.oneOf(["FULL_FLEXIBLE", "SEMI_FLEXIBLE", "NON_FLEXIBLE"]);
  });

  // overallAccommodationType is a known value (optional field)
  const overallAccommodationType = offerSummary.overallAccommodationType;
  if (overallAccommodationType) {
    test(`Offer summary - overallAccommodationType is a valid value: ${overallAccommodationType}`, function () {
      validationLogger(`[DEBUG] Offer summary - overallAccommodationType: ${overallAccommodationType}`);
      expect(overallAccommodationType).to.be.oneOf(["SEAT", "COUCHETTE", "BERTH", "VEHICLE", "STORAGE"]);
    });
  } else {
    validationLogger(`[DEBUG] overallAccommodationType is not present in offer summary → test skipped`);
  }

  // preBookableUntil must be defined and in the future
  const preBookableUntil = selectedOffer.preBookableUntil;
  if (preBookableUntil) {
    const preBookableDate = new Date(preBookableUntil);
    test(`Offer preBookableUntil is a valid date in the future - preBookableUntil: ${preBookableUntil}`, function () {
      validationLogger(`[DEBUG] preBookableUntil: ${preBookableUntil}`);
      expect(!Number.isNaN(preBookableDate.getTime()), "preBookableUntil should be a valid ISO date").to.be.true;
      expect(preBookableDate.getTime(), "preBookableUntil should be in the future").to.be.above(Date.now());
    });
  } else {
    validationLogger(`[DEBUG] preBookableUntil is not present → test skipped`);
  }
}

// Passengers validation
function validatePassengers(jsonData) {
  validationLogger("[DEBUG] ➤ validatePassengers");
  const passengers = jsonData.anonymousPassengerSpecifications || [];
  bru.setEnvVar("passengerCount", passengers.length);

  test(`Passengers are defined - length: ${passengers.length}`, function () {
    validationLogger(`[DEBUG] Passengers are defined - length: ${passengers.length}`);
    expect(passengers.length).to.be.above(0);
  });

  passengers.forEach((p, i) => {
    // externalRef is defined
    test(`Passenger ${i + 1} externalRef is defined - externalRef: ${p.externalRef}`, function () {
      validationLogger(`[DEBUG] Passenger ${i + 1} externalRef: ${p.externalRef}`);
      expect(p.externalRef, "externalRef should exist").to.exist.and.be.a("string");
    });

    // type: an extensible OSDM code list (#613 F4). FAIL only when missing or
    // not text; a value outside the listed ones is a WARNING.
    checkExtensibleCode({ test, expect, log: validationLogger },
      `Passenger ${i + 1} type`, p.type, OSDM_PASSENGER_TYPES, 'PassengerType');

    // dateOfBirth is a valid date in the past (if present)
    if (p.dateOfBirth) {
      const dob = new Date(p.dateOfBirth);
      test(`Passenger ${i + 1} dateOfBirth is a valid date in the past - dateOfBirth: ${p.dateOfBirth}`, function () {
        validationLogger(`[DEBUG] Passenger ${i + 1} dateOfBirth: ${p.dateOfBirth}`);
        expect(!Number.isNaN(dob.getTime()), "dateOfBirth should be a valid ISO date").to.be.true;
        expect(dob.getTime(), "dateOfBirth should be in the past").to.be.below(Date.now());
      });
    } else {
      validationLogger(`[DEBUG] Passenger ${i + 1} no dateOfBirth → test skipped`);
    }

    // #613 F15: the old "reduction cards" check read appliedReductionCardTypes,
    // which AnonymousPassengerSpecification does not have, and defaulted it to
    // [] — it could never fail. Reduction cards are checked by #597.
  });
}

// Trips & Legs validation
// #709: a leg that is not a timed leg, as { kind, from, to } (the stop place
// references of its start and end, undefined when absent); null for a timed
// leg, or a leg of no kind OSDM names (both are checked as timed legs).
function otherLegOf(leg) {
  if (!leg || leg.timedLeg) return null;
  const kind = ['transfer', 'continuous'].find((k) => leg[`${k}Leg`] && typeof leg[`${k}Leg`] === 'object');
  if (!kind) return null;
  const place = (p) => p?.stopPlaceRef ?? p?.stopPlaceName ?? p?.name ?? undefined;
  const part = leg[`${kind}Leg`];
  return { kind, from: place(part.start), to: place(part.end) };
}

function validateTripsAndLegs(jsonData) {
  validationLogger("[DEBUG] ➤ validateTripsAndLegs");
  const trips = jsonData.trips || [];

  test(`Trips are defined - length: ${trips.length}`, function () {
    validationLogger(`[DEBUG] Trips are defined - length: ${trips.length}`);
    expect(trips.length).to.be.above(0);
  });

  // Capture trip ids and compare to coveredTripId
  const tripIds = (jsonData.trips || []).map(trip => trip.id).filter(id => id !== undefined && id !== null);
  validationLogger(`[DEBUG] tripIds found: ${JSON.stringify(tripIds)}`);
  const coveredTripId = bru.getEnvVar("coveredTripId");
  if (coveredTripId) {
    test(`selectedOffer.tripCoverage.coveredTripId (${coveredTripId}) is part of Trip ids`, function () {
      validationLogger(`[DEBUG] Checking coveredTripId ${coveredTripId} is in tripIds: ${JSON.stringify(tripIds)}`);
      expect(tripIds).to.include(coveredTripId);
    });
  } else {
    validationLogger(`[DEBUG] coveredTripId is not set → tripCoverage test skipped`);
  }

  trips.forEach((trip, tripIndex) => {
    const legs = trip.legs || [];

    // A7: startTime must be strictly before endTime (OSDM: Trip.startTime/endTime required)
    const tripStart = new Date(trip.startTime);
    const tripEnd   = new Date(trip.endTime);
    if (!Number.isNaN(tripStart.getTime()) && !Number.isNaN(tripEnd.getTime())) {
      test(`Trip ${tripIndex + 1} startTime is before endTime (OSDM: temporal order)`, () => {
        expect(tripStart.getTime()).to.be.below(tripEnd.getTime(),
          `Trip startTime (${trip.startTime}) is not before endTime (${trip.endTime})`);
        validationLogger(`[DEBUG] Trip ${tripIndex + 1}: startTime=${trip.startTime}, endTime=${trip.endTime} ✓`);
      });
    } else {
      validationLogger(`[WARNING] Trip ${tripIndex + 1}: startTime or endTime is not a valid date → A7 test skipped`);
    }

    // direction is optional in OSDM (Trip.direction, with a default); when
    // present it is one of the two values (#613 F11).
    if (trip.direction != null) {
      test(`Trip ${tripIndex + 1} direction is a known value - direction: ${trip.direction}`, function () {
        validationLogger(`[DEBUG] Trip ${tripIndex + 1} direction: ${trip.direction}`);
        expect(trip.direction).to.be.oneOf(["OUT_BOUND", "IN_BOUND"]);
      });
    } else {
      validationLogger(`[DEBUG] Trip ${tripIndex + 1} direction absent (optional in OSDM) → check skipped`);
    }

    if (legs.length > 0) {
      test(`Trip ${tripIndex + 1} has legs - length: ${legs.length}`, function () {
        validationLogger(`[DEBUG] Trip ${tripIndex + 1} has legs - length: ${legs.length}`);
        expect(legs.length).to.be.above(0);
      });
    } else {
      validationLogger(`[DEBUG] Trip ${tripIndex + 1} has no legs (provider may not return legs) → test skipped`);
    }

    legs.forEach((leg, legIndex) => {
      // #709: a transfer or continuous leg (a change of platform, a walk) has
      // no train: its start and end are checked instead.
      const moving = otherLegOf(leg);
      if (moving) {
        test(`Trip ${tripIndex + 1} Leg ${legIndex + 1} is a ${moving.kind} leg with a start and an end - ${moving.from} → ${moving.to}`, function () {
          expect(moving.from, `${moving.kind}Leg.start`).to.not.be.undefined;
          expect(moving.to, `${moving.kind}Leg.end`).to.not.be.undefined;
        });
        return;
      }
      const trainId = leg.timedLeg?.service?.vehicleNumbers?.[0];
      const origin = leg.timedLeg?.start?.stopPlaceName;
      const destination = leg.timedLeg?.end?.stopPlaceName;

      test(`Trip ${tripIndex + 1} Leg ${legIndex + 1} has TrainID, Origin & Destination - TrainID: ${trainId}, Origin: ${origin}, Destination: ${destination}`, function () {
        validationLogger(`[DEBUG] Trip ${tripIndex + 1} Leg ${legIndex + 1} has TrainID, Origin & Destination - TrainID: ${trainId}, Origin: ${origin}, Destination: ${destination}`);
        expect(trainId).to.not.be.undefined;
        expect(origin).to.not.be.undefined;
        expect(destination).to.not.be.undefined;
      });
    });
  });
}

// Offer Parts validation
function logMinimalBelowAllParts(minimalPrice, sumPartsPrice) {
  if (minimalPrice < sumPartsPrice) {
    validationLogger(`[INFO] Offer minimalPrice (${minimalPrice}) is below the sum of all listed parts (${sumPartsPrice}): expected when some reservations or ancillaries are optional.`);
  }
}

function checkOverallFlexibility(selectedOffer) {
  // Flexibility of the summary (#223, #650). OSDM 3.8 OfferSummary: the
  // overall values "best represent this offer … this does not imply that these
  // values exactly apply to all parts of the offer". So the summary need not be
  // the most restrictive product (a FULL_FLEXIBLE admission with a
  // NON_FLEXIBLE reservation may be summed up FULL_FLEXIBLE). It should be the
  // flexibility of one of the products: that passes as a check; one no product
  // has is a warning line; a difference from the most restrictive one is
  // information. When offerSummary is absent (optional) the derived value is
  // logged.
  const productFlex = Array.from(new Set((selectedOffer?.products || []).map(p => p.flexibility).filter(Boolean)));
  const derivedFlex = deriveOfferFlexibilityFromProducts(selectedOffer);
  const overallFlex = selectedOffer.offerSummary?.overallFlexibility;

  if (overallFlex) {
    validationLogger(`[DEBUG] productFlex: ${productFlex.join(", ")}, derived (most restrictive): ${derivedFlex}`);
    if (productFlex.length === 0 || productFlex.includes(overallFlex)) {
      test(`Offer overallFlexibility consistency - overallFlex: ${overallFlex}, derived (most restrictive): ${derivedFlex}`, () => {
        validationLogger(`[DEBUG] overallFlexibility ${overallFlex} is the flexibility of a product of the offer`);
      });
      if (derivedFlex && overallFlex !== derivedFlex) {
        validationLogger(`[INFO] offerSummary.overallFlexibility is "${overallFlex}", the most restrictive product is "${derivedFlex}" (product flexibilities: ${productFlex.join(", ")}). OSDM lets the summary give the value that best represents the offer.`);
      }
    } else {
      validationLogger(`[WARNING] Offer overallFlexibility consistency - offerSummary.overallFlexibility says "${overallFlex}", which none of the offer's products has (product flexibilities: ${productFlex.join(", ")}).`);
    }
  } else {
    validationLogger(`[INFO] offerSummary absent — overall flexibility derived from products [${productFlex.join(", ")}] → most restrictive = ${derivedFlex}`);
  }
}

function validateOfferParts(selectedOffer) {
  validationLogger("[DEBUG] ➤ validateOfferParts");

  const admissionParts = selectedOffer.admissionOfferParts || [];
  const reservationParts = selectedOffer.reservationOfferParts || [];
  const ancillaryParts = selectedOffer.ancillaryOfferParts || [];

  const sumPrice = parts => parts.reduce((sum, p) => sum + (p.price?.amount || 0), 0);

  // Collect all referenced ancillary IDs from admissionOfferParts
  const referencedAncillaryIds = new Set();
  admissionParts.forEach(admissionPart => {
    const ancillaries = admissionPart.ancillaries || [];
    ancillaries.forEach(ancillary => {
      const ancillaryRefs = ancillary.ancillaryGroup?.ancillaryRefs || [];
      ancillaryRefs.forEach(ref => {
        if (ref.id) {
          referencedAncillaryIds.add(ref.id);
        }
      });
    });
  });

  // Filter ancillaryParts to only those that are referenced
  const referencedAncillaryParts = ancillaryParts.filter(part => referencedAncillaryIds.has(part.id));

  // Stock referenced ancillary IDs in environment
  bru.setEnvVar("referencedAncillaryIds", JSON.stringify([...referencedAncillaryIds]));

  const admissionPrice = sumPrice(admissionParts);
  const reservationPrice = sumPrice(reservationParts);
  const ancillaryPrice = sumPrice(referencedAncillaryParts);

  validationLogger(`[DEBUG] Admission parts price: ${admissionPrice}`);
  validationLogger(`[DEBUG] Reservation parts price: ${reservationPrice}`);
  validationLogger(`[DEBUG] Ancillary parts price: ${ancillaryPrice}`);

  const offerParts = [...admissionParts, ...reservationParts, ...referencedAncillaryParts];

  const minimalPrice = selectedOffer.offerSummary?.minimalPrice?.amount || 0;
  bru.setEnvVar("minimalPrice", minimalPrice);
  bru.setEnvVar("admissionPartsPrice", admissionPrice);
  bru.setEnvVar("reservationPartsPrice", reservationPrice);
  bru.setEnvVar("ancillaryPartsPrice", ancillaryPrice);

  const sumPartsPrice = sumPrice(offerParts);

  // #613 F11: the minimal price is what the offer costs at least, so it covers
  // the admissions. It used to be compared with the sum of every part, which
  // adds optional reservations and ancillaries and failed conformant offers.
  // OSDM gives no formula beyond that, so the full sum is only logged.
  test(`Offer minimalPrice >= sum of admission parts price - minimalPrice: ${minimalPrice}, admissions: ${admissionPrice}`, function () {
    validationLogger(`[DEBUG] Offer minimalPrice ${minimalPrice}; admissions ${admissionPrice}; all listed parts ${sumPartsPrice}`);
    expect(minimalPrice).to.be.at.least(admissionPrice);
  });
  logMinimalBelowAllParts(minimalPrice, sumPartsPrice);

  checkOverallFlexibility(selectedOffer);

  // capture coveredTripId if value exists
  const coveredTripId = selectedOffer.tripCoverage?.coveredTripId;
  if (coveredTripId !== undefined && coveredTripId !== null) {
    validationLogger(`[DEBUG] Covered Trip ID: ${coveredTripId}`);
    bru.setEnvVar("coveredTripId", coveredTripId);
  }

  // #251: the offer→trip link. `tripCoverage` is OPTIONAL on an offer part, but
  // when present OSDM requires `coveredTripId` (TripCoverage.required=[coveredTripId]).
  // Assert it when tripCoverage exists; WARN (not fail) when the offer carries no
  // tripCoverage at all, since clients then have to derive the link from offerParts
  // (the spec recommends returning coveredTripId at offer level for a single, optimal link).
  if (selectedOffer.tripCoverage) {
    test(`Offer tripCoverage.coveredTripId is present (OSDM: TripCoverage.coveredTripId required)`, () => {
      expect(selectedOffer.tripCoverage.coveredTripId, "tripCoverage present but coveredTripId missing/empty")
        .to.be.a("string").and.not.be.empty;
    });
  } else {
    validationLogger(`[WARNING] Offer has no tripCoverage — no offer-level coveredTripId; clients must derive the offer↔trip link from offerParts (recommended: return tripCoverage.coveredTripId). (#251)`);
  }

  // Validate tripCoverage.coveredLegIds are non-empty strings (if present)
  const coveredLegIds = selectedOffer.tripCoverage?.coveredLegIds || [];
  if (coveredLegIds.length > 0) {
    test(`Offer tripCoverage.coveredLegIds are non-empty strings - count: ${coveredLegIds.length}`, function () {
      validationLogger(`[DEBUG] tripCoverage.coveredLegIds: ${JSON.stringify(coveredLegIds)}`);
      coveredLegIds.forEach((legId, idx) => {
        expect(legId, `coveredLegIds[${idx}] should be a string`).to.be.a("string");
      });
    });
  }

  // A8: Currency consistency — all offer part prices must use the same currency as offerSummary
  const _summaryCurrency = selectedOffer.offerSummary?.minimalPrice?.currency;
  if (_summaryCurrency) {
    ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'].forEach(partType => {
      (selectedOffer[partType] || []).forEach((part, pi) => {
        if (part.price?.currency) {
          test(`${partType}[${pi}].price.currency matches offerSummary currency (expected: ${_summaryCurrency}, actual: ${part.price.currency})`, () => {
            expect(part.price.currency).to.eql(_summaryCurrency,
              `Currency mismatch in ${partType}[${pi}]: expected ${_summaryCurrency}, got ${part.price.currency}`);
          });
        }
      });
    });
    validationLogger(`[DEBUG] A8 currency consistency checked for all offer parts against summaryCurrency=${_summaryCurrency}`);
  }

  // RI (#258): for each offer part carrying requestedInformation — assert it is
  // statically conformant (Phase 1/3b: type, grammar, index range), evaluate it
  // against the passenger data OSCAR will send, and AUTO-PROVIDE any missing
  // demanded fields so the happy flow completes (Phase 3a, default on). A
  // negative probe (Phase 3c) disables auto-feed to test the provider's error.
  const _riReadJson = (name) => {
    const raw = bru.getEnvVar(name);
    if (raw === null || raw === undefined || raw === '') return [];
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_e) { return []; }
  };
  const _riSpecs = _riReadJson('offerPassengerSpecifications');
  let _riAdditional = _riReadJson('passengerAdditionalData');
  const _riCount = Number(bru.getEnvVar('offerPassengerNumber')) || _riAdditional.length || 0;
  const _riProbe = String(bru.getEnvVar('requestedInformationProbe') || 'off').toLowerCase();
  const _riMode = (_riProbe === 'omit' || _riProbe === 'invalid') ? _riProbe : 'autofeed';
  const _riAssert = (name, ok, msg) => test(name, () => { expect(ok, msg).to.be.true; });
  const _riLog = (lvl, msg) => validationLogger(`[${lvl}] ${msg}`);
  const _riAutoFed = [];
  const _riProbeTargets = [];
  let _riChanged = false;

  ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'].forEach(partType => {
    (selectedOffer[partType] || []).forEach((part, pi) => {
      const ri = part?.requestedInformation;
      if (ri === undefined || ri === null || ri === '') return;
      const out = processRequestedInformation({
        expr: ri,
        tag: `${partType}[${pi}]`,
        additional: _riAdditional,
        specs: _riSpecs,
        passengerCount: _riCount,
        mode: _riMode,
        assert: _riAssert,
        log: _riLog,
      });
      // autofeed (provided) and negative probe (probeTargets) both mutate the data.
      if (out.provided.length || (out.probeTargets?.length)) {
        _riAdditional = out.additional;
        _riChanged = true;
      }
      out.provided.forEach(p => _riAutoFed.push({ index: p.index, scenarioField: p.scenarioField }));
      (out.probeTargets || []).forEach(t => _riProbeTargets.push(t));
    });
  });

  if (_riChanged) {
    bru.setEnvVar('passengerAdditionalData', JSON.stringify(_riAdditional));
    // The PATCH step is skipped when no passenger update was configured; auto-fed
    // (or deliberately probed) values must actually be sent, so re-enable it.
    if (String(bru.getEnvVar('skipPatchPassengerRequest')) === 'true') {
      bru.setEnvVar('skipPatchPassengerRequest', 'false');
    }
  }
  if (_riAutoFed.length) bru.setEnvVar('requestedInfoAutoFed', JSON.stringify(_riAutoFed));
  if (_riProbeTargets.length) bru.setEnvVar('requestedInfoProbeTargets', JSON.stringify(_riProbeTargets));
}

// Admission validation
function validateAdmissions(selectedOffer) {
  validationLogger("[DEBUG] ➤ validateAdmissions");

  const overallFlex = selectedOffer.offerSummary?.overallFlexibility;
  const admissionParts = selectedOffer.admissionOfferParts || [];
  const reservationParts = selectedOffer.reservationOfferParts || [];
  const ancillaryParts = selectedOffer.ancillaryOfferParts || [];
  const _idsRaw1 = bru.getEnvVar("admissionReservationAncillaryOfferPartsIds");
  const admissionReservationAncillaryOfferPartsIds = Array.isArray(_idsRaw1) ? _idsRaw1 : JSON.parse(_idsRaw1 || "[]");
  let admissionReservationAncillaryOfferPartsAftersalesConditions = Number(bru.getEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions") || 0);

  if (admissionParts.length > 0) {
    admissionParts.forEach((admission, i) => {
      validationLogger(`[DEBUG] Validating admissionOfferParts ${i + 1} id=${admission.id}`);
      admissionReservationAncillaryOfferPartsIds.push(admission.id);
      bru.setEnvVar("admissionReservationAncillaryOfferPartsIds", admissionReservationAncillaryOfferPartsIds);

      // Determine business type of admission (NRT / IRT)
      let type = "NRT"; // Default: Non Reserved Ticket
      if (admission.isReservationRequired && Array.isArray(admission.reservations) && admission.reservations.length > 0) type = "IRT";

      // #613 F15: logged, not a check — the value is computed here, so a check
      // on it could never fail.
      validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} business type: ${type}`);

      // validFrom is a valid date
      if (admission.validFrom) {
        const validFrom = new Date(admission.validFrom);
        test(`AdmissionOfferPart ${i + 1} validFrom is a valid date - validFrom: ${admission.validFrom}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} validFrom: ${admission.validFrom}`);
          expect(!Number.isNaN(validFrom.getTime()), "validFrom should be a valid ISO date").to.be.true;
        });
      }

      // validUntil is optional in OSDM; when present it is in the future (#613 F11).
      if (admission.validUntil != null) {
        const validUntil = new Date(admission.validUntil);
        test(`AdmissionOfferPart ${i + 1} validUntil is in the future - validUntil: ${admission.validUntil}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} validUntil is in the future - validUntil: ${admission.validUntil}`);
          expect(validUntil.getTime()).to.be.above(Date.now());
        });
      } else {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} validUntil absent (optional in OSDM) → check skipped`);
      }

      // price structure is valid
      test(`AdmissionOfferPart ${i + 1} price structure is valid - amount: ${admission.price?.amount}, currency: ${admission.price?.currency}`, function () {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} price: ${admission.price?.amount} ${admission.price?.currency}`);
        expect(admission.price, "price should exist").to.be.an("object");
        expect(admission.price.amount, "price.amount should be a number >= 0").to.be.a("number").and.at.least(0);
        expect(admission.price.currency, "price.currency should exist").to.exist.and.be.a("string");
        expectScale(admission.price.scale, "price.scale should be a number, null or absent (nullable per OSDM)");
      });

      // offerMode is defined
      if (admission.offerMode) {
        test(`AdmissionOfferPart ${i + 1} offerMode is a known value - offerMode: ${admission.offerMode}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} offerMode: ${admission.offerMode}`);
          expect(admission.offerMode).to.be.oneOf(["INDIVIDUAL", "COLLECTIVE"]);
        });
      }

      // #601: minGroupItemsToBeBooked / maxGroupItemsToBeBooked belong to the
      // admission's reservation relations (admission.reservations[]), not to
      // the admission: they were read here, where OSDM never puts them, so the
      // checks never ran. The relations are checked when the reservations are
      // chosen (handleOptionalReservationSelections, seatReservations.js).

      // appliedPassengerTypes each has a type and passengerRef
      const appliedPassengerTypes = admission.appliedPassengerTypes || [];
      if (appliedPassengerTypes.length > 0) {
        test(`AdmissionOfferPart ${i + 1} appliedPassengerTypes are valid - count: ${appliedPassengerTypes.length}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} appliedPassengerTypes count: ${appliedPassengerTypes.length}`);
          appliedPassengerTypes.forEach((apt, aptIdx) => {
            expect(apt.passengerRef, `appliedPassengerTypes[${aptIdx}].passengerRef should exist`).to.be.a("string");
          });
        });
        // type: ActualPassengerType is an extensible OSDM code list (#613 F4).
        // FAIL only when missing or not text; a value outside the listed ones
        // (a provider's own code such as 'A') is a WARNING.
        appliedPassengerTypes.forEach((apt, aptIdx) => {
          checkExtensibleCode({ test, expect, log: validationLogger },
            `AdmissionOfferPart ${i + 1} appliedPassengerTypes[${aptIdx}].type`, apt.type, OSDM_PASSENGER_TYPES, 'PassengerType');
        });
      }

      // isReusable is a boolean (if present)
      if (admission.isReusable !== undefined) {
        test(`AdmissionOfferPart ${i + 1} isReusable is a boolean or null - isReusable: ${admission.isReusable}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} isReusable: ${admission.isReusable}`);
          expectTypeOrNull(admission.isReusable, "boolean", "isReusable should be a boolean or null (nullable per OSDM)");
        });
      }

      // passengerRefs: at least one
      const passengerRefs = admission.passengerRefs || [];
      test(`AdmissionOfferPart ${i + 1} passengerRefs has at least one entry`, function () {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} passengerRefs: ${JSON.stringify(passengerRefs)}`);
        expect(passengerRefs.length).to.be.above(0);
      });

      // Validate linkage to reservationOfferParts (handles both Paxone: reservationsGroup.reservationsRefs and Turnit: reservationGroup.reservationRefs)
      const reservationsRefs = admission?.reservations?.flatMap(r =>
        r.reservationGroup?.reservationRefs || r.reservationsGroup?.reservationsRefs || []
      ) || [];
      if (reservationsRefs.length > 0) {
        test(`Reservation linkage in admission with id ${admission.id}, reservationsRef ids should match reservationOfferParts ids`, () => {
          reservationsRefs.forEach(ref => {
            const found = reservationParts.some(r => r.id === ref.id);
            validationLogger(`[DEBUG] reservationsRef.id : ${ref.id} → match in reservationOfferParts : ${found}`);
            expect(found, `reservationOfferParts should contain id ${ref.id}`).to.eql(true);
          });
        });
      } else {
        validationLogger(`[DEBUG] No reservationsRefs found for admission id=${admission.id} → test skipped`);
      }

      // Validate linkage to ancillaryOfferParts
      const ancillaryRefs = admission?.ancillaries?.flatMap(r => r.ancillaryGroup?.ancillaryRefs || []) || [];
      if (ancillaryRefs.length > 0) {
        test(`Ancillary linkage in admission with id ${admission.id}, ancillaryRef ids should match ancillaryOfferParts ids`, () => {
          ancillaryRefs.forEach(ref => {
            const found = ancillaryParts.some(a => a.id === ref.id);
            validationLogger(`[DEBUG] ancillaryRef.id : ${ref.id} → match in ancillaryOfferParts : ${found}`);
            expect(found, `ancillaryOfferParts should contain id ${ref.id}`).to.eql(true);
          });
        });
      } else {
        validationLogger(`[DEBUG] No ancillaryRefs found for admission id=${admission.id} → test skipped`);
      }

      // Validate afterSalesConditions structure
      if (Array.isArray(admission.afterSalesConditions) && admission.afterSalesConditions.length > 0) {
        test(`Admission part ${i + 1} afterSalesConditions validity`, () => {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} has ${admission.afterSalesConditions.length} afterSalesCondition(s)`);

          admission.afterSalesConditions.forEach((condition, condIndex) => {
            validationLogger(`[DEBUG] Validating afterSalesCondition[${condIndex}] for admission ${admission.id}`);

            // Validate condition type
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should exist`).to.exist;
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should be REFUND, EXCHANGE or PLACE_CHANGE (OSDM: AfterSaleConditionType)`).to.be.oneOf(['REFUND', 'EXCHANGE', 'PLACE_CHANGE']);
            validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].condition: ${condition.condition}`);

            // Validate validFrom
            if (condition.validFrom) {
              const validFromDate = new Date(condition.validFrom);
              if (!Number.isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!Number.isNaN(validUntilDate.getTime())) {
                expect(condition.validUntil, `afterSalesCondition[${condIndex}].validUntil should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validUntil: ${condition.validUntil}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validUntil has invalid date format: ${condition.validUntil}`);
              }
            }

            // Validate afterSaleFee structure
            if (condition.afterSaleFee) {
              expect(condition.afterSaleFee, `afterSalesCondition[${condIndex}].afterSaleFee should exist`).to.be.an('object');
              expect(condition.afterSaleFee.currency, `afterSalesCondition[${condIndex}].afterSaleFee.currency should exist`).to.exist;
              expect(condition.afterSaleFee.amount, `afterSalesCondition[${condIndex}].afterSaleFee.amount should be a number`).to.be.a('number');
              expectScale(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number, null or absent (nullable per OSDM)`);
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              // The fee counts when the condition is for the scenario's own after-sales kind.
              if ((scenarioType.includes("REFUND") && condition.condition === "REFUND") ||
                  (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE")) {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              }
            } else {
              validationLogger(`[WARNING] afterSalesCondition[${condIndex}].afterSaleFee is missing`);
            }
          });
        });
      } else {
        validationLogger(`[DEBUG] No afterSalesConditions found for admission id=${admission.id} → test skipped`);
      }

      // #387: context only — was the SECOND of three rows for one root cause;
      // the verdict row is owned by ensureYesWhenRefundOrExchangeSelected.
      if (overallFlex === "FULL_FLEXIBLE" || overallFlex === "SEMI_FLEXIBLE") {
        const scenarioType = bru.getEnvVar("scenarioType") || "";
        if (scenarioType.includes("REFUND")) {
          validationLogger(`[DEBUG] Admission part ${i + 1} refundable : ${admission.refundable} (verdict: scenario-vs-offer row)`);
        } else if (scenarioType.includes("EXCHANGE")) {
          validationLogger(`[DEBUG] Admission part ${i + 1} exchangeable : ${admission.exchangeable} (verdict: scenario-vs-offer row)`);
        }
      }
    });
  } else {
    validationLogger(`[DEBUG] No admissionOfferParts found for offer.id : ${selectedOffer.offerId} → test skipped`);
  }
}

// Reservation validation
function validateReservations(selectedOffer) {
  validationLogger("[DEBUG] ➤ validateReservations");

  const reservationParts = selectedOffer.reservationOfferParts || [];
  const ancillaryParts = selectedOffer.ancillaryOfferParts || [];
  const _idsRaw2 = bru.getEnvVar("admissionReservationAncillaryOfferPartsIds");
  const admissionReservationAncillaryOfferPartsIds = Array.isArray(_idsRaw2) ? _idsRaw2 : JSON.parse(_idsRaw2 || "[]");
  let admissionReservationAncillaryOfferPartsAftersalesConditions = Number(bru.getEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions") || 0);

  if (reservationParts.length > 0) {
    reservationParts.forEach((reservation, i) => {
      validationLogger(`[DEBUG] Validating reservationOfferParts ${i + 1} id : ${reservation.id}`);
      admissionReservationAncillaryOfferPartsIds.push(reservation.id);
      bru.setEnvVar("admissionReservationAncillaryOfferPartsIds", admissionReservationAncillaryOfferPartsIds);

      // price structure is valid
      test(`ReservationOfferPart ${i + 1} price structure is valid - amount: ${reservation.price?.amount}, currency: ${reservation.price?.currency}`, function () {
        validationLogger(`[DEBUG] ReservationOfferPart ${i + 1} price: ${reservation.price?.amount} ${reservation.price?.currency}`);
        expect(reservation.price, "price should exist").to.be.an("object");
        expect(reservation.price.amount, "price.amount should be a number >= 0").to.be.a("number").and.at.least(0);
        expect(reservation.price.currency, "price.currency should exist").to.exist.and.be.a("string");
        expectScale(reservation.price.scale, "price.scale should be a number, null or absent (nullable per OSDM)");
      });

      // refundable and exchangeable are valid OSDM values
      test(`ReservationOfferPart ${i + 1} refundable is a valid value - refundable: ${reservation.refundable}`, function () {
        validationLogger(`[DEBUG] ReservationOfferPart ${i + 1} refundable: ${reservation.refundable}`);
        expect(reservation.refundable).to.be.oneOf(["YES", "NO", "WITH_CONDITION"]);
      });
      test(`ReservationOfferPart ${i + 1} exchangeable is a valid value - exchangeable: ${reservation.exchangeable}`, function () {
        validationLogger(`[DEBUG] ReservationOfferPart ${i + 1} exchangeable: ${reservation.exchangeable}`);
        expect(reservation.exchangeable).to.be.oneOf(["YES", "NO", "WITH_CONDITION"]);
      });

      // offerMode is a known OSDM value (if present)
      if (reservation.offerMode) {
        test(`ReservationOfferPart ${i + 1} offerMode is a known value - offerMode: ${reservation.offerMode}`, function () {
          validationLogger(`[DEBUG] ReservationOfferPart ${i + 1} offerMode: ${reservation.offerMode}`);
          expect(reservation.offerMode).to.be.oneOf(["INDIVIDUAL", "COLLECTIVE"]);
        });
      }

      // passengerRefs: at least one
      const reservationPassengerRefs = reservation.passengerRefs || [];
      test(`ReservationOfferPart ${i + 1} passengerRefs has at least one entry`, function () {
        validationLogger(`[DEBUG] ReservationOfferPart ${i + 1} passengerRefs: ${JSON.stringify(reservationPassengerRefs)}`);
        expect(reservationPassengerRefs.length).to.be.above(0);
      });

      // Available Places: structure + tripLegCoverage shape. #379: the former
      // hard `oneOf` on accommodationType was provider-UNFAIR — AccommodationType
      // is an x-extensible-enum, so a value outside the base list is LEGAL
      // (custom code) and must not fail the run. The membership check moved to
      // an R9 conformance-nuance WARNING below; accommodationSubType is an OPEN
      // code list (no base enum), so it gets no membership check at all.
      const availablePlaces = reservation.availablePlaces || [];
      if (availablePlaces.length > 0) {
        test(`Reservation part ${i + 1} availablePlaces is an array and contains accommodationType and numericAvailability`, () => {
          validationLogger(`[DEBUG] availablePlaces count : ${availablePlaces.length}`);
          expect(Array.isArray(availablePlaces)).to.eql(true);
          availablePlaces.forEach((place, pIndex) => {
            validationLogger(`[DEBUG] availablePlaces[${pIndex}] accommodationType : ${place.accommodationType}, numericAvailability : ${place.numericAvailability}`);
            expect(typeof place.accommodationType).to.eql("string");
            expectTypeOrNull(place.numericAvailability, "number", `availablePlaces[${pIndex}].numericAvailability should be a number or null (nullable per OSDM)`);
            // tripLegCoverage structure (if present)
            if (place.tripLegCoverage) {
              expect(place.tripLegCoverage.tripId, `availablePlaces[${pIndex}].tripLegCoverage.tripId should be a string`).to.be.a("string");
              expect(place.tripLegCoverage.legId, `availablePlaces[${pIndex}].tripLegCoverage.legId should be a string`).to.be.a("string");
            }
          });
        });
        const KNOWN_ACCOMMODATION_TYPES = ["SEAT", "COUCHETTE", "BERTH", "VEHICLE", "STORAGE"];
        availablePlaces.forEach((place, pIndex) => {
          const _t = String((place?.accommodationType) || "");
          if (_t && !KNOWN_ACCOMMODATION_TYPES.includes(_t.toUpperCase())) {
            validationLogger(`[WARNING] Reservation part ${i + 1} availablePlaces[${pIndex}].accommodationType '${_t}' is outside the OSDM base AccommodationType list [${KNOWN_ACCOMMODATION_TYPES.join(", ")}] — legal for an x-extensible-enum (custom code), but cross-vendor tooling may not understand it.`);
          }
        });
        // #211 (SFR night-train spec): gender-segregated COUCHETTE/BERTH
        // compartments are expected to carry a MEN/LADIES/MIXED placeProperties
        // entry. Soft WARNING, not a FAIL — placeProperties is not a
        // mandatory OSDM field and some vendors may not run gender-segregated
        // night trains at all.
        const GENDER_PLACE_PROPERTIES = ["MEN", "LADIES", "MIXED"];
        const _nightAccPlaces = availablePlaces.filter(pl => pl && ["COUCHETTE", "BERTH"].includes(String(pl.accommodationType || "").toUpperCase()));
        if (_nightAccPlaces.length > 0) {
          const _hasGenderProp = _nightAccPlaces.some(pl => Array.isArray(pl.placeProperties) && pl.placeProperties.some(p => GENDER_PLACE_PROPERTIES.includes(p)));
          if (!_hasGenderProp) {
            validationLogger(`[WARNING] Reservation part ${i + 1} has COUCHETTE/BERTH availablePlaces but none declare a gender-segregation placeProperties value (${GENDER_PLACE_PROPERTIES.join("/")}) — legal (placeProperties is optional per OSDM), but night-train gender-dependent scenarios (#211) cannot be exercised against this offer.`);
          }
        }
      } else {
        validationLogger(`[DEBUG] No availablePlaces for reservation id=${reservation.id} → test skipped`);
      }

      // Numeric Availability
      if ("numericAvailability" in reservation) {
        test(`Reservation part ${i + 1} numericAvailability is a number or null - total: ${reservation.numericAvailability}`, () => {
          validationLogger(`[DEBUG] numericAvailability : ${reservation.numericAvailability}`);
          expectTypeOrNull(reservation.numericAvailability, "number", "numericAvailability should be a number or null (nullable per OSDM)");
        });
      } else {
        validationLogger(`[DEBUG] No numericAvailability for reservation id : ${reservation.id} → test skipped`);
      }

      // #379: capacity vs the requested party (R9 nuance — the spec does not
      // mandate numericAvailability >= party size, but this offer was generated
      // FOR this party; one that cannot host it is worth a flag before booking).
      const _paxCount = (parseEnvJson("offerPassengerSpecifications", []) || []).length;
      if (_paxCount > 0) {
        const _short = [];
        if (typeof reservation.numericAvailability === "number" && reservation.numericAvailability < _paxCount) {
          _short.push(`part-level numericAvailability ${reservation.numericAvailability}`);
        }
        availablePlaces.forEach((place, pIndex) => {
          if (place && typeof place.numericAvailability === "number" && place.numericAvailability < _paxCount) {
            _short.push(`availablePlaces[${pIndex}] (${place.accommodationType || "?"}${place.accommodationSubType ? "/" + place.accommodationSubType : ""}) ${place.numericAvailability}`);
          }
        });
        if (_short.length > 0) {
          validationLogger(`[WARNING] Reservation part ${i + 1}: availability below the requested party of ${_paxCount} — ${_short.join("; ")}. Booking this part for the whole party may be refused.`);
        }
      }

      // Number of Private Compartments
      if ("numberOfPrivateCompartments" in reservation) {
        test(`Reservation part ${i + 1} numberOfPrivateCompartments is a number or null - total: ${reservation.numberOfPrivateCompartments}`, () => {
          validationLogger(`[DEBUG] numberOfPrivateCompartments : ${reservation.numberOfPrivateCompartments}`);
          expectTypeOrNull(reservation.numberOfPrivateCompartments, "number", "numberOfPrivateCompartments should be a number or null (nullable per OSDM)");
        });
      } else {
        validationLogger(`[DEBUG] No numberOfPrivateCompartments for reservation id=${reservation.id} → test skipped`);
      }

      // Available Place Preferences
      const placePrefs = reservation.availablePlacePreferences || [];
      if (placePrefs.length > 0) {
        test(`Reservation part ${i + 1} availablePlacePreferences present`, () => {
          validationLogger(`[DEBUG] availablePlacePreferences : ${JSON.stringify(placePrefs)}`);
          expect(Array.isArray(placePrefs)).to.eql(true);
          expect(placePrefs.length).to.be.above(0);
        });
      } else {
        validationLogger(`[DEBUG] No availablePlacePreferences for reservation id=${reservation.id} → test skipped`);
      }

      // Validate linkage to ancillaryOfferParts
      const ancillaryRefs = reservation?.ancillaries?.flatMap(r => r.ancillaryGroup?.ancillaryRefs || []) || [];
      if (ancillaryRefs.length > 0) {
        test(`Ancillary linkage — reservation id ${reservation.id}`, () => {
          ancillaryRefs.forEach(ref => {
            const found = ancillaryParts.some(a => a.id === ref.id);
            validationLogger(`[DEBUG] ancillaryRef.id : ${ref.id} → match in ancillaryOfferParts : ${found}`);
            expect(found, `ancillaryOfferParts should contain id ${ref.id}`).to.eql(true);
          });
        });
      } else {
        validationLogger(`[DEBUG] No ancillaryRefs found for reservation id : ${reservation.id} → test skipped`);
      }

      // Validate afterSalesConditions structure
      if (Array.isArray(reservation.afterSalesConditions) && reservation.afterSalesConditions.length > 0) {
        test(`Reservation part ${i + 1} afterSalesConditions validity`, () => {
          validationLogger(`[DEBUG] Reservation part ${i + 1} has ${reservation.afterSalesConditions.length} afterSalesCondition(s)`);

          reservation.afterSalesConditions.forEach((condition, condIndex) => {
            validationLogger(`[DEBUG] Validating afterSalesCondition[${condIndex}] for reservation ${reservation.id}`);
            // Validate condition type
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should exist`).to.exist;
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should be REFUND, EXCHANGE or PLACE_CHANGE (OSDM: AfterSaleConditionType)`).to.be.oneOf(['REFUND', 'EXCHANGE', 'PLACE_CHANGE']);
            validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].condition: ${condition.condition}`);

            // Validate validFrom
            if (condition.validFrom) {
              const validFromDate = new Date(condition.validFrom);
              if (!Number.isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!Number.isNaN(validUntilDate.getTime())) {
                expect(condition.validUntil, `afterSalesCondition[${condIndex}].validUntil should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validUntil: ${condition.validUntil}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validUntil has invalid date format: ${condition.validUntil}`);
              }
            }

            // Validate afterSaleFee structure
            if (condition.afterSaleFee) {
              expect(condition.afterSaleFee, `afterSalesCondition[${condIndex}].afterSaleFee should exist`).to.be.an('object');
              expect(condition.afterSaleFee.currency, `afterSalesCondition[${condIndex}].afterSaleFee.currency should exist`).to.exist;
              expect(condition.afterSaleFee.amount, `afterSalesCondition[${condIndex}].afterSaleFee.amount should be a number`).to.be.a('number');
              expectScale(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number, null or absent (nullable per OSDM)`);
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              // The fee counts when the condition is for the scenario's own after-sales kind.
              if ((scenarioType.includes("REFUND") && condition.condition === "REFUND") ||
                  (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE")) {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              }
            } else {
              validationLogger(`[WARNING] afterSalesCondition[${condIndex}].afterSaleFee is missing`);
            }
          });
        });
      } else {
        validationLogger(`[DEBUG] No afterSalesConditions found for reservation id : ${reservation.id} → test skipped`);
      }
    });
  } else {
    validationLogger(`[DEBUG] No reservationOfferParts found for offer.id : ${selectedOffer.offerId} → test skipped`);
  }
}

function validateAncillaries(selectedOffer) {
  validationLogger("[DEBUG] ➤ validateAncillaries");
  const ancillaryParts = selectedOffer.ancillaryOfferParts || [];
  const _idsRaw3 = bru.getEnvVar("admissionReservationAncillaryOfferPartsIds");
  const admissionReservationAncillaryOfferPartsIds = Array.isArray(_idsRaw3) ? _idsRaw3 : JSON.parse(_idsRaw3 || "[]");
  let admissionReservationAncillaryOfferPartsAftersalesConditions = Number(bru.getEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions") || 0);

  // Capture referenced ancillary IDs from environment
  const referencedAncillaryIdsArray = parseEnvJson("referencedAncillaryIds", []);
  const referencedAncillaryIds = new Set(referencedAncillaryIdsArray);

  if (ancillaryParts.length > 0) {
    ancillaryParts.forEach((ancillary, i) => {
      validationLogger(`[DEBUG] Validating ancillaryOfferParts ${i + 1} id=${ancillary.id}`);

      // Add ids only if referenced in admissionOfferParts
      if (referencedAncillaryIds.has(ancillary.id)) {
        admissionReservationAncillaryOfferPartsIds.push(ancillary.id);
        bru.setEnvVar("admissionReservationAncillaryOfferPartsIds", admissionReservationAncillaryOfferPartsIds);
      }

      test(`Ancillary type is defined - type: ${ancillary.type}`, function () {
        validationLogger(`[DEBUG] ancillaryOfferParts ${i + 1} type: ${ancillary.type}`);
        expect(ancillary.type).to.be.a("string");
      });

      // Validate afterSalesConditions structure
      if (Array.isArray(ancillary.afterSalesConditions) && ancillary.afterSalesConditions.length > 0) {
        test(`Ancillary part ${i + 1} afterSalesConditions validity`, () => {
          validationLogger(`[DEBUG] Ancillary part ${i + 1} has ${ancillary.afterSalesConditions.length} afterSalesCondition(s)`);

          ancillary.afterSalesConditions.forEach((condition, condIndex) => {
            validationLogger(`[DEBUG] Validating afterSalesCondition[${condIndex}] for ancillary ${ancillary.id}`);
            // Validate condition type
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should exist`).to.exist;
            expect(condition.condition, `afterSalesCondition[${condIndex}].condition should be REFUND, EXCHANGE or PLACE_CHANGE (OSDM: AfterSaleConditionType)`).to.be.oneOf(['REFUND', 'EXCHANGE', 'PLACE_CHANGE']);
            validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].condition: ${condition.condition}`);

            // Validate validFrom
            if (condition.validFrom) {
              const validFromDate = new Date(condition.validFrom);
              if (!Number.isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!Number.isNaN(validUntilDate.getTime())) {
                expect(condition.validUntil, `afterSalesCondition[${condIndex}].validUntil should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validUntil: ${condition.validUntil}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validUntil has invalid date format: ${condition.validUntil}`);
              }
            }

            // Validate afterSaleFee structure
            if (condition.afterSaleFee) {
              expect(condition.afterSaleFee, `afterSalesCondition[${condIndex}].afterSaleFee should exist`).to.be.an('object');
              expect(condition.afterSaleFee.currency, `afterSalesCondition[${condIndex}].afterSaleFee.currency should exist`).to.exist;
              expect(condition.afterSaleFee.amount, `afterSalesCondition[${condIndex}].afterSaleFee.amount should be a number`).to.be.a('number');
              expectScale(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number, null or absent (nullable per OSDM)`);
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              // The fee counts when the condition is for the scenario's own after-sales kind.
              if ((scenarioType.includes("REFUND") && condition.condition === "REFUND") ||
                  (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE")) {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              }
            } else {
              validationLogger(`[WARNING] afterSalesCondition[${condIndex}].afterSaleFee is missing`);
            }
          });
        });
      } else {
        validationLogger(`[DEBUG] No afterSalesConditions found for ancillary id : ${ancillary.id} → test skipped`);
      }
    });
  } else {
    validationLogger(`[DEBUG] No ancillaryOfferParts found for offer.id : ${selectedOffer.offerId} → test skipped`);
  }
}

// A value as a list: itself when it is one, [] when absent, else a list of it.
function asList(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

// Function to extract all tripId and legId from tripLegCoverage for a given accommodationType
// #371: coverage the OFFER declares (tripCoverage, object or array) -
// normalized to [{tripId, legId}]. The authoritative source for booking
// placeSelections per the OBB IRT/NJ requirement; per-place tripLegCoverage
// stays the fallback for providers that only set it there.
function offerTripCoverage(selectedOffer) {
  const tc = selectedOffer?.tripCoverage;
  const arr = asList(tc);
  const out = [];
  arr.forEach(c => {
    if (!c) return;
    if (c.tripId && c.legId) {
      out.push({ tripId: c.tripId, legId: c.legId });
    } else if (c.coveredTripId && Array.isArray(c.coveredLegIds)) {
      // #377: the spec's TripCoverage form ({coveredTripId, coveredLegIds})
      // is what providers actually send on the offer (seen on OBB) — the
      // flat {tripId, legId} mapping alone never fired, so #371's
      // offer-level preference silently fell back to per-place coverage.
      c.coveredLegIds.filter(Boolean).forEach(l => out.push({ tripId: c.coveredTripId, legId: l }));
    }
  });
  return out;
}

// #379 (R8 — registers only on failure): the offer's tripCoverage must
// reference trips/legs that EXIST in the same OfferCollectionResponse. A
// booking built on broken coverage would send tripLegCoverage pairs the
// provider's own trips do not contain.
function assertOfferCoverageIntegrity(selectedOffer, jsonData) {
  const pairs = offerTripCoverage(selectedOffer);
  const trips = (jsonData && Array.isArray(jsonData.trips)) ? jsonData.trips : [];
  if (pairs.length === 0 || trips.length === 0) {
    validationLogger(`[DEBUG] Offer coverage integrity: ${pairs.length === 0 ? "offer declares no tripCoverage" : "response carries no trips"} → check skipped.`);
    return;
  }
  const tripIds = new Set(trips.map((t) => t?.id).filter(Boolean));
  const legsByTrip = {};
  trips.forEach((t) => {
    if (t?.id) legsByTrip[t.id] = new Set((t.legs || []).map((l) => l?.id).filter(Boolean));
  });
  const issues = [];
  pairs.forEach((pr) => {
    if (!tripIds.has(pr.tripId)) {
      issues.push(`coverage references tripId '${pr.tripId}' but the response's trips are [${[...tripIds].join(", ")}]`);
      return;
    }
    const legs = legsByTrip[pr.tripId];
    if (legs && legs.size > 0 && pr.legId && !legs.has(pr.legId)) {
      issues.push(`coverage references legId '${pr.legId}' which is not a leg of trip '${pr.tripId}' (legs: [${[...legs].join(", ")}])`);
    }
  });
  if (issues.length > 0) {
    test("Selected offer tripCoverage references the response's own trips/legs", () => {
      throw new Error(`Referential integrity of the offer's tripCoverage is broken — ${[...new Set(issues)].join("; ")}.`);
    });
  } else {
    validationLogger(`[DEBUG] Offer coverage integrity OK — ${pairs.length} coverage pair(s) all reference existing trips/legs.`);
  }
}

// #379 (R9 nuance, never a failure): relate the CHOSEN reservation part's
// declared place-selection capabilities to what the scenario is about to do,
// so a later seat-map / booking misbehaviour reads back to a declared (or
// undeclared) capability without cross-referencing the payloads.
function notePlaceSelectionCapabilities(part) {
  if (!part || typeof part !== "object") return;
  const KNOWN_FLOWS = new Set([
    "MANUAL_PLACE_SELECTION_WITH_FEE", "MANUAL_PLACE_SELECTION_WITHOUT_FEE",
    "AUTOMATIC_PLACE_SELECTION", "AUTOMATIC_PLACE_SELECTION_NEARBY", "AUTOMATIC_PLACE_SELECTION_PREFERENCES",
  ]);
  const flows = Array.isArray(part.supportedPlaceSelectionFlows) ? part.supportedPlaceSelectionFlows.filter(Boolean).map(String) : [];
  const mode = bru.getEnvVar("placeSelectionMode") || "";
  const wantsMap = mode === "SEATMAP_AT_OFFER" || mode === "ADD_TO_BOOKING";
  const graphical = (Array.isArray(part.availablePlacePreferences) ? part.availablePlacePreferences : [])
    .map((p) => p?.graphicalReservation).filter(Boolean).map(String);

  if (flows.length === 0) {
    const mapNote = wantsMap ? ` — the scenario's ${mode} seat-map flow proceeds without a declared capability` : "";
    validationLogger(`[INFO] Reservation part ${part.id}: no supportedPlaceSelectionFlows declared (optional in OSDM)${mapNote}.`);
  } else {
    const graphicalNote = graphical.length ? `; graphicalReservation: ${[...new Set(graphical)].join(", ")}` : "";
    validationLogger(`[INFO] Reservation part ${part.id} declares place-selection flows: ${flows.join(", ")}${graphicalNote}.`);
    const unknown = flows.filter((f) => !KNOWN_FLOWS.has(f.toUpperCase()));
    if (unknown.length > 0) {
      validationLogger(`[WARNING] Reservation part ${part.id}: place-selection flow value(s) [${unknown.join(", ")}] are outside the OSDM base PlaceSelectionFlow list — legal (x-extensible-enum), noted for cross-vendor readers.`);
    }
    const hasManual = flows.some((f) => f.toUpperCase().indexOf("MANUAL_PLACE_SELECTION") === 0);
    const hasAutomatic = flows.some((f) => f.toUpperCase().indexOf("AUTOMATIC_PLACE_SELECTION") === 0);
    if (wantsMap && !hasManual) {
      validationLogger(`[WARNING] Scenario seat-selection mode is ${mode} (graphical pick) but the selected reservation part only declares [${flows.join(", ")}] — the provider does not advertise a manual/graphical flow; expect the place map or the place-carrying booking to be refused. Conformance nuance, not a failure.`);
    }
    if (!wantsMap && hasManual && !hasAutomatic) {
      validationLogger(`[INFO] Selected reservation part declares ONLY manual/graphical flows (${flows.join(", ")}) while the scenario books without a seat map — per OSDM the place map (/availabilities/vehicle-place-map) is expected before /bookings in these flows; watch the booking answer.`);
    }
  }
  if (wantsMap && graphical.length > 0 && graphical.every((g) => g.toUpperCase() === "NO")) {
    validationLogger(`[WARNING] Scenario seat-selection mode is ${mode} but availablePlacePreferences.graphicalReservation is 'NO' on the selected part — the provider states graphical reservation is NOT supported here. Conformance nuance, not a failure.`);
  }
}

function getTripLegCoverage(selectedOffer, accommodationSelection) {
  const fromOffer = offerTripCoverage(selectedOffer);
  if (fromOffer.length > 0) return fromOffer;
  const tripLegs = [];

  (selectedOffer.reservationOfferParts || []).forEach(part => {
    if (Array.isArray(part.availablePlaces)) {
      part.availablePlaces.forEach(place => {
        if (place.accommodationType === accommodationSelection && place.tripLegCoverage) {
          tripLegs.push({
            tripId: place.tripLegCoverage.tripId,
            legId: place.tripLegCoverage.legId
          });
        }
      });
    }
  });

  return tripLegs;
}

// Helper function to handle place and accommodation selection
function handleAccommodationAndPlaceSelection(selectedOffer) {
  validationLogger("[DEBUG] ➤ handleAccommodationAndPlaceSelection");

  const accommodationSelection = bru.getEnvVar("accommodationSelection");

  if (accommodationSelection !== "COUCHETTE" && accommodationSelection !== "BERTH") {
    // Plain SEAT scenario (not a couchette/berth). The pre-/post-booking place
    // map (08/08b) and add-reservation (09) are keyed on a RESERVATION offer-part
    // (resourceType=RESERVATION). reservationId/tripLegCoverage were previously
    // ONLY set on the COUCHETTE/BERTH branch — so a SEATMAP_AT_OFFER / ADD_TO_BOOKING
    // seat scenario sent an unresolved "{{reservationId}}" in the place-map URL and
    // the vendor replied 400 (observed on Bileto). Derive them here from the first
    // reservationOfferPart when place selection is in play and not already set.
    const _placeSelEnabled = String(bru.getEnvVar("salesFlow_placeSelection")) === "true"
      || bru.getEnvVar("placeSelectionMode") === "SEATMAP_AT_OFFER"
      || bru.getEnvVar("placeSelectionMode") === "ADD_TO_BOOKING"
      || bru.getEnvVar("requiresPlaceSelection") === true
      || bru.getEnvVar("requiresPlaceSelection") === "true";

    if (!_placeSelEnabled) {
      validationLogger(`[DEBUG] accommodationSelection is ${accommodationSelection}, place selection not enabled → skipping place selection`);
      return;
    }
    const _seatResParts = selectedOffer.reservationOfferParts || [];
    // #652: kept only when it is a part of this offer. A scenario that asks
    // for a new offer (after the expired-offer probe) used to keep the first
    // offer's reservation and trip, and booked them with the second offer.
    const _keptRes = bru.getEnvVar("reservationId");
    if (_keptRes && _seatResParts.some((p) => p?.id === _keptRes)) {
      validationLogger(`[DEBUG] reservationId already set (${_keptRes}) → keeping it`);
      return;
    }
    if (_seatResParts.length === 0) {
      validationLogger(`[WARN] Place selection enabled but this offer has no reservationOfferParts → seat map not applicable (nothing to reserve).`);
      return;
    }
    const _firstRes = _seatResParts[0];
    bru.setEnvVar("reservationId", _firstRes.id);
    bru.setEnvVar("reservationIds", JSON.stringify(_seatResParts.map((p) => p.id)));
    const _offerCov = offerTripCoverage(selectedOffer);
    const _firstPlace = Array.isArray(_firstRes.availablePlaces) ? _firstRes.availablePlaces[0] : null;
    if (_offerCov.length > 0) {
      bru.setEnvVar("tripLegCoverage", JSON.stringify(_offerCov));
    } else if (_firstPlace?.tripLegCoverage) {
      bru.setEnvVar("tripLegCoverage", JSON.stringify([_firstPlace.tripLegCoverage]));
    }
    // #371: persist the real accommodation of the selected part when the
    // offer declares it, so the booking placeSelections can carry it.
    if (_firstPlace && typeof _firstPlace.accommodationType === 'string' && _firstPlace.accommodationType) {
      const _acc = { accommodationType: _firstPlace.accommodationType };
      if (typeof _firstPlace.accommodationSubType === 'string' && _firstPlace.accommodationSubType) _acc.accommodationSubType = _firstPlace.accommodationSubType;
      bru.setEnvVar("selectedAccommodation", JSON.stringify(_acc));
    }
    notePlaceSelectionCapabilities(_firstRes);
    validationLogger(`[DEBUG] Seat place selection — reservationId set from first reservationOfferPart: ${_firstRes.id}`);
    return;
  }

  const reservationParts = selectedOffer.reservationOfferParts || [];
  validationLogger(`[DEBUG] Reservation Offer Parts count: ${reservationParts.length}`);

  const matchingParts = reservationParts.filter(part =>
    Array.isArray(part.availablePlaces) &&
    part.availablePlaces.some(place => place.accommodationType === accommodationSelection)
  );

  if (matchingParts.length === 0) {
    validationLogger(`[WARN] No reservationOfferParts found for accommodationType: '${accommodationSelection}'`);
    test(`At least one reservationOfferPart has accommodationType: ${accommodationSelection}`, function () {
      expect(false, `No reservationOfferParts with accommodationType ${accommodationSelection}`).to.be.true;
    });
    return;
  }

  matchingParts.forEach(part => validationLogger(`[DEBUG] ${accommodationSelection} reservationOfferPart.id: ${part.id}`));
  bru.setEnvVar("reservationIds", JSON.stringify(matchingParts.map(part => part.id)));

  // #211: night-train scenarios distinguish "bed in shared compartment"
  // (offerMode INDIVIDUAL) from "private compartment" (offerMode COLLECTIVE)
  // — both can appear as separate reservationOfferParts of the SAME
  // accommodationType in one offer response. Without this, an INDIVIDUAL-
  // intent scenario could silently book a COLLECTIVE part or vice versa,
  // making the two SFR scenario families untrustworthy to distinguish.
  const desiredOfferMode = bru.getEnvVar("offerMode");
  let selectedParts = matchingParts;
  if (desiredOfferMode) {
    const modeMatches = matchingParts.filter(part => part.offerMode === desiredOfferMode);
    if (modeMatches.length > 0) {
      selectedParts = modeMatches;
    } else {
      validationLogger(`[WARNING] No ${accommodationSelection} reservationOfferPart declares offerMode '${desiredOfferMode}' — falling back to the first ${accommodationSelection} part regardless of offerMode. The booked offerMode may not match what this scenario intended to test.`);
    }
  }
  const selectedPart = selectedParts[0];
  bru.setEnvVar("reservationId", selectedPart.id);

  // #371 (OBB IRT/NJ): persist the SELECTED part's real accommodation so the
  // booking request's placeSelections states which compartment is booked
  // (accommodationType + accommodationSubType from availablePlaces - e.g.
  // COUCHETTE / COUCHETTE_COMFORT_4) instead of a hardcoded placeholder.
  // #211: when the scenario asked for a specific gender-segregated
  // placeProperties value (MEN/LADIES/MIXED), prefer the availablePlace that
  // carries it — a single reservationOfferPart can list places for more than
  // one gender designation (e.g. a MEN place and a LADIES place).
  const desiredGender = bru.getEnvVar("accommodationGenderPreference");
  const candidatePlaces = (selectedPart.availablePlaces || [])
    .filter(pl => pl && pl.accommodationType === accommodationSelection);
  let _selPlace = null;
  if (desiredGender) {
    _selPlace = candidatePlaces.find(pl => Array.isArray(pl.placeProperties) && pl.placeProperties.includes(desiredGender)) || null;
    if (!_selPlace) {
      validationLogger(`[WARNING] No ${accommodationSelection} availablePlace declares placeProperties '${desiredGender}' — falling back to the first available place. The booked gender designation may not match what this scenario intended to test.`);
    }
  }
  if (!_selPlace) _selPlace = candidatePlaces[0] || null;
  if (_selPlace) {
    const _acc = { accommodationType: _selPlace.accommodationType };
    if (typeof _selPlace.accommodationSubType === 'string' && _selPlace.accommodationSubType) _acc.accommodationSubType = _selPlace.accommodationSubType;
    if (Array.isArray(_selPlace.placeProperties) && _selPlace.placeProperties.length > 0) _acc.placeProperties = _selPlace.placeProperties;
    bru.setEnvVar("selectedAccommodation", JSON.stringify(_acc));
    validationLogger(`[INFO] Selected accommodation for the booking placeSelections: ${_acc.accommodationType}${_acc.accommodationSubType ? ' / ' + _acc.accommodationSubType : ''}${_acc.placeProperties ? ' [' + _acc.placeProperties.join(',') + ']' : ''} (reservation part ${selectedPart.id}${desiredOfferMode ? ', offerMode ' + (selectedPart.offerMode || 'n/a') : ''})`);
  }

  notePlaceSelectionCapabilities(selectedPart);

  test(`At least one reservationOfferPart has accommodationType: ${accommodationSelection}`, function () {
    expect(matchingParts.length, "No matching reservationOfferParts found").to.be.above(0);
  });

  const tripLegCoverage = getTripLegCoverage(selectedOffer, accommodationSelection);
  bru.setEnvVar("tripLegCoverage", JSON.stringify(tripLegCoverage));
  validationLogger(`[DEBUG] tripLegCoverage stored in environment: ${JSON.stringify(tripLegCoverage)}`);
}

// #239, #601: the reservations booked with the selected offer. Every
// mandatory reservation (a relation of an admission with
// minGroupItemsToBeBooked > 0) is booked; the optional ones too when the
// scenario names a reservationBookingForm, or with the older
// bookMandatoryReservations switch (which booked every reservation part).
// RESERVATION_SELECTION sends optionalReservationSelections, PLACE_SELECTION
// placeSelections naming the trip and leg, ADD_LATER adds the optional ones
// after the booking (09). Independent of the seat map flow above, which picks
// places.
function handleOptionalReservationSelections(selectedOffer, trips) {
  const sr = require('./seatReservations.js');
  // The trips of the offer response, as { id, legIds } (#737): to tell the
  // leg of a reservation the offer gives without one, and to find a booked
  // reservation whose leg the booking renamed.
  const tripLegs = sr.tripLegsOf(trips);
  bru.setEnvVar("__offerTripLegs", JSON.stringify(tripLegs));
  const form = sr.normaliseForm(bru.getEnvVar("reservationBookingForm"));
  const legacy = String(bru.getEnvVar("bookMandatoryReservations")) === "true";
  const parts = selectedOffer.reservationOfferParts || [];
  if (parts.length === 0) {
    if (form || legacy) validationLogger(`[WARNING] The scenario books reservations (${form || "bookMandatoryReservations"}) but the selected offer has no reservationOfferParts — nothing to book.`);
    bru.setEnvVar("optionalReservationSelections", JSON.stringify([]));
    return;
  }
  validationLogger("[DEBUG] ➤ handleOptionalReservationSelections");
  recordChecks(sr.checkRelations(selectedOffer));
  const passengerRefs = (parseEnvJson("offerPassengerSpecifications", []) || []).map((p) => p?.externalRef).filter(Boolean);
  recordChecks(sr.checkProviderRules(selectedOffer, passengerRefs));

  const { mandatory, optional } = sr.reservationsToBook(selectedOffer, { bookOptional: !!form || legacy });
  const later = form === "ADD_LATER" ? optional : [];
  const atBooking = form === "ADD_LATER" ? mandatory : [...mandatory, ...optional];
  // #742: a mandatory reservation whose leg is known goes in placeSelections
  // whatever the form; one whose leg cannot be told goes in
  // optionalReservationSelections instead (#737): a placeSelection needs it.
  // #793: the Test Framework says how a mandatory one without a seat choice
  // is sent (a placeSelection, or nothing); the booking builder drops it then.
  const mandatoryForm = sr.normaliseMandatoryForm(bru.getEnvVar("mandatoryReservationForm"));
  bru.setEnvVar("__mandatoryReservationIds", JSON.stringify(mandatory));
  const sel = sr.bookingSelections(selectedOffer, { atBooking, mandatory, form, mandatoryForm }, tripLegs);
  sel.noLeg.filter((id) => !(mandatoryForm === "NONE" && mandatory.includes(id))).forEach((id) => validationLogger(`[WARNING] Reservation ${id}: the offer gives no leg for it — booked through optionalReservationSelections instead of placeSelections.`));
  if (mandatoryForm === "NONE" && mandatory.length > 0) validationLogger(`[INFO] Mandatory reservation(s) ${mandatory.join(", ")}: not named in the booking request unless a seat is chosen for them (Test Framework: mandatory reservation without a seat choice = nothing).`);
  bru.setEnvVar("reservationPlaceSelections", JSON.stringify(sel.placeSelections));
  bru.setEnvVar("optionalReservationSelections", JSON.stringify(sel.optionalReservationSelections));
  // Adding a reservation later takes placeSelections only (OSDM 3.8
  // BookedOfferPartRequest): one whose leg cannot be told is not added.
  const laterNoLeg = sr.reservationsWithoutLeg(selectedOffer, later, tripLegs);
  laterNoLeg.forEach((id) => validationLogger(`[WARNING] Reservation ${id}: the offer gives no leg for it — it cannot be added after the booking (placeSelections need a trip and a leg).`));
  bru.setEnvVar("reservationAddLaterSelections", JSON.stringify(sr.placeSelectionsFor(selectedOffer, later, tripLegs)));
  bru.setEnvVar("__reservationsBooked", JSON.stringify(atBooking));
  validationLogger(`[INFO] Reservations: ${mandatory.length} mandatory, ${optional.length} optional booked; ${atBooking.length} with the booking (${sel.placeSelections.length} in placeSelections, ${sel.optionalReservationSelections.length} in optionalReservationSelections), ${later.length} added after it.`);
}

function ensureYesWhenRefundOrExchangeSelected(selectedOffer) {
  validationLogger("[DEBUG] ➤ ensureYesWhenRefundOrExchangeSelected");

  const admissionParts = selectedOffer.admissionOfferParts || [];

  if (admissionParts.length > 0) {
    admissionParts.forEach((admission, i) => {
      const scenarioType = bru.getEnvVar("scenarioType") || "";
      // #387: THE owner of the scenario-vs-offer verdict (one defect, one row
      // — two former duplicates demoted to DEBUG context). Provider-fairness:
      // WITH_CONDITION must PASS — a REFUND/EXCHANGE under conditions is
      // legitimate; the after-sales step verifies the actual window. Only NO
      // (or an absent flag) fails, decoded.
      const _flagVerdict = (field, action) => {
        // #391: read the flag THROUGH the schedule (fee vs price per window).
        // OBB exchange: admissions pinned to NO while the schedules said three
        // different things — Sparschiene fee=100% of price (flag CONSISTENT:
        // a refund returns 0), Komfort fee=50%, Normalpreis fee=0 (both
        // effectively refundable → the flag should be WITH_CONDITION). Mere
        // PRESENCE of conditions proves nothing; their CONTENT decides.
        const { effectiveRefundability } = require("./afterSalesRules.js");
        const v = admission[field];
        const a = effectiveRefundability(admission, Date.now(), action);
        if (a.schedule && a.effective === "WITH_CONDITION") {
          test(`Admission part ${i + 1} permits ${action} (scenarioType=${action}) - schedule: ${a.refundableWindows}/${a.windows} window(s) below full price (flag: ${a.flagLabel})`, () => {
            validationLogger(`[INFO] Admission part ${i + 1}: the declared ${action} schedule grants a ${action.toLowerCase()} — ${a.refundableWindows} of ${a.windows} window(s) charge less than the price (${a.priceAmount})${a.freeWindow ? ", one window is even FREE" : ""}; the ${action.toLowerCase()} leg verifies the engine against it.`);
          });
          if (a.contradiction === "FLAG_NO_SCHEDULE_REFUNDABLE") {
            validationLogger(`[WARNING] Admission part ${i + 1} declares ${field}=NO while its own ${action} schedule charges less than the price${a.freeWindow ? " (a window is even FREE)" : ""} — the flag does not summarize the rules; per the spec enum, WITH_CONDITION is the value for exactly this schedule. Distributors filtering on the flag would hide a ${action.toLowerCase()}able product.`);
          }
          return;
        }
        if (a.schedule && a.effective === "NO") {
          test(`Admission part ${i + 1} permits ${action} (scenarioType=${action}) - schedule: every window charges the full price (flag: ${a.flagLabel})`, () => {
            throw new Error(`The scenario plans a ${action} but every declared ${action} window charges the full price (fee ≥ ${a.priceAmount}) — a ${action.toLowerCase()} would return 0; the schedule CONFIRMS the flag (${a.flagLabel}). OSCAR continues so the ${action.toLowerCase()} leg documents what the provider actually does.`);
          });
          return;
        }
        // No decodable schedule → the flag rules.
        if (v === "YES") {
          test(`Admission part ${i + 1} permits ${action} (scenarioType=${action}) - ${field}: YES`, () => {
            validationLogger(`[DEBUG] Admission part ${i + 1} ${field}=YES — the ${action} scenario can proceed.`);
          });
          return;
        }
        if (v === "WITH_CONDITION") {
          test(`Admission part ${i + 1} permits ${action} (scenarioType=${action}) - ${field}: WITH_CONDITION`, () => {
            validationLogger(`[INFO] Admission part ${i + 1} ${field}=WITH_CONDITION — the ${action} is condition-bound; the ${action.toLowerCase()}-offer step verifies the declared window.`);
          });
          if (a.contradiction === "FLAG_WC_NO_SCHEDULE") {
            validationLogger(`[WARNING] Admission part ${i + 1} declares ${field}=WITH_CONDITION but carries no ${action} afterSalesConditions — the conditions the flag promises are not declared; a client cannot evaluate them.`);
          }
          return;
        }
        test(`Admission part ${i + 1} permits ${action} (scenarioType=${action}) - ${field}: ${v}`, () => {
          throw new Error(`The scenario plans a ${action} but the selected offer's admission part declares ${field}=${v == null ? "(absent)" : v} (and no decodable ${action} schedule is present) — OSCAR continues so the ${action.toLowerCase()} leg documents what the provider actually does with a product it declared non-${action.toLowerCase()}able.`);
        });
      };
      if (scenarioType.includes("REFUND")) {
        _flagVerdict("refundable", "REFUND");
      } else if (scenarioType.includes("EXCHANGE")) {
        _flagVerdict("exchangeable", "EXCHANGE");
      }
    });
  }
}

// #393: catalog-wide flag-vs-schedule sweep (R9). The per-scenario verdict
// above analyses only the SELECTED offer, but the conformance pattern it
// caught on OBB — value-bearing parts pinned to refundable=NO while their own
// schedules grant below-price refunds — is a property of the whole catalog
// (16 of 24 offers in one NJ response). One summary WARNING per offers
// response gives catalog-scale evidence without per-offer noise; silent when
// no offer contradicts (R8). Zero-price parts carry no value to compare fees
// against and are skipped (the flag legitimately rules there, see #391).
function sweepCatalogFlagVsSchedule(offers) {
  const { effectiveRefundability } = require("./afterSalesRules.js");
  const list = Array.isArray(offers) ? offers : [];
  if (list.length === 0) return;
  ["REFUND", "EXCHANGE"].forEach((action) => {
    const field = action === "REFUND" ? "refundable" : "exchangeable";
    let contradicting = 0;
    let freeWindowed = 0;
    let consistent = 0;
    list.forEach((offer) => {
      const parts = [
        offer?.admissionOfferParts || [],
        offer?.reservationOfferParts || [],
        offer?.ancillaryOfferParts || [],
      ].flat()
        .filter((p) => p?.price && typeof p.price.amount === "number" && p.price.amount > 0);
      let hasContradiction = false;
      let hasFree = false;
      let hasConsistentNo = false;
      parts.forEach((p) => {
        const a = effectiveRefundability(p, Date.now(), action);
        if (!a.schedule) return;
        if (a.contradiction === "FLAG_NO_SCHEDULE_REFUNDABLE") {
          hasContradiction = true;
          if (a.freeWindow) hasFree = true;
        } else if (a.flag === "NO" && a.effective === "NO") {
          hasConsistentNo = true;
        }
      });
      if (hasContradiction) {
        contradicting++;
        if (hasFree) freeWindowed++;
      } else if (hasConsistentNo) {
        consistent++;
      }
    });
    if (contradicting > 0) {
      const freeNote = freeWindowed > 0 ? ` (${freeWindowed} even with a FREE window)` : "";
      validationLogger(`[WARNING] Catalog sweep (${action}): ${contradicting} of ${list.length} offers declare ${field}=NO on a value-bearing part while their own ${action} schedule charges less than the price${freeNote} — per the spec enum these are WITH_CONDITION; ${consistent} offer(s) are consistent (every ${action} window charges the full price). Distributors filtering on the flag would hide ${action.toLowerCase()}able products.`);
    }
  });
}

// Expose globally for convenience in eval/require flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e?.message));
}

// ── Reduction cards (#597) ───────────────────────────────────────────────────

// The offer postOfferResponse chose, kept in the environment as an object.
function chosenOffer() {
  const offer = bru.getEnvVar("offer");
  if (typeof offer !== "string") return offer || null;
  try { return JSON.parse(offer); } catch { return null; }
}

/**
 * After an offer step: the chosen offer applied each passenger's reduction
 * card. Warns once for a card code the provider's list (step 06) does not
 * hold. Returns true when the price comparison without cards (01c) is still
 * to be made, which the outbound step asks for (`compare`).
 */
function checkOfferCards(label, { compare = false } = {}) {
  const { withIssuers, passengersWithCards, checkCardsApplied } = require('./reductionCards.js');
  const specs = parseEnvJson("offerPassengerSpecifications", []);
  if (passengersWithCards(specs).length === 0) return false;
  const known = parseEnvJson("__reductionCardTypes", null);
  if (!Array.isArray(known)) {
    validationLogger(`[WARNING] Reduction cards: the provider's list (GET /reduction-cards) could not be read, so the cards are sent without an issuer.`);
  } else {
    const { unknown } = withIssuers(specs, known);
    if (unknown.length > 0) validationLogger(`[WARNING] Reduction cards: ${unknown.join(", ")} not in the provider's list (GET /reduction-cards).`);
  }
  checkCardsApplied(chosenOffer(), specs, label).forEach((c) => {
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
  return compare && String(bru.getEnvVar("__cardPriceCompareDone")) !== "true";
}

/** 01c: the chosen offer against the same request without cards. */
function compareOfferWithoutCards(status, body) {
  const { comparePrices } = require('./reductionCards.js');
  bru.setEnvVar("__cardPriceCompareDone", "true");
  if (status !== 200) {
    validationLogger(`[WARNING] Reduction cards: the offer request without cards answered ${status}; prices not compared.`);
    return;
  }
  comparePrices(chosenOffer(), { ...body, offers: searchTripOffers(body) }, parseEnvJson("offerPassengerSpecifications", [])).forEach((c) => {
    if (c.level === "warn") {
      if (!c.ok) validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      return;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
}

// ── Offer request options (#780) ─────────────────────────────────────────────

/**
 * After 01: do the offers keep to the offerSearchCriteria the request sent?
 * A warning per option no offer keeps to, or that the provider says it
 * ignored; an INFO line otherwise. In an offer search probe (#780 part 2,
 * `offerSearchProbe`), each option is a test, failed in those two cases: the
 * probe exists because the Test Framework declares the value.
 */
function checkOfferSearchCriteria(jsonData) {
  const raw = bru.getEnvVar("offerSearchCriteria");
  let criteria = raw;
  if (typeof raw === "string") {
    try { criteria = JSON.parse(raw); } catch { criteria = null; }
  }
  const { ignoredParameters } = require('./ignoredParameters.js');
  const { checkOfferCriteria } = require('./offerCriteria.js');
  const probe = String(bru.getEnvVar("offerSearchProbe")) === "true";
  // #780 PR B: the trips keep to the trip search parameters sent.
  const { checkTripParameters } = require('./tripParameters.js');
  const tripCriteria = parseEnvJson("offerTripSearchCriteria", null);
  const ignored = ignoredParameters(jsonData);
  [...checkOfferCriteria(criteria, jsonData, ignored), ...checkTripParameters(tripCriteria, jsonData, ignored)].forEach((c) => {
    if (probe) {
      if (!c.ok && c.level !== 'warn') validationLogger(`[INFO] ${c.name} — ${c.message}`);
      test(c.name, () => { if (!c.ok && c.level === 'warn') throw new Error(c.message); });
    } else if (c.ok) {
      validationLogger(`[INFO] ✔ ${c.name}`);
    } else {
      validationLogger(`[${c.level === 'warn' ? 'WARNING' : 'INFO'}] ${c.name} — ${c.message}`);
    }
  });
}

/** #781: after 01, the offers are in the currency expected, and the sale's is kept. */
function checkOfferCurrency(jsonData) {
  require('./currencies.js').checkSaleCurrency(jsonData, chosenOffer());
}

// ── Travel class per leg (#600) ──────────────────────────────────────────────

/**
 * After the offer step of a scenario that names a class per leg: one check
 * per leg of the chosen offer, saying how its class is given (its admission,
 * or a supplement on the leg).
 */
function checkOfferLegClasses(jsonData) {
  const expected = parseEnvJson("legTravelClasses", null);
  if (!Array.isArray(expected)) return;
  const { checkLegClasses, classesOfOffer } = require('./legClasses.js');
  // #762: none of the offers had the classes asked; the booking is held to
  // the classes of the offer sold instead ("unknown" when one leg reads none).
  if (bru.getEnvVar("__legClassesNotOffered") === "true") {
    const sold = classesOfOffer(chosenOffer(), jsonData?.trips);
    bru.setEnvVar("__legClassesSold", sold ? JSON.stringify(sold) : "unknown");
    validationLogger(`[INFO] Offer chosen: classes per leg [${sold ? sold.join(", ") : "not readable"}]; the booking is checked against them.`);
    return;
  }
  checkLegClasses("Offer", chosenOffer(), jsonData?.trips, expected).forEach((c) => {
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
}

// ── Place selection flow (#766) ──────────────────────────────────────────────

/**
 * After the offer step: what the chosen offer says of the scenario's place
 * selection flow (supportedPlaceSelectionFlows) and the preferences it offers
 * (availablePlacePreferences). A flow it does not list is a warning.
 */
function checkOfferPlaceSelection() {
  bru.setEnvVar("__placePreferencesSent", JSON.stringify([]));
  bru.setEnvVar("__placePreferencesListed", "false");
  bru.setEnvVar("__placePreferencesRetried", "false");
  bru.setEnvVar("__placePreferencesRefused", null);
  bru.setEnvVar("__namedPlaceChoices", null);
  bru.setEnvVar("__namedPlaceFees", null);
  const flow = bru.getEnvVar("placeSelectionFlow");
  if (!flow) return;
  const { describeOfferedFlow, choosePreferences } = require('./placeSelection.js');
  const offer = chosenOffer();
  for (const line of describeOfferedFlow(offer, flow)) validationLogger(`[${line.level}] ${line.text}`);
  // #766 PR 2: the seat preferences the booking asks for, among those the
  // offer lists; one it does not list is a warning.
  const chosen = choosePreferences(offer, parseEnvJson("placePreferences", []));
  for (const line of chosen.lines) validationLogger(`[${line.level}] ${line.text}`);
  bru.setEnvVar("__placePreferencesSent", JSON.stringify(chosen.send));
  bru.setEnvVar("__placePreferencesListed", chosen.listed ? "true" : "false");
}

/**
 * 02's after-response, before its status check (#766 PR 3). A booking refused
 * while it asked for seat preferences is sent once more without them: true
 * when 02 is to be sent again. On the second answer, says whether it was the
 * preference or the reservation that was refused.
 */
function bookingWithoutPreferences(status, body) {
  const ps = require('./placeSelection.js');
  const refused = parseEnvJson("__placePreferencesRefused", null);
  if (refused && typeof refused === "object") {
    bru.setEnvVar("__placePreferencesRefused", null);
    const outcome = ps.afterRetryWithoutPreferences(status, refused);
    if (outcome.fail) test(`Booking: takes the seat preferences the offer lists (${refused.preferences.join(', ')})`, () => { throw new Error(outcome.text); });
    else validationLogger(`[${outcome.level}] ${outcome.text}`);
    return false;
  }
  const sent = parseEnvJson("__placePreferencesSent", []);
  if (!ps.retryWithoutPreferences(status, sent, bru.getEnvVar("__placePreferencesRetried") === "true")) return false;
  const code = body && typeof body === "object" ? (body.code || body.title || "") : "";
  bru.setEnvVar("__placePreferencesRetried", "true");
  bru.setEnvVar("__placePreferencesRefused", JSON.stringify({ status, code, preferences: sent, listed: bru.getEnvVar("__placePreferencesListed") === "true" }));
  bru.setEnvVar("__placePreferencesSent", JSON.stringify([]));
  const answer = code ? `HTTP ${status}, ${code}` : `HTTP ${status}`;
  validationLogger(`[WARNING] Seat preferences ${sent.join(', ')}: the booking asking for them was refused (${answer}); it is sent once more without them, to tell a refused preference from a refused reservation.`);
  return true;
}

/**
 * Before the booking, in the PREFERENCES flow (#766 PR 2): GET
 * /availabilities/preferences for each reservation the booking places, once
 * per offer. A preference no longer available is a warning and is not asked.
 * The checks are kept in __placePreferencesOutcome and recorded by 02's
 * after-response (a before-request records none).
 */
async function askPlacePreferences(afterBooking = false) {
  if (bru.getEnvVar("placeSelectionFlow") !== "AUTOMATIC_PLACE_SELECTION_PREFERENCES") return;
  const send = parseEnvJson("__placePreferencesSent", []);
  const ctx = placeChoiceContext(afterBooking);
  if (!Array.isArray(send) || send.length === 0 || !ctx.contextId || bru.getEnvVar("__placePreferencesAskedFor") === ctx.key) return;
  bru.setEnvVar("__placePreferencesAskedFor", ctx.key);
  const ps = require('./placeSelection.js');
  const ids = ctx.ids;
  if (ids.length === 0) {
    if (!afterBooking && !placeChoiceAfterBooking()) validationLogger("[WARNING] Seat preferences: no reservation is placed in the booking, so GET /availabilities/preferences is not asked.");
    return;
  }
  const answers = await Promise.all(ids.map((id) => sendAvailabilityRequest(ps.preferencesQuery(ctx.contextId, id, ctx.contextType))));
  const checks = [];
  let available = send;
  for (const [i, id] of ids.entries()) {
    const outcome = ps.checkPreferenceAvailability(answers[i].status, answers[i].body, id, available);
    checks.push(...outcome.checks);
    for (const line of outcome.lines) validationLogger(`[${line.level}] ${line.text}`);
    available = outcome.available;
  }
  bru.setEnvVar("__placePreferencesSent", JSON.stringify(available));
  bru.setEnvVar("__placePreferencesOutcome", JSON.stringify({ checks }));
}

// A request to an availability resource (#766), with the headers of the
// offer request: a GET, or a POST of `body`; { status, body }, status 0 when
// it could not be sent.
async function sendAvailabilityRequest(path, payload) {
  return sendOsdmRequest(payload === undefined ? "GET" : "POST", path, payload);
}

// A request to the provider sent from a step's script: GET, POST (with a
// body) or DELETE. { status, body }; status 0 when it could not be sent.
async function sendOsdmRequest(method, path, payload) {
  const { requestorHeader } = require("./requestHeaders.js");
  const post = payload !== undefined;
  try {
    const res = await new Promise((resolve, reject) => {
      bru.sendRequest({
        url: `${bru.getEnvVar("api_base")}${path}`,
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${bru.getEnvVar("access_token")}`,
          ...(post ? { "Content-Type": `application/json;version=${bru.getEnvVar("osdmVersion")}` } : {}),
          ...requestorHeader(bru.getEnvVar("requestor")),
        },
        ...(post ? { data: JSON.stringify(payload) } : {}),
      }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
    });
    let body = res?.data ?? res?.body ?? null;
    if (body instanceof Uint8Array) body = new TextDecoder().decode(body);
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    return { status: res?.status || res?.statusCode || 0, body };
  } catch (err) {
    validationLogger(`[ERROR] ${method} ${path.split("?")[0]} could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

/** 02's after-response: records the checks of the availability requests asked before it, once. */
function recordPlacePreferenceChecks() {
  for (const name of ["__placePreferencesOutcome", "__namedPlacesOutcome", "__nearbyOutcome"]) {
    const outcome = parseEnvJson(name, null);
    if (!outcome) continue;
    bru.setEnvVar(name, null);
    recordChecks(outcome.checks || []);
  }
}

/**
 * Before the booking, in the NEARBY flow (#766 PR 4): GET
 * /availabilities/nearby for each reservation the booking places, near the
 * scenario's reference place, once per offer. The reference place is then
 * sent in the booking (requestsBuilder).
 */
async function askNearbyPlace(afterBooking = false) {
  const np = require('./namedPlaces.js');
  const ctx = placeChoiceContext(afterBooking);
  // #776: the reference place taken from a first booking, made here: before
  // the booking, or before 09 when the reservation is added after it.
  if (afterBooking || !placeChoiceAfterBooking()) await makeReferenceBooking(ctx.ids);
  const ref = parseEnvJson("nearbyReference", null);
  if (!ref || bru.getEnvVar("placeSelectionFlow") !== "AUTOMATIC_PLACE_SELECTION_NEARBY" || !ctx.contextId || bru.getEnvVar("__nearbyAskedFor") === ctx.key) return;
  bru.setEnvVar("__nearbyAskedFor", ctx.key);
  const ids = ctx.ids;
  if (ids.length === 0) {
    if (!afterBooking && !placeChoiceAfterBooking()) validationLogger("[WARNING] Nearby place: no reservation is placed in the booking, so no place near the reference is asked.");
    return;
  }
  const answers = await Promise.all(ids.map((id) => sendAvailabilityRequest(np.nearbyQuery(ctx.contextId, id, ref, ctx.contextType))));
  const checks = [];
  for (const [i, id] of ids.entries()) {
    const outcome = np.checkNearbyAnswer(answers[i].status, answers[i].body, id, ref);
    checks.push(...outcome.checks);
    for (const line of outcome.lines) validationLogger(`[${line.level}] ${line.text}`);
  }
  bru.setEnvVar("__nearbyOutcome", JSON.stringify({ checks }));
}

/**
 * #776: the reference place of the NEARBY flow from a first booking. Step
 * 01's offer request is sent again for the first passenger alone (A), the
 * offer standing for the chosen one is booked with its reservations, and the
 * place A is given becomes `nearbyReference`. Once per sale; nothing when the
 * scenario names its own reference place, or when no reservation is placed.
 * A failure is a warning: the scenario then goes on without a reference place.
 */
async function makeReferenceBooking(reservationIds) {
  if (String(bru.getEnvVar("nearbyReferenceAuto")) !== "true" || String(bru.getEnvVar("__referenceBookingTried")) === "true") return;
  if (bru.getEnvVar("placeSelectionFlow") !== "AUTOMATIC_PLACE_SELECTION_NEARBY" || reservationIds.length === 0) return;
  bru.setEnvVar("__referenceBookingTried", "true");
  const rb = require("./referenceBooking.js");
  const skip = (why) => validationLogger(`[WARNING] Nearby place: no reference place, ${why}; the place near another passenger is not tested.`);
  const request = rb.referenceOfferRequest(parseEnvJson("OfferCollectionRequest", null));
  if (!request) {
    skip("the offer request names no passenger to book first");
    return;
  }
  const offers = await sendOsdmRequest("POST", "/offers", request.body);
  const pick = offers.status >= 200 && offers.status < 300 ? rb.referenceOffer(chosenOffer(), offers.body?.offers) : null;
  if (!pick) {
    skip(`the offers asked for passenger ${request.passengerRef} alone (HTTP ${offers.status}) hold no reservation`);
    return;
  }
  const passenger = (parseEnvJson("bookingPassengerSpecifications", []) || []).find((p) => p?.externalRef === request.passengerRef)
    || (parseEnvJson("bookingPassengerSpecifications", []) || [])[0];
  const body = rb.referenceBookingRequest({ offer: pick.offer, trips: offers.body?.trips, passenger, purchaser: parseEnvJson("bookingPurchaserSpecifications", null), passengerRef: request.passengerRef });
  if (!body) {
    skip("passenger A's booking could not be built");
    return;
  }
  const booked = await sendOsdmRequest("POST", "/bookings", body);
  const place = booked.status >= 200 && booked.status < 300 ? rb.placeOfReferenceBooking(booked.body) : null;
  if (place?.bookingId) bru.setEnvVar("__referenceBookingId", place.bookingId);
  if (!place) {
    skip(`passenger ${request.passengerRef}'s booking on offer ${pick.offer.offerId} was refused (HTTP ${booked.status}${booked.body?.code ? ", " + booked.body.code : ""})`);
    return;
  }
  if (place.missing) {
    skip(`passenger ${request.passengerRef}'s booking ${place.bookingId}: ${place.missing}`);
    return;
  }
  bru.setEnvVar("nearbyReference", JSON.stringify({ coachNumber: place.coachNumber, placeNumber: place.placeNumber }));
  validationLogger(`[INFO] Nearby place: the reference place is ${place.coachNumber}/${place.placeNumber}, given to passenger ${request.passengerRef} alone in booking ${place.bookingId} (offer ${pick.offer.offerId}, ${pick.how}); the scenario's booking asks for places near it.`);
}

/**
 * #776: passenger A's booking is deleted once the scenario's booking (02, or
 * 09 for a reservation added later) has been answered. A booking not deleted
 * is a warning naming it: it expires on its own if it was only pre-booked.
 */
async function releaseReferenceBooking() {
  const id = bru.getEnvVar("__referenceBookingId");
  if (!id) return;
  bru.setEnvVar("__referenceBookingId", null);
  const res = await sendOsdmRequest("DELETE", `/bookings/${encodeURIComponent(id)}`);
  if (res.status >= 200 && res.status < 300) {
    validationLogger(`[INFO] Nearby place: passenger A's booking ${id} (the reference place) is deleted (HTTP ${res.status}).`);
  } else {
    validationLogger(`[WARNING] Nearby place: passenger A's booking ${id} (the reference place) could not be deleted (HTTP ${res.status}${res.body?.code ? ", " + res.body.code : ""}); it stays pre-booked until it expires.`);
  }
}

/**
 * Before the booking, in a manual flow (#766 PR 3): POST
 * /availabilities/vehicle-place-map for the reservations the booking places,
 * once per offer, and the places (or compartment) to name for each. Nothing
 * to choose is a warning; the booking then names no place.
 */
async function askNamedPlaces(afterBooking = false) {
  const np = require('./namedPlaces.js');
  const kind = bru.getEnvVar("namedPlaceKind");
  const flow = bru.getEnvVar("placeSelectionFlow");
  const ctx = placeChoiceContext(afterBooking);
  if (!kind || !np.isManual(flow) || !ctx.contextId || bru.getEnvVar("__namedPlacesAskedFor") === ctx.key) return;
  bru.setEnvVar("__namedPlacesAskedFor", ctx.key);
  const offer = chosenOffer();
  const ids = ctx.ids;
  if (ids.length === 0) {
    if (!afterBooking && !placeChoiceAfterBooking()) validationLogger("[WARNING] Named place: no reservation is placed in the booking, so the place map is not asked.");
    return;
  }
  const bookingRefs = parseEnvJson("bookingPassengerReferences", []) || [];
  const reservations = ids.map((id) => {
    const part = (offer?.reservationOfferParts || []).find((p) => p?.id === id);
    const refs = Array.isArray(part?.passengerRefs) && part.passengerRefs.length > 0 ? part.passengerRefs : bookingRefs;
    return { id, passengerRefs: refs };
  });
  const res = await sendAvailabilityRequest('/availabilities/vehicle-place-map', np.placeMapRequest(ctx.contextId, ids, ctx.contextType));
  const answer = np.checkPlaceMapAnswer(res.status, res.body);
  for (const line of answer.lines) validationLogger(`[${line.level}] ${line.text}`);
  bru.setEnvVar("__namedPlacesOutcome", JSON.stringify({ checks: answer.checks }));
  if (!answer.map) return;
  const chosen = np.chooseNamedPlaces(answer.map, { flow, kind, reservations });
  for (const line of chosen.lines) validationLogger(`[${line.level}] ${line.text}`);
  for (const [id, choice] of Object.entries(chosen.choices)) {
    const fee = chosen.fees[id] ? ` (selection fee ${chosen.fees[id]})` : '';
    validationLogger(`[INFO] Named place for reservation ${id}: ${np.describeChoice(choice)}${fee}.`);
  }
  // After the booking, the choices join those made for the booking (#766 PR 5).
  const before = (name) => (afterBooking ? parseEnvJson(name, {}) || {} : {});
  bru.setEnvVar("__namedPlaceChoices", JSON.stringify({ ...before("__namedPlaceChoices"), ...chosen.choices }));
  bru.setEnvVar("__namedPlaceFees", JSON.stringify({ ...before("__namedPlaceFees"), ...chosen.fees }));
}

/**
 * Where the availability requests of a place choice are asked (#766 PR 5):
 * before the booking, for the offer and the reservations the booking places;
 * after it, for the booking and the reservations 09 adds (ADD_LATER). `key`
 * keeps each ask to once per offer, and once per booking.
 */
function placeChoiceContext(afterBooking) {
  const idsOf = (selections) => [...new Set(selections.map((p) => p?.reservationId).filter(Boolean))];
  if (afterBooking) {
    const bookingId = bru.getEnvVar("bookingId");
    return { contextId: bookingId, contextType: "BOOKING", key: `BOOKING:${bookingId}`, ids: idsOf(parseEnvJson("reservationAddLaterSelections", []) || []) };
  }
  const offerId = bru.getEnvVar("offerId");
  return { contextId: offerId, contextType: "OFFER", key: offerId, ids: idsOf([...parseEnvJson("placeSelections", []), ...parseEnvJson("reservationPlaceSelections", [])]) };
}

/** Whether 09 adds reservations after the booking (ADD_LATER), where the place choice is made then. */
function placeChoiceAfterBooking() {
  return bru.getEnvVar("reservationBookingForm") === "ADD_LATER" && (parseEnvJson("reservationAddLaterSelections", []) || []).length > 0;
}

/**
 * Before 09 adds the optional reservations after the booking (ADD_LATER):
 * the same availability requests as before a booking, in a BOOKING context
 * (#766 PR 5). Their checks are recorded by 09's after-response.
 */
async function askPlacesAfterBooking() {
  await askPlacePreferences(true);
  await askNamedPlaces(true);
  await askNearbyPlace(true);
}

// ── Group tariffs (#599) ─────────────────────────────────────────────────────

// Records checks: a failed warning-level check is a [WARNING] line, the others
// are tests.
function recordChecks(checks) {
  checks.forEach((c) => {
    if (c.level === "warn") {
      if (!c.ok) validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      return;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
}

/**
 * After an offer step of a COLLECTIVE request: the chosen offer holds one
 * COLLECTIVE admission for the whole group on each trip, with the passenger
 * types applied. Nothing for any other request.
 */
function checkGroupOffer() {
  const { collectiveAsked, checkCollectiveOffer } = require('./groupOffers.js');
  const request = parseEnvJson("OfferCollectionRequest", {});
  if (!collectiveAsked(request)) return;
  const refs = listOfRefs(request.anonymousPassengerSpecifications);
  recordChecks(checkCollectiveOffer(chosenOffer(), refs));
}

const listOfRefs = (specs) => (Array.isArray(specs) ? specs.map((p) => p?.externalRef).filter(Boolean) : []);

// Whether the outbound group offer is still to be compared with the same
// search in the INDIVIDUAL mode (01d).
function groupCompareDue() {
  const { collectiveAsked } = require('./groupOffers.js');
  return collectiveAsked(parseEnvJson("OfferCollectionRequest", {})) && String(bru.getEnvVar("__groupPriceCompareDone")) !== "true";
}

/** 01d: the chosen group offer against the same search in the INDIVIDUAL mode. */
function compareGroupOfferIndividual(status, body) {
  const { compareGroupWithIndividual } = require('./groupOffers.js');
  bru.setEnvVar("__groupPriceCompareDone", "true");
  if (status !== 200) {
    validationLogger(`[WARNING] Group offer: the INDIVIDUAL offer request answered ${status}; prices not compared.`);
    return;
  }
  recordChecks(compareGroupWithIndividual(chosenOffer(), { ...body, offers: searchTripOffers(body) }));
}

/**
 * Where the flow goes after the outbound offer: the comparison of a group
 * offer with the INDIVIDUAL search (01d, #599), the inbound offer of a return
 * (#178, #594), the seat map before booking (#104), or the booking. Shared by
 * 01, 01c and 01d, which come between them.
 */
// ── Offers by trip ids (#602) ─────────────────────────────────────────────
// Called by 01's before-request once the offer request is built. With
// offersByTripIds, it asks POST /trips-collection with the search's origin,
// destination and time, chooses a trip (tripIds.js) and asks the offers for
// it by id. The call is made from here, not from a request of its own, so
// that every way into 01 (a retry, the next scenario, the rerun after an
// expired offer) asks the trips again. Its checks are recorded by 01's
// after-response (checkOfferRequestByTripIds), with the offer's. With
// tripIdsExpectRejection, an id the provider never gave is sent instead.
async function prepareOfferRequestByTripIds() {
  bru.setEnvVar("__tripIdsOutcome", null);
  const probe = String(bru.getEnvVar("tripIdsExpectRejection")) === "true";
  if (!probe && String(bru.getEnvVar("offersByTripIds")) !== "true") return;
  const ti = require("./tripIds.js");
  const request = parseEnvJson("OfferCollectionRequest", {}) || {};
  if (probe) {
    bru.setEnvVar("OfferCollectionRequest", JSON.stringify(ti.offerRequestByTripIds(request, ti.UNKNOWN_TRIP_ID)));
    bru.setEnvVar("__tripIdsOutcome", JSON.stringify({ probe: true }));
    validationLogger(`[INFO] 🧪 Trip id probe — POST /offers names trip "${ti.UNKNOWN_TRIP_ID}", which the provider never gave; a refusal is expected.`);
    return;
  }
  const search = ti.tripsCollectionRequest(parseEnvJson("offerTripSearchCriteria", null));
  if (!search) {
    bru.setEnvVar("__tripIdsOutcome", JSON.stringify({ checks: [{ name: "Trips collection: the scenario's SEARCH trip gives an origin and a destination", ok: false, message: "no tripSearchCriteria to ask the trips with" }], failed: true }));
    return;
  }
  validationLogger(`[INFO] 🚆 Offers by trip id — POST /trips-collection: ${search.origin.stopPlaceRef} → ${search.destination.stopPlaceRef} at ${search.departureTime || search.arrivalTime}`);
  const { status, body, raw } = await sendTripsCollection(search);
  const checks = ti.checkTripsCollection(status, body, search);
  const choice = status === 200 ? ti.chooseTrip(body?.trips, { vehicleNumber: bru.getEnvVar("tripVehicleNumber"), departureTime: search.departureTime }) : { trip: null };
  if (status === 200) {
    checks.push({ name: `Trips collection: a trip to ask offers for — ${choice.trip ? choice.how + ", " + choice.trip.id : "none"}`, ok: !!choice.trip, message: choice.reason });
  }
  if (!choice.trip) {
    reportNoTrip(status, body, raw, checks);
    return;
  }
  bru.setEnvVar("OfferCollectionRequest", JSON.stringify(ti.offerRequestByTripIds(request, choice.trip.id)));
  bru.setEnvVar("__tripIdsOutcome", JSON.stringify({ checks, tripId: choice.trip.id }));
  validationLogger(`[INFO] 🚆 Offers by trip id — ${body.trips.length} trip(s) answered; asking offers for ${choice.how}: ${choice.trip.id}`);
}

// No trip to ask offers for: the checks fail the step, and the log says what
// the trip search answered (#729), or what it was when not JSON (#764).
function reportNoTrip(status, body, raw, checks) {
  const ti = require("./tripIds.js");
  bru.setEnvVar("__tripIdsOutcome", JSON.stringify({ checks, failed: true }));
  if (status === 200) {
    const lines = body == null && raw ? ti.describeRawAnswer(raw.text, raw.contentType) : ti.describeTripsAnswer(body);
    for (const line of lines) validationLogger(`[INFO] POST /trips-collection: ${line}`);
  }
  validationLogger("[WARNING] Offers by trip id: no trip to ask offers for — the offer request goes out by search criteria, and its answer is not used.");
}

// POST /trips-collection (#602), with the headers of the offer request; no
// Requestor header when none is set (#692, #764). { status, body, raw }:
// status 0 when it could not be sent; raw holds the text and Content-Type of
// an answer that is not JSON, for the log.
async function sendTripsCollection(search) {
  const { requestorHeader } = require("./requestHeaders.js");
  try {
    const res = await new Promise((resolve, reject) => {
      bru.sendRequest({
        url: `${bru.getEnvVar("api_base")}/trips-collection`,
        method: "POST",
        headers: {
          "Content-Type": `application/json;version=${bru.getEnvVar("osdmVersion")}`,
          Accept: "application/json",
          Authorization: `Bearer ${bru.getEnvVar("access_token")}`,
          ...requestorHeader(bru.getEnvVar("requestor")),
        },
        data: JSON.stringify(search),
      }, (err, r) => (err && !err.response ? reject(err) : resolve(r || err.response)));
    });
    let body = res?.data ?? res?.body ?? null;
    let raw = null;
    if (body instanceof Uint8Array) body = new TextDecoder().decode(body);
    if (typeof body === "string") {
      const headers = res?.headers || {};
      raw = { text: body, contentType: headers["content-type"] ?? headers["Content-Type"] ?? null };
      try { body = JSON.parse(body); raw = null; } catch { body = null; }
    }
    return { status: res?.status || res?.statusCode || 0, body, raw };
  } catch (err) {
    validationLogger(`[ERROR] POST /trips-collection could not be sent: ${err?.message || err}`);
    return { status: 0, body: null };
  }
}

// 01's after-response: records the checks of POST /trips-collection and of
// the offers asked by trip id, or grades the probe's refusal. True when the
// scenario stops here: the probe always ends it, and so does a trip search
// that gave no trip.
function checkOfferRequestByTripIds(status, body) {
  const outcome = parseEnvJson("__tripIdsOutcome", null);
  if (!outcome) return false;
  if (outcome.probe) {
    // #772: "no offer" for a trip the provider never gave is a right answer,
    // as for a departure out of range (#704).
    const offers = Array.isArray(body?.offers) ? body.offers : null;
    if (typeof status === "number" && status >= 200 && status < 300 && offers?.length === 0) {
      test("🧪 Trip id probe: no offer for a trip the provider never gave", () => {});
      return true;
    }
    const { validateProblemResponse } = require("./requestedInformation.js");
    validateProblemResponse({
      status,
      body,
      targets: [{ scenarioField: "tripIds" }],
      prefix: "🧪 Trip id probe",
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => validationLogger(`[${level}] ${msg}`),
    });
    if (typeof status === "number" && status < 300) {
      validationLogger("[WARNING] Trip id probe: the provider answered offers for a trip it never gave.");
    }
    return true;
  }
  recordChecks(outcome.checks || []);
  if (outcome.failed) return true;
  if (status === 200) recordChecks(require("./tripIds.js").checkOffersForTrip(body, outcome.tripId));
  return false;
}

function routeAfterOfferStep() {
  if (groupCompareDue()) {
    bru.runner.setNextRequest("01d. POST Get Offer Individual");
    return;
  }
  const isReturn = !!bru.getEnvVar("returnInboundDate");
  if (isReturn && bru.getEnvVar("__returnInboundDone") !== "true") {
    bru.setEnvVar("outboundOfferId", bru.getEnvVar("offerId"));
    // The chosen offer's trip, for returnSearchParameters.outboundTripIds
    // (COMBINED): its tripCoverage, else its first part's.
    const chosen = chosenOffer() || {};
    const firstPart = (chosen.admissionOfferParts || [])[0] || {};
    const tripId = chosen.tripCoverage?.coveredTripId || firstPart.tripCoverage?.coveredTripId || null;
    bru.setEnvVar("outboundTripId", tripId);
    bru.setGlobalEnvVar("skipPlaceMaps", true);
    console.log("[INFO] 🔁 Return scenario — outbound offer captured (" + bru.getEnvVar("offerId") + "); fetching the inward (return) offer.");
    bru.runner.setNextRequest("01b. POST Get Return Offer");
    return;
  }
  const psMode = bru.getEnvVar("placeSelectionMode");
  const psOptIn = String(bru.getEnvVar("salesFlow_placeSelection")) === "true";
  const reqPlace = bru.getEnvVar("requiresPlaceSelection");
  const runPlaceMap = (psMode === "SEATMAP_AT_OFFER" && psOptIn) || (reqPlace === true || reqPlace === "true");
  // #652: only to a seat map the run filter will not skip (it needs a
  // reservation of this offer, and no booking yet). A skipped step runs no
  // script, so its "go on to 02" never came: Bruno went on down the folder,
  // skipping every step, and reached the refund with no booking.
  const mapAsked = runPlaceMap && !!bru.getEnvVar("reservationId") && !bru.getEnvVar("bookingId");
  if (runPlaceMap && !mapAsked) {
    console.log("[INFO] No seat map for this offer (no reservation part, or a booking already exists): going on to the booking.");
  }
  if (mapAsked) {
    bru.setGlobalEnvVar("skipPlaceMaps", false);
    bru.runner.setNextRequest("08. GET Place Maps");
  } else {
    bru.runner.setNextRequest("02. POST Create Booking");
    bru.setGlobalEnvVar("skipPlaceMaps", true);
  }
}
