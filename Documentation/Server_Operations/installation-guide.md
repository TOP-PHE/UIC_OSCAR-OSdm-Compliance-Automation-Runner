# OSCAR — Installation Guide

This guide walks through deploying OSCAR (server + Bruno collection + UI) on
a Linux VPS using Docker Compose. It assumes a clean Ubuntu 22.04 LTS host
fronted by nginx (or another reverse proxy) for HTTPS termination.

For the legacy single-folder deployment guide, see
[OSCAR - VPS Deployment Guide.md](./OSCAR%20-%20VPS%20Deployment%20Guide.md).
The procedure below supersedes it for the monorepo layout.

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
sudo git clone https://github.com/UICrail/OSCAR-OSdm-Compliance-Automation-Runner.git OSCAR
sudo chown -R "$USER:$USER" /opt/OSCAR
cd /opt/OSCAR
```

Pin to a known-good combined release tag (see `compatibility.json` for the
list of tested combinations):

```bash
git fetch --tags
git checkout release-2026.04   # or whichever release you intend to deploy
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

From v1.11.112 the default value points at the schema **bundled with the
Bruno collection and served by OSCAR_Server itself** at the loopback URL:

```
JSON_SCHEMA_URL=http://127.0.0.1:3001/json_validator/datafile.schema.json
```

Leave this default unchanged unless you maintain a custom schema. It works
offline and always matches the running collection's expectations because
both ship together.

**Older installs** may have an obsolete value pointing at:

```
https://raw.githubusercontent.com/UnionInternationalCheminsdeFer/OSDM-testing/refs/heads/exch_dev/json_validator/datafile.schema.json
```

That repo is deprecated and its schema is out of sync with the modern
OSCAR datafile shape — you'll see a `[WARNING]` in every run log and
false-positive validation failures (typically *"Required property
'offerSearchCriteriaList' is missing"*). To fix:

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo cp .env .env.bak.$(date +%Y%m%d)
sudo nano .env
# → set JSON_SCHEMA_URL=http://127.0.0.1:3001/json_validator/datafile.schema.json
sudo docker compose up -d oscar
# verify the running container actually sees the new value:
sudo docker compose exec oscar printenv JSON_SCHEMA_URL
```

> **Why `up -d` and not `restart`** — environment values from `env_file`
> are baked into a container when it is **created**. `docker compose
> restart` keeps the existing container, so an edited `.env` is silently
> ignored — the run logs keep showing the old URL and the false-positive
> failures continue. `docker compose up -d oscar` detects the config
> change and recreates the container with the new value. (Watchtower
> image updates don't pick up `.env` edits either — it clones the old
> container's environment — so an explicit `up -d` is the only path.)
> The `printenv` line confirms the value landed; if it still shows the
> old URL, the container was not recreated.

The route is public, no auth, served from the bind-mounted `/collection`
volume inside the oscar container. There is no per-company schema — this
is a single VPS-wide setting.

Since v1.11.115 the server also **defaults** to the loopback URL when
`JSON_SCHEMA_URL` is not set at all, so removing the line from `.env`
entirely (then `up -d`) is equally valid.

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
[db] SQLite ready → /app/data/oscar.db
Server↔collection combination is a tested release
OSCAR — OSDM Conformance Automation Runner started
```

If you see `Server↔collection combination is not in compatibility.json`,
the running versions are not in the tested matrix — review
[`compatibility.json`](../../compatibility.json) and either upgrade/downgrade
or accept the risk.

---

## 5. Create the first platform admin

The `/v1/auth/bootstrap/platform-user` endpoint is gated by the
`PLATFORM_BOOTSTRAP_TOKEN` from your `.env`. It can only create the very
first administrator.

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
{ "id": "...", "email": "admin@example.org", "role": "platform_admin" }
```

After this, the bootstrap endpoint returns `409 Conflict` for any further
attempt — the admin is created via the UI from now on.

---

## 6. nginx reverse proxy + HTTPS

Replace `oscar.example.org` below with your hostname.

```nginx
# /etc/nginx/sites-available/oscar
server {
    listen 80;
    server_name oscar.example.org;
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name oscar.example.org;

    ssl_certificate     /etc/letsencrypt/live/oscar.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/oscar.example.org/privkey.pem;

    client_max_body_size 50M;     # for datafile uploads

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

Open the UI at `https://oscar.example.org`, log in with the platform admin
you created in step 5, and start onboarding companies.

---

## 8. Day-2 operations

| Task                       | Command (run from `/opt/OSCAR/OSCAR_Deploy`)                |
| -------------------------- | ----------------------------------------------------------- |
| Tail logs                  | `sudo docker compose logs -f oscar`                         |
| Restart                    | `sudo docker compose restart oscar`                         |
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
