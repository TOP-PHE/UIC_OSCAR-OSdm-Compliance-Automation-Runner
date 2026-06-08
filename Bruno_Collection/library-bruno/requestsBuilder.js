/**
 * requestsBuilder.js — assemble every OSDM REQUEST body from the scenario data.
 *
 * The write-side counterpart to the response validators: turns the env vars
 * scenarioParser set (trip, passengers, purchaser, fulfillment options, place
 * selection, refund/exchange) into the JSON bodies for the offer, booking,
 * purchaser and after-sales requests. Pure assembly — no assertions.
 */
const { parseEnvJson } = require('./envUtils.js');

module.exports = {
  buildOfferCollectionRequest,
  buildReturnOfferCollectionRequest,
  buildBookingRequest,
  buildBookingPurchaserBody,
  accommodationAndPlaceSelection,
  collectAvailablePlaces,
  placesForPassengers,
  requestRefundOffersBody,
  requestExchangeOffersBody,
  requestExchangeOperationsBody
};

// Two-step return (#178): does this scenario's outbound search request a return?
// We detect it from the outbound tripSearchCriteria the scenarioParser built —
// returnSearchParameters.inwardReturnDate is present only for return scenarios.
// (Return is supported for SEARCH outbounds; SPECIFICATION returns are out of
// scope — there's no return train spec in the test data.)
function returnInwardDateFromOutbound() {
  try {
    const tsc = JSON.parse(bru.getEnvVar("offerTripSearchCriteria") || "{}");
    const d = tsc && tsc.returnSearchParameters && tsc.returnSearchParameters.inwardReturnDate;
    return (typeof d === "string" && d) ? d : null;
  } catch (_) { return null; }
}

// Build the INWARD (return) offer request — OSDM two-step return, leg 2.
// Reuses the outbound tripSearchCriteria but swaps origin/destination, sets the
// departureTime to the inwardReturnDate, and relates it to the chosen outbound
// offer via returnSearchParameters.outwardOfferIds. Passengers / offer criteria
// / fulfillment are the same as the outbound. Returns true when a body was
// built (i.e. this is a return scenario), false otherwise.
function buildReturnOfferCollectionRequest() {
  validationLogger("[INFO] ➤ buildReturnOfferCollectionRequest");
  const inwardReturnDate = returnInwardDateFromOutbound();
  const outboundOfferId  = bru.getEnvVar("outboundOfferId");
  if (!inwardReturnDate || !outboundOfferId) {
    validationLogger("[WARN] buildReturnOfferCollectionRequest — not a return scenario or missing outbound offer; skipping.");
    return false;
  }

  const outboundTsc = JSON.parse(bru.getEnvVar("offerTripSearchCriteria") || "{}");
  // Swap O&D for the return leg; drop the outbound's vehicle/carrier filter
  // (the return is an open search) and the inwardReturnDate.
  const inboundTsc = {
    departureTime: inwardReturnDate,
    origin: outboundTsc.destination,
    destination: outboundTsc.origin,
    returnSearchParameters: { outwardOfferIds: [outboundOfferId] }
  };
  const outboundTag = bru.getEnvVar("outboundOfferTag");
  if (outboundTag) inboundTsc.returnSearchParameters.outwardOfferTag = outboundTag;

  const sandbox = bru.getEnvVar("api_base") || "";
  const isPaxone = sandbox.includes("paxone");
  const body = {
    tripSearchCriteria: inboundTsc,
    anonymousPassengerSpecifications: parseEnvJson("offerPassengerSpecifications"),
    offerSearchCriteria: parseEnvJson("offerSearchCriteria")
  };
  const fulfillmentOptions = bru.getEnvVar("offerFulfillmentOptions");
  const parsedFulfillmentOptions = (fulfillmentOptions != null && fulfillmentOptions !== '')
    ? JSON.parse(fulfillmentOptions) : [];
  if (!isPaxone || parsedFulfillmentOptions.length > 0) {
    body.requestedFulfillmentOptions = parsedFulfillmentOptions;
  }

  bru.setEnvVar("ReturnOfferCollectionRequest", JSON.stringify(body));
  validationLogger(`[INFO] 🔁 Return (inward) offer request built — ${inboundTsc.origin && inboundTsc.origin.stopPlaceRef} → ${inboundTsc.destination && inboundTsc.destination.stopPlaceRef} on ${inwardReturnDate}, outwardOfferIds=[${outboundOfferId}]`);
  return true;
}

// Function to build the offer collection request
function buildOfferCollectionRequest() {
  validationLogger("[INFO] ➤ buildOfferCollectionRequest");
  const tripType = bru.getEnvVar("TripType");
  const sandbox = bru.getEnvVar("api_base") || "";
  const isPaxone = sandbox.includes("paxone");
  validationLogger("[INFO] Build using TripType: " + tripType);

  const body = {};

  // objectType is NOT a property of OfferCollectionRequest in the OSDM spec
  // (additionalProperties: false) — sending it causes VALIDATION_ERROR on strict implementations.

  if (tripType === "SPECIFICATION") {
    body.tripSpecifications = parseEnvJson("offerTripSpecifications");
  } else if (tripType === "SEARCH") {
    body.tripSearchCriteria = parseEnvJson("offerTripSearchCriteria");
  }

  body.anonymousPassengerSpecifications = parseEnvJson("offerPassengerSpecifications");
  body.offerSearchCriteria = parseEnvJson("offerSearchCriteria");

  const fulfillmentOptions = bru.getEnvVar("offerFulfillmentOptions");
  const parsedFulfillmentOptions = (fulfillmentOptions != null && fulfillmentOptions !== '')
    ? JSON.parse(fulfillmentOptions)
    : [];
  if (!isPaxone || parsedFulfillmentOptions.length > 0) {
    body.requestedFulfillmentOptions = parsedFulfillmentOptions;
  }

  bru.setEnvVar("OfferCollectionRequest", JSON.stringify(body));
}

// Function to build the booking request
function buildBookingRequest() {
  validationLogger("[INFO] ➤ buildBookingRequest");
  accommodationAndPlaceSelection();

  const bookingPassengerSpecifications = parseEnvJson("bookingPassengerSpecifications");
  const firstPassenger = bookingPassengerSpecifications[0];
  const passengerSpecifications = (firstPassenger?.detail?.firstName && firstPassenger?.detail?.lastName)
    ? bookingPassengerSpecifications
    : parseEnvJson("offerPassengerSpecifications");

  const placeSelections = parseEnvJson("placeSelections", []);
  const passengerRefs = parseEnvJson("bookingPassengerReferences");

  // Two-step return (#178/#180): when an inbound offer was fetched, book the
  // return. The FIRST attempt books BOTH offers in one booking (OSDM-valid).
  // If the vendor rejects multi-offer booking (e.g. Bileto "Only one offer can
  // be booked at a time"), 02's after-response sets __returnBookMode and re-runs
  // this builder to book them separately: 'sep-out' (outbound only) then
  // 'sep-in' (inbound only). One-way scenarios book the single selected offer
  // (unchanged). Manual place selections apply to the outbound offer only.
  const inboundOfferId  = bru.getEnvVar("inboundOfferId");
  const outboundOfferId = bru.getEnvVar("outboundOfferId");
  const returnMode      = bru.getEnvVar("__returnBookMode") || "";
  const offers = [];
  if (inboundOfferId && outboundOfferId) {
    const outboundOffer = { offerId: outboundOfferId, passengerRefs };
    if (placeSelections.length > 0) outboundOffer.placeSelections = placeSelections;
    if (returnMode === "sep-out") {
      offers.push(outboundOffer);
      validationLogger(`[INFO] 🔁 Return booking (separate) — outbound only (${outboundOfferId}).`);
    } else if (returnMode === "sep-in") {
      offers.push({ offerId: inboundOfferId, passengerRefs });
      validationLogger(`[INFO] 🔁 Return booking (separate) — inbound only (${inboundOfferId}).`);
    } else {
      offers.push(outboundOffer);
      offers.push({ offerId: inboundOfferId, passengerRefs });
      validationLogger(`[INFO] 🔁 Return booking (combined) — outbound (${outboundOfferId}) + inbound (${inboundOfferId}).`);
    }
  } else {
    const offer = { offerId: bru.getEnvVar("offerId"), passengerRefs };
    if (placeSelections.length > 0) offer.placeSelections = placeSelections;
    offers.push(offer);
  }

  // #258: purchaser is OPTIONAL in BookingRequest (OSDM required = [offers,
  // passengerSpecifications]). `bookingPurchaserMode` decides whether we send it
  // inline at booking time. 'inline' (default) keeps the historic behaviour. For
  // 'deferred'/'omit'/'invalid' the purchaser is OMITTED here so the provider's
  // purchaser requestedInformation (or a confirmation rejection) is exercised;
  // the Booking Purchaser step then supplies it (deferred) or probes it
  // (invalid). 'omit' withholds it entirely (no later step).
  const _purMode = String(bru.getEnvVar("bookingPurchaserMode") || "inline").toLowerCase();
  const body = { offers, passengerSpecifications };
  if (_purMode === "inline") {
    body.purchaser = parseEnvJson("bookingPurchaserSpecifications");
  } else {
    validationLogger(`[INFO] bookingPurchaserMode='${_purMode}' → purchaser omitted from the booking request (OSDM allows this; will be set/probed via the Booking Purchaser step where applicable).`);
  }

  const sandbox = bru.getEnvVar("api_base") || "";
  if (!sandbox.includes("paxone")) {
    body.externalRef = "00001";
  }

  bru.setEnvVar("BookingRequest", JSON.stringify(body));
}

// #258/#203: assemble the body for the deferred-purchaser step (GET→PATCH/POST
// upsert). Shared by both the PATCH (update) and POST (create) write steps so the
// body is identical regardless of which one the GET-probe selected. Base is the
// scenario purchaser (bookingPurchaserSpecifications); update* overrides from the
// booking-level requestedInformation handler (purchaserAdditionalData) are
// overlaid — a present value replaces the field, an empty string ("" — a probe
// "withhold") removes it. In 'invalid' mode, force a clearly-invalid email when
// nothing else makes the body invalid, so the provider must reject.
function buildBookingPurchaserBody() {
  validationLogger("[INFO] ➤ buildBookingPurchaserBody");
  const mode = String(bru.getEnvVar("bookingPurchaserMode") || "inline").toLowerCase();

  let base = {};
  try { base = JSON.parse(bru.getEnvVar("bookingPurchaserSpecifications") || "{}") || {}; } catch (_e) { base = {}; }
  let add = {};
  try { add = JSON.parse(bru.getEnvVar("purchaserAdditionalData") || "{}") || {}; } catch (_e) { add = {}; }

  const body = JSON.parse(JSON.stringify(base || {}));
  body.detail = (body.detail && typeof body.detail === "object") ? body.detail : {};
  body.detail.contact = (body.detail.contact && typeof body.detail.contact === "object") ? body.detail.contact : {};

  const setOrClear = (obj, key, val) => {
    if (val === undefined) return;
    if (val === "") { delete obj[key]; } else { obj[key] = val; }
  };
  if ("updateFirstName"   in add) setOrClear(body.detail,         "firstName",   add.updateFirstName);
  if ("updateLastName"    in add) setOrClear(body.detail,         "lastName",    add.updateLastName);
  if ("updateEmail"       in add) setOrClear(body.detail.contact, "email",       add.updateEmail);
  if ("updatePhoneNumber" in add) setOrClear(body.detail.contact, "phoneNumber", add.updatePhoneNumber);
  if ("updateGender"      in add) setOrClear(body.detail,         "gender",      add.updateGender);
  if ("updateDateOfBirth" in add) setOrClear(body.detail,         "dateOfBirth", add.updateDateOfBirth);

  if (mode === "invalid") {
    // Negative sweep (#258): test EACH purchaser parameter one at a time within a
    // SINGLE run. Each pass corrupts exactly ONE field (the rest stay valid); the
    // write step grades it, then the flow loops back to 12. GET Booking Purchaser
    // for the next field. The purchaser PersonDetail has no enum/format-constrained
    // field (no gender/dateOfBirth), so:
    //   email / phoneNumber → an invalid value (unconstrained string → WARN if accepted)
    //   firstName / lastName → OMITTED (required in PersonDetail → must reject → FAIL)
    const SWEEP = ["firstName", "lastName", "email", "phoneNumber"];
    bru.setEnvVar("__purchaserSweepTotal", String(SWEEP.length));
    let idx = parseInt(bru.getEnvVar("__purchaserSweepIndex") || "0", 10);
    if (isNaN(idx) || idx < 0) idx = 0;
    if (idx > SWEEP.length - 1) idx = SWEEP.length - 1;
    const field = SWEEP[idx];

    let target;
    if (field === "email") {
      body.detail.contact.email = "not-an-email";
      target = { scenarioField: "email", value: "not-an-email" };
    } else if (field === "phoneNumber") {
      body.detail.contact.phoneNumber = "not-a-phone";
      target = { scenarioField: "phoneNumber", value: "not-a-phone" };
    } else {
      // firstName / lastName — no invalid form; OMIT the required field instead.
      delete body.detail[field];
      target = { scenarioField: field };
    }
    bru.setEnvVar("bookingPurchaserSweepTarget", JSON.stringify(target));
    validationLogger(`[WARNING] Purchaser negative sweep ${idx + 1}/${SWEEP.length}: `
      + (target.value !== undefined ? `INVALID '${field}' = '${target.value}'` : `OMIT required '${field}'`)
      + ` — expecting the provider to reject.`);
  }

  bru.setVar("bookingPurchaserBody", JSON.stringify(body));
  return body;
}

// Walk a PlaceAvailability "vehicle" (08. GET Place Maps response) and return up
// to `count` AVAILABLE places as { coachNumber, placeNumber, layoutId }.
//
// The OSDM seat-map response returns the WHOLE vehicle in one payload (all
// coaches, each with its places), so an automated runner has full visibility at
// once — there is no "show coach, then drill into seats" round-trip. We flatten
// the coaches, keep only available places, and pick the first `count`.
//
// No sandbox has served an OFFER-context seat map yet (issue #182 — the vendors
// we test hold seats against a BOOKING and expose no offer-time map), so this is
// built to the OSDM spec and is deliberately DEFENSIVE about the exact shape:
//   - a coach's places may sit at coach.places, coach.compartments[].places,
//     coach.decks[].places, or a compartment object may itself carry .place
//     (the shape the original stub assumed);
//   - availability may be a boolean (available/bookable) or an enum
//     (availability/state/status). A place with NO availability info is treated
//     as available so minimal vendors are not excluded by accident.
// Availability-only (no "seat passengers together" optimisation — issue #182
// follow-up, scope confirmed with the user).
function collectAvailablePlaces(vehicle, count) {
  const out = [];
  if (!vehicle || typeof vehicle !== "object" || !Array.isArray(vehicle.coaches)) return out;
  const want = Math.max(1, parseInt(count, 10) || 1);

  const isAvailable = (p) => {
    if (!p || typeof p !== "object") return false;
    if (p.available === false || p.bookable === false || p.reserved === true || p.occupied === true) return false;
    if (p.available === true || p.bookable === true) return true;
    const s = String(p.availability || p.state || p.status || "").toUpperCase();
    if (s) return s === "AVAILABLE" || s === "FREE" || s === "BOOKABLE" || s === "OPEN";
    return true; // no availability info → assume available
  };

  const placeId = (p) => {
    if (!p || typeof p !== "object") return null;
    if (p.place != null) return p.place;
    if (p.placeNumber != null) return p.placeNumber;
    if (p.number != null) return p.number;
    return null;
  };

  const placesOf = (coach) => {
    if (Array.isArray(coach.places)) return coach.places;
    const acc = [];
    if (Array.isArray(coach.compartments)) {
      coach.compartments.forEach((c) => {
        if (Array.isArray(c && c.places)) acc.push(...c.places);
        else if (c && c.place != null) acc.push(c); // compartment IS a place (legacy stub shape)
      });
    }
    if (Array.isArray(coach.decks)) {
      coach.decks.forEach((d) => { if (Array.isArray(d && d.places)) acc.push(...d.places); });
    }
    return acc;
  };

  for (let ci = 0; ci < vehicle.coaches.length && out.length < want; ci++) {
    const coach = vehicle.coaches[ci];
    if (!coach || typeof coach !== "object") continue;
    // OSDM Coach uses `number` for the coach number (required); `coachNumber`
    // is kept only as a fallback for non-spec vendors. Reading the wrong field
    // produced an undefined coachNumber → the booking's SelectedPlace was missing
    // its required coachNumber and the vendor rejected it (#188).
    const cn = (coach.number != null) ? coach.number
             : (coach.coachNumber != null ? coach.coachNumber : null);
    const places = placesOf(coach);
    for (let pi = 0; pi < places.length && out.length < want; pi++) {
      const p = places[pi];
      if (!isAvailable(p)) continue;
      const pid = placeId(p);
      if (pid == null) continue;
      out.push({ coachNumber: cn, placeNumber: pid, layoutId: coach.layoutId });
    }
  }
  return out;
}

// Map availability-picked places onto passengers — one places[] entry per
// passenger (issue #184). Pairs passengerRefs[i] with the i-th picked place; if
// fewer places were available than passengers, the surplus reuse the last place
// (best-effort). Shared by accommodationAndPlaceSelection (pre-booking, into the
// booking request) and 09. POST Add Reservation (post-booking, BOOKING-context
// seat map). Returns [] when there is nothing to assign.
function placesForPassengers(picked, passengerRefs) {
  const refs = Array.isArray(passengerRefs) ? passengerRefs : [];
  if (!Array.isArray(picked) || picked.length === 0 || refs.length === 0) return [];
  // OSDM SelectedPlace is additionalProperties:false and requires exactly
  // { coachNumber, placeNumber, passengerRef } — all STRINGS, passengerRef
  // SINGULAR. Emitting "passengerRefs" (plural array) — or numeric coach/place —
  // makes the vendor reject the booking with 400 "Invalid request content".
  return refs.map((ref, i) => {
    const pk = picked[i] || picked[picked.length - 1];
    return {
      coachNumber: String(pk.coachNumber),
      placeNumber: String(pk.placeNumber),
      passengerRef: ref
    };
  });
}

// Function to handle place selections
function accommodationAndPlaceSelection() {
  validationLogger("[INFO] ➤ accommodationAndPlaceSelection");

  const requiresPlaceSelection = bru.getEnvVar("requiresPlaceSelection");
  const accommodationSelection = bru.getEnvVar("accommodationSelection");

  // Availability-aware picks produced by 08. GET Place Maps (one AVAILABLE place
  // per passenger). Their presence ALSO enables place selection, so a
  // SEATMAP_AT_OFFER scenario that did not set the legacy requiresPlaceSelection
  // flag still carries its chosen seats into the booking.
  const preselectedPlaces = parseEnvJson("preselectedPlaces", []);
  const hasPicks = Array.isArray(preselectedPlaces) && preselectedPlaces.length > 0;

  if (requiresPlaceSelection !== true && requiresPlaceSelection !== "true"
      && accommodationSelection !== "COUCHETTE" && !hasPicks) {
    bru.setEnvVar("placeSelections", JSON.stringify([]));
    return;
  }

  const tripLegCoverageArr = parseEnvJson("tripLegCoverage", []);
  const tripId = tripLegCoverageArr.length > 0 ? tripLegCoverageArr[0].tripId : "";
  const legId = tripLegCoverageArr.length > 0 ? tripLegCoverageArr[0].legId : "";
  const passengerRefsRaw = parseEnvJson("bookingPassengerReferences", []);
  const passengerRefs = Array.isArray(passengerRefsRaw) ? passengerRefsRaw : [];

  const placeSelection = {
    reservationId: bru.getEnvVar("reservationId"),
    tripLegCoverage: { tripId, legId }
  };

  if (accommodationSelection === "COUCHETTE") {
    placeSelection.accommodations = [{
      passengerRefs,
      accommodationType: accommodationSelection,
      accommodationSubType: "ANY_SEAT",
      placeProperties: ["MEN"]
    }];
  }

  if (hasPicks) {
    // One AVAILABLE place per passenger (shared with the post-booking path).
    placeSelection.places = placesForPassengers(preselectedPlaces, passengerRefs);
  } else if (requiresPlaceSelection === true || requiresPlaceSelection === "true") {
    // Back-compat: a single preselected coach/place → one SelectedPlace per
    // passenger (via the shared, schema-correct builder).
    placeSelection.places = placesForPassengers(
      [{ coachNumber: bru.getEnvVar("preselectedCoach"), placeNumber: bru.getEnvVar("preselectedPlace") }],
      passengerRefs
    );
  }

  bru.setEnvVar("placeSelections", JSON.stringify([placeSelection]));
}

// Parse fulfillmentIds from env var (handles both array and JSON string)
function parseFulfillmentIds() {
  const raw = bru.getEnvVar('fulfillmentIds');
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return raw;
  }
}

// Function to create request body for refund offers
//
// Optional third arg `refundSpecifications` carries the OSDM v3.8
// RefundSpecification[] for partial refunds (issue #218). When passed as a
// non-empty array, OSCAR is scoping the refund to a subset of booking parts
// and/or passengers within a single fulfillment. Otherwise the body is the
// historical full-refund shape.
//
// When partial is armed we also TRIM `fulfillmentIds[]` down to the scoped
// fulfillment. Otherwise the provider sees:
//   fulfillmentIds      = every fulfillment in the booking
//   refundSpecifications = partial scope for ONE fulfillment
// and (correctly per OSDM) interprets the fulfillmentIds list as "refund all
// these in full". Paxone in particular ignores refundSpecifications as an
// unknown field on its current spec version, so the partial scope is then
// silently lost — see #218 follow-up.
function requestRefundOffersBody(overruleCode, refundDate = null, refundSpecifications = null) {
  validationLogger("[INFO] ➤ requestRefundOffersBody");

  let fulfillmentIds = parseFulfillmentIds();
  // Side-channel: when partial scope is resolved but the OSDM version doesn't
  // yet support refundSpecifications[] (Paxone on v3.5 today), 10.yml stashes
  // the target fulfillmentId here so we still trim fulfillmentIds[].
  const _scopeOnly = bru.getEnvVar("__partialRefundScopeFulfillmentId");
  const _hasSpec   = Array.isArray(refundSpecifications) && refundSpecifications.length > 0;
  if (_hasSpec || (_scopeOnly && String(_scopeOnly).length > 0)) {
    // Trim to the scoped fulfillment(s) only; preserve order.
    const wanted = new Set(
      _hasSpec
        ? refundSpecifications.map(s => s && s.fulfillmentId).filter(Boolean).map(String)
        : [String(_scopeOnly)]
    );
    const trimmed = Array.isArray(fulfillmentIds)
      ? fulfillmentIds.filter(id => wanted.has(String(id)))
      : [];
    if (trimmed.length === 0) {
      // Fail safe: if the trim leaves nothing (env var was empty / mismatched)
      // fall back to just listing the scoped fulfillment(s) so the request is
      // at least internally consistent.
      fulfillmentIds = [...wanted];
    } else {
      // De-dupe while keeping the first occurrence — guards against legacy
      // duplicates from older bookings.js that pushed every fulfillment twice.
      const seen = new Set();
      fulfillmentIds = trimmed.filter(id => {
        const k = String(id);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
  }

  const body = { fulfillmentIds };
  if (overruleCode != null) body.overruleCode = overruleCode;
  if (refundDate != null)   body.refundDate   = refundDate;
  if (Array.isArray(refundSpecifications) && refundSpecifications.length > 0) {
    body.refundSpecifications = refundSpecifications;
    validationLogger(`[INFO] Partial refund armed — fulfillmentIds scoped to [${fulfillmentIds.join(", ")}], refundSpecifications: ${JSON.stringify(refundSpecifications)}`);
  }

  bru.setEnvVar("requestRefundOffersBodyData", JSON.stringify(body));
}

// Function to create request body for exchange offers
function requestExchangeOffersBody(overruleCode) {
  validationLogger("[INFO] ➤ requestExchangeOffersBody");

  // Build anonymousPassengerSpecifications dynamically from offerPassengerSpecifications
  // so multi-passenger exchange scenarios send one entry per passenger.
  // Previously hardcoded to index 0 only — any additional passengers were silently dropped.
  let anonymousPassengerSpecifications;
  try {
    const passengerSpecs = parseEnvJson('offerPassengerSpecifications', []);
    if (!Array.isArray(passengerSpecs) || passengerSpecs.length === 0) {
      throw new Error('offerPassengerSpecifications is empty or not an array');
    }
    anonymousPassengerSpecifications = passengerSpecs.map(function(spec, i) {
      const updateGender = bru.getEnvVar('updateGender_' + i);
      const entry = {
        externalRef: spec.externalRef || String(i + 1).padStart(5, '0'),
        dateOfBirth: bru.getEnvVar('updateDateOfBirth_' + i) || spec.dateOfBirth || null,
        age: spec.age != null ? spec.age : 0,
        type: spec.type || "PERSON"
      };
      if (updateGender != null) entry.gender = updateGender;
      return entry;
    });
    validationLogger("[INFO] Built anonymousPassengerSpecifications for " + passengerSpecs.length + " passenger(s)");
  } catch (_e) {
    validationLogger('[WARNING] requestExchangeOffersBody: could not build passenger specs from offerPassengerSpecifications (' + _e.message + ') — falling back to single-passenger');
    const updateGender_0 = bru.getEnvVar('updateGender_0');
    anonymousPassengerSpecifications = [{
      externalRef: "00001",
      dateOfBirth: bru.getEnvVar('updateDateOfBirth_0'),
      age: 0,
      type: "PERSON",
      ...(updateGender_0 != null && { gender: updateGender_0 })
    }];
  }

  const body = {
    fulfillmentIds: parseFulfillmentIds(),
    tripSearchCriteria: parseEnvJson('offerTripSearchCriteria'),
    offerSearchCriteria: parseEnvJson('offerSearchCriteria'),
    anonymousPassengerSpecifications,
    ...(overruleCode != null && { overruleCode })
  };

  validationLogger("[INFO] Request Exchange Offers Body: " + JSON.stringify(body));
  bru.setEnvVar("requestExchangeOffersBodyData", JSON.stringify(body));
}

// Function to create request body for exchange operations
function requestExchangeOperationsBody() {
  validationLogger("[INFO] ➤ requestExchangeOperationsBody");

  const body = {
    exchangeOffers: [{
      offerId: bru.getEnvVar('exchangeOffersOfferId'),
      passengerRefs: parseEnvJson('bookingPassengerReferences')
    }]
  };

  validationLogger("[INFO] Request Exchange Operations Body: " + JSON.stringify(body));
  bru.setEnvVar("requestExchangeOperationsBodyData", JSON.stringify(body));
}

// Expose to global for convenience in eval/require loader flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  // no-op
}