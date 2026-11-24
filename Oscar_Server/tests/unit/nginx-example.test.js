// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * nginx-example.test.js — the nginx site of the example and of the guides
 * (#1426): nginx names no version, and the security headers are OSCAR's, so
 * the proxy adds none and hides none. The CI job "nginx example (the VPS's
 * proxy)" checks the same under a real nginx.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../../..');
const read = rel => fs.readFileSync(path.join(REPO, rel), 'utf8').replaceAll('\r\n', '\n');
const SECURITY_HEADERS = /(content-security-policy|strict-transport-security|x-frame-options|x-content-type-options|referrer-policy|permissions-policy|cross-origin-[a-z-]+)/i;

/** The nginx configuration a guide shows: its fenced blocks that hold a server { … }. */
function nginxBlocksOf(markdown) {
  return [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]).filter(b => /^\s*server\s*\{/m.test(b));
}

describe('the nginx example', () => {
  const example = read('OSCAR_Deploy/nginx/oscar.conf.example');

  test('names no nginx version: server_tokens off in its server block', () => {
    const server = example.slice(example.indexOf('server {'));
    expect(server).toMatch(/^\s*server_tokens off;/m);
  });

  test('adds no security header and hides none of OSCAR\'s', () => {
    const lines = example.split('\n').filter(l => !l.trim().startsWith('#'));
    const touching = lines.filter(l => /\b(add_header|proxy_hide_header|more_set_headers|more_clear_headers)\b/.test(l) && SECURITY_HEADERS.test(l));
    expect(touching).toEqual([]);
  });

  test('the CI job checks both under a real nginx', () => {
    const job = read('.github/workflows/ci-kubernetes.yml');
    expect(job).toContain('No nginx version, no security header of the proxy\'s own (#1426)');
    expect(job).toContain('test "$server" = nginx');
  });
});

describe.each([
  ['installation-guide.md', 'Documentation/Server_Operations/installation-guide.md'],
  ['the Self-Hosted Quick Start', 'Documentation/Server_Operations/OSCAR - Self-Hosted Quick Start.md'],
])('the nginx site of %s', (_name, file) => {
  const blocks = nginxBlocksOf(read(file));

  test('turns server_tokens off in every server block', () => {
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const servers = block.split(/^\s*server\s*\{/m).slice(1);
      for (const server of servers) expect(server).toMatch(/^\s*server_tokens off;/m);
    }
  });

  test('adds no security header and hides none', () => {
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => !l.trim().startsWith('#'));
      expect(lines.filter(l => /\b(add_header|proxy_hide_header)\b/.test(l) && SECURITY_HEADERS.test(l))).toEqual([]);
    }
  });
});
