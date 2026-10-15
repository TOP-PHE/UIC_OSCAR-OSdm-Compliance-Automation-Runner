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

/**
 * The flow a scenario exercises, or null when it chooses no place: its own
 * `placeSelectionFlow`, else a seat from the seat map (placeSelectionMode) is
 * a named place, and a couchette or berth (accommodationSelection) or a
 * reservation booked by placeSelections (reservationBookingForm
 * PLACE_SELECTION) an automatic selection.
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
    for (const group of listOf(part?.availablePlacePreferences?.preferenceGroups)) {
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

module.exports = { FLOWS, FLOW_TEXT, flowOfScenario, flowsOffered, preferencesOffered, describeOfferedFlow };
