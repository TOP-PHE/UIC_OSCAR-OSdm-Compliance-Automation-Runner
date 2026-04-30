# OSCAR — VPS Deployment Guide

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC © 2026."

---

## Prerequisites

- A VPS running **Ubuntu 22.04 LTS** with **root SSH access**
- A domain name or subdomain pointing to the VPS IP (e.g. `oscar.yourdomain.com`)
- Your local machine with the two folders ready to transfer:
  - `oscar-server/` — the OSCAR Node.js application
  - `OTST_V2.0.1/` — the Bruno OTST collection

---

## Overview of What Will Be Installed

| Component | Purpose |
|---|---|
| Node.js 22 | Runtime for the OSCAR server |
| Bruno CLI (`bru`) | Execute OTST test scenarios |
| pm2 | Keep the Node.js process alive after reboot |
| Nginx | Reverse proxy: domain:443 → localhost:3001 |
| Certbot | Free TLS certificate via Let's Encrypt |

---

## Step 1 — Connect to the VPS

From your Windows machine, open PowerShell or any SSH client:

```bash
ssh root@YOUR_VPS_IP
```

Once connected, update the system:

```bash
apt update && apt upgrade -y
```

---

## Step 2 — Create a Dedicated User (Recommended)

Running everything as root is a security risk. Create a dedicated user:

```bash
adduser oscaradmin
usermod -aG sudo oscaradmin
```

Switch to that user for all remaining steps:

```bash
sudo -i -u oscaradmin
```

---

## Step 3 — Install Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify:

```bash
node --version
# Must show v22.x.x or higher

npm --version
# Must show 10.x or higher
```

---

## Step 4 — Install Bruno CLI

```bash
sudo npm install -g @usebruno/cli
```

Verify:

```bash
bru --version
# Must show @usebruno/cli 3.x.x or higher
```

Find the exact path (you will need it in Step 8):

```bash
which bru
# Typically: /usr/local/bin/bru
```

> **Important:** On Linux the executable is called `bru`, not `bru.cmd`. Use the full path returned by `which bru` in the env file.

---

## Step 5 — Install pm2 (Process Manager)

pm2 keeps the OSCAR server running permanently and restarts it automatically after a VPS reboot.

```bash
sudo npm install -g pm2
```

---

## Step 6 — Transfer Files to the VPS

Run these commands **from your Windows machine** (open a new PowerShell window, do not close the SSH session).

> **First connection note:** if SSH asks `The authenticity of host ... can't be established`, verify the fingerprint with your VPS console, then type `yes` once to trust and save the host key.

### 6.1 — Transfer the OSCAR server

```powershell
scp -r "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\UIC-OSCAR\oscar-server" oscaradmin@31.207.37.154:/home/oscaradmin/
```

### 6.2 — Transfer the Bruno OTST collection

```powershell
scp -r "C:\Users\patri\OneDrive\Documents\TrackOnPath\Contract_execution\UIC_New_Revenue_Management project\projets\OSDM\OTST\Bruno_tests\OTST_Bruno_Workspace\OTST_V2.0.1" oscaradmin@31.207.37.154:/home/oscaradmin/
```

After transfer, your VPS home directory should look like:

```
/home/oscaradmin/
├── oscar-server/
│   ├── src/
│   ├── public/
│   ├── data/
│   ├── package.json
│   └── oscar-server.env.example
└── OTST_V2.0.1/
    ├── opencollection.yml
    ├── environments/
    ├── library-bruno/
    ├── Validation_Reports/
    └── ...
```

---

## Step 7 — Install Node.js Dependencies

Back in your SSH session:

```bash
cd /home/oscaradmin/oscar-server
npm install
```

### Fix security vulnerabilities

After `npm install` you may see a warning about high severity vulnerabilities in `bcrypt`. Fix it immediately:

```bash
npm install bcrypt@6
npm audit
# Should now show: found 0 vulnerabilities
```

---

## Step 8 — Configure the Environment File

### 8.1 — Generate the secret values

Run each command below on the VPS and copy the output — you will paste it into the env file:

```bash
# JWT_SECRET — authentication token signing key
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# PLATFORM_BOOTSTRAP_TOKEN — one-time token to create the first admin account
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# ENCRYPTION_KEY — must be exactly 64 hex characters
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Keep these values safe.** If you lose `ENCRYPTION_KEY`, all stored API credentials in the database become unreadable.

### 8.2 — Create and edit the env file

```bash
cp oscar-server.env.example oscar-server.env
nano oscar-server.env
```

### Nano editor quick reference

| Keys | Action |
|------|--------|
| Arrow keys | Move cursor |
| `Backspace` | Delete character |
| `Ctrl+K` | Cut entire line |
| `Shift+Insert` or right-click | Paste from clipboard |
| `Ctrl+O` then `Enter` | Save |
| `Ctrl+X` | Exit (asks to save if unsaved) |
| `Ctrl+X` → `Y` → `Enter` | Save and exit in one sequence |

### 8.3 — Fill in the values

```dotenv
# ── Server ────────────────────────────────────────────────────────────────────
PORT=3001

# ── Security ──────────────────────────────────────────────────────────────────
JWT_SECRET=<output of first node command>

# One-time token to create the first administrator account (Step 9)
PLATFORM_BOOTSTRAP_TOKEN=<output of second node command>

# Must be exactly 64 hex characters
ENCRYPTION_KEY=<output of third node command>

# ── Bruno Collection ──────────────────────────────────────────────────────────
COLLECTION_PATH=/home/oscaradmin/OTST_V2.0.1

# Full path returned by: which bru
BRU_CMD=/usr/local/bin/bru
```

### 8.4 — Configure SMTP for email-verified registration

OSCAR sends a confirmation email when a new Tester account is requested. Without SMTP configured the server will refuse to send email in production mode and return a `503` error to the user.

#### Recommended: Brevo (free tier — 300 emails/day, no credit card)

1. Create a free account at [brevo.com](https://www.brevo.com)
2. In Brevo go to: **top-right avatar → SMTP & API → SMTP tab**
3. Click **"Generate a new SMTP key"**, name it `oscar-vps`, confirm
4. Copy the generated key — it starts with `xsmtpsib-...` and is shown only once

> ⚠️ **Do not confuse the two keys on this page:**
> | Key | Tab | Starts with | Works for SMTP? |
> |---|---|---|---|
> | API Key | API Keys tab | `xkeysib-...` | ❌ No |
> | **SMTP Key** | **SMTP tab** | `xsmtpsib-...` | ✅ Yes |
> Using the API key will cause `535 5.7.8 Authentication failed`.

Add these lines to `oscar-server.env`:

```dotenv
# ── Email (Brevo SMTP relay) ───────────────────────────────────────────────────
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-brevo-login@example.com
SMTP_PASS=xsmtpsib-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SMTP_FROM=OSCAR Platform <your-brevo-login@example.com>

# ── Application URL (used in confirmation email links) ────────────────────────
APP_URL=https://YOUR_ACTUAL_DOMAIN

# ── Set to production to enforce SMTP and disable dev-mode bypass ─────────────
NODE_ENV=production
```

Replace:
- `your-brevo-login@example.com` → the login shown on the Brevo SMTP page (format: `xxxxxxxx@smtp-brevo.com`)
- `xsmtpsib-...` → the full SMTP key generated above
- `YOUR_ACTUAL_DOMAIN` → your real domain e.g. `vps119497.serveur-vps.net`

#### Alternative: any standard SMTP server

If you have an existing mail account (e.g. on LWS hosting), use its SMTP credentials instead:

```dotenv
SMTP_HOST=mail.yourdomain.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@yourdomain.com
SMTP_PASS=your-email-password
SMTP_FROM=OSCAR Platform <noreply@yourdomain.com>
APP_URL=https://YOUR_ACTUAL_DOMAIN
NODE_ENV=production
```

> If port 587 is blocked by the hosting provider, try `SMTP_PORT=465` with `SMTP_SECURE=true`.

### 8.5 — Protect the file

```bash
chmod 600 oscar-server.env
```

---

## Step 9 — Start the Server and Verify

Test that the server starts correctly before configuring pm2:

```bash
cd /home/oscaradmin/oscar-server
node src/server.js
```

Expected output:

```
[db] SQLite ready → /home/oscaradmin/oscar-server/data/oscar.db
(node:...) ExperimentalWarning: SQLite is an experimental feature...

╔═══════════════════════════════════════════════╗
║   OSCAR — OSDM Conformance Automation Runner  ║
║   http://localhost:3001                       ║
╚═══════════════════════════════════════════════╝

[server] Collection : /home/oscaradmin/OTST_V2.0.1
[server] Bruno CLI  : /usr/local/bin/bru
[server] Data dir   : /home/oscaradmin/oscar-server/data/datafiles
```

> The `ExperimentalWarning: SQLite` message is harmless — it is a Node.js notice about a built-in feature still in preview. It does not affect operation.

Check that the Collection and Bruno CLI lines show **Linux paths** (starting with `/home/...`), not Windows paths (`C:\...`). If you see Windows paths, the env file was not saved correctly — go back and fix it.

Verify with a health check (open a second SSH terminal while the server runs):

```bash
curl http://localhost:3001/health
# Expected: {"status":"ok","version":"1.0.0","queue":{"depth":0,"running":0}}
```

Press `Ctrl+C` to stop the server once verified.

---

## Step 10 — Create the First Administrator Account

This is a one-time operation using the `PLATFORM_BOOTSTRAP_TOKEN` you set in Step 8.

Start the server first (or it must already be running):

```bash
cd /home/oscaradmin/oscar-server
node src/server.js &
```

Then run the bootstrap command (all on one line):

```bash
curl -X POST http://localhost:3001/v1/auth/bootstrap/platform-user -H "Content-Type: application/json" -H "x-platform-bootstrap-token: YOUR_PLATFORM_BOOTSTRAP_TOKEN" -d '{"email":"your@email.com","password":"YourPassword1!","role":"administrator"}'
```

Replace:
- `YOUR_PLATFORM_BOOTSTRAP_TOKEN` → the value from your `oscar-server.env`
- `your@email.com` → your admin email address
- `yourpassword` → a password of at least 12 characters, containing uppercase, lowercase, and a digit

> **JSON syntax is strict:** the `-d` value must start with `'{"` and end with `"}'`. No spaces inside the email or password values. Paste the whole command as a single line.

Expected successful response:

```json
{
  "token": "eyJ...",
  "user": { "email": "your@email.com", "role": "administrator" },
  "company": { "name": "OSCAR Platform", "slug": "platform-root" }
}
```

If you get `409 Conflict / Email already registered` — the account was already created successfully on a previous attempt. Proceed to the next step.

If you get `401 Unauthorized / Invalid bootstrap token` — the token in the curl command does not match what is in `oscar-server.env`. Check for extra spaces or line breaks in the env file value.

Stop the background server:

```bash
kill %1
# or: pkill -f "node src/server.js"
```

---

## Step 11 — Run as a Permanent Service with pm2

```bash
cd /home/oscaradmin/oscar-server
pm2 start src/server.js --name oscar
```

Configure pm2 to restart OSCAR automatically after a VPS reboot:

```bash
pm2 save
pm2 startup
```

The `pm2 startup` command will print a `sudo` command — copy and run it exactly as shown.

### Useful pm2 commands

```bash
pm2 status          # Check if oscar is running
pm2 logs oscar      # View live logs
pm2 restart oscar   # Restart after a code update
pm2 stop oscar      # Stop the service
```

---

## Step 12 — Install Nginx as Reverse Proxy

Nginx sits in front of OSCAR and handles:
- Serving the app on standard port 80 / 443
- TLS termination (HTTPS)
- Clean domain access instead of `http://IP:3001`

```bash
sudo apt install -y nginx
```

Create an Nginx configuration for OSCAR:

```bash
sudo nano /etc/nginx/sites-available/oscar
```

Paste this configuration (replace `oscar.yourdomain.com` with your actual domain):

```nginx
server {
    listen 80;
    server_name oscar.yourdomain.com;

    # Increase upload limit for data file uploads
    client_max_body_size 50M;

    location / {
        proxy_pass         http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Allow long-running requests (Bruno runs can take several minutes)
        proxy_read_timeout    660s;
        proxy_connect_timeout 660s;
        proxy_send_timeout    660s;
    }
}
```

Enable the site and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/oscar /etc/nginx/sites-enabled/
sudo nginx -t          # Test configuration — must say "syntax is ok"
sudo systemctl reload nginx
```

---

## Step 13 — Configure the Firewall

`ufw` is not installed by default on all VPS images. Install it first:

```bash
sudo apt install -y ufw
```

Then configure and enable it:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

When `ufw enable` asks `Command may disrupt existing SSH connections. Proceed with operation (y|n)?` — type `y`. Your SSH session will stay connected because you already allowed OpenSSH just before.

> **Port 3001 does NOT need to be opened** — Nginx proxies to it internally. Only open 3001 temporarily if you need to test the Node.js server directly from a browser before Nginx is set up, and close it again afterwards with `sudo ufw delete allow 3001`.

---

## Step 14 — Enable HTTPS with Let's Encrypt (Strongly Recommended)

```bash
sudo apt install -y certbot python3-certbot-nginx
```

> ⚠️ **Use your real domain name** in the command below — the exact same name you put in `server_name` in the Nginx config (Step 12). Do **not** type `oscar.yourdomain.com` literally — that is a placeholder. If you use the wrong domain, Certbot will fail with an `unauthorized` error.

```bash
sudo certbot --nginx -d YOUR_ACTUAL_DOMAIN
```

For example, if your domain is `vps119497.serveur-vps.net`:

```bash
sudo certbot --nginx -d vps119497.serveur-vps.net
```

Follow the prompts. Certbot will:
1. Obtain a free TLS certificate
2. Automatically update the Nginx configuration for HTTPS
3. Set up automatic certificate renewal

Test automatic renewal:

```bash
sudo certbot renew --dry-run
```

After this step, OSCAR is accessible at `https://YOUR_ACTUAL_DOMAIN`.

---

## Step 15 — Verify the Full Installation

Open a browser and navigate to `https://YOUR_ACTUAL_DOMAIN` (e.g. `https://vps119497.serveur-vps.net`).

You should see the OSCAR login page. Log in with the admin account created in Step 10.

Run through this checklist:

- [ ] Login page loads over HTTPS
- [ ] Admin panel accessible after login
- [ ] Company profile page allows setting API endpoint and credentials
- [ ] Data file upload works
- [ ] A test run can be submitted and reaches QUEUED status
- [ ] Run executes and reaches COMPLETED status
- [ ] HTML report artifact opens in browser
- [ ] Report comparison works between two completed runs
- [ ] Register tab: submit a real email + company name → green "Check your inbox" panel appears
- [ ] Confirmation email received → click link → set password → account created and logged in

---

## GitHub Workflow — Local Development to Production

OSCAR uses GitHub as the bridge between your local Windows machine and the VPS. The repository is:
**https://github.com/TOP-PHE/OSCAR-OSdm-Compliance-Automation-Runner**

### Overview

```
[Windows — edit & test locally]
           ↓  git commit + git push
      [GitHub repository]
           ↓  git pull + pm2 restart
  [VPS — production server]
```

---

### What is tracked in Git / what is not

| Path | In Git? | Reason |
|------|---------|--------|
| `src/` | ✅ Yes | Server source code |
| `public/` | ✅ Yes | Web UI pages |
| `package.json` | ✅ Yes | Dependency list |
| `.gitignore` | ✅ Yes | Git exclusion rules |
| `oscar-server.env` | ❌ No | Contains secrets — never commit |
| `data/` | ❌ No | Database and run artifacts — server only |
| `node_modules/` | ❌ No | Reinstalled via `npm install` |
| `oscar-user-management.ps1` | ❌ No | Local admin script |

---

### Daily workflow — push an update to the server

**Step 1 — Edit and test locally on Windows**

```powershell
cd "C:\Users\patri\OneDrive\...\oscar-server"
node src/server.js
# Open http://localhost:3001 and verify your changes
# Press Ctrl+C when done
```

**Step 2 — Commit and push to GitHub**

```powershell
git add .
git commit -m "Brief description of what changed"
git push
```

**Step 3 — Pull and restart on the VPS**

```bash
cd /home/oscaradmin/oscar-server && git pull && pm2 restart oscar
```

That single line is all you need for every future deployment.

If `package.json` changed (new dependency added), also run `npm install`:

```bash
cd /home/oscaradmin/oscar-server && git pull && npm install && pm2 restart oscar
```

---

### One-time setup — connecting the VPS to GitHub (already done)

This section documents what was done during the initial setup for reference.

**Prerequisites on the VPS:**
```bash
sudo apt install -y git
```

**GitHub Personal Access Token (Classic):**
1. Go to https://github.com/settings/tokens
2. Click **Generate new token (classic)**
3. Note: `OSCAR VPS deploy` — Expiration: `No expiration` — Scope: ✅ `repo`
4. Copy the `ghp_...` token — it is shown only once

**Connecting the existing folder to GitHub:**
```bash
cd /home/oscaradmin/oscar-server
git init
git remote add origin https://github.com/TOP-PHE/OSCAR-OSdm-Compliance-Automation-Runner.git
git fetch origin
git reset --hard origin/main
```
When prompted: **Username** = `TOP-PHE` — **Password** = your `ghp_...` token

**Restore env file and data after reset:**
```bash
cp ~/oscar-server.env.backup /home/oscaradmin/oscar-server/oscar-server.env
cp -r ~/data.backup /home/oscaradmin/oscar-server/data
chown -R oscaradmin:oscaradmin /home/oscaradmin/oscar-server
npm install
pm2 restart oscar
```

---

### Troubleshooting Git on the VPS

**`git: command not found`**
```bash
sudo apt install -y git
```

**`fatal: destination path already exists and is not an empty directory`**

Do not delete the folder. Initialize git inside it instead:
```bash
cd /home/oscaradmin/oscar-server
git init
git remote add origin https://github.com/TOP-PHE/OSCAR-OSdm-Compliance-Automation-Runner.git
git fetch origin
git reset --hard origin/main
```

**`error: remote origin already exists`**

Skip `git remote add` and go straight to:
```bash
git fetch origin
git reset --hard origin/main
```

**`remote: Write access to repository not granted` (403)**

Your token does not have the right permissions. Generate a new **Classic** token with the `repo` scope checked (see above).

**`remote: Invalid username or token`**

You used your email address as the username. Use `TOP-PHE` (your GitHub username), not your email.

---

## Updating the Bruno Collection (OTST_V2.0.1)

When a new version of the OTST collection is released:

```powershell
# From Windows PowerShell
scp -r "C:\...\OTST_V2.0.1" oscaradmin@YOUR_VPS_IP:/home/oscaradmin/
```

No server restart is needed — the collection path is read at each run execution.

---

## Directory Reference on the VPS

```
/home/oscaradmin/
├── oscar-server/
│   ├── src/                        # Application source code
│   ├── public/                     # Web UI (HTML pages)
│   ├── data/
│   │   ├── oscar.db                # SQLite database (single file = full state)
│   │   ├── datafiles/              # Uploaded data files per company
│   │   └── artifacts/              # Run reports and JSON results
│   ├── package.json
│   └── oscar-server.env            # Configuration (keep secure, chmod 600)
└── OTST_V2.0.1/
    ├── opencollection.yml
    ├── environments/               # Ephemeral env files written/deleted per run
    ├── library-bruno/
    └── Validation_Reports/         # Bruno writes reports here during runs
```

---

## Backup Recommendation

The entire OSCAR state is in two locations:

```bash
# Database — backup daily
/home/oscaradmin/oscar-server/data/oscar.db

# Run artifacts — backup weekly
/home/oscaradmin/oscar-server/data/artifacts/
```

Simple daily backup to a local copy:

```bash
# Add to crontab (crontab -e)
0 2 * * * cp /home/oscaradmin/oscar-server/data/oscar.db /home/oscaradmin/backups/oscar_$(date +\%Y\%m\%d).db
```

---

## Troubleshooting

### Server does not start

```bash
pm2 logs oscar --lines 50
```

Common causes:
- Missing or wrong value in `oscar-server.env` — check all required vars are set
- Windows paths still in env file — `COLLECTION_PATH` and `BRU_CMD` must be Linux paths starting with `/`
- Wrong `COLLECTION_PATH` — verify: `ls /home/oscaradmin/OTST_V2.0.1`
- `bru` not found — verify: `which bru` returns a path

### Cannot access the site from browser (`no data received` error)

The firewall is blocking the port. Check and fix:

```bash
sudo ufw status
sudo ufw allow 'Nginx Full'   # If using Nginx
# OR temporarily for direct testing:
sudo ufw allow 3001
```

Also check your VPS provider's external firewall in their control panel — some providers have a separate firewall that must be configured there.

### Bootstrap curl command not working

- Make sure the server is running first: `curl http://localhost:3001/health`
- The entire curl command must be on **one single line** — no line breaks
- The JSON body must start with `'{"` and end with `"}'`
- No spaces inside the email or password values in the JSON

### Bruno run fails immediately

```bash
# Verify bru is accessible
bru --version

# Verify collection path is correct
ls /home/oscaradmin/OTST_V2.0.1/opencollection.yml
```

### Certbot fails with `unauthorized` error

This means the domain in the `certbot` command does not match what the DNS/web resolves to. Common cause: the placeholder `oscar.yourdomain.com` was typed literally instead of the real domain name.

Fix: run certbot again with the correct domain — the same name as `server_name` in your Nginx config:

```bash
sudo certbot --nginx -d YOUR_ACTUAL_DOMAIN
```

### Cannot access the site after Nginx setup

```bash
sudo systemctl status nginx
pm2 status
sudo ufw status
sudo nginx -t     # Check for config syntax errors
```

### Registration email not received / SMTP errors

Check the live logs immediately after submitting the registration form:

```bash
pm2 logs oscar --lines 20
```

| Error in logs | Cause | Fix |
|---|---|---|
| `[auth] Email send failed: Invalid login: 535 5.7.8 Authentication failed` | Wrong SMTP credentials | Check `SMTP_USER` and `SMTP_PASS` in env file — with Brevo, `SMTP_PASS` must be the **SMTP key** (starts with `xsmtpsib-`), not the API key (starts with `xkeysib-`) |
| `[auth] Email send failed: ECONNREFUSED` | Cannot reach the SMTP server | Check `SMTP_HOST` and `SMTP_PORT`. Try port 465 with `SMTP_SECURE=true` |
| `503 Service Unavailable` returned to browser | `NODE_ENV=production` set but SMTP not configured | Add all `SMTP_*` variables to `oscar-server.env` and restart |
| Email sent but lands in spam | Sender domain not verified | Add the sender domain to Brevo's verified senders list, or use a recognised From address |

After editing `oscar-server.env`, always restart:

```bash
pm2 restart oscar
```

To quickly verify credentials without going through the app:

```bash
cd ~/oscar-server
node -e "
const nodemailer = require('nodemailer');
require('dotenv').config({ path: './oscar-server.env' });
console.log('HOST:', process.env.SMTP_HOST);
console.log('USER:', process.env.SMTP_USER);
console.log('PASS length:', (process.env.SMTP_PASS||'').length);
const t = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});
t.verify().then(() => console.log('✅ SMTP OK')).catch(e => console.error('❌ SMTP FAIL:', e.message));
"
```

### Check server logs live

```bash
pm2 logs oscar
```
