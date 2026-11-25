// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * productTags.js — GET /product-tags (#1436): the tags of everything the
 * provider sells, in groups.
 *
 * OSDM (Master Data, ProductTagsResponse, 3.6 to 3.12): `productTagNames`
 * [{ tag, description }] and `productTagGroups` [{ code, description,
 * productTags }], both required; a description is a Text { id, text,
 * shortText }, its short text "a name on a button". The simulator lists what
 * it sells, decided with the maintainer (2026-11-24):
 *
 *   - WITHOUT_TRIP: the types of the products sold without a trip (#1266:
 *     single ride, pass, multi-ride), when the provider sells without a trip;
 *   - REPLACEMENT: TICKET_LOST and CARD_LOST, when it replaces lost items;
 *   - WITH_TRIP: ADMISSION_POINT2POINT, then UPGRADE_POINT2POINT when some
 *     trains run in second class only, and RESERVATION when it sells
 *     reservations (productSelection.js reads the same tags in a request).
 *
 * A tag in two groups (ADMISSION_POINT2POINT) has one name. Every provider
 * answers: each sells admissions with a trip.
 */

const replacements = require('./replacements');

const text = (id, short, long) => ({ id, text: long, shortText: short });

// The description of each tag the simulator sells.
const NAMES = Object.freeze({
  ADMISSION_POINT2POINT: ['Single ride', 'A ticket for one ride, from one place to another.'],
  ADMISSION_PASS: ['Pass', 'Unlimited rides in a zone for the time of its validity.'],
  ADMISSION_MULTI_RIDE: ['Multi-ride card', 'A card holding a number of rides, valid for a period.'],
  UPGRADE_POINT2POINT: ['Upgrade', 'An upgrade to first class for one ride.'],
  RESERVATION: ['Reservation', 'A seat reservation on a train.'],
  TICKET_LOST: ['Lost ticket', 'The replacement of a lost ticket.'],
  CARD_LOST: ['Lost card', 'The replacement of a lost card.'],
});

const GROUPS = Object.freeze({
  WITHOUT_TRIP: ['Without a trip', 'What is sold for a zone or between stop places, without a trip.'],
  REPLACEMENT: ['Replacement', 'The replacement of a lost ticket or card.'],
  WITH_TRIP: ['With a trip', 'What is sold for a trip.'],
});

/** The groups of a provider, in that order, each with its tags; empty ones left out. */
function groupsOf(provider) {
  const withoutTrip = provider.nonTrip ? [...new Set(provider.nonTrip.products.map((p) => p.type))] : [];
  const replacing = provider.nonTrip?.replacements ? [...replacements.KINDS] : [];
  const withTrip = [
    'ADMISSION_POINT2POINT',
    ...(provider.secondClassOnlyCategories ? ['UPGRADE_POINT2POINT'] : []),
    ...(provider.reservations ? ['RESERVATION'] : []),
  ];
  return [['WITHOUT_TRIP', withoutTrip], ['REPLACEMENT', replacing], ['WITH_TRIP', withTrip]]
    .filter(([, tags]) => tags.length > 0);
}

// A tag the simulator does not describe has its own name for text.
const nameOf = (tag) => NAMES[tag] || [tag, tag];

/** The answer of GET /product-tags. */
function productTagsOf(provider) {
  const groups = groupsOf(provider);
  const tags = [...new Set(groups.flatMap(([, list]) => list))];
  const prefix = provider.idPrefix;
  return {
    productTagNames: tags.map((tag) => ({ tag, description: text(`${prefix}-TAG-${tag}`, ...nameOf(tag)) })),
    productTagGroups: groups.map(([code, list]) => ({
      code,
      description: text(`${prefix}-TAG-GROUP-${code}`, ...GROUPS[code]),
      productTags: list,
    })),
  };
}

module.exports = { productTagsOf, groupsOf };
