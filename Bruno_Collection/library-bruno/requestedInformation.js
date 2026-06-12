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
 * #258 purchaser support: the grammar's root token is generic, so a provider may
 * also demand purchaser data with a `purchaser[…].…` leaf (not in the published
 * examples, but valid syntax). The engine is therefore ROOT-AWARE: a leaf's root
 * decides the subject it refers to — `passengerSpecifications` → an indexed
 * passenger; `purchaser` → the single purchaser object (the index is ignored).
 * Each kind has its own evaluation subject and its own auto-feed/probe channel.
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

// #258: a leaf's ROOT decides the "subject" it refers to. passengerSpecifications
// → an indexed passenger; purchaser → the single purchaser object (index ignored).
// Unknown roots are tolerated but flagged (staticIssues.unknownRoots).
const ROOT_KIND = { passengerSpecifications: 'passenger', purchaser: 'purchaser' };
function rootKind(root) { return ROOT_KIND[root] || 'other'; }
function subjectRef(root, index) {
  return rootKind(root) === 'purchaser' ? 'the purchaser' : passengerRef(index);
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
    return `${fieldInfo(node.path).label} (${subjectRef(node.root, node.index)})`;
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
    const ref = subjectRef(node.root, node.index);
    acc.push({
      root: node.root,
      kind: rootKind(node.root),
      index: node.index,
      passengerRef: ref, // back-compat name; root-aware value ('the purchaser' for purchaser leaves)
      subjectRef: ref,
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
    // #258: the purchaser is a SINGLE object (not a collection); the index is
    // immaterial — `purchaser[0]` / `purchaser[ANY]` both mean "the purchaser".
    if (rootKind(node.root) === 'purchaser') {
      const subject = model && model.purchaser;
      return leafSatisfiedFor(subject, node)
        ? { satisfied: true, unmet: [] }
        : { satisfied: false, unmet: [{ leaf: node, index: node.index }] };
    }
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
  const ref = subjectRef(u.leaf.root, u.index);
  return {
    fieldLabel: fi.label,
    scenarioField: fi.scenarioField,
    root: u.leaf.root,
    kind: rootKind(u.leaf.root),
    path: u.leaf.path,
    index: u.index,
    passengerRef: ref,
    subjectRef: ref,
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

/**
 * Build the PURCHASER data model (a single object, not a collection) from OSCAR's
 * scenario data. `purchaserAdditional` carries update* override values (parallel
 * to passengerAdditionalData, used by the POST/PATCH purchaser step); `purchaserSpec`
 * is the scenario's purchaser (bookingPurchaserSpecifications) supplying fields
 * already set. Tolerates the 3.0 flat (detail.email) vs 3.1+ (detail.contact.email)
 * shapes on the spec side.
 * @returns {object} normalised purchaser (OSDM-ish) for evaluation.
 */
function buildPurchaserModelFromAdditionalData(purchaserAdditional, purchaserSpec) {
  const a = (purchaserAdditional && typeof purchaserAdditional === 'object') ? purchaserAdditional : {};
  const s = (purchaserSpec && typeof purchaserSpec === 'object') ? purchaserSpec : {};
  const sd = (s.detail && typeof s.detail === 'object') ? s.detail : {};
  const sc = (sd.contact && typeof sd.contact === 'object') ? sd.contact : {};
  const pick = (...vals) => { for (const v of vals) { if (v !== undefined && v !== null) return v; } return null; };
  return {
    type: pick(s.type, a.type),
    dateOfBirth: pick(a.updateDateOfBirth, s.dateOfBirth, sd.dateOfBirth),
    gender: pick(a.updateGender, s.gender, sd.gender),
    detail: {
      firstName: pick(a.updateFirstName, sd.firstName),
      lastName: pick(a.updateLastName, sd.lastName),
      contact: {
        email: pick(a.updateEmail, sc.email, sd.email),
        phoneNumber: pick(a.updatePhoneNumber, sc.phoneNumber, sd.phoneNumber),
      },
    },
  };
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
  const unknownRoots = [];
  leaves.forEach((l) => {
    const kind = rootKind(l.root);
    // Index range applies to passengers only — the purchaser is a single object,
    // so `purchaser[0]`/`purchaser[3]` carry no out-of-range meaning.
    if (kind === 'passenger'
        && typeof l.index === 'number'
        && typeof passengerCount === 'number' && passengerCount >= 0
        && l.index >= passengerCount) {
      indexErrors.push({ index: l.index, passengerCount, path: l.path.join('.') });
    }
    const last = l.path[l.path.length - 1];
    if (!KNOWN_LAST_SEGMENTS.has(last)) unknownPaths.push(l.path.join('.'));
    if (kind === 'other') unknownRoots.push(l.root);
  });
  return { indexErrors, unknownPaths, unknownRoots };
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

/**
 * Auto-feed missing mappable PURCHASER fields into a copy of the purchaser
 * additional-data object (single object, not an array). Only fills empty fields;
 * never overwrites tester/scenario-provided values. The POST/PATCH purchaser step
 * reads these update* keys. @returns {{ purchaserAdditional:object, provided:Array }}
 */
function applyPurchaserAutoFeed(purchaserAdditional, unmetLeaves, purchaserSpec) {
  const out = (purchaserAdditional && typeof purchaserAdditional === 'object')
    ? Object.assign({}, purchaserAdditional) : {};
  const provided = [];
  (unmetLeaves || []).forEach((u) => {
    const updateKey = AUTO_FEED_UPDATE_KEYS[u.scenarioField];
    if (!updateKey) return;               // unmappable (taxId/companyDetails) → can't PATCH
    if (isSet(out[updateKey])) return;    // keep scenario/tester-provided values
    const type = (purchaserSpec && purchaserSpec.type) || out.type || null;
    const value = sampleValueForField(u.scenarioField, 0, type);
    if (value === null) return;
    out[updateKey] = value;
    provided.push({
      scenarioField: u.scenarioField, updateKey, value,
      fieldLabel: u.fieldLabel, subjectRef: u.subjectRef || 'the purchaser',
    });
  });
  return { purchaserAdditional: out, provided };
}

/** A deliberately INVALID value for a field, for the negative probe (Phase 3c).
 *  Returns null for fields with no clear invalid form (those get omitted instead). */
function invalidValueForField(scenarioField) {
  switch (scenarioField) {
    case 'gender':      return 'ZZZ';            // not in OSDM enum [MALE, FEMALE, X]
    case 'email':       return 'not-an-email';   // no '@'
    case 'phoneNumber': return 'not-a-phone';
    case 'dateOfBirth': return 'not-a-date';
    default:            return null;             // names/type: no clear invalid form
  }
}

// ─── Orchestrator (used by the offer & booking handlers) ──────────────────────
/**
 * Process one requestedInformation value end-to-end: static assertions (S1/S2/
 * S3/S4), then either AUTO-FEED missing demanded fields (happy path) or, under a
 * negative probe, deliberately OMIT or set INVALID values so the provider must
 * reject. Pure except via injected callbacks, so it is unit-testable with mocks.
 *
 * Root-aware (#258): passenger leaves use the passengerAdditionalData channel (the
 * PATCH-passenger step); purchaser leaves use a SEPARATE purchaserAdditional channel
 * (the POST/PATCH-purchaser step). The two channels have independent modes so a run
 * can, e.g., auto-feed passengers while withholding the purchaser.
 *
 * @param {object} o
 * @param {string}   o.expr             raw requestedInformation string
 * @param {string}   o.tag              context label (e.g. "admissionOfferParts[0]" / "booking")
 * @param {Array}    o.additional       passengerAdditionalData (not mutated; a new array is returned)
 * @param {Array}    o.specs            passenger specs (for `type` + count)
 * @param {number}   o.passengerCount   passenger count for index-range checks
 * @param {string}   [o.mode]           passenger mode: 'autofeed' | 'omit' | 'invalid'
 * @param {boolean}  [o.autoFeedOn]     legacy: true→'autofeed', false→'omit' (used if mode absent)
 * @param {object}   [o.purchaserAdditional] purchaser update* overrides (not mutated; a copy is returned)
 * @param {object}   [o.purchaserSpec]  the scenario purchaser (bookingPurchaserSpecifications)
 * @param {string}   [o.purchaserMode]  purchaser mode: 'autofeed' (default) | 'omit' | 'invalid'
 * @param {function} o.assert           (name, okBool, failMsg) — FAIL semantics
 * @param {function} o.log              (level, msg) — 'INFO' | 'WARNING'
 * @returns {{ additional:Array, provided:Array, probeTargets:Array,
 *            purchaserAdditional:object, purchaserProvided:Array, purchaserProbeTargets:Array,
 *            satisfied:boolean, parseOk:boolean }}
 */
function processRequestedInformation(o) {
  const { expr, tag, specs, passengerCount, assert, log } = o;
  const paxMode = o.mode || (o.autoFeedOn === false ? 'omit' : 'autofeed');
  // Only 'omit'/'invalid' are negative probes; anything else (inline/deferred/
  // undefined) means "satisfy it" → autofeed.
  const purMode = (o.purchaserMode === 'omit' || o.purchaserMode === 'invalid') ? o.purchaserMode : 'autofeed';
  let additional = Array.isArray(o.additional) ? o.additional.map((x) => Object.assign({}, x)) : [];
  let purchaserAdditional = (o.purchaserAdditional && typeof o.purchaserAdditional === 'object')
    ? Object.assign({}, o.purchaserAdditional) : {};
  const purchaserSpec = o.purchaserSpec || null;

  const provided = [];
  const probeTargets = [];
  const purchaserProvided = [];
  const purchaserProbeTargets = [];
  const result = () => ({
    additional, provided, probeTargets,
    purchaserAdditional, purchaserProvided, purchaserProbeTargets,
    satisfied: false, parseOk: true,
  });

  const s = summariseRequestedInformation(expr);

  assert(`${tag}.requestedInformation is a valid OSDM type (string, <=${MAX_LENGTH})`,
    s.typeOk, `type errors: ${s.typeErrors.join('; ')}`);
  assert(`${tag}.requestedInformation parses against the OSDM grammar`,
    s.parseOk, `parse error: ${s.parseError}`);
  if (!s.parseOk) { const r = result(); r.parseOk = false; return r; }

  log('INFO', `${tag} requests additional information before the next step: ${s.description}`);

  const issues = staticIssues(s.ast, passengerCount);
  assert(`${tag}.requestedInformation passenger indices are in range`,
    issues.indexErrors.length === 0,
    `out-of-range index(es): ${issues.indexErrors.map((e) => `[${e.index}] >= ${e.passengerCount}`).join(', ')}`);
  if (issues.unknownPaths.length) {
    log('WARNING', `${tag}.requestedInformation references attribute(s) OSCAR does not recognise: ${[...new Set(issues.unknownPaths)].join(', ')}`);
  }
  if (issues.unknownRoots.length) {
    log('WARNING', `${tag}.requestedInformation references unknown root object(s): ${[...new Set(issues.unknownRoots)].join(', ')} — OSCAR handles 'passengerSpecifications' and 'purchaser'.`);
  }

  s.leaves.forEach((l) => {
    if (l.scenarioField) {
      log('INFO', `  → '${l.scenarioField}' (${l.fieldLabel}) on ${l.subjectRef} — OSDM: ${l.root}[${l.index}].${l.path.join('.')}`);
    } else {
      log('WARNING', `  → '${l.path.join('.')}' on ${l.subjectRef} is not configurable in OSCAR — OSDM: ${l.root}[${l.index}].${l.path.join('.')}`);
    }
  });

  const paxLeaves = s.leaves.filter((l) => l.kind === 'passenger');
  const purLeaves = s.leaves.filter((l) => l.kind === 'purchaser');
  const evalNow = () => evaluateRequestedInformation(s.ast, {
    passengerSpecifications: buildPassengerModelFromAdditionalData(additional, specs),
    purchaser: buildPurchaserModelFromAdditionalData(purchaserAdditional, purchaserSpec),
  });

  let paxSatisfied = true;
  let purSatisfied = true;

  // ── PASSENGER channel (passengerAdditionalData → PATCH-passenger step) ──────
  if (paxLeaves.length) {
    if (paxMode === 'autofeed') {
      let unmet = evalNow().unmetLeaves.filter((u) => u.kind === 'passenger');
      if (unmet.length === 0) {
        log('INFO', `${tag} requestedInformation is already satisfied by the scenario's passenger data.`);
      } else {
        const r = applyAutoFeed(additional, unmet, specs);
        additional = r.additional;
        r.provided.forEach((p) => {
          provided.push(p);
          log('INFO', `Auto-provided '${p.scenarioField}' (${p.fieldLabel}) = '${p.value}' for ${p.passengerRef} to satisfy ${tag}.requestedInformation`);
        });
        unmet = evalNow().unmetLeaves.filter((u) => u.kind === 'passenger');
        const mappableRemaining = unmet.filter((u) => u.scenarioField);
        assert(`${tag}.requestedInformation is satisfiable from OSCAR scenario fields (auto-fed)`,
          mappableRemaining.length === 0,
          `still unmet after auto-feed: ${mappableRemaining.map((u) => `${u.scenarioField}@${u.passengerRef}`).join(', ')}`);
        unmet.filter((u) => !u.scenarioField).forEach((u) => {
          log('WARNING', `${tag}: cannot auto-provide '${u.path.join('.')}' for ${u.passengerRef} (not configurable in OSCAR) — booking/confirmation may be rejected.`);
        });
      }
      paxSatisfied = evalNow().unmetLeaves.every((u) => u.kind !== 'passenger');
    } else {
      // Negative probe: omit or set INVALID the demanded mappable passenger fields
      // so the next step is submitted with missing/invalid data → provider rejects.
      const count = (typeof passengerCount === 'number' && passengerCount > 0) ? passengerCount : additional.length;
      paxLeaves.forEach((l) => {
        const updateKey = AUTO_FEED_UPDATE_KEYS[l.scenarioField];
        if (!updateKey) return; // unmappable → cannot manipulate via the PATCH body
        const indices = (l.index === 'ANY') ? Array.from({ length: count }, (_, i) => i) : [l.index];
        indices.forEach((i) => {
          if (typeof i !== 'number' || i < 0) return;
          while (additional.length <= i) additional.push({});
          const entry = additional[i];
          const bad = (paxMode === 'invalid') ? invalidValueForField(l.scenarioField) : null;
          if (paxMode === 'invalid' && bad !== null) {
            entry[updateKey] = bad;
            probeTargets.push({ index: i, scenarioField: l.scenarioField, value: bad });
            log('WARNING', `${tag} negative probe: set INVALID '${l.scenarioField}' = '${bad}' for passenger ${i} — expecting the provider to reject the next step`);
          } else {
            entry[updateKey] = '';
            probeTargets.push({ index: i, scenarioField: l.scenarioField });
            log('WARNING', `${tag} negative probe: withholding required '${l.scenarioField}' for passenger ${i} — expecting the provider to reject the next step`);
          }
        });
      });
      paxSatisfied = false;
    }
  }

  // ── PURCHASER channel (purchaserAdditional → POST/PATCH-purchaser step) ─────
  if (purLeaves.length) {
    if (purMode === 'autofeed') {
      let unmet = evalNow().unmetLeaves.filter((u) => u.kind === 'purchaser');
      if (unmet.length === 0) {
        log('INFO', `${tag} requestedInformation (purchaser) is already satisfied by the scenario's purchaser data.`);
      } else {
        const r = applyPurchaserAutoFeed(purchaserAdditional, unmet, purchaserSpec);
        purchaserAdditional = r.purchaserAdditional;
        r.provided.forEach((p) => {
          purchaserProvided.push(p);
          log('INFO', `Auto-provided '${p.scenarioField}' (${p.fieldLabel}) = '${p.value}' for the purchaser to satisfy ${tag}.requestedInformation`);
        });
        unmet = evalNow().unmetLeaves.filter((u) => u.kind === 'purchaser');
        const mappableRemaining = unmet.filter((u) => u.scenarioField);
        assert(`${tag}.requestedInformation (purchaser) is satisfiable from OSCAR scenario fields (auto-fed)`,
          mappableRemaining.length === 0,
          `still unmet after auto-feed: ${mappableRemaining.map((u) => u.scenarioField).join(', ')}`);
        unmet.filter((u) => !u.scenarioField).forEach((u) => {
          log('WARNING', `${tag}: cannot auto-provide '${u.path.join('.')}' for the purchaser (not configurable in OSCAR) — booking/confirmation may be rejected.`);
        });
      }
      purSatisfied = evalNow().unmetLeaves.every((u) => u.kind !== 'purchaser');
    } else {
      // Negative probe on the purchaser (a single object → no index).
      purLeaves.forEach((l) => {
        const updateKey = AUTO_FEED_UPDATE_KEYS[l.scenarioField];
        if (!updateKey) return;
        const bad = (purMode === 'invalid') ? invalidValueForField(l.scenarioField) : null;
        if (purMode === 'invalid' && bad !== null) {
          purchaserAdditional[updateKey] = bad;
          purchaserProbeTargets.push({ scenarioField: l.scenarioField, value: bad });
          log('WARNING', `${tag} negative probe: set INVALID '${l.scenarioField}' = '${bad}' for the purchaser — expecting the provider to reject the next step`);
        } else {
          purchaserAdditional[updateKey] = '';
          purchaserProbeTargets.push({ scenarioField: l.scenarioField });
          log('WARNING', `${tag} negative probe: withholding required '${l.scenarioField}' for the purchaser — expecting the provider to reject the next step`);
        }
      });
      purSatisfied = false;
    }
  }

  const out = result();
  out.satisfied = paxSatisfied && purSatisfied;
  return out;
}

// Fields OSDM actually constrains, where a bad value is a HARD schema violation a
// conformant provider MUST reject: `gender` (enum [MALE,FEMALE,X]) and `dateOfBirth`
// (format: date). Everything else (firstName/lastName/email/phoneNumber) is a bare
// `type: string` in the spec — no pattern/format — so a malformed value is only a
// RECOMMENDED rejection (semantic validation), not a conformance requirement.
const STRINGENT_FIELDS = new Set(['gender', 'dateOfBirth']);

/**
 * Grade a provider's rejection of a negative requestedInformation probe (Group N).
 *
 * Severity is provider-fair (#258): a rejection is REQUIRED (hard FAIL if absent)
 * only when a demanded field is MISSING (omit probe — the spec needs it populated to
 * proceed) or an OSDM-constrained field (enum/format) carries an invalid value.
 * For a malformed value in an UNCONSTRAINED string field (email/phone/names) the
 * rejection is merely RECOMMENDED → a non-rejection is a WARN, not a FAIL, because a
 * provider that accepts it is still OSDM-conformant.
 *
 * @param {object} o
 * @param {number}   o.status   HTTP status of the next step
 * @param {*}        o.body     response body
 * @param {Array}    [o.targets] probe targets [{scenarioField[, index][, value]}] —
 *                               a target WITHOUT `value` is an omit (missing field);
 *                               WITH `value` is an invalid value.
 * @param {function} o.assert   (name, okBool, failMsg) — FAIL semantics
 * @param {function} o.log      (level, msg)
 */
function validateProblemResponse(o) {
  const { status, body, targets, assert, log } = o;
  const tgs = Array.isArray(targets) ? targets : [];
  // Optional label disambiguates assertion names when the grader runs repeatedly in
  // a per-field sweep (e.g. "[purchaser.email]") so each field shows on its own line.
  const lbl = o.label ? ` [${o.label}]` : '';
  // #378: reusable outside the requestedInformation context (place-selection
  // probes pass '🧪 Place probe'); the default keeps every existing call site
  // byte-identical.
  const pfx = o.prefix || 'Negative requestedInformation';

  // Rejection REQUIRED (hard) when: no targets given (caller asserts a hard expectation),
  // OR any target is an omit (missing demanded field), OR any invalid target is on an
  // enum/format-constrained field. Otherwise the probe only corrupted unconstrained
  // strings → rejection is RECOMMENDED (soft / WARN).
  const rejectionRequired = tgs.length === 0
    || tgs.some((t) => !('value' in t) || STRINGENT_FIELDS.has(t.scenarioField));
  const soft = !rejectionRequired;
  const softNote = ' — OSDM defines this field as an unconstrained string (no format/pattern), '
    + 'so rejecting a malformed value is recommended practice, not a conformance requirement.';

  // grade(): hard → assert (FAIL); soft → INFO when ok, WARNING when not (never FAIL).
  const grade = (name, ok, failMsg) => {
    if (!soft) { assert(name, ok, failMsg); }
    else if (ok) { log('INFO', `${name} — OK.`); }
    else { log('WARNING', `${name}: ${failMsg}${softNote}`); }
  };

  const isError = typeof status === 'number' && status >= 400;
  const isClientError = isError && status < 500;

  // N1 — provider rejects with a client error (never a silent accept).
  grade(`${pfx}${lbl}: provider rejects with a client error (4xx)`,
    isClientError, `expected 4xx, got ${status}`);

  // N2/N3 only apply when the provider actually returned an error body to grade.
  if (isError) {
    const isObj = body !== null && typeof body === 'object';
    const hasMessage = isObj && (isSet(body.title) || isSet(body.detail) || isSet(body.code));
    grade(`${pfx}${lbl}: error body is an RFC-9457 Problem (title/detail/code present)`,
      !!hasMessage, 'response body did not contain title/detail/code');
    // N3 — should identify the offending field (always WARN; Problem.pointers optional @3.1).
    const fields = [...new Set(tgs.map((t) => t.scenarioField).filter(Boolean))];
    const blob = isObj ? JSON.stringify(body).toLowerCase() : '';
    const hasPointers = isObj && Array.isArray(body.pointers) && body.pointers.length > 0;
    const namesField = fields.length > 0 && fields.some((f) => blob.includes(f.toLowerCase()));
    if (hasPointers || namesField) {
      log('INFO', `${pfx}: error identifies the offending field.`);
    } else {
      log('WARNING', `${pfx}: error does not clearly identify the offending field${fields.length ? ` (${fields.join('/')})` : ''} via Problem.pointers — recommended per RFC 9457.`);
    }
  } else {
    log(soft ? 'INFO' : 'WARNING',
      `${pfx}: provider returned ${status} with no error body to grade.`);
  }
}

module.exports = {
  parseRequestedInformation,
  describeRequestedInformation,
  collectRequestedInformationLeaves: collectLeaves,
  summariseRequestedInformation,
  evaluateRequestedInformation,
  buildPassengerModelFromAdditionalData,
  buildPurchaserModelFromAdditionalData,
  staticIssues,
  sampleValueForField,
  applyAutoFeed,
  applyPurchaserAutoFeed,
  invalidValueForField,
  processRequestedInformation,
  validateProblemResponse,
  rootKind,
  AUTO_FEED_UPDATE_KEYS,
  MAX_LENGTH,
};

// Expose to global for convenience in eval/require loader flows (matches the
// other library-bruno modules).
try {
  Object.assign(globalThis, module.exports);
} catch (e) {
  console.log('[DEBUG] [library-bruno] globalThis exposure skipped: ' + (e && e.message));
}
