// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * image-scans.test.js — what Trivy scans (#1453):
 *  - the required job (ci-server.yml) builds the three images a release
 *    publishes and scans each with the same rule;
 *  - the Kubernetes CI runs Trivy config on the render Kubescape reads and on
 *    the three Dockerfiles, through the accepted list;
 *  - the weekly job scans the release's images on GHCR and every image a
 *    deployment file pins (OSCAR_Deploy/scans/images.js), one job each, and
 *    sends no credential anywhere.
 */

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.join(__dirname, '..', '..', '..');
const I = require(path.join(REPO, 'OSCAR_Deploy', 'scans', 'images.js'));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const workflow = (name) => yaml.load(read(`.github/workflows/${name}`));

const ciServer = workflow('ci-server.yml');
const TRIVY_ACTION = ciServer.jobs['trivy-scan'].steps.find((s) => /trivy-action@/.test(s.uses || '')).uses;
const trivySteps = (job) => job.steps.filter((s) => /^aquasecurity\/trivy-action@/.test(s.uses || ''));

// Every `image` value of a YAML document, whatever its depth.
function imagesIn(value, out = []) {
  if (Array.isArray(value)) value.forEach((v) => imagesIn(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'image' && typeof v === 'string') out.push(v);
      else imagesIn(v, out);
    }
  }
  return out;
}

describe('the required job scans the three images a release publishes', () => {
  const job = ciServer.jobs['trivy-scan'];

  test('its name stays the required check\'s, and it builds as a release builds', () => {
    expect(job.name).toBe('Container image scan (Trivy)');
    const build = job.steps.find((s) => s.id === 'build');
    expect(build.run).toBe('OSCAR_Deploy/kubernetes/build-images.sh local trivy');
    const script = read('OSCAR_Deploy/kubernetes/build-images.sh');
    for (const name of ['oscar-server', 'oscar', 'oscar-run']) expect(script).toContain(`"$prefix/${name}:$tag"`);
  });

  test('each image with the same rule, each scan run even when another failed', () => {
    const scans = trivySteps(job);
    expect(scans.map((s) => s.with['image-ref'])).toEqual(['local/oscar-server:trivy', 'local/oscar-run:trivy', 'local/oscar:trivy']);
    for (const s of scans) {
      expect(s.uses).toBe(TRIVY_ACTION);
      expect(s.with).toEqual(expect.objectContaining({ 'exit-code': '1', 'ignore-unfixed': true, 'vuln-type': 'os,library', severity: 'CRITICAL,HIGH' }));
      expect(s.if).toBe("${{ !cancelled() && steps.build.outcome == 'success' }}");
    }
    expect(TRIVY_ACTION).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('a release\'s image is built afresh', () => {
  test('the promotion builds without the cache, so that apt-get upgrade runs at each release', () => {
    const build = workflow('promote-release.yml').jobs[Object.keys(workflow('promote-release.yml').jobs)[0]].steps
      .find((s) => /docker\/build-push-action@/.test(s.uses || ''));
    expect(build.with['no-cache']).toBe(true);
    expect(build.with['cache-from']).toBeUndefined();
    expect(read('Oscar_Server/Dockerfile')).toMatch(/apt-get upgrade -y/);
  });
});

describe('Trivy config in the Kubernetes CI', () => {
  const job = workflow('ci-kubernetes.yml').jobs.kubescape;

  test('the render Kubescape reads and the three Dockerfiles, each in a folder of its own', () => {
    const prepare = job.steps.find((s) => /What Trivy reads/.test(s.name)).run;
    expect(prepare).toContain('cp "$RUNNER_TEMP"/rendered/* "$cfg/"');
    for (const [name, file] of [['server', 'Oscar_Server/Dockerfile'], ['run', 'OSCAR_Deploy/kubernetes/Dockerfile.run'], ['bundle', 'OSCAR_Deploy/kubernetes/Dockerfile.bundle']]) {
      expect(prepare).toContain(`${name}=${file}`);
      expect(fs.existsSync(path.join(REPO, file))).toBe(true);
    }
  });

  test('every finding, through the accepted list; the scan itself never decides', () => {
    const [scan] = trivySteps(job);
    expect(scan.uses).toBe(TRIVY_ACTION);
    expect(scan.with).toEqual(expect.objectContaining({ 'scan-type': 'config', format: 'json', 'exit-code': '0', severity: 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL' }));
    expect(scan.with['scan-ref']).toBe('${{ runner.temp }}/trivy-config');
    const checkStep = job.steps.find((s) => /check-scans\.js trivy/.test(s.run || ''));
    expect(checkStep.run).toBe('node OSCAR_Deploy/kubernetes/scans/check-scans.js trivy "$RUNNER_TEMP/trivy-config.json"');
    expect(job.steps.indexOf(checkStep)).toBeGreaterThan(job.steps.indexOf(scan));
  });
});

describe('images.js: what the weekly job scans', () => {
  test('the current release\'s three images on GHCR', () => {
    const { current_release: release } = JSON.parse(read('compatibility.json'));
    expect(I.releaseImages()).toEqual(['oscar-server', 'oscar', 'oscar-run'].map((n) => `ghcr.io/top-phe/${n}:release-${release}`));
  });

  test('every image a deployment file pins, read here another way', () => {
    const expected = new Set();
    for (const file of I.deploymentFiles()) {
      const text = read(file);
      if (/Dockerfile/.test(path.basename(file))) {
        for (const m of text.matchAll(/^FROM\s+(\S+)/gm)) expected.add(m[1]);
      } else {
        for (const doc of yaml.loadAll(text)) imagesIn(doc).forEach((i) => expected.add(i));
      }
    }
    const pinned = [...expected].filter((i) => !i.startsWith('ghcr.io/top-phe/') && !i.includes('${') && i !== 'oscar-bundle');
    expect(I.pinnedImages()).toEqual(pinned.sort());
    expect(I.pinnedImages().length).toBeGreaterThanOrEqual(7);
  });

  test('a third-party image is pinned by its digest; OSCAR\'s and the placeholders are left out', () => {
    for (const ref of I.pinnedImages()) expect([ref, /@sha256:[0-9a-f]{64}$/.test(ref)]).toEqual([ref, true]);
    expect(I.isPinned('oscar-bundle')).toBe(false);
    expect(I.isPinned('ghcr.io/top-phe/oscar-server@${OSCAR_IMAGE_DIGEST:?set}')).toBe(false);
    expect(I.isPinned('quay.io/prometheus/prometheus:v3.7.0')).toBe(true);
    expect(I.isPinned('busybox')).toBe(false);
  });

  test('the chart: repo, name, version and values as the HelmChart holds them', () => {
    const helmChart = yaml.load(read('OSCAR_Deploy/kubernetes/monitoring/stack/kube-prometheus-stack.yaml'));
    const chart = I.chartOf();
    expect(chart).toEqual({
      repo: helmChart.spec.repo, chart: helmChart.spec.chart, version: helmChart.spec.version,
      values: `${helmChart.spec.valuesContent.trimEnd()}\n`,
    });
    expect(yaml.load(chart.values).grafana.image.sha).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the images of a rendered chart: its image lines and the config reloader', () => {
    const render = [
      '        - name: grafana',
      '          image: "docker.io/grafana/grafana:13.3.1-distroless@sha256:' + 'a'.repeat(64) + '"',
      '          image: quay.io/prometheus-operator/prometheus-operator:v0.86.0',
      '            - --prometheus-config-reloader=quay.io/prometheus-operator/prometheus-config-reloader:v0.86.0',
      '          image: busybox',
    ].join('\n');
    expect(I.imagesOfRender(render)).toEqual([
      `docker.io/grafana/grafana:13.3.1-distroless@sha256:${'a'.repeat(64)}`,
      'quay.io/prometheus-operator/prometheus-config-reloader:v0.86.0',
      'quay.io/prometheus-operator/prometheus-operator:v0.86.0',
    ]);
  });

  test('main(): each command, stdin for a render, 2 for a wrong call', () => {
    const written = [];
    const out = { write: (s) => written.push(s) };
    expect(I.main(['list'], out)).toBe(0);
    expect(written.join('').trim().split('\n')).toEqual([...I.releaseImages(), ...I.pinnedImages()]);
    written.length = 0;
    expect(I.main(['from-render'], out, () => '  image: grafana/loki:3.7.10')).toBe(0);
    expect(written.join('')).toBe('grafana/loki:3.7.10\n');
    expect(() => I.main(['from-render'], out, () => 'nothing')).toThrow(/no image/);
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(I.main(['from-render', '/etc/passwd'], out)).toBe(2);
      expect(I.main(['scan'], out)).toBe(2);
    } finally {
      err.mockRestore();
    }
  });
});

describe('the weekly job', () => {
  const text = read('.github/workflows/scan-images.yml');
  const weekly = yaml.load(text);

  test('every week, by hand, and on a PR changing it or a pinned image; reading the repository and nothing else', () => {
    expect(weekly.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/);
    expect(weekly.on).toHaveProperty('workflow_dispatch');
    const paths = weekly.on.pull_request.paths;
    const covered = (file) => paths.some((p) => p === file
      || (p.endsWith('/**') && file.startsWith(p.slice(0, -2)))
      || (p === 'OSCAR_Deploy/docker-compose*.yml' && /^OSCAR_Deploy\/docker-compose[^/]*\.yml$/.test(file)));
    // Every file that pins a third-party image, and the scan's own files.
    const pinning = I.deploymentFiles().filter((f) => I.imagesOfText(read(f)).some((i) => I.isPinned(i) && !i.startsWith('ghcr.io/top-phe/')));
    expect(pinning.length).toBeGreaterThanOrEqual(5);
    for (const file of [...pinning, 'OSCAR_Deploy/scans/images.js', '.github/workflows/scan-images.yml']) {
      expect([file, covered(file)]).toEqual([file, true]);
    }
    expect(paths).not.toContain('compatibility.json');
    expect(weekly.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(weekly.jobs)) expect(job.permissions).toBeUndefined();
  });

  test('no credential sent to any registry', () => {
    expect(text).not.toMatch(/secrets\.|GITHUB_TOKEN|TRIVY_USERNAME|TRIVY_PASSWORD|docker login|login-action/);
  });

  test('the list from images.js and the chart, helm pinned and checked', () => {
    const job = weekly.jobs.images;
    expect(job.env.HELM_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(job.env.HELM_SHA256).toMatch(/^[0-9a-f]{64}$/);
    const steps = job.steps.map((s) => s.run || '').join('\n');
    expect(steps).toContain('sha256sum -c -');
    for (const command of ['images.js list', 'images.js chart)', 'images.js chart-values', 'images.js from-render <']) expect(steps).toContain(command);
    expect(steps.indexOf('sha256sum -c -')).toBeLessThan(steps.indexOf('helm template'));
    // The chart's test pods run only under `helm test`, never on k3s.
    expect(steps).toMatch(/helm template [^\n]*\\\n[^\n]*--skip-tests/);
  });

  test('one job per image, every one run, the build\'s rule', () => {
    const job = weekly.jobs.scan;
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.image).toBe('${{ fromJSON(needs.images.outputs.images) }}');
    const [scan] = trivySteps(job);
    expect(scan.uses).toBe(TRIVY_ACTION);
    expect(scan.with).toEqual(expect.objectContaining({
      'image-ref': '${{ matrix.image }}', scanners: 'vuln', 'exit-code': '1', 'ignore-unfixed': true, severity: 'CRITICAL,HIGH',
    }));
  });
});
