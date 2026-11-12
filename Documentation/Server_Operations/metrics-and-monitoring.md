# Metrics & Monitoring — Prometheus + Grafana

This guide explains how to enable, use, and extend the optional metrics
stack for OSCAR.

The metrics stack is **opt-in**. Default deployments don't run Prometheus
or Grafana, so existing installations are unaffected by simply pulling
this version of the repo.

---

## What you get

Two pre-built Grafana dashboards at **`https://oscar.uic.org/grafana/`**:

**OSCAR · Overview** — runtime metrics:
- Active runs / queue depth (current snapshot)
- HTTP request rate and P95 latency (pages and API: the run pods' calls
  are left out, #1205)
- HTTP latency percentiles (p50/p95/p99) over time
- HTTP requests per second by status code (find error spikes)
- Bruno runs completed/sec by status (COMPLETED / FAILED)
- Auth + SMTP success/failure rates
- Process memory (RSS, heap used, heap total)
- Process CPU + Node.js event-loop lag
- Row *OSCAR host* (#1013): the machine's CPU by mode, load against CPUs,
  memory and swap, the container's memory, and the run processes (Bruno)
  with their memory
- Row *Runs by company or provider* (#1017): runs going and waiting, runs
  ended per minute, and requests to the provider per second
- Row *OSCAR's thread: what each run costs it* (#1205): the share of the
  server's one thread taken by the work done for each run, how long requests
  waited for the thread, the slowest addresses, one run's work (see
  *OSCAR's thread* below)

Which address is slow: Grafana → **Explore** → Prometheus, the 99th
percentile by listener, method and route over the last 5 minutes:

```
histogram_quantile(0.99, sum by (le, listener, method, route) (rate(oscar_http_request_duration_seconds_bucket[5m])))
```

`listener` (from server 1.11.502, #1205) is `public` for the pages and the
API, `internal` for the run pods' calls (`INTERNAL_PORT`: a run's data
file, its results, its token renewed), which nothing measured before.

`route` is the address's pattern with its router's path (`/v1/runs`,
`/v1/runs/:id`, `/v1/company/datafile`; from server 1.11.499, #1196, before
which the root of every router read `/`), a static file its own path, any
other address `unmatched`.

**OSCAR · Logs** — centralised log aggregation:
- Errors-only view: OSCAR's lines at level error or fatal, and other lines
  holding error, fatal or panic as a word of their own (#1187)
- Full live tail (5s refresh) with substring search box
- Per-container filter (variable dropdown)
- Log rate timeseries by container

**OSDM Simulator · Overview** (#1005) — the simulator and its host, when
Admin → OSDM Simulator holds its address and key:
- Whether it answers OSCAR, its version, request rate and P95 answer time
- Host memory used, swap used, CPU by mode, load, data disk
- Requests per second by status and by provider, refusals of its rate limit
  (429, trusted address or not)
- Its process: memory, CPU, event-loop delay; offers and bookings it keeps

All metrics scraped from OSCAR's `/metrics` at 15s intervals (15-day retention);
the simulator's every 30 s, see *The OSDM simulator* below.
All logs shipped via Promtail from container stdout/stderr (indefinite retention by
default — adjust in `OSCAR_Deploy/loki/loki-config.yaml` if disk pressure).

**Plus, since v1.8.0, an end-to-end watchdog stack:**

- **Autoheal sidecar** restarts any container that fails its Docker healthcheck (3× in 90s). Self-healing for the common transient hangs — no human action needed.
- **Alertmanager** routes Prometheus alerts to email, with deduping, grouping, and re-paging. Hooks into the same SMTP relay you set up for OSCAR's own emails (Brevo, etc.).
- **Pre-defined alert ruleset** covers OSCAR down, restart loops, queue stuck, sustained run failure, SMTP degradation, login attack burst, memory leak, event-loop lag.

Full operational guide: [`OSCAR - Server Admin Guide.md` § 14](OSCAR%20-%20Server%20Admin%20Guide.md#14-operational-monitoring--alerting-v18).

---

## Architecture

```
┌─────────────┐   scrape every 15s    ┌────────────┐
│  Prometheus │ ───────────────────▶ │   oscar    │
│  (private)  │   http://oscar:3001  │  /metrics  │
└─────┬───────┘                       └────────────┘
      │ datasource
      ▼
┌─────────────┐    auth_request      ┌────────────┐
│   Grafana   │ ◀──── /grafana/ ──── │   nginx    │
│ (port 3000) │     X-WEBAUTH-USER   │  (public)  │
└─────────────┘                       └─────┬──────┘
       ↑                                    │  /v1/auth/sso-check
       │                                    ▼
       │                              ┌────────────┐
       │     X-WEBAUTH-USER set if    │   oscar    │
       └─── role==administrator ─────│ JWT cookie │
                                      └────────────┘
```

- `/metrics` endpoint: **no auth** in the app, but **404'd by nginx**
  for external requests. Only Prometheus (in the same Docker network
  as `oscar`) can reach it. Where no nginx guards it (Kubernetes,
  OpenShift), `METRICS_TOKEN` makes OSCAR itself answer 404 to any
  request without that bearer token (#1059, 1.11.443; the
  [Kubernetes and OpenShift guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md),
  section 8).
- Grafana: gated by **OSCAR SSO** at `https://oscar.uic.org/grafana/`.
  When you click the menu link, nginx's `auth_request` calls OSCAR's
  `/v1/auth/sso-check`. If your JWT cookie says `role=administrator`,
  the request continues with the `X-WEBAUTH-USER` header carrying your
  email — Grafana auto-creates a matching user (Viewer by default,
  promote to Editor / Admin in the Grafana UI).
- Prometheus has no public port at all.

### The OSCAR server's machine (#1013)

Each run is a Bruno process, a child of the server: its CPU and memory do not
show in the server process's own metrics (`oscar_node_process_*`). A load
test of 36 parallel runs saturated a 6-CPU machine (load 29.7, 2.6 GiB of
memory available, no swap) while the dashboard showed none of it. Since
1.11.424 OSCAR's `/metrics` also writes, read at each scrape:

- `oscar_host_*`: memory total and available, swap total and free, load
  (1, 5, 15 minutes), CPU count, CPU time by mode, from `/proc` as the
  container sees it (on a VM, the VM's own figures);
- `oscar_container_memory_bytes` and, when the container has one, its limit
  (cgroup);
- `oscar_run_processes` and their total resident memory: the server's own
  child processes (Bruno, report merge), counted. No name, path or argument
  of a process is written.

The row *OSCAR host* of *OSCAR · Overview* shows them. How to read it:

- **Load per CPU** over 1 means processes wait for a CPU. Pages and runs
  slow down together. Over 2 for 10 minutes fires `OscarHostOverloaded`.
- **Memory available** under 10 % for 5 minutes fires `OscarHostMemoryLow`
  (critical). Past it the machine swaps or the kernel kills a process, the
  OSCAR server included.
- **Swap used** over 1 GiB for 10 minutes fires `OscarHostSwapping`.

**How many parallel runs a machine holds.** A run costs about 0.2 CPU and
250 MB (measured on the simulator, up to 430 MB for a long scenario). So
*Max Concurrent Runs* (Admin → Server Config, applied at once) is about 4
per CPU, as long as runs × 250 MB stays well under the memory available
without runs: 24 on 6 CPUs and 11 GiB. 50 runs need about 12 CPUs and 16 to
24 GiB. Above that the machine does no more work, it only shares it out
more slowly. **In pod mode** (Kubernetes, each run a pod) count about one
run per vCPU instead: a run pod's start costs 0.4 to 0.7 CPU for a few
seconds, and the node makes and removes a pod per run (#1150, measured on 6
vCPU with k3s).

### Runs by company or provider (#1017)

Four metrics carry the labels `company` (the company or provider's name) and
`distributor` (its parent's name, empty for a top-level company):

- `oscar_company_runs_running` and `oscar_company_runs_queued`, read from the
  queue every 5 seconds. With several providers at work, the runs going
  should even out between them as runs end (#1015).
- `oscar_company_runs_finished_total{status}`.
- `oscar_company_run_requests_total`: the requests a run stored, counted when
  the run ends. Bruno sends them straight to the provider, so OSCAR cannot
  count them live. The rate lags by about one run, and requests a script
  sends itself are not counted.

No metric names a user: an e-mail would be personal data in Prometheus, and
the series would grow with every user. *Admin → Server Activity → Runs in
Progress* lists runs going and waiting by user and company or provider. A
company renamed keeps its old name in the labels until OSCAR restarts.

### OSCAR's thread (#1205)

OSCAR's server answers every page on one thread. Work done for a run on
that thread makes every page wait while it lasts, with the CPU, memory and
disk far from their limits (on the k3s test machine, four providers'
batches at once made pages take more than 10 s). From server 1.11.502, that
work is measured where it runs:

- `oscar_run_work_seconds{work}`, a histogram, one observation per run and
  kind: `datafile_copy` (the run's copy of the data file, with the Test
  Framework's warnings and the trips' calendars, made each time a run asks
  for its data file) and `results_store` (the run's checks, steps and
  requests read from Bruno's results and stored; from 1.11.505 in slices,
  and only the slices' time is counted, not the waits between them);
- `oscar_run_log_lines_total` and `oscar_run_log_seconds_total`: every
  line of a run's log, counted, and the time it took in total (its
  encryption, and its share of the write that stores it).

The row *OSCAR's thread* of *OSCAR · Overview* reads them:

| Panel | How to read it |
|---|---|
| Share of the thread taken by run work | Seconds of work a second, by kind. Near 100 % in all, every page waits behind the runs. |
| Event loop: how long requests waited | The worst wait and the 99th percentile since the last reading. Seconds here are seconds every page waited. |
| Slowest addresses (99th percentile) | The ten slowest, with their listener. Slow everywhere at once is the thread; one address alone is that address. |
| One run's work (95th percentile) | How long one run's copy or results take, and log lines a second. |

The alert `OscarEventLoopLag` reads the same 99th percentile. **Until
1.11.502 it could never fire**: it read a `_bucket` series that prom-client
does not write (the event loop's lag is a set of gauges).

**What the first reading showed** (k3s test machine, 15 runs going, #1210):
log lines took half of the thread and up to 85 %, about 180 a second at
2.7 ms each, and requests waited up to 6.8 s. Each line was written alone,
so each was a write that waits for the disk. From server 1.11.503 the lines
of every run are written together, every 0.2 s: about 0.07 ms a line
instead of 1.8 measured on one machine. A running run's log on its page
still shows every line at once (the page's request writes the waiting lines
first).

**The second reading** (all six simulated providers at once, server
1.11.503, #1214): pages answered in 10–100 ms, log lines took 15 % of the
thread, and storing each run's results 34 %, 2.2 to 3 s a run in one block.
From server 1.11.505 the results are stored in slices of about 20 ms, other
requests served between them; the longest block left is the results file
decrypted and read (about 0.1 s for 9 MB of results, measured on one
machine).

### Run pods (#1130)

With `RUN_ISOLATION=pod` (Kubernetes or OpenShift, each run in a pod of its
own; *OSCAR - Kubernetes and OpenShift Deployment Guide*, section 10a), two
more metrics; in any other mode they stay empty:

- `oscar_run_pod_start_seconds`, a histogram: from the server asking the run
  dispatcher for a run to its pod running. A few seconds with the run image
  already on the node; more on a node that must pull it.
- `oscar_run_pods_ended_total{outcome}`, one per run: `ran` (Bruno ended,
  passed or not), `deadline` (the run's Job reached its deadline),
  `not_started` (the pod never ran), `stopped` (on the server's word: a stop,
  a time limit) or `refused` (by the dispatcher, or the server lost it).

The row *Run pods* of *OSCAR · Overview* shows both. Two alerts:
`OscarRunPodsNotStarting` (the run image cannot be pulled, the runs'
namespace's quota is full, or its pod security refuses the pod) and
`OscarRunDispatcherRefusing` (the dispatcher is down, refuses the server's
key, or has as many runs as `RUN_DISPATCHER_MAX_RUNS`).

### On Kubernetes (#1147)

This page's stack is the VPS's (`docker-compose.metrics.yml`). On a cluster:
- `OSCAR_Deploy/kubernetes/monitoring/oscar` gives a cluster's Prometheus
  Operator the same jobs, alerts and dashboards (*OSCAR - Kubernetes and
  OpenShift Deployment Guide*, section 8);
- on one machine with k3s, `monitoring/stack` installs Prometheus,
  Alertmanager, Grafana and Loki as well (*OSCAR - k3s on one VPS*, section
  8a).

In pod mode a run is a pod, which OSCAR's own process figures do not see.
Its memory and CPU come from the kubelet (cAdvisor), its limit and end from
kube-state-metrics, in the dashboard *OSCAR · Kubernetes*: each run pod's
memory against `RUN_MEMORY_LIMIT`, its CPU, the runs stopped for memory, the
quota of `oscar-runs`, OSCAR's pods and the machine. Two alerts there:
`OscarRunPodNearMemoryLimit` (over 90 % of the limit for a minute) and
`OscarRunPodOutOfMemory` (Kubernetes stopped a run at the limit; OSCAR shows
it as failed). Prometheus reads every 15 s, so a run shorter than that may not
show.

### The OSDM simulator (#1005)

The simulator runs on a host of its own and is read **through OSCAR**: the
job `osdm-simulator` scrapes `http://oscar:3001/metrics?source=simulator`,
and OSCAR asks the simulator's administration API (`GET /admin/api/metrics`)
with the address and key saved in Admin → OSDM Simulator, then writes the
answer in Prometheus's format (`osdm_sim_*`). So Prometheus holds no key,
nothing new is opened on the simulator's host, and nginx's
`location = /metrics` 404 covers the path (a query string does not change
that match). OSCAR reads the simulator at most once every 10 s.

What the simulator reports: requests by provider, method and status and
their duration (its administration API left out), refusals of its rate
limit, its process (memory, CPU, event-loop delay), and its host as `/proc`
shows it: memory, swap, load, CPU time by mode, and the disk of its data
folder. Never an account, a token or a body.

`oscar_simulator_configured` is 0 while no simulator is set up, and nothing
fires. Once set up, `oscar_simulator_up` says whether it answered. The rules
are in `prometheus/alerts/osdm-simulator-alerts.yml`: unreachable (critical),
swap over 256 MiB, memory over 90 %, P95 over 1 s, 429s to the OSCAR server,
disk under 10 %, event-loop delay over 200 ms.

---

## One-time setup

### 1. Pull the repo (gets the new compose overlay + dashboard files)

```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
```

### 2. SSO instead of htpasswd

Grafana is now SSO'd through OSCAR — no separate password file. Anyone signed in to OSCAR as **administrator** lands directly in Grafana when they click the menu link or visit `https://oscar.uic.org/grafana/`. Non-admins get bounced back to the OSCAR login page.

(If you previously installed an `/etc/nginx/.htpasswd-grafana` file for the v1.5.0 / v1.5.1 basic-auth setup, you can leave it on disk — it's no longer referenced — or remove it: `sudo rm /etc/nginx/.htpasswd-grafana`.)

### 3. Add the nginx snippet

Open the OSCAR site config (e.g. `/etc/nginx/sites-enabled/oscar.uic.org`)
and paste the two `location` blocks from
`/opt/OSCAR/OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` into the
existing `server { ... }` block.

Reload:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4. Start the metrics stack

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d
```

This pulls + starts `oscar-prometheus` and `oscar-grafana` alongside the
existing `oscar` container. The original `oscar` container is unaffected
(no recreate, no downtime).

### 5. Open the dashboard

Visit **`https://oscar.uic.org/grafana/`**, log in with the htpasswd
credentials. The "OSCAR · Overview" dashboard loads automatically.

---

## Day-to-day

### Stop just the metrics stack (leave OSCAR running)

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml stop prometheus grafana
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml rm -f prometheus grafana
```

### Or just turn off the overlay on next restart

```bash
sudo docker compose -f docker-compose.yml down                 # stops everything
sudo docker compose -f docker-compose.yml up -d                # restarts WITHOUT metrics
```

### Resource budget

Steady state on a small VPS:

| Container | RAM | Disk |
|-----------|-----|------|
| Prometheus | ~150 MB | ~500 MB (15d retention) |
| Grafana | ~120 MB | ~50 MB |
| Loki | ~80 MB | grows ~5-50 MB/day depending on log volume |
| Promtail | ~30 MB | minimal (positions file) |
| Alertmanager (v1.8) | ~30 MB | minimal (silences, notification log) |
| Autoheal (v1.8) | ~5 MB  | none |
| **Total added** | **~415 MB** | **~600 MB after 30d typical** |

### Where data lives

Two named Docker volumes survive container recreation:
- `oscar_deploy_prometheus-data` — TSDB samples
- `oscar_deploy_grafana-data` — Grafana's internal SQLite (annotations, etc.)

Grafana dashboards themselves are NOT stored in `grafana-data` — they're
provisioned from `/opt/OSCAR/OSCAR_Deploy/grafana/dashboards/*.json` on
every container start. To customize, edit the JSON in Git and reload the
container.

---

## Adding a new metric

Three steps:

1. **Declare it** in `Oscar_Server/src/utils/metrics.js`:
   ```js
   const myCounter = new promClient.Counter({
     name: 'oscar_my_thing_total',
     help: 'Description of what this counts',
     labelNames: ['result'],
     registers: [register]
   });
   module.exports = { ..., myCounter };
   ```

2. **Increment it** wherever the event happens:
   ```js
   const { myCounter } = require('../../utils/metrics');
   myCounter.inc({ result: 'success' });
   ```

3. **Add a panel** to `OSCAR_Deploy/grafana/dashboards/oscar-overview.json`
   (or create a new dashboard JSON file in the same directory). Reload
   Grafana — the new panel appears within 30 seconds.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Grafana 502 from nginx | Grafana container down or wrong port | `docker logs oscar-grafana` |
| Empty graphs in Grafana | Prometheus can't reach OSCAR | `docker exec oscar-prometheus wget -qO- http://oscar:3001/metrics \| head` |
| `/grafana/` redirect loop on first login | `GF_SERVER_DOMAIN` defaulted to `localhost` | Source has it hardcoded since v1.6.0 — verify env via `docker exec oscar-grafana env \| grep GF_SERVER` |
| `/grafana/` ERR_TOO_MANY_REDIRECTS | nginx `proxy_pass http://127.0.0.1:3000/;` has trailing slash | Remove the `/` — source has the correct form since v1.6.0 |
| `/grafana/` returns 500 from nginx | `auth_request` got a 3xx redirect (only 2xx/401/403 accepted) | The `/auth/sso-check` location must send `Host: localhost` AND `X-Forwarded-Proto: https`. Source snippet has both since v1.6.1 |
| Grafana panels show "No data" with red triangles | Datasource UID mismatch | Datasource provisioning must set `uid: prometheus` (source has it since v1.6.0) |
| Grafana panels show "No data" without errors | Prometheus has no data (target down) — see next row | |
| Prometheus `oscar-server` target down with 400 / ECONNREFUSED | OSCAR's HTTPS-redirect intercepting plain-HTTP scrape | v1.5.1+ exempts `/metrics` from the redirect — make sure you're on v1.5.1 or later |
| External `https://oscar.uic.org/metrics` returns OSCAR HTML | nginx snippet not installed | Re-do nginx step, reload nginx |
| External `https://oscar.uic.org/metrics` returns the metrics in clear | nginx snippet not installed correctly | Re-do nginx step, **immediate fix** |
| `refresh-collection.sh` fails with "working tree dirty" on the deploy workflow | Local edits in `/opt/OSCAR/` block `git pull` | `sudo -u ubuntu git -C /opt/OSCAR status` to see what's dirty; `git checkout -- .` to discard tracked-file edits; `rm /opt/OSCAR/FETCH_HEAD` if that's the only "untracked" entry |
| **Alertmanager won't start — `error loading config: yaml: did not find expected key`** | `alertmanager.yml` not created on host (gitignored — only `.example` ships) | `cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml` then edit + `docker compose up -d alertmanager` |
| **Alerts fire in Prometheus but no email arrives** | Alertmanager SMTP credentials wrong | `docker logs oscar-alertmanager --tail 50` shows the SMTP error verbatim. Note: Alertmanager has its OWN config file — it doesn't reuse OSCAR's Server Config DB |
| **Autoheal restarts oscar repeatedly** | Healthcheck failing because OSCAR can't actually reach DB / disk | `docker exec oscar node -e "fetch('http://127.0.0.1:3001/health').then(r=>r.json()).then(console.log)"` — shows which subsystem is unhealthy |
| **`oscar` container shows `(unhealthy)` but autoheal didn't restart it** | Container missing the `autoheal=true` label | Recreate with `docker compose up -d --force-recreate oscar` (label only applies on create, not start) |

### Operator note: dirty-tree on the host

`refresh-collection.sh` refuses to `git pull` when the host's working tree has any uncommitted edits OR untracked files (treated as "dirty"). Two common sources:

- **Manual debugging edits** — common during incident response. Once the equivalent fix lands in source via a PR, discard the local edit with `git checkout -- <file>` to let auto-pull resume.
- **Stray `FETCH_HEAD`** at the repo root — git creates this file during a fetch from a non-standard working dir; it's usually `.git/FETCH_HEAD` (which git ignores) but can land at the repo root in some shells. Safe to delete.

After cleaning, the next release-tagged push will auto-refresh the host repo via `refresh-collection.yml` + `promote-release.yml` (both SSH the host, both run the same script).
