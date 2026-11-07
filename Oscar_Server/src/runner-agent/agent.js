// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The runner agent (run isolation, option 2b). Runs in a container of its own,
 * next to the server (same pod, or `network_mode: service:oscar`), with the
 * runs' working folders and the collection, and NOTHING of the server: no
 * data folder, no database, no ENCRYPTION_KEY, no JWT secret. It starts the
 * two kinds of process a run needs (worker/launcher.js) when the server asks,
 * and streams their output back.
 *
 * Settings (environment):
 *   RUN_AGENT_TOKEN        the secret the server sends (32 characters or more)
 *   RUN_WORKSPACES_DIR     the runs' working folders (shared with the server)
 *   RUN_AGENT_HOST/PORT    where to listen (default 127.0.0.1:3002)
 *   RUN_AGENT_MAX_PROCESSES  at most this many processes at once (default 60)
 *   BRU_CMD                the Bruno CLI
 *
 * It refuses to start while it can see any of the server's secrets or its
 * database (startupProblem()): that is what makes it an isolation, so a
 * deployment that mounts too much is told at once.
 */

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const P = require('./protocol');
const { launchLocal } = require('../worker/launcher');
const { childBaseEnv } = require('../worker/childEnv');

// What the agent must never hold: the server's secrets, and its database.
const SERVER_SECRETS = Object.freeze(['ENCRYPTION_KEY', 'JWT_SECRET', 'SMTP_PASS', 'METRICS_TOKEN', 'BOOTSTRAP_TOKEN']);
const SERVER_DATABASES = Object.freeze(['/app/data/oscar.db']);

/** Why the agent may not start with these settings, or null. */
function startupProblem(env = process.env, exists = fs.existsSync) {
  if (typeof env.RUN_AGENT_TOKEN !== 'string' || env.RUN_AGENT_TOKEN.length < P.MIN_TOKEN_LENGTH) {
    return `RUN_AGENT_TOKEN is missing or shorter than ${P.MIN_TOKEN_LENGTH} characters.`;
  }
  if (!env.RUN_WORKSPACES_DIR) return 'RUN_WORKSPACES_DIR is not set: the agent needs the runs\' working folders.';
  const held = SERVER_SECRETS.filter((k) => env[k] !== undefined && env[k] !== '');
  if (held.length > 0) return `The agent can see the server's ${held.join(', ')}: give it none of the server's settings.`;
  const databases = [env.OSCAR_DB_PATH, ...SERVER_DATABASES].filter(Boolean);
  const seen = databases.find((p) => exists(p));
  if (seen) return `The agent can see the server's database (${seen}): do not mount the data folder in its container.`;
  return null;
}

/**
 * Creates the agent's server (not listening yet).
 * @param {{ token: string, workspacesDir: string, maxProcesses?: number, log?: object }} options
 */
function createAgent({ token, workspacesDir, maxProcesses = 60, log = console }) {
  const running = new Set();

  return net.createServer((socket) => {
    let child = null;
    let ended = false;
    const send = (msg) => { if (!socket.destroyed && !socket.writableEnded) socket.write(P.line(msg)); };
    const refuse = (reason) => { send({ t: 'refused', reason }); socket.end(); ended = true; };
    const stop = (signal) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill(signal); } catch { /* already gone */ }
    };

    socket.on('data', P.lineReader((text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return refuse('not JSON'); }
      if (child) {
        const signal = P.killSignalOf(msg);
        if (signal) stop(signal);
        return undefined;
      }
      if (ended) return undefined;
      return start(msg);
    }, () => refuse('line too long')));

    function start(msg) {
      const checked = P.checkRequest(msg, { token, workspacesDir });
      if (!checked.request) return refuse(checked.reason);
      const { kind, args, cwd, env } = checked.request;
      // The folder must exist, as itself: no symbolic link out of the volume.
      let real = null;
      try { real = fs.realpathSync(cwd); } catch { real = null; }
      if (real !== cwd || !fs.statSync(cwd).isDirectory()) return refuse('not a run folder');
      if (running.size >= maxProcesses) return refuse('too many processes');
      try {
        child = launchLocal(kind, { args, cwd, env: { ...childBaseEnv(), ...env } });
      } catch (err) {
        return refuse(`could not start: ${String(err.message).slice(0, 200)}`);
      }
      running.add(child);
      send({ t: 'started' });
      child.stdout.on('data', (c) => send({ t: 'out', d: c.toString('utf8') }));
      child.stderr.on('data', (c) => send({ t: 'err', d: c.toString('utf8') }));
      child.on('error', (err) => {
        running.delete(child);
        send({ t: 'refused', reason: `process error: ${String(err.message).slice(0, 200)}` });
        socket.end();
      });
      child.on('close', (code, signal) => {
        running.delete(child);
        send({ t: 'exit', code, signal });
        socket.end();
      });
      log.info?.(`[runner-agent] started ${kind} in ${path.basename(cwd)}`);
      return undefined;
    }

    // The server went away: the process does not outlive its connection.
    socket.on('close', () => {
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 3000).unref();
    });
    socket.on('error', () => { /* 'close' follows */ });
  });
}

/* istanbul ignore next: the process entry point */
if (require.main === module) {
  const problem = startupProblem();
  if (problem) {
    console.error(`[runner-agent] Not started: ${problem}`);
    process.exit(1);
  }
  const host = process.env.RUN_AGENT_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.RUN_AGENT_PORT || '3002', 10);
  const maxProcesses = Number.parseInt(process.env.RUN_AGENT_MAX_PROCESSES || '60', 10) || 60;
  createAgent({ token: process.env.RUN_AGENT_TOKEN, workspacesDir: path.resolve(process.env.RUN_WORKSPACES_DIR), maxProcesses })
    .listen(port, host, () => console.log(`[runner-agent] listening on ${host}:${port}`));
}

module.exports = { createAgent, startupProblem, SERVER_SECRETS };
