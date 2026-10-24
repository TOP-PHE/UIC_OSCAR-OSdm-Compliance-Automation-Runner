// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * checklistFiles.js — the set-up checklist files by name (#938, decision E3).
 *
 * Every checklist file is `OSCAR_Checklist_<NAME>_Vxx.yy.docx`: `TEMPLATE`
 * for the blank form, `Simulator-<provider>` for a simulator copy. The
 * version is in the name, so OSCAR's code and tests never write one: they
 * ask for a name and get the highest version. The template keeps its three
 * latest versions (`TEMPLATE_VERSIONS_KEPT`); every copy keeps its latest
 * only, so a copy found twice is a mistake to fix, not to choose from.
 */

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = 'TEMPLATE';
const TEMPLATE_VERSIONS_KEPT = 3;
const FILE = /^OSCAR_Checklist_(.+)_V(\d{2})\.(\d{2})\.docx$/;

/** { name, major, minor } of a checklist file name, or null when it is not one. */
function checklistNameOf(file) {
  const m = FILE.exec(file);
  return m ? { name: m[1], major: Number(m[2]), minor: Number(m[3]) } : null;
}

/** The checklist files of `folder` named `name`, highest version first. */
function checklistVersions(folder, name) {
  return fs.readdirSync(folder)
    .map((file) => ({ file, at: checklistNameOf(file) }))
    .filter(({ at }) => at && at.name === name)
    .sort((a, b) => (b.at.major - a.at.major) || (b.at.minor - a.at.minor))
    .map(({ file }) => file);
}

/**
 * The path of the checklist `name` in `folder`, at its highest version.
 * Throws when there is none, or when a copy (any name but TEMPLATE) is
 * there more than once.
 */
function checklistFile(folder, name) {
  const files = checklistVersions(folder, name);
  if (files.length === 0) throw new Error(`No checklist OSCAR_Checklist_${name}_Vxx.yy.docx in ${folder}.`);
  if (name !== TEMPLATE && files.length > 1) {
    throw new Error(`The checklist ${name} is in ${folder} ${files.length} times (${files.join(', ')}): a copy keeps its latest version only.`);
  }
  return path.join(folder, files[0]);
}

module.exports = { TEMPLATE, TEMPLATE_VERSIONS_KEPT, checklistNameOf, checklistVersions, checklistFile };
