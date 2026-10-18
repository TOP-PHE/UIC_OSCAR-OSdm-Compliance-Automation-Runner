// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * aiModels.js — the models OSCAR knows, their list prices, and the cost and
 * spend of AI analyses (#831). Pure.
 *
 * Prices are Anthropic's list prices in US dollars per million tokens, as of
 * 2026-10 (no cache, no batch: an analysis is one plain call). They are an
 * estimate of what an analysis costs: the service's invoice is what counts.
 * A model not listed here costs what the Test Manager entered for it in the
 * AI service, else has no price.
 *
 * Claude Haiku 5.5 has two rate cards, chosen by the prompt's length: above
 * 100K input tokens the whole call is at the second.
 */

// The order is the list's: the suggested model first.
const ANTHROPIC_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', input: 4, output: 20, note: 'suggested: the most accurate for its price' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', input: 2, output: 10, note: 'half the price of Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, above: { tokens: 100_000, input: 0.5, output: 2.5 },
    note: 'the cheapest, for a first look' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', input: 10, output: 50, note: 'the most capable, and the most expensive' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', input: 5, output: 25 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', input: 2, output: 10 },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', input: 5, output: 25 },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', input: 5, output: 25 },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', input: 5, output: 25 },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', input: 3, output: 15 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', input: 1, output: 5 },
].map(Object.freeze));

const BY_ID = new Map(ANTHROPIC_MODELS.map((m) => [m.id, m]));

// A price as a page or a stored row gives it: two numbers of $/M, or null.
function customPrice(input, output) {
  const ok = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  return ok(input) && ok(output) ? { input, output } : null;
}

/**
 * The price of a model: { input, output, above?, source }, or null. A dated
 * id ("claude-opus-5-5-20261001") takes the price of the id it starts with.
 * `custom` is the Test Manager's { input, output } for a model OSCAR does not
 * know; it never replaces a known price.
 */
function priceOf(model, custom = null) {
  const id = String(model || '');
  let known = BY_ID.get(id) || null;
  if (!known) {
    for (const m of ANTHROPIC_MODELS) {
      if (id.startsWith(m.id + '-') && (!known || m.id.length > known.id.length)) known = m;
    }
  }
  if (known) {
    const price = { input: known.input, output: known.output, source: 'list' };
    if (known.above) price.above = known.above;
    return price;
  }
  const own = custom ? customPrice(custom.input, custom.output) : null;
  return own ? { ...own, source: 'custom' } : null;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/** The cost in US dollars of a call's tokens at a price, or null when either is missing. */
function costOf(price, usage) {
  if (!price) return null;
  const input = Number.isFinite(usage?.input) ? usage.input : null;
  const output = Number.isFinite(usage?.output) ? usage.output : null;
  if (input === null && output === null) return null;
  const rate = price.above && (input || 0) > price.above.tokens ? price.above : price;
  return round6(((input || 0) * rate.input + (output || 0) * rate.output) / 1e6);
}

/** What an analysis may cost before it is sent: the input, and the answer at most. */
function estimateOf(price, inputTokens, maxAnswerTokens) {
  if (!price) return null;
  return { input: costOf(price, { input: inputTokens, output: 0 }), atMost: costOf(price, { input: inputTokens, output: maxAnswerTokens }) };
}

/** The models of the list for a page: id, label, price, note. */
function modelsForPage() {
  return ANTHROPIC_MODELS.map((m) => ({ id: m.id, label: m.label, input: m.input, output: m.output, note: m.note || null,
    above: m.above || null }));
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;
const MAX_LISTED = 100;

/**
 * The answer of Anthropic's GET /v1/models as the page lists it: the models
 * the service offers, newest first as it gives them, each with its price when
 * OSCAR knows one. Null when the answer is not that shape.
 */
function modelsFromService(json) {
  if (!json || !Array.isArray(json.data)) return null;
  return json.data
    .filter((m) => m && typeof m.id === 'string' && m.id.length <= 200 && MODEL_PATTERN.test(m.id))
    .slice(0, MAX_LISTED)
    .map((m) => {
      const known = BY_ID.get(m.id);
      const price = priceOf(m.id);
      const label = typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name.trim().slice(0, 100) : (known?.label || m.id);
      return { id: m.id, label, input: price?.input ?? null, output: price?.output ?? null, note: known?.note || null, above: price?.above || null };
    });
}

/** The day ("2026-10-18") and month ("2026-10") of a stored "YYYY-MM-DD hh:mm:ss" time. */
const dayOf = (at) => String(at || '').slice(0, 10);
const monthOf = (at) => String(at || '').slice(0, 7);

function addTo(map, key, row) {
  const s = map.get(key) || { analyses: 0, tokens: 0, cost: 0, unpriced: 0 };
  s.analyses++;
  s.tokens += row.tokens;
  if (row.cost === null) s.unpriced++;
  else s.cost = round6(s.cost + row.cost);
  map.set(key, s);
}

/**
 * Spend from analysis rows ({ created_at, model, input_tokens, output_tokens,
 * cost_usd }): today, this month, per month (latest first, at most 12) and
 * per model this month. A row without a stored cost is priced now, from the
 * list or `custom`; `unpriced` counts the analyses with no price at all.
 * `now` is a Date.
 */
function spendOf(rows, now, custom = null) {
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const months = new Map();
  const models = new Map();
  const days = new Map();
  for (const r of rows || []) {
    const usage = { input: r.input_tokens, output: r.output_tokens };
    if (!Number.isFinite(usage.input) && !Number.isFinite(usage.output)) continue;
    const cost = Number.isFinite(r.cost_usd) ? r.cost_usd : costOf(priceOf(r.model, custom), usage);
    const row = { tokens: (usage.input || 0) + (usage.output || 0), cost };
    addTo(months, monthOf(r.created_at), row);
    addTo(days, dayOf(r.created_at), row);
    if (monthOf(r.created_at) === month) addTo(models, r.model, row);
  }
  const empty = { analyses: 0, tokens: 0, cost: 0, unpriced: 0 };
  return {
    today: days.get(today) || empty,
    month: months.get(month) || empty,
    months: [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([m, s]) => ({ month: m, ...s })),
    models: [...models.entries()].sort((a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0])).map(([model, s]) => ({ model, ...s })),
  };
}

/**
 * The monthly token limit suggested in the AI service form: 30 analyses of a
 * large batch (about 66,000 tokens each: input near the 50,000 the analysis
 * summarises at, plus a full answer).
 */
const SUGGESTED_MONTHLY_TOKENS = 2_000_000;

/** An instruction the form offers to insert: OSCAR's own instructions already say the rest. */
const SUGGESTED_INSTRUCTION = [
  'Be concrete and short: one group per cause, merged when two groups have the same cause.',
  'For each group, name the OSDM member or rule involved and quote the extract where it decides.',
  'When the provider\'s answer follows OSDM and OSCAR\'s request or check does not, say so plainly and give the owner oscar.',
  'When the failure comes from the test data or the Test Framework (a train that does not run that day, a tariff or capability the provider does not have), give the owner configuration and say what to change.',
  'Put the groups that block the most scenarios first. Say when you are not sure.',
].join('\n');

module.exports = {
  ANTHROPIC_MODELS, SUGGESTED_MONTHLY_TOKENS, SUGGESTED_INSTRUCTION,
  priceOf, costOf, estimateOf, customPrice, modelsForPage, modelsFromService, spendOf,
};
