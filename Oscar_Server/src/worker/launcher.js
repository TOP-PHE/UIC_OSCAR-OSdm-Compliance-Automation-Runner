// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Where a run's processes are started (option 2b of the run isolation study).
 *
 * The runner starts two kinds of process for a run: the Bruno CLI (`bru`) and
 * the collection's report merger (`merge`, library-bruno/mergeReport.js). It
 * asks this module for one by KIND, never by path: the isolated mode hands the
 * request to a runner agent in another container, and an agent that ran any
 * path it was given would be a remote shell.
 *
 * RUN_ISOLATION:
 *   - `local` (default): a child process of the server, as before.
 *   - `isolated`: the runner agent (runner-agent/agent.js) starts it in its
 *     own container, which holds none of the server's secrets or data. The
 *     server reaches it at RUN_AGENT_HOST:RUN_AGENT_PORT (default
 *     127.0.0.1:3002) with RUN_AGENT_TOKEN.
 *
 * Whatever the mode, launch() returns an object that behaves like a
 * ChildProcess for what the runner uses: `stdout`/`stderr` 'data' events,
 * 'close' (code) and 'error' events, and kill(signal).
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const { RUN_ENV_KEYS } = require('./childEnv');

const MIN_TOKEN_LENGTH = 32;
// Loaded when first used: the agent's module needs this one's launchLocal().
let RemoteProcess;

const MODES = Object.freeze(['local', 'isolated']);
const KINDS = Object.freeze(['bru', 'merge']);

/** The configured mode, as written (trimmed, lower case; empty = local). */
function isolationMode() {
  return String(process.env.RUN_ISOLATION || 'local').trim().toLowerCase() || 'local';
}

/** Where the runner agent listens, and its token (isolated mode). */
function agentSettings() {
  return {
    host: process.env.RUN_AGENT_HOST || '127.0.0.1',
    port: Number.parseInt(process.env.RUN_AGENT_PORT || '3002', 10),
    token: process.env.RUN_AGENT_TOKEN || '',
  };
}

/** Why runs cannot start in the configured mode, or null. */
function launcherProblem() {
  const mode = isolationMode();
  if (mode === 'isolated') {
    const { port, token } = agentSettings();
    if (token.length < MIN_TOKEN_LENGTH) return `RUN_ISOLATION is "isolated" but RUN_AGENT_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters: no run is started. Ask the administrator to correct the server's settings.`;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'RUN_ISOLATION is "isolated" but RUN_AGENT_PORT is not a port: no run is started. Ask the administrator to correct the server\'s settings.';
    if (!process.env.RUN_WORKSPACES_DIR) return 'RUN_ISOLATION is "isolated" but RUN_WORKSPACES_DIR is not set: the runner agent needs the runs\' working folders. No run is started.';
    return null;
  }
  if (MODES.includes(mode)) return null;
  return `RUN_ISOLATION="${mode.slice(0, 40)}" is not a mode this server knows (${MODES.join(', ')}): no run is started. Ask the administrator to correct the server's settings.`;
}

// The Bruno CLI. A Windows batch wrapper (.cmd / .bat) needs a shell; any
// other file is started directly, so arguments are never re-read by sh -c.
function bruCommand() {
  return process.env.BRU_CMD || 'bru.cmd';
}

/**
 * Starts a process of `kind` for a run, in the configured mode.
 * @param {'bru'|'merge'} kind
 * @param {{ args: string[], cwd: string, env: object }} opts
 */
function launch(kind, { args, cwd, env }) {
  if (!KINDS.includes(kind)) throw new Error(`launcher: unknown kind "${kind}"`);
  const problem = launcherProblem();
  if (problem) throw new Error(problem);
  if (isolationMode() === 'isolated') {
    // Only the run's own credentials travel; the agent adds its own PATH/HOME.
    const runEnv = {};
    for (const key of RUN_ENV_KEYS) if (env?.[key] !== undefined) runEnv[key] = env[key];
    RemoteProcess ??= require('./remoteProcess').RemoteProcess;
    return new RemoteProcess(agentSettings(), { kind, args, cwd, env: runEnv });
  }
  return launchLocal(kind, { args, cwd, env });
}

/** Starts a process of `kind` here, as a child process (the agent uses it too). */
function launchLocal(kind, { args, cwd, env }) {
  if (!KINDS.includes(kind)) throw new Error(`launcher: unknown kind "${kind}"`);
  if (kind === 'bru') {
    const bru = bruCommand();
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bru);
    return spawn(bru, args, { cwd, shell: needsShell, env });
  }
  // merge: the collection's own script, from the run's working folder.
  const script = path.join(cwd, 'library-bruno', 'mergeReport.js');
  return spawn(process.execPath, [script, ...args], { cwd, shell: false, env });
}

module.exports = { launch, launchLocal, launcherProblem, isolationMode, agentSettings, MODES, KINDS };
