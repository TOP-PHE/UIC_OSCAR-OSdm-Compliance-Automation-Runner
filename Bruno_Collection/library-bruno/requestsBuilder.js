const { parseEnvJson } = require('./envUtils.js');

module.exports = {
  buildOfferCollectionRequest,
  buildReturnOfferCollectionRequest,
  buildBookingRequest,
  accommodationAndPlaceSelection,
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

  // Two-step return (#178): when an inbound offer was fetched, book BOTH the
  // outbound and the inbound offers in one booking. Otherwise book the single
  // selected offer (unchanged single-trip behaviour). Manual place selections
  // are applied to the outbound offer only (the inbound uses automatic
  // selection — manual place selection on a return is out of scope for now).
  const inboundOfferId  = bru.getEnvVar("inboundOfferId");
  const outboundOfferId = bru.getEnvVar("outboundOfferId");
  const offers = [];
  if (inboundOfferId && outboundOfferId) {
    const outboundOffer = { offerId: outboundOfferId, passengerRefs };
    if (placeSelections.length > 0) outboundOffer.placeSelections = placeSelections;
    offers.push(outboundOffer);
    offers.push({ offerId: inboundOfferId, passengerRefs });
    validationLogger(`[INFO] 🔁 Return booking — booking outbound (${outboundOfferId}) + inbound (${inboundOfferId}) offers.`);
  } else {
    const offer = { offerId: bru.getEnvVar("offerId"), passengerRefs };
    if (placeSelections.length > 0) offer.placeSelections = placeSelections;
    offers.push(offer);
  }

  const body = {
    offers,
    purchaser: parseEnvJson("bookingPurchaserSpecifications"),
    passengerSpecifications
  };

  const sandbox = bru.getEnvVar("api_base") || "";
  if (!sandbox.includes("paxone")) {
    body.externalRef = "00001";
  }

  bru.setEnvVar("BookingRequest", JSON.stringify(body));
}

// Function to handle place selections
function accommodationAndPlaceSelection() {
  validationLogger("[INFO] ➤ accommodationAndPlaceSelection");

  const requiresPlaceSelection = bru.getEnvVar("requiresPlaceSelection");
  const accommodationSelection = bru.getEnvVar("accommodationSelection");

  if (requiresPlaceSelection !== true && requiresPlaceSelection !== "true" && accommodationSelection !== "COUCHETTE") {
    bru.setEnvVar("placeSelections", JSON.stringify([]));
    return;
  }

  const tripLegCoverageArr = parseEnvJson("tripLegCoverage", []);
  const tripId = tripLegCoverageArr.length > 0 ? tripLegCoverageArr[0].tripId : "";
  const legId = tripLegCoverageArr.length > 0 ? tripLegCoverageArr[0].legId : "";
  const passengerRefs = parseEnvJson("bookingPassengerReferences");

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

  if (requiresPlaceSelection === true || requiresPlaceSelection === "true") {
    placeSelection.places = [{
      passengerRefs,
      coachNumber: bru.getEnvVar("preselectedCoach"),
      placeNumber: bru.getEnvVar("preselectedPlace")
    }];
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
function requestRefundOffersBody(overruleCode, refundDate = null) {
  validationLogger("[INFO] ➤ requestRefundOffersBody");

  const body = { fulfillmentIds: parseFulfillmentIds() };
  if (overruleCode != null) body.overruleCode = overruleCode;
  if (refundDate != null)   body.refundDate   = refundDate;

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