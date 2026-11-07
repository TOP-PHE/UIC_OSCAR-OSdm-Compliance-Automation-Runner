// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * launcher.test.js — a run's processes are started by kind, never by path
 * (worker/launcher.js), in the mode RUN_ISOLATION names.
 */

jest.mock('child_process');
const { spawn } = require('child_process');
const path = require('node:path');
const L = require('../../src/worker/launcher');

const saved = { iso: process.env.RUN_ISOLATION, bru: process.env.BRU_CMD };
afterEach(() => {
  spawn.mockReset();
  if (saved.iso === undefined) delete process.env.RUN_ISOLATION; else process.env.RUN_ISOLATION = saved.iso;
  if (saved.bru === undefined) delete process.env.BRU_CMD; else process.env.BRU_CMD = saved.bru;
});

describe('mode', () => {
  test('local by default, and when written in any case or with spaces', () => {
    delete process.env.RUN_ISOLATION;
    expect(L.isolationMode()).toBe('local');
    expect(L.launcherProblem()).toBeNull();
    process.env.RUN_ISOLATION = '  LOCAL ';
    expect(L.launcherProblem()).toBeNull();
  });

  test('a mode the server does not know refuses runs, and says which', () => {
    process.env.RUN_ISOLATION = 'isolated';
    expect(L.launcherProblem()).toMatch(/^RUN_ISOLATION="isolated" is not a mode this server knows \(local\)/);
    expect(() => L.launch('bru', { args: [], cwd: '/w', env: {} })).toThrow(/not a mode this server knows/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('launch()', () => {
  test('bru: the configured CLI, no shell on this platform, the env and folder given', () => {
    process.env.BRU_CMD = '/usr/local/bin/bru';
    spawn.mockReturnValueOnce('proc');
    expect(L.launch('bru', { args: ['run', '--env', 'E'], cwd: '/w/run', env: { A: '1' } })).toBe('proc');
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/bru', ['run', '--env', 'E'],
      { cwd: '/w/run', shell: false, env: { A: '1' } });
  });

  test('merge: the collection\'s mergeReport.js from the run\'s folder, run by this Node', () => {
    L.launch('merge', { args: ['E'], cwd: '/w/run', env: {} });
    expect(spawn).toHaveBeenCalledWith(process.execPath,
      [path.join('/w/run', 'library-bruno', 'mergeReport.js'), 'E'], { cwd: '/w/run', shell: false, env: {} });
  });

  test('any other kind is refused: a path is never run', () => {
    expect(() => L.launch('/bin/sh', { args: [], cwd: '/w', env: {} })).toThrow('launcher: unknown kind "/bin/sh"');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('RUN_WORKSPACES_DIR', () => {
  test('puts the runs\' working folders where it says; data/workspaces otherwise', () => {
    const saved = process.env.RUN_WORKSPACES_DIR;
    try {
      process.env.RUN_WORKSPACES_DIR = '/run/oscar-workspaces';
      jest.isolateModules(() => {
        expect(require('../../src/worker/runner').WORKSPACES_DIR).toBe(path.resolve('/run/oscar-workspaces'));
      });
      delete process.env.RUN_WORKSPACES_DIR;
      jest.isolateModules(() => {
        expect(require('../../src/worker/runner').WORKSPACES_DIR).toBe(path.resolve(__dirname, '../../data/workspaces'));
      });
    } finally {
      if (saved === undefined) delete process.env.RUN_WORKSPACES_DIR; else process.env.RUN_WORKSPACES_DIR = saved;
    }
  });
});
