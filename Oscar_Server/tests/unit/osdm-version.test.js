// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * osdm-version.test.js — #785: a Test Framework's OSDM version typed "3..0.5"
 * went into every copied scenario and every request of a batch. The version
 * is checked, a scenario naming none follows the framework, and a change of
 * the framework's version offers the scenarios on the old one the new one.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { OSDM_VERSION, isOsdmVersion, scenarioVersion, withFrameworkVersion, versionRefusal } = require('../../src/utils/osdmVersion');

describe('#785 the server\'s rule', () => {
  test('a version is digits and dots', () => {
    for (const ok of ['3.8', '3.0.5', '3.8.0', ' 3.10.12 ']) expect(isOsdmVersion(ok)).toBe(true);
    for (const bad of ['3..0.5', '3', '3.', 'v3.8', '3.8.0.1', '', null, 38, '3.8-beta']) expect(isOsdmVersion(bad)).toBe(false);
  });

  test('a scenario runs with its own version, else the framework\'s', () => {
    expect(scenarioVersion({ osdmVersion: '3.8' }, '3.0.5')).toBe('3.8');
    expect(scenarioVersion({ osdmVersion: ' ' }, '3.0.5')).toBe('3.0.5');
    expect(scenarioVersion({}, undefined)).toBe('');
  });

  test('the run\'s copy: scenarios naming none get the framework\'s, when it is a version', () => {
    const datafile = { scenarios: [{ code: 'A' }, { code: 'B', osdmVersion: '3.8' }, null, { code: 'C', osdmVersion: '' }] };
    expect(withFrameworkVersion(datafile, '3.0.5')).toBe(2);
    expect(datafile.scenarios.map((s) => s?.osdmVersion)).toEqual(['3.0.5', '3.8', undefined, '3.0.5']);
    const other = { scenarios: [{ code: 'A' }] };
    expect(withFrameworkVersion(other, '3..0.5')).toBe(0);
    expect(other.scenarios[0].osdmVersion).toBeUndefined();
    expect(withFrameworkVersion({}, '3.8')).toBe(0);
  });

  test('a run is refused when its version is not one, saying where to correct it', () => {
    const datafile = { scenarios: [{ code: 'OWN', osdmVersion: '3..0.5' }, { code: 'FW' }, { code: 'OK', osdmVersion: '3.8' }] };
    expect(versionRefusal(datafile, 'OWN', '3.8')).toContain('Correct it in the scenario');
    expect(versionRefusal(datafile, 'FW', '3..0.5')).toContain('Correct it in the Test Framework');
    expect(versionRefusal(datafile, 'FW', '3.8')).toBeNull();
    expect(versionRefusal(datafile, 'OK', '3..0.5')).toBeNull();
    expect(versionRefusal(datafile, 'FW', undefined)).toBeNull();
    expect(versionRefusal(datafile, 'MISSING', '3..0.5')).toBeNull();
  });
});

describe('#785 the Test Config page', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'scenarios.js'), 'utf8').split('\n');
  const source = lines.join('\n');
  const lift = (name, context) => {
    const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
    const end = lines.findIndex((l, i) => i > start && l === '}');
    return vm.runInNewContext(`(${lines.slice(start, end + 1).join('\n')})`, context);
  };
  const pattern = vm.runInNewContext(lines.find((l) => l.startsWith('const OSDM_VERSION_PATTERN = ')).replace('const OSDM_VERSION_PATTERN = ', '').replace(/;$/, ''));
  const isOsdmVersionText = (v) => pattern.test(String(v ?? '').trim());

  test('the page\'s rule is the server\'s', () => {
    expect(pattern.source).toBe(OSDM_VERSION.source);
  });

  test('the scenarios on the old version, own ones only, are offered the new one after a confirmation', () => {
    const state = { scenarios: [{ osdmVersion: '3..0.5' }, { osdmVersion: '3.8' }, { osdmVersion: '3..0.5', ro: true }, null, { osdmVersion: ' 3..0.5 ' }] };
    const set = [];
    const toasts = [];
    const ctx = {
      state,
      isReadOnlyForMe: (sc) => !!sc.ro,
      confirm: () => true,
      setScenarioField: (idx, f, v) => { set.push([idx, f, v]); },
      oscarToast: (m) => toasts.push(m),
    };
    ctx.scenariosOnVersion = lift('scenariosOnVersion', ctx);
    const offer = lift('offerScenarioVersionUpdate', ctx);
    offer('3..0.5', '3.0.5');
    expect(set).toEqual([[0, 'osdmVersion', '3.0.5'], [4, 'osdmVersion', '3.0.5']]);
    expect(toasts[0]).toContain('2 scenario(s) now on OSDM version 3.0.5');
    set.length = 0;
    ctx.confirm = () => false;
    offer('3..0.5', '3.0.5');
    offer('', '3.8');
    offer('3.8', '3.8');
    expect(set).toEqual([]);
  });

  test('a field left with something not a version is put back and said; the framework\'s offers the update', () => {
    const toasts = [];
    const offered = [];
    const ctx = {
      isOsdmVersionText,
      oscarToast: (m, kind) => toasts.push([m, kind]),
      offerScenarioVersionUpdate: (a, b) => offered.push([a, b]),
      wizData: { framework: { osdmVersion: '3.8' } },
      state: { scenarios: [{ osdmVersion: '3.6' }] },
      Number,
      String,
    };
    const change = lift('changeOsdmVersion', ctx);
    const field = (value, extra = {}) => ({ value, defaultValue: '3..0.5', dataset: {}, ...extra });
    const fw = field('3..0.5');
    expect(change('wiz-osdm-version', fw)).toBe(true);
    expect([fw.value, toasts[0][1]]).toEqual(['3.8', 'error']);
    const good = field('3.0.5');
    change('wiz-osdm-version', good);
    expect(offered).toEqual([['3..0.5', '3.0.5']]);
    expect(good.defaultValue).toBe('3.0.5');
    const sc = field('3.', { dataset: { field: 'osdmVersion', idx: '0' } });
    expect(change('set-scenario-text', sc)).toBe(true);
    expect(sc.value).toBe('3.6');
    expect(change('set-scenario-text', field('x', { dataset: { field: 'code' } }))).toBe(false);
    expect(change('other', field('x'))).toBe(false);
  });

  test('the page wires it: typing stores a version only, leaving checks it, the value is escaped', () => {
    expect(source).toContain('|| changeOsdmVersion(action, el)) return;');
    expect(source).toContain("if (!v || !isOsdmVersionText(v)) break;");
    expect(source).toContain("if (el.dataset.field === 'osdmVersion' && el.value.trim() && !isOsdmVersionText(el.value)) break;");
    expect(source).toContain('value="${esc(fw.osdmVersion||\'3.4\')}"');
  });
});
