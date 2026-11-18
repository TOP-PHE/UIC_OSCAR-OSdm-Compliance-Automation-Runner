// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The run image's entrypoint (run isolation, option 4, #1130). With a pod's
 * secret in its environment it is a pod kept for the runs of one batch
 * (keptPod.js, #1309); without, one run, then the pod ends with Bruno's exit
 * code (runPod.js).
 */

/* istanbul ignore next: the process entry point */
const start = process.env.OSCAR_POD_SECRET ? require('./keptPod').keptPod : require('./runPod').runPod;
/* istanbul ignore next: the process entry point */
start().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[run-pod] Failed: ${err?.message || err}\n`);
    process.exit(1);
  },
);
