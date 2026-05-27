'use strict';

/**
 * bruno-requestedinformation.test.js — library-bruno harness (#258 Phase 1).
 *
 * Exercises the pure requestedInformation.js module: the recursive-descent
 * parser, the human-readable describer, and the one-shot summariser used by the
 * offer/booking handlers. Includes the four verbatim examples from the OSDM
 * "Requested Information – Grammar" page.
 */

const ri = require('../../../Bruno_Collection/library-bruno/requestedInformation.js');

// Verbatim examples from https://osdm.io/spec/requested-information-grammar.html
const EX1 = 'passengerSpecifications[0].detail.contact.phoneNumber';
const EX2 = 'passengerSpecifications[1].detail.firstName AND passengerSpecifications[1].detail.lastName';
const EX3 = 'passengerSpecifications[0].detail.firstName AND passengerSpecifications[0].detail.lastName AND (passengerSpecifications[0].detail.contact.email OR passengerSpecifications[0].detail.contact.phoneNumber)';
const EX4 = 'passengerSpecifications[ANY].detail.contact.phoneNumber';

describe('parseRequestedInformation', () => {
  test('parses a single leaf (example 1)', () => {
    const r = ri.parseRequestedInformation(EX1);
    expect(r.ok).toBe(true);
    expect(r.ast.type).toBe('leaf');
    expect(r.ast.root).toBe('passengerSpecifications');
    expect(r.ast.index).toBe(0);
    expect(r.ast.path).toEqual(['detail', 'contact', 'phoneNumber']);
  });

  test('parses AND of two leaves (example 2)', () => {
    const r = ri.parseRequestedInformation(EX2);
    expect(r.ok).toBe(true);
    expect(r.ast.type).toBe('and');
    expect(ri.collectRequestedInformationLeaves(r.ast)).toHaveLength(2);
  });

  test('parses AND with a parenthesised OR group (example 3)', () => {
    const r = ri.parseRequestedInformation(EX3);
    expect(r.ok).toBe(true);
    expect(r.ast.type).toBe('and');
    const leaves = ri.collectRequestedInformationLeaves(r.ast);
    expect(leaves).toHaveLength(4);
    // The OR group must be preserved as an 'or' node somewhere in the tree.
    const hasOr = JSON.stringify(r.ast).includes('"or"');
    expect(hasOr).toBe(true);
  });

  test("parses an 'ANY' index (example 4)", () => {
    const r = ri.parseRequestedInformation(EX4);
    expect(r.ok).toBe(true);
    expect(r.ast.type).toBe('leaf');
    expect(r.ast.index).toBe('ANY');
  });

  test('rejects a leaf with no attribute path', () => {
    expect(ri.parseRequestedInformation('passengerSpecifications[0]').ok).toBe(false);
  });

  test('rejects unbalanced parentheses', () => {
    expect(ri.parseRequestedInformation('(passengerSpecifications[0].detail.gender').ok).toBe(false);
  });

  test('rejects garbage input', () => {
    expect(ri.parseRequestedInformation('not an expression').ok).toBe(false);
  });

  test('rejects empty / non-string input', () => {
    expect(ri.parseRequestedInformation('').ok).toBe(false);
    expect(ri.parseRequestedInformation(null).ok).toBe(false);
    expect(ri.parseRequestedInformation(undefined).ok).toBe(false);
  });
});

describe('describeRequestedInformation', () => {
  test('renders a single leaf with a friendly label and passenger ref', () => {
    const r = ri.parseRequestedInformation(EX1);
    expect(ri.describeRequestedInformation(r.ast)).toBe('phone number (passenger 0)');
  });

  test("renders 'ANY' as all passengers", () => {
    const r = ri.parseRequestedInformation(EX4);
    expect(ri.describeRequestedInformation(r.ast)).toBe('phone number (all passengers)');
  });

  test('renders AND with a parenthesised OR group (example 3)', () => {
    const r = ri.parseRequestedInformation(EX3);
    expect(ri.describeRequestedInformation(r.ast)).toBe(
      'first name (passenger 0) AND last name (passenger 0) AND (email (passenger 0) OR phone number (passenger 0))'
    );
  });
});

describe('summariseRequestedInformation', () => {
  test('present + typeOk + parseOk, maps phoneNumber leaf to scenario field', () => {
    const s = ri.summariseRequestedInformation(EX1);
    expect(s.present).toBe(true);
    expect(s.typeOk).toBe(true);
    expect(s.parseOk).toBe(true);
    expect(s.leaves).toHaveLength(1);
    expect(s.leaves[0].scenarioField).toBe('phoneNumber');
    expect(s.leaves[0].fieldLabel).toBe('phone number');
    expect(s.leaves[0].passengerRef).toBe('passenger 0');
  });

  test('maps the flat 3.0 contact path (detail.email) to the same field', () => {
    const s = ri.summariseRequestedInformation('passengerSpecifications[0].detail.email');
    expect(s.parseOk).toBe(true);
    expect(s.leaves[0].scenarioField).toBe('email');
  });

  test('maps gender and dateOfBirth (root-level detail siblings)', () => {
    const g = ri.summariseRequestedInformation('passengerSpecifications[0].gender');
    expect(g.leaves[0].scenarioField).toBe('gender');
    const d = ri.summariseRequestedInformation('passengerSpecifications[ANY].dateOfBirth');
    expect(d.leaves[0].scenarioField).toBe('dateOfBirth');
    expect(d.leaves[0].passengerRef).toBe('all passengers');
  });

  test('flags an unmapped field (gap) without throwing', () => {
    const s = ri.summariseRequestedInformation('passengerSpecifications[0].detail.taxId');
    expect(s.parseOk).toBe(true);
    expect(s.leaves[0].scenarioField).toBeNull();
    expect(s.unmappedFields).toContain('detail.taxId');
  });

  test('type check fails for a non-string', () => {
    const s = ri.summariseRequestedInformation(42);
    expect(s.present).toBe(true); // non-empty, but not a string
    expect(s.typeOk).toBe(false);
    expect(s.typeErrors.join(' ')).toMatch(/not a string/);
  });

  test('type check fails when exceeding maxLength', () => {
    const s = ri.summariseRequestedInformation('a'.repeat(ri.MAX_LENGTH + 1));
    expect(s.typeOk).toBe(false);
    expect(s.typeErrors.join(' ')).toMatch(/maxLength/);
  });

  test('absent expression → not present, parseError set', () => {
    const s = ri.summariseRequestedInformation(null);
    expect(s.present).toBe(false);
    expect(s.parseOk).toBe(false);
  });
});
