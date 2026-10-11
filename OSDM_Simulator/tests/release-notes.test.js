// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #617: the notes of a simulator-<version> release, from the CHANGELOG.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { releaseNotes } = require('../scripts/release-notes');

const CHANGELOG = [
  '# Changelog',
  '',
  '## [server-1.0.2] / [collection-X.2] — 2026-10-12',
  '',
  'Issue #2, release 2026.2. Simulator 0.2.0.',
  '',
  '### Added',
  '',
  '- Something on the server.',
  '',
  '### Simulator 0.2.0',
  '',
  '- The simulator answers more.',
  '  On two lines.',
  '',
  '---',
  '',
  '## [server-1.0.1] / [collection-X.1] — 2026-10-11',
  '',
  'Issue #1, release 2026.1. Simulator 0.1.0.',
  '',
  '- **Simulator 0.1.0**: a first bullet',
  '  that goes on.',
  '- Not the simulator.',
  '',
  '## [server-1.0.0] / [collection-X.0] — 2026-10-10',
  '',
  'Issue #0, release 2026.0. Simulator 0.0.9.',
  '',
  '- Nothing named.',
].join('\n');

test('a "### Simulator" part is taken whole, after the release line', () => {
  assert.equal(releaseNotes(CHANGELOG, '0.2.0'),
    'Issue #2, release 2026.2. Simulator 0.2.0.\n\n- The simulator answers more.\n  On two lines.\n');
});

test('else the bullets that start with the version, with their continuation', () => {
  assert.equal(releaseNotes(CHANGELOG, '0.1.0'),
    'Issue #1, release 2026.1. Simulator 0.1.0.\n\n- **Simulator 0.1.0**: a first bullet\n  that goes on.\n');
});

test('a section that names the version and nothing more points to the CHANGELOG', () => {
  assert.equal(releaseNotes(CHANGELOG, '0.0.9'),
    'Issue #0, release 2026.0. Simulator 0.0.9.\n\nSee the CHANGELOG entry of this release.\n');
});

test('no section, or not a version: null', () => {
  assert.equal(releaseNotes(CHANGELOG, '0.3.0'), null);
  assert.equal(releaseNotes(CHANGELOG, '0.2'), null);
  assert.equal(releaseNotes(CHANGELOG, '0.2.0.'), null);
  // "Simulator 0.2.0" must not match a section of 0.2.0x.
  assert.equal(releaseNotes(CHANGELOG.replace('Simulator 0.2.0.', 'Simulator 0.2.01.'), '0.2.0'), null);
});

test('the current version has notes in the repository CHANGELOG', () => {
  const { version } = require('../package.json');
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotes(text, version);
  assert.ok(notes, `CHANGELOG.md names no "Simulator ${version}."`);
  assert.ok(notes.startsWith('Issue #'), notes);
});

test('run as a program: the notes on stdout, or status 1 and one line', () => {
  const script = path.join(__dirname, '..', 'scripts', 'release-notes.js');
  const { version } = require('../package.json');
  const ok = spawnSync(process.execPath, [script, version], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(`Simulator ${version.replaceAll('.', '\\.')}\\.`));
  const missing = spawnSync(process.execPath, [script, '99.0.0'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr.trim(), 'No CHANGELOG section names Simulator 99.0.0.');
});
