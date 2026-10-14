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
