/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * fares.js — fare offers for a requested section (#903, fares phase 1a).
 *
 * A scenario that asks for `FARE_*` sends a trip and the section of it the
 * provider prices (`requestedSections`). Step 01 then checks the fares of
 * the answer (`offers[].fares[]`), one check per rule over every fare offer,
 * naming each place that breaks it:
 *
 *   O1  an offer holds fares                                  FAIL
 *   O2  each fare has the members OSDM requires               FAIL
 *   O3  its type is one asked (ADMISSION for FARE_ADMISSION)  FAIL
 *   O4  regional validities (each a zone, route, …)           FAIL / WARNING
 *   O5  after-sales conditions; isProviderFee logged          FAIL / INFO
 *   O6  a validity range; the travel day within the dates     FAIL / WARNING
 *   O7  every passenger in a fare of each offer               FAIL
 *   O8  each passenger's fares cover the section: gap, overlap FAIL / WARNING
 *   O9  combination model of the YAML list                    WARNING
 *   O10 CLUSTERING: reference and allowed clusters listed     WARNING
 *   O11 CLUSTERING: none allowed more flexible                WARNING
 *   O12 involvedTCOs present                                  WARNING
 *   O13 no negative price                                     FAIL
 *   O14 fares that were not asked                             FAIL
 *   O15 products and fares counted                            INFO
 *   O16–O20 cards, ages, class, dates offset, offer coverage  WARNING
 *       (`fareDetails.js`, #1045)
 *
 * A negative scenario (#905) sets `expectFares: false`: the answer must hold
 * no fare (N, FAIL), whether fares were asked or not; O1 to O13 are then not
 * checked. OSDM says nothing of a domestic trip or of a request without a
 * section: the expectation is the Test Manager's for their provider (#242 D4).
 *
 *   N   no fare, as the scenario expects                      FAIL
 *
 * A fare offer that passed every FAIL-level check is booked and confirmed
 * (#906, `fareBooking.js`: step 01 sets `__fareSale` and routes to 02);
 * with `bookMode` PRODUCT the sale goes on with a product offer instead.
 * Fare reservations (#255, `fareReservations.js`): a request asking
 * FARE_RESERVATION gets checks V1–V3 and V8 here; an offer holding only fare
 * reservations is a fare offer, and a bicycle held by one needs no fare (O7).
 * Sources and levels are in #903, #905, #906, #255 and #242.
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

const { sameStopPlace } = require('./returnJourney.js');
const fareReservations = require('./fareReservations.js');
const fareDetails = require('./fareDetails.js');

// The clusters of OSDM's "constructing products from fares", most flexible first.
const CLUSTERS = ['BUSINESS', 'FULL_FLEX', 'SEMI_FLEX', 'NON_FLEX', 'PROMO'];
// FareCombinationModel.model, as the YAML spells it (no code list exists).
const COMBINATION_MODELS = ['SEPARATE_TICKET', 'SEPARATE_CONTRACT', 'CLUSTERING', 'COMBINING'];
const FARE_TYPES = ['ADMISSION', 'RESERVATION', 'ANCILLARY'];
const TYPE_OF_PART = { FARE_ADMISSION: 'ADMISSION', FARE_RESERVATION: 'RESERVATION', FARE_ANCILLARY: 'ANCILLARY' };
const REGIONAL_KINDS = ['zone', 'route', 'trainLink', 'line', 'polygon'];
// Fare.required (OSDM 3.8), and passengerRefs, which the wiki scenario asks for (#903 O2).
const REQUIRED = ['id', 'type', 'prices', 'regionalConstraint', 'travelClass', 'afterSalesCondition', 'combinationConstraint', 'travelValidityConstraint', 'passengerRefs'];
const NON_EMPTY = new Set(['prices', 'combinationConstraint', 'passengerRefs']);
const MAX_LISTED = 5;

const list = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stationOf = (place) => (isObject(place) ? place.stopPlaceRef || place.id || null : null);

/** The offer parts a request asks for, [] when it names none. */
const partsOf = (request) => list(request?.offerSearchCriteria?.requestedOfferParts);

/** Does the request ask for fares? */
function asksFares(request) {
  return partsOf(request).some((p) => p === 'ALL' || String(p).startsWith('FARE_'));
}

/** #255: does the request ask for fares other than reservations (admissions, ancillaries, ALL)? */
function asksFareProducts(request) {
  return typesAsked(request).some((type) => type !== 'RESERVATION');
}

/** The fare types the request asks for: the three for ALL. */
function typesAsked(request) {
  const parts = partsOf(request);
  if (parts.includes('ALL')) return [...FARE_TYPES];
  return parts.map((p) => TYPE_OF_PART[p]).filter(Boolean);
}

/** Every (offer, fare) of the answer, with a path for messages. */
function faresOf(response) {
  return list(response?.offers).flatMap((offer, i) => list(offer.fares).map((fare, j) => ({
    offer, fare, path: `offers[${i}].fares[${j}]`,
  })));
}

// An offer of fares: one holding fares, or fare reservations (#255).
const fareOffersOf = (response) => list(response?.offers).filter(fareReservations.hasFareParts);

// One check over many places: ok when none breaks the rule.
function check(id, level, title, broken, explain) {
  const shown = broken.slice(0, MAX_LISTED).join('; ');
  const more = broken.length > MAX_LISTED ? ` and ${broken.length - MAX_LISTED} more` : '';
  return { id, level, title, ok: broken.length === 0, message: broken.length ? `${explain}: ${shown}${more}` : '' };
}

function missingFareMembers(fare) {
  return REQUIRED.filter((key) => {
    const v = fare?.[key];
    if (v === undefined || v === null || v === '') return true;
    return NON_EMPTY.has(key) && (!Array.isArray(v) || v.length === 0);
  });
}

function regionalIssues(all) {
  const noList = [];
  const emptyItems = [];
  for (const { fare, path } of all) {
    const validities = fare?.regionalConstraint?.regionalValidities;
    if (!Array.isArray(validities) || validities.length === 0) { noList.push(path); continue; }
    validities.forEach((item, k) => {
      if (!REGIONAL_KINDS.some((kind) => item?.[kind] != null)) emptyItems.push(`${path}.regionalConstraint.regionalValidities[${k}]`);
    });
  }
  return { noList, emptyItems };
}

// The travel day within validTravelDates (from/until), when both are given.
function dayOutside(fare, travelDay) {
  const dates = fare?.travelValidityConstraint?.validTravelDates;
  if (!travelDay || !isObject(dates) || !dates.from || !dates.until) return false;
  const day = String(travelDay).slice(0, 10);
  return day < String(dates.from).slice(0, 10) || day > String(dates.until).slice(0, 10);
}

// The stations a route item stands for: its station, the stations of its
// fare reference station, else those of the first or last item it names.
function routeItemStations(item, items, which, depth = 0) {
  if (!isObject(item) || depth > 20) return [];
  if (isObject(item.station)) return [stationOf(item.station)].filter(Boolean);
  if (isObject(item.fareReferenceStation)) return list(item.fareReferenceStation.stations).map(stationOf).filter(Boolean);
  const indices = list(item.routeItemIndices).length ? list(item.routeItemIndices) : list(item.alternativeRouteItemIndices);
  const pick = which === 'first' ? indices[0] : indices.at(-1);
  if (indices.length > 1 && list(item.alternativeRouteItemIndices).length && !list(item.routeItemIndices).length) {
    return indices.flatMap((i) => routeItemStations(items[i], items, which, depth + 1));
  }
  return pick === undefined ? [] : routeItemStations(items[pick], items, which, depth + 1);
}

/**
 * #1045: the stations a fare's route runs from and to: the first and last
 * items of its route item (OSDM 3.8 Route), else of its list as given. null
 * when the route names no station at either end.
 */
function routeEndsOf(fare) {
  const route = list(fare?.regionalConstraint?.regionalValidities).map((v) => v?.route).find(isObject);
  if (!route) return null;
  const items = list(route.routeItemList);
  const top = list(route.routeItem?.routeItemIndices).length ? route.routeItem.routeItemIndices.map((i) => items[i]) : items;
  const start = routeItemStations(top[0], items, 'first');
  const end = routeItemStations(top.at(-1), items, 'last');
  return top.length > 1 && start.length && end.length ? { start, end } : null;
}

// The [start, end] stations a fare covers: its coveredSection, else its entry
// and exit connection points, else its route's ends, else the covered
// sections of its offer (#1045: a real provider gives the last two only).
// null when none says.
function coveredOf(fare, offer) {
  const section = fare?.coveredSection;
  if (isObject(section) && stationOf(section.startPlace) && stationOf(section.endPlace)) {
    return { start: [stationOf(section.startPlace)], end: [stationOf(section.endPlace)] };
  }
  const points = (cp) => list(cp?.stationSets).flatMap((set) => list(set.stations).map(stationOf)).filter(Boolean);
  const start = points(fare?.regionalConstraint?.entryConnectionPoint);
  const end = points(fare?.regionalConstraint?.exitConnectionPoint);
  if (start.length && end.length) return { start, end };
  return routeEndsOf(fare) || fareDetails.offerSectionEnds(offer);
}

const among = (station, stations) => stations.some((s) => sameStopPlace(s, station));

/**
 * How one passenger's fares cover the section: 'covered', 'gap', 'overlap'
 * (covered, with fares left over) or 'unknown' (a fare that does not say
 * what it covers). From the section's start, each step takes a fare starting
 * where the last one ended, one reaching the end first.
 */
function coverageOfPassenger(fares, section, spanOf = coveredOf) {
  const spans = fares.map((fare) => spanOf(fare));
  if (spans.includes(null)) return 'unknown';
  const left = [...spans];
  let at = section.start;
  for (let steps = 0; steps <= spans.length; steps++) {
    if (sameStopPlace(at, section.end)) return left.length ? 'overlap' : 'covered';
    const from = left.filter((s) => among(at, s.start));
    if (from.length === 0) return 'gap';
    const next = from.find((s) => among(section.end, s.end)) || from[0];
    left.splice(left.indexOf(next), 1);
    at = next.end[0];
  }
  return 'gap';
}

function sectionOf(request) {
  const first = list(request?.requestedSections)[0];
  const start = stationOf(first?.startPlace);
  const end = stationOf(first?.endPlace);
  return start && end ? { start, end } : null;
}

// O7, O8: per offer, each passenger's fares.
function passengerChecks(response, request) {
  const passengers = list(request?.anonymousPassengerSpecifications).map((p) => p.externalRef).filter(Boolean);
  const bicycles = new Set(fareReservations.bicycleRefsOf(request));
  const section = sectionOf(request);
  const withoutFare = [];
  const gaps = [];
  const overlaps = [];
  const unknown = [];
  list(response?.offers).forEach((offer, i) => {
    const fares = list(offer.fares);
    if (fares.length === 0) return;
    // #255: a bicycle travels on its reservation, without a fare (its mode is V1's).
    const reserved = new Set(list(offer.reservationOfferParts).flatMap((r) => list(r.passengerRefs)).filter((ref) => bicycles.has(ref)));
    for (const ref of passengers) {
      const own = fares.filter((f) => list(f.passengerRefs).includes(ref));
      if (own.length === 0 && reserved.has(ref)) continue;
      if (own.length === 0) { withoutFare.push(`passenger ${ref} in offers[${i}]`); continue; }
      if (!section) continue;
      const how = coverageOfPassenger(own, section, (fare) => coveredOf(fare, offer));
      if (how === 'gap') gaps.push(`passenger ${ref} in offers[${i}]`);
      if (how === 'overlap') overlaps.push(`passenger ${ref} in offers[${i}]`);
      if (how === 'unknown') unknown.push(`passenger ${ref} in offers[${i}]`);
    }
  });
  return { withoutFare, gaps, overlaps, unknown, section };
}

// O9 to O11: the combination constraints.
function combinationIssues(all) {
  const models = [];
  const reference = [];
  const allowed = [];
  const wider = [];
  for (const { fare, path } of all) {
    list(fare?.combinationConstraint).forEach((c, k) => {
      const at = `${path}.combinationConstraint[${k}]`;
      if (!COMBINATION_MODELS.includes(c?.model)) models.push(`${at}.model = ${JSON.stringify(c?.model)}`);
      if (c?.model !== 'CLUSTERING') return;
      if (!CLUSTERS.includes(c.referenceCluster)) reference.push(`${at}.referenceCluster = ${JSON.stringify(c.referenceCluster)}`);
      const outside = list(c.allowedClusters).filter((x) => !CLUSTERS.includes(x));
      if (outside.length) allowed.push(`${at}.allowedClusters holds ${outside.join(', ')}`);
      const rank = CLUSTERS.indexOf(c.referenceCluster);
      const more = rank < 0 ? [] : list(c.allowedClusters).filter((x) => CLUSTERS.includes(x) && CLUSTERS.indexOf(x) < rank);
      if (more.length) wider.push(`${at} (${c.referenceCluster}) allows ${more.join(', ')}`);
    });
  }
  return { models, reference, allowed, wider };
}

function negativePrices(all) {
  return all.flatMap(({ fare, path }) => list(fare?.prices)
    .map((p, k) => ({ p, k }))
    .filter(({ p }) => Number(p?.amount) < 0)
    .map(({ p, k }) => `${path}.prices[${k}].amount = ${p.amount}`));
}

/**
 * The checks of the fares of an answer to a request that asks for them
 * (O1 to O13, O15). Each: { id, level: FAIL | WARNING | INFO, title, ok, message }.
 */
function fareChecks(response, request, { travelDay } = {}) {
  const all = faresOf(response);
  const offers = list(response?.offers).filter((o) => list(o.fares).length > 0);
  const first = check('O1', 'FAIL', 'At least one offer holds fares (offers[].fares)', offers.length ? [] : ['no offer'],
    'the request asks for fares and names a section, but no offer holds any');
  if (offers.length === 0) return [first];
  const types = typesAsked(request);
  const regional = regionalIssues(all);
  const providerFee = all.filter(({ fare }) => fare?.afterSalesCondition?.isProviderFee === true).length;
  const pax = passengerChecks(response, request);
  const combination = combinationIssues(all);
  return [
    first,
    check('O2', 'FAIL', 'Each fare has the members OSDM requires (Fare.required, passengerRefs)',
      all.map(({ fare, path }) => ({ path, missing: missingFareMembers(fare) })).filter((x) => x.missing.length).map((x) => `${x.path} lacks ${x.missing.join(', ')}`),
      'members missing or empty'),
    check('O3', 'FAIL', `Each fare is of a type asked (${types.join(', ') || 'none'})`,
      all.filter(({ fare }) => !types.includes(fare?.type)).map(({ fare, path }) => `${path}.type = ${JSON.stringify(fare?.type)}`),
      `fare types outside ${types.join(' / ')} (OSDM allows no provider-specific value here, #242 D2)`),
    check('O4', 'FAIL', 'Each fare has regional validities (regionalConstraint.regionalValidities)', regional.noList, 'no regional validity'),
    check('O4', 'WARNING', 'Each regional validity names a zone, route, train link, line or polygon', regional.emptyItems, 'an empty regional validity'),
    check('O5', 'FAIL', 'Each fare has after-sales conditions (afterSalesCondition.conditions)',
      all.filter(({ fare }) => list(fare?.afterSalesCondition?.conditions).length === 0).map(({ path }) => path), 'no after-sales condition'),
    { id: 'O5', level: 'INFO', title: 'After-sales fees attributed to the provider (isProviderFee)', ok: true,
      message: `${providerFee} of ${all.length} fare(s) say the after-sales fees are the provider's` },
    check('O6', 'FAIL', 'Each fare has a validity range (travelValidityConstraint.validityRange)',
      all.filter(({ fare }) => !isObject(fare?.travelValidityConstraint?.validityRange)).map(({ path }) => path), 'no validity range'),
    check('O6', 'WARNING', 'The travel day lies within each fare\'s valid travel dates',
      all.filter(({ fare }) => dayOutside(fare, travelDay)).map(({ path }) => path), `the travel day ${String(travelDay || '').slice(0, 10)} is outside the valid travel dates`),
    check('O7', 'FAIL', 'Every passenger has a fare in each fare offer (a free one priced 0)', pax.withoutFare, 'passengers without a fare'),
    ...sectionChecks(pax),
    check('O9', 'WARNING', 'Each combination model is one of the YAML list (SEPARATE_TICKET, SEPARATE_CONTRACT, CLUSTERING, COMBINING)', combination.models, 'models outside the list'),
    check('O10', 'WARNING', 'CLUSTERING: the reference cluster is one of BUSINESS, FULL_FLEX, SEMI_FLEX, NON_FLEX, PROMO', combination.reference, 'reference clusters outside the list'),
    check('O10', 'WARNING', 'CLUSTERING: the allowed clusters are from the same list', combination.allowed, 'allowed clusters outside the list'),
    check('O11', 'WARNING', 'CLUSTERING: no allowed cluster is more flexible than the reference one', combination.wider, 'allowed clusters more flexible than the reference'),
    check('O12', 'WARNING', 'Each fare names the TCOs involved (involvedTCOs)',
      all.filter(({ fare }) => list(fare?.involvedTCOs).length === 0).map(({ path }) => path), 'no involvedTCOs'),
    check('O13', 'FAIL', 'No fare price is negative', negativePrices(all), 'negative prices'),
    ...detailChecks(response, request, all, travelDay),
    countCheck(response),
  ];
}

// O16 to O20 (#1045): what a fare says of its passengers, cards, class,
// dates and coverage, against the request (`fareDetails.js`).
function detailChecks(response, request, all, travelDay) {
  const cards = fareDetails.cardIssues(all, request);
  return [
    check('O16', 'WARNING', 'A fare requiring cards names one its passengers hold (requiredCards)', cards.notHeld,
      'cards required that no passenger of the fare declared (OSDM: one of them is required at the time of travel)'),
    check('O16', 'WARNING', 'A requiredCards list names at least one card', cards.empty, 'empty lists (OSDM: at least one item when the list is given)'),
    check('O17', 'WARNING', "A fare's passenger constraints hold its passenger's age on the travel day", fareDetails.ageIssues(all, request, travelDay),
      "ages outside the fare's passenger constraints"),
    check('O18', 'WARNING', 'A fare offer is in each travel class asked (travelClasses)', fareDetails.classIssues(response, request),
      'classes asked with no fare offer in them'),
    check('O19', 'WARNING', 'Valid travel dates: utcOffset agrees with the offset of the dates', fareDetails.datesOffsetIssues(all),
      'offsets that disagree (OSDM: utcOffset is the minutes added to get UTC)'),
    check('O20', 'WARNING', "An offer's covered sections name train legs of its trip", fareDetails.offerCoverageIssues(response),
      "covered sections naming a leg that is not one of the trip's trains"),
  ];
}

// O8: the coverage of the requested section, when the request names one.
function sectionChecks(pax) {
  if (!pax.section) return [];
  return [
    check('O8', 'FAIL', 'Each passenger\'s fares cover the requested section without a gap', pax.gaps,
      `fares that leave part of the section ${pax.section.start} - ${pax.section.end} uncovered`),
    check('O8', 'WARNING', 'Each passenger\'s fares do not overlap', pax.overlaps, 'fares covering a part of the section twice'),
    check('O8', 'WARNING', "Each fare says what it covers (coveredSection, else entry and exit connection points, its route's ends or its offer's covered sections)", pax.unknown,
      'the coverage of the section cannot be checked'),
  ];
}

/** O15: how many offers hold products, and how many fares. */
function countCheck(response) {
  const offers = list(response?.offers);
  const withProducts = offers.filter((o) => list(o.products).length || list(o.admissionOfferParts).length).length;
  const withFares = offers.filter((o) => list(o.fares).length).length;
  return { id: 'O15', level: 'INFO', title: 'Offers with products and with fares', ok: true,
    message: `${offers.length} offer(s): ${withProducts} with products, ${withFares} with fares` };
}

/**
 * O14: fares in the answer though the request named its offer parts without
 * FARE_* or ALL. Null when the request named none (OSDM: all types then).
 */
function unaskedFaresCheck(response, request) {
  const parts = partsOf(request);
  if (parts.length === 0 || asksFares(request)) return null;
  const fares = faresOf(response).length;
  return check('O14', 'FAIL', `No fare when the request asks for ${parts.join(', ')} only`, fares ? [`${fares} fare(s)`] : [],
    'fares that were not asked (OSDM DistributionMode: without FARE_* the answer holds products)');
}

/**
 * The checks of a scenario that expects no fare (#905). When the request
 * named its offer parts without FARE_* or ALL, O14 says it already; otherwise
 * (fares asked, or no offer part named) check N does. O15 counts the offers.
 */
function noFareChecks(response, request) {
  const unasked = unaskedFaresCheck(response, request);
  const fares = faresOf(response).length;
  const offers = fareOffersOf(response).length;
  const reservations = fareReservations.fareReservationCount(response);
  const found = [];
  if (fares) found.push(`${fares} fare(s) in ${offers} offer(s)`);
  if (reservations) found.push(`${reservations} fare reservation(s)`);
  const none = unasked || check('N', 'FAIL', 'No fare in the answer, as the scenario expects (expectFares: false)',
    found,
    'fares though the scenario expects none (the Test Manager\'s expectation for this provider, #242 D4)');
  return [none, countCheck(response)];
}

/**
 * The fare offer a scenario books: the first holding fares, of the cluster
 * asked when one is. null when none fits.
 */
function chooseFareOffer(response, desiredCluster) {
  const offers = fareOffersOf(response);
  if (!desiredCluster) return offers[0] || null;
  return offers.find((o) => list(o.fares).some((f) => list(f.combinationConstraint).some((c) => c?.referenceCluster === desiredCluster))) || null;
}

const BOOK_MODES = new Set(['FARE', 'PRODUCT']);

// A station of the data file as an OSDM StopPlaceRef: a URN as it is, a bare
// UIC code as urn:uic:stn:<code>. null for anything else.
function stopPlaceRefOf(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/^\d{5,9}$/.test(text)) return { objectType: 'StopPlaceRef', stopPlaceRef: `urn:uic:stn:${text}` };
  if (/^urn:[^\s]{3,117}$/.test(text)) return { objectType: 'StopPlaceRef', stopPlaceRef: text };
  return null;
}

// A yes/no field of the data file: true, false, or null when not given.
function flagOf(value) {
  const text = String(value);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}

/**
 * The fare fields of a scenario (#903, #905): the requested sections as OSDM
 * Sections, the international flag (true, false or null), the cluster to
 * book, the booking mode (null when not named) and whether fares are
 * expected (false for a negative scenario, else null). Sections that name no
 * usable station on both ends are left out. `emptySectionList` is true when
 * the scenario holds an empty list, which a fare request then sends as it is
 * (#905 N4). `fareRefundFee` (#907) is the fee OSCAR states in the refund of a
 * CLUSTERING fare, in cents, or null.
 */
function fareFieldsOf(scenario) {
  const raw = scenario?.requestedSections;
  const requestedSections = list(raw)
    .map((s) => ({ startPlace: stopPlaceRefOf(s?.startPlace), endPlace: stopPlaceRefOf(s?.endPlace) }))
    .filter((s) => s.startPlace && s.endPlace);
  const cluster = String(scenario?.desiredFareCluster || '').toUpperCase();
  const mode = String(scenario?.bookMode || '').toUpperCase();
  return {
    requestedSections,
    emptySectionList: Array.isArray(raw) && raw.length === 0,
    isPartOfInternationalTrip: flagOf(scenario?.isPartOfInternationalTrip),
    desiredFareCluster: CLUSTERS.includes(cluster) ? cluster : null,
    bookMode: BOOK_MODES.has(mode) ? mode : null,
    expectFares: flagOf(scenario?.expectFares) === false ? false : null,
    fareRefundFee: require('./fareRefund.js').feeAmountOf(scenario?.fareRefundFee),
  };
}

/**
 * The requested sections an offer request carries: the scenario's sections;
 * an empty list only when the scenario holds one and the request asks for
 * fares (#905 N4); else none (undefined).
 */
function sectionsToSend(requestedSections, offerSearchCriteria) {
  if (!Array.isArray(requestedSections)) return undefined;
  if (requestedSections.length > 0) return requestedSections;
  return asksFares({ offerSearchCriteria }) ? [] : undefined;
}

// ── The requested sections against the trip (#904) ─────────────────────────

// A PlaceRef as its id text: a StopPlaceRef, or a board/alight point holding one.
function placeOf(point) {
  if (typeof point === 'string') return point;
  if (!isObject(point)) return null;
  if (typeof point.stopPlaceRef === 'string') return point.stopPlaceRef;
  if (isObject(point.stopPlaceRef)) return placeOf(point.stopPlaceRef);
  return typeof point.id === 'string' ? point.id : null;
}

// The stations of legs, in order: each leg's start, its intermediate stops, its end.
function stationsOfLegs(legs) {
  const out = [];
  for (const leg of list(legs)) {
    const timed = leg?.timedLeg || leg?.transferLeg || leg?.continuousLeg || leg;
    for (const point of [timed?.start, ...list(timed?.intermediates), timed?.end]) {
      const station = placeOf(point);
      if (station && !(out.length && sameStopPlace(out.at(-1), station))) out.push(station);
    }
  }
  return out;
}

/**
 * The stations the trip of an offer request gives, in order, and whether
 * they are all of the trip's (`complete`): a trip specification and a trip
 * chosen by id give every leg; search criteria only the origin, the vias and
 * the destination. null when the request names no trip.
 */
function tripStationsOf(request, chosenTripLegs) {
  if (list(request?.tripIds).length > 0) {
    const stations = stationsOfLegs(chosenTripLegs);
    return stations.length ? { stations, complete: true } : null;
  }
  if (list(request?.tripSpecifications).length > 0) {
    const stations = stationsOfLegs(list(request.tripSpecifications).flatMap((t) => list(t?.legs)));
    return stations.length ? { stations, complete: true } : null;
  }
  const criteria = request?.tripSearchCriteria;
  if (!isObject(criteria)) return null;
  const stations = [criteria.origin, ...list(criteria.vias).map((v) => v?.viaPlace), criteria.destination].map(placeOf).filter(Boolean);
  return stations.length ? { stations, complete: false } : null;
}

const indexIn = (stations, station, from = 0) => stations.findIndex((s, i) => i >= from && sameStopPlace(s, station));

/**
 * The requested sections that do not lie inside the trip, as sentences ([]
 * when all do). Against a complete list of stations a section must start at
 * one of them and end at a later one. Against search criteria, whose other
 * stops are not known before the answer, only a section between two of the
 * stations given, in the wrong order, is outside.
 */
function sectionsOutsideTrip(request, chosenTripLegs) {
  const trip = tripStationsOf(request, chosenTripLegs);
  if (!trip) return [];
  const shown = trip.stations.join(', ');
  const out = [];
  list(request?.requestedSections).forEach((section, i) => {
    const start = placeOf(section?.startPlace);
    const end = placeOf(section?.endPlace);
    if (!start || !end) return;
    const name = `requestedSections[${i}] ${start} - ${end}`;
    const at = indexIn(trip.stations, start);
    const to = at < 0 ? -1 : indexIn(trip.stations, end, at + 1);
    if (trip.complete) {
      if (at < 0) out.push(`${name} starts at a station that is not on the trip (${shown})`);
      else if (to < 0) out.push(`${name} does not end at a station after its start on the trip (${shown})`);
      return;
    }
    if (at >= 0 && to < 0 && indexIn(trip.stations, end) >= 0) out.push(`${name} runs against the direction of the search (${shown})`);
  });
  return out;
}

/** The offers that hold products (or no fares): what the product checks look at. */
function productOffersOf(response) {
  return list(response?.offers).filter((o) => !fareReservations.hasFareParts(o) || list(o.products).length || list(o.admissionOfferParts).length);
}

// ── Bruno glue ──────────────────────────────────────────────────────────────

function readJson(name) {
  const raw = bru.getEnvVar(name);
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || 'null'); } catch { return null; }
}

function record(c) {
  if (c.level === 'FAIL') {
    test(`[fares ${c.id}] ${c.title}`, () => { if (!c.ok) throw new Error(c.message); });
  } else if (c.level === 'WARNING') {
    if (!c.ok) validationLogger(`[WARNING] [fares ${c.id}] ${c.title} — ${c.message}`);
  } else {
    validationLogger(`[INFO] [fares ${c.id}] ${c.message}`);
  }
}

/**
 * Step 01, after a 200, for a scenario that expects no fare (#905): check N
 * (or O14) and the count. The answer goes on without its fare-only offers.
 * The scenario ends here (true) unless it books a product (bookMode
 * PRODUCT), whose sale then goes on (false).
 */
function checkNoFares(body, request) {
  if (asksFares(request) && list(request.requestedSections).length === 0) {
    validationLogger('[INFO] [fares] No requested section, on purpose: the scenario expects no fare (#905).');
  }
  for (const c of noFareChecks(body, request)) record(c);
  if (fareOffersOf(body).length > 0 && Array.isArray(body?.offers)) body.offers = productOffersOf(body);
  if (bru.getEnvVar('bookMode') === 'PRODUCT') {
    validationLogger('[INFO] [fares] The scenario expects no fare and books a product: the sale goes on with the product offers.');
    return false;
  }
  validationLogger('[INFO] [fares] The scenario expects no fare: it ends after the offer step.');
  return true;
}

/**
 * Step 01, after a 200. A scenario that expects no fare is checkNoFares().
 * A request that asks for fares has its fares checked and ends here (booking
 * a fare is #906): true. Otherwise only O14 is checked, and the answer goes
 * on without its fare-only offers: false.
 */
function checkFareOffers(body) {
  const request = readJson('OfferCollectionRequest') || {};
  if (String(bru.getEnvVar('expectFares')) === 'false') return checkNoFares(body, request);
  // #255: fare reservations that were not asked.
  const unaskedReservations = fareReservations.unaskedReservationsCheck(body, request);
  if (!asksFares(request)) return checkUnaskedFares(body, request, unaskedReservations);
  if (list(request.requestedSections).length === 0) {
    validationLogger('[WARNING] [fares] The request asks for fares without a requested section; OSDM asks for one when trips are given (processes).');
  }
  const checks = offerStepChecks(body, request, unaskedReservations);
  for (const c of checks) record(c);
  const desired = bru.getEnvVar('desiredFareCluster') || null;
  const chosen = chooseFareOffer(body, desired);
  if (desired) {
    test(`[fares] An offer holds fares of cluster ${desired} (desiredFareCluster)`, () => {
      if (!chosen) throw new Error(`no fare offer has the reference cluster ${desired}`);
    });
  }
  if (chosen) bru.setEnvVar('fareOfferId', chosen.offerId);
  // #906: a product booked although fares were asked: the sale goes on with the product offers.
  if (bru.getEnvVar('bookMode') === 'PRODUCT') {
    if (Array.isArray(body?.offers)) body.offers = productOffersOf(body);
    validationLogger('[INFO] [fares] The scenario books a product (bookMode PRODUCT): the sale goes on with the product offers.');
    return false;
  }
  // #906: the fare offer chosen is booked, unless a FAIL-level check of it failed.
  const decision = fareSaleDecision(checks, chosen);
  if (decision.book) bookFareOffer(chosen);
  validationLogger(`[INFO] [fares] ${decision.reason}`);
  return true;
}

// Step 01 when the request asks for no fare: only O14 and V8 are checked, and
// the answer goes on without its fare-only offers (false: the sale goes on).
function checkUnaskedFares(body, request, unaskedReservations) {
  const unasked = unaskedFaresCheck(body, request);
  if (unasked) record(unasked);
  if (unaskedReservations) record(unaskedReservations);
  if (fareOffersOf(body).length > 0 && Array.isArray(body?.offers)) {
    body.offers = productOffersOf(body);
    validationLogger('[INFO] [fares] Offers holding fares only are left out of the product checks.');
  }
  return false;
}

// The checks of step 01 for a request that asks for fares. A request for fare
// reservations alone checks no fare, unless the answer holds some (#255).
function offerStepChecks(body, request, unaskedReservations) {
  const fareRules = asksFareProducts(request) || faresOf(body).length > 0
    ? fareChecks(body, request, { travelDay: bru.getEnvVar('__travelDay') })
    : [countCheck(body)];
  return [
    ...fareRules,
    ...fareReservations.offerChecks(body, request, { osdmVersion: bru.getEnvVar('osdmVersion') }),
    ...(unaskedReservations ? [unaskedReservations] : []),
  ];
}

// #906: the fare offer chosen is the one booked. #255: OSDM books only the
// mandatory reservations unless they are selected, so its fare reservations are.
function bookFareOffer(chosen) {
  bru.setEnvVar('__fareSale', 'true');
  bru.setEnvVar('offer', chosen);
  bru.setEnvVar('offerId', chosen.offerId);
  const selections = fareReservations.selectionsFor(chosen);
  if (selections.length > 0) {
    bru.setEnvVar('optionalReservationSelections', JSON.stringify(selections));
    validationLogger(`[INFO] [fares] ${selections.length} fare reservation(s) of the offer selected for the booking (optionalReservationSelections).`);
  }
}

/**
 * #906: whether the fare offer chosen is booked: there is one, and no check of
 * the offer step that OSDM states as a rule failed. Booking an offer whose
 * fares broke one would test nothing reliable.
 */
function fareSaleDecision(checks, chosen) {
  if (!chosen) return { book: false, reason: 'No fare offer chosen: the scenario ends after the offer step.' };
  const failed = list(checks).filter((c) => c.level === 'FAIL' && !c.ok).map((c) => c.id);
  if (failed.length > 0) {
    return { book: false, reason: `Fare offer ${chosen.offerId} is not booked: the offer step failed ${[...new Set(failed)].join(', ')}. The scenario ends here.` };
  }
  return { book: true, reason: `Fare offer chosen: ${chosen.offerId} (${list(chosen.fares).length} fare(s)). It is booked next (#906).` };
}

/** #906: the scenario is booking a fare offer (step 01 decided it). */
function isFareSale() {
  return bru.getEnvVar('__fareSale') === 'true';
}

/**
 * Step 01's before-request (#904): the requested sections that do not lie
 * inside the trip are kept for the after-response, which fails the scenario
 * on them before reading the answer: a broken scenario is not the
 * provider's failure. The trip chosen by id comes from `__chosenTripLegs`.
 */
function prepareSectionCheck() {
  const request = readJson('OfferCollectionRequest') || {};
  const outside = asksFares(request) ? sectionsOutsideTrip(request, readJson('__chosenTripLegs')) : [];
  bru.setEnvVar('__fareSectionsOutside', outside.length ? JSON.stringify(outside) : null);
  for (const line of outside) validationLogger(`[ERROR] [fares] The scenario's own data: ${line}. The answer will not be checked.`);
}

/** Step 01's after-response, first: true when the scenario stops on its sections. */
function stopOnSectionsOutside() {
  const outside = list(readJson('__fareSectionsOutside'));
  if (outside.length === 0) return false;
  test('[fares] The requested sections lie inside the trip (the scenario\'s own data, not the provider\'s answer)', () => {
    throw new Error(outside.join('; '));
  });
  return true;
}

module.exports = {
  CLUSTERS, COMBINATION_MODELS, missingFareMembers, fareSaleDecision, isFareSale, stopPlaceRefOf, fareFieldsOf, sectionsToSend, asksFares, asksFareProducts, typesAsked, fareChecks, unaskedFaresCheck, fareOffersOf,
  noFareChecks, chooseFareOffer, coverageOfPassenger, productOffersOf, checkFareOffers, tripStationsOf, sectionsOutsideTrip,
  prepareSectionCheck, stopOnSectionsOutside,
};
