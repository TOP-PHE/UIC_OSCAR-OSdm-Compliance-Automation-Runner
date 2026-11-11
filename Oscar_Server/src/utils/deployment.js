// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

/**
 * Where this server runs (#1187): 'kubernetes' (every pod has
 * KUBERNETES_SERVICE_HOST) or 'docker' (the VPS). The admin pages point by it:
 * on Kubernetes Prometheus's own page is not published (guide "OSCAR - k3s on
 * one VPS", section 8a), its queries run in Grafana's Explore.
 */
function deploymentKind(env = process.env) {
  return env.KUBERNETES_SERVICE_HOST ? 'kubernetes' : 'docker';
}

module.exports = { deploymentKind };
