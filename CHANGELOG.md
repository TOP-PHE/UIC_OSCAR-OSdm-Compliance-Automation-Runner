# Changelog

All notable changes to OSCAR (OSDM Conformance Automation Runner) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- (next cycle)

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
