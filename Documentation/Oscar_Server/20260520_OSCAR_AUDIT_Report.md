# OSCAR — Independent Code Audit & Validation

**Date:** 2026-05-20
**Audited revision:** `main` @ server v1.11.16 / release-2026.44 (after PRs #68–#79)
**Auditor posture:** external reviewer signing off on delivered quality
**Trigger:** post-integration review following the PR #68 Bruno-library merge and the week's hotfix chain

---

## 1. Executive summary & verdict

> ## Verdict: ✅ **ACCEPT WITH CONDITIONS**

The **OSCAR server** is professional-grade and empirically validated — it is live in production and the week's fixes are confirmed working. SonarCloud rates its reliability, security and maintainability all **A**, with **zero bugs**.

The **Bruno scenario engine** (`Bruno_Collection/library-bruno`, ~6.4k LOC) works but carries the project's real technical risk: it is logic-heavy, stylistically dated, under-guarded on error handling, and was — until this audit — **entirely excluded from SonarCloud**. Every production incident this week originated in this layer.

Acceptance is conditional on a short remediation list (§6). None of the conditions block continued production use; they close governance and fragility gaps.

---

## 2. Scope & method

| Area | Reviewed |
|---|---|
| Server | `Oscar_Server/src` (routes, helpers, middleware, worker, db, utils), `Oscar_Server/public` |
| Bruno engine | `Bruno_Collection/library-bruno` (18 JS files, 6,443 LOC) |
| Tooling | GitHub Issues, CodeQL, Dependabot/secret-scanning status, SonarCloud (issues + quality gate via API), `npm audit` (CI) |
| Manual | Line-level review of the scenario engine, the certifier-visibility model, the auth/rate-limit and timezone handling |

**Material method note:** SonarCloud was found to **exclude all of `Bruno_Collection`** as "data files". In reality `library-bruno` is 6,443 lines of real JavaScript. The exclusion was corrected during this audit (PR #79: `library-bruno` added to `sonar.sources`), so the numbers below reflect the **full** code surface for the first time.

---

## 3. Tooling findings

### 3.1 GitHub
- **Open issues:** 0.
- **🔴 Dependabot alerts: DISABLED** on the repository.
- **🔴 Secret scanning: DISABLED** on the repository.
- CodeQL: enabled and reporting.
- `npm audit` (prod deps): runs in CI; "Lint, audit, test" check is green.

### 3.2 CodeQL (open alerts, notable)
| Severity | Rule | Location | Assessment |
|---|---|---|---|
| HIGH | `js/file-system-race` | `reportGenerator.js:244` | **Low real risk** — each run executes in its own isolated workspace (single writer). Worth a guard. |
| HIGH | `js/empty-password-in-configuration-file` | `opencollection.yml:14` | **False positive** — Bruno's empty proxy-config default. |
| ERROR | `js/node/missing-exports-qualifier` | `refunds.js:238,250` | **Not a defect** — the `globalThis`/`*Local` override pattern, guarded by `typeof`. A smell, not a crash. |
| WARNING/NOTE | trivial-conditional, useless-assignment, ~15 unused-locals | various | Trivial. |

### 3.3 SonarCloud (`TOP-PHE_UIC_OSCAR_Temporary`) — full surface
- **🔴 Quality Gate: FAILING (ERROR)** on three *new-code* conditions:
  - `new_coverage` = **34.6%** (threshold 80%)
  - `new_duplicated_lines_density` = **3.9%** (over threshold)
  - `new_security_hotspots_reviewed` = **0%** (6 hotspots `TO_REVIEW`, none reviewed)
  - Reliability / Security / Maintainability ratings on new code: all **A (OK)**.
- **1,085 open issues** total (was 813 before `library-bruno` was added → **+272** from the engine).
  - Types: **0 BUGs**, 3 VULNERABILITY, ~1,082 CODE_SMELL.
  - Severities (project): 3 BLOCKER, 44 CRITICAL+, ~400 MAJOR, ~370 MINOR.
- **3 BLOCKER = DOM-XSS (`jssecurity:S5696`)** in `public/js/scenarios.js` (lines 365, 811, 1073). Pre-existing; the most security-relevant items.
- The quality gate does **not** currently fail CI (the Sonar job uploads results but isn't wired to block on the gate).

> **Note on coverage 34.6%:** `library-bruno` is *analyzed* for quality but *excluded from the coverage metric* (it has no Jest harness yet), so it does not contribute to the 34.6% — that figure is the server/UI new-code coverage. Adding a Bruno test harness later and removing the coverage exclusion is the path to gating its coverage too.

---

## 4. Manual review by layer

### 4.1 Server — **Strong (A)**
- `run-access.js` is a genuine single-source-of-truth for run visibility — a clean, auditable design.
- Parameterized SQL throughout (no injection surface), at-rest encryption, audit logging, IP-keyed auth rate limiting, tenant scoping.
- The certifier-visibility refactor (per-report sharing, v1.11.15) is **consistent across all five enforcement points** (`run-access.js`, `runs.js` list, `reports.js` comparisons, `tenant.js`, and the share endpoints) — verified.
- Timezone handling (post v1.11.6 Europe/Paris): storage is consistently UTC; the one server-side defect (`isRunStale` parsing UTC-as-Paris) was fixed in v1.11.13.
- Residual: a handful of high-complexity handlers (`S3776`) and unused-var nits.

### 4.2 Frontend (`public`) — **Acceptable; one real concern**
- **3 DOM-XSS BLOCKERs in `scenarios.js`** — the test-config editor builds HTML from data. If the data is fully trusted (the company's own config) the risk is contained, but "test_manager-supplied data rendered as HTML" is a legitimate stored-XSS vector. **Triage required.**
- Large inline `<script>` blocks drive most of the CRITICAL complexity scores. Maintainability debt, not correctness.

### 4.3 Bruno scenario engine (`library-bruno`) — **Works, but architecturally fragile**
SonarCloud (now that it scans this tree): **272 issues, 52 CRITICAL, 0 bugs, 0 vulnerabilities.** The CRITICALs are cognitive complexity; the bulk are maintainability:

| Measured | Count | Meaning |
|---|---:|---|
| `S3504` (`var` instead of `let/const`) | 37 | dated style; hoisting hazards |
| `S6582` (optional chaining) | 40 | style; auto-fixable |
| `S7773` / `S7735` (modern-JS) | 63 | style; auto-fixable |
| **`S2486` (swallowed/ignored exceptions)** | **30** | **real robustness gap** |
| `S3776` (cognitive complexity) | 15 | over-long functions (offers.js 1,223 LOC; scenarioParser.js 882) |
| `JSON.parse(bru.getEnvVar(...))` **without try/catch** | **17** | produces the cryptic stack traces seen when running locally |
| Empty / swallowing `catch` blocks | 8 | silent failures |
| `Object.assign(globalThis, …)` global-injection | 13 of 18 files | obscures definitions; same shape as the export bug that crashed v1.11.11 |
| Duplicated loop-back decision block | 11 files | the duplication the gate fails on |

**Root-cause theme:** the engine drives control flow through global mutable state (`bru.getEnvVar/setEnvVar`). The PR #68 infinite loop, the committed session-state cruft, and the brittle unitary-load wrapper all stem from this. It is the highest-leverage area for hardening.

---

## 5. What was already remediated this week (context)
v1.11.10 (loop fix) · v1.11.11–12 (dashboard regressions) · v1.11.13 (tester visibility + TZ sanity pass + Grafana false-positive + env cleanup) · v1.11.14 (auth rate-limit) · v1.11.15 (per-report certifier sharing) · v1.11.16 (share-in-place UX) · #79 (Sonar now scans the engine).

---

## 6. Remediation backlog (severity-ranked)

**Conditions of acceptance (do first):**
1. **Enable Dependabot + secret scanning** (two repo settings). Non-negotiable for a security-positioned product.
2. **Triage the 3 DOM-XSS BLOCKERs** in `scenarios.js` — confirm trusted-data or sanitize.
3. **Review the 6 SonarCloud security hotspots** (un-reviewing them is what fails that gate condition).

**High value (schedule):**
4. **Bruno engine hardening** — wrap the 17 `JSON.parse(bru.getEnvVar(...))` in guards with actionable errors; fix the 30 swallowed exceptions; reduce global-state reliance. This is the layer that caused every incident this week.
5. **Decide the coverage gate** — either invest toward 80% on new code (currently 34.6%) or consciously relax the threshold for a UI-heavy app. Add a Jest harness for `library-bruno`, then gate its coverage too.

**Low effort / high volume (cleanup):**
6. Auto-fixable style: `S6582` optional-chaining (×40+), `S3504` `var`→`let/const` (×37), modern-JS (×63) — a single `eslint --fix`-style pass clears most.
7. Replace the hardcoded short-lived Benerail JWT with runtime token-minting like the other vendors.
8. Add a guard for the `reportGenerator.js` TOCTOU and clear the unused-var notes.

---

## 7. Sign-off

The delivered solution is **fit for production and accepted, with the conditions in §6**. The server earns an unqualified pass. The Bruno engine is functionally validated but should receive a dedicated hardening pass before the next significant change lands on it — and, as of PR #79, it is finally under continuous Sonar scrutiny so that regressions surface in CI rather than in production.

*Prepared as an independent code-quality audit. Findings are reproducible from the SonarCloud project `TOP-PHE_UIC_OSCAR_Temporary`, the repository's CodeQL alerts, and the repository settings.*
