// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fareTemplates.js — DB's real fares as templates, laid on the simulator's
 * own places (#1047).
 *
 * `fares/templates.json` is made by `scripts/fare-templates.js` from DB's
 * 2024 offline fare delivery: each template is a region's shape (its ends,
 * its route as a tree of stations, station sets, sequences and alternatives)
 * and its fares, without any place, company or card of DB's. This module
 * turns a template fare into OSDM's online `Fare` once the caller gives:
 *
 * - `placeOf(role, n)`: the n-th place (0, 1, …) of the region's `entry`,
 *   `route` or `exit`, as `{ stopPlaceRef, name }`. The route asks for its
 *   places in reading order, a station set for as many as it holds;
 * - `companies(n)`: n company references, for the carriers and the TCOs;
 * - `cardFor(slot)`: the CardReference of a card slot (`cardSlots`);
 * - the fare's id, passengers, day of travel and after-sales condition.
 *
 * Choosing the template, the places, the cluster and the card is the fare
 * generator's (part C, #1048).
 */

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', '..', 'fares', 'templates.json');
let loaded = null;

/** The templates file, read once. */
function fareTemplates() {
  if (!loaded) loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return loaded;
}

const stopRef = (place) => ({ objectType: 'StopPlaceRef', stopPlaceRef: place.stopPlaceRef });

// The places of each role, in the order the template asks for them.
function placeTaker(placeOf) {
  const next = { entry: 0, route: 0, exit: 0 };
  return (role) => {
    const place = placeOf(role, next[role]);
    next[role] += 1;
    if (!place?.stopPlaceRef) throw new Error(`no place given for ${role} ${next[role] - 1}`);
    return place;
  };
}

function connectionPointOf(end, take, role) {
  const sets = end.stationSets.map((size) => Array.from({ length: size }, () => take(role)));
  const first = sets[0][0];
  return {
    objectType: 'FareConnectionPoint',
    id: `urn:x_osdm_simulator:fcp:${first.stopPlaceRef.split(':').pop()}`,
    name: first.name,
    stationSets: sets.map((stations) => ({ stations: stations.map(stopRef) })),
  };
}

// A template's route as OSDM's flat routeItemList, items naming each other
// by index; the route's own item lists the top sequence.
function routeOf(shape, take, ctx) {
  const items = [];
  const push = (item, node) => {
    if (node.carriers) item.carrierConstraint = ctx.carrierConstraint(node.carriers);
    items.push(item);
    return { index: items.length - 1, summary: item.summary };
  };
  const add = (node) => {
    if (node.place === 'station') {
      const p = take('route');
      return push({ station: { objectType: 'StopPlace', id: p.stopPlaceRef, name: p.name }, summary: p.name }, node);
    }
    if (node.place === 'stationSet') {
      const stations = Array.from({ length: node.stations }, () => take('route'));
      const code = stations[0].stopPlaceRef.split(':').pop();
      return push({
        fareReferenceStation: { name: stations[0].name, code, carrier: ctx.carrier, stations: stations.map(stopRef) },
        summary: stations[0].name,
      }, node);
    }
    if (node.sequence) {
      const parts = node.sequence.map(add);
      return push({ routeItemIndices: parts.map((p) => p.index), summary: parts.map((p) => p.summary).join(' - ') }, node);
    }
    if (node.alternatives) {
      const parts = node.alternatives.map(add);
      return push({ alternativeRouteItemIndices: parts.map((p) => p.index), summary: `(${parts.map((p) => p.summary).join(' / ')})` }, node);
    }
    throw new Error('a route node with no place, sequence or alternatives');
  };
  if (!shape.sequence) throw new Error('a route that is not a sequence');
  const top = shape.sequence.map(add);
  for (const item of items) delete item.summary;
  return {
    routeSummary: top.map((p) => p.summary).join(' - '),
    routeItem: { routeItemIndices: top.map((p) => p.index) },
    routeItemList: items,
  };
}

/**
 * A template's region as OSDM's online RegionalConstraint, its places from
 * `placeOf`: the entry's stations, then the route's, then the exit's.
 */
function regionalConstraintOf(template, placeOf, ctx) {
  const take = placeTaker(placeOf);
  const entryConnectionPoint = connectionPointOf(template.entry, take, 'entry');
  const regionalValidities = template.regionalValidities.map((v, i) => {
    const route = routeOf(v.route, take, ctx);
    if (v.carriers) route.routeItem.carrierConstraint = ctx.carrierConstraint(v.carriers);
    return { seqNb: i + 1, route };
  });
  const exitConnectionPoint = connectionPointOf(template.exit, take, 'exit');
  return { entryConnectionPoint, exitConnectionPoint, regionalValidities, distance: template.distance };
}

// The day after `day` (YYYY-MM-DD) by `days`, at `hours` o'clock, in UTC.
function untilOf(day, days, hours) {
  const t = Date.parse(`${day}T00:00:00Z`) + days * 86400000 + hours * 3600000;
  return new Date(t).toISOString().replace('.000Z', 'Z');
}

function travelValidityOf(validity, day) {
  const { validityRange } = validity;
  const days = validityRange.timeUnit === 'DAYS' ? validityRange.value : 0;
  return {
    validTravelDates: { from: `${day}T00:00:00Z`, until: untilOf(day, days, validityRange.hoursAfterMidnight || 0) },
    validityRange,
    ...(validity.numberOfTravelDays > 0 ? { numberOfTravelDays: validity.numberOfTravelDays } : {}),
    validityType: validity.validityType,
  };
}

const SERVICE_CLASS_NAMES = { BEST: 'Best', HIGH: 'High', STANDARD: 'Standard', BASIC: 'Basic' };

/**
 * One template fare as OSDM's online Fare.
 *
 * @param {object} file the templates file (`fareTemplates()`)
 * @param {object} template one of `file.templates`
 * @param {object} fare one of `template.fares`
 * @param {object} ctx id, passengerRefs, day (YYYY-MM-DD), placeOf,
 *   companies(n), cardFor(slot), afterSalesCondition, and optionally a
 *   combinationConstraint in place of the template's
 */
function onlineFare(file, template, fare, ctx) {
  const bundle = file.bundles[fare.bundle];
  const passenger = file.passengerConstraints[fare.passenger];
  if (!bundle || !passenger) throw new Error(`template ${template.id}: bundle ${fare.bundle} or passenger ${fare.passenger} is not in the file`);
  const companies = (n) => ctx.companies(n);
  const carrierConstraint = (key) => {
    const c = file.carrierConstraints[key];
    if (!c) throw new Error(`template ${template.id}: carrier constraint ${key} is not in the file`);
    return { includedCarriers: companies(c.carriers) };
  };
  const [carrier] = companies(1);
  const result = {
    id: ctx.id,
    type: fare.type,
    name: { id: `${ctx.id}-NAME`, text: fare.name },
    prices: [{ amount: fare.price, currency: file.about.currency, scale: 2 }],
    regionalConstraint: regionalConstraintOf(template, ctx.placeOf, { carrier, carrierConstraint }),
    carrierConstraint: carrierConstraint(fare.carriers),
    regulatoryConditions: fare.regulatoryConditions,
    serviceClass: { type: fare.serviceClass, name: SERVICE_CLASS_NAMES[fare.serviceClass] || fare.serviceClass },
    travelClass: fare.travelClass,
    afterSalesCondition: ctx.afterSalesCondition,
    combinationConstraint: ctx.combinationConstraint || bundle.combinationConstraint,
    fulfillmentConstraint: {
      acceptedControlSecurityTypes: bundle.fulfillment.acceptedControlSecurityTypes,
      isIndividualTicketingForbidden: !bundle.fulfillment.individualTicketingPermitted,
    },
    travelValidityConstraint: travelValidityOf(bundle.travelValidity, ctx.day),
    passengerRefs: ctx.passengerRefs,
    passengerConstraints: [{ number: ctx.passengerRefs.length, lowerAgeLimit: passenger.lowerAgeLimit, upperAgeLimit: passenger.upperAgeLimit }],
    involvedTCOs: companies(fare.involvedTCOs),
    legacyAccountingIdentifier: fare.legacyAccountingIdentifier,
  };
  if (fare.card) result.requiredCards = [ctx.cardFor(fare.card)];
  return result;
}

module.exports = { fareTemplates, onlineFare, regionalConstraintOf, FILE };
