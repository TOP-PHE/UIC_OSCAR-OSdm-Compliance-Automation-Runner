// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * deploy-by-digest.test.js — production runs the image digest the
 * promotion built:
 *  - docker-compose.yml names the server image by OSCAR_IMAGE_DIGEST only,
 *    every other image by a digest too, and has no auto-update agent;
 *  - promote-release.yml sends the digest its build gave to the VPS's
 *    forced command, and reads back the line the script writes on success;
 *  - refresh-collection.sh itself, run on a real git checkout with a stub
 *    docker (Linux; skipped on Windows like backup-status.test.js): what it
 *    accepts from the caller, what it refuses before anything moves, the
 *    .env line, the compose call made from the running server's own files,
 *    and the health wait.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'OSCAR_Deploy', 'scripts', 'refresh-collection.sh');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const INSTALLED = '/usr/local/sbin/oscar-refresh-collection';
const IMAGE = 'ghcr.io/top-phe/oscar-server';
const DIGEST_VAR = '${OSCAR_IMAGE_DIGEST:?';
const D_OLD = 'sha256:' + 'a'.repeat(64);
const D_NEW = 'sha256:' + '0123456789abcdef'.repeat(4);

describe('docker-compose.yml', () => {
  const compose = yaml.load(read('OSCAR_Deploy/docker-compose.yml'));
  const services = Object.entries(compose.services);

  test('the server and its runner name the image by the digest in .env, nothing else', () => {
    const ours = services.filter(([, s]) => String(s.image).startsWith(IMAGE));
    expect(ours.map(([name]) => name).sort()).toEqual(['oscar', 'oscar-runner']);
    for (const [, s] of ours) {
      expect(s.image.startsWith(`${IMAGE}@${DIGEST_VAR}`)).toBe(true);
    }
  });

  test('every other image is pinned by a digest', () => {
    for (const [name, s] of services) {
      if (String(s.image).startsWith(IMAGE)) continue;
      expect([name, /@sha256:[0-9a-f]{64}$/.test(s.image)]).toEqual([name, true]);
    }
  });

  test('no auto-update agent and no label asking for one', () => {
    const text = read('OSCAR_Deploy/docker-compose.yml');
    expect(compose.services.watchtower).toBeUndefined();
    expect(text).not.toMatch(/com\.centurylinklabs\.watchtower/);
    expect(text).not.toMatch(/oscar-server:stable/);
  });

  test('.env.example names the digest, empty', () => {
    expect(read('OSCAR_Deploy/.env.example')).toMatch(/^OSCAR_IMAGE_DIGEST=$/m);
  });
});

describe('promote-release.yml', () => {
  const wf = yaml.load(read('.github/workflows/promote-release.yml'));
  const steps = wf.jobs.promote.steps;
  const build = steps.find((s) => s.id === 'build');
  const deploy = steps.find((s) => s.id === 'deploy');

  test('the job stays behind the production environment', () => {
    expect(wf.jobs.promote.environment).toBe('production');
  });

  test('the deploy step sends the digest its build gave, through the environment', () => {
    expect(build.uses).toMatch(/^docker\/build-push-action@[0-9a-f]{40}/);
    expect(deploy.env.DIGEST).toBe('${{ steps.build.outputs.digest }}');
    expect(deploy.run).not.toMatch(/\$\{\{/);
    expect(deploy.run).toContain(`"${INSTALLED} $DIGEST"`);
    expect(deploy.run).toMatch(/\^sha256:\[0-9a-f\]\{64\}\$/);
  });

  test('it reads back the line the script writes once the server is healthy on that image', () => {
    expect(deploy.run).toContain(`deployed ${IMAGE}@$DIGEST`);
    expect(fs.readFileSync(SCRIPT, 'utf8')).toContain('log "deployed $IMAGE@$DIGEST: oscar is healthy');
  });

  test('production-smoke.yml still follows the workflow by its name', () => {
    const smoke = yaml.load(read('.github/workflows/production-smoke.yml'));
    expect(smoke.on.workflow_run.workflows).toEqual([wf.name]);
  });
});

// ── The script, run ────────────────────────────────────────────────────────
// OSCAR_TEST_BASH=1 runs them on Windows too, under Git Bash.
const hasBash = (process.platform !== 'win32' || process.env.OSCAR_TEST_BASH === '1')
  && spawnSync('bash', ['-c', 'command -v git && command -v cmp && readlink -f /'], { encoding: 'utf8' }).status === 0;
const bashTest = hasBash ? test : test.skip;

const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/docker.log"
state="$STUB_DIR/running"
case "$1" in
  info) exit "\${DOCKER_INFO_EXIT:-0}" ;;
  pull) [ "\${PULL_FAILS:-0}" = 1 ] && exit 1; exit 0 ;;
  image) ref="\${!#}"; printf 'id-%s\\n' "\${ref#*@}"; exit 0 ;;
  compose)
    [ "\${COMPOSE_FAILS:-0}" = 1 ] && exit 1
    d=$(grep -E '^OSCAR_IMAGE_DIGEST=' "$STUB_ENV_FILE" | tail -n 1 | cut -d= -f2-)
    printf 'id-%s\\n' "$d" > "$state"; exit 0 ;;
  inspect)
    shift; target=""; fmt=""
    while [ $# -gt 0 ]; do case "$1" in --format) fmt="$2"; shift 2 ;; *) target="$1"; shift ;; esac; done
    if [ "$target" = oscar-runner ]; then [ "\${RUNNER:-0}" = 1 ] && exit 0; exit 1; fi
    case "$fmt" in
      *config_files*) printf '%s\\n' "$STUB_CONFIG_FILES" ;;
      *compose.project*) printf 'oscar_deploy\\n' ;;
      '{{.Image}}') cat "$state" 2>/dev/null || echo id-old ;;
      *Health*) printf '%s\\n' "\${HEALTH:-healthy}" ;;
      *) exit 1 ;;
    esac ;;
  *) exit 1 ;;
esac
`;

describe('refresh-collection.sh', () => {
  let root; let repo; let seed; let bin; let envFile; let files;
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = () => git(repo, 'rev-parse', 'HEAD');
  const dockerCalls = () => (fs.existsSync(path.join(root, 'docker.log')) ? fs.readFileSync(path.join(root, 'docker.log'), 'utf8').trim().split('\n') : []);

  function commitAndTag(tag, content) {
    fs.writeFileSync(path.join(seed, 'OSCAR_Deploy', 'version.txt'), content);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', tag);
    git(seed, 'tag', tag);
    git(seed, 'push', '-q', 'origin', 'main', '--tags');
  }

  beforeEach(() => {
    if (!hasBash) return;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-deploy-'));
    repo = path.join(root, 'repo');
    seed = path.join(root, 'seed');
    bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'logger'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    git(root, 'init', '-q', '--bare', 'origin.git');
    git(root, 'clone', '-q', 'origin.git', 'seed');
    fs.mkdirSync(path.join(seed, 'OSCAR_Deploy'));
    fs.writeFileSync(path.join(seed, '.gitignore'), '.env\n');
    fs.writeFileSync(path.join(seed, 'OSCAR_Deploy', 'docker-compose.yml'), 'services: {}\n');
    fs.writeFileSync(path.join(seed, 'OSCAR_Deploy', 'docker-compose.metrics.yml'), 'services: {}\n');
    commitAndTag('release-2026.001', 'one');
    git(root, 'clone', '-q', 'origin.git', 'repo');
    envFile = path.join(repo, 'OSCAR_Deploy', '.env');
    fs.writeFileSync(envFile, `ENCRYPTION_KEY=x\nOSCAR_IMAGE_DIGEST=${D_OLD}\nOSCAR_TZ=Europe/Paris\n`);
    files = [path.join(repo, 'OSCAR_Deploy', 'docker-compose.yml'), path.join(repo, 'OSCAR_Deploy', 'docker-compose.metrics.yml')];
    commitAndTag('release-2026.002', 'two');
  });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function run(request, extraEnv = {}) {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        OSCAR_REPO: repo,
        OSCAR_HEALTH_WAIT_SECONDS: '2',
        OSCAR_HEALTH_POLL_SECONDS: '0',
        STUB_DIR: root,
        STUB_ENV_FILE: envFile,
        STUB_CONFIG_FILES: files.join(','),
        ...(request === undefined ? {} : { SSH_ORIGINAL_COMMAND: request }),
        ...extraEnv,
      },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  bashTest('the path alone, as before: the checkout moves, no image is touched', () => {
    const before = head();
    const r = run(INSTALLED);
    expect(r.code).toBe(0);
    expect(head()).not.toBe(before);
    expect(git(repo, 'describe', '--tags')).toBe('release-2026.002');
    expect(dockerCalls()).toEqual([]);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`OSCAR_IMAGE_DIGEST=${D_OLD}\n`);
  });

  bashTest('a digest: pulled by digest, written in .env, the server made again from its own files, healthy', () => {
    const r = run(`${INSTALLED} ${D_NEW}`);
    expect(r.out).toContain(`deployed ${IMAGE}@${D_NEW}: oscar is healthy`);
    expect(r.code).toBe(0);
    expect(git(repo, 'describe', '--tags')).toBe('release-2026.002');
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`ENCRYPTION_KEY=x\nOSCAR_IMAGE_DIGEST=${D_NEW}\nOSCAR_TZ=Europe/Paris\n`);
    const calls = dockerCalls();
    expect(calls).toContain(`pull --quiet ${IMAGE}@${D_NEW}`);
    expect(calls).toContain(`compose -p oscar_deploy -f ${files[0]} -f ${files[1]} up -d --no-deps oscar`);
    expect(calls.findIndex((c) => c.startsWith('pull'))).toBeLessThan(calls.findIndex((c) => c.startsWith('compose')));
  });

  bashTest('a digest alone, as typed by hand, works too; so does the runner agent when it runs', () => {
    const r = spawnSync('bash', [SCRIPT, D_NEW], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OSCAR_REPO: repo, OSCAR_HEALTH_WAIT_SECONDS: '2', OSCAR_HEALTH_POLL_SECONDS: '0', STUB_DIR: root, STUB_ENV_FILE: envFile, STUB_CONFIG_FILES: files.join(','), RUNNER: '1' },
    });
    expect(r.status).toBe(0);
    expect(dockerCalls()).toContain(`compose -p oscar_deploy -f ${files[0]} -f ${files[1]} up -d --no-deps oscar oscar-runner`);
  });

  bashTest('anything else is refused before anything moves', () => {
    const before = head();
    const refused = [
      'bash',
      `${INSTALLED} ${D_NEW}; id`,
      `${INSTALLED} ${D_NEW} ${D_NEW}`,
      `${INSTALLED} ${D_NEW.toUpperCase()}`,
      `${INSTALLED} sha256:${'0'.repeat(63)}`,
      `${INSTALLED} $(id)`,
      `/tmp/other ${D_NEW}`,
      `${D_NEW}\nid`,
    ];
    for (const request of refused) {
      const r = run(request);
      expect([request, r.code]).toEqual([request, 2]);
      expect(r.out).toContain('the request is not an image digest');
      expect(r.out).not.toContain(request);
    }
    expect(head()).toBe(before);
    expect(dockerCalls()).toEqual([]);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`OSCAR_IMAGE_DIGEST=${D_OLD}\n`);
  });

  bashTest('a pull that fails changes nothing in .env and starts nothing', () => {
    const r = run(`${INSTALLED} ${D_NEW}`, { PULL_FAILS: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('docker pull');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`OSCAR_IMAGE_DIGEST=${D_OLD}\n`);
    expect(dockerCalls().some((c) => c.startsWith('compose'))).toBe(false);
  });

  bashTest('a compose that fails puts the previous digest back', () => {
    const r = run(`${INSTALLED} ${D_NEW}`, { COMPOSE_FAILS: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`names the previous image again (${D_OLD})`);
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`OSCAR_IMAGE_DIGEST=${D_OLD}\n`);
  });

  bashTest('a server that does not become healthy fails the deployment', () => {
    const r = run(`${INSTALLED} ${D_NEW}`, { HEALTH: 'unhealthy' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('is not healthy after 2 s (unhealthy)');
    expect(r.out).not.toContain('deployed ');
  });

  bashTest('an .env without the line, nor a last line break, gets it on a line of its own', () => {
    fs.writeFileSync(envFile, 'ENCRYPTION_KEY=x\nOSCAR_TZ=Europe/Paris');
    const r = run(`${INSTALLED} ${D_NEW}`);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`ENCRYPTION_KEY=x\nOSCAR_TZ=Europe/Paris\nOSCAR_IMAGE_DIGEST=${D_NEW}\n`);
    expect(r.out).toContain('(before: none)');
  });

  bashTest('without docker for this user nor sudo, nothing is deployed and the log says why', () => {
    const r = run(`${INSTALLED} ${D_NEW}`, { DOCKER_INFO_EXIT: '1' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('nor sudo without a password');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`OSCAR_IMAGE_DIGEST=${D_OLD}\n`);
  });
});
