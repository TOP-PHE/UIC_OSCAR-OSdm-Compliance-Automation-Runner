# Changelog

All notable changes to OSCAR (OSDM Conformance Automation Runner) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- (next cycle)

---

## [server-v1.11.2] — 2026-05-15

Docs-only. Ships Phase 3 of issue #60 — the operational policy that
closes the part of "vendor data sovereignty" that software cannot
enforce on its own.

### Added
- **`Documentation/Server_Operations/OSCAR - Security Operations Policy.md`**
  — the policy document that defines:
  - Access tiers (Tier A platform operator with root SSH; Tier B
    OSCAR administrator; Tier C certification reviewer)
  - Strict separation rule — a person with Tier A access must not
    hold Tier B/C on the same identity
  - Key management inventory + rotation procedures for all four
    long-lived secrets (`ENCRYPTION_KEY`, `JWT_SECRET`,
    `PLATFORM_BOOTSTRAP_TOKEN`, Brevo SMTP key)
  - Backup policy: daily snapshots, 14-day rolling retention,
    quarterly cold archives, GPG-encrypted backup tarballs
  - SEV-1 → SEV-4 severity levels and target response times
  - SEV-1 incident playbook (with the verified commands that worked
    during the 2026-05-15 v19 outage)
  - Procedure when a vendor reports a data-leak suspicion
  - Periodic review cadence (weekly to yearly) with explicit owners
  - Known operational risks NOT closed by code, with mitigations
  - A worked example of the 2026-05-15 v19 migration outage —
    timeline, what worked, what didn't, four concrete action items
  - Reading guide mapping situations to docs

### Changed
- **Admin Guide § 15.5** — Phase 3 marker flipped from ⏳ to ✅;
  cross-reference to the policy doc added.

### Operator action
None. Docs-only. Watchtower picks up v1.11.2 and the recreate is a
no-op against the running v1.11.1 schema state.

### Status of issue #60
| Phase | Status |
|---|---|
| 1 — Application-level access control + per-run sharing | ✅ v1.10.0 |
| 2 — At-rest encryption (DB columns + artifact files) | ✅ v1.11.0 + v1.11.1 hotfix |
| 3 — Operational policy | ✅ v1.11.2 (this) |

Issue #60 closeable.

---

## [server-v1.11.1] — 2026-05-15

Critical hotfix. v1.11.0 shipped with a broken v19 migration that crashed
OSCAR on first boot, leaving production in a restart loop. Recovery was
pinning to the previous (`:edge`) image while this fix was prepared.

### Fixed
- **v19 migration crash** — `Provided value cannot be bound to SQLite
  parameter 2`. The migration ran `SELECT rowid, ... FROM <table>` and
  then `UPDATE ... WHERE rowid = ?`, but Node 22's built-in
  `node:sqlite` (DatabaseSync) does not surface `rowid` as a row
  property when SELECTed without an explicit alias — `r.rowid` came
  back `undefined` and the bind failed. Switched to the explicit `id`
  primary key, which exists on all four affected tables
  (`run_events`, `run_requests`, `test_frameworks`, `test_resources`).
- **Per-row error isolation** added to v19 — a single unbindable row
  (corrupt data, oversized payload, etc.) no longer aborts the whole
  table's migration. The offending row is left plaintext and gets
  encrypted on its next natural write via `colEncrypt`. Counts logged
  for operator visibility.

### Migration
Schema migration v18 was already applied during the failed v1.11.0
boot (ALTER TABLE ADD COLUMN is durable across crashes), so v1.11.1's
boot sees `schema_version = 18` and applies only the now-fixed v19.
No manual DB intervention required.

### Operator action
After Watchtower rolls over to v1.11.1, or after a manual:
```bash
sudo docker compose pull oscar
sudo docker compose up -d --force-recreate oscar
```
the migration runs cleanly. Existing plaintext rows are encrypted on
first boot, and OSCAR resumes normal operation with the full v1.11.0
feature set (per-run share, admin role tightening, at-rest encryption).

---

## [server-v1.11.0] — 2026-05-15

Minor bump — **vendor data sovereignty Phase 2 (issue #60)**:
**at-rest encryption**. Closes the gap Phase 1 deferred: the same SSH-
equipped sysadmin who could not browse vendor data through the UI could
still `sudo cat /opt/OSCAR/.../data/oscar.db | strings` and read every
log line, HTTP body, scenario, and test framework in plaintext. After
v1.11.0 the bytes on disk are AES-256-GCM ciphertext envelopes; the
plaintext exists only inside the OSCAR process while it runs.

This is **Phase 2 of three**:
- ✅ Phase 1 (v1.10.0) — application-level access control + per-run share
- ✅ Phase 2 (this) — at-rest encryption
- ⏳ Phase 3 — operational policy (who has root SSH on production)

### Added
- **`src/utils/at-rest.js`** — file-level AES-256-GCM helper. Uses the
  same `ENCRYPTION_KEY` envelope OSCAR already uses for credentials.
  Format: `OSCAR1` magic (6 B) + IV (12 B) + tag (16 B) + ciphertext.
  Sync + async variants for both buffers and files. 22 unit tests
  cover round-trip, magic-header detection, legacy plaintext fall-
  through, tampering rejection, atomic temp+rename writes.
- **`db.colEncrypt()` / `db.colDecrypt()`** — column-level wrappers
  around the existing `encrypt()`/`decrypt()` with an `enc:v1:` prefix
  marker. Mixed-state safe: any row without the prefix is treated as
  legacy plaintext and returned unchanged.

### Changed (security)
The following **content** columns and files are now encrypted at rest.
Schema, structural columns (status, timestamps, http_method, http_status,
suite_name, etc.) remain plaintext so SQL filtering / sorting / counting
keeps working without per-row decrypt cost.

| What | Where | Encrypted? |
|---|---|---|
| HTML report files | `data/artifacts/<runId>/report*.html` | ✅ new |
| JSON results files | `data/artifacts/<runId>/.bru_results.json` | ✅ new |
| Company datafiles | `data/datafiles/<slug>-datafile.json` | ✅ new |
| Log line content | `run_events.message` | ✅ new |
| HTTP request body | `run_requests.request_body` | ✅ new |
| HTTP request headers | `run_requests.request_headers` | ✅ new |
| HTTP response body | `run_requests.response_body` | ✅ new |
| HTTP response headers | `run_requests.response_headers` | ✅ new |
| Per-call context JSON | `run_requests.context` | ✅ new |
| Test framework JSON | `test_frameworks.config` | ✅ new |
| Test resources JSON | `test_resources.data` | ✅ new |
| Per-tester credentials | `users.*_enc` columns | ✅ already (v12) |
| Cached OAuth tokens | `users.cached_token_enc` | ✅ already (v11) |

### Migration
Schema migration **v19** runs automatically on first boot and encrypts
existing plaintext rows in the columns above. Per-table transactions;
rollback on failure; logs row counts. Idempotent: rows already carrying
the `enc:v1:` prefix are skipped on subsequent runs.

**Files on disk are NOT touched by the DB migration.** Existing artifact
HTML and datafile JSON files remain plaintext until they're re-written
by a new run / upload — at which point they get encrypted. This is fine
because the read helpers transparently handle both formats. An optional
one-time bulk-encrypt operator script lives at
`OSCAR_Deploy/scripts/encrypt-existing-artifacts.sh` — strictly cleanup,
not required.

### Fixed (latent bug — incidental)
- `/v1/reports/requests/:id/messages` queried four non-existent columns
  (`req_body`, `req_headers`, `resp_body`, `resp_headers`) — the real
  names are `request_*` / `response_*`. The HTTP message-chain viewer
  in Report Builder was silently empty. Fixed alongside the encryption
  work since both touch the same query.

### Search behaviour change
The `?search=...` filter on `GET /v1/runs/:id/logs` previously used
SQL `LIKE` against the message column. Now that `run_events.message`
is encrypted, server-side LIKE no longer matches ciphertext — the
endpoint fetches a wider window (5×, capped at 5000 rows) and filters
post-decrypt in Node. Query time is microseconds slower for the
post-decrypt scan; user-visible behaviour is unchanged.

### Threat coverage matrix (updated)

| Threat | v1.10 | v1.11 |
|---|---|---|
| Admin browsing UI sees vendor reports | ✅ | ✅ |
| Anonymous artifact download via UUID guess | ✅ | ✅ |
| Sysadmin `sudo cat oscar.db \| strings` reveals log + HTTP content | ❌ | ✅ |
| Sysadmin `sudo cat report.html` reveals vendor results | ❌ | ✅ |
| Sysadmin `sudo cat datafile.json` reveals scenarios | ❌ | ✅ |
| Backup tape leak (cold storage) | ❌ | ✅ |
| Sysadmin attaches debugger to running OSCAR process | ❌ | ❌ Phase 3 |

### Migration after Watchtower rolls over to v1.11.0
**No operator action required.**
- v19 migration runs on first boot
- Existing files remain readable; new writes are encrypted
- All endpoints continue to work — the read helpers are transparent
- The optional `encrypt-existing-artifacts.sh` is operator's choice

---

## [server-v1.10.0] — 2026-05-15

Minor bump — **vendor data sovereignty (Phase 1, issue #60)**. Restructures
the trust model so a company's test configuration and reports stay private
to its own testers and test_managers until the test_manager explicitly opts
in to sharing specific runs with the UIC certification team. Strips the
administrator role of all test-data read access; closes an anonymous
static-serve bypass that previously let any unauthenticated user download
an artifact knowing only the run UUID.

This is **Phase 1 of three**:
- Phase 1 (this release) — application-level access control + per-run share
- Phase 2 (next release) — at-rest DB encryption (SQLCipher)
- Phase 3 — operational policy (who has root SSH on production)

### Added
- **Per-run share-with-certifier toggle** — test_managers explicitly pick
  which terminal runs (COMPLETED / FAILED / CANCELLED) become visible to
  certifiers, via a new button on each run-detail page. Replaces the
  legacy company-wide all-or-nothing toggle as the gating mechanism.
  - `POST /v1/runs/:id/share` — share this run with certifiers
  - `DELETE /v1/runs/:id/share` — revoke certifier access to this run
  - Both audit-logged with the test_manager's email and the run id.
- **`canUserSeeRun()` helper** at `src/api/helpers/run-access.js` — single
  source of truth for "is this user allowed to see this run". Every
  endpoint that returns run-scoped data now flows through it.

### Changed (BREAKING)
- **Administrator role no longer reads test data**. The role becomes
  operations + security only — users, companies (metadata), server
  config, alerts, audit log, observability stack. Specifically removed:
  - `GET /v1/runs/:id` and all sub-endpoints (logs / artifacts /
    assertions / requests) → 404 for admin
  - `GET /v1/company/test-framework` → 403 for admin
  - `GET /v1/company/datafile` → 403 for admin
  - `GET /v1/company/test-resources` → 403 for admin
  - `GET /v1/runs` returns ONLY the data-lifecycle queue
    (DELETION_REQUESTED + DELETED_BY_ADMIN status) — metadata only,
    no per-run content. Aggregate counts still available via
    `/v1/admin/activity`.
  - `POST /v1/company/datafile`, `PUT /datafile/json`,
    `DELETE /datafile`, `PUT /test-framework`, `POST /test-resources` →
    test_manager only (was test_manager OR isPlatformRole).
- **Certifier visibility tightened**. Certifiers no longer see every run
  of a vendor that has the legacy company-wide toggle on; they see ONLY
  runs the test_manager has explicitly shared via the new per-run flag.
  The legacy `companies.share_reports_with_certifier` toggle becomes a
  master kill switch — when set to 0 it overrides every per-run share.
- **Migration v18** backfills `shared_with_certifier_at` for every
  terminal run of a company whose legacy toggle was on. Existing
  certifier workflows continue uninterrupted on rollover; the new
  per-run model applies to NEW runs going forward.

### Fixed (security)
- **`/artifacts/:runId/:filename`** — was served by `express.static` with
  no auth. Anyone able to reach OSCAR (or guess a run UUID) could
  download a vendor's HTML report or JSON results. Now gated by
  authenticated session + per-run-ownership check via `canUserSeeRun()`.
  The HTML-report `<a href>` continues to work because browsers send the
  httpOnly session cookie automatically for same-origin GETs.
- **`/data/:filename`** — same `express.static` exposure. Now requires
  authenticated session whose company owns the slug, OR a true-loopback
  request with no `X-Forwarded-For` (Bruno subprocess on the same
  host). Nginx-proxied external traffic always carries
  `X-Forwarded-For`, so the loopback path is unreachable from outside.

### Documentation
- New `Server Admin Guide § 15 — Vendor Data Sovereignty` documenting
  the trust model, the threat model (what code defends against vs. what
  requires operational policy), and the Phase 2/3 roadmap.
- Welcome news entry summarising the change for end users.

### Migration
After Watchtower rolls over to v1.10.0:
- **No operator action required.** v18 migration runs automatically on
  first boot; the backfill preserves every existing certifier workflow.
- The legacy company-wide `share_reports_with_certifier` toggle remains
  in the UI as a master kill switch.
- Test managers should familiarise themselves with the new per-run share
  button on the run-detail page.
- Administrators may notice that the "All Reports" tab now shows only
  the data-lifecycle queue, not every run on the platform — this is
  intentional (issue #60).

---

## [server-v1.9.1] — 2026-05-11

Patch release — UX polish bundling three small wins from the open-issue
backlog plus a docs-pipeline improvement.

### Fixed
- **Issue #19** — *Test Config save confirmation invisible without
  scrolling.* The `.msg` element rendered at the top of the page in
  normal document flow; admins saving from the bottom of the long Test
  Config form had no visible feedback that the save succeeded. Switched
  to a fixed-position toast pinned to the top-centre of the viewport
  regardless of scroll, with a slide-in animation. Standard 5-second
  auto-dismiss preserved. Affects every flow that calls `showMsg()` in
  `scenarios.html` (framework save, scenario save, train save, datafile
  upload, deletion confirmations, …).

### Added
- **Issue #18** — *Dashboard batch summary split into per-outcome
  counters.* The previous "X/Y done" pill was misread by users as
  "nothing has finished" when in fact every scenario had failed (the
  word "done" implied success). Replaced with up to three pills
  side-by-side: green `✓ N` (passed), red `✗ N` (failed), amber `⌛ N`
  (still running). Empty batches show a neutral em-dash. Failures are
  now immediately legible at a glance without parsing a fraction.
- **`render-docs-pdf.yml` workflow** — re-renders the Self-Hosted Quick
  Start PDF whenever its markdown source changes on `main`, commits the
  regenerated file back. Uses Python 3.12 + reportlab + xhtml2pdf, same
  toolchain that produced the initial PDF. Loop-safe (skips itself on
  github-actions[bot] commits).

### Closed
- **Issue #14** — *Requesting a new user does not work, email never
  received.* Closed with comment: root cause was misconfigured
  `SMTP_FROM` (relay-internal authentication identity used as the
  display sender). v1.9.0 already hardened this with field renaming +
  soft-validation warnings + Send test email button — no further code
  change needed.

### Migration
None — pull v1.9.1, hard-refresh the browser (Ctrl+Shift+R) to bust
cached HTML/CSS, and the new pills + sticky toast are live. No DB
change, no compose change, no operator action.

---

## [server-v1.9.0] — 2026-05-11

Minor bump — closes three operational pain points discovered during v1.8.x
rollout: scattered SMTP config, error-prone SMTP field labels, and the
"dead UI after cookie expiry" fallout from the v1.8.1 hotfix.

### Added
- **Unified SMTP / alerting config in the admin UI**. Server Config tab
  gains an Alerting card with three new keys:
  - `ALERT_RECIPIENTS` (comma- or newline-separated admin emails)
  - `ALERT_REPEAT_CRITICAL` (default `1h`)
  - `ALERT_REPEAT_WARNING` (default `4h`)
  Plus a one-click **"Apply alerting config to Alertmanager"** button
  that templates `alertmanager.yml` from current `SMTP_*` + `ALERT_*`
  values, writes it to a docker-shared volume mounted into the
  Alertmanager container at `/etc/alertmanager`, and hot-reloads via
  Alertmanager's built-in `POST /-/reload` endpoint. No SSH, no VPS
  file edits, no Docker socket exposure.
- **`POST /v1/admin/alertmanager/apply`** new admin endpoint surfacing
  the verbatim outcome of every step (file written, reload status,
  reload body) so the UI can self-diagnose partial failures.
- **Best-effort startup seed** in `server.js` — if the
  `alertmanager-config` volume is mounted (env var present) AND
  Server Config has SMTP + recipients filled in, OSCAR templates
  + reloads on boot. Eliminates the chicken-and-egg "Alertmanager
  refuses to start with empty config" problem on fresh metrics-stack
  rollouts.
- **Soft-validation warnings on SMTP_FROM** — saved-with-warning when
  the value looks like a relay-internal authentication identity
  (e.g. `*@smtp-brevo.com`, `*@smtp.sendgrid.net`) or duplicates
  `SMTP_USER`. Shown inline in the UI without blocking the save.

### Changed
- **SMTP field labels rewritten** for clarity:
  - `SMTP_USER` → "SMTP Login" (with help text: *"Authentication
    identity, often a relay-internal id like `a731f1001@smtp-brevo.com`
    — NOT the address recipients see"*)
  - `SMTP_FROM` → "Display 'From' Address" (with help text: *"Sender
    shown in the From: header, must be an address your relay has
    verified"*)
  Closes the diagnostic gap that produced the `SMTP_USER`-pasted-into-
  `SMTP_FROM` incident.
- **`docker-compose.metrics.yml` switched from host-file mount to
  shared volume** for `alertmanager.yml`. Old host file under
  `OSCAR_Deploy/alertmanager/alertmanager.yml` is no longer used and
  can be deleted after the v1.9.0 rollout.

### Fixed
- **"Dead UI" after cookie expiry** (v1.8.1 follow-up). nav.js's global
  fetch interceptor now detects 401 from any authenticated API call,
  clears stale localStorage, and bounces to login with a one-shot
  "Your session has expired" notice. The previous behaviour (silent
  button failures, no redirect) ended whenever the next page-render
  hit the legacy `oscar_user` guard, which could be never on a
  long-lived dashboard tab.

### Operations
- Single source of truth for SMTP credentials. The same Brevo / SendGrid
  / etc. login configured once in OSCAR's Server Config now drives
  password resets, email verification, test emails, AND alert delivery.
- The host-mounted `OSCAR_Deploy/alertmanager/alertmanager.yml` becomes
  legacy. Operators can delete it after the rollover; OSCAR generates
  the live config into the `alertmanager-config` named volume.

### Migration
After Watchtower rolls over to v1.9.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy

# Recreate oscar + alertmanager so they pick up the new shared volume mount.
sudo docker compose \
     -f docker-compose.yml \
     -f docker-compose.metrics.yml \
     up -d --force-recreate oscar alertmanager

# In OSCAR UI:
#   1. Server Config tab → Alerting → fill in ALERT_RECIPIENTS → Save
#   2. Click "Apply alerting config to Alertmanager"
#   3. (Optional) sudo rm OSCAR_Deploy/alertmanager/alertmanager.yml — no longer used
```

---

## [server-v1.8.1] — 2026-05-11

Hotfix — clears a redirect loop ("blinking welcome page") for users whose
session is cookie-only.

### Fixed
- **Auth guard redirect loop on cookie-only sessions** — seven web pages
  (welcome, admin, compare, dashboard, profile, run-detail, run) still
  asserted the presence of `localStorage.oscar_token` to consider the
  user logged in. The auth model migrated to an httpOnly `oscar_session`
  cookie a while back; the verify-email and forgot-password flows
  correctly write `oscar_user` to localStorage but no longer write
  `oscar_token`. Result: any freshly-verified user landing on those
  pages bounced to `/`, `/` saw `oscar_user` and bounced back to
  `/welcome.html`, repeating indefinitely (visible "blinking").
  Guards now use `oscar_user` as the client-side session-presence proxy;
  `oscar_token` is still read for legacy Bearer-header fetches when
  present. Existing administrator sessions were not affected because
  they retained `oscar_token` from before the cookie migration.

### Migration
None — Watchtower picks up the new image and the fix is live the moment
the page reloads. No DB change, no compose change, no config edit.

---

## [server-v1.8.0] — 2026-05-10

Minor bump — operational watchdog and email alerting layer on top of the
existing Prometheus + Grafana + Loki observability stack. Ships a
self-healing sidecar (autoheal) plus Alertmanager wired to admin email
through the same SMTP relay used by OSCAR itself.

### Added
- **Docker `healthcheck` on the OSCAR container** — probes `GET /health`
  every 30 s using Node's built-in `fetch` (no extra binaries needed in
  the slim image). Three failures in a row → container marked
  `unhealthy`. The `oscar` service is now labelled `autoheal=true`.
- **`willfarrell/autoheal` sidecar** in `docker-compose.yml` — watches
  the Docker socket every 30 s, restarts any `autoheal=true`-labelled
  container that goes unhealthy. ~5 MB image. Most transient hangs heal
  themselves without paging a human.
- **`prom/alertmanager` service** in `docker-compose.metrics.yml` —
  receives alerts from Prometheus, dedupes / groups, emails OSCAR
  administrators via the existing SMTP relay (Brevo, SendGrid, etc.).
  Re-pages criticals every 1 h, warnings every 4 h. Bound to
  127.0.0.1:9093.
- **Default alert ruleset** in `OSCAR_Deploy/prometheus/alerts/oscar-alerts.yml`:
  - `OscarServerDown` — `/metrics` unscrapeable for 2 min (critical)
  - `OscarRestartLoop` — > 3 container restarts in 10 min (critical)
  - `OscarQueueStuck` — queue depth > 0 + no run completed in 10 min (warning)
  - `OscarRunFailureRateHigh` — > 50 % of runs FAILED over 15 min (warning)
  - `OscarSmtpDegraded` — any SMTP failure in last 10 min (warning)
  - `OscarLoginAttackBurst` — > 50 failed logins in 5 min (warning)
  - `OscarHighMemory` — RSS > 1 GB for 15 min (warning)
  - `OscarEventLoopLag` — p99 lag > 200 ms for 10 min (warning)
- **Two news entries on welcome page**:
  - "Operational monitoring upgrade — live dashboards, centralised logs,
    and an automatic watchdog with email alerts"
  - "Three big quality-of-life features now live: credential redaction,
    self-service report deletion, and password reset by email"

### Documentation
- **`OSCAR - Server Admin Guide.md`** — new § 13 (Admin Web Tools:
  Manage Users / Companies / Server Activity / Server Config / Admin
  Dashboard tiles) + new § 14 (Operational Monitoring & Alerting:
  what's wired up, default alert table, first-time setup, end-to-end
  email-path test, silencing during planned maintenance, recipient list
  sync). § 7 also clarifies which `.env` settings are now editable at
  runtime via the Server Config tab.
- **Solution Architecture (§ 10.1)** — new "Production Observability
  and Self-Healing Stack" section covering the full Prometheus / Loki /
  Grafana / autoheal / Alertmanager topology, default alert ruleset,
  and resource budget.
- **Specification (§ 5)** — Non-Functional Requirements updated to
  mention container healthchecks + autoheal (reliability), credential
  redaction + self-service password reset (security), Prometheus +
  Grafana + Loki + Alertmanager email alerting (observability).
- **`metrics-and-monitoring.md`** — resource table updated to ~415 MB
  RAM (adds autoheal + alertmanager), four new troubleshooting rows
  for the watchdog stack.

### Migration
After Watchtower rolls over to v1.8.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy

# 1. Create the alertmanager config from the example, fill in SMTP + recipients.
sudo cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml
sudo $EDITOR alertmanager/alertmanager.yml
#    └── set: smtp_smarthost, smtp_auth_username, smtp_auth_password, recipient `to:`

# 2. Bring the new services up. `oscar` is recreated to pick up the
#    healthcheck + autoheal label; existing data is untouched.
sudo docker compose \
     -f docker-compose.yml \
     -f docker-compose.metrics.yml \
     up -d --force-recreate oscar autoheal alertmanager prometheus

# 3. Verify.
docker ps --format 'table {{.Names}}\t{{.Status}}'
#    └── oscar should now show "(healthy)" after ~30 s
```
Smoke-test the email path with the synthetic-alert curl in
`Server Admin Guide § 14.4`.

---

## [server-v1.7.0] — 2026-05-10

Minor bump — adds Loki / Promtail to the metrics stack and bakes the
auth_request fix from v1.6.0 into source.

### Added
- **Centralised logs via Loki + Promtail** — operators click 📝 Logs
  on the Admin Dashboard → land in a pre-built "OSCAR · Logs" Grafana
  dashboard with errors-only view, full live tail (5s refresh),
  per-container filter, and ad-hoc substring search. Promtail uses
  Docker SD to discover containers, so any new container in the
  compose project is picked up automatically with zero config.
  - Loki 3.4.1 — single-binary, filesystem store, bound to localhost:3100
  - Promtail 3.4.1 — Docker SD, ships stdout/stderr to Loki
  - Loki datasource auto-provisioned in Grafana (`uid: loki`)
  - New `OSCAR · Logs` dashboard JSON provisioned alongside Overview
- **Loki tile activated** in Admin Dashboard (was disabled
  "Coming soon" placeholder in v1.6.0)

### Fixed
- **SSO `auth_request` 500 Internal Server Error** —
  `OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` now ships with the
  two extra headers required to bypass OSCAR's HTTPS-redirect
  middleware on the internal SSO check (`Host: localhost` and
  `X-Forwarded-Proto: https`). Was applied live on the VPS during the
  v1.6.0 rollout; baking into source means new deployers don't hit it.

### Operations
- `Documentation/Server_Operations/metrics-and-monitoring.md` —
  troubleshooting table now covers every gotcha hit during v1.5.0 →
  v1.7.0 rollout. Resource budget bumped to ~380 MB RAM / ~600 MB
  disk after 30d (was ~270 MB / ~550 MB without Loki+Promtail).
- `Documentation/Server_Operations/auto-deploy-setup.md` — new
  "When refresh-collection.sh fails with 'working tree dirty'"
  recovery section.

### Migration
After Watchtower rolls over to v1.7.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d loki promtail
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d --force-recreate grafana
```
The force-recreate of Grafana picks up the new Loki datasource. After
that, Admin Dashboard → 📝 Logs tile lands in OSCAR · Logs dashboard
with live container output streaming in.

---

## [server-v1.6.0] — 2026-05-10

Minor bump — new SSO endpoint, new public page, replaces the htpasswd
basic-auth model that v1.5.x shipped.

### Added
- **SSO into Grafana via OSCAR JWT.** New `GET /v1/auth/sso-check`
  endpoint validates the `oscar_session` cookie and returns
  `X-User-Email` + `X-User-Role` if the user is an administrator,
  401 otherwise. nginx's `auth_request` directive uses this to gate
  `/grafana/` (and `/prometheus/`, see below). Grafana auto-creates
  a matching user (Viewer role) on first visit via its `auth.proxy`
  module. No more htpasswd file to manage.
- **Prometheus web UI exposed at `/prometheus/`** behind the same SSO
  gate. Useful for raw PromQL queries and scrape-target health
  inspection. Bound to `127.0.0.1:9090` on the host; only nginx (with
  the SSO check) can reach it externally.
- **New "Admin Dashboard" nav entry** (administrator only) → page at
  `/admin-dashboard.html` with three tiles: 📈 Grafana, 🔍 Prometheus,
  📝 Logs (Loki) — the Loki tile is a disabled placeholder for the
  next iteration.

### Fixed
- **Bake post-v1.5.0 production fixes into source** —
  `GF_SERVER_DOMAIN: 'oscar.uic.org'` + hardcoded `GF_SERVER_ROOT_URL`,
  Grafana datasource `uid: prometheus`, nginx `proxy_pass http://127.0.0.1:3000;`
  (no trailing slash). These were patched on the production VPS during
  the v1.5.0 / v1.5.1 rollouts; baking them into source means
  `refresh-collection.sh` stops failing on a dirty working tree.

### Security
- **`/v1/auth/sso-check` rate-limited** 600/5min/IP (CodeQL
  `js/missing-rate-limiting`). Generous because nginx fires this on
  every proxied request to `/grafana/` or `/prometheus/`.

### Migration steps for existing deployments
After Watchtower rolls over to v1.6.0:
1. `git -C /opt/OSCAR pull` (now clean — the v1.5.1-era manual edits
   match what's in source)
2. Replace the OLD `location /grafana/` block in your nginx site config
   with the new 3-block snippet from
   `OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` (one `auth_request`
   helper + `/grafana/` + `/prometheus/`)
3. `sudo nginx -t && sudo systemctl reload nginx`
4. `sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d --force-recreate grafana prometheus`

The old `/etc/nginx/.htpasswd-grafana` file is no longer referenced —
leave it on disk (harmless) or `sudo rm` it.

---

## [server-v1.5.1] — 2026-05-10

### Fixed
- **`/metrics` scrape blocked in production (regression from v1.5.0).**
  PR #41 added the Prometheus endpoint, but the existing HTTPS-redirect
  middleware (PRs #7 / #23) intercepted Prometheus's plain-HTTP scrape
  from inside the Docker network — returning 400 Bad Request, or 301
  to a TLS port that doesn't exist depending on `ALLOWED_REDIRECT_HOSTS`.
  Both modes left the Grafana dashboard empty.
  Fix: skip the HTTPS-redirect middleware when `req.path === '/metrics'`.
  Endpoint is firewalled at the nginx layer for external requests
  (returns 404), so this exemption adds no security exposure.

  Operators who added `oscar` to `ALLOWED_REDIRECT_HOSTS` as a workaround
  can revert that change — no longer required. The standard
  `prometheus.yml` shipped in v1.5.0 works as-is.

---

## [server-v1.5.0] — 2026-05-09

Minor bump — new dependency (`prom-client`), new public-ish endpoint
(`/metrics`), new optional infrastructure components (Prometheus + Grafana).

### Added
- **Prometheus + Grafana integration (opt-in).** New
  `/metrics` endpoint on the server exposes Node.js process metrics
  (CPU, memory, GC, event-loop lag) plus OSCAR-specific counters:
  - `oscar_http_request_duration_seconds` (Histogram, by route + status)
  - `oscar_runs_total` (Counter, by terminal status)
  - `oscar_queue_depth` / `oscar_active_runs` (Gauges, refreshed every 5s)
  - `oscar_login_attempts_total` (Counter)
  - `oscar_smtp_send_total` (Counter)
- **Compose overlay `OSCAR_Deploy/docker-compose.metrics.yml`** — start
  Prometheus + Grafana with one extra `-f` flag, leave the existing
  `oscar` container untouched. Default deployments unaffected.
- **Auto-provisioned Grafana dashboard** ("OSCAR · Overview") with 10
  panels: live snapshots (active runs, queue depth, HTTP rate, P95
  latency), latency percentiles, status-code rate, run throughput,
  auth + SMTP rates, process memory, CPU + event-loop lag.
- **nginx snippet** (`OSCAR_Deploy/nginx/oscar-metrics.conf.snippet`)
  blocks external access to `/metrics` (returns 404) and reverse-proxies
  `/grafana/` with HTTP basic auth.
- **Operator guide**: `Documentation/Server_Operations/metrics-and-monitoring.md`
  covers architecture, one-time setup, day-to-day commands, resource
  budget (~270 MB RAM, ~550 MB disk over 15d), how to add a new metric,
  troubleshooting.

### Notes
- The `/metrics` endpoint is always-on at the app layer (no auth) but
  not externally reachable (nginx 404). Only the in-cluster Prometheus
  scrapes it.
- Grafana defaults to Anonymous Viewer mode internally, with HTTP basic
  auth at the nginx layer — operators see one auth prompt, not two.

---

## [server-v1.4.4] — 2026-05-09

### Fixed
- **Closes #34 UI gap.** Dashboard batch header rows now have a
  "select-all" checkbox. v1.4.3 unblocked the server-side permission
  for test_managers, but the dashboard still required users to expand
  every batch and tick each scenario individually before deletion —
  prohibitively tedious for batches with many scenarios. One click on
  the batch checkbox now selects all child scenarios at once. An
  indeterminate (gray dash) state appears when some children are
  selected. Applies to all roles that can delete (tester,
  test_manager, administrator).

---

## [server-v1.4.3] — 2026-05-09

### Fixed
- **Closes #34** — Test Manager can now soft-delete any run in their
  own company. Previously the soft-delete handlers
  (`POST /v1/runs/bulk-delete` and `DELETE /v1/runs/:id`) gated
  past-tenant ownership behind `role === 'administrator'`, so test
  managers were treated as regular testers and could only delete
  runs they personally started — even though they already had
  elevated privileges over user management and the privacy toggle.
  Tenant filter still enforces the company boundary; cross-company
  delete remains impossible. Bulk-admin-action (which includes
  irreversible `purge`) intentionally stays administrator-only.

---

## [server-v1.4.2] — 2026-05-09

### Security
- **Closes #17 third leak path** — `Bruno_Collection/library-bruno/reportGenerator.js`
  now redacts sensitive headers and auth-endpoint bodies before writing
  the per-scenario HTML report (`/artifacts/<runId>/report_<sc>.html`).
  Same shape as the redaction added in PR #21 (mergeReport.js) and PR
  #29 (structureResults.js). Three render paths now all consistent.
- **Migration v17** — retroactive scrub of historical `run_requests`
  rows. Re-applied here via PR #32 (was effectively missed by PR #29's
  squash-merge). Boot logs show
  `[db] migration v17 — scrubbed credentials from N of M run_requests rows`.

### Operations
- Old `report_*.html` files on disk are NOT auto-cleaned (filesystem,
  not DB; v17 scrub doesn't reach them). Optional one-time cleanup
  documented in PR #31.

---

## [server-v1.4.1] — 2026-05-09

### Security
- **Closes #17 server-side leak.** `structureResults.js` now redacts
  sensitive headers (`Authorization`, `Ocp-Apim-Subscription-Key`,
  `X-API-Key`, `Cookie`, etc.) and auth-endpoint request/response
  bodies BEFORE storing in `run_requests`. PR #21 had closed the same
  class of leak in the Bruno-side merged report — this PR closes the
  matching server-side path that fed the Report Builder UI.
- **Migration v17: retroactive scrub.** Walks every existing
  `run_requests` row and re-redacts in place using the same logic.
  Idempotent. Wraps per-row updates in a transaction so the scrub
  is atomic. Boot log shows
  `[db] migration v17 — scrubbed credentials from N of M run_requests rows`.

### Operations
- **Hands-off release deploy.** `refresh-collection.yml` now also fires
  on `compatibility.json` changes (was previously `Bruno_Collection/**`
  only). `promote-release.yml` SSHes the VPS after pushing `:stable`
  as defense in depth. Combined effect: the manual
  `ssh + git pull + restart` ritual after every release is gone —
  Watchtower's normal poll cycle handles container recreate, and the
  host file is fresh by the time it does.
- **Repo-level auto-merge enabled.** Future release PRs are armed with
  `gh pr merge --auto` so they merge as soon as CI is green; no more
  forgotten merge-button clicks.

---

## [server-v1.4.0] — 2026-05-08

Minor bump rather than patch — adds new public auth endpoints, two new
public HTML pages, and a DB schema migration.

### Added
- **Self-service password reset (closes #15).** Login page gets a
  "Forgot password?" link. Two new public pages (`/forgot-password.html`,
  `/reset-password.html`) backed by three new endpoints under
  `/v1/auth/password-reset/*` (request, check-token, confirm). 24h
  single-use UUID tokens, anti-enumeration generic-success on request,
  same password-strength rule as registration (12+ chars, upper/lower/
  digit). Schema migration v16 adds `password_reset_tokens` table.
- **Admin "Test SMTP Email" button (closes #14 diagnostic gap).** New
  card on the Server Config tab. Pre-filled with the admin's own
  email, rate-limited 6/5min/admin, returns the verbatim SMTP relay
  response inline so misconfigurations are diagnosable without SSH.
- **Admin escape hatch for password reset.** New "Reset Link" button on
  each user row in the admin Users tab → generates a self-service
  reset URL the admin can deliver out-of-band (Slack/Teams/in-person)
  when SMTP is broken. Audit-logged.

### Changed
- **All credential-bearing UI fields are now masked (#16 follow-up).**
  Token URL, Scope, Requestor Header, and Ocp-Apim-Subscription-Key
  switched from `type=text` (visible while typing) to `type=password`,
  matching the existing Bearer Token / Client ID / Client Secret /
  Extra Credential fields.
- **Hardened admin-panel `esc()` helper** to escape `"` and `'` in
  addition to `& < >`. Safe for both text content and attribute
  contexts. Closes a CodeQL `js/incomplete-html-attribute-sanitization`
  finding on the new "Reset Link" button and retroactively closes the
  same latent surface on Reset PWD / Delete buttons.

### Security
- **Rate limiting on password-reset token endpoints.** Both
  `/check-token` and `/confirm` now share a 30 / 15 min / IP limiter.
  Tokens are 122-bit UUIDs (brute-force infeasible on its merits) but
  the limit is defense in depth and closes the CodeQL
  `js/missing-rate-limiting` rule on auth endpoints.
- **Replaced hand-rolled email-format regex** in the admin test-email
  endpoint with `express-validator`'s `isEmail()` — same library used
  elsewhere in the codebase. Closes CodeQL `js/polynomial-redos`.

---

## [server-v1.3.4] — 2026-05-08

### Security
- **Sonar S5146 follow-up**: validate `req.url` is a safe local path
  before concatenating into the HTTPS-redirect `Location` header. The
  `Host:` allow-list shipped in 2026.10 covered the host source of the
  open redirect; SonarCloud's post-merge full scan then surfaced the
  remaining `req.url` taint flow. Now path must match
  `/^\/(?!\/)[^\\]*$/` (single leading `/`, no `//evil.com`, no
  backslashes) — anything else falls back to `/`.

---

## [server-v1.3.3] — 2026-05-08 + collection-OTST_V2.0.2

### Security
- **Closes #17 — credential redaction in Bruno reports.** `mergeReport.js`
  now strips sensitive header values (Authorization, Ocp-Apim-Subscription-Key,
  X-API-Key, Cookie, etc.) from request and response header maps, and
  redacts the entire request/response body for auth endpoints
  (`/token`, `/login`, `/oauth`, …) which carry `client_secret` /
  `access_token`. Anyone who downloaded a JSON report archive could
  previously read every tester's credentials in plain text.

### Fixed
- **Closes #16 — cannot reset API credentials.** PATCH
  `/v1/me/credentials` now accepts `null`/`""` to clear a credential
  field (previously silently ignored due to a truthy check). Profile UI
  gets a red 🗑 **Clear all credentials** button that wipes every
  credential field in one call. Recommended workflow at the end of a
  test campaign.

### Operations
- Bruno collection bumped to `OTST_V2.0.2` to record the redaction
  change in the Git tag history.

---

## [server-v1.3.2] — 2026-05-08

### Quality
- **Sonar S7783** — replace deprecated `String#trimRight()` with the
  standard `String#trimEnd()` in `report-builder.html:813`. One-character
  substitution, no behaviour change. CRITICAL code-smell count: 40 → 39.

### Operations
- **First release cut via the auto-tag-on-merge automation** (Layer 2).
  No manual `git tag … && git push origin …` step — tags created
  automatically by the OSCAR Release Bot GitHub App when this commit
  hits main.

---

## [server-v1.3.1] — 2026-05-08

### Security
- **Open-redirect guard (Sonar S5146)** — the HTTPS-enforcement middleware
  no longer echoes `req.headers.host` directly into the `Location:` header.
  New `ALLOWED_REDIRECT_HOSTS` env-var allow-list rejects forged Host
  headers with `400 Bad Request`. nginx already filters Host upstream in
  production, but this gives the app server its own guard for cases where
  the proxy is bypassed.

### Quality
- **Sonar BUG count: 8 → 0** — closed all S3403 (`=== 0 || === false`
  unreachable branch on SQLite booleans), S3923 (identical-branch ternary),
  and S2871 (sort without compare fn) issues.
- **Sonar BLOCKER code-smell count: 3 → 0** — auth-middleware tests now
  use explicit `expect()` assertions instead of the `done()` callback
  pattern (S2699).
- **3 Sonar S5696 XSS findings marked as False Positive** — every dynamic
  interpolation in the flagged `innerHTML` sites is already wrapped in
  the `esc()` helper; Sonar's heuristic fires regardless.

### Operations
- New `ALLOWED_REDIRECT_HOSTS` documented in `OSCAR_Deploy/.env.example`.

---

## [server-v1.3.0] — 2026-05-08

### Security
- **Spawn hardening (Sonar S4721)** — Bruno CLI `spawn()` now uses
  `shell: false` on Linux/macOS (production); shell only retained on
  Windows when launching `.cmd`/`.bat` shims. Args go straight to
  `execve()` as `argv[]`, eliminating metacharacter-injection surface.
- **Path-traversal guards** — central `safeJoinUuid` helper + inline
  UUID-regex guard alongside every fs call that takes `runId`
  (Sonar S6549). Test fixtures updated to valid UUIDs.
- **DOM-XSS hardening (Sonar S5247)** — `esc()` wrappers added to all
  remaining template-literal interpolations targeting `innerHTML`,
  including numeric-index and short-loop-var sites.
- **Dependency CVE remediation** — axios bumped to `^1.15.2` in *all
  three* Bruno-internal locations (top-level + `@usebruno/js` +
  `@usebruno/requests`), clearing 4 HIGH CVEs (CVE-2026-42033,
  -42035, -42043, -42264). `express-rate-limit` bumped to 8.5.1
  (ip-address XSS advisory).

### Privacy & user management
- **Per-company "Share reports with Certifier" toggle** — operators
  opt in/out per company; default off.
- **Test Manager user-management feature** — Test Managers can now
  invite, suspend, and reset passwords for users within their
  company without admin involvement.

### CI/CD pipeline
- **GHCR auto-publish + release-tag promotion** — `publish-image.yml`
  builds and pushes Docker images on merge to `main` and on
  `server-v*` tag.
- **Watchtower-based auto-deployment** — switched to `nickfedor/watchtower`
  (active fork) for automatic image rollover on the production VPS.
- **SAST + secret scanning suite** — CodeQL, SonarCloud, Gitleaks,
  Dependabot all wired in with required-status-check gating.
- **Branch protection** — main is protected; all changes flow through
  PR with 7 required green checks before merge.
- **PR ergonomics** — labeler, CODEOWNERS, PR/issue templates,
  SECURITY.md.
- **Workflow path-filter fix** — required-check workflows no longer
  use `paths:` filter on `pull_request` (was blocking PRs that
  didn't touch the filtered paths).

### Licensing
- LICENSE year aligned to 2026; Apache-2.0 headers added across all
  source files.

---

## [release-2026.07] — 2026-05-01

### Combined release
- Server **1.2.0** + collection **OTST_V2.0.1**
- First release to be deployed via the new auto-rollover pipeline

### Repository
- Reorganised into a UIC-owned monorepo (`Oscar_Server/`, `Bruno_Collection/`,
  `OSCAR_Deploy/`, `Documentation/`, root `compatibility.json`)
- Single source of truth for server, collection, deploy manifests, and docs

### Docker
- Multi-stage Dockerfile: builder (with bcrypt native deps) → runtime
  (no npm, ~250 MB)
- `npm install -g @usebruno/cli` moved to runtime stage so the symlink for
  `bru` resolves correctly; npm + corepack stripped in the same `RUN` for
  CVE-2026-33671 (picomatch ReDoS) remediation
- `package.json` copied into runtime so `src/api/openapi.js` can read the
  version field

### Versioning
- `Bruno_Collection/VERSION` (single line) — e.g. `OTST_V2.0.1`
- `compatibility.json` at repo root — server↔collection tested-together matrix
- `src/utils/versionInfo.js` — boot-time check, single-line warning if combo
  not in matrix; non-blocking
- `/health` enriched with `server_version`, `collection_version`,
  `release_label`, `compatibility_status`
- Top banner UI: monospace version chip showing release/server/collection,
  color-coded by `compatibility_status` (green/amber/red/gray), 5-min
  localStorage cache, hover tooltip
- Annotated Git tags: `server-v1.2.0`, `collection-OTST_V2.0.1`,
  `release-2026.04` … `release-2026.07`

### CI/CD
- `.github/workflows/ci-server.yml` — path-scoped to `Oscar_Server/**`,
  lint + audit + tests with coverage gate (50% lines / 42% branches) +
  docker build + Trivy scan
- `.github/workflows/ci-collection.yml` — Bruno CLI sanity check, VERSION
  presence enforcement, `.bru` meta-block lint
- `.github/workflows/publish-image.yml` — every server-touching push to
  `main` builds + pushes `ghcr.io/top-phe/oscar-server:edge` and `:sha-XXX`;
  `server-v*` tag pushes also push `:server-vX.Y.Z`
- `.github/workflows/promote-release.yml` — `release-YYYY.MM` tag pushes
  rebuild and push the image as `:stable` and `:release-YYYY.MM` (the only
  workflow that touches `:stable`)
- `.github/workflows/refresh-collection.yml` — collection-only commits
  SSH into the VPS and trigger a pinned `git pull` script

### Production deploy
- Migrated `/opt/OSCAR-OSdm-Compliance-Automation-Runner/` → `/opt/OSCAR/`
  monorepo layout in place; SQLite DB and artifacts preserved
- `OSCAR_Deploy/docker-compose.yml` — uses `image:`-based deploy from GHCR
  with `:stable`; collection and `compatibility.json` bind-mounted read-only
- Watchtower added (`nickfedor/watchtower`, the maintained fork — original
  `containrrr/watchtower` is dead and breaks on Docker 25+ API)
  - Polls every 5 minutes
  - Watches only labelled containers (just `oscar`)
  - Pulls + recreates `oscar` when `:stable` digest changes
- SSH deploy key locked down via `command="…/refresh-collection.sh"` in
  `~ubuntu/.ssh/authorized_keys` — even if the key leaks, the worst it can
  do is force a `git pull`
- `refresh-collection.sh` — refuses to pull if working tree is dirty,
  logs every transition to `journalctl -t oscar-deploy`

### Documentation
- `Documentation/Server_Operations/installation-guide.md` — full VPS
  install procedure for the monorepo layout (Ubuntu 24.04, Docker, nginx,
  Let's Encrypt, smoke test against `/health`)
- `Documentation/Server_Operations/auto-deploy-setup.md` — one-time VPS
  setup for GHCR pull, SSH key, GitHub secrets, switching from `build:` to
  `image:`, daily-life recipes, rollback procedure
- `Documentation/Server_Operations/monorepo-and-autodeploy-transformation.md`
  — single document narrating the entire two-day transformation, decisions
  taken, gotchas captured, inventory of artifacts
- Three doc folders by audience: `Documentation/{Oscar_Server,Bruno_Collection,Server_Operations}/`

---

## [1.2.0] — 2026-04-27

### Added — Phase 1 + 2 Audit Implementation
- **JWT secret persisted in `server_config` DB table** — sessions now survive server restarts. New `POST /v1/admin/rotate-jwt-secret` endpoint to invalidate all sessions on demand.
- **Admin Server Config UI** at `/admin.html?tab=config` — runtime-editable settings (concurrent runs, timeouts, SMTP, log level) with no restart required.
- **`LOG_LEVEL` runtime control** — admins can switch between `error/warn/info/debug/trace` from the UI; takes effect immediately.
- **Structured logging via pino** — JSON in production, pretty-printed in dev, automatic redaction of secrets.
- **Enhanced `/health` endpoint** — checks DB connectivity, queue, data dir writability, disk space, memory; returns 503 when degraded.
- **Rate limiting on `POST /v1/runs`** — 30 batches/hour/user, IPv6-safe key generator.
- **Stream backpressure on Bruno output** — caps log events to 50,000/run to prevent OOM/DB bloat.
- **HTTPS enforcement middleware** — production redirects HTTP→HTTPS, honors `X-Forwarded-Proto`.
- **Async I/O in worker** — `createWorkspace`/`cleanupWorkspace` use `fs.promises` to avoid EventLoop blocking.
- **ESLint configuration** — `npm run lint` / `npm run lint:fix`; main branch is 0 errors / 0 warnings.

### Changed
- **Docker container runs as non-root** (`node` user, UID 1000) for security.
- **PowerShell user management script** — passwords no longer hardcoded; prompted at runtime via `Read-Host -AsSecureString`.
- **Admin password creation/reset** now requires 12+ chars with complexity (was 8 chars, no complexity) — aligned with self-registration policy.
- **Pinned dependency versions** (`~` instead of `^`) to prevent surprise minor-version breakage.

### Security
- **S1**: Subprocess env var leakage fixed (whitelist instead of `...process.env`).
- **S5**: OAuth2 error response body no longer logged (could echo client secrets).
- **S6**: Scenario code sanitized with character whitelist (path traversal hardening).
- **S8**: OAuth2 fetch has 15-second `AbortController` timeout.
- **S9**: `app.set('trust proxy', 1)` for accurate client IP behind reverse proxy.

### Fixed — Concurrent runs safety (E13/E14/E15)
- Env file name now per-run (`OTST_{slug}_{runIdShort}_Env`) — prevents collision under `MAX_CONCURRENT_RUNS > 1`.
- `.bru_results.json` written to per-run path (`.bru_results_{runIdShort}.json`).
- Report scanning prefix now unique per run (automatic from env name change).

---

## [1.1.0] — 2026-04 (Concurrent Sessions release)

### Added
- **Parallel scenario execution** — each scenario runs as its own job, controlled by `MAX_CONCURRENT_RUNS` (server-wide) and `concurrentSessionLimit` (per-company).
- **Workspace isolation on Linux** — each parallel run gets its own copy of the Bruno collection.
- **Test Manager role** — shared scenarios, batch run management.
- **Live queue panel** in the New Run UI.
- Sequential vs parallel choice removed — parallel is now the default (and only) mode.

---

## [1.0.0] — 2026-03 (Initial production release)

### Added
- Multi-tenant company management with isolated testers.
- OAuth2 client_credentials and Bearer token auth modes.
- Self-service registration with email verification (24h token).
- Bruno CLI worker with real-time event streaming to DB.
- HTML and JSON report generation with run comparison.
- Admin UI for user/company/activity management.
- Soft-delete workflow (`DELETION_REQUESTED` → `DELETED_BY_ADMIN` → `DELETED`) with restore capability.
- AES-256-GCM encryption for company secrets at rest.
