// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * runner-agent.test.js — the runner agent (run isolation, option 2b), for
 * real: an agent listening on a loopback port, a fake Bruno CLI, the
 * server's RemoteProcess and launcher in front of it.
 */

const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAgent, startupProblem } = require('../../src/runner-agent/agent');
const { RemoteProcess } = require('../../src/worker/remoteProcess');
const P = require('../../src/runner-agent/protocol');

const TOKEN = 'a'.repeat(40);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-agent-'));
const workspaces = path.join(root, 'workspaces');
const outside = path.join(root, 'outside');
fs.mkdirSync(workspaces);
fs.mkdirSync(outside);

// A Bruno CLI that says what it was given, then ends as asked.
const fakeBru = path.join(root, 'fake-bru.js');
fs.writeFileSync(fakeBru, `#!${process.execPath}
const mode = process.argv[2];
console.log('pid=' + process.pid);
console.log('cwd=' + process.cwd());
console.log('secret=' + (process.env.OSCAR_RUN_SECRET || 'none'));
console.log('enc=' + (process.env.ENCRYPTION_KEY || 'none'));
console.log('other=' + (process.env.SENT_BY_SERVER || 'none'));
console.error('to stderr');
if (mode === 'sleep') setTimeout(() => {}, 60000); else process.exit(3);
`, { mode: 0o755 });

const savedBru = process.env.BRU_CMD;
let agent;
let port;

beforeAll(async () => {
  process.env.BRU_CMD = fakeBru;
  agent = createAgent({ token: TOKEN, workspacesDir: workspaces, log: {} });
  await new Promise((resolve) => agent.listen(0, '127.0.0.1', resolve));
  port = agent.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => agent.close(resolve));
  if (savedBru === undefined) delete process.env.BRU_CMD; else process.env.BRU_CMD = savedBru;
  fs.rmSync(root, { recursive: true, force: true });
});

function runFolder() {
  const dir = path.join(workspaces, randomUUID());
  fs.mkdirSync(dir);
  return dir;
}

// Runs a RemoteProcess to its end: { code, out, err, error }.
function runRemote(request, token = TOKEN) {
  return new Promise((resolve) => {
    const proc = new RemoteProcess({ host: '127.0.0.1', port, token }, request);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('close', (code) => resolve({ code, out, err, proc }));
    proc.on('error', (e) => resolve({ error: e.message, out, err, proc }));
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
}

describe('the agent starts a run\'s processes', () => {
  test('bru: output streamed, exit code given, the run\'s secret only, none of the server\'s', async () => {
    const cwd = runFolder();
    const res = await runRemote({ kind: 'bru', args: ['exit'], cwd,
      env: { OSCAR_RUN_SECRET: 'run-secret', ENCRYPTION_KEY: 'sent-anyway', SENT_BY_SERVER: 'x' } });
    expect(res.error).toBeUndefined();
    expect(res.code).toBe(3);
    expect(res.out).toContain(`cwd=${cwd}`);
    expect(res.out).toContain('secret=run-secret');
    expect(res.out).toContain('enc=none');
    expect(res.out).toContain('other=none');
    expect(res.err).toContain('to stderr');
  });

  test('merge: the collection\'s mergeReport.js of the run folder, with its arguments', async () => {
    const cwd = runFolder();
    fs.mkdirSync(path.join(cwd, 'library-bruno'));
    fs.writeFileSync(path.join(cwd, 'library-bruno', 'mergeReport.js'), 'console.log("merged " + process.argv[2]);');
    const res = await runRemote({ kind: 'merge', args: ['ENV_NAME'], cwd, env: {} });
    expect(res.code).toBe(0);
    expect(res.out.trim()).toBe('merged ENV_NAME');
  });

  test('kill: the agent stops the process and says how it ended', async () => {
    const cwd = runFolder();
    const proc = new RemoteProcess({ host: '127.0.0.1', port, token: TOKEN }, { kind: 'bru', args: ['sleep'], cwd, env: {} });
    let pid = 0;
    proc.stdout.on('data', (c) => { const m = /pid=(\d+)/.exec(c.toString()); if (m) pid = Number(m[1]); });
    const closed = new Promise((resolve) => proc.on('close', resolve));
    expect(await until(() => pid > 0)).toBe(true);
    expect(proc.kill('SIGTERM')).toBe(true);
    expect(await closed).toBeNull();
    expect(await until(() => !alive(pid))).toBe(true);
    expect(proc.kill('SIGTERM')).toBe(false);
  });

  test('a connection that drops stops its process', async () => {
    const cwd = runFolder();
    const proc = new RemoteProcess({ host: '127.0.0.1', port, token: TOKEN }, { kind: 'bru', args: ['sleep'], cwd, env: {} });
    proc.on('error', () => {});
    let pid = 0;
    proc.stdout.on('data', (c) => { const m = /pid=(\d+)/.exec(c.toString()); if (m) pid = Number(m[1]); });
    expect(await until(() => pid > 0)).toBe(true);
    proc._socket.destroy();
    expect(await until(() => !alive(pid))).toBe(true);
  });
});

describe('the agent refuses', () => {
  test('a wrong token', async () => {
    const res = await runRemote({ kind: 'bru', args: [], cwd: runFolder(), env: {} }, 'b'.repeat(40));
    expect(res.error).toBe('the runner agent refused: not authorised');
  });

  test('a kind that is not one of the two, such as a path', async () => {
    const res = await runRemote({ kind: '/bin/sh', args: ['-c', 'id'], cwd: runFolder(), env: {} });
    expect(res.error).toBe('the runner agent refused: unknown kind');
  });

  test('a folder that is not a run folder of the volume', async () => {
    for (const cwd of [outside, workspaces, path.join(workspaces, 'not-a-run'), path.join(workspaces, randomUUID())]) {
      const res = await runRemote({ kind: 'bru', args: [], cwd, env: {} });
      expect(res.error).toBe('the runner agent refused: not a run folder');
    }
  });

  test('a run folder that is a link to somewhere else', async () => {
    const link = path.join(workspaces, randomUUID());
    fs.symlinkSync(outside, link);
    const res = await runRemote({ kind: 'bru', args: [], cwd: link, env: {} });
    expect(res.error).toBe('the runner agent refused: not a run folder');
  });

  test('anything that is not one request line', async () => {
    const answer = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('not json\n'));
      let got = '';
      s.on('data', (c) => { got += c; });
      s.on('close', () => resolve(got));
    });
    expect(JSON.parse(answer.trim())).toEqual({ t: 'refused', reason: 'not JSON' });
  });
});

describe('the agent will not start next to the server\'s secrets', () => {
  const ok = { RUN_AGENT_TOKEN: TOKEN, RUN_WORKSPACES_DIR: '/run/w' };
  test.each([
    [{ ...ok, RUN_AGENT_TOKEN: 'short' }, /RUN_AGENT_TOKEN is missing or shorter than 32/],
    [{ RUN_AGENT_TOKEN: TOKEN }, /RUN_WORKSPACES_DIR is not set/],
    [{ ...ok, ENCRYPTION_KEY: 'k', JWT_SECRET: 'j' }, /can see the server's ENCRYPTION_KEY, JWT_SECRET/],
  ])('%#', (env, problem) => {
    expect(startupProblem(env, () => false)).toMatch(problem);
  });
  test('nor where it can see the database', () => {
    expect(startupProblem(ok, (p) => p === '/app/data/oscar.db')).toMatch(/can see the server's database \(\/app\/data\/oscar\.db\)/);
    expect(startupProblem(ok, () => false)).toBeNull();
  });
});

describe('the server\'s launcher in isolated mode', () => {
  const saved = {};
  const keys = ['RUN_ISOLATION', 'RUN_AGENT_TOKEN', 'RUN_AGENT_PORT', 'RUN_AGENT_HOST', 'RUN_WORKSPACES_DIR'];
  beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('says what is missing; then starts bru through the agent, with the run\'s credentials only', async () => {
    const L = require('../../src/worker/launcher');
    process.env.RUN_ISOLATION = 'isolated';
    delete process.env.RUN_AGENT_TOKEN;
    expect(L.launcherProblem()).toMatch(/RUN_AGENT_TOKEN is missing/);
    process.env.RUN_AGENT_TOKEN = TOKEN;
    delete process.env.RUN_WORKSPACES_DIR;
    expect(L.launcherProblem()).toMatch(/RUN_WORKSPACES_DIR is not set/);
    process.env.RUN_WORKSPACES_DIR = workspaces;
    process.env.RUN_AGENT_PORT = String(port);
    process.env.RUN_AGENT_HOST = '127.0.0.1';
    expect(L.launcherProblem()).toBeNull();

    const cwd = runFolder();
    const proc = L.launch('bru', { args: ['exit'], cwd, env: { OSCAR_RUN_SECRET: 's', PATH: '/nowhere', SENT_BY_SERVER: 'x' } });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    const code = await new Promise((resolve, reject) => { proc.on('close', resolve); proc.on('error', reject); });
    expect(code).toBe(3);
    expect(out).toContain('secret=s');
    expect(out).toContain('other=none');
  });
});

describe('protocol', () => {
  test('a line longer than allowed stops the reader', () => {
    const lines = [];
    let tooLong = 0;
    const read = P.lineReader((l) => lines.push(l), () => { tooLong++; }, 10);
    read(Buffer.from('short\n'));
    read(Buffer.from('x'.repeat(11)));
    read(Buffer.from('\nafter\n'));
    expect(lines).toEqual(['short']);
    expect(tooLong).toBe(1);
  });
  test('kill messages: the two signals only', () => {
    expect(P.killSignalOf({ t: 'kill', signal: 'SIGKILL' })).toBe('SIGKILL');
    expect(P.killSignalOf({ t: 'kill', signal: 'SIGSTOP' })).toBeNull();
  });
});
