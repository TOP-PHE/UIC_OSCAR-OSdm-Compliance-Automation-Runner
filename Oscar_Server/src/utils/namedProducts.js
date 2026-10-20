// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * namedProducts.js — the products (tariffs) a provider sells, as the Test
 * Framework declares them (#887 PR 2). Pure.
 *
 * `products` in the framework is a list of { code, name, flexibility }: the
 * product's code as the provider writes it in an offer (`products[].code`,
 * which a scenario's `expectedProduct` names, #598), a name for people, and
 * its flexibility (FULL_FLEXIBLE, SEMI_FLEXIBLE or NON_FLEXIBLE; optional).
 * Absent = none declared: the catalogue's named-product scenario cannot be
 * copied.
 *
 * A checklist (#795) gives them in question A4.18: `data.products=YES` or
 * `=NO`, and the table `data.product.<n>.code` / `.name` / `.flexibility`.
 *
 * PR 3: `groupProducts` lists the group tariffs the same way, each with the
 * group sizes it takes (`minPassengers`, `maxPassengers`, 1 to 99, optional).
 * Checklist A4.19: `data.groupProducts=YES` / `=NO` and the table
 * `data.groupProduct.<n>.code` / `.name` / `.flexibility` / `.min` / `.max`.
 */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

const FLEXIBILITIES = ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'];
const MAX = { code: 60, name: 120 };
const MAX_PRODUCTS = 50;

/** A flexibility as the framework keeps it ("full flexible", "Non-flexible"…), or null. */
function flexibilityOf(value) {
  const t = text(value).toUpperCase().replaceAll(/[\s-]+/g, '_');
  return FLEXIBILITIES.includes(t) ? t : null;
}

/** One declared product, cleaned, or null when it has no code. */
function productOf(entry) {
  if (!isObj(entry)) return null;
  const code = text(entry.code).slice(0, MAX.code);
  if (!code) return null;
  const product = { code };
  const name = text(entry.name).slice(0, MAX.name);
  if (name) product.name = name;
  const flexibility = flexibilityOf(entry.flexibility);
  if (flexibility) product.flexibility = flexibility;
  return product;
}

// A group size: a whole number from 1 to 99 ("19" or 19), or null.
function sizeOf(value) {
  const n = typeof value === 'string' && /^\s*\d{1,2}\s*$/.test(value) ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null;
}

/** One declared group product: a product, plus the group sizes it takes. */
function groupProductOf(entry) {
  const product = productOf(entry);
  if (!product) return null;
  const min = sizeOf(entry.minPassengers ?? entry.min);
  const max = sizeOf(entry.maxPassengers ?? entry.max);
  if (min !== null) product.minPassengers = min;
  if (max !== null && (min === null || max >= min)) product.maxPassengers = max;
  return product;
}

// A framework's list under `key`, cleaned by `clean`: each code once, in order.
function declaredList(framework, key, clean) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const out = [];
  for (const item of (Array.isArray(fw?.[key]) ? fw[key] : []).map(clean)) {
    if (!item || out.some((p) => p.code === item.code)) continue;
    out.push(item);
    if (out.length === MAX_PRODUCTS) break;
  }
  return out;
}

/** The products a framework declares: each with a code, each code once, in order. */
const declaredProducts = (framework) => declaredList(framework, 'products', productOf);

/** PR 3: the group products a framework declares, likewise. */
const declaredGroupProducts = (framework) => declaredList(framework, 'groupProducts', groupProductOf);

// A checklist table `data.<tag>.<n>.<field>`: [] for NO, its rows by number
// for YES, null when the question is not answered.
function rowsFromChecklist(answers, question, tag, fields) {
  const a = isObj(answers) ? answers : {};
  if (a[`data.${question}=NO`] === true) return [];
  if (a[`data.${question}=YES`] !== true) return null;
  const prefix = `data.${tag}.`;
  const rows = new Map();
  for (const [key, value] of Object.entries(a)) {
    if (!key.startsWith(prefix) || typeof value !== 'string') continue;
    const [n, field, ...rest] = key.slice(prefix.length).split('.');
    if (rest.length > 0 || !/^\d{1,3}$/.test(n) || !fields.includes(field)) continue;
    if (!rows.has(Number(n))) rows.set(Number(n), {});
    rows.get(Number(n))[field] = value;
  }
  return [...rows.keys()].sort((x, y) => x - y).map((n) => rows.get(n));
}

/** The products a checklist's A4.18 declares, or null when it is not answered. */
function productsFromChecklist(answers) {
  const rows = rowsFromChecklist(answers, 'products', 'product', ['code', 'name', 'flexibility']);
  return rows && declaredProducts({ products: rows });
}

/** PR 3: the group products a checklist's A4.19 declares, or null. */
function groupProductsFromChecklist(answers) {
  const rows = rowsFromChecklist(answers, 'groupProducts', 'groupProduct', ['code', 'name', 'flexibility', 'min', 'max']);
  return rows && declaredGroupProducts({ groupProducts: rows });
}

module.exports = {
  FLEXIBILITIES, flexibilityOf, sizeOf, declaredProducts, productsFromChecklist, declaredGroupProducts, groupProductsFromChecklist,
};
