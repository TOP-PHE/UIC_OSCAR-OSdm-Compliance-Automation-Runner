/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * placeSelection.js — how a place is chosen (#766).
 *
 * OSDM 3.8 names five ways a retailer may choose a place, its
 * PlaceSelectionFlow: an automatic selection by accommodation and place
 * properties, the same after asking the available preferences, a place next
 * to a given one, and a named place with or without a seat fee. An offer's
 * reservation parts list the flows they take (`supportedPlaceSelectionFlows`)
 * and the preferences they offer (`availablePlacePreferences`), both
 * optional.
 *
 * A scenario exercises one flow: its own `placeSelectionFlow`, else the one
 * its place fields send (flowOfScenario, alike with frameworkGating.js
 * placeSelectionFlowOf on the server, pinned by a test). At the offer step,
 * a flow the offer does not list is a warning: the place choice is then not
 * tested, and the sale goes on.
 *
 * Seat preferences (#766 PR 2): a scenario's `placePreferences` (PlaceProperty
 * codes, e.g. WINDOW) are asked for in the booking, in
 * `placeSelections[].accommodations[].placeProperties`. Only those the offer
 * lists are sent; one it does not list is a warning (the customer is told it
 * cannot be had). In the PREFERENCES flow, GET /availabilities/preferences is
 * asked first, and a preference it no longer gives is a warning and is not
 * sent. A booked place without a preference asked is a warning: OSDM says a
 * preference is honoured if possible.
 *
 * Pure module: no Bruno globals. Unit-tested in
 * Oscar_Server/tests/unit/bruno-place-selection.test.js.
 */

const FLOWS = [
  'AUTOMATIC_PLACE_SELECTION',
  'AUTOMATIC_PLACE_SELECTION_PREFERENCES',
  'AUTOMATIC_PLACE_SELECTION_NEARBY',
  'MANUAL_PLACE_SELECTION_WITHOUT_FEE',
  'MANUAL_PLACE_SELECTION_WITH_FEE',
];
const FLOW_TEXT = Object.freeze({
  AUTOMATIC_PLACE_SELECTION: 'by accommodation and place properties',
  AUTOMATIC_PLACE_SELECTION_PREFERENCES: 'by the available preferences',
  AUTOMATIC_PLACE_SELECTION_NEARBY: 'next to a given place',
  MANUAL_PLACE_SELECTION_WITHOUT_FEE: 'of a named place, without fee',
  MANUAL_PLACE_SELECTION_WITH_FEE: 'of a named place, with a fee',
});

const listOf = (value) => (Array.isArray(value) ? value : []);
const upper = (value) => String(value ?? '').trim().toUpperCase();
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const unique = (values) => [...new Set(values)];

/**
 * A reservation part's AvailablePlacePreferences: a list in OSDM 3.8; a
 * single object is read too.
 */
function preferenceSetsOf(part) {
  const value = part?.availablePlacePreferences;
  if (Array.isArray(value)) return value.filter((v) => v && typeof v === 'object');
  return value && typeof value === 'object' ? [value] : [];
}

/**
 * The scenario's seat preferences: PlaceProperty codes, each once. A list, or
 * text as Test Config stores it ("WINDOW, POWER").
 */
function preferencesOfScenario(scenario) {
  const value = scenario?.placePreferences;
  const codes = typeof value === 'string' ? value.split(/[\s,;]+/) : listOf(value);
  return unique(codes.filter(isText).map(upper));
}

/**
 * The flow a scenario exercises, or null when it chooses no place: its own
 * `placeSelectionFlow`, else a seat from the seat map (placeSelectionMode) is
 * a named place, and a couchette or berth (accommodationSelection), a
 * reservation booked by placeSelections (reservationBookingForm
 * PLACE_SELECTION) or seat preferences (placePreferences) an automatic
 * selection.
 */
function flowOfScenario(scenario) {
  if (!scenario || typeof scenario !== 'object') return null;
  const own = upper(scenario.placeSelectionFlow);
  if (FLOWS.includes(own)) return own;
  const mode = upper(scenario.placeSelectionMode);
  if (mode === 'SEATMAP_AT_OFFER' || mode === 'ADD_TO_BOOKING') return 'MANUAL_PLACE_SELECTION_WITHOUT_FEE';
  const accommodation = upper(scenario.accommodationSelection);
  if (accommodation === 'COUCHETTE' || accommodation === 'BERTH') return 'AUTOMATIC_PLACE_SELECTION';
  if (upper(scenario.reservationBookingForm) === 'PLACE_SELECTION') return 'AUTOMATIC_PLACE_SELECTION';
  if (preferencesOfScenario(scenario).length > 0) return 'AUTOMATIC_PLACE_SELECTION';
  return null;
}

/** The flows the offer's reservation parts list, each once, in order. */
function flowsOffered(offer) {
  const flows = listOf(offer?.reservationOfferParts).flatMap((part) => listOf(part?.supportedPlaceSelectionFlows));
  return [...new Set(flows.filter(isText).map(upper))];
}

/** The preferences the offer's reservation parts offer: { group: [preference, ...] }. */
function preferencesOffered(offer) {
  const groups = {};
  for (const part of listOf(offer?.reservationOfferParts)) {
    for (const group of preferenceSetsOf(part).flatMap((set) => listOf(set.preferenceGroups))) {
      if (!isText(group?.preferenceGroup)) continue;
      const key = group.preferenceGroup;
      groups[key] = [...new Set([...(groups[key] || []), ...listOf(group.preferences).filter(isText)])];
    }
  }
  return groups;
}

/**
 * What the offer says of the scenario's flow, as log lines:
 * `{ level: 'INFO'|'WARNING', text }`. A flow the offer does not list, or an
 * offer with no reservation part, is a warning; an offer that names no flow
 * at all is information (the member is optional).
 */
function describeOfferedFlow(offer, flow) {
  if (!flow) return [];
  const label = `Place selection ${FLOW_TEXT[flow] || flow} (${flow})`;
  const parts = listOf(offer?.reservationOfferParts);
  if (parts.length === 0) {
    return [{ level: 'WARNING', text: `${label}: the offer chosen has no reservation part; the place choice is not tested.` }];
  }
  const lines = [];
  const offered = flowsOffered(offer);
  if (offered.length === 0) {
    lines.push({ level: 'INFO', text: `${label}: the offer's reservation parts name no place selection flow (supportedPlaceSelectionFlows is optional).` });
  } else if (offered.includes(flow)) {
    lines.push({ level: 'INFO', text: `${label}: the offer lists it (${offered.join(', ')}).` });
  } else {
    lines.push({ level: 'WARNING', text: `${label}: the offer does not list it (it lists ${offered.join(', ')}); the place choice may be refused or ignored.` });
  }
  const preferences = Object.entries(preferencesOffered(offer)).map(([group, prefs]) => `${group}: ${prefs.join(', ') || '-'}`);
  if (preferences.length > 0) lines.push({ level: 'INFO', text: `Place preferences offered — ${preferences.join('; ')}` });
  return lines;
}

/**
 * The place properties a reservation part offers: those of its preference
 * groups and of its available places, upper case, each once.
 */
function propertiesOfPart(part) {
  const fromGroups = preferenceSetsOf(part).flatMap((set) => listOf(set.preferenceGroups)).flatMap((g) => listOf(g?.preferences));
  const fromPlaces = listOf(part?.availablePlaces).flatMap((p) => listOf(p?.placeProperties));
  return unique([...fromGroups, ...fromPlaces].filter(isText).map(upper));
}

/**
 * Which of the scenario's seat preferences go into the booking, from the
 * offer chosen: `{ send, notOffered, lines }`. Those the offer lists are sent,
 * the others are a warning each. An offer that lists none at all says nothing
 * either way: every preference is sent, and the booking shows what was given.
 * No reservation part: nothing is sent (the flow's own warning says so).
 */
function choosePreferences(offer, wanted) {
  const asked = unique(listOf(wanted).filter(isText).map(upper));
  if (asked.length === 0) return { send: [], notOffered: [], listed: false, lines: [] };
  const parts = listOf(offer?.reservationOfferParts);
  if (parts.length === 0) {
    return { send: [], notOffered: [], listed: false, lines: [{ level: 'WARNING', text: `Seat preferences ${asked.join(', ')}: the offer chosen has no reservation part, so none is asked.` }] };
  }
  const offered = unique(parts.flatMap(propertiesOfPart));
  if (offered.length === 0) {
    return { send: asked, notOffered: [], listed: false, lines: [{ level: 'INFO', text: `Seat preferences ${asked.join(', ')}: the offer lists no place preference (availablePlacePreferences and availablePlaces are optional); all are asked, and the booking shows what is given.` }] };
  }
  const send = asked.filter((code) => offered.includes(code));
  const notOffered = asked.filter((code) => !offered.includes(code));
  const lines = [];
  if (send.length > 0) lines.push({ level: 'INFO', text: `Seat preferences asked in the booking: ${send.join(', ')} (the offer lists ${offered.join(', ')}).` });
  for (const code of notOffered) {
    lines.push({ level: 'WARNING', text: `Seat preference ${code}: the offer does not list it (it lists ${offered.join(', ')}); it is not asked, and the customer cannot have it.` });
  }
  return { send, notOffered, listed: true, lines };
}

/**
 * Whether a refused booking that asked for seat preferences is sent once
 * more without them (#766 PR 3): any error answer but 401 and 403 (the
 * token, not the request), the first time only. The second answer tells a
 * refused preference from a refused reservation.
 */
function retryWithoutPreferences(status, sent, alreadyRetried) {
  if (alreadyRetried || listOf(sent).length === 0) return false;
  return typeof status === 'number' && status >= 400 && status !== 401 && status !== 403;
}

/**
 * What the answer to the booking sent again without preferences says:
 * `{ level, text, fail }`. Accepted: the preferences were what the provider
 * refused, a failure when the offer listed them, else a warning. Refused
 * again: the reservation itself is refused, which the status check fails.
 * @param {number} status   the second answer's status
 * @param {object} refused  { status, code, preferences, listed } of the first
 */
function afterRetryWithoutPreferences(status, refused) {
  const what = `Seat preferences ${listOf(refused?.preferences).join(', ')}`;
  const first = refused?.code ? `HTTP ${refused?.status}, ${refused.code}` : `HTTP ${refused?.status}`;
  if (typeof status === 'number' && status >= 200 && status < 300) {
    return refused?.listed
      ? { level: 'FAIL', fail: true, text: `${what}: the booking asking for them was refused (${first}), and accepted without them, though the offer lists them.` }
      : { level: 'WARNING', fail: false, text: `${what}: the booking asking for them was refused (${first}), and accepted without them; the offer did not list them, so the provider may not take them.` };
  }
  return { level: 'INFO', fail: false, text: `${what}: the booking was refused with them (${first}) and without them (HTTP ${status}): the reservation itself is refused, not the preference.` };
}

/** The accommodation a seat preference is sent with: the part's first seat entry, else its first, else SEAT / ANY_SEAT. */
function accommodationOfPart(part) {
  const places = listOf(part?.availablePlaces).filter((p) => isText(p?.accommodationType));
  const place = places.find((p) => upper(p.accommodationType) === 'SEAT') || places[0];
  return place
    ? { accommodationType: place.accommodationType, accommodationSubType: isText(place.accommodationSubType) ? place.accommodationSubType : 'ANY_SEAT' }
    : { accommodationType: 'SEAT', accommodationSubType: 'ANY_SEAT' };
}

// The passengers a seat preference is asked for: the part's own that the
// booking knows, else all the part's, else the booking's when it names none.
function passengersOfPart(part, passengerRefs) {
  const refs = listOf(part?.passengerRefs).filter(isText);
  if (refs.length === 0) return listOf(passengerRefs);
  const known = refs.filter((r) => passengerRefs.includes(r));
  return known.length > 0 ? known : refs;
}

/**
 * The placeSelections with the seat preferences: a selection that has
 * accommodations gets the preferences added to each; one that has none gets
 * one SelectedAccommodation for the passengers of its reservation part (those
 * of the booking when the part names none). A selection naming no part of
 * the offer is left as it is.
 * @param {object[]} selections    the booking's placeSelections
 * @param {object}   offer         the offer chosen
 * @param {string[]} send          the preferences to ask (choosePreferences)
 * @param {string[]} passengerRefs the booking's passenger references
 */
function withPreferences(selections, offer, send, passengerRefs = []) {
  const codes = listOf(send).filter(isText);
  if (codes.length === 0) return listOf(selections);
  const parts = listOf(offer?.reservationOfferParts);
  return listOf(selections).map((selection) => {
    const part = parts.find((p) => p?.id === selection?.reservationId);
    if (!part) return selection;
    const accommodations = listOf(selection.accommodations);
    if (accommodations.length > 0) {
      return { ...selection, accommodations: accommodations.map((a) => ({ ...a, placeProperties: unique([...listOf(a?.placeProperties), ...codes]) })) };
    }
    const own = passengersOfPart(part, passengerRefs);
    if (own.length === 0) return selection;
    return { ...selection, accommodations: [{ passengerRefs: own, ...accommodationOfPart(part), placeProperties: [...codes] }] };
  });
}

/** The query of GET /availabilities/preferences for a reservation of an offer. */
function preferencesQuery(offerId, reservationId) {
  const q = (v) => encodeURIComponent(String(v ?? ''));
  return `/availabilities/preferences?contextId=${q(offerId)}&contextType=OFFER&resourceId=${q(reservationId)}&resourceType=RESERVATION`;
}

/**
 * The checks of GET /availabilities/preferences, and the preferences still
 * available: `{ checks, available, lines }`. 501, 404 and 405 are "not
 * provided": a warning, and the preferences go as chosen from the offer.
 * Another error fails (the offer listed the flow, or the scenario asks for
 * it). Each AvailablePlace must name its accommodation type, sub-type and
 * leg (required in OSDM). A preference no entry gives is a warning and is not
 * sent; an answer giving no property at all leaves the choice as it was.
 */
function checkPreferenceAvailability(status, body, reservationId, send) {
  const label = `GET /availabilities/preferences (reservation ${reservationId})`;
  if ([404, 405, 501].includes(status)) {
    return { checks: [], available: listOf(send), lines: [{ level: 'WARNING', text: `${label}: answered ${status}, the provider does not give the availability of preferences; the preferences go as the offer lists them.` }] };
  }
  const ok2xx = typeof status === 'number' && status >= 200 && status < 300;
  const checks = [{ name: `${label} is answered with 2xx`, ok: ok2xx, message: `HTTP ${status}` }];
  if (!ok2xx) return { checks, available: listOf(send), lines: [] };
  const places = body?.availablePlaces;
  checks.push({ name: `${label}: availablePlaces is a list`, ok: Array.isArray(places), message: `availablePlaces is ${places === undefined ? 'absent' : typeof places}` });
  const list = listOf(places);
  const incomplete = list.map((p, i) => [i, p]).filter(([, p]) => !isText(p?.accommodationType) || !isText(p?.accommodationSubType) || !isText(p?.tripLegCoverage?.tripId) || !isText(p?.tripLegCoverage?.legId)).map(([i]) => i);
  if (list.length > 0) {
    checks.push({ name: `${label}: each available place names its accommodation type, sub-type and leg`, ok: incomplete.length === 0, message: `incomplete: availablePlaces[${incomplete.join('], [')}]` });
  }
  const given = unique(list.flatMap((p) => listOf(p?.placeProperties)).filter(isText).map(upper));
  if (given.length === 0) {
    return { checks, available: listOf(send), lines: [{ level: 'INFO', text: `${label}: the answer gives no place property; the preferences go as the offer lists them.` }] };
  }
  const available = listOf(send).filter((code) => given.includes(code));
  const lines = listOf(send).filter((code) => !given.includes(code)).map((code) => ({
    level: 'WARNING', text: `Seat preference ${code}: listed by the offer, but no longer available (${label} gives ${given.join(', ')}); it is not asked.`,
  }));
  return { checks, available, lines };
}

/**
 * Whether the booked reservations give the preferences asked: one check per
 * reservation, a warning (level 'warn') when a preference is missing from its
 * places. OSDM honours a preference "if possible", and a booked place need
 * not name its properties (ReservedPlace.placeProperties is optional).
 * @param {object}   booking        the booking read
 * @param {string[]} reservationIds the reservations asked with preferences
 * @param {string[]} sent           the preferences asked
 */
function checkPreferencesGiven(booking, reservationIds, sent) {
  const codes = listOf(sent).filter(isText).map(upper);
  if (codes.length === 0) return [];
  const all = listOf(booking?.bookedOffers).flatMap((o) => listOf(o?.reservations));
  const own = all.filter((r) => listOf(reservationIds).includes(r?.id));
  return (own.length > 0 ? own : all).map((r) => {
    const given = unique(listOf(r?.placeAllocation?.reservedPlaces).flatMap((p) => listOf(p?.placeProperties)).filter(isText).map(upper));
    const missing = codes.filter((code) => !given.includes(code));
    return {
      name: `Booking: reservation ${r?.id} gives the seat preferences asked (${codes.join(', ')})`,
      ok: missing.length === 0,
      level: 'warn',
      message: `not given: ${missing.join(', ')}; its places name ${given.length > 0 ? given.join(', ') : 'no property'}`,
    };
  });
}

module.exports = {
  FLOWS, FLOW_TEXT, flowOfScenario, flowsOffered, preferencesOffered, describeOfferedFlow,
  preferencesOfScenario, propertiesOfPart, choosePreferences, withPreferences, preferencesQuery,
  checkPreferenceAvailability, checkPreferencesGiven, retryWithoutPreferences, afterRetryWithoutPreferences,
};
