// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-access.test.js — the Test Config editor's read-only rule (#515).
 *
 * The server keeps a tester's changes to their own, non-shared scenarios only
 * (src/utils/datafileOwnership.js, v1.11.197). public/js/scenario-access.js
 * applies the same rule in the browser so the editor never offers an edit the
 * save would discard. This file pins the two together and guards the wiring in
 * public/js/scenarios.js that turns the rule into locked controls.
 *
 * There is no DOM harness for public/ (it is outside the coverage metric), so
 * the wiring checks read scenarios.js as text. Each one names the regression it
 * catches; they were mutation-checked against the code they guard.
 */

const fs = require('fs');
const path = require('path');

const client = require('../../public/js/scenario-access.js');
const server = require('../../src/utils/datafileOwnership');

const PUBLIC = path.join(__dirname, '../../public');
const SCENARIOS_JS = fs.readFileSync(path.join(PUBLIC, 'js/scenarios.js'), 'utf8');
const SCENARIOS_HTML = fs.readFileSync(path.join(PUBLIC, 'scenarios.html'), 'utf8');

const ANA = 'ana@vendor.test';
const tester = { role: 'company_user', email: ANA };

describe('ownership rule — the browser copy matches the server', () => {
  // Every pairing of these is run through both implementations.
  const scenarios = [
    { created_by: ANA },
    { created_by: '  Ana@Vendor.TEST ' },
    { created_by: ANA, shared: true },
    { created_by: ANA, shared: 1 },
    { created_by: ANA, shared: 'yes' },
    { created_by: ANA, shared: 0 },
    { created_by: ANA, shared: '' },
    { created_by: 'ben@vendor.test' },
    { created_by: 'ben@vendor.test', shared: true },
    {},
    { created_by: '' },
    { created_by: '   ' },
    { created_by: null },
    { created_by: 123 },
    { shared: true },
    null, undefined, [], 'OTST_SALE', 42,
  ];
  const emails = [ANA, ' ANA@vendor.test ', 'ben@vendor.test', '', '   ', null, undefined, '123'];

  test.each(emails.map(e => [JSON.stringify(e) ?? 'undefined', e]))('isOwnedBy and isVisibleTo agree for email %s', (_label, email) => {
    for (const sc of scenarios) {
      expect([sc, client.isOwnedBy(sc, email)]).toEqual([sc, server.isOwnedBy(sc, email)]);
      expect([sc, client.isVisibleTo(sc, email)]).toEqual([sc, server.isVisibleTo(sc, email)]);
    }
  });
});

describe('isReadOnlyFor — who is restricted', () => {
  const own     = { code: 'A', created_by: ANA };
  const shared  = { code: 'S', created_by: 'tm@vendor.test', shared: true };
  const company = { code: 'C' };
  const bens    = { code: 'B', created_by: 'ben@vendor.test' };

  test('a tester may change only the scenarios they own', () => {
    expect(client.isReadOnlyFor(own, tester)).toBe(false);
    expect(client.isReadOnlyFor(shared, tester)).toBe(true);
    expect(client.isReadOnlyFor(company, tester)).toBe(true);
    expect(client.isReadOnlyFor(bens, tester)).toBe(true);
  });

  test('a tester\'s own scenario, once shared, is read-only for them too', () => {
    expect(client.isReadOnlyFor({ ...own, shared: true }, tester)).toBe(true);
  });

  test('a missing scenario is read-only (fail closed)', () => {
    expect(client.isReadOnlyFor(undefined, tester)).toBe(true);
    expect(client.isReadOnlyFor(null, tester)).toBe(true);
  });

  test('Test Managers are not restricted', () => {
    for (const role of ['test_manager', 'administrator']) {
      for (const sc of [own, shared, company, bens]) {
        expect(client.isReadOnlyFor(sc, { role, email: 'tm@vendor.test' })).toBe(false);
      }
    }
  });
});

describe('isCardActionLocked — default-deny on a read-only card', () => {
  const shared = { code: 'S', created_by: 'tm@vendor.test', shared: true };
  const own    = { code: 'A', created_by: ANA };
  const tm     = { role: 'test_manager', email: 'tm@vendor.test' };

  // Changing this list is a decision: every entry must leave the scenario, and
  // the resource entries it points at, untouched.
  test('the view-only allowlist is exactly these actions', () => {
    expect([...client.READ_ONLY_CARD_ACTIONS].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      'duplicate-scenario', 'toggle-detail', 'toggle-param-section', 'toggle-pax-edit', 'toggle-scenario',
    ]);
    expect(Object.isFrozen(client.READ_ONLY_CARD_ACTIONS)).toBe(true);
  });

  test('every allowlisted action still exists in scenarios.js (no stale names)', () => {
    for (const action of client.READ_ONLY_CARD_ACTIONS) {
      expect(SCENARIOS_JS).toContain(`data-action="${action}"`);
    }
  });

  // The controls #515 found ungated, or gated at render time only.
  const previouslyEditable = [
    'set-scenario', 'set-scenario-text', 'set-scenario-code',
    'set-scenario-max-wait-minutes', 'set-scenario-max-wait-offer-minutes',
    'set-scenario-max-wait-addres-minutes', 'set-scenario-max-wait-addanc-minutes',
    'set-scenario-max-wait-refund-offer-minutes', 'set-scenario-max-wait-exchange-offer-minutes',
    'toggle-place-probe', 'toggle-sales-action', 'set-place-mode', 'set-accommodation-selection',
    'set-accommodation-gender', 'toggle-book-mandatory-reservations',
    'set-trip-field', 'set-trip-path', 'set-trip-time', 'apply-trip-train', 'apply-trip-journey',
    'set-offer', 'set-offer-currency', 'toggle-offer-array', 'set-offer-tags',
    'set-offer-return-offset', 'set-offer-return-time', 'set-offer-selections',
    'set-fulfill',
    'add-pax', 'remove-pax', 'set-pax', 'set-pax-text', 'set-pax-family', 'change-pax-category',
    'add-pax-reduction', 'remove-pax-reduction', 'set-pax-reduction',
    'add-pax-loyalty', 'remove-pax-loyalty', 'set-pax-loyalty',
    'toggle-purchaser-is-pax', 'set-purchaser-passenger', 'set-purchaser',
    'delete-scenario', 'toggle-shared',
  ];

  test.each(previouslyEditable)('"%s" is refused on a read-only card, allowed on your own', action => {
    expect(client.isCardActionLocked(action, shared, tester)).toBe(true);
    expect(client.isCardActionLocked(action, own, tester)).toBe(false);
    expect(client.isCardActionLocked(action, shared, tm)).toBe(false);
  });

  test('every data-action scenarios.js renders is refused on a read-only card unless allowlisted', () => {
    const actions = new Set([...SCENARIOS_JS.matchAll(/data-action="([a-z0-9-]+)"/g)].map(m => m[1]));
    expect(actions.size).toBeGreaterThan(50);
    for (const action of actions) {
      expect([action, client.isCardActionLocked(action, shared, tester)])
        .toEqual([action, !client.READ_ONLY_CARD_ACTIONS.includes(action)]);
    }
  });

  test('an action nobody has classified yet is refused', () => {
    expect(client.isCardActionLocked('some-control-added-later', shared, tester)).toBe(true);
    expect(client.isCardActionLocked(undefined, shared, tester)).toBe(true);
  });

  test('the view-only actions stay usable on a read-only card', () => {
    for (const action of client.READ_ONLY_CARD_ACTIONS) {
      expect(client.isCardActionLocked(action, shared, tester)).toBe(false);
    }
  });
});

describe('scenarios.js wiring', () => {
  // The source of one top-level function: from its declaration to the next one.
  function topLevelFunction(name) {
    const start = SCENARIOS_JS.indexOf(`\nfunction ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const end = SCENARIOS_JS.indexOf('\nfunction ', start + 1);
    return SCENARIOS_JS.slice(start, end === -1 ? undefined : end);
  }

  test('scenario-access.js is loaded before scenarios.js', () => {
    const access = SCENARIOS_HTML.indexOf('<script src="/js/scenario-access.js"></script>');
    const editor = SCENARIOS_HTML.indexOf('<script src="/js/scenarios.js"></script>');
    expect(access).toBeGreaterThan(-1);
    expect(editor).toBeGreaterThan(access);
  });

  test('isMine / isReadOnlyForMe delegate to the shared rule', () => {
    expect(topLevelFunction('isMine')).toContain('OscarScenarioAccess.isOwnedBy(sc, user.email)');
    expect(topLevelFunction('isReadOnlyForMe')).toContain('OscarScenarioAccess.isReadOnlyFor(sc, user)');
  });

  // A re-render that bypasses renderScenarioDetail brings a read-only card back
  // editable — the pre-#515 toggleDetail lock was lost exactly that way.
  test('a card detail is drawn only through renderScenarioDetail', () => {
    const calls = SCENARIOS_JS.match(/buildDetailHTML\(/g) || [];
    expect(calls).toHaveLength(2);                              // the definition + one call
    expect(topLevelFunction('renderScenarioDetail')).toContain('detail.innerHTML = buildDetailHTML(idx);');
    expect(topLevelFunction('renderScenarioDetail')).toContain('OscarScenarioAccess.isAllowedOnReadOnlyCard(');
  });

  test.each(['click', 'change', 'input'])('the %s delegate refuses a locked control before dispatching', type => {
    const start = SCENARIOS_JS.indexOf(`document.body.addEventListener('${type}', function(e) {`);
    expect(start).toBeGreaterThan(-1);
    const head = SCENARIOS_JS.slice(start, SCENARIOS_JS.indexOf('switch (action)', start));
    expect(head).toContain('if (isLockedControl(el))');
  });

  test('each scenario card carries the index isLockedControl looks up', () => {
    expect(SCENARIOS_JS).toMatch(/<div class="scenario-item" data-sc-card="\$\{esc\(idx\)\}">/);
    expect(topLevelFunction('cardScenarioIndex')).toContain("closest('[data-sc-card]')");
  });

  test('no read-only check tests `shared` alone (that missed 🔒 Company scenarios)', () => {
    expect(SCENARIOS_JS).not.toMatch(/isTester\s*&&\s*[\w.]+\.shared/);
  });

  test('drawing a read-only purchaser section writes nothing to the model', () => {
    const fn = topLevelFunction('buildPurchaserSection');
    expect(fn).toContain('if (prIdx === -1 && !readOnly) {');
    expect(fn.indexOf('const readOnly = isReadOnlyForMe(sc);')).toBeLessThan(fn.indexOf('if (prIdx === -1'));
  });
});
