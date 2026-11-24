# OSCAR — Installation Guide

This guide walks through deploying OSCAR (server + Bruno collection + UI) on
a Linux VPS using Docker Compose. It assumes a clean Ubuntu 22.04 LTS host
fronted by nginx (or another reverse proxy) for HTTPS termination.

For the legacy single-folder deployment guide, see
[OSCAR - VPS Deployment Guide.md](./OSCAR%20-%20VPS%20Deployment%20Guide.md).
The procedure below supersedes it for the monorepo layout.

To run OSCAR on a **Kubernetes cluster or on OpenShift** instead of a VPS,
see [section 10](#10-kubernetes-or-openshift-instead-of-docker-compose).

---

## 1. Prerequisites

| Requirement              | Version          | Install                             |
| ------------------------ | ---------------- | ----------------------------------- |
| Docker Engine            | 24+              | `curl -fsSL https://get.docker.com \| sh` |
| Docker Compose plugin    | v2 (bundled)     | included with Docker Engine 24      |
| Git                      | any recent       | `sudo apt install -y git`           |
| nginx (or Caddy/Apache)  | any              | `sudo apt install -y nginx`         |
| Domain + DNS A record    | pointing to VPS  | configured at your DNS provider     |
| TLS cert (Let's Encrypt) | via certbot      | `sudo apt install -y certbot python3-certbot-nginx` |

The host needs ~2 GB RAM, 1 CPU, 10 GB disk for a low-volume conformance
service. The image itself is ~250 MB and the SQLite DB grows roughly
1–5 MB per 1000 runs.

---

## 2. Clone the monorepo

```bash
sudo mkdir -p /opt
cd /opt
sudo git clone https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner.git OSCAR
sudo chown -R "$USER:$USER" /opt/OSCAR
cd /opt/OSCAR
```

Pin to a known-good combined release tag (see `compatibility.json` for the
list of tested combinations):

```bash
git fetch --tags
git checkout release-2026.481   # or whichever release you intend to deploy
```

---

## 3. Configure secrets

```bash
cd /opt/OSCAR/OSCAR_Deploy
cp .env.example .env
```

Generate the three required secrets and paste them into `.env`:

```bash
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "PLATFORM_BOOTSTRAP_TOKEN=$(openssl rand -base64 48)"
echo "JWT_SECRET=$(openssl rand -hex 64)"
```

Edit `.env`:

```bash
nano .env
```

Required fields:

```
ENCRYPTION_KEY=<64 hex chars from above>
PLATFORM_BOOTSTRAP_TOKEN=<base64 string from above>
JWT_SECRET=<128 hex chars from above>
```

Optional — adjust runtime tuning if needed:

```
MAX_CONCURRENT_RUNS=3
RUN_TIMEOUT_MS=600000
LOG_LEVEL=info
```

> **Note** — `JWT_SECRET` is also persisted in the SQLite DB on first boot
> for backward compatibility. Setting it in `.env` makes the value
> deterministic across DB resets.

### `JSON_SCHEMA_URL` — datafile schema validation

**Leave it unset.** OSCAR_Server serves the schema bundled with the Bruno
collection at `/json_validator/datafile.schema.json`, and each run is given
the address where it reaches the server: the loopback
(`http://127.0.0.1:3001/…`) when Bruno runs in the `oscar` container,
`RUN_SERVER_URL` (`http://oscar:3001/…`) when it runs in the
`oscar-runner` container (`RUN_ISOLATION=isolated`), and the internal port
for a run pod on a cluster. The schema always matches the running
collection, as both ship together. Set `JSON_SCHEMA_URL` only for a schema
of your own hosted elsewhere.

**Older installs** may still have one of these lines in `.env`:

```
JSON_SCHEMA_URL=http://127.0.0.1:3001/json_validator/datafile.schema.json
JSON_SCHEMA_URL=https://raw.githubusercontent.com/UnionInternationalCheminsdeFer/OSDM-testing/refs/heads/exch_dev/json_validator/datafile.schema.json
```

- The loopback value was this guide's advice until 1.11.523. In isolated
  mode it names the runner container, where nothing answers: every run
  logged `Error loading the schema: connect ECONNREFUSED 127.0.0.1:3001`
  and the data file went unchecked. Since 1.11.523 the server ignores a
  loopback value in that mode (and says so once in its log).
- The GitHub repository is deprecated and its schema is out of sync with
  the modern OSCAR datafile shape: a `[WARNING]` in every run log and
  false-positive validation failures (typically *"Required property
  'offerSearchCriteriaList' is missing"*).

Remove either line:

```bash
cd /opt/OSCAR/OSCAR_Deploy && sudo cp .env .env.bak.$(date +%Y%m%d) && sudo sed -i '/^JSON_SCHEMA_URL=/d' .env && sudo docker compose up -d oscar
```

Then check that the running container no longer has it (no output):

```bash
cd /opt/OSCAR/OSCAR_Deploy && sudo docker compose exec oscar printenv JSON_SCHEMA_URL
```

> **Why `up -d` and not `restart`** — environment values from `env_file`
> are baked into a container when it is **created**. `docker compose
> restart` keeps the existing container, so an edited `.env` is silently
> ignored. `docker compose up -d oscar` detects the config change and
> recreates the container with the new value. (Watchtower image updates
> don't pick up `.env` edits either — it clones the old container's
> environment — so an explicit `up -d` is the only path.) If `printenv`
> still shows the old URL, the container was not recreated.

**With the monitoring stack, name both compose files.** Compose builds a
service from the files it is given. A server started with
`-f docker-compose.yml -f docker-compose.metrics.yml` and created again with
the base file alone comes back without the volume it shares with
Alertmanager: *Apply alerting config* no longer reaches Alertmanager's file.
The running container says which files made it. These two lines read them
and name the same ones, whatever they are:

```bash
FILES=$(sudo docker inspect oscar --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}')
cd /opt/OSCAR/OSCAR_Deploy && sudo docker compose $(printf -- '-f %s ' ${FILES//,/ }) up -d oscar
```

Use them in place of every `docker compose up -d oscar` of this guide once
the monitoring stack is installed (`echo "$FILES"` shows what they read).
Done this way on production on 2026-11-22, where two files made the server.

The route is public, no auth, served from the bind-mounted `/collection`
volume inside the oscar container. There is no per-company schema — this
is a single server-wide setting.

---

## 4. Start the stack

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose up -d --build
```

Watch the boot logs:

```bash
sudo docker compose logs -f oscar
```

You should see:

```
[db] schema up to date (version 14)
[db] SQLite ready → /app/data/oscar.db (synchronous NORMAL, checkpoints thread)
Server↔collection combination is a tested release
OSCAR — OSDM Conformance Automation Runner started
[db] checkpoints run in a thread of their own, when the log passes 16 MB or every 30 s
```

If you see `Server↔collection combination is not in compatibility.json`,
the running versions are not in the tested matrix — review
[`compatibility.json`](../../compatibility.json) and either upgrade/downgrade
or accept the risk.

---

## 5. Create the first platform admin

The `/v1/auth/bootstrap/platform-user` endpoint is gated by the
`PLATFORM_BOOTSTRAP_TOKEN` from your `.env`. It creates the very first
administrator only: once an active administrator exists it answers `409
Conflict` and creates nobody (server 1.11.566; before, it answered for as
long as the token was set). Clear the token once that administrator exists
(below).

From the host (or anywhere with HTTPS access once nginx is up):

```bash
TOKEN=$(grep ^PLATFORM_BOOTSTRAP_TOKEN /opt/OSCAR/OSCAR_Deploy/.env | cut -d= -f2-)

curl -X POST http://localhost:3001/v1/auth/bootstrap/platform-user \
  -H "Content-Type: application/json" \
  -H "X-Platform-Bootstrap-Token: $TOKEN" \
  -d '{"email":"admin@example.org","password":"<strong-password>"}'
```

Expected response:

```json
{ "user": { "id": "...", "email": "admin@example.org", "role": "administrator", "company_id": "..." } }
```

Then clear the token, so that the endpoint creates nobody else. Empty the
line, then create the container again (a `restart` would keep the old
value, see the note in section 3):

```bash
sudo sed -i 's/^PLATFORM_BOOTSTRAP_TOKEN=.*/PLATFORM_BOOTSTRAP_TOKEN=/' /opt/OSCAR/OSCAR_Deploy/.env
cd /opt/OSCAR/OSCAR_Deploy && sudo docker compose up -d oscar
```

From then on the endpoint answers `503` ("PLATFORM_BOOTSTRAP_TOKEN is not
configured on server"), and further administrators are invited from the
Admin pages by an existing one.

---

## 6. nginx reverse proxy + HTTPS

Replace `oscar.example.org` below with your hostname.

```nginx
# /etc/nginx/sites-available/oscar
server {
    listen 80;
    server_name oscar.example.org;
    server_tokens off;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name oscar.example.org;

    ssl_certificate     /etc/letsencrypt/live/oscar.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/oscar.example.org/privkey.pem;

    # No version in the Server header nor in nginx's own error pages.
    server_tokens off;

    # The security headers are OSCAR's (Content-Security-Policy, HSTS,
    # X-Frame-Options and the rest, src/server.js): add none here and hide
    # none. A policy written in a proxy stays as it was written when OSCAR's
    # changes (#1423 made script-src 'self' alone).

    client_max_body_size 50M;     # for datafile uploads

    # Compression of text answers (see below)
    gzip            on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_proxied    any;
    gzip_vary       on;
    gzip_types      application/json application/problem+json application/javascript text/javascript text/css text/plain text/csv application/xml image/svg+xml;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 600s;   # Bruno runs can be long
    }
}
```

Enable + obtain a certificate:

```bash
sudo ln -s /etc/nginx/sites-available/oscar /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d oscar.example.org
```

**Version and security headers.** `server_tokens off` keeps nginx's version out of the `Server` header and its error pages. OSCAR sends its own security headers (`Content-Security-Policy`, HSTS, `X-Frame-Options`…): a site that adds one, or hides OSCAR's with `proxy_hide_header`, keeps an old policy when OSCAR's changes. To check an installed server: `curl -sI https://oscar.example.org/index.html` shows `Server: nginx` with no version, and one `Content-Security-Policy` whose `script-src` is `'self'` from server 1.11.583.

**Compression.** OSCAR compresses nothing itself, so that its one thread is
kept for the pages and the runs: nginx does it. The `gzip_types` line is what
matters: a distribution's `nginx.conf` usually has `gzip on;` alone, which
compresses HTML and nothing else, and OSCAR's answers are mostly JSON and
JavaScript. With it, the Test Config script goes from 556 KB to about 150 KB
on the wire, and a data file of 1.9 MB to about 110 KB.

To check, from any machine (the answer must name `gzip`):

```bash
HOST=oscar.example.org     # ← yours
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' "https://$HOST/js/scenarios.js" | grep -i '^content-encoding'
```

An installation made before this section existed has no `gzip_types` line.
The simplest there is a file of its own: it touches neither the site's file
nor `nginx.conf`, and removing it goes back. The command checks the
configuration before it reloads, and removes the file if nginx refuses it:

```bash
FILE=/etc/nginx/conf.d/oscar-compression.conf     # ← yours
printf '%s\n' 'gzip_comp_level 5;' 'gzip_min_length 1024;' 'gzip_proxied    any;' 'gzip_vary       on;' 'gzip_types      application/json application/problem+json application/javascript text/javascript text/css text/plain text/csv application/xml image/svg+xml;' | sudo tee "$FILE" > /dev/null
if sudo nginx -t; then sudo systemctl reload nginx && echo reloaded; else sudo rm "$FILE"; echo "refused: file removed, nothing changed"; fi
```

No `gzip on;` in that file: Ubuntu's `nginx.conf` already says it for the
whole server, and saying it twice at the same level is an error (`nginx -t`
names it). On a distribution whose `nginx.conf` has none, add the line. A
reload cuts no connection and stops no run. Done this way on production on
2026-11-22: the Test Config script went from 555,602 to 150,043 bytes on the
wire.

---

## 7. Smoke-test

```bash
curl -s https://oscar.example.org/health | jq
```

Expected:

```json
{
  "status": "ok",
  "version": "1.2.0",
  "server_version": "1.2.0",
  "collection_version": "OTST_V2.0.1",
  "release_label": "2026.04",
  "compatibility_status": "tested",
  "checks": {
    "database":  { "ok": true, "status": "ok" },
    "queue":     { "ok": true, "depth": 0, "running": 0 },
    "data_dir":  { "ok": true, "status": "writable" },
    "disk":      { "ok": true, "free_mb": 12345 },
    "process":   { "ok": true, "uptime_seconds": 42, "memory_mb": 80, "node_version": "v22.x" }
  }
}
```

If `compatibility_status` is `"untested_combination"`, you're running a
non-matrix combination — supported but not formally tested.

A check that fails reads `"ok": false` with an `error` code (`EACCES`,
`ENOSPC`…), and the answer is `503` with `"status": "degraded"`. The reason
in full is in the server's log (`docker compose logs oscar`), not in the
answer, which anyone can read. The data folder and the free space are read
at most every 10 seconds.

Open the UI at `https://oscar.example.org`, log in with the platform admin
you created in step 5, and start onboarding companies.

---

## 8. Day-2 operations

| Task                       | Command (run from `/opt/OSCAR/OSCAR_Deploy`)                |
| -------------------------- | ----------------------------------------------------------- |
| Tail logs                  | `sudo docker compose logs -f oscar`                         |
| Restart                    | `sudo docker compose restart oscar`                         |
| Apply a change of `.env`   | `sudo docker compose up -d oscar` (a `restart` keeps the container, and its old values; with the monitoring stack, name both compose files: see the notes in section 3) |
| Upgrade to a new release   | `cd /opt/OSCAR && sudo git pull && cd OSCAR_Deploy && sudo docker compose up -d --build` |
| Update collection only     | `cd /opt/OSCAR && sudo git pull` (no rebuild needed — collection is bind-mounted) |
| Backup DB + artifacts      | `sudo docker compose stop oscar && sudo tar czf oscar-backup-$(date +%F).tar.gz data/ && sudo docker compose start oscar` |
| Inspect running config     | `sudo docker compose exec oscar env \| grep -E 'COLLECTION\|BRU_CMD\|MAX_'` |
| Rotate JWT secret          | UI → Admin → Server Config → Rotate JWT Secret              |

---

## 9. Troubleshooting

| Symptom                                        | Likely cause / fix                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `502 Bad Gateway` from nginx                   | Container not running. `sudo docker compose ps` and check logs.                                             |
| `MODULE_NOT_FOUND … package.json`              | Outdated Dockerfile. Pull latest and rebuild.                                                               |
| `Invalid bootstrap token`                      | Token must be sent in the `X-Platform-Bootstrap-Token` header (not the body) and match `.env` byte-for-byte. |
| `compatibility_status: untested_combination`   | You're running server/collection versions not in `compatibility.json`. Either pin to a tested release tag or review the matrix. |
| Container restarts in a loop                   | Missing required env var. Check `sudo docker compose logs oscar --tail=20` for the FATAL line.              |
| `permission denied` writing to `data/`         | `data/` should be owned by UID 1000 (the `node` user inside the image). `sudo chown -R 1000:1000 data/`.    |

For deeper issues, see `Documentation/Server_Operations/SECURITY_FIXES.md`
for known security-related notes, and the structured logs (Pino JSON) for
contextual error details.

---

## 10. Kubernetes or OpenShift instead of Docker Compose

Since server 1.11.443 (release 2026.481) OSCAR also runs on a Kubernetes
cluster or on OpenShift, from the files in
[`OSCAR_Deploy/kubernetes/`](../../OSCAR_Deploy/kubernetes/). This section
says what changes and gives the outline; the full procedure is the
[OSCAR - Kubernetes and OpenShift Deployment Guide](OSCAR%20-%20Kubernetes%20and%20OpenShift%20Deployment%20Guide.md).

**When to choose it.** Your organisation runs its services on a cluster
rather than on servers of their own, or the OSDM test systems you need to
reach are reachable from the cluster's network.

**What stays the same.** The server, its settings (the variables of
section 3) and everything done in OSCAR's pages afterwards.

**What differs.**

| | Docker Compose (sections 1–9) | Kubernetes or OpenShift |
|---|---|---|
| Instances | one container | one pod, never more: the database (SQLite) and the run queue belong to one process |
| Test collection | a folder beside the container, updated with `git pull` | inside the image, built from the release you deploy |
| HTTPS | nginx on the host (section 6) | the cluster's Ingress or Route |
| `/metrics` | nginx hides it from outside | OSCAR asks for `METRICS_TOKEN` |
| Updates | Watchtower follows `:stable` | you change the image tag and apply |
| Restarts | the autoheal sidecar | Kubernetes, from the liveness probe |
| Backups | `oscar-backup.sh` on the host | volume snapshots of `oscar-data` |

**Outline**, from a checkout of the release to deploy:

1. Build and push the image:

   ```bash
   OSCAR_Deploy/kubernetes/build-images.sh registry.example.org/oscar release-2026.481
   docker push registry.example.org/oscar/oscar:release-2026.481
   ```

2. Create the Secret `oscar-secrets` from
   [`base/secrets.env.example`](../../OSCAR_Deploy/kubernetes/base/secrets.env.example)
   (the secrets of section 3, plus `METRICS_TOKEN`), filled in outside the
   repository:

   ```bash
   kubectl create namespace oscar
   kubectl -n oscar create secret generic oscar-secrets --from-env-file=secrets.env
   ```

3. In `overlays/kubernetes` (Ingress) or `overlays/openshift` (Route), set
   your image and your host.
4. Apply it:

   ```bash
   kubectl -n oscar apply -k OSCAR_Deploy/kubernetes/overlays/kubernetes
   # OpenShift: oc apply -k OSCAR_Deploy/kubernetes/overlays/openshift
   ```

5. Create the first platform admin as in section 5, at your host's address.

**Providers behind a VPN.** If the OSDM test systems are reached through a
VPN or a private network, the cluster needs its own route to them, and OSCAR
refuses private addresses unless `ALLOW_PRIVATE_TARGETS=1`, which turns that
check off entirely. The guide's section 7 says how to put the limit back in
the network.

**Tested how.** Every change to these files, and every week, a CI workflow
deploys them on a throw-away Kubernetes cluster under an OpenShift-style user
id and runs a scenario against the OSDM simulator. They have not yet been run
on a real OpenShift cluster.
