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
    // A file may hold several documents (---), as the pod mode's do.
    expect(() => yaml.loadAll(read(rel))).not.toThrow();
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
    // The two deployments with a runner container, and the pod mode's (the dispatcher's key).
    expect(workflow.match(/create secret generic oscar-runner --from-literal=RUN_AGENT_TOKEN=/g)).toHaveLength(3);
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
      'Oscar_Server/src/runner-agent/**', 'Oscar_Server/src/utils/runAgentPeer.js', 'Oscar_Server/src/run-pod/**',
      'Oscar_Server/src/run-dispatcher/**']) {
      expect(workflow.split(`'${p}'`).length - 1).toBe(2);   // pull_request and push
    }
  });
});

// ── #1130: pod mode, each run in a pod of its own ────────────────────────────
// The runs' namespace (runs/), the component that turns an overlay to pod
// mode (components/pod-runs/), and what the kind CI deploys of them.
describe('pod mode (option 4)', () => {
  const loadAll = (rel) => yaml.loadAll(read(rel));
  const byKind = (docs, kind, name) => docs.find(d => d.kind === kind && (!name || d.metadata.name === name));
  const runsK = load('runs/kustomization.yaml');
  const runsDocs = runsK.resources.flatMap(r => loadAll(`runs/${r}`));
  const component = load('components/pod-runs/kustomization.yaml');
  const compDocs = component.resources.flatMap(r => loadAll(`components/pod-runs/${r}`));
  const generated = (name) => envOf((component.configMapGenerator.find(g => g.name === name)?.literals || []).join('\n'));
  const serverSettings = generated('oscar-settings');
  const dispatcherSettings = generated('oscar-dispatcher-settings');
  const dispatcher = byKind(compDocs, 'Deployment', 'oscar-dispatcher');
  const dPod = dispatcher.spec.template.spec;
  const dContainer = dPod.containers[0];

  test('the runs\' namespace is held to "restricted", and everything in it names it', () => {
    const ns = byKind(runsDocs, 'Namespace');
    expect(ns.metadata.name).toBe('oscar-runs');
    expect(ns.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('restricted');
    for (const d of runsDocs.filter(x => x.kind !== 'Namespace')) expect([d.kind, d.metadata.namespace]).toEqual([d.kind, 'oscar-runs']);
    expect(byKind(runsDocs, 'ServiceAccount', 'oscar-run').automountServiceAccountToken).toBe(false);
    expect(byKind(runsDocs, 'ResourceQuota')).toBeDefined();
  });

  test('the dispatcher may make and remove runs there, and nothing more', () => {
    const role = byKind(runsDocs, 'Role', 'oscar-dispatcher');
    const rights = role.rules.flatMap(r => r.resources.map(res => `${res}:${[...r.verbs].sort().join(',')}`)).sort();
    expect(rights).toEqual(['jobs:create,delete,get,list', 'pods/log:get', 'pods:get,list', 'secrets:create,delete,list,patch']);
    const binding = byKind(runsDocs, 'RoleBinding', 'oscar-dispatcher');
    expect(binding.roleRef).toMatchObject({ kind: 'Role', name: 'oscar-dispatcher' });
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: 'oscar-dispatcher', namespace: 'oscar' }]);
    expect(runsDocs.some(d => d.kind === 'ClusterRole' || d.kind === 'ClusterRoleBinding')).toBe(false);
  });

  test('a run pod reaches DNS, OSCAR\'s internal port and public addresses only; nothing reaches it', () => {
    const np = byKind(runsDocs, 'NetworkPolicy', 'oscar-run');
    expect(np.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'oscar-run' });
    expect(np.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(np.spec.ingress).toBeUndefined();
    expect(np.spec.egress).toHaveLength(3);
    const [dns, internal, publicNet] = np.spec.egress;
    expect(dns.ports.map(p => p.port).sort((a, b) => a - b)).toEqual([53, 53, 5353, 5353]);
    expect(internal.ports).toEqual([{ protocol: 'TCP', port: Number(serverSettings.INTERNAL_PORT) }]);
    expect(internal.to[0].namespaceSelector.matchLabels).toEqual({ 'kubernetes.io/metadata.name': 'oscar' });
    const v4 = publicNet.to.find(t => t.ipBlock.cidr === '0.0.0.0/0').ipBlock.except;
    expect(v4).toEqual(expect.arrayContaining(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8', '100.64.0.0/10']));
    expect(publicNet.ports).toBeUndefined();
  });

  test('the component sets pod mode and the internal port, and takes the runner out of OSCAR\'s pod', () => {
    expect(component.kind).toBe('Component');
    expect(serverSettings).toMatchObject({ RUN_ISOLATION: 'pod', INTERNAL_PORT: '3003', RUN_AGENT_HOST: 'oscar-dispatcher', RUN_AGENT_PORT: '3002' });
    expect(serverSettings.RUN_SERVER_URL).toBe(dispatcherSettings.RUN_RESULTS_URL);
    expect(serverSettings.RUN_SERVER_URL).toBe(`http://oscar-internal.oscar.svc:${serverSettings.INTERNAL_PORT}`);
    const patch = load('components/pod-runs/server-pod-mode.yaml').spec.template.spec;
    expect(patch.containers).toEqual(expect.arrayContaining([{ name: 'runner', $patch: 'delete' }]));
    expect(patch.containers.find(c => c.name === 'oscar').ports).toEqual([{ name: 'internal', containerPort: 3003 }]);
    const svc = byKind(compDocs, 'Service', 'oscar-internal');
    expect(svc.spec.ports).toEqual([{ name: 'internal', port: 3003, targetPort: 'internal' }]);
    expect(svc.spec.selector).toEqual({ 'app.kubernetes.io/name': 'oscar' });
  });

  test('the dispatcher holds none of the server\'s settings, secrets or data', () => {
    expect(dPod.serviceAccountName).toBe('oscar-dispatcher');
    expect(byKind(compDocs, 'ServiceAccount', 'oscar-dispatcher').automountServiceAccountToken).toBe(true);
    expect(dContainer.command).toEqual(['node', 'src/run-dispatcher/dispatcher.js']);
    expect(dContainer.image).toBe(container.image);
    expect(dContainer.envFrom).toEqual([{ configMapRef: { name: 'oscar-dispatcher-settings' } }]);
    expect(dContainer.env).toEqual([{ name: 'RUN_AGENT_TOKEN', valueFrom: { secretKeyRef: { name: 'oscar-runner', key: 'RUN_AGENT_TOKEN' } } }]);
    expect(JSON.stringify(dispatcher)).not.toMatch(/oscar-secrets|oscar-data|\/app\/data/);
    expect(dContainer.securityContext).toMatchObject({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(dPod.securityContext).toEqual({ runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } });
  });

  test('the dispatcher\'s settings are the ones it reads, and it starts with them', () => {
    const D = require('../../src/run-dispatcher/dispatcher');
    const source = fs.readFileSync(path.join(REPO, 'Oscar_Server/src/run-dispatcher/dispatcher.js'), 'utf8');
    const readByIt = new Set([...source.matchAll(/env\.(RUN_[A-Z_]+)/g)].map(m => m[1]));
    for (const key of Object.keys(dispatcherSettings).filter(k => k.startsWith('RUN_'))) expect([key, readByIt.has(key)]).toEqual([key, true]);
    expect(D.startupProblem({ ...dispatcherSettings, RUN_AGENT_TOKEN: 'k'.repeat(40) }, undefined, () => false)).toBeNull();
    expect(D.settingsOf(dispatcherSettings).serviceAccount).toBe('oscar-run');
  });

  test('the internal port is reached by run pods only, the dispatcher by OSCAR\'s pod only', () => {
    const server = byKind(compDocs, 'NetworkPolicy', 'oscar-server');
    expect(server.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'oscar' });
    const open = server.spec.ingress.find(r => !r.from);
    expect(open.ports).toEqual([{ protocol: 'TCP', port: 3001 }]);
    const internal = server.spec.ingress.find(r => r.from);
    expect(internal.ports).toEqual([{ protocol: 'TCP', port: 3003 }]);
    expect(internal.from).toEqual([{
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'oscar-runs' } },
      podSelector: { matchLabels: { 'app.kubernetes.io/name': 'oscar-run' } },
    }]);
    const disp = byKind(compDocs, 'NetworkPolicy', 'oscar-dispatcher');
    expect(disp.spec.ingress).toEqual([{ from: [{ podSelector: { matchLabels: { 'app.kubernetes.io/name': 'oscar' } } }], ports: [{ protocol: 'TCP', port: 3002 }] }]);
  });

  test('the run pods\' labels and service account are the ones the dispatcher gives them', () => {
    const J = require('../../src/run-dispatcher/jobSpec');
    expect(J.LABELS['app.kubernetes.io/name']).toBe('oscar-run');
    expect(dispatcherSettings.RUN_SERVICE_ACCOUNT).toBe(byKind(runsDocs, 'ServiceAccount', 'oscar-run').metadata.name);
    expect(dispatcherSettings.RUN_NAMESPACE).toBe('oscar-runs');
  });

  test('the kind CI deploys pod mode with the run image it builds, and checks it', () => {
    const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/ci-kubernetes.yml'), 'utf8');
    const ci = load('ci/pod-mode/kustomization.yaml');
    expect(ci.components).toEqual(['../../components/pod-runs']);
    expect(runImagePatchOf(ci)).toBe('local/oscar-run:ci');
    expect(workflow).toContain('kind load docker-image local/oscar-run:ci --name oscar');
    expect(workflow).toContain('kubectl apply -k OSCAR_Deploy/kubernetes/ci/pod-runs');
    expect(workflow).toContain('kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/ci/pod-mode');
    expect(workflow).toContain('OSCAR_Deploy/kubernetes/ci/probe-run-network.sh');
    expect(load('ci/pod-runs/kustomization.yaml').resources).toEqual(['../../runs']);
  });

  // kustomize (5.1 and later) runs a kustomization's own generators before its
  // components: a `behavior: merge` into a ConfigMap a component makes fails
  // ("does not exist; cannot merge"), and one setting a key a component also
  // merges is overwritten by the component. The kind CI met the first.
  function mergeProblems(k, dir) {
    const theirs = (k.components || []).flatMap(c => load(path.posix.join(dir, c, 'kustomization.yaml')).configMapGenerator || []);
    const problems = [];
    for (const g of (k.configMapGenerator || []).filter(x => x.behavior === 'merge')) {
      const same = theirs.filter(c => c.name === g.name);
      if (same.some(c => !c.behavior || c.behavior === 'create')) {
        problems.push(`${g.name}: made by a component`);
        continue;
      }
      const keys = new Set(same.flatMap(c => Object.keys(envOf((c.literals || []).join('\n')))));
      for (const key of Object.keys(envOf((g.literals || []).join('\n')))) if (keys.has(key)) problems.push(`${g.name}: ${key} is a component's`);
    }
    return problems;
  }

  test('an overlay sets what a component makes with a patch, never a merge', () => {
    const found = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(K8S, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.name === 'kustomization.yaml') found.push(rel);
      }
    };
    walk('.');
    const users = found.map(rel => ({ rel, k: load(rel) })).filter(({ k }) => k.kind !== 'Component' && k.components);
    expect(users.map(u => u.rel)).toContain('ci/pod-mode/kustomization.yaml');
    for (const { rel, k } of users) expect([rel, mergeProblems(k, path.posix.dirname(rel))]).toEqual([rel, []]);
    // The mutation this guards against.
    const merged = { ...load('ci/pod-mode/kustomization.yaml') };
    merged.configMapGenerator = [...merged.configMapGenerator,
      { name: 'oscar-dispatcher-settings', behavior: 'merge', literals: ['RUN_IMAGE=x'] },
      { name: 'oscar-settings', behavior: 'merge', literals: ['RUN_SERVER_URL=http://x:3003'] }];
    expect(mergeProblems(merged, 'ci/pod-mode')).toEqual(['oscar-dispatcher-settings: made by a component', 'oscar-settings: RUN_SERVER_URL is a component\'s']);
  });

  test('the guide\'s overlay for pod mode names the run image with a patch', () => {
    const guide = fs.readFileSync(path.join(REPO, 'Documentation/Server_Operations/OSCAR - Kubernetes and OpenShift Deployment Guide.md'), 'utf8');
    const start = guide.indexOf('## 10a.');
    const section = guide.slice(start, guide.indexOf('\n## ', start + 1));
    const blocks = [...section.matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => yaml.load(m[1].replace(/^ {3}/gm, '')));
    const overlay = blocks.find(b => b?.components);
    expect(overlay.components).toEqual(['../../components/pod-runs']);
    expect(mergeProblems(overlay, 'overlays/kubernetes')).toEqual([]);
    expect(runImagePatchOf(overlay)).toMatch(/\/oscar-run:/);
  });
});

// RUN_IMAGE as an overlay's strategic-merge patch of oscar-dispatcher-settings sets it.
function runImagePatchOf(k) {
  const patches = (k.patches || []).filter(p => p.patch).map(p => yaml.load(p.patch));
  return patches.find(p => p?.kind === 'ConfigMap' && p.metadata?.name === 'oscar-dispatcher-settings')?.data?.RUN_IMAGE;
}

// ── The images each release publishes, and moving the data ──────────────────
const GUIDE = fs.readFileSync(path.join(REPO, 'Documentation/Server_Operations/OSCAR - Kubernetes and OpenShift Deployment Guide.md'), 'utf8');
const guideSection = (heading) => {
  const start = GUIDE.indexOf(`## ${heading}`);
  return GUIDE.slice(start, GUIDE.indexOf('\n## ', start + 1));
};

describe('the cluster images of each release (publish-cluster-images.yml)', () => {
  const text = fs.readFileSync(path.join(REPO, '.github/workflows/publish-cluster-images.yml'), 'utf8');
  const wf = yaml.load(text);

  test('it runs on a release tag, or by hand for an earlier one, with GITHUB_TOKEN only', () => {
    expect(wf.on.push.tags).toEqual(['release-*']);
    expect(Object.keys(wf.on.workflow_dispatch.inputs)).toEqual(['release_tag']);
    expect(wf.jobs.publish.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(wf.jobs.publish.environment).toBeUndefined();
    expect([...text.matchAll(/secrets\.(\w+)/g)].map(m => m[1])).toEqual(['GITHUB_TOKEN']);
  });

  test('it takes the release tags promote-release.yml takes, on main only', () => {
    const promote = fs.readFileSync(path.join(REPO, '.github/workflows/promote-release.yml'), 'utf8');
    const pattern = (t) => /grep -Eq '([^']+)'/.exec(t)[1];
    expect(pattern(text)).toBe(pattern(promote));
    expect(text).toContain('git merge-base --is-ancestor "refs/tags/$TAG" origin/main');
  });

  test('it builds with build-images.sh and pushes the bundle and the run image, never the server image', () => {
    expect(text).toContain('OSCAR_Deploy/kubernetes/build-images.sh "$PREFIX" "$TAG"');
    expect([...text.matchAll(/docker push "\$PREFIX\/([a-z-]+):\$TAG"/g)].map(m => m[1])).toEqual(['oscar', 'oscar-run']);
    const build = read('build-images.sh');
    expect(build).toContain('-t "$prefix/oscar:$tag"');
    expect(build).toContain('-t "$prefix/oscar-run:$tag"');
  });

  test('the overlays and the guide name what it publishes, for a release compatibility.json lists', () => {
    const compat = JSON.parse(fs.readFileSync(path.join(REPO, 'compatibility.json'), 'utf8'));
    const releases = new Set(compat.releases.map(r => `release-${r.release}`));
    const tags = new Set();
    for (const rel of ['overlays/kubernetes/kustomization.yaml', 'overlays/openshift/kustomization.yaml']) {
      const img = load(rel).images[0];
      expect(img.newName).toBe('ghcr.io/top-phe/oscar');
      expect(releases.has(img.newTag)).toBe(true);
      tags.add(img.newTag);
    }
    expect(tags.size).toBe(1);
    const blocks = [...guideSection('10a.').matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => yaml.load(m[1].replace(/^ {3}/gm, '')));
    expect(runImagePatchOf(blocks.find(b => b?.components))).toBe(`ghcr.io/top-phe/oscar-run:${[...tags][0]}`);
  });
});

describe('moving the data (oscar-data.sh)', () => {
  const script = read('oscar-data.sh');
  const setting = (name) => new RegExp(String.raw`^${name}=(\S+)`, 'm').exec(script)[1];

  test('it moves what a VPS backup holds in data/', () => {
    const backup = fs.readFileSync(path.join(REPO, 'OSCAR_Deploy/scripts/oscar-backup.sh'), 'utf8');
    const items = /^ITEMS=\(([^)]*)\)/m.exec(script)[1].split(/\s+/).filter(Boolean);
    expect(items).toEqual(['oscar.db', 'oscar.db-wal', 'datafiles', 'artifacts']);
    expect(backup).toContain('$STAGE/data/oscar.db');
    for (const dir of ['datafiles', 'artifacts']) expect(backup).toContain(`"$DATA_DIR/${dir}"`);
  });

  test('it copies into the volume where OSCAR\'s Deployment mounts it, in a pod like OSCAR\'s', () => {
    expect(setting('DEPLOYMENT')).toBe(deployment.metadata.name);
    expect(container.name).toBe('oscar');
    expect(script).toContain('select(.name == "oscar")');
    const mount = container.volumeMounts.find(m => m.mountPath === setting('DATA'));
    expect(pod.volumes.find(v => v.name === mount.name).persistentVolumeClaim.claimName).toBe('oscar-data');
    expect(script).toContain(`select(.name == "${mount.name}")`);
    // OSCAR's security, user and groups, so that the files are the server's.
    for (const key of ['securityContext: ($p.securityContext', 'securityContext: ($c.securityContext', 'image: $c.image']) expect(script).toContain(key);
  });

  test('its pod is not one OSCAR\'s Service or Deployment selects', () => {
    const helper = setting('HELPER');
    expect(Object.values(load('base/service.yaml').spec.selector)).not.toContain(helper);
    expect(Object.values(deployment.spec.selector.matchLabels)).not.toContain(helper);
    expect(script).toContain('"app.kubernetes.io/name": $name');
  });

  test('CI saves, refuses to load over users, loads, then reads the data back through the API', () => {
    const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/ci-kubernetes.yml'), 'utf8');
    expect(workflow).toContain('NAMESPACE=oscar "$d" save "$RUNNER_TEMP/moved"');
    expect(workflow).toContain('if NAMESPACE=oscar "$d" load "$RUNNER_TEMP/moved"; then');
    expect(workflow).toContain('NAMESPACE=oscar-k8s "$d" load "$RUNNER_TEMP/moved"');
    expect(workflow).toContain('SMOKE_ACCOUNT_FILE="$RUNNER_TEMP/smoke-account.json"');
    expect(workflow).toContain('/v1/company/datafile');
    expect(read('ci/smoke.sh')).toContain('> "$SMOKE_ACCOUNT_FILE"');
  });

  test('the guide opens a backup and loads its data/ folder', () => {
    const move = guideSection('6a.');
    expect(move).toContain('gpg --decrypt');
    expect(move).toContain('OSCAR_Deploy/kubernetes/oscar-data.sh load oscar-move/data');
    expect(move).toMatch(/grep -E '\^\(ENCRYPTION_KEY\|JWT_SECRET\|SMTP_PASS\)='/);
  });
});
