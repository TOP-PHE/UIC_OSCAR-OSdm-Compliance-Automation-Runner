# OSCAR — Concurrent Sessions Management Feature

**Date:** 2026-04-11
**Status:** Design complete, implementation pending
**Target:** Linux production server (Windows remains single-run)

## License and Copyright
This document is the property of UIC (Union Internationale des Chemins de fer)

"This material is copyrighted by UIC, Union Internationale des Chemins de fer (c) 2026 OSDM is a trademark belonging to UIC, and any use of this trademark is strictly prohibited unless otherwise agreed by UIC."

---

## 1. Objective

Enable multiple test scenarios to run **in parallel** for the same company and/or user, while maintaining full execution isolation and respecting a configurable concurrency limit.

### Current State
- `MAX_CONCURRENT_RUNS=1` — global limit, only one Bruno process runs at a time across the entire server
- All scenarios run **sequentially** within a single `bru run` invocation via a loopback mechanism
- A run with 5 scenarios takes the **sum** of all 5 execution times

### Target State
- Each scenario runs as an **independent Bruno process** in its own isolated workspace
- Multiple scenarios execute **in parallel**, limited by a per-company `concurrent_session_limit`
- A run with 5 scenarios takes the time of the **longest single scenario** (not the sum)
- Queue holds excess runs until a slot opens (never refuses, always waits)
- Users can see their position in the company queue in real-time

---

## 2. Architecture

### 2.1 Current Flow (Sequential)

```
User clicks "Run" (5 scenarios selected)
  --> 1 run record created (status: QUEUED)
  --> 1 Bruno process spawned
  --> Bruno loops: scenario 0 --> 1 --> 2 --> 3 --> 4 --> stop
  --> 1 .bru_results.json (all 5 scenarios merged)
  --> 5 HTML reports (one per scenario)
  --> Total time: sum of all 5 scenarios
```

### 2.2 Target Flow (Parallel)

```
User clicks "Run All in Parallel" (5 scenarios selected)
  --> 5 run records created (batch_id groups them, each has scenario_code)
  --> Queue manages concurrency (e.g. 3 slots for this company)
  --> 3 Bruno processes start immediately, 2 wait in queue
  --> Each process runs in its own workspace (symlinked collection)
  --> As slots free up, queued runs start
  --> Each produces its own .bru_results.json + HTML report
  --> Total time: longest single scenario
```

### 2.3 Run-Scoped Workspace (Linux)

Each run gets an isolated working directory with symlinks to the shared collection:

```
data/workspaces/
  {runId}/                              <-- temporary per-run workspace
    environments/
      OTST_{slug}_Env.yml               <-- this run's env file (unique, real file)
    Validation_Reports/                 <-- this run's output (real directory)
      .bru_results.json
      {date}_{env}_{scenario}_Report.html
    library-bruno/      --> symlink     <-- points to shared collection
    00-Access Token/    --> symlink
    01-System Infos Requests/ --> symlink
    02-Common Requests/ --> symlink
    03-Refund/          --> symlink
    04-Exchange/        --> symlink
    opencollection.yml  --> copy        <-- small file, copied not symlinked
```

**Why symlinks?**
- Zero disk duplication — the Bruno test collection (read-only) is shared
- Only env files + output reports are real files (~100KB per workspace)
- Clean cleanup: `rm -rf data/workspaces/{runId}/` removes everything
- No collision: each Bruno process writes to its own isolated directories

**Platform note:** This approach uses Linux symlinks (`fs.symlinkSync(target, path, 'dir')`). On Windows, the system remains single-run (`MAX_CONCURRENT_RUNS=1`) with the current non-isolated approach.

### 2.4 Scenario Override Mechanism

Currently, `scenarioParser.js` reads `scenariosToRun` from the datafile and uses `scenariosToRunIndex` to cycle through them. For parallel execution, each Bruno process must run **exactly one scenario**.

**Solution:** Add a `scenario_override` environment variable that takes priority over the datafile:

```javascript
// In scenarioParser.js parseScenarioData():
const override = bru.getEnvVar('scenario_override');
if (override) {
  effectiveList = [override];  // run only this one scenario
  idx = 0;
}
```

The runner injects this into the ephemeral env YAML:

```yaml
variables:
  - name: scenario_override
    value: "OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG"
```

**Benefits:**
- Shared datafile stays untouched (all scenario definitions remain available)
- Each Bruno process naturally stops after one scenario (list has 1 item)
- Backward compatible: no `scenario_override` = run all sequentially (existing behavior)

---

## 3. Data Model

### 3.1 Database Changes

```sql
-- New columns on runs table
ALTER TABLE runs ADD COLUMN batch_id TEXT;        -- groups related parallel runs
ALTER TABLE runs ADD COLUMN scenario_code TEXT;   -- which specific scenario this run executes

-- Index for batch queries
CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id);
```

### 3.2 Concurrent Session Limit

Stored in the existing `test_frameworks.config` JSON blob (per-company):

```json
{
  "osdmVersion": "3.8",
  "concurrentSessionLimit": 3,
  "salesFlows": ["SALE", "REFUND", "EXCHANGE"],
  ...
}
```

- **Default:** `1` (current behavior — one run at a time)
- **Maximum:** Configurable, recommended 5-10 depending on server capacity
- **Scope:** Per company, applies across all users of that company
- **Enforcement:** Queue checks active runs per company before starting a new job

### 3.3 Batch Run Example

When a user submits a parallel run with 5 scenarios and `concurrentSessionLimit = 3`:

```
batch_id: "b-uuid-123"

Run 1: scenario_code="OTST_RFND_PATCH_1ADT_1LEG"   status=RUNNING   (slot 1/3)
Run 2: scenario_code="OTST_RFND_DEL_1ADT_1LEG"     status=RUNNING   (slot 2/3)
Run 3: scenario_code="OTST_EXCH_1ADT_1LEG"         status=RUNNING   (slot 3/3)
Run 4: scenario_code="OTST_SALE_1ADT_1LEG"         status=QUEUED    (waiting for slot)
Run 5: scenario_code="OTST_RFND_2ADT_1LEG"         status=QUEUED    (waiting for slot)
```

When Run 1 completes, Run 4 starts automatically. When Run 2 completes, Run 5 starts.

---

## 4. Queue Design

### 4.1 Enhanced Queue Logic

```javascript
_drain() {
  // Global server limit
  if (this._running >= this._maxGlobal) return;

  // Find next job whose company hasn't hit its concurrent limit
  const jobIdx = this._queue.findIndex(job => {
    const companyRunning = this._countRunningForCompany(job.companyId);
    return companyRunning < job.concurrentLimit;
  });

  if (jobIdx === -1) return;  // all queued jobs at their company limit -- wait

  const job = this._queue.splice(jobIdx, 1)[0];  // pick that job (priority-aware)
  this._running++;
  this._runningByCompany.set(job.companyId, 
    (this._runningByCompany.get(job.companyId) || 0) + 1);

  // ... execute job ...
  // On completion: decrement company counter, call _drain() again
}
```

**Key behaviors:**
- Jobs are **never refused** — they stay in queue until a slot opens
- A company at its limit doesn't block other companies
- FIFO within the same company, but companies are interleaved fairly
- When a job completes, `_drain()` picks the next eligible job

### 4.2 Queue State Tracking

The queue maintains:
- `_queue[]` — pending jobs (FIFO array)
- `_running` — total active jobs (global counter)
- `_runningByCompany` — Map of companyId to active job count
- `_maxGlobal` — server-wide max (from `MAX_CONCURRENT_RUNS` env var)

---

## 5. API Changes

### 5.1 Run Submission (Enhanced)

```
POST /v1/runs
```

**New request body fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `parallel` | boolean | `false` | If true, create one run per scenario in `scenariosToRun` |
| `scenarios` | string[] | all from datafile | Optional: specific scenario codes to run (subset of datafile) |

**Parallel submission flow:**
1. Read `scenariosToRun` from the company's datafile (or use `scenarios` from request body)
2. Read `concurrentSessionLimit` from the company's test framework config
3. Generate `batch_id = uuid()`
4. For each scenario: create a run record with `batch_id`, `scenario_code`, `status = 'QUEUED'`
5. Enqueue all jobs with `{ runId, companyId, scenarioOverride, concurrentLimit }`
6. Return `{ batch_id, runs: [{id, scenario_code, status}, ...] }`

**Sequential submission (unchanged):**
When `parallel = false` (default), behavior is identical to current: one run, one Bruno process, all scenarios via loopback.

### 5.2 Queue Status (New)

```
GET /v1/runs/queue-status
```

Returns the current queue state for the authenticated user's company:

```json
{
  "company_id": "uuid",
  "concurrent_limit": 3,
  "slots_used": 2,
  "slots_available": 1,
  "runs": [
    {
      "id": "run-uuid-1",
      "scenario_code": "OTST_RFND_PATCH_1ADT_1LEG",
      "status": "RUNNING",
      "user_email": "patrick@company.com",
      "is_current_user": true,
      "position": null,
      "started_at": "2026-04-11T14:30:00Z"
    },
    {
      "id": "run-uuid-2",
      "scenario_code": "OTST_EXCH_1ADT_1LEG",
      "status": "RUNNING",
      "user_email": "jean@company.com",
      "is_current_user": false,
      "position": null,
      "started_at": "2026-04-11T14:30:05Z"
    },
    {
      "id": "run-uuid-3",
      "scenario_code": "OTST_SALE_1ADT_1LEG",
      "status": "QUEUED",
      "user_email": "patrick@company.com",
      "is_current_user": true,
      "position": 1,
      "queued_at": "2026-04-11T14:30:10Z"
    }
  ]
}
```

### 5.3 Batch Status (New)

```
GET /v1/runs/batch/:batchId
```

Returns all runs in a batch with aggregated status:

```json
{
  "batch_id": "batch-uuid",
  "total": 5,
  "completed": 3,
  "running": 1,
  "queued": 1,
  "failed": 0,
  "runs": [ ... ]
}
```

---

## 6. UI Changes

### 6.1 Test Framework Config (scenarios.html)

Add a `Concurrent Session Limit` field in the framework configuration section:

```
+--------------------------------------------------+
| CONCURRENT SESSION LIMIT                          |
|                                                   |
|   Maximum parallel runs per company: [___3___]    |
|   (applies across all users of this company)      |
+--------------------------------------------------+
```

- Numeric input, min 1, max 10
- Stored in `test_frameworks.config.concurrentSessionLimit`
- Default: 1

### 6.2 Run Launch Page (run.html)

Add execution mode selector and queue status panel:

```
+--------------------------------------------------+
| EXECUTION MODE                                    |
|                                                   |
|   ( ) Sequential — run all scenarios one by one   |
|   (*) Parallel — run each scenario independently  |
|                                                   |
|   [>>> Start Run]                                 |
+--------------------------------------------------+

+--------------------------------------------------+
| COMPANY QUEUE (Benerail)          2/3 slots used  |
|                                                   |
|  # | Scenario                   | User    | Status|
|  --+----------------------------+---------+-------|
|  1 | OTST_RFND_PATCH_1ADT_1LEG | you *   | RUN   |
|  2 | OTST_EXCH_1ADT_1LEG       | jean@.. | RUN   |
|  3 | OTST_RFND_DEL_1ADT_1LEG   | you *   | QUEUE |
|  4 | OTST_SALE_1ADT_2LEG       | marc@.. | QUEUE |
|                                                   |
| Your runs: 2 (1 running, 1 queued at position #3) |
+--------------------------------------------------+
```

- **Execution mode** — radio buttons (sequential is default for backward compatibility)
- **Queue panel** — live-updated every 3 seconds via `GET /v1/runs/queue-status`
- **Current user highlighted** — "you *" badge and distinct row color
- **Slot usage bar** — visual indicator of concurrent limit usage

### 6.3 Dashboard (dashboard.html)

Batch runs grouped visually:

```
+--------------------------------------------------+
| BATCH: 2026-04-11 14:30 (5 scenarios)    [3/5 OK]|
|   OTST_RFND_PATCH_1ADT_1LEG     COMPLETED   42s  |
|   OTST_RFND_DEL_1ADT_1LEG       COMPLETED   38s  |
|   OTST_EXCH_1ADT_1LEG           COMPLETED   55s  |
|   OTST_SALE_1ADT_1LEG           RUNNING...        |
|   OTST_RFND_2ADT_1LEG           QUEUED      #2   |
+--------------------------------------------------+
```

- Runs with the same `batch_id` are grouped under a collapsible header
- Header shows batch summary (date, scenario count, completion ratio)
- Individual scenarios show their status, duration, and queue position
- Non-batched runs (sequential) appear as individual rows (current behavior)

---

## 7. Runner Changes (runner.js)

### 7.1 Workspace Setup

```javascript
async function createWorkspace(runId) {
  const workspaceDir = path.join(WORKSPACES_DIR, runId);
  fs.mkdirSync(workspaceDir, { recursive: true });
  
  // Create real directories for write targets
  fs.mkdirSync(path.join(workspaceDir, 'environments'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'Validation_Reports'), { recursive: true });
  
  // Symlink read-only collection folders
  const collectionItems = [
    '00-Access Token', '01-System Infos Requests', '02-Common Requests',
    '03-Refund', '04-Exchange', 'library-bruno'
  ];
  for (const item of collectionItems) {
    const target = path.join(COLLECTION_PATH, item);
    if (fs.existsSync(target)) {
      fs.symlinkSync(target, path.join(workspaceDir, item), 'dir');
    }
  }
  
  // Copy small files (opencollection.yml)
  fs.copyFileSync(
    path.join(COLLECTION_PATH, 'opencollection.yml'),
    path.join(workspaceDir, 'opencollection.yml')
  );
  
  return workspaceDir;
}
```

### 7.2 Workspace Cleanup

```javascript
async function cleanupWorkspace(runId) {
  const workspaceDir = path.join(WORKSPACES_DIR, runId);
  try {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[runner] Failed to clean workspace ${runId}: ${err.message}`);
  }
}
```

### 7.3 Modified executeRun

Key changes:
- Create workspace before spawning Bruno
- Write env file to `workspace/environments/` instead of `COLLECTION_PATH/environments/`
- Spawn Bruno with `cwd: workspaceDir` instead of `cwd: COLLECTION_PATH`
- Read results from `workspace/Validation_Reports/` instead of shared directory
- If `scenarioOverride` is set, add it to the env YAML
- Cleanup workspace after artifacts are copied

---

## 8. Bruno Collection Changes (scenarioParser.js)

### 8.1 Scenario Override

One small change at the top of `parseScenarioData()`:

```javascript
// If scenario_override is set (parallel execution mode),
// run only this specific scenario instead of the full list
const override = bru.getEnvVar('scenario_override');
if (override) {
  effectiveList = [override];
  idx = 0;
  bru.setEnvVar('scenariosToRunIndex', '1');  // will stop after this one
  validationLogger(`[INFO] Parallel mode — running only: ${override}`);
}
```

This is the **only change** needed in the Bruno collection. Everything else (scenario parsing, offer request building, test execution, report generation) works unchanged.

---

## 9. Provider Rate Limiting Protection

### 9.1 Stagger Delay

When launching multiple parallel runs, add an optional delay between starts to avoid overwhelming the provider API:

```javascript
// In queue._drain(), when starting a batch job:
const staggerMs = parseInt(process.env.PARALLEL_STAGGER_MS || '2000', 10);
if (job.batchId) {
  const batchRunning = this._countRunningForBatch(job.batchId);
  if (batchRunning > 0) {
    setTimeout(() => this._startJob(job), staggerMs * batchRunning);
    return;
  }
}
```

**Default:** 2 seconds between launches within the same batch.
**Configurable:** via `PARALLEL_STAGGER_MS` environment variable.

### 9.2 Circuit Breaker (Future)

If multiple parallel runs all fail with 429 (Too Many Requests) or 503 (Service Unavailable), the queue could automatically:
- Pause remaining queued runs for that company
- Wait for a cooldown period
- Resume with reduced concurrency

This is a **future enhancement** — not needed for initial implementation.

---

## 10. Implementation Backlog

### Phase 1 — Foundation (estimated: 2-3 days)

| # | Task | Scope | Files |
|---|------|-------|-------|
| 1 | Add `concurrent_session_limit` to test framework config | DB config | `scenarios.html` (framework section) |
| 2 | Add `concurrent_session_limit` UI field in framework section | Frontend | `scenarios.html` |
| 3 | Add `batch_id` and `scenario_code` columns to runs table | Schema | `db.js` (migration) |
| 4 | Add `scenario_override` env var support in scenarioParser | Bruno | `scenarioParser.js` |
| 5 | Implement run-scoped workspace (create/cleanup) | Runner | `runner.js` |

### Phase 2 — Parallel Execution (estimated: 2-3 days)

| # | Task | Scope | Files |
|---|------|-------|-------|
| 6 | Enhance queue with per-company concurrency tracking | Queue | `queue.js` |
| 7 | Add parallel run submission API (POST /v1/runs with parallel flag) | API | `runs.js` |
| 8 | Add queue status API (GET /v1/runs/queue-status) | API | `runs.js` |
| 9 | Add batch status API (GET /v1/runs/batch/:batchId) | API | `runs.js` |

### Phase 3 — UI (estimated: 2-3 days)

| # | Task | Scope | Files |
|---|------|-------|-------|
| 10 | Add "Run All in Parallel" option to run page | Frontend | `run.html` |
| 11 | Add company queue status panel to run page | Frontend | `run.html` |
| 12 | Update dashboard to group runs by batch_id | Frontend | `dashboard.html` |

### Phase 4 — Polish (estimated: 1 day)

| # | Task | Scope | Files |
|---|------|-------|-------|
| 13 | Add stagger delay between parallel launches | Queue | `queue.js` |
| 14 | Add batch completion notification in run-detail | Frontend | `run-detail.html` |
| 15 | Update specification document | Docs | `oscar_dev_docs/` |

---

## 11. Backward Compatibility

| Concern | Handled? | How |
|---------|----------|-----|
| Existing sequential runs | Yes | `parallel: false` (default) preserves current behavior |
| Single-user mode | Yes | `concurrent_session_limit = 1` (default) = one run at a time |
| Windows | Yes | Remains single-run, no workspace isolation |
| Old datafiles without `offerSearchCriteria` | Yes | Parser applies defaults for legacy scenarios |
| Bruno collection | Yes | Only 1 small change (scenario_override check) — existing loopback works unchanged |
| Dashboard | Yes | Non-batched runs appear as individual rows (current behavior) |
| API | Yes | POST /v1/runs without `parallel` flag works exactly as before |

---

## 12. Configuration Reference

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MAX_CONCURRENT_RUNS` | `1` | Global server-wide max concurrent Bruno processes |
| `PARALLEL_STAGGER_MS` | `2000` | Delay (ms) between parallel launches within a batch |

| Framework Config Field | Default | Description |
|----------------------|---------|-------------|
| `concurrentSessionLimit` | `1` | Max parallel runs for this company (across all users) |

---

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Provider rate limiting | 429 errors on parallel requests | Stagger delay (2s default), circuit breaker (future) |
| Server resource exhaustion | CPU/memory overload with many concurrent Bruno processes | Global `MAX_CONCURRENT_RUNS` cap |
| Disk space for workspaces | Accumulation if cleanup fails | Workspace cleaned after each run; periodic cleanup cron job |
| Symlink permission issues | Workspace creation fails | Fallback: copy instead of symlink (larger disk usage) |
| Concurrent credential rotation | Token changes mid-batch | Each run decrypts credentials at start — all runs in a batch use the same snapshot |
| Database lock contention (SQLite) | WAL mode should handle concurrent writes | Monitor; switch to PostgreSQL if needed at scale |
