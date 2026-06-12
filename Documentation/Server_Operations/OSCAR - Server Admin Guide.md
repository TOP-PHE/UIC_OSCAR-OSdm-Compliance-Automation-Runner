# OSCAR — Server Administrator Guide

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC, Union Internationale des Chemins de fer © 2026."

---

## 1. Overview

OSCAR (OSDM Conformance Automation Runner) is a Node.js server process that runs locally on a Windows machine. It exposes a web interface on port 3001 and manages the execution of OTST Bruno test collections against OSDM API endpoints.

This guide covers day-to-day server operations for the administrator: starting, stopping, monitoring, and troubleshooting.

---

## 2. Prerequisites

Before starting the server, verify the following are in place:

| Item | Expected value / location |
|---|---|
| Node.js | v22.5 or higher (v24 recommended). Run `node -v` to check. |
| Bruno CLI | `C:\Users\patri\AppData\Roaming\npm\bru.cmd` |
| OTST Collection | `C:\Users\patri\OneDrive\...\OTST_V2.0.1` |
| Server folder | `C:\Users\patri\OneDrive\...\UIC-OSCAR\oscar-server` |
| `.env` file | Must exist in the server folder root (see Section 7) |
| `node_modules` | Must exist. If not, run `npm install` once before first start. |

---

## 3. Starting the Server

### 3.1 Normal Start

Open a PowerShell window and run:

```powershell
cd "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\UIC-OSCAR\oscar-server"
node src/server.js
```

You should see the startup banner:

```
╔═══════════════════════════════════════════════╗
║   OSCAR — OSDM Conformance Automation Runner  ║
║   http://localhost:3001                        ║
╚═══════════════════════════════════════════════╝

[server] Collection : C:\Users\patri\...\OTST_V2.0.1
[server] Bruno CLI  : C:\Users\patri\AppData\Roaming\npm\bru.cmd
[server] Data dir   : C:\Users\patri\...\oscar-server\data\datafiles
```

The server is ready when you see that banner. Open `http://localhost:3001` in a browser to access the web UI.

### 3.2 Development Mode (auto-restart on file changes)

```powershell
node --watch src/server.js
```

Use this during development only. The process restarts automatically when any source file changes.

### 3.3 Keeping the PowerShell window open

The server process is attached to the PowerShell window. **Do not close the window** while the server needs to be running. If you close it, the server stops immediately.

To keep the server running in the background, use Windows Task Scheduler (see Section 6) or simply leave the PowerShell window minimized.

---

## 4. Stopping the Server

### 4.1 Clean Stop (recommended)

In the PowerShell window where the server is running, press:

```
Ctrl + C
```

This sends an interrupt signal. The server finishes any in-flight requests and exits cleanly. Any run currently executing will be interrupted.

### 4.2 Force Stop — Port Already in Use

If you try to start the server and get:

```
Error: listen EADDRINUSE: address already in use :::3001
```

It means a previous server process is still running (possibly from a previous PowerShell session that was closed without `Ctrl+C`).

**Find and kill the process occupying port 3001:**

```powershell
# Step 1 — find the process ID (PID) using port 3001
Get-NetTCPConnection -LocalPort 3001 -State Listen

# Step 2 — kill it (replace 1234 with the actual PID shown above)
Stop-Process -Id 1234 -Force
```

Or in a single command:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force
```

Then start the server normally.

### 4.3 Force Stop — Process Not Responding

If the Node.js process hangs and `Ctrl+C` is not working:

```powershell
# Kill all Node.js processes (use only if you have no other Node processes running)
Stop-Process -Name node -Force

# Or target a specific PID
Stop-Process -Id <PID> -Force
```

To find the PID of the OSCAR server process:

```powershell
Get-Process node | Select-Object Id, CPU, WorkingSet, StartTime
```

---

## 5. Checking Server Status

### 5.1 Health Check Endpoint

While the server is running, open a browser or run:

```powershell
Invoke-RestMethod http://localhost:3001/health
```

Expected response:

```json
{
  "status": "ok",
  "version": "1.0.0",
  "queue": {
    "depth": 0,
    "running": 0
  }
}
```

- `queue.depth` — number of runs waiting to execute.
- `queue.running` — number of runs currently executing (max 1 in MVP).

### 5.2 Checking if the Port is Occupied

```powershell
Get-NetTCPConnection -LocalPort 3001 -State Listen
```

If this returns a row, the server is running. If it returns nothing, the server is stopped.

### 5.3 Checking the Node.js Process

```powershell
Get-Process node
```

---

## 6. Restarting the Server

There is no daemon or service wrapper in the MVP. Restart = stop then start.

```powershell
# Stop (if running in this window)
Ctrl + C

# Or force stop if needed
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force

# Start again
node src/server.js
```

**When to restart:**
- After editing any file in `src/`.
- After editing `.env`.
- After running `npm install` to add or update packages.
- After a crash (the process exits automatically on unhandled exceptions).

---

## 7. Configuration — The `.env` File

All **boot-time** server configuration is in `oscar-server\.env`. The server reads this file on startup.

> **Since v1.7.0**, most operational settings (`MAX_CONCURRENT_RUNS`, `PARALLEL_STAGGER_MS`, `RUN_TIMEOUT_MS`, `LOG_LEVEL`, all `SMTP_*`) are also editable at runtime from **Admin → Server Config** in the web UI, **without a restart**. The DB value takes precedence over the matching `.env` value as soon as you save it. The `.env` file is still used to seed the database on first boot, and to hold the secrets that must exist before the DB is even open (`ENCRYPTION_KEY`, `JWT_SECRET`, `OSCAR_DB_PATH`, `PORT`).

```ini
# Port the server listens on
PORT=3001

# Secret used to sign JWT authentication tokens
# Change before any production deployment
JWT_SECRET=oscar-uic-jwt-secret-change-before-production-deployment-2026

# 32-byte AES-256 key (64 hex characters) used to encrypt credentials in the database
# Generate a new one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# WARNING: changing this key will invalidate all stored encrypted credentials
ENCRYPTION_KEY=6db303fa21634cb8ddb0fb014306dfef4c93cb1f6af5975fcb0b29029148e34b

# Absolute path to the root of the OTST Bruno collection
COLLECTION_PATH=C:\Users\patri\OneDrive\...\OTST_V2.0.1

# Full path to the Bruno CLI command
BRU_CMD=C:\Users\patri\AppData\Roaming\npm\bru.cmd

# URL of the OSDM data file JSON schema (used for validation).
# Since v1.11.112 OSCAR serves the schema itself; leave the default.
# Do NOT use the deprecated OSDM-testing/exch_dev GitHub URL — its schema
# is out of sync and produces false-positive validation failures.
JSON_SCHEMA_URL=http://127.0.0.1:3001/json_validator/datafile.schema.json

# Maximum time (ms) a single Bruno run is allowed to run before it is killed
RUN_TIMEOUT_MS=600000

# Maximum number of simultaneous runs (keep at 1 for MVP)
MAX_CONCURRENT_RUNS=1
```

### Environment Variables Reference

#### Required

| Variable | Description |
|----------|-------------|
| `ENCRYPTION_KEY` | AES-256-GCM key (64 hex chars) |
| `COLLECTION_PATH` | Absolute path to Bruno collection folder |
| `BRU_CMD` | Absolute path to `bru.cmd` (Windows) or `bru` (Linux) executable |

#### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `MAX_CONCURRENT_RUNS` | `10` | Global cap on parallel runs (also editable in admin UI) |
| `PARALLEL_STAGGER_MS` | `2000` | Delay between batch job launches (ms) |
| `RUN_TIMEOUT_MS` | `600000` | Hard timeout per run (ms, default 10 min). A scenario can request a longer wait via `expiredBookingMaxWaitMinutes` (#204) — see the next row for the cap. |
| `RUN_HARD_MAX_TIMEOUT_MS` | `1800000` | **Server-wide ceiling** for the per-run hard timeout when a scenario opts into a longer wait (`expiredBookingMaxWaitMinutes` on the expired-booking test, #204). The runner extends the worker SIGTERM to `max(RUN_TIMEOUT_MS, scenario wait + buffer)` but never above this value. Default 30 min. Raise it if you need to test providers with confirmation deadlines longer than ~25 min — e.g. an expired-OFFER test against a provider whose `preBookableUntil` is offer +30 min needs ≥ `1920000`. Since #394 also editable in the admin panel (Server Config → "Run Budget Ceiling (ms)"); a value saved there is stored in `server_config` and **overrides this env var**. |
| `TOKEN_WATCHDOG_INTERVAL_MS` | `300000` | **OAuth token watchdog tick interval** (#204). While a Bruno run is in flight, the runner ticks every N ms and calls `resolveAccessToken` on the cached per-tester token — the cache's own safety-margin check then decides whether to refetch from the OAuth server or no-op against cache. Keeps the cached token fresh under long-running scenario series. Default 5 min. Set to `0` to disable. Skipped automatically for bearer-mode runs. |
| `ALLOWED_ORIGINS` | (all) | Comma-separated CORS whitelist |
| `APP_URL` | `http://localhost:3001` | Base URL for email verification links |
| `NODE_ENV` | (unset) | Set to `production` for SMTP email sending |
| `PLATFORM_BOOTSTRAP_TOKEN` | (unset) | One-time token for creating admin users |

#### SMTP (required for email verification in production)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | (unset) | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | Use TLS (`true` for port 465) |
| `SMTP_USER` | (unset) | SMTP username |
| `SMTP_PASS` | (unset) | SMTP password |
| `SMTP_FROM` | `noreply@oscar` | From header for emails |

All passwords must be at least 12 characters and contain uppercase, lowercase, and a digit.

### 7.1 Changing the Port

Edit `PORT=3001` to any free port, then restart. Access the UI at `http://localhost:<new_port>`.

### 7.2 Rotating the Encryption Key

> **Warning:** If you change `ENCRYPTION_KEY`, all previously encrypted credentials stored in the database (bearer tokens, client secrets, etc.) become unreadable. Every company profile will need to be reconfigured after a key rotation.

To generate a new key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 8. Data and File Locations

| Location | Contents |
|---|---|
| `data/oscar.db` | SQLite database — users, companies, runs, logs |
| `data/datafiles/` | Uploaded data files (`{slug}-datafile.json` per company) |
| `data/artifacts/` | Per-run artifacts: `{runId}/report.html`, `{runId}/.bru_results.json` |
| `{COLLECTION_PATH}/environments/` | Ephemeral `.yml` env files (created at run start, deleted at run end) |
| `{COLLECTION_PATH}/Validation_Reports/` | Raw HTML reports from `reportGenerator.js` (Bruno writes here) |

### 8.1 Database Backup

The entire state of OSCAR is contained in a single file: `data/oscar.db`.

To back it up (while the server is stopped):

```powershell
Copy-Item "data\oscar.db" "data\oscar.db.backup-$(Get-Date -Format 'yyyyMMdd')"
```

To restore, stop the server, replace `oscar.db` with the backup, and restart.

### 8.2 Cleaning Up Old Artifacts

Artifacts accumulate in `data/artifacts/` — one folder per run. To free disk space, delete old run folders manually (the run record in the database will remain, but artifact download links will show "file missing").

---

## 9. Common Issues and Fixes

### 9.1 Port Already in Use

```
Error: listen EADDRINUSE: address already in use :::3001
```

**Fix:**
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force
node src/server.js
```

### 9.2 Missing Environment Variables on Start

```
[server] FATAL: Missing required environment variables: ENCRYPTION_KEY, COLLECTION_PATH
```

**Fix:** Check that `.env` exists in the `oscar-server` folder and contains all required keys. The server must be started from inside the `oscar-server` directory.

### 9.3 Run Stays QUEUED Forever

**Possible causes:**
- A previous run is still executing (MVP allows only 1 concurrent run).
- The previous run crashed mid-execution, leaving the queue locked.

**Fix:** Restart the server. Runs that were RUNNING when the server crashed will remain in RUNNING state in the database — update them manually if needed:

```powershell
# Open the SQLite database and manually fix stuck runs
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('data/oscar.db');
  const r = db.prepare(\"UPDATE runs SET status='FAILED', error_message='Server restarted during execution' WHERE status='RUNNING'\").run();
  console.log('Fixed', r.changes, 'stuck run(s)');
"
```

### 9.4 Bruno Not Found

```
[runner] Process error: spawn bru.cmd ENOENT
```

**Fix:** Verify `BRU_CMD` in `.env` points to the correct path:

```powershell
Test-Path "C:\Users\patri\AppData\Roaming\npm\bru.cmd"
# Should return: True
```

### 9.5 Run Completes But No HTML Report Artifact

Check the server logs for `[runner] No reportGenerator HTML found`. This means `reportGenerator.js` did not produce a report file in `Validation_Reports/`.

**Possible causes:**
- The Bruno collection errored before any assertion was written.
- The `COLLECTION_PATH` is wrong.
- `Validation_Reports/` directory could not be created.

### 9.6 SQLite Experimental Warning

```
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

This is expected on Node.js 22/24. The built-in `node:sqlite` module is stable enough for MVP use. Suppress it with:

```powershell
node --no-warnings src/server.js
```

### 9.7 Data File Not Found During Run

```
No data file uploaded. Upload a data file in your company profile before running.
```

**Fix:** Go to the company profile page (`/profile.html`) and upload a `datafile.json` for the company before submitting a run.

### 9.8 `npm audit` Warnings After Install

After `npm install` (or an `npm ci`), npm may print advisories like:

```
# npm audit report
uuid  <14.0.0
Severity: moderate
uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided
fix available via `npm audit fix --force`
Will install uuid@14.0.0, which is a breaking change
```

**Do not run `npm audit fix --force` reflexively.** The `--force` flag disables npm's semver safety and accepts major-version upgrades — those can introduce breaking API changes that OSCAR's code hasn't been tested against.

**Policy for OSCAR:**

1. **Read the advisory first.** Many advisories describe vulnerabilities in API surfaces OSCAR doesn't use. For example, the uuid v3/v5/v6 buffer-bounds CVE is irrelevant to us because every OSCAR call site uses `uuid.v4()` only, never the vulnerable variants.
2. **`npm audit fix` (without `--force`)** is safe — it only applies patch and minor updates that the package.json's caret range (`^x.y.z`) already permits. Run this freely after upgrades.
3. **`npm audit fix --force`** is **forbidden** without prior review. It crosses semver-major boundaries and may replace a dependency with an incompatible successor in a single command. If an advisory genuinely affects OSCAR and only a major upgrade fixes it, raise it on the OSCAR repo so it can be tested on a branch before going to production.
4. **If someone already ran `--force` on the VPS**, revert from the committed files and reinstall pristinely:

   ```bash
   cd /home/oscaradmin/oscar-server
   git checkout package.json package-lock.json
   npm ci        # clean install — exact versions from the lock file
   pm2 restart oscar
   ```
   `npm ci` will recreate `node_modules` matching the lock file exactly; any ad-hoc version bump disappears.

5. **Filtering low-severity noise**, if you want to see only actionable items:

   ```bash
   npm audit --audit-level=high
   ```
   This suppresses `moderate` and lower, which is appropriate once you've confirmed they don't apply to OSCAR.

**Current status (April 2026):** the only outstanding advisory is the uuid v3/v5/v6 buffer-bounds issue (GHSA-w5hq-g745-h8pq). OSCAR is not exposed — all eight call sites use `v4` without a `buf` argument. No action required.

---

## 10. Verifying the Full Installation

Run this checklist after initial setup or after moving the server to a new machine:

```powershell
# 1. Check Node.js version (must be 22.5+)
node -v

# 2. Check Bruno CLI is accessible
& "C:\Users\patri\AppData\Roaming\npm\bru.cmd" --version

# 3. Check the collection folder exists
Test-Path "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\Bruno_tests\OTST_Bruno_Workspace\OTST_V2.0.1"

# 4. Check .env file exists
Test-Path ".\oscar-server\.env"

# 5. Check dependencies are installed
Test-Path ".\oscar-server\node_modules"

# 6. Start the server and hit the health endpoint
node src/server.js
# In another window:
Invoke-RestMethod http://localhost:3001/health
```

---

## 11. Server Upgrade — GitHub Code Sync

OSCAR consists of two independent Git repositories that must be kept up to date:

| Component | GitHub Repository | Branch | VPS Path |
|---|---|---|---|
| OSCAR Server | https://github.com/TOP-PHE/OSCAR-OSdm-Compliance-Automation-Runner | `main` | `/home/oscaradmin/oscar-server` |
| OTST Bruno Collection | https://github.com/UnionInternationalCheminsdeFer/OSDM-testing | `Bruno-Enhancements` | `/home/oscaradmin/OTST_V2.0.1` |

> **Important:** The Bruno collection lives inside a subdirectory of the `OSDM-testing` repository (`collections-bruno/OTST_V2.0.1`). On the VPS, the folder `/home/oscaradmin/OTST_V2.0.1` is a sparse checkout or copy of that subdirectory. The `git pull` commands below assume the VPS folder is already connected to the correct remote and branch.

---

### 11.1 Upgrading the OSCAR Server (Windows — local)

**Step 1 — Stop the server**

```powershell
# Press Ctrl+C in the server window, or force stop:
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force
```

**Step 2 — Pull the latest code from GitHub**

```powershell
cd "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\UIC-OSCAR\oscar-server"
git pull origin main
```

**Step 3 — Install or update dependencies**

Run this every time — it is a no-op if nothing changed in `package.json`:

```powershell
npm install
```

**Step 4 — Restart the server**

```powershell
node src/server.js
```

**Step 5 — Verify**

```powershell
Invoke-RestMethod http://localhost:3001/health
```

**Single-command upgrade (stop → pull → install → start):**

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force; cd "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\UIC-OSCAR\oscar-server"; git pull origin main; npm install; node src/server.js
```

---

### 11.2 Upgrading the Bruno OTST Collection (Windows — local)

The OTST Bruno collection is maintained by UIC on the `Bruno-Enhancements` branch. No server restart is needed after updating — the collection path is read at each run execution.

```powershell
cd "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\GitHub_OSDM-Testing\OSDM-testing\O\collections-bruno\OTST_V2.0.1"
git pull origin Bruno-Enhancements
```

> **Note:** If the collection has moved to a new folder name (e.g. `OTST_V3.0.0`), update the `COLLECTION_PATH` variable in `.env` accordingly and restart the server.

---

### 11.3 Upgrading Bruno CLI

To update the Bruno CLI to the latest version:

```powershell
npm update -g @usebruno/cli
```

Verify the new version:

```powershell
bru --version
```

No server restart is needed — the CLI is invoked as an external process for each run.

---

### 11.4 Upgrading on VPS (Production)

#### OSCAR Server

If Git authentication fails because the token is invalid, follow this token sync procedure first.

**Step 1 — Generate a new token (if the old one expired)**

1. Go to https://github.com/settings/tokens.
2. Click **Generate new token (classic)**.
3. Set:
  - **Note:** OSCAR VPS deploy
  - **Expiration:** pick what suits you
  - **Scope:** check `repo`
4. Copy the `ghp_...` token (it is shown only once).

**Step 2 — Pull again, using the token as password**

When prompted by Git during pull, use your GitHub username and paste the token as the password.

```bash
cd /home/oscaradmin/oscar-server
git pull origin main
```

After this first authenticated pull, use your GitHub account password for subsequent pulls.

```bash
# SSH into the VPS
ssh oscaradmin@YOUR_VPS_IP

# If Git authentication fails because the token is invalid,
# recreate the GitHub token and use it for the first pull,
# then use your GitHub account password for subsequent pulls.

# Discard local package-lock changes before pulling,
# then pull latest code, install dependencies, restart
cd /home/oscaradmin/oscar-server
git checkout -- package-lock.json
git pull origin main
npm install
pm2 restart oscar

# Verify
curl http://localhost:3001/health
```

**Single-command version:**

```bash
cd /home/oscaradmin/oscar-server && git checkout -- package-lock.json && git pull origin main && npm install && pm2 restart oscar
```

> **If `npm install` prints an `npm audit` advisory:** do not run `npm audit fix --force` as a reflex — see [Section 9.8](#98-npm-audit-warnings-after-install) for how to evaluate advisories and revert if someone already forced a major-version bump.

#### Bruno OTST Collection

```bash
cd /home/oscaradmin/OSDM-testing
git stash
git pull origin Bruno-Enhancements
```

No server restart is needed.

#### Bruno CLI

```bash
sudo npm update -g @usebruno/cli
bru --version
```

---

### 11.5 Upgrade Checklist

| Step | Windows (local) | VPS (production) |
|---|---|---|
| Stop server | `Ctrl+C` or force stop | `pm2 stop oscar` |
| Pull OSCAR code | `git pull origin main` (in `oscar-server`) | `cd /home/oscaradmin/oscar-server && git pull origin main` |
| Install dependencies | `npm install` | `npm install` |
| Start server | `node src/server.js` | `pm2 restart oscar` |
| Pull Bruno collection | `git pull origin Bruno-Enhancements` (in OTST folder) | `cd /home/oscaradmin/OTST_V2.0.1 && git pull origin Bruno-Enhancements` |
| Update Bruno CLI | `npm update -g @usebruno/cli` | `sudo npm update -g @usebruno/cli` |
| Verify health | `Invoke-RestMethod http://localhost:3001/health` | `curl http://localhost:3001/health` |

---

## 12. Quick Reference Card

| Action | Command |
|---|---|
| Start server | `node src/server.js` |
| Start (dev, auto-reload) | `node --watch src/server.js` |
| Stop cleanly | `Ctrl + C` in server window |
| Force stop (port in use) | `Stop-Process -Id (Get-NetTCPConnection -LocalPort 3001 -State Listen).OwningProcess -Force` |
| Force stop (all Node) | `Stop-Process -Name node -Force` |
| Check if running | `Get-NetTCPConnection -LocalPort 3001 -State Listen` |
| Health check | `Invoke-RestMethod http://localhost:3001/health` |
| Backup database | `Copy-Item data\oscar.db data\oscar.db.backup` |
| Fix stuck runs | See Section 9.3 |
| Generate new encryption key | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## 13. Admin Web Tools (v1.6+)

Once you log in as **administrator**, the top navigation exposes a set of admin-only screens. None of them require SSH access — everything below is doable from a browser.

### 13.1 Manage Users / Companies

`/admin.html?tab=users` and `?tab=companies`. Create, rename, reassign, soft-delete users and companies. Notable details:

- **Reset password** for any user (since v1.6) — choose between sending an email reset link (requires SMTP configured) or generating an out-of-band link you copy-paste into Slack/Teams (works even when SMTP is down — issue #15 workaround).
- **Privacy toggle** on each company (`share_reports_with_certifier`) controls whether `certification_user` accounts can see that company's runs. Default = on, matching legacy behaviour.

### 13.2 Server Activity

`/admin.html?tab=activity`. Live counters: total runs / users / companies, runs in last 24 h, login successes vs. failures, top submitters, latest 50 auth events. Refreshes on tab-switch.

### 13.3 Server Config (v1.7)

`/admin.html?tab=config`. Two cards:

- **Runtime Config** — change `MAX_CONCURRENT_RUNS`, `PARALLEL_STAGGER_MS`, `RUN_TIMEOUT_MS`, `LOG_LEVEL`, and all `SMTP_*` settings. Save applies immediately — the worker queue re-reads on every drain, the runner re-reads per run, and `LOG_LEVEL` swaps the active pino sink. **No restart needed.** Audit-logged.
- **Server Info** — read-only: version, Node version, platform, uptime, collection path, Bruno binary path, DB path. Useful when filing a bug or talking to support.

There is also a **Send test email** button — exercises the current SMTP config end-to-end and shows the verbatim SMTP error if delivery fails. Closes the diagnostic gap that issue #14 surfaced.

A **Rotate JWT Secret** button is available too — generates a fresh secret, invalidates every active session immediately. Use after a suspected token leak.

### 13.4 Admin Dashboard (Grafana / Prometheus / Logs)

`/admin-dashboard.html`. Three tiles:

| Tile | Backed by | What it shows |
|---|---|---|
| **Grafana** | grafana/grafana | Live operational dashboards — HTTP latency, run throughput, queue depth, process resources. Pre-provisioned **OSCAR · Overview** dashboard. |
| **Prometheus** | prom/prometheus | Raw metrics database. Useful for ad-hoc PromQL, scrape-target health (`/prometheus/targets`), confirming alert state under `/prometheus/alerts`. |
| **Logs (Loki)** | grafana/loki + grafana/promtail | Centralised log aggregation across OSCAR + Bruno workers. Pre-provisioned **OSCAR · Logs** dashboard with errors-only view, full live tail, per-container filter. |

All three are gated by **OSCAR SSO** — your OSCAR admin login auto-signs you in. No separate Grafana/Prometheus passwords. Non-admin accounts see a 401 if they try to navigate there.

These tiles are **opt-in**. They light up only if the operator brought the metrics overlay up:

```bash
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d
```

Full setup notes: [`metrics-and-monitoring.md`](metrics-and-monitoring.md).

---

## 14. Operational Monitoring & Alerting (v1.8)

OSCAR ships a self-healing + paging stack so production incidents get caught and (where possible) fixed before an admin notices.

### 14.1 What's wired up

| Layer | Component | Behaviour |
|---|---|---|
| **Health probe** | Docker `healthcheck` on the `oscar` container | Hits `GET /health` every 30 s. Three failures in a row → container marked `unhealthy`. |
| **Auto-restart** | `willfarrell/autoheal` sidecar (~5 MB) | Polls Docker every 30 s. Any container labelled `autoheal=true` that goes unhealthy is restarted. No human action needed for transient hangs. |
| **Metrics** | `prom/prometheus` (existing since v1.5) | Scrapes `/metrics` every 15 s. Evaluates the alert rules in `prometheus/alerts/oscar-alerts.yml`. |
| **Routing + email** | `prom/alertmanager` (new in v1.8) | Receives firing alerts, dedupes, groups, and emails the OSCAR admin distribution list. Re-pages criticals every 1 h until acknowledged, warnings every 4 h. |
| **Logs** | Loki + Promtail (since v1.7) | Centralised log aggregation — query via Grafana to triage what an alert actually meant. |

### 14.2 The default alert rules

| Alert | Severity | Fires when | Typical fix |
|---|---|---|---|
| `OscarServerDown` | critical | `/metrics` unscrapeable for 2 min | Autoheal usually restarts within 60 s. If it didn't, `docker ps` + `docker logs oscar`. |
| `OscarRestartLoop` | critical | >3 container restarts in 10 min | Persistent boot-time failure — DB corruption, full disk, broken migration, missing env var. Stop autoheal first, debug, fix, restart. |
| `OscarQueueStuck` | warning | `oscar_queue_depth > 0` AND no run completed in 10 min | Hung Bruno child. Restart the OSCAR container — kills zombie children. |
| `OscarRunFailureRateHigh` | warning | >50 % of runs FAILED over 15 min | Vendor outage, expired OAuth credentials, or a bad collection update. |
| `OscarSmtpDegraded` | warning | Any SMTP failure in last 10 min | Check SMTP creds in Server Config tab. Use **Send test email** to reproduce. |
| `OscarLoginAttackBurst` | warning | >50 failed logins in 5 min | Possible brute force / credential stuffing. Check Server Activity for source IP, block at firewall. |
| `OscarHighMemory` | warning | RSS >1 GB for 15 min | Likely a leak. Snapshot heap before restarting if you want to investigate. |
| `OscarEventLoopLag` | warning | p99 lag >200 ms for 10 min | Heavy synchronous work — usually a giant report-builder query. Check active runs. |

Rule definitions live in `OSCAR_Deploy/prometheus/alerts/oscar-alerts.yml`. Edit, then `docker exec oscar-prometheus kill -HUP 1` to reload without restart.

### 14.3 First-time setup (one-shot per VPS)

**Since v1.9.0 the alerting recipient list and SMTP credentials are managed
entirely from the Server Config tab in OSCAR.** No more host-file editing.

After you `git pull` v1.9.0 on the VPS:

```bash
cd /opt/OSCAR/OSCAR_Deploy

# 1. Bring the stack up (autoheal + alertmanager + a shared `alertmanager-config`
#    volume between OSCAR and Alertmanager). Force-recreate oscar + alertmanager
#    so they pick up the new mount.
sudo docker compose \
     -f docker-compose.yml \
     -f docker-compose.metrics.yml \
     up -d --force-recreate oscar autoheal alertmanager prometheus

# 2. Verify the containers.
docker ps --format 'table {{.Names}}\t{{.Status}}'
#    └── oscar should show "(healthy)" after ~30 s
curl -s http://127.0.0.1:9093/api/v2/status | head -20
#    └── alertmanager should respond (may show "no config" briefly until step 3)
```

**Then in the OSCAR web UI:**

1. Log in as administrator → **Server Config tab**
2. Under **SMTP / Email Settings** — fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` (relay login), `SMTP_PASS`, `SMTP_FROM` (verified sender). Click *Save*.
3. Click **Send test email** to confirm SMTP is healthy end-to-end (uses these credentials → if you get the test email, alerts will work too).
4. Under **Alerting** — fill in `ALERT_RECIPIENTS` (comma-separated admin emails) and accept the default `1h` / `4h` re-page intervals. Click *Save*.
5. Click **⚡ Apply alerting config to Alertmanager**. The button generates `alertmanager.yml` from the same SMTP credentials you set above, writes it to the shared docker volume, hot-reloads Alertmanager, and surfaces the verbatim result inline.

**Legacy cleanup (optional):** the v1.8.x host file
`/opt/OSCAR/OSCAR_Deploy/alertmanager/alertmanager.yml` is no longer
mounted or used. Safe to delete after the rollover.

### 14.4 Verifying the email path

The fastest end-to-end test is to manually fire a synthetic alert:

```bash
# Fire a fake critical alert — should email admins within ~1 min.
curl -XPOST http://127.0.0.1:9093/api/v2/alerts -H 'Content-Type: application/json' -d '[{
  "labels": { "alertname": "OscarTestAlert", "severity": "critical" },
  "annotations": { "summary": "Synthetic test alert — please ignore" }
}]'
```

Within ~30 s the alert appears in `https://oscar.uic.org/prometheus/alerts` (state: firing → wait for grouping window) → admin inbox.

If no email arrives:

1. `docker logs oscar-alertmanager --tail 50` — SMTP errors appear verbatim here.
2. Wrong recipient list? Edit `alertmanager.yml`, `docker exec oscar-alertmanager kill -HUP 1`, replay the curl.
3. SMTP working in OSCAR (test email succeeds) but not in Alertmanager? Different config files — Alertmanager has its own copy of credentials in its yml; they don't share with OSCAR's Server Config DB.

### 14.5 Silencing alerts during planned maintenance

```bash
# 4-hour silence for any alert matching alertname=OscarServerDown.
docker exec oscar-alertmanager amtool silence add \
    alertname=OscarServerDown \
    --duration=4h \
    --comment "Planned upgrade — PHE 2026-05-10" \
    --author "patrick.heuguet@trackonpath.com"

# List active silences
docker exec oscar-alertmanager amtool silence query

# Remove a silence by ID
docker exec oscar-alertmanager amtool silence expire <silence-id>
```

Or use the silences UI inside Grafana → Alerting → Silences.

### 14.6 Keeping the admin recipient list in sync

**Since v1.9.0** — edit `ALERT_RECIPIENTS` directly in the Server Config tab,
click *Save*, click *Apply alerting config*. Done in 10 seconds, audit-logged,
no VPS access needed. Two complementary patterns:

- **Distribution list** (lowest maintenance) — set `ALERT_RECIPIENTS` to a single
  list like `oscar-admins@uic.org` and manage membership in your mail provider.
- **Explicit list** — comma- or newline-separated emails. Add / remove members
  from the UI. Each save is audit-logged so the trail of who-added-whom is
  recoverable.

---

## 15. Vendor Data Sovereignty (v1.10+)

This section documents the trust model OSCAR implements as of v1.10.0
(issue #60), and is honest about what software-only mechanisms can and
cannot defend against.

### 15.1 The trust model

| Asset | Visible to | Not visible to |
|---|---|---|
| Test framework configuration (Wizard Step 1) | Tester + Test Manager of the owning company | Other companies, Certifiers, Administrators |
| Data file (`{slug}-datafile.json`) | Tester + Test Manager of the owning company; Bruno subprocess on loopback | Other companies, Certifiers, Administrators |
| Test resources (Wizard Step 2) | Tester + Test Manager of the owning company | Other companies, Certifiers, Administrators |
| Scenarios (personal) | The tester who created them | Everyone else |
| Scenarios (shared) | All testers + Test Managers of the owning company | Other companies, Certifiers, Administrators |
| Run results, artifacts, HTTP traffic | Tester + Test Manager of the owning company | Other companies, Administrators |
|  | **Plus** Certifiers — but ONLY for runs where the Test Manager has clicked "Share with certifiers" on that specific run | Certifiers without explicit per-run share |
| API credentials (per-tester) | The owning tester only — encrypted at rest | Everyone else, including admins, even on the database |
| Audit log | Administrator only | Everyone else |

### 15.2 The two share gates for certifiers

Certifier visibility of a run requires **both** to be true:

1. **Per-run share** — `runs.shared_with_certifier_at` is set. The Test
   Manager flips this with the **Share with certifiers** button on the
   run-detail page. Audit-logged.
2. **Master kill switch** — `companies.share_reports_with_certifier`
   (the legacy v15 toggle) is `1`. Setting it to `0` overrides every
   per-run share, instantly revoking all certifier access to the
   company's runs. Useful for emergency lockout.

Both gates can be flipped by a Test Manager of the company. Neither can
be flipped by an Administrator, a Certifier, or another company.

### 15.3 What the Administrator role can and cannot do (v1.10+)

| Allowed | Not allowed |
|---|---|
| Create / edit / delete users and companies | Read any company's run results |
| Reset passwords, generate one-shot reset links | Read any company's HTTP traffic / artifacts |
| Configure the server (SMTP, alerts, runtime tuning) | Read any company's test framework or data file |
| View aggregate run counts (Server Activity tab) | Read any company's test scenarios |
| Confirm or restore tester-flagged deletions | Read any company's per-tester credentials (always encrypted) |
| Browse the audit log | Bypass the per-run share gate for certifiers |
| Configure observability (Prometheus / Grafana / Loki) | |

The **All Reports** tab in the admin panel, which previously showed every
run on the platform, now shows only the data-lifecycle queue: runs
testers have requested deletion of (`DELETION_REQUESTED`) and runs the
Administrator has flagged (`DELETED_BY_ADMIN`). Per-run content is
unreachable to the Administrator from this view; they can only act on
the lifecycle metadata (confirm deletion, restore).

If a genuine support case requires an Administrator to inspect a
specific report, the current procedure is to ask the company's Test
Manager to share the run with a designated certifier-role account
operated by support. (A future release may add a break-glass
admin-override with extra audit logging — not implemented in Phase 1.)

### 15.4 Threat model — what we defend against, what we don't

#### Defended in code (v1.10.0)

| Threat | Defence |
|---|---|
| Administrator browsing the UI sees a vendor's reports | `canUserSeeRun()` returns null for admin role; LIST endpoint short-circuits to data-lifecycle queue only |
| Anonymous user downloads `/artifacts/<uuid>/report.html` | Static-serve replaced with authenticated handler that calls `canUserSeeRun()` |
| Anonymous user downloads `/data/<slug>-datafile.json` | Static-serve replaced with handler that requires authenticated session matching the slug, OR a true-loopback request from Bruno |
| Certifier sees a run the Test Manager didn't share | Two-gate check: per-run flag AND master kill switch |
| Certifier from one company sees another company's data they shouldn't | Tenant scoping at the database query layer; certifier requests targeting opted-out companies return 404 (existence not disclosed) |
| Tester from company A reads company B's runs | Tenant middleware hard-pins `req.companyId` to the user's own company; cross-company query parameters are ignored for non-platform roles |

#### Defended in code (since earlier releases)

- API credentials encrypted at rest (AES-256-GCM, since v12)
- Credentials redacted from persisted reports (since v17 retroactive scrub)
- Self-service password reset, JWT rotation, granular roles
- 401 auto-logout, sticky session toast, rate limiting
- CodeQL / SonarCloud / Gitleaks / Trivy on every commit

#### Defended in code (since v1.11.0 — Phase 2 at-rest encryption)

| Threat | Defence |
|---|---|
| Sysadmin with `sudo cat /opt/OSCAR/.../data/oscar.db \| strings` | Sensitive content columns (message, bodies, headers, scenarios, framework JSON) are AES-256-GCM ciphertext with `enc:v1:` prefix. Strings command yields only structural metadata (status, timestamps, http_status, suite_name). |
| Sysadmin `cat /opt/OSCAR/.../data/artifacts/<run>/report.html` | File starts with OSCAR1 magic + IV + tag; payload is ciphertext. `head -c 6` reveals `OSCAR1`, the rest is gibberish. |
| Sysadmin `cat /opt/OSCAR/.../data/datafiles/<slug>-datafile.json` | Same OSCAR1 envelope — JSON contents unreadable without the key. |
| Backup / cloud snapshot leaks | Same as live disk — every sensitive byte is ciphertext at rest. |

#### NOT defended in code (operational policy required)

| Threat | Why software cannot stop it | Mitigation |
|---|---|---|
| Sysadmin attaches a debugger to the running OSCAR process | The process must decrypt to use; an attacker with PID-level access can extract `ENCRYPTION_KEY` from memory | **Phase 3** — operational policy: restrict who has root SSH; audit `sudo` usage; consider hardware-backed key storage (HSM / SGX) for higher-tier deployments |
| Sysadmin reads `/proc/<oscar_pid>/environ` | The key is passed via env var; visible to root via `/proc` | Same as above. Phase 3. |
| Compromised application code that exfiltrates the key | An attacker who can ship code into OSCAR can do anything the process can do | Branch protection, code review, signed commits, restricted CI. Already in place. |

### 15.5 Roadmap — Phase 3 (Phase 2 shipped in v1.11.0)

**Phase 2 — at-rest encryption** ✅ shipped in v1.11.0. Uses
application-level AES-256-GCM rather than SQLCipher, which:
- Reuses the existing `ENCRYPTION_KEY` infrastructure (no new key to manage)
- Avoids the Docker build complexity of native SQLCipher
- Encrypts both DB columns and artifact / datafile files in one design
- Same protection level: bytes on disk are ciphertext regardless of
  who opens them. See [`src/utils/at-rest.js`](../../Oscar_Server/src/utils/at-rest.js)
  + the `colEncrypt`/`colDecrypt` helpers in `db.js`.
- Keeps structural metadata (status, timestamps, http_status, suite
  names) in plaintext so SQL queries continue to work without per-row
  decrypt cost.

**Phase 3 — operational policy (no code)** ✅ shipped in v1.11.2 as
[`OSCAR - Security Operations Policy.md`](OSCAR%20-%20Security%20Operations%20Policy.md).
That document defines who has SSH access to production, how the
four long-lived secrets (ENCRYPTION_KEY, JWT_SECRET, SMTP key,
bootstrap token) are managed and rotated, backup encryption posture,
the SEV-1 incident playbook, the procedure when a vendor reports
data-leak suspicion, and a worked example using the 2026-05-15 v19
migration outage. It also records the operational risks the code
cannot defend against — debugger access by a Tier A operator, host
compromise, build supply chain — with concrete mitigations.

The honest truth: software gets you to the trust boundary at the
application layer + the on-disk layer. Beyond that — a sysadmin
attaching a debugger to the running OSCAR process and reading
`ENCRYPTION_KEY` out of memory — **only operational policy +
organisational discipline** prevent a privileged sysadmin from reading
data they shouldn't. The Security Operations Policy is that
discipline, written down.

### 15.6 Verifying the model on your deployment

After v1.10.0 deploys, three quick checks confirm the application-level
controls are active:

```bash
# 1. Authenticated artifact download — should require login.
curl -i https://oscar.example.org/artifacts/00000000-0000-0000-0000-000000000000/report.html
# Expected: HTTP/1.1 401 Unauthorized

# 2. Datafile download — same.
curl -i https://oscar.example.org/data/anyslug-datafile.json
# Expected: HTTP/1.1 401 Unauthorized  (or 404 if slug doesn't exist)

# 3. Admin run list — should show only data-lifecycle entries plus the notice.
#    Login as admin first, copy the oscar_session cookie, then:
curl -s -H "Cookie: oscar_session=<paste>" https://oscar.example.org/v1/runs | python3 -m json.tool | head
# Expected: JSON with "notice" field about issue #60 and runs only in
#   DELETION_REQUESTED / DELETED_BY_ADMIN status.
```

After **v1.11.0** deploys, three more checks confirm the at-rest
encryption is active. Run these from the OSCAR host (need shell access
to the data directory):

```bash
# 4. Database — sensitive content should now be enc:v1: prefixed ciphertext.
sudo sqlite3 /opt/OSCAR/.../data/oscar.db "SELECT message FROM run_events LIMIT 1;"
# Expected (post-v1.11): "enc:v1:<base64 ciphertext>"
# (If you see plaintext, either the row pre-dates v1.11 — fine, the read
#  path handles it — or the v19 migration hasn't run yet.)

# 5. Artifact file — should start with the OSCAR1 magic header.
sudo head -c 6 /opt/OSCAR/.../data/artifacts/<any-runid>/report.html
# Expected (for runs after v1.11): "OSCAR1"

# 6. Datafile — same envelope.
sudo head -c 6 /opt/OSCAR/.../data/datafiles/anyslug-datafile.json
# Expected (for datafiles uploaded after v1.11): "OSCAR1"
```

For belt-and-suspenders coverage of files that pre-date v1.11.0, run the
optional bulk-encrypt script:

```bash
sudo docker exec -it oscar /opt/OSCAR/OSCAR_Deploy/scripts/encrypt-existing-artifacts.sh
# Output:  ........... Backfill complete — encrypted: N, already encrypted: M, errors: 0
```

If all six behave as expected, Phase 1 + Phase 2 of issue #60 are in
effect. The remaining gap is the running-process memory threat — Phase 3
(operational policy).
