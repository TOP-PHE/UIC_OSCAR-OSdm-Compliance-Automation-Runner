/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * lostItems.js — the replacement of a lost ticket or card (#1266).
 *
 * OSDM (after-sales processes, "Replacement of lost tickets and cards"): the
 * replacement is asked as a non-trip offer whose product tags hold
 * TICKET_LOST or CARD_LOST (physical tickets and cards only); "the provider
 * will ask for the required data of the lost card or ticket", the passenger's
 * card data (card number) for a card; the offer "might include a fee"; it is
 * booked as a usual offer. OSDM names no member for that data: OSCAR reads
 * the provider's `requestedInformation`, the way OSDM asks for any data.
 *
 *   - Step 01, the chosen offer: it asks for the lost item's data (a card
 *     leaf for CARD_LOST, the holder's name or date of birth for TICKET_LOST)
 *     — a WARNING when it does not, since OSDM says so in prose only. Its
 *     fees are said at INFO. A CARD_LOST scenario that names no card
 *     (`lostCard`) fails one check: the booking cannot give the number.
 *   - Step 02: the scenario's `lostCard` goes in the first passenger's cards
 *     (the holder's name and date of birth are the passenger's own data).
 *   - `lostCardExpectRejection`: the card is one the provider does not know;
 *     the booking must be refused (4xx with a Problem). The scenario ends.
 */

require('./displays.js');

const LOST_KINDS = Object.freeze(['TICKET_LOST', 'CARD_LOST']);
const PART_LISTS = ['admissionOfferParts', 'reservationOfferParts', 'ancillaryOfferParts'];
const HOLDER_FIELDS = new Set(['lastName', 'firstName', 'dateOfBirth']);

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The lost kinds an offer request asks (its product tags and its selections' tags), in OSDM's order. */
function lostKindsOf(request) {
  const criteria = request?.offerSearchCriteria;
  const asked = new Set([
    ...list(criteria?.productTags),
    ...list(criteria?.productSelections).map((s) => s?.productTag),
  ].map(text).filter(Boolean));
  return LOST_KINDS.filter((kind) => asked.has(kind));
}

/**
 * The scenario's lost card as a CardReference (a reduction card), or null
 * when it names no number.
 */
function lostCardOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const number = text(entry.number);
  if (!number) return null;
  const card = { type: 'REDUCTION_CARD' };
  if (text(entry.code)) card.code = text(entry.code);
  card.number = number;
  if (text(entry.issuer)) card.issuer = text(entry.issuer);
  return card;
}

/** The passenger specifications with the lost card among the first passenger's cards. */
function withLostCard(specs, card) {
  if (!card || !Array.isArray(specs) || specs.length === 0) return specs;
  const [first, ...rest] = specs;
  const others = list(first?.cards).filter((c) => c?.number !== card.number && !(card.code && c?.code === card.code));
  return [{ ...first, cards: [...others, card] }, ...rest];
}

/** The kind of the chosen offer: the lost tag its products carry, else the first asked. */
function kindOfOffer(offer, kinds) {
  const tags = new Set(list(offer?.products).flatMap((p) => list(p?.productTags)));
  return kinds.find((k) => tags.has(k)) || kinds[0] || null;
}

/** The leaves the parts of an offer ask for (requestedInformation), as paths. */
function askedPaths(offer) {
  const { summariseRequestedInformation } = require('./requestedInformation.js');
  return PART_LISTS.flatMap((key) => list(offer?.[key]))
    .map((part) => part?.requestedInformation)
    .filter((ri) => typeof ri === 'string' && ri !== '')
    .flatMap((ri) => summariseRequestedInformation(ri).leaves.map((leaf) => leaf.path));
}

/** Whether the offer asks for the data of the lost item. */
function asksForLostData(offer, kind) {
  const paths = askedPaths(offer);
  if (kind === 'CARD_LOST') return paths.some((p) => p.includes('cards'));
  return paths.some((p) => HOLDER_FIELDS.has(p[p.length - 1]));
}

/** The offer's fees: their number and, when they share a currency, their total; null without fees. */
function feesOf(offer) {
  const fees = list(offer?.fees);
  if (fees.length === 0) return null;
  const currency = fees[0]?.price?.currency;
  const priced = fees.every((f) => typeof f?.price?.amount === 'number' && f.price.currency === currency);
  return { count: fees.length, amount: priced ? fees.reduce((sum, f) => sum + f.price.amount, 0) : null, currency, scale: fees[0]?.price?.scale };
}

const WHAT = { TICKET_LOST: 'ticket', CARD_LOST: 'card' };
const NAMED = { TICKET_LOST: "the holder's name or date of birth", CARD_LOST: 'the card (cards.number)' };

/**
 * The checks of the chosen replacement offer: [{ name, ok, level, message }].
 * `level: 'warn'` is a WARNING line, anything else a test.
 */
function replacementChecks(offer, kinds, lostCard) {
  const kind = kindOfOffer(offer, kinds);
  if (!kind) return [];
  const what = WHAT[kind];
  const checks = [];
  const asks = asksForLostData(offer, kind);
  checks.push({
    name: `🔑 Lost ${what}: the replacement offer asks for the data of the lost ${what} (requestedInformation)`,
    ok: asks,
    level: 'warn',
    message: `no part of the chosen offer asks for ${NAMED[kind]}; OSDM says the provider asks for the data of the lost ticket or card`,
  });
  if (kind === 'CARD_LOST' && !lostCard) {
    checks.push({
      name: '🔑 Lost card: the scenario names the card to replace (lostCard: its number, and its code)',
      ok: false,
      message: "the scenario's data names no lost card: the booking cannot give its number",
    });
  }
  return checks;
}

function amountText(fees) {
  if (fees.amount === null) return `${fees.count} fee(s) in several currencies`;
  const scale = Number.isInteger(fees.scale) ? fees.scale : 2;
  return `${(fees.amount / 10 ** scale).toFixed(scale)} ${fees.currency} (${fees.count} fee(s))`;
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

function envJson(name, fallback) {
  const raw = bru.getEnvVar(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** The scenario's lost card, as the parser kept it. */
const scenarioLostCard = () => lostCardOf(envJson('__lostCard', null));

/** Step 01, once the offer is chosen: the replacement's checks and its fee. */
function recordReplacementChecks(test) {
  const kinds = lostKindsOf(envJson('OfferCollectionRequest', null));
  if (kinds.length === 0) return;
  const offer = envJson('offer', null);
  if (!offer) return;
  const kind = kindOfOffer(offer, kinds);
  const fees = feesOf(offer);
  validationLogger(`[INFO] 🔑 Replacement of a lost ${WHAT[kind]} (${kind}): ${offer.summary || offer.offerId}; ${fees ? `fee ${amountText(fees)}` : 'no fee'}.`);
  for (const c of replacementChecks(offer, kinds, scenarioLostCard())) {
    if (c.level === 'warn') {
      if (!c.ok) validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      continue;
    }
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  }
}

const rejectionArmed = () => String(bru.getEnvVar('lostCardExpectRejection')) === 'true';

/** Step 02, after the response: the booking of an unknown card must be refused. True when armed (the scenario ends). */
function checkLostCardRefused(status, body) {
  if (!rejectionArmed()) return false;
  const card = scenarioLostCard();
  validationLogger(`[INFO] 🧪 Unknown lost card probe — the booking names card ${card?.number || '(none)'}, which the provider should not know; a refusal is expected.`);
  const { validateProblemResponse } = require('./requestedInformation.js');
  validateProblemResponse({
    status,
    body,
    targets: [],
    prefix: '🧪 Unknown lost card probe',
    label: 'POST /bookings',
    assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
    log: (level, msg) => validationLogger(`[${level}] ${msg}`),
  });
  return true;
}

module.exports = {
  LOST_KINDS, lostKindsOf, lostCardOf, withLostCard, kindOfOffer, asksForLostData, feesOf, replacementChecks,
  scenarioLostCard, recordReplacementChecks, checkLostCardRefused,
};
