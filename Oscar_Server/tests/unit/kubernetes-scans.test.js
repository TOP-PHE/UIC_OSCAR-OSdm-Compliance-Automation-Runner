// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * kubernetes-scans.test.js — the Kubernetes scans of the CI (#1438):
 *  - check-scans.js reads Kubescape's, kube-bench's and (#1453) Trivy's
 *    configuration JSON reports, fails on
 *    a finding accepted.json does not accept, on an accepted entry that
 *    matches nothing, and on an entry without its reason;
 *  - accepted.json is sound;
 *  - the run pods are scanned as the k3s overlay has the dispatcher make them;
 *  - the pinned versions and checksums are the same in the CI and the guide.
 * The scans themselves run in ci-kubernetes.yml (jobs kubescape and k3s).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.join(__dirname, '..', '..', '..');
const SCANS = path.join(REPO, 'OSCAR_Deploy', 'kubernetes', 'scans');
const C = require(path.join(SCANS, 'check-scans.js'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// Shaped like Kubescape's JSON report: results by resource id, the objects
// (an RBAC subject without metadata) and where they were read.
function kubescapeReport() {
  const deployment = { kind: 'Deployment', metadata: { name: 'oscar' } };
  return {
    summaryDetails: { controls: { 'C-0017': { name: 'Immutable container filesystem' } } },
    resources: [
      { resourceID: 'k3s/oscar', object: deployment, source: { relativePath: 'rendered/overlays-k3s.yaml' } },
      { resourceID: 'ocp/oscar', object: deployment, source: { relativePath: 'rendered/overlays-openshift.yaml' } },
      { resourceID: 'sa/dispatcher', object: { kind: 'ServiceAccount', name: 'oscar-dispatcher', namespace: 'oscar' } },
    ],
    results: [
      { resourceID: 'k3s/oscar', controls: [
        { controlID: 'C-0017', status: { status: 'failed' }, rules: [{ paths: [{ fixPath: { path: 'spec.x.readOnlyRootFilesystem', value: 'true' } }] }] },
        { controlID: 'C-0016', status: { status: 'passed' } },
      ] },
      { resourceID: 'ocp/oscar', controls: [
        { controlID: 'C-0013', name: 'Non-root containers', status: { status: 'failed' } },
        { controlID: 'C-0017', status: { status: 'failed' } },
      ] },
      { resourceID: 'sa/dispatcher', controls: [{ controlID: 'C-0053', status: 'failed' }] },
    ],
  };
}

function kubeBenchReport() {
  return {
    Controls: [{
      text: 'Control Plane Security Configuration',
      tests: [{ results: [
        { test_number: '1.1.20', test_desc: 'PKI certificate permissions', status: 'FAIL', actual_value: 'permissions=644' },
        { test_number: '1.1.21', test_desc: 'key permissions', status: 'PASS' },
        { test_number: '1.2.1', test_desc: 'manual', status: 'WARN' },
      ] }],
    }],
  };
}

describe('check-scans.js, Kubescape', () => {
  test('a finding names its rendered file, kind, namespace and name, and what the control found', () => {
    const rows = C.check('kubescape', kubescapeReport(), { kubescape: [] }).rows;
    expect(rows.map((r) => `${r.id} ${r.where}`)).toEqual([
      'C-0017 overlays-k3s:Deployment/-/oscar',
      'C-0013 overlays-openshift:Deployment/-/oscar',
      'C-0017 overlays-openshift:Deployment/-/oscar',
      'C-0053 ServiceAccount/oscar/oscar-dispatcher',
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({ name: 'Immutable container filesystem', detail: 'spec.x.readOnlyRootFilesystem=true', state: 'NEW' }));
  });

  test('accepted by control and resource, in any file or in one; everything else is to look at', () => {
    const accepted = { kubescape: [
      { control: 'C-0017', resources: ['Deployment/-/oscar'], reason: 'a' },
      { control: 'C-0013', resources: ['overlays-openshift:Deployment/-/oscar'], reason: 'b' },
    ] };
    const result = C.check('kubescape', kubescapeReport(), accepted);
    expect(result.rows.map((r) => r.state)).toEqual(['accepted', 'accepted', 'accepted', 'NEW']);
    expect(result.problems).toEqual(['C-0053  — ServiceAccount/oscar/oscar-dispatcher']);
  });

  test('an accepted entry that matches nothing, or gives no reason, fails', () => {
    const accepted = { kubescape: [
      { control: 'C-0099', resources: ['*'], reason: 'gone' },
      { control: 'C-0053', resources: ['ServiceAccount/oscar/*'], reason: ' ' },
    ] };
    const { problems } = C.check('kubescape', kubescapeReport(), accepted);
    expect(problems).toContain('accepted C-0099 matched nothing: remove it from accepted.json');
    expect(problems).toContain('accepted entry C-0053 gives no reason');
  });

  test('a resource pattern: file or not, "*" for any part, three parts', () => {
    const m = C.matchesResource;
    expect(m('*', 'x:Job/a/b')).toBe(true);
    expect(m('Job/a/*', 'run-pod-job:Job/a/b')).toBe(true);
    expect(m('run-pod-job:Job/*/*', 'kept-pod-job:Job/a/b')).toBe(false);
    expect(m('*:Job/a/b', 'kept-pod-job:Job/a/b')).toBe(true);
    expect(m('Job/a', 'Job/a/b')).toBe(false);
  });

  test('not a Kubescape report: said, with what it holds', () => {
    expect(() => C.check('kubescape', { Controls: [] }, {})).toThrow(/not a Kubescape JSON report.*Controls/);
  });
});

describe('check-scans.js, kube-bench', () => {
  test('FAIL is a finding, WARN (the benchmark\'s manual checks) is listed only, PASS is not shown', () => {
    const result = C.check('kube-bench', kubeBenchReport(), { 'kube-bench': [] });
    expect(result.rows.map((r) => [r.id, r.state])).toEqual([['1.1.20', 'NEW'], ['1.2.1', 'manual']]);
    expect(result.rows[0].detail).toBe('permissions=644');
    expect(result.problems).toEqual(['1.1.20 PKI certificate permissions — Control Plane Security Configuration']);
  });

  test('accepted by its number', () => {
    const result = C.check('kube-bench', kubeBenchReport(), { 'kube-bench': [{ check: '1.1.20', reason: 'r' }] });
    expect(result.problems).toEqual([]);
    expect(result.fresh).toBe(0);
  });
});

// Shaped like `trivy config --format json`: a result per file read, a
// Dockerfile in a folder of its own, the render's files by name.
function trivyReport() {
  return {
    SchemaVersion: 2,
    Results: [
      { Target: 'dockerfile-run/Dockerfile', Class: 'config', Type: 'dockerfile', Misconfigurations: [
        { ID: 'DS026', Title: 'No HEALTHCHECK defined', Message: 'Add HEALTHCHECK instruction in your Dockerfile', Severity: 'LOW', Status: 'FAIL' },
        { ID: 'DS002', Title: 'Image user should not be root', Message: 'Specify at least 1 USER command', Severity: 'HIGH', Status: 'PASS' },
      ] },
      { Target: 'overlays-k3s.yaml', Class: 'config', Type: 'kubernetes', Misconfigurations: [
        { ID: 'KSV014', Title: 'Root file system is not read-only', Message: "Container 'oscar' of Deployment 'oscar' should set 'securityContext.readOnlyRootFilesystem' to true", Severity: 'HIGH', Status: 'FAIL' },
        { ID: 'KSV113', Title: 'Manage namespace secrets', Message: "Role 'oscar-dispatcher' shouldn't have access to manage secrets in namespace 'oscar-runs'", Severity: 'MEDIUM', Status: 'FAIL' },
      ] },
      { Target: 'overlays-openshift.yaml', Class: 'config', Type: 'kubernetes' },
    ],
  };
}

describe('check-scans.js, Trivy (#1453)', () => {
  test('a finding names its Dockerfile\'s folder or its rendered file, and the resource its message names', () => {
    const rows = C.check('trivy', trivyReport(), { trivy: [] }).rows;
    expect(rows.map((r) => `${r.id} ${r.where}`)).toEqual([
      'DS026 dockerfile-run',
      'KSV014 overlays-k3s:Deployment/oscar',
      'KSV113 overlays-k3s:Role/oscar-dispatcher',
    ]);
    expect(rows[1]).toEqual(expect.objectContaining({
      name: 'Root file system is not read-only', state: 'NEW',
      detail: "HIGH: Container 'oscar' of Deployment 'oscar' should set 'securityContext.readOnlyRootFilesystem' to true",
    }));
  });

  test('accepted by check and what it covers; everything else is to look at', () => {
    const accepted = { trivy: [
      { check: 'DS026', resources: ['dockerfile-run'], reason: 'a' },
      { check: 'KSV014', resources: ['Deployment/oscar'], reason: 'b' },
    ] };
    const result = C.check('trivy', trivyReport(), accepted);
    expect(result.rows.map((r) => r.state)).toEqual(['accepted', 'accepted', 'NEW']);
    expect(result.problems).toEqual(['KSV113 Manage namespace secrets — overlays-k3s:Role/oscar-dispatcher']);
  });

  test('an entry that matches nothing fails, as for Kubescape', () => {
    const { problems } = C.check('trivy', trivyReport(), { trivy: [{ check: 'KSV014', resources: ['overlays-openshift'], reason: 'r' }] });
    expect(problems).toContain('accepted KSV014 matched nothing: remove it from accepted.json');
  });

  test('what an entry covers: a file, a file and resource, a resource in any file, "*" for any part', () => {
    const m = C.matchesTrivy;
    expect(m('*', 'overlays-k3s:Deployment/oscar')).toBe(true);
    expect(m('overlays-k3s', 'overlays-k3s:Deployment/oscar')).toBe(true);
    expect(m('overlays-k3s', 'overlays-openshift:Deployment/oscar')).toBe(false);
    expect(m('overlays-k3s:Deployment/*', 'overlays-k3s:Deployment/oscar')).toBe(true);
    expect(m('*:Role/oscar-dispatcher', 'runs:Role/oscar-dispatcher')).toBe(true);
    expect(m('Deployment/oscar', 'monitoring-stack:Deployment/oscar')).toBe(true);
    expect(m('Deployment/oscar', 'dockerfile-run')).toBe(false);
    expect(m('Deployment/oscar/x', 'overlays-k3s:Deployment/oscar')).toBe(false);
    expect(m('dockerfile-run', 'dockerfile-run')).toBe(true);
  });

  test('the file of a result, and the resource of a message', () => {
    expect(C.trivyTarget('dockerfile-server/Dockerfile')).toBe('dockerfile-server');
    expect(C.trivyTarget('/tmp/x/overlays-k3s.yaml')).toBe('overlays-k3s');
    expect(C.trivyTarget('run-pod-job.json')).toBe('run-pod-job');
    expect(C.trivyResource("Container 'c' of StatefulSet 'loki' should set …")).toBe('StatefulSet/loki');
    expect(C.trivyResource("ClusterRole 'x' should not …")).toBe('ClusterRole/x');
    expect(C.trivyResource('Container run in job oscar-pod-kept-scan (namespace: oscar-runs) uses an image from an untrusted registry.')).toBe('Job/oscar-pod-kept-scan');
    expect(C.trivyResource('deployment oscar in default namespace should set metadata.namespace to a non-default namespace')).toBe('Deployment/oscar');
    // kustomize's content hash is left out: it changes with every setting.
    expect(C.trivyResource("ConfigMap 'oscar-settings-26d6768gk7' in 'default' namespace stores sensitive contents")).toBe('ConfigMap/oscar-settings');
    expect(C.trivyResource("Role 'oscar-settings-26d6768gk7' should not …")).toBe('Role/oscar-settings-26d6768gk7');
    expect(C.trivyResource('Specify at least 1 USER command')).toBe('');
    expect(C.trivyResource('A resource quota policy with hard memory and CPU limits should be configured per namespace')).toBe('');
  });

  test('a report with nothing found has no finding; not a Trivy report is said', () => {
    expect(C.check('trivy', { SchemaVersion: 2 }, { trivy: [] }).rows).toEqual([]);
    expect(() => C.check('trivy', { Controls: [] }, {})).toThrow(/not a Trivy JSON report.*Controls/);
    expect(() => C.check('trivy', [], {})).toThrow(/not a Trivy JSON report/);
  });
});

describe('check-scans.js, its output', () => {
  test('the summary escapes a backslash, then the column bar', () => {
    const md = C.markdown('kubescape', { rows: [{ state: 'NEW', id: String.raw`a\|b`, name: 'n', where: 'w', times: 2, detail: '', reason: '' }], problems: ['x'] });
    expect(md).toContain(String.raw`| NEW | a\\\|b | n | w (×2) |`);
    expect(md).toContain('**1 to look at.**');
  });

  test('main(): exit 1 on a finding, 0 when every one is accepted, 2 for a wrong call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oscar-scans-'));
    try {
      const file = path.join(dir, 'bench.json');
      fs.writeFileSync(file, JSON.stringify({ Controls: [{ text: 'x', tests: [{ results: [{ test_number: '9.9.9', status: 'PASS' }] }] }] }));
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      const err = jest.spyOn(console, 'error').mockImplementation(() => {});
      const saved = process.env.GITHUB_STEP_SUMMARY;
      delete process.env.GITHUB_STEP_SUMMARY;
      try {
        // accepted.json's kube-bench entries match nothing in this report.
        expect(C.main(['kube-bench', file])).toBe(1);
        expect(C.main(['grype', file])).toBe(2);
      } finally {
        if (saved !== undefined) process.env.GITHUB_STEP_SUMMARY = saved;
        log.mockRestore();
        err.mockRestore();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('accepted.json', () => {
  const accepted = JSON.parse(read('OSCAR_Deploy/kubernetes/scans/accepted.json'));

  test('every entry names what it accepts and why', () => {
    for (const e of accepted.kubescape) {
      expect([e.control, /^C-\d{4}$/.test(e.control)]).toEqual([e.control, true]);
      expect(e.resources.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(40);
    }
    for (const e of accepted['kube-bench']) {
      expect([e.check, /^\d+(\.\d+)+$/.test(e.check)]).toEqual([e.check, true]);
      expect(e.reason.length).toBeGreaterThan(40);
    }
    expect(Array.isArray(accepted.trivy)).toBe(true);
    for (const e of accepted.trivy) {
      expect([e.check, /^[A-Z]{2,4}-?\d{3,5}$/.test(e.check)]).toEqual([e.check, true]);
      expect(e.resources.length).toBeGreaterThan(0);
      expect(e.reason.length).toBeGreaterThan(40);
    }
  });

  test('the run pods, the dispatcher\'s reading of Secrets and the server\'s writable root are not accepted: they are fixed', () => {
    expect(accepted.kubescape.some((e) => e.resources.some((r) => r.includes('pod-job')))).toBe(false);
    expect(accepted.kubescape.some((e) => e.control === 'C-0015')).toBe(false);
    expect(accepted.kubescape.some((e) => e.control === 'C-0017')).toBe(false);
  });
});

describe('the run pods, as scanned', () => {
  test('the k3s overlay names their uid and group, and the scan renders them so', () => {
    const k3s = yaml.load(read('OSCAR_Deploy/kubernetes/overlays/k3s/kustomization.yaml'));
    const patch = k3s.patches.map((p) => p.patch).filter(Boolean).map((p) => yaml.load(p))
      .find((p) => p.kind === 'ConfigMap' && p.metadata.name === 'oscar-dispatcher-settings');
    expect(patch.data.RUN_POD_USER).toBe('1000:1000');
    expect(read('OSCAR_Deploy/kubernetes/scans/render.sh')).toContain('RUN_POD_USER="$RUN_POD_USER" node');
    const saved = process.env.RUN_POD_USER;
    process.env.RUN_POD_USER = patch.data.RUN_POD_USER;
    try {
      const jobs = require(path.join(SCANS, 'run-pods.js')).jobs();
      for (const job of Object.values(jobs)) {
        expect(job.metadata.namespace).toBe('oscar-runs');
        expect(job.spec.template.spec.securityContext).toEqual(expect.objectContaining({ runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000 }));
      }
    } finally {
      if (saved === undefined) delete process.env.RUN_POD_USER; else process.env.RUN_POD_USER = saved;
    }
  });
});

describe('the pinned tools', () => {
  const workflow = yaml.load(read('.github/workflows/ci-kubernetes.yml'));
  const guide = read('Documentation/Server_Operations/OSCAR - k3s on one VPS.md');
  const kubescape = workflow.jobs.kubescape.env;
  const bench = workflow.jobs.k3s.steps.find((s) => /kube-bench/.test(s.name)).env;

  test('Kubescape and kube-bench: an exact version and its sha256, the same in the CI and the guide', () => {
    expect(kubescape.KUBESCAPE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(kubescape.KUBESCAPE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(bench.KUBE_BENCH_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bench.KUBE_BENCH_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(guide).toContain(`${kubescape.KUBESCAPE_SHA256}  kubescape_${kubescape.KUBESCAPE_VERSION}_linux_amd64.tar.gz`);
    expect(guide).toContain(`${bench.KUBE_BENCH_SHA256}  kube-bench_${bench.KUBE_BENCH_VERSION}_linux_amd64.tar.gz`);
    expect(guide).toContain(`--benchmark ${bench.KUBE_BENCH_BENCHMARK}`);
  });

  test('every download is checked before it is used', () => {
    const steps = [...workflow.jobs.kubescape.steps, ...workflow.jobs.k3s.steps].map((s) => s.run || '').join('\n');
    expect(steps.match(/sha256sum -c -/g).length).toBeGreaterThanOrEqual(2);
  });
});
