# OSCAR — Logging Rules

Established 2026-06-10 during the tester log-audit (issues #336/#338/#341/#343/#345/#347).
These rules govern **every line the tester sees in the run log** — emitted by the
Bruno collection (`validationLogger` / `console.*` in `library-bruno/` and the
`.yml` runtime scripts) or by the OSCAR runner (`logEvent` in
`Oscar_Server/src/worker/runner.js`).

## The doctrine — three layers, each owns its job

| Layer | Owns | Where |
|---|---|---|
| **JSON viewer** (HTTP traffic + editor) | The **data** — every request/response, full depth | Run page, one click |
| **Log @ INFO** | The **story** — what step ran, what was decided, the verdicts, anything abnormal | Execution log, default view |
| **Log @ DEBUG** | The **plumbing** — payload echoes, per-field traces, internals | One filter-click away |

## Rules

- **R1 — Every line carries a level.** Our code always emits an explicit
  `[DEBUG]` / `[INFO]` / `[WARNING]` (or `[WARN]`) / `[ERROR]` prefix. Third-party
  output (Bruno CLI rows, OpenSSL, stack frames) is classified by the runner's
  `inferLevel()`. Exception: lines whose exact text is machine-parsed by the
  runner's `LogParser` milestones (`⏭️ Skipping to next scenario…`,
  `🔄 Loop-back…`, `⚠️ No offers (attempt N/M)…`) keep their historical shape —
  classify them runner-side, never re-word them.
- **R2 — INFO is the flow story a tester acts on.** Steps, scenario resolution
  (with linkage ids), scope decisions (partial-refund armed, return-trip
  booking mode, purchaser PATCH-vs-POST routing), expiry-deadline captures,
  probe announcements ("attempting X, expecting rejection"), counts
  ("2 offer(s)"), vendor-gap fallbacks. One line per fact.
- **R3 — DEBUG is plumbing and payload.** Function-entry breadcrumbs (`➤`/`►`),
  full-JSON/object dumps, per-field restatements of response data, container
  paths, env-var bookkeeping, pass-echoes, skip-notes for absent optional data,
  bare "→ 200 OK" confirmations (the native ✓ row already says it).
- **R4 — WARNING = real anomaly that doesn't stop the flow, with the action
  path in the message. ERROR = failure or stop, decoded.** Never invert
  semantics (no `[WARNING] No warnings found`); never emit malformed tags
  (`[✅ INFO]` is invisible to the level filter).
- **R5 — Failures speak the provider's language.** Read the RFC-9457 Problem
  body (`urn:uic:problem:*` codes) and say what the provider said, in one line.
  Aggregate repetition: "ALL 208 entries", "13 of 208 (index sample, … +N
  more)", "416 issue(s) — 2 distinct problem(s)". Use plain `throw new
  Error(message)` in test bodies — never `expect(ok, msg).to.be.true/eql`,
  which appends chai's meaningless "expected false to be true" tail.
- **R6 — Never replay the payload in the log.** The JSON viewer owns the data.
  The full body is referenced, not printed.
- **R7 — One confirmation per assertion.** Bruno's native `✓` row is the single
  INFO-level proof; the library pass-echo lives at DEBUG. Failure echoes stay
  in-flow at WARNING (duplication on failure is a feature).
- **R8 — Run-constant facts are announced once per run**, not per request
  (environment OK, auth preflight). Guard assertions register **only on
  failure** — no filler passes inflating report counts.
- **R9 — Conformance nuance rides along.** When a provider does something
  tolerated-but-non-ideal (HTTP 400 for "not supported" instead of 501,
  non-URN problem codes, unexplained empty offers[]), the line says so with
  the recommendation — one clause, certification-ready.
- **R10 — Kill noise at the source when possible** (e.g. `ca-certificates` in
  the image instead of reclassifying the OpenSSL warning), reclassify only
  when the source is third-party.

## Change record

| Round | PR | Versions | Scope |
|---|---|---|---|
| Round 1 — levels & display | [#337](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/337) (#336) | v1.11.113 / OTST_V2.0.61 / 2026.141 | ms display, runner `inferLevel`, `[LEVEL]` tag sweep, #253 followup |
| Round 1 — assertion clarity | [#339](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/339) (#338) | v1.11.114 / OTST_V2.0.62 / 2026.142 | refund/booking decodable failures, cascade-kill, null guards |
| Round 1 — level colors | [#342](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/342) (#341) | v1.11.116 / 2026.144 | warn/debug CSS + filter buttons + unknown-level safety net |
| Round 1 — log pipeline | [#344](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/344) (#343) | v1.11.117 / 2026.145 | ms timestamps stored, run-detail backlog drain |
| Round 1 — validator false positives | [#346](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/346) (#345) | v1.11.118 / OTST_V2.0.64 / 2026.146 | schema currency-required, null-whitelist, ⛔ header |
| Round 2 — tester walkthrough | [#348](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/pull/348) (#347) | v1.11.119 / OTST_V2.0.65 / 2026.147 | 20 items: doctrine applied end-to-end (see PR for the list) + this full-review sweep |

## Known remaining (tracked, not yet applied)

- ~18 non-uniform `expect(res.getStatus(), <custom msg>).to.eql(200)` variants
  across `.yml` scripts still produce chai tails — convert to plain throw as
  they are touched.
- `scenarioParser.js` / `requestedInformation.js` INFO lines were deliberately
  NOT swept (flow narration / graded NHF probes by design) — re-judge only on
  tester feedback.
