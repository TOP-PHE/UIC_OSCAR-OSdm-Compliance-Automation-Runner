// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * reductionCards.js — the reduction cards a provider accepts, as the Test
 * Framework declares them (#887). Pure.
 *
 * `reductionCards` in the framework is a list of { code, issuer, name,
 * percent }: the card's code as the provider writes it in an offer request,
 * the issuer (a URN, which an OSDM CardReference carries), a name for people,
 * and (#889, optional) the share of the price the card takes off, above 0 and
 * at most 100. Absent = none declared: the catalogue's card scenarios cannot
 * be copied. A card without `percent` is only checked to be cheaper.
 *
 * A checklist (#795) gives them in question A3.7: `data.reductionCards=YES`
 * or `=NO`, and the table `data.card.<n>.code` / `.issuer` / `.name` /
 * `.percent` ("25", "25 %" or "25,5").
 *
 * The run's copy writes each declared rate on the passengers' cards of the
 * same code (`withCardRates()`), where the collection reads it (step 01c).
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// A card's code, issuer and name: at most this long (a code is short; an
// issuer is a URN; a name is for people).
const MAX = { code: 60, issuer: 200, name: 120 };
const MAX_CARDS = 50;

/** A reduction rate: "25", "25 %", "25,5" or a number, above 0 and at most 100; else null. */
function percentOf(value) {
  let n = value;
  if (typeof value === 'string') {
    const m = /^(\d{1,3}(?:[.,]\d{1,2})?)(?: ?%)?$/.exec(value.trim());
    n = m ? Number(m[1].replace(',', '.')) : Number.NaN;
  }
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
}

/** One declared card, cleaned, or null when it has no code. */
function cardOf(entry) {
  if (!isObj(entry)) return null;
  const code = text(entry.code).slice(0, MAX.code);
  if (!code) return null;
  const card = { code };
  const issuer = text(entry.issuer).slice(0, MAX.issuer);
  const name = text(entry.name).slice(0, MAX.name);
  if (issuer) card.issuer = issuer;
  if (name) card.name = name;
  const percent = percentOf(entry.percent);
  if (percent !== null) card.percent = percent;
  return card;
}

/** The cards a framework declares: each with a code, each code once, in order. */
function declaredCards(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const out = [];
  for (const card of (Array.isArray(fw?.reductionCards) ? fw.reductionCards : []).map(cardOf)) {
    if (!card || out.some((c) => c.code === card.code)) continue;
    out.push(card);
    if (out.length === MAX_CARDS) break;
  }
  return out;
}

/**
 * The cards a checklist's A3.7 declares: [] for NO, the table's rows for YES,
 * null when the question is not answered.
 */
function cardsFromChecklist(answers) {
  const a = isObj(answers) ? answers : {};
  if (a['data.reductionCards=NO'] === true) return [];
  if (a['data.reductionCards=YES'] !== true) return null;
  const rows = new Map();
  for (const [tag, value] of Object.entries(a)) {
    const m = /^data\.card\.(\d{1,3})\.(code|issuer|name|percent)$/.exec(tag);
    if (!m || typeof value !== 'string') continue;
    const n = Number(m[1]);
    if (!rows.has(n)) rows.set(n, {});
    rows.get(n)[m[2]] = value;
  }
  return declaredCards({ reductionCards: [...rows.keys()].sort((x, y) => x - y).map((n) => rows.get(n)) });
}

/**
 * The passengers of a card scenario's copy (#887): each passenger holding a
 * card holds the given one instead (its code and issuer); the others are
 * left as they are.
 * Copies; the source list is not changed.
 */
function passengersWithCard(source, card) {
  const held = { code: card.code, ...(card.issuer ? { issuer: card.issuer } : {}) };
  return (Array.isArray(source) ? source : []).filter(isObj).map((p) => {
    const out = structuredClone(p);
    if (Array.isArray(p.reductionCards) && p.reductionCards.length > 0) out.reductionCards = [held];
    return out;
  });
}

/**
 * #889: the run's copy of a data file (changed in place) with each declared
 * card's rate on the passengers' cards of the same code (and issuer, when both
 * name one). A card the scenario already gives a rate keeps it. A card written
 * as a code becomes { code, percent }. Returns how many cards it changed.
 */
function withCardRates(datafile, framework) {
  const rated = declaredCards(framework).filter((c) => c.percent !== undefined);
  if (rated.length === 0 || !isObj(datafile) || !Array.isArray(datafile.passengersList)) return 0;
  const match = (code, issuer) => rated.find((c) => c.code === code && (!issuer || !c.issuer || c.issuer === issuer));
  let changed = 0;
  for (const list of datafile.passengersList) {
    for (const p of Array.isArray(list?.passengers) ? list.passengers : []) {
      if (!isObj(p) || !Array.isArray(p.reductionCards)) continue;
      p.reductionCards = p.reductionCards.map((entry) => {
        const code = text(isObj(entry) ? entry.code : entry);
        if (!code || (isObj(entry) && entry.percent !== undefined)) return entry;
        const card = match(code, isObj(entry) ? text(entry.issuer) : '');
        if (!card) return entry;
        changed += 1;
        return { ...(isObj(entry) ? entry : { code }), percent: card.percent };
      });
    }
  }
  return changed;
}

module.exports = { declaredCards, cardsFromChecklist, passengersWithCard, percentOf, withCardRates };
