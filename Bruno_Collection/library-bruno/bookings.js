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
const { checkExtensibleCode } = require('./osdmEnums.js');

module.exports = {
  postCreateBookingResponse,
  validateFulfillments,
  checkFulfillmentSummaryStatus,
  checkProvisionalPrice,
  alignPassengerIdsToSubmittedOrder,
  isPostConfirmationStage,
  pairOfferParts,
  // Not under its own name: offers.js exposes a different validateOfferParts
  // on globalThis.
  validateBookedOfferParts: validateOfferParts,
};

// ─── Passenger id ordering ───────────────────────────────────────────────────
/**
 * Order the booking's passenger ids to match the SUBMITTED order, keyed on each
 * passenger's `externalRef` (the retailer reference OSCAR sends and the provider
 * echoes back on the booking + on GET /passengers/{id}).
 *
 * Why: OSDM does not guarantee a booking returns passengers in the order they
 * were submitted — some providers (e.g. Turnit) reorder them. The downstream
 * per-passenger steps (`03. PATCH Multi Passenger`, `04. GET Passenger`) pair
 * `passengerIdList[i]` with `passengerAdditionalData[i]` / `bookingPassengerReferences[i]`
 * BY INDEX, so a reordered booking made every per-passenger field compare against
 * the wrong expected row (~25 false-fails on a 5-pax run, all data otherwise
 * correct).
 *
 * Returns `{ ids, aligned, reordered }`. Falls back to booking order
 * (`aligned:false`) when external refs are absent, counts mismatch, or any
 * submitted ref can't be mapped — so providers that don't echo `externalRef`,
 * and providers that already return in order, are unaffected (for the latter the
 * realignment is an identity no-op, `reordered:false`).
 *
 * @param {Array}  bookingPassengers  booking.passengers[] (each may have id, externalRef)
 * @param {Array}  submittedRefs      bookingPassengerReferences (submitted order)
 * @returns {{ids:string[], aligned:boolean, reordered:boolean}}
 */
function alignPassengerIdsToSubmittedOrder(bookingPassengers, submittedRefs) {
  const bookingOrderIds = [];
  const refToId = Object.create(null);
  (Array.isArray(bookingPassengers) ? bookingPassengers : []).forEach((p) => {
    if (p && p.id) {
      bookingOrderIds.push(p.id);
      if (p.externalRef != null && p.externalRef !== '') {
        refToId[String(p.externalRef)] = p.id;
      }
    }
  });
  const refs = Array.isArray(submittedRefs) ? submittedRefs : [];
  const canAlign = refs.length > 0
    && refs.length === bookingOrderIds.length
    && refs.every((r) => refToId[String(r)] !== undefined);
  if (!canAlign) return { ids: bookingOrderIds, aligned: false, reordered: false };
  const ids = refs.map((r) => refToId[String(r)]);
  const reordered = ids.some((id, i) => id !== bookingOrderIds[i]);
  return { ids, aligned: true, reordered };
}

// ─── Field-level helpers ─────────────────────────────────────────────────────

function validatePartIntersectionFields(offerParts, bookedParts, partType, fields) {
  fields.forEach(field => {
    const offerValues   = offerParts.map(p => p[field]).filter(v => v != null);
    const bookingValues = bookedParts.map(p => p[field]).filter(v => v != null);
    if (offerValues.length > 0 && bookingValues.length > 0) {
      test(`${partType} ${field} values have at least one member in common between offer and booking offer=[${offerValues}] booking=[${bookingValues}]`, () => {
        const intersection = offerValues.filter(v => bookingValues.includes(v));
        expect(intersection.length, `No common value for ${field} between offer and booking`).to.be.above(0);
        validationLogger(`[DEBUG] ${partType} ${field}: offer=[${offerValues}] booking=[${bookingValues}] intersection=[${intersection}]`);
      });
    } else if (offerValues.length === 0 && bookingValues.length === 0) {
      validationLogger(`[DEBUG] ${partType}: '${field}' is empty in both offer and booking`);
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
        validationLogger(`[DEBUG] ${partType}[${index}].${field}: offer='${part[field]}' booking='${bookedPart[field]}'`);
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
        validationLogger(`[DEBUG] ${partType} price.${field}: offer=[${offerValues}] booking=[${bookingValues}] intersection=[${intersection}]`);
      });
    });
  } else if (offerPrices.length === 0 && bookingPrices.length === 0) {
    validationLogger(`[DEBUG] ${partType}: 'price' is empty in both offer and booking`);
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
          validationLogger(`[DEBUG] ${partType}[${index}].${field}: offer='${part[field]}' booking='${bookedPart[field]}'`);
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
    validationLogger(`[DEBUG] ${partType}[${index}] has ${offerConditions.length} afterSalesCondition(s) in offer and ${bookedConditions.length} in booking`);
  });
  // #389: pair offer→booking conditions by type + IDENTICAL validity INSTANTS
  // (timezone-insensitive — the offer speaks +02:00, the booking Z), then by
  // consumption among same-type leftovers, then re-use with one WARNING. The
  // old find()-by-type compared EVERY offer window of a type against the
  // booking's FIRST window of that type — two REFUND windows (free until the
  // eve of travel / full fee after) manufactured "the offer said 88950, the
  // booking says 0" on perfectly mirrored payloads (tester + OBB finding;
  // the same first-match disease as the #383 appliedPassengerTypes fix).
  const _condInstant = (v) => {
    if (!v) return null;
    const t = new Date(v).getTime();
    return isNaN(t) ? String(v) : t;
  };
  const _bookedCondPool = bookedConditions.slice();
  let _condReuseWarned = false;
  offerConditions.forEach((condition, condIndex) => {
    const condType = condition.condition;
    let _pairKind = 'window';
    let _poolIdx = _bookedCondPool.findIndex((c) => c && c.condition === condType
      && _condInstant(c.validFrom) === _condInstant(condition.validFrom)
      && _condInstant(c.validUntil) === _condInstant(condition.validUntil));
    if (_poolIdx === -1) {
      _pairKind = 'order';
      _poolIdx = _bookedCondPool.findIndex((c) => c && c.condition === condType);
    }
    let bookedCondition = (_poolIdx !== -1) ? _bookedCondPool.splice(_poolIdx, 1)[0] : null;
    if (!bookedCondition) {
      bookedCondition = bookedConditions.find((c) => c && c.condition === condType) || null;
      _pairKind = 'reused';
      if (bookedCondition && !_condReuseWarned) {
        _condReuseWarned = true;
        validationLogger(`[WARNING] ${partType}[${index}] afterSalesConditions: the booking carries fewer ${condType} conditions than the offer — entries re-used for matching; per-window comparison is approximate.`);
      }
    }
    test(`${partType}[${index}] afterSalesConditions[${condIndex}] - ${condType} exists in booking`, () => {
      expect(bookedCondition, `Condition '${condType}' not found in booking`).to.exist;
      validationLogger(`[DEBUG] ${partType}[${index}] afterSalesConditions[${condIndex}] - ${condType} found in booking (paired by ${_pairKind === 'window' ? 'validity window' : _pairKind === 'order' ? 'type+order' : 'type re-use'})`);
    });
    if (!bookedCondition) return;
    if (_pairKind === 'order' && (condition.validFrom || condition.validUntil || bookedCondition.validFrom || bookedCondition.validUntil)) {
      validationLogger(`[WARNING] ${partType}[${index}] afterSalesConditions[${condIndex}] (${condType}): no booking condition shares this validity window (offer ${condition.validFrom || '-'} → ${condition.validUntil || 'open'}; paired with booking ${bookedCondition.validFrom || '-'} → ${bookedCondition.validUntil || 'open'}) — the schedules differ between offer and booking.`);
    }
    test(`${partType}[${index}] afterSalesConditions[${condIndex}].condition matches`, () => {
      expect(bookedCondition.condition).to.eql(condition.condition);
      validationLogger(`[DEBUG] ${partType}[${index}] afterSalesConditions[${condIndex}].condition: offer='${condition.condition}' booking='${bookedCondition.condition}'`);
    });
    if (condition.afterSaleFee && bookedCondition.afterSaleFee) {
      test(`${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee exists in both`, () => {
        expect(condition.afterSaleFee).to.exist;
        expect(bookedCondition.afterSaleFee).to.exist;
        validationLogger(`[DEBUG] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee exists in both offer and booking`);
      });
      ['currency', 'amount', 'scale'].forEach(field => {
        const _offerVal  = condition.afterSaleFee[field];
        const _bookedVal = bookedCondition.afterSaleFee[field];
        const _name = `${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee.${field} matches`;
        if (_bookedVal === _offerVal) {
          test(_name, () => {
            validationLogger(`[DEBUG] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee.${field}: offer='${_offerVal}' booking='${_bookedVal}'`);
          });
          return;
        }
        // #375: decodable provider-language failure (no chai tail).
        // #383: ONE failing row per root cause across the booking re-reads.
        recordFindingOnce(
          `${partType}[${index}].asc[${condIndex}].afterSaleFee.${field}|${JSON.stringify(_offerVal)}|${JSON.stringify(_bookedVal)}`,
          () => {
            test(_name, () => {
              throw new Error(`Booking does not echo the offer's ${condition.condition} fee ${field}: the offer said ${JSON.stringify(_offerVal)}, the booking says ${JSON.stringify(_bookedVal)} — the booking must mirror the offer's after-sales conditions.`);
            });
          },
          `[WARNING] ${_name}: defect already recorded at create-booking — still present at this read (offer ${JSON.stringify(_offerVal)} vs booking ${JSON.stringify(_bookedVal)}).`,
        );
      });
      const scenarioType = bru.getEnvVar("scenarioType");
      if (scenarioType && scenarioType.includes(condType)) {
        bru.setEnvVar(`afterSaleCondition_${condType}_amount`,   condition.afterSaleFee.amount);
        bru.setEnvVar(`afterSaleCondition_${condType}_currency`, condition.afterSaleFee.currency);
        bru.setEnvVar(`afterSaleCondition_${condType}_scale`,    condition.afterSaleFee.scale);
        validationLogger(`[DEBUG] Stored afterSaleCondition_${condType}: amount=${condition.afterSaleFee.amount}, currency=${condition.afterSaleFee.currency}`);
      }
    } else {
      validationLogger(`[WARNING] ${partType}[${index}] afterSalesConditions[${condIndex}].afterSaleFee missing in offer or booking`);
    }
  });
}

// #383 (Option B, approved): offer↔booking mismatch findings register ONE
// failing row per root cause. The booking is validated at THREE steps (02
// create / 05 before fulfillment / 07 after) — re-reads seeing the IDENTICAL
// finding (same part/condition/field/values) would only re-count it, so they
// log a [WARNING] instead. A DIFFERENT value at a re-read is a state-transition
// change → a NEW finding, registered normally. Keys live in
// __bookingFindingKeys (reset per scenario via the parser delete-list).
function isCreateBookingStep() {
  try { return ((req && req.getName && req.getName()) || "") === "02. POST Create Booking"; } catch (_e) { return false; }
}
function recordFindingOnce(key, registerFailingTest, rereadNote) {
  let seen = [];
  try { seen = JSON.parse(bru.getEnvVar("__bookingFindingKeys") || "[]"); } catch (_e) { seen = []; }
  if (!Array.isArray(seen)) seen = [];
  if (seen.includes(key) && !isCreateBookingStep()) {
    validationLogger(rereadNote);
    return;
  }
  if (!seen.includes(key)) {
    seen.push(key);
    bru.setEnvVar("__bookingFindingKeys", JSON.stringify(seen));
  }
  registerFailingTest();
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
    validationLogger(`[DEBUG] ${partType}[${index}] has ${part.appliedPassengerTypes.length} appliedPassengerType(s) in offer and ${bookedPart.appliedPassengerTypes.length} in booking`);
  });
  // #383: 1:1 consumption matching. The old find()-by-type returned the FIRST
  // booking entry of each type for EVERY offer passenger of that type — for a
  // 2 ADT + 3 CHD party the log showed booking refs PAX1, PAX1, 00003, 00003,
  // 00003 (OUR matcher, not the provider collapsing passengers), the same
  // entry was compared N times, and per-passenger coverage was never checked.
  // Order now: exact passengerRef match (providers that keep the request's
  // refs — OBB does) → first UNCONSUMED entry of the same type (sandboxes that
  // rewrite refs to internal UUIDs) → re-use any entry of the type, with one
  // R9 note (booking carries fewer entries than the offer).
  const _bookedPtPool = Array.isArray(bookedPart.appliedPassengerTypes) ? bookedPart.appliedPassengerTypes.slice() : [];
  const _bookedPtAll  = Array.isArray(bookedPart.appliedPassengerTypes) ? bookedPart.appliedPassengerTypes : [];
  let _ptReuseWarned = false;
  const _distinctBookedRefs = new Set(_bookedPtAll.map(pt => pt && pt.passengerRef).filter(Boolean));
  if (_bookedPtAll.length > 1 && _distinctBookedRefs.size < _bookedPtAll.length) {
    validationLogger(`[WARNING] ${partType}[${index}] appliedPassengerTypes: only ${_distinctBookedRefs.size} distinct passengerRef(s) across ${_bookedPtAll.length} booking entries — passengers share references, so per-passenger entitlements cannot be told apart.`);
  }
  part.appliedPassengerTypes.forEach((passengerType, ptIndex) => {
    validationLogger(`[DEBUG] Validating ${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type}`);
    let _matchKind = 'ref';
    let _poolIdx = _bookedPtPool.findIndex(pt => pt && pt.passengerRef != null && pt.passengerRef === passengerType.passengerRef);
    if (_poolIdx === -1) {
      _matchKind = 'type';
      _poolIdx = _bookedPtPool.findIndex(pt => pt && pt.type === passengerType.type);
    }
    let bookedPassengerType = (_poolIdx !== -1) ? _bookedPtPool.splice(_poolIdx, 1)[0] : null;
    if (!bookedPassengerType) {
      // Pool exhausted — fewer booking entries than offer entries. Stay as
      // lenient as the historic matcher (re-use an entry) but say so once.
      bookedPassengerType = _bookedPtAll.find(pt => pt && pt.type === passengerType.type) || null;
      _matchKind = 'reused';
      if (bookedPassengerType && !_ptReuseWarned) {
        _ptReuseWarned = true;
        validationLogger(`[WARNING] ${partType}[${index}] appliedPassengerTypes: the booking carries fewer entries (${_bookedPtAll.length}) than the offer (${part.appliedPassengerTypes.length}) — entries re-used for matching; per-passenger linkage cannot be verified.`);
      }
    }
    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type} exists in booking`, () => {
      expect(bookedPassengerType, `PassengerType type='${passengerType.type}' not found in booking`).to.exist;
      validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}] - type=${passengerType.type} found in booking`);
    });
    if (!bookedPassengerType) return;

    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].passengerRef exists in booking`, () => {
      expect(bookedPassengerType.passengerRef, `passengerRef missing in booking appliedPassengerTypes`).to.be.a('string').and.not.be.empty;
      validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].passengerRef in booking: '${bookedPassengerType.passengerRef}'`
        + (_matchKind === 'ref'
          ? ` — matched 1:1 with the offer's '${passengerType.passengerRef}'`
          : ` (offer externalRef was: '${passengerType.passengerRef}'; matched by type — the provider uses its own ids)`));
    });
    test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].type matches`, () => {
      expect(bookedPassengerType.type).to.eql(passengerType.type);
      validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].type: offer='${passengerType.type}' booking='${bookedPassengerType.type}'`);
    });

    if (passengerType.description && bookedPassengerType.description) {
      test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].description matches`, () => {
        expect(bookedPassengerType.description).to.eql(passengerType.description);
        validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].description: offer='${passengerType.description}' booking='${bookedPassengerType.description}'`);
      });
    }

    if (passengerType.tripCoverage && bookedPassengerType.tripCoverage) {
      test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage exists in both`, () => {
        expect(passengerType.tripCoverage).to.exist;
        expect(bookedPassengerType.tripCoverage).to.exist;
        validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage exists in both offer and booking`);
      });
      if (passengerType.tripCoverage.coveredTripId && bookedPassengerType.tripCoverage.coveredTripId) {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredTripId matches`, () => {
          expect(bookedPassengerType.tripCoverage.coveredTripId).to.eql(passengerType.tripCoverage.coveredTripId);
          validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredTripId: offer='${passengerType.tripCoverage.coveredTripId}' booking='${bookedPassengerType.tripCoverage.coveredTripId}'`);
        });
      }
      if (passengerType.tripCoverage.coveredLegIds && bookedPassengerType.tripCoverage.coveredLegIds) {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredLegIds matches`, () => {
          expect(bookedPassengerType.tripCoverage.coveredLegIds).to.have.members(passengerType.tripCoverage.coveredLegIds);
          validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].tripCoverage.coveredLegIds: offer=[${passengerType.tripCoverage.coveredLegIds}] booking=[${bookedPassengerType.tripCoverage.coveredLegIds}]`);
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
          validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}] has ${passengerType.appliedReductionCardTypes.length} appliedReductionCardType(s)`);
        });
        passengerType.appliedReductionCardTypes.forEach((cardType, cardIndex) => {
          const bookedCardType = bookedPassengerType.appliedReductionCardTypes?.find(c => c === cardType);
          test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes[${cardIndex}] matches`, () => {
            expect(bookedCardType).to.eql(cardType);
            validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes[${cardIndex}]: offer='${cardType}' booking='${bookedCardType}'`);
          });
        });
      } else {
        test(`${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes is empty in both`, () => {
          expect(bookedPassengerType.appliedReductionCardTypes || []).to.be.an('array').with.lengthOf(0);
          validationLogger(`[DEBUG] ${partType}[${index}] appliedPassengerTypes[${ptIndex}].appliedReductionCardTypes is empty in both offer and booking`);
        });
      }
    }
  });
}

// ─── Offer part ↔ booked part pairing (#550) ─────────────────────────────────
// OSDM gives a booked part no reference to the offer part it was made from,
// and does not require the booking to list its parts in the offer's order.
// Pairing by position compared, e.g., the offer's ADULT admission with the
// booking's SENIOR one. Parts are paired by content instead: every pair gets
// a score, and the best-scoring pairs are taken first. The weights are
// ranked (a higher criterion outweighs all lower ones together):
//   same id > same passenger references > same passenger types >
//   same products, same trip coverage > same validity > same price >
//   same offerMode / isReservationRequired / after-sales conditions.
// Ties are broken by the offer part's position and then by the booked part's
// own text, never by its position, so the same booking listed in any order
// gives the same pairs and therefore the same assertions.

const _sortedJoin = (values) => values.filter((v) => v != null && v !== '').map(String).sort(_compareText).join('|');

function _instant(value) {
  if (!value) return '';
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? String(value) : String(t);
}

function _passengerTypesOf(part) {
  return Array.isArray(part.appliedPassengerTypes) ? part.appliedPassengerTypes.filter(Boolean) : [];
}

function _partSignature(part, refList) {
  const pts = _passengerTypesOf(part);
  const coverage = part.tripCoverage || {};
  const products = Array.isArray(part.products) ? part.products.filter(Boolean) : [];
  const conditions = part.afterSalesConditions || part.afterSaleConditions;
  return {
    id: part.id == null ? '' : String(part.id),
    ptRefs: _sortedJoin(pts.map((pt) => pt.passengerRef)),
    listRefs: _sortedJoin(Array.isArray(refList) ? refList : []),
    types: _sortedJoin(pts.map((pt) => pt.type)),
    products: [part.summaryProductId || '', _sortedJoin(products.map((p) => `${p.productId || ''}@${p.legId || ''}`))].join('#'),
    coverage: [coverage.coveredTripId || '', _sortedJoin(Array.isArray(coverage.coveredLegIds) ? coverage.coveredLegIds : [])].join('#'),
    validFrom: _instant(part.validFrom),
    validUntil: _instant(part.validUntil),
    price: part.price ? `${part.price.amount}|${part.price.currency}` : '',
    offerMode: part.offerMode == null ? '' : String(part.offerMode),
    isReservationRequired: part.isReservationRequired == null ? '' : String(part.isReservationRequired),
    conditions: Array.isArray(conditions)
      ? _sortedJoin(conditions.filter(Boolean).map((c) => `${c.condition}:${c.afterSaleFee ? c.afterSaleFee.amount : ''}`))
      : '',
  };
}

const _PAIR_WEIGHTS = [
  ['id', 1e6], ['types', 1e4], ['products', 1e3], ['coverage', 1e3],
  ['validFrom', 100], ['validUntil', 100], ['price', 10],
  ['offerMode', 1], ['isReservationRequired', 1], ['conditions', 1],
];
const _NO_VALUE = new Set(['', '#']);

function _pairScore(o, b) {
  let score = 0;
  // Passenger references: the same field on both sides, or the offer part's
  // passengerRefs against the booked part's passengerIds.
  if ((o.ptRefs && o.ptRefs === b.ptRefs) || (o.listRefs && o.listRefs === b.listRefs)) score += 1e5;
  _PAIR_WEIGHTS.forEach(([key, weight]) => {
    if (!_NO_VALUE.has(o[key]) && o[key] === b[key]) score += weight;
  });
  return score;
}

// Code-unit order, not localeCompare: two different texts never compare equal.
function _compareText(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Pair the offer's parts with the booking's parts by content (#550).
 *
 * @param {Array} offerParts   e.g. selectedOffer.admissionOfferParts
 * @param {Array} bookedParts  e.g. bookedOffers.flatMap(b => b.admissions)
 * @returns {{pairs: Array<{offerIndex:number, bookedIndex:number, typesMatch:boolean}>,
 *            missing: number[], extra: number[], reordered: boolean}}
 *   `pairs` in offer order; `missing` = offer parts with no booked part left,
 *   `extra` = booked parts no offer part took; `reordered` = some pair does
 *   not sit at the same position on both sides.
 */
function pairOfferParts(offerParts, bookedParts) {
  const offers = Array.isArray(offerParts) ? offerParts : [];
  const booked = Array.isArray(bookedParts) ? bookedParts : [];
  const oSig = offers.map((p) => _partSignature(p || {}, p?.passengerRefs));
  const bSig = booked.map((p) => _partSignature(p || {}, p?.passengerIds));
  const bText = booked.map((p) => JSON.stringify(p) || '');
  const candidates = [];
  offers.forEach((o, oi) => {
    booked.forEach((b, bi) => {
      if (o && b) candidates.push({ oi, bi, score: _pairScore(oSig[oi], bSig[bi]) });
    });
  });
  candidates.sort((x, y) => (y.score - x.score)
    || (x.oi - y.oi)
    || _compareText(bText[x.bi], bText[y.bi])
    || (x.bi - y.bi));
  const offerTaken = new Array(offers.length).fill(-1);
  const bookedTaken = new Array(booked.length).fill(false);
  for (const c of candidates) {
    if (offerTaken[c.oi] === -1 && !bookedTaken[c.bi]) {
      offerTaken[c.oi] = c.bi;
      bookedTaken[c.bi] = true;
    }
  }
  const pairs = [];
  const missing = [];
  offerTaken.forEach((bi, oi) => {
    if (bi === -1) { missing.push(oi); return; }
    pairs.push({ offerIndex: oi, bookedIndex: bi, typesMatch: oSig[oi].types === bSig[bi].types });
  });
  const extra = [];
  bookedTaken.forEach((taken, bi) => { if (!taken) extra.push(bi); });
  return { pairs, missing, extra, reordered: pairs.some((p) => p.offerIndex !== p.bookedIndex) };
}

function _describePart(part) {
  part = part || {};
  const types = _passengerTypesOf(part).map((pt) => pt.type).filter(Boolean);
  const typesText = types.length ? ', passenger types ' + types.join(', ') : '';
  return `id=${part.id}${typesText}`;
}

// ─── Part-level orchestrator ─────────────────────────────────────────────────

function validateOfferParts(offerParts, bookedParts, partType, expectedBookedOffersStatus) {
  const _idsRaw = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
  const ids = Array.isArray(_idsRaw) ? _idsRaw : JSON.parse(_idsRaw || "[]");

  const pairing = pairOfferParts(offerParts, bookedParts);
  if (pairing.reordered) {
    validationLogger(`[INFO] ${partType}: the booking lists its parts in another order than the offer; parts paired by content: `
      + pairing.pairs.map((p) => `offer[${p.offerIndex}] ↔ booking[${p.bookedIndex}]`).join(', '));
  }
  pairing.pairs.filter((p) => !p.typesMatch).forEach((p) => {
    validationLogger(`[WARNING] ${partType}[${p.offerIndex}]: no booked part carries the same passenger types as offer part ${_describePart(offerParts[p.offerIndex])}; compared with booking[${p.bookedIndex}] (${_describePart(bookedParts[p.bookedIndex])}), the closest remaining part.`);
  });
  pairing.missing.forEach((index) => {
    const part = offerParts[index] || {};
    // Every admission of the offer is booked. A reservation or an ancillary
    // part can be optional (booked only when selected), so its absence stays
    // a warning, as before.
    if (partType !== 'admission') {
      validationLogger(`[WARNING] No booked ${partType} found for offer ${partType}[${index}] (${_describePart(part)}); it may be an optional part that was not selected.`);
      return;
    }
    const name = `${partType}[${index}] has a counterpart in the booking (offer part ${_describePart(part)})`;
    // #383: one failing row per root cause across the booking re-reads.
    recordFindingOnce(
      `${partType}.missing|${part.id}`,
      () => {
        test(name, () => {
          throw new Error(`The booking has no ${partType} for offer part ${_describePart(part)}: the offer has ${offerParts.length} ${partType} part(s), the booking ${bookedParts.length}. The field checks for this part are skipped.`);
        });
      },
      `[WARNING] ${name}: defect already recorded at create-booking — still present at this read.`,
    );
  });
  if (pairing.extra.length > 0) {
    // Not a fault: a combined return booking holds the other direction's
    // parts, and parts can be added after the sale.
    validationLogger(`[INFO] ${partType}: the booking has ${pairing.extra.length} part(s) that no part of the selected offer pairs with: `
      + pairing.extra.map((bi) => _describePart(bookedParts[bi])).join('; '));
    // #594: they are parts of this booking all the same, so a fulfillment
    // that holds them (the outbound ticket of a return) is not refused.
    pairing.extra.forEach((bi) => { if (bookedParts[bi] && bookedParts[bi].id) ids.push(bookedParts[bi].id); });
  }

  pairing.pairs.forEach(({ offerIndex: index, bookedIndex }) => {
    const part = offerParts[index];
    const bookedPart = bookedParts[bookedIndex];
    ids.push(bookedPart.id);

    validatePartIntersectionFields(offerParts, bookedParts, partType, ['exchangeable', 'refundable']);
    validatePartEqualityFields(part, bookedPart, partType, index, ['isReservationRequired', 'offerMode']);

    test(`Status is ${expectedBookedOffersStatus} for ${partType}[${index}] - expected: ${expectedBookedOffersStatus}, actual: ${bookedPart.status}`, () => {
      if (Array.isArray(expectedBookedOffersStatus)) {
        expect(expectedBookedOffersStatus).to.include(bookedPart.status);
      } else {
        expect(bookedPart.status).to.eql(expectedBookedOffersStatus);
      }
      validationLogger(`[DEBUG] ${partType}[${index}]: status: ${bookedPart.status}`);
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

  bru.setEnvVar("admissionReservationAncillaryBookingPartsIds", [...new Set(ids)]);
}

// ─── Public functions ────────────────────────────────────────────────────────

// #377: 🎯 accommodation goal-closing — requested → offered → allocated.
// The booked Reservation's placeAllocation (OSDM: accommodationType,
// accommodationSubType, reservedPlaces, tripLegCoverage all required when
// present) is the provider's own statement of what was allocated. Absent
// placeAllocation is a capability note (WARNING), not a failure.
function validateAccommodationGoal(selectedOffer, bookedOffers) {
  const requested = bru.getEnvVar("accommodationSelection");
  if (!requested || requested === "null") return;   // scenario asked for no accommodation family

  let selAcc = null;
  try { const raw = bru.getEnvVar("selectedAccommodation"); selAcc = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { selAcc = null; }
  const reservationId = bru.getEnvVar("reservationId");
  const offeredLabel = selAcc
    ? `${selAcc.accommodationType}${selAcc.accommodationSubType ? '/' + selAcc.accommodationSubType : ''}`
    : String(requested);

  const bookedRes = (bookedOffers || []).flatMap(b => (b && b.reservations) || []).filter(Boolean);
  // #396: locate the booked reservation by id; if the provider didn't echo it,
  // fall back to the requested accommodation type, and only then to the first
  // reservation — warning when that last fallback is ambiguous (>1 reservation).
  // The old `|| bookedRes[0]` silently validated the 🎯 goal against the FIRST
  // reservation, which can green-light the wrong compartment in a multi-
  // reservation booking.
  let target = bookedRes.find(r => r.id === reservationId) || null;
  if (!target && selAcc && selAcc.accommodationType) {
    const _want = String(selAcc.accommodationType).toUpperCase();
    target = bookedRes.find(r => r.placeAllocation
      && String(r.placeAllocation.accommodationType || '').toUpperCase() === _want) || null;
  }
  if (!target) {
    target = bookedRes[0] || null;
    if (target && bookedRes.length > 1) {
      validationLogger(`[WARNING] 🎯 Accommodation goal: the booked reservation could not be located by id (${reservationId || 'n/a'}) or by accommodation type (${selAcc && selAcc.accommodationType ? selAcc.accommodationType : 'n/a'}) among ${bookedRes.length} reservations — validating against the first; the 🎯 verdict may target the wrong reservation part.`);
    }
  }

  test(`🎯 Accommodation goal — booking carries the requested ${requested} reservation`, () => {
    if (!target) throw new Error(`No reservation part in the booking (requested ${requested}, selected part ${reservationId || 'n/a'}) — the provider dropped the reservation from the booking.`);
  });
  if (!target) return;

  const alloc = target.placeAllocation;
  if (!alloc) {
    validationLogger(`[WARNING] 🎯 Accommodation goal: requested ${requested} → offer advertised ${offeredLabel} (part ${reservationId}) → booked, but the reservation carries NO placeAllocation — the provider does not state which place(s) were allocated. Goal verified up to the reservation level only.`);
    return;
  }

  test(`🎯 placeAllocation.accommodationType matches the requested ${requested}`, () => {
    const got = String(alloc.accommodationType || '');
    if (got.toUpperCase() !== String(requested).toUpperCase()) {
      throw new Error(`Requested ${requested} but the booking allocated '${got || '(none)'}' — the provider changed the accommodation family.`);
    }
  });
  if (selAcc && selAcc.accommodationSubType && alloc.accommodationSubType) {
    test(`🎯 placeAllocation.accommodationSubType matches the offered compartment (${selAcc.accommodationSubType})`, () => {
      if (String(alloc.accommodationSubType) !== String(selAcc.accommodationSubType)) {
        throw new Error(`The offer advertised ${selAcc.accommodationSubType}, the booking allocated ${alloc.accommodationSubType} — the allocation does not match the selected compartment.`);
      }
    });
  }
  test(`🎯 placeAllocation.reservedPlaces is non-empty (OSDM: required member of PlaceAllocation)`, () => {
    if (!Array.isArray(alloc.reservedPlaces) || alloc.reservedPlaces.length === 0) {
      throw new Error(`placeAllocation.reservedPlaces is ${JSON.stringify(alloc.reservedPlaces)} — OSDM requires the reserved place(s) to be stated when placeAllocation is present.`);
    }
  });
  let tlc = [];
  try { const raw = bru.getEnvVar("tripLegCoverage"); tlc = typeof raw === 'string' ? JSON.parse(raw) : (raw || []); } catch { tlc = []; }
  if (Array.isArray(tlc) && tlc.length > 0 && alloc.tripLegCoverage) {
    test(`🎯 placeAllocation.tripLegCoverage matches the selected coverage`, () => {
      const ok = tlc.some(c => c && c.tripId === alloc.tripLegCoverage.tripId && c.legId === alloc.tripLegCoverage.legId);
      if (!ok) throw new Error(`The allocation covers trip/leg ${alloc.tripLegCoverage.tripId}/${alloc.tripLegCoverage.legId}, but the selection targeted ${tlc.map(c => c.tripId + '/' + c.legId).join(', ')}.`);
    });
  }
  // #383: name the actual places so a human can judge the allocation, and
  // relate the count to the party (R9 nuance — a 'place' may be a compartment
  // hosting several passengers, e.g. a DOUBLE berth, so fewer places than
  // passengers can be legitimate; the list is what tells which case it is).
  const _resPlaces = Array.isArray(alloc.reservedPlaces) ? alloc.reservedPlaces : [];
  const _placeLabel = (p) => {
    if (!p || typeof p !== 'object') return '?';
    const _coach = p.coachNumber != null ? p.coachNumber : (p.coach != null ? p.coach : null);
    const _num   = p.placeNumber != null ? p.placeNumber : (p.number != null ? p.number : (p.place != null ? p.place : null));
    if (_coach != null && _num != null) return `coach ${_coach} place ${_num}`;
    if (_num != null) return `place ${_num}`;
    return JSON.stringify(p).slice(0, 40);
  };
  const _placesText = _resPlaces.length ? ` [${_resPlaces.map(_placeLabel).join('; ')}]` : '';
  validationLogger(`[INFO] 🎯 Accommodation goal MET: requested ${requested} → offer advertised ${offeredLabel} (part ${reservationId}) → booking allocated ${alloc.accommodationType}${alloc.accommodationSubType ? '/' + alloc.accommodationSubType : ''} with ${_resPlaces.length} reserved place(s)${_placesText}.`);
  let _party = 0;
  try { _party = (JSON.parse(bru.getEnvVar("offerPassengerSpecifications") || "[]") || []).length; } catch (_e) { _party = 0; }

  // #211 (SFR night-train spec): when the scenario declared an offerMode,
  // the SFR's two families have a STRICT place-count expectation — exactly
  // one place for INDIVIDUAL (bed in shared compartment), place count ==
  // party size for COLLECTIVE (private compartment). Without a declared
  // offerMode, keep the pre-existing soft WARNING (many non-night-train
  // scenarios legitimately allocate a multi-passenger compartment as one
  // place and should not suddenly start failing).
  const _declaredOfferMode = bru.getEnvVar("offerMode");
  if (_party > 0 && _resPlaces.length > 0 && (_declaredOfferMode === "INDIVIDUAL" || _declaredOfferMode === "COLLECTIVE")) {
    if (_declaredOfferMode === "INDIVIDUAL") {
      test(`🎯 offerMode INDIVIDUAL — exactly one place allocated (bed in shared compartment)`, () => {
        if (_resPlaces.length !== 1) {
          throw new Error(`offerMode INDIVIDUAL requires exactly one allocated place; got ${_resPlaces.length}${_placesText}.`);
        }
      });
    } else {
      test(`🎯 offerMode COLLECTIVE — allocated place count (${_resPlaces.length}) matches party size (${_party})`, () => {
        if (_resPlaces.length !== _party) {
          throw new Error(`offerMode COLLECTIVE (private compartment) requires the allocated place count to equal the party size (${_party}); got ${_resPlaces.length}${_placesText}.`);
        }
      });
    }
  } else if (_party > 0 && _resPlaces.length > 0 && _resPlaces.length < _party) {
    validationLogger(`[WARNING] 🎯 ${_resPlaces.length} reserved place(s) for a party of ${_party} — legitimate when a place is a multi-passenger compartment (${alloc.accommodationSubType || alloc.accommodationType}), under-allocation otherwise. Check the place list above.`);
  }

  // #211: the SFR's "selected gender property from request matches booked
  // response value" — compare the requested placeProperties (harvested onto
  // selectedAccommodation in offers.js) against whatever the booking
  // response echoes. OSDM does not guarantee placeAllocation echoes
  // placeProperties, so this only runs (and only WARNS, never fails) when
  // both sides actually carry a value to compare.
  if (selAcc && Array.isArray(selAcc.placeProperties) && selAcc.placeProperties.length > 0) {
    const _bookedProps = Array.isArray(alloc.placeProperties) ? alloc.placeProperties
      : (Array.isArray(_resPlaces[0]?.placeProperties) ? _resPlaces[0].placeProperties : null);
    if (Array.isArray(_bookedProps)) {
      const _requestedSet = selAcc.placeProperties;
      const _matches = _requestedSet.some(p => _bookedProps.includes(p));
      if (!_matches) {
        validationLogger(`[WARNING] 🎯 Requested gender-segregation placeProperties [${_requestedSet.join(',')}] but the booking response's placeProperties are [${_bookedProps.join(',')}] — no overlap. The provider may have reassigned the compartment.`);
      } else {
        validationLogger(`[DEBUG] 🎯 Gender-segregation placeProperties confirmed in the booking response: [${_bookedProps.join(',')}].`);
      }
    } else {
      validationLogger(`[DEBUG] Requested gender-segregation placeProperties [${selAcc.placeProperties.join(',')}] but the booking response echoes no placeProperties — not guaranteed by OSDM, check skipped.`);
    }
  }
}

// ─── Lifecycle-scoped price member ───────────────────────────────────────────
// An OSDM Booking carries two price members (openapi3_0.json, Booking schema;
// same wording on osdm.io/spec/models):
//   provisionalPrice — "Price of all unconfirmed pre-booked parts in the booking"
//   confirmedPrice   — "Sum of all prices of confirmed parts in the booking minus
//                       the sum of all confirmed refund amounts."
// So the member a GET-Booking step must assert depends on the booking-part
// stage that step expects (BookingPartStatus enum: PREBOOKED, ON_HOLD,
// CONFIRMED, FULFILLED, CANCELLED, RELEASED, REFUNDED, EXCHANGE_ONGOING,
// EXCHANGED, ERROR):
//   pre-confirmation  (PREBOOKED / ON_HOLD)                 → provisionalPrice
//   confirmed onwards (CONFIRMED / FULFILLED) and the after-sales states that
//   only exist for confirmed parts (REFUNDED / EXCHANGED) → confirmedPrice
// #375 introduced the split but matched FULFILLED|CONFIRMED only, so
// `14. GET Booking after Patch Refund` (stage REFUNDED) kept demanding
// provisionalPrice — legitimately absent once nothing is pre-booked any more
// (OTST review, Farruggia/SBB, relayed 2026-09-03, #496). EXCHANGED
// (`04-Exchange/15. GET Booking after Fulfillment`) is corrected on the same
// principle. EXCHANGE_ONGOING is deliberately NOT on the confirmed side: the
// exchange operation itself creates new pre-booked parts, and OSDM says
// provisionalPrice "includes booking parts from exchange operations" — so
// `13. GET Booking before Fulfillment` keeps asserting provisionalPrice.
const POST_CONFIRMATION_STAGE_RE = /CONFIRMED|FULFILLED|REFUNDED|EXCHANGED/i;
function isPostConfirmationStage(expectedBookedOffersStatus) {
  return POST_CONFIRMATION_STAGE_RE.test(String(expectedBookedOffersStatus || ''));
}

function postCreateBookingResponse(selectedOffer, jsonData, expectedBookedOffersStatus, expectedFulfillmentStatus, requireFulfillments = false) {
  validationLogger("[DEBUG] ► postCreateBookingResponse");

  // #613 F10: `warnings` is a WarningCollection object in OSDM 3.5+; the old
  // "not an array" WARNING here was the wrong way round. checkWarningsAndProblems
  // (offers.js) reads both shapes.
  if (typeof checkWarningsAndProblems === 'function') {
    checkWarningsAndProblems(jsonData);
  }

  const booking = jsonData.booking;
  if (typeof booking !== 'object' || booking === null) {
    validationLogger("[ERROR] No booking found or 'booking' is not an object.");
    throw new Error("No booking found or 'booking' is not an object.");
  }

  test(`'booking' object exists`, () => {
    expect(booking, "[ERROR] 'booking' is missing or empty").to.be.an("object").that.is.not.empty;
    validationLogger(`[DEBUG] 'booking' object exists`);
  });

  test(`booking.id is a non-empty string (OSDM: Booking.id required)`, () => {
    validationLogger(`[DEBUG] booking.id: ${booking.id}`);
    expect(booking.id).to.be.a('string').and.not.be.empty;
  });
  bru.setEnvVar("bookingId", booking.id);
  if (booking.bookingCode !== undefined && booking.bookingCode !== null) {
    test(`booking.bookingCode is a non-empty string when present`, () => {
      validationLogger(`[DEBUG] booking.bookingCode: ${booking.bookingCode}`);
      expect(booking.bookingCode).to.be.a('string').and.not.be.empty;
    });
  } else {
    validationLogger(`[DEBUG] booking.bookingCode is absent (optional per OSDM spec)`);
  }

  // Collect passenger IDs, ALIGNED to the submitted order by externalRef. OSDM
  // does not guarantee the booking returns passengers in submitted order (Turnit
  // reorders them); the per-passenger steps (03 PATCH / 04 GET Passenger) pair
  // passengerIdList[i] with passengerAdditionalData[i] BY INDEX, so a reordered
  // booking made every field compare against the wrong passenger. Align by the
  // externalRef OSCAR sent (and the provider echoes back); fall back to booking
  // order when refs are unavailable so unaffected providers behave exactly as before.
  (booking.passengers || []).forEach((passenger, i) => {
    if (!passenger || !passenger.id) validationLogger(`[WARNING] Passenger at index ${i} has no ID.`);
  });
  let _submittedRefs = [];
  try {
    const _raw = bru.getEnvVar("bookingPassengerReferences");
    _submittedRefs = _raw ? (Array.isArray(_raw) ? _raw : JSON.parse(_raw)) : [];
  } catch { _submittedRefs = []; }
  const _align = alignPassengerIdsToSubmittedOrder(booking.passengers, _submittedRefs);
  const passengerIdList = _align.ids;
  if (_align.aligned && _align.reordered) {
    validationLogger(`[WARNING] Provider returned booking passengers in a different order than submitted. Re-aligned passengerIdList to the submitted order by externalRef (${_submittedRefs.join(', ')}) so the per-passenger checks (03 PATCH / 04 GET Passenger) compare like-for-like rather than position-by-position. A strict OSDM consumer should not rely on passenger order either.`);
  } else if (!_align.aligned && (booking.passengers || []).length) {
    validationLogger(`[DEBUG] passengerIdList kept in booking order — externalRef alignment unavailable (refs/count mismatch or provider does not echo externalRef). submittedRefs=[${_submittedRefs.join(', ')}].`);
  }
  if (passengerIdList.length === 0) validationLogger("[ERROR] Passengers structure is invalid or empty.");
  validationLogger(`[FULL] Passenger IDs: [${passengerIdList}]`);
  bru.setEnvVar("passengerIdList", passengerIdList);

  // Check booking.createdOn > offer.createdOn
  const bookingDate = new Date(booking.createdOn);
  const offerDate   = new Date(selectedOffer.createdOn);
  if (!isNaN(bookingDate.getTime()) && !isNaN(offerDate.getTime())) {
    test(`booking.createdOn: ${bookingDate.toISOString()}, offer.createdOn: ${offerDate.toISOString()}`, () => {
      validationLogger(`[DEBUG] booking.createdOn: ${bookingDate.toISOString()}, offer.createdOn: ${offerDate.toISOString()}`);
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
      validationLogger(`[DEBUG] booking confirmation deadline: ${_confirmDeadline} (source: ${_confirmSource})`);
    });
    // Document vendor deviations from OSDM-standard placement.
    if (!booking.confirmationTimeLimit && booking.confirmableUntil) {
      validationLogger(`[WARNING] Provider exposes the booking-level confirmation deadline as 'confirmableUntil' rather than the OSDM-standard 'confirmationTimeLimit'. The OSDM spec defines 'confirmableUntil' at the bookingPart level only — at the booking level the standard field is 'confirmationTimeLimit'. OSCAR accepts both, but a strict OSDM consumer might not.`);
    } else if (!booking.confirmationTimeLimit && !booking.confirmableUntil) {
      validationLogger(`[WARNING] Provider does not expose a booking-level confirmation deadline (neither 'confirmationTimeLimit' nor 'confirmableUntil' at the booking root). OSCAR fell back to the earliest bookingPart-level 'confirmableUntil' (${_confirmDeadline}). This matches OSDM's schema placement for 'confirmableUntil' (it's defined on the bookingPart), but OSDM also recommends 'confirmationTimeLimit' at the booking root for clients that don't walk parts — a strict consumer might expect that.`);
    }
  } else {
    bru.setEnvVar('bookingConfirmationTimeLimit', '');
    validationLogger(`[DEBUG] booking has no confirmation deadline anywhere (not at the booking root, not on any bookingPart) → deadline test skipped; if #204 expiredBookingTest=on, that test will skip with a [WARNING] too.`);
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
      try { const v = typeof r === 'string' ? JSON.parse(r) : r; return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; } catch { return {}; }
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
    validationLogger(`[DEBUG] booking.requestedInformation absent → nothing additionally required`);
  }

  // B3: bookedOffers must be non-empty (OSDM: a booking must contain at least one BookedOffer)
  test(`booking.bookedOffers is a non-empty array (OSDM: required)`, () => {
    expect(booking.bookedOffers).to.be.an('array').with.lengthOf.at.least(1);
    validationLogger(`[DEBUG] booking.bookedOffers count: ${booking.bookedOffers?.length}`);
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
  // #613 F7: offerSummary is optional in OSDM; reading through it unguarded
  // threw before any check ran and stopped the step before its routing.
  const mini      = selectedOffer?.offerSummary?.minimalPrice;
  const confirmed = booking.confirmedPrice;

  // #375 / #496: price members are LIFECYCLE-scoped in OSDM — provisionalPrice
  // before confirmation, confirmedPrice once confirmed and through the
  // after-sales states (REFUNDED / EXCHANGED), where nothing is pre-booked any
  // more. Asserting BOTH at every stage false-failed every conformant provider,
  // and the combined field check crashed with a TypeError when one was absent.
  // Key on the expected booking-part status this call already receives — see
  // isPostConfirmationStage() above for the exact mapping.
  const _stageLabel = String(expectedBookedOffersStatus || '');
  const _expectsConfirmed = isPostConfirmationStage(expectedBookedOffersStatus);
  const _stagePrice = _expectsConfirmed ? confirmed : prov;
  const _stageName  = _expectsConfirmed ? 'confirmedPrice' : 'provisionalPrice';
  const _otherPrice = _expectsConfirmed ? prov : confirmed;
  const _otherName  = _expectsConfirmed ? 'provisionalPrice' : 'confirmedPrice';

  test(`${_stageName} structure exists (booking stage: ${expectedBookedOffersStatus || 'pre-confirmation'})`, () => {
    if (!_stagePrice) throw new Error(`${_stageName} missing — OSDM expects it at this booking stage (${expectedBookedOffersStatus || 'pre-confirmation'}).`);
    validationLogger(`[DEBUG] ${_stageName} structure exists`);
  });
  validationLogger(_otherPrice
    ? `[DEBUG] ${_otherName} also present at this stage — allowed (optional member).`
    : `[DEBUG] ${_otherName} absent at this stage — allowed (lifecycle-scoped member).`);
  test(`Price fields exist (currency, scale) in ${_stageName}`, () => {
    if (!_stagePrice) throw new Error(`${_stageName} missing — its fields cannot be checked (see the assertion above).`);
    ['currency', 'scale'].forEach(field => {
      if (_stagePrice[field] == null) throw new Error(`${_stageName}.${field} missing in booking (got: ${JSON.stringify(_stagePrice[field])})`);
    });
    validationLogger(`[DEBUG] ${_stageName} fields present (currency, scale)`);
  });
  if (prov) bru.setEnvVar("provisionalPriceAmount", prov.amount);
  if (confirmed) {
    // #496: after an after-sales operation, surface confirmedPrice before vs
    // after so a certifier can eyeball the OSDM identity "confirmedPrice =
    // confirmed parts − confirmed refund amounts". Logged, NOT asserted, until
    // OTST confirms the expected provider behaviour — SBB INT still showed the
    // pre-refund amount after REFUNDED.
    const _prevConfirmedAmount = bru.getEnvVar("confirmedPriceAmount");
    if (_expectsConfirmed && /REFUNDED|EXCHANGED/i.test(_stageLabel) &&
        _prevConfirmedAmount !== undefined && _prevConfirmedAmount !== null && _prevConfirmedAmount !== '') {
      validationLogger(
        `[INFO] confirmedPrice at stage ${_stageLabel}: ${confirmed.amount} ${confirmed.currency} (scale ${confirmed.scale}) — ` +
        `was ${_prevConfirmedAmount} before the after-sales operation. OSDM defines confirmedPrice as the sum of ` +
        `confirmed parts minus all confirmed refund amounts; not asserted (see #496).`
      );
    }
    if (!_expectsConfirmed && confirmed.amount === 0 && prov && prov.amount > 0) {
      validationLogger(
        `[WARNING] confirmedPrice.amount is 0 while provisionalPrice.amount is ${prov.amount} ` +
        `at pre-confirmation stage — possible provider anomaly. confirmedPriceAmount NOT stored ` +
        `to avoid corrupting downstream refund/exchange calculations.`
      );
    } else {
      bru.setEnvVar("confirmedPriceAmount", confirmed.amount);
    }
  }

  // B4: Both prices must use the same currency (OSDM: currency must be consistent within a booking)
  if (prov?.currency && confirmed?.currency) {
    test(`provisionalPrice.currency matches confirmedPrice.currency (OSDM: currency consistency)`, () => {
      expect(confirmed.currency).to.eql(prov.currency,
        `Currency mismatch: provisional=${prov.currency}, confirmed=${confirmed.currency}`);
      validationLogger(`[DEBUG] Currency consistent across prices: ${prov.currency}`);
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

  const requestName = (typeof req !== "undefined" && req?.getName?.()) || "";
  if (requestName === "02. POST Create Booking" || requestName === "05. GET Booking before Fulfillments") {
    checkProvisionalPrice(prov, mini, booking);
  }

  // Validate booked offer parts
  const bookedOffers = booking.bookedOffers || [];
  validateOfferParts(selectedOffer.admissionOfferParts   || [], bookedOffers.flatMap(b => b.admissions   || []), "admission",   expectedBookedOffersStatus);
  validateOfferParts(selectedOffer.reservationOfferParts || [], bookedOffers.flatMap(b => b.reservations || []), "reservation", expectedBookedOffersStatus);
  validateOfferParts(selectedOffer.ancillaryOfferParts   || [], bookedOffers.flatMap(b => b.ancillaries  || []), "ancillary",   expectedBookedOffersStatus);

  // #239: the reservation↔booked-reservation correspondence just checked above
  // by validateOfferParts is the same check regardless of HOW the reservation
  // was requested (placeSelections vs optionalReservationSelections) — note
  // which mechanism this scenario used, for report traceability.
  if (bru.getEnvVar("bookMandatoryReservations") === "true") {
    validationLogger(`[INFO] Reservation booked via optionalReservationSelections (issue #239) — ${bookedOffers.flatMap(b => b.reservations || []).length} reservation(s) in the booking response.`);
  }

  // #377: close the accommodation loop ONCE, on the create-booking step —
  // re-reads (05/07) would only duplicate the goal rows in the report.
  if ((req?.getName?.() ?? "") === "02. POST Create Booking") {
    validateAccommodationGoal(selectedOffer, bookedOffers);
  }

  // #253: pass the sibling Booking.fulfillmentDocuments[] (v3.8) so each
  // fulfillment.fulfillmentDocumentRef can be checked against its sibling id.
  validateFulfillments(booking.fulfillments || [], 0, expectedFulfillmentStatus, requireFulfillments, booking.fulfillmentDocuments);
  // #613 F2: the booking's own fulfillment list, kept apart from fulfillmentIds
  // (which validateFulfillments rewrites when it checks a refund offer's subset).
  if (Array.isArray(booking.fulfillments) && booking.fulfillments.length > 0) {
    bru.setEnvVar("__bookingFulfillmentIds", JSON.stringify(booking.fulfillments.map((f) => f?.id).filter(Boolean)));
  }

  // Check that booking has the same number of passengers as expected from the offer
  const expectedPassengerCount = Number(bru.getEnvVar("passengerCount") || 0);
  const actualPassengerCount = (booking.passengers || []).length;
  test(`Booking contains exactly the expected number of passengers - expected: ${expectedPassengerCount}, actual: ${actualPassengerCount}`, () => {
    validationLogger(`[DEBUG] Booking passenger count - expected: ${expectedPassengerCount}, actual: ${actualPassengerCount}`);
    if (expectedPassengerCount > 0) {
      expect(actualPassengerCount).to.eql(expectedPassengerCount,
        `Expected exactly ${expectedPassengerCount} passengers, got ${actualPassengerCount}`);
    } else {
      expect(actualPassengerCount).to.be.above(0);
    }
  });

  // C2: fulfillmentStatus (new in OSDM 3.8, optional) is a FulfillmentSummaryStatus:
  // an x-extensible-enum PENDING / CREATED / COMPLETE (spec 3.8, FulfillmentSummaryStatus).
  // #613 F3: the list used to be UNISSUED/ISSUED/…, which is not the 3.8 one and
  // failed every provider sending the 3.8 values. Extensible: FAIL only when the
  // value is not text, WARNING when it is outside the listed values.
  // #337: null and undefined both mean "absent".
  checkFulfillmentSummaryStatus(booking);
}

// #613 F7: provisionalPrice is "the price of all unconfirmed pre-booked parts
// in the booking" (OSDM Booking.provisionalPrice). It used to be required to
// EQUAL the offer's minimalPrice, which is false as soon as a reservation or an
// ancillary is added, or a return books two offers. What holds instead: it is
// not below the minimal price of the selected offer (same currency and scale),
// and it matches the sum of the pre-booked parts, unless fees explain the
// difference (logged, not failed). The values are read inside the check, so a
// missing member fails the check instead of throwing in the title.
function checkProvisionalPrice(prov, mini, booking) {
  test(`provisionalPrice is not below the offer's minimalPrice - provisional: ${prov?.amount} ${prov?.currency}, minimal: ${mini?.amount} ${mini?.currency}`, () => {
    expect(prov, 'provisionalPrice missing').to.exist;
    if (!mini) {
      validationLogger(`[INFO] The selected offer has no offerSummary.minimalPrice (optional): only provisionalPrice's presence is checked.`);
      return;
    }
    expect(prov.currency, 'provisionalPrice and minimalPrice differ in currency').to.eql(mini.currency);
    const ps = prov.scale == null ? 2 : prov.scale;
    const ms = mini.scale == null ? 2 : mini.scale;
    expect(ps, 'provisionalPrice and minimalPrice differ in scale').to.eql(ms);
    expect(prov.amount, 'provisionalPrice is below the minimal price of the offer').to.be.at.least(mini.amount);
  });
  if (!prov || typeof prov.amount !== 'number') return;
  const parts = (booking.bookedOffers || []).flatMap((bo) => [
    ...(bo.admissions || []), ...(bo.reservations || []), ...(bo.ancillaries || []),
  ]).filter((p) => p?.status === 'PREBOOKED');
  const priced = parts.filter((p) => p.price && typeof p.price.amount === 'number' && p.price.currency === prov.currency);
  if (parts.length > 0 && priced.length === parts.length) {
    const sum = priced.reduce((acc, p) => acc + p.price.amount, 0);
    if (sum !== prov.amount) {
      validationLogger(`[WARNING] provisionalPrice ${prov.amount} ${prov.currency} differs from the sum of the pre-booked parts (${sum}): OSDM defines it as the price of all unconfirmed pre-booked parts. Booking fees, if any, would explain the difference.`);
    } else {
      validationLogger(`[DEBUG] provisionalPrice ${prov.amount} = sum of the ${parts.length} pre-booked part(s)`);
    }
  }
}

const FULFILLMENT_SUMMARY_STATUSES = ['PENDING', 'CREATED', 'COMPLETE'];
function checkFulfillmentSummaryStatus(booking) {
  if (booking.fulfillmentStatus != null) {
    checkExtensibleCode({ test, expect, log: validationLogger },
      'booking.fulfillmentStatus', booking.fulfillmentStatus, FULFILLMENT_SUMMARY_STATUSES, 'FulfillmentSummaryStatus');
  } else {
    validationLogger(`[DEBUG] booking.fulfillmentStatus absent (null or undefined; optional in OSDM v3.8) → test skipped`);
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
    validationLogger("[DEBUG] No fulfillments available in the response, continue execution");
    return;
  }

  const fulfillmentIds   = [];
  const _bookedPartIdsRaw = bru.getEnvVar("admissionReservationAncillaryBookingPartsIds");
  const bookedPartIds    = Array.isArray(_bookedPartIdsRaw) ? _bookedPartIdsRaw : JSON.parse(_bookedPartIdsRaw || "[]");

  test(`Fulfillments exist at index ${index}`, () => {
    validationLogger(`[DEBUG] Number of fulfillments: ${fulfillments.length}`);
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
      expect(fulfillment.id).to.be.a('string').and.not.be.empty;
      validationLogger(`[DEBUG] Fulfillment[${idx}] id exists: ${fulfillment.id}`);
    });
    bru.setEnvVar("fulfillmentIds", fulfillmentIds);

    test(`Fulfillment[${idx}] bookingRef exists`, () => {
      validationLogger(`[DEBUG] Fulfillment[${idx}] bookingRef exists: ${fulfillment.bookingRef}`);
      expect(fulfillment.bookingRef).to.be.a("string").and.not.be.empty;
    });

    // D3: bookingRef must match the current bookingId (OSDM: Fulfillment.bookingRef required)
    const _currentBookingId = bru.getEnvVar("bookingId");
    if (_currentBookingId && fulfillment.bookingRef) {
      test(`Fulfillment[${idx}].bookingRef matches current bookingId (expected: ${_currentBookingId}, actual: ${fulfillment.bookingRef})`, () => {
        expect(fulfillment.bookingRef).to.eql(_currentBookingId,
          `bookingRef '${fulfillment.bookingRef}' does not match bookingId '${_currentBookingId}'`);
        validationLogger(`[DEBUG] Fulfillment[${idx}].bookingRef matches bookingId ✓`);
      });
    }

    // D4: createdOn must always be a valid ISO datetime (OSDM: Fulfillment.createdOn required)
    const createdOnDate = new Date(fulfillment.createdOn);
    if (!isNaN(createdOnDate.getTime())) {
      test(`Fulfillment[${idx}] createdOn is a valid datetime at or before now`, () => {
        expect(fulfillment.createdOn).to.be.a("string").and.not.be.empty;
        expect(createdOnDate.getTime()).to.be.at.most(Date.now());
        validationLogger(`[DEBUG] Fulfillment[${idx}] createdOn: ${fulfillment.createdOn}`);
      });
    } else {
      validationLogger(`[WARNING] Fulfillment[${idx}] createdOn has invalid date format: ${fulfillment.createdOn}`);
    }

    test(`Fulfillment[${idx}] status comparison - expected: ${expectedFulfillmentStatus}, actual: ${fulfillment.status}`, () => {
      validationLogger(`[DEBUG] Fulfillment[${idx}] status comparison - expected: ${expectedFulfillmentStatus}, actual: ${fulfillment.status}`);
      if (Array.isArray(expectedFulfillmentStatus)) {
        expect(expectedFulfillmentStatus).to.include(fulfillment.status);
      } else {
        expect(fulfillment.status).to.eql(expectedFulfillmentStatus);
      }
    });

    // D1: status must be an OSDM FulfillmentStatus. This one is a closed enum,
    // identical in 3.5 and 3.8 (#613 F3: CHECKEDIN was missing; USED,
    // PARTIALLY_USED and RESERVED are not OSDM values and were accepted).
    const _validFulfillmentStatuses = ['AVAILABLE', 'ON_HOLD', 'CONFIRMED', 'FULFILLED', 'CHECKEDIN',
      'CANCELLED', 'RELEASED', 'REFUNDED', 'EXCHANGED', 'EXPIRED'];
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
      validationLogger(`[DEBUG] Fulfillment[${idx}] controlNumber is absent (expected for CONFIRMED without document issuance yet)`);
    }

    // #613 F8: bookingParts is optional in the schema, so the title must not
    // assume it (a missing member used to throw here and abort the whole step).
    // In a sale the fulfillment is made from booking parts, and the spec says
    // the member "must be provided" then: its absence fails this check.
    const _fulfillmentPartIds = Array.isArray(fulfillment.bookingParts)
      ? fulfillment.bookingParts.map(bp => bp?.id) : '(no bookingParts)';
    test(`Fulfillment[${idx}] bookingParts.id exist in admissionReservationAncillaryBookingPartsIds - expected: [${bookedPartIds}], actual: [${_fulfillmentPartIds}]`, () => {
      expect(fulfillment.bookingParts, 'bookingParts must be provided for a fulfillment made from booking parts').to.be.an("array").that.is.not.empty;
      fulfillment.bookingParts.forEach(part => {
        validationLogger(`[DEBUG] Fulfillment[${idx}] bookingPart.id: ${part.id} exists in admissionReservationAncillaryBookingPartsIds`);
        expect(bookedPartIds).to.include(part.id);
      });
    });

    if (Array.isArray(fulfillment.fulfillmentDocuments) && fulfillment.fulfillmentDocuments.length > 0) {
      test(`Fulfillment[${idx}] documents exist and contain valid data`, () => {
        expect(fulfillment.fulfillmentDocuments).to.be.an("array").that.is.not.empty;
        validationLogger(`[DEBUG] Fulfillment[${idx}] number of documents: ${fulfillment.fulfillmentDocuments.length}`);
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
            validationLogger(`[DEBUG] Fulfillment[${idx}].document[${docIndex}] -> medium=${doc.medium}, type=${doc.type}, format=${doc.format}; payload via ${_channel} [${_std}]`);

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
        validationLogger(`[DEBUG] Fulfillment[${idx}] has ${fulfillment.fulfillmentDocumentRefs.length} fulfillmentDocumentRef(s)`);
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
          validationLogger(`[DEBUG] Fulfillment[${idx}] all ${fulfillment.fulfillmentDocumentRefs.length} ref(s) resolve to sibling fulfillmentDocuments[].id (v3.8 integrity OK)`);
        }
      } else if (Array.isArray(siblingDocs)) {
        // Case (b): sibling array present but empty — legal pre-issuance shape.
        validationLogger(`[DEBUG] Fulfillment[${idx}] sibling fulfillmentDocuments[] is present but empty — v3.8 ref→id cross-check skipped (legal pre-issuance shape: provider declared the v3.8 fulfillmentDocuments[] location but emitted no documents yet).`);
      } else {
        // Case (a): sibling array absent entirely — caller did not supply it.
        validationLogger(`[DEBUG] Fulfillment[${idx}] sibling fulfillmentDocuments[] not provided to validator — v3.8 ref→id cross-check skipped (caller did not supply it; expected for pre-v3.8 providers using the deprecated nested fulfillment.fulfillmentDocuments).`);
      }
    } else if (!_hasLegacyDocs) {
      validationLogger(`[DEBUG] Fulfillment[${idx}] has no document refs or documents (may be pre-issuance state)`);
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
