// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The few Kubernetes API calls the run dispatcher makes (run isolation,
 * option 4, #1130), by plain node:http(s): no client library. In the cluster,
 * the pod's service account: its token (read again at each call, as the
 * kubelet renews it) and the cluster's CA. Its Role allows these calls in the
 * runs' namespace and nothing else.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const MAX_ANSWER = 4 * 1024 * 1024;
const TIMEOUT_MS = 30 * 1000;

class KubeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** The API server and credentials of the pod this runs in. */
function inClusterConfig(env = process.env, read = fs.readFileSync) {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error('not in a Kubernetes pod (KUBERNETES_SERVICE_HOST is not set)');
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  return {
    base: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    ca: read(`${SA_DIR}/ca.crt`),
    tokenFile: `${SA_DIR}/token`,
    ownNamespace: read(`${SA_DIR}/namespace`, 'utf8').trim(),
  };
}

// An answer read whole, up to MAX_ANSWER.
function readAnswer(res, resolve, reject) {
  const chunks = [];
  let size = 0;
  res.on('data', (c) => {
    size += c.length;
    if (size <= MAX_ANSWER) chunks.push(c);
  });
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
    return reject(new KubeError(res.statusCode, String(json?.message || `HTTP ${res.statusCode}`).slice(0, 300)));
  });
  res.on('error', reject);
}

/**
 * A client of the namespace `namespace`.
 * @param {{ base: string, ca?: Buffer, token?: string, tokenFile?: string, namespace: string }} config
 */
function createKubeClient({ base, ca = null, token = null, tokenFile = null, namespace }) {
  const url = new URL(base);
  const transport = url.protocol === 'https:' ? https : http;
  const bearer = () => token || (tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : '');

  function call(method, path, { body, contentType = 'application/json', stream = false } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = { Authorization: `Bearer ${bearer()}`, Accept: 'application/json' };
      if (data) Object.assign(headers, { 'Content-Type': contentType, 'Content-Length': data.length });
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || undefined,
        method,
        path,
        headers,
        ca: ca || undefined,
      }, (res) => {
        if (stream && res.statusCode >= 200 && res.statusCode < 300) return resolve(res);
        return readAnswer(res, resolve, reject);
      });
      // A followed log stays open as long as the run; any other call answers soon.
      if (!stream) req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('the API server did not answer in time')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  const ns = encodeURIComponent(namespace);
  const one = (name) => encodeURIComponent(name);
  const selector = (s) => `labelSelector=${encodeURIComponent(s)}`;
  return {
    namespace,
    createSecret: (secret) => call('POST', `/api/v1/namespaces/${ns}/secrets`, { body: secret }),
    patchSecret: (name, patch) => call('PATCH', `/api/v1/namespaces/${ns}/secrets/${one(name)}`,
      { body: patch, contentType: 'application/merge-patch+json' }),
    deleteSecret: (name) => call('DELETE', `/api/v1/namespaces/${ns}/secrets/${one(name)}`),
    listSecrets: (labels) => call('GET', `/api/v1/namespaces/${ns}/secrets?${selector(labels)}`),
    createJob: (job) => call('POST', `/apis/batch/v1/namespaces/${ns}/jobs`, { body: job }),
    getJob: (name) => call('GET', `/apis/batch/v1/namespaces/${ns}/jobs/${one(name)}`),
    deleteJob: (name) => call('DELETE', `/apis/batch/v1/namespaces/${ns}/jobs/${one(name)}?propagationPolicy=Background`),
    listJobs: (labels) => call('GET', `/apis/batch/v1/namespaces/${ns}/jobs?${selector(labels)}`),
    listPods: (labels) => call('GET', `/api/v1/namespaces/${ns}/pods?${selector(labels)}`),
    followLog: (pod, container) => call('GET',
      `/api/v1/namespaces/${ns}/pods/${one(pod)}/log?container=${encodeURIComponent(container)}&follow=true`, { stream: true }),
  };
}

module.exports = { createKubeClient, inClusterConfig, KubeError };
