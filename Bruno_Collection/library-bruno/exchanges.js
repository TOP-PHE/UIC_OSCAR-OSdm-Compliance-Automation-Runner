/**
 * exchanges.js — validate the after-sales EXCHANGE flow responses.
 *
 * Runs in the Exchange scenario folder (after an initial sale). Validates the
 * PATCH exchange-offers and exchange-operations responses against OSDM
 * (amounts to-be-paid / refundable, status transitions).
 */
// Import needed library files
require('./displays.js');
const { bruTest: test } = require('./testCapture.js');

module.exports = {
  postPatchExchangeOffersResponse,
  postPatchExchangeOperationsResponse,
  validateExchangeOfferResponse,
  validateExchangeFeesConsistentWithAfterSalesConditions,
  validateExchangeAppliedOverruleCode
};

// Function to validate exchange offers response
function postPatchExchangeOffersResponse(jsonData, expectedFulfillmentStatus) {
  validationLogger("[DEBUG] ➤ postPatchExchangeOffersResponse");
  // Stop flow if offers invalid
  if (!Array.isArray(jsonData.exchangeOffers) || jsonData.exchangeOffers.length === 0) {
    validationLogger("[ERROR] No exchangeOffers found or 'exchangeOffers' is not an array.");
    throw new Error("No exchangeOffers found or 'exchangeOffers' is not an array.");
  }

  // Check exchange offers exist
  test(`'exchangeOffers' array exists with ${jsonData.exchangeOffers.length} exchange offer(s)`, () => {
    validationLogger(`[DEBUG] 'exchangeOffers' array exists with ${jsonData.exchangeOffers.length} exchange offer(s)`);
    expect(jsonData.exchangeOffers, "[ERROR] 'exchangeOffers' is missing or empty").to.be.an("array").that.is.not.empty;
  });

  // Validate each exchange offer
  jsonData.exchangeOffers.forEach((exchangeOffer, index) => {
    validateExchangeOfferResponse(exchangeOffer, index, expectedFulfillmentStatus);
  });

  // Store first offer ID
  bru.setEnvVar("exchangeOffersOfferId", jsonData.exchangeOffers[0].offerId);
  validationLogger(`[DEBUG] Stored exchangeOffersOfferId: ${jsonData.exchangeOffers[0].offerId}`);

  // Expired-exchange-offer test (Phase 4): capture the
  // ExchangeOffer.preBookableUntil of the offer the POST /exchange-operations
  // will accept (exchangeOffers[0]). Note the SPEC FIELD NAME is
  // `preBookableUntil`, NOT `validUntil` — this is the per-resource-type
  // naming inconsistency #25 documented in OSDM_Spec_Deviations: every other
  // offer-expiry field uses `validUntil`, the exchange flow uses
  // `preBookableUntil` for the same semantic. The env-var name mirrors the
  // spec literal so the deviation stays discoverable.
  const _firstExchangeOffer = jsonData.exchangeOffers[0];
  if (_firstExchangeOffer && _firstExchangeOffer.preBookableUntil) {
    bru.setEnvVar("exchangeOfferPreBookableUntil", String(_firstExchangeOffer.preBookableUntil));
    bru.setEnvVar("exchangeOfferPreBookableUntilSource", "exchangeOffers[0].preBookableUntil");
    validationLogger(`[INFO] Captured exchangeOffer preBookableUntil = ${_firstExchangeOffer.preBookableUntil}`);
  }
}

// Function to validate exchange operations response (using 11_turnit_exchange.json structure)
function postPatchExchangeOperationsResponse(jsonData, expectedExchangeOperationStatus, expectedFulfillmentStatus) {
  validationLogger("[DEBUG] ➤ postPatchExchangeOperationsResponse");
  if (typeof checkWarningsAndProblems === "function") {
    checkWarningsAndProblems(jsonData);
  }
  // Stop flow if exchangeOperation invalid
  if (typeof jsonData.exchangeOperation !== 'object' || jsonData.exchangeOperation === null) {
    validationLogger("[ERROR] No exchangeOperation found or 'exchangeOperation' is not an object.");
    throw new Error("No exchangeOperation found or 'exchangeOperation' is not an object.");
  }

  // Validate exchangeOperation exists
  test(`'exchangeOperation' exists in response`, () => {
    validationLogger("[DEBUG] Exchange operation found in response");
    expect(jsonData).to.have.property('exchangeOperation');
    expect(jsonData.exchangeOperation).to.not.be.null;
  });

  // Validate exchangeOperation ID
  test(`Exchange operation has a valid Id ${jsonData.exchangeOperation.id}`, () => {
    validationLogger(`[DEBUG] Exchange operation has a valid Id ${jsonData.exchangeOperation.id}`);
    expect(jsonData.exchangeOperation.id).to.exist;
    expect(jsonData.exchangeOperation.id).to.be.a('string').and.not.empty;
  });

  // Validate exchangeOperation status
  test(`Exchange operation has valid status, expected : ${expectedExchangeOperationStatus}, actual : ${jsonData.exchangeOperation.status}`, () => {
    validationLogger(`[DEBUG] Exchange operation has valid status, expected : ${expectedExchangeOperationStatus}, actual : ${jsonData.exchangeOperation.status}`);
    expect(expectedExchangeOperationStatus).to.include(jsonData.exchangeOperation.status);
  });

  // Validate exchangeOffers
  test(`Exchange operation contains exchangeOffers`, () => {
    validationLogger(`[DEBUG] 🔍 ${jsonData.exchangeOperation.exchangeOffers.length} exchange offer(s) in operation`);
    expect(jsonData.exchangeOperation).to.have.property('exchangeOffers');
    expect(jsonData.exchangeOperation.exchangeOffers).to.be.an('array').that.is.not.empty;
  });

  jsonData.exchangeOperation.exchangeOffers.forEach((exchangeOffer, index) => {
    validateExchangeOfferResponse(exchangeOffer, index, expectedFulfillmentStatus);
  });

  // Store exchangeOperation ID
  bru.setEnvVar("exchangeOperationId", jsonData.exchangeOperation.id);
  validationLogger(`[DEBUG] Stored exchangeOperationId: ${jsonData.exchangeOperation.id}`);
}

// Function to validate exchange offer
function validateExchangeOfferResponse(exchangeOffer, index, expectedFulfillmentStatus) {
  validationLogger("[DEBUG] ➤ validateExchangeOfferResponse");
  validationLogger(`[DEBUG] Validating exchange offer at index ${index}`);

  // Validate exchange offer ID
  test(`Exchange offer at index ${index} has a valid Offer Id ${exchangeOffer.offerId}`, () => {
    validationLogger(`[DEBUG] Exchange offer at index ${index} has a valid Offer Id ${exchangeOffer.offerId}`);
    expect(exchangeOffer.offerId).to.exist;
  });

  // F2: preBookableUntil must be a valid future datetime (OSDM: ExchangeOffer.preBookableUntil required)
  if (exchangeOffer.preBookableUntil) {
    const _pbu = new Date(exchangeOffer.preBookableUntil);
    test(`Exchange offer[${index}].preBookableUntil is a valid future datetime (OSDM: required)`, () => {
      expect(isNaN(_pbu.getTime()), `preBookableUntil is not a valid date: ${exchangeOffer.preBookableUntil}`).to.be.false;
      expect(_pbu.getTime()).to.be.above(Date.now(),
        `preBookableUntil is in the past: ${exchangeOffer.preBookableUntil}`);
      validationLogger(`[DEBUG] Exchange offer[${index}].preBookableUntil: ${exchangeOffer.preBookableUntil} ✓`);
    });
  } else {
    validationLogger(`[DEBUG] Exchange offer[${index}].preBookableUntil absent → test skipped`);
  }

  // F4: admissionOfferParts must be non-empty (OSDM: ExchangeOffer.admissionOfferParts required)
  test(`Exchange offer[${index}].admissionOfferParts is a non-empty array (OSDM: required field)`, () => {
    expect(exchangeOffer.admissionOfferParts).to.be.an('array').with.lengthOf.at.least(1,
      `exchangeOffer.admissionOfferParts must not be empty`);
    validationLogger(`[DEBUG] Exchange offer[${index}] has ${exchangeOffer.admissionOfferParts?.length} admissionOfferPart(s)`);
  });

  // Validate offer structure
  test(`Exchange offer[${index}] has required properties offerSummary, exchangeFee, exchangePrice`, () => {
    validationLogger(`[DEBUG] Exchange offer[${index}] has required properties offerSummary, exchangeFee, exchangePrice`);
    expect(exchangeOffer).to.have.property('offerSummary');
    expect(exchangeOffer).to.have.property('exchangeFee');
    expect(exchangeOffer).to.have.property('exchangePrice');
  });

  // Validate offer summary
  if (exchangeOffer.offerSummary) {
    test(`Exchange offer [${index}] has overallFlexibility: ${exchangeOffer.offerSummary.overallFlexibility} and minimal price: ${exchangeOffer.offerSummary.minimalPrice.amount}`, () => {
      validationLogger(`[DEBUG] Exchange offer [${index}] has overallFlexibility: ${exchangeOffer.offerSummary.overallFlexibility} and minimal price: ${exchangeOffer.offerSummary.minimalPrice.amount}`);
      expect(exchangeOffer.offerSummary).to.have.property('overallFlexibility');
      expect(exchangeOffer.offerSummary.overallFlexibility).to.be.a('string');
      expect(exchangeOffer.offerSummary).to.have.property('minimalPrice');
      expect(exchangeOffer.offerSummary.minimalPrice.amount).to.be.a('number');
    });
  } else {
    validationLogger(`[WARN] Exchange offer[${index}] offerSummary is missing`);
  }

  // Validate amountToBePaid if present
  if (exchangeOffer.amountToBePaid) {
    test(`Exchange offer[${index}] has amount to be paid: ${exchangeOffer.amountToBePaid.amount}`, () => {
      validationLogger(`[DEBUG] Exchange offer[${index}] has amount to be paid: ${exchangeOffer.amountToBePaid.amount}`);
      expect(exchangeOffer.amountToBePaid.amount).to.be.a('number');
    });
    // F1: Use integer arithmetic to avoid floating-point errors (OSDM financial identity)
    const _confirmedPriceAmount = Number(bru.getEnvVar("confirmedPriceAmount"));
    const _scale     = Math.pow(10, exchangeOffer.exchangePrice?.scale || 2);
    const _exPriceInt = Math.round(exchangeOffer.exchangePrice.amount * _scale);
    const _exFeeInt   = Math.round(exchangeOffer.exchangeFee.amount * _scale);
    const _confInt    = Math.round(_confirmedPriceAmount * _scale);
    const _toPayInt   = Math.round(exchangeOffer.amountToBePaid.amount * _scale);
    test(`Exchange offer[${index}] amountToBePaid = exchangePrice + exchangeFee - confirmedPrice (OSDM financial identity, integer arithmetic)`, () => {
      validationLogger(`[DEBUG] exchangePrice=${exchangeOffer.exchangePrice.amount}, exchangeFee=${exchangeOffer.exchangeFee.amount}, confirmedPrice=${_confirmedPriceAmount}`);
      validationLogger(`[DEBUG] Expected amountToBePaid (scaled) = ${_exPriceInt} + ${_exFeeInt} - ${_confInt} = ${_exPriceInt + _exFeeInt - _confInt}`);
      expect(_toPayInt).to.eql(_exPriceInt + _exFeeInt - _confInt,
        `amountToBePaid(${_toPayInt}) ≠ exchangePrice(${_exPriceInt}) + exchangeFee(${_exFeeInt}) - confirmedPrice(${_confInt})`);
      validationLogger(`[DEBUG] Exchange financial identity verified: amountToBePaid=${exchangeOffer.amountToBePaid.amount}`);
    });
  } else {
    validationLogger(`[WARN] Exchange offer[${index}] amountToBePaid is missing`);
  }

  const expectedOverruleCode = bru.getEnvVar("overruleCode") || null;
  // Validate applied overrule code if present
  if (exchangeOffer.appliedOverruleCode) {
    validateExchangeAppliedOverruleCode(exchangeOffer.appliedOverruleCode, expectedOverruleCode);
  }

  // #396: exchange-fee schedule consistency runs in the NORMAL flow now. The old
  // code ran it ONLY inside `if (appliedOverruleCode)` — but an overrule
  // overrides the declared schedule, so the comparison was against the wrong
  // baseline exactly there, while the normal (non-overrule) exchange was never
  // checked. The function itself skips when an overruleCode was sent.
  validateExchangeFeesConsistentWithAfterSalesConditions(exchangeOffer);

  // Validate refundableAmount if present
  if (exchangeOffer.refundableAmount !== undefined && exchangeOffer.refundableAmount !== null && exchangeOffer.refundableAmount.amount !== null) {
    test(`Exchange offer[${index}] has refundable amount defined ${exchangeOffer.refundableAmount.amount}`, () => {
      validationLogger(`[DEBUG] Exchange offer[${index}] has refundable amount defined ${exchangeOffer.refundableAmount.amount}`);
      expect(exchangeOffer.refundableAmount.amount).to.be.a('number');
    });
  } else {
    validationLogger(`[DEBUG] Exchange offer[${index}] refundable amount is not defined`);
  }

  // Store all offer part IDs for later fulfillment validation when on that specific request
  const requestName = (typeof req !== 'undefined' && typeof req.getName === 'function') ? req.getName() : "";
  if (requestName === "12. GET Exchange Offer") {
    const _rawIds = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
    const admissionReservationAncillaryBookingPartsIds = Array.isArray(_rawIds) ? _rawIds : JSON.parse(_rawIds || "[]");
    const allPartIds = [
      ...(exchangeOffer.admissionOfferParts || []).map(part => part.id),
      ...(exchangeOffer.reservationOfferParts || []).map(part => part.id),
      ...(exchangeOffer.ancillaryOfferParts || []).map(part => part.id)
    ].filter(id => id);

    admissionReservationAncillaryBookingPartsIds.push(...allPartIds);
    bru.setEnvVar("admissionReservationAncillaryBookingPartsIds", admissionReservationAncillaryBookingPartsIds);
    validationLogger(`[DEBUG] Collected ${allPartIds.length} exchange offer parts IDs`);
  }

  // Validate fulfillments
  if (exchangeOffer.fulfillments && expectedFulfillmentStatus) {
    if (typeof validateFulfillments === "function") {
      // #253: pass the sibling exchangeOffer.fulfillmentDocuments[] (v3.8) so
      // each fulfillment.fulfillmentDocumentRef can be checked against a sibling id.
      validateFulfillments(exchangeOffer.fulfillments, index, expectedFulfillmentStatus, false, exchangeOffer.fulfillmentDocuments);
    }
  }
}

// Function to validate exchange fees are consistent with after-sales conditions
function validateExchangeFeesConsistentWithAfterSalesConditions(exchangeOffer) {
  validationLogger("[DEBUG] \u27a4 validateExchangeFeesConsistentWithAfterSalesConditions");
  // #396: schedule-aware exchange-fee consistency (mirrors the refund #391 model).
  // The old version summed afterSaleFee across ALL EXCHANGE windows of ALL parts
  // and hard-asserted equality to exchangeFee (and to a second naive sum carried
  // in an env var) — a part with a two-window schedule (e.g. 50% before travel,
  // 100% after) contributed 150%, manufacturing a false 'exchange fee mismatch'
  // on any multi-window / multi-part offer. Now: the expected fee is the sum of
  // the ACTIVE window's fee per value-bearing part, and the check is DECODE-SAFE
  // (hard-asserts only when every value-bearing part has a decodable active
  // EXCHANGE schedule and one currency; otherwise INFO + skip, no false fail).
  const exchangeFee = exchangeOffer && exchangeOffer.exchangeFee;
  if (!exchangeFee || typeof exchangeFee.amount !== 'number') {
    validationLogger("[DEBUG] Exchange offer carries no numeric exchangeFee \u2014 nothing to verify against the schedule.");
    return;
  }

  // An overrule explicitly overrides the declared schedule (overrule contract:
  // the fee is the overridden value, not the afterSalesConditions). Skip the
  // schedule comparison, exactly as the refund permissibility gate does.
  const overruleCode = bru.getEnvVar("overruleCode");
  if (overruleCode && overruleCode !== "null") {
    validationLogger(`[INFO] Exchange fee schedule-consistency skipped \u2014 an overruleCode (${overruleCode}) was sent; the overrule overrides the declared EXCHANGE schedule.`);
    return;
  }

  const { expectedRefundForParts } = require("./afterSalesRules.js");
  const parts = []
    .concat(exchangeOffer.admissionOfferParts || [])
    .concat(exchangeOffer.reservationOfferParts || [])
    .concat(exchangeOffer.ancillaryOfferParts || []);

  // expectedRefundForParts threads the action through effectiveRefundability;
  // its .expectedFee is the sum of the active-window fee over value-bearing parts
  // (price > 0) \u2014 exactly what the declared EXCHANGE schedule charges right now.
  const r = expectedRefundForParts(parts, Date.now(), "EXCHANGE");

  if (!r.ok) {
    validationLogger(`[INFO] Exchange fee not schedule-decodable (${r.reason}) \u2014 OSCAR does not assert exchangeFee against the conditions here; the provider's exchangeFee (${exchangeFee.amount}${exchangeFee.currency ? ' ' + exchangeFee.currency : ''}) stands on its own.`);
    return;
  }
  if (exchangeFee.currency && r.currency && exchangeFee.currency !== r.currency) {
    validationLogger(`[INFO] Exchange fee currency (${exchangeFee.currency}) differs from the schedule currency (${r.currency}) \u2014 schedule decode skipped.`);
    return;
  }

  test(`Exchange fee matches the active EXCHANGE schedule \u2014 exchangeFee ${exchangeFee.amount} = active-window fee ${r.expectedFee}`, () => {
    validationLogger(`[DEBUG] Exchange fee schedule decode: per part [${r.detail.join('; ')}] \u2192 expected active-window fee ${r.expectedFee}; provider exchangeFee ${exchangeFee.amount}.`);
    if (exchangeFee.amount !== r.expectedFee) {
      throw new Error(`The declared EXCHANGE schedule charges ${r.expectedFee} right now (${r.detail.join('; ')}), but the exchange offer's exchangeFee is ${exchangeFee.amount} \u2014 the engine and its own declared schedule disagree.`);
    }
  });
  validationLogger(`[INFO] Exchange fee schedule decode OK \u2014 exchangeFee ${exchangeFee.amount} matches the active EXCHANGE schedule (active-window fee ${r.expectedFee}).`);
}

// Function to validate applied overrule code
function validateExchangeAppliedOverruleCode(appliedOverruleCode, expectedOverruleCode) {
  validationLogger(`[DEBUG] ExpectedOverruleCode: ${expectedOverruleCode}`);
  validationLogger(`[DEBUG] AppliedOverruleCode: ${appliedOverruleCode}`);

  const title = expectedOverruleCode === null
    ? "AppliedOverruleCode is null as expected"
    : `AppliedOverruleCode is valid, (expected: appliedOverruleCode = ${appliedOverruleCode}, actual: expectedOverruleCode = ${expectedOverruleCode})`;

  test(title, () => {
    expect(appliedOverruleCode).to.equal(expectedOverruleCode);
  });
}

// Expose to global for convenience in eval/require loader flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
