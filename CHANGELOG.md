# Changelog

All notable changes to OSCAR (OSDM Conformance Automation Runner) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- (Phase 3 in progress)

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
