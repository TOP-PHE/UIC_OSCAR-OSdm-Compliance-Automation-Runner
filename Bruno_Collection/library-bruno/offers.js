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
const { bruTest: test, expectTypeOrNull } = require('./testCapture.js');
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
      // #357: validationLogger so the [DEBUG] diagnostic obeys loggingType.
      validationLogger('[DEBUG] [offers] preflight header extraction failed, continuing without headers: ' + (e && e.message));
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
      // #357: validationLogger so the [DEBUG] diagnostic obeys loggingType.
      validationLogger('[DEBUG] [offers] preflight body resolution failed, continuing without body: ' + (e && e.message));
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

  captureExpiredOfferDeadline(selectedOffer);

  validateOfferSummary(selectedOffer);
  validatePassengers(jsonData);
  validateOfferParts(selectedOffer);
  validateTripsAndLegs(jsonData);
  validateAdmissions(selectedOffer);
  validateReservations(selectedOffer);
  validateAncillaries(selectedOffer);

  handleAccommodationAndPlaceSelection(selectedOffer);
  handleOptionalReservationSelections(selectedOffer);

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
  if (selectedOffer.preBookableUntil) {
    const _pbu = new Date(selectedOffer.preBookableUntil).getTime();
    if (!isNaN(_pbu) && _pbu < _earliestMs) {
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
      const parts = (o && o.reservationOfferParts) || [];
      if (parts.length === 0) { noRes++; return; }
      parts.forEach((p) => ((p && p.availablePlaces) || []).forEach((pl) => {
        const t = pl && pl.accommodationType;
        if (!t) return;
        if (!fam[t]) fam[t] = { offers: new Set(), subs: new Set() };
        fam[t].offers.add(o.offerId);
        if (pl.accommodationSubType) fam[t].subs.add(pl.accommodationSubType);
      }));
    });
    const famLine = Object.keys(fam)
      .map((t) => `${t} ×${fam[t].offers.size} offer(s)${fam[t].subs.size ? ` (subtypes: ${[...fam[t].subs].join(", ")})` : ""}`)
      .join("; ");
    console.log(`[INFO] 🧭 Offer set: ${offers.length} offer(s)${famLine ? ` — reservation accommodations: ${famLine}` : ""}${noRes > 0 ? `; ${noRes} offer(s) without reservation parts` : ""}.`);
  })(jsonData && jsonData.offers);

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
        expectTypeOrNull(admission.price.scale, "number", "price.scale should be a number or null (nullable per OSDM)");
      });

      // offerMode is defined
      if (admission.offerMode) {
        test(`AdmissionOfferPart ${i + 1} offerMode is a known value - offerMode: ${admission.offerMode}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} offerMode: ${admission.offerMode}`);
          expect(admission.offerMode).to.be.oneOf(["INDIVIDUAL", "COLLECTIVE"]);
        });
      }

      // #211 (SFR night-train spec): minGroupItemsToBeBooked/maxGroupItemsToBeBooked
      // are optional OSDM fields — not every vendor populates them, so this is a
      // soft type-check only, never a hard requirement that they equal 1.
      if ("minGroupItemsToBeBooked" in admission) {
        test(`AdmissionOfferPart ${i + 1} minGroupItemsToBeBooked is a number or null - value: ${admission.minGroupItemsToBeBooked}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} minGroupItemsToBeBooked: ${admission.minGroupItemsToBeBooked}`);
          expectTypeOrNull(admission.minGroupItemsToBeBooked, "number", "minGroupItemsToBeBooked should be a number or null (nullable per OSDM)");
        });
      } else {
        validationLogger(`[INFO] AdmissionOfferPart ${i + 1} does not declare minGroupItemsToBeBooked (optional per OSDM) → check skipped`);
      }
      if ("maxGroupItemsToBeBooked" in admission) {
        test(`AdmissionOfferPart ${i + 1} maxGroupItemsToBeBooked is a number or null - value: ${admission.maxGroupItemsToBeBooked}`, function () {
          validationLogger(`[DEBUG] AdmissionOfferPart ${i + 1} maxGroupItemsToBeBooked: ${admission.maxGroupItemsToBeBooked}`);
          expectTypeOrNull(admission.maxGroupItemsToBeBooked, "number", "maxGroupItemsToBeBooked should be a number or null (nullable per OSDM)");
        });
      } else {
        validationLogger(`[INFO] AdmissionOfferPart ${i + 1} does not declare maxGroupItemsToBeBooked (optional per OSDM) → check skipped`);
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
              expectTypeOrNull(condition.afterSaleFee.scale, "number", `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number or null (nullable per OSDM)`);
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
        expectTypeOrNull(reservation.price.scale, "number", "price.scale should be a number or null (nullable per OSDM)");
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
          const _t = String((place && place.accommodationType) || "");
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
              expectTypeOrNull(condition.afterSaleFee.scale, "number", `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number or null (nullable per OSDM)`);
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
              expectTypeOrNull(condition.afterSaleFee.scale, "number", `afterSalesCondition[${condIndex}].afterSaleFee.scale should be a number or null (nullable per OSDM)`);
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
    validationLogger(`[DEBUG] No ancillaryOfferParts found for offer.id : ${selectedOffer.offerId} → test skipped`);
  }
}

// Function to extract all tripId and legId from tripLegCoverage for a given accommodationType
// #371: coverage the OFFER declares (tripCoverage, object or array) -
// normalized to [{tripId, legId}]. The authoritative source for booking
// placeSelections per the OBB IRT/NJ requirement; per-place tripLegCoverage
// stays the fallback for providers that only set it there.
function offerTripCoverage(selectedOffer) {
  const tc = selectedOffer && selectedOffer.tripCoverage;
  const arr = Array.isArray(tc) ? tc : (tc ? [tc] : []);
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
  const tripIds = new Set(trips.map((t) => t && t.id).filter(Boolean));
  const legsByTrip = {};
  trips.forEach((t) => {
    if (t && t.id) legsByTrip[t.id] = new Set((t.legs || []).map((l) => l && l.id).filter(Boolean));
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
  const KNOWN_FLOWS = [
    "MANUAL_PLACE_SELECTION_WITH_FEE", "MANUAL_PLACE_SELECTION_WITHOUT_FEE",
    "AUTOMATIC_PLACE_SELECTION", "AUTOMATIC_PLACE_SELECTION_NEARBY", "AUTOMATIC_PLACE_SELECTION_PREFERENCES",
  ];
  const flows = Array.isArray(part.supportedPlaceSelectionFlows) ? part.supportedPlaceSelectionFlows.filter(Boolean).map(String) : [];
  const mode = bru.getEnvVar("placeSelectionMode") || "";
  const wantsMap = mode === "SEATMAP_AT_OFFER" || mode === "ADD_TO_BOOKING";
  const graphical = (Array.isArray(part.availablePlacePreferences) ? part.availablePlacePreferences : [])
    .map((p) => p && p.graphicalReservation).filter(Boolean).map(String);

  if (flows.length === 0) {
    validationLogger(`[INFO] Reservation part ${part.id}: no supportedPlaceSelectionFlows declared (optional in OSDM)${wantsMap ? ` — the scenario's ${mode} seat-map flow proceeds without a declared capability` : ""}.`);
  } else {
    validationLogger(`[INFO] Reservation part ${part.id} declares place-selection flows: ${flows.join(", ")}${graphical.length ? `; graphicalReservation: ${[...new Set(graphical)].join(", ")}` : ""}.`);
    const unknown = flows.filter((f) => !KNOWN_FLOWS.includes(f.toUpperCase()));
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
    const _offerCov = offerTripCoverage(selectedOffer);
    const _firstPlace = Array.isArray(_firstRes.availablePlaces) ? _firstRes.availablePlaces[0] : null;
    if (_offerCov.length > 0) {
      bru.setEnvVar("tripLegCoverage", JSON.stringify(_offerCov));
    } else if (_firstPlace && _firstPlace.tripLegCoverage) {
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

// #239: book the selected offer's reservationOfferParts via
// optionalReservationSelections — the OSDM mechanism for offers where a
// reservation is mandatory, distinct from (and independent of)
// placeSelections/accommodationSelection above, which additionally state
// WHICH place/compartment is wanted. This only declares the reservation(s)
// themselves should be booked, one {reservationId} entry per part.
function handleOptionalReservationSelections(selectedOffer) {
  const bookMandatoryReservations = bru.getEnvVar("bookMandatoryReservations");
  if (bookMandatoryReservations !== true && bookMandatoryReservations !== "true") {
    return;
  }
  validationLogger("[DEBUG] ➤ handleOptionalReservationSelections");

  const reservationParts = selectedOffer.reservationOfferParts || [];
  if (reservationParts.length === 0) {
    validationLogger("[WARN] bookMandatoryReservations is enabled but the selected offer has no reservationOfferParts — nothing to add to optionalReservationSelections.");
    bru.setEnvVar("optionalReservationSelections", JSON.stringify([]));
    return;
  }

  const selections = reservationParts.map(part => ({ reservationId: part.id }));
  bru.setEnvVar("optionalReservationSelections", JSON.stringify(selections));
  validationLogger(`[INFO] optionalReservationSelections will book ${selections.length} reservationOfferPart(s): ${reservationParts.map(p => p.id).join(", ")}`);
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
      const parts = []
        .concat((offer && offer.admissionOfferParts) || [])
        .concat((offer && offer.reservationOfferParts) || [])
        .concat((offer && offer.ancillaryOfferParts) || [])
        .filter((p) => p && p.price && typeof p.price.amount === "number" && p.price.amount > 0);
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
      validationLogger(`[WARNING] Catalog sweep (${action}): ${contradicting} of ${list.length} offers declare ${field}=NO on a value-bearing part while their own ${action} schedule charges less than the price${freeWindowed > 0 ? ` (${freeWindowed} even with a FREE window)` : ""} — per the spec enum these are WITH_CONDITION; ${consistent} offer(s) are consistent (every ${action} window charges the full price). Distributors filtering on the flag would hide ${action.toLowerCase()}able products.`);
    }
  });
}

// Expose globally for convenience in eval/require flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
