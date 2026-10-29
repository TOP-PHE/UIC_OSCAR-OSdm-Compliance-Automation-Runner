// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1047: reading an offline fare delivery as a stream, and making templates
// of its regions without their places, on a small delivery made by hand.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { DeliveryScanner } = require('../scripts/gtm-reader-lib');
const lib = require('../scripts/fare-templates-lib');
const { run } = require('../scripts/fare-templates');
const { delivery } = require('./fixtures/fare-delivery');
const { tempDir } = require('./helpers');

const REGIONS = [
  { numbers: [35047], shape: 'station to station' },
  { numbers: [23711], shape: 'border to station set, alternatives' },
];

// Feeds a text to a scanner in pieces of sizes drawn from a seed.
function scan(text, seed, handlers) {
  const scanner = new DeliveryScanner(handlers);
  let state = seed;
  for (let i = 0; i < text.length;) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const size = 1 + (state % 97);
    scanner.write(text.slice(i, i + size));
    i += size;
  }
}

function collected(source = delivery(), seed = 7) {
  const collector = lib.createCollector([35047, 23711]);
  scan(JSON.stringify(source, null, 1), seed, collector);
  return collector.kept;
}

test('the scanner hands back every element of the fareStructure lists and the header, whatever the pieces', () => {
  const source = delivery();
  const text = JSON.stringify(source, null, 2);
  for (const seed of [1, 2, 3, 42, 1234]) {
    const seen = {};
    let header = null;
    scan(text, seed, {
      onElement: (list, t) => { (seen[list] ||= []).push(JSON.parse(t)); },
      onDelivery: (t) => { header = JSON.parse(t); },
    });
    const withElements = Object.fromEntries(Object.entries(source.fareDelivery.fareStructure).filter(([, list]) => list.length > 0));
    assert.deepEqual(seen, withElements, `seed ${seed}`);
    assert.deepEqual(header, source.fareDelivery.delivery);
  }
});

test('the scanner leaves out what is not an element of a fareStructure list', () => {
  const text = JSON.stringify({
    other: { fareStructure: { fares: [{ id: 'not-this' }] } },
    fareDelivery: {
      notes: [{ id: 'not-this-either' }],
      fareStructure: { fares: [{ id: 'f1', nested: { fares: [{ id: 'inner' }], delivery: { x: 1 } } }], empty: [] },
    },
  });
  const seen = [];
  const headers = [];
  scan(text, 3, { onElement: (list, t) => seen.push([list, JSON.parse(t).id]), onDelivery: (t) => headers.push(t) });
  assert.deepEqual(seen, [['fares', 'f1']]);
  assert.deepEqual(headers, []);
});

test('the collector keeps the regions asked and their fares, and never the station names', () => {
  const kept = collected();
  assert.deepEqual(kept.delivery.deliveryId, '2024.02');
  assert.deepEqual(kept.lists.regionalConstraints.map((r) => r.id), ['1080_2024.02_K__35047', '1080_2024.02_K__23711']);
  assert.equal(kept.lists.fares.length, 9, 'the fare of the region not read is left out');
  assert.equal(kept.lists.stationNames, undefined);
  assert.equal(kept.lists.connectionPoints.length, 4);
});

test('a template keeps the shape of its region, without its places', () => {
  const { templates } = lib.templatesOf(collected(), REGIONS);
  const [t1, t2] = templates.templates;
  assert.deepEqual(t1.entry, { border: false, stationSets: [1] });
  assert.deepEqual(t1.exit, { border: false, stationSets: [1] });
  assert.deepEqual(t1.regionalValidities, [{ carriers: 'C1', route: { sequence: [{ place: 'station' }, { place: 'station' }] } }]);
  assert.deepEqual([t1.id, t1.madeFromRegion, t1.distance, t1.pair, t1.direction], ['T01', 35047, 39, 1, 0]);
  assert.deepEqual(t2.entry, { border: true, stationSets: [1] });
  assert.deepEqual(t2.exit, { border: false, stationSets: [2] });
  assert.deepEqual(t2.regionalValidities[0].route, {
    sequence: [
      { place: 'stationSet', stations: 2 },
      { alternatives: [{ place: 'stationSet', stations: 3 }, { sequence: [{ place: 'station', stop: true }, { place: 'stationSet', stations: 1 }] }] },
      { place: 'station', border: true },
    ],
  });
  assert.equal(t2.pair, 2);
});

test('a template\'s fares keep everything but places, companies and cards', () => {
  const { templates } = lib.templatesOf(collected(), REGIONS);
  const [t1] = templates.templates;
  const adult = t1.fares.find((f) => f.family === 'FLEXIBLE' && f.passenger === 'G1' && f.card === null);
  assert.deepEqual(adult, {
    family: 'FLEXIBLE', name: 'Flexible fare', type: 'ADMISSION', travelClass: 'SECOND', serviceClass: 'BASIC',
    passenger: 'G1', card: null, bundle: 'S1', carriers: 'C1', price: 1000, regulatoryConditions: ['CIV'],
    legacyAccountingIdentifier: { serialId: 78, addId: 0, tariffId: 10001 }, involvedTCOs: 3, individualContracts: false,
  });
  assert.deepEqual(t1.fares.map((f) => f.family), ['BICYCLE', 'FLEXIBLE', 'FLEXIBLE', 'FLEXIBLE', 'FLEXIBLE', 'FLEXIBLE', 'FLEXIBLE', 'GROUP']);
  assert.equal(t1.fares.find((f) => f.family === 'GROUP').bundle, 'S2');
  assert.deepEqual(templates.cardSlots, {
    R1: { family: 'REDUCTION_50', cardClasses: ['SECOND', 'FIRST'] },
    R3: { family: 'REDUCTION_25', cardClasses: ['SECOND', 'FIRST'] },
  });
  assert.deepEqual(templates.carrierConstraints, { C1: { carriers: 3, excludedCarriers: 0 } });
  assert.deepEqual(Object.keys(templates.passengerConstraints), ['G1', 'G3', 'G5', 'G7', 'G11'], 'G7 as the adult\'s free companion; G12, unused, left out');
  assert.deepEqual(templates.passengerConstraints.G1.includedFree, [{ number: 10, constraint: 'G7' }]);
  assert.deepEqual(templates.passengerCombinations, { T1: { min: 1, max: 5 }, T2: { min: 6, max: 99 } });
  assert.deepEqual(templates.bundles.S1.combinationConstraint, [{
    model: 'CLUSTERING', referenceCluster: 'FULL_FLEX', allowedClusters: ['PROMO', 'NON_FLEX', 'SEMI_FLEX', 'FULL_FLEX', 'BUSINESS'], isValidOnlyWhenCombined: false,
  }]);
  assert.deepEqual(templates.bundles.S1.fulfillment, { acceptedControlSecurityTypes: ['SID', 'SIP', 'SIS'], individualTicketingPermitted: true, separateFulfillmentRequired: false });
  assert.equal(templates.about.currency, 'EUR');
});

test('DB\'s doubled card fare goes to the child it is priced for, not the dog priced like the child', () => {
  const { templates, corrections } = lib.templatesOf(collected(), REGIONS);
  const card = templates.templates[0].fares.filter((f) => f.card === 'R3');
  assert.deepEqual(card.map((f) => [f.passenger, f.price]).sort((a, b) => a[0].localeCompare(b[0], 'en')), [['G1', 750], ['G3', 375]]);
  assert.deepEqual(corrections, ['T01: FLEXIBLE|SECOND|G1|R3 at 375 given to G3']);
  assert.match(templates.about.corrected, /given back to the child \(1 fares\)/);
});

test('a doubled fare with no passenger to give it to stops the conversion', () => {
  const source = delivery();
  const fares = source.fareDelivery.fareStructure.fares;
  fares.splice(fares.findIndex((f) => f.id === 'fare-6'), 1);
  assert.throws(() => lib.templatesOf(collected(source), REGIONS), /two fares for FLEXIBLE\|SECOND\|G1\|R3, and no passenger/);
});

test('anything the script does not know stops it', () => {
  const broken = (change, pattern) => {
    const source = delivery();
    change(source.fareDelivery);
    assert.throws(() => lib.templatesOf(collected(source), REGIONS), pattern);
  };
  broken((d) => { d.delivery.deliveryId = '2025.01'; }, /reads DB's delivery 1080 2024.02/);
  broken((d) => { d.fareStructure.texts[0].text = 'Superpreis'; }, /fare name this script does not know: Superpreis/);
  broken((d) => { d.fareStructure.reductionConstraints[0].requiredCards[0].cardValue = '1080_XYZ'; }, /card this script does not know/);
  broken((d) => { d.fareStructure.combinationConstraints[0].combinationModels[0].referenceCluster = 'GOLD'; }, /cluster this script does not know: GOLD/);
  broken((d) => { d.fareStructure.prices[0].price[0].currency = 'CHF'; }, /not in EUR cents/);
  broken((d) => {
    const v = d.fareStructure.regionalConstraints[1].regionalValidity[0].viaStations;
    v.route[0] = { ...v.route[0], station: undefined, route: [v.route[1]], alternativeRoute: [v.route[1]] };
  }, /both a route and alternatives/);
  broken((d) => { d.fareStructure.regionalConstraints[1].regionalValidity[0].zone = { id: 'z' }; }, /regional validity this script does not read: zone/);
  broken((d) => { d.fareStructure.regionalConstraints.splice(1, 1); }, /region 35047 is not in the delivery/);
  broken((d) => { d.fareStructure.fareReferenceStationSetDefinitions.pop(); }, /station set this delivery does not define/);
});

test('leaksIn finds a place, company or card of the delivery outside `about`, and nothing in good templates', () => {
  const kept = collected();
  const { templates } = lib.templatesOf(kept, REGIONS);
  assert.deepEqual(lib.leaksIn(templates, kept), []);
  const leaky = JSON.parse(JSON.stringify(templates));
  leaky.templates[0].shape = 'from 9900001 by Settwo';
  leaky.cardSlots.R1.family = '1080_BC50_2';
  leaky.templates[1].note = 'TCO 1185';
  assert.deepEqual(lib.leaksIn(leaky, kept), ['1080', '1080_BC50_2', '1185', '9900001', 'Settwo'], 'the company code inside the card code too');
  // `about` may name the source.
  const named = { ...templates, about: { ...templates.about, source: 'delivery of 1080, Somewhere 9900001' } };
  assert.deepEqual(lib.leaksIn(named, kept), []);
});

test('the file is indented, one fare per line, and reads back as written', () => {
  const { templates } = lib.templatesOf(collected(), REGIONS);
  const text = lib.templatesText(templates);
  assert.deepEqual(JSON.parse(text), templates);
  const fareLines = text.split('\n').filter((l) => l.trim().startsWith('{"family"'));
  assert.equal(fareLines.length, 9);
  assert.ok(text.endsWith('}\n'));
});

const chunks = (text) => Readable.from(text.match(/[\s\S]{1,500}/g));

test('the script reads a delivery from a stream and writes the templates; the same twice', async () => {
  const out = path.join(tempDir(), 'fares', 'templates.json');
  const text = JSON.stringify(delivery());
  const done = await run(chunks(text), out, REGIONS);
  assert.deepEqual([done.templates, done.fares, done.corrections.length], [2, 9, 1]);
  const first = fs.readFileSync(out, 'utf8');
  assert.equal(first, lib.templatesText(lib.templatesOf(collected(), REGIONS).templates));
  await run(chunks(text), out, REGIONS);
  assert.equal(fs.readFileSync(out, 'utf8'), first);
});

test('the script reads its own regions by default, and writes nothing when one is missing', async () => {
  const out = path.join(tempDir(), 'templates.json');
  const err = await run(chunks(JSON.stringify(delivery())), out).catch((e) => e);
  assert.match(err.message, /is not in the delivery/);
  assert.equal(fs.existsSync(out), false);
});

test('the script writes nothing when the templates would name a place', async () => {
  const out = path.join(tempDir(), 'templates.json');
  const source = delivery();
  // A value copied as it is (the fare type) that holds a station code.
  source.fareDelivery.fareStructure.fares[2].fareType = 'ADMISSION 9900001';
  const err = await run(chunks(JSON.stringify(source)), out, REGIONS).catch((e) => e);
  assert.match(err.message, /would name places, companies or cards of the delivery: 9900001/);
  assert.equal(fs.existsSync(out), false);
});

test('a stream that fails, or text the scanner cannot follow, rejects', async () => {
  const out = path.join(tempDir(), 'templates.json');
  const failing = new Readable({ read() { this.destroy(new Error('disk gone')); } });
  await assert.rejects(run(failing, out, REGIONS), /disk gone/);
  const bad = JSON.stringify(delivery()).replace('"carrierConstraints":[', '"carrierConstraints":[{"id":oops},');
  await assert.rejects(run(chunks(bad), out, REGIONS), SyntaxError);
  assert.equal(fs.existsSync(out), false);
});
