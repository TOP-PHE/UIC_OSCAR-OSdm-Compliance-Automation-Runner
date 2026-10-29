// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1047: a small OSDM offline fare delivery in the shape of DB's 2024.02,
// made by hand: two regions read (35047, a station to a station; 23711, a
// border point to a station set by a route with alternatives), one region
// not read, the doubled child card fare DB's delivery has, and a dog priced
// like the child. Codes are made up; only their shapes are DB's.

const P = (kind, n) => `1080_2024.02_${kind}__${n}`;
const stn = (code) => ({ codeList: 'UIC', code, country: 'XX' });
const item = (extra) => ({ isBorder: false, alternativeRoute: [], route: [], routeValidityType: 'LINE', stop: false, technicalViaOnly: false, ...extra });

function fareOf(n, region, { name = 9, cls = 'BASIC', pax = 1, card = null, bundle = 1, price }) {
  return {
    id: `fare-${n}`,
    bundleRef: P('S', bundle),
    fareType: 'ADMISSION',
    nameRef: P('P', name),
    priceRef: P('I', price),
    regionalConstraintRef: P('K', region),
    carrierConstraintRef: P('C', 1),
    regulatoryConditions: ['CIV'],
    serviceClassRef: cls,
    passengerConstraintRef: P('G', pax),
    legacyAccountingIdentifier: { serialId: 78, addId: 0, tariffId: 10001 },
    legacyConversion: 'YES',
    individualContracts: false,
    involvedTCOs: ['1080', '1181', '1185'],
    ...(card ? { reductionConstraintRef: P('K', card) } : {}),
  };
}

function delivery() {
  return {
    fareDelivery: {
      delivery: { fareProvider: '1080', deliveryId: '2024.02', previousDeliveryId: '2024.01', version: '3.1', usage: 'PRODUCTION' },
      fareStructure: {
        calendars: [{ id: P('B', 1), fromDate: '2024-12-14T23:00:00+0000', untilDate: '2025-12-13T22:59:59+0000', dates: [], utcOffset: 60 }],
        serviceClassDefinitions: [
          { id: 'HIGH', textRef: P('P', 10), comfortClass: 'FIRST', travelClass: 'FIRST' },
          { id: 'BASIC', textRef: P('P', 11), comfortClass: 'SECOND', travelClass: 'SECOND' },
        ],
        texts: [
          { id: P('P', 9), text: 'Flexpreis' },
          { id: P('P', 21), text: 'Gruppe&Spar' },
          { id: P('P', 50), text: 'Fahrrad' },
          { id: P('P', 60), text: 'A "quoted" {brace} [bracket] and a \\ backslash' },
        ],
        prices: [
          [1, 1000], [2, 500], [3, 750], [4, 375], [5, 250], [6, 800], [7, 1600], [8, 300],
        ].map(([n, amount]) => ({ id: P('I', n), price: [{ currency: 'EUR', amount, scale: 2, vatDetails: [] }] })),
        regionalConstraints: [
          {
            id: P('K', 9),
            entryConnectionPointId: P('E', 1),
            exitConnectionPointId: P('E', 2),
            regionalValidity: [{ seqNb: 1, viaStations: item({ carrierConstraintRef: P('C', 1), route: [item({ station: stn('9900001') }), item({ station: stn('9900002') })] }) }],
            distance: 12,
          },
          {
            id: P('K', 35047),
            entryConnectionPointId: P('E', 1),
            exitConnectionPointId: P('E', 2),
            regionalValidity: [{ seqNb: 1, viaStations: item({ carrierConstraintRef: P('C', 1), route: [item({ station: stn('9900001') }), item({ station: stn('9900002') })] }) }],
            distance: 39,
          },
          {
            id: P('K', 23711),
            entryConnectionPointId: P('E', 3),
            exitConnectionPointId: P('E', 4),
            regionalValidity: [{
              seqNb: 1,
              viaStations: item({
                carrierConstraintRef: P('C', 1),
                route: [
                  item({ fareReferenceStationSet: { carrier: '1080', code: '20060', name: 'Setone' } }),
                  item({ alternativeRoute: [
                    item({ fareReferenceStationSet: { carrier: '1080', code: '2140', name: 'Settwo' } }),
                    item({ route: [item({ station: stn('9900005'), stop: true }), item({ fareReferenceStationSet: { carrier: '1080', code: '22193', name: 'Setthree' } })] }),
                  ] }),
                  item({ station: stn('9900006'), isBorder: true }),
                ],
              }),
            }],
            distance: 1010,
          },
        ],
        carrierConstraints: [{ id: P('C', 1), includedCarrier: ['1080', '1181', '1185'], excludedCarrier: [] }],
        passengerConstraints: [
          { id: P('G', 1), passengerType: 'ADULT', nameRef: P('P', 18), upperAgeLimit: 150, lowerAgeLimit: 15, ageLimitToTravelAlone: 0, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [{ maxNumber: 10, minNumber: 0, passengerConstraintRef: P('G', 5) }], includedFreePassenger: [{ number: 10, passengerConstraintRef: P('G', 7) }], passengerWeight: 1 },
          { id: P('G', 3), passengerType: 'CHILD', nameRef: P('P', 19), upperAgeLimit: 14, lowerAgeLimit: 6, ageLimitToTravelAlone: 0, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [], includedFreePassenger: [], passengerWeight: 1 },
          { id: P('G', 5), passengerType: 'DOG', nameRef: P('P', 22), upperAgeLimit: 100, lowerAgeLimit: 0, ageLimitToTravelAlone: 150, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [], includedFreePassenger: [], passengerWeight: 0 },
          { id: P('G', 7), passengerType: 'YOUNG_CHILD', nameRef: P('P', 20), upperAgeLimit: 5, lowerAgeLimit: 0, ageLimitToTravelAlone: 0, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [], includedFreePassenger: [], passengerWeight: 0 },
          { id: P('G', 11), passengerType: 'BICYCLE', nameRef: P('P', 50), upperAgeLimit: 999, lowerAgeLimit: 0, ageLimitToTravelAlone: 0, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [], includedFreePassenger: [], passengerWeight: 0 },
          { id: P('G', 12), passengerType: 'ADULT', nameRef: P('P', 18), upperAgeLimit: 150, lowerAgeLimit: 15, ageLimitToTravelAlone: 0, ageLimitForReservation: 0, isAncillaryItem: false, combinationConstraint: [], includedFreePassenger: [], passengerWeight: 1 },
        ],
        fareConstraintBundles: [1, 2].map((n) => ({
          id: P('S', n),
          combinationConstraintRef: P('D', 1),
          salesAvailabilityConstraintRef: P('M', 1),
          travelValidityConstraintRef: P('Q', 1),
          fulfillmentConstraintRef: P('E', 1196),
          passengerCombinationConstraintRef: P('T', n),
          defaultFareType: 'ADMISSION',
          defaultRegulatoryConditions: [],
          products: [],
        })),
        passengerCombinationConstraints: [
          { id: P('T', 1), maxWeightedPassengers: 5, minWeightedPassengers: 1 },
          { id: P('T', 2), maxWeightedPassengers: 99, minWeightedPassengers: 6 },
        ],
        fares: [
          fareOf(1, 9, { price: 1 }),
          fareOf(2, 35047, { price: 1 }),
          fareOf(3, 35047, { card: 3, price: 3 }),
          fareOf(4, 35047, { card: 3, price: 4 }),
          fareOf(5, 35047, { pax: 3, price: 2 }),
          fareOf(6, 35047, { pax: 3, card: 1, price: 5 }),
          fareOf(7, 35047, { pax: 5, price: 2 }),
          fareOf(8, 35047, { name: 50, pax: 11, price: 6 }),
          fareOf(9, 35047, { name: 21, bundle: 2, price: 8 }),
          fareOf(10, 23711, { cls: 'HIGH', price: 7 }),
        ],
        salesAvailabilityConstraint: [{ id: P('M', 1), salesRestrictions: [{ startOfSale: { timeUnit: 'DAYS', timeValue: 182, timeReference: 'BEFORE_START_VALIDITY' }, endOfSale: { timeUnit: 'DAYS', timeValue: 1, timeReference: 'AFTER_END_VALIDITY' }, salesDatesRef: P('B', 1) }] }],
        travelValidityConstraints: [{ id: P('Q', 1), validityRange: { timeUnit: 'DAYS', value: 2, hoursAfterMidnight: 0 }, excludedTimeRange: [], numberOfTravelDays: 0, validityType: 'SINGLE_TRIP' }],
        combinationConstraints: [{ id: P('D', 1), combinationModels: [{ model: 'CLUSTERING', onlyWhenCombined: false, referenceCluster: 'FULLFLEX', allowedClusters: ['PROMO', 'NONFLEX', 'SEMIFLEX', 'FULLFLEX', 'BUSINESS'] }] }],
        fulfillmentConstraints: [{ id: P('E', 1196), acceptedControlSecurityTypes: ['SID', 'SIP', 'SIS'], individualTicketingPermitted: true, separateFulfillmentRequired: false }],
        reductionConstraints: [
          { id: P('K', 1), requiredCards: [{ cardValue: '1080_BC50_2', cardName: 'Card fifty second', issuer: '1080' }, { cardValue: '1080_BC50_1', cardName: 'Card fifty first', issuer: '1080' }] },
          { id: P('K', 3), requiredCards: [{ cardValue: '1080_BC25_2', cardName: 'Card quarter second', issuer: '1080' }, { cardValue: '1080_BC25_1', cardName: 'Card quarter first', issuer: '1080' }] },
        ],
        reductionCards: [],
        connectionPoints: [
          { id: P('E', 1), legacyBorderPointCode: '0', stationSets: [[stn('9900001')]] },
          { id: P('E', 2), legacyBorderPointCode: '0', stationSets: [[stn('9900002')]] },
          { id: P('E', 3), legacyBorderPointCode: '462', stationSets: [[stn('9900003')]] },
          { id: P('E', 4), legacyBorderPointCode: '0', stationSets: [[stn('9900004'), stn('9900007')]] },
        ],
        stationNames: [{ code: '9900001', name: 'Somewhere Central' }],
        fareReferenceStationSetDefinitions: [
          { fareProvider: '1080', code: '20060', stations: [stn('9900003'), stn('9900008')], name: 'Setone' },
          { fareProvider: '1080', code: '2140', stations: [stn('9900009'), stn('9900010'), stn('9900011')], name: 'Settwo' },
          { fareProvider: '1080', code: '22193', stations: [stn('9900004')], name: 'Setthree' },
        ],
      },
    },
  };
}

module.exports = { delivery, P };
