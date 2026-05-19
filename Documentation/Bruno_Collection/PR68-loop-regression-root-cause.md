# PR #68 — Loop Regression Root-Cause Analysis

**Status:** Fixed by `server-v1.11.10` / `release-2026.38`
**Branch:** `hotfix/v1.11.10-pr68-loop-regression`
**Author of this analysis:** Audit triggered on 2026-05-19 from log
`run-d96e282e-logs.txt` (Sqills sandbox, 1-scenario run).
**Audience:** the developer who authored PR #68 (`V2.0.2 — HOTFIX — Merge
Bruno Lib from Old repo`) and anyone who'll touch the
`opencollection.yml` unitary-load wrapper next.

The intent of this document is **not** to assign blame. PR #68 was a
large merge from an older fork; the underlying interaction between the
new wrapper and the legacy multi-scenario terminal-stop machinery is
subtle and easy to miss. The intent is to give the next person enough
information to (a) understand why the fix looks the way it does, and
(b) safely re-introduce the "Bruno-UI single Send" affordances PR #68
was trying to add, without re-breaking OSCAR.

---

## 1. What the operator saw

> *"Running on sqills I realised it is slow as the scenario is run
> multiple time… a sort of loop introduced by PR68. With the last PR
> solving the reporting issues, open report is working again, but I
> cannot dowload anymore the report json file, only the logs."*

Three apparent symptoms, one root cause:

| Symptom | Explained by |
|---|---|
| Same scenario re-executed many times | Infinite loop-back; terminal `stopExecution()` never reached |
| Run very slow vs. the PR #69 baseline | Each loop iteration re-downloads the data file from `/data/<vendor>-datafile.json` and replays the full request chain |
| `.bru_results_<runId>.json` download missing while HTML report works | Bruno CLI killed by `RUN_TIMEOUT_MS` SIGTERM; its `--reporter-json` writer never reached end-of-run flush. `reportGenerator.js` writes HTML incrementally per assertion, so the partial HTML survives |

A fourth symptom — Bileto `POST /api/offers` returning HTTP 500 — is
**unrelated** to PR #68. It is an upstream failure at
`osdm-5.platform.bileto.zone` (generic Spring Boot 500 body, ~42 s
upstream latency). PR #71's report-side fix was prompted by that 500,
not the cause of it.

---

## 2. Evidence from `run-d96e282e-logs.txt`

The run is a single-scenario run:
`OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG` against `sqills-sandbox`,
started 18:45:12, manually cancelled 18:48:37 (≈ 3 min 25 s).

```
[18:45:12] [runner] Ephemeral env file written → OTST_sqills-sandbox_d96e282e_Env.yml
           (scenario_override: OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG)
[18:45:14] [INFO] ⚡ Parallel mode — running only: OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG
[18:45:14] [INFO] 🎯 scenariosToRun [1/1]: selected "OTST_RFND_PATCH_..." — last in list, run will stop after this scenario
```

Then, instead of stopping after this scenario, the log shows:

| `grep -c …` | Pattern | Count |
|---:|---|---:|
| 1 | `scenariosToRun [1/1]: selected …` | **27** |
| 2 | `📋 Scenario selected` | 54 (27 × 2 — one from `/versions`, one from wrapper) |
| 3 | `🔄 REFUND+PATCH complete — looping to [1/1]` | **26** |
| 4 | `🔄 Loading scenario for unitary run` | **27** |
| 5 | `↩ scenariosToRunIndex was at/past end of __scenariosList — clamped to 0 before unitary load` (PR #70) | 27 |
| 6 | `↩ Same scenario detected … preserving accumulated report data` (PR #71) | 26 |
| 7 | `All scenarios attempted — run finished` / `stopExecution` | **0** |

Rows 1, 3 and 7 are the smoking gun: 27 iterations of a one-entry
list, and **the explicit stop branch (row 7) is never reached**.

Rows 4, 5 and 6 show PR #70 and PR #71's fixes firing exactly as
designed — they just don't address the loop.

---

## 3. The terminal-stop contract (pre-PR #68 design, still in force)

Each terminal `.bru` step in a scenario family ends with a near-
identical block. Example from
`Bruno_Collection/03-Refund/14. GET Booking after Patch Refund.yml`,
lines 66–75:

```js
// ── Multi-scenario: loop to next scenario or truly stop ────────────────
const _scList    = JSON.parse(bru.getEnvVar('__scenariosList') || '[]');
const _scNextIdx = parseInt(bru.getEnvVar('scenariosToRunIndex') || '0', 10);
if (_scList.length > 0 && _scNextIdx < _scList.length) {
  console.log('🔄 REFUND+PATCH complete — looping to [' + (_scNextIdx + 1) + '/' + _scList.length + ']: ' + _scList[_scNextIdx]);
  bru.setEnvVar('__loopback', 'true');
  bru.runner.setNextRequest('01. POST Get Offer');
} else {
  console.log('✅ All scenarios complete — run finished');
  bru.runner.stopExecution();
}
```

The same pattern lives in `library-bruno/loopback.js` and is used by
mid-scenario failure short-circuits (HTTP error / JSON parse error).

**The contract is:** `scenariosToRunIndex` is monotonically advanced
by `parseScenarioData()` until it reaches `__scenariosList.length`,
at which point the terminal step sees `_scNextIdx >= _scList.length`
and calls `stopExecution()`. Anything that wraps the index back to a
value strictly less than `length` after the last scenario has been
consumed breaks that contract.

---

## 4. What PR #68 changed

Two large additions in
`Bruno_Collection/opencollection.yml`'s collection-level
`request:` pre-script:

1. **Unitary-load wrapper**: detects whether the current request is
   the scenario start (`/versions` or "System version check"), and if
   not, calls `getScenarioData()` to load a scenario on demand. The
   goal — explicitly stated in the comments — is to let a Bruno-UI
   user "Send" a single `.bru` file outside an OSCAR collection run
   and still have the scenario context populated.

2. **State-tracking variables** `__unitaryLoadedIdx` and
   `__unitaryLoadedTarget`, used to decide whether to reload:

   ```js
   const _needsLoad = !bru.getEnvVar('scenarioCode')
     || (_targetNow !== '' && _targetNow !== _lastUnitaryTarget)
     || (_targetNow === '' && _lastUnitaryIdx !== _idxNow);
   ```

The third clause (`_lastUnitaryIdx !== _idxNow`) is where the trouble
starts. In an OSCAR collection run:

- `/versions` runs first. It invokes `parseScenarioData()` directly
  (not via the wrapper, because `_isScenarioStartLocal === true`).
  `parseScenarioData()` consumes index 0, advances
  `scenariosToRunIndex` to `'1'`, and sets `scenarioCode`.
  **It does not touch `__unitaryLoadedIdx`.**
- Request #2 (`01. POST Get Offer`) fires. The wrapper sees:
  - `scenarioCode` is set (so clause 1 is false)
  - `_targetNow === ''` (no `scenarioTarget` in OSCAR mode)
  - `_lastUnitaryIdx === undefined`, `_idxNow === '1'` →
    `undefined !== '1'` → clause 3 is **true**
- `_needsLoad === true` → the wrapper calls `getScenarioData()`,
  which calls `parseScenarioData()` a **second** time.

For a 1-scenario list, on this second call `parseScenarioData()`
sees `idx (1) >= effectiveList.length (1)`, which is the "all
scenarios attempted" branch — its original behaviour was to call
`bru.runner.stopExecution()` immediately. That is the silent-truncate
symptom PR #70 was authored to fix.

PR #70 added a clamp inside the wrapper, **before** the
`getScenarioData()` call, that resets `scenariosToRunIndex` to `'0'`
when `idx >= __scenariosList.length`. That defused the immediate
halt: `getScenarioData()` now reads `'0'`, picks scenario[0] again,
and advances back to `'1'`.

But PR #68 also has, in the wrapper's post-load block (sequential
mode), this:

```js
const _scList = JSON.parse(bru.getEnvVar('__scenariosList') || '[]');
const _nextIdx = parseInt(bru.getEnvVar('scenariosToRunIndex') || '0', 10);
if (_scList.length > 0 && _nextIdx >= _scList.length) {
  bru.setEnvVar('scenariosToRunIndex', '0');
  console.log('[INFO] 🔁 Last scenario reached — scenariosToRunIndex reset to 0 for next Send');
}
```

**This is the wrap-to-0 that breaks the terminal-stop contract.**
The intent (per its own comment) is unitary-UI: "so the next Send
starts from the first scenario again". In an OSCAR collection run
this branch fires once between `/versions` and request #2, leaving
`scenariosToRunIndex === '0'` for the rest of the iteration. By the
time the terminal step (`14. GET Booking after Patch Refund.yml`)
runs, the check `_scNextIdx (0) < _scList.length (1)` is true →
loop-back instead of stop.

Then the loop-back jumps to `01. POST Get Offer`, which calls
`getScenarioData()` again (because `__loopback === 'true'`),
consumes scenario[0] again, advances to `'1'`, the wrapper wraps
back to `'0'`, the terminal step loops back again — forever.

---

## 5. The full sequence trace, single scenario list

For an OSCAR collection run with `__scenariosList = ["A"]`:

```
T  request                        action                                   scenariosToRunIndex  __unitaryLoadedIdx
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
0  /versions                      parseScenarioData consumes idx=0,             0 → 1            undefined
                                  advances index, sets scenarioCode='A'.
                                  Does NOT touch __unitaryLoadedIdx.
1  01. POST Get Offer             Wrapper: _lastUnitaryIdx(undefined) !=         1                undefined
                                  _idxNow('1') → _needsLoad=true.
                                  PR#70 clamp: 1 >= 1 → set idx='0'.              1 → 0            undefined
                                  getScenarioData: consume idx=0, advance.       0 → 1            undefined
                                  PR#68 wrap-to-0: 1 >= 1 → set idx='0'.          1 → 0            undefined
                                  Store __unitaryLoadedIdx = _idxNow('0').        0                0
2..13 02..13. (intermediate requests)
                                  Wrapper: _lastUnitaryIdx('0') ==                0                0
                                  _idxNow('0') → _needsLoad=false. Skip.
14 14. GET Booking after Patch    Terminal step: _scNextIdx(0) <                  0                0
   Refund                         _scList.length(1) → true → LOOP BACK.
                                  setNextRequest('01. POST Get Offer'),
                                  __loopback='true'.
15 01. POST Get Offer (loop-back) before-request sees __loopback='true' →         0                0
                                  resetScenarioEnvVars, getScenarioData.
                                  parseScenarioData consumes idx=0, advance.      0 → 1            0
                                  (NO wrapper firing this time — the
                                  loop-back path is inside the request's
                                  own before-request, not the collection
                                  hook.)
16 02. POST Get Offer-Req param   Wrapper: _lastUnitaryIdx('0') !=                1                0
   chk                            _idxNow('1') → _needsLoad=true.
                                  PR#70 clamp: 1 >= 1 → set idx='0'.              1 → 0            0
                                  getScenarioData: consume idx=0, advance.       0 → 1            0
                                  PR#68 wrap-to-0: 1 >= 1 → set idx='0'.          1 → 0            0
                                  Store __unitaryLoadedIdx = _idxNow('0').        0                0
                                  → back to the state at T2. Loop repeats.
```

This matches the log perfectly: each terminal `REFUND+PATCH complete
— looping` is followed by a `Loading scenario for unitary run` plus a
`scenariosToRunIndex was at/past end … clamped to 0`, then a
`Scenario selected`, then the next iteration's requests.

Note the asymmetry: `/versions` runs the parser **once**, but in the
loop-back path the parser runs **twice** — once from
`01. POST Get Offer`'s own before-request, and again from the
collection-level wrapper firing on `02. POST Get Offer-Req param chk`.
This is why every iteration produces a pair of `Scenario selected`
lines in the log instead of just one.

---

## 6. The fix in v1.11.10

Two minimal changes, both already in this branch.

### 6.1 `Bruno_Collection/library-bruno/scenarioParser.js`

Inside `parseScenarioData()`'s sequential-mode branch, immediately
after the existing `bru.setEnvVar("scenariosToRunIndex", String(nextIdx));`
line:

```js
// v1.11.10: keep the unitary-load wrapper in opencollection.yml synchronised
// with the index we just consumed. The wrapper's reload condition is
//   (_targetNow === '' && _lastUnitaryIdx !== _idxNow)
// which fires on every non-/versions request in an OSCAR collection run
// when __unitaryLoadedIdx is undefined while scenariosToRunIndex is post-
// advance. Setting __unitaryLoadedIdx here (i.e. wherever the parser is
// invoked — /versions, loop-back, or the wrapper itself) keeps the
// wrapper from re-firing on requests #2..N within the same scenario
// iteration.
bru.setEnvVar("__unitaryLoadedIdx", String(nextIdx));
```

Effect: after `/versions` consumes scenario 0, both
`scenariosToRunIndex` and `__unitaryLoadedIdx` are `'1'`. The
wrapper's clause 3 evaluates to `'1' !== '1'` → false → no reload.
The same is true after the loop-back path consumes the next scenario.

### 6.2 `Bruno_Collection/opencollection.yml`

Removed the wrap-to-0 branch from the wrapper's sequential-mode
post-load block:

```diff
-          } else {
-            // Sequential mode: getScenarioData() advanced index to idx+1.
-            // If we've reached the end of the list, wrap back to 0 so the
-            // next Send starts from the first scenario again.
-            try {
-              const _scList = JSON.parse(bru.getEnvVar('__scenariosList') || '[]');
-              const _nextIdx = parseInt(bru.getEnvVar('scenariosToRunIndex') || '0', 10);
-              if (_scList.length > 0 && _nextIdx >= _scList.length) {
-                bru.setEnvVar('scenariosToRunIndex', '0');
-                console.log('[INFO] 🔁 Last scenario reached — scenariosToRunIndex reset to 0 for next Send');
-              }
-            } catch (_we) { /* ignore */ }
-          }
+          }
+          // v1.11.10: the previous wrap-to-0 branch was REMOVED here. […]
```

(The full replacement comment in the file explains why; reproduced
here as a diff for clarity.)

Effect: `scenariosToRunIndex` is now allowed to reach
`__scenariosList.length`, which is precisely what the terminal `.bru`
steps and `loopback.js` check. The contract from §3 is restored.

### 6.3 What was deliberately *not* changed

- **PR #70's defensive clamp stays.** It's now mostly unreachable in
  OSCAR mode (the wrapper no longer fires on request #2), but it
  remains a useful safety net for unitary-UI users who manually set a
  stale `scenariosToRunIndex` and hit Send.
- **PR #71's two fixes stay.** They are correct in their own right —
  `mergeReport.js` should handle the newer Bruno CLI iteration-array
  shape regardless of whether the loop is fixed; `reportGenerator.js`
  should preserve the tmp file on same-scenario loop-back retry.
- **The `scenarioTarget` override stays.** It's an OSDM tester
  affordance for picking a specific scenario by code/index, and it
  has its own correctness guarantee (`scenariosToRunIndex` is not
  advanced when `scenarioTarget` is set).

---

## 7. Re-introducing the unitary-UI "wrap-to-0" affordance safely

The wrap-to-0 was a real UX feature for Bruno-UI users — after
running through all scenarios manually, the next Send should
re-start at scenario 0. The minimal change above removes it
unconditionally. If we want it back, the wrapper needs a way to
distinguish *"I am inside an OSCAR-driven collection run"* from
*"I am a single Send from the Bruno UI"*.

Suggested approaches, in increasing order of intrusiveness:

1. **Sentinel env var set by the OSCAR runner.** The ephemeral env
   file already carries `scenario_override`, `runner_company`,
   `runner_user`, etc. Add a top-level `__oscar_collection_run: true`
   and have the wrapper guard the wrap-to-0 behind
   `!bru.getEnvVar('__oscar_collection_run')`. Server change is in
   `Oscar_Server/src/worker/runner.js`'s env-yaml writer.

2. **Time-window sentinel.** When `/versions` fires, write
   `__lastVersionsAt = Date.now()`. The wrapper only wraps to 0 if
   the last `/versions` was more than (say) 5 minutes ago. Cheap,
   works without a server change, but heuristic.

3. **"Did the loop-back path run since the last terminal stop"
   tracking.** Most precise but most code. Probably not worth it.

Approach (1) is cleanest. If/when revisited, please also make sure
the `__unitaryLoadedIdx` synchronisation from §6.1 still holds — it's
the bigger of the two bugs and benefits both modes.

---

## 8. Reproduction (for the developer to verify locally)

Without the fix:

```bash
# Pick any single-scenario run target with at least 2-3 requests after /versions.
# Sqills works fine; Turnit works fine.
# Watch the run log: you'll see "scenariosToRun [1/1]" lines accumulating
# every ~5 seconds. The run never terminates until RUN_TIMEOUT_MS (600 s)
# or manual cancel.
```

With the fix:

```bash
# Same run target. The log should contain:
#   exactly 1 "scenariosToRun [1/1]: selected ..." line
#   0 "REFUND+PATCH complete — looping" lines (or however many the scenario's terminal step is)
#   exactly 1 "Scenario selected" line (the one from /versions)
#   exactly 1 "✅ All scenarios complete — run finished" line at the end
# Run duration should drop from ~3+ minutes to whatever the single iteration takes.
# Run-detail page should show both an HTML report and a "JSON Results"
# download button (the latter was missing in v1.11.9 because the JSON file
# never got flushed before SIGTERM).
```

A multi-scenario run (e.g. `__scenariosList = ["A", "B", "C"]`)
should now advance through all three in order, then stop. Pre-fix,
that case behaved even worse than the single-scenario case: every
non-`/versions` request alternated between scenarios 0..N, so each
iteration was effectively running a different scenario's environment
context for adjacent requests.

---

## 9. Open follow-ups (not blocking the hotfix)

- **Bileto `POST /api/offers` returns 500.** Upstream issue at
  `osdm-5.platform.bileto.zone`. Worth pinging their operators with
  the captured request body and `x-request-id` headers from the
  failure JSON. Not OSCAR's fault.
- **The wrap-to-0 unitary-UI feature** — see §7. Re-introduce
  guarded by an OSCAR-run sentinel.
- **PR #68 also added or modified** environment YAMLs (Bileto,
  Paxone, Turnit, Sqills, Benerail) and dropped a 20 000-line
  `openapi3_0.json`. The fix here is only about the collection
  runtime loop; the environment-file and schema-file additions
  appear independent and have not been audited line-by-line. If
  testers report further per-vendor regressions, those are the
  files to look at next.

---

*End of analysis. The hotfix branch carrying this document is
`hotfix/v1.11.10-pr68-loop-regression`.*
