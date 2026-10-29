// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * fare-templates-lib.js — fare templates made from DB's real fares, without
 * their places (#1047, part B of #1045).
 *
 * The source is DB's OSDM offline fare delivery 2024.02 (fare provider 1080,
 * format 3.1), shared publicly by a CEN project and no longer commercially
 * valid. A template is one of its regions, kept for its shape and its fares:
 *
 * - the shape: each end a station or a border point and the size of its
 *   station sets; the route as a tree of stations, station sets (by size),
 *   sequences and alternatives; the distance;
 * - the fares: family, class, passenger constraint, card slot, bundle,
 *   carrier constraint, price (EUR cents), regulatory conditions, accounting
 *   identifier, number of TCOs.
 *
 * No station, station name, station set code or name, company code or card
 * code is written outside `about` (`leaksIn()` says so). The simulator lays
 * a template on its own stations (`src/osdm/fareTemplates.js`, part C).
 *
 * The tables below name what this delivery holds (its fare names, cards,
 * clusters). Anything else stops the conversion rather than going through
 * unread.
 */

const DELIVERY = { fareProvider: '1080', deliveryId: '2024.02' };

// The regions read, chosen for the shapes they give (#1047).
const REGIONS = [
  { numbers: [35047, 35048], shape: 'station to station, short' },
  { numbers: [35135, 35136], shape: 'station to station, long, a route with alternatives' },
  { numbers: [34801, 34802, 34803, 34804], shape: 'station set to station set, two routes' },
  { numbers: [4045, 4046], shape: 'border to station set, long' },
  { numbers: [15441, 15442], shape: 'border to station, short' },
  { numbers: [15465, 15466], shape: 'border to a large station set' },
  { numbers: [193, 194], shape: 'border to border, transit' },
  { numbers: [4053, 4054], shape: 'border to station set, short' },
  { numbers: [203, 204], shape: 'border to border, short' },
  { numbers: [23711, 23712, 23713, 23714, 23715, 23716], shape: 'one pair, three routes' },
];
const REGION_NUMBERS = REGIONS.flatMap((r) => r.numbers);

// DB's fare names, as neutral families.
const FAMILIES = {
  Flexpreis: { family: 'FLEXIBLE', name: 'Flexible fare' },
  'Gruppe&Spar': { family: 'GROUP', name: 'Group saver fare' },
  Fahrrad: { family: 'BICYCLE', name: 'Bicycle fare' },
};

// DB's cards, as anonymous families: a card slot names the family and the
// classes of the cards it takes, never a card.
const CARD_FAMILIES = [
  { pattern: /^\d+_BC(25|50|100)_([12])$/, family: (m) => `REDUCTION_${m[1]}`, cardClass: (m) => (m[2] === '1' ? 'FIRST' : 'SECOND') },
  { pattern: /^UIC_FIP_(?:DUTY|LEISURE_REDU)(?:_([12]))?$/, family: () => 'STAFF', cardClass: (m) => ({ 1: 'FIRST', 2: 'SECOND' }[m[1]] || 'ANY') },
];

// The offline delivery's clusters, in OSDM's spelling (osdm.io).
const CLUSTERS = { BUSINESS: 'BUSINESS', FULLFLEX: 'FULL_FLEX', SEMIFLEX: 'SEMI_FLEX', NONFLEX: 'NON_FLEX', PROMO: 'PROMO' };

const REGION_ID = /_K__(\d+)$/;
const REGION_REF = /"regionalConstraintRef"\s*:\s*"[^"]*_K__(\d+)"/;
const regionNumberOf = (id) => (REGION_ID.exec(id) || [])[1];
// A local key from a delivery id: 1080_2024.02_G__7 → G7.
const keyOf = (id) => {
  const m = /_([A-Z])__(\d+)$/.exec(id || '');
  if (!m) throw new Error(`not an id of this delivery: ${id}`);
  return `${m[1]}${m[2]}`;
};

/**
 * What to keep of the delivery while it streams by: the header, every small
 * list, the chosen regions and their fares. Station names are never kept.
 */
function createCollector(numbers = REGION_NUMBERS) {
  const wanted = new Set(numbers.map(String));
  const kept = { delivery: null, lists: {} };
  const keep = (list, value) => { (kept.lists[list] ||= []).push(value); };
  return {
    kept,
    onDelivery(text) { kept.delivery = JSON.parse(text); },
    onElement(list, text) {
      if (list === 'stationNames') return;
      if (list === 'fares') {
        const m = REGION_REF.exec(text);
        if (m && wanted.has(m[1])) keep(list, JSON.parse(text));
        return;
      }
      const value = JSON.parse(text);
      if (list === 'regionalConstraints' && !wanted.has(regionNumberOf(value.id))) return;
      keep(list, value);
    },
  };
}

const byId = (list = []) => new Map(list.map((x) => [x.id, x]));

function cardSlotOf(constraint) {
  const families = new Set();
  const classes = new Set();
  for (const card of constraint.requiredCards || []) {
    const rule = CARD_FAMILIES.find((f) => f.pattern.test(card.cardValue));
    if (!rule) throw new Error(`a card this script does not know: ${card.cardValue}`);
    const m = rule.pattern.exec(card.cardValue);
    families.add(rule.family(m));
    classes.add(rule.cardClass(m));
  }
  if (families.size !== 1) throw new Error(`a card slot of several families: ${constraint.id}`);
  const order = ['SECOND', 'FIRST', 'ANY'];
  return { family: [...families][0], cardClasses: [...classes].sort((a, b) => order.indexOf(a) - order.indexOf(b)) };
}

function connectionPointShape(point) {
  if (!point) throw new Error('a region whose connection point is missing');
  const code = point.legacyBorderPointCode;
  return { border: Boolean(code && code !== '0'), stationSets: (point.stationSets || []).map((set) => set.length) };
}

// The flags of a route item worth keeping, only when they say something.
function itemFlags(item, ctx) {
  const flags = {};
  if (item.isBorder) flags.border = true;
  if (item.stop) flags.stop = true;
  if (item.technicalViaOnly) flags.technicalViaOnly = true;
  if (item.routeValidityType && item.routeValidityType !== 'LINE') flags.validity = item.routeValidityType;
  if (item.carrierConstraintRef) flags.carriers = ctx.carrier(item.carrierConstraintRef);
  if (item.serviceConstraintRef) flags.services = ctx.service(item.serviceConstraintRef);
  return flags;
}

// An offline route item as a tree without places.
function routeShape(item, ctx) {
  const flags = itemFlags(item, ctx);
  if (item.station) return { place: 'station', ...flags };
  if (item.fareReferenceStationSet) return { place: 'stationSet', stations: ctx.setSize(item.fareReferenceStationSet.code), ...flags };
  const sequence = item.route || [];
  const alternatives = item.alternativeRoute || [];
  if (sequence.length > 0 && alternatives.length > 0) throw new Error('a route item with both a route and alternatives');
  if (sequence.length > 0) return { sequence: sequence.map((i) => routeShape(i, ctx)), ...flags };
  if (alternatives.length > 0) return { alternatives: alternatives.map((i) => routeShape(i, ctx)), ...flags };
  throw new Error('a route item with no station, station set or route');
}

function validityShape(validity, ctx) {
  const extra = Object.keys(validity).filter((k) => k !== 'seqNb' && k !== 'viaStations');
  if (extra.length > 0) throw new Error(`a regional validity this script does not read: ${extra.join(', ')}`);
  const { carriers, ...route } = routeShape(validity.viaStations, ctx);
  return { ...(carriers ? { carriers } : {}), route };
}

function priceOf(price, id) {
  const p = Array.isArray(price?.price) ? price.price[0] : null;
  if (!p || p.currency !== 'EUR' || (p.scale ?? 2) !== 2) throw new Error(`a price not in EUR cents: ${id}`);
  return p.amount;
}

// DB rounds its prices to 10 cents.
const ROUNDING_CENTS = 10;

// The passenger a doubled card fare belongs to, when `stays` is the right
// passenger's: one whose fare without card, reduced at the rate `stays` gives,
// is `goes`'s price within DB's rounding, who has other card fares of that
// family and class but none with this card. Null when not exactly one.
function ownerOf(goes, stays, fares) {
  const same = (x) => x.family === goes.family && x.travelClass === goes.travelClass;
  const plainOf = (passenger) => fares.find((x) => same(x) && x.passenger === passenger && x.card === null);
  const own = plainOf(stays.passenger);
  if (!own || own.price === 0) return null;
  const rate = stays.price / own.price;
  const owners = fares.filter((x) => same(x) && x.card === null && x.passenger !== goes.passenger
    && x.price > 0 && Math.abs(goes.price - x.price * rate) <= ROUNDING_CENTS
    && fares.some((y) => same(y) && y.passenger === x.passenger && y.card !== null)
    && !fares.some((y) => same(y) && y.passenger === x.passenger && y.card === goes.card));
  return owners.length === 1 ? owners[0].passenger : null;
}

/**
 * DB's delivery labels, in every region, the second-class card fare of a
 * child with the adult's passenger constraint: one (family, class,
 * passenger, card) appears twice. The one `ownerOf()` finds an owner for
 * goes to that passenger; any other doubled fare stops the conversion.
 */
function correctDuplicates(fares, corrections, region) {
  const keyOfFare = (f) => [f.family, f.travelClass, f.passenger, f.card].join('|');
  const groups = new Map();
  for (const f of fares) groups.set(keyOfFare(f), [...(groups.get(keyOfFare(f)) || []), f]);
  for (const [key, same] of groups) {
    if (same.length === 1) continue;
    if (same.length > 2) throw new Error(`${region}: ${same.length} fares for ${key}`);
    const [a, b] = same;
    const moved = [[b, a], [a, b]]
      .map(([goes, stays]) => ({ goes, to: ownerOf(goes, stays, fares) }))
      .filter((m) => m.to);
    if (moved.length !== 1) throw new Error(`${region}: two fares for ${key}, and no passenger they belong to`);
    corrections.push(`${region}: ${key} at ${moved[0].goes.price} given to ${moved[0].to}`);
    moved[0].goes.passenger = moved[0].to;
  }
}

function fareShape(f, ctx) {
  const name = ctx.text(f.nameRef);
  const family = FAMILIES[name];
  if (!family) throw new Error(`a fare name this script does not know: ${name}`);
  const serviceClass = ctx.serviceClass(f.serviceClassRef);
  return {
    family: family.family,
    name: family.name,
    type: f.fareType,
    travelClass: serviceClass.travelClass,
    serviceClass: serviceClass.id,
    passenger: keyOf(f.passengerConstraintRef),
    card: f.reductionConstraintRef ? ctx.cardSlot(f.reductionConstraintRef) : null,
    bundle: keyOf(f.bundleRef),
    carriers: ctx.carrier(f.carrierConstraintRef),
    price: ctx.price(f.priceRef),
    regulatoryConditions: f.regulatoryConditions || [],
    legacyAccountingIdentifier: f.legacyAccountingIdentifier,
    involvedTCOs: (f.involvedTCOs || []).length,
    individualContracts: Boolean(f.individualContracts),
  };
}

const FARE_ORDER = ['family', 'travelClass', 'passenger', 'card'];
function compareFares(a, b) {
  for (const k of FARE_ORDER) {
    const x = String(a[k] ?? '');
    const y = String(b[k] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.price - b.price;
}

function passengerShape(p) {
  return {
    type: p.passengerType,
    lowerAgeLimit: p.lowerAgeLimit,
    upperAgeLimit: p.upperAgeLimit,
    weight: p.passengerWeight,
    travelAloneAgeLimit: p.ageLimitToTravelAlone,
    reservationAgeLimit: p.ageLimitForReservation,
    isAncillaryItem: Boolean(p.isAncillaryItem),
    includedFree: (p.includedFreePassenger || []).map((x) => ({ number: x.number, constraint: keyOf(x.passengerConstraintRef) })),
    combinedWith: (p.combinationConstraint || []).map((x) => ({ min: x.minNumber, max: x.maxNumber, constraint: keyOf(x.passengerConstraintRef) })),
  };
}

function clusterOf(name) {
  const cluster = CLUSTERS[name];
  if (!cluster) throw new Error(`a cluster this script does not know: ${name}`);
  return cluster;
}

function bundleShape(bundle, lists) {
  const one = (list, id) => {
    const found = byId(lists[list]).get(id);
    if (!found) throw new Error(`${bundle.id}: ${list} ${id} is missing`);
    return found;
  };
  const combination = one('combinationConstraints', bundle.combinationConstraintRef);
  const validity = one('travelValidityConstraints', bundle.travelValidityConstraintRef);
  const sales = one('salesAvailabilityConstraint', bundle.salesAvailabilityConstraintRef);
  const fulfillment = one('fulfillmentConstraints', bundle.fulfillmentConstraintRef);
  return {
    passengers: keyOf(bundle.passengerCombinationConstraintRef),
    combinationConstraint: combination.combinationModels.map((m) => ({
      model: m.model,
      referenceCluster: clusterOf(m.referenceCluster),
      allowedClusters: (m.allowedClusters || []).map(clusterOf),
      isValidOnlyWhenCombined: Boolean(m.onlyWhenCombined),
    })),
    travelValidity: {
      validityRange: validity.validityRange,
      validityType: validity.validityType,
      numberOfTravelDays: validity.numberOfTravelDays,
    },
    salesAvailability: (sales.salesRestrictions || []).map(({ startOfSale, endOfSale }) => ({ startOfSale, endOfSale })),
    fulfillment: {
      acceptedControlSecurityTypes: fulfillment.acceptedControlSecurityTypes,
      individualTicketingPermitted: Boolean(fulfillment.individualTicketingPermitted),
      separateFulfillmentRequired: Boolean(fulfillment.separateFulfillmentRequired),
    },
  };
}

// Templates made from the same pair of connection points are routes of one
// pair: `pair` numbers the pair, `direction` 0 is the way first met.
function pairsOf(regions) {
  const pairs = [];
  return regions.map((rc) => {
    const ends = [rc.entryConnectionPointId, rc.exitConnectionPointId];
    let index = pairs.findIndex((p) => p[0] === ends[0] && p[1] === ends[1]);
    if (index >= 0) return { pair: index + 1, direction: 0 };
    index = pairs.findIndex((p) => p[0] === ends[1] && p[1] === ends[0]);
    if (index >= 0) return { pair: index + 1, direction: 1 };
    pairs.push(ends);
    return { pair: pairs.length, direction: 0 };
  });
}

/**
 * The templates file, from what `createCollector()` kept. Throws on anything
 * this script does not know how to read.
 */
function templatesOf(kept, regions = REGIONS) {
  const { delivery, lists } = kept;
  if (delivery?.fareProvider !== DELIVERY.fareProvider || delivery?.deliveryId !== DELIVERY.deliveryId) {
    throw new Error(`this script reads DB's delivery ${DELIVERY.fareProvider} ${DELIVERY.deliveryId}, not ${delivery?.fareProvider} ${delivery?.deliveryId}`);
  }
  const texts = byId(lists.texts);
  const prices = byId(lists.prices);
  const classes = byId(lists.serviceClassDefinitions);
  const points = byId(lists.connectionPoints);
  const setSizes = new Map((lists.fareReferenceStationSetDefinitions || []).map((s) => [s.code, s.stations.length]));
  const used = { carriers: new Set(), services: new Set(), cards: new Set(), passengers: new Set(), bundles: new Set() };
  const ctx = {
    text: (id) => texts.get(id)?.text ?? texts.get(id)?.textUtf8,
    price: (id) => priceOf(prices.get(id), id),
    serviceClass: (id) => {
      const c = classes.get(id);
      if (!c) throw new Error(`a service class this delivery does not define: ${id}`);
      return c;
    },
    setSize: (code) => {
      if (!setSizes.has(code)) throw new Error(`a station set this delivery does not define: ${code}`);
      return setSizes.get(code);
    },
    carrier: (id) => { used.carriers.add(id); return keyOf(id); },
    service: (id) => { used.services.add(id); return keyOf(id); },
    cardSlot: (id) => { used.cards.add(id); return keyOf(id).replace(/^K/, 'R'); },
  };
  const numbers = regions.flatMap((r) => r.numbers.map((n) => ({ n, shape: r.shape })));
  const regionals = numbers.map(({ n }) => {
    const rc = (lists.regionalConstraints || []).find((x) => regionNumberOf(x.id) === String(n));
    if (!rc) throw new Error(`region ${n} is not in the delivery`);
    return rc;
  });
  const pairs = pairsOf(regionals);
  const corrections = [];
  const faresByRegion = new Map();
  for (const f of lists.fares || []) faresByRegion.set(regionNumberOf(f.regionalConstraintRef), [...(faresByRegion.get(regionNumberOf(f.regionalConstraintRef)) || []), f]);

  const templates = numbers.map(({ n, shape }, i) => {
    const rc = regionals[i];
    const id = `T${String(i + 1).padStart(2, '0')}`;
    const fares = (faresByRegion.get(String(n)) || []).map((f) => fareShape(f, ctx));
    if (fares.length === 0) throw new Error(`region ${n} has no fare`);
    correctDuplicates(fares, corrections, id);
    for (const f of fares) { used.passengers.add(f.passenger); used.bundles.add(f.bundle); }
    return {
      id,
      // DB's region number (its id ends in K__<number>): an id, not a place.
      madeFromRegion: n,
      shape,
      ...pairs[i],
      distance: rc.distance,
      entry: connectionPointShape(points.get(rc.entryConnectionPointId)),
      exit: connectionPointShape(points.get(rc.exitConnectionPointId)),
      regionalValidities: (rc.regionalValidity || []).map((v) => validityShape(v, ctx)),
      fares: fares.sort(compareFares),
    };
  });

  const pick = (list, ids, shapeOf) => Object.fromEntries((lists[list] || [])
    .filter((x) => ids.has(x.id))
    .map((x) => [keyOf(x.id), shapeOf(x)])
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  const passengerIds = new Set([...used.passengers].map((k) => (lists.passengerConstraints || []).find((p) => keyOf(p.id) === k)?.id));
  // Constraints named by those used (free companions, combinations) are kept too.
  for (const p of lists.passengerConstraints || []) {
    if (!passengerIds.has(p.id)) continue;
    for (const x of [...(p.includedFreePassenger || []), ...(p.combinationConstraint || [])]) passengerIds.add(x.passengerConstraintRef);
  }
  const bundleIds = new Set((lists.fareConstraintBundles || []).filter((b) => used.bundles.has(keyOf(b.id))).map((b) => b.id));
  const bundles = pick('fareConstraintBundles', bundleIds, (b) => bundleShape(b, lists));
  const combinationIds = new Set((lists.fareConstraintBundles || []).filter((b) => bundleIds.has(b.id)).map((b) => b.passengerCombinationConstraintRef));

  return {
    templates: {
      about: {
        source: `DB's OSDM offline fare delivery, fare provider ${delivery.fareProvider}, delivery ${delivery.deliveryId}, format ${delivery.version}.`,
        validity: lists.calendars?.[0] ? `${lists.calendars[0].fromDate} to ${lists.calendars[0].untilDate}` : undefined,
        origin: 'Shared publicly by a CEN project; no longer commercially valid (maintainer, 2026-10-29).',
        leftOut: 'Stations, station names, station set codes and names, connection points, company codes and card codes. A template keeps the shape of a region and its fares; the simulator lays it on its own stations.',
        corrected: corrections.length > 0
          ? `In every region DB's delivery gives one second-class card fare of a child the adult's passenger constraint; it is given back to the child (${corrections.length} fares).`
          : undefined,
        currency: 'EUR',
        script: 'OSDM_Simulator/scripts/fare-templates.js',
      },
      passengerConstraints: pick('passengerConstraints', passengerIds, passengerShape),
      passengerCombinations: pick('passengerCombinationConstraints', combinationIds, (c) => ({ min: c.minWeightedPassengers, max: c.maxWeightedPassengers })),
      bundles,
      carrierConstraints: pick('carrierConstraints', used.carriers, (c) => ({ carriers: (c.includedCarrier || []).length, excludedCarriers: (c.excludedCarrier || []).length })),
      serviceConstraints: pick('serviceConstraints', used.services, (s) => ({ serviceBrands: (s.includedServiceBrands || []).length })),
      cardSlots: Object.fromEntries(Object.entries(pick('reductionConstraints', used.cards, cardSlotOf))
        .map(([k, v]) => [k.replace(/^K/, 'R'), v])),
      templates,
    },
    corrections,
  };
}

/**
 * Every place, company or card of the delivery that appears in the templates
 * outside `about`: station codes and names of the regions read, station set
 * codes and names, carrier and TCO codes, card codes and names. Strings only
 * (numbers are counts, prices and accounting identifiers).
 */
function leaksIn(templates, kept) {
  const tokens = new Set();
  const add = (v) => { if (typeof v === 'string' && v.length >= 4) tokens.add(v); };
  const { lists } = kept;
  for (const p of lists.connectionPoints || []) for (const set of p.stationSets || []) for (const s of set) add(s.code);
  for (const d of lists.fareReferenceStationSetDefinitions || []) {
    add(d.code); add(d.name); add(d.nameUtf8);
    for (const s of d.stations || []) add(s.code);
  }
  const walkRoute = (item) => {
    if (!item) return;
    if (item.station) add(item.station.code);
    if (item.fareReferenceStationSet) { add(item.fareReferenceStationSet.code); add(item.fareReferenceStationSet.name); }
    for (const x of [...(item.route || []), ...(item.alternativeRoute || [])]) walkRoute(x);
  };
  for (const rc of lists.regionalConstraints || []) for (const v of rc.regionalValidity || []) walkRoute(v.viaStations);
  for (const c of lists.carrierConstraints || []) for (const code of [...(c.includedCarrier || []), ...(c.excludedCarrier || [])]) add(code);
  for (const f of lists.fares || []) for (const code of f.involvedTCOs || []) add(code);
  for (const r of lists.reductionConstraints || []) for (const card of r.requiredCards || []) { add(card.cardValue); add(card.cardName); }
  const found = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { for (const t of tokens) if (v.includes(t)) found.add(t); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k); walk(x); }
  };
  const { about: _about, ...rest } = templates;
  walk(rest);
  return [...found].sort();
}

/**
 * The templates file as text: indented, each fare on one line, so the file
 * stays readable and a change shows as a change of a few lines.
 */
function templatesText(file) {
  const lines = new Map();
  const marked = {
    ...file,
    templates: file.templates.map((t, i) => ({
      ...t,
      fares: t.fares.map((f, j) => {
        const mark = `@@fare-${i}-${j}@@`;
        lines.set(mark, JSON.stringify(f));
        return mark;
      }),
    })),
  };
  const text = JSON.stringify(marked, null, 2).replace(/"(@@fare-\d+-\d+@@)"/g, (_, mark) => lines.get(mark));
  return `${text}\n`;
}

module.exports = { REGIONS, REGION_NUMBERS, DELIVERY, createCollector, templatesOf, templatesText, leaksIn, correctDuplicates };
