/*
Copyright UIC, Union Internationale des Chemins de fer
Licensed under the Apache License, Version 2.0 (the "License");
http://www.apache.org/licenses/LICENSE-2.0
*/

'use strict';

/**
 * currencies.js — a sale keeps its currency (#781).
 *
 * An offer request asks for at most one currency
 * (`offerSearchCriteria.currency`, ISO 4217); without one the provider
 * answers in its default currency, which a scenario may name
 * (`expectedCurrency`). The offers of the answer are in that currency, and so
 * are the booking, the refund offers and the exchange offers of the sale.
 *
 * A probe (`currencyExpectRejection`) asks for a currency the provider does
 * not sell. OSDM says nothing of what it must then do: a refusal or no offer
 * passes; offers in that currency fail (the provider sells it, so the Test
 * Framework should declare it); offers in another currency pass with a
 * warning (the answer does not say the currency asked is not sold).
 *
 * The pure part has no Bruno globals; the glue at the bottom has.
 */

require('./displays.js');

const ISO_4217 = /^[A-Z]{3}$/;

const isCode = (c) => typeof c === 'string' && ISO_4217.test(c);

/** Every currency named by a price (an object with `amount` and `currency`) in a value. */
function currenciesIn(value, out = new Set(), depth = 0) {
  if (depth > 12 || value == null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) currenciesIn(v, out, depth + 1);
    return out;
  }
  if (typeof value.currency === 'string' && 'amount' in value) out.add(value.currency);
  for (const [key, v] of Object.entries(value)) {
    if (key !== 'currency') currenciesIn(v, out, depth + 1);
  }
  return out;
}

const offerName = (offer, i) => (offer?.offerId ? `offer ${offer.offerId}` : `offer ${i + 1}`);

/**
 * The offers of an answer against the currency expected. One check: FAIL
 * (`level: 'fail'`) when no offer is in it alone, WARNING (`level: 'warn'`)
 * when some offers are in another one too. [] when there is no offer or no
 * currency is expected.
 */
function checkOffersCurrency(expected, response, why = 'asked') {
  const offers = Array.isArray(response?.offers) ? response.offers.filter(Boolean) : [];
  if (!isCode(expected) || offers.length === 0) return [];
  const off = offers.map((offer, i) => ({ i, offer, given: [...currenciesIn(offer)] }))
    .filter(({ given }) => given.some((c) => c !== expected));
  const shown = off.slice(0, 3).map(({ offer, i, given }) => `${offerName(offer, i)}: ${given.join(', ')}`).join('; ');
  return [{
    name: `Offer request: the offers are in ${expected} (${why})`,
    ok: off.length === 0,
    level: off.length === offers.length ? 'fail' : 'warn',
    message: `${off.length} of ${offers.length} offer(s) are priced in another currency (${shown}${off.length > 3 ? '; …' : ''})`,
  }];
}

/**
 * One after-sale answer against the sale's currency: every price in `value`
 * is in `sale`. One check, or [] when the sale's currency is not known or the
 * answer names no price.
 */
function checkAfterSaleCurrency(label, sale, value) {
  if (!isCode(sale)) return [];
  const given = [...currenciesIn(value)];
  if (given.length === 0) return [];
  const other = given.filter((c) => c !== sale);
  return [{
    name: `${label}: priced in the sale's currency (${sale})`,
    ok: other.length === 0,
    message: `priced in ${given.join(', ')}; the sale was in ${sale}`,
  }];
}

/**
 * What the provider did with a currency it does not sell: 'refused' (an error
 * status), 'no-offer', 'sold' (offers in that currency) or 'other' (offers in
 * other currencies only).
 */
function notSoldOutcome(status, body, asked) {
  if (typeof status !== 'number' || status >= 300) return 'refused';
  const offers = body && typeof body === 'object' && Array.isArray(body.offers) ? body.offers.filter(Boolean) : [];
  if (offers.length === 0) return 'no-offer';
  return offers.some((o) => currenciesIn(o).has(asked)) ? 'sold' : 'other';
}

// ── Bruno glue ─────────────────────────────────────────────────────────────

function readCriteria() {
  const raw = bru.getEnvVar('offerSearchCriteria');
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

/** The currency asked by the offer request, or null. */
function currencyAsked() {
  const c = readCriteria().currency;
  return isCode(c) ? c : null;
}

/** The currency the offers must be in, and why: the one asked, else the scenario's default. */
function currencyExpected() {
  const asked = currencyAsked();
  if (asked) return { currency: asked, why: 'asked' };
  const def = bru.getEnvVar('expectedCurrency');
  return isCode(def) ? { currency: def, why: 'no currency asked: the default currency' } : null;
}

const armed = () => String(bru.getEnvVar('currencyExpectRejection')) === 'true';

/**
 * Step 01, after the response, before the status check. True when the
 * not-sold probe is armed: it is graded here and the scenario ends.
 */
function checkCurrencyNotSold(status, body) {
  if (!armed()) return false;
  const asked = currencyAsked();
  const label = `🧪 Currency probe [${asked || 'no currency'}, POST /offers]`;
  if (!asked) {
    test(`${label}: the request asks for a currency`, () => {
      throw new Error('the scenario arms the currency probe but its offer search criteria name no currency');
    });
    return true;
  }
  validationLogger(`[INFO] 🧪 Currency probe — ${asked} is not declared in the Test Framework; the provider must not sell in it.`);
  const outcome = notSoldOutcome(status, body, asked);
  if (outcome === 'refused') {
    const { validateProblemResponse } = require('./requestedInformation.js');
    validateProblemResponse({
      status, body, targets: [], prefix: '🧪 Currency probe', label: `${asked}, POST /offers`,
      assert: (name, ok, msg) => test(name, () => { if (!ok) throw new Error(msg); }),
      log: (level, msg) => validationLogger(`[${level}] ${msg}`),
    });
    return true;
  }
  test(`${label}: no offer is sold in ${asked}`, () => {
    if (outcome === 'sold') {
      throw new Error(`POST /offers gave offers in ${asked}: the provider sells in it, so the Test Framework should declare it`);
    }
  });
  if (outcome === 'other') {
    validationLogger(`[WARNING] 🧪 Currency probe: offers in ${[...currenciesIn(body.offers)].join(', ')} instead of ${asked}, with nothing saying ${asked} is not sold; a refusal or a problem naming the currency helps a distributor.`);
  }
  return true;
}

/** Step 01, after the offer is chosen: the offers are in the currency expected; the sale's currency is kept. */
function checkSaleCurrency(jsonData, chosen) {
  const expected = currencyExpected();
  if (expected) {
    checkOffersCurrency(expected.currency, jsonData, expected.why).forEach((c) => {
      if (c.ok) validationLogger(`[INFO] ✔ ${c.name}`);
      else if (c.level === 'warn') validationLogger(`[WARNING] ${c.name} — ${c.message}`);
      else test(c.name, () => { throw new Error(c.message); });
    });
  }
  const sold = chosen ? [...currenciesIn(chosen.offerSummary || chosen)] : [];
  bru.setEnvVar('__saleCurrency', sold.length === 1 ? sold[0] : null);
}

/** An after-sale answer (refund offers, exchange offers) is in the sale's currency. */
function checkAfterSale(label, value) {
  checkAfterSaleCurrency(label, bru.getEnvVar('__saleCurrency'), value).forEach((c) => {
    test(c.name, () => { if (!c.ok) throw new Error(c.message); });
  });
}

module.exports = {
  currenciesIn, checkOffersCurrency, checkAfterSaleCurrency, notSoldOutcome,
  currencyAsked, currencyExpected, checkCurrencyNotSold, checkSaleCurrency, checkAfterSale,
};
