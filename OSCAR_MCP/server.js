#!/usr/bin/env node
// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * server.js — the OSCAR MCP server (#503 PR 3), over stdio.
 *
 * An MCP client (Claude Desktop, Claude Code, another assistant) starts it
 * with OSCAR_URL and OSCAR_API_KEY in its environment. It reads one JSON-RPC
 * message per line on stdin and writes each answer as one line on stdout;
 * stdout carries nothing else. Its few messages go to stderr, without the key.
 */

const readline = require('node:readline');
const { configFrom } = require('./src/config');
const { getFromOscar } = require('./src/client');
const { handleLine } = require('./src/protocol');

const config = configFrom(process.env);
if (config.errors) {
  for (const e of config.errors) process.stderr.write(`oscar-mcp: ${e}\n`);
  process.exit(2);
}

const call = (path) => getFromOscar(config, path);
const send = (answer) => process.stdout.write(`${JSON.stringify(answer)}\n`);

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = 0;
let closed = false;
const finish = () => { if (closed && pending === 0) process.exit(0); };

lines.on('line', (line) => {
  if (line.trim() === '') return;
  pending += 1;
  handleLine(line, call)
    .then((answer) => { if (answer) send(answer); })
    .catch(() => process.stderr.write('oscar-mcp: a message could not be answered.\n'))
    .finally(() => { pending -= 1; finish(); });
});
lines.on('close', () => { closed = true; finish(); });
