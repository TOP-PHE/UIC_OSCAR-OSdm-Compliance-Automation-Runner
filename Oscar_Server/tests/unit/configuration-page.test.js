// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #810: Test Config's side of a full configuration. The page's functions are
 * lifted out of scenarios.js and run in a vm, as the other page tests do.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const source = fs.readFileSync(path.join(PUBLIC, 'js', 'scenarios.js'), 'utf8');
const html = fs.readFileSync(path.join(PUBLIC, 'scenarios.html'), 'utf8');

function loadFunction(name, context = {}) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
}

const countScenarios = loadFunction('countScenarios');
const isConfigurationFile = loadFunction('isConfigurationFile');
const configurationSummary = loadFunction('configurationSummary', { countScenarios });
const importResultText = loadFunction('importResultText');

test('a full configuration is told apart from a data file by its marker', () => {
  expect(isConfigurationFile({ __oscarConfiguration: { format: 1 } })).toBe(true);
  expect(isConfigurationFile({ scenarios: [] })).toBe(false);
  expect(isConfigurationFile(null)).toBe(false);
  expect(isConfigurationFile([])).toBe(false);
});

test('the summary says what the file holds and where it comes from', () => {
  expect(configurationSummary({
    __oscarConfiguration: { format: 1, company: 'acme', exported_at: '2026-10-17T10:00:00Z' },
    datafile: { scenarios: [{}, {}] },
    framework: { osdmVersion: '3.8.0' },
    testResources: [{ resource_type: 'TRAIN' }, { resource_type: 'TRAIN' }, { resource_type: 'JOURNEY' }, null],
  })).toBe('From acme, 2026-10-17: 2 scenario(s), a Test Framework (OSDM 3.8.0), 2 train(s) and 1 journey(s).');
  expect(configurationSummary({ __oscarConfiguration: {}, datafile: null, framework: null }))
    .toBe('no data file, no Test Framework, 0 train(s) and 0 journey(s).');
});

test('the result message names each part taken', () => {
  expect(importResultText({
    scenarios: { replaced: true, scenarios_count: 3, previous: { scenarios_count: 1 } },
    framework: { replaced: true },
    testData: { mode: 'replace', removed: 2, trains_added: 4, journeys_added: 1, already_there: 0, unresolved_legs: 1 },
  })).toBe('✅ Configuration imported: data file replaced (3 scenario(s); the previous one is kept); Test Framework replaced; '
    + 'Test Data: 2 removed, 4 train(s) and 1 journey(s) added; 1 journey leg(s) name a train that is not in the file: check them in Test Data.');
  expect(importResultText({ scenarios: { replaced: false }, framework: { replaced: false },
    testData: { mode: 'add', removed: 0, trains_added: 0, journeys_added: 0, already_there: 5, unresolved_legs: 0 } }))
    .toBe('✅ Configuration imported: Test Data: 0 train(s) and 0 journey(s) added, 5 already there.');
});

test('the upload sends a full configuration to the import panel, before the data-file confirmation', () => {
  const upload = source.slice(source.indexOf('async function handleFileUpload('), source.indexOf('\n}\n', source.indexOf('async function handleFileUpload(')));
  const toImport = upload.indexOf('openConfigurationImport(file, parsed)');
  expect(toImport).toBeGreaterThan(-1);
  expect(toImport).toBeLessThan(upload.indexOf('confirm(uploadConfirmText('));
});

test('every action of the two panels is handled, and every choice has a label', () => {
  for (const action of ['download-scenarios', 'download-configuration', 'config-import-run', 'close-config-panel']) {
    expect(html).toContain(`data-action="${action}"`);
    expect(source).toContain(`case '${action}':`);
  }
  for (const id of ['ci-scenarios', 'ci-framework', 'ci-test-data']) {
    expect(html).toContain(`<label for="${id}">`);
    expect(html).toContain(`<select id="${id}">`);
  }
  // The values the server reads (utils/configurationBundle.js).
  expect(html).toMatch(/id="ci-test-data">[\s\S]*value="add"[\s\S]*value="replace"[\s\S]*value="keep"/);
});
