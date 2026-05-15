# OSCAR — Security Operations Policy

> This document is Phase 3 of issue #60 (Vendor Data Sovereignty). Phases 1
> and 2 closed the application-level and on-disk-encryption gaps in code.
> This phase covers the things software cannot defend against on its own:
> who has root access to the production VPS, how keys are managed and
> rotated, how backups are protected, and what to do when something goes
> wrong.
>
> It is intentionally specific. Vague policies don't get followed. Procedures
> here are concrete enough to execute without further interpretation.

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer).
"This material is copyrighted by UIC, Union Internationale des Chemins de fer © 2026."

---

## 1. Purpose and Scope

OSCAR runs as a small Docker stack on a single VPS (currently
`oscar.uic.org`). The application code, audited and hardened across
v1.6–v1.11, defends against external attackers and against unintended
read paths from the UI / API. What it cannot defend against is the
human (or compromised account) with root SSH on the host running OSCAR —
that human can attach a debugger to the running process, read
`ENCRYPTION_KEY` out of memory, and decrypt anything.

This policy defines how UIC keeps the population of "people with that
level of access" small, accountable, and auditable.

**In scope:** the production OSCAR deployment at `oscar.uic.org`, its
host VPS, the `oscar` Docker container, its data volumes, its backups,
the GitHub repository and Container Registry that feed it.

**Out of scope:** vendor-side test environments, OSDM specification work,
the Bruno collection development workflow (covered by `CONTRIBUTING.md`).

---

## 2. Roles and Access Tiers

OSCAR distinguishes three tiers of "operator" with strictly different
permissions on the production host. The application-level roles
(administrator, test_manager, certifier, tester) are documented in the
Admin Guide § 15 and are unrelated to this hierarchy.

### 2.1 Tier A — Platform Operator (root SSH)

Can SSH into `oscar.uic.org` with `sudo` privileges. Can read raw disk,
attach debuggers, modify config, restart services, rotate secrets.

**Authorized count:** strictly two named individuals at any time.
Currently:
1. Patrick Heuguet (primary)
2. *Designated UIC IT contact — to be named*

**Access mechanism:** SSH key pair only. Password authentication is
disabled (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).
Public keys are tracked in `~/.ssh/authorized_keys` for the `ubuntu`
user.

**Audit:** every `sudo` command is logged to `/var/log/auth.log`. Once a
quarter, logs are reviewed for unexpected activity.

### 2.2 Tier B — Platform Administrator (OSCAR admin UI)

Holds the `administrator` role in OSCAR's user table. Can manage users,
companies (metadata only), server config, alerts, observability stack
through the web UI. **Cannot read vendor test data** — that constraint
is enforced in code since v1.10.0 (issue #60 Phase 1).

**Authorized count:** at most three named individuals. Reviewed twice
yearly to remove inactive admins.

**Access mechanism:** OSCAR username + password + 2FA via the password
reset / SMTP flow.

### 2.3 Tier C — UIC Certification Reviewer (certifier role)

Holds the `certification_user` role. Sees only runs that a vendor's Test
Manager has explicitly shared.

**Authorized count:** as needed for the certification workload.

**Access mechanism:** OSCAR username + password.

### 2.4 Strict separation

A person holding Tier A access **must not** also hold Tier B or Tier C
on the same identity. Use a different email address (e.g.
`patrick.heuguet+ops@trackonpath.com` for the OSCAR admin account) so
that a compromise of one does not cascade. This is enforced by policy,
not by code.

---

## 3. Key Management

OSCAR depends on four long-lived secrets. All four live in
`/opt/OSCAR/OSCAR_Deploy/.env` on the production host with file
permissions `600` (root only).

### 3.1 Inventory

| Secret | Used by | Rotation cadence | What breaks on rotation |
|---|---|---|---|
| `ENCRYPTION_KEY` | At-rest encryption (creds + run_events + run_requests + scenarios + artifact files) | **NEVER ROTATE** under normal conditions | Without re-encryption pass, all encrypted data becomes unreadable |
| `JWT_SECRET` | Web session tokens | On suspected leak; otherwise indefinite | All active web sessions invalidated; users must re-login |
| `PLATFORM_BOOTSTRAP_TOKEN` | One-time admin creation via `POST /v1/auth/bootstrap/platform-user` | Once initial admin is created, this is cleared (set to empty) | The bootstrap endpoint returns 503 until set again |
| Brevo SMTP key | Outbound emails (alerts, password reset, verification) | When Brevo rotates / on suspected leak | Email delivery stops until re-configured |

### 3.2 `ENCRYPTION_KEY` — the most critical secret

This is the AES-256-GCM key used to encrypt **all** at-rest data —
OAuth credentials in `users` table, log content, HTTP traffic, scenarios,
artifact files. **Losing this key means losing read access to every
encrypted byte.**

#### Generation (already done — for reference only)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### Storage

- Primary: `/opt/OSCAR/OSCAR_Deploy/.env` on the VPS, mode 600
- Backup: in a 1Password (or equivalent) vault entry owned by both Tier A
  operators. The vault entry's audit log shows every access.

**Never** commit this key to git. **Never** paste it into chat, email,
ticket systems, or screenshots. **Never** copy it to a developer's laptop.

#### Rotation procedure (only if suspected leak)

If rotation is genuinely required, it is a planned ~2 h maintenance
window because every encrypted value must be re-encrypted under the
new key:

1. Announce maintenance window via OSCAR welcome news + email to admins
2. Generate new key (above command)
3. SSH to VPS; create `data/oscar.db.backup` and `data/artifacts.tgz`
   snapshot
4. Run a one-shot Node script that:
   - Loads every encrypted column / file using the **old** key
   - Re-encrypts using the **new** key
   - Commits in a single transaction per table
5. Update `.env` with the new `ENCRYPTION_KEY`
6. `docker compose up -d --force-recreate oscar`
7. Verify with the three CLI checks from Admin Guide § 15.6
8. After 7 days with no rollback need, delete the old-key backup

A re-encryption script template lives at
`OSCAR_Deploy/scripts/rekey-encryption.sh.example` — not committed yet
(it's an aspirational future file; for now, rekey requires hand-written
code).

### 3.3 `JWT_SECRET` — session signing

Cheaper to rotate. Effect: every user logged in must log in again.

#### Rotation procedure

```bash
# Generate new
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "JWT_SECRET=$NEW"

# Update .env on the VPS (or use the admin UI's "Rotate JWT Secret" button —
# which does the same thing through /v1/admin/rotate-jwt-secret)
ssh ubuntu@oscar.uic.org "sudo sed -i \"s|^JWT_SECRET=.*|JWT_SECRET=$NEW|\" /opt/OSCAR/OSCAR_Deploy/.env"
ssh ubuntu@oscar.uic.org "cd /opt/OSCAR/OSCAR_Deploy && sudo docker compose restart oscar"
```

After restart, all existing JWTs are invalid. Users see "session
expired" toast (v1.9.1 wired this up) and are bounced to login.

### 3.4 SMTP credentials

Brevo SMTP key. Held in OSCAR's Server Config tab (DB) since v1.7. Also
held in `OSCAR_Deploy/alertmanager/alertmanager.yml` for Alertmanager —
since v1.9.0 this file is generated from the DB on save, so there's one
canonical source.

Rotate when Brevo rotates (their dashboard notifies) or on suspected
leak. Procedure: Brevo → SMTP & API → generate new key → paste into
OSCAR Server Config → Save → click "Apply alerting config".

---

## 4. Backup Policy

### 4.1 What gets backed up

The SQLite database **`oscar.db`** and the **artifact directory**
(`data/artifacts/`) and the **datafiles directory**
(`data/datafiles/`). Everything else (Bruno collection, code, container
images) lives in git / GHCR and is reproducible.

### 4.2 Frequency and retention

- **Daily** snapshot at 03:00 UTC via cron (host-level)
- Retention: 14 days rolling
- **Pre-upgrade** snapshot before any `docker compose pull oscar`
- Retention: until the next stable upgrade is confirmed working
- **Quarterly** archive moved to off-host cold storage (UIC fileshare),
  retained 4 years for audit

### 4.3 Encryption at rest of backups

Backups inherit OSCAR's at-rest encryption envelope automatically:
- `oscar.db` — sensitive columns already AES-256-GCM encrypted in place
  (v1.11.0)
- `data/artifacts/*` — files written from v1.11.0+ are OSCAR1-enveloped;
  earlier files remain plaintext until naturally re-written or until the
  optional bulk-encrypt script runs

For **defence in depth**, the rolling backup tarballs are themselves
encrypted with `gpg --symmetric --cipher-algo AES256` using a passphrase
stored in the same 1Password vault as `ENCRYPTION_KEY`.

```bash
# Daily cron (sudo crontab -e):
0 3 * * * tar -C /opt/OSCAR/OSCAR_Deploy -czf - data | \
          gpg --batch --yes --symmetric --cipher-algo AES256 \
              --passphrase-file /root/.oscar-backup-pass \
              -o /opt/OSCAR/backups/oscar-$(date +\%F).tgz.gpg && \
          find /opt/OSCAR/backups -mtime +14 -delete
```

### 4.4 Restore procedure

```bash
ssh ubuntu@oscar.uic.org
sudo docker compose stop oscar
sudo gpg --batch --decrypt --passphrase-file /root/.oscar-backup-pass \
     /opt/OSCAR/backups/oscar-YYYY-MM-DD.tgz.gpg | \
  sudo tar -C /opt/OSCAR/OSCAR_Deploy -xzf -
sudo docker compose up -d oscar
```

Restore is destructive — confirm with the data owner before doing it
during business hours.

---

## 5. Incident Response

### 5.1 Severity levels

| Severity | Definition | First-response target |
|---|---|---|
| **SEV-1** | Production-down, security breach confirmed, or data loss | 15 min — notify both Tier A operators |
| **SEV-2** | Production degraded (slow, partial failures) | 1 h — Tier A primary investigates |
| **SEV-3** | A single tester or company affected; platform broadly healthy | 4 business h |
| **SEV-4** | Minor cosmetic / non-blocking | Next sprint |

### 5.2 Communication channels during an incident

1. **Internal**: WhatsApp / Signal group with both Tier A operators
2. **External (administrators)**: email to admin distribution list
3. **External (users)**: status banner on `oscar.uic.org` welcome page
   (`Oscar_Server/public/news/index.json` — push a "Service notice"
   entry with `tag: "Operations"`)
4. **External (UIC stakeholders)**: dedicated email if SEV-1 lasts > 1 h

### 5.3 SEV-1 incident playbook — "OSCAR is down"

This morning's `502 Bad Gateway` outage exercised this. The proven
sequence:

```bash
# 1. Confirm scope
curl -i https://oscar.uic.org/health  # from outside the VPS

# 2. SSH in, inspect
ssh ubuntu@oscar.uic.org
docker ps --filter name=oscar --format 'table {{.Names}}\t{{.Status}}'
docker logs oscar --tail 80

# 3. Quick remediation if container is restart-looping
sudo docker compose -f /opt/OSCAR/OSCAR_Deploy/docker-compose.yml restart oscar

# 4. If a recent Watchtower update broke things, roll back to :edge image
docker images ghcr.io/top-phe/oscar-server
sudo docker tag ghcr.io/top-phe/oscar-server:edge \
                ghcr.io/top-phe/oscar-server:stable
sudo docker compose up -d --force-recreate oscar

# 5. If a migration crashed, mark it complete in the DB to skip it on next boot
sudo apt install -y sqlite3  # one-time
sudo docker stop oscar
sudo sqlite3 /opt/OSCAR/OSCAR_Deploy/data/oscar.db \
  "INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (<N>, datetime('now'));"
sudo docker compose up -d --force-recreate oscar
```

The full incident from this morning is documented in § 8 below as a
worked example.

### 5.4 Vendor reports a data leak suspicion

1. **Acknowledge within 1 h** — confirm receipt, set expectation that
   investigation will take 24–72 h
2. **Preserve evidence** — snapshot `oscar.db`, `data/artifacts/`, and
   the auth_events log to a read-only copy before any remediation
3. **Investigate**:
   - What did the vendor see / share? Get a screenshot or repro path
   - Check `auth_events` table for anomalous access to that company's
     data
   - Check Loki logs (`{container="oscar"}`) for the affected time
     window
   - Check the share table — did anyone unexpectedly flip
     `shared_with_certifier_at`?
4. **Determine class**:
   - **Application bug** (e.g. tenant filter missed an endpoint) →
     patch, deploy, rotate `JWT_SECRET` to invalidate any sessions that
     used the leak, notify the vendor
   - **Credential leak** (an admin's account compromised) → reset that
     admin's password, audit their recent actions, rotate
     `JWT_SECRET`
   - **Host compromise** (Tier A access taken over) → full rebuild —
     new VPS, new `ENCRYPTION_KEY` (with re-encrypt pass), notify all
     companies, possibly involve UIC legal
5. **Communicate** — vendor first, then UIC stakeholders, then a
   redacted post-mortem to all administrators

### 5.5 Suspected key leak

If any of the four long-lived secrets is suspected leaked:

- `ENCRYPTION_KEY` → SEV-1, rotate-and-re-encrypt window (§ 3.2)
- `JWT_SECRET` → SEV-2, immediate rotation via admin UI button
- `PLATFORM_BOOTSTRAP_TOKEN` → not really a leak risk (single-use); just
  clear it
- SMTP key → SEV-2, rotate in Brevo + paste new key in Server Config

---

## 6. Audit and Compliance

### 6.1 What's logged

- **OSCAR application audit log** (`auth_events` table) — every login,
  privilege change, share toggle, password reset, JWT rotation,
  admin-config change
- **Host system log** (`/var/log/auth.log`, `journalctl`) — every SSH
  connection, every `sudo` command
- **Container logs** (Loki via Promtail since v1.7) — OSCAR stdout /
  stderr, all dependent containers, indefinite retention by default
- **Watchtower** — every image pull and container update

### 6.2 Periodic reviews

| Cadence | Reviewed | Owner |
|---|---|---|
| Weekly | Open issues + open security alerts on the repo | Primary Tier A |
| Monthly | OSCAR admin and certifier user list (revoke inactive) | Primary Tier A |
| Quarterly | Host `auth.log` for unexpected sessions / sudo | Primary Tier A |
| Quarterly | Backup integrity (decrypt + restore to test VPS) | Primary Tier A |
| Half-yearly | Tier B admin list + this policy itself | UIC IT contact |
| Yearly | Full pen-test or external review | UIC procurement |

### 6.3 Evidence preservation

If a SEV-1 or SEV-2 incident occurs, all artefacts (logs, DB snapshot,
authn events for ±24h) are preserved on read-only storage for **180
days** before any deletion. This survives the normal backup retention
window.

---

## 7. Known Operational Risks Not Closed by Code

These are documented limitations. Operational discipline (this policy)
is the only mitigation:

1. **Tier A operator with debugger access can read everything.** Memory
   inspection of the OSCAR Node process recovers `ENCRYPTION_KEY` and
   decrypted payloads. Mitigation: keep Tier A count strictly to two
   trusted individuals; review `sudo` log quarterly.
2. **Backup passphrase is held by the same humans who hold Tier A
   access.** A compromised Tier A operator can decrypt backups. No code
   mitigation possible; this is fundamentally a trust problem.
3. **`compatibility.json` warnings do not block boot** — a vendor or
   operator running an untested server / collection combination only
   gets a log warning. Intentional (lets us run release candidates
   without a hard-fail) but worth knowing.
4. **DNS hijack on `oscar.uic.org`** — if UIC's DNS provider is
   compromised, an attacker can route the hostname to their own server
   and harvest credentials. Mitigation: DNSSEC if UIC supports it;
   certificate-pinning is impractical for a web app.
5. **Build supply chain** — a compromise of GitHub Actions, the GHCR
   registry, or a package OSCAR depends on (npm, Bruno CLI) could land
   a backdoor in the next `:stable` image. Mitigation: Dependabot
   alerts, CodeQL + Sonar gates, Trivy image scan, and the operator
   reviewing release notes before manually unlocking auto-update if a
   suspicious release lands.

---

## 8. Worked Example — 2026-05-15 v19 Migration Outage

### What happened

PR #61 (vendor data sovereignty, Phase 1 + 2) auto-merged at 07:20 UTC.
The CI pipeline built a new `:stable` image. Watchtower picked it up at
~12:31 UTC and recreated the `oscar` container. The container's
schema migration v19 crashed with
`TypeError: Provided value cannot be bound to SQLite parameter 2` —
the migration used `SELECT rowid` but Node 22's built-in `node:sqlite`
doesn't surface `rowid` as a row property without explicit aliasing.

Container exited 1 → autoheal restarted → same crash → restart-loop →
502 Bad Gateway visible to all users.

### Time to recovery: ~1 h 45 min from user-reported outage to full restoration

**12:31** — Watchtower applies v1.11.0 image.

**13:25** — User opens browser, sees 502.

**13:30** — User reports to Tier A primary (this conversation).

**13:35** — Initial diagnosis: container in restart loop, root cause
identified as v19 migration crash.

**13:40** — First recovery attempt: `:edge` image re-tag → OSCAR boots
on v1.2.0 (very old, but functional). Partial recovery — users can log
in but features missing.

**14:00** — Watchtower polled again, pulled v1.11.0, removed the `:edge`
image during cleanup. Container crash-loops AGAIN.

**14:08** — Recovery option B: install `sqlite3` on host, manually
INSERT `schema_version (version=19)`, recreate container. Migration
skipped, OSCAR boots cleanly on v1.11.0.

**14:11** — Container healthy. Full feature set restored.

**14:25** — Hotfix PR #62 (v1.11.1) merged; image built; Watchtower
will pick up the corrected migration on its next poll. No further user
action needed; new image is a no-op against `schema_version=19`.

### What worked

- Healthcheck + autoheal correctly identified the container as unhealthy
- Loki captured the full stack trace for diagnosis
- The schema_version manual bump was a clean recovery mechanism — the
  v19 migration is purely a one-time backfill, so skipping it leaves
  the system in a working state (existing rows stay plaintext, new
  writes encrypted via `colEncrypt`)
- The mixed-state read helpers (legacy plaintext + new ciphertext)
  designed for backward compat ALSO turned out to be the right design
  for partial-migration recovery

### What didn't work

- **No quick rollback to a known-good tagged image** — `:edge` was the
  only locally-cached fallback, and it was v1.2.0 (months stale).
  Lesson: keep at least the most recent two `:stable` versions
  available, either as tagged images on GHCR or pre-pulled on the host.
- **Watchtower's `image_name` log column is misleading** — it showed
  `image_name=...:stable` even while removing the previous `:edge`
  image. Made debugging slower than it needed to be.
- **The v19 migration was tested only on an empty DB.** Local CI tests
  exercised `colEncrypt` / `colDecrypt` thoroughly but never seeded
  rows + ran the migration end-to-end. Adding that test is on the
  backlog.

### Action items from this incident

| Item | Owner | Status |
|---|---|---|
| Pin the last 3 stable image tags to GHCR (`stable-1`, `stable-2`, `stable-3`) so rollback always has options | Tier A primary | TODO |
| Add an integration test that seeds rows, runs every migration, asserts data integrity | Backlog | TODO |
| Document the `INSERT OR REPLACE INTO schema_version` manual recovery in the Admin Guide | This document, § 5.3 | ✅ done |
| Quarterly fire-drill: practice the SEV-1 playbook on a staging VPS | Tier A primary | TODO (first drill: Q3 2026) |

---

## 9. Reading Guide

When something happens, which doc to open first:

| Situation | Read first |
|---|---|
| "Something is wrong with OSCAR" | This document § 5 (Incident response) |
| Need to understand what role can do what | Admin Guide § 13 + § 15 |
| Configuring SMTP, alerts, observability | Admin Guide § 14 |
| Setting up a new self-hosted instance | Self-Hosted Quick Start |
| Bringing a new admin onboard | This document § 2 + Admin Guide § 13.1 |
| Annual review of access lists | This document § 6.2 |
| Forensic investigation of an incident | This document § 5.4 + § 6.3 |

---

## 10. Change Log of This Policy

| Date | Change | Author |
|---|---|---|
| 2026-05-15 | Initial issue. Captures policy state after issue #60 Phases 1–3 land. Worked example from same-day v19 migration outage included. | Patrick Heuguet |

This policy is reviewed half-yearly (§ 6.2). Substantive changes are
recorded above with rationale.
