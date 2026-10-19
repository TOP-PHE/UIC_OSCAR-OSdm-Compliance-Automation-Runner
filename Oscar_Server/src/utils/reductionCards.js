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
 * `reductionCards` in the framework is a list of { code, issuer, name }: the
 * card's code as the provider writes it in an offer request, the issuer (a
 * URN, which an OSDM CardReference carries), and a name for people. Absent =
 * none declared: the catalogue's card scenarios cannot be copied.
 *
 * A checklist (#795) gives them in question A3.7: `data.reductionCards=YES`
 * or `=NO`, and the table `data.card.<n>.code` / `.issuer` / `.name`.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// A card's code, issuer and name: at most this long (a code is short; an
// issuer is a URN; a name is for people).
const MAX = { code: 60, issuer: 200, name: 120 };
const MAX_CARDS = 50;

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
    const m = /^data\.card\.(\d{1,3})\.(code|issuer|name)$/.exec(tag);
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

module.exports = { declaredCards, cardsFromChecklist, passengersWithCard };
