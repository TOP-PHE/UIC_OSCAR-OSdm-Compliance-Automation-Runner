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
 * are not provided. Everything comes from the profile's `nonTrip`, so the
 * same request always gives the same answer.
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

/**
 * What a non-trip request asks for: `{ kind: 'places', places }` or
 * `{ kind: 'zones', zones }`, a key for its price, the names for its summary.
 */
function nonTripAsked(criteria, provider) {
  if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw bad('nonTripSearchCriteria must be an object');
  const hasNuts = Array.isArray(criteria.nutsCodes) && criteria.nutsCodes.length > 0;
  if (hasNuts) throw bad('nonTripSearchCriteria.nutsCodes: a validity by NUTS code is not provided by this simulator');
  const hasPlaces = criteria.places !== undefined && criteria.places !== null;
  const hasZones = criteria.zones !== undefined && criteria.zones !== null;
  if (hasPlaces === hasZones) throw bad('nonTripSearchCriteria must name either places or zones');
  if (hasPlaces) {
    const places = placesAsked(criteria.places, provider);
    return { kind: 'places', places, key: places.map((p) => p.stopPlaceRef).join('|'), names: places.map((p) => p.name) };
  }
  const zones = zonesAsked(criteria.zones, provider);
  return { kind: 'zones', zones, key: zones.map((z) => z.id).join('|'), names: zones.map((z) => z.name) };
}

/** The first stop place asked, or of the first zone asked: it chooses a variant. */
const firstStopOf = (asked) => (asked.kind === 'places' ? asked.places[0].stopPlaceRef : asked.zones[0].places[0]);

/**
 * The regional validities of an admission (3.8 shape: a list; versionShapes
 * gives 3.6 the single deprecated member): a route through the stop places,
 * or one Zone per zone asked.
 */
function regionalValiditiesOf(asked, provider) {
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

function regionalValiditySummaryOf(asked) {
  const between = asked.kind === 'zones' ? `in ${asked.names.join(', ')}` : `between ${asked.names.join(', ')}`;
  return { description: `Valid ${between}, for one day`, shortDescription: asked.names.join(' - ') };
}

module.exports = {
  placeCollection, findPlaces, placeById, zoneCollection,
  nonTripAsked, firstStopOf, regionalValiditiesOf, regionalValiditySummaryOf,
};
