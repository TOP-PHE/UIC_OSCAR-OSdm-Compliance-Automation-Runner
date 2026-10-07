# OSCAR — OSDM Conformance Automation Runner Specification

## License and Copyright
This document is the property of  UIC (Union Internationale des Chemins de fer) 

"This material is copyrighted by UIC, Union Internationale des Chemins de fer © 2026  OSDM is a trademark belonging to UIC, and any use of this trademark is strictly prohibited unless otherwise agreed by UIC."

For further inquiries, please contact UIC.:

## 1. Purpose
OSCAR (OSDM Conformance Automation Runner) is a cloud-based execution platform for OTST/Bruno scenarios that allows authorized users to run OSDM conformance tests against their own API endpoints in a simple, guided workflow.

The objective is to provide a secure and repeatable way to:
- Register and manage test accounts.
- Submit test run requests with endpoint and credentials.
- Execute Bruno-based scenarios in cloud isolation.
- Store and retrieve run results and reports.
- Confirm whether the report file has been updated between runs.

## 2. High-Level Architecture Overview
OSCAR is composed of five logical layers:

1. Web Portal (UI)
- Account registration and login.
- Scenario Run Request page (endpoint, token, requestor, data file upload, Run action).
- Results page (status, logs, downloadable artifacts, report update indicator).

2. API and Orchestration Service
- Exposes REST endpoints for authentication, run submission, status, logs, and artifact retrieval.
- Validates requests and enforces access control by company/tenant.
- Persists run metadata and dispatches execution jobs to the queue.

3. Execution Worker (Bruno Runner)
- Pulls queued jobs.
- Creates an isolated runtime (container) per run.
- Injects runtime variables (endpoint, token, requestor, data file).
- Executes OTST Bruno collections.
- Captures logs and generated reports.

4. Data and Storage Layer
- Relational database stores users, organizations, runs, and execution states.
- Object storage stores uploaded data files and generated reports.
- Queue service enables asynchronous, scalable run processing.

5. Security and Governance Layer
- Token and secrets encryption at rest.
- Secrets masking in logs.
- Per-tenant data isolation.
- Audit trail for all run actions.

## 3. Functional Flow
1. User creates account (username, password, company name, contact points).
2. User signs in to access Scenario Run Request page.
3. User submits endpoint, token, requestor field, and data file.
4. Backend creates a run record and enqueues a worker job.
5. Worker executes Bruno scenarios in cloud isolation.
6. Results and artifacts are stored and linked to the run.
7. Results page displays status, logs, artifacts, and report update state.

## 4. Report Update Tracking
OSCAR store each run outcome in its database, tracking the company, user, endpoint tested.
OSCAR provie a capabilty for a user of a dedicated company, to have the visibility on all tests done by users of this company

The page provide the list of reports.
The user can click on 2 reports and click on a buttom compare.
The outcome is a page listing the differences between both report what failed and is now OK and vise versa.
It als highlight added of suppresed scenarios.

## 5. Non-Functional Requirements
- Reliability: idempotent run submission and retry-safe worker execution. **Container-level health checks + autoheal sidecar** (since v1.8) restart any unhealthy OSCAR container automatically.
- Scalability: horizontal worker scale based on queue depth.
- Security: TLS everywhere, strict secret handling, role-based access. **Credentials redacted from persisted run artefacts** (since v1.6 — issue #17 retroactive scrub migration covers historical rows). **Self-service password reset** with single-use 24 h tokens (since v1.6).
- Observability: structured logs, run traces, health probes, metrics. **Prometheus + Grafana + Loki** observability overlay (opt-in since v1.5/v1.7). **Alertmanager-based email alerting to admins** for service-down / restart-loop / queue-stuck / failure-spike / SMTP-degraded / login-attack-burst (since v1.8).
- Portability: containerized components deployable on major cloud providers.

## 6. Suggested Minimal Deployment
A practical starting setup:
- Frontend service (web app).
- Backend API service.
- Worker service.
- PostgreSQL database.
- Redis or managed queue.
- Object storage bucket.

This baseline enables fast delivery and can later evolve to managed cloud services for higher scale and resilience.

## 7. Future Extensions
- Multi-scenario templates per operator profile.
- Scheduled runs and recurring compliance checks.
- Notification integrations (email, Teams, Slack).
- Trend dashboards for conformance over time.
- Signed report export and long-term retention policies.

---

## 8. API Endpoints — Run Management

### Submit a run
```
POST /v1/runs
```
Creates a run record with status `QUEUED` and enqueues it for execution. Returns HTTP 202 with the run row. Company configuration (API endpoint, token, data file) is validated at submission time.

### List runs
```
GET /v1/runs?limit=50&offset=0
```
Returns a paginated list of runs. Platform roles (`administrator`, `certification_user`) see runs across all companies when no company context is set. Regular users see only their company's runs. Runs with `status = 'DELETED'` are excluded.

### Run detail
```
GET /v1/runs/:id
```
Returns the full run record including `status`, `exit_code`, `error_message`, and timestamps.

### Run logs
```
GET /v1/runs/:id/logs?since_id=0
```
Returns up to 500 `run_events` rows newer than `since_id`. The UI polls this endpoint to show a live log stream.

### Run artifacts
```
GET /v1/runs/:id/artifacts
GET /v1/runs/:id/artifacts/:aid
```
Lists or downloads artifacts (HTML reports, JSON results) linked to a run.

### Cancel a queued run
```
DELETE /v1/runs/:id/cancel
```
Cancels a run whose status is `QUEUED` (not yet started). Returns 409 if the run is already running or completed. Role `certification_user` cannot cancel runs.

### Soft-delete a single run
```
DELETE /v1/runs/:id
```
Marks a run as `DELETED` (soft-delete). The run is hidden from all list and detail queries but remains in the database for audit purposes. Also removes any linked `report_comparisons` rows atomically (SQLite `transaction`).

Constraints:
- Active runs (`QUEUED` or `RUNNING`) cannot be deleted — cancel first.
- Role `company_user` can only delete their own runs.
- Role `certification_user` cannot delete runs.

### Bulk soft-delete
```
POST /v1/runs/bulk-delete
Body: { "run_ids": ["uuid1", "uuid2", ...] }
```
Deletes up to 50 runs in a single atomic transaction. Returns:
```json
{
  "deleted": ["uuid1"],
  "skipped": [{ "id": "uuid2", "reason": "Run is RUNNING — cancel it first" }],
  "not_found": ["uuid3"],
  "new_status": "DELETION_REQUESTED" | "DELETED_BY_ADMIN"
}
```
The `new_status` field indicates the deletion status applied: `DELETION_REQUESTED` for tester-initiated deletions, `DELETED_BY_ADMIN` for administrator-initiated deletions.

### Bulk Admin Actions
```
POST /v1/runs/bulk-admin-action
```
Requires role: `administrator`

Body:
```json
{
  "action": "soft_delete" | "confirm_delete" | "purge" | "restore",
  "run_ids": ["uuid1", "uuid2", ...]
}
```

Actions:
- `soft_delete`: marks runs as `DELETED_BY_ADMIN` (visible to tester as flagged)
- `confirm_delete`: converts `DELETION_REQUESTED` to `DELETED` (permanent)
- `purge`: directly marks runs as `DELETED` (permanent)
- `restore`: reverses deletion, restoring run to `previous_status`

Max 50 runs per request.

Response:
```json
{
  "action": "soft_delete",
  "processed": [{ "id": "uuid", "new_status": "DELETED_BY_ADMIN" }],
  "skipped": [{ "id": "uuid", "reason": "..." }],
  "not_found": ["uuid"]
}
```

### Run Deletion Lifecycle

Runs follow a multi-status deletion workflow:

| Status | Visible to Tester | Visible to Admin | Description |
|--------|:-:|:-:|---|
| `DELETION_REQUESTED` | No | Yes | Tester soft-deleted; pending admin review |
| `DELETED_BY_ADMIN` | Yes (flagged) | Yes | Admin soft-deleted; tester notified |
| `DELETED` | No | No | Permanently deleted |

State transitions:
- Tester delete → `DELETION_REQUESTED`
- Admin delete → `DELETED_BY_ADMIN`
- Admin confirm/purge → `DELETED` (permanent)
- Admin restore → `previous_status` (reverses deletion)

---

## 8a. API Endpoints — Admin Management

### Admin User Management (administrator only)
```
GET    /v1/admin/users              — list users (optional ?q= search)
POST   /v1/admin/users              — create user (email, password, role, company_id)
PATCH  /v1/admin/users/:id          — update role/company/email
POST   /v1/admin/users/:id/reset-password — reset password (min 12 chars, complexity required)
DELETE /v1/admin/users/:id          — delete user and associated data
```

### Admin Company Management (administrator only)
```
GET    /v1/admin/companies           — list all companies with user counts
POST   /v1/admin/companies           — create company (name, slug)
PATCH  /v1/admin/companies/:id       — update name/slug
DELETE /v1/admin/companies/:id       — delete company (must have 0 users)
```

### Admin Server Config (administrator only)
```
GET    /v1/admin/config              — current config + server info
PATCH  /v1/admin/config              — update runtime settings (MAX_CONCURRENT_RUNS, etc.)
```

### Admin Activity Dashboard
```
GET    /v1/admin/activity            — totals, run distribution, top submitters, login events
```

---

## 8b. API Endpoints — Test Framework and Resources

### Test Framework Configuration (Wizard Step 1)
```
GET    /v1/company/test-framework    — get company capability declaration
PUT    /v1/company/test-framework    — create/update capability config (JSON object)
DELETE /v1/company/test-framework    — delete capability config
```

### Test Resources (Wizard Step 2)
```
GET    /v1/company/test-resources    — list available trains/trips
POST   /v1/company/test-resources    — add resource (resource_type: TRAIN|MULTIMODAL, label, data)
PUT    /v1/company/test-resources/:id — update resource
DELETE /v1/company/test-resources/:id — delete resource
```

---

## 8c. API Endpoints — Report Comparison

### Report Comparison
```
POST /v1/reports/compare
```
Body:
```json
{ "run_a_id": "uuid", "run_b_id": "uuid" }
```

Response:
```json
{
  "comparison_id": "uuid",
  "run_a_id": "uuid",
  "run_b_id": "uuid",
  "summary": { "total": 0, "passed_both": 0 },
  "differences": []
}
```

```
GET /v1/reports/comparisons       — list saved comparisons
GET /v1/reports/comparisons/:id   — retrieve specific comparison
```

---

## 8d. Company Profile — Subscription Key

The company profile supports an optional `subscription_key` field (Azure API Management subscription key). This value is encrypted at rest using the same AES-256-GCM encryption as other credentials. When a run is executed, the subscription key is passed to the Bruno environment as the `Ocp-Apim-Subscription-Key` variable.

---

## 8e. Concurrent Run Configuration

OSCAR supports running multiple Bruno scenarios in parallel:
- **Global limit**: `MAX_CONCURRENT_RUNS` (env var or admin UI Server Config)
- **Per-company limit**: set via Test Framework config (`concurrentLimit` field)
- Each run uses a unique environment file and JSON results file
- On Linux: workspace isolation copies collection per run
- On Windows: unique file naming prevents collisions

See Section 13 (Concurrent Sessions Management) for full details.

---

## 9. Security Model

### 9.1 HTTP Security Headers (Helmet)

All HTTP responses include security headers set by the `helmet` middleware:

| Header | Value | Purpose |
|--------|-------|---------|
| Content-Security-Policy | `default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://uic.org https://*.uic.org; connect-src 'self'; frame-ancestors 'none'` | Prevents XSS, clickjacking, and unauthorised resource loading |
| Strict-Transport-Security | `max-age=31536000; includeSubDomains` | Enforces HTTPS for 1 year |
| X-Content-Type-Options | `nosniff` | Prevents MIME sniffing |
| X-Frame-Options | `SAMEORIGIN` | Prevents clickjacking |

**CSP note:** `script-src-attr 'none'` blocks all inline event handler attributes (`onclick`, `onchange`, etc.). All UI event handling uses `addEventListener()` and event delegation with `data-action` attributes.

### 9.2 CORS Policy

CORS is restricted to origins listed in the `ALLOWED_ORIGINS` environment variable (comma-separated). When configured, only listed origins are permitted. When `ALLOWED_ORIGINS` is not set (local development), all origins are allowed as a fallback.

```
# .env example
ALLOWED_ORIGINS=https://oscar.example.com,https://admin.example.com
```

### 9.3 Rate Limiting

Authentication endpoints are rate-limited via `express-rate-limit`:

| Endpoint | Window | Max attempts | Response on limit |
|----------|--------|-------------|-------------------|
| `POST /v1/auth/login` | 15 minutes | 20 | 429 Too Many Requests |
| `POST /v1/auth/register/*` | 15 minutes | 20 | 429 Too Many Requests |
| `POST /v1/auth/bootstrap/*` | 15 minutes | 20 | 429 Too Many Requests |

### 9.4 Web Session — Ephemeral JWT Secret

OSCAR generates a new random JWT secret at every server startup:
```javascript
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
```
This means all active browser sessions are invalidated when the server restarts. Users must log in again after a restart. The `JWT_SECRET` is never written to disk or the `.env` file — it exists only in process memory for the lifetime of the server process.

**What is affected by a restart:** all web UI login sessions are terminated.

**What is NOT affected by a restart:** company API configuration (endpoint URL, bearer token, OAuth2 credentials, data file) is stored encrypted in the SQLite database using the persistent `ENCRYPTION_KEY` from `.env`. These persist indefinitely across restarts until explicitly changed by the user.

### 9.5 JWT Algorithm Pinning

JWT verification is restricted to HS256 only:
```javascript
jwt.verify(token, secret, { algorithms: ['HS256'] })
```
This prevents algorithm confusion attacks where a crafted token could use `none` or an asymmetric algorithm to bypass verification.

### 9.6 Password Policy

Passwords must meet these requirements (enforced on registration confirmation and admin user creation):
- Minimum length: **12 characters**
- Must contain at least one **uppercase** letter
- Must contain at least one **lowercase** letter
- Must contain at least one **digit**

### 9.7 Email Enumeration Prevention

The registration endpoint returns the same generic response whether an email already exists or not:
> *"If this email is not already registered, a verification link has been sent."*

This prevents attackers from enumerating valid email addresses by observing different responses.

### 9.8 Credentials Storage

API credentials (bearer token, OAuth2 client ID and secret, Ocp-Apim-Subscription-Key) are stored using AES-256-GCM encryption in the `companies` table. The encryption key (`ENCRYPTION_KEY`) is a static hex string in the `oscar-server.env` (or `.env`) configuration file. Credentials are only decrypted in memory at run-time by the execution worker and are never exposed in logs or API responses.

### 9.9 Ephemeral Environment Files

The Bruno environment `.yml` file written to disk for each run is **credential-free**
(#306, since server v1.11.179 / collection OTST_V2.0.95): the decrypted access token,
`Ocp-Apim-Subscription-Key` and `oauth_extra` are handed to the Bruno child process via
its process environment (`OSCAR_ACCESS_TOKEN` / `OSCAR_SUBSCRIPTION_KEY` /
`OSCAR_OAUTH_EXTRA`) and seeded into Bruno runtime variables by the collection's
before-request hook (`bru.getProcessEnv()`), never written to disk. The seeding only
fires while the runtime variable is empty, so a token refreshed mid-run via the OSCAR
loopback (#204) is never overwritten by the stale spawn-time value. The `.yml` file
itself carries only non-secret plumbing (API base URL, datafile URL, requestor, run id,
scenario override) and is:
- Written with restricted file permissions (`mode: 0o600` — owner-only read/write)
- Deleted immediately after the Bruno process exits
- Deletion uses a 3-attempt retry loop (500ms backoff) to handle Windows file locks
- Each failed deletion attempt is logged as a warning (hygiene only — a leftover file
  contains no credentials)

With this, **every credential-bearing path on disk is encrypted or eliminated**: DB
columns and datafiles/artifacts are AES-256-GCM at rest (§9.8, at-rest envelope), and
the last plaintext-on-disk credential (the pre-#306 env yml) no longer exists — a
worker crash between env-file write and cleanup leaves nothing sensitive behind.

### 9.10 Path Traversal Prevention

The artifact download endpoint (`GET /v1/runs/:id/artifacts/:aid`) validates that the resolved file path resides inside the `data/artifacts/` directory before serving:
```javascript
const safePath = path.resolve(artifact.path);
if (!safePath.startsWith(ARTIFACTS_DIR + path.sep)) {
  return res.status(403).json({ title: 'Forbidden' });
}
```
A malicious or corrupted path in the database cannot serve files outside the artifacts directory.

### 9.11 Tenant Isolation

Company users are always scoped to their own `company_id`. Platform users (administrators, certification users) can optionally target a specific company via the `company_id` query parameter, `X-Company-Id` header, or request body field — but the middleware validates that the specified company exists in the database before allowing the request to proceed. Non-existent company IDs return `404 Not Found`.

### 9.12 Error Handling

The global error handler returns a generic response with no internal details:
```json
{"status": 500, "title": "Internal Server Error"}
```
Full error stack traces are logged server-side only via `console.error`. No `err.message`, file paths, or SQL errors are exposed to clients.

### 9.13 Audit Logging

Security-relevant operations are recorded in the `auth_events` table:

| Event Type | Trigger |
|------------|---------|
| `login_success` / `login_failed` | User authentication attempts |
| `credential_update:{fields}` | Company API config changes (token, OAuth, subscription key) |
| `datafile_uploaded` / `datafile_deleted` | Test configuration file changes |
| `user_created:{email}:{role}` | Admin creates a user |
| `user_updated:{userId}` | Admin modifies a user |
| `user_deleted:{email}` | Admin deletes a user |
| `password_reset:{email}` | Admin resets a user's password |

All events record the acting user's ID, email, company context, and timestamp.

### 9.14 CSRF Protection

CSRF protection is not required. The API uses `Authorization: Bearer <token>` header authentication, not cookies. Cross-site requests from a malicious page cannot include the Bearer header (blocked by CORS and the same-origin policy).

### 9.15 Client-Side Token Handling

JWT tokens are stored in `localStorage`. To mitigate XSS risk:
- The Content Security Policy (`script-src-attr 'none'`) blocks inline script injection via HTML attributes
- Token format is validated on read — if it doesn't match the `header.payload.signature` Base64url pattern, `localStorage` is cleared and the user is redirected to login
- `JSON.parse` of stored user/company data is wrapped in `try/catch` to handle corrupted localStorage gracefully

### 9.16 Child Process Environment

A run starts two child processes: the Bruno CLI, and `library-bruno/mergeReport.js`,
a script of the bind-mounted collection. Neither is handed the server's environment,
which holds `ENCRYPTION_KEY`, `JWT_SECRET` and the SMTP credentials. Both start from
one allowlist, `CHILD_ENV_ALLOWLIST` in `worker/runner.js`: the path and profile
variables a process needs to start, plus `NODE_ENV` and `NODE_PATH`. Bruno gets the
run's three credentials and the per-run loopback secret (§9.17) on top (§9.9). The
report script gets nothing more.

Until v1.11.207 only the Bruno spawn used the allowlist. The report script was
started with no environment option and inherited everything (audit tracker NEW-01,
fixed in v1.11.208). A test fails if either child receives a variable that is not on
the list, so a secret added to the server later is not passed on by default.

The allowlist stops inheritance. It is not isolation: collection code runs as the
same operating-system user as the server, so a script written to do harm could still
read the server's files, and on Linux the environment of the server process itself.
The integrity of the collection (who can push to `main`) remains the control for that.

### 9.17 Loopback Route Authentication

Two routes exist for the Bruno subprocess to call back while a run is in flight:
`GET /data/:filename` returns the company's decrypted datafile, and
`POST /v1/runs/:runId/refresh-access-token` returns a live vendor access token for a
long-running scenario. A spawned child has no web session, so these cannot be gated
on a cookie or bearer token.

Until v1.11.210 they were gated on the source address alone: the request had to come
from `127.0.0.1`/`::1` with no `X-Forwarded-For`. That is a single condition with no
second factor. Any other process on the host, and any fronting proxy that does not
inject `X-Forwarded-For` (an L4/stream forwarder, a sidecar), satisfied it and could
read any company's datafile (slugs are enumerable) and a live vendor token — audit
tracker S8-loopback.

Since v1.11.210 the gate is a per-run secret (`utils/runSecrets.js`). When the runner
spawns Bruno it mints a random 32-byte secret, keyed by run id and bound to the run's
company, passes it through the child environment as `OSCAR_RUN_SECRET` (never the env
file on disk, §9.9), and revokes it when the child exits. The collection returns it as
the `X-OSCAR-Run-Secret` header — on the datafile fetch together with the run id in
`X-OSCAR-Run-Id`, since that route is keyed on the slug. Each route verifies the secret
in constant time and confirms it was issued for the company that owns what is asked:
a run of company A requesting company B's datafile is answered `404`. Nothing reads
`req.ip` for these routes any more. A signed-in Test Manager of the owning company
remains an authenticated fallback on `/data`; the refresh route is secret-only.

Because the secret is only on the collection's own two OSCAR calls, a run's OSDM
requests to the company `api_base` never carry it: aiming `api_base` at the internal
`/data` route now returns `401`, not a datafile. Constraining `api_base`/`token_url`
away from loopback and private ranges altogether (tracker S5) is a separate control.

The server now requires the header, so this release pairs server 1.11.210 with
collection OTST_V2.0.103 (`min_collection`); the bind-mounted collection updates before
the server image is promoted, so the header is sent before it is required.

### 9.18 Outbound Target Policy (api_base / token_url)

Two fields a company's members control become outbound requests: `companies.api_base`,
to which every OSDM request of every run is sent, and a tester's `users.token_url`, from
which the OAuth token is fetched. Unvalidated, each is a server-side request-forgery
(SSRF) primitive: a `token_url` of `http://127.0.0.1:3001/…` or an `api_base` of
`http://grafana:3000` reaches loopback, the private network (RFC 1918), link-local
(including the cloud metadata address `169.254.169.254`) and the Docker service mesh,
and the response returns in the run log or the token error — audit tracker S5. §9.17
removed the loopback *trust* on OSCAR's own routes; this stops the request being aimed
at an internal address in the first place.

`utils/urlPolicy.js` is the rule, with IP ranges classified by `ipaddr.js` rather than
by hand. A target must use `https` and resolve to a public (`unicast`) address;
loopback, private, link-local, unique-local, carrier-grade NAT, the
unspecified/broadcast/multicast/reserved ranges, and any bare single-label host name (a
Docker service name, `localhost`) are refused. It is applied twice: a synchronous
structural check at save time (`PATCH /v1/company`, `PATCH /v1/me/credentials` → 400,
nothing stored, no DNS in the request path), and a structural-plus-DNS check at use time
— before the token fetch (`access-token.js`), before the server's own OSDM calls
(`osdm-client.js`), and before a run starts (`worker/runner.js` refuses it, ahead of
token resolution and any spawn). The use-time DNS lookup catches a host name that
resolves to an internal address, and a value stored before the policy existed.

`ALLOW_PRIVATE_TARGETS=1` disables the policy for a self-hosted or development
deployment whose providers sit on `localhost` or the LAN. It is read at call time.

### 9.19 Dedicated Headers at Rest (companies.extra_headers)

The company "Dedicated Headers" field (`companies.extra_headers`, a JSON array of
`{ name, value }` injected on every OSDM request) is presented as the home for
vendor API keys, yet it was stored plaintext and serialized verbatim by
`GET /v1/company` — including to a platform administrator — unlike every other
credential (encrypted at rest, never returned). Audit tracker S6.

It is now encrypted at rest with the shared `enc:v1:` column envelope
(`db.colEncrypt`): the write path in `PATCH /v1/company` encrypts the JSON blob,
migration v27 encrypts existing rows at boot (mirroring v19), and `colDecrypt`
reads both the encrypted form and any legacy-plaintext row, so a row left plain
by an interrupted migration still works. The run engine (`worker/runner.js`) and
the server's own OSDM calls (`utils/osdm-client.mergeDedicatedHeaders`) decrypt
at use.

On read, `safeCompany(company, canSeeHeaderValues)` returns the values only to the
owning Test Manager — who set them and needs them to edit. An administrator, a
tester, a certifier, and the platform cross-company view receive the header name
and a `has_value` flag, never the value. Runs are unaffected (the engine reads
from the database, not from this response).

This is the storage/read half (S6). The report a certifier reads still renders a
tenant-named header value verbatim because redaction matches a fixed name list;
that is tracker NEW-03, redacted by value (any header whose value is the run's
resolved credential) so diagnostic headers stay visible.

---

## 10. Execution Worker — Credential Handling and Error Detection

### 10.1 YAML Safety of the Environment File

Since #306 the token never enters the environment `.yml` at all (it travels via the
child process environment, §9.9), so a malformed token can no longer break YAML parsing.

Since v1.11.208 (audit tracker NEW-02) every value that does enter the file is written
by one function, `yamlQuoted()` in `worker/runner.js`: the environment name, the API
base URL, the datafile URL, the requestor, the scenario override, the dedicated
headers and the three variables the runner adds itself. It writes a YAML double-quoted
scalar on one line that holds printable ASCII only. The quote, the backslash and the
control characters are escaped as in JSON, and every character from DEL upwards is
written as `\uXXXX`, because some YAML parsers treat U+0085, U+2028 and U+2029 as line
breaks. Bruno reads back exactly the value given. A value with nothing to escape is
written byte for byte as before; the only line that differs for an ordinary run is
the first, where the environment name is now quoted.

Before that, values were pasted between two double quotes as they came, and only the
dedicated headers were escaped. A value holding a `"` broke the file, and Bruno failed
before running any test (`Unexpected scalar`). A value holding a `"` and a line break
did worse: it added variables of its own. A scenario code is free text stored by a
tester, so a crafted code could add a second `api_base`; Bruno uses the last one, and
the run's requests, access token included, went to that address. The run could be the
Test Manager's: a company run list of "ALL" includes testers' private scenarios. It
could be a colleague's once the Test Manager had shared the scenario. Reproduced with
Bruno 4.2.1 before the fix, and checked after it.

Escaping does not cover one thing Bruno does with a value afterwards: it fills in
`{{...}}` when a script reads the value. A scenario code written as
`{{process.env.OSCAR_ACCESS_TOKEN}}` would be read by the collection as the access token
of whoever started the run, and then reported as "not found" in a run log that every
member of the company can read. Bruno has no way to write `{{` literally, so the runner
refuses to start a run whose scenario code contains `{{`: the run is marked FAILED
with a message asking for the scenario to be renamed, before a token is requested,
before the file is written and before any process is started. The dedicated headers
keep their `{{var}}` templates: that is their documented use, and only a Test Manager
sets them.

A scenario code that is not text (the datafile is JSON, so a code can be stored as an
object, a list or a number) is not run either. `POST /v1/runs` leaves such scenarios
out of the batch; before, an object or a list could not be written to the runs table,
and the whole batch answered 500. The runner refuses a non-text code that reaches it,
instead of throwing: a run that throws is not marked FAILED.

### 10.2 Authentication Error Detection

During Bruno execution, the runner monitors all stdout/stderr output for two categories of authentication failure:

| Sentinel written to DB | Detection pattern | Meaning |
|---|---|---|
| `TOKEN_FORMAT_ERROR` | `YAMLParseError`, `Unexpected scalar`, `Error parsing environment` | Bruno could not parse the environment file. Until v1.11.207 a configured value holding a special character (API base URL, requestor) caused this. Since v1.11.208 every value is escaped (§10.1), so a value can no longer cause it; the detection is kept as a safety net |
| `TOKEN_AUTH_ERROR` | `Wrong response status: 401`, `401 Unauthorized`, `HTTP 401` | The token is syntactically valid but rejected by the remote API — token expired or revoked |

After the Bruno process exits, if either flag was set, the runner writes the sentinel string to `runs.error_message` and appends a human-readable error event to `run_events`.

OAuth2 authentication failures are handled earlier: if the OAuth2 token request (`POST` to the token URL) returns a non-200 status, the run is immediately marked `FAILED` and the HTTP error response is stored in `error_message`.

### 10.3 Templates in Datafile Text

Bruno fills in a double-brace template wherever a value is used: in a request body, a
URL, a header, or when a script reads a variable back. `{{process.env.OSCAR_ACCESS_TOKEN}}`
and `{{access_token}}` both give the access token of whoever started the run.

The collection makes the whole datafile such a value, in two ways:

- Before every run it stores the whole datafile as one variable and reads it back for
  the schema check. Bruno fills in every template in it, in every scenario, and the
  schema check prints the value of a field that is not on its list of allowed values.
- It then copies the scenario being run, and the resource entries it uses, into the
  variables requests are built from.

So text a tester typed into one of their own scenarios, in the ordinary editor, showed
the token of whoever ran **any** scenario of the company: in that run's log, or in its
HTTP traffic. Every member of the company can read both, and a certifier can once the
run is shared. Checked with Bruno CLI 4.2.1 (audit tracker NEW-10, fixed in v1.11.209).

Bruno has no way to write `{{` literally and no datafile needs it, so it is refused, by
two rules in `utils/datafileTemplates.js`:

- **A save may not add it.** `PUT /v1/company/datafile/json` (a tester's merged save, a
  Test Manager's whole-file save) and `POST /v1/company/datafile` (upload) answer 400
  when the write adds `{{`, in a value or in the name of a field. The answer names the
  place and never repeats the text. Only text that is not already stored counts: text
  stored earlier, by anyone, does not block a save of something else, whatever else the
  save changes or reorders. One more copy of a stored template is new.
- **A run is not started while the datafile holds it.** Before a token is requested,
  the runner reads the datafile and refuses the run if `{{` is anywhere in it: any
  scenario, any entry of any list, any other root key. The run is marked `FAILED` with
  the place. A Test Manager is told every place. A tester is told the places in what
  Test Config shows them (`viewForTester`), and for anything else only that the text
  is also in a part of the datafile they cannot see: no code, no field, no count. A
  datafile that is present but cannot be read refuses the run as well: starting it
  would mean starting it unchecked.

Both are needed. Bruno reads the datafile itself, after the runner has looked at it, so
the run-time rule alone could be raced by a save; the save-time rule alone would leave
text stored before it existed.

Left alone, on purpose: the two root keys only a Test Manager can write
(`systemInfoParameters`, `knownDeviations`), and the dedicated headers, where a template
is the documented way to reference a variable.

---

## 11. Bruno Collection — Resilient Scenario Execution

### 11.1 Multi-Scenario Loopback Mechanism

OSCAR runs OTST Bruno scenarios sequentially within a single `bru run` invocation. The scenario list is stored in the `__scenariosList` environment variable (a JSON array). After each scenario completes, the loopback script sets `__loopback = true` and routes execution back to `01. POST Get Offer` to load the next scenario.

### 11.2 "No Offers" Retry and Skip Logic

When a provider returns HTTP 200 but an empty offers array, the `01. POST Get Offer` post-response script would previously throw an exception, causing the scenario to cascade-fail into `02. POST Create Booking` which would call `stopExecution()` — killing all remaining scenarios.

**Current behaviour (as of this version):**

The post-response script wraps `postOfferResponse(jsonData)` in a try/catch with a 3-attempt retry counter stored in `__offerRetryCount`:

1. **Attempts 1 and 2**: Re-run `01. POST Get Offer` for the same scenario (same origin/destination/date combination). The test is marked as failed in the report but execution continues.
2. **Attempt 3 (final)**: Log an INFO message, reset the counter, and advance to the next scenario via the normal loopback mechanism (`__loopback = true`). If there are no more scenarios, call `stopExecution()`.

This prevents a single route with no inventory from blocking the entire test session. The counter is reset to `0` on every successful offer response so retries are per-scenario, not cumulative across the run.

This logic applies to all endpoint types that return offers (booking, refund search, exchange search).

---

## 12. UI Error Reporting — Authentication Banners

The run detail page (`run-detail.html`) displays a warning banner when the `error_message` field of a completed run contains a recognised sentinel value:

### TOKEN_FORMAT_ERROR banner
Displayed when Bruno could not parse the YAML environment file. Until v1.11.207 a special character in an API setting caused it. Since v1.11.208 values are escaped (§10.1): a base URL or requestor holding a `"` is passed to Bruno as it is, and this banner should no longer appear.
- Title: *"Invalid API configuration — Bruno could not parse the run environment"*
- Message: explains that a special character (e.g. trailing `"`) was detected in an API setting (e.g. base URL or requestor) and instructs the user to correct it.
- Action button: links to the Company Profile page to fix the API config.

### TOKEN_AUTH_ERROR banner
Displayed when Bruno received an HTTP 401 from the remote API during test execution.
- Title: *"API Token rejected — HTTP 401 Unauthorized"*
- Message: advises that the configured token is invalid or has expired.
- Action button: links to the Company Profile page to update the token.

### OAuth2 failure banner
Displayed when `error_message` contains neither sentinel but the run failed — typically an OAuth2 token fetch error. Shows the raw error message returned by the token endpoint.

All banners use a consistent orange warning style and are only shown once the run has a terminal status (`COMPLETED` or `FAILED`).

---

## 13. Concurrent Sessions Management

### 13.1 Overview

OSCAR supports parallel scenario execution, allowing multiple Bruno test processes to run concurrently for the same company. This is controlled by a per-company `concurrentSessionLimit` in the test framework configuration.

- **Sequential mode** (default): All scenarios in `scenariosToRun` execute one-by-one within a single Bruno process via the loopback mechanism. Total time = sum of all scenario durations.
- **Parallel mode**: Each scenario is an independent Bruno process in its own isolated workspace. Total time = longest single scenario duration.

### 13.2 Concurrent Session Limit

The `concurrentSessionLimit` is configured per company in the test framework (Scenarios page, Section 1):

| Setting | Default | Range | Scope |
|---------|---------|-------|-------|
| `concurrentSessionLimit` | 1 | 1-10 | Per company, across all users |

When set to 1, behavior is identical to sequential mode. When set to 3, up to 3 Bruno processes can run simultaneously for that company.

### 13.3 Run-Scoped Workspace (Linux Only)

On Linux, each run executes in an isolated workspace directory to prevent file collisions:

```
data/workspaces/{runId}/
  environments/           <-- real directory (ephemeral env file)
  Validation_Reports/     <-- real directory (results + reports)
  library-bruno/          <-- symlink to shared collection
  00-Access Token/        <-- symlink
  01-System Infos Requests/ <-- symlink
  02-Common Requests/     <-- symlink
  03-Refund/              <-- symlink
  04-Exchange/            <-- symlink
  data_base/              <-- symlink
  opencollection.yml      <-- copied (small file)
```

Symlinks point to the shared Bruno collection (read-only). Only `environments/` and `Validation_Reports/` are real directories where Bruno writes output. After artifacts are copied to `data/artifacts/{runId}/`, the workspace is deleted.

On Windows, workspace isolation is not used — the system runs in sequential mode with `MAX_CONCURRENT_RUNS=1`.

### 13.4 Scenario Override

When running in parallel mode, each Bruno process receives a `scenario_override` environment variable that restricts execution to a single scenario:

```yaml
- name: scenario_override
  value: "OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG"
```

The `scenarioParser.js` checks this variable before resolving `scenariosToRun`. When set, only the specified scenario executes, and the loopback mechanism naturally stops after one iteration.

### 13.5 Batch Runs

Parallel submissions create a batch of runs grouped by `batch_id`:

```
POST /v1/runs { "parallel": true }

Response:
{
  "batch_id": "uuid",
  "parallel": true,
  "concurrent_limit": 3,
  "runs": [
    { "id": "run-1", "scenario_code": "OTST_RFND_PATCH_1ADT_1LEG", "status": "QUEUED" },
    { "id": "run-2", "scenario_code": "OTST_EXCH_1ADT_1LEG", "status": "QUEUED" },
    ...
  ]
}
```

Each run in the batch has its own `scenario_code`, appears independently in the dashboard (grouped under the batch), and produces its own artifacts and logs.

### 13.6 Queue Behavior

The job queue enforces both global and per-company limits:

1. **Global limit**: `MAX_CONCURRENT_RUNS` environment variable (default: 5)
2. **Per-company limit**: `concurrentSessionLimit` from test framework config

Jobs are never refused — they wait in the queue until a slot opens. A company at its limit does not block other companies' jobs from starting.

**Stagger delay**: Within a batch, jobs are started with a configurable delay (`PARALLEL_STAGGER_MS`, default 2000ms) to avoid overwhelming the provider API with simultaneous requests.

### 13.7 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST /v1/runs` | Submit run | Accepts `parallel: true` to create a batch of parallel runs |
| `GET /v1/runs/queue-status` | Queue status | Returns company queue state: slots used/available, queued/running runs with positions |
| `GET /v1/runs/batch/:batchId` | Batch status | Returns all runs in a batch with aggregated completion counts |

### 13.8 Configuration Reference

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MAX_CONCURRENT_RUNS` | `5` | Global server-wide max concurrent Bruno processes |
| `PARALLEL_STAGGER_MS` | `2000` | Delay (ms) between parallel launches within a batch |

| Framework Config Field | Default | Description |
|----------------------|---------|-------------|
| `concurrentSessionLimit` | `1` | Max parallel runs for this company (across all users) |
