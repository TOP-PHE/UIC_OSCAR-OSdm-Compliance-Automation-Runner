const { parseEnvJson } = require('./envUtils.js');

module.exports = {
  buildOfferCollectionRequest,
  buildBookingRequest,
  accommodationAndPlaceSelection,
  requestRefundOffersBody,
  requestExchangeOffersBody,
  requestExchangeOperationsBody
};

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

  const offer = {
    offerId: bru.getEnvVar("offerId"),
    passengerRefs: parseEnvJson("bookingPassengerReferences")
  };
  if (placeSelections.length > 0) {
    offer.placeSelections = placeSelections;
  }

  const body = {
    offers: [offer],
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