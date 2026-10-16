// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mandatoryReservation.js — how a mandatory reservation booked without a seat
 * choice is sent (#793). Pure.
 *
 * One provider requires a placeSelection naming its trip and leg ("Mandatory
 * reservation(s) not covered by any placeSelection"); another refuses such a
 * placeSelection, which asks nothing, and books the reservation with the
 * booking. OSDM settles neither, so the Test Framework declares it:
 * `mandatoryReservationForm` PLACE_SELECTION (default) or NONE. The run's copy
 * of the data file gives it to each scenario naming none; the collection
 * (`library-bruno/seatReservations.js`) applies it.
 */

const MANDATORY_FORMS = Object.freeze(['PLACE_SELECTION', 'NONE']);

const text = (v) => (typeof v === 'string' ? v.trim().toUpperCase() : '');

/** The framework's declared form, or null when it declares none (or no known one). */
function frameworkMandatoryForm(framework) {
  const form = text(framework?.mandatoryReservationForm);
  return MANDATORY_FORMS.includes(form) ? form : null;
}

/**
 * The run's copy: each scenario naming no form gets the framework's. Changes
 * `datafile`; returns how many scenarios got it.
 */
function withMandatoryReservationForm(datafile, framework) {
  const form = frameworkMandatoryForm(framework);
  if (!form || !Array.isArray(datafile?.scenarios)) return 0;
  let count = 0;
  for (const sc of datafile.scenarios) {
    if (sc && typeof sc === 'object' && !text(sc.mandatoryReservationForm)) {
      sc.mandatoryReservationForm = form;
      count += 1;
    }
  }
  return count;
}

module.exports = { MANDATORY_FORMS, frameworkMandatoryForm, withMandatoryReservationForm };
