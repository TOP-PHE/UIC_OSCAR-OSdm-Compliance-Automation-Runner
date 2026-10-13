// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #705: prices by age. A trip from the profile's `ageTariffs.from` stop place
// prices each passenger with a date of birth by its age on the day of travel:
// the first band whose `maxAge` it does not pass gives the passenger type and
// the share of the full price; older passengers are adults at the full price.
// Each such admission names the type in `appliedPassengerTypes`. Only that
// stop place, so that the other scenarios keep their prices.

const localDay = (trip) => trip.startTime.slice(0, 10);

// The age of a passenger on a day (YYYY-MM-DD), or null without a date of birth.
function ageOn(dateOfBirth, day) {
  if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = day.split('-').map(Number);
  const beforeBirthday = tm < m || (tm === m && td < d);
  return ty - y - (beforeBirthday ? 1 : 0);
}

/** The band of a passenger on a trip: { type, percent, age }, or null when age tariffs do not apply. */
function bandOf(passenger, trip, provider) {
  const tariffs = provider.ageTariffs;
  if (!tariffs || trip.origin?.stopPlaceRef !== tariffs.from) return null;
  const age = ageOn(passenger?.dateOfBirth, localDay(trip));
  if (age === null) return null;
  const band = tariffs.bands.find((b) => age <= b.maxAge);
  return band ? { type: band.type, percent: band.percent, age } : { type: 'ADULT', percent: 100, age };
}

/**
 * An admission of one passenger, priced by age: its amount is the band's
 * share, and it names the passenger type applied. Unchanged when age tariffs
 * do not apply.
 */
function priced(admission, trip, provider) {
  const [passenger] = admission.passengers;
  const band = admission.passengers.length === 1 ? bandOf(passenger, trip, provider) : null;
  if (!band) return admission;
  const named = admission.applied?.appliedPassengerTypes?.[0];
  const card = named ? ` (${named.description})` : '';
  const applied = {
    ...named,
    passengerRef: passenger.externalRef,
    type: band.type,
    description: `${band.type}, aged ${band.age} on the day of travel${card}`,
  };
  return {
    ...admission,
    amount: Math.round(admission.amount * band.percent / 100),
    applied: { appliedPassengerTypes: [applied] },
  };
}

module.exports = { ageOn, bandOf, priced };
