// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * A process the runner agent starts for the server (RUN_ISOLATION=isolated),
 * seen as the runner sees a child process: `stdout` / `stderr` emit 'data'
 * (Buffers), the object emits 'close' (code) once, or 'error' when the agent
 * refuses or cannot be reached, and kill(signal) asks the agent to stop it.
 * The protocol is runner-agent/protocol.js.
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');
const P = require('../runner-agent/protocol');

class RemoteProcess extends EventEmitter {
  /**
   * @param {{ host: string, port: number, token: string }} agent
   * @param {object} request  { kind, args, cwd, env } for the runner agent, or
   *   a whole run for the run dispatcher ({ kind: 'run', runId, envName, ... })
   */
  constructor(agent, request) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this._done = false;
    this._socket = net.connect(agent.port, agent.host, () => {
      this._socket.write(P.line({ v: P.VERSION, token: agent.token, ...request }));
    });
    this._socket.on('data', P.lineReader((text) => this._onLine(text), () => this._fail('the runner agent sent a line too long')));
    this._socket.on('error', (err) => this._fail(`the runner agent could not be reached (${err.code || err.message})`));
    this._socket.on('close', () => this._fail('the runner agent closed the connection before the process ended'));
  }

  _onLine(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return this._fail('the runner agent sent something that is not JSON'); }
    if (msg?.t === 'out' && typeof msg.d === 'string') this.stdout.emit('data', Buffer.from(msg.d, 'utf8'));
    else if (msg?.t === 'err' && typeof msg.d === 'string') this.stderr.emit('data', Buffer.from(msg.d, 'utf8'));
    else if (msg?.t === 'exit') this._finish(Number.isInteger(msg.code) ? msg.code : null);
    else if (msg?.t === 'pod' && typeof msg.address === 'string') this.emit('pod', msg.address.slice(0, 64));
    else if (msg?.t === 'refused') this._fail(`the runner agent refused: ${String(msg.reason || '').slice(0, 200)}`);
    return undefined;
  }

  _finish(code) {
    if (this._done) return;
    this._done = true;
    this.exitCode = code;
    this._socket.end();
    this.emit('close', code);
  }

  _fail(message) {
    if (this._done) return;
    this._done = true;
    this._socket.destroy();
    this.emit('error', new Error(message));
  }

  /** Asks the agent to stop the process. Returns false once it has ended. */
  kill(signal = 'SIGTERM') {
    if (this._done || this._socket.destroyed) return false;
    this._socket.write(P.line({ t: 'kill', signal: P.SIGNALS.includes(signal) ? signal : 'SIGTERM' }));
    return true;
  }
}

module.exports = { RemoteProcess };
