// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * lint-config.test.js — what `npm run lint` reads, and the version SonarCloud
 * files an analysis under.
 *
 * Until 1.11.571 ESLint read src/ and public/ only: the tests, the scripts
 * and the Bruno collection's library (some 110,000 lines) had no linter. And
 * SonarCloud's version was a number kept by hand, which stayed at 1.11.178
 * for four months.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..');
const REPO = path.join(SERVER, '..');
const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8').split('\r\n').join('\n');

describe('npm run lint', () => {
  const scripts = JSON.parse(read(SERVER, 'package.json')).scripts;

  test('reads the server, the pages, the tests, the scripts, the library and the inline scripts', () => {
    expect(scripts.lint).toBe('eslint src/ public/ tests/ scripts/ && npm run lint:library && node scripts/lint-inline-scripts.js');
  });

  test('reads the library from the repository root, with its own configuration and no warning allowed', () => {
    expect(scripts['lint:library']).toBe(
      'cd .. && node Oscar_Server/node_modules/eslint/bin/eslint.js -c Oscar_Server/eslint.library.config.js Bruno_Collection/library-bruno --max-warnings 0');
  });

  test('CI runs it', () => {
    expect(read(REPO, '.github', 'workflows', 'ci-server.yml')).toMatch(/^\s+run: npm run lint$/m);
  });
});

describe('the rules for code not held to the server\'s style', () => {
  const rules = require('../../eslint.bug-rules');

  test('every rule is an error: none is a warning nobody reads', () => {
    for (const [name, setting] of Object.entries(rules)) {
      expect([name, Array.isArray(setting) ? setting[0] : setting]).toEqual([name, 'error']);
    }
  });

  test('the ones that matter most are there', () => {
    for (const name of ['no-undef', 'no-unused-vars', 'no-unreachable', 'no-dupe-keys', 'no-const-assign', 'no-redeclare']) {
      expect(rules).toHaveProperty(name);
    }
  });

  test('the tests and the scripts are read with them', () => {
    const blocks = require('../../eslint.config');
    const block = blocks.find(b => (b.files || []).includes('tests/**/*.js'));
    expect(block.files).toEqual(['tests/**/*.js', 'scripts/**/*.js']);
    expect(block.rules).toBe(rules);
    for (const name of ['describe', 'test', 'expect', 'jest', 'require', 'process']) {
      expect(block.languageOptions.globals).toHaveProperty(name);
    }
  });

  test('the library is read with them', () => {
    const [block] = require('../../eslint.library.config');
    expect(block.files).toEqual(['Bruno_Collection/library-bruno/**/*.js']);
    expect(block.rules).toBe(rules);
    for (const name of ['bru', 'req', 'res', 'test', 'expect']) expect(block.languageOptions.globals).toHaveProperty(name);
  });
});

describe('the names the library shares through the global object', () => {
  const { SHARED_THROUGH_GLOBAL } = require('../../eslint.library.config');

  // The list may only get shorter: lower this number with it, never raise it.
  test('are 34 at most, each once', () => {
    expect(SHARED_THROUGH_GLOBAL.length).toBeLessThanOrEqual(34);
    expect(new Set(SHARED_THROUGH_GLOBAL).size).toBe(SHARED_THROUGH_GLOBAL.length);
  });

  // Read the library without the list: what ESLint then finds undefined must
  // be the list, name for name. A module that starts requiring what it uses
  // makes this fail until its names leave the list; a new name used without a
  // require fails `npm run lint` first.
  // ESLint is started as `npm run lint:library` starts it (its API loads
  // modules in a way Jest does not allow), with a configuration of a moment:
  // the real one, minus the list.
  test('are exactly the names the library uses without requiring them', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-lint-'));
    try {
      const config = path.join(folder, 'eslint.config.js');
      fs.writeFileSync(config, [
        "'use strict';",
        `const real = require(${JSON.stringify(path.join(SERVER, 'eslint.library.config.js'))});`,
        'const [block] = real;',
        'const globals = { ...block.languageOptions.globals };',
        'for (const name of real.SHARED_THROUGH_GLOBAL) delete globals[name];',
        "module.exports = [{ files: block.files, languageOptions: { ...block.languageOptions, globals }, rules: { 'no-undef': 'error' } }];",
      ].join('\n'));
      const run = spawnSync(process.execPath,
        [path.join(SERVER, 'node_modules', 'eslint', 'bin', 'eslint.js'), '-c', config, 'Bruno_Collection/library-bruno', '-f', 'json'],
        { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const results = JSON.parse(run.stdout);
      expect(results.length).toBeGreaterThan(70);
      const found = new Set();
      for (const result of results) {
        for (const message of result.messages) {
          expect([path.basename(result.filePath), message.ruleId]).toEqual([path.basename(result.filePath), 'no-undef']);
          found.add(/'([^']+)'/.exec(message.message)[1]);
        }
      }
      expect([...found].sort()).toEqual([...SHARED_THROUGH_GLOBAL].sort());
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }, 120000);
});

describe('the version SonarCloud files an analysis under', () => {
  const workflow = read(REPO, '.github', 'workflows', 'sonar.yml');
  const properties = read(REPO, 'sonar-project.properties');

  test('is not a number kept by hand', () => {
    expect(properties).not.toMatch(/^sonar[.]projectVersion\s*=/m);
  });

  test('is read from the server\'s package.json and passed to the scan', () => {
    expect(workflow).toContain("version=$(node -p \"require('./Oscar_Server/package.json').version\")");
    expect(workflow).toContain('args: -Dsonar.projectVersion=${{ steps.server.outputs.version }}');
    expect(workflow.indexOf("- name: Read the server's version")).toBeLessThan(workflow.indexOf('- name: SonarCloud Scan'));
  });

  test('is refused unless it is digits and dots: it goes into the scan\'s arguments', () => {
    expect(workflow).toContain("''|*[!0-9.]*)");
    expect(JSON.parse(read(SERVER, 'package.json')).version).toMatch(/^\d+[.]\d+[.]\d+$/);
  });
});
