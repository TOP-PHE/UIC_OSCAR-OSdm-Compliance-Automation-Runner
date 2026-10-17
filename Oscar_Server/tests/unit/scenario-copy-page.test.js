// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * scenario-copy-page.test.js — #727: Copy scenarios was refused for "unsaved
 * edits" when no data file was loaded (nothing to overwrite, nothing Save &
 * Apply could save), and the refusal sat at the top of the panel, out of
 * sight of the Copy button. The two helpers are lifted from the page script
 * and run in a vm context.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../public/js/scenario-copy.js'), 'utf8');

// The text of `const hasUnsavedEdits = …;` and of `function showMsg(…) {…}`.
function lift(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = SOURCE.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end + endMarker.length);
}
const UNSAVED = lift('const hasUnsavedEdits', ';');
const SHOW_MSG = lift('function showMsg(', '\n  }');

function unsaved(globals) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(`${UNSAVED}\nthis.result = hasUnsavedEdits();`, ctx);
  return ctx.result;
}

describe('hasUnsavedEdits', () => {
  test('blocks the copy only when a data file is loaded and edited', () => {
    expect(unsaved({ dirty: true, state: { scenarios: [] } })).toBe(true);
    expect(unsaved({ dirty: false, state: { scenarios: [] } })).toBe(false);
  });

  test('no data file loaded: never blocks, whatever the flag says', () => {
    expect(unsaved({ dirty: true, state: null })).toBe(false);
    expect(unsaved({ dirty: true })).toBe(false);
    expect(unsaved({})).toBe(false);
  });
});

describe('showMsg', () => {
  function run(text) {
    const el = { textContent: '', style: {}, scrolled: null, scrollIntoView(o) { this.scrolled = o; } };
    const ctx = vm.createContext({
      document: { getElementById: (id) => (id === 'sc-copy-msg' ? el : null) },
      NOTE_STYLE: '', OK_COLORS: '', ERR_COLORS: '',
    });
    vm.runInContext(`${SHOW_MSG}\nshowMsg(${JSON.stringify(text)}, 'error');`, ctx);
    return el;
  }

  test('a message is brought into view', () => {
    const el = run('Tick at least one scenario.');
    expect(el.textContent).toBe('Tick at least one scenario.');
    expect(el.scrolled).toEqual({ behavior: 'smooth', block: 'center' });
  });

  test('clearing the message does not scroll', () => {
    expect(run('').scrolled).toBeNull();
  });
});

// Copy scenarios: one box ticks every scenario that can be copied, and
// follows the scenario boxes. The greyed-out ones stay unticked.
describe('Copy scenarios: tick all', () => {
  const SELECT_ALL = lift('function selectAllRow(', '\n  }');
  const JOURNEY_NEEDS = lift('function journeyNeeds(', '\n  }');
  const IS_LOCKED = lift('function isLocked(', '\n  }');
  const ROW = lift('function scenarioRow(', '\n  }');
  const CODE_BOXES = lift('function codeBoxes(', '\n  }');
  const TICK_ALL = lift('function tickAll(', '\n  }');
  const SYNC = lift('function syncSelectAll(', '\n  }');

  function page(boxes) {
    const all = { checked: false, indeterminate: false };
    const document = {
      querySelectorAll: (sel) => {
        expect(sel).toBe('#sc-copy-scenarios input[data-copy-action="toggle-code"]:not(:disabled)');
        return boxes.filter(b => !b.disabled);
      },
      getElementById: (id) => (id === 'sc-copy-all' ? all : null),
    };
    const ctx = vm.createContext({ document, Array });
    vm.runInContext(`${CODE_BOXES}\n${TICK_ALL}\n${SYNC}\nthis.tickAll = tickAll; this.syncSelectAll = syncSelectAll;`, ctx);
    return { ctx, all };
  }

  test('the box is drawn only when two or more scenarios can be copied, and counts them', () => {
    const ctx = vm.createContext({ Array });
    vm.runInContext(`${JOURNEY_NEEDS}\n${IS_LOCKED}\n${SELECT_ALL}\nthis.selectAllRow = selectAllRow;`, ctx);
    const html = ctx.selectAllRow([{ missing: [] }, {}, { missing: ['x'] }]);
    expect(html).toContain('data-copy-action="toggle-all"');
    expect(html).toContain('Tick all that can be copied (2)');
    expect(ctx.selectAllRow([{}, { missing: ['x'] }])).toBe('');
    // #799: one waiting for a journey is not counted either.
    expect(ctx.selectAllRow([{}, {}, { journeyLegsMissing: [2] }])).toContain('Tick all that can be copied (2)');
  });

  // #799: a scenario whose trip needs a journey the Test Data lacks is greyed out, and says why.
  test('a scenario without a journey of its legs cannot be ticked and names what is missing', () => {
    const ctx = vm.createContext({ Array, esc: (v) => String(v), warningLine: () => '' });
    vm.runInContext(`${JOURNEY_NEEDS}\n${IS_LOCKED}\n${ROW}\nthis.scenarioRow = scenarioRow;`, ctx);
    const base = { code: 'C', scenarioType: 'SALE', warnings: [] };
    const waiting = ctx.scenarioRow({ ...base, journeyLegsMissing: [2, 3] });
    expect(waiting).toContain(' disabled>');
    expect(waiting).toContain('Needs in the Test Data: a journey of 2 legs, a journey of 3 legs (Test Data → Find journeys makes one from your trains)');
    expect(waiting).not.toContain('Needs in the Test Framework');
    const free = ctx.scenarioRow({ ...base, journeyLegsMissing: [] });
    expect(free).not.toContain(' disabled>');
    expect(free).not.toContain('Needs in the Test Data');
    expect(ctx.scenarioRow({ ...base, missing: ['x'] })).toContain('Needs in the Test Framework: x');
  });

  test('ticking all leaves the greyed-out scenarios unticked; unticking clears the others', () => {
    const boxes = [{ checked: false }, { checked: false, disabled: true }, { checked: false }];
    const { ctx } = page(boxes);
    ctx.tickAll(true);
    expect(boxes.map(b => b.checked)).toEqual([true, false, true]);
    ctx.tickAll(false);
    expect(boxes.map(b => b.checked)).toEqual([false, false, false]);
  });

  test('the box follows the scenario boxes: all, some, none', () => {
    const boxes = [{ checked: true }, { checked: false, disabled: true }, { checked: true }];
    const { ctx, all } = page(boxes);
    ctx.syncSelectAll();
    expect([all.checked, all.indeterminate]).toEqual([true, false]);
    boxes[2].checked = false;
    ctx.syncSelectAll();
    expect([all.checked, all.indeterminate]).toEqual([false, true]);
    boxes[0].checked = false;
    ctx.syncSelectAll();
    expect([all.checked, all.indeterminate]).toEqual([false, false]);
  });

  // #802: the "Tick all" box's value ("on") was sent as a scenario code.
  test('the codes copied are read from the scenario boxes only, never the "Tick all" box', () => {
    const SELECTED = lift('function selectedCodes(', '\n  }');
    const all = { value: 'on', checked: true, dataset: { copyAction: 'toggle-all' } };
    const boxes = [all, { value: 'A', checked: true, dataset: { copyAction: 'toggle-code' } },
      { value: 'B', checked: false, dataset: { copyAction: 'toggle-code' } }];
    const document = {
      querySelectorAll: (sel) => boxes.filter(b => b.checked
        && (!sel.includes('[data-copy-action="toggle-code"]') || b.dataset.copyAction === 'toggle-code')),
    };
    const ctx = vm.createContext({ document, Array });
    vm.runInContext(`${SELECTED}\nthis.selectedCodes = selectedCodes;`, ctx);
    expect(ctx.selectedCodes()).toEqual(['A']);
  });

  test('the page wires both boxes', () => {
    expect(SOURCE).toContain("el.dataset.copyAction === 'toggle-all' && preview) { tickAll(el.checked); renderTrips(); renderReport(); }");
    expect(SOURCE).toContain("el.dataset.copyAction === 'toggle-code' && preview) { syncSelectAll(); renderTrips(); renderReport(); }");
    expect(SOURCE).toContain('selectAllRow(preview.scenarios) + preview.scenarios.map(scenarioRow)');
  });
});
