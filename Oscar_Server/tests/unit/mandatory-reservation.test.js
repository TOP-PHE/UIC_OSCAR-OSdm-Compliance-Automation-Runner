// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * mandatory-reservation.test.js — #793: how a mandatory reservation booked
 * without a seat choice is sent is declared in the Test Framework, given to the
 * run's copy, and chosen on the Test Framework page.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MANDATORY_FORMS, frameworkMandatoryForm, withMandatoryReservationForm } = require('../../src/utils/mandatoryReservation');
const sr = require('../../../Bruno_Collection/library-bruno/seatReservations.js');

describe('#793 the server\'s rule', () => {
  test('the forms are the collection\'s', () => {
    expect(MANDATORY_FORMS).toEqual(sr.MANDATORY_FORMS);
  });

  test('the framework declares a form, or none', () => {
    expect(frameworkMandatoryForm({ mandatoryReservationForm: 'none' })).toBe('NONE');
    expect(frameworkMandatoryForm({ mandatoryReservationForm: 'PLACE_SELECTION' })).toBe('PLACE_SELECTION');
    for (const fw of [{}, null, { mandatoryReservationForm: 'x' }, { mandatoryReservationForm: 3 }]) expect(frameworkMandatoryForm(fw)).toBeNull();
  });

  test('the run\'s copy: scenarios naming none get the framework\'s', () => {
    const datafile = { scenarios: [{ code: 'A' }, { code: 'B', mandatoryReservationForm: 'PLACE_SELECTION' }, null, { code: 'C', mandatoryReservationForm: '' }] };
    expect(withMandatoryReservationForm(datafile, { mandatoryReservationForm: 'NONE' })).toBe(2);
    expect(datafile.scenarios.map((s) => s?.mandatoryReservationForm)).toEqual(['NONE', 'PLACE_SELECTION', undefined, 'NONE']);
    const other = { scenarios: [{ code: 'A' }] };
    expect(withMandatoryReservationForm(other, {})).toBe(0);
    expect(other.scenarios[0].mandatoryReservationForm).toBeUndefined();
    expect(withMandatoryReservationForm({}, { mandatoryReservationForm: 'NONE' })).toBe(0);
  });
});

describe('#793 the Test Framework page', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const formsStart = lines.findIndex((l) => l.startsWith('const FW_MANDATORY_RESERVATION_FORMS = '));
  const formsEnd = lines.findIndex((l, i) => i > formsStart && l === '];');
  const forms = vm.runInNewContext(`(${lines.slice(formsStart, formsEnd + 1).join('\n').replace('const FW_MANDATORY_RESERVATION_FORMS = ', '').replace(/;$/, '')})`);

  test('the page offers the collection\'s forms, with a label tied to its field', () => {
    expect(forms.map(([v]) => v)).toEqual([...sr.MANDATORY_FORMS]);
    const html = lift('mandatoryReservationFormHtml', { esc, FW_MANDATORY_RESERVATION_FORMS: forms })({ mandatoryReservationForm: 'NONE' });
    expect(html).toContain('<label for="fw-mandatory-reservation-form">');
    expect(html).toContain('id="fw-mandatory-reservation-form"');
    expect(html).toContain('<option value="NONE" selected>');
    const plain = lift('mandatoryReservationFormHtml', { esc, FW_MANDATORY_RESERVATION_FORMS: forms })({});
    expect(plain).toContain('<option value="PLACE_SELECTION" selected>');
  });

  test('a choice is stored, the default as no key, and saved', () => {
    let saved = 0;
    const ctx = { wizData: { framework: {} }, saveFrameworkDebounced: () => { saved += 1; } };
    const change = lift('changeMandatoryReservationForm', ctx);
    expect(change('fw-mandatory-reservation-form', { value: 'NONE' })).toBe(true);
    expect(ctx.wizData.framework.mandatoryReservationForm).toBe('NONE');
    change('fw-mandatory-reservation-form', { value: 'PLACE_SELECTION' });
    expect('mandatoryReservationForm' in ctx.wizData.framework).toBe(false);
    expect(saved).toBe(2);
    expect(change('other', { value: 'NONE' })).toBe(false);
  });

  // #797: the help says what each choice sends, and the other two fields how to fill them.
  test('the help texts say what each field does', () => {
    const html = lift('mandatoryReservationFormHtml', { esc, FW_MANDATORY_RESERVATION_FORMS: forms })({});
    expect(html).toContain('names it nowhere and the provider books it with the ticket');
    expect(html).toContain('always sends its placeSelection');
    const source = lines.join('\n');
    expect(source).toContain('Separate several codes with a comma, a semicolon or a space');
    expect(source).toContain('the same seed always gives the same combinations');
  });

  test('the panel shows it and the change handler is wired before the switch', () => {
    const source = lines.join('\n');
    expect(source).toContain('${mandatoryReservationFormHtml(fw)}');
    expect(source).toContain('|| changeMandatoryReservationForm(action, el) ||');
  });
});
