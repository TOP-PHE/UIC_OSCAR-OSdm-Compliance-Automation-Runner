// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * nonTrip.js — what a provider sells without a trip (#1258): its stop places
 * (GET and POST /places), its zones (GET /zones) and the regional validity of
 * an offer asked by `nonTripSearchCriteria`, by places or by zones.
 *
 * Places are stop places only: a request naming another kind of PlaceRef
 * (an address, a point of interest, a geo position) is refused. NUTS codes
 * (#1266) are those the profile's zones name: a region asked by NUTS code is
 * served by the zone that names it, each admission valid in a Zone naming the
 * code; an unknown code is refused. Everything comes from the profile's
 * `nonTrip`, so the same request always gives the same answer.
 */

const { HttpError } = require('../http');

const MAX_PLACES = 10;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 10;

const bad = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The offer request is not valid', detail);
const badPlaces = (detail) => new HttpError(400, 'VALIDATION_ERROR', 'The place request is not valid', detail);

// No `modes`: OSDM 3.6's StopPlace has none.
const stopPlaceOf = (place) => ({ objectType: 'StopPlace', id: place.id, name: place.name });

/** GET /places: every stop place of the provider. */
function placeCollection(provider) {
  return { places: provider.nonTrip.places.map(stopPlaceOf) };
}

// The words of a name, without case or accents.
const wordsOf = (text) => String(text).normalize('NFD').replaceAll(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * POST /places: the stop places whose name holds every word of the name
 * asked, at most `restrictions.numberOfResults`. A place type other than STOP
 * finds nothing: the provider knows stop places only.
 */
function findPlaces(body, provider) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badPlaces('the body must be a PlaceRequest object');
  const input = body.placeInput;
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) throw badPlaces('placeInput must be an object');
  const name = input?.name;
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 120)) throw badPlaces('placeInput.name must be text of at most 120 characters');
  const restrictions = body.restrictions || {};
  const count = restrictions.numberOfResults ?? DEFAULT_RESULTS;
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS) throw badPlaces(`restrictions.numberOfResults must be 1 to ${MAX_RESULTS}`);
  const type = restrictions.type;
  if (type !== undefined && type !== null && type !== 'STOP') {
    return { places: [], problems: [{ code: 'NO_PLACE_FOUND', title: 'No place found', detail: `This provider knows stop places only (type ${String(type).slice(0, 30)} asked).` }] };
  }
  const asked = wordsOf(name || '');
  const found = provider.nonTrip.places
    .filter((place) => asked.every((word) => wordsOf(place.name).includes(word) || place.id.toLowerCase().endsWith(word)))
    .slice(0, count)
    .map(stopPlaceOf);
  if (found.length === 0) return { places: [], problems: [{ code: 'NO_PLACE_FOUND', title: 'No place found', detail: 'No stop place has that name.' }] };
  return { places: found };
}

/** GET /places/{id}: one stop place, or undefined. */
function placeById(provider, id) {
  const place = provider.nonTrip.places.find((p) => p.id === id);
  return place ? { places: [stopPlaceOf(place)] } : undefined;
}

const zoneDefinitionOf = (zone, provider) => ({
  id: zone.id,
  name: zone.name,
  carrier: provider.carrier.ref,
  ...(zone.nutsCodes ? { nutsCodes: [...zone.nutsCodes] } : {}),
  places: zone.places.map((stopPlaceRef) => ({ objectType: 'StopPlaceRef', stopPlaceRef })),
});

/** GET /zones: every zone of the provider. */
function zoneCollection(provider) {
  return { zones: provider.nonTrip.zones.map((zone) => zoneDefinitionOf(zone, provider)) };
}

const nameOf = (provider, stopPlaceRef) => provider.nonTrip.places.find((p) => p.id === stopPlaceRef)?.name || `Station ${stopPlaceRef.split(':').pop()}`;

// The stop places asked: StopPlaceRefs only, at least two, each once.
function placesAsked(list, provider) {
  if (!Array.isArray(list) || list.length < 2 || list.length > MAX_PLACES) throw bad(`nonTripSearchCriteria.places must hold 2 to ${MAX_PLACES} stop places`);
  const refs = list.map((place, i) => {
    if (!place || typeof place !== 'object' || place.objectType !== 'StopPlaceRef') {
      throw bad(`nonTripSearchCriteria.places[${i}]: only a StopPlaceRef is provided (objectType ${JSON.stringify(place?.objectType ?? null).slice(0, 40)})`);
    }
    const ref = place.stopPlaceRef;
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 120) throw bad(`nonTripSearchCriteria.places[${i}].stopPlaceRef is missing or not valid`);
    return ref;
  });
  if (new Set(refs).size !== refs.length) throw bad('nonTripSearchCriteria.places names a stop place twice');
  return refs.map((stopPlaceRef) => ({ stopPlaceRef, name: nameOf(provider, stopPlaceRef) }));
}

// The zones asked: each one of the provider's, by id and carrier.
function zonesAsked(list, provider) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PLACES) throw bad(`nonTripSearchCriteria.zones must hold 1 to ${MAX_PLACES} zones`);
  return list.map((zone, i) => {
    const id = zone?.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 120) throw bad(`nonTripSearchCriteria.zones[${i}].id is missing or not valid`);
    const known = provider.nonTrip.zones.find((z) => z.id === id);
    if (!known) throw bad(`nonTripSearchCriteria.zones[${i}]: "${id}" is not a zone of this provider (GET /zones lists them)`);
    if (zone.carrier !== provider.carrier.ref) throw bad(`nonTripSearchCriteria.zones[${i}].carrier: zone "${id}" is defined by ${provider.carrier.ref}`);
    return known;
  });
}

// #1266: the NUTS codes asked, each one a zone of the provider names.
function nutsAsked(list, provider) {
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PLACES) throw bad(`nonTripSearchCriteria.nutsCodes must hold 1 to ${MAX_PLACES} codes`);
  const codes = list.map((code, i) => {
    if (typeof code !== 'string' || code.length === 0 || code.length > 10) throw bad(`nonTripSearchCriteria.nutsCodes[${i}] is missing or not valid`);
    return code;
  });
  if (new Set(codes).size !== codes.length) throw bad('nonTripSearchCriteria.nutsCodes names a code twice');
  return codes.map((code, i) => {
    const zone = provider.nonTrip.zones.find((z) => (z.nutsCodes || []).includes(code));
    // The Problem points at the code refused (RFC 9457 recommends it).
    if (!zone) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'The offer request is not valid',
        `nonTripSearchCriteria.nutsCodes[${i}]: "${code.slice(0, 10)}" is no NUTS code of this provider (GET /zones lists them)`,
        {}, { pointers: [{ requestPointer: `/nonTripSearchCriteria/nutsCodes/${i}` }] });
    }
    return { code, zone };
  });
}

/**
 * What a non-trip request asks for: `{ kind: 'places', places }`,
 * `{ kind: 'zones', zones }` or (#1266) `{ kind: 'nuts', nuts, zones }`, a
 * key for its price, the names for its summary.
 */
function nonTripAsked(criteria, provider) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw bad('nonTripSearchCriteria must be an object');
  const given = (member) => criteria[member] !== undefined && criteria[member] !== null;
  const kinds = ['places', 'zones', 'nutsCodes'].filter(given);
  if (kinds.length !== 1) throw bad('nonTripSearchCriteria must name either places, zones or nutsCodes');
  if (kinds[0] === 'nutsCodes') {
    const nuts = nutsAsked(criteria.nutsCodes, provider);
    return { kind: 'nuts', nuts, zones: nuts.map((n) => n.zone), key: `nuts|${nuts.map((n) => n.code).join('|')}`, names: nuts.map((n) => `${n.zone.name} (${n.code})`) };
  }
  if (kinds[0] === 'places') {
    const places = placesAsked(criteria.places, provider);
    return { kind: 'places', places, key: places.map((p) => p.stopPlaceRef).join('|'), names: places.map((p) => p.name) };
  }
  const zones = zonesAsked(criteria.zones, provider);
  return { kind: 'zones', zones, key: zones.map((z) => z.id).join('|'), names: zones.map((z) => z.name) };
}

/** The first stop place asked, or of the first zone asked (or named by the first NUTS code): it chooses a variant. */
const firstStopOf = (asked) => (asked.kind === 'places' ? asked.places[0].stopPlaceRef : asked.zones[0].places[0]);

/**
 * The regional validities of an admission (3.8 shape: a list; versionShapes
 * gives 3.6 the single deprecated member): a route through the stop places,
 * or one Zone per zone asked.
 */
function regionalValiditiesOf(asked, provider) {
  // #1266: a Zone per NUTS code asked, naming it.
  if (asked.kind === 'nuts') {
    return asked.nuts.map((n, i) => ({ seqNb: i + 1, zone: { carrier: provider.carrier.ref, name: n.zone.name, zoneIds: [n.zone.zoneId], nutsCode: n.code } }));
  }
  if (asked.kind === 'zones') {
    return asked.zones.map((zone, i) => ({ seqNb: i + 1, zone: { carrier: provider.carrier.ref, name: zone.name, zoneIds: [zone.zoneId] } }));
  }
  return [{
    seqNb: 1,
    route: {
      routeSummary: asked.names.join(' - '),
      routeItem: { routeItemIndices: asked.places.map((_, i) => i) },
      routeItemList: asked.places.map((p) => ({ station: { objectType: 'StopPlace', id: p.stopPlaceRef, name: p.name } })),
    },
  }];
}

// How long a product is valid, in words (#1266).
function durationText(minutes) {
  if (minutes % 1440 === 0) return minutes === 1440 ? 'one day' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'one hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

function regionalValiditySummaryOf(asked, item) {
  const between = asked.kind === 'places' ? `between ${asked.names.join(', ')}` : `in ${asked.names.join(', ')}`;
  return { description: `${item.name}, valid ${between}, for ${durationText(item.validityMinutes)}`, shortDescription: asked.names.join(' - ') };
}

// A carrier that is not the provider's, for the wrong variant otherCarrier.
const OTHER_CARRIER = 'urn:x_osdm_simulator:carrier:other';

/**
 * The wrong variants (#1258, #1266), each chosen by the first stop place asked
 * (or of the first zone asked), applied to the admissions of every offer:
 * - withoutValidityFrom: no regional validity and no summary;
 * - variants.tripCoverage: a trip coverage, though no trip was asked;
 * - variants.otherPlaces (between stop places): a route through stop places
 *   other than those asked;
 * - variants.otherCarrier (in zones): zones of another carrier.
 * The booking copies the offer's parts, so it keeps the defect.
 */
function applyVariants(asked, offers, provider) {
  const first = firstStopOf(asked);
  const variants = provider.nonTrip.variants || {};
  const parts = offers.flatMap((o) => o.admissionOfferParts);
  if (first === provider.nonTrip.withoutValidityFrom) withoutValidity(parts);
  if (first === variants.tripCoverage) withTripCoverage(parts, provider);
  if (first === variants.otherPlaces && asked.kind === 'places') withOtherPlaces(parts, asked, provider);
  if (first === variants.otherCarrier && asked.kind === 'zones') withOtherCarrier(parts);
}

function withoutValidity(parts) {
  for (const part of parts) {
    delete part.regionalValidities;
    delete part.regionalValiditySummary;
  }
}

function withTripCoverage(parts, provider) {
  for (const part of parts) part.tripCoverage = { coveredTripId: `${provider.idPrefix}-TRIP-NONTRIP` };
}

// A route through as many of the provider's stop places, none of them asked.
function withOtherPlaces(parts, asked, provider) {
  const askedRefs = new Set(asked.places.map((p) => p.stopPlaceRef));
  const others = provider.nonTrip.places.filter((p) => !askedRefs.has(p.id)).slice(0, asked.places.length)
    .map((p) => ({ stopPlaceRef: p.id, name: p.name }));
  const elsewhere = regionalValiditiesOf({ kind: 'places', places: others, names: others.map((p) => p.name) }, provider);
  for (const part of parts) part.regionalValidities = structuredClone(elsewhere);
}

function withOtherCarrier(parts) {
  for (const validity of parts.flatMap((part) => part.regionalValidities || [])) {
    if (validity.zone) validity.zone.carrier = OTHER_CARRIER;
  }
}

module.exports = {
  placeCollection, findPlaces, placeById, zoneCollection,
  nonTripAsked, firstStopOf, regionalValiditiesOf, regionalValiditySummaryOf, applyVariants,
};
