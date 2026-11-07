// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The Kubernetes objects of one run in a pod of its own (run isolation,
 * option 4, #1130): a Secret holding the run's inputs, and a Job running the
 * run image once. Pure: what the dispatcher sends to the API server.
 *
 * The pod is held to the "restricted" pod security standard and more: no
 * service account token, no service links, a read-only root file system
 * (its work folder and /tmp are emptyDirs), every capability dropped, no
 * privilege escalation, the RuntimeDefault seccomp profile, never restarted.
 * The Job ends at the run's deadline and is removed after it.
 */

const MANAGED_BY = 'oscar-dispatcher';
const LABELS = Object.freeze({
  'app.kubernetes.io/name': 'oscar-run',
  'app.kubernetes.io/managed-by': MANAGED_BY,
});
const RUN_ID_LABEL = 'oscar.uic.org/run-id';
const CONTAINER = 'run';
// What a Job leaves once it ends, in case the dispatcher could not remove it.
const TTL_AFTER_FINISHED_S = 300;
// The pod has a little more than the run's own budget to send its results.
const DEADLINE_MARGIN_S = 120;

/** The label selector of every object the dispatcher makes. */
const MANAGED_SELECTOR = `app.kubernetes.io/managed-by=${MANAGED_BY}`;

/** The name of a run's Job and Secret. */
function jobNameOf(runId) {
  return `oscar-run-${runId}`;
}

/** The Secret holding the run pod's inputs (its environment). */
function runSecret({ runId, envName, envYml, env, resultsUrl }) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: jobNameOf(runId), labels: { ...LABELS, [RUN_ID_LABEL]: runId } },
    type: 'Opaque',
    stringData: {
      ...env,
      OSCAR_RUN_ID: runId,
      OSCAR_ENV_NAME: envName,
      OSCAR_RUN_ENV_YML: envYml,
      OSCAR_RESULTS_URL: resultsUrl,
    },
  };
}

/**
 * The Job of one run.
 * @param {object} run       { runId, deadlineSeconds }
 * @param {object} settings  { image, serviceAccount, cpuRequest, cpuLimit,
 *                             memoryRequest, memoryLimit, runtimeClass? }
 */
function runJob({ runId, deadlineSeconds }, settings) {
  const name = jobNameOf(runId);
  const labels = { ...LABELS, [RUN_ID_LABEL]: runId };
  const podSpec = {
    restartPolicy: 'Never',
    serviceAccountName: settings.serviceAccount,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
    containers: [{
      name: CONTAINER,
      image: settings.image,
      envFrom: [{ secretRef: { name } }],
      resources: {
        requests: { cpu: settings.cpuRequest, memory: settings.memoryRequest },
        limits: { cpu: settings.cpuLimit, memory: settings.memoryLimit },
      },
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ['ALL'] },
      },
      volumeMounts: [{ name: 'work', mountPath: '/work' }, { name: 'tmp', mountPath: '/tmp' }],
    }],
    volumes: [{ name: 'work', emptyDir: {} }, { name: 'tmp', emptyDir: {} }],
  };
  if (settings.runtimeClass) podSpec.runtimeClassName = settings.runtimeClass;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadlineSeconds + DEADLINE_MARGIN_S,
      ttlSecondsAfterFinished: TTL_AFTER_FINISHED_S,
      template: { metadata: { labels }, spec: podSpec },
    },
  };
}

/** The Secret's owner: the Job, so that removing the Job removes it too. */
function ownedBy(job) {
  return {
    metadata: {
      ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: job.metadata.name, uid: job.metadata.uid }],
    },
  };
}

module.exports = {
  runSecret, runJob, ownedBy, jobNameOf,
  LABELS, RUN_ID_LABEL, CONTAINER, MANAGED_SELECTOR, DEADLINE_MARGIN_S, TTL_AFTER_FINISHED_S,
};
