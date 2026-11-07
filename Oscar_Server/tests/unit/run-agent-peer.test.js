// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * run-agent-peer.test.js — with the runner agent in a container of its own,
 * its address counts as "from this machine" for the run's loopback calls,
 * and nothing else does; Bruno is told where the server is.
 */

const P = require('../../src/utils/runAgentPeer');

const keys = ['RUN_ISOLATION', 'RUN_AGENT_HOST', 'RUN_SERVER_URL', 'JSON_SCHEMA_URL', 'PORT'];
const saved = {};
beforeEach(() => { for (const k of keys) saved[k] = process.env[k]; });
afterEach(async () => {
  for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await P.refreshRunAgentPeer();
});

describe('the runner agent\'s address', () => {
  test('counts only in isolated mode with the agent on another host, as it resolves now', async () => {
    process.env.RUN_ISOLATION = 'isolated';
    process.env.RUN_AGENT_HOST = 'oscar-runner';
    const lookup = jest.fn(async () => [{ address: '172.18.0.7', family: 4 }]);
    await P.refreshRunAgentPeer(lookup);
    expect(lookup).toHaveBeenCalledWith('oscar-runner', { all: true });
    expect(P.isRunAgentPeer('172.18.0.7')).toBe(true);
    expect(P.isRunAgentPeer('::ffff:172.18.0.7')).toBe(true);
    expect(P.isRunAgentPeer('172.18.0.8')).toBe(false);
    // The container was recreated with another address.
    await P.refreshRunAgentPeer(async () => [{ address: '172.18.0.9', family: 4 }]);
    expect(P.isRunAgentPeer('172.18.0.7')).toBe(false);
    expect(P.isRunAgentPeer('172.18.0.9')).toBe(true);
  });

  test('a name that does not resolve, the loopback, or local mode: no address counts', async () => {
    process.env.RUN_ISOLATION = 'isolated';
    process.env.RUN_AGENT_HOST = 'oscar-runner';
    await P.refreshRunAgentPeer(async () => { throw new Error('ENOTFOUND'); });
    expect(P.isRunAgentPeer('172.18.0.7')).toBe(false);
    process.env.RUN_AGENT_HOST = '127.0.0.1';
    expect(P.agentHost()).toBe('');
    process.env.RUN_AGENT_HOST = 'oscar-runner';
    process.env.RUN_ISOLATION = 'local';
    const lookup = jest.fn();
    await P.refreshRunAgentPeer(lookup);
    expect(lookup).not.toHaveBeenCalled();
    expect(P.isRunAgentPeer('')).toBe(false);
  });
});

describe('where Bruno reaches the server', () => {
  const { serverUrls } = require('../../src/worker/runner');
  test('the loopback by default, as before', () => {
    delete process.env.RUN_ISOLATION; delete process.env.RUN_SERVER_URL; delete process.env.JSON_SCHEMA_URL;
    process.env.PORT = '3001';
    expect(serverUrls()).toEqual({
      data: 'http://localhost:3001',
      loopback: 'http://127.0.0.1:3001',
      schema: 'http://127.0.0.1:3001/json_validator/datafile.schema.json',
    });
  });
  test('RUN_SERVER_URL in isolated mode only', () => {
    process.env.PORT = '3001';
    process.env.RUN_SERVER_URL = 'http://oscar:3001//';
    delete process.env.JSON_SCHEMA_URL;
    process.env.RUN_ISOLATION = 'local';
    expect(serverUrls().loopback).toBe('http://127.0.0.1:3001');
    process.env.RUN_ISOLATION = 'isolated';
    expect(serverUrls()).toEqual({
      data: 'http://oscar:3001',
      loopback: 'http://oscar:3001',
      schema: 'http://oscar:3001/json_validator/datafile.schema.json',
    });
  });
});
