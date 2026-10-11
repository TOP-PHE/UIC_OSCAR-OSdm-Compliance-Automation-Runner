// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * release-notes.js — the notes of a simulator release, from the CHANGELOG.
 *
 *   node scripts/release-notes.js <version>
 *
 * Prints the notes of `simulator-<version>` (#617), read from the repository's
 * CHANGELOG.md: the release section whose first line names "Simulator
 * <version>", and in it the "### Simulator <version>" part, or else the
 * bullets that start with "**Simulator <version>**". Ends with status 1 when
 * no section names that version, so that the release workflow stops instead
 * of publishing empty notes. The file read is always the CHANGELOG: the
 * argument is only compared with its text.
 */

const fs = require('node:fs');
const path = require('node:path');

const CHANGELOG = path.join(__dirname, '..', '..', 'CHANGELOG.md');
const VERSION = /^\d+\.\d+\.\d+$/;

// The release sections of the CHANGELOG, each as its lines.
function sections(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## [')) {
      current = [line];
      out.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  return out;
}

// The lines from `start` up to the next heading or rule, without trailing blanks.
function block(lines, start) {
  let end = start + 1;
  while (end < lines.length && !/^(#{2,3} |---\s*$)/.test(lines[end])) end += 1;
  const out = lines.slice(start, end);
  while (out.length > 0 && out.at(-1).trim() === '') out.pop();
  return out;
}

// The bullets of a section that start with **Simulator <version>**, with
// their continuation lines.
function simulatorBullets(lines, version) {
  const out = [];
  const head = `- **Simulator ${version}**`;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith(head)) continue;
    out.push(lines[i]);
    for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j += 1) out.push(lines[j]);
  }
  return out;
}

/**
 * The notes for one version, or null when no release section names it.
 * Pure: takes the CHANGELOG's text.
 */
function releaseNotes(text, version) {
  if (!VERSION.test(String(version))) return null;
  const named = `Simulator ${version}.`;
  for (const lines of sections(text)) {
    const intro = lines.findIndex((line) => line.trim() !== '' && !line.startsWith('## ['));
    if (intro === -1 || !lines[intro].includes(named)) continue;
    const heading = lines.indexOf(`### Simulator ${version}`);
    let body;
    if (heading === -1) {
      body = simulatorBullets(lines, version);
    } else {
      body = block(lines, heading).slice(1);
      while (body.length > 0 && body[0].trim() === '') body.shift();
    }
    const first = lines[intro].trim();
    return [first, '', ...(body.length > 0 ? body : ['See the CHANGELOG entry of this release.'])].join('\n') + '\n';
  }
  return null;
}

if (require.main === module) {
  const version = process.argv[2];
  const notes = releaseNotes(fs.readFileSync(CHANGELOG, 'utf8'), version);
  if (notes === null) {
    console.error(`No CHANGELOG section names Simulator ${version}.`);
    process.exit(1);
  }
  process.stdout.write(notes);
}

module.exports = { releaseNotes };
