// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #691: the Test Framework editor shows the flexibilities the provider sells
 * (offerCriteria.flexibilities). The field drove the editor's flexibility
 * picker and, since #687, the catalogue copy, but no page let anyone set it:
 * every framework kept the default, all three.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FILE = path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js');
const source = fs.readFileSync(FILE, 'utf8');

function loadFunction(name, context) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

function fakePill() {
  const classes = new Set();
  return { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) } };
}

describe('Test Framework: flexibilities the provider sells (#691)', () => {
  test('step 1 draws one pill per flexibility, bound to offerCriteria.flexibilities', () => {
    const step1 = source.slice(source.indexOf('function renderWizardStep1('), source.indexOf('\n}\n', source.indexOf('function renderWizardStep1(')));
    expect(step1).toContain('Tariff Flexibility');
    expect(step1).toMatch(/WIZ_FLEXIBILITIES\.map\(f=>`<div class="pill\$\{\(fw\.offerCriteria\.flexibilities\|\|\[\]\)\.includes\(f\)/);
    expect(step1).toContain('data-action="fw-offer-pill" data-group="flexibilities"');
  });

  test('a click toggles the flexibility in the framework and saves it', () => {
    expect(source).toMatch(/case 'fw-offer-pill':\s*\n\s*fwToggleOfferPill\(el, el\.dataset\.group, el\.dataset\.val\); saveFrameworkDebounced\(\); break;/);
    const wizData = { framework: { offerCriteria: { flexibilities: ['FULL_FLEXIBLE', 'SEMI_FLEXIBLE', 'NON_FLEXIBLE'] } } };
    const toggle = loadFunction('fwToggleOfferPill', { wizData });
    const full = fakePill();
    toggle(full, 'flexibilities', 'FULL_FLEXIBLE');
    toggle(fakePill(), 'flexibilities', 'SEMI_FLEXIBLE');
    expect(wizData.framework.offerCriteria.flexibilities).toEqual(['NON_FLEXIBLE']);
    toggle(full, 'flexibilities', 'FULL_FLEXIBLE');
    expect(wizData.framework.offerCriteria.flexibilities).toEqual(['NON_FLEXIBLE', 'FULL_FLEXIBLE']);
    expect(full.classList.has('selected')).toBe(true);
  });
});
