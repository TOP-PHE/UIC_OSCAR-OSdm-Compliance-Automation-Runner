// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

// ── Filling a trip from Test Data (#136, #137, #540) ─────────────────────────
// One implementation of "Apply test data" for the trip editor and for the
// scenario copy between providers, so a copied trip is rebuilt exactly as the
// editor would rebuild it:
//   - a TRAIN resource (route + a chosen service) fills one trip block or leg;
//   - a JOURNEY resource (legs of { trainResourceId, serviceIndex }) gives the
//     legs of a SPECIFICATION trip.
// Fields neither the train nor the service defines are left as they were.
//
// Loaded by scenarios.html before scenarios.js (browser global OscarTripApply)
// and required by the server (src/utils/scenarioCopy.js) and the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OscarTripApply = api;
}(globalThis, function () {
  'use strict';

  // A train set's data in its current shape (#136, #141). Legacy sets stored
  // one service at the top level; they are read as services[0]. Idempotent;
  // changes and returns `d`.
  function normalizeTrainData(d) {
    d = d || {};
    if (!Array.isArray(d.services)) {
      d.services = (d.vehicleNumber || d.departureTime || d.arrivalTime)
        ? [{ vehicleNumber: d.vehicleNumber || '', departureTime: d.departureTime || '', arrivalTime: d.arrivalTime || '' }]
        : [];
    }
    // Operating days live at the set level (#141) — all services share one
    // calendar. Migrate from a per-service daysOfWeek (the Phase 2 shape).
    if (!Array.isArray(d.daysOfWeek)) {
      const fromSvc = d.services.find(s => s && Array.isArray(s.daysOfWeek) && s.daysOfWeek.length);
      d.daysOfWeek = fromSvc ? fromSvc.daysOfWeek.slice() : [];
    }
    d.services = d.services.map(s => ({
      vehicleNumber: s?.vehicleNumber || '',
      departureTime: s?.departureTime || '',
      arrivalTime:   s?.arrivalTime || ''
    }));
    // Product category as OSDM ref/name/shortName (#141). Migrate the earlier
    // single `productCategory` text field into the ref so saved sets keep working.
    if (d.productCategoryRef == null)       d.productCategoryRef = d.productCategory || '';
    if (d.productCategoryName == null)      d.productCategoryName = '';
    if (d.productCategoryShortName == null) d.productCategoryShortName = '';
    return d;
  }

  // A resource's data as an object (stored as text or as an object).
  function resourceData(resource) {
    if (!resource) return {};
    let d = resource.data;
    if (typeof d === 'string') { try { d = JSON.parse(d || '{}'); } catch { return {}; } }
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  }

  // Fill trip block or leg `t` from train data `d` (normalized) and service `svc`.
  function applyTrainService(t, d, svc) {
    if (d.originURN)      t.origin         = d.originURN;
    if (d.destinationURN) t.destination    = d.destinationURN;
    if (svc.departureTime) t.startDatetime = '%TRIP_DATE%T' + svc.departureTime;
    if (svc.arrivalTime)   t.endDatetime   = '%TRIP_DATE%T' + svc.arrivalTime;
    if (svc.vehicleNumber) t.vehicleNumber = svc.vehicleNumber;
    if (d.operatorCode)    t.operatorCode  = d.operatorCode;
    // Product category (#141) — carried into the request's service.productCategory.
    if (d.productCategoryRef)       t.productCategoryRef       = d.productCategoryRef;
    if (d.productCategoryName)      t.productCategoryName      = d.productCategoryName;
    if (d.productCategoryShortName) t.productCategoryShortName = d.productCategoryShortName;
    return t;
  }

  // The train resource `trainId` among `resources`, normalized, with its
  // service `serviceIndex` (or the first): { train, d, svc }, or null.
  function trainService(resources, trainId, serviceIndex) {
    const train = (resources || []).find(r => String(r.id) === String(trainId) && (!r.resource_type || r.resource_type === 'TRAIN'));
    if (!train) return null;
    const d = normalizeTrainData(resourceData(train));
    const svc = d.services[serviceIndex] || d.services[0] || {};
    return { train, d, svc };
  }

  // A journey's legs as trip legs, resolving each leg's train among
  // `resources`. A leg whose train is missing is left out.
  function journeyToTripLegs(journey, resources) {
    const legs = Array.isArray(resourceData(journey).legs) ? resourceData(journey).legs : [];
    return legs.map(leg => {
      if (!leg) return null;
      const r = trainService(resources, leg.trainResourceId, leg.serviceIndex);
      return r ? applyTrainService({}, r.d, r.svc) : null;
    }).filter(Boolean);
  }

  // #787: a trip keeps no link to the train set it was filled from: "Apply
  // test data" copies the values. A trip block or leg was built from a set's
  // service when it has the set's route and that service's number, as the set
  // was before an edit (`before`). [{ target: 'trip' | <leg index>, serviceIndex }].
  function blocksBuiltFrom(tripReq, before) {
    const d = normalizeTrainData(structuredClone(before || {}));
    if (!d.originURN || !d.destinationURN || !tripReq || typeof tripReq !== 'object') return [];
    const out = [];
    const consider = (block, target) => {
      if (!block || typeof block !== 'object') return;
      if (block.origin !== d.originURN || block.destination !== d.destinationURN) return;
      const serviceIndex = d.services.findIndex(s => s.vehicleNumber && s.vehicleNumber === block.vehicleNumber);
      if (serviceIndex >= 0) out.push({ target, serviceIndex });
    };
    consider(tripReq.trip, 'trip');
    (Array.isArray(tripReq.legs) ? tripReq.legs : []).forEach((leg, i) => consider(leg, i));
    return out;
  }

  const blockOf = (tripReq, target) => (target === 'trip' ? tripReq.trip : tripReq.legs[target]);

  // #787: the blocks of `tripRequirements` built from the set as it was
  // (`before`) that the set as saved (`after`) would change, each with its
  // trip's index. A service the edit removed changes nothing.
  function tripUpdatesFromTrain(tripRequirements, before, after) {
    const d = normalizeTrainData(structuredClone(after || {}));
    const out = [];
    (Array.isArray(tripRequirements) ? tripRequirements : []).forEach((tripReq, tripIndex) => {
      for (const b of blocksBuiltFrom(tripReq, before)) {
        const svc = d.services[b.serviceIndex];
        if (!svc) continue;
        const block = blockOf(tripReq, b.target);
        const applied = applyTrainService(structuredClone(block), d, svc);
        if (JSON.stringify(applied) !== JSON.stringify(block)) out.push({ tripIndex, ...b });
      }
    });
    return out;
  }

  // #787: fill one block named by an update from the set as saved.
  function applyTripUpdate(tripReq, update, after) {
    const d = normalizeTrainData(structuredClone(after || {}));
    const block = blockOf(tripReq, update.target);
    const svc = d.services[update.serviceIndex];
    if (block && svc) applyTrainService(block, d, svc);
    return tripReq;
  }

  return Object.freeze({ normalizeTrainData, resourceData, applyTrainService, trainService, journeyToTripLegs, blocksBuiltFrom, tripUpdatesFromTrain, applyTripUpdate });
}));
