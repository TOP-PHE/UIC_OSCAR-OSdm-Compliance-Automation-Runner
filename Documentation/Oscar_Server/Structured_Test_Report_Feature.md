# OSCAR — Structured Test Report Feature Specification

**Date:** 2026-04-15
**Status:** Design complete, implementation pending
**Priority:** High — enables assertion-level analytics, trend tracking, and configurable certification reports

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer)

"This material is copyrighted by UIC, Union Internationale des Chemins de fer (c) 2026 OSDM is a trademark belonging to UIC, and any use of this trademark is strictly prohibited unless otherwise agreed by UIC."

---

## 1. Objective

Transform OSCAR's test reporting from file-based artifacts (HTML reports + raw JSON) into a **structured, queryable, database-backed** system that enables:

1. **Per-assertion result tracking** across runs
2. **Trend analysis** showing pass/fail rates over time
3. **Categorized reports** filterable by OSDM domain, assertion category, severity
4. **Configurable certification reports** where certifiers can select criteria for the report content
5. **Regression detection** identifying newly failing assertions

### Current State
- Bruno produces `.bru_results.json` (30 request entries, ~400 assertions per run)
- `reportGenerator.js` produces an HTML report per scenario
- `diff.js` compares two runs using flat string keys (`"{suite}|{request}|{assertion}"`)
- No assertion-level data in the database — only summary counts in the HTML report
- Certifiers see the same report as testers — no filtering or configuration options

### Target State
- Every assertion result stored in the database with rich metadata (category, domain, severity)
- Reports configurable by certifiers: filter by domain, category, status, date range
- Trend charts showing assertion pass rates over time
- Automatic regression alerts when previously passing assertions start failing

---

## 2. Data Model

### 2.1 Three-Level Normalized Schema

```
run_suites (Level 1)          — one row per scenario folder per run
  └── run_requests (Level 2)  — one row per HTTP request per suite
        └── run_assertions (Level 3) — one row per test/assertion per request
```

### 2.2 Table Definitions

#### `run_suites` — Scenario-level rollup

```sql
CREATE TABLE IF NOT EXISTS run_suites (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  suite_name      TEXT NOT NULL,           -- e.g. "01-System Infos Requests"
  total           INTEGER NOT NULL DEFAULT 0,
  passed          INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  pass_rate       REAL NOT NULL DEFAULT 0.0,
  duration_ms     INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_suites_run      ON run_suites(run_id);
CREATE INDEX IF NOT EXISTS idx_run_suites_company  ON run_suites(company_id);
```

**Enables:** "Show me all suites with <80% pass rate", "Which scenario folder fails most?"

#### `run_requests` — Request-level detail

```sql
CREATE TABLE IF NOT EXISTS run_requests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id        INTEGER NOT NULL REFERENCES run_suites(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  request_name    TEXT NOT NULL,            -- e.g. "00. GET System Version Check"
  http_method     TEXT,                     -- GET, POST, PATCH, DELETE
  http_url        TEXT,                     -- full request URL
  http_status     INTEGER,                  -- response status code
  duration_ms     INTEGER DEFAULT 0,        -- request duration
  total           INTEGER NOT NULL DEFAULT 0,
  passed          INTEGER NOT NULL DEFAULT 0,
  failed          INTEGER NOT NULL DEFAULT 0,
  result          TEXT NOT NULL DEFAULT 'SKIP',  -- PASS / FAIL / SKIP
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_requests_run     ON run_requests(run_id);
CREATE INDEX IF NOT EXISTS idx_run_requests_suite   ON run_requests(suite_id);
```

**Enables:** "Show all requests returning 500", "Which endpoints fail most?", "Average response time per endpoint"

#### `run_assertions` — Individual assertion/test detail

```sql
CREATE TABLE IF NOT EXISTS run_assertions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      INTEGER NOT NULL REFERENCES run_requests(id) ON DELETE CASCADE,
  suite_id        INTEGER NOT NULL REFERENCES run_suites(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Assertion identity
  assertion_key   TEXT NOT NULL,            -- stable "{suite}|{request}|{name}" for trend matching
  assertion_name  TEXT NOT NULL,            -- full description from Bruno
  type            TEXT NOT NULL DEFAULT 'test',  -- 'test' | 'assertion' | 'script_error'
  -- Classification (from assertion catalog)
  category        TEXT,                     -- environment_check, http_status, content_type, etc.
  domain          TEXT,                     -- infrastructure, offer, booking, fulfillment, etc.
  offer_part      TEXT,                     -- admission, reservation, ancillary (if applicable)
  -- Result
  passed          INTEGER NOT NULL DEFAULT 0,  -- 0 or 1
  error_msg       TEXT,                     -- failure reason
  -- Value extraction (for parameterized assertions)
  expected_value  TEXT,                     -- extracted from assertion name
  actual_value    TEXT,                     -- extracted from assertion name
  parameterized   INTEGER NOT NULL DEFAULT 0,  -- 1 if assertion name contains dynamic values
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_run_assertions_run       ON run_assertions(run_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_request   ON run_assertions(request_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_company   ON run_assertions(company_id);
CREATE INDEX IF NOT EXISTS idx_run_assertions_key       ON run_assertions(company_id, assertion_key);
CREATE INDEX IF NOT EXISTS idx_run_assertions_category  ON run_assertions(company_id, category);
CREATE INDEX IF NOT EXISTS idx_run_assertions_domain    ON run_assertions(company_id, domain);
```

**Enables:** "All failing assertions across all runs", "Trend for specific assertion", "Most flaky assertions", "Filter by category/domain"

---

## 3. Assertion Classification

### 3.1 Categories (from Assertion Catalog)

| Category | Pattern | Example |
|----------|---------|---------|
| `environment_check` | API/library/data-file availability | "API base is available" |
| `http_status` | Status code validation | "GET /versions -> 200 OK" |
| `content_type` | MIME type check | "[OSDM] Content-Type is application/json" |
| `response_structure` | Field/array existence | "'offers' array exists with 1 offer(s)" |
| `field_validation` | Type/format checks | "offers[0].createdOn is a valid ISO datetime" |
| `business_logic` | Domain-specific rules | "Status is PREBOOKED for admission[0]" |
| `data_consistency` | Cross-entity matching | "admission refundable values match between offer and booking" |
| `prerequisite` | Dependency checks | "GET Products prerequisite: succeeded with valid body" |
| `script_error` | Script execution failures | "Post-Response Script Error" |
| `parameter_probe` | Parameter support detection | "Offer baseline request executed" |
| `scenario_config` | Version/config validation | "Scenario version used is 3.4, system is 3.8" |

### 3.2 OSDM Domains

| Domain | Scope |
|--------|-------|
| `infrastructure` | API availability, Content-Type, library/data checks |
| `system` | System info endpoints (versions, coaches, products, zones) |
| `offer` | Offer structure, trips, legs, offerParts, prices |
| `booking` | Booking structure, bookedOffers, prices |
| `fulfillment` | Fulfillment status, documents, bookingParts |
| `passenger` | Passenger PATCH/GET validations |
| `refund` | Refund offer/operation validations |
| `exchange` | Exchange offer/operation validations |

### 3.3 Classification Logic

The classification functions already exist in `gen_assertion_catalog.py` and need to be ported to JavaScript for use in OSCAR's runner (post-run processing):

```javascript
// src/reports/classifier.js — classify assertion name into category + domain
function classifyCategory(name) { ... }
function classifyDomain(name, suite) { ... }
function classifyOfferPart(name) { ... }
function isParameterized(name) { ... }
function extractExpected(name) { ... }
function extractActual(name) { ... }
```

---

## 4. Structured Message Format in Bruno

### 4.1 Current State

`bruTest()` produces:
```javascript
{ name: "assertion description", passed: true/false, error: "message or null" }
```

### 4.2 Proposed Enhancement

Enhance `bruTest()` to produce richer metadata without breaking existing behavior:

```javascript
{
  name: "assertion description",
  passed: true/false,
  error: "message or null",
  // New structured fields (optional — only set when assertions are structured)
  category: "http_status",           // auto-detected from name pattern
  domain: "offer",                   // auto-detected from context
  severity: "critical",              // critical | major | minor | info
  osdm_ref: "Offer.offerId",        // OSDM spec reference (manual annotation)
  expected: "200",                   // extracted from assertion
  actual: "401"                      // extracted from assertion
}
```

### 4.3 Backward Compatibility

- The `category`, `domain`, `severity`, `expected`, `actual` fields are **optional**
- If not set by the Bruno test, OSCAR's classifier fills them in during post-run processing
- Existing tests continue to work unchanged
- New tests can provide structured metadata for better accuracy

### 4.4 Severity Levels

| Severity | Meaning | Example |
|----------|---------|---------|
| `critical` | Test cannot proceed | HTTP 401, script error, missing prerequisite |
| `major` | Functional failure | Wrong status, missing field, incorrect value |
| `minor` | Non-functional issue | Content-Type mismatch, timing issue |
| `info` | Environment/config check | API base available, version check |

---

## 5. OSCAR Post-Run Processing

### 5.1 New Module: `src/reports/structureResults.js`

Called by `runner.js` after Bruno completes and artifacts are copied:

```javascript
function extractStructuredResults(runId, companyId) {
  // 1. Read .bru_results.json from data/artifacts/{runId}/
  // 2. For each request entry:
  //    a. Create run_suites row (grouped by path segment)
  //    b. Create run_requests row (HTTP method, URL, status, duration)
  //    c. For each test/assertion:
  //       - Classify: category, domain, offer_part
  //       - Detect parameterization
  //       - Extract expected/actual values
  //       - Create run_assertions row
  // 3. Compute rollup counts (total, passed, failed, pass_rate) for suites and requests
  // 4. Batch-insert in a single transaction
  // 5. Return summary stats
}
```

### 5.2 Integration Point in runner.js

After line ~346 (JSON artifact copy), before status update:

```javascript
try {
  const { extractStructuredResults } = require('../reports/structureResults');
  const stats = extractStructuredResults(runId, companyRow.id);
  logEvent(runId, 'info', `[runner] Stored ${stats.assertions} assertions across ${stats.suites} suites.`);
} catch (err) {
  logEvent(runId, 'error', `[runner] Failed to store structured results: ${err.message}`);
}
```

---

## 6. API Endpoints

### 6.1 Assertion Results per Run

```
GET /v1/runs/:id/assertions
```

Query params: `status=passed|failed`, `category=http_status`, `domain=offer`, `suite=name`

Returns 3-level nested structure:
```json
{
  "run_id": "uuid",
  "summary": { "total": 445, "passed": 380, "failed": 65 },
  "suites": [
    {
      "suite_name": "01-System Infos Requests",
      "total": 58, "passed": 52, "failed": 6, "pass_rate": 89.7,
      "requests": [
        {
          "request_name": "00. GET System Version Check",
          "http_method": "GET", "http_status": 200, "duration_ms": 234,
          "assertions": [
            {
              "assertion_name": "GET /versions -> 200 OK",
              "passed": true, "category": "http_status", "domain": "system"
            }
          ]
        }
      ]
    }
  ]
}
```

### 6.2 Assertion Trends

```
GET /v1/reports/trends?assertion_key=...&limit=20
```

Returns last N pass/fail results for a specific assertion across runs.

### 6.3 Trend Summary

```
GET /v1/reports/trends/summary
```

Returns top-20 most-failing assertions with fail rate, filtered by company.

### 6.4 Report Configuration (Certifiers)

```
POST /v1/reports/configured
{
  "run_ids": ["uuid1", "uuid2"],
  "filters": {
    "categories": ["http_status", "business_logic"],
    "domains": ["offer", "booking", "fulfillment"],
    "status": "failed",
    "severity": ["critical", "major"]
  },
  "format": "html"  // or "json" or "pdf"
}
```

Returns a filtered report containing only assertions matching the criteria.

---

## 7. Certifier Report Configuration UI

### 7.1 Report Builder Page

A new page (`/report-builder.html`) accessible to `certification_user` and `administrator`:

```
+------------------------------------------------------------------+
| REPORT BUILDER                                                    |
|                                                                   |
| Select Runs:                                                      |
| [x] Bileto — 2026-04-15 10:30 (7 scenarios)                     |
| [x] Sqills — 2026-04-15 11:00 (8 scenarios)                     |
| [ ] Turnit — 2026-04-14 09:00 (5 scenarios)                     |
|                                                                   |
| Filter by Category:                                               |
| [x] HTTP Status  [x] Business Logic  [ ] Environment Check       |
| [x] Response Structure  [x] Field Validation  [ ] Content Type   |
| [x] Data Consistency  [ ] Prerequisite  [ ] Script Error         |
|                                                                   |
| Filter by OSDM Domain:                                            |
| [x] Offer  [x] Booking  [x] Fulfillment                        |
| [x] Refund  [x] Exchange  [ ] System  [ ] Infrastructure        |
| [ ] Passenger                                                     |
|                                                                   |
| Filter by Status:                                                 |
| (*) All  ( ) Failed only  ( ) Passed only                       |
|                                                                   |
| Filter by Severity:                                               |
| [x] Critical  [x] Major  [ ] Minor  [ ] Info                    |
|                                                                   |
| [Generate Report]  [Export CSV]  [Export PDF]                    |
+------------------------------------------------------------------+
```

### 7.2 Generated Report View

The generated report shows a filtered, structured view:

```
+------------------------------------------------------------------+
| OSDM CONFORMANCE REPORT                                          |
| Company: Bileto SandBox                                          |
| Run: 2026-04-15 10:30 — 7 scenarios                             |
| Filters: Domains=Offer,Booking | Categories=HTTP,Business Logic  |
|                                                                   |
| SUMMARY                                                          |
| Total assertions: 245  Passed: 210  Failed: 35  Pass rate: 85.7% |
|                                                                   |
| BY DOMAIN                                                         |
| Offer:       120 assertions  95 passed  25 failed  (79.2%)      |
| Booking:      85 assertions  80 passed   5 failed  (94.1%)      |
| Fulfillment:  40 assertions  35 passed   5 failed  (87.5%)      |
|                                                                   |
| FAILED ASSERTIONS (sorted by severity)                           |
| CRITICAL:                                                         |
|   booking.fulfillmentStatus 'null' is a valid FulfillmentSummary |
|     → Expected: FULFILLED  Actual: null                          |
|     → Domain: booking  Category: field_validation                |
|     → Runs affected: 5/7  First seen: 2026-04-10                |
| MAJOR:                                                            |
|   provisionalPrice.currency matches confirmedPrice.currency      |
|     → Expected: CZK  Actual: EUR                                |
|     → Domain: booking  Category: data_consistency                |
|     → Runs affected: 3/7  First seen: 2026-04-12                |
+------------------------------------------------------------------+
```

---

## 8. Implementation Plan

### Phase 1: Database Schema + Post-Run Extraction (3-4 days)

| # | Task | Files |
|---|------|-------|
| 1 | Create `run_suites`, `run_requests`, `run_assertions` tables | `schema.sql`, `db.js` |
| 2 | Create `src/reports/classifier.js` (port from Python) | New file |
| 3 | Create `src/reports/structureResults.js` (extraction module) | New file |
| 4 | Wire extraction into `runner.js` (post-run) | `runner.js` |
| 5 | Backfill existing completed runs | Migration script |

### Phase 2: API Endpoints + Run Detail UI (2-3 days)

| # | Task | Files |
|---|------|-------|
| 6 | `GET /v1/runs/:id/assertions` — 3-level nested response | `runs.js` |
| 7 | `GET /v1/reports/trends` — per-assertion history | `reports.js` |
| 8 | `GET /v1/reports/trends/summary` — top failing assertions | `reports.js` |
| 9 | Assertions section on `run-detail.html` — filterable table | `run-detail.html` |
| 10 | Trend sparklines per assertion | `run-detail.html` |

### Phase 3: Enhanced Log Structure (1-2 days)

| # | Task | Files |
|---|------|-------|
| 11 | Add `category`, `phase`, `suite_name`, `request_name` to `run_events` | `db.js` migration |
| 12 | Create `LogParser` class for Bruno stdout parsing | `runner.js` or new file |
| 13 | Enhanced `GET /v1/runs/:id/logs` with category/phase filters | `runs.js` |
| 14 | Log filtering UI on `run-detail.html` | `run-detail.html` |

### Phase 4: Certifier Report Builder (3-4 days)

| # | Task | Files |
|---|------|-------|
| 15 | `POST /v1/reports/configured` — filtered report generation | `reports.js` |
| 16 | Report configuration storage | `schema.sql` (new table) |
| 17 | Report builder page (`/report-builder.html`) | New file |
| 18 | Export: HTML, CSV, PDF | `reports.js` |
| 19 | Saved report templates (certifier can save/reuse configurations) | `reports.js`, UI |

### Phase 5: Bruno Message Enhancement (2 days)

| # | Task | Files |
|---|------|-------|
| 20 | Enhance `bruTest()` to accept structured metadata | `testCapture.js` |
| 21 | Add `severity` and `osdm_ref` to key assertions in Bruno library | `offers.js`, `bookings.js`, etc. |
| 22 | Update `appendRequest()` to pass structured fields | `reportGenerator.js` |

---

## 9. Files Affected

### OSCAR Server (oscar-server repo)

| File | Changes |
|------|---------|
| `src/db/schema.sql` | New tables: run_suites, run_requests, run_assertions |
| `src/db/db.js` | Migrations for new tables + run_events columns |
| `src/reports/classifier.js` | NEW — assertion classification functions |
| `src/reports/structureResults.js` | NEW — post-run extraction module |
| `src/reports/diff.js` | Update to use assertion IDs from DB |
| `src/worker/runner.js` | Wire extraction + log parser |
| `src/api/routes/runs.js` | New assertions endpoint + enhanced logs |
| `src/api/routes/reports.js` | Trend endpoints + configured report |
| `public/run-detail.html` | Assertions section + log filtering |
| `public/report-builder.html` | NEW — certifier report builder |
| `public/nav.js` | Add Report Builder to certifier menu |

### Bruno Collection (OSDM-testing repo)

| File | Changes |
|------|---------|
| `library-bruno/testCapture.js` | Enhanced bruTest() with optional metadata |
| `library-bruno/reportGenerator.js` | Pass structured fields through |
| `library-bruno/offers.js` | Add severity/osdm_ref to key assertions |
| `library-bruno/bookings.js` | Add severity/osdm_ref to key assertions |
| `library-bruno/fulfillments.js` | Add severity/osdm_ref to key assertions |
| `library-bruno/refunds.js` | Add severity/osdm_ref to key assertions |
| `library-bruno/exchanges.js` | Add severity/osdm_ref to key assertions |

---

## 10. Assertion Catalog Reference

The Excel file `OSCAR_Assertion_Catalog.xlsx` contains 445 assertions from a real Bileto run, classified across:

- **11 categories** — from environment_check to scenario_config
- **8 OSDM domains** — from infrastructure to exchange
- **Offer part types** — admission, reservation, ancillary
- **Parameterization** — 60% of assertions contain dynamic values (UUIDs, dates, amounts)

This catalog serves as the reference for:
1. Building the `classifier.js` functions
2. Validating that the DB schema captures all necessary dimensions
3. Designing the certifier report filters

---

## 11. Design Decisions

| # | Question | Decision |
|---|----------|----------|
| 1 | Assertion severity | **Auto-detect** based on category and assertion context. No manual annotation needed. |
| 2 | Certifier report templates | **Yes** — certifiers can save and reuse filter configurations via `report_templates` table. |
| 3 | Report export formats | **HTML first.** CSV as secondary. PDF deferred to future release. |
| 4 | Existing run backfill | **No backfill.** Existing runs will be deleted before deployment. Clean slate. |
| 5 | Structured log storage | **Replace** existing `run_events` table with enhanced columns (category, phase, suite_name, request_name). Single table, not separate. |
