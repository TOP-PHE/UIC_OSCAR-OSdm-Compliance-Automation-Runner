// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * The run image's entrypoint (run isolation, option 4, #1130): one run, then
 * the pod ends with Bruno's exit code. See runPod.js.
 */

/* istanbul ignore next: the process entry point */
require('./runPod').runPod().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`[run-pod] Failed: ${err?.message || err}\n`);
    process.exit(1);
  },
);
