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

  test('summary exposes the parsed ast for evaluation', () => {
    const s = ri.summariseRequestedInformation(EX1);
    expect(s.ast).not.toBeNull();
    expect(s.ast.type).toBe('leaf');
  });
});

// ─── Phase 2 ──────────────────────────────────────────────────────────────────
function pax(overrides) {
  return Object.assign({
    type: 'PERSON',
    dateOfBirth: null,
    gender: null,
    detail: { firstName: null, lastName: null, contact: { email: null, phoneNumber: null } },
  }, overrides || {});
}
function model(passengers) {
  return { passengerSpecifications: passengers };
}
function astOf(expr) {
  return ri.parseRequestedInformation(expr).ast;
}

describe('evaluateRequestedInformation', () => {
  test('single leaf satisfied when the field is populated (example 1)', () => {
    const m = model([pax({ detail: { contact: { phoneNumber: '+3312345678' } } })]);
    const r = ri.evaluateRequestedInformation(astOf(EX1), m);
    expect(r.satisfied).toBe(true);
    expect(r.unmetLeaves).toHaveLength(0);
  });

  test('single leaf unmet when the field is empty', () => {
    const r = ri.evaluateRequestedInformation(astOf(EX1), model([pax()]));
    expect(r.satisfied).toBe(false);
    expect(r.unmetLeaves).toHaveLength(1);
    expect(r.unmetLeaves[0].scenarioField).toBe('phoneNumber');
    expect(r.unmetLeaves[0].passengerRef).toBe('passenger 0');
  });

  test('contact path satisfied by the flat 3.0 field (detail.email)', () => {
    // Demand the 3.1+ contact path; supply only the deprecated flat field.
    const m = model([{ detail: { email: 'a@b.c' } }]);
    const r = ri.evaluateRequestedInformation(astOf('passengerSpecifications[0].detail.contact.email'), m);
    expect(r.satisfied).toBe(true);
  });

  test("ANY satisfied only when every passenger has the field", () => {
    const all = model([
      pax({ detail: { contact: { phoneNumber: '+1' } } }),
      pax({ detail: { contact: { phoneNumber: '+2' } } }),
    ]);
    expect(ri.evaluateRequestedInformation(astOf(EX4), all).satisfied).toBe(true);

    const one = model([
      pax({ detail: { contact: { phoneNumber: '+1' } } }),
      pax(), // no phone
    ]);
    const r = ri.evaluateRequestedInformation(astOf(EX4), one);
    expect(r.satisfied).toBe(false);
    expect(r.unmetLeaves.map((u) => u.passengerRef)).toContain('passenger 1');
  });

  test('OR group satisfied by either side (example 3)', () => {
    const m = model([pax({ detail: { firstName: 'A', lastName: 'B', contact: { email: 'a@b.c' } } })]);
    expect(ri.evaluateRequestedInformation(astOf(EX3), m).satisfied).toBe(true);
  });

  test('OR group unmet reports both alternatives when neither is set (example 3)', () => {
    const m = model([pax({ detail: { firstName: 'A', lastName: 'B' } })]); // no email, no phone
    const r = ri.evaluateRequestedInformation(astOf(EX3), m);
    expect(r.satisfied).toBe(false);
    const fields = r.unmetLeaves.map((u) => u.scenarioField).sort();
    expect(fields).toEqual(['email', 'phoneNumber']);
  });
});

describe('buildPassengerModelFromAdditionalData', () => {
  test('maps update* fields + spec type into the OSDM-ish shape', () => {
    const m = ri.buildPassengerModelFromAdditionalData(
      [{
        updateFirstName: 'Ada', updateLastName: 'Lovelace', updateDateOfBirth: '1990-01-01',
        updateEmail: 'ada@x.io', updatePhoneNumber: '+3312', updateGender: 'F',
      }],
      [{ type: 'PERSON' }]
    );
    expect(m).toHaveLength(1);
    expect(m[0].type).toBe('PERSON');
    expect(m[0].dateOfBirth).toBe('1990-01-01');
    expect(m[0].gender).toBe('F');
    expect(m[0].detail.firstName).toBe('Ada');
    expect(m[0].detail.contact.email).toBe('ada@x.io');
    expect(m[0].detail.contact.phoneNumber).toBe('+3312');
  });

  test('leaves unset fields null and round-trips through the evaluator', () => {
    const m = model(ri.buildPassengerModelFromAdditionalData(
      [{ updateFirstName: 'A', updateLastName: 'B' }], // no email/phone
      [{ type: 'PERSON' }]
    ));
    expect(m.passengerSpecifications[0].detail.contact.email).toBeNull();
    // A phone demand is therefore unmet for this scenario data.
    expect(ri.evaluateRequestedInformation(astOf(EX1), m).satisfied).toBe(false);
  });

  test('tolerates empty / non-array input', () => {
    expect(ri.buildPassengerModelFromAdditionalData(null, null)).toEqual([]);
  });
});

// ─── Phase 3a / 3b ──────────────────────────────────────────────────────────
describe('staticIssues', () => {
  test('flags a numeric index >= passenger count', () => {
    const ast = astOf('passengerSpecifications[5].detail.gender');
    const r = ri.staticIssues(ast, 2);
    expect(r.indexErrors).toHaveLength(1);
    expect(r.indexErrors[0].index).toBe(5);
  });

  test('does not flag ANY or in-range indices', () => {
    expect(ri.staticIssues(astOf(EX4), 3).indexErrors).toHaveLength(0);
    expect(ri.staticIssues(astOf('passengerSpecifications[0].detail.gender'), 1).indexErrors).toHaveLength(0);
  });

  test('reports unknown attribute paths', () => {
    const r = ri.staticIssues(astOf('passengerSpecifications[0].detail.taxId'), 1);
    expect(r.unknownPaths).toContain('detail.taxId');
  });

  test('known paths are not reported', () => {
    expect(ri.staticIssues(astOf(EX3), 1).unknownPaths).toHaveLength(0);
  });
});

describe('sampleValueForField', () => {
  test('gender is a valid OSDM enum value', () => {
    expect(['MALE', 'FEMALE', 'X']).toContain(ri.sampleValueForField('gender', 0, 'PERSON'));
  });
  test('email looks like an email; phone like E.164', () => {
    expect(ri.sampleValueForField('email', 0)).toMatch(/@/);
    expect(ri.sampleValueForField('phoneNumber', 0)).toMatch(/^\+\d+$/);
  });
  test('dateOfBirth is type-aware', () => {
    expect(ri.sampleValueForField('dateOfBirth', 0, 'CHILD')).toBe('2016-01-01');
    expect(ri.sampleValueForField('dateOfBirth', 0, 'PERSON')).toBe('1990-01-01');
  });
  test('unmappable field yields null', () => {
    expect(ri.sampleValueForField('taxId', 0)).toBeNull();
  });
});

describe('applyAutoFeed', () => {
  test('fills an empty mapped field and reports it', () => {
    const unmet = ri.evaluateRequestedInformation(astOf(EX1), { passengerSpecifications: [{}] }).unmetLeaves;
    const { additional, provided } = ri.applyAutoFeed([{}], unmet, [{ type: 'PERSON' }]);
    expect(provided).toHaveLength(1);
    expect(provided[0].scenarioField).toBe('phoneNumber');
    expect(additional[0].updatePhoneNumber).toBeTruthy();
  });

  test('never overwrites a tester-provided value', () => {
    const unmet = [{ scenarioField: 'gender', index: 0, fieldLabel: 'gender', passengerRef: 'passenger 0', path: ['gender'] }];
    const { additional, provided } = ri.applyAutoFeed([{ updateGender: 'FEMALE' }], unmet, []);
    expect(provided).toHaveLength(0);
    expect(additional[0].updateGender).toBe('FEMALE');
  });

  test('skips unmappable fields', () => {
    const unmet = [{ scenarioField: null, index: 0, fieldLabel: 'detail.taxId', passengerRef: 'passenger 0', path: ['detail', 'taxId'] }];
    expect(ri.applyAutoFeed([{}], unmet, []).provided).toHaveLength(0);
  });
});

function mockSinks() {
  const asserts = [];
  const logs = [];
  return {
    assert: (name, ok, msg) => asserts.push({ name, ok, msg }),
    log: (lvl, msg) => logs.push({ lvl, msg }),
    asserts,
    logs,
  };
}

describe('processRequestedInformation', () => {
  test('auto-feeds a missing field and ends satisfied', () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: EX1, tag: 'admissionOfferParts[0]', additional: [{}], specs: [{ type: 'PERSON' }],
      passengerCount: 1, autoFeedOn: true, assert: m.assert, log: m.log,
    });
    expect(out.provided.map((p) => p.scenarioField)).toContain('phoneNumber');
    expect(out.satisfied).toBe(true);
    expect(out.additional[0].updatePhoneNumber).toBeTruthy();
    expect(m.asserts.find((a) => /satisfiable/.test(a.name)).ok).toBe(true);
  });

  test('grammar assertion fails on malformed input (S2)', () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'garbage', tag: 'booking', additional: [{}], specs: [{}],
      passengerCount: 1, autoFeedOn: true, assert: m.assert, log: m.log,
    });
    expect(out.parseOk).toBe(false);
    expect(m.asserts.find((a) => /grammar/.test(a.name)).ok).toBe(false);
  });

  test('index-range assertion fails when index >= count (S4)', () => {
    const m = mockSinks();
    ri.processRequestedInformation({
      expr: 'passengerSpecifications[5].detail.gender', tag: 'booking', additional: [{}], specs: [{ type: 'PERSON' }],
      passengerCount: 1, autoFeedOn: true, assert: m.assert, log: m.log,
    });
    expect(m.asserts.find((a) => /in range/.test(a.name)).ok).toBe(false);
  });

  test('with auto-feed off, withholds data and stays unsatisfied (negative-probe path)', () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'passengerSpecifications[0].detail.gender', tag: 'booking', additional: [{}], specs: [{ type: 'PERSON' }],
      passengerCount: 1, autoFeedOn: false, assert: m.assert, log: m.log,
    });
    expect(out.provided).toHaveLength(0);
    expect(out.satisfied).toBe(false);
    expect(m.asserts.find((a) => /satisfiable/.test(a.name))).toBeUndefined();
  });

  test('unmappable demand cannot be auto-fed but does not fail the satisfiable assert', () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'passengerSpecifications[0].detail.taxId', tag: 'booking', additional: [{}], specs: [{ type: 'PERSON' }],
      passengerCount: 1, autoFeedOn: true, assert: m.assert, log: m.log,
    });
    expect(out.provided).toHaveLength(0);
    expect(m.asserts.find((a) => /satisfiable/.test(a.name)).ok).toBe(true);
    expect(m.logs.some((l) => l.lvl === 'WARNING' && /cannot auto-provide/.test(l.msg))).toBe(true);
  });
});

// ─── Phase 3c (negative probe) ──────────────────────────────────────────────
describe('invalidValueForField', () => {
  test('produces clearly-invalid values for constrained fields', () => {
    expect(ri.invalidValueForField('gender')).toBe('ZZZ');
    expect(ri.invalidValueForField('email')).not.toMatch(/@/);
    expect(ri.invalidValueForField('dateOfBirth')).toBe('not-a-date');
  });
  test('returns null for fields with no clear invalid form', () => {
    expect(ri.invalidValueForField('firstName')).toBeNull();
    expect(ri.invalidValueForField('type')).toBeNull();
  });
});

describe('processRequestedInformation — negative probe', () => {
  test("mode 'omit' clears the demanded field and records the target", () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'passengerSpecifications[0].gender', tag: 'booking', additional: [{ updateGender: 'MALE' }],
      specs: [{ type: 'PERSON' }], passengerCount: 1, mode: 'omit', assert: m.assert, log: m.log,
    });
    expect(out.additional[0].updateGender).toBe('');
    expect(out.probeTargets).toEqual([{ index: 0, scenarioField: 'gender' }]);
    expect(out.satisfied).toBe(false);
  });

  test("mode 'invalid' injects an invalid value for a constrained field", () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'passengerSpecifications[0].gender', tag: 'booking', additional: [{ updateGender: 'MALE' }],
      specs: [{ type: 'PERSON' }], passengerCount: 1, mode: 'invalid', assert: m.assert, log: m.log,
    });
    expect(out.additional[0].updateGender).toBe('ZZZ');
    expect(out.probeTargets[0]).toMatchObject({ index: 0, scenarioField: 'gender', value: 'ZZZ' });
  });

  test("mode 'invalid' falls back to omit for a field with no invalid form", () => {
    const m = mockSinks();
    const out = ri.processRequestedInformation({
      expr: 'passengerSpecifications[0].detail.firstName', tag: 'booking', additional: [{ updateFirstName: 'Bob' }],
      specs: [{ type: 'PERSON' }], passengerCount: 1, mode: 'invalid', assert: m.assert, log: m.log,
    });
    expect(out.additional[0].updateFirstName).toBe('');
    expect(out.probeTargets[0]).toEqual({ index: 0, scenarioField: 'firstName' });
  });
});

describe('validateProblemResponse', () => {
  test('N1+N2 pass on a 4xx RFC-9457 Problem; N3 logs that the field is named', () => {
    const m = mockSinks();
    ri.validateProblemResponse({
      status: 400,
      body: { title: 'Bad Request', detail: 'gender is required', status: 400 },
      targets: [{ index: 0, scenarioField: 'gender' }],
      assert: m.assert, log: m.log,
    });
    expect(m.asserts.find((a) => /client error/.test(a.name)).ok).toBe(true);
    expect(m.asserts.find((a) => /Problem/.test(a.name)).ok).toBe(true);
    expect(m.logs.some((l) => l.lvl === 'INFO' && /identifies the offending field/.test(l.msg))).toBe(true);
  });

  test('N1 fails when the provider silently accepts (200)', () => {
    const m = mockSinks();
    ri.validateProblemResponse({ status: 200, body: {}, targets: [], assert: m.assert, log: m.log });
    expect(m.asserts.find((a) => /client error/.test(a.name)).ok).toBe(false);
  });

  test('N2 fails when the body is not a Problem', () => {
    const m = mockSinks();
    ri.validateProblemResponse({ status: 400, body: 'oops', targets: [], assert: m.assert, log: m.log });
    expect(m.asserts.find((a) => /Problem/.test(a.name)).ok).toBe(false);
  });

  test('N3 warns when the error does not identify the offending field', () => {
    const m = mockSinks();
    ri.validateProblemResponse({
      status: 422, body: { title: 'Unprocessable', detail: 'something failed' },
      targets: [{ index: 0, scenarioField: 'gender' }], assert: m.assert, log: m.log,
    });
    expect(m.logs.some((l) => l.lvl === 'WARNING' && /does not clearly identify/.test(l.msg))).toBe(true);
  });

  test('N3 accepts a Problem.pointers array as field identification', () => {
    const m = mockSinks();
    ri.validateProblemResponse({
      status: 400, body: { title: 'Bad', pointers: [{ pointer: '/passengers/0/gender' }] },
      targets: [{ index: 0, scenarioField: 'gender' }], assert: m.assert, log: m.log,
    });
    expect(m.logs.some((l) => l.lvl === 'INFO' && /identifies the offending field/.test(l.msg))).toBe(true);
  });
});
