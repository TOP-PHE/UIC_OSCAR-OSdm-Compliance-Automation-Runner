// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * store.js — the simulator's memory.
 *
 * Offers and bookings are kept per scope, a scope being one client of one
 * provider. What a client stored, only that client reads back. Nothing is
 * written to disk.
 *
 * Memory is bounded: each scope holds at most `limit` entries of a kind and
 * drops its oldest to take a new one, and an entry older than the time to live
 * is gone when next looked at. The clients are a fixed list, so the total is
 * bounded too (clients x limits).
 */

function createStore({ limits, ttlMs, now = Date.now }) {
  // kind → scope → Map(id → { value, at }), a Map keeping insertion order.
  const kinds = new Map(Object.keys(limits).map((kind) => [kind, new Map()]));

  function bucket(kind, scope, create) {
    const scopes = kinds.get(kind);
    if (!scopes) throw new Error(`unknown kind: ${kind}`);
    let entries = scopes.get(scope);
    if (!entries && create) {
      entries = new Map();
      scopes.set(scope, entries);
    }
    return entries;
  }

  function put(kind, scope, id, value) {
    const entries = bucket(kind, scope, true);
    entries.delete(id);
    while (entries.size >= limits[kind]) entries.delete(entries.keys().next().value);
    entries.set(id, { value, at: now() });
  }

  function get(kind, scope, id) {
    const entries = bucket(kind, scope, false);
    const entry = entries?.get(id);
    if (!entry) return undefined;
    if (now() - entry.at > ttlMs) {
      entries.delete(id);
      return undefined;
    }
    return entry.value;
  }

  function count(kind) {
    let n = 0;
    for (const entries of kinds.get(kind).values()) n += entries.size;
    return n;
  }

  return { put, get, count };
}

module.exports = { createStore };
