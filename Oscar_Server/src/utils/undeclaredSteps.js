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
 * and one that narrows the first (#885), absent = every passenger:
 *   passengerUpdateScope: 'MAIN'  only the first (main) passenger can be updated
 *
 * A scenario that would still use one gets a warning (the collection's
 * [WARNING], via __featureNotDeclaredWarnings). The run's copy also turns the
 * passenger update off: a provider without that route answered 404 at step
 * 03 and every booking scenario stopped there. Likewise it updates the main
 * passenger only where that is all the provider takes: one provider answered
 * 400 BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE for the second passenger. A
 * late purchaser is the point of its scenario, so that one is only warned.
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

/** Does the framework say only the main passenger can be updated? */
const mainPassengerOnly = (framework) => framework?.passengerUpdate !== false
  && String(framework?.passengerUpdateScope || '').toUpperCase() === 'MAIN';

/** The scenario's own choice of passengers to update: 'ALL', 'MAIN' or null when it names none. */
function ownUpdateScope(scenario) {
  const scope = String(scenario?.passengerUpdateScope || '').toUpperCase();
  return scope === 'ALL' || scope === 'MAIN' ? scope : null;
}

/** The warnings (field names) of a scenario using a step the framework says is not offered. */
function undeclaredStepWarnings(scenario, framework) {
  const out = [];
  if (framework?.passengerUpdate === false && updatesPassengers(scenario)) out.push('passengerUpdate');
  if (mainPassengerOnly(framework) && updatesPassengers(scenario) && ownUpdateScope(scenario) === 'ALL') out.push('passengerUpdateScope');
  if (framework?.purchaserAfterBooking === false && purchaserAfterBooking(scenario)) out.push('purchaserAfterBooking');
  return out;
}

/**
 * The run's copy: a scenario that would update its passengers on a provider
 * declaring no passenger update does not; on one declaring the main passenger
 * only, it updates that one (#885). Changes `datafile`; returns how many
 * scenarios changed.
 */
function withoutUndeclaredPassengerUpdate(datafile, framework) {
  const none = framework?.passengerUpdate === false;
  const mainOnly = mainPassengerOnly(framework);
  if ((!none && !mainOnly) || !Array.isArray(datafile?.scenarios)) return 0;
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (!isObj(sc) || !updatesPassengers(sc)) continue;
    if (none) {
      sc.salesFlowActions = { ...(isObj(sc.salesFlowActions) ? sc.salesFlowActions : {}), patchPassengers: false };
      count += 1;
    } else if (ownUpdateScope(sc) !== 'MAIN') {
      sc.passengerUpdateScope = 'MAIN';
      count += 1;
    }
  }
  return count;
}

/**
 * #899: the run's copy of the invalid purchaser probe on a provider that takes
 * no purchaser after the booking. `invalid` books without one and probes
 * …/purchaser afterwards: such a provider refuses that booking, and nothing
 * is probed. It becomes `invalid_at_booking`: the wrong purchaser goes in the
 * booking itself. Changes `datafile`; returns how many scenarios changed.
 */
function withPurchaserProbeAtBooking(datafile, framework) {
  if (framework?.purchaserAfterBooking !== false || !Array.isArray(datafile?.scenarios)) return 0;
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (!isObj(sc) || typeof sc.bookingPurchaserMode !== 'string') continue;
    if (sc.bookingPurchaserMode.trim().toLowerCase() !== 'invalid') continue;
    sc.bookingPurchaserMode = 'invalid_at_booking';
    count += 1;
  }
  return count;
}

module.exports = {
  updatesPassengers, purchaserAfterBooking, mainPassengerOnly, undeclaredStepWarnings, withoutUndeclaredPassengerUpdate,
  withPurchaserProbeAtBooking,
};
