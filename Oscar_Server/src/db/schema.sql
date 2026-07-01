-- OSCAR Database Schema — SQLite
-- Mirrors the full data model defined in architecture doc Section 14.7
-- Migration strategy: version is tracked in schema_version table.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ── Schema version ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Companies ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id                  TEXT PRIMARY KEY,          -- UUID
  name                TEXT NOT NULL,
  slug                TEXT NOT NULL UNIQUE,       -- used as datafile prefix and env name fragment
  -- Auth mode: 'bearer' | 'oauth2'
  auth_mode           TEXT NOT NULL DEFAULT 'bearer',
  -- OSDM endpoint
  api_base            TEXT,
  -- Bearer token mode (AES-GCM encrypted, base64)
  access_token_enc    TEXT,
  -- OAuth2 Client Credentials mode (AES-GCM encrypted, base64)
  client_id_enc       TEXT,
  client_secret_enc   TEXT,
  token_url           TEXT,
  -- Auth profile dispatcher (added v10). Each profile picks a different
  -- token-fetch shape so we can talk to vendors that don't speak vanilla
  -- RFC 6749 client_credentials. See src/worker/auth-profiles.js.
  --   'oauth2_basic' (default) — RFC 6749 client_secret_basic
  --   'oauth2_post'            — RFC 6749 client_secret_post  (Bileto, Turnit)
  --   'paxone_json'            — Paxone JSON {accountName, accountSecret}
  --   'sqills_extension'       — Sqills custom grant_type URI + JSON body
  --   'custom'                 — user-supplied JSON request template
  oauth_profile         TEXT NOT NULL DEFAULT 'oauth2_basic',
  -- Optional OAuth2 scope (used by oauth2_basic / oauth2_post / custom).
  oauth_scope           TEXT,
  -- Profile-specific extra credential, AES-GCM encrypted.
  -- Used by sqills_extension for the pre-base64'd Authorization: Basic
  -- value Sqills layers on top of body credentials. Other profiles ignore.
  oauth_extra_enc       TEXT,
  -- Free-text JSON template for the 'custom' profile. Schema:
  --   { "method": "POST",
  --     "headers": { "k": "v with {{client_id}} placeholders" },
  --     "body":    "{...}" or { ... },
  --     "body_format": "json" | "form",
  --     "token_field": "access_token" }
  -- Placeholders: {{client_id}}, {{client_secret}}, {{scope}}, {{extra}}.
  oauth_custom_template TEXT,
  -- Cached access token + expiry (added v11). Avoids hammering the vendor's
  -- token endpoint when running back-to-back scenarios. Cleared whenever any
  -- auth field on this row is rewritten via PATCH /v1/company. The token
  -- itself is AES-GCM encrypted; the expiry is stored as ISO 8601 UTC. NULL
  -- expiry means "do not cache" (vendor didn't return expires_in).
  cached_token_enc        TEXT,
  cached_token_expires_at TEXT,
  cached_token_cred_fp    TEXT,
  -- Optional requestor header (AES-GCM encrypted, base64)
  requestor_enc       TEXT,
  -- Data file
  datafile_path       TEXT,                      -- absolute path on server
  datafile_hash       TEXT,                      -- SHA-256 hex of uploaded file
  datafile_updated_at TEXT,
  -- Company-wide "dedicated headers" (issue #426). JSON array of
  -- { "name": "<HTTP header>", "value": "<literal or {{var}} template>" }.
  -- Injected on every OSDM request by opencollection.yml's before-request
  -- hook; {{var}} references resolve against the Bruno env at send time
  -- (e.g. {{requestor}}, {{Ocp-Apim-Subscription-Key}}, {{access_token}}).
  -- Lets a Test Manager add operator-specific headers without a code change.
  extra_headers       TEXT,
  -- Privacy toggle (v15): when 0, certification_user role cannot see this
  -- company's runs/reports. Only test_manager(s) of the company and the
  -- platform administrator can. Default 1 keeps current behaviour.
  share_reports_with_certifier INTEGER NOT NULL DEFAULT 1,
  -- Timestamps
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Users ─────────────────────────────────────────────────────────────────────
-- Per-user OSDM credentials (added v12). Each tester maintains their own
-- credentials against the company's OSDM API — different testers can use
-- different vendor accounts. The companies row keeps only api_base + datafile;
-- everything related to authentication lives here.
CREATE TABLE IF NOT EXISTS users (
  id                      TEXT PRIMARY KEY,                -- UUID
  company_id              TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email                   TEXT NOT NULL UNIQUE,
  password_hash           TEXT NOT NULL,
  role                    TEXT NOT NULL DEFAULT 'company_user',
  -- 'active' | 'pending' — self-registered users start 'pending' until a
  -- Test Manager (or administrator) of their company approves them (#449).
  status                  TEXT NOT NULL DEFAULT 'active',
  -- Credentials (encrypted secrets are AES-GCM, base64)
  auth_mode               TEXT NOT NULL DEFAULT 'bearer',   -- 'bearer' | 'oauth2'
  access_token_enc        TEXT,
  client_id_enc           TEXT,
  client_secret_enc       TEXT,
  token_url               TEXT,
  oauth_profile           TEXT NOT NULL DEFAULT 'oauth2_basic',
  oauth_scope             TEXT,
  oauth_extra_enc         TEXT,
  oauth_custom_template   TEXT,
  -- Token cache (reused only while the credential fingerprint matches; #208)
  cached_token_enc        TEXT,
  cached_token_expires_at TEXT,
  cached_token_cred_fp    TEXT,
  -- Optional headers
  requestor_enc           TEXT,
  subscription_key_enc    TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Runs ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,          -- UUID
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users(id),
  -- Status lifecycle:
  --   QUEUED → RUNNING → COMPLETED (exit 0) | FAILED (exit ≠ 0)
  --                    → CANCELLED (explicit cancel)
  --   Any terminal → DELETION_REQUESTED  (tester soft-delete, pending admin confirmation)
  --   Any terminal → DELETED_BY_ADMIN    (admin soft-delete, still visible to tester flagged)
  --   DELETION_REQUESTED | DELETED_BY_ADMIN → DELETED  (admin confirms / purges permanently)
  --   DELETION_REQUESTED | DELETED_BY_ADMIN → previous_status  (admin restores)
  status              TEXT NOT NULL DEFAULT 'QUEUED',
  -- Deletion tracking
  deleted_by          TEXT,                      -- email of the user who requested/performed deletion
  previous_status     TEXT,                      -- status before deletion (for restore)
  -- Snapshot of config used for this run (for traceability)
  auth_mode_used      TEXT,
  api_base_used       TEXT,
  datafile_hash_used  TEXT,
  env_name_used       TEXT,                      -- e.g. OTST_AcmeCorp_Env
  -- Timing
  queued_at           TEXT NOT NULL DEFAULT (datetime('now')),
  started_at          TEXT,
  completed_at        TEXT,
  -- Result
  exit_code           INTEGER,
  error_message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_company_id ON runs(company_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);

-- ── Run Events (log stream) ───────────────────────────────────────────────────
-- Additional columns added via migrations in db.js:
--   category, phase, suite_name, request_name, http_status  (v5)
--   event_kind, attempt_index, attempt_total, scenario_name (v7 — scenario milestones + retry tracking)
-- event_kind values:
--   'log'               (default)  — regular stdout/stderr line
--   'scenario_start'               — new scenario starting
--   'scenario_retry'               — same scenario being retried (attempt N/M)
--   'scenario_skipped'             — scenario skipped after exhausted retries
--   'scenario_end'                 — scenario finished
CREATE TABLE IF NOT EXISTS run_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL DEFAULT (datetime('now')),
  level     TEXT NOT NULL DEFAULT 'stdout',      -- 'stdout' | 'stderr' | 'info' | 'error'
  message   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run_id ON run_events(run_id);

-- ── Run Artifacts ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS run_artifacts (
  id        TEXT PRIMARY KEY,                    -- UUID
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type      TEXT NOT NULL,                       -- 'html_report' | 'json_results'
  filename  TEXT NOT NULL,
  path      TEXT NOT NULL                        -- absolute path on server
);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id ON run_artifacts(run_id);

-- ── Report Comparisons ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS report_comparisons (
  id          TEXT PRIMARY KEY,                  -- UUID
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_a_id    TEXT NOT NULL REFERENCES runs(id),
  run_b_id    TEXT NOT NULL REFERENCES runs(id),
  diff_json   TEXT NOT NULL,                     -- serialized diff result
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_comparisons_run_a ON report_comparisons(run_a_id);
CREATE INDEX IF NOT EXISTS idx_report_comparisons_run_b ON report_comparisons(run_b_id);

-- ── Auth events (login activity) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT REFERENCES users(id),
  company_id  TEXT REFERENCES companies(id),
  email       TEXT,
  event_type  TEXT NOT NULL,                     -- 'login_success' | 'login_failed'
  ip          TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_events_created_at ON auth_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_events_event_type ON auth_events(event_type);

-- ── Pending Registrations (email-verified self-registration) ──────────────────
CREATE TABLE IF NOT EXISTS pending_registrations (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,           -- display-name snapshot (shown on the confirm page/email)
  company_slug TEXT,                    -- stable slug of the picked company; the lookup key at confirm (#449)
  token        TEXT NOT NULL UNIQUE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Test Framework (company capability declaration — Step 1 of scenario wizard) ─
-- Stores one JSON configuration row per company describing which OSDM features
-- (sales flows, transport modes, train types, service classes, pax types, etc.)
-- the system under test supports.  Used by the scenario creation wizard.
CREATE TABLE IF NOT EXISTS test_frameworks (
  id          TEXT PRIMARY KEY,                  -- UUID
  company_id  TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  config      TEXT NOT NULL DEFAULT '{}',        -- JSON blob (see API for schema)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Test Resources (available test trains / trips — Step 2 of scenario wizard) ─
-- Each row is one bookable resource: a specific train run or a multimodal trip
-- that can be referenced when the wizard generates scenario definitions.
CREATE TABLE IF NOT EXISTS test_resources (
  id            TEXT PRIMARY KEY,                -- UUID
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL DEFAULT 'TRAIN',   -- 'TRAIN' | 'JOURNEY' | 'MULTIMODAL'
  label         TEXT NOT NULL DEFAULT '',        -- human-readable short name
  data          TEXT NOT NULL DEFAULT '{}',      -- JSON blob (see API for schema)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_test_resources_company ON test_resources(company_id);

-- ── Places cache (OSDM GET /places bulk-download — issue #450) ───────────────
-- One row per company: the vendor's stop-place list, bulk-downloaded on demand
-- and used for a full-text stop-place lookup in Test Config (Timetable Discovery
-- + Train Resource editor). Places are public reference data (station
-- names/URNs) so the JSON blob is stored plaintext, not encrypted at rest.
CREATE TABLE IF NOT EXISTS places_cache (
  company_id  TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  places_json TEXT NOT NULL DEFAULT '[]',        -- JSON array of { id, name, objectType }
  place_count INTEGER NOT NULL DEFAULT 0,
  cached_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Server config — runtime-editable key-value settings ─────────────────────
-- Stores server configuration that can be changed by administrators at runtime
-- without requiring a server restart. On first startup, values are seeded from
-- environment variables. DB values take precedence over env vars thereafter.
CREATE TABLE IF NOT EXISTS server_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT DEFAULT (datetime('now')),
  updated_by  TEXT                               -- admin email who last changed it
);

-- ── Run Suites (scenario-level rollup per run) ──────────────────────────────
CREATE TABLE IF NOT EXISTS run_suites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scenario_name TEXT,                                -- top-level OSDM scenario folder (grandparent of .bru files)
  suite_name  TEXT NOT NULL,                         -- request-group folder (e.g. "02-Common Requests")
  total       INTEGER NOT NULL DEFAULT 0,
  passed      INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  pass_rate   REAL NOT NULL DEFAULT 0.0,
  duration_ms INTEGER DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_suites_run      ON run_suites(run_id);
CREATE INDEX IF NOT EXISTS idx_run_suites_company  ON run_suites(company_id);

-- ── Run Requests (request-level detail per suite) ───────────────────────────
-- vendor_capability (added via v7 migration): classifies how the endpoint
-- behaved from a vendor-conformance standpoint, independently of PASS/FAIL:
--   'IMPLEMENTED'       — 2xx response, all assertions passed
--   'NOT_IMPLEMENTED'   — 501, or 404 on an expected OSDM endpoint
--   'PARTIAL'           — 2xx but some assertions failed (vendor implements
--                         the endpoint but not the full contract)
--   'ERROR'             — 5xx other than 501 (vendor error, not a capability gap)
--   NULL                — undetermined (auth-only, no response, etc.)
-- context (added via v8 migration): JSON blob of request-specific metadata
-- extracted from the sent payload (e.g. refund overrule code, exchange mode,
-- offer flexibility filter). Surfaced as inline tags on the capability matrix
-- so the certifier can interpret PASS/FAIL/PARTIAL results without opening
-- the raw request body. Populated by src/reports/contextExtractors.js.
CREATE TABLE IF NOT EXISTS run_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id      INTEGER NOT NULL REFERENCES run_suites(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_name  TEXT NOT NULL,
  http_method   TEXT,
  http_url      TEXT,
  http_status   INTEGER,
  duration_ms   INTEGER DEFAULT 0,
  total         INTEGER NOT NULL DEFAULT 0,
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL DEFAULT 'SKIP',  -- 'PASS' | 'FAIL' | 'SKIP'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_requests_run   ON run_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_run_requests_suite ON run_requests(suite_id);

-- ── Run Assertions (individual assertion/test results) ──────────────────────
CREATE TABLE IF NOT EXISTS run_assertions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER NOT NULL REFERENCES run_requests(id) ON DELETE CASCADE,
  suite_id        INTEGER NOT NULL REFERENCES run_suites(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assertion_key   TEXT NOT NULL,       -- stable "{suite}|{request}|{name}" for trend matching
  assertion_name  TEXT NOT NULL,       -- full description from Bruno
  type            TEXT NOT NULL DEFAULT 'test',  -- 'test' | 'assertion' | 'script_error'
  category        TEXT,                -- environment_check, http_status, business_logic, etc.
  domain          TEXT,                -- infrastructure, offer, booking, fulfillment, etc.
  offer_part      TEXT,                -- admission, reservation, ancillary (if applicable)
  severity        TEXT,                -- critical, major, minor, info
  passed          INTEGER NOT NULL DEFAULT 0,
  error_msg       TEXT,
  expected_value  TEXT,
  actual_value    TEXT,
  parameterized   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_assertions_run       ON run_assertions(run_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_request   ON run_assertions(request_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_company   ON run_assertions(company_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_key       ON run_assertions(company_id, assertion_key);
CREATE INDEX IF NOT EXISTS idx_run_assertions_category  ON run_assertions(company_id, category);
CREATE INDEX IF NOT EXISTS idx_run_assertions_domain    ON run_assertions(company_id, domain);

-- ── Report Templates (certifier saved report configurations) ────────────────
CREATE TABLE IF NOT EXISTS report_templates (
  id          TEXT PRIMARY KEY,
  company_id  TEXT REFERENCES companies(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',  -- JSON: categories, domains, status, severity filters
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Token Revocation Blacklist ────────────────────────────────────────────────
-- Stores revoked JWT IDs (jti) so individual sessions can be invalidated
-- without rotating the global JWT secret. Rows are pruned once expires_at
-- passes — a background vacuum or periodic job can handle this.
CREATE TABLE IF NOT EXISTS token_blacklist (
  jti         TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,             -- ISO-8601 UTC; mirrors the JWT exp
  revoked_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at);

-- ── Test Findings & Open Points (conformance dialogue) ──────────────────────
-- A per-test-system, threaded record of conformance findings. OSCAR's analysis
-- opens a "finding" (an observation + its reading of the spec); the test team
-- replies on the thread (finding_comment) and settles a category/severity. It
-- is deliberately soft-worded — a finding may turn out to be the provider's
-- deviation OR OSCAR's own bug, decided by the dialogue, not pre-judged.
--
-- Runtime link: a finding marked baseline_in_run=1 that carries a numeric
-- expected_status is projected into the datafile's top-level knownDeviations[]
-- (sibling of systemInfoParameters) so the #398 Bruno engine reports a matching
-- response as a documented deviation instead of a FAILED run. Everything else
-- is recorded for the dialogue only — no runtime effect.
CREATE TABLE IF NOT EXISTS finding (
  id               TEXT PRIMARY KEY,
  company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,                       -- short headline of the open point
  step             TEXT,                                -- request/step label for status-level baselining (e.g. "GET Passenger"); NULL for assertion-level / general findings
  scenario_code    TEXT,                                -- the datafile scenario.code that revealed this finding (issue #447); NULL when not tied to one scenario
  expected_status  INTEGER,                             -- the provider's observed HTTP status to baseline (e.g. 501); NULL when not status-level
  observed         TEXT,                                -- what the provider actually returned
  interpretation   TEXT,                                -- OSCAR's reading + spec reference
  category         TEXT NOT NULL DEFAULT 'open',        -- 'open' | 'provider_deviation' | 'oscar_issue' | 'not_supported' | 'spec_question'
  severity         TEXT,                                -- soft label: 'major' | 'minor' | 'not_supported' | NULL (until classified)
  status           TEXT NOT NULL DEFAULT 'open',        -- 'open' | 'discussing' | 'resolved'
  baseline_in_run  INTEGER NOT NULL DEFAULT 0,          -- 1 = project into knownDeviations (needs expected_status); enforce switch
  raise_to_osdm    INTEGER NOT NULL DEFAULT 0,          -- 1 = flagged as structured feedback for the OSDM working group
  evidence         TEXT,                                -- free text / run link / response snippet
  created_by       TEXT,                                -- author label ('OSCAR analysis' for seeded findings, else the user email)
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finding_company ON finding(company_id);

CREATE TABLE IF NOT EXISTS finding_comment (
  id          TEXT PRIMARY KEY,
  finding_id  TEXT NOT NULL REFERENCES finding(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,                            -- email of the poster (or 'OSCAR' for analysis posts)
  role        TEXT,                                     -- poster's role at time of writing (test_manager | company_user | oscar)
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_finding_comment_finding ON finding_comment(finding_id);

-- ── Seed schema version ───────────────────────────────────────────────────────
INSERT OR IGNORE INTO schema_version (version) VALUES (1);
