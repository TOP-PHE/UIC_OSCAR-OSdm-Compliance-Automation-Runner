// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1059: OSCAR_Deploy/kubernetes/ held to what the image and the server
// expect. A kind cluster deploys it in .github/workflows/ci-kubernetes.yml;
// this file catches, in the required job, a path, port, host or setting that
// drifts from the Dockerfiles, the server or the VPS's nginx — and the Route,
// which kind cannot check.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { trustProxyHops } = require('../../src/utils/clusterSettings');

const REPO = path.resolve(__dirname, '../../..');
const K8S = path.join(REPO, 'OSCAR_Deploy/kubernetes');

const read = (rel) => fs.readFileSync(path.join(K8S, rel), 'utf8');
const load = (rel) => yaml.load(read(rel));

// KEY=VALUE lines of an env file, comments and blank lines left out, as
// kustomize and `kubectl create secret --from-env-file` read it.
function envOf(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

// A configMapGenerator's literals, as an object.
function literalsOf(kustomization) {
  const gen = (kustomization.configMapGenerator || []).find(g => g.name === 'oscar-settings');
  return envOf((gen?.literals || []).join('\n'));
}

const deployment = load('base/deployment.yaml');
const pod = deployment.spec.template.spec;
const container = pod.containers[0];
const settings = envOf(read('base/settings.env'));
const secretKeys = Object.keys(envOf(read('base/secrets.env.example')));
const dockerfile = fs.readFileSync(path.join(REPO, 'Oscar_Server/Dockerfile'), 'utf8');
const bundle = read('Dockerfile.bundle');
const nginx = fs.readFileSync(path.join(REPO, 'OSCAR_Deploy/nginx/oscar.conf.example'), 'utf8');

describe('every manifest is there and reads', () => {
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yaml')) files.push(p);
    }
  })(K8S);

  test.each(files.map(f => path.relative(K8S, f)))('%s', (rel) => {
    expect(() => load(rel)).not.toThrow();
  });

  test.each(files.filter(f => f.endsWith('kustomization.yaml')).map(f => path.relative(K8S, f)))(
    '%s names files and folders that exist', (rel) => {
      const k = load(rel);
      const dir = path.dirname(path.join(K8S, rel));
      const named = [
        ...(k.resources || []),
        ...(k.patches || []).map(p => p.path).filter(Boolean),
        ...(k.configMapGenerator || []).flatMap(g => g.envs || []),
      ];
      expect(named.length).toBeGreaterThan(0);
      for (const n of named) expect(fs.existsSync(path.join(dir, n))).toBe(true);
    });

  test('the guide the base names exists', () => {
    const named = /Guide: (.+\.md)/.exec(read('base/kustomization.yaml'))[1];
    expect(fs.existsSync(path.join(REPO, named))).toBe(true);
  });
});

describe('the pod', () => {
  test('one replica, replaced, never rolled: SQLite and the queue are in one process', () => {
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
  });

  test('restricted pod security, with no uid or group of its own (OpenShift chooses them)', () => {
    expect(pod.securityContext).toEqual({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
    expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(container.securityContext.capabilities.drop).toEqual(['ALL']);
    expect(pod.automountServiceAccountToken).toBe(false);
  });

  test('the probes ask /health naming localhost, which the production redirect leaves alone', () => {
    for (const probe of ['startupProbe', 'readinessProbe', 'livenessProbe']) {
      expect(container[probe].httpGet.path).toBe('/health');
      expect(container[probe].httpGet.port).toBe('http');
      expect(container[probe].httpGet.httpHeaders).toEqual([{ name: 'Host', value: 'localhost' }]);
    }
    const server = fs.readFileSync(path.join(REPO, 'Oscar_Server/src/server.js'), 'utf8');
    expect(server).toContain("const isLocalhost = host === 'localhost'");
  });

  test('the port is the image\'s', () => {
    expect(container.ports).toEqual([{ name: 'http', containerPort: 3001 }]);
    expect(dockerfile).toMatch(/^EXPOSE 3001$/m);
    expect(settings.PORT).toBe('3001');
  });

  test('the data directory is the volume, /tmp an emptyDir, HOME in /tmp', () => {
    expect(container.volumeMounts).toEqual([
      { name: 'data', mountPath: '/app/data' },
      { name: 'run-workspaces', mountPath: settings.RUN_WORKSPACES_DIR },
      { name: 'tmp', mountPath: '/tmp' },
    ]);
    expect(pod.volumes.find(v => v.name === 'data').persistentVolumeClaim.claimName).toBe('oscar-data');
    expect(load('base/data-volume.yaml').metadata.name).toBe('oscar-data');
    expect(pod.volumes.find(v => v.name === 'tmp').emptyDir).toBeDefined();
    expect(settings.HOME).toBe('/tmp');
  });

  test('settings and secrets come from oscar-settings and oscar-secrets', () => {
    expect(container.envFrom).toEqual([
      { configMapRef: { name: 'oscar-settings' } },
      { secretRef: { name: 'oscar-secrets' } },
    ]);
    expect(load('base/kustomization.yaml').configMapGenerator[0].name).toBe('oscar-settings');
  });

  test('settings and secrets reach the server, and the runner\'s key comes from a Secret of its own', () => {
    expect(container.env).toEqual([
      { name: 'RUN_AGENT_TOKEN', valueFrom: { secretKeyRef: { name: 'oscar-runner', key: 'RUN_AGENT_TOKEN' } } },
    ]);
  });

  test('the Service selects the pod', () => {
    const service = load('base/service.yaml');
    for (const [k, v] of Object.entries(service.spec.selector)) {
      expect(deployment.spec.template.metadata.labels[k]).toBe(v);
    }
    expect(service.spec.ports).toEqual([{ name: 'http', port: 3001, targetPort: 'http' }]);
  });
});

describe('the runner container (run isolation)', () => {
  const runner = pod.containers.find(c => c.name === 'runner');
  const { SERVER_SECRETS, startupProblem } = require('../../src/runner-agent/agent');
  const envOfRunner = Object.fromEntries((runner.env || []).filter(e => 'value' in e).map(e => [e.name, e.value]));

  test('the server sends its runs there', () => {
    expect(pod.containers.map(c => c.name)).toEqual(['oscar', 'runner']);
    expect(settings.RUN_ISOLATION).toBe('isolated');
    // The pod's containers share 127.0.0.1: the agent's and the server's defaults.
    expect(settings).not.toHaveProperty('RUN_AGENT_HOST');
    expect(settings).not.toHaveProperty('RUN_SERVER_URL');
  });

  test('the same image, the agent, and none of the server\'s settings, secrets or data', () => {
    expect(runner.image).toBe(container.image);
    expect(runner.command).toEqual(['node', 'src/runner-agent/agent.js']);
    expect(runner.envFrom).toBeUndefined();
    expect(runner.volumeMounts).toEqual([
      { name: 'run-workspaces', mountPath: settings.RUN_WORKSPACES_DIR },
      { name: 'runner-tmp', mountPath: '/tmp' },
    ]);
    expect(envOfRunner.RUN_WORKSPACES_DIR).toBe(settings.RUN_WORKSPACES_DIR);
    expect(envOfRunner.BRU_CMD).toBe(settings.BRU_CMD);
    for (const k of [...SERVER_SECRETS, ...secretKeys]) expect(runner.env.map(e => e.name)).not.toContain(k);
    expect(runner.env.find(e => e.name === 'RUN_AGENT_TOKEN')).toEqual(container.env[0]);
    expect(startupProblem({ ...envOfRunner, RUN_AGENT_TOKEN: 'x'.repeat(64) }, () => false)).toBeNull();
  });

  test('the two share the run folders only, and not their processes', () => {
    expect(pod.shareProcessNamespace).toBeUndefined();
    for (const name of ['run-workspaces', 'runner-tmp']) {
      expect(pod.volumes.find(v => v.name === name).emptyDir).toBeDefined();
    }
    expect(runner.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(runner.securityContext.capabilities.drop).toEqual(['ALL']);
  });

  test('its probes reach the agent on the pod\'s loopback, at its port', () => {
    const agent = fs.readFileSync(path.join(REPO, 'Oscar_Server/src/runner-agent/agent.js'), 'utf8');
    expect(agent).toContain("process.env.RUN_AGENT_PORT || '3002'");
    for (const probe of ['startupProbe', 'livenessProbe']) {
      expect(runner[probe].exec.command.join(' ')).toContain("connect(3002,'127.0.0.1')");
    }
  });
});

describe('the image', () => {
  test('USER is uid 1000 by number, and the data directory is group 0\'s too', () => {
    expect(dockerfile).toMatch(/^USER 1000$/m);
    expect(dockerfile).toMatch(/chgrp -R 0 \/app\/data/);
    expect(dockerfile).toMatch(/chmod -R g=u \/app\/data/);
  });

  test('the bundle puts the collection and the matrix where the settings say', () => {
    expect(bundle).toMatch(new RegExp(String.raw`^COPY --chown=0:0 Bruno_Collection/ ${settings.COLLECTION_PATH}/$`, 'm'));
    expect(bundle).toMatch(new RegExp(String.raw`^COPY --chown=0:0 compatibility.json ${settings.COMPATIBILITY_FILE}$`, 'm'));
  });

  test('the Bruno CLI is where BRU_CMD says', () => {
    expect(dockerfile).toContain(`ln -s /opt/bruno-cli/node_modules/.bin/bru ${settings.BRU_CMD}`);
  });

  test('the local run reports stay out of the bundle', () => {
    const ignore = read('Dockerfile.bundle.dockerignore').split('\n').map(l => l.trim());
    expect(ignore).toEqual(expect.arrayContaining(['*', '!Bruno_Collection', '!compatibility.json', 'Bruno_Collection/Validation_Reports']));
    expect(ignore.indexOf('Bruno_Collection/Validation_Reports')).toBeGreaterThan(ignore.indexOf('!Bruno_Collection'));
  });
});

// #1130: one run in a pod of its own. The run image holds Bruno, the
// collection and the run pod's entrypoint, and nothing else of the server.
describe('the run image (option 4)', () => {
  const runImage = read('Dockerfile.run');
  const fromOf = (text) => text.split('\n').filter(l => l.startsWith('FROM ')).map(l => l.split(/\s+/)[1]);

  test('its base image is the server\'s, by digest', () => {
    const server = fromOf(dockerfile);
    expect(fromOf(runImage)).toEqual([server[server.length - 1]]);
    expect(fromOf(runImage)[0]).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test('Bruno is installed as the server image installs it', () => {
    const install = (text) => text.split('\n')
      .filter(l => /npm ci --omit=dev --ignore-scripts|ln -s \/opt\/bruno-cli|bru --version/.test(l)).map(l => l.trim());
    expect(install(runImage)).toEqual(install(dockerfile));
  });

  test('of the server, it copies the run pod\'s entrypoint only', () => {
    const copies = runImage.split('\n').filter(l => l.startsWith('COPY ')).map(l => l.replace(/--chown=\S+ /, '').split(/\s+/).slice(1, -1)).flat();
    expect(copies.filter(c => c.startsWith('Oscar_Server/'))).toEqual(
      ['Oscar_Server/bruno-cli/package.json', 'Oscar_Server/bruno-cli/package-lock.json', 'Oscar_Server/src/run-pod/']);
    expect(runImage).toMatch(/^USER 1000$/m);
    expect(runImage).toMatch(/^ENTRYPOINT \["node", "\/opt\/run-pod\/entrypoint\.js"\]$/m);
    const ignore = read('Dockerfile.run.dockerignore').split('\n').map(l => l.trim());
    expect(ignore).toEqual(expect.arrayContaining(['*', '!Oscar_Server/src/run-pod', '!Bruno_Collection', 'Bruno_Collection/Validation_Reports']));
    expect(ignore.filter(l => l.startsWith('!Oscar_Server/'))).toEqual(
      ['!Oscar_Server/bruno-cli/package.json', '!Oscar_Server/bruno-cli/package-lock.json', '!Oscar_Server/src/run-pod']);
  });

  test('build-images.sh builds it from the repository root', () => {
    const script = read('build-images.sh');
    expect(script).toContain('build -f "$here/Dockerfile.run" $ignore -t "$prefix/oscar-run:$tag" "$root"');
    expect(script).toContain('--ignorefile=$here/Dockerfile.run.dockerignore');
  });
});

describe('settings and secrets', () => {
  const SECRETS = ['ENCRYPTION_KEY', 'JWT_SECRET', 'PLATFORM_BOOTSTRAP_TOKEN', 'METRICS_TOKEN', 'SMTP_PASS'];

  test('the secrets are in the Secret, never in the ConfigMap', () => {
    expect(secretKeys).toEqual(SECRETS);
    for (const k of SECRETS) expect(settings).not.toHaveProperty(k);
    expect(Object.values(envOf(read('base/secrets.env.example')))).toEqual(SECRETS.map(() => ''));
  });

  test('what the server cannot start without is set', () => {
    const server = fs.readFileSync(path.join(REPO, 'Oscar_Server/src/server.js'), 'utf8');
    const required = JSON.parse(/const REQUIRED_ENV = (\[[^\]]*\])/.exec(server)[1].replaceAll("'", '"'));
    for (const k of required) expect(k in settings || secretKeys.includes(k)).toBe(true);
  });

  test('every setting is a variable OSCAR reads (or Node, for HOME and TZ)', () => {
    const src = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) src.push(fs.readFileSync(p, 'utf8'));
      }
    })(path.join(REPO, 'Oscar_Server/src'));
    const used = new Set(src.join('\n').match(/process\.env\.[A-Z_]+/g).map(s => s.slice('process.env.'.length)));
    for (const k of Object.keys(settings)) {
      expect(['HOME', 'TZ'].includes(k) || used.has(k) ? k : `${k} is read by nothing`).toBe(k);
    }
  });

  test('the hop count is one the server accepts, and outbound addresses stay checked', () => {
    expect(trustProxyHops(settings.TRUST_PROXY_HOPS)).toBe(1);
    expect(settings).not.toHaveProperty('ALLOW_PRIVATE_TARGETS');
    expect(settings.NODE_ENV).toBe('production');
  });
});

describe('the overlays', () => {
  const k8s = load('overlays/kubernetes/kustomization.yaml');
  const ocp = load('overlays/openshift/kustomization.yaml');
  const ingress = load('overlays/kubernetes/ingress.yaml');
  const route = load('overlays/openshift/route.yaml');
  const nginxBody = /client_max_body_size\s+(\d+)M;/.exec(nginx)[1];
  const nginxTimeout = /proxy_read_timeout\s+(\d+)s;/.exec(nginx)[1];

  test('each names one host for its way in, APP_URL and the redirect', () => {
    for (const [k, host] of [[k8s, ingress.spec.rules[0].host], [ocp, route.spec.host]]) {
      const lit = literalsOf(k);
      expect(lit.APP_URL).toBe(`https://${host}`);
      expect(lit.ALLOWED_REDIRECT_HOSTS).toBe(host);
      expect(k.configMapGenerator[0].behavior).toBe('merge');
    }
    expect(ingress.spec.tls[0].hosts).toEqual([ingress.spec.rules[0].host]);
  });

  test('both name the same image', () => {
    expect(k8s.images).toEqual(ocp.images);
    expect(k8s.images[0].name).toBe(container.image);
  });

  test('the Ingress gives the limits the VPS\'s nginx gives', () => {
    const a = ingress.metadata.annotations;
    expect(a['nginx.ingress.kubernetes.io/proxy-body-size']).toBe(`${nginxBody}m`);
    expect(a['nginx.ingress.kubernetes.io/proxy-read-timeout']).toBe(nginxTimeout);
    expect(a['nginx.ingress.kubernetes.io/proxy-send-timeout']).toBe(nginxTimeout);
    expect(ingress.spec.rules[0].http.paths).toEqual([
      { path: '/', pathType: 'Prefix', backend: { service: { name: 'oscar', port: { name: 'http' } } } },
    ]);
  });

  test('the Route ends TLS at the router, redirects http, and waits as long as nginx', () => {
    expect(route.spec.tls).toEqual({ termination: 'edge', insecureEdgeTerminationPolicy: 'Redirect' });
    expect(route.metadata.annotations['haproxy.router.openshift.io/timeout']).toBe(`${nginxTimeout}s`);
    expect(route.spec.to).toEqual({ kind: 'Service', name: 'oscar', weight: 100 });
    expect(route.spec.port).toEqual({ targetPort: 'http' });
  });

  test('plain Kubernetes gives the volume to the image\'s uid; OpenShift chooses its own', () => {
    const patch = load('overlays/kubernetes/data-volume-group.yaml');
    expect(patch.spec.template.spec.securityContext.fsGroup).toBe(1000);
    expect(ocp.patches).toBeUndefined();
    expect(read('overlays/openshift/kustomization.yaml')).not.toMatch(/runAsUser|fsGroup/);
  });
});

describe('what CI deploys', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/ci-kubernetes.yml'), 'utf8');

  test('the OpenShift-like deployment runs under a uid the image does not know, in group 0', () => {
    const user = load('ci/openshift-like/openshift-user.yaml').spec.template.spec.securityContext;
    expect(user.runAsUser).not.toBe(1000);
    expect(user.runAsUser).toBeGreaterThan(1000000);
    expect(user.runAsGroup).toBe(0);
    expect(workflow).toContain(`= ${user.runAsUser}`);
  });

  test('both CI deployments create the runner\'s Secret, and check what the runner holds', () => {
    expect(workflow.match(/create secret generic oscar-runner --from-literal=RUN_AGENT_TOKEN=/g)).toHaveLength(2);
    expect(workflow).toContain('exec deploy/oscar -c runner');
  });

  test('both CI deployments use the image the workflow builds', () => {
    const build = /build-images\.sh (\S+) (\S+)/.exec(workflow);
    for (const rel of ['ci/openshift-like/kustomization.yaml', 'ci/kubernetes/kustomization.yaml']) {
      const img = load(rel).images[0];
      expect(`${img.newName}:${img.newTag}`).toBe(`${build[1]}/oscar:${build[2]}`);
    }
    expect(load('ci/kubernetes/kustomization.yaml').images[0].name).toBe(load('overlays/kubernetes/kustomization.yaml').images[0].newName);
  });

  test('the workflow runs when what it deploys changes', () => {
    for (const p of ['OSCAR_Deploy/kubernetes/**', 'Oscar_Server/Dockerfile', 'Oscar_Server/src/server.js', 'Oscar_Server/src/utils/clusterSettings.js',
      'Oscar_Server/src/runner-agent/**', 'Oscar_Server/src/utils/runAgentPeer.js', 'Oscar_Server/src/run-pod/**']) {
      expect(workflow.split(`'${p}'`).length - 1).toBe(2);   // pull_request and push
    }
  });
});
