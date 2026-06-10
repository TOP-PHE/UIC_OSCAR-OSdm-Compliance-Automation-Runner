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
const { bruTest: test } = require('./testCapture.js');
const { OSDM_PASSENGER_TYPES } = require('./osdmEnums.js');
const { parseEnvJson } = require('./envUtils.js');
const { processRequestedInformation } = require('./requestedInformation.js');

module.exports = {
  checkWarningsAndProblems,
  postOfferResponsePreRequest,
  ensureAuthorizationOr403,
  postOfferResponse,
  selectAndSetOffer,
  validateOfferSummary,
  validatePassengers,
  validateTripsAndLegs,
  validateOfferParts,
  validateAdmissions,
  validateReservations,
  validateAncillaries,
  getTripLegCoverage,
  handleAccommodationAndPlaceSelection,
  ensureYesWhenRefundOrExchangeSelected,
  deriveOfferFlexibilityFromProducts,
  offerFlexibility
};

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
        .filter((k) => p && p[k] != null && p[k] !== "")
        .map((k) => `${k}=${JSON.stringify(p[k])}`);
      return parts.length ? parts.join(", ") : JSON.stringify(p);
    };
    const warnings = Array.isArray(jsonData.warnings) ? jsonData.warnings : [];
    const problems = Array.isArray(jsonData.problems) ? jsonData.problems : [];

    warnings.forEach((w, i) => {
      validationLogger(`[WARNING] ⚠️ Response envelope warning ${i + 1}/${warnings.length}: ${_fmt(w)}`);
    });
    problems.forEach((p, i) => {
      const ptr = Array.isArray(p.pointers) && p.pointers.length > 0
        ? ` — pointer(s): ${p.pointers.map((x) => `${(x && x.code) || "?"} @ ${(x && x.requestPointer) || "?"}`).join("; ")}`
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

  function resolveVars(str) {
    if (!str) return str;
    return String(str).replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
      const v = bru.getEnvVar(varName);
      return v == null ? '' : String(v);
    });
  }

  try {
    const urlStr = (typeof req !== 'undefined' && req.getUrl) ? String(req.getUrl()) : '';
    const method = (typeof req !== 'undefined' && req.getMethod) ? req.getMethod() : 'GET';

    const resolvedUrl = resolveVars(urlStr);

    // Attempt to copy headers if possible
    let resolvedHeaders = {};
    try {
      const headersObj = req.getHeaders && req.getHeaders();
      // Try common shapes: getAll() or entries()
      if (headersObj && typeof headersObj.getAll === 'function') {
        const arr = headersObj.getAll();
        arr.forEach(h => {
          if (h && h.key) resolvedHeaders[h.key] = resolveVars(h.value);
        });
      } else if (headersObj && typeof headersObj.entries === 'function') {
        for (const { key, value } of headersObj.entries()) {
          resolvedHeaders[key] = resolveVars(value);
        }
      }
    } catch (e) {
      console.log('[DEBUG] [offers] preflight header extraction failed, continuing without headers: ' + (e && e.message));
    }

    // Best-effort body resolve (may be empty in pre-request)
    let resolvedBody = null;
    try {
      const rawBody = req.getBody && req.getBody();
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
      console.log('[DEBUG] [offers] preflight body resolution failed, continuing without body: ' + (e && e.message));
    }

    // Preflight call using bru.sendRequest
    if (resolvedBody) {
      resolvedHeaders['Content-Type'] = resolvedHeaders['Content-Type'] || 'application/json';
    }
    // bru.sendRequest expects headers as array of {key, value} objects (Postman/Bruno format)
    const headersArray = Object.entries(resolvedHeaders).map(([key, value]) => ({ key, value }));
    const bodyStr = resolvedBody
      ? (typeof resolvedBody === 'string' ? resolvedBody : JSON.stringify(resolvedBody))
      : undefined;
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
    const _wrn   = Array.isArray(jsonData.warnings)   ? jsonData.warnings.length   : 0;
    const _prb   = Array.isArray(jsonData.problems)   ? jsonData.problems.length   : 0;
    // #355: no standalone validationLogger before the throw — the caller
    // re-throws inside bruTest("Offers found in response", …) whose failure
    // echo prints this exact message, so logging here showed it TWICE.
    if (!Array.isArray(jsonData.offers)) {
      throw new Error(`POST /offers response has no offers[] array (got ${jsonData.offers === undefined ? "no 'offers' property" : typeof jsonData.offers}) — malformed OfferCollectionResponse envelope.`);
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
      expect(isNaN(createdOnDate.getTime()), `createdOn is not a valid date: ${offer.createdOn}`).to.be.false;
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

  // #expired-offer: stash the earliest validUntil across all parts of the
  // SELECTED offer (OSDM AbstractOfferPart.validUntil — admission, reservation,
  // ancillary, fareAdmission, fareReservation, fareAncillary, …). The shared
  // expiredFlow.js helper will read this in 02. POST Create Booking's
  // before-request if expiredOfferTest is on, wait past the earliest
  // validUntil, then fire the booking and assert the provider rejects it.
  //
  // Earliest, not latest: a SINGLE expired part is enough for the booking to
  // be invalid — the booking is only as valid as its earliest-expiring part.
  if (selectedOffer && typeof selectedOffer === 'object') {
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
        if (p && p.validUntil) {
          const t = new Date(p.validUntil).getTime();
          if (!isNaN(t) && t < _earliestMs) {
            _earliestMs  = t;
            _earliestRaw = p.validUntil;
            _earliestSrc = `selectedOffer.${pt}[${i}].validUntil`;
          }
        }
      });
    });
    if (_earliestRaw) {
      bru.setEnvVar('offerValidUntil', String(_earliestRaw));
      bru.setEnvVar('offerValidUntilSource', String(_earliestSrc));
      validationLogger(`[INFO] Earliest offer-part validUntil = ${_earliestRaw} (${_earliestSrc}) — drives the #expiredOfferTest deadline if enabled.`);
    } else {
      bru.setEnvVar('offerValidUntil', '');
      bru.setEnvVar('offerValidUntilSource', '');
      validationLogger('[DEBUG] Selected offer has no validUntil on any part — #expiredOfferTest (if on) will skip with a WARNING.');
    }
  }

  validateOfferSummary(selectedOffer);
  validatePassengers(jsonData);
  validateOfferParts(selectedOffer);
  validateTripsAndLegs(jsonData);
  validateAdmissions(selectedOffer);
  validateReservations(selectedOffer);
  validateAncillaries(selectedOffer);

  handleAccommodationAndPlaceSelection(selectedOffer);

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
      if (_matchPart && _matchPart.validUntil) {
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

  // Mirror original no-op env set (kept for compatibility)
  bru.setEnvVar("admissionReservationAncillaryOfferPartsIds", bru.getEnvVar("admissionReservationAncillaryOfferPartsIds"));
}

// OSDM Flexibility ordered least → most restrictive. An offer's overall
// flexibility is the MOST RESTRICTIVE of its products: a multi-leg journey is
// only as flexible as its least-flexible leg (e.g. TGV FULL_FLEXIBLE + TER
// NON_FLEXIBLE → the offer is NON_FLEXIBLE). Unknown/vendor-specific values are
// ignored for the aggregation. (#223)
const FLEX_ORDER = ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'];

function deriveOfferFlexibilityFromProducts(offer) {
  const flits = ((offer && offer.products) || []).map(p => p && p.flexibility).filter(Boolean);
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
  return (offer && offer.offerSummary && offer.offerSummary.overallFlexibility)
    || deriveOfferFlexibilityFromProducts(offer);
}

// select and set offer based on criteria
function selectAndSetOffer(jsonData) {
  validationLogger("[DEBUG] ➤ selectAndSetOffer");

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

  let filteredOffers = jsonData.offers;

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

  // Apply flexibility filter if specified. offerSummary is OPTIONAL in OSDM, so
  // when a provider omits it we derive the offer's overall flexibility from its
  // products (most restrictive wins) instead of dropping every offer. (#223)
  if (desiredFlexibility) {
    validationLogger(`[DEBUG] Applying flexibility filter: ${desiredFlexibility}`);
    if (!filteredOffers.some(o => o.offerSummary && o.offerSummary.overallFlexibility)) {
      validationLogger(`[DEBUG] No offerSummary.overallFlexibility on these offers — deriving flexibility from offer products (most restrictive leg wins).`);
    }
    filteredOffers = filteredOffers.filter(o => offerFlexibility(o) === desiredFlexibility);
  }

  // Select the first matching offer or default to the first offer
  const selectedOffer = filteredOffers[0] || jsonData.offers[0];

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

  // Store selected offer and related info in environment
  bru.setEnvVar("offer", selectedOffer);
  bru.setEnvVar("offerId", selectedOffer.offerId);
  bru.setEnvVar("offers", jsonData.offers);

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

  function validateSelectedOfferAdmission(selOffer, scenarioTypeStr, overallFlexibility) {
    if (!selOffer?.admissionOfferParts) return;

    // Do nothing if not FULL_FLEXIBLE or SEMI_FLEXIBLE
    if (overallFlexibility !== "FULL_FLEXIBLE" && overallFlexibility !== "SEMI_FLEXIBLE") {
      validationLogger(`[DEBUG] overallFlexibility is '${overallFlexibility}' - skipping admissionOfferParts validation`);
      return;
    }

    function validateField(field, type) {
      const parts = selOffer.admissionOfferParts;
      const allYes = parts.every(p => p[field] === "YES");
      test(`All admissionOfferParts of selected offer are ${type} - expected: YES, actual: ${parts.map(p => p[field]).join(", ")}`, () => {
        validationLogger(`[DEBUG] All admissionOfferParts of selected offer are ${type} - expected: YES, actual: ${parts.map(p => p[field]).join(", ")}`);
        expect(allYes, `Expected all admissionOfferParts to be ${type}`).to.be.true;
        if (!allYes) {
          validationLogger(`[ERROR] Some admissionOfferParts are not ${type}`);
          throw new Error(`⛔ Stop: selected offer admissionOfferParts are not all ${type}`);
        }
      });
    }

    if (scenarioTypeStr?.includes("EXCHANGE")) validateField("exchangeable", "exchangeable");
    if (scenarioTypeStr?.includes("REFUND")) validateField("refundable", "refundable");
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

  // Check all price fields (amount, currency, scale) exist in minimalPrice
  test(`Price fields exist (currency, scale) exist in minimalPrice`, () => {
    expect(mini, 'minimalPrice is missing').to.exist;
    validationLogger(`[DEBUG] Price fields (currency, scale) are present in minimalPrice`);
    ['currency', 'scale'].forEach(field => {
      expect(mini[field], `minimalPrice.${field} missing`).to.exist;
    });
  });

  // Overall flexibility validation
  test(`Offer summary - overallFlexibility is defined - overallFlexibility: ${overallFlexibility}`, function () {
    validationLogger(`[DEBUG] Offer summary - overallFlexibility is defined - overallFlexibility: ${overallFlexibility}`);
    expect(overallFlexibility).to.be.a("string");
    bru.setEnvVar("overallFlexibility", overallFlexibility);
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
      expect(!isNaN(preBookableDate.getTime()), "preBookableUntil should be a valid ISO date").to.be.true;
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

    // type is a known OSDM value
    test(`Passenger ${i + 1} type is a known OSDM value - type: ${p.type}`, function () {
      validationLogger(`[DEBUG] Passenger ${i + 1} type valid value check: ${p.type}`);
      expect(p.type).to.be.oneOf(["YOUNG_CHILD", "CHILD", "YOUTH", "ADULT", "SENIOR", "FAMILY_CHILD", "ACCOMP_PRM", "PRM_CHILD", "WHEELCHAIR", "PERSON", "PRM", "DOG", "PET", "LUGGAGE", "BICYCLE", "PRAM", "COMPANION_DOG", "CAR", "MOTORCYCLE", "TRAILER"]);
    });

    // dateOfBirth is a valid date in the past (if present)
    if (p.dateOfBirth) {
      const dob = new Date(p.dateOfBirth);
      test(`Passenger ${i + 1} dateOfBirth is a valid date in the past - dateOfBirth: ${p.dateOfBirth}`, function () {
        validationLogger(`[DEBUG] Passenger ${i + 1} dateOfBirth: ${p.dateOfBirth}`);
        expect(!isNaN(dob.getTime()), "dateOfBirth should be a valid ISO date").to.be.true;
        expect(dob.getTime(), "dateOfBirth should be in the past").to.be.below(Date.now());
      });
    } else {
      validationLogger(`[DEBUG] Passenger ${i + 1} no dateOfBirth → test skipped`);
    }

    const reductionCards = p.appliedReductionCardTypes || [];
    test(`Passenger ${i + 1} reduction cards - reductionCards: ${JSON.stringify(reductionCards)}`, function () {
      validationLogger(`[DEBUG] Passenger ${i + 1} reduction cards - reductionCards: ${JSON.stringify(reductionCards)}`);
      expect(Array.isArray(reductionCards), "appliedReductionCardTypes should be an array").to.be.true;
    });
  });
}

// Trips & Legs validation
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
    if (!isNaN(tripStart.getTime()) && !isNaN(tripEnd.getTime())) {
      test(`Trip ${tripIndex + 1} startTime is before endTime (OSDM: temporal order)`, () => {
        expect(tripStart.getTime()).to.be.below(tripEnd.getTime(),
          `Trip startTime (${trip.startTime}) is not before endTime (${trip.endTime})`);
        validationLogger(`[DEBUG] Trip ${tripIndex + 1}: startTime=${trip.startTime}, endTime=${trip.endTime} ✓`);
      });
    } else {
      validationLogger(`[WARNING] Trip ${tripIndex + 1}: startTime or endTime is not a valid date → A7 test skipped`);
    }

    // direction is a known OSDM value
    test(`Trip ${tripIndex + 1} direction is a known value - direction: ${trip.direction}`, function () {
      validationLogger(`[DEBUG] Trip ${tripIndex + 1} direction: ${trip.direction}`);
      expect(trip.direction).to.be.oneOf(["OUT_BOUND", "IN_BOUND"]);
    });

    if (legs.length > 0) {
      test(`Trip ${tripIndex + 1} has legs - length: ${legs.length}`, function () {
        validationLogger(`[DEBUG] Trip ${tripIndex + 1} has legs - length: ${legs.length}`);
        expect(legs.length).to.be.above(0);
      });
    } else {
      validationLogger(`[DEBUG] Trip ${tripIndex + 1} has no legs (provider may not return legs) → test skipped`);
    }

    legs.forEach((leg, legIndex) => {
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

  test(`Offer minimalPrice >= sum of offerParts price - minimalPrice: ${minimalPrice}, sumPartsPrice: ${sumPartsPrice}`, function () {
    validationLogger(`[DEBUG] Offer minimalPrice >= sum of offerParts price - minimalPrice: ${minimalPrice}, sumPartsPrice: ${sumPartsPrice}`);
    expect(minimalPrice).to.be.at.least(sumPartsPrice);
  });

  // Flexibility consistency. The offer's overall flexibility is the MOST
  // RESTRICTIVE of its products (least-flexible leg governs the journey). When
  // the provider sends offerSummary.overallFlexibility we assert it matches that
  // derivation; when it omits offerSummary (OPTIONAL in OSDM) there is nothing to
  // be consistent with — we just log the derived value. (#223)
  const productFlex = Array.from(new Set((selectedOffer?.products || []).map(p => p.flexibility).filter(Boolean)));
  const derivedFlex = deriveOfferFlexibilityFromProducts(selectedOffer);
  const overallFlex = selectedOffer.offerSummary?.overallFlexibility;

  if (overallFlex) {
    test(`Offer overallFlexibility consistency - overallFlex: ${overallFlex}, derived (most restrictive): ${derivedFlex}`, () => {
      validationLogger(`[DEBUG] productFlex: ${productFlex.join(", ")}, derived (most restrictive): ${derivedFlex}`);
      // Log-audit round 2: plain throw with the decoded reasoning instead of
      // expect().to.eql and its chai tail ("expected 'FULL_FLEXIBLE' to
      // deeply equal 'NON_FLEXIBLE'").
      if (overallFlex !== derivedFlex) {
        throw new Error(
          `offerSummary.overallFlexibility says "${overallFlex}" but the most restrictive product flexibility in the offer is "${derivedFlex}" ` +
          `(product flexibilities: ${productFlex.join(", ") || "none"}). Per the least-flexible-part rule (#223) the summary should reflect ` +
          `the most restrictive product — typically the NON_FLEXIBLE reservations. Provider should align offerSummary.overallFlexibility with its products.`
        );
      }
    });
  } else {
    validationLogger(`[INFO] offerSummary absent — overall flexibility derived from products [${productFlex.join(", ")}] → most restrictive = ${derivedFlex}`);
  }

  // capture coveredTripId if value exists
  const coveredTripId = selectedOffer.tripCoverage && selectedOffer.tripCoverage.coveredTripId;
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
      const ri = part && part.requestedInformation;
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
      if (out.provided.length || (out.probeTargets && out.probeTargets.length)) {
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

      test(`AdmissionOfferPart ${i + 1} type: ${type}`, function () {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} type: ${type}`);
        expect(["NRT", "TLT", "IRT"]).to.include(type);
      });

      // validFrom is a valid date
      if (admission.validFrom) {
        const validFrom = new Date(admission.validFrom);
        test(`AdmissionOfferPart ${i + 1} validFrom is a valid date - validFrom: ${admission.validFrom}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} validFrom: ${admission.validFrom}`);
          expect(!isNaN(validFrom.getTime()), "validFrom should be a valid ISO date").to.be.true;
        });
      }

      // validUntil must be in the future
      const validUntil = new Date(admission.validUntil);
      test(`AdmissionOfferPart ${i + 1} validUntil is in the future - validUntil: ${validUntil}`, function () {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} validUntil is in the future - validUntil: ${validUntil}`);
        expect(validUntil.getTime()).to.be.above(Date.now());
      });

      // price structure is valid
      test(`AdmissionOfferPart ${i + 1} price structure is valid - amount: ${admission.price?.amount}, currency: ${admission.price?.currency}`, function () {
        validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} price: ${admission.price?.amount} ${admission.price?.currency}`);
        expect(admission.price, "price should exist").to.be.an("object");
        expect(admission.price.amount, "price.amount should be a number >= 0").to.be.a("number").and.at.least(0);
        expect(admission.price.currency, "price.currency should exist").to.exist.and.be.a("string");
        expect(admission.price.scale, "price.scale should be a number").to.be.a("number");
      });

      // offerMode is defined
      if (admission.offerMode) {
        test(`AdmissionOfferPart ${i + 1} offerMode is a known value - offerMode: ${admission.offerMode}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} offerMode: ${admission.offerMode}`);
          expect(admission.offerMode).to.be.oneOf(["INDIVIDUAL", "COLLECTIVE"]);
        });
      }

      // appliedPassengerTypes each has a type and passengerRef
      const appliedPassengerTypes = admission.appliedPassengerTypes || [];
      if (appliedPassengerTypes.length > 0) {
        test(`AdmissionOfferPart ${i + 1} appliedPassengerTypes are valid - count: ${appliedPassengerTypes.length}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} appliedPassengerTypes count: ${appliedPassengerTypes.length}`);
          appliedPassengerTypes.forEach((apt, aptIdx) => {
            expect(apt.passengerRef, `appliedPassengerTypes[${aptIdx}].passengerRef should exist`).to.be.a("string");
            // Use the shared OSDM PassengerType enum from osdmEnums.js so this
            // check stays in lockstep with passengers.js. The previous inline
            // 6-value list (ADULT/YOUTH/SENIOR/CHILD/INFANT/PERSON) wrongly
            // rejected valid OSDM values like YOUNG_CHILD, DOG, BICYCLE, CAR
            // — which appear in family, pet-friendly, and auto-train offers.
            expect(apt.type, `appliedPassengerTypes[${aptIdx}].type should be a known value`).to.be.oneOf(OSDM_PASSENGER_TYPES);
          });
        });
      }

      // isReusable is a boolean (if present)
      if (admission.isReusable !== undefined) {
        test(`AdmissionOfferPart ${i + 1} isReusable is a boolean - isReusable: ${admission.isReusable}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} isReusable: ${admission.isReusable}`);
          expect(admission.isReusable, "isReusable should be a boolean").to.be.a("boolean");
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
              if (!isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!isNaN(validUntilDate.getTime())) {
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
              expect(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number`).to.be.a('number');
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              if (scenarioType.includes("REFUND") && condition.condition === "REFUND") {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              } else if (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE") {
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

      // If FULL FLEXIBLE ticket, refundable and/or exchangeable must be YES
      if (overallFlex === "FULL_FLEXIBLE" || overallFlex === "SEMI_FLEXIBLE") {
        const scenarioType = bru.getEnvVar("scenarioType") || "";
        if (scenarioType.includes("REFUND")) {
          test(`Admission part ${i + 1} refundable : ${admission.refundable}`, function () {
            validationLogger(`[DEBUG] Admission part ${i + 1} refundable : ${admission.refundable}`);
            expect(admission.refundable, "Refundable should be YES").to.eql("YES");
          });
        } else if (scenarioType.includes("EXCHANGE")) {
          test(`Admission part ${i + 1} exchangeable : ${admission.exchangeable}`, function () {
            validationLogger(`[DEBUG] Admission part ${i + 1} exchangeable : ${admission.exchangeable}`);
            expect(admission.exchangeable, "Exchangeable should be YES").to.eql("YES");
          });
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
        expect(reservation.price.scale, "price.scale should be a number").to.be.a("number");
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

      // Available Places: accommodationType oneOf + tripLegCoverage structure
      const availablePlaces = reservation.availablePlaces || [];
      if (availablePlaces.length > 0) {
        test(`Reservation part ${i + 1} availablePlaces is an array and contains accommodationType and numericAvailability`, () => {
          validationLogger(`[DEBUG] availablePlaces count : ${availablePlaces.length}`);
          expect(Array.isArray(availablePlaces)).to.eql(true);
          availablePlaces.forEach((place, pIndex) => {
            validationLogger(`[DEBUG] availablePlaces[${pIndex}] accommodationType : ${place.accommodationType}, numericAvailability : ${place.numericAvailability}`);
            expect(typeof place.accommodationType).to.eql("string");
            expect(place.accommodationType, `availablePlaces[${pIndex}].accommodationType should be a known OSDM value`).to.be.oneOf(	["SEAT", "COUCHETTE", "BERTH", "VEHICLE", "STORAGE"]);
            expect(typeof place.numericAvailability).to.eql("number");
            // tripLegCoverage structure (if present)
            if (place.tripLegCoverage) {
              expect(place.tripLegCoverage.tripId, `availablePlaces[${pIndex}].tripLegCoverage.tripId should be a string`).to.be.a("string");
              expect(place.tripLegCoverage.legId, `availablePlaces[${pIndex}].tripLegCoverage.legId should be a string`).to.be.a("string");
            }
          });
        });
      } else {
        validationLogger(`[DEBUG] No availablePlaces for reservation id=${reservation.id} → test skipped`);
      }

      // Numeric Availability
      if ("numericAvailability" in reservation) {
        test(`Reservation part ${i + 1} numericAvailability is a number - total: ${reservation.numericAvailability}`, () => {
          validationLogger(`[DEBUG] numericAvailability : ${reservation.numericAvailability}`);
          expect(typeof reservation.numericAvailability).to.eql("number");
        });
      } else {
        validationLogger(`[DEBUG] No numericAvailability for reservation id : ${reservation.id} → test skipped`);
      }

      // Number of Private Compartments
      if ("numberOfPrivateCompartments" in reservation) {
        test(`Reservation part ${i + 1} numberOfPrivateCompartments is a number - total: ${reservation.numberOfPrivateCompartments}`, () => {
          validationLogger(`[DEBUG] numberOfPrivateCompartments : ${reservation.numberOfPrivateCompartments}`);
          expect(typeof reservation.numberOfPrivateCompartments).to.eql("number");
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
              if (!isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!isNaN(validUntilDate.getTime())) {
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
              expect(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number`).to.be.a('number');
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              if (scenarioType.includes("REFUND") && condition.condition === "REFUND") {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              } else if (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE") {
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
              if (!isNaN(validFromDate.getTime())) {
                expect(condition.validFrom, `afterSalesCondition[${condIndex}].validFrom should be a valid date`).to.be.a('string');
                validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].validFrom: ${condition.validFrom}`);
              } else {
                validationLogger(`[WARNING] afterSalesCondition[${condIndex}].validFrom has invalid date format: ${condition.validFrom}`);
              }
            }

            // Validate validUntil
            if (condition.validUntil) {
              const validUntilDate = new Date(condition.validUntil);
              if (!isNaN(validUntilDate.getTime())) {
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
              expect(condition.afterSaleFee.scale, `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number`).to.be.a('number');
              validationLogger(`[DEBUG] afterSalesCondition[${condIndex}].afterSaleFee: ${condition.afterSaleFee.amount} ${condition.afterSaleFee.currency}`);

              const scenarioType = bru.getEnvVar("scenarioType") || "";
              if (scenarioType.includes("REFUND") && condition.condition === "REFUND") {
                admissionReservationAncillaryOfferPartsAftersalesConditions += condition.afterSaleFee.amount;
                bru.setEnvVar("admissionReservationAncillaryOfferPartsAftersalesConditions", admissionReservationAncillaryOfferPartsAftersalesConditions);
              } else if (scenarioType.includes("EXCHANGE") && condition.condition === "EXCHANGE") {
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
    validationLogger(`[DEBUG] No ancillaryOfferParts found for offer.id : ${selectedOffer.id} → test skipped`);
  }
}

// Function to extract all tripId and legId from tripLegCoverage for a given accommodationType
function getTripLegCoverage(selectedOffer, accommodationSelection) {
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
    if (bru.getEnvVar("reservationId")) {
      validationLogger(`[DEBUG] reservationId already set (${bru.getEnvVar("reservationId")}) → keeping it`);
      return;
    }
    const _seatResParts = selectedOffer.reservationOfferParts || [];
    if (_seatResParts.length === 0) {
      validationLogger(`[WARN] Place selection enabled but this offer has no reservationOfferParts → seat map not applicable (nothing to reserve).`);
      return;
    }
    const _firstRes = _seatResParts[0];
    bru.setEnvVar("reservationId", _firstRes.id);
    bru.setEnvVar("reservationIds", JSON.stringify(_seatResParts.map((p) => p.id)));
    const _firstPlace = Array.isArray(_firstRes.availablePlaces) ? _firstRes.availablePlaces[0] : null;
    if (_firstPlace && _firstPlace.tripLegCoverage) {
      bru.setEnvVar("tripLegCoverage", JSON.stringify([_firstPlace.tripLegCoverage]));
    }
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
  bru.setEnvVar("reservationId", matchingParts[0].id);

  test(`At least one reservationOfferPart has accommodationType: ${accommodationSelection}`, function () {
    expect(matchingParts.length, "No matching reservationOfferParts found").to.be.above(0);
  });

  const tripLegCoverage = getTripLegCoverage(selectedOffer, accommodationSelection);
  bru.setEnvVar("tripLegCoverage", JSON.stringify(tripLegCoverage));
  validationLogger(`[DEBUG] tripLegCoverage stored in environment: ${JSON.stringify(tripLegCoverage)}`);
}

function ensureYesWhenRefundOrExchangeSelected(selectedOffer) {
  validationLogger("[DEBUG] ➤ ensureYesWhenRefundOrExchangeSelected");

  const admissionParts = selectedOffer.admissionOfferParts || [];

  if (admissionParts.length > 0) {
    admissionParts.forEach((admission, i) => {
      const scenarioType = bru.getEnvVar("scenarioType") || "";
      if (scenarioType.includes("REFUND")) {
        test(`Admission part ${i + 1} is refundable (scenarioType=REFUND) - refundable: ${admission.refundable}`, function () {
          if (admission.refundable !== "YES") {
            validationLogger(`[ERROR] ⛔ scenarioType is REFUND but Admission part ${i + 1} is not refundable`);
          } else {
            validationLogger(`[DEBUG] Admission part ${i + 1} is refundable as expected, continuing.`);
          }
          expect(admission.refundable, "Admission part should be refundable in REFUND scenario").to.eql("YES");
        });
      } else if (scenarioType.includes("EXCHANGE")) {
        test(`Admission part ${i + 1} is exchangeable (scenarioType=EXCHANGE) - exchangeable: ${admission.exchangeable}`, function () {
          if (admission.exchangeable !== "YES") {
            validationLogger(`[ERROR] ⛔ scenarioType is EXCHANGE but Admission part ${i + 1} is not exchangeable`);
          } else {
            validationLogger(`[DEBUG] Admission part ${i + 1} is exchangeable as expected, continuing.`);
          }
          expect(admission.exchangeable, "Admission part should be exchangeable in EXCHANGE scenario").to.eql("YES");
        });
      }
    });
  }
}

// Expose globally for convenience in eval/require flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
