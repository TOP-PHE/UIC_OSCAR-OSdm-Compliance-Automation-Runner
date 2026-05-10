# Metrics & Monitoring — Prometheus + Grafana

This guide explains how to enable, use, and extend the optional metrics
stack for OSCAR.

The metrics stack is **opt-in**. Default deployments don't run Prometheus
or Grafana, so existing installations are unaffected by simply pulling
this version of the repo.

---

## What you get

A live operational dashboard at **`https://oscar.uic.org/grafana/`** showing:

- Active runs / queue depth (current snapshot)
- HTTP request rate and P95 latency
- HTTP latency percentiles (p50/p95/p99) over time
- HTTP requests per second by status code (find error spikes)
- Bruno runs completed/sec by status (COMPLETED / FAILED)
- Auth + SMTP success/failure rates
- Process memory (RSS, heap used, heap total)
- Process CPU + Node.js event-loop lag

All metrics are scraped from OSCAR's `/metrics` endpoint at 15s intervals
and retained for 15 days.

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

| Container | RAM | Disk (15d retention) |
|-----------|-----|----------------------|
| Prometheus | ~150 MB | ~500 MB |
| Grafana | ~120 MB | ~50 MB |
| **Total added** | **~270 MB** | **~550 MB** |

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
| `/grafana/` redirect loop | `GF_SERVER_SERVE_FROM_SUB_PATH` wrong | Verify env in `docker-compose.metrics.yml` |
| External `https://oscar.uic.org/metrics` returns OSCAR HTML | nginx snippet not installed | Re-do step 3 above, reload nginx |
| External `https://oscar.uic.org/metrics` returns the metrics in clear | nginx snippet not installed correctly | Re-do step 3, **immediate fix** |

The last two are minor security concerns — not catastrophic (no
secrets in the metrics) but expose internal counters and request
patterns. Worth fixing immediately.
