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
- HTTP request rate and P95 latency
- HTTP latency percentiles (p50/p95/p99) over time
- HTTP requests per second by status code (find error spikes)
- Bruno runs completed/sec by status (COMPLETED / FAILED)
- Auth + SMTP success/failure rates
- Process memory (RSS, heap used, heap total)
- Process CPU + Node.js event-loop lag

**OSCAR · Logs** — centralised log aggregation:
- Errors-only view (regex-matches ERROR / FATAL / PANIC)
- Full live tail (5s refresh) with substring search box
- Per-container filter (variable dropdown)
- Log rate timeseries by container

All metrics scraped from OSCAR's `/metrics` at 15s intervals (15-day retention).
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
  as `oscar`) can reach it.
- Grafana: gated by **OSCAR SSO** at `https://oscar.uic.org/grafana/`.
  When you click the menu link, nginx's `auth_request` calls OSCAR's
  `/v1/auth/sso-check`. If your JWT cookie says `role=administrator`,
  the request continues with the `X-WEBAUTH-USER` header carrying your
  email — Grafana auto-creates a matching user (Viewer by default,
  promote to Editor / Admin in the Grafana UI).
- Prometheus has no public port at all.

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
