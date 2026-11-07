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
    process.env.RUN_ISOLATION = 'separate';
    expect(L.launcherProblem()).toMatch(/^RUN_ISOLATION="separate" is not a mode this server knows \(local, isolated, pod\)/);
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

// Option 4 (#1130): pod mode, a whole run per request to the run dispatcher.
describe('pod mode', () => {
  const net = require('node:net');
  const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_AGENT_HOST', 'RUN_AGENT_PORT', 'RUN_SERVER_URL', 'INTERNAL_PORT'];
  const saved = {};
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    Object.assign(process.env, { RUN_ISOLATION: 'pod', RUN_AGENT_TOKEN: 't'.repeat(40), RUN_SERVER_URL: 'http://oscar-internal:3003', INTERNAL_PORT: '3003' });
  });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test.each([
    ['RUN_AGENT_TOKEN', 'short', /RUN_AGENT_TOKEN/],
    ['RUN_AGENT_PORT', 'x', /RUN_AGENT_PORT/],
    ['RUN_SERVER_URL', 'oscar-internal', /RUN_SERVER_URL/],
    ['INTERNAL_PORT', '', /INTERNAL_PORT/],
  ])('%s = %p: no run is started', (key, value, message) => {
    process.env[key] = value;
    expect(L.launcherProblem()).toMatch(message);
  });

  test('the settings are complete: no problem; a process by kind is refused', () => {
    expect(L.launcherProblem()).toBeNull();
    expect(() => L.launch('bru', { args: [], cwd: '.', env: {} })).toThrow(/launchRun/);
  });

  test('a whole run goes to the dispatcher with the run\'s credentials only; its pod\'s address comes back', async () => {
    let request;
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        request = JSON.parse(chunk.toString().split('\n')[0]);
        socket.write(`${JSON.stringify({ t: 'started' })}\n${JSON.stringify({ t: 'pod', address: '10.1.0.9' })}\n`);
        socket.end(`${JSON.stringify({ t: 'exit', code: 0 })}\n`);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.RUN_AGENT_HOST = '127.0.0.1';
    process.env.RUN_AGENT_PORT = String(server.address().port);
    const proc = L.launchRun({
      runId: '11111111-2222-3333-4444-555555555555', envName: 'OTST_x_11111111_Env', envYml: 'bmFtZTogeAo=',
      deadlineSeconds: 600, env: { OSCAR_ACCESS_TOKEN: 'tok', OSCAR_RUN_SECRET: 's', ENCRYPTION_KEY: 'never' },
    });
    const pod = new Promise((resolve) => proc.on('pod', resolve));
    const code = await new Promise((resolve) => proc.on('close', resolve));
    server.close();
    expect(await pod).toBe('10.1.0.9');
    expect(code).toBe(0);
    expect(request).toMatchObject({ kind: 'run', runId: '11111111-2222-3333-4444-555555555555', deadlineSeconds: 600, token: 't'.repeat(40) });
    expect(request.env).toEqual({ OSCAR_ACCESS_TOKEN: 'tok', OSCAR_RUN_SECRET: 's' });
  });

  test('outside pod mode, a whole run is refused', () => {
    process.env.RUN_ISOLATION = 'local';
    expect(() => L.launchRun({ runId: 'x', envName: 'e', envYml: 'e', deadlineSeconds: 60, env: {} })).toThrow(/pod mode only/);
  });
});
