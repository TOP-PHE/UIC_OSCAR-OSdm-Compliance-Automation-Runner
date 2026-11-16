// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1287: a run Bruno ends with a code other than 0 or 1 is not a test result.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RunExit = require('../../public/js/run-exit');
const { esc } = require('../../public/js/esc');

const PAGE = path.join(__dirname, '..', '..', 'public', 'run-detail.html');
const BRUNO_CONSTANTS = path.join(__dirname, '..', '..', 'bruno-cli', 'node_modules', '@usebruno', 'cli', 'src', 'constants.js');

// A top-level function of the page, as ui-scripts.test.js lifts one.
function pageFunction(name, context) {
  const lines = fs.readFileSync(PAGE, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l === '}');
  if (start === -1 || end === -1) throw new Error(`run-detail.html: no top-level function ${name}`);
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

describe('run-exit.js', () => {
  test('only 0 and 1 are test results', () => {
    expect(RunExit.isTestResultExit(0)).toBe(true);
    expect(RunExit.isTestResultExit(1)).toBe(true);
    for (const code of [2, 3, 6, 13, 124, 125, 127, 137, 143, 255, -1, null, undefined, '1', 1.5]) {
      expect(RunExit.isTestResultExit(code)).toBe(false);
    }
  });

  test('every code says what it means; an unknown one says so too', () => {
    expect(RunExit.exitMeaning(255)).toMatch(/^Bruno stopped on an unexpected error \("Something went wrong"\)/);
    expect(RunExit.exitMeaning(124)).toBe('the run reached its time limit and its pod was stopped');
    expect(RunExit.exitMeaning(125)).toBe('the run\'s pod never started');
    expect(RunExit.exitMeaning(137)).toMatch(/killed/);
    expect(RunExit.exitMeaning(6)).toMatch(/environment was not found/);
    for (const code of [42, null, undefined, 'toString', '__proto__', 1.5, '255']) {
      expect(RunExit.exitMeaning(code)).toBe('the run ended with a code Bruno does not give a test result');
    }
  });

  test('the sentinels that are not a test result', () => {
    expect(RunExit.NOT_FINISHED).toBe('RUN_NOT_FINISHED');
    expect([...RunExit.NOT_A_RESULT].sort()).toEqual(['NO_CHECKS', 'RUN_NOT_FINISHED', 'RUN_PROCESS_ERROR']);
    expect(RunExit.isNotAResult('RUN_NOT_FINISHED')).toBe(true);
    for (const v of ['TOKEN_AUTH_ERROR', 'TOKEN_FORMAT_ERROR', null, undefined, '']) expect(RunExit.isNotAResult(v)).toBe(false);
  });

  // Bruno CLI is installed in its own folder (bruno-cli/) only where it runs:
  // when it is there, every code it can end a run with is named.
  (fs.existsSync(BRUNO_CONSTANTS) ? test : test.skip)('every exit code of the installed Bruno CLI but 1 has its meaning', () => {
    const { EXIT_STATUS } = require(BRUNO_CONSTANTS);
    for (const code of new Set(Object.values(EXIT_STATUS))) {
      if (code === 1) continue;
      expect(RunExit.exitMeaning(code)).not.toBe(RunExit.exitMeaning(42));
    }
  });
});

describe('the run page banner for a run that did not go to its end', () => {
  const banner = pageFunction('notFinishedBannerHtml', { escHtml: esc, OscarRunExit: RunExit, Number, String });

  test('names the code and its meaning', () => {
    const html = banner(255);
    expect(html).toContain('The run did not go to its end — this is not a test result');
    expect(html).toContain('It ended with code 255: Bruno stopped on an unexpected error (&quot;Something went wrong&quot;)');
    expect(html).toContain('the rest of the scenario was not tested');
  });

  test('a code that is not a number is not printed', () => {
    for (const code of [null, undefined, '<b>1</b>', 1.5]) {
      const html = banner(code);
      expect(html).toContain('It ended with code unknown:');
      expect(html).not.toContain('<b>');
    }
  });
});
