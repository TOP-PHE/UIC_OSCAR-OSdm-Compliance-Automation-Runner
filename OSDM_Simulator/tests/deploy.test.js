// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// The simulator's container: named by digest, the same base image as OSCAR's
// Dockerfile (#545), and started without privileges.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const COMPOSE = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'docker-compose.yml'), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(__dirname, '..', '..', 'Oscar_Server', 'Dockerfile'), 'utf8');

const IMAGE_LINE = /^\s*image:\s*(node:22-slim@sha256:[0-9a-f]{64})\s*$/gm;
const FROM_LINE = /^FROM\s+(node:22-slim@sha256:[0-9a-f]{64})\b/gm;
const digestsOf = (text, line) => [...text.matchAll(line)].map(m => m[1]);

test('the image is named by digest, the digest of OSCAR\'s Dockerfile', () => {
  const simulator = digestsOf(COMPOSE, IMAGE_LINE);
  const oscar = new Set(digestsOf(DOCKERFILE, FROM_LINE));
  assert.equal(simulator.length, 1, 'one image line with a digest');
  assert.equal(oscar.size, 1, 'both FROM lines of the Dockerfile name one digest');
  assert.equal(simulator[0], [...oscar][0]);
});

test('the container runs unprivileged, read-only, on the loopback port only', () => {
  assert.match(COMPOSE, /^\s*user: "1000:1000"$/m);
  assert.match(COMPOSE, /^\s*read_only: true$/m);
  assert.match(COMPOSE, /^\s*cap_drop:\n\s*- ALL$/m);
  assert.match(COMPOSE, /^\s*- no-new-privileges:true$/m);
  assert.match(COMPOSE, /^\s*- "127\.0\.0\.1:3002:3002"$/m);
});
