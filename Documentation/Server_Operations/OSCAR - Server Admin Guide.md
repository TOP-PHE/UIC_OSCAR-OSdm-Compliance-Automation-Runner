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

All server configuration is in `oscar-server\.env`. The server reads this file on startup — changes require a restart.

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

# URL of the OSDM data file JSON schema (used for validation)
JSON_SCHEMA_URL=https://raw.githubusercontent.com/UnionInternationalCheminsdeFer/OSDM-testing/refs/heads/exch_dev/json_validator/datafile.schema.json

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
| `RUN_TIMEOUT_MS` | `600000` | Hard timeout per run (ms, default 10 min) |
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
