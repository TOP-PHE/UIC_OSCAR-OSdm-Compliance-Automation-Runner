'use strict';

/**
 * requestedInformation.js — OSDM `requestedInformation` parsing & surfacing (#258)
 * ================================================================================
 * OSDM lets a provider advertise, in a response, *which passenger data must be
 * populated before the client can proceed to the next step* (provisional booking
 * → confirmation). It does this through the `requestedInformation` string, which
 * appears on every offer part (`AbstractOfferPart`) of the offer response and at
 * the top level of the post-booking response (`Booking`).
 *
 * The value is a boolean expression (OSDM "Requested Information – Grammar"):
 *
 *   requested_information : class_index_attribute
 *                         | requested_information AND requested_information
 *                         | requested_information OR  requested_information
 *                         | '(' requested_information ')' ;
 *   class_index_attribute : Attribute '[' Identifier ']' ('.' Attribute)+ ;
 *   Attribute  : [a-zA-Z_]+ ;     Identifier : 'ANY' | <numeric index> ;
 *
 * Root collection is `passengerSpecifications`; index is numeric (one passenger)
 * or `ANY` (every passenger). A leaf is true when that attribute is populated;
 * the whole expression must be true to proceed.
 *
 * Phase 1 (this module): parse the expression, render it for humans, map each
 * leaf to the OSCAR scenario field a tester must set, and Layer-1 type-check the
 * raw string. Evaluation against the sent data model is Phase 2.
 *
 * This module is intentionally PURE (no `bru` / `test` / network) so it is unit
 * testable; the offer/booking handlers call summariseRequestedInformation() and
 * do the logging / assertions themselves.
 */

const MAX_LENGTH = 32768;

// ─── Field mapping ───────────────────────────────────────────────────────────
// OSDM leaf paths are keyed on their last segment, which is robust to the
// 3.0 (detail.email) vs 3.1+ (detail.contact.email) nesting difference.
const FIELD_LABELS = {
  firstName:   'first name',
  lastName:    'last name',
  gender:      'gender',
  dateOfBirth: 'date of birth',
  email:       'email',
  phoneNumber: 'phone number',
  type:        'passenger type',
};
const SCENARIO_FIELDS = {
  firstName:   'firstName',
  lastName:    'lastName',
  gender:      'gender',
  dateOfBirth: 'dateOfBirth',
  email:       'email',
  phoneNumber: 'phoneNumber',
  type:        'type',
};

function fieldInfo(path) {
  const last = path[path.length - 1];
  return {
    label:         FIELD_LABELS[last] || path.join('.'),
    scenarioField: SCENARIO_FIELDS[last] || null,
  };
}

function passengerRef(index) {
  return index === 'ANY' ? 'all passengers' : `passenger ${index}`;
}

// ─── Tokenizer ───────────────────────────────────────────────────────────────
function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[') { tokens.push({ t: '[' }); i++; continue; }
    if (c === ']') { tokens.push({ t: ']' }); i++; continue; }
    if (c === '(') { tokens.push({ t: '(' }); i++; continue; }
    if (c === ')') { tokens.push({ t: ')' }); i++; continue; }
    if (c === '.') { tokens.push({ t: '.' }); i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      tokens.push({ t: 'num', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z_]/.test(s[j])) j++;
      tokens.push({ t: 'word', v: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }
  return tokens;
}

// ─── Parser (recursive descent; OR lowest, AND higher, then primary) ──────────
function parseExpression(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (v) => {
    const t = peek();
    return !!t && t.t === 'word' && t.v.toUpperCase() === v;
  };

  function parseOr() {
    let left = parseAnd();
    while (isOp('OR')) { next(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parsePrimary();
    while (isOp('AND')) { next(); left = { type: 'and', left, right: parsePrimary() }; }
    return left;
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.t === '(') {
      next();
      const e = parseOr();
      if (!peek() || peek().t !== ')') throw new Error("Expected ')'");
      next();
      return e;
    }
    return parseLeaf();
  }
  function parseLeaf() {
    const root = next();
    if (!root || root.t !== 'word') throw new Error('Expected an attribute name');
    const up = root.v.toUpperCase();
    if (up === 'AND' || up === 'OR') throw new Error(`Unexpected operator '${root.v}'`);
    if (!peek() || peek().t !== '[') throw new Error(`Expected '[' after '${root.v}'`);
    next(); // [
    const idxTok = next();
    let index;
    if (idxTok && idxTok.t === 'num') index = parseInt(idxTok.v, 10);
    else if (idxTok && idxTok.t === 'word' && idxTok.v.toUpperCase() === 'ANY') index = 'ANY';
    else throw new Error("Expected a numeric index or 'ANY' inside '[]'");
    if (!peek() || peek().t !== ']') throw new Error("Expected ']'");
    next(); // ]
    if (!peek() || peek().t !== '.') throw new Error("Expected '.' after the index");
    const path = [];
    while (peek() && peek().t === '.') {
      next(); // .
      const a = next();
      if (!a || a.t !== 'word') throw new Error("Expected an attribute name after '.'");
      path.push(a.v);
    }
    if (path.length === 0) throw new Error('Expected at least one attribute after the index');
    return { type: 'leaf', root: root.v, index, path };
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new Error('Unexpected trailing tokens after expression');
  }
  return ast;
}

/**
 * Parse a requestedInformation expression.
 * @returns {{ok:boolean, ast:object|null, error:string|null}}
 */
function parseRequestedInformation(expr) {
  try {
    if (typeof expr !== 'string') return { ok: false, ast: null, error: 'requestedInformation is not a string' };
    const tokens = tokenize(expr);
    if (tokens.length === 0) return { ok: false, ast: null, error: 'empty expression' };
    const ast = parseExpression(tokens);
    return { ok: true, ast, error: null };
  } catch (e) {
    return { ok: false, ast: null, error: e && e.message ? e.message : String(e) };
  }
}

// ─── Human-readable description ───────────────────────────────────────────────
function renderNode(node) {
  if (!node) return '';
  if (node.type === 'leaf') {
    return `${fieldInfo(node.path).label} (${passengerRef(node.index)})`;
  }
  const op = node.type === 'and' ? 'AND' : 'OR';
  const render = (child) => {
    const s = renderNode(child);
    // Parenthesise a binary child of a different operator for clarity.
    return (child.type !== 'leaf' && child.type !== node.type) ? `(${s})` : s;
  };
  return `${render(node.left)} ${op} ${render(node.right)}`;
}

/** Human-readable rendering of a parsed AST. */
function describeRequestedInformation(ast) {
  return renderNode(ast);
}

// ─── Leaf collection ──────────────────────────────────────────────────────────
function collectLeaves(node, acc) {
  acc = acc || [];
  if (!node) return acc;
  if (node.type === 'leaf') {
    const fi = fieldInfo(node.path);
    acc.push({
      root: node.root,
      index: node.index,
      passengerRef: passengerRef(node.index),
      path: node.path,
      fieldLabel: fi.label,
      scenarioField: fi.scenarioField,
    });
    return acc;
  }
  collectLeaves(node.left, acc);
  collectLeaves(node.right, acc);
  return acc;
}

/**
 * One-shot summary used by the offer/booking handlers.
 * @returns {{
 *   present:boolean, typeOk:boolean, typeErrors:string[],
 *   parseOk:boolean, parseError:string|null, description:string|null,
 *   leaves:Array, unmappedFields:string[]
 * }}
 */
function summariseRequestedInformation(expr) {
  const present = expr !== null && expr !== undefined && expr !== '';

  const typeErrors = [];
  if (typeof expr !== 'string') typeErrors.push('not a string');
  else if (expr.length > MAX_LENGTH) typeErrors.push(`exceeds maxLength ${MAX_LENGTH} (got ${expr.length})`);
  const typeOk = typeErrors.length === 0;

  const parsed = present ? parseRequestedInformation(expr) : { ok: false, ast: null, error: 'absent' };
  const leaves = parsed.ok ? collectLeaves(parsed.ast) : [];
  const unmappedFields = leaves.filter((l) => !l.scenarioField).map((l) => l.path.join('.'));

  return {
    present,
    typeOk,
    typeErrors,
    parseOk: parsed.ok,
    parseError: parsed.ok ? null : parsed.error,
    ast: parsed.ok ? parsed.ast : null,
    description: parsed.ok ? renderNode(parsed.ast) : null,
    leaves,
    unmappedFields,
  };
}

// ─── Evaluation (Phase 2) ─────────────────────────────────────────────────────
function isSet(v) {
  return v !== undefined && v !== null && v !== '';
}

function getByPath(obj, pathArr) {
  return pathArr.reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

// Candidate locations for a leaf so a demand for the 3.1+ contact path is also
// satisfied by the deprecated 3.0 flat field (and vice-versa) — mirrors #231.
function leafCandidatePaths(path) {
  const last = path[path.length - 1];
  if (last === 'email') return [['detail', 'contact', 'email'], ['detail', 'email']];
  if (last === 'phoneNumber') return [['detail', 'contact', 'phoneNumber'], ['detail', 'phoneNumber']];
  return [path];
}

function leafSatisfiedFor(passenger, leaf) {
  if (!passenger) return false;
  return leafCandidatePaths(leaf.path).some((p) => isSet(getByPath(passenger, p)));
}

function collectionFor(model, root) {
  if (model && Array.isArray(model[root])) return model[root];
  if (model && Array.isArray(model.passengerSpecifications)) return model.passengerSpecifications;
  return [];
}

function evalNode(node, model) {
  if (node.type === 'leaf') {
    const collection = collectionFor(model, node.root);
    if (node.index === 'ANY') {
      if (!collection.length) return { satisfied: false, unmet: [{ leaf: node, index: 'ANY' }] };
      const failing = [];
      collection.forEach((pax, i) => { if (!leafSatisfiedFor(pax, node)) failing.push(i); });
      return failing.length === 0
        ? { satisfied: true, unmet: [] }
        : { satisfied: false, unmet: failing.map((i) => ({ leaf: node, index: i })) };
    }
    const pax = collection[node.index];
    return leafSatisfiedFor(pax, node)
      ? { satisfied: true, unmet: [] }
      : { satisfied: false, unmet: [{ leaf: node, index: node.index }] };
  }
  const l = evalNode(node.left, model);
  const r = evalNode(node.right, model);
  if (node.type === 'and') {
    return { satisfied: l.satisfied && r.satisfied, unmet: l.unmet.concat(r.unmet) };
  }
  // 'or': satisfied if either side is; only surface unmet when neither is met.
  const satisfied = l.satisfied || r.satisfied;
  return { satisfied, unmet: satisfied ? [] : l.unmet.concat(r.unmet) };
}

function unmetDescriptor(u) {
  const fi = fieldInfo(u.leaf.path);
  return {
    fieldLabel: fi.label,
    scenarioField: fi.scenarioField,
    root: u.leaf.root,
    path: u.leaf.path,
    index: u.index,
    passengerRef: passengerRef(u.index),
  };
}

/**
 * Evaluate a parsed expression against a passenger data model.
 * @param {object} ast    parsed AST from parseRequestedInformation / summarise.ast
 * @param {object} model  { passengerSpecifications: [ {type, dateOfBirth, gender,
 *                          detail:{firstName,lastName,contact:{email,phoneNumber}}}, … ] }
 * @returns {{satisfied:boolean, unmetLeaves:Array}}
 */
function evaluateRequestedInformation(ast, model) {
  if (!ast) return { satisfied: false, unmetLeaves: [] };
  const res = evalNode(ast, model || {});
  // Dedupe unmet by (field, passengerRef) for clean reporting.
  const seen = new Set();
  const unmetLeaves = [];
  res.unmet.map(unmetDescriptor).forEach((d) => {
    const key = `${d.scenarioField || d.path.join('.')}|${d.passengerRef}`;
    if (!seen.has(key)) { seen.add(key); unmetLeaves.push(d); }
  });
  return { satisfied: res.satisfied, unmetLeaves };
}

/**
 * Build the offer-time passenger data model from OSCAR's scenario data. The
 * `passengerAdditionalData` env var carries the per-passenger values OSCAR will
 * send (update* fields); `offerPassengerSpecifications` supplies `type`.
 * @returns {Array} normalised passengers (OSDM-ish shape) for evaluation.
 */
function buildPassengerModelFromAdditionalData(additionalArr, specsArr) {
  const add = Array.isArray(additionalArr) ? additionalArr : [];
  const specs = Array.isArray(specsArr) ? specsArr : [];
  return add.map((raw, i) => {
    const a = raw || {};
    const spec = specs[i] || {};
    const pick = (...vals) => { for (const v of vals) { if (v !== undefined && v !== null) return v; } return null; };
    return {
      type: pick(spec.type, a.type),
      dateOfBirth: pick(a.updateDateOfBirth, spec.dateOfBirth),
      gender: pick(a.updateGender, spec.gender),
      detail: {
        firstName: pick(a.updateFirstName),
        lastName: pick(a.updateLastName),
        contact: {
          email: pick(a.updateEmail),
          phoneNumber: pick(a.updatePhoneNumber),
        },
      },
    };
  });
}

// ─── Static conformance (Phase 3b) ────────────────────────────────────────────
// Known passenger attributes OSCAR recognises (last path segment). Anything else
// is reported as an unknown path (S3 — WARN, allow-list may be incomplete).
const KNOWN_LAST_SEGMENTS = new Set(Object.keys(SCENARIO_FIELDS));

/**
 * Static issues for a parsed expression's leaves.
 * @param {object} ast              parsed AST
 * @param {number} [passengerCount] number of passengers in the request (for index range)
 * @returns {{ indexErrors:Array, unknownPaths:string[] }}
 */
function staticIssues(ast, passengerCount) {
  const leaves = ast ? collectLeaves(ast) : [];
  const indexErrors = [];
  const unknownPaths = [];
  leaves.forEach((l) => {
    if (typeof l.index === 'number'
        && typeof passengerCount === 'number' && passengerCount >= 0
        && l.index >= passengerCount) {
      indexErrors.push({ index: l.index, passengerCount, path: l.path.join('.') });
    }
    const last = l.path[l.path.length - 1];
    if (!KNOWN_LAST_SEGMENTS.has(last)) unknownPaths.push(l.path.join('.'));
  });
  return { indexErrors, unknownPaths };
}

// ─── Auto-feed (Phase 3a) ──────────────────────────────────────────────────────
// Maps a scenario field to the passengerAdditionalData key the PATCH step reads.
const AUTO_FEED_UPDATE_KEYS = {
  firstName: 'updateFirstName',
  lastName: 'updateLastName',
  gender: 'updateGender',
  dateOfBirth: 'updateDateOfBirth',
  email: 'updateEmail',
  phoneNumber: 'updatePhoneNumber',
};

/** A valid sample value for a demanded field (gender uses the OSDM enum). */
function sampleValueForField(scenarioField, index, passengerType) {
  const n = (typeof index === 'number' ? index : 0) + 1;
  switch (scenarioField) {
    case 'firstName':  return 'Test';
    case 'lastName':   return 'Passenger' + n;
    case 'email':      return `oscar.autofeed+${n}@example.org`;
    case 'phoneNumber': return '+3310000000' + (n % 10);
    case 'gender':     return 'MALE'; // valid OSDM Gender enum [MALE, FEMALE, X]
    case 'dateOfBirth': {
      const t = String(passengerType || '').toUpperCase();
      if (t.includes('CHILD') || t.includes('YOUTH') || t.includes('INFANT')) return '2016-01-01';
      if (t.includes('SENIOR')) return '1950-01-01';
      return '1990-01-01';
    }
    default: return null;
  }
}

/**
 * Fill auto-feed values for unmet, mappable leaves into a copy of the
 * passengerAdditionalData array. Only fills fields that are currently empty
 * (never overwrites tester-provided data). `ANY`/non-numeric indices are skipped
 * — evaluateRequestedInformation already expands ANY to concrete passenger
 * indices in unmetLeaves.
 * @returns {{ additional:Array, provided:Array }}
 */
function applyAutoFeed(additionalArr, unmetLeaves, specsArr) {
  const additional = Array.isArray(additionalArr) ? additionalArr.map((x) => Object.assign({}, x)) : [];
  const specs = Array.isArray(specsArr) ? specsArr : [];
  const provided = [];
  (unmetLeaves || []).forEach((u) => {
    const updateKey = AUTO_FEED_UPDATE_KEYS[u.scenarioField];
    if (!updateKey) return;                       // unmappable (taxId/card) or type → can't PATCH
    if (typeof u.index !== 'number') return;      // unmet leaves carry concrete indices
    while (additional.length <= u.index) additional.push({});
    const entry = additional[u.index];
    if (isSet(entry[updateKey])) return;          // keep tester-provided values
    const passengerType = (specs[u.index] && specs[u.index].type) || entry.type || null;
    const value = sampleValueForField(u.scenarioField, u.index, passengerType);
    if (value === null) return;
    entry[updateKey] = value;
    provided.push({
      index: u.index, scenarioField: u.scenarioField, updateKey,
      value, fieldLabel: u.fieldLabel, passengerRef: u.passengerRef,
    });
  });
  return { additional, provided };
}

// ─── Orchestrator (used by the offer & booking handlers) ──────────────────────
/**
 * Process one requestedInformation value end-to-end: static assertions (S1/S2/
 * S3/S4), evaluation against the passenger data OSCAR will send, and — unless a
 * negative probe is active — auto-feed of missing demanded fields. Pure except
 * via injected callbacks, so it is unit-testable with mocks.
 *
 * @param {object} o
 * @param {string}   o.expr            raw requestedInformation string
 * @param {string}   o.tag             context label (e.g. "admissionOfferParts[0]" / "booking")
 * @param {Array}    o.additional      passengerAdditionalData (not mutated; a new array is returned)
 * @param {Array}    o.specs           passenger specs (for `type` + count)
 * @param {number}   o.passengerCount  passenger count for index-range checks
 * @param {boolean}  o.autoFeedOn      whether to auto-provide missing fields
 * @param {function} o.assert          (name, okBool, failMsg) — FAIL semantics
 * @param {function} o.log             (level, msg) — 'INFO' | 'WARNING'
 * @returns {{ additional:Array, provided:Array, satisfied:boolean, parseOk:boolean }}
 */
function processRequestedInformation(o) {
  const { expr, tag, specs, passengerCount, autoFeedOn, assert, log } = o;
  let additional = Array.isArray(o.additional) ? o.additional : [];
  const s = summariseRequestedInformation(expr);

  assert(`${tag}.requestedInformation is a valid OSDM type (string, <=${MAX_LENGTH})`,
    s.typeOk, `type errors: ${s.typeErrors.join('; ')}`);
  assert(`${tag}.requestedInformation parses against the OSDM grammar`,
    s.parseOk, `parse error: ${s.parseError}`);
  if (!s.parseOk) return { additional, provided: [], satisfied: false, parseOk: false };

  log('INFO', `${tag} requests additional information before the next step: ${s.description}`);

  const issues = staticIssues(s.ast, passengerCount);
  assert(`${tag}.requestedInformation passenger indices are in range`,
    issues.indexErrors.length === 0,
    `out-of-range index(es): ${issues.indexErrors.map((e) => `[${e.index}] >= ${e.passengerCount}`).join(', ')}`);
  if (issues.unknownPaths.length) {
    log('WARNING', `${tag}.requestedInformation references attribute(s) OSCAR does not recognise: ${[...new Set(issues.unknownPaths)].join(', ')}`);
  }

  s.leaves.forEach((l) => {
    if (l.scenarioField) {
      log('INFO', `  → '${l.scenarioField}' (${l.fieldLabel}) on ${l.passengerRef} — OSDM: ${l.root}[${l.index}].${l.path.join('.')}`);
    } else {
      log('WARNING', `  → '${l.path.join('.')}' on ${l.passengerRef} is not configurable in OSCAR — OSDM: ${l.root}[${l.index}].${l.path.join('.')}`);
    }
  });

  const evalNow = () => evaluateRequestedInformation(
    s.ast, { passengerSpecifications: buildPassengerModelFromAdditionalData(additional, specs) });

  let res = evalNow();
  const provided = [];
  if (res.satisfied) {
    log('INFO', `${tag} requestedInformation is already satisfied by the scenario's passenger data.`);
    return { additional, provided, satisfied: true, parseOk: true };
  }

  if (autoFeedOn) {
    const r = applyAutoFeed(additional, res.unmetLeaves, specs);
    additional = r.additional;
    r.provided.forEach((p) => {
      provided.push(p);
      log('INFO', `Auto-provided '${p.scenarioField}' (${p.fieldLabel}) = '${p.value}' for ${p.passengerRef} to satisfy ${tag}.requestedInformation`);
    });
    res = evalNow();
    const mappableRemaining = res.unmetLeaves.filter((u) => u.scenarioField);
    assert(`${tag}.requestedInformation is satisfiable from OSCAR scenario fields (auto-fed)`,
      mappableRemaining.length === 0,
      `still unmet after auto-feed: ${mappableRemaining.map((u) => `${u.scenarioField}@${u.passengerRef}`).join(', ')}`);
    res.unmetLeaves.filter((u) => !u.scenarioField).forEach((u) => {
      log('WARNING', `${tag}: cannot auto-provide '${u.path.join('.')}' for ${u.passengerRef} (not configurable in OSCAR) — booking/confirmation may be rejected.`);
    });
  } else {
    log('INFO', `${tag} requestedInformation unmet and auto-feed disabled — expecting the provider to reject the next step.`);
    res.unmetLeaves.forEach((u) => {
      log('INFO', `  → withholding '${u.scenarioField || u.path.join('.')}' for ${u.passengerRef}`);
    });
  }
  return { additional, provided, satisfied: res.satisfied, parseOk: true };
}

module.exports = {
  parseRequestedInformation,
  describeRequestedInformation,
  collectRequestedInformationLeaves: collectLeaves,
  summariseRequestedInformation,
  evaluateRequestedInformation,
  buildPassengerModelFromAdditionalData,
  staticIssues,
  sampleValueForField,
  applyAutoFeed,
  processRequestedInformation,
  AUTO_FEED_UPDATE_KEYS,
  MAX_LENGTH,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
