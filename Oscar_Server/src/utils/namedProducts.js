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

/** The products a framework declares: each with a code, each code once, in order. */
function declaredProducts(framework) {
  const fw = isObj(framework?.config) ? framework.config : framework;
  const out = [];
  for (const product of (Array.isArray(fw?.products) ? fw.products : []).map(productOf)) {
    if (!product || out.some((p) => p.code === product.code)) continue;
    out.push(product);
    if (out.length === MAX_PRODUCTS) break;
  }
  return out;
}

/**
 * The products a checklist's A4.18 declares: [] for NO, the table's rows for
 * YES, null when the question is not answered.
 */
function productsFromChecklist(answers) {
  const a = isObj(answers) ? answers : {};
  if (a['data.products=NO'] === true) return [];
  if (a['data.products=YES'] !== true) return null;
  const rows = new Map();
  for (const [tag, value] of Object.entries(a)) {
    const m = /^data\.product\.(\d{1,3})\.(code|name|flexibility)$/.exec(tag);
    if (!m || typeof value !== 'string') continue;
    const n = Number(m[1]);
    if (!rows.has(n)) rows.set(n, {});
    rows.get(n)[m[2]] = value;
  }
  return declaredProducts({ products: [...rows.keys()].sort((x, y) => x - y).map((n) => rows.get(n)) });
}

module.exports = { FLEXIBILITIES, flexibilityOf, declaredProducts, productsFromChecklist };
