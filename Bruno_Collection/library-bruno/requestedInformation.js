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

module.exports = {
  parseRequestedInformation,
  describeRequestedInformation,
  collectRequestedInformationLeaves: collectLeaves,
  summariseRequestedInformation,
  evaluateRequestedInformation,
  buildPassengerModelFromAdditionalData,
  MAX_LENGTH,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
