// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * undeclaredSteps.js — steps a provider says it does not offer (#809). Pure.
 *
 * Two Test Framework settings, each absent = yes:
 *   passengerUpdate: false        no PATCH /bookings/{id}/passengers/{id}
 *   purchaserAfterBooking: false  no POST /bookings/{id}/purchaser after the booking
 *
 * A scenario that would still use one gets a warning (the collection's
 * [WARNING], via __featureNotDeclaredWarnings). The run's copy also turns the
 * passenger update off: a provider without that route answered 404 at step
 * 03 and every booking scenario stopped there. A late purchaser is the point
 * of its scenario, so that one is only warned.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Does the scenario update its passengers? Default on, as the collection reads it. */
function updatesPassengers(scenario) {
  const actions = isObj(scenario?.salesFlowActions) ? scenario.salesFlowActions : {};
  return Object.hasOwn(actions, 'patchPassengers') ? actions.patchPassengers === true : true;
}

/** Does the scenario write its purchaser after the booking? */
function purchaserAfterBooking(scenario) {
  return typeof scenario?.bookingPurchaserMode === 'string'
    && scenario.bookingPurchaserMode.trim().toLowerCase() === 'deferred';
}

/** The warnings (field names) of a scenario using a step the framework says is not offered. */
function undeclaredStepWarnings(scenario, framework) {
  const out = [];
  if (framework?.passengerUpdate === false && updatesPassengers(scenario)) out.push('passengerUpdate');
  if (framework?.purchaserAfterBooking === false && purchaserAfterBooking(scenario)) out.push('purchaserAfterBooking');
  return out;
}

/**
 * The run's copy: a scenario that would update its passengers on a provider
 * declaring no passenger update does not. Changes `datafile`; returns how
 * many scenarios changed.
 */
function withoutUndeclaredPassengerUpdate(datafile, framework) {
  if (framework?.passengerUpdate !== false || !Array.isArray(datafile?.scenarios)) return 0;
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (!isObj(sc) || !updatesPassengers(sc)) continue;
    sc.salesFlowActions = { ...(isObj(sc.salesFlowActions) ? sc.salesFlowActions : {}), patchPassengers: false };
    count += 1;
  }
  return count;
}

module.exports = { updatesPassengers, purchaserAfterBooking, undeclaredStepWarnings, withoutUndeclaredPassengerUpdate };
