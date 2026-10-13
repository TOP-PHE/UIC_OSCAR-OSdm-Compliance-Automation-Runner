/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * passengerAges.js — passengers on the edges of the age ranges (#705).
 *
 * A passenger may give its age on the day of travel instead of a fixed date
 * of birth: `bornYearsBeforeTravel` (whole years) and `bornDaysAfter` (days
 * added to that date: 1 = the birthday is tomorrow, so the passenger is one
 * year younger than `bornYearsBeforeTravel` for one more day). The date of
 * birth is then worked out from the departure day, each run.
 *
 * With `expectedPassengerType`, the chosen offer must price the passenger as
 * that type: an admission of the passenger names it in
 * `appliedPassengerTypes`. OSDM does not require that member, so none given
 * is a WARNING, as is the generic type PERSON alone (#709); another type is a
 * failure. A child or youth that does not pay
 * less than an adult is a WARNING (a commercial choice, not an OSDM rule).
 */

require('./displays.js');

const DAY_MS = 86400000;
const listOf = (value) => (Array.isArray(value) ? value : []);
const GENERIC_TYPE = 'PERSON';
const YOUNGER = new Set(['YOUNG_CHILD', 'CHILD', 'FAMILY_CHILD', 'PRM_CHILD', 'YOUTH']);

/**
 * The date of birth (YYYY-MM-DD) of a passenger who is `years` old on
 * `travelDay`, moved by `daysAfter` days; null when `years` is not given.
 * A 29 February that the year of birth does not have becomes the 28th.
 */
function birthDateFor(passenger, travelDay) {
  const years = passenger?.bornYearsBeforeTravel;
  if (!Number.isInteger(years) || years < 0 || years > 120) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(travelDay || ''));
  if (!day) return null;
  const month = Number(day[2]) - 1;
  let born = Date.UTC(Number(day[1]) - years, month, Number(day[3]));
  if (new Date(born).getUTCMonth() !== month) born -= DAY_MS;
  const after = passenger.bornDaysAfter;
  if (Number.isInteger(after) && Math.abs(after) <= 366) born += after * DAY_MS;
  return new Date(born).toISOString().slice(0, 10);
}

/** The passengers that name the type they must be priced as: [{ ref, type }]. */
function expectedTypesOf(passengers) {
  return listOf(passengers)
    .filter((p) => p && typeof p.reference === 'string' && typeof p.expectedPassengerType === 'string' && p.expectedPassengerType !== '')
    .map((p) => ({ ref: p.reference, type: p.expectedPassengerType }));
}

const admissionsOf = (offer) => listOf(offer?.admissionOfferParts);
const appliedTypes = (offer, ref) => [...new Set(admissionsOf(offer)
  .filter((p) => listOf(p.passengerRefs).includes(ref))
  .flatMap((p) => listOf(p.appliedPassengerTypes))
  .filter((t) => t?.passengerRef === ref)
  .map((t) => t.type)
  .filter((t) => typeof t === 'string'))];

/**
 * One check per passenger with an expected type: `level` 'fail' when it is
 * graded, 'warn' when the offer names no applied type for the passenger.
 * @returns {Array<{name: string, ok: boolean, level: 'fail'|'warn', message?: string}>}
 */
function checkAppliedTypes(offer, expected, label = 'Offer') {
  return listOf(expected).map(({ ref, type }) => {
    const given = appliedTypes(offer, ref);
    // #709: PERSON is the generic type; it says nothing of the age band.
    const named = given.filter((t) => t !== GENERIC_TYPE || type === GENERIC_TYPE);
    if (named.length === 0) {
      const why = given.length > 0
        ? `the admissions of passenger ${ref} name only ${GENERIC_TYPE} in appliedPassengerTypes, which states no age band`
        : `no admission of passenger ${ref} gives appliedPassengerTypes`;
      return {
        name: `${label}: passenger ${ref} is priced as ${type}`,
        ok: false,
        level: 'warn',
        message: `${why}, so the type it was priced as cannot be checked (OSDM does not require it)`,
      };
    }
    const ok = named.includes(type);
    return {
      name: `${label}: passenger ${ref} is priced as ${type} — applied: ${named.join(', ')}`,
      ok,
      level: 'fail',
      message: ok ? undefined : `passenger ${ref} is priced as ${named.join(', ')}, not ${type}`,
    };
  });
}

// What a passenger pays in an offer: its single-passenger admissions, or null.
function priceOf(offer, ref) {
  const parts = admissionsOf(offer).filter((p) => listOf(p.passengerRefs).length === 1 && p.passengerRefs[0] === ref);
  if (parts.length === 0 || parts.some((p) => typeof p?.price?.amount !== 'number')) return null;
  return parts.reduce((sum, p) => sum + p.price.amount, 0);
}

/**
 * Each younger passenger (child, youth) against the first adult: paying less
 * is expected, not paying less is a warning.
 * @returns {Array<{text: string, ok: boolean}>}
 */
function compareWithAdult(offer, expected) {
  const adult = listOf(expected).find((e) => e.type === 'ADULT');
  const adultPrice = adult ? priceOf(offer, adult.ref) : null;
  if (adultPrice === null) return [];
  return listOf(expected).filter((e) => YOUNGER.has(e.type)).map(({ ref, type }) => {
    const price = priceOf(offer, ref);
    if (price === null) return { text: `passenger ${ref} (${type}) has no admission of its own with a price; not compared with the adult`, ok: false };
    const ok = price < adultPrice;
    return { text: `passenger ${ref} (${type}) pays ${price}, the adult ${adult.ref} ${adultPrice}${ok ? '' : ': not less (a commercial choice, not an OSDM rule)'}`, ok };
  });
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

function fromEnv(name) {
  const value = bru.getEnvVar(name);
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Step 01, once the offer is chosen: the passenger types applied, and the prices by age. */
function checkOfferAges() {
  const expected = listOf(fromEnv('__expectedPassengerTypes'));
  if (expected.length === 0) return;
  const offer = fromEnv('offer');
  checkAppliedTypes(offer, expected).forEach((c) => {
    if (c.level === 'warn') {
      validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      return;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
  compareWithAdult(offer, expected).forEach((c) => {
    validationLogger(`[${c.ok ? 'INFO' : 'WARNING'}] Prices by age: ${c.text}.`);
  });
}

module.exports = { birthDateFor, expectedTypesOf, checkAppliedTypes, compareWithAdult, checkOfferAges };
