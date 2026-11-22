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
      'cd .. && node Oscar_Server/node_modules/eslint/bin/eslint.js -c Oscar_Server/eslint.library.config.js Bruno_Collection/library-bruno --max-warnings 0'
      + ' --suppressions-location Oscar_Server/eslint-library-suppressions.json');
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
    expect(block.rules).toEqual({ ...rules, ...require('../../eslint.size-rules') });
    for (const name of ['bru', 'req', 'res', 'test', 'expect']) expect(block.languageOptions.globals).toHaveProperty(name);
  });
});

describe('the limits a new function is held to', () => {
  const sizeRules = require('../../eslint.size-rules');
  const ESLINT = path.join(SERVER, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const recorded = name => JSON.parse(read(SERVER, name));
  const totalOf = (record, rule) => Object.values(record).reduce((sum, rules) => sum + (rules[rule]?.count || 0), 0);

  test('15 paths through a function, 100 lines of code', () => {
    expect(sizeRules).toEqual({
      complexity: ['error', { max: 15, variant: 'modified' }],
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
    });
  });

  test('in the server, the pages\' scripts and the library; not in the tests', () => {
    const blocks = require('../../eslint.config');
    const blockOf = glob => blocks.find(b => (b.files || []).includes(glob));
    for (const glob of ['src/**/*.js', 'public/**/*.js']) {
      expect(blockOf(glob).rules.complexity).toBe(sizeRules.complexity);
      expect(blockOf(glob).rules['max-lines-per-function']).toBe(sizeRules['max-lines-per-function']);
    }
    const [library] = require('../../eslint.library.config');
    expect(library.rules.complexity).toBe(sizeRules.complexity);
    expect(library.rules['max-lines-per-function']).toBe(sizeRules['max-lines-per-function']);
    expect(blockOf('tests/**/*.js').rules).not.toHaveProperty('complexity');
    expect(blockOf('tests/**/*.js').rules).not.toHaveProperty('max-lines-per-function');
  });

  // What was over the limits when they were set. **These numbers only go
  // down**: lower them with the record (`npm run lint:baseline`) when a
  // function is brought under a limit. Raising one says, in this diff, that a
  // function over a limit was let in on purpose.
  test.each([
    ['eslint-suppressions.json', 107, 22],
    ['eslint-library-suppressions.json', 82, 23],
  ])('%s records no more than what was there', (name, complexity, lines) => {
    const record = recorded(name);
    expect(totalOf(record, 'complexity')).toBeLessThanOrEqual(complexity);
    expect(totalOf(record, 'max-lines-per-function')).toBeLessThanOrEqual(lines);
  });

  test('the records hold the two limits only: no other rule is ever set aside', () => {
    for (const name of ['eslint-suppressions.json', 'eslint-library-suppressions.json']) {
      for (const [file, rules] of Object.entries(recorded(name))) {
        expect([file, Object.keys(rules).filter(rule => !(rule in sizeRules))]).toEqual([file, []]);
        // Written with forward slashes, from the folder ESLint is started in.
        expect(file).not.toContain('\\');
        const from = name === 'eslint-suppressions.json' ? SERVER : REPO;
        expect([file, fs.existsSync(path.join(from, file))]).toEqual([file, true]);
      }
    }
  });

  test('the scripts: the library has a record of its own, and one command lowers both', () => {
    const scripts = JSON.parse(read(SERVER, 'package.json')).scripts;
    expect(scripts['lint:library']).toContain('--suppressions-location Oscar_Server/eslint-library-suppressions.json');
    expect(scripts['lint:baseline']).toBe(
      'eslint src/ public/ tests/ scripts/ --prune-suppressions && cd .. && ' + scripts['lint:library'].replace('cd .. && ', '') + ' --prune-suppressions');
    // No script sets a rule aside: a record is raised by hand, where it shows.
    for (const script of Object.values(scripts)) expect(script).not.toMatch(/--suppress-(all|rule)/);
  });

  // The baseline is ESLint's own. What OSCAR relies on is run here on a folder
  // of a moment, with the real limits: an upgrade of ESLint that changed any
  // of it would fail this test, not pass a function over a limit unseen.
  describe('as ESLint applies them', () => {
    let folder;
    const lint = (...args) => spawnSync(process.execPath, [ESLINT, 'code', ...args], { cwd: folder, encoding: 'utf8' });
    const ifs = (name, count) => `function ${name}(x) {\n  let n = 0;\n${Array.from({ length: count }, (_, i) => `  if (x === ${i}) n += 1;`).join('\n')}\n  return n;\n}\n`;
    const write = (name, text) => fs.writeFileSync(path.join(folder, 'code', name), `'use strict';\n${text}`);
    const record = () => JSON.parse(fs.readFileSync(path.join(folder, 'eslint-suppressions.json'), 'utf8'));

    beforeAll(() => {
      folder = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-limits-'));
      fs.mkdirSync(path.join(folder, 'code'));
      fs.writeFileSync(path.join(folder, 'eslint.config.js'), [
        "'use strict';",
        `const rules = require(${JSON.stringify(path.join(SERVER, 'eslint.size-rules.js'))});`,
        "module.exports = [{ files: ['code/**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' }, rules }];",
      ].join('\n'));
    });
    afterAll(() => fs.rmSync(folder, { recursive: true, force: true }));

    test('at a limit passes, one over fails, and a recorded one passes until another joins it or it leaves', () => {
      // 14 conditions make 15 paths; 97 statements make 100 lines with the three around them.
      write('paths.js', `${ifs('atTheLimit', 14)}module.exports = { atTheLimit };\n`);
      write('lines.js', `function long() {\n${Array.from({ length: 97 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n  return v0 + v96;\n}\nmodule.exports = { long };\n`);
      expect(lint().status).toBe(0);

      write('paths.js', `${ifs('over', 15)}module.exports = { over };\n`);
      let run = lint();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("Function 'over' has a complexity of 16. Maximum allowed is 15");

      write('lines.js', `function long() {\n${Array.from({ length: 98 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n  return v0 + v97;\n}\nmodule.exports = { long };\n`);
      run = lint();
      expect(run.stdout).toContain("Function 'long' has too many lines (101). Maximum allowed is 100");

      // Recorded, as the two files of OSCAR's were made.
      expect(lint('--suppress-rule', 'complexity', '--suppress-rule', 'max-lines-per-function').status).toBe(0);
      expect(record()).toEqual({
        'code/lines.js': { 'max-lines-per-function': { count: 1 } },
        'code/paths.js': { complexity: { count: 1 } },
      });
      expect(lint().status).toBe(0);

      // One more over the limit in a file that has its record: refused.
      write('paths.js', `${ifs('over', 15)}${ifs('another', 15)}module.exports = { over, another };\n`);
      run = lint();
      expect(run.status).toBe(1);
      expect(run.stdout).toContain("Function 'another' has a complexity of 16");

      // One brought under the limit: refused too, until the record is lowered.
      write('paths.js', `${ifs('over', 15)}module.exports = { over };\n`);
      write('lines.js', 'function short() { return 1; }\nmodule.exports = { short };\n');
      run = lint();
      expect(run.status).toBe(2);
      expect(run.stdout + run.stderr).toContain('--prune-suppressions');
      expect(lint('--prune-suppressions').status).toBe(0);
      expect(record()).toEqual({ 'code/paths.js': { complexity: { count: 1 } } });
      expect(lint().status).toBe(0);
    }, 120000);
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
