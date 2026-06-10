/**
 * bookings.js — validate the BOOKING response (POST /bookings → Booking).
 *
 * Runs after `02. POST Create Booking`. Asserts offer↔booking consistency on each
 * booked part (price / products / dates / after-sales conditions), the booked
 * offers are present, fulfillment docs are well-formed, and processes the
 * booking-level `requestedInformation` (passenger + purchaser channels, #258).
 */
const { validationLogger } = require('./displays.js');
const { bruTest: test } = require('./testCapture.js');
const { processRequestedInformation, summariseRequestedInformation } = require('./requestedInformation.js');

module.exports = {
  postCreateBookingResponse,
  validateFulfillments
};

// ─── Field-level helpers ─────────────────────────────────────────────────────

function validatePartIntersectionFields(offerParts, bookedParts, partType, fields) {
  fields.forEach(field => {
    const offerValues   = offerParts.map(p => p[field]).filter(v => v != null);
    const bookingValues = bookedParts.map(p => p[field]).filter(v => v != null);
    if (offerValues.length > 0 && bookingValues.length > 0) {
      test(`${partType} ${field} values have at least one member in common between offer and booking offer=[${offerValues}] booking=[${bookingValues}]`, () => {
        const intersection = offerValues.filter(v => bookingValues.includes(v));
        expect(intersection.length, `No common value for ${field} between offer and booking`).to.be.above(0);
        validationLogger(`[INFO] ${partType} ${field}: offer=[${offerValues}] booking=[${bookingValues}] intersection=[${intersection}]`);
      });
    } else if (offerValues.length === 0 && bookingValues.length === 0) {
      validationLogger(`[INFO] ${partType}: '${field}' is empty in both offer and booking`);
    } else {
      validationLogger(`[WARNING] ${partType}: '${field}' missing - offer has ${offerValues.length} values, booking has ${bookingValues.length} values`);
    }
  });
}

function validatePartEqualityFields(part, bookedPart, partType, index, fields) {
  fields.forEach(field => {
    if (part[field] != null && bookedPart[field] != null) {
      test(`${partType}[${index}].${field} matches between offer and booking : offer='${part[field]}' booking='${bookedPart[field]}'`, () => {
        expect(bookedPart[field]).to.eql(part[field]);
        validationLogger(`[INFO] ${partType}[${index}].${field}: offer='${part[field]}' booking='${bookedPart[field]}'`);
      });
    } else {
      validationLogger(`[WARNING] ${partType}[${index}]: '${field}' missing in offer or booking`);
    }
  });
}

function validatePartPrices(offerParts, bookedParts, partType) {
  const offerPrices   = offerParts.filter(p => p.price).map(p => ({ amount: p.price.amount, currency: p.price.currency, scale: p.price.scale }));
  const bookingPrices = bookedParts.filter(p => p.price).map(p => ({ amount: p.price.amount, currency: p.price.currency, scale: p.price.scale }));
  if (offerPrices.length > 0 && bookingPrices.length > 0) {
    test(`${partType} prices have at least one member in common between offer and booking`, () => {
      ['amount', 'currency', 'scale'].forEach(field => {
        const offerValues   = offerPrices.map(p => p[field]);
        const bookingValues = bookingPrices.map(p => p[field]);
        const intersection  = offerValues.filter(v => bookingValues.includes(v));
        expect(intersection.length, `No common value for price.${field} between offer and booking`).to.be.above(0);
        validationLogger(`[INFO] ${partType} price.${field}: offer=[${offerValues}] booking=[${bookingValues}] intersection=[${intersection}]`);
      });
    });
  } else if (offerPrices.length === 0 && bookingPrices.length === 0) {
    validationLogger(`[INFO] ${partType}: 'price' is empty in both offer and booking`);
  } else {
    validationLogger(`[WARNING] ${partType}: 'price' missing - offer has ${offerPrices.length} prices, booking has ${bookingPrices.length} prices`);
  }
}

function validatePartDates(part, bookedPart, partType, index) {
  ['validFrom', 'validUntil'].forEach(field => {
    if (part[field] && bookedPart[field]) {
      const partDate       = new Date(part[field]);
      const bookedPartDate = new Date(bookedPart[field]);
      if (!isNaN(partDate.getTime()) && !isNaN(bookedPartDate.getTime())) {
        test(`${partType}[${index}].${field} is present in both offer and booking`, () => {
          expect(part[field]).to.exist;
          expect(bookedPart[field]).to.exist;
          validationLogger(`[INFO] ${partType}[${index}].${field}: offer='${part[field]}' booking='${bookedPart[field]}'`);
        });
      } else {
        validationLogger(`[WARNING] ${partType}[${index}] ${field} has invalid date format`);
      }
    } else {
      validationLogger(`[WARNING] ${partType}[${index}] ${field} missing in offer or booking`);
    }
  });
}

function validateAfterSalesConditions(part, bookedPart, partType, index) {
  // Some sandboxes (e.g. Bileto) use 'afterSaleConditions' (no trailing 's') → normalise both
  const offerConditions   = part.afterSalesConditions      || part.afterSaleConditions      || [];
  const bookedConditions  = bookedPart.afterSalesConditions || bookedPart.afterSaleConditions || [];

  if (!Array.isArray(offerConditions) || offerConditions.length === 0) {
    if (Array.isArray(bookedConditions) && bookedConditions.length > 0) {
      validationLogger(`[WARNING] ${partType}[${index}] afterSalesConditions exist in booking but not in offer`);
    }
    return;
  }
  // #337 cascade-kill: when the booking has NO afterSalesConditions at all,
  // emit ONE parent failure naming the root cause (per part) and skip the
  // per-condition child REFUND-exists tests below. Previously each
  // offerConditions[N] iteration fired a child test that ALSO failed with
  // "Condition 'REFUND' not found in booking", producing N+1 failures per
  // affected part — for a 3-admission, 3-reservation, 2-conditions-each offer
  // that meant 18 cascading failures from a single provider-side gap
  // (booking response missing afterSalesConditions).
  const _offerConditionTypes = offerConditions
    .map(c => c && c.condition).filter(Boolean);
  if (!Array.isArray(bookedConditions) || bookedConditions.length === 0) {
    test(`${partType}[${index}] afterSalesConditions exist in both offer and booking`, () => {
      expect(bookedConditions.length,
        `afterSalesConditions missing or empty in booking. ` +
        `Offer declared ${offerConditions.length} condition(s) (${_offerConditionTypes.join(', ') || '?'}) ` +
        `— booking returned 0. The provider did not echo afterSalesConditions ` +
        `back into the booking object. Per-condition checks for this part are ` +
        `SKIPPED to avoid duplicate cascading failures (one root cause).`
      ).to.be.above(0);
    });
    validationLogger(`[ERROR] ${partType}[${index}] afterSalesConditions missing in booking — offer had ${offerConditions.length} (${_offerConditionTypes.join(', ') || '?'}). Per-condition tests skipped (cascade-kill).`);
    return;
  }
  test(`${partType}[${index}] afterSalesConditions exist in both offer and booking`, () => {
    expect(bookedConditions.length, `afterSalesConditions missing or empty in booking`).to.be.above(0);
    expect(bookedConditions).to.be.an('array');
    validationLogger(`[INFO] ${partType}[${index}] has ${offerConditions.length} afterSalesCondition(s) in offer and ${bookedConditions.length} in booking`);
  });
  offerConditions.forEach((condition, condIndex) => {
    const condType        = condition.condition;
    const bookedCondition = bookedConditions.find(c => c.condition === condType);
    test(`${partType}[${index}] afterSalesConditions[${condIndex}] - ${condType} exists in booking`, () => {
      expect(bookedCondition, `Condition '${condType}' not found in booking`).to.exist;
      validationLogger(`[INFO] ${partType}[${index}] afterSalesConditions[${condIndex}] - ${condType} found in booking`);
    });
    if (!bookedCondition) return;
    test(`${partType}[${index}] afterSalesConditions[${condIndex}].condition matches`, () => {
      expect(bookedCondition.condition).to.eql(condition.condition);
      validationLogger(`[INFO] ${partType}[${index}] afterSalesConditions[${condIndex}].condition: offer='${condition.condition}' booking='${bookedCondition.condition}'`);
    });
    if (condition.afterSaleFee && bookedCondition.afterSaleFee) {
      test(`${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee exists in both`, () => {
        expect(condition.afterSaleFee).to.exist;
        expect(bookedCondition.afterSaleFee).to.exist;
        validationLogger(`[INFO] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee exists in both offer and booking`);
      });
      ['currency', 'amount', 'scale'].forEach(field => {
        test(`${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee.${field} matches`, () => {
          expect(bookedCondition.afterSaleFee[field]).to.eql(condition.afterSaleFee[field]);
          validationLogger(`[INFO] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee.${field}: offer='${condition.afterSaleFee[field]}' booking='${bookedCondition.afterSaleFee[field]}'`);
        });
      });
      const scenarioType = bru.getEnvVar("scenarioType");
      if (scenarioType && scenarioType.includes(condType)) {
        bru.setEnvVar(`afterSaleCondition_${condType}_amount`,   condition.afterSaleFee.amount);
        bru.setEnvVar(`afterSaleCondition_${condType}_currency`, condition.afterSaleFee.currency);
        bru.setEnvVar(`afterSaleCondition_${condType}_scale`,    condition.afterSaleFee.scale);
        validationLogger(`[INFO] Stored afterSaleCondition_${condType}: amount=${condition.afterSaleFee.amount}, currency=${condition.afterSaleFee.currency}`);
      }
    } else {
      validationLogger(`[WARNING] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee missing in offer or booking`);
    }
  });
}

function validateAppliedPassengerTypes(part, bookedPart, partType, index) {
  if (!Array.isArray(part.appliedPassengerTypes) || part.appliedPassengerTypes.length === 0) {
    if (Array.isArray(bookedPart.appliedPassengerTypes) && bookedPart.appliedPassengerTypes.length > 0) {
      validationLogger(`[WARNING] ${partType}[${index}] appliedPassengerTypes exist in booking but not in offer`);
    }
    return;
  }
  test(`${partType}[${index}] appliedPassengerTypes exist in both offer and booking`, () => {
    expect(bookedPart.appliedPassengerTypes, `appliedPassengerTypes missing in booking`).to.exist;
    expect(bookedPart.appliedPassengerTypes).to.be.an('array');
    validationLogger(`[INFO] ${partType}[${index}] has ${part.appliedPassengerTypes.length} appliedPassengerType(s) in offer and ${bookedPart.appliedPassengerTypes.length} in booking`);
  });
  part.appliedPassengerTypes.forEach((passengerType, ptIndex) => {
    validationLogger(`[INFO] Validating ${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type}`);
    // Note: passengerRef in the offer is the externalRef (e.g. "00001") while in the booking it is the
    // sandbox internal UUID → match by type only to avoid false negatives across all sandboxes.
    const bookedPassengerType = bookedPart.appliedPassengerTypes?.find(
      pt => pt.type === passengerType.type
    );
    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type} exists in booking`, () => {
      expect(bookedPassengerType, `PassengerType type='${passengerType.type}' not found in booking`).to.exist;
      validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type} found in booking`);
    });
    if (!bookedPassengerType) return;

    // passengerRef is intentionally not compared: offer contains externalRef, booking contains internal UUID
    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].passengerRef exists in booking`, () => {
      expect(bookedPassengerType.passengerRef, `passengerRef missing in booking appliedPassengerTypes`).to.be.a('string').and.not.be.empty;
      validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].passengerRef in booking: '${bookedPassengerType.passengerRef}' (offer externalRef was: '${passengerType.passengerRef}')`);
    });
    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].type matches`, () => {
      expect(bookedPassengerType.type).to.eql(passengerType.type);
      validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].type: offer='${passengerType.type}' booking='${bookedPassengerType.type}'`);
    });

    if (passengerType.description && bookedPassengerType.description) {
      test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].description matches`, () => {
        expect(bookedPassengerType.description).to.eql(passengerType.description);
        validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].description: offer='${passengerType.description}' booking='${bookedPassengerType.description}'`);
      });
    }

    if (passengerType.tripCoverage && bookedPassengerType.tripCoverage) {
      test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage exists in both`, () => {
        expect(passengerType.tripCoverage).to.exist;
        expect(bookedPassengerType.tripCoverage).to.exist;
        validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage exists in both offer and booking`);
      });
      if (passengerType.tripCoverage.coveredTripId && bookedPassengerType.tripCoverage.coveredTripId) {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredTripId matches`, () => {
          expect(bookedPassengerType.tripCoverage.coveredTripId).to.eql(passengerType.tripCoverage.coveredTripId);
          validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredTripId: offer='${passengerType.tripCoverage.coveredTripId}' booking='${bookedPassengerType.tripCoverage.coveredTripId}'`);
        });
      }
      if (passengerType.tripCoverage.coveredLegIds && bookedPassengerType.tripCoverage.coveredLegIds) {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredLegIds matches`, () => {
          expect(bookedPassengerType.tripCoverage.coveredLegIds).to.have.members(passengerType.tripCoverage.coveredLegIds);
          validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredLegIds: offer=[${passengerType.tripCoverage.coveredLegIds}] booking=[${bookedPassengerType.tripCoverage.coveredLegIds}]`);
        });
      }
    } else if (passengerType.tripCoverage || bookedPassengerType.tripCoverage) {
      validationLogger(`[WARNING] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage missing in ${passengerType.tripCoverage ? 'booking' : 'offer'}`);
    }

    if (Array.isArray(passengerType.appliedReductionCardTypes)) {
      if (passengerType.appliedReductionCardTypes.length > 0) {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes exist in both`, () => {
          expect(bookedPassengerType.appliedReductionCardTypes, `appliedReductionCardTypes missing in booking`).to.exist;
          expect(bookedPassengerType.appliedReductionCardTypes).to.be.an('array');
          validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}] has ${passengerType.appliedReductionCardTypes.length} appliedReductionCardType(s)`);
        });
        passengerType.appliedReductionCardTypes.forEach((cardType, cardIndex) => {
          const bookedCardType = bookedPassengerType.appliedReductionCardTypes?.find(c => c === cardType);
          test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes[${cardIndex}] matches`, () => {
            expect(bookedCardType).to.eql(cardType);
            validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes[${cardIndex}]: offer='${cardType}' booking='${bookedCardType}'`);
          });
        });
      } else {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes is empty in both`, () => {
          expect(bookedPassengerType.appliedReductionCardTypes || []).to.be.an('array').with.lengthOf(0);
          validationLogger(`[INFO] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes is empty in both offer and booking`);
        });
      }
    }
  });
}

// ─── Part-level orchestrator ─────────────────────────────────────────────────

function validateOfferParts(offerParts, bookedParts, partType, expectedBookedOffersStatus) {
  const _idsRaw = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
  const ids = Array.isArray(_idsRaw) ? _idsRaw : JSON.parse(_idsRaw || "[]");

  offerParts.forEach((part, index) => {
    const bookedPart = bookedParts[index];
    if (!bookedPart) {
      validationLogger(`[WARNING] No booked ${partType}[${index}] found for offer part id=${part.id}`);
      return;
    }
    ids.push(bookedPart.id);

    validatePartIntersectionFields(offerParts, bookedParts, partType, ['exchangeable', 'refundable']);
    validatePartEqualityFields(part, bookedPart, partType, index, ['isReservationRequired', 'offerMode']);

    test(`Status is ${expectedBookedOffersStatus} for ${partType}[${index}] - expected: ${expectedBookedOffersStatus}, actual: ${bookedPart.status}`, () => {
      if (Array.isArray(expectedBookedOffersStatus)) {
        expect(expectedBookedOffersStatus).to.include(bookedPart.status);
      } else {
        expect(bookedPart.status).to.eql(expectedBookedOffersStatus);
      }
      validationLogger(`[INFO] ${partType}[${index}]: status: ${bookedPart.status}`);
    });

    // B6: Status must be a known OSDM BookingPartStatus enum value
    const _validBookingPartStatuses = ['PREBOOKED','ON_HOLD','CONFIRMED','FULFILLED',
      'CANCELLED','RELEASED','REFUNDED','EXCHANGE_ONGOING','EXCHANGED','ERROR'];
    test(`${partType}[${index}].status '${bookedPart.status}' is a valid OSDM BookingPartStatus`, () => {
      expect(_validBookingPartStatuses).to.include(bookedPart.status,
        `'${bookedPart.status}' is not a valid BookingPartStatus enum value. ` +
        `Valid OSDM values: [${_validBookingPartStatuses.join(', ')}].`);
    });

    validatePartPrices(offerParts, bookedParts, partType);
    validatePartDates(part, bookedPart, partType, index);
    validateAfterSalesConditions(part, bookedPart, partType, index);
    validateAppliedPassengerTypes(part, bookedPart, partType, index);
  });

  bru.setEnvVar("admissionReservationAncillaryBookingPartsIds", ids);
}

// ─── Public functions ────────────────────────────────────────────────────────

function postCreateBookingResponse(selectedOffer, jsonData, expectedBookedOffersStatus, expectedFulfillmentStatus, requireFulfillments = false) {
  validationLogger("[DEBUG] ► postCreateBookingResponse");

  const booking = jsonData.booking;
  if (typeof booking !== 'object' || booking === null) {
    validationLogger("[ERROR] No booking found or 'booking' is not an object.");
    throw new Error("No booking found or 'booking' is not an object.");
  }

  test(`'booking' object exists`, () => {
    expect(booking, "[ERROR] 'booking' is missing or empty").to.be.an("object").that.is.not.empty;
    validationLogger(`[INFO] 'booking' object exists`);
  });

  test(`booking.id is a non-empty string (OSDM: Booking.id required)`, () => {
    validationLogger(`[INFO] booking.id: ${booking.id}`);
    expect(booking.id).to.be.a('string').and.not.be.empty;
  });
  bru.setEnvVar("bookingId", booking.id);
  if (booking.bookingCode !== undefined && booking.bookingCode !== null) {
    test(`booking.bookingCode is a non-empty string when present`, () => {
      validationLogger(`[INFO] booking.bookingCode: ${booking.bookingCode}`);
      expect(booking.bookingCode).to.be.a('string').and.not.be.empty;
    });
  } else {
    validationLogger(`[INFO] booking.bookingCode is absent (optional per OSDM spec)`);
  }

  // Collect passenger IDs
  const passengerIdList = [];
  (booking.passengers || []).forEach((passenger, i) => {
    if (passenger.id) {
      passengerIdList.push(passenger.id);
    } else {
      validationLogger(`[WARNING] Passenger at index ${i} has no ID.`);
    }
  });
  if (passengerIdList.length === 0) validationLogger("[ERROR] Passengers structure is invalid or empty.");
  validationLogger(`[FULL] Passenger IDs: [${passengerIdList}]`);
  bru.setEnvVar("passengerIdList", passengerIdList);

  // Check booking.createdOn > offer.createdOn
  const bookingDate = new Date(booking.createdOn);
  const offerDate   = new Date(selectedOffer.createdOn);
  if (!isNaN(bookingDate.getTime()) && !isNaN(offerDate.getTime())) {
    test(`booking.createdOn: ${bookingDate.toISOString()}, offer.createdOn: ${offerDate.toISOString()}`, () => {
      validationLogger(`[INFO] booking.createdOn: ${bookingDate.toISOString()}, offer.createdOn: ${offerDate.toISOString()}`);
      expect(bookingDate.getTime()).to.be.above(offerDate.getTime());
    });
  } else {
    validationLogger(`[WARNING] Invalid date - bookingDate: ${booking.createdOn}, offerDate: ${selectedOffer.createdOn}`);
  }

  // B2 / #204: booking-level confirmation deadline must be a valid future datetime
  // when present (OSDM).
  //
  // Field-name resolution order (most-standard → least-standard):
  //   1. `Booking.confirmationTimeLimit` — OSDM-standard at the booking level.
  //   2. `Booking.confirmableUntil` — Bileto sandbox sets this at the booking
  //       level (OSDM defines this field at the *bookingPart* level only).
  //   3. **Earliest** `bookedOffers[].{admissions|reservations|ancillaries}[].confirmableUntil`
  //       — Paxone sandbox sets `confirmableUntil` ONLY at the bookingPart level,
  //       not at the booking root (matching the OSDM schema's own placement of
  //       the field). The booking effectively expires when the FIRST part
  //       expires, so the earliest part-level deadline is the booking deadline.
  //
  // Each fallback emits a `[WARNING]` documenting the vendor deviation so the
  // tester can see in the report which shape was used.
  let _confirmDeadline = booking.confirmationTimeLimit || booking.confirmableUntil || null;
  let _confirmSource   = booking.confirmationTimeLimit
    ? 'booking.confirmationTimeLimit (OSDM-standard)'
    : (booking.confirmableUntil ? 'booking.confirmableUntil (vendor extension at booking level)' : null);

  // Fallback 3 — dig into bookingParts and pick the earliest confirmableUntil.
  if (!_confirmDeadline) {
    const _partDeadlines = [];
    const _bos = Array.isArray(booking.bookedOffers) ? booking.bookedOffers : [];
    for (const bo of _bos) {
      for (const pt of ['admissions', 'reservations', 'ancillaries']) {
        const parts = Array.isArray(bo[pt]) ? bo[pt] : [];
        for (const p of parts) {
          if (p && p.confirmableUntil) {
            const t = new Date(p.confirmableUntil).getTime();
            if (!isNaN(t)) _partDeadlines.push({ ts: t, raw: p.confirmableUntil, pt });
          }
        }
      }
    }
    if (_partDeadlines.length > 0) {
      _partDeadlines.sort((a, b) => a.ts - b.ts);
      const earliest = _partDeadlines[0];
      _confirmDeadline = earliest.raw;
      _confirmSource =
        `min(bookedOffers[].${earliest.pt}[].confirmableUntil) — bookingPart-level ` +
        `(OSDM-standard location for this field). Picked the earliest of ${_partDeadlines.length} ` +
        `part deadline(s); the booking effectively expires when the first part expires.`;
    }
  }

  if (_confirmDeadline) {
    const confirmLimit = new Date(_confirmDeadline);
    // #204: stash the effective booking deadline so 06. fulfillments can wait
    // until just past it before attempting confirmation.
    bru.setEnvVar('bookingConfirmationTimeLimit', String(_confirmDeadline));
    test(`booking confirmation deadline is a valid future datetime — source: ${_confirmSource}`, () => {
      expect(isNaN(confirmLimit.getTime()), `confirmation deadline is not a valid date`).to.be.false;
      expect(confirmLimit.getTime()).to.be.above(Date.now(),
        `confirmation deadline is already in the past: ${_confirmDeadline}`);
      validationLogger(`[INFO] booking confirmation deadline: ${_confirmDeadline} (source: ${_confirmSource})`);
    });
    // Document vendor deviations from OSDM-standard placement.
    if (!booking.confirmationTimeLimit && booking.confirmableUntil) {
      validationLogger(`[WARNING] Provider exposes the booking-level confirmation deadline as 'confirmableUntil' rather than the OSDM-standard 'confirmationTimeLimit'. The OSDM spec defines 'confirmableUntil' at the bookingPart level only — at the booking level the standard field is 'confirmationTimeLimit'. OSCAR accepts both, but a strict OSDM consumer might not.`);
    } else if (!booking.confirmationTimeLimit && !booking.confirmableUntil) {
      validationLogger(`[WARNING] Provider does not expose a booking-level confirmation deadline (neither 'confirmationTimeLimit' nor 'confirmableUntil' at the booking root). OSCAR fell back to the earliest bookingPart-level 'confirmableUntil' (${_confirmDeadline}). This matches OSDM's schema placement for 'confirmableUntil' (it's defined on the bookingPart), but OSDM also recommends 'confirmationTimeLimit' at the booking root for clients that don't walk parts — a strict consumer might expect that.`);
    }
  } else {
    bru.setEnvVar('bookingConfirmationTimeLimit', '');
    validationLogger(`[INFO] booking has no confirmation deadline anywhere (not at the booking root, not on any bookingPart) → deadline test skipped; if #204 expiredBookingTest=on, that test will skip with a [WARNING] too.`);
  }

  // RI (#258): booking-level requestedInformation — static assertions, evaluate
  // against the passenger data OSCAR will PATCH, and auto-provide missing fields
  // (Phase 3a/3b). The PATCH step (03) runs after this and carries the values.
  const _bookingRi = booking.requestedInformation;
  if (_bookingRi !== undefined && _bookingRi !== null && _bookingRi !== '') {
    const _read = (n) => {
      const r = bru.getEnvVar(n);
      if (r === null || r === undefined || r === '') return [];
      try { return typeof r === 'string' ? JSON.parse(r) : r; } catch (_e) { return []; }
    };
    const _add = _read('passengerAdditionalData');
    const _specs = _read('bookingPassengerSpecifications');
    const _count = Number(bru.getEnvVar('offerPassengerNumber')) || (booking.passengers || []).length || _add.length || 0;
    const _probe = String(bru.getEnvVar('requestedInformationProbe') || 'off').toLowerCase();
    const _mode = (_probe === 'omit' || _probe === 'invalid') ? _probe : 'autofeed';

    // Purchaser channel (#258 / #203): the purchaser is a single object. Its mode
    // is driven by bookingPurchaserMode — inline/deferred → satisfy (autofeed),
    // omit/invalid → negative probe. The resulting purchaserAdditionalData /
    // requestedInfoPurchaserProbeTargets are read by the Booking Purchaser
    // step. The scenario purchaser (bookingPurchaserSpecifications) seeds the
    // model so an already-complete purchaser needs no auto-feed.
    const _readObj = (n) => {
      const r = bru.getEnvVar(n);
      if (r === null || r === undefined || r === '') return {};
      try { const v = typeof r === 'string' ? JSON.parse(r) : r; return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch (_e) { return {}; }
    };
    const _purSpec = _readObj('bookingPurchaserSpecifications');
    const _purAdd = _readObj('purchaserAdditionalData');
    const _purModeRaw = String(bru.getEnvVar('bookingPurchaserMode') || 'inline').toLowerCase();
    const _purMode = (_purModeRaw === 'omit' || _purModeRaw === 'invalid') ? _purModeRaw : 'autofeed';

    const out = processRequestedInformation({
      expr: _bookingRi,
      tag: 'booking',
      additional: _add,
      specs: _specs,
      passengerCount: _count,
      mode: _mode,
      purchaserAdditional: _purAdd,
      purchaserSpec: _purSpec,
      purchaserMode: _purMode,
      assert: (name, ok, msg) => test(name, () => { expect(ok, msg).to.be.true; }),
      log: (lvl, msg) => validationLogger(`[${lvl}] ${msg}`),
    });
    if (out.provided.length || (out.probeTargets && out.probeTargets.length)) {
      bru.setEnvVar('passengerAdditionalData', JSON.stringify(out.additional));
      if (String(bru.getEnvVar('skipPatchPassengerRequest')) === 'true') {
        bru.setEnvVar('skipPatchPassengerRequest', 'false');
      }
    }
    if (out.probeTargets && out.probeTargets.length) {
      const _existing = _read('requestedInfoProbeTargets');
      bru.setEnvVar('requestedInfoProbeTargets', JSON.stringify(_existing.concat(out.probeTargets)));
    }
    // Persist the purchaser channel for the Booking Purchaser step (#258/#203).
    if ((out.purchaserProvided && out.purchaserProvided.length)
        || (out.purchaserProbeTargets && out.purchaserProbeTargets.length)) {
      bru.setEnvVar('purchaserAdditionalData', JSON.stringify(out.purchaserAdditional || {}));
    }
    if (out.purchaserProbeTargets && out.purchaserProbeTargets.length) {
      bru.setEnvVar('requestedInfoPurchaserProbeTargets', JSON.stringify(out.purchaserProbeTargets));
    }

    // P2: the provider should stop requesting what OSCAR already provided at the
    // offer step. If it still asks, flag it (WARN — requestedInformation should
    // shrink as data is supplied).
    const _autoFed = _read('requestedInfoAutoFed');
    if (_autoFed.length) {
      const s = summariseRequestedInformation(_bookingRi);
      if (s.parseOk) {
        s.leaves
          .filter(l => l.scenarioField && _autoFed.some(a => a.scenarioField === l.scenarioField && (l.index === 'ANY' || a.index === l.index)))
          .forEach(l => validationLogger(`[WARNING] [P2] booking.requestedInformation still requests '${l.scenarioField}' for ${l.passengerRef}, which OSCAR already provided — requestedInformation should clear once satisfied.`));
      }
    }
  } else {
    validationLogger(`[INFO] booking.requestedInformation absent → nothing additionally required`);
  }

  // B3: bookedOffers must be non-empty (OSDM: a booking must contain at least one BookedOffer)
  test(`booking.bookedOffers is a non-empty array (OSDM: required)`, () => {
    expect(booking.bookedOffers).to.be.an('array').with.lengthOf.at.least(1);
    validationLogger(`[INFO] booking.bookedOffers count: ${booking.bookedOffers?.length}`);
  });

  // Capture the first BookedOffer id for post-booking add-offer-part flows
  // (issue #104 Stage B / ADD_TO_BOOKING, #108 add-ancillary). Needed for the URL
  // of POST /bookings/{bookingId}/booked-offers/{bookedOfferId}/(offer-parts|
  // reservations|ancillaries). Per OSDM the BookedOffer identifier is `offerId`
  // (BookedOffer.required = [offerId]; there is no `id` field) — note this is a
  // NEW id minted by the booking, not the original offer's id. Fall back to a
  // legacy `.id` only if a vendor ever provides one (#147).
  const firstBookedOffer = (Array.isArray(booking.bookedOffers) && booking.bookedOffers[0]) || null;
  const bookedOfferId = firstBookedOffer && (firstBookedOffer.offerId || firstBookedOffer.id);
  if (bookedOfferId) {
    bru.setEnvVar("bookedOfferId", bookedOfferId);
  }

  // Price structure checks
  const prov      = booking.provisionalPrice;
  const mini      = selectedOffer.offerSummary.minimalPrice;
  const confirmed = booking.confirmedPrice;

  test(`provisionalPrice structure exists`, () => {
    expect(prov, `provisionalPrice missing`).to.exist;
    validationLogger(`[INFO] provisionalPrice structure exists`);
  });
  test(`confirmedPrice structure exists`, () => {
    expect(confirmed, `confirmedPrice missing`).to.exist;
    validationLogger(`[INFO] confirmedPrice structure exists`);
  });
  test(`Price fields exist (currency, scale) in provisionalPrice and confirmedPrice`, () => {
    ['currency', 'scale'].forEach(field => {
      expect(prov[field],
        `provisionalPrice.${field} missing in booking (got: ${JSON.stringify(prov[field])})`).to.exist;
      expect(confirmed[field],
        `confirmedPrice.${field} missing in booking (got: ${JSON.stringify(confirmed[field])})`).to.exist;
    });
    bru.setEnvVar("provisionalPriceAmount", prov.amount);
    bru.setEnvVar("confirmedPriceAmount",   confirmed.amount);
    validationLogger(`[INFO] provisionalPrice and confirmedPrice fields present`);
  });

  // B4: Both prices must use the same currency (OSDM: currency must be consistent within a booking)
  if (prov?.currency && confirmed?.currency) {
    test(`provisionalPrice.currency matches confirmedPrice.currency (OSDM: currency consistency)`, () => {
      expect(confirmed.currency).to.eql(prov.currency,
        `Currency mismatch: provisional=${prov.currency}, confirmed=${confirmed.currency}`);
      validationLogger(`[INFO] Currency consistent across prices: ${prov.currency}`);
    });
  }
  // H3: Offer currency must carry through to booking (OSDM: cross-flow currency consistency)
  const _offerCurrency = bru.getEnvVar("offerCurrency");
  if (_offerCurrency && prov?.currency) {
    test(`booking.provisionalPrice.currency matches offer currency (expected: ${_offerCurrency}, actual: ${prov.currency})`, () => {
      expect(prov.currency).to.eql(_offerCurrency,
        `Booking currency (${prov.currency}) differs from offer currency (${_offerCurrency})`);
    });
  }

  const requestName = req?.getName?.() ?? "";
  if (requestName === "03. POST Create Booking" || requestName === "07. GET Booking before Fulfillments") {
    test(`provisionalPrice matches minimalPrice: ${prov.amount} ${prov.currency} (scale: ${prov.scale})`, () => {
      expect(prov.amount).to.eql(mini.amount);
      expect(prov.currency).to.eql(mini.currency);
      expect(prov.scale).to.eql(mini.scale);
      validationLogger(`[INFO] provisionalPrice matches minimalPrice: ${prov.amount} ${prov.currency} (scale: ${prov.scale})`);
    });
  }

  // Validate booked offer parts
  const bookedOffers = booking.bookedOffers || [];
  validateOfferParts(selectedOffer.admissionOfferParts   || [], bookedOffers.flatMap(b => b.admissions   || []), "admission",   expectedBookedOffersStatus);
  validateOfferParts(selectedOffer.reservationOfferParts || [], bookedOffers.flatMap(b => b.reservations || []), "reservation", expectedBookedOffersStatus);
  validateOfferParts(selectedOffer.ancillaryOfferParts   || [], bookedOffers.flatMap(b => b.ancillaries  || []), "ancillary",   expectedBookedOffersStatus);

  // #253: pass the sibling Booking.fulfillmentDocuments[] (v3.8) so each
  // fulfillment.fulfillmentDocumentRef can be checked against its sibling id.
  validateFulfillments(booking.fulfillments || [], 0, expectedFulfillmentStatus, requireFulfillments, booking.fulfillmentDocuments);

  // Check that booking has the same number of passengers as expected from the offer
  const expectedPassengerCount = Number(bru.getEnvVar("passengerCount") || 0);
  const actualPassengerCount = (booking.passengers || []).length;
  test(`Booking contains exactly the expected number of passengers - expected: ${expectedPassengerCount}, actual: ${actualPassengerCount}`, () => {
    validationLogger(`[INFO] Booking passenger count - expected: ${expectedPassengerCount}, actual: ${actualPassengerCount}`);
    if (expectedPassengerCount > 0) {
      expect(actualPassengerCount).to.eql(expectedPassengerCount,
        `Expected exactly ${expectedPassengerCount} passengers, got ${actualPassengerCount}`);
    } else {
      expect(actualPassengerCount).to.be.above(0);
    }
  });

  // C2: fulfillmentStatus (OSDM v3.8 new field) must be a valid FulfillmentSummaryStatus enum when present.
  // #337: guard was `!== undefined`, which let the JSON-literal-null case through
  // and stringified it into a nonsense test title like `'null' is a valid
  // FulfillmentSummaryStatus`. Treat null AND undefined as "absent" — the field is
  // optional in OSDM v3.8 and absence is encoded either way in practice.
  const _validFulfillmentSummaryStatuses = ['UNISSUED','PARTIALLY_ISSUED','ISSUED',
    'PARTIALLY_USED','COMPLETELY_USED','REFUNDED','CANCELLED','EXPIRED'];
  if (booking.fulfillmentStatus != null) {
    test(`booking.fulfillmentStatus '${booking.fulfillmentStatus}' is a valid FulfillmentSummaryStatus (OSDM v3.8)`, () => {
      expect(_validFulfillmentSummaryStatuses).to.include(booking.fulfillmentStatus,
        `'${booking.fulfillmentStatus}' is not a valid FulfillmentSummaryStatus. ` +
        `Valid OSDM v3.8 values: [${_validFulfillmentSummaryStatuses.join(', ')}].`);
      validationLogger(`[INFO] booking.fulfillmentStatus: ${booking.fulfillmentStatus}`);
    });
  } else {
    validationLogger(`[INFO] booking.fulfillmentStatus absent (null or undefined; optional in OSDM v3.8) → test skipped`);
  }
}

function validateFulfillments(fulfillments, index, expectedFulfillmentStatus, requireFulfillments = false, siblingDocs = undefined) {
  validationLogger("[DEBUG] ► validateFulfillments");
  if (!Array.isArray(fulfillments) || fulfillments.length === 0) {
    if (requireFulfillments) {
      // #250: after POST /fulfillments, GET /bookings/{id} MUST embed the
      // generated fulfillments — the provider has to keep the booking object
      // updated. An empty/missing booking.fulfillments here is a conformance
      // failure, not a "continue".
      test(`Booking embeds the generated fulfillments after fulfillment (OSDM: booking must be kept updated)`, () => {
        expect(Array.isArray(fulfillments) && fulfillments.length > 0,
          "GET /bookings returned no fulfillments after a successful POST /fulfillments — the provider did not update the booking object").to.be.true;
      });
      return;
    }
    validationLogger("[INFO] No fulfillments available in the response, continue execution");
    return;
  }

  const fulfillmentIds   = [];
  const _bookedPartIdsRaw = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
  const bookedPartIds    = Array.isArray(_bookedPartIdsRaw) ? _bookedPartIdsRaw : JSON.parse(_bookedPartIdsRaw || "[]");

  test(`Fulfillments exist at index ${index}`, () => {
    validationLogger(`[INFO] Number of fulfillments: ${fulfillments.length}`);
    expect(fulfillments).to.be.an("array").that.is.not.empty;
  });

  fulfillments.forEach((fulfillment, idx) => {
    // Push the id exactly once per fulfillment. Historically this loop pushed
    // the id twice (once inside the `if` guard, once again unconditionally
    // below) so the POST /refund-offers and POST /exchange-offers bodies ended
    // up with every fulfillment id duplicated in fulfillmentIds[]. Providers
    // tolerated it for full-refund/full-exchange because the duplicate was
    // semantically the same instruction; partial-refund scoping (#218) however
    // depended on a clean list to scope correctly.
    if (fulfillment?.id) {
      fulfillmentIds.push(fulfillment.id);
    }

    test(`Fulfillment[${idx}] id exists`, () => {
      validationLogger(`[INFO] Fulfillment[${idx}] id exists: ${fulfillment.id}`);
    });
    bru.setEnvVar("fulfillmentIds", fulfillmentIds);

    test(`Fulfillment[${idx}] bookingRef exists`, () => {
      validationLogger(`[INFO] Fulfillment[${idx}] bookingRef exists: ${fulfillment.bookingRef}`);
      expect(fulfillment.bookingRef).to.be.a("string").and.not.be.empty;
    });

    // D3: bookingRef must match the current bookingId (OSDM: Fulfillment.bookingRef required)
    const _currentBookingId = bru.getEnvVar("bookingId");
    if (_currentBookingId && fulfillment.bookingRef) {
      test(`Fulfillment[${idx}].bookingRef matches current bookingId (expected: ${_currentBookingId}, actual: ${fulfillment.bookingRef})`, () => {
        expect(fulfillment.bookingRef).to.eql(_currentBookingId,
          `bookingRef '${fulfillment.bookingRef}' does not match bookingId '${_currentBookingId}'`);
        validationLogger(`[INFO] Fulfillment[${idx}].bookingRef matches bookingId ✓`);
      });
    }

    // D4: createdOn must always be a valid ISO datetime (OSDM: Fulfillment.createdOn required)
    const createdOnDate = new Date(fulfillment.createdOn);
    if (!isNaN(createdOnDate.getTime())) {
      test(`Fulfillment[${idx}] createdOn is a valid datetime at or before now`, () => {
        expect(fulfillment.createdOn).to.be.a("string").and.not.be.empty;
        expect(createdOnDate.getTime()).to.be.at.most(Date.now());
        validationLogger(`[INFO] Fulfillment[${idx}] createdOn: ${fulfillment.createdOn}`);
      });
    } else {
      validationLogger(`[WARNING] Fulfillment[${idx}] createdOn has invalid date format: ${fulfillment.createdOn}`);
    }

    test(`Fulfillment[${idx}] status comparison - expected: ${expectedFulfillmentStatus}, actual: ${fulfillment.status}`, () => {
      validationLogger(`[INFO] Fulfillment[${idx}] status comparison - expected: ${expectedFulfillmentStatus}, actual: ${fulfillment.status}`);
      if (Array.isArray(expectedFulfillmentStatus)) {
        expect(expectedFulfillmentStatus).to.include(fulfillment.status);
      } else {
        expect(fulfillment.status).to.eql(expectedFulfillmentStatus);
      }
    });

    // D1: status must be a valid OSDM FulfillmentStatus enum value.
    // #337: aligned with fulfillments.js (which already accepts FULFILLED). The
    // bookings.js enum was missing FULFILLED, producing a false-positive
    // failure on every FULFILLED fulfillment under a v3.8 booking.
    const _validFulfillmentStatuses = ['AVAILABLE','USED','PARTIALLY_USED','RESERVED',
      'EXCHANGED','REFUNDED','RELEASED','CANCELLED','EXPIRED','ON_HOLD','CONFIRMED','FULFILLED'];
    test(`Fulfillment[${idx}].status '${fulfillment.status}' is a valid OSDM FulfillmentStatus`, () => {
      expect(_validFulfillmentStatuses).to.include(fulfillment.status,
        `'${fulfillment.status}' is not a valid FulfillmentStatus enum value. ` +
        `Valid OSDM values: [${_validFulfillmentStatuses.join(', ')}].`);
    });

    if (fulfillment.controlNumber != null) {
      test(`Fulfillment[${idx}] controlNumber exists`, () => {
        expect(fulfillment.controlNumber).to.be.a("string").and.not.be.empty;
      });
    } else {
      validationLogger(`[INFO] Fulfillment[${idx}] controlNumber is absent (expected for CONFIRMED without document issuance yet)`);
    }

    test(`Fulfillment[${idx}] bookingParts.id exist in admissionReservationAncillaryBookingPartsIds - expected: [${bookedPartIds}], actual: [${fulfillment.bookingParts.map(bp => bp.id)}]`, () => {
      expect(fulfillment.bookingParts).to.be.an("array").that.is.not.empty;
      fulfillment.bookingParts.forEach(part => {
        validationLogger(`[INFO] Fulfillment[${idx}] bookingPart.id: ${part.id} exists in admissionReservationAncillaryBookingPartsIds`);
        expect(bookedPartIds).to.include(part.id);
      });
    });

    if (Array.isArray(fulfillment.fulfillmentDocuments) && fulfillment.fulfillmentDocuments.length > 0) {
      test(`Fulfillment[${idx}] documents exist and contain valid data`, () => {
        expect(fulfillment.fulfillmentDocuments).to.be.an("array").that.is.not.empty;
        validationLogger(`[INFO] Fulfillment[${idx}] number of documents: ${fulfillment.fulfillmentDocuments.length}`);
        fulfillment.fulfillmentDocuments.forEach((doc, docIndex) => {
          test(`Fulfillment[${idx}].document[${docIndex}] - fields exist`, () => {
            // #202/#254: a FulfillmentDocument carries the actual payload as EITHER
            // a downloadLink (URI) OR inline `content` (base64) — BOTH are the OSDM
            // standard ("Either downloadLink + downloadExpiry or content must be
            // provided"). `rawData` is NOT an OSDM field; some providers use it as a
            // vendor extension for the inline payload, so we accept it but flag it.
            const _hasLink    = typeof doc.downloadLink === "string" && doc.downloadLink.trim() !== "";
            const _hasContent = doc.content !== undefined && doc.content !== null && String(doc.content).trim() !== "";
            const _hasRaw     = doc.rawData !== undefined && doc.rawData !== null && String(doc.rawData).trim() !== "";

            // Report EXACTLY which field delivered the document and whether it is
            // OSDM-standard or a vendor extension, so the tester can see at a glance.
            let _channel, _std;
            if (_hasContent)   { _channel = "content (base64 inline)";          _std = "OSDM-standard"; }
            else if (_hasLink) { _channel = `downloadLink=${doc.downloadLink}`; _std = "OSDM-standard"; }
            else if (_hasRaw)  { _channel = "rawData (inline)";                 _std = "VENDOR EXTENSION (not in the OSDM FulfillmentDocument schema)"; }
            else               { _channel = "(none)";                           _std = "MISSING"; }
            validationLogger(`[INFO] Fulfillment[${idx}].document[${docIndex}] -> medium=${doc.medium}, type=${doc.type}, format=${doc.format}; payload via ${_channel} [${_std}]`);

            expect(doc.medium,       "medium missing").to.be.a("string").and.not.be.empty;
            expect(doc.type,         "type missing").to.be.a("string").and.not.be.empty;
            // Must be retrievable: OSDM `content` or `downloadLink`, or the vendor `rawData`.
            expect(_hasContent || _hasLink || _hasRaw,
              "fulfillment document has no payload (expected OSDM 'content' or 'downloadLink', or the vendor 'rawData')").to.be.true;
            expect(doc.format,       "format missing").to.be.a("string").and.not.be.empty;
          });
          // Conformance note (#202): a document delivered ONLY via the non-standard
          // `rawData` field is retrievable but NOT OSDM-conformant — OSDM requires
          // `content` or `downloadLink`. Surface it as a WARNING (vendor extension),
          // not a hard failure (the document IS obtainable).
          {
            const _hasLink2    = typeof doc.downloadLink === "string" && doc.downloadLink.trim() !== "";
            const _hasContent2 = doc.content !== undefined && doc.content !== null && String(doc.content).trim() !== "";
            const _hasRaw2     = doc.rawData !== undefined && doc.rawData !== null && String(doc.rawData).trim() !== "";
            if (_hasRaw2 && !_hasContent2 && !_hasLink2) {
              validationLogger(`[WARNING] Fulfillment[${idx}].document[${docIndex}] delivers the document only via the non-standard 'rawData' field — OSDM defines 'content' (base64) or 'downloadLink'. Accepted as a vendor extension.`);
            }
          }
        });
      });
    }

    // D2: Check fulfillmentDocumentRefs (v3.8 field, replaces deprecated fulfillmentDocuments)
    const _hasLegacyDocs = Array.isArray(fulfillment.fulfillmentDocuments) && fulfillment.fulfillmentDocuments.length > 0;
    const _hasDocRefs    = Array.isArray(fulfillment.fulfillmentDocumentRefs) && fulfillment.fulfillmentDocumentRefs.length > 0;
    if (_hasDocRefs) {
      test(`Fulfillment[${idx}].fulfillmentDocumentRefs are non-empty strings (OSDM v3.8: replaces fulfillmentDocuments)`, () => {
        fulfillment.fulfillmentDocumentRefs.forEach((ref, ri) => {
          expect(ref).to.be.a('string').and.not.be.empty;
        });
        validationLogger(`[INFO] Fulfillment[${idx}] has ${fulfillment.fulfillmentDocumentRefs.length} fulfillmentDocumentRef(s)`);
      });

      // #253: v3.8 cross-reference integrity — each fulfillmentDocumentRef must
      // resolve to a sibling fulfillmentDocuments[].id (under FulfillmentResponse
      // or Booking, NOT the deprecated nested fulfillment.fulfillmentDocuments).
      // When `siblingDocs` is not supplied (legacy callers / pre-v3.8 providers
      // that still use the deprecated nested form) the check is SKIPPED so the
      // existing happy path is unaffected.
      //
      // #336 (v1.11.113) follow-up: distinguish two distinct cases that both
      // should SKIP the ref→id cross-check rather than fail it as "0 resolved":
      //   (a) caller did not pass siblingDocs at all (undefined / not an array)
      //   (b) caller passed an empty siblingDocs array
      // Case (b) shows up in a real-world OBB-style provider response that
      // declares `fulfillmentDocuments: []` at the response-root level (the
      // v3.8-correct location), but with no documents in it — typically
      // because the provider is still rolling out v3.8 emission and only
      // wires the array shape, not the contents, on the first iteration.
      // Treating it as "every ref is unresolved" would produce a
      // false-positive integrity failure on a perfectly legal pre-issuance
      // shape. Skip with a precise diagnostic instead.
      const _hasSiblingDocs = Array.isArray(siblingDocs) && siblingDocs.length > 0;
      if (_hasSiblingDocs) {
        const _docIds = new Set(
          siblingDocs
            .filter(d => d != null && d.id != null)
            .map(d => String(d.id))
        );
        const _unresolved = fulfillment.fulfillmentDocumentRefs.filter(r => !_docIds.has(String(r)));
        test(`Fulfillment[${idx}].fulfillmentDocumentRefs all resolve to a sibling fulfillmentDocuments[].id (OSDM v3.8 integrity, when siblings present)`, () => {
          // #337: the existing message correctly named the unresolved refs and
          // the sibling-id pool, but didn't spell out the root cause — the
          // provider emits BOTH lists but their UUIDs don't link up. Add a
          // plain-language explanation so the report reader doesn't have to
          // diff the two sets in their head.
          expect(_unresolved.length,
            `Provider emits both fulfillmentDocumentRefs[] AND a sibling ` +
            `fulfillmentDocuments[] list, but the UUIDs don't reconcile — ` +
            `the refs and the docs are independently generated instead of ` +
            `linked. ` +
            `unresolved ref(s): [${_unresolved.map(r => JSON.stringify(r)).join(", ")}] — ` +
            `sibling ids: [${[..._docIds].join(", ") || "(none)"}].`
          ).to.eql(0);
        });
        if (_unresolved.length === 0) {
          validationLogger(`[INFO] Fulfillment[${idx}] all ${fulfillment.fulfillmentDocumentRefs.length} ref(s) resolve to sibling fulfillmentDocuments[].id (v3.8 integrity OK)`);
        }
      } else if (Array.isArray(siblingDocs)) {
        // Case (b): sibling array present but empty — legal pre-issuance shape.
        validationLogger(`[INFO] Fulfillment[${idx}] sibling fulfillmentDocuments[] is present but empty — v3.8 ref→id cross-check skipped (legal pre-issuance shape: provider declared the v3.8 fulfillmentDocuments[] location but emitted no documents yet).`);
      } else {
        // Case (a): sibling array absent entirely — caller did not supply it.
        validationLogger(`[INFO] Fulfillment[${idx}] sibling fulfillmentDocuments[] not provided to validator — v3.8 ref→id cross-check skipped (caller did not supply it; expected for pre-v3.8 providers using the deprecated nested fulfillment.fulfillmentDocuments).`);
      }
    } else if (!_hasLegacyDocs) {
      validationLogger(`[INFO] Fulfillment[${idx}] has no document refs or documents (may be pre-issuance state)`);
    }
  });

  bru.setEnvVar("fulfillmentIds", JSON.stringify(fulfillmentIds));
}

// Expose to global for convenience in eval/require loader flows
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
