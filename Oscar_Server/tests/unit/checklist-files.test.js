// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * #938: the set-up checklist files by name (OSCAR_Checklist_<NAME>_Vxx.yy),
 * what the repository keeps of them, the links the documents give, and
 * chapter F and A1.3 read on import.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const F = require('../../src/utils/checklistFiles');
const { answersOfDocx } = require('../../src/utils/checklistAnswers');
const R = require('../../src/utils/referenceConfiguration');
const { fareDeclarationsProblem, referenceFares } = require('../../src/utils/fareDeclarations');

const ROOT = path.join(__dirname, '..', '..', '..');
const GUIDES = path.join(ROOT, 'Documentation', 'User_Guides');
const SIM = path.join(ROOT, 'Documentation', 'Server_Operations', 'Simulator checklists');
const PROVIDERS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const answersOf = (file) => answersOfDocx(fs.readFileSync(file)).answers;

describe('#938 checklistFile()', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-checklists-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const touch = (...names) => names.forEach((n) => fs.writeFileSync(path.join(dir, n), ''));

  test('reads the name and version of a checklist file, and nothing else', () => {
    expect(F.checklistNameOf('OSCAR_Checklist_Simulator-alpha_V01.06.docx')).toEqual({ name: 'Simulator-alpha', major: 1, minor: 6 });
    for (const other of ['OSCAR_Test_Config_Checklist.docx', 'OSCAR_Checklist_TEMPLATE_V1.06.docx', 'OSCAR_Checklist_TEMPLATE_V01.06.pdf']) {
      expect(F.checklistNameOf(other)).toBeNull();
    }
  });

  test('gives the highest version of the template, compared as numbers', () => {
    touch('OSCAR_Checklist_TEMPLATE_V01.09.docx', 'OSCAR_Checklist_TEMPLATE_V01.10.docx', 'OSCAR_Checklist_TEMPLATE_V01.08.docx');
    expect(path.basename(F.checklistFile(dir, 'TEMPLATE'))).toBe('OSCAR_Checklist_TEMPLATE_V01.10.docx');
  });

  test('fails when there is none, and when a copy is there twice', () => {
    expect(() => F.checklistFile(dir, 'Simulator-alpha')).toThrow('No checklist');
    touch('OSCAR_Checklist_Simulator-alpha_V01.05.docx', 'OSCAR_Checklist_Simulator-alpha_V01.06.docx', 'OSCAR_Checklist_Simulator-alphax_V01.06.docx');
    expect(() => F.checklistFile(dir, 'Simulator-alpha')).toThrow('2 times');
  });
});

describe('#938 the checklist files of the repository', () => {
  test('the template keeps its three latest versions at most', () => {
    const versions = F.checklistVersions(GUIDES, F.TEMPLATE);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.length).toBeLessThanOrEqual(F.TEMPLATE_VERSIONS_KEPT);
  });

  test('each simulator copy is there once, on the latest template version', () => {
    const latest = F.checklistNameOf(path.basename(F.checklistFile(GUIDES, F.TEMPLATE)));
    for (const p of PROVIDERS) {
      const at = F.checklistNameOf(path.basename(F.checklistFile(SIM, `Simulator-${p}`)));
      expect([at.major, at.minor]).toEqual([latest.major, latest.minor]);
    }
  });

  test('no checklist file has the name used before V01.06', () => {
    for (const folder of [GUIDES, SIM]) {
      expect(fs.readdirSync(folder).filter((f) => f.startsWith('OSCAR_Test_Config_Checklist'))).toEqual([]);
    }
  });

  test('every link a document gives to a checklist file reaches it', () => {
    const docs = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) docs.push(full);
    });
    walk(path.join(ROOT, 'Documentation'));
    docs.push(path.join(ROOT, 'README.md'), path.join(ROOT, 'Bruno_Collection', 'README.md'));
    const links = [];
    for (const doc of docs.filter((d) => fs.existsSync(d))) {
      for (const m of fs.readFileSync(doc, 'utf8').matchAll(/\]\(([^)\s]*OSCAR_[A-Za-z_]*Checklist[^)\s]*\.docx)\)/g)) {
        links.push({ doc: path.relative(ROOT, doc), target: decodeURIComponent(m[1]) });
      }
    }
    expect(links.length).toBeGreaterThanOrEqual(7);
    const broken = links.filter(({ doc, target }) => !fs.existsSync(path.join(ROOT, path.dirname(doc), target)));
    expect(broken).toEqual([]);
  });
});

describe('#938 A1.3 and chapter F on import', () => {
  test('a simulator checklist declares both modes and the fares of its profile', () => {
    for (const p of PROVIDERS) {
      const fw = R.frameworkFromChecklist(answersOf(F.checklistFile(SIM, `Simulator-${p}`)));
      const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'OSDM_Simulator', 'providers', `${p}.json`), 'utf8'));
      expect(fw.distributionModes).toEqual(['PRODUCT', 'FARE']);
      expect(fw.fares).toEqual(referenceFares(profile));
      expect(fareDeclarationsProblem(fw.fares)).toBeNull();
    }
  });

  test('a copy without A1.3 and chapter F (V01.05 and before) imports as before', () => {
    const answers = answersOf(F.checklistFile(SIM, 'Simulator-gamma'));
    const older = Object.fromEntries(Object.entries(answers).filter(([tag]) => !/^(fw\.distributionModes|fw\.fares\.|info\.fares\.)/.test(tag)));
    const fw = R.frameworkFromChecklist(older);
    expect(fw.distributionModes).toEqual(['PRODUCT']);
    expect(fw.fares).toBeUndefined();
    const full = R.frameworkFromChecklist(answers);
    delete full.fares;
    full.distributionModes = ['PRODUCT'];
    expect(fw).toEqual(full);
  });

  test('the blank templates kept are read as a form with nothing filled in, and the latest holds A1.3 and chapter F', () => {
    for (const file of F.checklistVersions(GUIDES, F.TEMPLATE)) {
      expect(answersOfDocx(fs.readFileSync(path.join(GUIDES, file))).refusal).toContain('nothing is filled in');
    }
    const xml = require('../../src/utils/zip').readZipEntry(fs.readFileSync(F.checklistFile(GUIDES, F.TEMPLATE)), 'word/document.xml').toString('utf8');
    for (const tag of ['fw.distributionModes=FARE', 'fw.fares.clusters=PROMO', 'fw.fares.statedRefundFee=YES', 'fw.fares.freeUnderAge', 'info.fares.wholeTripSection=NO', 'svc1.sectionPoints']) {
      expect(xml).toContain(`w:val="${tag}"`);
    }
  });

  test('ticks read as their values: no mode is product only, the sale of fares always counts, YES / NO is a boolean', () => {
    const fw = R.frameworkFromChecklist({
      'fw.distributionModes.comment': 'not sure yet',
      'fw.fares.salesFlows=REFUND_FULL': true,
      'fw.fares.statedRefundFee=NO': true,
      'fw.fares.freeUnderAge': '12',
      'fw.fares.clusters.comment': 'none named',
    });
    expect(fw.distributionModes).toEqual(['PRODUCT']);
    expect(fw.fares).toEqual({ salesFlows: ['SALE', 'REFUND_FULL'], statedRefundFee: false, freeUnderAge: 12, clusters: [] });
    expect(fareDeclarationsProblem(fw.fares)).toBeNull();
    expect(R.frameworkFromChecklist({ 'fw.fares.statedRefundFee=YES': true }).fares).toEqual({ statedRefundFee: true });
  });
});
