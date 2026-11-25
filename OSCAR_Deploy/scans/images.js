// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// images.js — the images the weekly scan reads (#1453). No dependency.
//
//   node images.js list              the current release's images on GHCR,
//                                    then every third-party image a
//                                    deployment file pins, one per line
//   node images.js chart             "<repo> <chart> <version>" of the
//                                    kube-prometheus-stack the k3s
//                                    monitoring installs
//   node images.js chart-values      that chart's values (valuesContent)
//   node images.js from-render < f   the images of a `helm template` output,
//                                    read from stdin
//
// A pinned image is an `image:` line of a Docker Compose or Kubernetes file
// of the deployments, or a Dockerfile's FROM, written as a full reference
// (a name with a tag or a digest). OSCAR's own images and the placeholders a
// deployment fills in (oscar-bundle, ${OSCAR_IMAGE_DIGEST}) are left out: the
// release's images stand for them.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const OWN = 'ghcr.io/top-phe/';
const RELEASE_IMAGES = ['oscar-server', 'oscar', 'oscar-run'];
const CHART_FILE = 'OSCAR_Deploy/kubernetes/monitoring/stack/kube-prometheus-stack.yaml';

function isDeploymentFile(name, rel) {
  if (/^docker-compose.*\.ya?ml$/.test(name)) return true;
  if (/^Dockerfile(\..+)?$/.test(name)) return !name.endsWith('.dockerignore');
  return /\.ya?ml$/.test(name) && rel.startsWith('OSCAR_Deploy/kubernetes/');
}

// The deployment files read, relative to the repository. The CI's own
// overlays (kubernetes/ci) name images built in the job, not pinned ones.
function deploymentFiles(root = ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (rel !== 'OSCAR_Deploy/kubernetes/ci') walk(rel);
      } else if (isDeploymentFile(entry.name, rel)) {
        files.push(rel);
      }
    }
  };
  walk('OSCAR_Deploy');
  for (const extra of ['Oscar_Server/Dockerfile', 'OSDM_Simulator/deploy/docker-compose.yml']) {
    if (fs.existsSync(path.join(root, extra))) files.push(extra);
  }
  return [...new Set(files)].sort();
}

// A full reference: a name with a tag or a digest, nothing left to fill in.
function isPinned(ref) {
  return /^[a-z0-9][a-z0-9._/-]*(:[\w][\w.-]*)?(@sha256:[0-9a-f]{64})?$/.test(ref)
    && (/@sha256:/.test(ref) || /:[\w][\w.-]*$/.test(ref.split('/').pop()));
}

function imagesOfText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?image:\s*["']?([^"'\s#]+)["']?\s*(?:#.*)?$/.exec(line)
      || /^FROM\s+(?:--platform=\S+\s+)?(\S+)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function pinnedImages(root = ROOT) {
  const found = new Set();
  for (const file of deploymentFiles(root)) {
    for (const ref of imagesOfText(fs.readFileSync(path.join(root, file), 'utf8'))) {
      if (isPinned(ref) && !ref.startsWith(OWN)) found.add(ref);
    }
  }
  return [...found].sort();
}

function releaseImages(root = ROOT) {
  const { current_release: release } = JSON.parse(fs.readFileSync(path.join(root, 'compatibility.json'), 'utf8'));
  if (!/^\d{4}\.\d+$/.test(String(release))) throw new Error(`compatibility.json: current_release "${release}" is not a release`);
  return RELEASE_IMAGES.map((name) => `${OWN}${name}:release-${release}`);
}

// The HelmChart of the k3s monitoring: repo, chart, version and values.
function chartOf(root = ROOT) {
  const text = fs.readFileSync(path.join(root, CHART_FILE), 'utf8');
  const field = (name) => {
    const m = new RegExp(`^  ${name}:\\s*(\\S+)\\s*$`, 'm').exec(text);
    if (!m) throw new Error(`${CHART_FILE}: no spec.${name}`);
    return m[1];
  };
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^  valuesContent:\s*\|-?\s*$/.test(l));
  if (start < 0) throw new Error(`${CHART_FILE}: no spec.valuesContent`);
  const values = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && !line.startsWith('    ')) break;
    values.push(line.slice(4));
  }
  return { repo: field('repo'), chart: field('chart'), version: field('version'), values: `${values.join('\n').trimEnd()}\n` };
}

// The images a rendered chart starts: its `image:` lines and the config
// reloader the Prometheus operator is told to use.
function imagesOfRender(text) {
  const found = new Set(imagesOfText(text).filter(isPinned));
  for (const m of text.matchAll(/--prometheus-config-reloader=([^\s"']+)/g)) if (isPinned(m[1])) found.add(m[1]);
  return [...found].sort();
}

function main(argv, out = process.stdout, readInput = () => fs.readFileSync(0, 'utf8')) {
  const [command] = argv;
  if (command === 'list' && argv.length === 1) out.write(`${[...releaseImages(), ...pinnedImages()].join('\n')}\n`);
  else if (command === 'chart' && argv.length === 1) {
    const c = chartOf();
    out.write(`${c.repo} ${c.chart} ${c.version}\n`);
  } else if (command === 'chart-values' && argv.length === 1) out.write(chartOf().values);
  else if (command === 'from-render' && argv.length === 1) {
    const images = imagesOfRender(readInput());
    if (images.length === 0) throw new Error('from-render: no image in what was read');
    out.write(`${images.join('\n')}\n`);
  } else {
    console.error('usage: images.js list | chart | chart-values | from-render < rendered.yaml');
    return 2;
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { deploymentFiles, isPinned, imagesOfText, pinnedImages, releaseImages, chartOf, imagesOfRender, main };
