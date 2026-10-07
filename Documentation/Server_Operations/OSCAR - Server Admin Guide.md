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

### 9.9 Intermittent "Failed to save data file" on Windows (OneDrive folder)

```
EPERM: operation not permitted, rename '...\data\datafiles\<slug>-datafile.json.tmp.<hex>' -> '...\data\datafiles\<slug>-datafile.json'
```

Seen only when OSCAR runs on Windows from a folder that OneDrive syncs,
which is how the local install in §1 is laid out. OSCAR writes datafiles and
report artifacts atomically. It writes a temp file, then renames it over the
real one. OneDrive, Defender and the search indexer briefly open any file
that was just written. A rename over such a file fails until they let go.
Before v1.11.196 that surfaced as an occasional 500 on **Save & Apply** or on
a datafile upload. It also left a stray `*.tmp.<hex>` file in `data/datafiles/`
or `data/artifacts/`. A measured rate was 14 of 400 back-to-back saves.

**Fix:** upgrade to v1.11.196 or later. The rename is now retried on
`EPERM` / `EBUSY` / `EACCES`: up to 10 attempts over about one second. If it
still fails, the temp file is removed. Stray `*.tmp.<hex>` files left by older
versions are safe to delete while the server is stopped.

If it still happens after upgrading, the lock is lasting longer than a second.
Exclude `data\` from OneDrive, or move the install outside the synced folder.
The Linux VPS deployment is not affected.

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
| Scenarios (personal) | The tester who created them (edit); Test Managers of the owning company | Other testers, other companies, Certifiers, Administrators |
| Scenarios (shared, or with no owner) | All testers (read-only) + Test Managers (edit) of the owning company | Other companies, Certifiers, Administrators |
| Run list — what "Run the collection" runs | Each tester their own; Test Managers the company default | Other testers |
| Run results, artifacts, HTTP traffic | Tester + Test Manager of the owning company | Other companies, Administrators |
|  | **Plus** Certifiers — but ONLY for runs where the Test Manager has clicked "Share with certifiers" on that specific run | Certifiers without explicit per-run share |
| API credentials (per-tester) | The owning tester only — encrypted at rest | Everyone else, including admins, even on the database |
| OSDM API endpoint and dedicated headers (company-wide) | Tester (read-only) + Test Manager (edit) of the owning company; Administrators (§15.9) | Other companies, Certifiers |
| Audit log | Administrator only | Everyone else |

### 15.2 The certifier share gate

Certifier visibility of a run requires exactly one thing:

- **Per-run share** — `runs.shared_with_certifier_at` is set. The Test
  Manager flips this with the **Share with certifiers** button on the
  run-detail page. Audit-logged. Default is unshared: a certifier sees
  nothing until someone deliberately shares it.

> **Corrected in v1.11.194.** This section previously described a second,
> company-wide gate — `companies.share_reports_with_certifier`, the legacy
> v15 master kill switch. **That toggle was removed in v1.11.15**; per-run
> sharing has been the sole gate ever since, and `PATCH /v1/company`
> rejects the field with an explanatory 400 if an old client still sends
> it. The column remains in the schema, unread, and migration 19's backfill
> used it once to seed per-run shares for companies that had it on. If you
> need an emergency lockout today, un-share the runs — there is no
> company-wide switch.

The share gate can be flipped by a Test Manager of the company. It cannot
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
| Certifier sees a run the Test Manager didn't share | Per-run share check (`runs.shared_with_certifier_at`) in `canUserSeeRun()`. Was a two-gate check until v1.11.15 removed the company-wide toggle — see §15.2. |
| Certifier from one company sees another company's data they shouldn't | Tenant scoping at the database query layer; certifier requests targeting opted-out companies return 404 (existence not disclosed) |
| Tester from company A reads company B's runs | Tenant middleware hard-pins `req.companyId` to the user's own company; cross-company query parameters are ignored for non-platform roles |
| Administrator or Certifier overwrites a vendor's datafile | **v1.11.195.** Role and company are checked as middleware before the upload is parsed; uploads are held in memory until authorised and valid; `PUT /datafile/json` refuses both roles (see §15.8) |

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
| Sysadmin (or a mid-run volume snapshot) reads the per-run Bruno env file under `environments/` | **Credential-free since #306** (server v1.11.179 / collection OTST_V2.0.95): the access token, subscription key and oauth-extra travel via the Bruno child **process environment**, never the file. Every credential-bearing path on disk is now encrypted or eliminated — a worker crash mid-run leaves nothing sensitive behind. |

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

### 15.7 v1.11.194 — the reporting endpoints joined the shared gate

The model above was implemented in `runs.js` in v1.10.0 and has been
accurate for the run list, artifact downloads and the datafile ever
since. It was **not** accurate for `reports.js`, which carried its own,
older role logic: five handlers branched on `isPlatformRole()` or on a
literal `req.user.role === 'certification_user'`, and in each case a
platform role skipped the per-run check entirely. Findings **S1** and
**S4** of the 2026-09-05 external readiness assessment.

What was reachable before this release, by a logged-in administrator or
certifier, without any run being shared:

| Endpoint | What it disclosed |
|---|---|
| `GET /v1/reports/requests/:id/messages` | Decrypted request/response bodies and headers of any run. `run_requests.id` is a plain `AUTOINCREMENT` integer, so the whole table was enumerable by counting. |
| `POST /v1/reports/compare` | Either run by id; the company-scope check under it defaulted to run A's own company, so it could not fail for a platform caller. |
| `GET /v1/reports/comparisons/:id` | The stored diff — the certifier privacy guard tested for the `certification_user` string, so an administrator fell through it. |
| `POST /v1/reports/configured` | Full assertion set, `run_events` log and capability-matrix context for any `run_ids` passed in the body. |
| `GET /v1/reports/trends[/summary]` | Assertion trend data for a company named in `x-company-id`, including `error_msg` — assertion text from the tenant's run. |
| `GET /v1/runs/batch/:batchId[/reports.zip]` | The batch's run ids, and the complete decrypted report artifacts as a ZIP. |

All of these now call `canUserSeeRun()`, the same function §15.4 credits.
Two consequences worth knowing before you field a support call:

- **A foreign-tenant caller on `/requests/:id/messages` now gets 404, not
  403.** 403 confirmed the row existed, which is what made the integer id
  space worth walking. Any client asserting on 403 there needs updating.
- **The Administrator's Report Builder, comparison list and trends are
  empty.** This is the intended end state of issue #60, not a fault. The
  menu entries remain reachable and will show nothing; the support
  procedure in §15.3 is unchanged — ask the company's Test Manager to
  share the run with a certifier-role account.

Fixed in the same change: `run_events.message` is encrypted at rest from
migration 19 on, and the `POST /configured` path returned it without
decrypting, so the Report Builder rendered every log line of a
post-migration run as `enc:v1:…`. The data was never wrong on disk — only
the read path.

### 15.8 v1.11.195 — datafile writes are authorised before anything touches disk

The trust model's datafile row — writable by "Tester + Test Manager of the
owning company", never by Certifiers or Administrators — was true for reads
and false for writes. Findings **S2** and **S3** of the 2026-09-05 external
readiness assessment:

| Route | What was reachable | Now |
|---|---|---|
| `POST /v1/company/datafile` (upload) | multer stored the upload **as the live `{slug}-datafile.json`, in plaintext, before the role check ran**. A tester on their own company, or an Administrator or Certifier naming any company in `?company_id=`, got a 403 — after their file had replaced the company's. | Role and company are checked first, and the upload is held in memory until it is authorised and valid. The only disk write is the atomic encrypted one. Test Managers only, as before. |
| `PUT /v1/company/datafile/json` (the scenario editor's Save & Apply) | Refused Certifiers only. An Administrator could rewrite **any** company's datafile by naming it. | Administrators and Certifiers refused. Testers and Test Managers write their own company only. |

Both routes ignore `?company_id=` / `X-Company-Id` for the roles they admit,
so a tester or Test Manager cannot reach another company's file.

**Why testers can still save.** Test Config is on the tester menu. Its Save &
Apply is how testers author their own scenarios and choose `scenariosToRun`,
which `POST /v1/runs` reads to decide what to run. Removing testers from this
route would stop them running anything but the Test Manager's selection.

**Closed in v1.11.197 — testers only change their own scenarios.** Until then a
tester's save replaced the whole company file, so it could alter shared scenarios
and other testers' private ones; the editor's read-only marking was browser-only.
Now the server merges a tester's save into the stored file
(`utils/datafileOwnership.js`):

- **Owned** = not shared, and `created_by` is the tester's email. A tester can
  create, change and delete only those.
- **Visible** = owned, shared, or with no `created_by` at all (older company
  scenarios). Other people's private scenarios are removed from what
  `GET /datafile` returns to a tester, together with the resource entries only
  they use.
- Everything else in the stored file is kept exactly as stored, including other
  scenarios, their resource entries, and company-level keys such as
  `systemInfoParameters`. A tester's edit to a read-only scenario is
  not kept, and the save response lists it (`read_only_ignored`). An edit to
  the resource entries a read-only scenario uses (its trip, passengers,
  purchaser, fulfillment options) is not kept either, and is not listed, because
  the scenario itself is unchanged. Since v1.11.203 the editor locks read-only
  scenario cards, so a tester is no longer offered either kind of edit
  (`public/js/scenario-access.js`, the same rule as `isOwnedBy`). A new
  scenario whose code someone else's already uses is stored under the next free
  code (`renamed` in the response), never dropped or overwritten. A stale copy
  of a scenario the Test Manager has since deleted or un-shared is discarded,
  not revived as the tester's.
- **Company configuration is never writable by a tester.** This includes the
  first save into an empty company. Bruno turns every key of
  `systemInfoParameters` into an environment variable for every run, so a
  planted `api_base` would have sent colleagues' runs, bearer token included,
  to a host of the tester's choosing.
- **`purchaserList[0]` is protected.** Bruno uses the first purchaser entry for
  every scenario, whatever the scenario's `purchaserListId` says. A tester
  cannot change or remove it, even when only their own scenario references it.
- A tester cannot newly point one of their scenarios at an entry that only
  hidden scenarios use; that would make it appear in their view.
- `/data/:filename` answers a logged-in session only for a Test Manager. It
  used to hand any tester of the company the whole unfiltered file. Bruno reads
  it with the run's secret (see §15.12), not as "a logged-in session".
- Resource ids are allocated by the browser from what the tester can see, so
  one can clash with a hidden scenario's entry. The merge never lets a tester's
  entry replace one that another scenario references: it copies the tester's
  version to a fresh id (copy-on-write).
- Every datafile write — save, upload, findings re-projection — runs under a
  per-company lock, so two saves at once cannot lose either one.
- **Run lists are personal**: what a tester ticks is stored per user (table
  `run_selections`, migration 26), and `POST /v1/runs` expands a tester's
  batch from it. The datafile's `scenariosToRun` is the Test Manager's company
  default. Bruno is unaffected: each run is still handed its one scenario.

Test Managers still see and save the whole file. Bruno still reads the
unfiltered file from `/data/:filename`, but now with the run's own secret
(§15.12), scoped to the run's company.

A side effect worth knowing when you field a support call: before this release,
a Test Manager who uploaded an invalid or oversized file lost the company's
datafile altogether. The upload had already replaced it, and the failure path
then deleted it, while `companies.datafile_path` still pointed at the old file.
If a company reports "our data file vanished after a failed upload" from
before v1.11.195, that is the cause. The Test Manager needs to upload or rebuild
it once. The fixed release leaves the previous file untouched.

### 15.9 v1.11.207 — only a Test Manager changes the company's OSDM endpoint

A company has one OSDM API endpoint (`companies.api_base`, shown as **OSDM API
Endpoint** on the API Config page). Every request of every run in that company
goes to it, with the access token of the tester who started the run.

Until this release `PATCH /v1/company` accepted `api_base` from any signed-in
member of the company, and the API Config page sent it with every save, whatever
the role. A tester could therefore point the whole company at another address
(issue #544). The dedicated headers on the same route were already
Test-Manager-only; the endpoint was not.

| Who sends `api_base` | Before | Now |
|---|---|---|
| Test Manager of the company | Stored | Stored, as before. Audit event `company_update:` followed by the fields sent. |
| Administrator naming the company (`?company_id=`) | Stored | Stored, as before, like the dedicated headers. |
| Tester, a different address | **Stored** | **403** "Only Test Managers can change the OSDM API endpoint." Nothing is written. |
| Tester, exactly the stored address | Stored again | 200, nothing written, no audit event. |
| Certifier | 403 | 403, as before. |

The fourth row exists for one reason. Before this release the page sent the
endpoint back unchanged each time a tester saved their credentials, and a page
left open across the upgrade still does. Refusing that would have broken the
tester's credential save until they reloaded. The comparison is exact after
trimming spaces: a different case, scheme, path or query is a change.

On the page, anyone who is not a Test Manager now sees the endpoint read-only,
with the line "Only a Test Manager of your company can change this address."
Their **Save** sends their own credentials and nothing else.

Two things for support:

- "I can no longer change the API address" from a tester is the intended
  behaviour. The company's Test Manager makes the change.
- The audit log cannot tell you whether a tester changed the endpoint before
  the upgrade. Until this release every save of the API Config page, by any
  role, wrote a `company_update:api_base…` event whether or not the address
  had changed, and the event does not record the address. If there is a doubt,
  have the Test Manager check the address shown on the page. From this release
  that event is written only for a Test Manager or an Administrator.

### 15.10 v1.11.208 — what a run's child processes receive, and how the environment file is written

Two findings of our own review of the 2026-09-05 assessment (tracker items NEW-01
and NEW-02), both in the code that starts a run.

**The report script inherited the server's secrets.** A run starts two child
processes: the Bruno CLI, then `library-bruno/mergeReport.js`. The Bruno spawn
was given an allowlisted environment. The second was given none, so it
inherited the server's whole environment: `ENCRYPTION_KEY`, `JWT_SECRET`, the
SMTP credentials. That script is a file of the collection, which is
bind-mounted and refreshed from GitHub on every push to `main`, not a file of
the server image. A script that printed or reported its environment would have
exposed the key that encrypts every company's data. Both children now start
from the same allowlist, and the report script gets none of the run's
credentials either.

This closes the inheritance and nothing more. Collection code still runs as the
same operating-system user as the server: a script written to do harm could
read the server's files, and on Linux the environment of the server process
itself. Keeping the collection trustworthy (who can push to `main`, branch
protection, the refresh workflow) remains the control for that. Running
collection code under a separate user is not done.

**A scenario code could redirect a run.** The environment file Bruno reads for
a run is YAML, and values were pasted into it between double quotes as they
came. A scenario code is free text a tester stores in the datafile. A code
holding a quote and a line break added variables of its own to the file,
including a second `api_base`, and Bruno uses the last one. The run's requests
then went to an address the tester chose, with the access token of whoever
started the run. That could be the Test Manager, whose run list "ALL" includes
testers' private scenarios, or a colleague once the Test Manager had shared the
scenario. Every value is now written through one escaping function, so a value
can neither break the file nor add to it.

**A scenario code could also be a template.** Bruno fills in `{{...}}` in a
value when a script reads it. A code written as
`{{process.env.OSCAR_ACCESS_TOKEN}}` was read as the access token of whoever
started the run, then reported as "not found" in the run log, which every member
of the company can read. Escaping cannot prevent that, and Bruno has no way to
write `{{` literally. The runner now refuses a run whose scenario code contains
`{{`: it is marked FAILED before a token is requested and before anything is
started. A failed run with that message in a Test Manager's batch is also the
sign that someone stored such a code.

**A scenario code need not be text.** The datafile is JSON, and a code could be
stored as an object or a list. Such a code could not be written to the runs
table, so a Test Manager's "run all" answered a server error for the whole
batch as long as one tester's scenario had one. Only text codes are run now;
the others are left out of the batch.

| | Before | Now |
|---|---|---|
| Environment of `mergeReport.js` | The server's, complete | The allowlist only |
| A scenario code with a `"` and a line break | Adds variables to the run | One value, passed to Bruno unchanged |
| A scenario code containing `{{` | Bruno replaces the template with a variable's value, the run's token for example, and the run log shows it | The run is refused before it starts, with a message asking for the scenario to be renamed |
| A scenario code that is not text (an object, a list) | The whole "run all" answers a server error | That scenario is left out of the batch |
| An API base URL or requestor with a `"` | The run fails: "Invalid API configuration" | Passed to Bruno unchanged |
| Run log when a run's scenario no longer exists | Lists every scenario code in the datafile | Gives the number of scenarios |

The last row is in the collection (OTST_V2.0.102). The datafile holds every
tester's scenarios, and the message is written to the run log of whoever
started the run. A tester could delete one of their own scenarios right after
starting its run and read the codes of everyone's private scenarios.

What to check on your deployment:

- Nothing has to be configured. Runs behave as before for ordinary values.
- **Whether a crafted code was ever stored cannot be seen from the server
  side**: an Administrator has no access to datafiles (§15.3). A Test Manager
  can look at the scenario codes in Test Config; a code containing a double
  quote, `{{`, or spreading over several lines would stand out. The editor itself
  only produces codes made of capital letters, digits and underscores, so any
  other code was stored through the API or an upload. If one is found,
  treat the access tokens of everyone who ran that scenario as exposed and
  have them replaced at the provider.
- If you maintain a fork of the collection that needs a server variable in
  `mergeReport.js`, it no longer receives it. Add the variable's name to
  `CHILD_ENV_ALLOWLIST` in `worker/runner.js`, never a secret.

### 15.11 v1.11.209 — text in a datafile is never read as a template

Found while fixing §15.10 (tracker item NEW-10). The test engine fills in a
double-brace template, `{{name}}`, wherever a value is used. One template
gives the access token of whoever started the run.

Before every run, the collection hands the **whole** datafile to the test
engine for a schema check, and that check prints the value of a field that is
not on its list of allowed values. It then builds the requests from the
scenario being run.

So a tester could type that template into a field of one of their own
scenarios, in the ordinary editor. From then on, the access token of anyone in
the company who ran **any** scenario was written into the log of that run, or
into one of its requests. Every member of the company can read a run's log and
HTTP traffic, and a certifier can once the run is shared. The mechanism was
confirmed with the real test engine; the complete path through a provider
sandbox was not replayed.

| | Before | Now |
|---|---|---|
| Saving text that contains `{{` in a scenario, a trip, a passenger list, a purchaser or fulfillment options | Stored | Refused: the message names the scenario and the field |
| Uploading a datafile that adds such text | Stored | Refused, the stored file stays |
| Starting a run while the datafile holds such text, anywhere | The template is filled in | The run is not started; the message says where |
| A datafile the server cannot read | The run starts and fails later | The run is not started, with the reason |
| Dedicated headers with `{{variable}}` | Filled in | Unchanged: that is their documented use, and only a Test Manager sets them |

A save is refused only for text it adds. Text someone stored earlier never
blocks a save of something else. It does block runs: **while one such text is
stored anywhere in a company's datafile, no run of that company starts**. That
is deliberate: the engine fills it in for every run.

What to check on your deployment:

- Nothing has to be configured.
- **If every run of a company fails at once with "This run was not started: the
  data file holds text that contains {{"**, such text is stored in that
  company's datafile. A Test Manager's run names every place. A tester's run
  names the places in their own scenarios, and otherwise says only that the
  text is in a part they cannot see. An Administrator cannot read the datafile (§15.3): the company's
  Test Manager opens the scenario in Test Config, removes the two curly braces
  from the field, and saves. Runs start again at once.
- If the text was not put there by accident, treat the access tokens of
  everyone in that company who ran anything while it was stored as exposed, and
  have them replaced at the provider.
- "The data file could not be read" on a run means the stored file is damaged.
  Before this release such a run was started anyway and failed later inside the
  test engine.

### 15.12 v1.11.210 — the loopback routes require a per-run secret

Audit tracker item S8-loopback. The server serves two things to the test engine
while a run is in flight, both on the loopback interface: the company's data
file (`GET /data/:filename`) and, for long scenarios, a fresh vendor access
token (`POST /v1/runs/:runId/refresh-access-token`).

Until this release both were gated on one thing only: the request came from
`127.0.0.1` with no `X-Forwarded-For` header. That single condition was enough
for **any** other process on the host, and for **any** fronting proxy that does
not add `X-Forwarded-For` (an L4/TCP forwarder, an nginx `stream` block, a
sidecar), to read **any** company's decrypted data file and a live vendor
token. Data-file names are the company slug, which is guessable. It also meant
a Test Manager who set the company's OSDM endpoint (`api_base`) to the server's
own `/data` route made the run copy another company's data file into its report.

Now trust is a per-run secret, not the source address:

- The server issues a random secret when it starts the test engine for a run,
  tied to that run's company, hands it to the engine through its process
  environment (never a file on disk), and destroys it when the run ends.
- The engine sends the secret back as a header on both calls. The routes
  require it, compare it in constant time, and bind it to the run's own
  company — a run of one company asking for another company's data file is
  answered `404`.
- The `127.0.0.1` / `X-Forwarded-For` test is gone. A signed-in Test Manager of
  the owning company is still accepted on `/data` (no page uses it; it is a
  fallback). The token-refresh route is secret-only.

What to check on your deployment:

- Nothing has to be configured. The secret is internal and per-run.
- A canonical nginx config ships at `OSCAR_Deploy/nginx/oscar.conf.example`.
  With the loopback trust gone, that config's `X-Forwarded-For` line is for
  correct client IPs in logs and rate limiting, not a security boundary — but
  do not front OSCAR with a plain TCP/stream forwarder that drops it.
- This release pairs the server (1.11.210) with the collection (OTST_V2.0.103):
  older collections do not send the header and their runs would be refused. On
  a normal deploy the bind-mounted collection updates before the server image
  is promoted, so the collection sends the header before the server requires
  it. If you pin versions by hand, move both together.
- The companion item — validating `api_base`/`token_url` so a run cannot be
  aimed at loopback or private-range addresses at all (tracker S5) — shipped in
  1.11.211; see §15.13.

### 15.13 v1.11.211 — api_base and token_url must be public https targets

Audit tracker item S5. Two fields the company's members set become outbound
requests the server makes: the company `api_base` (every OSDM request of every
run) and a tester's `token_url` (the OAuth token fetch). Neither was checked, so
either could point at the server's own host, the private network or a container
on the Docker network — `http://127.0.0.1:3001/…`, `http://grafana:3000`,
`https://169.254.169.254/…` (the cloud metadata address). The run or the token
fetch then reached that internal address and the reply came back in the run log
or the token error. §15.12 removed the loopback trust on OSCAR's own routes;
this stops the request being aimed inward at all.

From this release a target must be `https` and resolve to a public address.
Blocked: loopback, private, link-local, unique-local, carrier-grade NAT, the
unspecified / broadcast / multicast / reserved ranges, and any bare single-label
host name (a Docker service name, `localhost`). The check runs when the value is
saved (a 400, nothing stored) and again when it is used (the token fetch, the
server's own OSDM calls, and the start of a run, which is refused before a token
is fetched) — the second time with a DNS lookup, so a host name that resolves to
an internal address is caught too.

What to check on your deployment:

- **If your providers are genuinely on `localhost` or your LAN** (a self-hosted
  or development box), set `ALLOW_PRIVATE_TARGETS=1` in the server's `.env`. That
  turns the policy off. It is read per request, so no restart is needed. A public
  VPS deployment must **not** set it.
- A Test Manager saving a non-public endpoint now gets a 400 that says it must be
  a public https host. A tester saving a non-public `token_url` gets the same.
- If a company's runs start failing with "This run was not started … public
  host", its `api_base` is non-public: either fix it in API Config, or (for a
  deliberately private deployment) set `ALLOW_PRIVATE_TARGETS=1`.

### 15.14 v1.11.212 — CORS fails closed without an allowlist

Audit tracker item S7-cors. When `ALLOWED_ORIGINS` was unset the server reflected
the CORS `Access-Control-Allow-Origin` header back to **any** site, with
credentials — so any web page a signed-in user visited could call the API with
their session. OSCAR is served same-origin (nginx fronts the SPA and the API on
one host), so with no allowlist the server now permits **no** cross-origin at all.

What to check on your deployment:

- A normal deployment (UI and API on the same host, as in the shipped nginx
  config) needs nothing — same-origin requests are unaffected.
- **Only if you serve the UI from a different origin than the API**, set
  `ALLOWED_ORIGINS` to that origin (comma-separated for several), e.g.
  `ALLOWED_ORIGINS=https://oscar.uic.org`. Listed origins are then allowed with
  credentials; everything else is refused. See `.env.example`.

### 15.15 v1.11.213 — dedicated headers are encrypted and not shown to others

Audit tracker item S6. The company "Dedicated Headers" field (API Config) is the
home for vendor API keys. It was stored in clear in the database and returned in
full by the company API — including to a platform administrator — unlike every
other credential, which is encrypted at rest and never sent back to a client.

From this release the dedicated-header values are encrypted at rest (the same
`enc:v1:` envelope as the other sensitive columns), and a migration encrypts any
existing rows on first boot. The values are returned **only** to the Test Manager
of the owning company — who sets them and needs them to edit. An administrator, a
tester and a certifier see the header **name** and whether a value is set, never
the value. Runs are unaffected: the engine reads the headers from the database
and decrypts them itself.

What to check on your deployment:

- Nothing to configure. The migration runs automatically; a row left in clear by
  an interrupted migration is still read correctly and re-encrypted on its next
  save.
- A Test Manager still sees and edits their company's dedicated headers as
  before. If an administrator reports they can no longer see the values, that is
  intended.
- The report-side counterpart is §15.16 (tracker NEW-03).

### 15.16 v1.11.214 — report headers are redacted by value, not just by name

Audit tracker item NEW-03. The reports a certifier reads (the stored request
traffic and the HTML report) used to hide credentials by matching a fixed list of
header **names**. A dedicated header a Test Manager named themselves — say
`X-My-Auth` carrying `{{access_token}}` — was not on that list, so its value (the
run's live token) showed in clear.

From this release the reports also hide a header **by its value**: any header
whose value is one of the run's own secrets (the access token, the subscription
key, the OAuth extra) is masked, whatever the header is called. Headers that do
not carry a secret stay visible on purpose — an OSDM version header, a
correlation or session-trace id (useful when chasing a problem with the vendor),
`Accept`, and so on — so you lose no diagnostic information.

Nothing to configure. This applies to new runs; traffic already stored from older
runs keeps whatever masking it had. The companion storage change (dedicated
headers encrypted at rest, §15.15) shipped in the previous release.

### 15.17 v1.11.215 — tenant text is escaped on every page (cross-tenant XSS)

Audit tracker item S11. Values a company controls — its API endpoint, a scenario
code, who submitted a run, an environment name — are shown on pages that a
certifier of another company opens. They were written into the page without
escaping (the dashboard had no escaping at all), so a company could store markup
that runs as code in another company's browser (a stored cross-site-scripting
weakness).

From this release every such value is escaped through one shared routine before
it reaches the page, on all pages. Nothing changes for ordinary values; only
characters that would otherwise be read as HTML are neutralised.

Nothing to configure. Two operator-facing notes:

- The browser code under `public/` is now checked by the linter (`npm run lint`),
  which previously only read the server code — this is what let the gap go
  unnoticed.
- After deploying, a quick load of the dashboard confirms the shared escaper
  (`js/esc.js`) is served and the pages render normally; it loads before the
  nav bar script on every page.
