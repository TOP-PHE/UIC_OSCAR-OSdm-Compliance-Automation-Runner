// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * currencies.js — the currencies a provider sells in (#781). Pure.
 *
 * The Test Framework declares them as `currencies: { sold: ['CZK', 'EUR'],
 * default: 'CZK' }`: every currency an offer request may ask for, and the one
 * the provider answers in when none is asked. The default is one of the sold
 * ones; a default not in the list is added to it. Nothing declared: every
 * currency is accepted and none is tested.
 */

const ISO_4217 = /^[A-Z]{3}$/;

// Currencies a provider is told it does not sell, the first not declared,
// for the negative probe: common ones, so the request is otherwise sound.
const NOT_SOLD_CANDIDATES = Object.freeze(['USD', 'JPY', 'GBP', 'AUD', 'CAD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'EUR', 'CZK']);

const code = (c) => (typeof c === 'string' && ISO_4217.test(c.trim()) ? c.trim() : null);

/** The declared currencies: { sold: [...], default: 'XXX' | null }; sold is [] when none is declared. */
function currenciesOf(fw) {
  const c = fw?.currencies;
  const sold = Array.isArray(c?.sold) ? [...new Set(c.sold.map(code).filter(Boolean))] : [];
  const def = code(c?.default);
  if (def && !sold.includes(def)) sold.unshift(def);
  return { sold, default: def };
}

/** True when the framework accepts this currency: none declared, or declared. */
function currencyDeclared(fw, currency) {
  const { sold } = currenciesOf(fw);
  return sold.length === 0 || sold.includes(currency);
}

/** The currency the not-sold probe asks for: the first common one not declared; null when none is declared. */
function currencyNotSold(fw) {
  const { sold } = currenciesOf(fw);
  if (sold.length === 0) return null;
  return NOT_SOLD_CANDIDATES.find((c) => !sold.includes(c)) || null;
}

module.exports = { ISO_4217, NOT_SOLD_CANDIDATES, currenciesOf, currencyDeclared, currencyNotSold };
