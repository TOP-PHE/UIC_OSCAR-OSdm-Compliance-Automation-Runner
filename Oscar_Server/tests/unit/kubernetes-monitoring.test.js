// Copyright [2026] [International Union of Railways (UIC)]
//
//    Licensed under the Apache License, Version 2.0 (the "License");
//    you may not use this file except in compliance with the License.
//    You may obtain a copy of the License at
//        http://www.apache.org/licenses/LICENSE-2.0

'use strict';

// #1147: OSCAR's monitoring on Kubernetes (OSCAR_Deploy/kubernetes/monitoring)
// held to what OSCAR, the VPS's monitoring and the run dispatcher give it. The
// k3s job of ci-kubernetes.yml installs it on a real k3s and checks what it
// reads; this file catches, in the required job, a name, label, port or rule
// that drifts from them.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const REPO = path.resolve(__dirname, '../../..');
const DEPLOY = path.join(REPO, 'OSCAR_Deploy');
const MON = path.join(DEPLOY, 'kubernetes/monitoring');

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const docs = (rel) => yaml.loadAll(read(rel)).filter(Boolean);
const one = (rel, kind, name) => docs(rel).find(d => d.kind === kind && (!name || d.metadata.name === name));

const stack = yaml.load(read('OSCAR_Deploy/kubernetes/monitoring/stack/kustomization.yaml'));
const helmChart = one('OSCAR_Deploy/kubernetes/monitoring/stack/kube-prometheus-stack.yaml', 'HelmChart');
const values = yaml.load(helmChart.spec.valuesContent);
const grafanaIni = values.grafana['grafana.ini'];
const middleware = one('OSCAR_Deploy/kubernetes/monitoring/stack/grafana-ingress.yaml', 'Middleware');
const grafanaIngress = one('OSCAR_Deploy/kubernetes/monitoring/stack/grafana-ingress.yaml', 'Ingress');
const policies = docs('OSCAR_Deploy/kubernetes/monitoring/stack/network-policy.yaml');
const alloyDocs = docs('OSCAR_Deploy/kubernetes/monitoring/stack/alloy.yaml');
const alloyConfig = read('OSCAR_Deploy/kubernetes/monitoring/stack/config.alloy');
const lokiDocs = docs('OSCAR_Deploy/kubernetes/monitoring/stack/loki.yaml');
const oscarPart = yaml.load(read('OSCAR_Deploy/kubernetes/monitoring/oscar/kustomization.yaml'));
const serviceMonitor = one('OSCAR_Deploy/kubernetes/monitoring/oscar/service-monitor.yaml', 'ServiceMonitor');
const clusterRules = one('OSCAR_Deploy/kubernetes/monitoring/oscar/cluster-rules.yaml', 'PrometheusRule');
const k8sDashboard = JSON.parse(read('OSCAR_Deploy/kubernetes/monitoring/oscar/dashboards/oscar-kubernetes.json'));
const vpsPrometheus = yaml.load(read('OSCAR_Deploy/prometheus/prometheus.yml'));
const compose = yaml.load(read('OSCAR_Deploy/docker-compose.metrics.yml'));
const workflowText = read('.github/workflows/ci-kubernetes.yml');
const workflow = yaml.load(workflowText);
const k3sSteps = workflow.jobs.k3s.steps.map(s => s.run || '').join('\n');
const guide = read('Documentation/Server_Operations/OSCAR - k3s on one VPS.md');

// Every PromQL expression of a dashboard, however deep its panels are.
function exprsOf(dashboard) {
  const out = [];
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.expr === 'string') out.push(v.expr);
      Object.values(v).forEach(walk);
    }
  })(dashboard);
  return out;
}

// Every datasource uid a dashboard names.
function datasourceUidsOf(dashboard) {
  const out = new Set();
  (function walk(v) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (v.datasource && typeof v.datasource === 'object' && v.datasource.uid) out.add(v.datasource.uid);
      Object.values(v).forEach(walk);
    }
  })(dashboard);
  return out;
}

const vpsDashboards = fs.readdirSync(path.join(DEPLOY, 'grafana/dashboards')).filter(f => f.endsWith('.json'));

describe('the chart (kube-prometheus-stack, by k3s\'s Helm controller)', () => {
  test('one pinned version from the chart\'s own repository, installed in monitoring', () => {
    expect(helmChart.apiVersion).toBe('helm.cattle.io/v1');
    expect(helmChart.metadata.namespace).toBe('kube-system');
    expect(helmChart.spec.repo).toBe('https://prometheus-community.github.io/helm-charts');
    expect(helmChart.spec.chart).toBe('kube-prometheus-stack');
    expect(helmChart.spec.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(helmChart.spec.targetNamespace).toBe(one('OSCAR_Deploy/kubernetes/monitoring/stack/namespace.yaml', 'Namespace').metadata.name);
  });

  test('nothing looked for that k3s runs inside its own process', () => {
    for (const k of ['kubeControllerManager', 'kubeScheduler', 'kubeProxy', 'kubeEtcd']) expect(values[k].enabled).toBe(false);
    for (const r of ['etcd', 'kubeControllerManager', 'kubeProxy', 'kubeSchedulerAlerting', 'kubeSchedulerRecording']) {
      expect(values.defaultRules.rules[r]).toBe(false);
    }
  });

  test('Prometheus reads every ServiceMonitor and rule of the cluster, at the VPS\'s pace and for its time', () => {
    const spec = values.prometheus.prometheusSpec;
    for (const k of ['serviceMonitor', 'podMonitor', 'rule', 'probe', 'scrapeConfig']) expect(spec[`${k}SelectorNilUsesHelmValues`]).toBe(false);
    expect(spec.scrapeInterval).toBe(vpsPrometheus.global.scrape_interval);
    expect(spec.evaluationInterval).toBe(vpsPrometheus.global.evaluation_interval);
    const vpsRetention = compose.services.prometheus.command.find(c => c.startsWith('--storage.tsdb.retention.time=')).split('=')[1];
    expect(spec.retention).toBe(vpsRetention);
    expect(spec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage).toBeDefined();
  });

  test('Alertmanager\'s configuration is the Secret the guide makes, never a value here', () => {
    expect(values.alertmanager.alertmanagerSpec).toMatchObject({ useExistingSecret: true, configSecret: 'oscar-alertmanager' });
    expect(values.alertmanager.config).toBeUndefined();
    expect(guide).toContain('kubectl -n monitoring create secret generic oscar-alertmanager --from-file=alertmanager.yaml=');
    expect(k3sSteps).toContain('kubectl -n monitoring create secret generic oscar-alertmanager --from-file=alertmanager.yaml=');
    // The example: the VPS's receiver, and the chart's two alerts that must
    // not be mailed.
    const example = yaml.load(read('OSCAR_Deploy/kubernetes/monitoring/alertmanager.yaml.example'));
    const vps = yaml.load(read('OSCAR_Deploy/alertmanager/alertmanager.yml.example'));
    expect(example.route.receiver).toBe(vps.route.receiver);
    expect(example.inhibit_rules).toEqual(vps.inhibit_rules);
    expect(example.route.routes[0]).toEqual({ matchers: ['alertname =~ "Watchdog|InfoInhibitor"'], receiver: 'null' });
    expect(example.receivers.map(r => r.name)).toEqual(['null', vps.route.receiver]);
  });

  test('the machine\'s exporter, on the host\'s network, answers Prometheus\'s account only', () => {
    const ne = values['prometheus-node-exporter'];
    expect(ne.kubeRBACProxy.enabled).toBe(true);
    expect(ne.prometheus.monitor).toEqual({
      scheme: 'https',
      bearerTokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
      tlsConfig: { insecureSkipVerify: true },
    });
  });

  test('Grafana: the VPS\'s version, by digest, its users kept, nothing pulled to chown', () => {
    const vpsImage = compose.services.grafana.image;
    const vpsVersion = /^grafana\/grafana:([^@]+)@/.exec(vpsImage)[1];
    expect(values.grafana.image.tag).toBe(`${vpsVersion}-distroless`);
    expect(values.grafana.image.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(values.grafana.persistence.enabled).toBe(true);
    expect(values.grafana.initChownData.enabled).toBe(false);
  });
});

describe('Grafana behind OSCAR\'s sign-in (Traefik ForwardAuth)', () => {
  const host = grafanaIngress.spec.rules[0].host;
  const k3sIngress = yaml.load(read('OSCAR_Deploy/kubernetes/overlays/k3s/ingress.yaml'));

  test('on OSCAR\'s host, at /grafana, the URL Grafana builds its links from', () => {
    expect(host).toBe(k3sIngress.spec.rules[0].host);
    expect(grafanaIni.server).toEqual({ domain: host, root_url: `https://${host}/grafana/`, serve_from_sub_path: true });
    expect(grafanaIngress.spec.rules[0].http.paths).toEqual([{
      path: '/grafana', pathType: 'Prefix',
      // The chart names Grafana after its release, the HelmChart's name.
      backend: { service: { name: `${helmChart.metadata.name}-grafana`, port: { number: 80 } } },
    }]);
    const annotations = grafanaIngress.metadata.annotations;
    const oscarAnnotations = k3sIngress.metadata.annotations;
    for (const k of ['entrypoints', 'tls', 'tls.certresolver']) {
      expect(annotations[`traefik.ingress.kubernetes.io/router.${k}`]).toBe(oscarAnnotations[`traefik.ingress.kubernetes.io/router.${k}`]);
    }
    // Traefik names a middleware of the Ingress's namespace <namespace>-<name>.
    expect(annotations['traefik.ingress.kubernetes.io/router.middlewares'])
      .toBe(`${middleware.metadata.namespace}-${middleware.metadata.name}@kubernetescrd`);
    expect(middleware.metadata.namespace).toBe(grafanaIngress.metadata.namespace);
    // The admin dashboard's links go there.
    expect(read('Oscar_Server/public/admin-dashboard.html')).toContain('href="/grafana/"');
  });

  test('Traefik asks OSCAR\'s sso-check, with the session only, at OSCAR\'s Service', () => {
    const fa = middleware.spec.forwardAuth;
    const url = new URL(fa.address);
    const service = yaml.load(read('OSCAR_Deploy/kubernetes/base/service.yaml'));
    expect(url.protocol).toBe('http:');
    expect(url.hostname).toBe(`${service.metadata.name}.oscar.svc.cluster.local`);
    expect(Number(url.port)).toBe(service.spec.ports.find(p => p.name === 'http').port);
    expect(url.pathname).toBe('/v1/auth/sso-check');
    // The route answers administrators only, with these two headers.
    const auth = read('Oscar_Server/src/api/routes/auth.js');
    expect(auth).toMatch(/router\.get\('\/sso-check'/);
    expect(read('Oscar_Server/src/server.js')).toMatch(/app\.use\('\/v1\/auth',/);
    for (const h of fa.authResponseHeaders) expect(auth).toContain(`.set('${h}'`);
    expect(fa.authRequestHeaders).toEqual(['Cookie', 'Authorization']);
    expect(fa.trustForwardHeader).toBeUndefined();
  });

  test('Grafana takes the user from the header Traefik sets from OSCAR\'s answer, and from nothing else', () => {
    const proxy = grafanaIni['auth.proxy'];
    expect(proxy.enabled).toBe(true);
    // Traefik removes a header of authResponseHeaders the visitor sent before
    // it adds OSCAR's: the visitor cannot choose it.
    expect(middleware.spec.forwardAuth.authResponseHeaders).toContain(proxy.header_name);
    expect(proxy.headers).toBe(`Email:${proxy.header_name} Role:X-User-Role`);
    expect(middleware.spec.forwardAuth.authResponseHeaders).toContain('X-User-Role');
    expect(grafanaIni.auth.disable_login_form).toBe(true);
    expect(grafanaIni['auth.anonymous'].enabled).toBe(false);
    expect(grafanaIni['auth.basic'].enabled).toBe(false);
    // As on the VPS.
    expect(grafanaIni.users.auto_assign_org_role).toBe(compose.services.grafana.environment.GF_USERS_AUTO_ASSIGN_ORG_ROLE);
  });

  test('an ended session goes to OSCAR\'s sign-in page, then back to Grafana, as on the VPS (#1199)', () => {
    // Traefik 3.7's authSigninURL: a 401 from the check becomes a 302 there.
    // A path, so the same host and nothing for the guide's sed to replace.
    const signin = middleware.spec.forwardAuth.authSigninURL;
    expect(signin).toBe('/index.html?next=/grafana/');
    expect(grafanaIni.server.root_url).toMatch(/\/grafana\/$/);
    // The VPS's nginx sends a 401 to the same page with the same parameter.
    expect(read('OSCAR_Deploy/nginx/oscar-metrics.conf.snippet')).toContain('return 302 /index.html?next=$request_uri;');
    // The page follows it back to Grafana (ui-scripts.test.js runs the function).
    expect(read('Oscar_Server/public/index.html')).toContain("nextAfterSignIn(window.location.search) || '/welcome.html'");
    // k3s ships a Traefik that has the field: 3.7.15 with the release the guide pins.
    expect(guide).toMatch(/INSTALL_K3S_VERSION=v1\.(3[6-9]|[4-9]\d)\./);
  });

  test('OSCAR\'s administrators are Grafana Editors, on the cluster and on the VPS (#1193)', () => {
    // Grafana's auth proxy takes the Role header only when it is one of its
    // own roles, and sets it at each sign-in (getRoles(), IsValid()); any
    // other word is ignored and the user stays at auto_assign_org_role, a
    // Viewer, who has no Explore. sso-check answers that header.
    const authRoute = read('Oscar_Server/src/api/routes/auth.js');
    const role = /^const GRAFANA_ROLE = '(\w+)';$/m.exec(authRoute);
    expect(role).not.toBeNull();
    expect(role[1]).toBe('Editor');
    expect(['Viewer', 'Editor', 'Admin']).toContain(role[1]);
    expect(authRoute).toContain(".set('X-User-Role',  GRAFANA_ROLE)");
    // The cluster maps it (above). The VPS: Grafana maps it, nginx passes it on
    // from OSCAR's answer and sets it itself, so a visitor cannot choose it.
    expect(compose.services.grafana.environment.GF_AUTH_PROXY_HEADERS.split(' ')).toContain('Role:X-User-Role');
    const nginx = read('OSCAR_Deploy/nginx/oscar-metrics.conf.snippet');
    expect(nginx).toMatch(/auth_request_set\s+\$sso_role\s+\$upstream_http_x_user_role;/);
    expect(nginx).toMatch(/proxy_set_header\s+X-User-Role\s+\$sso_role;/);
  });

  test('only Traefik reaches Grafana; Prometheus does not read it', () => {
    const grafana = policies.find(p => p.metadata.name === 'grafana');
    expect(grafana.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'grafana' });
    expect(grafana.spec.ingress).toEqual([{
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
        podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } },
      }],
      ports: [{ protocol: 'TCP', port: 3000 }],
    }]);
    expect(values.grafana.serviceMonitor.enabled).toBe(false);
  });
});

describe('who reaches Prometheus, Alertmanager and Loki', () => {
  const sources = (name) => policies.find(p => p.metadata.name === name).spec.ingress
    .flatMap(rule => rule.from.map(f => f.podSelector.matchLabels['app.kubernetes.io/name']));

  test('each has a policy, in monitoring, selecting its pods', () => {
    expect(policies.map(p => p.metadata.name).sort()).toEqual(['alertmanager', 'grafana', 'loki', 'prometheus']);
    for (const p of policies) {
      expect(p.metadata.namespace).toBe('monitoring');
      expect(p.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': p.metadata.name });
      expect(p.spec.policyTypes).toEqual(['Ingress']);
    }
  });

  test('Prometheus: Grafana and itself; Alertmanager: Prometheus and Grafana; Loki: Alloy and Grafana', () => {
    expect(sources('prometheus').sort()).toEqual(['grafana', 'prometheus']);
    expect(sources('alertmanager').sort()).toEqual(['grafana', 'prometheus']);
    expect(sources('loki').sort()).toEqual(['alloy', 'grafana']);
    for (const p of policies) {
      for (const rule of p.spec.ingress) {
        for (const f of rule.from) expect(f.namespaceSelector === undefined || p.metadata.name === 'grafana').toBe(true);
      }
    }
  });

  test('the CI checks it from OSCAR\'s pod, with a pod no policy holds as the control', () => {
    const check = read('OSCAR_Deploy/kubernetes/ci/check-monitoring.sh');
    for (const s of ['kube-prometheus-stack-grafana.$svc:80', 'kube-prometheus-stack-prometheus.$svc:9090',
      'kube-prometheus-stack-alertmanager.$svc:9093', 'loki.$svc:3100']) expect(check).toContain(s);
    expect(check).toContain('reach "kube-prometheus-stack-kube-state-metrics.$svc" 8080');
  });
});

describe('the logs: Loki and Alloy', () => {
  const statefulSet = lokiDocs.find(d => d.kind === 'StatefulSet');
  const lokiService = lokiDocs.find(d => d.kind === 'Service');
  const deployment = alloyDocs.find(d => d.kind === 'Deployment');
  const role = alloyDocs.find(d => d.kind === 'Role');
  const binding = alloyDocs.find(d => d.kind === 'RoleBinding');

  test('Loki is the VPS\'s: its image by digest and its configuration file', () => {
    const container = statefulSet.spec.template.spec.containers[0];
    expect(container.image).toBe(compose.services.loki.image);
    const lokiKustomization = yaml.load(read('OSCAR_Deploy/loki/kustomization.yaml'));
    expect(stack.resources).toContain('../../../loki');
    expect(lokiKustomization.configMapGenerator).toEqual([{ name: 'loki-config', files: ['loki-config.yaml'] }]);
    expect(lokiKustomization.generatorOptions.disableNameSuffixHash).toBe(true);
    const config = statefulSet.spec.template.spec.volumes.find(v => v.name === 'config');
    expect(config.configMap.name).toBe('loki-config');
    const mount = container.volumeMounts.find(m => m.name === 'config').mountPath;
    expect(container.args).toEqual([`-config.file=${mount}/loki-config.yaml`]);
    // Where loki-config.yaml keeps its data is the volume.
    const lokiConfig = yaml.load(read('OSCAR_Deploy/loki/loki-config.yaml'));
    expect(container.volumeMounts.find(m => m.name === 'data').mountPath).toBe(lokiConfig.common.path_prefix);
    expect(lokiService.spec.ports[0].port).toBe(lokiConfig.server.http_listen_port);
  });

  test('Alloy writes to Loki\'s Service, and the dashboards read it under the uid "loki"', () => {
    const url = /url\s*=\s*"([^"]+)"/.exec(alloyConfig)[1];
    expect(url).toBe(`http://${lokiService.metadata.name}.monitoring.svc.cluster.local:${lokiService.spec.ports[0].port}/loki/api/v1/push`);
    const lokiSource = values.grafana.additionalDataSources.find(d => d.type === 'loki');
    expect(lokiSource.uid).toBe('loki');
    expect(lokiSource.url).toBe(url.replace('/loki/api/v1/push', ''));
  });

  test('Alloy reads OSCAR\'s namespace only, never the run pods\' (a run\'s log is test data)', () => {
    expect(/names\s*=\s*\[([^\]]*)\]/.exec(alloyConfig)[1].trim()).toBe('"oscar"');
    expect(alloyConfig).not.toMatch(/"oscar-runs"/);
    expect(role.metadata.namespace).toBe('oscar');
    expect(role.rules).toEqual([{ apiGroups: [''], resources: ['pods', 'pods/log'], verbs: ['get', 'list', 'watch'] }]);
    expect(binding.metadata.namespace).toBe('oscar');
    expect(binding.subjects).toEqual([{ kind: 'ServiceAccount', name: deployment.spec.template.spec.serviceAccountName, namespace: 'monitoring' }]);
    expect(alloyDocs.some(d => d.kind === 'ClusterRole' || d.kind === 'ClusterRoleBinding')).toBe(false);
  });

  test('Alloy gives the labels the VPS\'s logs dashboard selects, and its own page stays in its pod', () => {
    for (const label of ['namespace', 'pod', 'container']) expect(alloyConfig).toContain(`target_label  = "${label}"`);
    const logs = JSON.parse(read('OSCAR_Deploy/grafana/dashboards/oscar-logs.json'));
    const container = logs.templating.list.find(v => v.name === 'container');
    // No compose_project on a cluster: the list is every container label.
    expect(container.query).toBe('label_values(container)');
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.template.spec.containers[0].image).toMatch(/^grafana\/alloy:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(deployment.spec.template.spec.containers[0].args).toContain('--server.http.listen-addr=127.0.0.1:12345');
    const config = deployment.spec.template.spec.volumes.find(v => v.name === 'config').configMap.name;
    expect(stack.configMapGenerator).toEqual([{ name: config, namespace: 'monitoring', files: ['config.alloy'] }]);
  });

  test('the logs dashboard counts OSCAR\'s errors by level, never a word in a scenario code (#1187)', () => {
    // The recovery drill read 13.8K "errors": info lines naming scenarios such
    // as SIM_REFUND_OVERRULE_SALES_STAFF_ERROR_312. The two error panels share
    // one filter: OSCAR's (pino) lines below level 50 out, then level 50 or 60,
    // or the word error / fatal / panic in any other line. Loki's RE2 and
    // JavaScript read these constructs alike ((?i) taken as the i flag).
    const logs = JSON.parse(read('OSCAR_Deploy/grafana/dashboards/oscar-logs.json'));
    const filters = ['Errors in range', 'Errors only'].map((title) => {
      const expr = logs.panels.find(p => p.title === title).targets[0].expr;
      const m = /!~ `([^`]+)` \|~ `\(\?i\)([^`]+)`/.exec(expr);
      expect([title, m]).not.toEqual([title, null]);
      return m.slice(1);
    });
    expect(filters[1]).toEqual(filters[0]);
    const [below, wanted] = [new RegExp(filters[0][0]), new RegExp(filters[0][1], 'i')];
    const isError = (line) => !below.test(line) && wanted.test(line);
    const lines = {
      '{"level":30,"module":"queue","scenario":"SIM_REFUND_OVERRULE_SALES_STAFF_ERROR_312","msg":"Job completed"}': false,
      '{"level":40,"module":"simulator-metrics","err":"The simulator answered 403.","msg":"The simulator did not answer its metrics"}': false,
      '{"level":40,"error":"boom","msg":"a warning that names an error"}': false,
      '{"level":50,"module":"runner","msg":"Run failed"}': true,
      '{"level":60,"msg":"Going down"}': true,
      'time="2026-11-11T07:00:00Z" level=error msg="Unable to update container"': true,
      'level=info msg="SIM_WRONG_FARE_ERROR_38 done"': false,
      'Error: connect ECONNREFUSED 10.43.0.10:443': true,
    };
    for (const [line, expected] of Object.entries(lines)) expect([line, isError(line)]).toEqual([line, expected]);
  });
});

describe('what OSCAR adds (monitoring/oscar)', () => {
  test('the ServiceMonitor reads /metrics with METRICS_TOKEN, as the VPS\'s two jobs', () => {
    const service = yaml.load(read('OSCAR_Deploy/kubernetes/base/service.yaml'));
    expect(serviceMonitor.metadata.namespace).toBe('oscar');
    expect(serviceMonitor.spec.selector.matchLabels).toEqual(service.metadata.labels);
    const secretKeys = read('OSCAR_Deploy/kubernetes/base/secrets.env.example');
    const jobs = {};
    for (const ep of serviceMonitor.spec.endpoints) {
      expect(service.spec.ports.map(p => p.name)).toContain(ep.port);
      expect(ep.authorization).toEqual({ type: 'Bearer', credentials: { name: 'oscar-secrets', key: 'METRICS_TOKEN' } });
      expect(secretKeys).toMatch(/^METRICS_TOKEN=/m);
      const job = ep.relabelings.find(r => r.targetLabel === 'job').replacement;
      jobs[job] = ep;
    }
    for (const sc of vpsPrometheus.scrape_configs.filter(s => s.job_name !== 'prometheus')) {
      const ep = jobs[sc.job_name];
      expect([sc.job_name, ep && ep.path]).toEqual([sc.job_name, sc.metrics_path]);
      expect(ep.params).toEqual(sc.params);
      expect(ep.interval).toBe(sc.scrape_interval || vpsPrometheus.global.scrape_interval);
      expect(ep.relabelings.find(r => r.targetLabel === 'service').replacement).toBe(sc.static_configs[0].labels.service);
    }
  });

  test('the VPS\'s alert rules are its PrometheusRules, one per file, the groups as they are', () => {
    const generator = require(path.join(MON, 'generate-rules.js'));
    expect(read('OSCAR_Deploy/kubernetes/monitoring/oscar/prometheus-rules.yaml')).toBe(generator.render());
    const rules = docs('OSCAR_Deploy/kubernetes/monitoring/oscar/prometheus-rules.yaml');
    const files = fs.readdirSync(path.join(DEPLOY, 'prometheus/alerts')).filter(f => f.endsWith('.yml')).sort();
    expect(rules.map(r => r.metadata.name)).toEqual(files.map(f => f.slice(0, -4)));
    for (const [i, f] of files.entries()) {
      expect(rules[i].kind).toBe('PrometheusRule');
      expect(rules[i].metadata.namespace).toBe('monitoring');
      expect(rules[i].spec.groups).toEqual(yaml.load(read(`OSCAR_Deploy/prometheus/alerts/${f}`)).groups);
    }
    expect(oscarPart.resources).toEqual(expect.arrayContaining(['service-monitor.yaml', 'prometheus-rules.yaml', 'cluster-rules.yaml', '../../../grafana']));
  });

  test('the run pods\' rules select the namespace and container the dispatcher gives them', () => {
    const jobSpec = read('Oscar_Server/src/run-dispatcher/jobSpec.js');
    const container = /const CONTAINER = '([^']+)'/.exec(jobSpec)[1];
    const runsNamespace = yaml.load(read('OSCAR_Deploy/kubernetes/runs/namespace.yaml')).metadata.name;
    const selector = `namespace="${runsNamespace}", container="${container}"`;
    const exprs = clusterRules.spec.groups.flatMap(g => g.rules.map(r => r.expr));
    expect(exprs.length).toBe(2);
    for (const e of exprs) expect(e).toContain(selector);
    for (const e of exprsOf(k8sDashboard).filter(x => x.includes('oscar-runs') && x.includes('container='))) expect(e).toContain(selector);
    // The Job's TTL keeps a pod 5 minutes after its run: long enough for the
    // out-of-memory alert, which has no "for".
    expect(Number(/const TTL_AFTER_FINISHED_S = (\d+)/.exec(jobSpec)[1])).toBeGreaterThanOrEqual(120);
    const oom = clusterRules.spec.groups[0].rules.find(r => r.alert === 'OscarRunPodOutOfMemory');
    expect(oom.for).toBeUndefined();
    // No rule name taken twice across the VPS's rules and the cluster's.
    const vps = docs('OSCAR_Deploy/kubernetes/monitoring/oscar/prometheus-rules.yaml').flatMap(r => r.spec.groups.flatMap(g => g.rules.map(x => x.alert)));
    const mine = clusterRules.spec.groups.flatMap(g => g.rules.map(x => x.alert));
    expect(new Set([...vps, ...mine]).size).toBe(vps.length + mine.length);
  });

  test('every dashboard is a ConfigMap Grafana\'s sidecar loads, under the datasources the chart gives', () => {
    const sidecar = values.grafana.sidecar.dashboards;
    expect(sidecar.searchNamespace).toBe('monitoring');
    const grafanaKustomization = yaml.load(read('OSCAR_Deploy/grafana/kustomization.yaml'));
    for (const k of [grafanaKustomization, oscarPart]) {
      // The chart's sidecar label (grafana_dashboard: "1"), and no hash: a
      // second ConfigMap of the same dashboard would load twice.
      expect(k.generatorOptions.labels.grafana_dashboard).toBe('1');
      expect(k.generatorOptions.disableNameSuffixHash).toBe(true);
    }
    expect(grafanaKustomization.namespace).toBe('monitoring');
    expect(grafanaKustomization.configMapGenerator.flatMap(g => g.files).sort()).toEqual(vpsDashboards.map(f => `dashboards/${f}`).sort());
    const k8sFiles = fs.readdirSync(path.join(MON, 'oscar/dashboards'));
    expect(oscarPart.configMapGenerator.flatMap(g => g.files).sort()).toEqual(k8sFiles.map(f => `dashboards/${f}`).sort());
    for (const g of oscarPart.configMapGenerator) expect(g.namespace).toBe('monitoring');
    const dashboards = [...vpsDashboards.map(f => JSON.parse(read(`OSCAR_Deploy/grafana/dashboards/${f}`))), k8sDashboard];
    const uids = dashboards.map(d => d.uid);
    expect(new Set(uids).size).toBe(uids.length);
    for (const d of dashboards) {
      for (const uid of datasourceUidsOf(d)) expect(['prometheus', 'loki', 'grafana']).toContain(uid);
    }
    // The CI looks each of them up in Grafana.
    const check = read('OSCAR_Deploy/kubernetes/ci/check-monitoring.sh');
    for (const uid of uids) expect(check).toContain(uid);
  });

  test('the cluster\'s dashboard reads the run pods, OSCAR\'s pods and the machine', () => {
    expect(k8sDashboard.uid).toBe('oscar-kubernetes');
    const exprs = exprsOf(k8sDashboard);
    for (const m of ['container_memory_working_set_bytes', 'container_cpu_usage_seconds_total', 'kube_pod_container_resource_limits',
      'kube_pod_container_status_terminated_reason', 'kube_pod_status_phase', 'kube_resourcequota', 'node_memory_MemAvailable_bytes',
      'oscar_run_pods_ended_total']) {
      expect(exprs.some(e => e.includes(m)) ? m : `${m} is read by no panel`).toBe(m);
    }
    // OSCAR's own figure is its metrics module's.
    expect(read('Oscar_Server/src/utils/metrics.js')).toContain("name: 'oscar_run_pods_ended_total'");
    // A test that a panel's id is unique and that each panel sits in the grid.
    const ids = k8sDashboard.panels.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of k8sDashboard.panels) expect(p.gridPos.x + p.gridPos.w).toBeLessThanOrEqual(24);
  });
});

describe('the guide and the CI', () => {
  test('the CI installs the stack and OSCAR\'s part as the guide does, then checks them', () => {
    expect(yaml.load(read('OSCAR_Deploy/kubernetes/ci/k3s-monitoring/kustomization.yaml')).resources).toEqual(['../../monitoring/stack']);
    expect(k3sSteps).toContain('kubectl apply -k OSCAR_Deploy/kubernetes/ci/k3s-monitoring');
    expect(k3sSteps).toContain('kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/oscar');
    expect(k3sSteps).toContain('OSCAR_Deploy/kubernetes/ci/check-monitoring.sh');
    expect(guide).toContain('kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/site');
    expect(guide).toContain('kubectl apply -k OSCAR_Deploy/kubernetes/monitoring/oscar');
    expect(guide).toContain('cp -r OSCAR_Deploy/kubernetes/monitoring/stack OSCAR_Deploy/kubernetes/monitoring/site');
    expect(read('.gitignore')).toContain('OSCAR_Deploy/kubernetes/monitoring/site/');
    // The machine's copy sits as deep as the stack: its ../../../loki is the same folder.
    expect(path.resolve(MON, 'site', '../../../loki')).toBe(path.resolve(MON, 'stack', '../../../loki'));
  });

  test('the workflow runs when the VPS\'s dashboards, Loki or alerts change, or OSCAR\'s sign-in check', () => {
    for (const p of ['OSCAR_Deploy/grafana/**', 'OSCAR_Deploy/loki/**', 'OSCAR_Deploy/prometheus/alerts/**', 'Oscar_Server/src/api/routes/auth.js']) {
      expect(workflowText.split(`'${p}'`).length - 1).toBe(2);   // pull_request and push
    }
  });

  test('after the guide\'s sed, its grep finds the placeholder name nowhere in the copy (#1185)', () => {
    // 8a step 2 copies this folder, runs sed on the files it names, then says
    // the grep "prints nothing when every name was replaced". A comment that
    // wrote the name once made it print a line in the recovery drill.
    const sed = /^sed -i "s\/(oscar\.example\.org)\/\$HOST\/g" (OSCAR_Deploy\/kubernetes\/monitoring\/site\/.+)$/m.exec(guide);
    expect(sed).not.toBeNull();
    const grep = /^grep -rn "([^"]+)" OSCAR_Deploy\/kubernetes\/monitoring\/site$/m.exec(guide);
    expect(grep).not.toBeNull();
    const edited = sed[2].trim().split(/\s+/).map(p => path.posix.relative('OSCAR_Deploy/kubernetes/monitoring/site', p));
    expect(edited.length).toBeGreaterThan(0);
    const stackDir = path.join(MON, 'stack');
    const files = fs.readdirSync(stackDir, { recursive: true })
      .map(f => String(f).split(path.sep).join('/'))
      .filter(f => fs.statSync(path.join(stackDir, f)).isFile());
    for (const f of edited) expect(files).toContain(f);
    const left = files.filter((f) => {
      let text = fs.readFileSync(path.join(stackDir, f), 'utf8');
      if (edited.includes(f)) text = text.replaceAll(sed[1], 'oscar-test.machine.invalid');
      return text.includes(grep[1]);
    });
    expect(left).toEqual([]);
  });

  test('the guide names the chart version this folder pins', () => {
    expect(guide).toContain(`kube-prometheus-stack ${helmChart.spec.version}`);
  });

  test('the guide makes Alertmanager\'s Secret from Server Config with the server\'s module, where the image puts it', () => {
    // The restored database holds the VPS's mail server and recipients: the
    // server's own renderConfig() writes the file, run by the administrator
    // in OSCAR's container (the server gets no right on the cluster).
    const m = /deploy\/oscar -c (\w+) -- node --no-warnings -e "console\.log = console\.error; process\.stdout\.write\(require\('\/app\/(src\/[^']+)'\)\.renderConfig\(\)\)"/.exec(guide);
    expect(m).not.toBeNull();
    const deployment = yaml.load(read('OSCAR_Deploy/kubernetes/base/deployment.yaml'));
    expect(m[1]).toBe(deployment.spec.template.spec.containers[0].name);
    const dockerfile = read('Oscar_Server/Dockerfile');
    expect(dockerfile).toMatch(/^WORKDIR \/app$/m);
    expect(dockerfile).toMatch(/^COPY src\/ src\/$/m);
    expect(read(`Oscar_Server/${m[2]}.js`)).toMatch(/module\.exports = \{[^}]*\brenderConfig\b/);
    // Then the Secret Alertmanager reads, by the name the chart is given.
    expect(guide).toContain(`kubectl -n monitoring create secret generic ${values.alertmanager.alertmanagerSpec.configSecret} --from-file=alertmanager.yaml=`);
  });

  test('the guide\'s lines are the ones Server Config shows on Kubernetes (#1175)', () => {
    const { KUBERNETES_COMMANDS } = require('../../src/utils/alertmanagerConfig');
    expect(guide).toContain('```bash\n' + KUBERNETES_COMMANDS + '\n```');
  });

  test('the test alert goes to the Alertmanager the chart makes, by the name the CI waits for', () => {
    const m = /kubectl -n monitoring exec statefulset\/(\S+) -c alertmanager -- amtool alert add alertname=OscarTestAlert severity=critical /.exec(guide);
    expect(m).not.toBeNull();
    expect(read('.github/workflows/ci-kubernetes.yml')).toContain(`statefulset/${m[1]}`);
    // A critical alert is mailed: the route the module writes sends it to the recipients.
    expect(read('Oscar_Server/src/utils/alertmanagerConfig.js')).toMatch(/- severity = "critical"\n\s+receiver: oscar-admins/);
  });
});
