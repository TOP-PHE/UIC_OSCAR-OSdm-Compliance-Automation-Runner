// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * catalogueSource.js — what copying reference scenarios reads (#612): the
 * scenario catalogue and the simulator's data file, a company's data file and
 * its Test Data as the person choosing a train sees it. Shared by Copy
 * scenarios (company-scenario-copy.js) and the provider checklist (#862).
 */

const fs = require('node:fs');
const path = require('node:path');
const { get } = require('../../db/db');
const { decryptFromFileAsync } = require('../../utils/at-rest');
const { fileVersion, deepFreeze } = require('../../utils/runDatafile');
const TripApply = require('../../../public/js/trip-apply');
const log = require('../../utils/logger').child({ module: 'catalogue-source' });

/** A refusal the route answers with its status and text. */
class Refusal extends Error {
  constructor(status, detail) { super(detail); this.status = status; }
}

// A company's datafile as an object; null when it has none. Throws a Refusal
// when it exists but cannot be read: copying from or into it would guess.
async function readDatafile(companyId) {
  const row = get('SELECT datafile_path FROM companies WHERE id = ?', [companyId]);
  if (!row?.datafile_path || !fs.existsSync(row.datafile_path)) return null;
  try {
    const df = JSON.parse((await decryptFromFileAsync(row.datafile_path)).toString('utf8'));
    if (df && typeof df === 'object' && !Array.isArray(df)) return df;
  } catch (err) {
    log.error({ err, companyId }, 'scenario copy: data file unreadable');
  }
  throw new Refusal(409, 'A data file involved in the copy cannot be read. Ask your Test Manager to check it.');
}

// #1236: a file of the collection is parsed once per version of it (size,
// times to the nanosecond, inode), not at each call: the Run page's preview
// and every launch read the catalogue, and the copy routes the simulator's
// data file (1.7 MB) too. The collection is refreshed without a restart, so
// the file is looked at each time and read again once it changed. What is
// kept is frozen: a caller that wrote into it would change what the next
// one reads, and throws instead (they all work on copies).
const MAX_KEPT_FILES = 8;
const keptFiles = new Map();

function keptJson(file) {
  const version = fileVersion(fs.statSync(file, { bigint: true }));
  const kept = keptFiles.get(file);
  if (kept?.version === version) return kept.value;
  const value = deepFreeze(JSON.parse(fs.readFileSync(file, 'utf8')));
  keptFiles.delete(file);
  keptFiles.set(file, { version, value });
  while (keptFiles.size > MAX_KEPT_FILES) keptFiles.delete(keptFiles.keys().next().value);
  return value;
}

// A file of the collection the runs use (COLLECTION_PATH), else the
// repository's copy, as the data file schema is read. Frozen (#1236).
function collectionJson(...parts) {
  const candidates = [
    path.join(path.resolve(process.env.COLLECTION_PATH || '/collection'), ...parts),
    path.resolve(__dirname, '../../../../Bruno_Collection', ...parts),
  ];
  for (const file of candidates) {
    try { return keptJson(file); } catch { /* the next copy */ }
  }
  throw new Refusal(503, 'The scenario catalogue cannot be read on this server.');
}

function readCatalogue() {
  return { catalogue: collectionJson('data_base', 'scenario_catalogue.json'), simulator: collectionJson('data_base', 'simulator_datafile.json') };
}

// The catalogue's entries alone, without the simulator's data file (#1236):
// what the Run page's facets and the coverage report read. [] when the file
// holds none; a Refusal when it cannot be read.
function catalogueEntries() {
  const entries = collectionJson('data_base', 'scenario_catalogue.json').entries;
  return Array.isArray(entries) ? entries : [];
}

// Trains and journeys, as the person choosing sees them.
function testDataChoices(resources) {
  const trains = resources.filter(r => r.resource_type === 'TRAIN').map(r => {
    const d = TripApply.normalizeTrainData(r.data);
    return {
      id: r.id, label: r.label, origin: d.originURN || '', destination: d.destinationURN || '', operatorCode: d.operatorCode || '',
      services: d.services.map((s, index) => ({ index, vehicleNumber: s.vehicleNumber, departureTime: s.departureTime, arrivalTime: s.arrivalTime })),
    };
  });
  // #1027: a journey's ends, so that a trip of several legs goes on its own route first.
  const journeys = resources.filter(r => r.resource_type === 'JOURNEY').map(r => {
    const legs = TripApply.journeyToTripLegs(r, resources);
    return { id: r.id, label: r.label, legs: legs.length, origin: legs[0]?.origin || '', destination: legs.at(-1)?.destination || '' };
  });
  return { trains, journeys };
}

module.exports = { Refusal, readDatafile, collectionJson, readCatalogue, catalogueEntries, testDataChoices };
