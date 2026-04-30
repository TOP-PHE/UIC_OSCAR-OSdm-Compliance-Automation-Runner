# OSCAR Server — Code Audit Report

**Date:** 2026-04-11
**Scope:** Full codebase audit — security, code quality, documentation, structural consistency
**Version audited:** Commit `c04a821` on branch `claude/wizardly-haslett`

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer)

"This material is copyrighted by UIC, Union Internationale des Chemins de fer (c) 2026 OSDM is a trademark belonging to UIC, and any use of this trademark is strictly prohibited unless otherwise agreed by UIC."

---

## Executive Summary

The OSCAR server is a well-architected Node.js/Express application with solid security foundations and a clean backend structure. The codebase has undergone rapid feature iteration, resulting in some technical debt primarily in the frontend layer. This audit identifies actionable findings across four dimensions and recommends a phased remediation plan.

| Dimension | Verdict | Details |
|-----------|---------|---------|
| **Security** | Production-ready with 3 fixes | Strong crypto, parameterized queries, tenant isolation. 1 critical + 2 medium items to address |
| **Code quality** | Backend solid, frontend needs refactoring | Clean backend architecture; `scenarios.html` at 189KB is the main concern |
| **Documentation** | Backend good, frontend gaps | Excellent backend comments; missing frontend state/event documentation |
| **Structural consistency** | Good with iteration debt | Consistent patterns across routes; some code duplication from rapid iteration |

---

## 1. Security Audit

### 1.1 Strengths

The following security measures are correctly implemented:

| Control | Implementation | Status |
|---------|---------------|--------|
| Encryption at rest | AES-256-GCM with random 12-byte IV, auth tag verified | Correct |
| SQL injection prevention | All queries use parameterized statements (`db.prepare()` with `?` placeholders) | Correct |
| Password hashing | bcrypt with 12 rounds | Correct |
| JWT security | HS256 algorithm pinning, ephemeral secret, 8h expiry | Correct |
| HTTP security headers | Helmet with strict CSP, HSTS (1 year), X-Frame-Options, X-Content-Type-Options | Correct |
| CORS | Configurable origin whitelist via `ALLOWED_ORIGINS` env var | Correct |
| Rate limiting | 20 requests per 15 minutes on login/register/bootstrap | Correct |
| Tenant isolation | `enforceTenant` middleware on all routes, company existence validated | Correct |
| Path traversal protection | Artifact download validates path against `ARTIFACTS_DIR` | Correct |
| Credential file handling | Restricted permissions (0o600), 3-attempt deletion retry | Correct |
| Email enumeration prevention | Generic response on duplicate registration | Correct |
| Error detail suppression | Generic 500 response, stack traces logged server-side only | Correct |
| Audit logging | Credential changes, user management, datafile operations logged | Correct |

### 1.2 Findings

#### CRITICAL: ENCRYPTION_KEY exposed to child process

**File:** `src/worker/runner.js:216`
**Issue:** The entire `process.env` (including `ENCRYPTION_KEY`) is passed to the Bruno CLI child process via `env: { ...process.env }`. If the Bruno process crashes, is debugged, or produces a core dump, the encryption key is exposed.
**Fix:** Pass only necessary environment variables:
```javascript
env: {
  PATH: process.env.PATH,
  NODE_ENV: process.env.NODE_ENV,
  APPDATA: process.env.APPDATA  // needed for bru.cmd on Windows
}
```
**Risk:** Key compromise would allow decryption of all stored credentials.

#### MEDIUM: No rate limiting on run submission and file upload

**Files:** `src/api/routes/runs.js:67`, `src/api/routes/company.js:176`
**Issue:** A user could submit unlimited runs (exhausting the queue and server resources) or upload datafiles repeatedly (5 MB each).
**Fix:** Add rate limiting:
- Run submission: 10 per hour per user
- File upload: 20 per hour per user

#### MEDIUM: Inconsistent password policy

**Files:** `src/api/routes/admin.js:99` (8 chars), `src/api/routes/auth.js:173` (12 chars)
**Issue:** Admin-created users require only 8 characters; self-registered users require 12 characters with complexity rules.
**Fix:** Align admin user creation to the same 12-character policy with uppercase, lowercase, and digit requirements.

#### MEDIUM: CSP allows unsafe-inline for script-src

**File:** `src/server.js:59`
**Issue:** `script-src 'self' 'unsafe-inline'` is required because all HTML pages use inline `<script>` blocks. This weakens XSS protection.
**Mitigation:** `script-src-attr 'none'` blocks inline event handler attributes (all pages refactored to use `addEventListener`). Full fix requires migrating inline `<script>` blocks to external `.js` files with nonce-based CSP.
**Status:** Acceptable for current deployment; tracked as future improvement.

#### MEDIUM: Race condition in ephemeral env file

**File:** `src/worker/runner.js:171`
**Issue:** The env file path is `environments/OTST_{slug}_Env.yml`. If two runs for the same company execute concurrently, the second write overwrites the first.
**Mitigation:** `MAX_CONCURRENT_RUNS=1` prevents concurrent execution. If concurrency is increased in the future, use `{runId}_{envName}.yml` for uniqueness.
**Status:** Not exploitable with current queue configuration.

#### LOW: OAuth2 error response logged

**File:** `src/worker/runner.js:59`
**Issue:** OAuth2 token endpoint error responses (up to 200 chars) are included in error messages, which may contain sensitive information.
**Fix:** Log only the HTTP status code, not the response body.

#### INFO: No token revocation mechanism

**Issue:** Once a JWT is issued, it is valid for 8 hours. If a user's account is compromised, the token cannot be revoked mid-session.
**Mitigation:** The ephemeral JWT secret (regenerated on server restart) invalidates all sessions on restart. For immediate revocation, implement a token blacklist.
**Status:** Acceptable for current deployment scale.

---

## 2. Code Quality Audit

### 2.1 Backend — GOOD

The backend is well-structured with clear separation of concerns:

```
src/
  api/
    routes/       5 route files, each focused on a domain
    middleware/    2 files (auth, tenant)
  db/             Connection, schema, encryption helpers
  worker/         Queue and runner (async job execution)
  reports/        Diff engine for run comparison
  utils/          Email utility
```

**Positive observations:**
- Single-responsibility principle followed throughout
- Consistent error response format `{status, title, detail}` across all routes
- Consistent naming: camelCase (JS), snake_case (DB), kebab-case (API), UPPER_SNAKE_CASE (env)
- No dead code or unused dependencies found
- Database queries use shared helper functions (`all`, `get`, `run`, `transaction`)

### 2.2 Frontend — NEEDS REFACTORING

#### HIGH: scenarios.html is a 189KB monolith

**File:** `public/scenarios.html` — 3,664 lines
**Breakdown:**
- Lines 1-800: Inline `<style>` block (CSS)
- Lines 801-900: HTML structure
- Lines 901-3664: Inline `<script>` block (wizard, scenario editor, resource manager, event delegation)

**Impact:**
- Difficult to navigate and debug
- Browser must parse and compile 2,500 lines of JS on page load
- Adding a feature requires editing a single monolithic file
- No code splitting or lazy loading

**Recommended structure:**
```
public/
  css/
    common.css          (shared styles: buttons, cards, badges, modals)
    scenarios.css       (scenario-specific styles)
  js/
    auth-guard.js       (shared auth check + localStorage validation)
    wizard.js           (config wizard steps)
    scenario-editor.js  (add/edit/delete scenarios)
    resource-editor.js  (train resource management)
    api-client.js       (API communication helpers)
  scenarios.html        (HTML structure only, loads external CSS/JS)
```

#### MEDIUM: CSS and JS duplication across HTML files

All 10 HTML files duplicate:
- Button/card/badge CSS styles (~50-200 lines per file)
- Auth check code (`localStorage.getItem('oscar_token')`)
- Logout function (`function logout() { localStorage.clear(); ... }`)
- Header/footer HTML structure

**Fix:** Extract to `common.css`, `auth-guard.js`, and use shared HTML includes or a lightweight template system.

### 2.3 Code Duplication — MEDIUM

| Duplicated code | Files | Lines | Fix |
|-----------------|-------|-------|-----|
| `ensurePlatformCompany()` | auth.js:63-70, admin.js:40-51 | identical | Extract to `src/db/companies.js` |
| `resolveCompanyScope()` pattern | company.js:77-88, similar in runs.js, reports.js | similar | Extract to shared middleware |
| Auto-cancel stale run logic | runs.js (3 occurrences) | 6 lines x3 | Extract `autoCancelStaleRun()` helper |
| Password validation | auth.js (2x), admin.js (1x, different!) | 4 lines x3 | Create shared `validatePassword()` |

### 2.4 Error Handling Gaps

| Issue | File:Line | Severity |
|-------|-----------|----------|
| No try-catch on `fs.writeFileSync` for datafile save | company.js:258 | HIGH |
| OAuth2 `res.json()` can throw if response is not JSON | runner.js:62 | HIGH |
| `fs.unlinkSync` blocks event loop in request handler | company.js:292 | MEDIUM |
| Silent catch blocks hide audit/logging failures | multiple files | MEDIUM |
| Queue error handler assumes `err.message` exists | queue.js:50 | MEDIUM |

### 2.5 Database Concerns

#### Missing Indexes

The following queries perform full table scans and will degrade as data grows:

| Query pattern | File | Missing index |
|---------------|------|---------------|
| `WHERE email = ?` | auth.js:126 | `CREATE INDEX idx_users_email ON users(email)` |
| `WHERE slug = ?` | auth.js:197 | `CREATE INDEX idx_companies_slug ON companies(slug)` |
| `WHERE company_id = ? AND status NOT IN (...)` | runs.js:149 | `CREATE INDEX idx_runs_company_status ON runs(company_id, status)` |
| `WHERE user_id = ?` | admin.js:261 | `CREATE INDEX idx_runs_user_id ON runs(user_id)` |
| `WHERE company_id = ?` | reports.js:113 | `CREATE INDEX idx_comparisons_company ON report_comparisons(company_id)` |

#### N+1 Subquery

**File:** `src/api/routes/runs.js:127`
The run listing uses a correlated subquery `(SELECT COUNT(*) FROM run_artifacts WHERE run_id = r.id)` for every row. With 10,000 runs, this executes 10,000 additional queries.

**Fix:** Replace with `LEFT JOIN run_artifacts ra ON ra.run_id = r.id ... GROUP BY r.id`.

#### Migration Strategy

**File:** `src/db/db.js:29-42`
Migrations are applied as `ALTER TABLE` statements in a try-catch loop. There is no tracking of which migrations have been applied, no rollback capability, and no migration history.

**Fix:** Implement a `schema_migrations` table tracking applied version numbers.

---

## 3. Documentation Audit

### 3.1 Ratings by Area

| Area | Rating | Notes |
|------|--------|-------|
| Backend file headers | GOOD | All 13 .js files have clear JSDoc headers listing endpoints and purpose |
| Backend inline comments | GOOD | Excellent "why" comments explaining security decisions, edge cases, and OSDM spec requirements |
| Frontend file headers | MISSING | `scenarios.html` (3,664 lines) has no header comment |
| Frontend inline comments | NEEDS IMPROVEMENT | Event delegation system and state management undocumented |
| `.env.example` | GOOD | Clear sections with generation instructions |
| API route documentation | ADEQUATE | Endpoints listed in JSDoc headers; request/response schemas not formally documented |
| Architecture documentation | GOOD but OUTDATED | References PostgreSQL, Redis, and S3 which are not used in current implementation (SQLite, in-memory queue, local filesystem) |
| Security documentation | EXCELLENT | Section 9 of the specification covers all 15 security controls |

### 3.2 Documentation Gaps

#### Missing Documentation

1. **Database schema diagram** — No ER diagram or schema reference document. Developers must read `schema.sql` directly.

2. **Frontend state management** — `scenarios.html` uses global objects (`state`, `wizData`, `wizProfile`, `wizScenario`) with no documentation of their structure, lifecycle, or persistence model.

3. **Event delegation patterns** — The refactored frontend uses `data-action` attributes with centralized event delegation. No documentation explains what actions exist, what elements they target, or how to add new ones.

4. **Scenario code grammar** — Codes like `OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG` follow a structured grammar (type, action, trip mode, passenger count, leg count) that is not documented anywhere.

5. **Bruno integration guide** — How the runner generates `.yml` files, what `.bru_results.json` format is expected, and how to add new Bruno test requests — all implicit in `runner.js` code.

6. **API request/response schemas** — No Swagger/OpenAPI specification. Developers must infer request body fields and response formats from route code.

#### Stale Documentation

The architecture document (`OSCAR - Solution Architecture.md`) references technologies not used in the current implementation:

| Document says | Code uses | Impact |
|---------------|-----------|--------|
| PostgreSQL | SQLite (`node:sqlite`) | Schema syntax differs |
| Redis queue | In-memory FIFO queue (`EventEmitter`) | No external dependency needed |
| S3 object storage | Local filesystem (`data/artifacts/`) | No cloud setup needed |
| Kubernetes deployment | PM2 on VPS | Different scaling model |

**Recommendation:** Update architecture docs with a "Current Implementation" section noting the MVP uses SQLite/in-memory/local fs, with the documented architecture as the target for scaling.

---

## 4. Structural Consistency Audit

### 4.1 What's Consistent (GOOD)

- **Route handler pattern:** All routes follow `router.method(path, (req, res) => { validate → query → respond })`.
- **Authentication flow:** All protected routes use `requireAuth, enforceTenant` middleware chain.
- **Error responses:** All errors return `{status, title, detail}` format (RFC 9457-inspired).
- **Database access:** All code uses the same `all()`, `get()`, `run()`, `transaction()` helpers from `db.js`.
- **Worker architecture:** Queue and runner are cleanly separated with EventEmitter events.
- **Encryption:** All sensitive fields use the same `encrypt()`/`decrypt()` functions.

### 4.2 Iteration Debt

The following inconsistencies result from rapid feature iteration:

| Area | Issue | Impact |
|------|-------|--------|
| Password policy | 8 chars for admin-created users, 12 for self-registered | Security inconsistency |
| Company scope resolution | 3 slightly different implementations across route files | Maintenance burden |
| Stale auto-cancel logic | Same 6-line pattern copied 3 times in runs.js | Bug risk if behavior changes |
| Frontend auth check | Each HTML file implements its own token validation | 10 files to update if logic changes |
| CSS styles | Each HTML file has its own `<style>` block with shared classes | Visual inconsistency risk |
| `ensurePlatformCompany()` | Identical function in 2 files | Can diverge during maintenance |

### 4.3 Architecture Alignment

The current implementation correctly follows the documented architecture in spirit, but at a different scale:

| Architecture layer | Documented | Implemented | Aligned? |
|-------------------|------------|-------------|----------|
| Frontend (UI) | SPA with framework | Vanilla HTML/JS | Yes (MVP) |
| API Gateway | Express with middleware | Express with middleware | Yes |
| Authentication | JWT + roles | JWT + roles (HS256, ephemeral) | Yes |
| Execution worker | Queue + spawned process | In-memory FIFO + child_process | Yes (MVP) |
| Storage | PostgreSQL + S3 | SQLite + local filesystem | Partial (MVP) |
| Encryption | AES-256-GCM | AES-256-GCM | Yes |
| Tenant isolation | Company-scoped queries | Company-scoped queries | Yes |

---

## 5. Remediation Plan

### Phase 1 — Must do before production (1-2 days)

| # | Priority | Action | Files |
|---|----------|--------|-------|
| 1 | CRITICAL | Stop passing `ENCRYPTION_KEY` to Bruno child process | `runner.js:216` |
| 2 | HIGH | Align admin password policy to 12 chars + complexity | `admin.js:99` |
| 3 | HIGH | Add rate limiting to run submission (10/hr) and file upload (20/hr) | `runs.js`, `company.js` |
| 4 | HIGH | Add try-catch to datafile write operation | `company.js:258` |
| 5 | HIGH | Add missing database indexes (email, slug, company_id, user_id) | `schema.sql` |

### Phase 2 — Should do for maintainability (1 week)

| # | Priority | Action | Files |
|---|----------|--------|-------|
| 6 | MEDIUM | Extract duplicated code (ensurePlatformCompany, auto-cancel, resolveCompanyScope) | `auth.js`, `admin.js`, `runs.js` |
| 7 | MEDIUM | Create `common.css` and `auth-guard.js` for frontend | `public/` |
| 8 | MEDIUM | Update architecture docs to reflect current implementation | `oscar_dev_docs/` |
| 9 | MEDIUM | Add proper migration version tracking | `db.js` |
| 10 | MEDIUM | Replace synchronous fs operations with async versions | `company.js` |

### Phase 3 — Recommended improvements (future sprint)

| # | Priority | Action | Files |
|---|----------|--------|-------|
| 11 | MEDIUM | Split `scenarios.html` into modular CSS/JS files | `public/` |
| 12 | MEDIUM | Create database schema documentation (ER diagram) | `oscar_dev_docs/` |
| 13 | LOW | Generate Swagger/OpenAPI spec from routes | `oscar_dev_docs/` |
| 14 | LOW | Document event delegation patterns and frontend state | `oscar_dev_docs/` |
| 15 | LOW | Add pagination to unbounded admin queries | `admin.js` |
| 16 | LOW | Implement token revocation mechanism | `auth.js`, `middleware/auth.js` |

---

## Appendix A: Files Reviewed

### Backend (13 files)
- `src/server.js` — Express application entry point
- `src/db/db.js` — Database connection, encryption, query helpers
- `src/db/schema.sql` — Table definitions and indexes
- `src/worker/runner.js` — Bruno CLI execution engine
- `src/worker/queue.js` — In-process job queue
- `src/reports/diff.js` — Run comparison engine
- `src/api/routes/auth.js` — Authentication endpoints
- `src/api/routes/company.js` — Company profile management
- `src/api/routes/runs.js` — Run management
- `src/api/routes/reports.js` — Report comparison endpoints
- `src/api/routes/admin.js` — Administrator endpoints
- `src/api/middleware/auth.js` — JWT validation middleware
- `src/api/middleware/tenant.js` — Tenant isolation middleware

### Frontend (11 files)
- `public/index.html` — Login page
- `public/welcome.html` — News and onboarding
- `public/verify-email.html` — Email verification
- `public/profile.html` — Company API configuration
- `public/scenarios.html` — Test configuration wizard (189KB)
- `public/run.html` — Run launch page
- `public/run-detail.html` — Execution logs and artifacts
- `public/dashboard.html` — Run list and management
- `public/compare.html` — Run comparison viewer
- `public/admin.html` — User and company administration
- `public/nav.js` — Shared navigation component

### Documentation (4 files)
- `oscar_dev_docs/OSCAR - Solution Architecture.md`
- `oscar_dev_docs/OSCAR - Specification.md`
- `oscar_dev_docs/OSCAR - Server Admin Guide.md`
- `oscar_dev_docs/OSCAR - VPS Deployment Guide.md`

### Configuration
- `package.json` — 10 dependencies, all current
- `.env.example` — Well-documented environment template
- `SECURITY_FIXES.md` — Security hardening changelog
