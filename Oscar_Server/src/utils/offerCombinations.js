// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * offerCombinations.js — random combinations of offer search options (#780,
 * part 3). Pure.
 *
 * The Test Framework sets how many combinations to draw and a seed
 * (`offerCombinations: { count, seed }`). The same seed always gives the same
 * combinations, so a combination that finds a gap can be copied and run
 * again; a new seed gives new ones. Each combination takes two or more of the
 * options that have a declared value, and one declared value of each. Options
 * of the same `group` are never combined: the travel class and the service
 * class ask for the same comfort in two ways, and a provider may tie them
 * (first class = HIGH), so together they would mostly find no offer.
 */

const MAX_COUNT = 20;
const MAX_SEED = 0xFFFFFFFF;

/** The count and seed a framework sets, or null when either is missing or out of range. */
function combinationSettings(fw) {
  const c = fw?.offerCombinations;
  const count = c?.count;
  const seed = c?.seed;
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return null;
  if (!Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) return null;
  return { count, seed };
}

// mulberry32: a small 32-bit generator, the same sequence for the same seed
// on every platform. Not for secrets: it only chooses test combinations.
function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Up to `count` different combinations from `options` (an array of
 * { key, values: [...] }, in a fixed order), each of two or more options with
 * one value each, as [{ key, value }] in the options' order. Fewer when there
 * are not that many different combinations. [] with fewer than two options.
 */
function drawCombinations(options, count, seed) {
  const usable = (Array.isArray(options) ? options : []).filter((o) => Array.isArray(o?.values) && o.values.length > 0);
  if (usable.length < 2) return [];
  const next = generator(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const seen = new Set();
  const out = [];
  // A bounded number of draws: duplicates are drawn again, never forever.
  for (let draw = 0; draw < count * 20 && out.length < count; draw++) {
    let chosen = usable.filter(() => next() < 0.5);
    while (chosen.length < 2) {
      const extra = pick(usable);
      if (!chosen.includes(extra)) chosen = usable.filter((o) => o === extra || chosen.includes(o));
    }
    chosen = oneOfEachGroup(chosen, next);
    if (chosen.length < 2) continue;
    const combination = chosen.map((o) => ({ key: o.key, value: pick(o.values) }));
    const id = combination.map((c) => `${c.key}=${c.value}`).join('&');
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(combination);
  }
  return out;
}

// Keeps one option of each group (chosen at random), in the options' order.
function oneOfEachGroup(chosen, next) {
  const groups = new Map();
  for (const o of chosen) if (o.group) groups.set(o.group, [...(groups.get(o.group) || []), o]);
  const kept = new Set([...groups.values()].map((list) => list[Math.floor(next() * list.length)]));
  return chosen.filter((o) => !o.group || kept.has(o));
}

module.exports = { MAX_COUNT, MAX_SEED, combinationSettings, drawCombinations };
