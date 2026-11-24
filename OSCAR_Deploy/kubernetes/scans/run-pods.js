// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// run-pods.js <folder> — a run pod's Job and a kept pod's Job, as the
// dispatcher makes them, written as JSON for the scanners (#1438). No
// manifest holds them: the dispatcher builds them at each run. The settings
// are those of the pod-runs component (components/pod-runs), read by the
// dispatcher's own settingsOf().

const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', '..', 'Oscar_Server', 'src', 'run-dispatcher');
const { runJob, keptPodJob } = require(path.join(SERVER, 'jobSpec.js'));
const { settingsOf } = require(path.join(SERVER, 'dispatcher.js'));

function jobs() {
  const settings = settingsOf({
    RUN_NAMESPACE: 'oscar-runs',
    RUN_IMAGE: 'ghcr.io/top-phe/oscar-run:release-scan',
    RUN_RESULTS_URL: 'http://oscar-internal.oscar.svc:3003',
  });
  // The dispatcher names the namespace in the address it posts to; the
  // scanners read it from the object.
  const inNamespace = (job) => ({ ...job, metadata: { ...job.metadata, namespace: settings.namespace } });
  return {
    'run-pod-job.json': inNamespace(runJob({ runId: '00000000-0000-4000-8000-000000000000', deadlineSeconds: 1800 }, settings)),
    'kept-pod-job.json': inNamespace(keptPodJob({ podId: 'kept-scan', deadlineSeconds: 3600 }, settings)),
  };
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) { console.error('usage: run-pods.js <folder>'); process.exit(2); }
  for (const [file, job] of Object.entries(jobs())) {
    fs.writeFileSync(path.join(out, file), `${JSON.stringify(job, null, 2)}\n`);
    console.log(`${file}: ${job.kind} ${job.metadata.name}`);
  }
}

module.exports = { jobs };
