// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * docker-socket.test.js — no container of a Docker installation mounts the
 * Docker socket (#1434):
 *  - no compose file of OSCAR_Deploy mounts it, and no autoheal service;
 *  - every service writes json-file logs naming its container and compose
 *    labels (the files' `x-logging` block), which is what Promtail reads;
 *  - Promtail reads those files, makes the labels the Logs dashboard uses,
 *    and asks no Docker API;
 *  - oscar-autoheal.sh, run with a stub docker (Linux; OSCAR_TEST_BASH=1
 *    under Git Bash): what it restarts, what it leaves, what it refuses;
 *  - oscar-autoheal-schedule.sh installs a copy outside the checkout.
 * The CI job "Docker host" of ci-kubernetes.yml runs the same on a real
 * Docker and systemd.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const DEPLOY = path.join(REPO_ROOT, 'OSCAR_Deploy');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
const COMPOSE_FILES = fs.readdirSync(DEPLOY).filter((f) => /^docker-compose.*\.ya?ml$/.test(f)).sort();

const sourceOf = (volume) => (typeof volume === 'string' ? volume.split(':')[0] : volume.source);

describe('compose files', () => {
  test('the base, metrics and secrets files are read', () => {
    expect(COMPOSE_FILES).toEqual(expect.arrayContaining([
      'docker-compose.metrics.yml', 'docker-compose.secrets.yml', 'docker-compose.yml',
    ]));
  });

  test.each(COMPOSE_FILES)('%s: no service mounts the Docker socket, not even in a comment-free line', (file) => {
    const compose = yaml.load(read(`OSCAR_Deploy/${file}`));
    for (const [name, service] of Object.entries(compose.services || {})) {
      const sources = (service.volumes || []).map(sourceOf);
      expect([name, sources.filter((s) => String(s).includes('docker.sock'))]).toEqual([name, []]);
    }
    const lines = read(`OSCAR_Deploy/${file}`).split('\n').filter((l) => !/^\s*#/.test(l));
    expect(lines.filter((l) => l.includes('docker.sock'))).toEqual([]);
  });

  test('the server and its runner: a read-only root, a tmpfs on /tmp, HOME there (#1446)', () => {
    const compose = yaml.load(read('OSCAR_Deploy/docker-compose.yml'));
    for (const name of ['oscar', 'oscar-runner']) {
      const s = compose.services[name];
      expect([name, s.read_only]).toEqual([name, true]);
      expect([name, (s.tmpfs || []).some((t) => /^\/tmp(:|$)/.test(t))]).toEqual([name, true]);
      expect([name, s.environment.HOME]).toEqual([name, '/tmp']);
      expect([name, (s.volumes || []).some((v) => String(v).startsWith('run-workspaces:/app/run-workspaces'))]).toEqual([name, true]);
    }
    expect(compose.services.oscar.volumes).toContain('./data:/app/data');
    const smoke = read('OSCAR_Deploy/kubernetes/ci/smoke.sh');
    expect(smoke).toContain('docker exec "$OSCAR_CONTAINER" "$@"');
    expect(smoke).not.toMatch(/kubectl -n "\$OSCAR_NAMESPACE" exec deploy\/oscar -- node/);
  });

  test('no autoheal service; the server and its runner keep the label the host timer reads', () => {
    const compose = yaml.load(read('OSCAR_Deploy/docker-compose.yml'));
    expect(compose.services.autoheal).toBeUndefined();
    expect(read('OSCAR_Deploy/docker-compose.yml')).not.toMatch(/willfarrell\/autoheal/);
    for (const name of ['oscar', 'oscar-runner']) {
      expect([name, compose.services[name].labels.autoheal]).toEqual([name, 'true']);
      expect([name, Boolean(compose.services[name].healthcheck)]).toEqual([name, true]);
    }
  });

  const logged = ['docker-compose.yml', 'docker-compose.metrics.yml'];
  const blockOf = (file) => yaml.load(read(`OSCAR_Deploy/${file}`))['x-logging'];

  test('both files hold the same logging block: json-file, the name as tag, the compose labels, a size cap', () => {
    const [a, b] = logged.map(blockOf);
    expect(a).toEqual(b);
    expect(a.driver).toBe('json-file');
    expect(a.options.tag).toBe('{{.Name}}');
    expect(a.options.labels.split(',').sort()).toEqual(['com.docker.compose.project', 'com.docker.compose.service']);
    expect(a.options['max-size']).toMatch(/^\d+m$/);
    expect(a.options['max-file']).toMatch(/^\d+$/);
  });

  test.each(logged)('%s: every service it makes writes those logs', (file) => {
    const compose = yaml.load(read(`OSCAR_Deploy/${file}`));
    const block = compose['x-logging'];
    for (const [name, service] of Object.entries(compose.services)) {
      // The metrics file adds settings to the base file's oscar service; the
      // base file gives it its logging.
      if (file !== 'docker-compose.yml' && !service.image) continue;
      expect([name, service.logging]).toEqual([name, block]);
    }
  });
});

describe('Promtail', () => {
  const config = yaml.load(read('OSCAR_Deploy/promtail/promtail-config.yaml'));
  const job = config.scrape_configs.find((j) => j.job_name === 'docker');
  const stages = job.pipeline_stages;
  const stage = (kind) => stages.find((s) => s[kind])[kind];

  test('reads the containers\' log files, never the Docker API', () => {
    expect(read('OSCAR_Deploy/promtail/promtail-config.yaml')).not.toMatch(/docker_sd_configs|docker\.sock|unix:\/\//);
    expect(job.static_configs[0].labels.__path__).toBe('/var/lib/docker/containers/*/*-json.log');
    const compose = yaml.load(read('OSCAR_Deploy/docker-compose.metrics.yml'));
    expect(compose.services.promtail.volumes).toContain('/var/lib/docker/containers:/var/lib/docker/containers:ro');
  });

  test('the container\'s name and compose labels come from the line Docker wrote', () => {
    const json = stage('json').expressions;
    expect(json).toEqual(expect.objectContaining({
      output: 'log', stream: 'stream', time: 'time', container: 'attrs.tag',
      compose_service: 'attrs."com.docker.compose.service"',
      compose_project: 'attrs."com.docker.compose.project"',
    }));
    expect(stage('template')).toEqual({ source: 'container', template: '{{ or .container .container_id }}' });
    expect(stage('output')).toEqual({ source: 'output' });
    expect(stage('labeldrop')).toEqual(['filename']);
  });

  test('the regex gives a nameless line its container id, from the path Docker uses', () => {
    const re = new RegExp(stage('regex').expression.replace('(?P<', '(?<'));
    const id = 'ab12cd34ef56'.repeat(5) + 'abcd';
    expect(`/var/lib/docker/containers/${id}/${id}-json.log`.match(re).groups.container_id).toBe(id.slice(0, 12));
  });

  test('every label the Logs dashboard filters on is made', () => {
    const made = Object.keys(stage('labels'));
    const dashboard = read('OSCAR_Deploy/grafana/dashboards/oscar-logs.json');
    const used = [...new Set([...dashboard.matchAll(/[{,]\s*([a-z_]+)\s*[=!]~?\\"/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    for (const label of used) expect([label, made.includes(label)]).toEqual([label, true]);
    expect(made.sort()).toEqual(['compose_project', 'compose_service', 'container', 'stream']);
  });
});

// ── The host's scripts ───────────────────────────────────────────────────────
const AUTOHEAL = path.join(DEPLOY, 'scripts', 'oscar-autoheal.sh');
const SCHEDULE = path.join(DEPLOY, 'scripts', 'oscar-autoheal-schedule.sh');

describe('oscar-autoheal-schedule.sh', () => {
  const text = fs.readFileSync(SCHEDULE, 'utf8');

  test('installs a copy owned by root outside the checkout, and the unit runs that copy', () => {
    expect(text).toMatch(/^TARGET=\/usr\/local\/sbin\/oscar-autoheal$/m);
    expect(text).toMatch(/install -m 0755 -o root -g root "\$SOURCE" "\$TARGET"/);
    expect(text).toMatch(/^ExecStart=\$TARGET$/m);
    expect(text).not.toMatch(/^User=/m);
  });

  test('every 30 s, its lines in the journal under its own name', () => {
    expect(text).toMatch(/^OnUnitActiveSec=30s$/m);
    expect(text).toMatch(/^SyslogIdentifier=oscar-autoheal$/m);
    expect(text).toMatch(/^NoNewPrivileges=yes$/m);
  });
});

const hasBash = (process.platform !== 'win32' || process.env.OSCAR_TEST_BASH === '1')
  && spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0;
const bashTest = hasBash ? test : test.skip;

// A docker that answers `ps` with $STUB_IDS, names each container, and logs
// every call; a restart of an id listed in $STUB_RESTART_FAILS fails.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/docker.log"
case "$1" in
  ps) [ "\${STUB_PS_FAILS:-0}" = 1 ] && exit 1; printf '%s' "\${STUB_IDS:-}" | tr ',' '\\n'; exit 0 ;;
  inspect) last="\${!#}"; printf '/name-%s\\n' "\${last:0:4}"; exit 0 ;;
  restart) case ",\${STUB_RESTART_FAILS:-}," in *",\${!#},"*) exit 1 ;; esac; exit 0 ;;
  *) exit 1 ;;
esac
`;

describe('oscar-autoheal.sh', () => {
  let root;
  const id = (c) => c.repeat(64);
  beforeEach(() => {
    if (!hasBash) return;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-autoheal-'));
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'docker'), DOCKER_STUB, { mode: 0o755 });
  });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function run(env = {}) {
    const r = spawnSync('bash', [AUTOHEAL], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, STUB_DIR: root, ...env },
    });
    const log = path.join(root, 'docker.log');
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
  }

  bashTest('asks Docker for the unhealthy containers labelled autoheal=true, and restarts each', () => {
    const r = run({ STUB_IDS: `${id('a')},${id('b')}` });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toBe('ps --quiet --no-trunc --filter label=autoheal=true --filter health=unhealthy');
    expect(r.calls).toContain(`restart -t 20 ${id('a')}`);
    expect(r.calls).toContain(`restart -t 20 ${id('b')}`);
    expect(r.out).toContain('restarted name-aaaa (aaaaaaaaaaaa): Docker reported it unhealthy');
  });

  bashTest('nothing unhealthy: nothing restarted', () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('restart'))).toEqual([]);
    expect(r.out).toBe('');
  });

  bashTest('Docker not answering: no restart, a failed pass', () => {
    const r = run({ STUB_PS_FAILS: '1', STUB_IDS: id('a') });
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.startsWith('restart'))).toEqual([]);
    expect(r.out).toContain('could not ask Docker');
  });

  bashTest('a restart that fails: the others are still restarted, the pass fails', () => {
    const r = run({ STUB_IDS: `${id('a')},${id('b')}`, STUB_RESTART_FAILS: id('a') });
    expect(r.code).toBe(1);
    expect(r.calls).toContain(`restart -t 20 ${id('b')}`);
    expect(r.out).toContain('could not restart name-aaaa');
  });

  bashTest('an answer that is not a container id is never acted upon', () => {
    const r = run({ STUB_IDS: `--all,${id('c')}` });
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.includes('--all'))).toEqual([]);
    expect(r.calls).toContain(`restart -t 20 ${id('c')}`);
  });

  bashTest('its settings: another label and stop time are used; odd values are refused before Docker is asked', () => {
    const ok = run({ OSCAR_AUTOHEAL_LABEL: 'heal', OSCAR_AUTOHEAL_STOP_TIMEOUT: '5', STUB_IDS: id('d') });
    expect(ok.code).toBe(0);
    expect(ok.calls[0]).toContain('--filter label=heal --filter');
    expect(ok.calls).toContain(`restart -t 5 ${id('d')}`);
    for (const env of [{ OSCAR_AUTOHEAL_LABEL: 'a b' }, { OSCAR_AUTOHEAL_LABEL: 'x=y,z' }, { OSCAR_AUTOHEAL_STOP_TIMEOUT: '-1' }, { OSCAR_AUTOHEAL_STOP_TIMEOUT: '1000' }]) {
      fs.rmSync(path.join(root, 'docker.log'), { force: true });
      const r = run({ ...env, STUB_IDS: id('e') });
      expect([env, r.code, r.calls]).toEqual([env, 2, []]);
    }
  });
});
