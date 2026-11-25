/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * nonTripFares.js — fares sold without a trip (#1449), a theoretical case.
 *
 * OSDM describes online fares as part of an offer for a trip (osdm.io,
 * Constructing products from fares). The OSDM architect's reading
 * (2026-11-25): fares are implicitly trip-related, but could theoretically
 * be sold without a trip, between stop places, in zones and in regions named
 * by NUTS codes; the distributor then links the trip of its product-based
 * sale to the provider's zones (nonTrip.zoneOf, nonTrip.js).
 *
 * A request without a trip that asks fare admissions has its fares checked
 * by fares.js (O1 to O20; O8 has no section to cover), then these, in the
 * same list, so they count for the sale's decision:
 *
 *   O21 a request without a trip gets no trip in the answer          FAIL
 *   O22 no fare offer covers a trip (tripCoverage absent)            FAIL
 *   O23 each fare's regional validity names what was asked           WARNING
 *
 * and the booking (02, 05, 07; fareBooking.js):
 *
 *   B7  nothing of a booking without a trip covers a trip            FAIL
 *
 * O23 is a WARNING, as for products sold without a trip: OSDM leaves the
 * reading of a validity open. A fare without validities is O4's, not O23's.
 * Pure but for isNonTripFareSale().
 */

const nonTrip = require('./nonTrip.js');

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

function check(id, level, title, broken, explain) {
  const items = list(broken);
  return { id, level, title, ok: items.length === 0, message: items.length ? `${explain}: ${nonTrip.firstFew(items)}` : '' };
}

const covers = (item) => item?.tripCoverage != null || item?.inboundTripCoverage != null;

/** O21 to O23: the checks of an answer to a request without a trip asking fares. */
function offerChecks(response, asked) {
  const offers = list(response?.offers).map((offer, i) => ({ offer, path: `offers[${i}]` })).filter(({ offer }) => list(offer.fares).length > 0);
  const trips = list(response?.trips);
  const fares = offers.flatMap(({ offer, path }) => list(offer.fares).map((fare, j) => ({ fare, path: `${path}.fares[${j}]` })));
  const elsewhere = fares.flatMap(({ fare, path }) => {
    const validities = list(fare.regionalConstraint?.regionalValidities);
    if (validities.length === 0) return [];
    const lack = nonTrip.validityMissing(validities, asked);
    if (lack === null) return [];
    return [lack ? `${path} (${lack})` : path];
  });
  return [
    check('O21', 'FAIL', 'A request without a trip gets no trip in the answer (trips)', trips.length ? [`${trips.length} trip(s)`] : [], 'trips in the answer'),
    check('O22', 'FAIL', 'No fare offer of a request without a trip covers a trip (tripCoverage absent)',
      offers.filter(({ offer }) => covers(offer)).map(({ offer, path }) => offer.offerId || path), 'fare offers covering a trip'),
    check('O23', 'WARNING', `Each fare's regional validity names ${nonTrip.validityWanted(asked)}`, elsewhere,
      'fares valid elsewhere than asked (OSDM leaves the reading of a validity open)'),
  ];
}

/** B7: nothing of a booking of fares without a trip covers a trip (booked offers, fulfilments). */
function bookingChecks(booking) {
  const covered = [
    ...list(booking?.bookedOffers).map((bo, i) => (covers(bo) ? `bookedOffers[${i}]` : null)),
    ...list(booking?.fulfillments).map((f, i) => (covers(f) ? `fulfillments[${i}]` : null)),
  ].filter(Boolean);
  return [check('B7', 'FAIL', 'Nothing of a booking without a trip covers a trip (tripCoverage absent)', covered, 'parts covering a trip')];
}

/** True when the scenario sells without a trip (its trip requirement is NON_TRIP). */
function isNonTripFareSale() {
  return nonTrip.isNonTripSale();
}

module.exports = { offerChecks, bookingChecks, isNonTripFareSale };
