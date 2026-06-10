/**
 * refunds.js — validate the after-sales REFUND flow responses.
 *
 * Runs in the Refund scenario folder (after an initial sale). Validates the
 * PATCH refund-offer response and the refund fee/amount against OSDM and the
 * offer's after-sales conditions.
 */
// Import needed library files
require('./displays.js');
const { bruTest: test } = require('./testCapture.js');

module.exports = {
  postPatchRefundOfferResponse,
  validateRefundOfferResponse,
  validateRefundFee: validateRefundFeeLocal,
  validateRefundableAmount: validateRefundableAmountLocal,
  validateRefundAppliedOverruleCode,
  getBookingRefundResponse
};

// Function to validate refund offers response
function postPatchRefundOfferResponse(jsonData, expectedRefundOperationStatus, expectedFulfillmentStatus) {
  validationLogger("[DEBUG] ➤ postPatchRefundOfferResponse");
  if (typeof checkWarningsAndProblems === "function") {
    checkWarningsAndProblems(jsonData);
  }

  // Convert single refundOffer to refundOffers array if necessary
  if (jsonData.refundOffer && !jsonData.refundOffers) {
    jsonData.refundOffers = [jsonData.refundOffer];
    validationLogger("[INFO] Converted single refundOffer to refundOffers array");
  }

  // Stop flow if refundOffers invalid
  if (!Array.isArray(jsonData.refundOffers) || jsonData.refundOffers.length === 0) {
    validationLogger("[ERROR] No refundOffers found or 'refundOffers' is not an array.");
    throw new Error("No refundOffers found or 'refundOffers' is not an array.");
  }

  // Check refund offers exist
  test(`'refundOffers' array exists with ${jsonData.refundOffers.length} refund offer(s)`, () => {
    expect(jsonData.refundOffers, "[ERROR] 'refundOffers' is missing or empty").to.be.an("array").that.is.not.empty;
    validationLogger(`[INFO] 'refundOffers' array exists with ${jsonData.refundOffers.length} refund offer(s)`);
  });

  // Validate each refund offer
  jsonData.refundOffers.forEach((refundOffer, index) => {
    validateRefundOfferResponse(refundOffer, index, expectedRefundOperationStatus, expectedFulfillmentStatus);
  });

  // Store first offer ID
  bru.setEnvVar("refundOffersOfferId", jsonData.refundOffers[0].id);
  validationLogger(`[INFO] Stored refundOffersOfferId: ${jsonData.refundOffers[0].id}`);

  // Expired-refund-offer test (Phase 3): capture the RefundOffer.validUntil of
  // the offer the PATCH will accept (refundOffers[0]), but ONLY on the POST
  // /refund-offers callsite — that's where the offer is freshly PROPOSED. The
  // same helper is reused by 11.yml (GET, also PROPOSED → safe to recapture
  // the same value) and 13.yml (PATCH → expects CONFIRMED), so we gate on
  // expectedRefundOperationStatus including "PROPOSED" to avoid 13.yml
  // overwriting the deadline with a post-confirmation value that would either
  // be null or already in the past.
  const _expectedStatuses = Array.isArray(expectedRefundOperationStatus)
    ? expectedRefundOperationStatus
    : [expectedRefundOperationStatus];
  if (_expectedStatuses.includes("PROPOSED")) {
    const _firstRefundOffer = jsonData.refundOffers[0];
    if (_firstRefundOffer && _firstRefundOffer.validUntil) {
      bru.setEnvVar("refundOfferValidUntil", String(_firstRefundOffer.validUntil));
      bru.setEnvVar("refundOfferValidUntilSource", "refundOffers[0].validUntil");
      validationLogger(`[INFO] Captured refundOffer validUntil = ${_firstRefundOffer.validUntil}`);
    }
  }
}

// Function to validate a single refund offer
function validateRefundOfferResponse(refundOffer, index, expectedRefundOperationStatus, expectedFulfillmentStatus) {
  validationLogger("[DEBUG] ➤ validateRefundOfferResponse");
  validationLogger(`[INFO] Validating refund offer at index ${index}`);

  // Validate refund offer ID
  test(`Refund offer at index ${index} has a valid Offer Id ${refundOffer.id}`, () => {
    expect(refundOffer.id).to.exist;
    expect(refundOffer.id).to.be.a('string').and.not.be.empty;
    validationLogger(`[INFO] Refund offer at index ${index} has a valid Offer Id ${refundOffer.id}`);
  });

  // Validate status
  test(`Refund offer[${index}] has valid status, expected: ${expectedRefundOperationStatus}, actual: ${refundOffer.status}`, () => {
    expect(refundOffer.status).to.exist;
    // expectedRefundOperationStatus can be array or string; normalize to array
    const expectedStatuses = Array.isArray(expectedRefundOperationStatus)
      ? expectedRefundOperationStatus
      : [expectedRefundOperationStatus];
    expect(expectedStatuses).to.include(refundOffer.status);
    validationLogger(`[INFO] Refund offer[${index}] has valid status, expected: ${expectedRefundOperationStatus}, actual: ${refundOffer.status}`);
  });

  // Validate dates.
  // #337: `new Date(null)` returns epoch 0 (1970-01-01) instead of Invalid
  // Date, so the downstream `!isNaN(getTime())` guards used to let the JSON-
  // literal-null case through unnoticed. The test would then fire with an
  // empty title (because _withLocal handles null gracefully and returns '')
  // and fail at `expect(refundOffer.validFrom).to.exist` — leaving the
  // reader staring at "expected null to exist" with no idea WHICH field.
  // Build the Date only from non-null strings so the outer guard genuinely
  // filters out the absent case, and emit an explicit [ERROR] for it.
  const currentDate = new Date();
  const _toDate = v => (typeof v === 'string' && v.trim() !== '') ? new Date(v) : new Date(NaN);
  const createdOn  = _toDate(refundOffer.createdOn);
  const validFrom  = _toDate(refundOffer.validFrom);
  const validUntil = _toDate(refundOffer.validUntil);

  // Local-time annotator (v1.11.106): provider timestamps come back in UTC
  // (e.g. 2026-06-09T05:23:26+00:00). The assertion message echoed the raw
  // UTC string, leaving testers to do the +1h/+2h math against their local
  // clock. The annotator appends a parenthetical Europe/Paris equivalent so
  // the report shows both reads at once.
  // Examples:
  //   utc:   2026-06-09T05:23:26.087386+00:00
  //   local: 2026-06-09 07:23:26 Europe/Paris  (CEST = UTC+2)
  function _withLocal(utcString, parsedDate) {
    if (!utcString || !parsedDate || isNaN(parsedDate.getTime())) return utcString || '';
    try {
      const local = parsedDate.toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
      return `${utcString} (= ${local} Europe/Paris)`;
    } catch (_e) {
      return utcString;
    }
  }

  // #337 helper: convert a single date-field outcome into either a passing test
  // (when the value is a non-null parseable ISO string) or an explicit ERROR
  // assertion that names whether the field was ABSENT vs MALFORMED. Avoids
  // the prior "expected null to exist" mystery.
  function _checkDatePresent(fieldName, rawValue, parsedDate, testTitle) {
    if (rawValue == null) {
      test(`Refund offer[${index}] ${fieldName} is present`, () => {
        expect.fail(
          `${fieldName} is absent in refundOffer (received ${rawValue === null ? 'JSON null' : 'undefined'}). ` +
          `OSDM RefundOffer requires ${fieldName} as a datetime string.`
        );
      });
      return false;
    }
    if (isNaN(parsedDate.getTime())) {
      test(`Refund offer[${index}] ${fieldName} parses as a datetime`, () => {
        expect.fail(
          `${fieldName} is present but does not parse as a datetime — got: ${JSON.stringify(rawValue)}. ` +
          `Expected ISO-8601 datetime string per OSDM.`
        );
      });
      return false;
    }
    return true;
  }

  // Validate createdOn
  if (_checkDatePresent('createdOn', refundOffer.createdOn, createdOn)) {
    const _label = _withLocal(refundOffer.createdOn, createdOn);
    test(`Refund offer[${index}] createdOn is valid and in the past: ${_label}`, () => {
      expect(createdOn.getTime(),
        `createdOn (${refundOffer.createdOn}) is in the future relative to now (${currentDate.toISOString()})`
      ).to.be.at.most(currentDate.getTime());
      validationLogger(`[INFO] Refund offer[${index}] createdOn is valid and in the past: ${_label}`);
    });
  }

  // Validate validFrom
  if (_checkDatePresent('validFrom', refundOffer.validFrom, validFrom)) {
    const _label = _withLocal(refundOffer.validFrom, validFrom);
    test(`Refund offer[${index}] validFrom is valid: ${_label}`, () => {
      // Presence + parseability already checked above; this body is reserved
      // for any future range/order assertions (currently just a heartbeat).
      validationLogger(`[INFO] Refund offer[${index}] validFrom is valid: ${_label}`);
    });
  }

  // Validate validUntil (approx 15 minutes in future with 2 minutes tolerance)
  if (_checkDatePresent('validUntil', refundOffer.validUntil, validUntil)) {
    const _label = _withLocal(refundOffer.validUntil, validUntil);
    test(`Refund offer[${index}] validUntil is valid and approximately 15 minutes in the future: ${_label}`, () => {
      expect(validUntil.getTime(),
        `validUntil (${refundOffer.validUntil}) is not in the future relative to now (${currentDate.toISOString()})`
      ).to.be.above(currentDate.getTime());

      const expectedValidUntil = new Date(currentDate.getTime() + 15 * 60 * 1000);
      const tolerance = 2 * 60 * 1000; // 2 minutes
      const difference = Math.abs(validUntil.getTime() - expectedValidUntil.getTime());
      expect(difference,
        `validUntil is ${Math.round(difference/1000)}s away from the expected ~15min mark (tolerance ±${tolerance/1000}s). Got ${refundOffer.validUntil}, expected ~${expectedValidUntil.toISOString()}.`
      ).to.be.at.most(tolerance);
      validationLogger(`[INFO] Refund offer[${index}] validUntil is valid and approximately 15 minutes in the future: ${_label}`);
    });
  }

  // E1: validFrom must be before or equal to validUntil (OSDM: temporal order required)
  if (!isNaN(validFrom.getTime()) && !isNaN(validUntil.getTime())) {
    test(`Refund offer[${index}] validFrom is before or equal to validUntil (OSDM: temporal order)`, () => {
      expect(validFrom.getTime()).to.be.at.most(validUntil.getTime(),
        `validFrom (${refundOffer.validFrom}) is after validUntil (${refundOffer.validUntil})`);
      validationLogger(`[INFO] Refund offer[${index}] temporal order OK: validFrom=${refundOffer.validFrom} ≤ validUntil=${refundOffer.validUntil}`);
    });
  }

  // Validate appliedOverruleCode
  const overruleCode = bru.getEnvVar("overruleCode");
  validateRefundAppliedOverruleCode(refundOffer.appliedOverruleCode, overruleCode);

  // Validate refundableAmount structure, and compare amounts depending on fulfillment state
  // #337: build the label as a SHAPE report (which sub-fields are present /
  // what type each is) rather than as a happy-path summary, so a failure on
  // any one sub-field (typically `scale`) doesn't leave the title saying
  // "amount: 0, currency: CZK" as if everything was fine. Each expect() also
  // gets a second-arg context naming the missing/wrong sub-field so the
  // assertion failure is self-explaining.
  const expectedFulfillmentStatuses = Array.isArray(expectedFulfillmentStatus) ? expectedFulfillmentStatus : [expectedFulfillmentStatus];
  const _priceShape = (obj) => {
    if (obj == null) return 'missing';
    const _hasA = typeof obj.amount   === 'number';
    const _hasC = typeof obj.currency === 'string' && obj.currency !== '';
    const _hasS = typeof obj.scale    === 'number';
    if (_hasA && _hasC && _hasS) return `amount=${obj.amount}, currency=${obj.currency}, scale=${obj.scale}`;
    // SHAPE report: mark each sub-field present/MISSING so the broken one
    // shows in the test title even when other fields look normal.
    const _badge = (ok, name, val) => ok ? `${name}=${val}` : `${name}=MISSING(got ${JSON.stringify(val)})`;
    return [
      _badge(_hasA, 'amount',   obj.amount),
      _badge(_hasC, 'currency', obj.currency),
      _badge(_hasS, 'scale',    obj.scale),
    ].join(', ');
  };
  const refundableAmountLabel = _priceShape(refundOffer.refundableAmount);
  test(`Refund offer[${index}] refundableAmount Price structure is well-formed — ${refundableAmountLabel}`, () => {
    validationLogger(`[INFO] Refund offer[${index}] refundableAmount: ${refundOffer.refundableAmount?.amount} ${refundOffer.refundableAmount?.currency}`);
    expect(refundOffer.refundableAmount, 'refundableAmount missing in RefundOffer').to.exist;
    expect(refundOffer.refundableAmount, 'refundableAmount is not an object').to.be.an('object');
    expect(refundOffer.refundableAmount.amount,   'refundableAmount.amount is not a number (OSDM Price.amount: integer)').to.be.a('number');
    expect(refundOffer.refundableAmount.currency, 'refundableAmount.currency is not a string (OSDM Price.currency: ISO-4217 code)').to.be.a('string');
    expect(refundOffer.refundableAmount.scale,    'refundableAmount.scale is not a number (OSDM Price.scale: required integer, typically 0)').to.be.a('number');

    if (expectedFulfillmentStatuses.includes("CONFIRMED") || expectedFulfillmentStatuses.includes("FULFILLED")) {
      const confirmedPriceAmount = Number(bru.getEnvVar("confirmedPriceAmount"));
      validateRefundableAmountLocal(refundOffer, overruleCode, confirmedPriceAmount);
    } else if (expectedFulfillmentStatuses.includes("PROPOSED")) {
      bru.setEnvVar("refundRefundAmount", refundOffer.refundableAmount.amount);
      bru.setEnvVar("refundFee", refundOffer.refundFee?.amount);
    }
  });

  // Validate refundFee structure
  // v1.11.108: clearer wording. The assertion is structural — *"the Price
  // object is well-formed"* — not economic — *"the carrier kept money"*.
  // Per OSDM (RefundOffer.refundFee: 'Amount kept by the carrier and/or
  // distributor') the field is REQUIRED on every RefundOffer; the Price
  // object MUST be present even when amount=0 (no retention).
  // #337: use the same SHAPE-report label as refundableAmount above so the
  // broken sub-field shows in the title even when other fields look OK.
  let refundFeeLabel;
  if (!refundOffer.refundFee) {
    refundFeeLabel = 'missing';
  } else {
    const amt = refundOffer.refundFee.amount;
    const retention = (amt === 0) ? ' (= no carrier retention)'
                    : (typeof amt === 'number') ? ' (= kept by carrier per OSDM)'
                    : '';
    refundFeeLabel = `${_priceShape(refundOffer.refundFee)}${retention}`;
  }
  test(`Refund offer[${index}] refundFee Price structure is well-formed — ${refundFeeLabel}`, () => {
    validationLogger(`[INFO] Refund offer[${index}] refundFee: ${refundOffer.refundFee?.amount} ${refundOffer.refundFee?.currency}`);
    expect(refundOffer.refundFee, 'refundFee missing in RefundOffer (OSDM: required even at amount=0)').to.exist;
    expect(refundOffer.refundFee, 'refundFee is not an object').to.be.an('object');
    expect(refundOffer.refundFee.amount,   'refundFee.amount is not a number (OSDM Price.amount: integer)').to.be.a('number');
    expect(refundOffer.refundFee.currency, 'refundFee.currency is not a string (OSDM Price.currency: ISO-4217 code)').to.be.a('string');
    expect(refundOffer.refundFee.scale, 'refundFee.scale is not a number (OSDM Price.scale: required integer, typically 0)').to.be.a('number');
    expect(refundOffer.refundFee.amount).to.be.at.least(0);
  });

  // E3: fulfillments must be a non-empty array (OSDM: RefundOffer.fulfillments minItems:1)
  test(`Refund offer[${index}] fulfillments is a non-empty array (OSDM: minItems:1)`, () => {
    expect(refundOffer.fulfillments).to.be.an('array').with.lengthOf.at.least(1,
      `refundOffer.fulfillments must not be empty`);
    validationLogger(`[INFO] Refund offer[${index}] has ${refundOffer.fulfillments?.length} fulfillment(s)`);
  });

  // Validate reimbursementStatus
  if (refundOffer.reimbursementStatus) {
    test(`Refund offer[${index}] has valid reimbursementStatus: ${refundOffer.reimbursementStatus}`, () => {
      expect(refundOffer.reimbursementStatus).to.exist;
      expect(refundOffer.reimbursementStatus).to.be.oneOf(['IMMEDIATE', 'DELAYED']);
      validationLogger(`[INFO] Refund offer[${index}] has valid reimbursementStatus: ${refundOffer.reimbursementStatus}`);
    });
  } else {
    validationLogger(`[INFO] reimbursementStatus is not present in refund offer[${index}] → test skipped`);
  }

  // Validate refundOfferBreakDown
  if (Array.isArray(refundOffer.refundOfferBreakDown) && refundOffer.refundOfferBreakDown.length > 0) {
    test(`Refund offer[${index}] has ${refundOffer.refundOfferBreakDown.length} breakdown(s)`, () => {
      expect(refundOffer.refundOfferBreakDown).to.be.an('array').that.is.not.empty;
      validationLogger(`[INFO] Refund offer[${index}] has ${refundOffer.refundOfferBreakDown.length} breakdown(s)`);
    });

    refundOffer.refundOfferBreakDown.forEach((breakdown, bdIndex) => {
      const bdLabel = `refundFee amount: ${breakdown.refundFee?.amount}, refundableAmount amount: ${breakdown.refundableAmount?.amount}`;
      test(`Refund offer[${index}] breakdown[${bdIndex}] is valid, ${bdLabel}`, () => {
        // Validate refundFee
        validationLogger(`[INFO] Refund offer[${index}] breakdown[${bdIndex}] refundFee: ${breakdown.refundFee.amount} ${breakdown.refundFee.currency}`);
        expect(breakdown.refundFee).to.exist;
        expect(breakdown.refundFee.amount).to.be.a('number').and.at.least(0);
        expect(breakdown.refundFee.currency).to.be.a('string');
        expect(breakdown.refundFee.scale).to.be.a('number');

        // Validate refundableAmount
        expect(breakdown.refundableAmount).to.exist;
        expect(breakdown.refundableAmount.amount).to.be.a('number');
        expect(breakdown.refundableAmount.currency).to.be.a('string');
        expect(breakdown.refundableAmount.scale).to.be.a('number');

        // Validate bookingParts
        expect(breakdown.bookingParts).to.be.an('array').that.is.not.empty;

        // Validate fulfillmentId
        expect(breakdown.fulfillmentId).to.be.a('string').and.not.be.empty;

        validationLogger(`[INFO] Refund offer[${index}] breakdown[${bdIndex}] is valid, refundFee amount: ${breakdown.refundFee.amount}, refundableAmount amount: ${breakdown.refundableAmount.amount} bookingParts=${breakdown.bookingParts.length}, fulfillmentId=${breakdown.fulfillmentId}`);
      });

      // Store bookingParts IDs for later validation (log only; storage optional)
      const partRefs = breakdown.bookingParts.map(bp => bp.id);
      validationLogger(`[INFO] Refund offer[${index}] breakdown[${bdIndex}] bookingParts IDs: ${partRefs.join(', ')}`);
    });
  } else {
    validationLogger(`[INFO] No refundOfferBreakDown found for refund offer[${index}]`);
  }

  // Validate fulfillments
  if (refundOffer.fulfillments) {
    if (typeof validateFulfillments === "function") {
      // Support both signatures: (fulfillments, expected) and (fulfillments, index, expected)
      // #253: pass refundOffer.fulfillmentDocuments[] (v3.8 sibling) for ref→id integrity.
      if (validateFulfillments.length >= 3) {
        validateFulfillments(refundOffer.fulfillments, index, expectedFulfillmentStatus, false, refundOffer.fulfillmentDocuments);
      } else {
        validateFulfillments(refundOffer.fulfillments, expectedFulfillmentStatus);
      }
    }
  }
}

// Wrapper in case a global implementation already exists elsewhere
function validateRefundFeeLocal(refundFee) {
  if (typeof validateRefundFee === "function" && validateRefundFee !== validateRefundFeeLocal) {
    return validateRefundFee(refundFee);
  }
  validationLogger(`[INFO] Validating refund fee: ${refundFee.amount} ${refundFee.currency}`);
  test(`Refund fee is valid and non-negative`, () => {
    expect(refundFee.amount).to.be.at.least(0);
    validationLogger(`[INFO] Refund fee amount: ${refundFee.amount} (non-negative)`);
  });
}

// Wrapper in case a global implementation already exists elsewhere
function validateRefundableAmountLocal(refundOffer, overruleCode, confirmedPriceAmount) {
  if (typeof validateRefundableAmount === "function" && validateRefundableAmount !== validateRefundableAmountLocal) {
    return validateRefundableAmount(refundOffer, overruleCode, confirmedPriceAmount);
  }
  validationLogger(`[INFO] confirmedPriceAmount: ${confirmedPriceAmount}`);
  validationLogger(`[INFO] RefundOffer.refundableAmount.amount: ${refundOffer.refundableAmount.amount}`);
  validationLogger(`[INFO] RefundOffer.refundFee.amount: ${refundOffer.refundFee.amount}`);
  validationLogger(`[INFO] OverruleCode: ${overruleCode}`);

  // Partial refund (#218) — the strict full-refund financial identity
  // `refundFee + refundableAmount = confirmedPrice` does NOT hold when the
  // refund is scoped to a subset of booking parts or passengers. In that
  // case we assert the WEAKER but meaningful identity:
  //   refundFee + refundableAmount  <  confirmedPrice
  // (partial scope must return strictly less than the full booking price).
  // When partial refund was REQUESTED but DEGRADED to full at runtime, the
  // standard full-refund identity applies — the degradation flag tells us
  // which mode to use.
  const _partialArmed = (
    String(bru.getEnvVar("partialRefundByLeg")) === "true" ||
    String(bru.getEnvVar("partialRefundByPax")) === "true"
  );
  const _partialDegraded = String(bru.getEnvVar("__partialRefundDegradedToFull")) === "true";
  const _isPartial = _partialArmed && !_partialDegraded;

  // ─────────────────────────────────────────────────────────────────────────
  //  Refund response value assertions (#218 follow-up — v1.11.106)
  //  The historical assertion was semantically inverted: it claimed
  //  `refundableAmount == 0` whenever `overruleCode` was absent, which
  //  encoded the assumption that "no overrule => refund denied". That's
  //  only true in a narrow edge case (booking outside the validity window
  //  of every applicable afterSalesCondition). The general truth is:
  //
  //    NORMAL FLOW (no overrule) — the provider OWNS the rules. They depend
  //      on time, fare class, distance from departure, internal commercial
  //      decisions, etc. OSCAR can't predict the answer; the provider's
  //      response is authoritative. OSCAR's job is to verify structural
  //      soundness (non-negative, bounded by confirmedPrice, currency
  //      consistency) and log what came back for a human to reconcile.
  //
  //    EXCEPTIONAL FLOW (overrule set, != CODE_DOES_NOT_EXIST) — the
  //      distributor declared the special circumstance. The overrule
  //      contract is "refund the full booking value, no fee". OSCAR's
  //      job is to verify the provider HONOURED that contract.
  //
  //  Partial-refund identity (fee + amount < confirmedPrice strict) is
  //  orthogonal — it applies whenever partial is armed and not degraded,
  //  regardless of overrule.
  // ─────────────────────────────────────────────────────────────────────────
  const _hasOverrule = !!overruleCode && overruleCode !== "CODE_DOES_NOT_EXIST";
  const _scale       = Math.pow(10, refundOffer.refundableAmount?.scale || 2);
  const _feeInt      = Math.round(refundOffer.refundFee.amount * _scale);
  const _refundInt   = Math.round(refundOffer.refundableAmount.amount * _scale);
  const _confirmedInt = Math.round(Number(confirmedPriceAmount) * _scale);

  // ── Structural bounds (always apply) ─────────────────────────────────────
  // Internally consistent response — independent of overrule and scope:
  //   amount, fee ≥ 0
  //   amount + fee ≤ confirmedPrice   (provider can't refund more than was paid)
  //   currency consistent between amount and fee
  test(`Refund response bounds — refundable(${refundOffer.refundableAmount.amount}) and fee(${refundOffer.refundFee.amount}) are non-negative, sum ≤ confirmedPrice(${confirmedPriceAmount}), currencies consistent`, () => {
    expect(_refundInt, `refundableAmount is negative: ${_refundInt}`).to.be.at.least(0);
    expect(_feeInt, `refundFee is negative: ${_feeInt}`).to.be.at.least(0);
    expect(_feeInt + _refundInt,
      `Provider refunded MORE than was paid: fee(${_feeInt}) + refundable(${_refundInt}) = ${_feeInt + _refundInt} > confirmed(${_confirmedInt})`)
      .to.be.at.most(_confirmedInt);
    if (refundOffer.refundableAmount.currency && refundOffer.refundFee.currency) {
      expect(refundOffer.refundableAmount.currency,
        `Currency mismatch: refundableAmount(${refundOffer.refundableAmount.currency}) vs refundFee(${refundOffer.refundFee.currency})`)
        .to.eql(refundOffer.refundFee.currency);
    }
    validationLogger(`[INFO] Refund response bounds OK — fee(${_feeInt}) + refundable(${_refundInt}) ≤ confirmed(${_confirmedInt}).`);
  });

  if (_hasOverrule) {
    // ── EXCEPTIONAL FLOW — verify the overrule contract was honoured ──────
    if (_isPartial) {
      // Partial-with-overrule — the scope is "the in-scope subset" (verified
      // by the partial alignment assertion in 10.yml) and the overrule
      // contract within that scope is "no fee taken". Strict less-than for
      // the partial identity still applies; we add the fee==0 check here.
      test(`Partial refund WITH overrule (${overruleCode}): refundFee should be 0 (overrule waives fee on top of partial scope)`, () => {
        expect(_feeInt, `Overrule(${overruleCode}) was sent but provider still charged a fee: ${_feeInt} (scaled). Overrule contract: waive fees on top of partial scope.`).to.eql(0);
        validationLogger(`[INFO] Overrule(${overruleCode}) honoured on partial scope — fee waived.`);
      });
      test(`Partial refund WITH overrule (${overruleCode}): refundFee(${refundOffer.refundFee.amount}) + refundableAmount(${refundOffer.refundableAmount.amount}) < confirmedPrice(${confirmedPriceAmount}) (partial scope returns strictly less than full)`, () => {
        expect(_feeInt + _refundInt,
          `Partial-refund identity broken: scoped fee+refundable(${_feeInt + _refundInt}) is NOT < confirmed(${_confirmedInt}). Provider refunded the full booking despite refundSpecifications being sent — possible non-conformance.`)
          .to.be.below(_confirmedInt);
        const _diff = _confirmedInt - (_feeInt + _refundInt);
        validationLogger(`[INFO] Partial-refund scope verified (scaled): ${_feeInt} + ${_refundInt} = ${_feeInt + _refundInt} < ${_confirmedInt} (out-of-scope = ${_diff})`);
      });
    } else {
      // Full-with-overrule — strict identity, the canonical overrule contract:
      //   refundableAmount == confirmedPrice
      //   refundFee == 0
      test(`Refund WITH overrule (${overruleCode}): refundableAmount(${refundOffer.refundableAmount.amount}) == confirmedPrice(${confirmedPriceAmount}) AND refundFee == 0 (overrule contract: full restitution, no fee)`, () => {
        expect(_refundInt,
          `Provider did NOT honour overrule(${overruleCode}): refundable(${_refundInt}) ≠ confirmed(${_confirmedInt}). Overrule contract: refund the full booking value.`)
          .to.eql(_confirmedInt);
        expect(_feeInt,
          `Provider did NOT honour overrule(${overruleCode}): fee(${_feeInt}) ≠ 0. Overrule contract: no fee taken on top of full restitution.`)
          .to.eql(0);
        validationLogger(`[INFO] Overrule(${overruleCode}) honoured — full refund (${_refundInt}) and zero fee.`);
      });
    }
  } else {
    // ── NORMAL FLOW (no overrule) — observe; do NOT assert a specific value ─
    // The provider's response IS the source of truth. The structural bounds
    // check above has already verified internal consistency. Here we just
    // surface what the provider answered so a human reviewer can reconcile
    // it against the booking's afterSalesConditions.
    if (_refundInt === 0) {
      validationLogger(`[INFO] No overrule sent and provider returned refundableAmount=0 — provider applied its rules and declined the refund. OSCAR does NOT assert a specific value in the normal flow; the provider's response is authoritative.`);
    } else {
      validationLogger(`[INFO] No overrule sent and provider returned refundableAmount=${refundOffer.refundableAmount.amount} ${refundOffer.refundableAmount.currency} (fee=${refundOffer.refundFee.amount}) — provider applied its rules and the conditions permit a refund. OSCAR does NOT assert a specific value in the normal flow; the provider's response is authoritative. To force a specific expected amount, set an overruleCode on the scenario (overrule contract: amount = confirmedPrice, fee = 0).`);
    }
    // Partial-refund identity still applies in the normal flow.
    if (_isPartial) {
      test(`Partial refund: refundFee(${refundOffer.refundFee.amount}) + refundableAmount(${refundOffer.refundableAmount.amount}) < confirmedPrice(${confirmedPriceAmount}) (partial scope returns strictly less than full)`, () => {
        expect(_feeInt + _refundInt,
          `Partial-refund identity broken: scoped fee+refundable(${_feeInt + _refundInt}) is NOT < confirmed(${_confirmedInt}). Provider refunded the full booking despite refundSpecifications being sent — possible non-conformance.`)
          .to.be.below(_confirmedInt);
        const _diff = _confirmedInt - (_feeInt + _refundInt);
        validationLogger(`[INFO] Partial-refund scope verified (scaled): ${_feeInt} + ${_refundInt} = ${_feeInt + _refundInt} < ${_confirmedInt} (out-of-scope = ${_diff})`);
      });
    }
  }

  // Partial-scope structural check: when partial is armed and not degraded,
  // the refundOfferBreakdownItems[].bookingParts referenced by the response
  // should be a SUBSET of the parts we asked to refund. If the response has
  // no breakdown (some providers omit it) we log INFO instead of failing.
  if (_isPartial) {
    const _resolved = (function () {
      try { return JSON.parse(bru.getEnvVar("__partialRefundResolvedSpec") || "[]"); }
      catch (_e) { return []; }
    })();
    const _requestedPartIds = new Set();
    for (const s of _resolved) {
      for (const pid of (s.bookingPartIds || [])) _requestedPartIds.add(pid);
    }
    const _breakdown = Array.isArray(refundOffer.refundOfferBreakdownItems)
      ? refundOffer.refundOfferBreakdownItems : [];
    if (_breakdown.length === 0 || _requestedPartIds.size === 0) {
      validationLogger(`[INFO] Partial-refund breakdown check skipped (no breakdown returned, or no bookingPartIds requested).`);
    } else {
      const _responsePartIds = new Set();
      for (const b of _breakdown) {
        for (const bp of (b.bookingParts || [])) {
          if (bp && bp.id) _responsePartIds.add(bp.id);
        }
      }
      const _outOfScope = [..._responsePartIds].filter((id) => !_requestedPartIds.has(id));
      test(`Partial refund: response.refundOfferBreakdownItems[].bookingParts is a subset of the requested bookingPartIds (no extra parts refunded)`, () => {
        expect(_outOfScope, `Response includes booking parts that were NOT in refundSpecifications: [${_outOfScope.join(", ")}]`).to.be.empty;
        validationLogger(`[INFO] Partial-refund scope conformance: response parts=[${[..._responsePartIds].join(", ")}] ⊆ requested=[${[..._requestedPartIds].join(", ")}]`);
      });
    }
  }
}

// Function to validate applied overrule code (uses global validateAppliedOverruleCode if available)
function validateRefundAppliedOverruleCode(appliedOverruleCode, expectedOverruleCode) {
  validationLogger(`[INFO] ExpectedOverruleCode: ${expectedOverruleCode}`);
  validationLogger(`[INFO] AppliedOverruleCode: ${appliedOverruleCode}`);
  if (typeof validateAppliedOverruleCode === "function") {
    return validateAppliedOverruleCode(appliedOverruleCode, expectedOverruleCode);
  }
  // v1.11.108: normalise `undefined → null` before comparison. JSON-omitting
  // providers (Paxone today) and JSON-emit-null providers both express "no
  // overrule applied" — the chai strict-equality check used to distinguish
  // them and fire a false-positive failure (`expected undefined to equal
  // null`) on the omitter. Treat both as equivalent: the OSDM contract says
  // the field is optional and absent / null are semantically the same.
  const normalisedApplied = (appliedOverruleCode === undefined) ? null : appliedOverruleCode;
  const title = expectedOverruleCode === null
    ? `AppliedOverruleCode is null as expected (actual: ${appliedOverruleCode === undefined ? 'undefined → treated as null' : JSON.stringify(appliedOverruleCode)})`
    : `AppliedOverruleCode matches expected — expected: ${expectedOverruleCode}, actual: ${JSON.stringify(appliedOverruleCode)}`;
  test(title, () => {
    expect(normalisedApplied).to.equal(expectedOverruleCode);
  });
}

// Function to validate booking response for refund
function getBookingRefundResponse(response, scenarioType) {
  // Response status check (Bruno)
  if (typeof res !== "undefined" && typeof res.getStatus === "function") {
    const status = res.getStatus();
    if (status !== 200) {
      throw new Error(`Exiting script due to wrong response status: ${status}`);
    }
    test('Successfully received booking', () => expect(status).to.eql(200));
  }

  if (!response.booking) {
    throw new Error("⛔ Exiting script, no booking available in the response");
  }

  const booking = response.booking;

  if (["postRefund", "patchRefund"].includes(scenarioType)) {
    const _refsRaw = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
    const idsAdmissionAncillariesReservationReference = Array.isArray(_refsRaw) ? _refsRaw : JSON.parse(_refsRaw || "[]");
    validationLogger(`[INFO] Reference for admissions, ancillaries and reservations: ${idsAdmissionAncillariesReservationReference}`);

    idsAdmissionAncillariesReservationReference.forEach(refId => {
      const admissions = booking.bookedOffers?.[0]?.admissions || [];
      const reservations = booking.bookedOffers?.[0]?.reservations || [];
      const ancillaries = booking.bookedOffers?.[0]?.ancillaries || [];

      const matchedAdmission = admissions.find(admission => admission.id === refId);
      const matchedReservation = reservations.find(reservation => reservation.id === refId);
      const matchedAncillary = ancillaries.find(ancillary => ancillary.id === refId);

      if (matchedAdmission || matchedReservation || matchedAncillary) {
        test(`RefundOfferPart '${refId}' found in booking`, () => {
          expect(true).to.be.true;
        });
      } else {
        test(`RefundOfferPart '${refId}' NOT found in booking`, () => {
          expect.fail(`[ERROR] ID '${refId}' not found in admissions or reservations or ancillaries`);
        });
      }
    });

    test("Booking is present and Booking ID is valid", () => {
      expect(response).to.have.property('booking');
      expect(booking).to.have.property('id').that.is.a('string').and.not.empty;
    });

    const validUntilRefundOffers = new Date(booking.refundOffers?.[0]?.validUntil);
    const currentDate = new Date();

    test("Valid until is set and still valid for the RefundOffers", () => {
      expect(validUntilRefundOffers).to.exist;
      expect(validUntilRefundOffers.getTime()).to.be.above(currentDate.getTime());
    });

    test("Refund offers are valid", () => {
      expect(booking).to.have.property('refundOffers').that.is.an('array').with.length.above(0);
      const refundOffer = booking.refundOffers[0];

      expect(refundOffer).to.have.property('id').that.is.a('string').and.not.empty;

      const expectedStatus = scenarioType === "postRefund" ? 'PROPOSED' : 'CONFIRMED';
      if (expectedStatus === 'CONFIRMED') {
        bru.setEnvVar("isRefundConfirmed", true);
      }

      if (typeof validateFulfillments === "function") {
        // Signature handling as above
        // #253: pass refundOffer.fulfillmentDocuments[] (v3.8 sibling) for ref→id integrity.
        if (validateFulfillments.length >= 3) {
          validateFulfillments(refundOffer.fulfillments, 0, expectedStatus, false, refundOffer.fulfillmentDocuments);
        } else {
          validateFulfillments(refundOffer.fulfillments, expectedStatus);
        }
      }

      validateRefundFeeLocal(refundOffer.refundFee);

      const overruleCode = bru.getEnvVar("overruleCode");
      const confirmedPriceAmount = Number(bru.getEnvVar("confirmedPriceAmount"));
      validateRefundableAmountLocal(refundOffer, overruleCode, confirmedPriceAmount);
    });
  } else if (scenarioType === "deleteRefund") {
    test("Refund offers are not present, empty array returned", () => {
      expect(booking).to.have.property("refundOffers").that.is.an("array");
      expect(booking.refundOffers).to.be.empty;
    });
    // E4: After a confirmed refund, affected booking parts must have transitioned to REFUNDED status
    if (bru.getEnvVar("isRefundConfirmed") === "true") {
      const _allParts = (booking.bookedOffers || [])
        .flatMap(bo => [...(bo.admissions||[]), ...(bo.reservations||[]), ...(bo.ancillaries||[])]);
      if (_allParts.length > 0) {
        test(`All booked offer parts are in REFUNDED or FULFILLED status after confirmed refund (OSDM: status transition)`, () => {
          _allParts.forEach((part, i) => {
            expect(['REFUNDED','FULFILLED'], `Part[${i}] status should be REFUNDED, got '${part.status}'`)
              .to.include(part.status);
          });
          validationLogger(`[INFO] All ${_allParts.length} parts verified as post-refund status`);
        });
      }
    }
  }
}

// Expose to global for convenience (optional)
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
