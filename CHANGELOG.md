# Changelog

All notable changes to OSCAR (OSDM Conformance Automation Runner) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- (next cycle)

---

## [collection-OTST_V2.0.98] — 2026-08-11

### Fixed

- **Optional, read-only GET endpoints no longer hard-fail when a provider
  legitimately doesn't implement them** (OTST review request — Farruggia,
  2026-07-29; widened after live field testing against SBB — Farruggia +
  Heuguet, 2026-08). Previously any non-200/non-known-deviation status
  FAILed outright.
  - **Round 1** (`04. GET Passenger` only): auto-skip only on HTTP 501, or
    a non-2xx carrying an OSDM Problem body whose `code` explicitly says
    `OPERATION_NOT_PERMITTED`/`NOT_IMPLEMENTED`/`NOT_SUPPORTED`/
    `UNSUPPORTED` — reusing the classifier already proven safe on
    System-Info endpoints (#353,
    `osdmCompliance.js#classifySystemInfoStatus`).
  - **Round 2** (this entry — a real SBB run showed round 1 only partially
    worked: SBB answers unimplemented endpoints with a bare 403/404/500
    and no confirming Problem body): the shared classifier now **also**
    auto-skips on a bare 403/404/405/406/500 — INFO when the signal is
    unambiguous (501, 404, or a confirming body), WARNING (accepted, but
    flags the ambiguity to the provider) otherwise. `401` stays a hard
    FAIL unconditionally — a token problem, never an availability signal.
    Because the widening lives in the one shared function, it applies
    automatically to everywhere that already calls it — all 10
    `01-System Infos Requests/` files and `04. GET Passenger` — with no
    further changes to those files. Newly wired into `11. GET Refund
    Offer.yml` and `12. GET Exchange Offer.yml`, which previously had
    only a manual per-company Known Deviation escape hatch. **Not**
    applied to any booking/refund/exchange mutation endpoint
    (POST/PATCH/DELETE) — those keep their existing strict assertions.
  - Fixed a pre-existing #383-class double-registration bug in `11.`/`12.`
    while restructuring their status handling (both registered the same
    failure as two separate `test()` calls on every non-200).
  - **Originally deliberately deferred, later resolved** (see
    `server-v1.11.187` below): Report Builder's separate "Vendor
    Capability Matrix" (`structureResults.js#classifyVendorCapability`)
    is the natural home for a "supported vs. not-supported endpoints"
    summary, but it classifies from raw HTTP status + assertion counts
    alone, with no per-endpoint context — a blind widening there risks
    silently reclassifying an unrelated negative-test probe elsewhere in
    the collection. Initially flagged for the team rather than patched
    blind, on the reasoning that the live per-run report already showed
    this via each auto-skip's own clearly-labelled passing assertion
    row — reconsidered once it became clear the Capability Matrix is
    exactly the "list of supported/not-supported endpoints" view this PR
    was asked to add, and it was still showing `ERROR` for these same
    responses. Resolved with an exact-endpoint-name allowlist instead of
    a blanket rule, closing the NHF-mislabeling risk that motivated the
    original deferral.

### Tests

- `Bruno_Collection` has no Jest harness (documented gap) — verified via
  YAML parse + JS syntax-check on all three edited files, plus a full
  manual trace of every branch across all three.

---

## [server-v1.11.187] — 2026-09-03

### Fixed

- **Three pre-existing unit tests still asserted the pre-widening policy**
  (a bare 403/404 on an in-version or ungated System-Info endpoint = hard
  fail), so `Lint, audit, test` and `SonarCloud Code Analysis` both
  regressed the moment the round-2 widening above shipped. Updated the
  three tests to assert the new skip+INFO/WARNING behavior, split the
  combined `401/403/5xx` test apart so each status's outcome stays
  independently readable, and added assertions on the log wording so the
  two skip *reasons* (out-of-version vs. provider-doesn't-implement-it)
  stay distinguishable in coverage.
- **Docker image — corrected the nanoid CVE fix + patched a newly-flagged
  `@faker-js/faker` CVE.** The `nanoid@3.3.17` target picked when
  CVE-2026-67213/-67214 was first patched (`server-v1.11.186` below) turned
  out to still be vulnerable — Trivy kept flagging it on this PR's
  Container image scan; the real fix landed one patch release later, in
  `3.3.18`. Corrected the tarball-unpack target accordingly. Also newly
  patched, same technique: `@faker-js/faker` CVE-2026-73231 (HIGH,
  arbitrary code execution via attacker-controlled fake templates),
  bundled inside `@usebruno/cli` to power its `{{$faker.*}}` templating
  helper, `9.9.0` → `10.5.0`. `Bruno_Collection` never uses
  `{{$faker...}}`, so the major-version bump has no call surface in this
  project to break.

### Added

- **Vendor Capability Matrix now agrees with the "not implemented"
  detection above** (OTST review request — Heuguet, 2026-09-03),
  resolving the "deliberately deferred" note further up this entry.
  `structureResults.js#classifyVendorCapability` — which drives
  `public/report-builder.html`'s certifier-facing "list of
  supported/not-supported endpoints" — now also classifies a bare
  403/405/406/500 as `NOT_IMPLEMENTED`, but **only** on the exact, known
  optional/read-only capability-probe endpoints (the same request names
  already wired to `classifySystemInfoStatus`). An exact-name allowlist,
  not a blanket status-code rule — a blind rule would also reclassify an
  unrelated NHF (negative-test) probe elsewhere that deliberately expects
  one of these same codes as its correct, passing outcome. Without this,
  the matrix still showed `ERROR` (or `null`, for 403/405/406) for the
  exact same responses the live per-run assertion already accepts as a
  documented capability gap — e.g. a bare 500 on `GET Refund Offer`.
  `classifyVendorCapability` gained an optional 4th `reqName` parameter;
  every existing call/test omitting it keeps its prior `ERROR`/`null`
  behavior unchanged, and the 404 rule stays endpoint-independent as
  before.

---

## [server-v1.11.186] — 2026-08-11

### Fixed

- **Docker image — nanoid CVE-2026-67213/-67214** (infinite loop in
  `customAlphabet`, both HIGH), which was blocking the required Container
  image scan (Trivy) check on **every** open PR, not just ones touching
  dependencies. Same shape as the earlier axios/form-data problem (#428):
  `nanoid@3.3.8` is exact-pinned as a direct dependency inside four of
  Bruno CLI's own sub-packages, so a plain reinstall or `overrides` entry
  can't budge it. Fixed the same way — unpack the patched `nanoid@3.3.17`
  tarball directly over every nested copy in the Docker build, with a
  verification step that fails the build if any copy is still unpatched.
- **`ip-address` 10.2.0 → 10.5.0** (lockfile only), folded into the same
  PR after discovering it broke a circular CI dependency with the
  then-open `ip-address` Dependabot PR (#484, closed as redundant once
  main carried the identical change) — Trivy blocked #484 until nanoid
  was patched here, while this PR's own audit step was blocked by the
  same pre-existing `ip-address` findings #484 fixed.

---

## [server-v1.11.185] — 2026-07-07

### Fixed

- **#477 — Discovery, Re-probe, and Places refresh now apply the company's
  Dedicated Headers.** Previously only the Bruno test-run path read
  `companies.extra_headers` — Discover Timetable, Re-probe offers
  (`company-test-resources.js`), and the Places API refresh
  (`company-places.js`) each built their own local header set from only
  the tester's Requestor/subscription-key, silently dropping any custom
  header a company had configured (e.g. SBB's `tracestate`/`traceparent`/
  `accept-language`), which made Discovery unusable on those sandboxes.

### Added

- **`utils/osdm-client.js`** — new shared `mergeDedicatedHeaders(headers,
  companyRow, resolvedVars)`, parsing `extra_headers` and resolving
  `{{var}}` templates against a caller-supplied map (case-sensitive,
  unresolved → empty string) — mirrors `opencollection.yml`'s
  `__extraHeaders` block exactly, in plain JS since these routes have no
  Bruno environment. Wired into all three affected routes.

### Tests

- 12 new unit tests for `mergeDedicatedHeaders` (literal values, `{{var}}`
  resolution, unresolved-var/case-sensitivity edge cases, malformed/
  missing `extra_headers` fail-open, override semantics).
- 3 new integration tests capturing the real outgoing `fetch` headers on
  all three routes, asserting both a literal and a `{{access_token}}`-
  templated dedicated header actually reach the vendor call.
- Full suite 54 suites / 1335 tests green (was 53/1321); eslint clean.

---

## [server-v1.11.184] — 2026-07-03

### Added

- **`public/news/index.json`** — announced #239 (book mandatory
  reservations via `optionalReservationSelections`) on the welcome page.
  Content-only; no runtime behaviour affected.

---

## [server-v1.11.183 / collection-OTST_V2.0.97] — 2026-07-03

**Feature (#239): book a mandatory reservation via `optionalReservationSelections`
— independent of the existing place/compartment-selection mechanism.**

### Added

- **`datafile.schema.json`** — new scenario boolean `bookMandatoryReservations`.
- **`offers.js`** — new `handleOptionalReservationSelections()`, called
  alongside `handleAccommodationAndPlaceSelection()` in `postOfferResponse`:
  when the flag is set, harvests every `reservationOfferParts[].id` on the
  selected offer into the `optionalReservationSelections` env var
  (`[{reservationId}, ...]`).
- **`requestsBuilder.js`** — `buildBookingRequest()` attaches
  `optionalReservationSelections` to each booked offer object, mirroring the
  existing `placeSelections` attachment (outbound-only for two-step return
  scenarios, same established simplification).
- **`scenarios.js`** — new "Book via optionalReservationSelections" toggle
  in the Booking Flow Actions section.
- **`bookings.js`** — logs which reservation-booking mechanism a scenario
  used, for report traceability. No new assertion needed: the existing
  generic `validateOfferParts()` reservation↔booked-reservation check
  already covers correctness regardless of which mechanism requested it.

### Changed

- Not breaking — the new field is optional and additive, defaulting off.
  `min_collection` unchanged at `OTST_V2.0.95`.

### Tests

- Full suite 53 suites / 1321 tests green (no server-side test file
  touched). `node --check` on every edited `Bruno_Collection` file; schema
  JSON-parses; `opencollection.yml` YAML + before-request JS syntax-check
  clean, including the new field in its scenario-reset delete-list.

---

## [server-v1.11.182] — 2026-07-03

### Added

- **`public/news/index.json`** — backfilled 18 welcome-page news entries
  covering everything merged since the last news update (2026-06-09,
  partial refund) through today: Night Train accommodation testing (#211),
  the env-yml credential-free security fix (#306), Places API stop-place
  discovery (#450), Test-Manager-gated registration (#449), fulfillment
  type/media declaration (#448), Test Finding ↔ scenario linking (#447),
  CHAPS-onboarding auth diagnostics (#437-443), dedicated headers (#427),
  Test Findings & Open Points (#400/#401) plus its category accordion and
  bulk-import follow-ups (#409/#413), batch ZIP downloads (#406), the Run
  Budget Ceiling admin field + catalog refundability sweep (#395), the
  IRT/NJ accommodation-aware testing programme (#372/#374/#380/#381/#382),
  run-setup UX polish (#364/#367), the Discovery offer probe + Re-probe
  button (#368/#370), the OSDM Trip Search Criteria wizard panel (#360),
  and the step-failure policy toggle (#362). Content-only; no runtime
  behaviour affected.

---

## [server-v1.11.181] — 2026-07-03

### Fixed

- **Flaky CI test** — `tests/unit/runner.test.js`'s "links a reportGenerator
  HTML artifact when one is present" intermittently failed in CI (never
  locally). The report-linking step in `runner.js` filters candidate report
  files by `mtime >= runStartTime`, guarding against linking a stale report
  left by a previous run. `runStartTime` used millisecond-precision
  `Date.now()`; some CI container filesystem storage drivers round a
  freshly-written file's reported mtime to coarser precision, which could
  put it just below `runStartTime` even though the write genuinely happened
  after — silently dropping the artifact link. Fixed by subtracting a
  2-second safety margin from `runStartTime` before the comparison — a real
  leftover report is always at minimum seconds old in practice, so the
  margin costs nothing on the staleness guarantee it exists for.

---

## [server-v1.11.180 / collection-OTST_V2.0.96] — 2026-07-03

**Feature (#211): Night Train Sales & Refund — the SFR's two accommodation
families (bed in shared compartment vs. private compartment) are now
reliably distinguishable and validated end-to-end.**

### Added

- **`datafile.schema.json`** — `accommodationSelection` enum synced to match
  what the wizard/code have used since #373 (was stale: only
  `SEAT`/`COMPARTMENT`, now includes `COUCHETTE`/`BERTH`/`VEHICLE`). New
  sibling field `accommodationGenderPreference` (`MEN`/`LADIES`/`MIXED`) for
  gender-segregated night-train compartments — not a passenger-level field;
  #227 (age/gender as an offer-request input) stays untouched.
- **`scenarios.js`** — new "Preferred place gender" wizard pill picker,
  wired the same way as the existing accommodation-type picker.

### Changed

- **`offers.js` `handleAccommodationAndPlaceSelection()`** — reservationOfferPart
  selection is now offerMode-aware: when the scenario declares `offerMode`,
  prefers a part whose own `offerMode` matches (a vendor offering both an
  INDIVIDUAL and a COLLECTIVE part of the same accommodation type could
  previously have the wrong one silently booked). Also prefers a place
  whose `placeProperties` matches the new gender preference, and harvests
  `placeProperties` into `selectedAccommodation` so it flows into the
  booking request. Falls back with a `[WARNING]` (never a hard fail) when
  no match exists.
- **`offers.js`** — new soft assertions: `minGroupItemsToBeBooked`/
  `maxGroupItemsToBeBooked` type-checked when present; COUCHETTE/BERTH
  `availablePlaces` warn when no MEN/LADIES/MIXED `placeProperties` is
  declared.
- **`bookings.js` `validateAccommodationGoal()`** — the place-count check is
  now a **hard** assertion when the scenario declared an `offerMode`
  (exactly 1 place for INDIVIDUAL, place count == party size for
  COLLECTIVE); stays a soft `[WARNING]` for every scenario that doesn't
  declare `offerMode` (unaffected, backward compatible). Added a
  `placeProperties` request-vs-response echo check (`[WARNING]` only).
- Not breaking — every new field is optional/additive; `min_collection`
  unchanged at `OTST_V2.0.95`.

### Tests

- Full suite 53 suites / 1321 tests green (unaffected — no server-side test
  file touched directly). `Bruno_Collection` has no Jest harness (documented
  pre-existing gap); verified instead via `node --check` on every edited
  file, schema JSON-parse, and `opencollection.yml` YAML + before-request JS
  syntax-check. Live browser verification of the new wizard picker was not
  completed — obtaining a test-manager session would have required
  resetting a seeded dev user's password, which the permission system
  correctly blocked as an unauthorized credential mutation; the picker is a
  byte-for-byte pattern match of the already-proven `accommodationSelection`
  picker.

---

## [server-v1.11.179 / collection-OTST_V2.0.95] — 2026-07-03

**Security (#306): the ephemeral Bruno env yml is now credential-free — no plaintext
secret ever touches disk.**

### Changed

- **`worker/runner.js`** — `buildEnvYml()` no longer writes `access_token`,
  `Ocp-Apim-Subscription-Key` or `oauth_extra`/`auth_key_secret` into the
  per-run environment file; it carries only non-secret plumbing (API base,
  datafile URL, requestor, run id, scenario override, extra headers).
  `executeRun()` instead hands the three credentials to the Bruno child
  process via its environment — `OSCAR_ACCESS_TOKEN`,
  `OSCAR_SUBSCRIPTION_KEY`, `OSCAR_OAUTH_EXTRA` — on top of the existing
  strict env allowlist (`ENCRYPTION_KEY`/`JWT_SECRET` still never
  forwarded). Closes the crash-window exposure: a worker SIGKILL between
  env-write and cleanup, or a mid-run volume snapshot, now leaves nothing
  sensitive behind. Every credential-bearing path on disk is encrypted or
  eliminated.
- **`Bruno_Collection/opencollection.yml`** — new step 0 in the
  before-request hook seeds the credentials from the process environment
  into Bruno runtime vars via `bru.getProcessEnv()` (official Bruno API,
  identical on the Linux workspace path and the Windows fallback). Seeding
  fires only while the runtime var is still empty, so a token refreshed
  mid-run through the OSCAR loopback (#204) is never clobbered; standalone
  Bruno (no `OSCAR_*` env) is a strict no-op.
- Env-file deletion failure downgraded from CRITICAL error to warning
  (hygiene only — the file carries no credentials any more).
- `TOKEN_FORMAT_ERROR` messaging (runner log + `run-detail.html` banner +
  docs) no longer blames the token for YAML parse errors — the token can no
  longer cause them; a malformed API base URL / requestor still can.
- **BREAKING PAIRING** — `compatibility.json` `min_collection` raised to
  `OTST_V2.0.95`: an older collection under server ≥ 1.11.179 never receives
  the access token and 401s on every call. Deploy both halves together (the
  `refresh-collection.yml` workflow already does).

### Documentation

- Server Admin Guide §15 threat table: env-file row added — "every
  credential-bearing path on disk is encrypted or eliminated" now holds
  without the env-yml caveat (the #306 acceptance criterion).
- Specification §9.9 (ephemeral env files), §10.1 (YAML safety), §10.2
  (error sentinels), §12 (banner); Solution Architecture §14.3.4 example +
  Issue-3 superseded note.

### Tests

- `tests/unit/runner.test.js` 17 → 19: the on-disk env yml contains neither
  secret values nor credential variable names while the run is in flight;
  the spawn env carries the `OSCAR_*` vars exactly when configured. Full
  suite 53 suites / 1321 tests green.

---

## [server-v1.11.178] — 2026-07-02

**Test: coverage batch 6 — src/server.js, the Express app entry point (overall `src` coverage ~83% → ~88%).**

### Added

- **`tests/unit/server.test.js`** (new file, 30 tests) — the last remaining
  major coverage gap (236 uncovered lines, 0% covered). Architecturally
  different from every prior batch: requiring `server.js` has real side
  effects (env-var validation with `process.exit(1)`, a JWT-secret DB
  bootstrap, queue event wiring, startup run reconciliation, and a real
  `app.listen()` that binds an OS port) rather than being a plain Express
  router. The module is required exactly once against a dedicated,
  never-dialed test port — supertest wraps the exported `app` directly and
  needs no real listening socket. Covers:
  - `GET /health` (DB / queue / disk / process checks)
  - `GET /metrics`
  - the datafile download route — filename-regex guard, unknown-company
    404, non-loopback 401/403, owning-company 200, loopback-bypass 200
  - the loopback-only access-token-refresh endpoint, including `?force=1`
    and a `resolveAccessToken`-failure 502
  - the run-artifact download route — ownership check, path/filename
    guards, and a real AES-GCM tamper-detection 500 (a single flipped
    ciphertext byte)
  - route-mounting wiring
  - via one isolated `NODE_ENV=production` re-require on a second
    dedicated port: the HTTPS-redirect middleware (Sonar S5146
    open-redirect guard)

  `server.js` 0% → **~83%** lines. Full suite: 52 → **53 suites, 1289 →
  1319 tests, all green**.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **74% → 83%** in
  `sonar-project.properties` (bump the actual gate condition in the
  SonarCloud UI to match).

### Notes

- Tests-only + Sonar-config-doc; no runtime change.
- **Deliberately out of scope, documented rather than forced:** the
  `process.exit(1)` missing-env-var path, the Alertmanager startup
  config-seed hook (gated behind an unset env var so it naturally never
  runs in tests), static/SPA file serving (Express's own tested
  behaviour), and the global error handler (no non-invasive way to force
  an unhandled throw through a real mounted route without modifying
  source).
- Given the elevated risk (two real, uncaptured `app.listen()` sockets —
  the main require plus the isolated production re-require — and two
  real, hardcoded, non-overridable data directories written to), this
  batch was written directly rather than delegated, after reading
  `server.js` end-to-end first.
- **Caught and fixed two authoring mistakes before they became
  false-negative-masking bugs:** a path-traversal test asserted 400/404
  on a URL Express itself normalizes before routing (it actually hits the
  SPA fallback at 200) — replaced with a same-segment filename that
  genuinely reaches and fails the route's own regex guard; an
  artifact-tamper test truncated the encrypted file below the 34-byte
  header, which made `isEncryptedBuffer()` treat it as legacy plaintext
  instead of tripping the AES-GCM auth-tag check — fixed by flipping one
  byte in the ciphertext region instead of truncating. Also fixed an
  FK-ordering bug in the file's own cleanup (deleting seeded users before
  their still-referencing runs' company row violated `runs.user_id`'s
  non-cascading foreign key).
- Stress-tested for flakiness given the real side effects: 6 standalone
  runs and 3 full-suite runs, all clean, before trusting the result.
  Confirmed `data/datafiles/` and `data/artifacts/` have zero leftover
  test files before and after; lint clean; scanned for both CodeQL
  patterns that hit earlier batches — neither present.

---

## [server-v1.11.177] — 2026-07-02

**Test: coverage batch 5 — worker/runner.js, the Bruno CLI orchestrator (overall `src` coverage ~77% → ~83%).**

### Added

- **`tests/unit/runner.test.js`** (new file, 17 tests) — closes by far the
  largest remaining coverage gap: the Bruno CLI orchestrator
  (`worker/runner.js`, 388 uncovered lines / 16% covered going in).
  `child_process.spawn` is fully mocked — **no real subprocess is ever
  spawned** — driving `executeRun()` through:
  - auth / missing-run / missing-datafile / env-write-failure early exits
  - exit-code 0 vs non-zero final status, and the `proc.on('error', ...)`
    path
  - HTML report linking, both directly (reportGenerator output) and via the
    `mergeReport.js` fallback, plus that second spawn call's own error path
  - the JSON-results artifact copy
  - `AUTH_401`/`TOKEN_FORMAT` detection in CLI output, surfaced onto
    `runs.error_message`
  - the emergency-stop terminal-state guard (a `CANCELLED` run is never
    resurrected to `COMPLETED`)
  - a real (not fake-timer), config-driven short-timeout kill test

  `runner.js` 16% → **~68%** lines. Full suite: 51 → **52 suites, 1272 →
  1289 tests, all green**.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **68% → 74%** in
  `sonar-project.properties` (bump the actual gate condition in the
  SonarCloud UI to match).

### Notes

- Tests-only + Sonar-config-doc; no runtime change.
- Given the elevated risk here (a real, hardcoded, non-overridable
  `ARTIFACTS_DIR` under this same repo, plus the real danger of accidentally
  spawning a subprocess), this batch was written directly rather than
  delegated to a subagent, after reading `executeRun()` end-to-end first.
- **Hit and fixed one real bug while authoring**: emitting synthetic
  `close`/`error` events on the fake child process after a single
  `setImmediate` tick raced ahead of `executeRun`'s own multi-`await`
  preamble (mkdir / env-yml write / datafile read) — the events fired
  *before* `executeRun` had even called `spawn()`, so its real listeners
  were never attached and the awaited promise hung forever. Fixed by
  polling for the Nth actual `spawn()` call before emitting anything.
- **Deliberately out of scope, documented rather than forced:** the
  Linux-only workspace create/cleanup functions (platform-gated, never
  engaged since no test sets `scenarioOverride`) and the token-watchdog
  `setInterval` tick logic (disabled via `TOKEN_WATCHDOG_INTERVAL_MS=0` for
  every test, avoiding a live interval that would otherwise keep Jest's
  process alive). Both carry real production risk surface but need a
  fundamentally different (fake-timer / platform-conditional) test strategy
  this batch didn't take on.
- Confirmed `data/artifacts/` has zero leftover test directories before and
  after a full suite run; lint clean; scanned for both CodeQL patterns that
  hit earlier batches (insecure `os.tmpdir()` writes, unanchored
  `new RegExp(string)` checks) — neither present.

---

## [server-v1.11.176] — 2026-07-02

**Test: coverage batch 4 — mailer.js, middleware/auth.js, worker/auth-profiles.js (overall `src` coverage ~74% → ~77%).**

### Added

- **`tests/unit/mailer.test.js`** (new file, 24 tests) — mocks `nodemailer`
  and seeds/restores `server_config` directly to exercise all four
  `send*Email` functions in both the SMTP-configured and
  dev-mode-fallback (no SMTP) branches. `mailer.js` 0% → **100%**
  (previously completely untested).
- **`auth-middleware.test.js`** (20 → 47 tests) — cookie parsing (malformed
  pairs, URL-decoding, multi-cookie, invalid RFC-6265 names), the
  `token_blacklist` revocation branch, and `isTestManagerOrAbove` /
  `userFromRequest` exercised over every role in the app.
  `middleware/auth.js` ~62% → **100%**.
- **`auth-profiles.test.js`** (30 → 57 tests) — the `custom` profile's
  raw-body-format and placeholder-substitution edge cases, network/timeout/
  malformed-response failure paths, and masked-diagnostic-logging
  assertions across every OAuth profile (confirming secrets never leak into
  logs). `worker/auth-profiles.js` ~85% → **~99%** (one line left: an
  unreachable `_maskBody()` fallback no adapter can actually produce —
  documented rather than reached through internals).

Full suite: 50 → **51 suites, 1199 → 1272 tests, all green**.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **65% → 68%** in
  `sonar-project.properties` (bump the actual gate condition in the
  SonarCloud UI to match).

### Notes

- Tests-only + Sonar-config-doc; no runtime change.
- This batch used 3 parallel subagents. Two independently flagged (and
  self-resolved) a transient mid-task file-read anomaly, so every file was
  re-verified from scratch rather than trusting any self-report: re-run
  standalone with `--coverage`, scanned for both CodeQL patterns that hit
  earlier batches (insecure `os.tmpdir()` writes, unanchored
  `new RegExp(string)` URL/domain checks — neither present), and the exact
  test-count delta reconciled against `origin/main` (1199 + 27 + 22 + 24 =
  1272, confirmed exactly).

---

## [server-v1.11.175] — 2026-07-01

**Test: coverage batch 3 — runs.js, admin.js, company.js (overall `src` coverage ~65% → ~74%).**

### Added

- **`runs-routes.test.js`** (10 → 75 tests) — the single biggest remaining
  coverage gap: submit / list / queue-status / stop-all / batch + zip / logs /
  assertions / requests / artifacts / share / cancel / delete / bulk-delete /
  bulk-admin-action, over real seeded run graphs with encrypted artifacts.
  `runs.js` ~35% → **~87%**.
- **`admin-routes.test.js`** (40 → 73 tests) — `users/:id/approve`,
  `generate-reset-link`, `GET`/`PATCH /config` (incl. sensitive-value
  masking), `alertmanager/apply`, `test-email` (dev-mode path only, no real
  SMTP), and `rotate-jwt-secret` (run last, self-restoring — it mutates
  `process.env.JWT_SECRET`). `admin.js` ~60% → **~89%**.
- **`company-routes.test.js`** (15 → 27 tests) — the `extra_headers`
  validation branches (issue #426), the retired
  `share_reports_with_certifier` rejection, and the `POST /datafile`
  multipart upload path. `company.js` ~58% → **~84%**.

Full suite: 50 suites, 1089 → **1199 tests, all green**.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **55% → 65%** in
  `sonar-project.properties` (bump the actual gate condition in the
  SonarCloud UI to match).

### Notes

- Tests-only + Sonar-config-doc; no runtime change. Every extended file was
  independently re-run standalone with `--coverage` and scanned for the
  CodeQL patterns that tripped batch 1 (no bare `os.tmpdir()` writes, no
  unused imports) before being folded in.
- **One real, pre-existing behavior surfaced while writing tests (not a
  regression — not changed here):** `POST /v1/company/datafile`'s multer
  `filename` callback treats `certification_user` as a platform role that
  needs an explicit `company_id`, so it errors with a `500` *before* the
  route's own test-manager-only `403` check ever runs, for that specific
  role. The new test exercises the intended `403` branch with a plain tester
  instead. Worth a follow-up if a certifier ever legitimately hits this
  endpoint.

---

## [server-v1.11.174] — 2026-07-01

**Test: coverage batch 2 — versionInfo, structureResults, and the auth route's untested surface (overall `src` coverage ~59% → ~65%).**

### Added

- **`version-info.test.js`** (8 tests, ~97%) — `utils/versionInfo.js`
  compatibility-matrix resolution: matrix-missing / malformed JSON, untested
  combination, exact + `.x`-wildcard match, unknown collection. Uses
  `jest.isolateModules` (the module resolves at load) + `mkdtemp` temp files.
- **`structure-results.test.js`** (22 tests, ~90%) — `reports/structureResults.js`:
  the pure `classifyVendorCapability` / `serializeBounded` across all branches,
  plus `extractStructuredResults` over a seeded run with real AES-encrypted
  artifact files (PASS/FAIL requests, auth-header redaction, assertion counts).
- **`auth-routes.test.js` extended** (~49% → ~86%) — the previously-untested
  auth surface: `register/companies`, `register/check-token`, the full
  password-reset flow (request → check-token → confirm, single-use, then
  login with the new password), `bootstrap/platform-user`, and the
  authenticated `/me`, `/logout`, `/sso-check` (admin-only) endpoints.

Full suite: 48 → 50 suites, 1043 → 1089 tests, all green.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **50% → 55%** in
  `sonar-project.properties` (bump the actual gate condition in the SonarCloud
  UI to match).

### Notes

- Tests-only + Sonar-config-doc; no runtime change. New test files were scanned
  for the CodeQL patterns that tripped batch 1 (no `os.tmpdir()` writes —
  `mkdtemp` used; no unused imports).

---

## [server-v1.11.173] — 2026-07-01

**Test: coverage batch 1 — integration tests for the three untested route files (overall `src` coverage ~50% → ~59%).**

### Added

- **`company-test-resources-routes.test.js`** (21 tests, ~85% of the file) —
  CRUD + role gating + tenant isolation, plus the vendor-calling
  `discover-timetable` / `reprobe-offers` endpoints (bearer creds +
  stubbed `global.fetch`, no live vendor).
- **`reports-routes.test.js`** (33 tests, ~98%) — `compare` / `comparisons` /
  `configured` report builder / `templates` / `trends`, over a seeded
  runs + run_requests + run_events graph.
- **`company-test-framework-routes.test.js`** (15 tests, ~94%) — GET/PUT/DELETE,
  role gating, and the lazy salesFlows migration path.

All three files were previously at **0%** coverage. Full suite: 45 → 48
suites, 974 → 1043 tests, all green.

### Changed

- Documented the OSCAR-Gate `new_coverage` floor bump **35% → 50%** in
  `sonar-project.properties` (the actual gate condition must be bumped in the
  SonarCloud UI to match) — locking in the coverage gain so new code can't
  regress below it.

### Notes

- Tests-only + Sonar-config-doc; no runtime change.
- The `discover-timetable` / `reprobe-offers` deep harvest-and-merge loops
  remain uncovered (they need a fully-shaped vendor `trips` payload) — a
  follow-up target for a later batch.

---

## [server-v1.11.172] — 2026-07-01

**Chore: clear the two conditions keeping `main`'s SonarCloud gate red, so the Quality Gate can become a required check.**

### Fixed (accessibility — reliability rating C → A)

- Associated a label with all **38 form controls** flagged by
  `Web:InputWithoutLabelCheck` (which Sonar classifies as reliability *bugs*)
  across 8 pages: the auth pages (`index`, `verify-email`, `reset-password`,
  `forgot-password`), `profile.html`, `admin.html`, `run-detail.html`, and
  `report-builder.html`. Used `<label for>` where a visible label already
  existed, and `aria-label` for compact toolbar filters and the "select-all"
  table checkboxes. This also resolves the 38 matching `S6853` a11y smells.

### Changed (Sonar config — duplication 9.2% → ~1%)

- Added `sonar.cpd.exclusions` for `Bruno_Collection/library-bruno/osdmSchemas.js`
  — a **generated** file (its header says "do not hand-edit") whose
  per-OSDM-version schema blocks are ~identical by design and accounted for
  ~2,288 of the project's ~2,585 duplicated lines. It stays analyzed for
  bugs/smells; only copy-paste detection is turned off.
- Bumped `sonar.projectVersion` `1.2.0 → 1.11.172` (it was stale, which made
  ~28k legacy lines count as "new code"). Keeping it in step with
  `package.json` lets the "Previous version" new-code period track real
  releases.

### Verification

- Every `<label for>` target confirmed to reference an existing element `id`
  across all 8 files; eslint + inline-script HTML lint clean; full Jest suite
  unaffected (HTML/config only). After merge, `main`'s gate is expected to go
  green on both previously-failing conditions — enabling "SonarQube Quality
  Gate check" to be added to branch protection.

---

## [server-v1.11.171] — 2026-07-01

**Feat (#450): discover stop places via the OSDM Places API — cache + full-text lookup in Test Config.**

### Added

- **Bulk place download + cache.** A "⬇ Download places" button in the Test
  Data → Train Resources toolbar calls the new
  `POST /v1/company/places/refresh` (test_manager only), which pages through
  the vendor's `GET {api_base}/places`, dedupes by `id`, and caches the list
  per company. Bounded (100 pages / 100k places) with a loud log if a cap
  truncates. A "N places cached · <ago>" status line shows the cache state.
- **Full-text stop-place lookup.** `GET /v1/company/places` returns cache
  metadata, or with `?q=` a ranked (name-prefix first) set of `{ id, name,
  objectType }` matches over name + URN (tester + test_manager readable;
  admin/certifier denied, per #60).
- **Typeahead** on every origin/destination URN field — the Timetable
  Discovery modal and the Train Resource editor — so testers pick a real place
  (name shown, URN stored) instead of typing `urn:uic:stn:NNNNNNN` by hand.
  Manual entry still works; the lookup is a pure assist.
- New `places_cache` table (one row per company, plaintext JSON — places are
  public reference data; migration 25). New shared helper
  `src/utils/osdm-client.js` (`osdmGet` + `buildTesterHeaders`) reused from the
  discover-timetable vendor-call boilerplate. OpenAPI documents both endpoints.

### Verification

- New `company-places.test.js` (11 tests): auth/role gating; `?q=` filtering,
  prefix ranking, and limit cap; refresh `400` with no `api_base`; a
  fetch-stubbed refresh happy-path asserting cross-page dedupe, the
  stop-when-no-new-ids condition, and name-falls-back-to-id. `db-migrations`
  extended for migration 25 (fresh install + already-versioned DB missing the
  table). Full suite: 45 suites / 974 tests green; lint clean.
- Manual browser run (seeded cache, no live vendor): the cache-status line
  renders, the typeahead filters (Basel/Zürich) and selecting fills the URN,
  and manual typing still works. The live `/places/refresh` download path is
  covered by the fetch-stubbed integration test.

---

## [server-v1.11.170] — 2026-07-01

**Fix (#449 follow-up): register against the company's stable slug, not a slug re-derived from its name.**

### Fixed

- Self-registration matched the chosen company by re-deriving a slug from its
  **display name** (`makeSlug(name)`) and looking up `WHERE slug = ?`. That
  breaks for any company whose stored slug was frozen before a rename — e.g.
  the real "Paxone" (display name `Paxone`, stored slug `paxone-gmbh`,
  `makeSlug('Paxone') = 'paxone'`), which was rejected with *"Unknown
  company"*. Registration now submits and matches on the company's **stable
  slug** (the `/register/companies` dropdown `<option>` value is the slug),
  eliminating the name→slug re-derivation entirely.

### Changed

- `POST /v1/auth/register/request` now takes `companySlug` (was `companyName`)
  and looks up `WHERE slug = ?`. The picked company's canonical name **and**
  slug are stored on the pending registration; `register/confirm` resolves the
  company by that stored slug (falling back to `makeSlug(company_name)` only
  for a pre-migration pending row). OpenAPI spec updated to match.
- New `pending_registrations.company_slug` column (migration 24, `schema.sql`).

### Verification

- `auth-routes.test.js` switched to `companySlug`, plus a new end-to-end
  regression test that seeds a name/slug-mismatched company
  (`Paxone`/`paxone-gmbh`) and asserts request → confirm succeeds and creates
  a pending user under the right company. `db-migrations.test.js` covers
  migration 24. Full suite: 44 suites / 962 tests green; lint clean.
- Manual browser run reproduced the exact mismatch (dropdown label `Paxone`,
  value `paxone-gmbh`) and confirmed request → confirm → pending now works.

---

## [server-v1.11.169] — 2026-07-01

**Feat (#449): user management at company level — Test-Manager approval replaces the email-must-match-company-name gate.**

### Added

- **Self-registration no longer requires the signup email to contain a
  fragment of the company name.** `emailMatchesCompany()` is removed from
  `auth.js`. The applicant instead must pick a real, existing company from
  the `/register/companies` dropdown (already enforced client-side; now also
  enforced server-side in `register/request`).
- **New account approval workflow.** A confirmed self-registration lands as
  `users.status = 'pending'` and cannot log in (403) until a Test Manager of
  that company — or an administrator, as a cross-company fallback — approves
  it. Every Test Manager of the company is emailed
  (`sendPendingApprovalEmail`, `mailer.js`) with a link to the admin Users
  tab as soon as the registration is confirmed.
- **New endpoints** `POST /v1/company/users/:id/approve` and
  `POST /v1/admin/users/:id/approve` activate a pending user. Rejecting one
  reuses the existing `DELETE` endpoint.
- **Admin UI** (`admin.html`) — a "Pending" status badge and an `Approve`
  button appear on pending rows in the User Directory, for both the
  Test-Manager and administrator views (both already routed through the
  same `USERS_API_BASE` switch).
- New `users.status` column (migration 23, `schema.sql`), default `'active'`.

### Changed

- Removed the `register/confirm` auto-create-company-from-free-text branch —
  it was unreachable from the UI dropdown, and kept alive would have let a
  stranger self-activate into a brand-new, unverified company with no Test
  Manager to approve them.

### Verification

- `auth-routes.test.js` updated for the new contract (seeds a real company;
  confirms `201` + `pending: true`/no token; login `403` while pending;
  login succeeds after direct approval) plus a new pending-login-rejected
  test. Full suite: 44 test suites / 961 tests green.
- Manual run: registered with an email deliberately **not** matching the
  company name → dev-mode confirm link → pending panel (no redirect, no
  auto-login) → login rejected 403 → Test Manager sees the Pending badge +
  Approve button on `admin.html` → approved → login now succeeds. Confirmed
  `register/request` with an unknown company name returns 400.

---

## [server-v1.11.168] — 2026-07-01

**Feat (#448): the Test Framework can now declare which OSDM fulfillment
types/media the provider actually supports.**

### Added

- **Test Framework → new "🎟 Fulfillment" section** — pill pickers for
  `fulfillmentType` (ETICKET, CIT_PAPER, PASS_CHIP, PASS_REFERENCE) and
  `fulfillmentMedia` (PDF_A4, UIC_PDF, PKPASS, ALLOCATOR_APP, RCCST, RCT2,
  TICKETLESS), wired to the already-existing `framework.fulfillment.{types,media}`
  data model and generic `fw-pill` toggle mechanism (`fwTogglePill`) — the same
  pattern used by Seat Selection / Passenger Types / Place Selection. Persists
  via the existing debounced framework auto-save; no new endpoint needed.
  Leaving a category empty means "no restriction" (matches `fwFilter`'s
  existing empty-means-full-set contract, same as every other framework pill
  group).
- This directly activates the scenario-level "E. Fulfillment" picker
  (`sc.fulfillmentTypes`/`sc.fulfillmentMedia`), which already calls
  `fwFilter(..., fw.fulfillment.types/media)` — that call site existed and
  worked correctly already, but had no real input to filter against (the
  framework value was frozen at its un-editable default). It now reflects what
  the Test Manager actually declared.

### Removed

- `fwToggleFulfilPill` — a narrower duplicate of the generic `fwTogglePill`
  handler with zero call sites (defined, never wired to any UI action). The
  new section uses the generic mechanism instead; keeping both would leave two
  ways to do the same thing.

### Verified

- Harness over the REAL extracted `fwTogglePill` + `fwFilter` — 12/12: toggle
  on/off correctly mutates `framework.fulfillment.types`/`.media` (and only the
  targeted subKey); `fwFilter` reflects the change immediately; clearing a
  category reverts to the unrestricted full OSDM set (existing empty-means-full
  contract, unchanged). `node --check`, eslint, and the inline-script HTML
  linter clean.

### Notes

- Scope: this ships the framework-level *declaration* UI, which is what issue
  #448 asked for. The separate, pre-existing scenario editor for the shared
  `requestedFulfillmentOptionsList` (`buildFulfillmentSection`, fixed in #436 to
  show the unrestricted OSDM set) is intentionally left as-is — extending
  *that* surface to warn on an undeclared type/media would need a genuinely
  different mechanism (`frameworkGating.js`'s rule engine matches a single
  boolean scenario flag against a `salesFlows` declaration; fulfillment options
  are a list of `{type, media}` objects) and is a natural, separately-scoped
  follow-up, not bundled into this PR.

---

## [server-v1.11.167] — 2026-06-25

**Feat (#447, requested by Wiremind): link a Test Finding to the scenario that
revealed it — faster to re-test a fix as a non-regression run.**

### Added

- **`finding.scenario_code`** — a new optional column (migration 22) recording
  the datafile `scenario.code` that revealed the finding. Set on create/edit via
  a free-text field with autocomplete against the test-system's current
  scenario codes (sourced from `GET /v1/company/datafile`); accepts any value,
  so a finding tied to a since-renamed or deleted scenario keeps its record.
  Exposed on the API as `scenarioCode` (create, patch, list, thread, and the
  JSON bulk-import path all carry it — same shape as `step`/`expectedStatus`).
- **UI** — the finding list row and the thread's opening-post header show a
  🧪 chip with the scenario code, linking straight to **Test Config**
  (`/scenarios.html`) so the tester can find and re-select that exact scenario
  to verify a fix, instead of re-deriving which one it was from the finding's
  prose.

### Verified

- `db-migrations.test.js`: migration 22 applies on a fresh install AND restores
  `scenario_code` on a DB already versioned past it (the #208-class upgrade
  regression guard) — extended `REQUIRED_COLUMNS` + a dedicated upgrade test.
- `findings-routes.test.js`: 2 new tests — `scenarioCode` round-trips through
  create → list → thread, defaults to `null` when omitted, and PATCH can set
  and clear it.
- Full suite: 44 test suites / 960 tests, all green. `node --check` + eslint +
  the inline-script HTML linter clean on every changed file.

---

## [server-v1.11.166 / OTST_V2.0.94] — 2026-06-18

**Fix (#445): `nullable: true` scalar fields no longer FAIL when the provider
returns `null` — a spec-legal value was producing false failures (reported on SBB
FULL_FLEX).**

### Fixed

- **`offers.js` + `refunds.js`** — type assertions for OSDM scalar fields that are
  declared `nullable: true` required the JS type and rejected `null`. A code
  generator emits these as `null` when the field is not applicable (returned for
  consistency) — which is conformant — so OSCAR was raising false failures. Now we
  assert **the declared type OR `null`** via a shared `expectTypeOrNull()` helper
  (`testCapture.js`). Fields covered (all confirmed `nullable: true` in OSDM 3.8.0):
  `Price`/`Amount.scale` (admission/reservation price, `afterSaleFee.scale`,
  refund `refundableAmount`/`refundFee`/breakdown scales), `isReusable`,
  part-level + `availablePlaces` `numericAvailability`, `numberOfPrivateCompartments`.
  Required fields (`price.amount`, `currency`) keep their strict checks. Also
  corrected a stale comment in `refunds.js` that wrongly called `scale` "required".

### Verified

- Harness over the REAL extracted `expectTypeOrNull` — 11/11: `null` accepted for
  number/boolean; the declared type still passes; a genuinely wrong type (string,
  object) still FAILS; `undefined` (absent ≠ null) still fails. `node --check` clean
  on all three files; residual-strict-assertion sweep finds none.

---

## [server-v1.11.165] — 2026-06-18

**Feat (#442): `custom` OAuth profile gains `body_format: "raw"` — send the token
body verbatim, so a `client_secret` containing `%` isn't mangled by form-encoding.**

### Added

- **`auth-profiles.js` `_custom` — `body_format: "raw"`** — sends the substituted
  template `body` **verbatim**, with no `URLSearchParams` re-encoding. The existing
  `"form"` mode builds the body with `URLSearchParams`, which percent-escapes
  `%` → `%25` (and `+` → `%2B`). A token endpoint that takes the body bytes as-is
  (CHAPS / ČD `/auth/login/`) then sees a different secret → `401 err_5002 "Invalid
  username or password"`, even though the same request works in a raw client. `"raw"`
  lets OSCAR match that byte-for-byte. Defaults `Content-Type:
  application/x-www-form-urlencoded` (overridable via the template `headers`).
- **Form-mode hint** — when a credential value in `"form"` mode contains `%` or `+`
  (the characters form-encoding transforms), the run log names the field and points
  at `body_format: "raw"`. Field name only, never the value (keeps the #437 mask
  contract). That one line pinpoints this class of 401.

### Tester template (CHAPS)

```json
{ "method": "POST",
  "headers": { "Content-Type": "application/x-www-form-urlencoded" },
  "body": "client_id={{client_id}}&client_secret={{client_secret}}&grant_type=client_credentials&scope={{scope}}",
  "body_format": "raw",
  "token_field": "access_token" }
```

### Verified

- Harness over the REAL extracted `_substitute` + `SAFE_BODY_KEYS` — 9/9: raw keeps
  `client_secret=ab%cd_e.f+g` verbatim while `form` sends `ab%25cd_e.f%2Bg`; the hint
  flags only the field(s) carrying `%`/`+` and never a `SAFE_BODY_KEYS` key.
  `node --check` + eslint clean.

---

## [server-v1.11.164] — 2026-06-18

**Fix (#440): trim OAuth credentials so a stray paste-whitespace can't cause a
`401` that works fine in a standalone client — plus problem-determination
diagnostics that name, never leak.**

### Fixed

- **`me-credentials.js` / `access-token.js`** — OSCAR trimmed `token_url` and
  `oauth_scope` but never `client_id` / `client_secret`, so a trailing space or
  newline pasted into the API-Config field was encrypted, stored, and sent to the
  OAuth server verbatim → `401 "Invalid username or password"`, even though the
  identical credential works in a standalone client that trims its inputs
  (reported on CHAPS / ČD `…/auth/login/`). The #437 masked diagnostic couldn't
  reveal it — `client_secret=***` masks a clean value and one with a trailing
  newline alike. Every pasted secret is now `.trim()`-ed on store (as
  `token_url`/`oauth_scope` already were), and `client_id`/`client_secret`/`scope`/
  `extra` are trimmed again at use-time so credentials saved before this fix are
  healed without re-entry (the cache fingerprint hashes the trimmed values).

### Added (diagnostics — field/placeholder names only, never values; keeps the #437 mask contract)

- **Whitespace note** — when stray whitespace is stripped from a credential, the
  run log says so, naming the field only: `[runner] Auth — stripped leading/
  trailing whitespace from client_secret before sending …`.
- **Case-insensitive placeholders** — the custom-profile templater now resolves
  `{{CLIENT_ID}}` as well as `{{client_id}}` (it was lowercase-only, so a
  capitalised placeholder was sent literally → same opaque 401).
- **Unknown-placeholder warning** — any unrecognised `{{…}}` in a custom template
  (a typo like `{{secret}}`) is listed in the run log before the request goes out.

### Verified

- Harness over the REAL extracted `_substitute` (now case-insensitive) and
  `_unknownPlaceholders` — 14/14. `node --check` clean on all three files; the
  credFp NUL-byte separator preserved.

---

## [server-v1.11.163] — 2026-06-18

**Fix (follow-up to #437): the masked token-request line now shows the full URL,
not just the `Host` header.**

### Fixed

- **`auth-profiles.js` `_logMaskedRequest`** — the diagnostic showed
  `Host: <hostname>` (the HTTP `Host` header, which is hostname-only by spec), so
  during problem determination it read as a truncated/wrong URL (CHAPS: showed
  `Host: osdm-api-test.cd.cz` when the target was
  `https://osdm-api-test.cd.cz/auth/login/`). It now shows the full request target:
  ```
  [runner] Custom request (secrets masked) — POST https://osdm-api-test.cd.cz/auth/login/ | headers: Content-Type: application/x-www-form-urlencoded | body: client_id=***&client_secret=***&grant_type=client_credentials&scope=***
  ```
  The URL was always correct (also on the preceding line; the HTTP status confirms
  the path) — this just makes the masked line self-contained and unambiguous.

### Verified

- `node --check` + `eslint` clean; `_maskHeaders`/`_maskBody` unchanged (still the
  21/21 from #437). Server-only — server 1.11.162 → 1.11.163.

---

## [server-v1.11.162] — 2026-06-18

**Feature (#437): log a *secrets-masked* dump of the token request for problem
determination (e.g. debugging the CHAPS OAuth handshake).**

### Added

- **`auth-profiles.js` `_doFetch` now emits one masked token-request line** for
  every profile (basic / post / paxone / sqills / custom) — the request body was
  previously never logged because it carries the client secret. Shows the **Host**
  (from the URL), **headers**, and **body** with a **default-deny mask**: only an
  allowlist of structural fields keeps its value — headers
  `content-type`/`accept`/`host`/`user-agent`/`accept-encoding`/`connection`; body
  `grant_type`/`response_type`/`body_format`/`token_field`. Everything else
  (`client_id`, `client_secret`, `scope`, `accountName`/`accountSecret`,
  `Authorization`, `Ocp-Apim-Subscription-Key`, api keys, …) is masked to `***`,
  with `(empty)` distinguishing a blank field from a populated one (often the
  actual cause). A newly-introduced secret field is masked **by default**. Example
  (oauth2_post / CHAPS):
  ```
  [runner] OAuth2[post] request (secrets masked) — Host: osdm-api-test.cd.cz | headers: Content-Type: application/x-www-form-urlencoded | Accept: application/json | body: grant_type=client_credentials&client_id=***&client_secret=***&scope=***
  ```
  Wrapped in `try/catch` so a diagnostics bug can never break the token fetch.

### Verified

- Harness over the **real extracted** `_maskHeaders`/`_maskBody` — **21/21**,
  including the core security property: **no** confidential value (client id/secret,
  scope, Basic value, Ocp-Apim key, account secrets) appears in the masked output —
  across URLSearchParams (post/basic), JSON (paxone/sqills) and opaque bodies;
  default-deny masks unknown headers/keys; empty → `(empty)`. `node --check` +
  `eslint` clean. Server-only — server 1.11.161 → 1.11.162.

---

## [server-v1.11.161] — 2026-06-17

**Fix (follow-up to #433–#435): the scenario "Fulfillment Options" dropdowns
still showed only "E-ticket" for a new provider — a *dead framework filter*.**

### Fixed

- **`public/js/scenarios.js` `buildFulfillmentSection` — show the full OSDM
  fulfillment set in the scenario editor.** The dropdowns filtered the OSDM enums
  by `wizData.framework.fulfillment.types/media`, which **defaults to
  `['ETICKET']`/`['PDF_A4']`** — and the only function that edits it
  (`fwToggleFulfilPill`) **isn't wired to any UI**, so a new company (SBB) was
  permanently locked to E-ticket/PDF-A4 and could never request `TICKETLESS`. The
  scenario "Fulfillment Options" editor is where the tester **explicitly chooses
  what to request**, so it now sources the lists straight from the canonical
  `ENUMS` (`typeList = ENUMS.fulfillmentType`, `mediaList = ENUMS.fulfillmentMedia`)
  — the same set the datafile schema (#434) already accepts. The dead
  `framework.fulfillment` filter (and its now-unused `fwFul` local) is removed;
  the server-side framework gating still flags anything the provider hasn't
  declared. This is the layer my #435 missed — that fixed the (separate, also
  stale) framework-editor lists; this fixes the dropdown you actually see.

### Security (rides along)

- **Bumped `multer` `2.1.1 → 2.2.0`** to clear two newly-published **HIGH** DoS
  advisories (GHSA-72gw-mp4g-v24j — deeply nested field names; GHSA-3p4h-7m6x-2hcm
  — incomplete cleanup of aborted uploads) that `npm audit` started flagging on
  every PR (latent on `main`). `multer` is the datafile-upload dependency (already
  auth-gated + rate-limited). Minor bump within the existing 2.x — `npm audit` →
  **0 vulnerabilities**. Unrelated to the dropdown fix, but required to clear CI.

### Verified

- `scenarios.js` `node --check` clean; no dangling `fwFul` reference; the dropdown
  now offers the same OSDM set used by datafile validation. `npm audit` clean after
  the multer bump. Server-only — server 1.11.160 → 1.11.161, collection unchanged
  OTST_V2.0.93.

---

## [server-v1.11.160] — 2026-06-17

**Fix (follow-up to #433): the scenario wizard had the same OSDM enum drift as the
datafile schema — the Fulfillment Type dropdown offered only "E-ticket".**

### Fixed

- **`public/js/scenarios.js` — the Test-Framework editor's enum lists were stale.**
  A scenario's fulfillment options are gated by the company's declared framework
  capabilities, but the framework editor's option lists held **invalid, non-OSDM
  values** and missed valid ones, so the correct fulfillment could never be
  declared (SBB saw only "E-ticket"; `TICKETLESS` was unreachable). Sourced the
  four affected lists from the canonical `ENUMS` (single source of truth):
  - `WIZ_FULFIL_MEDIA` (had bogus `AZTEC_CODE/QR_CODE/NFC`) → the **7** OSDM media.
  - `WIZ_FULFIL_TYPES` (had bogus `PAPER_TICKET`) → the **4** OSDM types.
  - `WIZ_TRAVEL_CLASSES` (had non-OSDM `THIRD/BUSINESS`) → `FIRST/SECOND/ANY_CLASS`.
  - `WIZ_OFFER_MODES` (had `COMBINATION`) → `INDIVIDUAL/COLLECTIVE`.

  `WIZ_SERVICE_CLASSES` + `WIZ_FLEXIBILITIES` were already in sync. **Flagged for a
  follow-up** (narrower-but-all-valid, with dependent age/mapping code):
  `WIZ_PAX_TYPES` (missing `PERSON/PRM_CHILD/COMPANION_DOG`) and `WIZ_OFFER_PARTS`.
- **Workflow note:** to use a newly-available media/type in a scenario, declare it
  in the company's **Test Framework** first — the scenario dropdowns are gated by
  the framework, then offer whatever it declares.

### Verified

- `scenarios.js` `node --check` clean; the 4 rewired constants reference `ENUMS`
  (defined earlier, line 26); the removed bogus values have no other references.
  Server-only — server 1.11.159 → 1.11.160, collection unchanged OTST_V2.0.93.

---

## [server-v1.11.159] — 2026-06-17

**Fix (#433): datafile schema enums were narrower than the OSDM spec — valid
provider test data (e.g. SBB's `TICKETLESS` fulfillment) was wrongly rejected.**

### Fixed

- **`json_validator/datafile.schema.json` — widened 3 stale enums to the OSDM
  source-of-truth.** The schema validated every datafile, but three enums had
  drifted *narrower* than the OSDM enum the rest of OSCAR already uses, so valid
  data was rejected with "⛔ Invalid JSON Data file structure":
  - `fulfillmentMedia`: `PDF_A4, UIC_PDF` → **7** (adds `PKPASS, ALLOCATOR_APP,
    RCCST, RCT2, TICKETLESS`) — matches `model.js` FulfillmentMediaType + wizard.
  - `fulfillmentType`: `ETICKET` → **4** (adds `CIT_PAPER, PASS_CHIP,
    PASS_REFERENCE`) — matches `model.js` FulfillmentOptionType + wizard.
  - `passengers[].type`: `PERSON` → the **20** `OSDM_PASSENGER_TYPES` — matches
    `osdmEnums.js` (the declared SSOT; `passengers.js`/`offers.js` runtime
    assertions already accept all 20).
- **Audited every other schema enum** against the OSDM sources — `serviceClass`
  (5), `travelClass` (3), `requestedOfferParts` (8, incl. CONTINUOUS_SERVICE),
  `flexibilities`/`desiredFlexibility` (3) and `offerMode` (2) were already in
  sync; OSCAR-internal harness enums are out of scope. No runtime/behavior change
  — only the schema gate widened (the flow already handles these values).

### Verified

- Schema parses; the 3 enums now hold 7 / 4 / 20 values (0 SSOT passenger types
  missing). **ajv** (the runtime validator) — **11/11**: `media`/`type`/`pax`
  accept `TICKETLESS, PKPASS, PDF_A4, CIT_PAPER, ETICKET, DOG, YOUTH, PERSON` and
  still reject `BOGUS`/`NOPE`/`ALIEN`. Collection OTST_V2.0.92 → OTST_V2.0.93;
  server 1.11.158 → 1.11.159.

---

## [server-v1.11.158] — 2026-06-17

**Fix (#430): a 401/403 on an unsupported endpoint no longer hard-stops the whole
run — the auth fail-fast now honors the step policy, exempts `/versions`, and
yields to known deviations.**

### Fixed

- **`checkAuthRejection` ([auth.js]) no longer aborts the run on every non-token
  401/403.** The #208 fail-fast treated any 401/403 as a dead/expired token and
  called `stopExecution()`, overriding both the step-failure policy and the
  known-deviation system — so a new provider that answers **403 "endpoint not
  supported"** on `GET /versions` (System Version Check, step 00) killed the run
  before anything else executed. It now flags the rejection but **does not stop**
  when **any** of:
  - **(a)** the request is the **System Version Check** (`GET /versions`) — an
    optional capability probe; a genuinely dead token is still caught at the first
    business request, one step later;
  - **(b)** `stepFailurePolicy ≠ HARD_STOP` (the tester chose `CONTINUE`); or
  - **(c)** the step+status is a **declared known deviation**.

  The default dead-token fail-fast (HARD_STOP + undeclared + business endpoint) is
  **unchanged**, so the cascade protection stays. `opencollection.yml` now passes
  the request URL into `checkAuthRejection` for robust `/versions` detection.
- **`handleSystemInfoStatus` honors known deviations.** A baselined system-info
  non-2xx (e.g. a provider's 403 on `/versions`) is reported as a **documented
  known deviation** (`[WARNING]`, not a failure), consistent with the
  refund/exchange 405 baseline — so the tester can baseline `GET /versions → 403`
  once and keep the run green.

### Verified

- Harness over the **real extracted** `checkAuthRejection` + `handleSystemInfoStatus`
  — **14/14**: non-401/403 + token steps ignored; 403/401 on `/versions` (by URL
  and by name) → no stop; **regression guard** — 403/401 on a business endpoint
  under HARD_STOP (incl. default policy) still **STOPS**; `CONTINUE` → no stop;
  declared known deviation → no stop; system-info 200 → ok, 403 undeclared → fail,
  403 baselined → `noteKnownDeviation` + no fail, baselined-but-no-`req` → safe
  fallback. `node --check` clean on both library files; `opencollection.yml` parses
  (js-yaml) and its after-response script parses as JS. Collection
  OTST_V2.0.91 → OTST_V2.0.92; server 1.11.157 → 1.11.158.

---

## [server-v1.11.157] — 2026-06-16

**Feature (#426): configurable company "dedicated headers" in API Config — add
operator-specific request headers without a code change.**

### Added

- **Company-wide "Dedicated Headers" in API Config** (`profile.html` → *Company —
  Shared* card). A Test Manager can add any number of extra HTTP headers sent on
  **every** OSDM request, via a `➕ Add dedicated header` button. Each row is a
  header **name** + **value**; the value may be a literal (e.g. `staging`) or
  reference an existing variable in double braces — `{{requestor}}`,
  `{{Ocp-Apim-Subscription-Key}}`, `{{access_token}}` — resolved **per tester** at
  request time, so secrets stay out of the shared config. The list is shared with
  the company's testers and is read-only for non-Test-Managers.
- **Storage + API.** New `companies.extra_headers` column (JSON array, migration
  v21). `GET /v1/company` surfaces the parsed array; `PATCH /v1/company` accepts
  `extra_headers` (**Test-Manager-only**) and validates it — RFC 7230 header-name
  token, rejects CR/LF (header-injection guard), caps 25 headers × 4096 chars, and
  drops blank rows.
- **Injection.** `runner.buildEnvYml` emits an `__extraHeaders` env var
  (YAML-escaped JSON); the Bruno collection's `before-request` hook
  (`opencollection.yml`) parses it, resolves any `{{var}}` templates against the
  env, and calls `req.setHeader(name, value)` per entry. This **generalises** the
  previously hardcoded `Ocp-Apim-Subscription-Key` injection so new
  operator-specific headers no longer need a collection edit. Collection
  OTST_V2.0.90 → OTST_V2.0.91.

### Verified

- Harness over the **real extracted** code — **40/40**:
  `normalizeExtraHeaders`/`parseExtraHeaders` (valid + blank-name drop; rejects for
  space/colon names, CR/LF, >4096-char value, >25 rows, non-array; hyphen·dot and
  `Ocp-Apim-Subscription-Key` names accepted; numeric/null value coercion; a
  `{{var}}` value preserved verbatim); `buildEnvYml` `__extraHeaders` emission with
  quote/backslash YAML round-trip and "no line when empty/undefined"; and the
  `opencollection.yml` resolver (`{{var}}` incl. hyphenated + whitespace-padded
  names, literal, partial `Bearer {{access_token}}`, unknown→empty, blank-name
  skip, malformed JSON caught → no throw + no headers set, absent → no-op).
- `npm run lint` clean (eslint + inline-HTML script linter, 15 files);
  `opencollection.yml` parses (js-yaml). Server 1.11.156 → 1.11.157.

---

## [server-v1.11.156] — 2026-06-16

**Fix (#428): Trivy gate failing on Bruno CLI `axios` / `form-data` HIGH CVEs —
the in-place override was silently a no-op.**

### Security

- **Clear 12 HIGH CVEs in the Bruno CLI's bundled dependencies** (`Oscar_Server/Dockerfile`):
  - `axios` **1.13.6 → 1.18.0** — CVE-2026-42033 / -42035 / -42043 / -42264 and the
    newly-published -44486 / -44487 / -44488 / -44492 / -44494 / -44495 / -44496 (11 HIGH).
  - `form-data` **4.0.4 → 4.0.6** — CVE-2026-12143 (multipart boundary via `Math.random()`).
- **Root cause:** `@usebruno/js` and `@usebruno/requests` pin `axios` by **exact**
  version (1.13.6). The previous `npm install axios@^1.15.2 --no-save` had no
  manifest entry to satisfy, so npm pruned the fresh copy and restored the pin —
  the image kept shipping 1.13.6. It passed historically only via a **cached
  Docker layer**; a cold-cache build re-exposes it (so this was latent on `main`).
- **Fix:** axios is a *direct* dependency of `@usebruno/cli`, so an npm
  `overrides` entry errors `EOVERRIDE`. Instead we **bypass npm resolution** and
  unpack the patched release tarball (`npm pack`) directly over every nested
  `axios`/`form-data` copy, then **assert** at build time that each is patched
  (fail the build otherwise — no broken image ships). axios 1.x / form-data 4.0.x
  are API-stable drop-ins and their runtime deps are already hoisted. Dockerfile-
  only; collection unchanged. Server 1.11.155 → 1.11.156.

---

## [server-v1.11.155] — 2026-06-15

**Fix (#422): baseline the documented Turnit refund/exchange `GET → 405` so it
stops hard-failing the run (extends the #398 known-deviation hook).**

### Fixed

- **`loopback.js _normStep` now tolerates a `Folder/` path prefix** as well as
  the `"NN. "` request-number prefix, so a deviation declared from a
  report-derived step name (`03-Refund/11. GET Refund Offer`) matches the
  request's own label (`11. GET Refund Offer`) — both normalise to
  `get refund offer`. (Previously a baselined finding's folder-prefixed step
  silently never matched.)
- **The #398 known-deviation hook is now wired into `03-Refund/11. GET Refund
  Offer.yml` and `04-Exchange/12. GET Exchange Offer.yml`** (previously only on
  `04. GET Passenger.yml`). Turnit creates refund/exchange offers (`POST` → 200,
  full body) but returns **405** on `GET /refund-offers/{id}` /
  `GET /exchange-operations/{id}`; those steps used to hard-stop the scenario, so
  the rest of the refund/exchange flow never ran. A documented 405 (the
  `baselineInRun` finding on the Turnit board) is now reported as a PASSING
  "known deviation" + `[WARNING]` and the flow proceeds — the offer id came from
  step 10/11, so steps 12-16 (incl. `13. PATCH Refund Offer`) don't need this
  body. Any **undocumented** non-200 still hard-stops; the 200 happy path is
  untouched. Collection OTST_V2.0.89 → OTST_V2.0.90.

### Verified

- Harness over the real extracted `_normStep` + `knownDeviationFor` — **11/11**:
  folder-prefixed ↔ short labels collapse equal; refund/exchange 405 match the
  documented deviation; legacy `GET Passenger` 501 still matches; 200 and
  undocumented (404) → no match; `active:false` not enforced; empty list → null.
  `node --check` on `loopback.js` clean; both edited yml after-response scripts
  parse as valid JS. Server 1.11.154 → 1.11.155.

  **Note:** baselining steps 11/12 lets the refund/exchange flow continue past
  the 405 — a fresh Turnit run will reveal whether 12-16 (esp. `13. PATCH Refund
  Offer`) complete or surface a new finding.

---

## [server-v1.11.154] — 2026-06-15

**Fix (#420): "Discover timetable" finds 0 trips on PAXONE — it queried at
midnight; PAXONE returns offers only around the requested time.**

### Fixed

- **Discovery now queries PAXONE at a daytime hour** (`company-test-resources.js`
  `_tripSearch`). After #418/#419 cleared the 422, PAXONE discovery returned 200
  but **0 trips every day**, even on a route the SALE scenario proves runs.
  Confirmed from the PAXONE SALE report: the working request searches
  `departureTime: …T06:00:00` and gets `trips[].legs[].timedLeg` (exactly what
  `harvestTrips` reads — the harvester is fine); discovery searched
  `…T00:00:00` (**midnight**). PAXONE returns offers only *around* the requested
  time, so a midnight query finds nothing (its sandbox trains run daytime). Fix:
  query PAXONE at `T08:00:00`, gated on `/paxone/i`; Bileto (offset) and every
  other sandbox keep midnight (whole-day), unchanged. Server-only — collection
  unchanged.

### Changed

- **Each discovery day now reports its `offers` count** alongside `trips`/`legs`
  in `dayResults`, so a future "0 trips" is self-diagnosing: a 2xx day with
  `offers > 0` but `trips == 0` is a harvest/shape issue, whereas `offers == 0`
  means no service for that day/time.

### Verified

- Harness over the **real extracted** `_tripSearch` — **6/6**: PAXONE →
  `T08:00:00` (no offset); Bileto → `T00:00:00+00:00` unchanged; other sandboxes
  → `T00:00:00` unchanged; `undefined` apiBase safe; case-insensitive.
  `node --check` clean. Server 1.11.153 → 1.11.154; collection unchanged
  (OTST_V2.0.89).

---

## [server-v1.11.153] — 2026-06-15

**Fix (#418): "Discover timetable" fails on PAXONE (422) — the server-side
companion to #416.**

### Fixed

- **The "Discover timetable" feature now sends `offerSearchCriteria.{currency,
  offerMode}` for PAXONE** (`company-test-resources.js` `_discoveryBody`). The
  train-set discovery that scans `POST /offers` across N days was sending
  `offerSearchCriteria: {}`, so on PAXONE every searched day returned a 422
  VALIDATION_ERROR and discovery reported *"No usable offer response across the
  searched days"* — blocking timetable discovery entirely. #416/#417 fixed the
  Bruno **request builder** (`requestsBuilder.js`) but missed this **server** path,
  which is the one behind the Discover-timetable button. `_discoveryBody` now
  sends `{ currency: 'EUR', offerMode: 'INDIVIDUAL' }` for PAXONE (neither filters
  the harvested timetable); every other sandbox keeps the empty criteria,
  unchanged. Same `/paxone/i` api_base gate. Server-only — collection unchanged.

### Verified

- Harness over the **real extracted** `_discoveryBody` (source-extracted + eval'd
  — the route module opens the DB on require) — **6/6**: PAXONE → currency +
  offerMode with trip/passenger preserved; non-PAXONE → empty `{}`; case-
  insensitive; non-offers endpoint → bare trip; `undefined` apiBase safe.
  `node --check` clean. Server 1.11.152 → 1.11.153; collection unchanged
  (OTST_V2.0.89).

---

## [server-v1.11.152] — 2026-06-15

**Fix (#416): PAXONE offer requests fail (422) without
`offerSearchCriteria.{currency,offerMode}`.**

### Fixed

- **For PAXONE, default `offerSearchCriteria.currency` + `.offerMode` on the offer
  requests** (`requestsBuilder.js`). Both are optional in OSDM but PAXONE rejects
  their absence with a 422 VALIDATION_ERROR, blocking offer/discovery for any
  scenario that doesn't declare them. New helper
  `withPaxoneOfferSearchCriteriaDefaults()` fills `currency` (from the scenario's
  `offerSearchCriteriaCurrency`, else `EUR`) and `offerMode` (`INDIVIDUAL`) on both
  the outbound (`buildOfferCollectionRequest`) and return
  (`buildReturnOfferCollectionRequest`) requests. Gated behind the existing
  `isPaxone` check — no other sandbox's offer request changes; only the two missing
  keys are filled (criteria the scenario already set pass through untouched), and
  the input is never mutated. Not tracked as a finding (PAXONE is simply stricter
  than these optional-by-spec fields). Collection OTST_V2.0.88 → OTST_V2.0.89.

### Verified

- Harness over the real extracted `withPaxoneOfferSearchCriteriaDefaults` — 10/10
  (absent/null → EUR+INDIVIDUAL; scenario currency respected; partial fills only
  the missing key; fully-specified unchanged; empty-string treated as missing;
  non-object → fresh defaults; input not mutated). `node --check` clean. Server
  1.11.151 → 1.11.152.

---

## [server-v1.11.151] — 2026-06-15

**Fix (#414): `GET Passenger` false-fails when a provider returns passengers out
of submitted order (Turnit).** Surfaced by the Turnit report analysis.

### Fixed

- **`passengerIdList` is now ordered to the SUBMITTED passenger order, keyed on
  `externalRef`** (`bookings.js`). The per-passenger steps (`03. PATCH Multi
  Passenger`, `04. GET Passenger`) pair `passengerIdList[i]` with
  `passengerAdditionalData[i]` BY INDEX. Because `passengerIdList` was built in
  booking-return order while the expected data is in submitted order, a provider
  that reorders passengers (Turnit: submitted `[PAX01…PAX05]` → returned
  `[PAX05,PAX04,PAX02,PAX03,PAX01]`) made every per-passenger field compare
  against the wrong row — ~25 false failures on a 5-pax run, all data otherwise
  correct. New helper `alignPassengerIdsToSubmittedOrder()` maps the booking's
  passenger ids back to submitted order via the `externalRef` OSCAR sends and the
  provider echoes (on the booking + on `GET /passengers/{id}`). Falls back to
  booking order when refs are absent / counts mismatch / any ref is unmappable,
  so providers that don't echo `externalRef` and providers that already return in
  order (identity no-op) are unaffected; a `[WARNING]` documents any realignment.
  Collection OTST_V2.0.87 → OTST_V2.0.88.

### Verified

- Harness over the **real extracted** `alignPassengerIdsToSubmittedOrder`, driven
  by the actual Turnit booking JSON + synthetic cases — **17/17**: real reorder
  aligns (`passengerIdList[i] ↔ submittedRefs[i]`, ids a permutation of booking
  ids); downstream comparison OLD 5/5 mismatches → NEW 0/5; in-order provider
  identity no-op; no-externalRef / count-mismatch / unknown-ref / empty / null all
  fall back to booking order. `node --check` clean. Server 1.11.150 → 1.11.151.

---

## [server-v1.11.150] — 2026-06-15

**Feature (#412): Test Findings list — category accordion with New/WIP/Closed
lifecycle groups.**

### Changed

- **The Test Findings & Open Points list now groups by category as a collapsed
  accordion** (`public/js/findings.js`). Each category (`provider_deviation`,
  `oscar_issue`, `not_supported`, `spec_question`, `open`) is a collapsed card
  whose header shows the lifecycle breakdown — **New** (not yet reviewed) ·
  **WIP** (discussion ongoing) · **Closed** (settled) — as counts, with zero
  buckets muted. Expanding a category reveals the three lifecycle sub-groups,
  themselves collapsed; expanding one lists its findings. Both accordion levels
  remember their open/closed state across re-renders, plus a `⊞ Expand all /
  ⊟ Collapse all` toggle. Finding rows are leaner now that the headers carry
  category + lifecycle: severity dot · title · ⚙ in-runs · 📣 OSDM · 💬 replies ·
  step/HTTP line; clicking a row opens the existing thread unchanged.
- New/WIP/Closed is a **display-only relabel** of the stored
  `open`/`discussing`/`resolved` status (the thread-view status pills + badge
  adopt the same words). No API, schema, or data-model change — front-end only.

### Verified

- `node --check` on `findings.js` clean; `public/js` is outside the eslint scope
  (CI lints `src/`). The grouping + lifecycle-count logic was previewed against
  the live 12-finding Bileto board (Provider deviation 9 / OSCAR issue 1 / Not
  supported 2, all New) — collapsed and expanded states render as specified.
  The findings API is unchanged (still covered by `findings-routes.test.js`).
  **Access confirmed unchanged**: findings are company-scoped
  (`GET /v1/company/findings` → `WHERE company_id = req.user.companyId`), so
  every Test Manager + tester of a company shares one board. Server
  1.11.149 → 1.11.150; collection unchanged OTST_V2.0.87.

---

## [server-v1.11.149] — 2026-06-14

**Fix (#410): placeSelection `reservationId` stale across offers (#14/#15)** —
surfaced by the Bileto report analysis.

### Fixed

- **`requestsBuilder.js` now derives the booking `placeSelections.reservationId`
  from the SELECTED offer at build time** instead of trusting a `reservationId`
  env var that `offers.js` sets by first-match and keeps across offers
  (`offers.js:1642`). In multi-offer flows (`…_RETURN`, `ADD_TO_BOOKING`) that
  value could point to a `reservationOfferPart` of a *different* offer than the
  one being booked — which the `#377` pre-flight rejected (Bileto #14) and which
  drove the Bileto add-reservation 400 (#15). The env value is honoured only
  when it IS a part of the selected offer; otherwise the part matching the
  chosen accommodation (else the first reservation part) is used; `#377` stays as
  the guard. Resolves the deferred place-selection audit item. Collection
  OTST_V2.0.86 → OTST_V2.0.87.

### Verified

- Harness over the real `resolvePlaceSelectionReservationId` — 8 checks
  (env-id-valid keep; stale-id re-derive [the Bileto #14 repro]; accommodation
  match; no-offer keep; unset→first; offer-as-JSON-string; valid-non-first keep;
  empty-parts keep). `node --check` clean.

---

## [server-v1.11.148] — 2026-06-14

**Findings: generic Import (#408)** — file a whole set of findings (e.g. OSCAR's
per-sandbox analysis) into the register in one click.

### Added

- **"⬆ Import" button on the Test Findings page** (test_manager). Paste a JSON
  array of findings and they're created via the existing
  `POST /v1/company/findings` — each authored "OSCAR analysis" unless the item
  sets `createdBy`. Replaces the removed hardcoded ÖBB seed with a generic,
  per-sandbox path, and is the front door for the Phase 2A auto-analyzer.
  Frontend-only (`public/js/findings.js`); no server change.

---

## [server-v1.11.147] — 2026-06-14

**One-click bulk report download (#405)** — download every run's reports in a
batch as a single ZIP, from the Dashboard.

### Added

- **"⬇ Reports" button on each Dashboard batch header.** One click streams a
  single ZIP of every run's artifacts in that batch — each run's HTML report +
  raw JSON results, named by scenario — as `{sandbox}_{date}_batch-{id}.zip`.
  Endpoint `GET /v1/runs/batch/:batchId/reports.zip` (strictly company-scoped;
  artifacts decrypted at-rest on the way out; rate-limited). No more downloading
  reports one-by-one — and a whole sandbox batch can be handed to OSCAR for
  analysis as a single file.
- **`utils/zip.js`** — a small, dependency-free store-mode ZIP writer (with a
  self-contained CRC-32), in keeping with the codebase's hand-rolled-over-
  dependency convention (cf. `utils/at-rest.js`). Unit-tested, and the endpoint
  integration-tested.

---

## [server-v1.11.146] — 2026-06-14

**Findings UX + report naming (#403)** — quality-of-life fixes after the Test
Findings feature went live on real sandboxes.

### Fixed

- **Run-artifact downloads are now self-describing.** The JSON results file
  downloaded from a run page is named `{sandbox}_{date}_{scenario}.json`
  (length-capped, filesystem-safe) instead of the anonymous `bru_results.json`,
  so a folder of downloaded reports is no longer indistinguishable
  (`run-detail.html`, derived client-side from the run metadata).

### Changed

- **Dropped the hardcoded ÖBB seed from the Findings page.** The "Import the
  ÖBB / Nightjet starter set" button was rendering on *every* sandbox (Bileto
  included), not just ÖBB. Removed — it was a Phase-1 convenience; the generic
  per-sandbox analyzer (Phase 2A) is its proper replacement, and ÖBB's findings
  are already imported. The empty state now points to **＋ Open a finding**.

---

## [server-v1.11.145] — 2026-06-14

**Test Findings & Open Points (#400)** — the per-test-system known-deviation
checklist becomes a threaded conformance dialogue, on its own main-menu page.

### Added

- **"Test Findings & Open Points" page** (`/findings.html`, new nav item for
  testers + test managers). A per-test-system, threaded record of conformance
  findings: OSCAR's analysis opens a point (observation + its reading of the
  spec); the test team replies, classifies (category / severity / status) and
  resolves on the thread. Soft-worded on purpose — a finding may be the
  provider's deviation **or** OSCAR's own issue; the dialogue decides. A
  "raise to OSDM" flag earmarks items as working-group feedback. Ships a
  one-click ÖBB / Nightjet starter set (OSCAR's analysis — 7 open points).
- **Server store + API** — `finding` + `finding_comment` tables (schema.sql);
  `GET/POST/PATCH/DELETE /v1/company/findings` and
  `POST /v1/company/findings/:id/comments`. Reads = the vendor's own users;
  writes = `test_manager` only (admins + certifiers excluded, mirroring the
  datafile). Integration-tested (`tests/integration/findings-routes.test.js`).
- **Run-time projection** — a finding the team baselines (a step + a documented
  HTTP status) is projected server-side into the datafile's `knownDeviations[]`
  (`utils/knownDeviationProjection.js`), so the #398 Bruno engine reports it as
  documented instead of FAILED. The array is server-managed: regenerated on any
  finding change and on every datafile save, so a wizard save can never wipe or
  hand-edit it.

### Changed

- **Known-deviation declaration moved out of Test Config.** The #398 wizard
  panel (v1.11.144) is replaced by the dedicated Findings page — it isn't run
  configuration, it's a standing conformance record. The #398 Bruno engine
  (`loopback.js` / `scenarioParser.js` / `04. GET Passenger.yml`) is unchanged
  and now consumes the server-projected `knownDeviations[]`.

---

## [server-v1.11.144] — 2026-06-13

**Known-deviation baseline (#398)** — a provider's documented gaps stop
dragging every run to FAILED, declared in the UI per test-system.

### Added

- **Per-test-system known-deviation checklist.** The test team registers a
  provider's accepted non-conformances (e.g. `GET Passenger → 501` on ÖBB)
  in the wizard's datafile panel; they persist as a top-level
  `knownDeviations[]` ({step, expectedStatus, note, active}) in that
  sandbox's datafile (sibling of `systemInfoParameters`). A **dedicated
  "Known deviations" card** in the scenarios section (Test-Manager-gated,
  saved by the existing Save & Apply) — add / remove / tick rows; un-ticking
  keeps a deviation on record without enforcing it.
- **Engine** (`loopback.js` + `scenarioParser.js` + `04. GET Passenger.yml`):
  when a step's HTTP status matches a ticked deviation, OSCAR emits a
  **passing** "known deviation (documented)" row + a WARNING instead of
  throwing — so a clean run is no longer FAILED by an already-reported gap.
  Any *other* status still fails for real (the baseline can't hide a
  regression), and a per-run tally records what was seen. Matching is
  tolerant of the `"NN. "` request-name prefix; `active:false` items are
  kept but not enforced. Safe no-op until a deviation is ticked
  (`knownDeviations` defaults to `[]`).

---

## [server-v1.11.143] — 2026-06-13

**Matcher-credibility audit, round 1 (#396)** — sweep of every offer↔booking
pairing function for the first-match-by-type disease that caused false
findings this week. The historically-diseased matchers (afterSalesConditions
#390, appliedPassengerTypes #384) are confirmed fixed; this fixes the one the
audit found in an un-audited flow.

### Changed

- **Exchange-fee validation is now schedule-aware (the refund #391 model
  applied to exchange).** `validateExchangeFeesConsistentWithAfterSalesConditions`
  summed `afterSaleFee` across ALL EXCHANGE windows of ALL parts and
  hard-asserted equality to `exchangeFee` (and to a second naive sum carried
  in an env var) — a part with a two-window schedule (50% before travel /
  100% after) contributed 150%, manufacturing a false "exchange fee mismatch"
  on any multi-window / multi-part offer. Now the expected fee is the sum of
  the **active** window's fee per value-bearing part, **decode-safe**
  (hard-asserts only when every value-bearing part has a decodable active
  EXCHANGE schedule and one currency; otherwise INFO + skip). The check also
  moves out of the `if (appliedOverruleCode)` branch into the normal flow and
  **skips under overrule** (an overrule overrides the schedule) — the old
  gating was inverted, so the normal exchange was never checked.
- **🎯 accommodation goal targets the right reservation.** The booked
  reservation was located by id with `|| bookedRes[0]` — in a multi-reservation
  booking where the id wasn't echoed, the 🎯 goal was silently validated
  against the FIRST reservation. Now: id → requested accommodation type →
  first, with a WARNING when the last fallback is ambiguous (>1 reservation).

### Deferred

- Place-selection `availablePlaces.find(type)[first-subtype]` (offers.js) feeds
  the live booking `placeSelections` — high blast radius; a fix needs a real
  multi-subtype reservation scenario to verify against. Tracked, not guessed.

---

## [server-v1.11.142] — 2026-06-12

**Bundle: catalog-wide refundability sweep (#393) + run-budget ceiling
in the admin panel (#394).**

### Added

- **Catalog flag-vs-schedule sweep (#393)**: the #391 verdict analyses
  only the SELECTED offer; the OBB pattern is catalog-wide (16 of 24 NJ
  offers pin `refundable=NO` over below-price REFUND schedules).
  offers.js now sweeps ALL offers' value-bearing parts with
  `effectiveRefundability` after the per-offer validations and emits ONE
  summary WARNING per action (REFUND / EXCHANGE) when contradictions
  exist — *"16 of 24 offers declare refundable=NO on a value-bearing
  part while their own REFUND schedule charges less than the price (8
  even with a FREE window) — per the spec enum these are WITH_CONDITION;
  8 offer(s) are consistent"*. Silent when nothing contradicts (R8);
  0-price parts skipped (no value to compare fees against, #391).
- **Run Budget Ceiling in the admin panel (#394)**:
  `RUN_HARD_MAX_TIMEOUT_MS` joins `CONFIG_SCHEMA` (60000..7200000) — the
  generic GET/PUT handlers make it visible, validated and persisted to
  `server_config`, which overrides the env var on the next run (no
  restart). The panel previously accepted `RUN_TIMEOUT_MS` up to 3.6M
  while the runner silently clamped every budget at the env-only 30-min
  ceiling — the OBB expired-offer test (`preBookableUntil` = offer
  +30 min) missed its window by one minute on every run, unfixable from
  the UI. `RUN_TIMEOUT_MS` description now names the clamp; panel label
  "Run Budget Ceiling (ms)"; Server Admin Guide row updated.

---

## [server-v1.11.141] — 2026-06-12

**Schedule-aware effective refundability (#391)** — from the OBB
exchange: the refundable/exchangeable FLAG must be read THROUGH the
afterSalesConditions (fee vs price per window); presence of conditions
proves nothing, their content decides.

### Added

- **afterSalesRules.js** (pure): effectiveRefundability(part, at, action)
  — a part is effectively refundable iff SOME declared window charges a
  fee BELOW the price; active-window fee lookup; contradiction
  classification (NO-but-refundable-window, WITH_CONDITION-without-
  schedule, YES-with-full-fee-window). expectedRefundForParts =
  Σ(price − active fee).
- **Schedule-decode assertion at the refund step**: refundableAmount
  must equal what the declared schedule says right now — a Sparschiene
  payout (fee=100%) or a post-departure full refund fails with "the
  engine and its own declared schedule disagree".

### Changed

- **Offer verdict is schedule-first**: Normalpreis/Komfort (flag NO,
  window below price) now PASS with the precise R9 WARNING ("the flag
  does not summarize the rules; WITH_CONDITION is the value for exactly
  this schedule"); Sparschiene FAILS decoded ("every declared window
  charges the full price — a refund would return 0; the schedule
  CONFIRMS the flag") with NO false contradiction.
- **Refund permissibility keys on EFFECTIVE refundability** — the
  schedule-legal Normalpreis full refund no longer raises the false
  "locked value" row; genuinely locked value still fails.

---

## [server-v1.11.140] — 2026-06-12

**Window-aware condition pairing & value-aware refund gate (#389)** —
confirmed with OBB (Marcel) + tester review of release 2026.167.

### Fixed

- **False "the offer said 88950, the booking says 0" rows are gone.**
  Offer↔booking afterSalesConditions now pair by condition type +
  identical validity INSTANTS (timezone-insensitive; the offer speaks
  +02:00, the booking Z), with consumption fallback and a re-use
  WARNING. The old find()-by-type compared every offer window against
  the booking's FIRST window of that type — two REFUND windows
  manufactured the mismatch on perfectly mirrored payloads. The
  "systematic afterSaleFee zeroing" OBB finding is formally RETRACTED.
  New nuance when paired windows genuinely differ (schedules diverge).

### Added

- **Value-aware refund permissibility.** The #387 gate failed only when
  EVERY part declared refundable=NO; a mixed offer (admission NO @ 88950
  + reservation WITH_CONDITION @ 0) passed while the refunded 88950 was
  exactly the NO-flagged admission's value. New gate: refunded value
  (refundable + fee) must not exceed the total price of the parts that
  permit a refund — excess fails decoded ("the provider pays out value
  its own flag declares locked"). Guarded to single-currency/scale.

---

## [server-v1.11.139] — 2026-06-12

**Refundability verdict & report readability (#387)** — from the tester
review of the REFUND-scenario assertions.

### Changed

- **One defect, one row**: the scenario-vs-offer refundable/exchangeable
  verdict is now OWNED by a single check (the two historical duplicates
  demote to DEBUG context). Provider-fairness: `WITH_CONDITION` now
  PASSES (a REFUND/EXCHANGE under conditions is legitimate; only NO
  fails, decoded). R9 WARNING when the flag contradicts the part's own
  afterSalesConditions (refundable=NO yet a REFUND fee schedule present).

### Added

- **Refund permissibility cross-check** at the refund-offers step (once;
  skipped under an overrule): every touched part refundable=NO → failing
  decoded row ("refund proposed on a product whose every part declares
  refundable=NO"); WITH_CONDITION → verify an ACTIVE declared REFUND
  window exists (none → WARNING); unambiguous active-window fee vs the
  refund offer's fee (mismatch → WARNING "engine and schedule disagree").

### Fixed

- **Report UI: failure messages no longer truncated** ("half hidden",
  60-char clip in a 180px column). The decoded message gets a full-width
  wrapped line under the failing assertion row.

---

## [server-v1.11.138] — 2026-06-12

**Expired-flow queue resilience (#385)** — tester finding: all NHF armed
on an OBB REFUND scenario, queue declared 3 sub-runs, run degenerated
into one happy pass.

### Fixed

- **A skipped timer no longer beheads the queue.** Every
  scenario-complete tail now consults the queue first: a sub-run whose
  timer skipped at its step (budget/deadline) — or whose gated step
  never fired — hands the remaining timers their pass. Tally line when
  the queue ends with skips (e.g. "1 of 3 sub-run(s) graded, 2 skipped").
- **Expired-offer deadline now targets BOOKABILITY.** Earliest of part
  validUntil (spec: USE validity — on OBB the trip arrival, days away)
  and Offer.preBookableUntil (the purchasability gate — 2.5 h on OBB).
  Bileto-style hold windows in part validUntil keep working; OBB stops
  producing 11-day waits.
- **A skipped expired-offer timer frees the booking step for the 🧪
  place-selection probes** in the same pass: the skip decision moved
  before the request body is built, and the probes' stand-down check
  honours the effective armed state.
- **Armed-but-inert requestedInformation probe now says so**: when the
  provider's RI vocabulary is unmapped (e.g. OBB's passenger[0].details.*)
  the probe has nothing to withhold — one WARNING instead of silence.

---

## [server-v1.11.137] — 2026-06-12

**Booking validation accuracy round (#383)** — from the tester audit of the
OBB SALE_WIEN_HAMBURG_1LEG_2ADT_3CHD_5BERTH run.

### Changed

- **One failing row per root cause across booking re-reads (Option B).**
  The offer↔booking afterSaleFee mismatch family registers its failing
  assertion ONCE, at create-booking; the 05/07 re-reads seeing the same
  part/condition/values log a [WARNING] "defect already recorded at
  create-booking — still present at this read". A value that CHANGES
  between reads is a NEW finding and fails normally (state-transition
  coverage kept). 6 rows → 2 on the OBB zeroed-fee defect.
- **appliedPassengerTypes now match 1:1 (consumption).** The old
  find()-by-type compared the FIRST booking entry of each type N times
  (log showed booking refs PAX1, PAX1, 00003, 00003, 00003 — our matcher,
  not the provider). Order: exact passengerRef match → first unconsumed
  same-type entry (UUID-rewriting sandboxes) → re-use with one R9 note.
  New nuance when booking entries share passengerRefs.
- **🎯 goal line names the allocated places** (coach/place) and adds an
  R9 WARNING when reservedPlaces count < party size (legitimate for
  multi-passenger compartments — the place list tells which case).

### Fixed

- **One HTTP failure, one row**: 03/04/05/07 registered the status test
  twice on non-200 (once normally, once inside the failure branch).

---

## [server-v1.11.136] — 2026-06-12

**NJ conformance PR3 (#379): reservation spec-coverage depth.**

### Added

- **🧭 Offer-set orientation line** before any filtering: one INFO line
  telling the certifier what the provider returned — accommodation
  families, their subtypes, how many offers carry each, and how many
  offers have no reservation parts.
- **Coverage referential integrity** (R8 — registers only on failure):
  the selected offer's tripCoverage must reference trips/legs that exist
  in the same OfferCollectionResponse; one decoded failure when broken,
  a DEBUG line when OK.
- **Place-selection capability notes** (R9 nuance, never a failure) on the
  chosen reservation part: declared supportedPlaceSelectionFlows +
  graphicalReservation related to the scenario's seat-selection mode
  (seat-map mode vs automatic-only flows; manual-only flows without a
  seat-map scenario; graphicalReservation 'NO'; unknown flow values
  noted as x-extensible-enum extensions).
- **Capacity vs party nuance**: numericAvailability (part- and place-level)
  below the requested party size → one WARNING before booking.

### Fixed

- **Provider-fairness: unknown accommodationType no longer FAILS.** The
  former hard oneOf [SEAT, COUCHETTE, BERTH, VEHICLE, STORAGE] assert
  contradicted the spec — AccommodationType is an x-extensible-enum, so a
  custom code is legal. Structural checks stay hard; list membership is
  now an R9 WARNING. accommodationSubType (open code list) gets no
  membership check at all.

---

## [server-v1.11.135] — 2026-06-12

**NJ conformance PR2 (#378): the place-selection Non-Happy-Flow probe sweep.**
One scenario, one sweep (the #258 purchaser-sweep design): the enabled
probes run INSIDE the booking step — one deliberately-corrupted
POST /bookings per probe, then the step re-runs CLEAN and the flow
continues normally.

### Added

- **Three place-selection probes** (wizard: Non Happy Flow customisation →
  🪑 Place-selection probes):
  - *Omit placeSelections* — rejection expected on a reservation-mandatory
    offer; acceptance WITH a provider-chosen `placeAllocation` is recorded
    as a WARNING (auto-allocation is OSDM-tolerated since `placeSelections`
    is optional); acceptance with NO allocation FAILS (ambiguous booking).
  - *Unknown accommodation type* — asks for `HAMMOCK`
    (AccommodationType is an x-extensible-enum). 400 + RFC-9457 Problem is
    the recommended answer; acceptance → WARNING (tolerant reader); a 5xx
    crash FAILS.
  - *Wrong reservationId* — references a reservation part that exists in
    no offer. Acceptance FAILS (referential integrity).
- **Sweep mechanics**: 🧪 banner per pass, one outcome row per probe in the
  report, RFC-9457 shape grading of every rejection (4xx not 5xx, Problem
  body, field identification) via the shared grader; a rejected probe
  consumes nothing; a wrongly-accepted probe stops the sweep and the run
  continues with that booking. Auth failures (401/403) are flagged as OUR
  problem and not graded. Probes auto-skip (one WARNING) when the scenario
  sends no placeSelections, on two-step returns, and when the
  expired-offer timer owns the booking step.
- `validateProblemResponse` accepts an optional `prefix` so graders outside
  the requestedInformation context keep their own report vocabulary
  (existing call sites unchanged).

---

## [server-v1.11.134] — 2026-06-12

**NJ conformance PR1 (#377): the accommodation goal-closing chain.**
Tester finding: nowhere did the run state that the BERTH requested by the
scenario was actually what got booked.

### Added

- **🎯 Accommodation goal assertions** at the create-booking step: the
  booking must carry the selected reservation part; when the provider
  echoes `placeAllocation` (OSDM: accommodationType, accommodationSubType,
  reservedPlaces, tripLegCoverage required when present), the allocation
  must match the requested family and the offered compartment subtype,
  with non-empty reservedPlaces and matching coverage. Absent
  placeAllocation → one [WARNING] capability note, no failure. One
  `🎯 Accommodation goal MET: requested BERTH → offer advertised
  BERTH/SINGLE_SWC → booking allocated …` INFO line tells the story.
- **Pre-flight self-check on the booking request** (R8 — registers only
  on failure): reservationId must be a part of the selected offer, the
  accommodations must be advertised in availablePlaces, tripLegCoverage
  must lie within the offer coverage. Catches OSCAR regressions and
  incoherent offers at zero provider cost.

### Fixed

- **`offerTripCoverage` now maps the spec's `TripCoverage` form**
  (`coveredTripId` + `coveredLegIds`) — what providers actually send on
  the offer (seen on OBB). The #371 offer-level preference only knew the
  flat `{tripId, legId}` shape, so it silently never fired and always
  fell back to per-place coverage.

---

## [server-v1.11.133] — 2026-06-11

### Fixed

- **Booking price assertions are lifecycle-aware (#375).** OSDM scopes the
  price members to the booking lifecycle: `provisionalPrice` before
  confirmation, `confirmedPrice` once FULFILLED/CONFIRMED. OSCAR asserted
  BOTH at every stage — 2 false ✕ per booking read on every conformant
  provider, plus a raw TypeError when one member was absent. Now keyed on
  the expected booking-part status: the stage member is required, the
  other is logged as allowed-optional, failures are decoded, and the
  price-amount env vars are set per-presence (previously only when both
  existed — i.e. never on conformant data).
- **afterSaleFee mismatches speak the provider's language** (#349
  leftover): "Booking does not echo the offer's REFUND fee amount: the
  offer said 60990, the booking says 0 — the booking must mirror the
  offer's after-sales conditions." replaces the chai
  "expected +0 to deeply equal 60990" tail. (That OBB mismatch itself is
  a genuine provider finding and stays red.)

---

## [server-v1.11.132] — 2026-06-11

### Added

- **Wizard: Accommodation type picker (#373).** The Bruno side has always
  read `scenario.accommodationSelection` (offer filtering by place family +
  the #371 booking `placeSelections`), but the wizard never exposed it —
  the IRT/NJ compartment choice was unreachable from the UI. New
  single-select pill row in **Booking Flow Actions** (next to the
  Seat-selection mode, where the tester looked for it): *— any —*
  (default, behaviour unchanged) / 🪑 Seat / 🛏 Couchette / 🛌 Berth.
  Deliberately NOT gated behind the framework place-selection
  authorisation — the accommodation drives offer selection and the
  booking placeSelections even without the graphical seat map.

---

## [server-v1.11.131] — 2026-06-11

**Booking placeSelections for IRT/NJ mandatory-reservation offers (#371,
OBB requirement).**

### Added

- The booking request now states **which compartment is booked**: at offer
  selection, the chosen `reservationOfferPart`'s real accommodation
  (`accommodationType`/`accommodationSubType` from `availablePlaces`, e.g.
  COUCHETTE / COUCHETTE_COMFORT_4) is persisted and emitted in
  `placeSelections[].accommodations` with the booking passenger refs — no
  fabricated `placeProperties`. BERTH and seat scenarios are covered, not
  just the legacy COUCHETTE path.
- `tripLegCoverage` now prefers the **offer's `tripCoverage`** (object or
  array, per the OBB spec) over the per-place `tripLegCoverage`, which
  stays as the fallback.
- Back-compat gates: the legacy hardcoded COUCHETTE shape (ANY_SEAT +
  placeProperties) is kept when the offer carries no availablePlaces
  detail; scenarios without accommodation/place selection are
  wire-identical. `selectedAccommodation` added to both env delete-lists.

---

## [server-v1.11.130] — 2026-06-11

**Offer-probe follow-up (#369).**

### Added

- **🔄 Re-probe offers** button in the Test Data step: re-runs the
  anonymous-adult offer probe (3 dates) for every distinct O&D across the
  TRAIN resources and refreshes `data.offerProbe` on the affected sets —
  no timetable harvest, no other train changes. Toast summarises routes
  probed / sets updated / findings. Manual for now; automation later.

### Fixed

- **Ancillary catalog could be seeded with the offer-part discriminator.**
  `_collectAncillaries` preferred `AncillaryOfferPart.type` — which carries
  the discriminator (providers send `AncillaryOfferPart`) — over `category`
  (the actual kind, e.g. BICYCLE/MEAL). Now category-first, and
  discriminator-shaped `type` values are never collected. travelClass /
  serviceClass collection audited clean (ServiceClass objects correctly
  yield their `type` enum). Findings builder factored into the service
  (`summarizeOfferProbe`) and shared by discovery + re-probe.

---

## [server-v1.11.129] — 2026-06-11

### Added

- **Timetable Discovery offer probe (#365).** A discovered route does not
  guarantee offers — the discovery now classifies the offer responses it
  already receives (anonymous 1-adult) and persists per-route
  **offer-availability findings** on every train set of the searched O&D:
  *no offer on any probed day* (with the provider's warning/problem echo
  when given), *offers only in SECOND class*, *offers only NON-FLEXIBLE*,
  *offers on X of Y probed days*. The wizard's Test Data step shows a
  **⚠ warnings panel** above the train list (click to expand the per-train
  findings) and a ⚠ chip on each affected train row (hover for details).
  Findings refresh on the next discovery of the route; trips-collection
  responses (no offers[]) are not counted as probed days.
## [server-v1.11.128] — 2026-06-11

### Fixed

- **UX follow-up (#366)** on the 2026.155 round: the **Departure day**
  select moved into the trip grid right next to the Departure time
  (where testers look for it) on SEARCH trips, and sits trip-level
  above the legs on SPECIFICATION (one date covers all legs). The
  **toasts** moved to the upper third of the viewport, overlapping the
  page content, with larger text/padding, a stronger shadow and an
  entrance animation — under-the-nav placement was still missed.

---

## [server-v1.11.127] — 2026-06-11

**Run-setup UX round (#363)** — three Test Manager findings while
setting up OBB runs.

### Added

- **Departure day per trip** (wizard, next to Trip Type): **Auto**
  (default — today + `departureDateFromToday` lead time, unchanged) or
  **Monday…Sunday** for trains that only run on certain days. The
  parser keeps the lead time (the aftersales buffer) and advances 0–6
  days to the next date matching the chosen weekday — one
  `[INFO] 📅 Departure day SATURDAY → 2026-06-27 (… lead time
  preserved)` line states the resolved date. Applies to SEARCH trips
  and SPECIFICATION legs alike (one date per trip, as before). Chosen
  over a hard-coded calendar date per the Test Manager's own rationale:
  a weekday stays valid forever, a date expires.

### Changed

- **Placeholders can no longer be mistaken for values**: wizard-wide
  `::placeholder` styling (lighter + italic) and an automatic "e.g. "
  prefix on the trip-field proposals.
- **Native `alert()` popups replaced by in-page toasts** (27 call
  sites: run.html, dashboard.html, run-detail.html, scenarios.js).
  Toasts render inside the OSCAR UI — top-centre under the nav —
  auto-dismiss (errors stay 12 s), can be closed, and are styled by
  kind (info/success/warning/error). Messages followed by a navigation
  (batch submitted → dashboard) survive via a sessionStorage hand-off
  shown on the next page. `confirm()` decision dialogs stay native.

---

## [server-v1.11.126] — 2026-06-10

**Step-failure policy (#361)** — tester finding on an OBB run: a failed
GET /bookings/{id}/passengers abandoned the scenario before fulfillment
was ever tested.

### Added

- **Scenario parameter `STEP FAILURE POLICY`** in the wizard (next to
  Logging Level): **Hard stop** (default — exactly the historical
  behaviour; existing datafiles unchanged) abandons the scenario via the
  loopback on any step failure. **Continue** records the failure (red
  assertions, scenario verdict stays FAILED), logs one
  `[WARNING] <step> failed — step-failure policy CONTINUE: proceeding to
  "<next step>"` line, and routes to the same successor the success path
  uses — so fulfillment & co still get coverage.
- One central helper `failStepOrContinue(label, nextStep, { critical })`
  in loopback.js. Call-site policy (v1): offer / booking failures are
  always `critical` (hard stop regardless of the parameter — nothing
  downstream is meaningful without them); **03 PATCH Multi Passenger and
  04 GET Passenger are policy-controlled** (the booking already exists;
  fulfillment needs nothing from these responses); fulfillment itself
  stays hard in v1. The malformed-body `⛔ Exiting script` throws in
  03/04 — which killed the script before any routing — are now a
  registered failing assertion + the same policy call, so CONTINUE
  really continues.

### Fixed

- **04. GET Passenger routed to a request name that never existed** —
  `"07. GET Booking before Fulfillments"`; the real request is
  `"05. GET Booking before Fulfillments"`. The flow only worked because
  Bruno falls through to natural file order on an unknown
  `setNextRequest` target. Both the success path and the new CONTINUE
  routing now use the real name.

### Clarified

- **Purchaser steps 12–14 already continue on failure by design**
  (their `[ERROR]` branch registers the failing assertion and proceeds
  to the pre-fulfillment GET — behaviour from #258). Phase 2 of #361 is
  therefore already satisfied; their semantics are identical under both
  policy values, and converting them to respect HARD_STOP would have
  changed default behaviour, which this feature deliberately avoids.

---

## [server-v1.11.125] — 2026-06-10

**OSDM Trip Search Criteria, v1 (#359)** — requested by Marcel Koseler
(ÖBB PV AG): scenarios can now exercise the spec-defined search options
beyond origin/destination/departure.

### Added

- **Wizard: "🔎 Trip Search Criteria" sub-panel** inside the Trip
  requirement (SEARCH type), collapsed by default with an "N set" badge.
  Fields (all optional — only filled ones are sent): search time basis
  (**Departure**, default / **Arrival** — searches by the existing Arrival
  time field, OSDM's `arrivalTime`), **Via 1/2** (UIC ref + optional ISO
  dwell time), **Not via** (comma-separated UIC refs), **Transfer limit**,
  **Number of results / before / after**, **Ignore realtime data**. Stored
  flat under `tripRequirement.trip.searchCriteria.*`; `setTripFieldByPath`
  now autovivifies missing sub-objects so older datafiles upgrade on first
  edit.
- **scenarioParser builds the OSDM members** from those fields:
  `arrivalTime` replaces `departureTime` on ARRIVAL basis (same
  LocalDateTime convention, Bileto OffsetDateTime exception preserved;
  missing Arrival time → WARNING + departure fallback); `vias[]`
  (`viaPlace` + `dwellTime`); `notVias[]`; `parameters` gains
  `transferLimit` / `numberOfResults(/Before/After)` /
  `ignoreRealtimeData`, merged with the existing train-binding
  `dataFilter`. The paxone no-`parameters` exception is preserved (top-level
  members still sent, one INFO note). One `[INFO] 🔎 Trip search criteria
  applied — …` line summarises what was sent (R2). **Wire shape is
  byte-identical to before when nothing is configured.**
- Out of v1 scope (documented in #359): per-via dataFilters, ptMode /
  serviceBrand filters, policy/mobility filters, `embed`.

---

## [server-v1.11.124] — 2026-06-10

### Fixed

- **reportGenerator `[DEBUG]` lines bypass loggingType (#357).** On a
  loggingType=INFO scenario (2026.151), grey `[DEBUG]` lines still appeared:
  reportGenerator.js printed three ROUTINE lines per scenario via direct
  `console.log` (`↩ Same scenario detected…`, `🗑 Previous run data cleared.`,
  `✅ Report directory: …`) plus three error-path diagnostics. The file is
  sandbox-self-contained (can't require displays.js), so it gets a local
  `_debugLog()` gate — suppressed unless loggingType is DEBUG/FULL. The two
  error-path preflight diagnostics in offers.js now route through
  `validationLogger` for the same reason.
- **Documented boundary:** lines the Bruno CLI emits itself (the
  `(request skipped via pre-request script)` echoes, post-failure stack
  frames) are *classified* debug by the runner but cannot be un-emitted by
  loggingType — the dashboard's **info+** filter is the way to hide them;
  the database keeps everything for forensics.

---

## [server-v1.11.123] — 2026-06-10

**Execution Log & System-Info polish round (#355)** — four tester findings
on the first 2026.150 run, bundled in one PR at the Test Manager's request.

### Fixed

- **Execution Log: section headers no longer stick to the top of the log box.**
  The per-area headers (#351) used `position:sticky`, so the open section's
  header (e.g. `📂 Runner`) pinned to the top edge while its lines scrolled
  underneath — testers read it as a stuck display, and the pinned row
  overlapped the first visible line. Headers now scroll naturally.
- **Benerail token-skip line landed in the Runner section.** The library's
  token-skip line fires in the PRE-request script — before the Bruno CLI row
  that opens the `00-Access Token` suite — so the first one (benerail) was
  attributed to Runner. The LogParser now recognises the token-skip line and
  attributes it to `00-Access Token` by construction (the folder name is
  fixed in the collection); scope-gate skips keep their current suite.
- **`[DEBUG]` lines still appeared with loggingType=INFO.** Two direct
  `console.log` sites bypassed the validationLogger pyramid: the token-skip
  lines and the per-request `Report updated →` line (opencollection.yml).
  Both are now gated on the dataset's `loggingType` — at INFO they are not
  emitted at all.
- **GET Coach By Id / GET Product By ProductId: 501 produced a
  prerequisite-failure cascade instead of one skip line.** Both By-Id scripts
  checked their list-prerequisite BEFORE looking at the status, so a provider
  that 501s the endpoint got `[ERROR] prerequisite failed` + `[WARNING]` +
  a failing assertion + stack frames. Restructured: the shared
  `handleSystemInfoStatus` (#353) runs FIRST — 501/Problem-says-unsupported
  → one skip line; out-of-version 404 → skip; auth/4xx/5xx → decoded
  failures without chai tails (replaces the per-file `expect(...).to.eql(200)`
  chains — 10 fewer chai-tail variants from the #349 known-remaining list).
  The prerequisite hard-fail becomes cascade-kill: when the id came from a
  broken list call, ONE `[INFO] Context: …` line points at the root cause —
  no extra failing assertion. On a 200 the body is validated regardless of
  how the id was obtained.
- **Empty-offers warning printed twice, with a false "0 passenger(s)".**
  `postOfferResponse` logged the full `[WARNING]` itself and then threw the
  same message, which the caller re-throws inside
  `bruTest("Offers found in response", …)` — whose failure echo printed it
  again verbatim. The standalone log is removed (the echo owns the message;
  same for the malformed-envelope `[ERROR]` twin). And the passenger count
  read only `jsonData.passengers`, while providers echo the list under
  `anonymousPassengerSpecifications` (OBB) or `passengersList` — all three
  locations are checked now, and when nothing is echoed the line says
  "no echoed passenger list" instead of claiming zero.

---

## [server-v1.11.122] — 2026-06-10

**System-Info "not supported" = skip, not failure + LogParser section fix
(#353)** — tester question on 2026.149: "why for GET passenger-categories
do we not skip like for the other ones?"

### Changed

- **A provider that declares a System-Information endpoint unsupported is
  SKIPPED, like out-of-version endpoints — no failed assertion.** A clean
  HTTP 501 (or 404 + unsupported Problem code) is exactly the
  OSDM-conformant signal for an unimplemented optional endpoint; the old
  classification *said* "remaining checks are skipped" but registered a
  failing test with a red ✕, an `[ERROR]` line and ~10 stack frames.
  Now: right signal (501/404) → one `[INFO]` "not implemented by this
  provider — endpoint out of scope, skipped" line; wrong signal (e.g.
  400 + OPERATION_NOT_PERMITTED) → one `[WARNING]` with the conformance
  note (OSDM expects 501/404). No assertion registered either way — the
  response itself stays visible in the HTTP traffic and report. Genuine
  failures (401/403, plain in-version 404, 5xx) unchanged.

### Fixed

- **Garbage per-area sections in the Execution Log** (#351 follow-on).
  The LogParser folder/request matcher accepted any "text/text (parens)"
  line, so `[DEBUG] 📊 Report updated → /app/…/report.html (39 assertions)`
  and `✕ GET /passenger-categories → … (HTTP 501 …)` each became their own
  bogus section and stole the following lines. Lines carrying an explicit
  `[LEVEL]` tag are now exempt from suite/request detection (library
  narration, never a Bruno CLI row), and assertion markers are checked
  first — including `✕` (U+2715, what the Bruno CLI actually prints,
  distinct from `✗`), which also fixes those rows' category.

---

## [server-v1.11.121] — 2026-06-10

**Execution Log follow-up (#351)** — tester feedback on the first 2026.148
run: level filter semantics, per-area sections, DEBUG-dump leak.

### Fixed

- **Multi-line `[DEBUG]` dumps no longer leak into the INFO view.** The runner
  stores each stdout line as its own event and only the FIRST line of a
  multi-line message carried the level tag — the continuation lines
  (`offerId: …`, `offerSummary: {`…) were level-guessed as *info*.
  `validationLogger()` now propagates the message's tag to **every physical
  line** (R1), and the Selected-Offer full-object dump is removed outright
  (R6 — payload replay; the complete offer is one click away in the
  HTTP-traffic viewer). The `[INFO]` id + per-part refundable/exchangeable
  summary lines stay, now each carrying an explicit `[INFO]` tag.

### Changed

- **Dashboard level filter is a pyramid, matching `loggingType` semantics:**
  *info+* shows INFO + WARNING + ERROR (DEBUG plumbing hidden), *warn+* shows
  WARNING + ERROR, *error* shows errors only, *All* shows everything. The
  buttons were exact-match before (selecting *info* hid warnings and errors).
  Unknown levels stay visible (the #341 safety net). The dead **stdout /
  stderr buttons are removed** — since round 1 the runner only ever stores
  `debug/info/warn/error`, so they matched nothing; *debug* is gone too
  (≡ *All* under pyramid semantics).
- **The Execution Log is split per area, like the assertions panel:** one
  collapsible sticky-header section per suite (`01-System Infos Requests`,
  `02-Common Requests`, …) in chronological order, with a per-section line
  count. Sections compose with all filters — a section whose lines are all
  filtered out disappears; the count shows `visible/total` when filtered.
  Lines stream into the current section live; a suite re-entered later (e.g.
  loop-back) starts a new section so chronology is never reordered.

### Verification

- The page's real functions (extracted from run-detail.html, not copies) run
  against a DOM shim in Node: 9 checks covering pyramid visibility per level,
  group order/counts, empty-group hiding, endpoint-filter and search
  composition, streaming continuation, and suite re-entry.
- `validationLogger` multi-line propagation tested for DEBUG/WARNING tags,
  single-line messages untouched.

---

## [server-v1.11.120] — 2026-06-10

**Request/response traces (#350)** — the dashboard becomes self-sufficient
for trace analysis; the HTML report gets the missing response headers.

### Added

- **Dashboard: per-endpoint log filter.** New "All endpoints" dropdown in the
  Execution Log toolbar — pick one tested endpoint and see only its lines,
  mirroring the assertions panel's per-request grouping. Uses the
  `request_name` attribution the runner's LogParser already writes on every
  `run_events` row; composes with the level buttons and the search box.
- **Dashboard: request & response headers in the HTTP Traffic viewer.** Each
  message now shows a collapsed "Request headers (N)" / "Response headers (N)"
  table between the meta line and the body — real HTTP reading order. All
  captured headers appear, including the non-mandatory debug ones
  (`traceparent`, `tracestate`, correlation ids…). The data was already
  stored and returned by the API; only the rendering was missing.
- **HTML reports: response headers panel.** Both the per-scenario report
  (reportGenerator.js) and the merged report (mergeReport.js) now render a
  Headers table in the 📥 Response panel, mirroring the 📤 Request panel.
  Capture confirmed complete on both directions: `req.headers` / `res.headers`
  carry every header Bruno sends/receives (explicit + script-set). Transport
  headers added below Bruno (Host, Content-Length) are not exposed by the
  runtime — documented limitation.

### Changed

- **Credential masking: full redaction → graduated partial mask** at all three
  capture sites (`structureResults.js` → run_requests, `reportGenerator.js`,
  `mergeReport.js`). Sensitive header values keep their head and tail so a
  tester can check the *right* token/identity was sent and correlate two
  requests: ≥24 chars → first 10 + `…[masked N chars]…` + last 4 (Bearer
  tokens show the scheme + JWT head); 8–23 chars → first 3 + last 2
  (identity-style values); <8 chars → full `[REDACTED — credential]`.
  Auth-endpoint request/response **bodies** stay fully redacted as before.
- `Requestor` (the OSDM identity header, no `x-` prefix) added to the
  sensitive-header sets — it was masked at render time in the reports but
  reached `run_requests` unmasked; with headers now displayed in the
  dashboard it gets the same partial mask everywhere.
- Render-time maskers in both report generators pass already-masked values
  through untouched (no double-masking that would destroy the tail); raw
  values from legacy report data still get the old render-time mask.

---

## [server-v1.11.119] — 2026-06-10

**Log-audit round 2 — 17 decodability fixes from a line-by-line
tester walkthrough.** A Test Manager read a full Bileto run log and
challenged every message he couldn't act on. Governing principle that
emerged: **the INFO log tells the flow story a tester can act on;
plumbing goes to DEBUG; failures speak the provider's language.**

### Fixed (real bugs found by the walkthrough)

- **False "passengersList has only 0 passenger(s)" warning** — the
  per-pax partial-refund check read `jsonData.passengersLists`
  (plural, never exists) instead of `passengersList`; it fired on
  every per-pax scenario regardless of the real count. Lookup fixed
  (loose id compare, plural kept as fallback); the message now
  distinguishes "list found but <2 passengers" from "list id not
  found".
- **expiredFlow queue require failed on EVERY run** — `library_base`
  double-nested the path inside `library-bruno/`; the confusing
  "Cannot find module" warning appeared even with 0 timers armed,
  and the multi-timer auto-expansion was silently dead since it
  shipped. Sibling require; a genuine failure now logs `[ERROR]`
  with the consequence.
- **OSDM version check** — mismatch narrative was `[INFO]`; the
  assertion `expect(foundMatch).to.be.false` passed green on a
  mismatch; the match confirmation was tagged `[✅ INFO]` (malformed
  → dropped at default level); plus the `sytem` typo. Now: one
  `[WARNING]` with the action path, an honest soft-check test title
  carrying the verdict, a well-formed match line.
- **Envelope warnings/problems present-path was broken** — warning
  objects printed as `[object Object]`; an empty `warnings: []`
  (truthy) hit the warning path; the problems header carried no
  level tag.
- **HTTP 501 was mislabelled "Server Error"** — it is OSDM's clean
  not-implemented signal and now gets the decoded "not supported"
  classification.
- **OpenSSL `/etc/ssl/certs` stderr noise** — root-caused:
  `node:22-slim` ships without `ca-certificates`; installed in the
  runtime image, the line disappears entirely.

### Changed (decodability)

- **Provider-language failures**: `classifySystemInfoStatus` reads
  the RFC-9457 Problem body — `GET /passenger-categories → not
  supported by this provider (HTTP 400 + OPERATION_NOT_PERMITTED)`
  in one line, including the conformance note that OSDM expects
  501/404 for unimplemented endpoints. All 8 System-Info callsites
  pass the parsed body.
- **Compliance failures speak plainly**: index dumps
  (`index 0, 1, … 207`) → *"required property "dimension" is
  missing or not of type object on ALL 208 CoachDeckLayout
  entries."* (count + 10-index sample for subsets); deep-schema
  dumps grouped by distinct problem (*"416 schema issue(s) across
  208 entries — 2 distinct problem(s): …"*); all 28
  `expect(c.ok, c.message).to.be.true` callsites → plain `throw`
  (kills chai's `: expected false to be true` tail everywhere).
- **Assertion double-display killed**: the bruTest pass-echo is
  `[DEBUG]`; Bruno's native `✓` row is the single INFO-level
  confirmation. Failure echo stays `[WARNING]`, in-flow.
- **Once-per-run instead of per-request**: env-sanity guards
  (api_base/library_base/data_base) — one `[INFO] Environment OK`
  line per run, a test only when something is missing (~120 lines
  and 63 filler assertions removed per run); the auth preflight
  (duplicate `POST /offers`) runs once per run and reports in one
  line.
- **Plumbing → DEBUG**: vendor token-skips (+ truthful wording),
  14 full-JSON dumps, reportGenerator internals, per-request
  "Report updated" lines, 33 `➤/►` function-name breadcrumbs,
  Bruno's skip echoes, and `at …` stack frames after failed
  assertions (runner-side; the `Error:` message line stays red).
- **Self-explaining flow lines**: "Correct data set was found" →
  names the scenario + its tripRequirement/passengersList/
  fulfillmentOptions linkage ids; the not-found twin lists the
  available codes and the wizard fix path.

### Added

- **OBB Access Token request** in `00-Access Token` for standalone
  Bruno users (always skipped on OSCAR — server-side OAuth).
- **Envelope shape-conformance assertion**: non-empty `warnings[]` /
  `problems[]` entries must carry `code` + `title`/`detail` (same
  bar as the NHF Problem probes); non-URN vendor codes get a
  `[WARNING]` note; clean envelopes register no assertion.

### Versions

- `Bruno_Collection/VERSION` `OTST_V2.0.64` → `OTST_V2.0.65`
- `Oscar_Server/package.json` `1.11.118` → `1.11.119`
- `compatibility.json` `release-2026.147`

### Notes

- Report assertion counts **drop** by ~63 filler passes per run —
  pass-rates become meaningful.
- No payload / wire-format change.
- Every behavioural item carries a Node-harness verification in its
  commit (208-entry fixture, Bileto Problem classification, envelope
  shapes ×4, expiredFlow require, inferLevel rule order, …).

---

## [server-v1.11.118] — 2026-06-10

**Datafile validator: two false positives in OUR bundled schema /
walker — not in the user's datafile.**

With local schema serving finally working end-to-end (v1.11.115), a
Bileto run surfaced the remaining ❌ lines — and both were our bugs:

### Fixed

- **Stale `required: ["currency"]` in the bundled schema.**
  `json_validator/datafile.schema.json` still required `currency`
  inside `scenario.offerSearchCriteria` — but ALL offer-search
  criteria were made optional per OSDM back in April 2026, and the
  wizard intentionally writes only the fields the tester picked
  (possibly an empty object). Every scenario authored without an
  explicit currency produced a false *"Required field
  'scenarios[N].offerSearchCriteria.currency' is missing"*.
  The `required` block is removed.

- **Walker flagged legal nulls as "Required property missing".**
  `validateValueAgainstSchema` accepted a present-but-null property
  only when its NAME was on a hardcoded whitelist — a maintenance
  trap: `placeSelectionMode`, added later with schema type
  `["string","null"]` and `null` in its enum, wasn't on the list,
  so every scenario carrying the perfectly legal
  `"placeSelectionMode": null` was flagged. The walker now derives
  nullability from the **schema itself** (type includes `"null"`,
  or the enum lists `null`), keeping the legacy name list as a
  fallback. A null on a genuinely non-nullable field now reports
  the precise condition (*"'X' is null but the schema type (…)
  does not allow null"*) instead of the misleading "required
  missing".

- **⛔ header decodability.** The *"Invalid JSON Data file
  structure"* header was tagged `[INFO]` with no error count —
  easy to misread as a schema-ACCESS problem (it fires only AFTER
  the schema was fetched 2xx and parsed). Now:
  `[ERROR] ⛔ Invalid JSON Data file structure (N error(s) —
  details below). Schema was fetched OK from: <url>`.

### Verified

Node harness driving the real `validateDataFileJsonWithTemplate`
against the real bundled schema:
- (A) scenario with `offerSearchCriteria` lacking currency +
  `placeSelectionMode: null` → both former false positives gone
- (B) wrong-type `placeSelectionMode: 123` → still flagged
- (C) missing `tripRequirementId` → still flagged
- (D) null on non-nullable `code` → new precise message

### Versions

- `Bruno_Collection/VERSION` `OTST_V2.0.63` → `OTST_V2.0.64`
- `Oscar_Server/package.json` `1.11.117` → `1.11.118`
- `compatibility.json` `release-2026.146`

---

## [server-v1.11.117] — 2026-06-10

**Two log-pipeline fixes: milliseconds were never stored, and the
run-detail log silently truncated at ~500 lines on finished runs.**

### Fixed

- **`run_events.ts` stored at second precision.** The v1.11.113
  dashboard change (`slice(11,23)`) claimed to "unhide" millisecond
  precision, but the `ts` column was populated by its SQLite schema
  default `datetime('now')` — second-precision
  (`2026-06-09 21:25:16`). There were no milliseconds to unhide;
  users kept seeing `[21:25:16]` even on release-2026.144 with the
  new page loaded.

  Fix: `logEvent()` now passes `ts` explicitly as
  `new Date().toISOString()` (`2026-06-10T07:42:13.123Z`) on both
  INSERT sites (regular event + cap-reached warning). Same UTC
  storage convention; the dashboard slice now yields
  `HH:MM:SS.mmm` as designed. Pre-existing rows keep the old format
  and degrade gracefully (slice shows `HH:MM:SS`). All `run_events`
  consumers paginate/order by the autoincrement `id`, never by `ts`
  string comparison, so mixed formats are safe. No migration —
  the column is TEXT; the schema DEFAULT stays as a fallback.

- **Run-detail log truncated at ~500 lines on finished runs —
  "log stops before the offer request".** A FAILED Bileto run
  (709 assertions, 21 HTTP requests — the full
  offer/booking/refund flow executed) showed an execution log
  ending mid-system-infos. The run never stopped; the log VIEW
  did:
  - `GET /v1/runs/:id/logs` caps each fetch at **500 rows**
    (`LIMIT 500` + `since_id` cursor).
  - `run-detail.html` stopped polling the moment the run reported
    a terminal status — so opening a finished run fetched exactly
    one page and stranded everything behind the cursor.

  Fix, three parts:
  1. The logs endpoint returns **`has_more`** (rows hit the SQL
     limit → backlog continues).
  2. The dashboard poll loop **drains the backlog** with immediate
     50 ms follow-up fetches while `has_more` (length ≥ 500
     fallback), and only then lets the terminal status end the
     loop.
  3. Terminal-status side-effects (artifacts / assertions /
     requests loads, delete + share buttons) are guarded by a
     `terminalHandled` flag so drain iterations don't re-fire
     them.

  Verified in a browser harness against a stubbed 1250-event
  FAILED-run backlog: 1250/1250 lines rendered across 3 pages,
  side-effect loaders called exactly once, polling stopped
  cleanly after the drain.

### Versions

- `Oscar_Server/package.json` `1.11.116` → `1.11.117`
- `compatibility.json` `release-2026.145` (collection unchanged at
  `OTST_V2.0.63` — server-only change)

---

## [server-v1.11.116] — 2026-06-09

**Invisible `warn`/`debug` log lines on the run-detail page —
regression-by-omission from v1.11.113.**

### Fixed

- **`run-detail.html`: `warn` and `debug` log lines rendered
  near-invisible.** The v1.11.113 runner-side level inference
  started storing `warn` and `debug` levels in volume, but the
  log box CSS only had color rules for `stdout` / `stderr` /
  `info` / `error`. Lines with `l-warn` / `l-debug` inherited
  the page's dark text color on the dark `#1e1e1e` log box —
  whole blocks of barely-readable text between green INFO lines
  (user screenshot, run of 2026-06-09 21:25).

  Fix: `.l-warn{color:#ffb74d}` (amber), `.l-debug{color:#9e9e9e}`
  (muted but readable grey), plus a safety-net default
  `color:#d4d4d4` on `.log-line` itself — placed **before** the
  `.l-*` rules (equal specificity, source order decides) — so any
  future level without an explicit rule stays readable instead of
  vanishing.

- **Level filter row was missing `warn` and `debug` buttons** —
  the new levels could not be isolated. Buttons added.

- **`report-builder.html`: `debug` level chips unbadged** — light
  page, so readable, but the chip rendered without its badge
  colors. Matching `.log-level.l-debug` rule added.

### Verified

Injected all 7 level samples against the served stylesheet:
`stdout #d4d4d4`, `info #81c784`, `warn #ffb74d`,
`error #ef5350`, `debug #9e9e9e`, `stderr #ff9800`,
unknown-level fallback `#d4d4d4`.

### Versions

- `Oscar_Server/package.json` `1.11.115` → `1.11.116`
- `compatibility.json` `release-2026.144` (collection unchanged
  at `OTST_V2.0.63` — HTML-only change)

---

## [server-v1.11.115] — 2026-06-09

**News: partial-refund availability announced + JSON_SCHEMA_URL
rollout fix (the v1.11.112 fix never reached running installs).**

### Added

- **"Partial refund is here" news item** in the welcome-page
  carousel ([index.json](Oscar_Server/public/news/index.json)).
  Announces the #218 partial-refund capability to OSCAR users:
  the two combinable scope axes (per-leg / per-passenger), the
  OSDM v3.8 `refundSpecifications[]` wire format, provider-
  modelling adaptation (Paxone vs Bileto/Sqills fulfillment
  shapes), the scope-aware refund-amount alignment assertion,
  the `REFUND_PARTIAL` framework-gating declaration, and the
  graceful degradation to full refund when the booking can't
  satisfy the requested scope.

- **`JSON_SCHEMA_URL` now defaults to the self-served loopback
  route** in `runner.js` (`http://127.0.0.1:<PORT>/json_validator/
  datafile.schema.json`, PORT-aware). Previously an unset variable
  produced an empty `json_schema` env var and every run failed
  datafile validation with *"Missing env var json_schema"*.
  Operators can now simply delete the line from `.env`.

### Fixed

- **The v1.11.112 schema-URL fix never reached running installs —
  and our own remediation instruction was wrong.** A user run on
  2026-06-09 still validated against the deprecated
  `OSDM-testing/exch_dev` GitHub schema and produced the known
  false-positive *"Required field 'scenarios[N].
  offerSearchCriteriaListId' is missing"* cascade, **after**
  release-2026.140 was deployed. Two compounding causes:
  1. v1.11.112 changed `.env.example` — the template for NEW
     installs. An existing VPS keeps its `OSCAR_Deploy/.env`
     untouched, old URL included.
  2. The remediation we shipped — in the run-log `[WARNING]` and
     the installation guide — said `docker compose restart oscar`.
     **`restart` does not apply `.env` edits**: `env_file` values
     are baked into a container at *create* time; `restart` keeps
     the same container. (Watchtower image updates clone the old
     container's env too.) The only command that applies an edited
     `.env` is `docker compose up -d oscar`.

  Fixed in three places: the `validators.js` `[WARNING]` text now
  instructs `up -d` (with the reason), the installation guide's
  remediation block does the same and adds a `printenv`
  verification step, and the stale `exch_dev` URL example in the
  Server Admin Guide is replaced with the local-route value.

### Versions

- `Oscar_Server/package.json` `1.11.114` → `1.11.115`
- `Bruno_Collection/VERSION` `OTST_V2.0.62` → `OTST_V2.0.63`
- `compatibility.json` `release-2026.143`

---

## [server-v1.11.114] — 2026-06-09

**Refund/booking assertion-message clarity.** User feedback on the
log-polish PR (#337): *"those failed messages on Refund Offer are
quite difficult to decode for me…"* Same user later: *"yes and I
have some on booking too, hope some others are not hidden and will
pop up later."* This release answers both — fixes the visible
messages AND audits the rest of the library for hidden equivalents
so they don't pop up later.

Continues [#336](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/336).
Ten small fixes, all in `bookings.js` + `refunds.js`. Passing
scenarios are unaffected — only failure-message text and one
cascade structure changed.

### Fixed

- **Cascade-kill on `afterSalesConditions`.**
  When the booking response was missing `afterSalesConditions`
  entirely, a 3-admission + 3-reservation × 2-conditions-each
  offer produced **18 failures from one provider gap**:
  6 × parent "exist in both" + 12 × child "`REFUND` exists in
  booking". The child loop fired even though the parent
  assertion had already proven the cascade was guaranteed to
  fail. Now: when `bookedConditions.length === 0`, emit ONE
  parent failure naming the root cause (offer declared N
  condition(s) [REFUND,REFUND,…] — booking returned 0;
  per-condition checks SKIPPED to avoid duplicate cascading
  failures) and early-return.

- **`FulfillmentStatus` enum was stale — missing `FULFILLED`.**
  `bookings.js:698` did not include `FULFILLED`, so every
  `FULFILLED` fulfillment under a v3.8 booking failed the D1
  enum check — even though our own `fulfillments.js:144-146`
  lists `FULFILLED` as expected. Added `FULFILLED`. Plus: the
  enum-check error message now NAMES the full valid list
  (`Valid OSDM values: [AVAILABLE,USED,…,FULFILLED].`) so the
  reader doesn't have to grep the source.

- **`booking.fulfillmentStatus` null vs. undefined guard.**
  The v3.8 `fulfillmentStatus` optional field was guarded by
  `!== undefined`, which let the JSON-literal-null case
  through and stringified it into a nonsense test title:
  `'null' is a valid FulfillmentSummaryStatus`. Changed to
  `!= null` so both null AND undefined are treated as
  "absent" (the v3.8 spec semantic). Same valid-list naming
  added to the error message.

- **`fulfillmentDocumentRefs` unresolved — added a
  plain-language root-cause line.**
  The #253/#336 v3.8 cross-check failure correctly named the
  unresolved UUIDs and the sibling-id pool, but didn't spell
  out the root cause. Added one-liner: *"Provider emits both
  fulfillmentDocumentRefs[] AND a sibling
  fulfillmentDocuments[] list, but the UUIDs don't reconcile —
  the refs and the docs are independently generated instead
  of linked."*

- **Price-field expect context** — `provisionalPrice` and
  `confirmedPrice`: bare *"X missing"* messages now include
  the actual JSON value (*"… missing in booking (got:
  undefined)"*), self-explaining.

- **`BookingPartStatus` error message** — same valid-list
  naming treatment as `FulfillmentStatus` above, for
  consistency.

- **`refunds.js` `validFrom`/`validUntil` date guards —
  `new Date(null)` trap.**
  `new Date(null)` returns epoch 0 (1970-01-01), not
  `Invalid Date`. So the `!isNaN(getTime())` guards in
  `refunds.js` let JSON null through. The test then fired
  with an empty title and failed at
  `expect(refundOffer.validFrom).to.exist`, leaving
  *"expected null to exist"* as the only breadcrumb.
  Replaced with `_toDate(v)` that only constructs the Date
  from non-null strings, and a new `_checkDatePresent` helper
  that emits an explicit ABSENT-vs-MALFORMED failure when
  the field doesn't pass. Applied to `createdOn`,
  `validFrom`, `validUntil`. Plus context strings on the
  *"in the past"*, *"in the future"*, and *"15 min window"*
  assertions naming exactly what went wrong.

- **`refundableAmount` / `refundFee` title built from SHAPE,
  not happy-path.**
  Test titles used to preformat *"amount: 0, currency: CZK"*
  even when `scale` was the missing field. So failures looked
  like everything passed up to a mystery *"expected
  undefined to be a number"*. Rewrote `_priceShape()` to
  report each sub-field as either `amount=0` (valid) or
  `amount=MISSING(got null)` — the broken sub-field now
  shows in the title even when other fields look fine. Plus
  per-field `expect()` context strings naming exactly which
  OSDM Price sub-field failed and why (*"refundableAmount.scale
  is not a number (OSDM Price.scale: required integer,
  typically 0)"*).

### Versions

- `Bruno_Collection/VERSION` `OTST_V2.0.61` → `OTST_V2.0.62`
- `Oscar_Server/package.json` `1.11.113` → `1.11.114`
- `compatibility.json` `release-2026.142`, current_release bumped

### Tests

- 21 partial-refund + 26 framework-gating unit tests still pass.
- No data-file schema change.
- No payload / wire-format change.
- Failure messages, cascade behaviour, and two real guard bugs
  changed; passing scenarios are unaffected.

---

## [server-v1.11.113] — 2026-06-09

**Log polish + #253 fulfillmentDocuments empty-array followup.**
Resolves [#336](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/336)
(also unblocks the [#253](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/253)
empty-array edge case).
Five coupled changes in one PR.

### Fixed

- **Dashboard log timestamps were truncated to seconds.**
  `Oscar_Server/public/run-detail.html` rendered the prefix as
  `slice(11,19)` → `"19:12:42"`. Two events emitted in the same
  wall-clock second showed identical timestamps and could not be
  correlated with provider-side logs at sub-second precision.
  Now `slice(11,23)` → `"19:12:42.123"`. UI-only change — the
  underlying log records already stored full ISO ms timestamps;
  this just unhides them.

- **Runner-side log lines stored with stream name as the level
  instead of the actual severity.** The Bruno child-process
  stdout/stderr listeners in `Oscar_Server/src/worker/runner.js`
  were calling `logEvent(runId, 'stdout', line, ...)` for every
  Bruno-emitted line — so the level filter on the run-detail page
  was useless for the bulk of the run output (an `[ERROR]` line
  and a `[DEBUG]` line both showed as `'stdout'`). Added an
  `inferLevel(line, streamFallback)` helper that classifies by:
  1. explicit `[LEVEL]` tag from library-bruno emitters → that level
  2. Bruno CLI native test markers (`✓` → info / `✕` → error)
  3. JS stack-trace shapes (`Error:` / `AssertionError:` / `at …` lines) → error
  4. known harmless platform noise (`Cannot open directory /etc/ssl/certs` from OpenSSL) → warn
  5. stderr-stream fallback → error (Bruno emits real failures there)
  6. stdout-stream fallback → info

  The dashboard level filter now actually filters correctly for the
  whole run output.

- **Bruno library — ~25 `console.log` / `console.error` calls
  emitted without a `[LEVEL]` tag.** With the runner-side inference
  above in place, *some* of these would still flow through correctly
  via the stream fallback, but the explicit tagging is much more
  reliable and makes the intent visible at the source. Added
  `[INFO]` / `[WARN]` / `[WARNING]` / `[ERROR]` / `[DEBUG]` prefixes
  across:
  - `auth.js`, `bookings.js`, `displays.js`, `envUtils.js`,
    `exchanges.js`, `expiredFlow.js`, `fulfillments.js`,
    `loopback.js`, `mergeReport.js`, `model.js`, `offers.js`,
    `osdmCompliance.js`, `osdmSchema.js`, `osdmSchemas.js`,
    `osdmVersion.js`, `partialRefund.js`, `passengers.js`,
    `refunds.js`, `reportGenerator.js`,
    `requestedInformation.js`, `scenarioParser.js`,
    `validators.js`.

  Two patterns of note:
  - the omnipresent `[library-bruno] globalThis exposure skipped`
    fallback (one per module) is now `[DEBUG]` — invisible at
    default INFO level, surfaceable on demand.
  - the `⏩ [STEP] Executing request …` lines from `displays.js`
    and `offers.js` are now `[INFO]` — they're the heartbeat of
    the run and should pass the INFO filter.

  Combined with the runner-side inference, the dashboard level
  filter is now reliable end-to-end.

- **#253 followup — `fulfillmentDocuments: []` empty-array case.**
  The v3.8 cross-check `fulfillmentDocumentRefs → siblingDocs[].id`
  in `Bruno_Collection/library-bruno/bookings.js` was guarded by
  `if (Array.isArray(siblingDocs))`, which correctly skipped the
  check when callers didn't pass `siblingDocs` at all, but
  INCORRECTLY ran the check (and reported every ref as
  "unresolved") when callers passed an **empty** array — the
  real-world pre-issuance shape `fulfillmentDocuments: []`. An OBB
  test response declaring the v3.8-correct location with no
  documents in it yet (typical for a provider rolling out v3.8
  emission incrementally) produced a false-positive integrity
  failure on a perfectly legal shape.

  **Fix**: tightened the guard to also require `length > 0`, and
  split the else-branch into two distinct cases:
  - **(a)** sibling array fully absent → existing
    "not provided to validator" `[INFO]` (unchanged behaviour)
  - **(b)** sibling array present but empty → new "is present but
    empty — legal pre-issuance shape" `[INFO]`

  Test name updated to `"... (OSDM v3.8 integrity, when siblings
  present)"` to clarify the conditional scope. No assertion
  change on the populated-array happy path.

### Versions

- `Bruno_Collection/VERSION` `OTST_V2.0.60` → `OTST_V2.0.61`
- `Oscar_Server/package.json` `1.11.112` → `1.11.113`
- `compatibility.json` `release-2026.141`, current_release bumped

### Tests

- 21 partial-refund + 26 framework-gating unit tests still pass.
- No data-file schema change.
- No payload / wire-format change.

---

## [server-v1.11.112] — 2026-06-09

**OBB onboarding follow-up — SEARCH branch was rejecting valid OSDM
data, schema-URL hardcoded in operator's `.env`, install guide silent
on both.** Resolves [#333](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/333).
Four coupled fixes in one PR.

### Fixed

- **SEARCH branch: `endDatetime` is OPTIONAL per OSDM, but
  scenarioParser was requiring it.**
  `Bruno_Collection/library-bruno/scenarioParser.js:776-777`
  unconditionally called `subTripDate(tripRequirement.trip.endDatetime,
  ...)`, which threw on `undefined`. But:
  - `endDatetime` is **optional** on `TripSearchCriteria` per OSDM —
    you specify a departure time, not a window.
  - `osdmTripSearchCriteria()` itself doesn't even **use** the
    `endDateTime` value — it's computed, passed through the
    `TripLegDefinition` constructor as arg 4, and discarded when the
    `TripSearchCriteria` is built (only `startDateTime` is used —
    see line 1171).

  So OSCAR was rejecting valid OSDM datafiles. The v1.11.110 try/catch
  caught the throw and emitted an `[ERROR]` blaming the data, sending
  new users on a wild goose chase. **Fix**: guard the `subTripDate`
  call behind a truthiness check, pass `null` when absent.
  SPECIFICATION branch unchanged (each leg's `endDatetime` IS required
  when you're specifying exact trips). The OBB Nightjet datafile that
  surfaced this now resolves cleanly to `offerTripSearchCriteria`.

- **v1.11.109 `[WARNING]` wording was misleading.** It said *"update
  the company's environment file"* — wrong because there is no
  per-company env file. The value is built fresh server-side from
  `JSON_SCHEMA_URL` on the OSCAR server itself. Updated to point at
  the actual fix path:

  > *"edit `OSCAR_Deploy/.env`, set `JSON_SCHEMA_URL` to
  > `http://127.0.0.1:3001/json_validator/datafile.schema.json`,
  > restart with `docker compose restart oscar`"*

  Also separated *"deprecated repo"* (the `exch_dev` /
  `OSDM-testing` case) from *"any GitHub URL is fragile"* so the
  warning is informative for both.

### Added

- **`Oscar_Server/src/server.js` — new public Express route
  `GET /json_validator/datafile.schema.json`** that serves the JSON
  schema bundled with the Bruno collection (read from the same
  `/collection` bind-mount the runner already uses). Removes the
  external dependency for datafile schema validation.

  Before this PR, operators had to either point `JSON_SCHEMA_URL` at
  an external GitHub URL (fragile — depends on the repo staying
  public and the branch / file path not moving) or set up their own
  static HTTP server in the docker-compose (undocumented). Now the
  schema is always co-located with the running collection — they
  ship together so versions can't drift.

- **`OSCAR_Deploy/.env.example` default updated** to
  `http://127.0.0.1:3001/json_validator/datafile.schema.json`. Fresh
  installs no longer land in the broken state.

- **`Documentation/Server_Operations/installation-guide.md` — new
  `JSON_SCHEMA_URL` section.** Documents the v1.11.112+ self-hosted
  default, names the obsolete `OSDM-testing/exch_dev` URL that older
  installs may still have, gives the exact one-line steps to update
  an existing `.env` on the VPS plus `docker compose restart oscar`.

### Behaviour guarantees

- 21 partial-refund + 26 framework-gating unit tests still pass.
- `npm run lint` clean.
- No data-file schema change.
- No backend behaviour change beyond serving one additional static
  file (the schema).
- The schema-route is public (no auth). The file path is entirely
  under operator control via `COLLECTION_PATH` env var; there's no
  user-controlled component in the resolved path, so path-traversal
  is not a vector.
- The route caches the response for 300 seconds (the collection only
  changes on deploy).

---

## [server-v1.11.111] — 2026-06-09

**`loggingType=DEBUG` was BACKWARDS — it dropped `[ERROR]` and
`[WARN]` instead of showing more detail than `INFO`.** Surfaced
exactly the case the v1.11.110 trip-branch diagnostics were
designed for: the OBB user switched to DEBUG to see more, and
the new `[ERROR]` lines vanished.

### Fixed

- `Bruno_Collection/library-bruno/displays.js` — `validationLogger`'s
  `case "DEBUG"` was passing only `[DEBUG]` and `[INFO]` messages
  and silently dropping `[WARN]` / `[WARNING]` / `[ERROR]`. A Test
  Manager setting `loggingType=DEBUG` (expecting MORE detail than
  INFO) actually saw FEWER critical lines than the default. Now
  matches the standard logging pyramid:

| Level | Shown when `loggingType=` |
|---|---|
| `[ERROR]` | ERROR · WARN · INFO · DEBUG · FULL |
| `[WARN]` / `[WARNING]` | WARN · INFO · DEBUG · FULL |
| `[INFO]` | INFO · DEBUG · FULL |
| `[DEBUG]` | DEBUG · FULL |
| Untagged | FULL only |

DEBUG is now the most verbose tagged-only level. FULL still picks
up untagged messages too (unchanged). INFO, WARN, ERROR cases
unchanged.

### Why this matters

After v1.11.110 deployed, the OBB user switched their scenario's
`loggingType` to DEBUG to see more detail about why
`offerTripSearchCriteria` was empty. The new trip-branch
`[ERROR]` lines we shipped in v1.11.110 became INVISIBLE at
DEBUG level because of this bug — defeating the whole point of
the v1.11.110 diagnostics. After v1.11.111:

- At default `INFO` level: trip-branch `[ERROR]` shows (unchanged)
- At `DEBUG` level: trip-branch `[ERROR]` shows AND the `[DEBUG]`
  structure dumps show — Test Manager has the complete picture
- The `[DEBUG]` structure dumps still don't pollute INFO-level
  reports (this is the property your "don't add hundreds of INFO
  logs" concern was about — preserved)

### Behaviour guarantees

- 21 partial-refund + 26 framework-gating unit tests still pass.
- `npm run lint` clean.
- No data-file schema change. No backend behaviour change. No
  wizard UI change.
- All other log levels (FULL, INFO, WARN, ERROR) unchanged.

---

## [server-v1.11.110] — 2026-06-09

**Trip-branch validation in scenarioParser — silent failures inside
the SEARCH / SPECIFICATION branches now surface as precise `[ERROR]`
lines naming the missing data fields.** Resolves the second OBB
onboarding case where the v1.11.109 upfront *unresolved
tripRequirementId* `[ERROR]` didn't fire (because the id resolved)
but the branch still left `offerTripSearchCriteria` unset because
the `.trip` sub-object was missing required fields.

### Context

After v1.11.109 deployed, the new-user log showed:

```
[INFO] Build using TripType: SEARCH
[02-Common Requests/01. POST Get Offer.yml] Pre-request script error:
Error: [ERROR] Required scenario variable "offerTripSearchCriteria" is empty or not set.
... Upstream resolver: scenarioParser.osdmTripSearchCriteria() ...
```

`TripType=SEARCH` was set, meaning `tripRequirement` WAS resolved
(the v1.11.109 upfront `[ERROR]` correctly didn't fire — there was
nothing to flag). The actual failure was downstream **inside** the
SEARCH branch at `tripRequirement.trip.startDatetime` — the
`.trip` sub-object was missing or incomplete in the OBB datafile,
the branch threw on the first undefined access, the throw was
swallowed silently, and `offerTripSearchCriteria` stayed unset.

### Added

- `Bruno_Collection/library-bruno/scenarioParser.js` — upfront
  shape validation for each branch:
  - **SEARCH**: verify `tripRequirement.trip` exists and has
    `origin`, `destination`, `startDatetime`. Emit a precise
    `[ERROR]` naming the missing field(s) if not:

    > *"Scenario `OBB_SALE_1ADT_1LEG`: tripRequirement #1 has
    > tripType=SEARCH but the .trip sub-object is missing
    > required field(s): [trip.origin, trip.startDatetime]. The
    > SEARCH branch needs origin / destination / startDatetime
    > to build a TripSearchCriteria... Fix in the wizard: open
    > Test Data → Trip Requirements, open this entry and complete
    > the SEARCH trip's origin, destination, and start datetime."*

  - **SPECIFICATION**: verify `tripRequirement.legs` is a
    non-empty array and each leg has `origin`, `destination`,
    `startDatetime`, `endDatetime`. Emit a precise `[ERROR]` per
    incomplete leg.

  - Both validators also emit a `[DEBUG]` dump of the actual
    structure (`tripRequirement.trip` for SEARCH,
    `tripRequirement.legs` for SPECIFICATION) so a Test Manager
    can see the raw data without grepping the datafile. The
    `[DEBUG]` line stays invisible at default `INFO` logging
    level — it only appears when `loggingType=DEBUG` or `FULL`.

- **Try/catch around the SEARCH/SPECIFICATION switch.** Any
  unexpected throw inside the branches (e.g. `subTripDate`
  refusing a date format, a malformed sub-field the validators
  didn't catch) now surfaces with the tripRequirement context:

  > *"Scenario `…`: building TripType=SEARCH criteria for
  > tripRequirement #1 threw: Cannot read property '...' of
  > undefined. offerTripSearchCriteria stays unset and the request
  > body cannot be built. Fix in the wizard: open Test Data → Trip
  > Requirements, open this entry and verify the trip data is
  > complete and dates parse correctly."*

  The catch does NOT rethrow — the downstream `parseEnvJson`
  hint from v1.11.109 still fires after, but now the report
  shows the **root cause** (`[ERROR]` line above) BEFORE the
  **consequence** (`Required scenario variable
  "offerTripSearchCriteria" is empty`).

### Log-level policy used here

| Type of log | Level | Visible at default INFO? |
|---|---|---|
| Fatal data gap (missing trip fields) | `[ERROR]` | ✅ |
| Verbose structure dump for investigation | `[DEBUG]` | ❌ (DEBUG/FULL only) |
| Normal happy-path status | `[INFO]` | ✅ |
| Suspect but non-fatal | `[WARNING]` | ✅ (WARN/INFO/FULL) |

This release follows the policy consistently: the new `[ERROR]`
lines only fire when there's actually a data gap, and the verbose
`[DEBUG]` structure dumps stay invisible at default logging level
— so happy-path runs don't get hundreds of extra log lines.

### Behaviour guarantees

- All new log lines are advisory. No assertion contracts change.
- 21 partial-refund + 26 framework-gating unit tests still pass.
- `npm run lint` clean.
- No data-file schema change. No backend behaviour change. No
  wizard UI change.
- Branches with complete data are unchanged — the validators only
  early-return when they detect a gap.

---

## [server-v1.11.109] — 2026-06-09

**Precise new-user diagnostics — five log lines that turn opaque
"variable is empty" symptoms into actionable error messages naming
the upstream resolver and the wizard section to fix.**
Resolves [#328](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/328) (OBB onboarding case).

### Context

A tester onboarding a new ÖBB company chased a confusing chain:

> `Error: [ERROR] Required scenario variable "offerTripSearchCriteria" is empty or not set. This usually means getScenarioData() did not run, or the data file failed to load...`

…through `scenarioParser.js`, `requestsBuilder.js`, and the env
file before discovering that the company's environment was pointing
at a deprecated GitHub-hosted schema (UnionInternationalCheminsdeFer/
OSDM-testing's `exch_dev` branch, which we no longer maintain) AND
the scenario's `tripRequirementId` didn't resolve to any entry in
the datafile. None of the OSCAR log lines said either of those
things directly. This release fixes that.

### Added

- `Bruno_Collection/library-bruno/validators.js` — when
  `validateDataFileJsonWithTemplate` sees the `json_schema` URL
  point at a GitHub host, emit a `[WARNING]`:

  > *"json_schema env var points at a GitHub-hosted schema (…). The UnionInternationalCheminsdeFer/OSDM-testing repo (exch_dev branch and others) is deprecated as a schema reference — its schema is out of sync with the modern OSCAR datafile shape and produces false-positive validation failures (typically 'Required property `offerSearchCriteriaList` is missing'). Update the company's environment file to point at the OSCAR-bundled local schema: http://localhost:8080/json_validator/datafile.schema.json"*

- `Bruno_Collection/library-bruno/scenarioParser.js` — three
  upfront `[ERROR]` lines for unresolved scenario id-references.
  When the scenario's `tripRequirementId`,
  `passengersListId`, or `requestedFulfillmentOptionsListId`
  doesn't match any entry in the corresponding datafile array,
  emit a precise error naming the unresolved id, the available
  ids, and the wizard section to fix (Trip Requirements,
  Passengers, or Requested Fulfillment Options respectively).
  Example:

  > *"Scenario `OBB_SALE_1ADT_1LEG` references tripRequirementId=42 but no matching entry exists in datafile.tripRequirements[]. Available ids: [1, 2, 3]. Fix in the wizard: open the Test Data → Trip Requirements section…"*

  Without this check the tester only saw the downstream symptom —
  *"Required scenario variable offerTripSearchCriteria is empty
  or not set"* — and had to reverse-engineer the linkage gap
  through the parser.

- `Bruno_Collection/library-bruno/envUtils.js` — per-variable
  hints appended to `parseEnvJson`'s required-but-empty error.
  The four scenario-id-dependent variables
  (`offerTripSearchCriteria`, `offerTripSpecifications`,
  `offerPassengerSpecifications`, `offerSearchCriteria`) now
  carry a tail message naming the upstream resolver and the
  likely cause:

  > *"Upstream resolver: scenarioParser.osdmTripSearchCriteria() / osdmTripSpecification(). TripType currently=\"SEARCH\". When this variable is empty the cause is almost always an unresolved scenario.tripRequirementId — look for `Scenario \"...\" references tripRequirementId=... but no matching entry exists` in the run log above. Fix: open the Test Data → Trip Requirements section in the wizard and link the scenario to a defined entry."*

### Behaviour guarantees

- All new log lines are advisory. No assertion contracts change.
- 21 partial-refund + 26 framework-gating unit tests still pass.
- `npm run lint` clean. No data-file schema change. No backend
  behaviour change.

### Known structural gap (not addressed in this PR)

The OBB env file still references the GitHub `exch_dev` schema —
the new `[WARNING]` makes that visible, but the file itself needs
manual update (or a Test Manager re-runs the wizard's environment
generation step). A future PR could ship a one-time migration
that rewrites any stored env file's `json_schema` value to the
local URL, gated on detecting the GitHub pattern.

---

## [server-v1.11.108] — 2026-06-09

**Three assertion wording / semantic fixes surfaced by a tester
walking through a real Paxone REFUND run.** All in `refunds.js` +
a sweep across 17 `.yml` files. No data-file schema change, no
backend change, no wizard UI change.

### Fixed

- **`AppliedOverruleCode is null as expected` ✗ false-positive
  when provider OMITS the field.** Paxone responds with the
  `appliedOverruleCode` field absent from the JSON body (so chai
  sees `undefined`); the test expects `null`. Both omitted-field
  and explicit-null are valid OSDM responses meaning the same
  thing — *"no overrule applied"*. `validateRefundAppliedOverruleCode`
  in `Bruno_Collection/library-bruno/refunds.js` now normalises
  `undefined → null` before the chai equality check. The
  assertion title also annotates which form the provider returned
  so the report reader sees it explicitly:

  > `AppliedOverruleCode is null as expected (actual: undefined → treated as null)`

- **`Refund offer[N] refundFee exists and is valid, amount: 0,
  currency: EUR` wording confused readers.** *"exists and is
  valid"* sounded like an economic claim about the fee, but per
  OSDM (`RefundOffer.refundFee: "Amount kept by the carrier and/or
  distributor"`) the assertion is structural — the Price object
  must be present even when amount=0 (no retention). Rephrased to
  name the structural check explicitly and annotate amount=0 vs
  amount>0 with the OSDM semantic:

  > `Refund offer[0] refundFee Price structure is well-formed — amount: 0 EUR (= no carrier retention), scale: 2`

  or, for non-zero:

  > `Refund offer[0] refundFee Price structure is well-formed — amount: 1000 EUR (= kept by carrier per OSDM), scale: 2`

- **`Status code is 200 ✗ expected 405 to deeply equal 200`
  misleading test name.** The historical title *"Status code is
  200"* asserted "200" as if it were a claim about the actual
  response, which read poorly when the response was 405. Renamed
  to a self-documenting dynamic name that names both expected
  and actual in the title:

  > `HTTP response status — expected 200, actual: ${res.getStatus()}`

  Swept across 17 `.yml` files (main test + the throw-on-failure
  branch). Two patterns deliberately left unchanged:
  `bruTest("Status code is 200 — STOP on failure", ...)` (the
  suffix already self-documents) and
  `test('Status code is 200 or 202', ...)` (different assertion,
  not a "must be 200" claim).

### Behaviour guarantees

- The chai comparisons themselves are unchanged — these are
  wording / normalisation fixes only.
- 21 partial-refund + 26 framework-gating unit tests still pass.
- `npm run lint` clean.

---

## [server-v1.11.107] — 2026-06-09

**Tester ergonomics — request timestamp logging + Copy/Download
buttons on JSON bodies in both report views.** Two pieces of
feedback from a tester, bundled into one PR. Resolves
[#324](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/324)
and [#325](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/325).

### Added

- **#324 — request start timestamp on every step.** A new
  `logStepStart(req)` helper in
  `Bruno_Collection/library-bruno/displays.js` prints a
  millisecond-precision UTC timestamp + Europe/Paris local-time
  annotation:

  ```
  ⏩ [STEP] [2026-06-09T07:23:26.087Z (= 2026-06-09 09:23:26.087 Europe/Paris)] Executing request : 10. POST Refund Offers
  ```

  Swept across all 30 `.yml` files that previously hardcoded
  `console.log("⏩ [STEP] Executing request : " + req.getName())`.
  The bracketed prefix sits after the existing `⏩ [STEP]` marker
  so any tool matching on that marker still finds the line. Same
  timestamp pattern as the refund-offer `createdOn / validFrom /
  validUntil` annotations shipped in v1.11.106.

  Why this matters: testers correlating an OSCAR run with provider-
  side logs (Paxone, Bileto, …) previously had to compute the
  request wall-clock from run start time + cumulative durations.
  Now it's right there next to the step.

- **#325 — per-message Copy + Download buttons.**

  - **Dashboard** (`Oscar_Server/public/run-detail.html`): each
    request and response body in the HTTP Traffic section now has
    Copy / Download / ⌄ Expand buttons in the message header (next
    to the existing Raw/Tree toggle). Copy puts the body on the
    clipboard; Download saves it as a self-named JSON file;
    Expand removes the 360px scroll-cap in place so the full body
    is readable without leaving the dashboard.
  - **Open Report** (`Oscar_Server/public/report-builder.html`):
    the existing Copy button gains a sibling Download button using
    the same filename pattern.

  Filename pattern:
  `${scenarioCode}_${stepName}_${kind}.json` with non-FS-safe
  characters (`\ / : * ? " < > |` + whitespace) collapsed to
  underscores. A file downloaded from either view has the same
  name, so they can be reconciled without renaming.

### Behaviour guarantees

- The dashboard 360px scroll-box (`.msg-pre max-height`) was a
  display constraint, not data truncation. The full body was
  always in the DOM. The Expand toggle just lifts the CSS cap.
- The 100 KB server-side `MAX_BODY_SIZE` cap behaviour is
  unchanged (separate config knob via `MAX_BODY_SIZE` env var).
  When a body hits that cap, the truncation marker
  `[truncated NNN bytes]` appears in the copy/download too — the
  tester sees the truncation explicitly.
- No data-file schema change. No backend behaviour change. No
  wizard UI change. 21 partial-refund + 26 framework-gating
  unit tests still pass.

---

## [server-v1.11.106] — 2026-06-09

**Refund assertion semantics corrected — OSCAR no longer asserts a
specific `refundableAmount` in the normal flow.** The historical
*"Refundable amount is 0 because overruleCode is null or
CODE_DOES_NOT_EXIST"* assertion was **semantically inverted**: it
encoded *"no overrule → refund denied → amount must be 0"* as a
global truth, which only holds in one specific edge case (booking
outside every applicable `afterSalesCondition` window). The general
truth — and the rule OSCAR now enforces:

| Flow | Provider's contract | OSCAR's assertion |
|---|---|---|
| **Normal** (no overrule) | Provider owns the rules (time, fare, distance, internal commercial). OSCAR can't predict the answer. | Structural bounds only (non-negative, ≤ confirmedPrice, currencies match). Log the values for human reconciliation. **Do NOT assert a specific amount.** |
| **Exceptional** (overrule set) | Bypass the normal rules, refund the full booking value with no fee. | Strict equality: `amount == confirmedPrice` AND `fee == 0`. |
| **Partial-refund**, either flow | Scope returns strictly less than full. | `fee + amount < confirmedPrice` (strict). |

### Fixed

- `Bruno_Collection/library-bruno/refunds.js` —
  `validateRefundableAmountLocal` rewritten:
  - New always-applies **structural-bounds** test
    (non-negative, sum ≤ confirmedPrice, currency consistent).
  - **Overrule-set** branch verifies the overrule contract was
    honoured (full: `amount == confirmedPrice && fee == 0`;
    partial-with-overrule: `fee == 0` on top of the partial-scope
    strict-less identity).
  - **No-overrule** branch logs what the provider returned but
    does NOT assert a specific value. The provider's response is
    authoritative; OSCAR is not the source of truth for refund rules
    that depend on conditions OSCAR can't compute.
  - The Paxone partial-refund scenario reported on 2026-06-09 — no
    overrule sent, Paxone returned 5000 EUR for a booking 9 days
    out — now correctly passes (was failing *"expected 5000 to
    equal 0"*).

- `Bruno_Collection/library-bruno/refunds.js` — provider timestamps
  arrive in UTC (`+00:00`). The `createdOn / validFrom / validUntil`
  assertion messages now append a parenthetical `Europe/Paris`
  reading so the report shows both at once:
  > `... is valid and in the past: 2026-06-09T05:23:26+00:00 (= 2026-06-09 07:23:26 Europe/Paris)`

  Pure display change; the comparison is and was always UTC-based
  (epoch-ms), so the verdict is unchanged.

### Changed

- `Bruno_Collection/03-Refund/10. POST Refund Offers.yml` — the
  partial-refund alignment assertion is renamed from
  *"Partial refund: response refundableAmount matches expected
  partial sum"* to *"Partial refund: request/response alignment —
  response refundableAmount matches the sum of in-scope parts"*. The
  historical wording sounded like a maths claim; the new wording
  names what is being verified. The error message already includes
  the wire-scope shape (e.g. `fulfillment[b90ddfa8…].bookingParts
  (6 part(s))`) so a failure is self-explanatory.

### Behaviour change worth knowing

Two cases shift between pass and fail vs. the historical behaviour:

- **Previously passed, now fails**: a provider that ignored an
  overrule and returned a partial amount or non-zero fee was
  silently accepted before. The exceptional-flow branch now asserts
  the overrule contract strictly. If a real provider does this, the
  test will surface it clearly. *(This is the intended direction —
  the overrule contract is now genuinely tested.)*

- **Previously failed, now passes**: a scenario whose booking is
  legitimately within the refund window, with no overrule set, that
  returns a non-zero amount from the provider. The old assertion
  fired *"expected X to equal 0"* — a false positive failure. The
  new no-overrule branch logs the values and does not assert. *(This
  is the case the user surfaced on 2026-06-09 with the Paxone
  scenario.)*

### Behaviour guarantees

- 21 existing partial-refund unit tests still pass.
- 26 framework-gating unit tests still pass.
- No data-file schema change. No backend change. No wizard UI
  change. The partial-refund identity assertion
  (`fee + amount < confirmedPrice` strict) is preserved exactly.
- The partial-scope structural check
  (response.refundOfferBreakdownItems[].bookingParts ⊆ requested)
  is preserved exactly.

---

## [server-v1.11.105] — 2026-06-08

**Framework-gating "golden rule" — Test Framework now declares what
scenarios may exercise.** *"What is not defined in the framework
cannot be tested."* First feature gated: partial refund. Soft
validation: existing scenarios keep working, runs are never blocked,
but the gap is surfaced at three levels (UI banner + inline chip,
served-datafile annotation, runtime `[WARNING]`).

### Added

- `Oscar_Server/src/utils/frameworkGating.js` — single source of
  truth for the field↔flow mapping. Five pure functions:
  - `gatingRules()` — rule table (currently
    `partialRefundByLeg / partialRefundByPax → REFUND_PARTIAL`).
  - `isScenarioArmedForField(scenario, rule)` — value normalisation,
    scenario-type scoping.
  - `scenarioWarnings(scenario, framework)` — per-scenario list of
    armed-but-not-declared fields.
  - `deriveSalesFlowsAdditions(scenarios, framework)` — derive
    missing flow declarations from existing scenarios (migration).
  - `applyFrameworkMigration(framework, scenarios, nowIso)` — one-
    time mutation with `_salesFlowsMigratedAt` stamp; idempotent.
  - `annotateDatafile(datafile, framework)` — inject
    `__featureNotDeclaredWarnings` into each scenario; remove stale
    annotations when the framework now declares the feature.

- `Oscar_Server/tests/unit/framework-gating.test.js` — 26 cases
  covering all five helpers plus the integration scenario
  (pre-migration warnings → migration runs → re-annotation clean).

### Changed

- `Oscar_Server/src/api/routes/company-test-framework.js` —
  `GET /test-framework` runs the lazy migration once per framework
  (gated by `_salesFlowsMigratedAt`). The company's datafile is
  decrypted in-process, scenarios scanned, missing flow declarations
  derived, framework re-encrypted and persisted. Conservative:
  ADDS to `salesFlows[]`, never removes — so a Test Manager's
  running configuration is preserved exactly. Datafile unreadable
  is non-fatal (warn-and-stamp); persistence failure returns the
  in-memory result and lets the next GET retry.

- `Oscar_Server/src/api/routes/company.js` — `GET /datafile` now
  annotates the served bytes. Each scenario whose armed feature
  isn't declared in the current framework gets
  `__featureNotDeclaredWarnings: [field, ...]`. The on-disk file
  is unchanged. Framework lookup / annotation failures fall back
  to serving the raw datafile (soft validation: warnings are
  best-effort, never block the run).

- `Bruno_Collection/library-bruno/scenarioParser.js` — reads
  `scenario.__featureNotDeclaredWarnings` at scenario load and
  emits one `[WARNING]` per entry. Message names the field and
  points the Test Manager at the Test Framework wizard. The
  warning is purely advisory: the scenario still runs, the
  runtime degrades downstream where the wire can't carry the
  scope.

- `Oscar_Server/public/js/scenarios.js` — wizard UI:
  - New `fwDeclaresPartialRefund(scenarioType)` helper alongside
    the existing `fwSupportsIrops` pattern.
  - Inline amber chip in the partial-refund block when the
    scenario arms `partialRefundByLeg` or `partialRefundByPax`
    without the framework declaring `REFUND_PARTIAL`. Names the
    fix path (tick the Partial card in Test Framework ✂️ Refund
    row, or unset the scenario flag).
  - Top-of-scenarios soft-validation banner with the count of
    affected scenarios and the same fix path. Renders only when
    the count > 0.

### Behaviour guarantees

- Existing scenarios keep working. The migration ADDS flow
  declarations; it never removes anything.
- Existing tests (21 `bruno-partialrefund.test.js`) still pass.
- The annotator and warning emission are forward-compatible:
  pre-v1.11.105 Bruno collections ignore `__featureNotDeclaredWarnings`
  as an unknown field.
- No data-file schema change. No wizard breakage. No backend
  behaviour change beyond the warnings.

### Known limitations

- This PR ships the rule for **partial refund only**. The same
  pattern will be extended in follow-ups to `partialExchangeByLeg / byPax`,
  the RequestedInformation probe, the `refundDate` time-travel overrule,
  and the overrule-code catalogue. New rules go into `gatingRules()`
  in `frameworkGating.js` — no schema migration needed beyond the
  one-time `_salesFlowsMigratedAt` already added here.

---

## [server-v1.11.104] — 2026-06-08

**Partial refund (#218) — alignment assertion now compares against the
actual wire scope, not the resolver's internal intent.**

Follow-up to v1.11.103. After v1.11.103 shipped, a Paxone test against
a 4-pax / 2-leg booking with both axes armed (`partialRefundByLeg=on
(last)` + `partialRefundByPax=on (last)`) produced the correct
behaviour at every layer except the alignment assertion:

- ✅ Request: `fulfillmentIds: ["<nicolas's fulfillment>"]` (1 entry,
  scoped, OSDM-3.5 compatible). The duplicate-push and trim-list
  fixes from v1.11.103 worked.
- ✅ `refundSpecifications` correctly omitted (Paxone on osdmVersion
  3.5). The OSDM version guard worked.
- ✅ Paxone returned `refundableAmount=5000 EUR` = sum of all 6 of
  nicolas's booking parts (admissions + reservations + ancillaries on
  BOTH legs of the trip). The fulfillment maps to one passenger's
  parts on Paxone.
- ❌ The new alignment assertion still failed with
  `expected=2500, got 5000` and falsely blamed the provider.

The bug: the assertion was computing expected from the resolver's
per-leg × per-pax intersection (3 parts on the last leg only =
2500 EUR), but on OSDM v3.5 the per-leg axis is silently dropped at
the wire because `refundSpecifications.bookingPartIds` isn't yet
supported. The wire actually conveyed "all of nicolas's parts" via
`fulfillmentIds[]` alone — and Paxone honoured exactly that.

### Fixed

- `Bruno_Collection/03-Refund/10. POST Refund Offers.yml` — expected
  refundable amount is now computed against what the request body
  actually contains:
  - `refundSpecifications.bookingPartIds` present → provider refunds
    exactly those parts → expected = sum of those parts' prices.
  - `refundSpecifications.passengerIds` only (no bookingPartIds) →
    provider expands to every part owned by the named passengers →
    expected = sum of those parts walked from `bookedOffers[].*`.
  - No `refundSpecifications` at all (e.g. OSDM v3.5 path) → wire
    scope is just the referenced fulfillment → expected = sum of
    parts named in `fulfillment.bookingParts[].id`.
- The assertion error message now names the wire-scope shape (e.g.
  `fulfillment[b90ddfa8…].bookingParts (6 part(s))`) so the failure
  is self-explanatory instead of leaving the reader to guess what
  was being measured.

### Added

- `Bruno_Collection/03-Refund/10. POST Refund Offers.yml` — explicit
  `[WARNING]` log line emitted when an axis is silently dropped due
  to `osdmVersion < 3.8`. Spells out in plain English why a per-leg
  request can't be conveyed and that the response will cover every
  leg of the chosen passenger / every passenger on a single-
  fulfillment booking. Per-leg-only on a multi-fulfillment booking
  triggers an extra `[WARNING]` because picking one fulfillment
  refunds one passenger across all legs — never "the chosen leg
  across all passengers" — and the wizard's intent is lost.

### Behaviour guarantees

- Full-refund scenarios unchanged.
- v1.11.103 fixes (duplicate-push, trim list, fulfillment-by-pax
  match, leg ordering via trips, reservationRefs walk) unchanged.
- Existing 21 partial-refund Jest unit tests still pass.
- No data-file schema change. No backend change. No wizard UI change.

### Known unrelated

The separate pre-existing assertion *"Refundable amount is 0 because
overruleCode is null or CODE_DOES_NOT_EXIST"* fails on the same
Paxone REFUND scenario because the booking's
`afterSalesConditions[].validFrom` is in the future (refund window
opens on the day of travel) and Paxone returned a refund offer
anyway. That's a separate provider-vs-OSDM semantic question
(strict-window reading vs free-text-condition reading) that was
present before v1.11.103 and is unchanged here.

---

## [server-v1.11.103] — 2026-06-08

**Partial refund (#218) — request was malformed in five ways and the
response was treated as a partial refund even when the provider had
silently produced a full one.** Discovered debugging a Paxone REFUND
scenario where the response `refundableAmount` equalled the booking's
full `confirmedPrice` — partial scope was never actually applied.

### Fixed

- `Bruno_Collection/library-bruno/bookings.js` — duplicate
  `fulfillmentIds[]` push. The `fulfillments.forEach` loop pushed each
  fulfillment id **twice** (once inside the `if (fulfillment?.id)`
  guard, once unconditionally below) so the env var carried every id
  duplicated. Providers tolerated it for full-refund / full-exchange,
  but partial-refund scoping (#218) couldn't work. Dedupe to one push
  per fulfillment.

- `Bruno_Collection/library-bruno/requestsBuilder.js` —
  `requestRefundOffersBody` now trims `fulfillmentIds[]` down to the
  scoped fulfillment when partial is armed. The original code kept the
  full list **and** added `refundSpecifications`, which providers
  correctly interpreted as "refund all these in full".

- `Bruno_Collection/library-bruno/partialRefund.js` — full resolver
  rewrite to address three logic bugs:
  - **Fulfillment selection.** The old resolver picked
    `booking.fulfillments[0].id` unconditionally. Paxone models
    one-fulfillment-per-passenger; on a 4-pax booking,
    `fulfillments[0]` is for the first passenger regardless of which
    passenger the scenario targeted. Now matches
    `fulfillment.fulfillmentParts[].passengerRef` against the chosen
    passenger's `externalRef`, with a fallback to `fulfillments[0]`
    for single-fulfillment providers (Bileto, Sqills).
  - **Leg ordering.** The old resolver flattened
    `bookedOffers[].admissions[]` and treated that flat list as the
    "leg list" — on a multi-pax booking the flat list is
    `legs × passengers` so "last by index" almost never matched the
    user-visible "last leg". Now reads
    `booking.trips[*].legs[*].id` (the authoritative ordering the
    wizard's first/last/outbound/inbound labels refer to) and
    collects admissions whose
    `tripCoverage.coveredLegIds` contains the picked leg.
  - **Booking-part expansion.** The old resolver looked for
    `requiredAdmissionKey | admissionRef | admissionId` on the
    reservation / ancillary side — those fields don't exist on
    OSDM / Paxone bookings. Now walks `admission.reservationRefs[].id`
    and `admission.ancillaryRefs[].id` (the actual linkage) so the
    in-scope set includes dependent parts.

  Plus: when both axes are armed, admissions are filtered by the
  intersection (covering the chosen leg **AND** owned by the chosen
  passenger). Previously the two axes resolved independently and
  could disagree on the subject (`refundSpecifications[].passengerIds`
  pointing at one passenger, `bookingPartIds` pointing at another).
  An empty intersection now degrades instead of sending a leg-less,
  parts-less spec that the provider would re-interpret as full refund.

### Added

- `Bruno_Collection/03-Refund/10. POST Refund Offers.yml` — OSDM
  version guard. When the negotiated `osdmVersion < 3.8` (e.g. Paxone
  sandbox currently on 3.5), `refundSpecifications[]` is omitted from
  the request body (the provider would reject it as
  `OSDM_EXTRA_REQUEST_FIELDS_IGNORED` and silently produce a full
  refund); scoping then happens via the trimmed `fulfillmentIds[]`
  alone, which v3.5+ already supports.

- `Bruno_Collection/03-Refund/10. POST Refund Offers.yml` —
  after-response alignment assertion. Compares
  `response.refundOffers[0].refundableAmount` against the sum of the
  in-scope booking-part prices computed before the request, and fails
  with a clear message if the provider ignored the scope. The symptom
  that started this investigation (Paxone returning the full
  `confirmedPrice` instead of the partial sum) now surfaces as a test
  failure instead of a silent full refund.

### Behaviour guarantees

- Full-refund scenarios (`partialRefundByLeg=off` and
  `partialRefundByPax=off`) are unchanged: `fulfillmentIds[]` carries
  every fulfillment in the booking (deduped) and no
  `refundSpecifications` field is sent.
- Exchange-offers requests benefit from the duplicate-push fix
  automatically — they share the same `fulfillmentIds` env var. The
  scoping logic in `requestRefundOffersBody` is refund-only.
- No data-file schema change. No backend change.

---

## [server-v1.11.102] — 2026-06-08

**Wizard UX — passenger category change no longer snaps the viewport
to the top of the panel.** Reported by a tester after v1.11.101 shipped:
editing in the Passengers section required scrolling all the way down
again every time the type dropdown changed value (ADULT → CHILD etc.),
and any other param-section the tester had open (NHF, Booking Flow
Actions, …) collapsed back to default along with the scroll loss.

### Fixed
- `Oscar_Server/public/js/scenarios.js` — `reRenderScenarioDetail`
  (line ~1974) now captures `window.scrollY` at entry and restores it
  after the innerHTML swap. Transparent improvement for every caller of
  the helper (family-group change, apply-trip-train, set-pax-text on
  firstName/lastName, etc.). No-op when the scroll position is
  unchanged across the swap.
- `Oscar_Server/public/js/scenarios.js` — the `change-pax-category`
  handler (`case 'change-pax-category'`, line ~6299) now routes through
  `reRenderScenarioDetail` instead of doing an inline
  `det.innerHTML = buildDetailHTML(...)`. Picks up the section-state
  preservation that the inline path bypassed (previously every section
  except Passengers collapsed) AND the new scroll preservation.
- Same handler — the category dropdown is re-focused after the
  re-render so the keyboard / pointer can continue editing without an
  extra click.

### Behaviour guarantees
- Wizard-only change. Runtime, data semantics, and save behaviour
  unchanged.
- No data-file schema change. No backend change.
- Other handlers that use the same inline `det.innerHTML = …` pattern
  (lines 5593, 5729, 6061, 6098) are NOT touched in this PR — they live
  on different edit paths (scenario type change, framework apply,
  scenario delete, scenario re-order) where the viewport reset is
  arguably more expected than during in-row editing. Worth a follow-up
  sweep if testers report similar friction on those paths.

### Operator action
None.

### Bumps
- `Oscar_Server/package.json` 1.11.101 → 1.11.102
- `Bruno_Collection/VERSION` OTST_V2.0.49 → OTST_V2.0.50
- New compatibility row `release-2026.130`

---

## [server-v1.11.101] — 2026-06-08

**Wizard UX — RequestedInfo probe presentation matched to the format
probe.** Tester feedback after v1.11.100 shipped: the new
*Field-shape & payload probes* sub-group rendered the format probe
inside a clean dashed-border box (uppercase mini-header, dropdown,
full-width hint underneath) while RequestedInfo probe still used
`buildSelect`'s grid layout — its long multi-sentence hint got
squeezed into a narrow vertical strip next to the dropdown. Now both
probes use the same dashed-border presentation, so the hint sentence
flows across the full sub-group width.

### Changed
- `Oscar_Server/public/js/scenarios.js`: inside
  `buildNonHappyFlowSection`'s shape-probes sub-section,
  `requestedInformationProbe` is now rendered by a small inlined
  builder that matches the format-probe block — same uppercase
  mini-header, same dropdown width cap, same hint placement.
  `buildSelect` no longer used for this field.

### Behaviour guarantees
- `data-action="set-scenario"` and `data-field="requestedInformationProbe"`
  unchanged — the save handler at `case 'set-scenario'` (line ~6010)
  picks up the new dropdown the same way.
- Field name, enum values, and runtime semantics unchanged. Pre-existing
  scenarios behave identically; only the visual presentation moved.

### Operator action
None. No data-file schema change.

### Bumps
- `Oscar_Server/package.json` 1.11.100 → 1.11.101
- `Bruno_Collection/VERSION` OTST_V2.0.48 → OTST_V2.0.49
- New compatibility row `release-2026.129`

---

## [server-v1.11.100] — 2026-06-08

**Wizard UX — Non Happy Flow customisation reorganised.** Two new
collapsible sub-groups inside the existing NHF section, each with a badge
counter showing how many of its probes are currently armed:

```
▼ Non Happy Flow customisation        — N probes armed
    ▶ ⏰ Expiry timers                  — N of 6 armed
    ▶ 🪪 Field-shape & payload probes  — N of 2 armed
```

### Moved
- `requestedInformationProbe` now renders in the **Field-shape & payload
  probes** sub-group instead of the SCENARIO PARAMETERS panel. The
  Tester Guide §4.8 always classified it as an NHF probe; the wizard now
  matches. Field name unchanged — pre-existing scenarios behave
  identically.

### Added
- Per-sub-group badge counters: amber pill *"N of M armed"* when N > 0,
  neutral grey when N = 0. Same visual vocabulary as the Test Framework
  pill counters elsewhere in the wizard.
- Auto-expand behaviour — each sub-group opens automatically when
  anything inside it is armed and stays collapsed otherwise. The top
  NHF section follows the same rule based on the total. Manual toggles
  are preserved across re-renders.

### Changed
- NHF section subtitle broadened from *"expired-X negative tests — wait
  past a deadline, assert the provider rejects the next request"* to
  *"negative tests and conformance probes"* so the description no longer
  lies about what lives there.

### Not changed (deliberately)
- `bookingPurchaserMode` stays in SCENARIO PARAMETERS because it mixes
  happy modes (`inline`, `deferred`) with NHF modes (`omit`, `invalid`).
  Splitting one field across two sections would be worse than the small
  inconsistency.
- **Partial refund** stays in SCENARIO PARAMETERS — it's a scope
  refinement of the refund request, not a probe. The `NHF_…_PARTIAL_REFUND`
  prefix in scenario *names* comes from the expired-X test you arm on
  top of it, not from partial refund itself.

### Operator action
None. No data-file schema change, no backend / runtime change. Pre-existing
scenarios render identically (the moved probe field name is unchanged) and
behave identically at run time.

### Bumps
- `Oscar_Server/package.json` 1.11.99 → 1.11.100
- `Bruno_Collection/VERSION` OTST_V2.0.47 → OTST_V2.0.48
- New compatibility row `release-2026.128`

---

## [server-v1.11.99] — 2026-06-08

**New NHF probe.** A multi-passenger SALE scenario can now arm the
`passengerExternalRefFormat` probe to override the default `00001`-style
passenger reference with a printf-style pattern, applied at scenario-parse
time and propagated through every downstream call (offer, booking,
refund, exchange) consistently. The probe is exposed in the wizard's
**Non Happy Flow customisation** section with a live preview of the first
three generated references as the tester types.

The probe documents real-world provider variance:

| Vendor | `00001` | `PAX1` | `PAX0001` |
|---|---|---|---|
| Bileto | ✅ | ✅ | ✅ |
| Sqills | ✅ | ✅ | ✅ |
| Turnit | ✅ | ✅ | ✅ |
| Benerail | ✅ | ✅ | ✅ |
| **Paxone** | ✅ | **❌ Schema validation error** | ✅ |

OSDM v3.8 declares `externalRef` as `type: string` with no `pattern` —
Paxone enforces a tighter rule client-invisibly. This probe lets the
tester drive that variance into the test report deliberately.

### Added — wizard
- `Oscar_Server/public/js/scenarios.js`: new optional scenario field
  `passengerExternalRefFormat` (string, default empty). Rendered as a
  text input inside the NHF section with a live preview of the first
  three generated refs and a validation hint when the pattern lacks a
  `%d` / `%0Nd` placeholder.
- `previewExternalRef()` helper inlined locally for the wizard preview —
  same parser as the runtime side, kept in sync via the unit test.

### Added — runtime
- `Bruno_Collection/library-bruno/scenarioParser.js`: new exported
  function `applyExternalRefFormat(pattern, n)` — pure parser for the
  printf-style pattern. Recognises `%d`, `%Nd` and `%0Nd`. Returns the
  pattern unchanged if it lacks a placeholder; returns `String(n)` if
  the pattern is null/empty.
- The passenger loop in `parseScenarioData` rewrites
  `passenger.reference` in-place when the probe is armed, BEFORE the
  downstream `AnonymousPassengerSpec` / `PassengerSpec` /
  `passengerReferences` / `updateXxx_<i>` env vars are materialised.
  The mutation is run-local — `jsonData` is re-parsed from the data
  file on every scenario load, so no state leaks across runs.

### Added — schema
- `Bruno_Collection/json_validator/datafile.schema.json`: new optional
  `passengerExternalRefFormat` field on the scenario object (`type:
  ["string", "null"]`, no pattern enum — the runtime validates the
  pattern shape on its own).

### Added — tests
- `Oscar_Server/tests/unit/bruno-externalrefformat.test.js`: 16 cases
  covering the documented happy paths (`PAX%04d`, `%05d`,
  `ABC-%03d-XYZ`), width edge cases (no padding, undersized width,
  zero-width), graceful degradation (null / undefined / empty pattern,
  pattern without a placeholder, pattern with two placeholders), and
  table-driven parity with the wizard's preview parser.

### Documentation
- Tester Guide section 4.8 expanded with the new probe, including a
  vendor-conformance table and the wizard preview behaviour.

### Operator action
None. The probe is OFF by default; pre-existing scenarios behave
exactly as before. Watchtower picks up `:stable` automatically once
`promote-release` republishes the image.

---

## [server-v1.11.98] — 2026-06-08

**Wizard hotfix.** Multi-passenger SALE scenarios failed `POST /offers` on
Paxone with four `Schema validation error` messages (one per passenger from
the second onwards), while the same scenario succeeded on Bileto, Sqills,
Turnit and Benerail. Root cause: the wizard generated passenger references
in the form `PAX1`, `PAX2`, `PAX3`, ... but Paxone's `externalRef` validator
enforces a stricter-than-OSDM shape and rejects anything that isn't numeric /
zero-padded. OSDM v3.8 itself permits any non-null string
(`AnonymousPassengerSpecification.externalRef`: `type: string`, no `pattern`),
but the wizard was the only place in OSCAR that didn't use the 5-digit
zero-padded shape already used by `Bruno_Collection/library-bruno/requestsBuilder.js`
(lines 178 / 455 / 468). One-side inconsistency, one-side fix.

**Bruno collection bumped (OTST_V2.0.45 → OTST_V2.0.46).** No data-file
schema change — the schema accepts any non-empty string for the `reference`
field on a passenger.

### Fixed
- `Oscar_Server/public/js/scenarios.js`: three sites that build passenger
  references now produce `"00001"`, `"00002"`, … instead of `"PAX1"`,
  `"PAX2"`, … :
  - `wizGenPassengers()` (line ~4960) — initial generation for a new
    scenario;
  - the "add passenger" UI handler (line ~5393) — appending to an existing
    passengersList;
  - the re-indexer after a passenger is removed (line ~5549).

### Tester action — pre-existing scenarios
Scenarios authored **before** this release keep their old `PAX1`-style
references in the data file. They continue to fail on Paxone until you
either:

1. **Re-author the scenario** in the wizard — the regenerated passenger
   list uses the new format and overwrites the old refs.
2. **Hand-edit the data file** — rename every `"PAXn"` occurrence to its
   zero-padded equivalent (`PAX1 → "00001"`, `PAX2 → "00002"`, …). The
   reference appears in three places per scenario:
   - `passengersList[].passengers[].reference`
   - `bookingPassengerReferences` (a flat array of strings)
   - any echoed `externalRef` inside `offerPassengerSpecifications` /
     `bookingPassengerSpecifications` if your data file was hand-edited
     before to materialise those fields.

Bileto, Sqills, Turnit, Benerail accept both formats and are unaffected
by either choice.

### Spec-side observation
OSDM v3.8 declares `externalRef` as `type: string` with no `pattern`. Paxone
enforces a tighter rule client-invisibly. Worth raising with the OSDM
working group: either tighten the spec (so OSCAR can validate client-side
and fail fast) or document Paxone's local rule in their connector notes.

---

## [server-v1.11.97] — 2026-06-07

**Hotfix #218.** The wizard's per-passenger / per-leg validation for partial
refunds always reported `0 passengers` and `0 legs`, firing the inline
warning even when the resolved passengersList had 5 passengers (reported via
screenshot of a `NHF_ETO_…_5ADT_…_PARTIAL_REFUND` scenario).
**Bruno collection bumped (OTST_V2.0.44 → OTST_V2.0.45).**

### Fixed

- `Oscar_Server/public/js/scenarios.js` `buildPartialRefundFields` reached
  for `wizData.passengersLists` and `wizData.tripRequirements` — neither
  exists. The canonical lookups are `state.passengersList` (singular noun,
  array of lists) and `state.tripRequirements` (plural), already wrapped by
  the `getPassengers(id)` / `getTrip(id)` helpers defined at the top of
  the file. Switched to the helpers so `resolvedPassengerCount` and
  `specLegCount` actually count the resolved entries.
- The inline warnings now fire only when the configuration genuinely
  can't be satisfied — multi-pax REFUND scenarios no longer get a
  spurious "Per-passenger partial refund requires ≥2 passengers" red message.

### Versions

- `Bruno_Collection/VERSION`: `OTST_V2.0.44` → `OTST_V2.0.45`.
- `Oscar_Server/package.json`: `1.11.96` → `1.11.97`.
- `compatibility.json`: new entry `2026.125`.

### Not affected

- The runtime check in `10. POST Refund Offers.yml` was already correct
  (it reads the booking JSON, not the wizard's data model) — so partial
  refunds that the tester forced through with the bug-affected wizard
  still ran correctly at execution time.
- `scenarioParser.js` setup-time validation was already correct (it reads
  `jsonData.passengersLists` from the data file, not the wizard state).

---

## [server-v1.11.96] — 2026-05-28

**Partial refund (#218).** REFUND scenarios can now scope the refund-offer
request to a subset of the booking — one leg, one passenger, or one
passenger on one leg — via OSDM's `RefundOfferRequest.refundSpecifications[]`.
**Bruno collection bumped (OTST_V2.0.43 → OTST_V2.0.44).**

### Added — partial-refund scenario fields (REFUND scenarios only)
- **`partialRefundByLeg`** (off/on) — scope refund to one leg via
  `RefundSpecification.bookingPartIds`. Requires the booking to have
  ≥2 admissions at run time; degrades to full refund with a `[WARNING]`
  when single-leg.
- **`partialRefundLegSelection`** (`first` / `last` / `outbound` / `inbound`) —
  which leg. `outbound` / `inbound` only valid for return-trips; the wizard
  hides them on one-way and auto-falls-back to `first` if hand-edited.
- **`partialRefundByPax`** (off/on) — scope refund to one passenger via
  `RefundSpecification.passengerIds`. Requires the booking to have
  ≥2 passengers; degrades to full refund when single-pax.
- **`partialRefundPaxSelection`** (`first` / `last`) — which passenger.
- Both axes can be combined → refund one passenger on one leg.

### Added — `library-bruno/partialRefund.js`
- `resolvePartialRefundScope(booking, opts)` — pure mapper. Given a booking
  response + the two axis-on flags + leg/pax selections, returns:
  - `{ armed: false }` when neither axis is on;
  - `{ armed: true, degraded: true, reason }` when the booking can't satisfy
    the requested scope (single-leg / single-pax / missing fulfillment.id);
  - `{ armed: true, degraded: false, fulfillmentId, bookingPartIds, passengerIds }`
    when ready to send.
- `buildRefundSpecifications(booking, opts)` — returns the OSDM array form
  (or `null` when not armed / degraded so the caller falls back to a full
  refund body).
- Leg mapping: `bookedOffers[].admissions[]` is the leg-list; for the chosen
  admission, OSCAR also collects linked `reservations` (matching
  `requiredAdmissionKey` / `admissionRef`) and `ancillaries`. All three id
  classes go into `bookingPartIds`.
- Pax mapping: union of `bookedOffer.passengerRefs[]` across bookedOffers,
  with fallback to `booking.passengers[].id` when `passengerRefs` is empty.

### Added — wizard
- Inline pair of dropdowns (4 fields) shown in SCENARIO PARAMETERS when
  `scenarioType === "REFUND"`. Inline warnings when the configuration can't
  be satisfied:
  - per-pax with <2 passengers in the resolved `passengersList`;
  - per-leg with a `SPECIFICATION` trip that has <2 legs;
  - `outbound` / `inbound` selection on a one-way trip.
- SEARCH-mode trips can't be statically checked — info note explains that
  runtime degradation in `10. POST Refund Offers` handles it.

### Changed — `10. POST Refund Offers.yml` before-request
- When partial refund is armed, reads `__bookingForRefund` (captured in
  `07. GET Booking after Fulfillments.yml`), resolves scope via the helper,
  sets `__partialRefundDegradedToFull` on degradation, passes
  `refundSpecifications` to `requestRefundOffersBody`.

### Changed — `requestsBuilder.js requestRefundOffersBody`
- Extended signature accepts an optional third `refundSpecifications` array;
  attaches it to the body when non-empty.

### Changed — `refunds.js validateRefundableAmountLocal`
- Now partial-refund-aware. When partial mode is armed AND not degraded:
  - Asserts **`refundFee + refundableAmount < confirmedPrice`** (strict-less)
    instead of the equality identity (which would fail by design when only
    a subset is refunded).
  - Additional structural check: `refundOfferBreakdownItems[].bookingParts`
    must be a **subset of the requested `bookingPartIds`** — flags any
    out-of-scope parts the provider refunded.
- When degraded: the standard full-refund identity fires unchanged (full
  refund actually happened, regular assertions apply).

### Changed — `07. GET Booking after Fulfillments.yml`
- Captures the booking JSON to `__bookingForRefund` when partial refund is
  armed (only — keeps env-var size lean for SALE and full-refund paths).

### Schema / parser plumbing
- `Bruno_Collection/json_validator/datafile.schema.json`: 4 new fields.
- `Bruno_Collection/library-bruno/scenarioParser.js`: resolves all 4 fields
  + emits a `[WARNING]` when a hand-edited data file bypasses wizard
  validation (per-pax with single pax, per-leg with single-leg SPEC trip,
  outbound/inbound on one-way). Reset list extended.

### Docs
- **Tester Guide §4.9 (NEW)** — full partial-refund subsection with the
  field table, setup-time validation rules, runtime degradation behaviour,
  and the modified assertion set. §4.10 is now Logging verbosity.
- §7.1 field-name table updated with the 4 new fields.

### Tests
- `tests/unit/bruno-partialrefund.test.js` — covers `resolvePartialRefundScope`
  (no-op / per-leg / per-pax / both / single-leg degradation / single-pax
  degradation / fulfillment.id missing / empty bookedOffers / passengerRefs
  fallback) and `buildRefundSpecifications` (null vs single-entry array,
  correct OSDM shape).

### Versions
- `Bruno_Collection/VERSION`: `OTST_V2.0.43` → `OTST_V2.0.44`.
- `Oscar_Server/package.json`: `1.11.95` → `1.11.96`.
- `compatibility.json`: new entry `2026.124`.

Closes #218.

---

## [server-v1.11.95] — 2026-05-28

**Expired-flow auto-expansion (PR B).** When 2+ expired-X timers are armed
on the same scenario, OSCAR runs that scenario **N times** — one sub-run
per timer, in flow order — instead of forcing the tester to duplicate the
scenario N times.
**Bruno collection bumped (OTST_V2.0.42 → OTST_V2.0.43).**

### Added — `expiredFlow.js` auto-expansion exports
- `buildAndArmExpiredFlowQueue()` — called by scenarioParser at scenario
  init. Inspects timer flags + gating env vars (`scenarioType`,
  `salesFlow_*`, `placeSelectionMode`), builds an ordered queue, persists
  it, and disarms every timer flag except queue[0]. Existing per-YAML
  gates naturally fire only for the current timer.
- `advanceExpiredFlowQueueOrFinish({ scenarioLabel })` — called by each
  gated YAML's after-response. Returns `true` if more timers queued
  (already routed back to `01.`); `false` if queue exhausted (caller runs
  its cross-scenario tail).
- `nhfTestPrefix()` — assertion-name prefix
  `[NHF_<3-letter>_<scenario_code>] ` for multi-timer queues; empty string
  for single-timer (backwards-compatible).
- **3-letter codes**: `OTO` / `BTO` / `ARO` / `ATO` / `RTO` / `ETO`. Stable.

### Added — `scenarioParser.js` sub-run continuation
- Early-return at the top of `getScenarioData` when
  `__expiredFlowSubRunPending === "true"` — skip the full re-parse (env
  state is still valid; only timer flags changed).
- Queue build runs after `salesFlow_*` / `scenarioType` /
  `placeSelectionMode` are resolved so gate functions see consistent state.
- Reset list extended with `__expiredFlowQueue`,
  `__expiredFlowQueueIndex`, `__expiredFlowSubRunPending`.

### Changed — runner SIGTERM math: sum within, max across
- `EXPIRED_FLOW_TIMERS` budget math switches from MAX to SUM within a
  single scenario. 3 timers of 10/15/20 min → `45 min + 3×60s` buffer.
  Across scenarios still MAX (one scenario per worker at a time).
- `RUN_HARD_MAX_TIMEOUT_MS` clamp unchanged.
- Source line shows `<N> timers summed (label1 + label2 + …)` when
  multi-timer.

### Changed — YAMLs
- All 6 gated YAMLs (`02. POST Create Booking`,
  `07. GET Booking after Fulfillments` for booking-expiry,
  `09. POST Add Reservation`, `10. POST Add Ancillary`,
  `03-Refund/13. PATCH Refund Offer`,
  `04-Exchange/11. POST Exchange Operations`) call
  `advanceExpiredFlowQueueOrFinish` before their cross-scenario tails.
- All `test()` assertion names get `nhfTestPrefix()` so multi-timer
  sub-runs are distinguishable in the report.

### Changed — wizard
- Footer note in the "Non Happy Flow customisation" section rewritten:
  describes auto-expansion, the `NHF_XXX_` naming convention, and the
  sum-vs-max budget. The previous "one scenario, one test today" caveat
  is gone.

### Docs
- **Tester Guide §4.8** — new "Auto-expansion: multi-timer scenarios → one
  sub-run per timer" subsection with the assertion-name worked example,
  gating-skip rules, and wait-budget math.

### Tests
- `bruno-expiredflow.test.js`: 3 new test groups (~20 cases) for
  `buildAndArmExpiredFlowQueue` (single, multi, scenarioType gates, add-
  reservation gates, order), `advanceExpiredFlowQueueOrFinish`
  (no-advance, advance + route, last-position), and `nhfTestPrefix`
  (empty ≤1, NHF format ≥2, leading-NHF strip).
- `runner-effective-timeout.test.js`: 3 new PR-B cases — sum within
  scenario, max across mixed-timer-count scenarios, clamp at
  `RUN_HARD_MAX_TIMEOUT_MS`.

### Versions
- `Bruno_Collection/VERSION`: `OTST_V2.0.42` → `OTST_V2.0.43`.
- `Oscar_Server/package.json`: `1.11.94` → `1.11.95`.
- `compatibility.json`: new entry `2026.123`.

### Backwards compatibility
- **Single-timer scenarios unchanged**: same assertion names (no `NHF_…`
  prefix), same routing, same budget (sum-of-one == one).
- **Multi-timer behaviour changed**: previously the first-in-flow timer
  fired and the rest never ran. Now all armed timers run as sub-runs. If
  you relied on the "first wins" pattern, update the data file to enable
  only the intended timer.

---

## [server-v1.11.94] — 2026-05-28

Ship the **4 remaining expired-X negative tests** on top of the shared
`expiredFlow.js` helper (PR A of the expired-flow generalization), and
regroup all 6 timers into a dedicated **"Non Happy Flow customisation"**
section in the wizard.
**Bruno collection bumped (OTST_V2.0.41 → OTST_V2.0.42).**

### Added — Phase 3: expired refund-offer test (`expiredRefundOfferTest`)
- `refunds.js postPatchRefundOfferResponse` captures `refundOffers[0].validUntil`
  → env vars `refundOfferValidUntil` + `refundOfferValidUntilSource`. Gated on
  `expectedRefundOperationStatus` including `"PROPOSED"` so 13.yml's PATCH
  doesn't overwrite the deadline with the post-confirmation value.
- `03-Refund/13. PATCH Refund Offer.yml` gates the acceptance. Asserts 4xx +
  RFC-9457 Problem; skips the downstream GET booking / DEL refund-offer chain
  on the rejected path.
- **REFUND scenarios only.**

### Added — Phase 4: expired exchange-offer test (`expiredExchangeOfferTest`)
- `exchanges.js postPatchExchangeOffersResponse` captures
  `exchangeOffers[0].preBookableUntil` → env vars
  `exchangeOfferPreBookableUntil` + `exchangeOfferPreBookableUntilSource`.
  Env-var name mirrors the spec literal (`preBookableUntil`, not
  `validUntil`) to keep the per-resource-type naming inconsistency
  (Deviations doc #25) discoverable.
- `04-Exchange/11. POST Exchange Operations.yml` gates the acceptance.
  Asserts 4xx + Problem; skips the downstream fulfillment chain.
- **EXCHANGE scenarios only.** No "exchange confirmation" timer needed —
  the post-exchange booking inherits `expiredBookingTest`.

### Added — Phase 5a: expired add-reservation-offer test (`expiredAddReservationOfferTest`)
- `offers.js postOfferResponse` extends its capture: after
  `handleAccommodationAndPlaceSelection` sets `reservationId`, looks up
  the specific reservationOfferPart by id and stashes its `validUntil`
  into `addReservationOfferValidUntil`. **Different source** from
  `expiredOfferTest` (which takes earliest-across-parts) — 09.yml sends
  a single reservation, so we wait past *that* part's deadline.
- `02-Common Requests/09. POST Add Reservation to Booking.yml` gates.
  Asserts 4xx + Problem; skips the AddAncillary / PATCH / GET routing.
- Only meaningful when `salesFlow_placeSelection === "true"` AND
  `placeSelectionMode === "ADD_TO_BOOKING"`.

### Added — Phase 5b: expired add-ancillary-offer test (`expiredAddAncillaryOfferTest`)
- **Primary capture** in `02-Common Requests/11. Add Ancillary - Get Additional Offers.yml`:
  scans `chosen.parts` for the earliest `validUntil`. Stashed into
  `addAncillaryOfferValidUntil`.
- **Fallback capture** in `02-Common Requests/10. POST Add Ancillary to Booking.yml`'s
  before-request: when 11.yml didn't supply ids, look the parts up in
  the selected offer's `ancillaryOfferParts` matching the resolved
  `ancillaryOfferIds`, capture the earliest. Same env vars.
- 10.yml's before-request runs plan+wait after the body is built;
  after-response grades + short-circuits. Asserts 4xx + Problem.
- **Special-case skip**: when 11.yml's additional-offers returns nothing
  addable, logs `[WARNING] expiredAddAncillaryOfferTest is on but the
  provider returned no addable ancillary — test will SKIP` and bypasses
  step 10.

### Changed — wizard: "Non Happy Flow customisation" section
- New `buildNonHappyFlowSection(idx, sc)` in `Oscar_Server/public/js/scenarios.js`
  groups all 6 expired-X timer pairs in a collapsible section (icon ⏰),
  under the scenario detail panel. Visual ordering: Offer → Booking →
  AddReservation → AddAncillary → RefundOffer → ExchangeOffer.
- **RefundOffer / ExchangeOffer rows are scenarioType-gated.**
- Removed the inline `expiredBookingTest` + `expiredOfferTest` rows from
  the SCENARIO PARAMETERS section.
- Footer note explains the run-budget guard, OAuth refresh, and the
  "one scenario, one test today" caveat that PR B will address.

### Changed — runner: `EXPIRED_FLOW_TIMERS` table extended
- `Oscar_Server/src/worker/runner.js`'s `EXPIRED_FLOW_TIMERS` grows from
  2 → 6 entries. `computeEffectiveRunTimeoutMs` already scans the table
  generically — the new timers plug in without code changes.

### Added — schema + parser plumbing
- `Bruno_Collection/json_validator/datafile.schema.json`: 4 new
  enum/integer pairs (one per new test).
- `Bruno_Collection/library-bruno/scenarioParser.js`: resolves the 4 new
  pairs through a small `_expiredFlowFields` loop (kept DRY); reset list
  updated.

### Docs
- **Tester User Guide §4.8** — 4 new subsections (one per new test) with
  the exact deadline source, gating, and what each test asserts. §7.1
  field-name table updated. Cross-reference to Deviations doc #25 added
  on the exchange-offer subsection.

### Versions
- `Bruno_Collection/VERSION`: `OTST_V2.0.41` → `OTST_V2.0.42`.
- `Oscar_Server/package.json`: `1.11.93` → `1.11.94`.
- `compatibility.json`: new entry `2026.122`.

### Not in this PR — coming in PR B
- **Auto-expansion**: when N>1 timers are armed on one scenario, OSCAR
  will internally run N sub-scenarios. Sub-run naming convention:
  `NHF_<3-letter-code>_<scenario_code>` (with leading `NHF_` stripped
  if the scenario already starts with it). Runner SIGTERM math switches
  from `max` to `sum` of armed timers within the same scenario.

---

## [server-v1.11.93] — 2026-05-28

Generalize the **#204 expired-X negative-test pattern** + ship the **expired-offer**
test on top of the new shared helper.
**Bruno collection bumped (OTST_V2.0.40 → OTST_V2.0.41).**

### Added — Phase 1: shared `expiredFlow.js` library helper
- New `Bruno_Collection/library-bruno/expiredFlow.js` exporting three functions
  that every expired-X test now shares:
  - `planExpiredFlow({ deadlineRaw, maxWaitMinutes, resourceLabel })` →
    `{ armed, waitMs, budgetSource, reason }`. Resolves the deadline, computes
    the wait, checks it fits the run budget (per-scenario Max wait →
    server's `runHardDeadlineMs` → conservative 8-min fallback).
  - `runExpiredFlowWait({ plan, scenarioLabel, deadlineRaw })` — sleeps,
    then **forces an OAuth token refresh** via `refreshAccessTokenIfNeeded`
    so the post-wait request authenticates with a fresh token.
  - `gradeExpiredFlowResponse({ res, scenarioLabel })` →
    `{ status, isClientError, isAuthFailure, hasProblemBody, expiryKeywordFound, body }`.
    Categorises the response (auth / 2xx / expiry keyword / other 4xx / 5xx)
    and emits the appropriate `[INFO]` / `[WARNING]` / `[ERROR]` line.
- `06. POST Obtaining Fulfillments from Booking.yml` refactored to use the
  helper — `~70` lines of inline plan/wait/grade logic replaced with `~20`
  lines that call the helper. **Byte-identical behaviour** (constants and
  budget arithmetic preserved); the existing #204 expired-booking test
  continues to fire the same way.

### Added — Phase 2: expired-offer test (`expiredOfferTest`)
- **New scenario fields** in `datafile.schema.json` and the wizard:
  - `expiredOfferTest` — `off` (default) / `on`.
  - `expiredOfferMaxWaitMinutes` — optional `1..60`, same auto-extension
    semantics as `expiredBookingMaxWaitMinutes`.
- `Bruno_Collection/library-bruno/offers.js` `postOfferResponse` now scans
  the selected offer's `admissionOfferParts` / `reservationOfferParts` /
  `ancillaryOfferParts` and their `fare*` equivalents for the **earliest**
  `OfferPart.validUntil` and stashes it (plus a source label) into env vars.
- `02. POST Create Booking.yml` gains a before-request block that calls
  `planExpiredFlow` + `runExpiredFlowWait` when armed, and an after-response
  block that grades the rejection via `gradeExpiredFlowResponse`, emits
  Bruno `test()` assertions (status 4xx + RFC-9457 Problem body), and
  short-circuits the post-booking happy path — the multi-scenario loop
  continues cleanly to the next scenario via `bru.runner.setNextRequest('01.
  POST Get Offer')` (or `stopExecution()` when done).
- `scenarioParser.js` resolves the new env vars and resets them between
  scenarios; the wizard seeds them on new scenarios; the SonarCloud-friendly
  numeric-input handler (`set-scenario-max-wait-offer-minutes`) mirrors the
  existing booking-timer one.

### Changed — runner auto-extension scans all expired-X timers
- `Oscar_Server/src/worker/runner.js` `computeEffectiveRunTimeoutMs` now
  iterates over a generic `EXPIRED_FLOW_TIMERS` table — currently
  `[expiredBookingTest/expiredBookingMaxWaitMinutes,
  expiredOfferTest/expiredOfferMaxWaitMinutes]`. Any future expired-X
  scenario field plugs in there without touching the scan loop or the
  budget arithmetic. The triggering timer label is preserved in
  `source` for diagnostics; clamp/error log lines were generalised away
  from the booking-specific phrasing.

### Docs
- **Tester User Guide §4.8** — new *Expired-offer test* section with the
  same flow-deadline-budget framing as the booking test, plus an explicit
  "don't combine offer + booking expiry in one scenario" note (the booking
  step fails by design when the offer expiry test is on, so there's no
  booking left to age out). §7.1 field-name table updated.
- **OSDM Spec Deviations** — new entry **#25 *(Theme J, spec-internal naming
  inconsistencies)*** documenting `OfferPart.validUntil` /
  `RefundOffer.validUntil` vs `ExchangeOffer.preBookableUntil` — the
  per-resource-type naming inconsistency that any expired-X generalisation
  has to special-case. Added to the summary table, per-provider
  concentration table, and "Suggested clarifications for OSDM architects"
  list as item 8.

### Tests
- `Oscar_Server/tests/unit/bruno-expiredflow.test.js` — unit-tests
  `planExpiredFlow` (no deadline / bad date / already past / future-in-budget
  / overrun-with-hint / fallback-budget paths), `gradeExpiredFlowResponse`
  (401/403 auth path / 2xx ERROR / 4xx with-and-without expiry keyword and
  Problem body / 5xx WARNING / multi-keyword detection), and
  `runExpiredFlowWait` (token refresh on no-wait path, throw-degrades-to-
  warning fallback).
- `Oscar_Server/tests/unit/runner-effective-timeout.test.js` — three new
  cases for the offer-timer auto-extension: offer-test on with offer Max
  wait, both booking+offer set (largest wins), offer-test off no-op.

### Versions
- `Bruno_Collection/VERSION`: `OTST_V2.0.40` → `OTST_V2.0.41`.
- `Oscar_Server/package.json`: `1.11.92` → `1.11.93`.
- `compatibility.json`: new entry `2026.121`.

---

## [server-v1.11.92] — 2026-05-28

OAuth token watchdog for long-running scenario series — **#204
(belt-and-braces).**
**Bruno collection bumped (OTST_V2.0.39 → OTST_V2.0.40).**

### Added — three layers of token-freshness defence
1. **Server endpoint accepts `?force`.**
   `POST /v1/runs/:runId/refresh-access-token?force=1` forces an OAuth
   round-trip (skip the cache); default (no query) respects the per-tester
   server-side cache. Lets Bruno call us cheaply at scenario start.
2. **`library-bruno/auth.js` gains `refreshAccessTokenIfNeeded()`.**
   Wraps the loopback call + env-var update + error logging. Wired into
   **`01. POST Get Offer`'s before-request** so every scenario starts with
   a fresh-or-cached token (~50ms cache hit). `06. POST Obtaining
   Fulfillments` now uses the shared helper with `force: true` (replaces
   the previous inline `bru.sendRequest`).
3. **`runner.js` background token watchdog.**
   Spawns a `setInterval` ticker (every `TOKEN_WATCHDOG_INTERVAL_MS`, default
   300000 = 5 min) that calls `resolveAccessToken` on the cached token
   **without `forceRefresh`**. The cache's safety-margin check decides
   whether to refetch or no-op — so this is a cheap background guard
   that keeps the cached token fresh enough for the next scenario start.
   Skipped for bearer-mode runs. Operator opt-out: `TOKEN_WATCHDOG_INTERVAL_MS=0`.
   Cleaned up in `proc.on('close'|'error')`.

### Notes
- Why three layers when one might suffice: PR #302 fixed the only
  *currently observed* token-TTL collision (the expired-booking test's
  long wait). This release adds defence-in-depth for the broader class
  the tester raised: *"if we run a long series of scenarios one after the
  other, we could fall in this trap."* In practice the per-scenario
  `resolveAccessToken` call in `runner.js` already handled batches via
  the server-side cache — but layer (2) makes that explicit at scenario
  start, and layer (3) keeps the cache warm under any in-flight run.

---

## [server-v1.11.91] — 2026-05-28

Refresh the OAuth access token after the expired-booking wait — **#204
(token-TTL collision).**
**Bruno collection bumped (OTST_V2.0.38 → OTST_V2.0.39).**

### Fixed
- **#204 — the expired-booking test failed to grade the booking-expiry
  rejection because the OAuth access token issued at run start expired
  during the ~15 min wait on Paxone.** The provider then returned
  `403 "not authenticated"` on the late `POST /fulfillments` — an auth
  failure that masked the booking-expiry semantics the test grades.
  Reported by a tester running `Max wait = 30` against Paxone (deadline
  ~15 min, token TTL ~15 min).
  - New server-side **loopback endpoint**
    `POST /v1/runs/:runId/refresh-access-token` (same loopback gate as
    `/data` — 127.0.0.1 / ::1 + no `X-Forwarded-For`; no session auth).
    Forces a fresh token via
    `resolveAccessToken(userRow, log, { forceRefresh: true })`.
  - `access-token.js` `resolveAccessToken` accepts a `forceRefresh`
    option that skips the cache and refetches.
  - `runner.js` injects `__runId` and `oscar_loopback_base` into the
    Bruno env alongside `runHardDeadlineMs`.
  - `06. POST Obtaining Fulfillments from Booking.yml`: after the wait
    completes, `bru.sendRequest` to the loopback endpoint, then
    `bru.setEnvVar('access_token', …)` with the fresh token. Bruno
    re-templates `Authorization: Bearer {{access_token}}` at
    request-fire time, so the fulfillment uses the fresh token.

### Changed
- Expired-booking after-response **distinguishes 401/403 (auth) from
  4xx + Problem (genuine booking-expiry rejection)**. A 401/403 fires a
  `[WARNING]` saying "this is likely a token problem (refresh failed),
  not a booking-expiry rejection" — so the tester doesn't mis-read an
  auth error as a test pass.

### Added
- `tests/unit/access-token.test.js` — two new cases for `forceRefresh`:
  bypasses a still-valid cache; default (`forceRefresh: false`) preserves
  the existing cache-hit behaviour (back-compat).

---

## [server-v1.11.90] — 2026-05-28

Fix the per-scenario expired-booking timer silently failing because the
runner couldn't read the encrypted datafile — **#204 (regression).**
**Server-only release; no Bruno collection bump.**

### Fixed
- **#204 — the per-scenario `expiredBookingMaxWaitMinutes` timer (shipped
  in 2026.116) silently did not extend the worker SIGTERM.** The helper
  `computeEffectiveRunTimeoutMs` in `runner.js` read the datafile with
  plain `fs.readFile` + `JSON.parse` — but since OSCAR v1.11.0 (Phase 2 of
  issue #60) the datafile on disk is AES-256-GCM encrypted under the
  OSCAR1 envelope. `JSON.parse(ciphertext)` threw, the catch block silently
  swallowed the error, and the helper fell back to base `RUN_TIMEOUT_MS`
  — so every scenario opting into Max wait got SIGTERMed at the 10 min
  default. Reported by a tester: Max wait = 30 on Paxone (deadline ~15 min)
  → run died at exactly 10 min with exit 1 and no transaction reports.
  - The helper now uses `decryptFromFileAsync` (same pattern as the
    `/v1/runs` POST handler in `api/routes/runs.js`), which handles both
    the encrypted form and any legacy plaintext datafiles.

### Changed
- **Always log the effective `RUN_TIMEOUT_MS`** for every run, with `base`
  / `requested` / `hardMax` / `source` / `helperError` fields. Previously
  the diagnostic line only fired when the extension *actually* fired —
  which is exactly when this class of failure can't be diagnosed.
  New log line example:
  ```
  [runner] Effective RUN_TIMEOUT_MS = 1260000ms (1260s); base=600000ms hardMax=1800000ms; source: scenario expiredBookingMaxWaitMinutes (triggered by 'SC_BKTIMEOUT')
  ```
- Helper-error captured (no longer silently swallowed) and surfaced as a
  `warn`-level log line so the operator can tell *why* an expected
  extension didn't fire.

### Added
- **`tests/unit/runner-effective-timeout.test.js`** — regression guard for
  this class. Pins the contract: encrypted+plaintext datafiles both work;
  clamping at `RUN_HARD_MAX_TIMEOUT_MS`; helper-error reporting; sanity
  (extension off when `expiredBookingTest` is off); `scenariosToRun: 'ALL'`
  fan-out; all four truthy forms of `expiredBookingTest` (`true`, `'true'`,
  `'on'`, `'YES'`).

---

## [server-v1.11.89] — 2026-05-28

Collective-booking — tester-facing documentation + wizard hint — **#222
Increment 1.**
**Server-only release; no Bruno collection bump.**

### Changed
- **#222 Inc 1 — clarify what `OfferMode` actually means.** The wizard hint
  on the **Offer Mode** field now spells out the OSDM-defined semantics:
  - `INDIVIDUAL` — each passenger gets their own admission/reservation;
    refund of a single passenger is possible.
  - `COLLECTIVE` — admissions/reservations are shared across the group
    (atomic — can't refund per passenger).
  - The 1-passenger edge case: COLLECTIVE is semantically degenerate; the
    provider may accept, fall back to INDIVIDUAL with a warning (per OSDM
    spec), or reject.
- Tester User Guide **§4.3** expanded with the same content plus the
  spec-mandated provider-fallback behaviour, and a pointer to **#222**
  for the broader test build-out.

### Notes
- **No behaviour change** — OSCAR still only validates that
  `offer.admissions[*].offerMode` is a member of the enum, exactly as
  before. Real assertions (mode fidelity, refund-per-pax restriction,
  `POST /bookings/{id}/split` endpoint behaviour, scenario guardrail
  when COLLECTIVE + 1 pax) are tracked as Increments 2–5 on #222 and
  will land in later releases.

---

## [server-v1.11.88] — 2026-05-28

Per-scenario **Max wait** timer for the expired-booking test — **#204 (tester's
personal choice).**
**Bruno collection bumped (OTST_V2.0.37 → OTST_V2.0.38).**

### Added
- **New optional scenario field `expiredBookingMaxWaitMinutes`** (integer 1–60)
  surfaced in the wizard next to the **Expired‑booking test** dropdown.
  When set AND `expiredBookingTest` is `on`, OSCAR:
  - uses **this** as the wait budget for the scenario (instead of the
    server-wide `RUN_TIMEOUT_MS`); and
  - the runner **auto-extends the worker's SIGTERM** to cover the wait —
    so the tester does **not** need to also raise `RUN_TIMEOUT_MS` on the
    server. Clamped to a new server-side ceiling
    `RUN_HARD_MAX_TIMEOUT_MS` (default 30 min).
  Typical use: Bileto / Paxone deadlines are ~15 min → set `20` and re-run.
- New env var **`RUN_HARD_MAX_TIMEOUT_MS`** documented in `.env.example`.

### Notes
- The same effective timeout drives **both** the `runHardDeadlineMs` env
  injection AND the SIGTERM `setTimeout` in `runner.js` — they must agree
  or 06.yml's pre-sleep budget check disagrees with reality. The new
  `computeEffectiveRunTimeoutMs` helper computes the value once and feeds
  it to both sites.
- The 06.yml SKIP message now says **which budget source was used**
  (per-scenario timer vs `RUN_TIMEOUT_MS` vs the conservative 8-min
  fallback) and the suggested fix is phrased per-source ("raise the
  scenario's Max wait" vs "raise RUN_TIMEOUT_MS").

---

## [server-v1.11.87] — 2026-05-28

Expired-booking deadline — bookingPart-level fallback for providers that
don't set the deadline at the booking root — **#204 (third follow-up).**
**Bruno collection bumped (OTST_V2.0.36 → OTST_V2.0.37).**

### Fixed
- **#204 — the expired-booking test silently no-op'd against a provider
  (e.g. Paxone sandbox) that reports `confirmableUntil` ONLY on the
  individual bookingParts (admissions / reservations / ancillaries), not
  at the booking root.** This is in fact OSDM's own schema placement
  for the field — but the previous two follow-ups (2026.112, 2026.114)
  only read the root-level fields, so the env var was never set and
  06.yml fired `POST /fulfillments` immediately. `bookings.js`
  `postCreateBookingResponse` now resolves the booking deadline in this
  order:
  1. `booking.confirmationTimeLimit` (OSDM-standard at booking root)
  2. `booking.confirmableUntil` (Bileto-style at booking root)
  3. **earliest** `bookedOffers[].{admissions|reservations|ancillaries}[].confirmableUntil`
     (Paxone-style — bookingPart level, OSDM schema's own placement)
  Each non-standard source emits a `[WARNING]` documenting which shape
  was used. 06.yml header comment + Tester User Guide §4.8 / §7.1
  updated.

### Notes
- **Operator action for long deadlines (unchanged from 2026.112).**
  Paxone's deadline is ~15 min after creation — same as Bileto. With the
  default `RUN_TIMEOUT_MS` of 10 min, the test self-skips with the
  budget `[WARNING]` (by design: the runner injects `runHardDeadlineMs`
  to avoid SIGTERM mid-wait). **Raise `RUN_TIMEOUT_MS` to ≥ ~1200 s
  (20 min)** on the server before re-running `expiredBookingTest: on`
  against either sandbox.

---

## [server-v1.11.86] — 2026-05-28

Regression guards for the #287 stray-`</script>` class — **#291 and #292.**
**Server-only release; no Bruno collection bump.**

### Added
- **#292 — `Oscar_Server/scripts/lint-inline-scripts.js`**, wired into the
  existing `lint` npm script (and therefore the CI Lint/audit/test job).
  Walks every `Oscar_Server/public/*.html` with the HTML5 *script-data state*
  rules, compares the raw `</script>` count to the count of blocks the walker
  actually paired up, and **fails the build** if there's a stray — naming
  the offending file + line and suggesting `<\/script>` as the escape.
  Deterministic, zero new dependencies, runs in milliseconds.
- **#291 — `Oscar_Server/tests/unit/dashboard-pages.test.js`**, a Jest test
  using the same walker logic. For every public HTML page it asserts every
  `<script>` is properly closed and that no stray `</script>` exists inside
  inline blocks. For `run-detail.html` specifically it asserts the outer
  inline block's parser-visible content reaches its **tail marker**
  (`poll();`) — a direct regression guard for #287 that would have failed
  loudly when the broken page was committed.

### Notes
- **Scope choice:** #291 originally proposed Playwright for a real-browser
  smoke test. This implementation deliberately avoids adding
  `@playwright/test` and its browser binaries — and avoids re-resolving
  `package-lock.json` — because the deterministic walker already catches the
  exact regression class at **zero dep cost**. A real-browser smoke test
  can be added as a separate scope if richer DOM-execution coverage is
  wanted later.

---

## [server-v1.11.85] — 2026-05-28

HOTFIX — run-detail page broken by stray `</script>` inside the JSON-viewer
template literal — **#287 (follow-up).**
**Server-only release; no Bruno collection bump.**

### Fixed
- **The run-detail page was unrenderable on releases 2026.111 and 2026.112.**
  `run-detail.html`'s inline `<script>` block contained a literal `</script>`
  substring inside the `renderMessage` template literal that emits the inline
  JSON payload envelope for the Tree viewer. HTML parsers terminate a script
  element at any `</script>` regardless of JS string context, so the outer
  inline script ended early there and the rest of the JS source bled out as
  visible page text — the broken view a tester reported. Every literal
  `</script` inside the inline block (the template, plus three comments)
  now spells `<\/script` instead — JS reads `\/` as `/`, so the emitted HTML
  and resulting DOM are correct, while the HTML parser does not see `</` and
  keeps the outer script open. **Hard-refresh the dashboard** (Ctrl+Shift+R)
  once Watchtower restarts so the cached broken HTML is replaced.

---

## [server-v1.11.84] — 2026-05-28

Expired-booking deadline field-name fallback — **#204 (follow-up).**
**Bruno collection bumped (OTST_V2.0.35 → OTST_V2.0.36).**

### Fixed
- **#204 — the expired-booking test silently no-op'd against a provider that
  exposes the booking-level deadline as `confirmableUntil` instead of the
  OSDM-standard `confirmationTimeLimit`** (e.g. the Bileto sandbox). `bookings.js`
  only read `booking.confirmationTimeLimit`, so the env var the wait logic
  consumes was never set, and the test took the "no deadline found" `[WARNING]`
  branch and went straight to `POST /fulfillments` without waiting. The booking
  validator now reads **either** field (with `confirmationTimeLimit` taking
  precedence). When the fallback fires it emits a `[WARNING]` so the vendor
  deviation is **visible in the report** — OSDM defines `confirmableUntil` at
  the bookingPart level, with an explicit note saying `confirmationTimeLimit`
  is the booking-level field.

### Notes
- **Operator action for long deadlines.** The Bileto sandbox's confirmation
  deadline is ~15 min. With the default `RUN_TIMEOUT_MS` of 10 min, the test
  still self-skips with the budget `[WARNING]` ("raise `RUN_TIMEOUT_MS`
  to >= ~N s") — that part is by design. **Raise `RUN_TIMEOUT_MS` to ≥ ~1100 s
  (~18 min) on the server before re-running** `expiredBookingTest: on`.
- Tester User Guide §4.8 + §7.1 updated to name both deadline fields.

---

## [server-v1.11.83] — 2026-05-28

Structured JSON tree view in the run-detail HTTP Traffic panel — **#287.**
**Server-only release; no Bruno collection bump.**

### Added
- **#287 — opt-in Tree view for request/response bodies.** Each body card in the
  **HTTP Traffic** section now offers a **`[Raw | Tree]`** toggle in its header.
  - **Raw is the default** (no behaviour change for users who don't opt in).
  - Clicking **Tree** lazy-loads `vanilla-jsoneditor` v3.x (ISC license) from
    `/vendor/vanilla-jsoneditor/standalone.js` and mounts a **read-only,
    collapsible tree** with built-in key/value search — a direct PB-determination
    aid for deeply nested OSDM responses (offers, bookings, RFC-9457 Problems).
  - **Guards:** a body that isn't valid JSON or is **> 2 MB** shows the toggle
    **disabled** with a tooltip explaining why (Raw still works). If the bundle
    fails to load or mount, the failure is logged and Raw stays in place.

### Notes
- The standalone bundle is **vendored** at
  `Oscar_Server/public/vendor/vanilla-jsoneditor/standalone.js` (pinned to
  upstream **3.12.0**, ISC) — served by the existing `express.static(PUBLIC_DIR)`,
  so CSP stays **`script-src 'self' 'unsafe-inline'`** (no policy change, no
  `node_modules` mount, no `package-lock` churn for a purely front-end asset).
  The ~1.26 MB bundle (~300 KB gzipped) is fetched **only** when a tester clicks
  **Tree** for the first time, then cached. Upgrade procedure is documented in
  `Oscar_Server/public/vendor/vanilla-jsoneditor/NOTICE.md`.

---

## [server-v1.11.82] — 2026-05-27

OSDM v3.8 `FulfillmentDocument` cross-reference integrity — **#253.**
**Bruno collection bumped (OTST_V2.0.34 → OTST_V2.0.35).**

### Added
- **#253 — `fulfillmentDocumentRefs` ↔ sibling `fulfillmentDocuments[].id` integrity
  check.** OSDM v3.8 moves `FulfillmentDocument` from a nested
  `fulfillment.fulfillmentDocuments[]` to a **sibling**
  `FulfillmentResponse.fulfillmentDocuments[]` / `Booking.fulfillmentDocuments[]`,
  with `fulfillments[].fulfillmentDocumentRefs[]` pointing at the sibling
  `.id`. `validateFulfillments()` now accepts the sibling array and asserts
  **each `fulfillmentDocumentRef` resolves to a sibling `fulfillmentDocuments[].id`** —
  an unresolved ref (or refs present with no sibling array at all) **FAILs** with a
  clear diagnostic listing the unresolved ref(s) and the available sibling ids.
  Wired through every caller: `postCreateBookingResponse` (passes
  `booking.fulfillmentDocuments`), `06. POST … Fulfillments` + `04-Exchange/14. POST … Fulfillments`
  (FulfillmentResponse-level `jsonData.fulfillmentDocuments`), `exchanges.js`,
  `refunds.js` (`exchangeOffer.fulfillmentDocuments` / `refundOffer.fulfillmentDocuments`).

### Notes
- **Backwards-compatible.** When the sibling array is not supplied — legacy
  callers, or pre-v3.8 providers that still use the deprecated nested
  `fulfillment.fulfillmentDocuments[]` form — the new cross-ref check is
  **SKIPPED** with an informational log. The existing happy path is unchanged.

---

## [server-v1.11.81] — 2026-05-27

Data-file robustness — **#210 (pt. 3).**
**Bruno collection bumped (OTST_V2.0.33 → OTST_V2.0.34).**

### Fixed
- **#210 pt.3 — a minimal/hand-authored data file that omitted `startDatetime` or
  `endDatetime` in a `tripRequirement` crashed the parser** with an opaque
  `TypeError: Cannot read properties of undefined (reading 'replace')`. The
  `%TRIP_DATE%` substitution in `scenarioParser.js` now runs through a guard
  (`subTripDate`) that throws a **clear, actionable message** naming the missing
  field and the trip context (`SEARCH` / `SPECIFICATION` leg N) and pointing to the
  Test Config UI. Data files generated by the Test Config UI always include both
  datetimes, so they are **unaffected** (no behaviour change for them).

### Notes
- Audit of the rest of #210 (all confirmed resolved before this fix): **(1)** configurable
  logging level via the `loggingType` scenario field (`FULL`/`INFO`/`DEBUG`/`ERROR`);
  **(4)** the data-file `passenger.reference` is now consumed as the OSDM `externalRef`
  in offer/booking requests (no longer ignored); **(5)** empty trip filters are no longer
  emitted — `carrierFilter`/`vehicleFilter`/`dataFilter` are built only when a value
  exists. **(2)** the `reference` vs `externalRef` naming is intentionally kept (renaming
  the schema field would break existing data files; the Test Config UI hides the field
  name from authors).

---

## [server-v1.11.80] — 2026-05-27

Expired-booking negative test — **#204 (OTST_TI_EXPIRED_BOOKING).**
**Bruno collection bumped (OTST_V2.0.32 → OTST_V2.0.33).**

### Added
- **#204 — a scenario can now request that OSCAR wait until *after* the booking's
  confirmation deadline before it tries to fulfill, and assert the provider correctly
  refuses the late confirmation.** A new scenario field **`expiredBookingTest`** (`off`
  default / `on`) drives the flow. When `on`, after the booking is created OSCAR reads
  `booking.confirmationTimeLimit`, waits until **15 s past** that deadline, then issues
  `POST /fulfillments` and asserts the provider **REJECTS it** with a `4xx` + an
  RFC-9457 `Problem` (hard **FAIL** if the booking is fulfilled after expiry). It then
  `GET /bookings/{id}` and asserts the admissions/reservations (or the booking itself)
  are **EXPIRED / RELEASED / CANCELLED**. A `404` on the follow-up GET is accepted as a
  legitimate purge.
- **Run-budget guard.** Because the wait can exceed the worker's `RUN_TIMEOUT_MS`
  (default 10 min), the runner now injects a read-only `runHardDeadlineMs` env var
  (`Date.now() + RUN_TIMEOUT_MS`) so the test can tell, *before sleeping*, whether the
  wait would blow the run budget. If it would, the test is **skipped with a `[WARNING]`**
  (advising to raise `RUN_TIMEOUT_MS`) instead of letting the worker SIGTERM mid-run.

### Notes
- New scenario field surfaced in the wizard (`public/js/scenarios.js`) and the datafile
  schema (`json_validator/datafile.schema.json`); `scenarioParser.js` accepts
  `true`/`"true"`/`"on"`/`"yes"` and resets the per-run state between scenarios.

---

## [server-v1.11.79] — 2026-05-27

Fulfillment documents: recognise the OSDM `content` field — **#202.**
**Bruno collection bumped (OTST_V2.0.31 → OTST_V2.0.32).**

### Fixed
- **#202 — a spec-conformant fulfillment document delivered inline via OSDM `content`
  was wrongly FAILED.** The check (`bookings.js` `validateFulfillments`) accepted only
  `downloadLink` OR the non-standard `rawData` — but OSDM's `FulfillmentDocument` defines
  the inline payload as **`content`** (base64), which is the field #202 names. It now
  accepts **`content` (OSDM) OR `downloadLink` (OSDM) OR `rawData` (vendor extension)**,
  and the report states **exactly which field delivered the payload and whether it is
  OSDM-standard or a vendor extension**. A document carried only by `rawData` is accepted
  but flagged with a `[WARNING]` (retrievable, but not OSDM-conformant).

### Added
- **DB migration smoke test** (`tests/unit/db-migrations.test.js`, #208 / #221 rec #2) —
  runs the real `schema.sql` + versioned migrations against throwaway temp DBs and asserts
  (1) a fresh install produces every column the runtime depends on, and (2) a column
  missing on an already-versioned DB is restored by a new migration. Guards the exact #208
  regression class (a required column buried in an already-applied migration) that the
  mocked-DB unit tests could not catch. Test-only.

---

## [server-v1.11.78] — 2026-05-27

Newcomer-readability pass over `library-bruno` — **#216 / #221.**
**Bruno collection bumped (OTST_V2.0.30 → OTST_V2.0.31). Comments only — no behaviour change.**

### Changed
- **Added a concise file-objective header** (what the module does + where it sits in the
  offer → booking → fulfillment flow) to the 12 modules that lacked one: `offers.js`,
  `bookings.js`, `fulfillments.js`, `passengers.js`, `refunds.js`, `exchanges.js`,
  `displays.js`, `requestsBuilder.js`, `scenarioParser.js`, `validators.js`, `model.js`,
  `schema.js`, `reportGenerator.js` — so a new contributor can grasp each module's purpose
  at a glance (addresses the audit gap on #216).
- **Removed** the dead, empty, unreferenced `library-bruno/swagger.js` (the Swagger schema
  logic lives in `validators.js`).

### Notes
- Comments/headers + one dead-file removal only; **zero runtime change.**

---

## [server-v1.11.77] — 2026-05-27

Passenger negative-probe **sweep** (companion to the purchaser sweep) — **#258.**
**Bruno collection bumped (OTST_V2.0.29 → OTST_V2.0.30).**

### Added
- **`requestedInformationProbe = invalid` now sweeps each passenger field** on passenger 0,
  one at a time, within a single run (`03. PATCH Multi Passenger`): a valid baseline for
  every field with exactly **one corrupted per pass**, graded on its own line
  (`[passenger0.<field>]`), then it loops back to PATCH for the next field and stops after
  the last:
  - `gender` → `ZZZ` (enum) → **FAIL** if not rejected
  - `dateOfBirth` → `not-a-date` (format) → **FAIL** if not rejected
  - `email` → `not-an-email`, `phoneNumber` → `not-a-phone` (unconstrained strings) → **WARN** if accepted
  - `firstName` / `lastName` → omitted (required in `PersonDetail`) → **FAIL** if not rejected

### Notes
- **Operator action required: none.** Strictly gated to `requestedInformationProbe = invalid`;
  `off` / `omit` / happy paths are byte-identical.
- ⚠️ **Built without live-flow validation** (it touches the core passenger PATCH step) —
  validate against a sandbox before relying on it.

---

## [server-v1.11.76] — 2026-05-27

Purchaser negative-probe **sweep** — test every parameter one-by-one in a single run — **#258.**
**Bruno collection bumped (OTST_V2.0.28 → OTST_V2.0.29).**

### Added
- **`bookingPurchaserMode = invalid` now sweeps each purchaser field** (`firstName`,
  `lastName`, `email`, `phoneNumber`) **one at a time within a single run** — no more
  one-scenario-per-parameter. Each pass corrupts exactly one field (the rest valid),
  the write step grades it on its own line, then the flow loops back to
  `12. GET Booking Purchaser` for the next field (re-using the GET-adaptive
  create-or-update each pass, so it stays robust to rejections):
  - `email` / `phoneNumber` → an **invalid value** (unconstrained string → **WARN** if accepted)
  - `firstName` / `lastName` → **omitted** (required in `PersonDetail` → **FAIL** if not rejected)
- `validateProblemResponse()` gains an optional `label` so each swept field is a
  distinct assertion in the report (e.g. `… [purchaser.email] …`).

### Notes
- **Operator action required: none.** Only affects `bookingPurchaserMode = invalid`.
- Passenger-field sweep (per-passenger × per-field) can follow as a separate increment.

---

## [server-v1.11.75] — 2026-05-27

Provider-fair grading of the `requestedInformation` negative probe — **#258.**
**Bruno collection bumped (OTST_V2.0.27 → OTST_V2.0.28).**

### Changed
- **`validateProblemResponse()` now FAILs "provider must reject" only when a rejection
  is genuinely *required*:**
  - a demanded field is **missing** (`omit` probe — the spec needs it populated to proceed), or
  - an **OSDM-constrained** field is violated — `gender` (enum `[MALE, FEMALE, X]`) or
    `dateOfBirth` (`format: date`).
- For a malformed value in an **unconstrained string** field (`firstName` / `lastName` /
  `email` / `phoneNumber` — bare `type: string` in the spec, no pattern/format), a
  non-rejection is now a **WARNING**, not a FAIL — a provider that accepts it is still
  OSDM-conformant (semantic validation is recommended, not required).
- N2 (RFC-9457 `Problem` shape) and N3 (field pointer) are graded only when an error body
  is actually returned, and follow the same hard/soft severity.

### Notes
- **Operator action required: none.** Only changes report *severity* for negative-probe
  (`requestedInformationProbe` / `bookingPurchaserMode = invalid`) scenarios; happy-flow
  runs are unaffected.

---

## [server-v1.11.74] — 2026-05-27

`bookingPurchaserMode=invalid` now actually sends an invalid purchaser — **#258 / #203.**
**Bruno collection bumped (OTST_V2.0.26 → OTST_V2.0.27).**

### Fixed
- **The `invalid` purchaser probe was sending VALID data.**
  `requestsBuilder.buildBookingPurchaserBody()` forced a bad email only when the
  email was *empty* (`!body.detail.contact.email`), so a scenario whose purchaser
  already had a valid email (the normal case) passed straight through unchanged —
  the negative test never exercised the provider's validation. `invalid` mode now
  **overwrites** the email with `not-an-email`, so the PATCH/POST purchaser body is
  guaranteed invalid and the provider must reject with an RFC-9457 `Problem`
  (graded by `validateProblemResponse`).

### Notes
- **Operator action required: none.** Only affects `bookingPurchaserMode = invalid`.

---

## [server-v1.11.73] — 2026-05-27

Purchaser **create-or-update (upsert)** — probe first, then PATCH or POST — **#258 / #203.**
**Bruno collection bumped (OTST_V2.0.25 → OTST_V2.0.26).**

### Changed
- **The deferred-purchaser flow no longer guesses POST vs PATCH.** It now probes
  first with a new **`12. GET Booking Purchaser`** step (`getBookingPurchaser`):
  - **2xx** → a purchaser already exists → **`13. PATCH Booking Purchaser`** (update)
  - **404 / none** → no purchaser → **`14. POST Booking Purchaser`** (create)

  This works on both provider styles without hardcoding a method — those that
  materialise an empty purchaser on the booking (PATCH; e.g. **Bileto**) and those
  that don't (POST). Shared body assembly moved to
  `requestsBuilder.buildBookingPurchaserBody()`; `04. GET Passenger` routes to the
  GET probe; the smart-run filter gates each step so a write step runs only for the
  method the probe selected.

### Notes
- **Operator action required: none.** Only affects `bookingPurchaserMode = deferred`/
  `invalid`; the default `inline` is unchanged.

---

## [server-v1.11.72] — 2026-05-27

Deferred-purchaser step uses **PATCH** instead of POST — **#258 / #203.**
**Bruno collection bumped (OTST_V2.0.24 → OTST_V2.0.25).**

### Changed
- **`12. POST Booking Purchaser` → `12. PATCH Booking Purchaser`** (method `POST` →
  `PATCH`, `patchBookingPurchaser`). For a booking created without a purchaser,
  POST-*create* is the OSDM-canonical call, but providers that already materialise
  an (empty) purchaser on the booking (e.g. **Bileto**) return **500** on a
  POST-create because the resource already exists. PATCH-*update* is the call that
  works there. `04. GET Passenger` routes to the new step name; the body assembly
  is unchanged.

### Notes
- **Operator action required: none.** Only affects scenarios with
  `bookingPurchaserMode = deferred`/`invalid`; the default `inline` is unchanged.

---

## [server-v1.11.71] — 2026-05-27

**CRITICAL regression fix** — valid OAuth credentials failed on every run (**#208**).
**Server-only; Bruno collection unchanged (OTST_V2.0.24).**

### Fixed
- **OAuth runs no longer fail with a missing-column error.** The 2026.97 fix added
  `users.cached_token_cred_fp`, but the `ALTER TABLE` was placed inside the
  **already-applied v12 migration**. The version-gated migration runner skips
  applied migrations (`if (m.version <= current) continue`), so the column was
  **never created on existing databases**. `resolveAccessToken()` then persisted
  the token cache with `UPDATE users SET … cached_token_cred_fp = ?`, which threw
  `no such column: cached_token_cred_fp` and **failed every `oauth2` run — including
  valid, unchanged credentials** (e.g. Bileto).
  - **New migration v20** (`users-cached-token-cred-fp`) adds the column on
    existing DBs (idempotent; `companies` too for schema parity with `schema.sql`).
  - **`access-token.js` cache persistence is now best-effort** — a token we just
    fetched is returned even if the cache write fails, so a DB-bookkeeping error
    can never fail an otherwise-valid auth.
  - Regression test added: caching throws → the freshly-fetched token is still returned.

### Notes
- **Operator action required: none.** The migration runs automatically on boot; the
  first `oauth2` run per tester re-fetches once and re-populates the cache.

---

## [server-v1.11.70] — 2026-05-27

Purchaser-aware `requestedInformation` + a purchaser-on-booking step — **#258, #203.**
**Bruno collection bumped (OTST_V2.0.23 → OTST_V2.0.24).**

### Added
- **Root-aware `requestedInformation` engine** (`library-bruno/requestedInformation.js`).
  A leaf's *root* now decides its subject: `passengerSpecifications[i]` (an indexed
  passenger — unchanged) or `purchaser[…]` (the **single** purchaser object, index
  ignored). Each kind has its own evaluation subject, report label (`the purchaser`)
  and auto-feed/probe channel. New helpers `buildPurchaserModelFromAdditionalData`,
  `applyPurchaserAutoFeed`, `rootKind`, and `staticIssues.unknownRoots`. Passenger
  behaviour and all existing engine tests are unchanged; purchaser-channel unit
  tests added.
- **`bookingPurchaserMode` scenario field** (`inline` | `deferred` | `omit` |
  `invalid`) — authored in the scenario detail panel, documented in
  `datafile.schema.json`. Controls where the purchaser is supplied:
  - `inline` *(default)* — purchaser sent in the `POST /bookings` request (historic behaviour).
  - `deferred` — omitted at booking, then **`POST /bookings/{id}/purchaser`** to satisfy
    any purchaser `requestedInformation` (the OSDM-correct way to exercise a provider
    that requests purchaser data).
  - `omit` — never supplied (observe the provider's demand / rejection).
  - `invalid` — POST a deliberately bad purchaser and assert an RFC-9457 `Problem`.
- **New Bruno step `12. POST Booking Purchaser`** (`postBookingPurchaser`), gated in the
  smart-run filter and routed from `04. GET Passenger` before fulfillment — **closes #203**
  (purchaser endpoints exercised). Fully inert when `inline`/`omit`.

### Notes
- OSDM `BookingRequest.required = [offers, passengerSpecifications]` — `purchaser` is
  optional, and the spec points to `requestedInformation` as the mechanism to request it.
- **Operator action required: none.** New scenarios default to `bookingPurchaserMode=inline`,
  so existing scenarios behave exactly as before.

---

## [server-v1.11.69] — 2026-05-27

Invalidate the OAuth token cache on credential change — **#208 (root cause).**
**Server‑only; Bruno collection unchanged (OTST_V2.0.23).**

### Fixed
- **Changing credentials now actually re‑fetches the token** (`worker/access-token.js`).
  Root cause of "invalid credentials still ran all test cases": the per‑tester
  token cache (`cached_token_enc`) was reused while still time‑valid **regardless
  of whether the credentials had changed**, so switching to invalid creds within
  the token's lifetime silently reused the previous valid token and never
  exercised them (the token is fetched server‑side before Bruno, so it never
  shows in the report; `fetchToken` *does* throw on a real 401 — only the cache
  could have returned a token). Now a **SHA‑256 fingerprint** of the credentials
  (`profile`+`token_url`+`client_id`+`client_secret`+`scope`+`extra`; the secret
  is hashed one‑way, never stored) is saved with the cached token
  (new `users.cached_token_cred_fp` column + migration) and the cache is reused
  **only when the fingerprint matches**. A credential change forces a re‑fetch →
  invalid credentials now throw → the run is marked **FAILED before Bruno** with
  `[runner] Auth failed: HTTP 401 …` in the Execution Log and **no scenarios run**.
  Existing rows have a NULL fingerprint → one safe re‑fetch on the first run after
  deploy.

---

## [server-v1.11.68] — 2026-05-27

Auth-rejection fail-fast (mid-flow) — **#208 follow-up**. Bruno collection change
(OTST_V2.0.22 → OTST_V2.0.23); server in lockstep (1.11.67 → 1.11.68).

### Fixed
- **A 401/403 now stops the run with a clear message instead of cascading.** The
  2026.95 fix covered the OAuth *token-acquisition* failure, but a **bearer/static
  token that is present yet expired/revoked** can't be detected up-front (the
  server only decrypts it — it can't know it's dead without calling the provider),
  so the run used to proceed and every request 401/403'd. New
  `library-bruno/auth.js` `checkAuthRejection(res, reqName)` is called from the
  collection-level after-response (`opencollection.yml`) for **every** request: on
  the first 401/403 from a non-token request it logs a clear `[ERROR]`
  (*"access/bearer token invalid or expired — update it in Profile → API
  Configuration"*), records a **FAILING** "Authentication accepted" assertion, and
  `bru.runner.stopExecution()`. Keyed strictly on **401/403** (a rejected
  credential) — 404/400 (wrong endpoint / bad request) and the token request
  itself are left alone; the failing request is still recorded in the report.

---

## [server-v1.11.67] — 2026-05-27

Clear, fail-fast diagnostic for invalid auth credentials — **#208**. Bruno
collection change (OTST_V2.0.21 → OTST_V2.0.22); server in lockstep
(1.11.66 → 1.11.67).

### Fixed
- **Invalid OAuth credentials now stop the run with a self-explanatory message**
  instead of cascading into misleading 4xx errors. Each vendor *Access Token*
  request previously only `console.error`'d when no `access_token` came back — no
  assertion, no stop — so a bad `client_id`/`client_secret` let every downstream
  request fail confusingly (and the success path logged the token value, a leak).
- New **`library-bruno/auth.js`** `handleAccessTokenResponse(res, { vendor })`,
  called by all six `00-Access Token` requests (Benerail / Bileto / Chaps /
  Paxone / Sqills / Turnit):
  - **success** → store `access_token`, record a passing assertion, **never log
    the token value**;
  - **failure** (non-2xx or no token; tries `access_token` / `accessToken` /
    `token`) → emit a clear `[ERROR]` naming the likely cause (OAuth
    `client_id`/`client_secret`/`scope`/token URL), surface the provider's
    `error`/`error_description`, record a **FAILING** "access token acquired"
    assertion, clear any stale token, and **`bru.runner.stopExecution()`** so the
    cascade never happens.
- Token request HTTP definitions (endpoints / grant types / bodies) are unchanged.

---

## [server-v1.11.66] — 2026-05-27

Two offer/booking conformance checks — **#250 + #251**. Bruno collection change
(OTST_V2.0.20 → OTST_V2.0.21); server in lockstep (1.11.65 → 1.11.66).

### Added
- **#250 — the booking must embed its fulfillments after fulfillment.** After
  `POST /bookings/{id}/fulfillments`, the subsequent `GET /bookings/{id}` must
  contain the generated fulfillments (the provider has to keep the booking object
  updated). `library-bruno/bookings.js` (`validateFulfillments` /
  `postCreateBookingResponse`) gains a `requireFulfillments` flag; the
  **`07. GET Booking after Fulfillments`** step passes it `true`, so an empty
  `booking.fulfillments` after fulfillment now **fails** instead of silently
  passing. Pre-fulfillment / other callers stay lenient (unchanged).
- **#251 — offer→trip link.** `tripCoverage` is optional on an offer part, but
  when present OSDM requires `coveredTripId` (`TripCoverage.required=[coveredTripId]`).
  `offers.js` `validateOfferParts` now **asserts** `tripCoverage.coveredTripId` is
  a non-empty string when `tripCoverage` is present, and **WARNs** (does not fail)
  when the offer has no `tripCoverage` at all — clients then derive the link from
  `offerParts`; the spec recommends returning `coveredTripId` at offer level.

---

## [server-v1.11.65] — 2026-05-27

Fulfillment document payload — **#254**. Bruno collection change
(OTST_V2.0.19 → OTST_V2.0.20); server in lockstep (1.11.64 → 1.11.65).

### Fixed
- **A fulfillment document may carry its payload as `downloadLink` *or* `rawData`**
  (`library-bruno/bookings.js`, `validateFulfillments`). The check hard-required
  `doc.downloadLink` to be a non-empty string, which **false-failed** valid
  documents that return inline `rawData` instead of a link (common for fare /
  e-ticket providers). It now requires **at least one** of `downloadLink` /
  `rawData` to be present (the `medium` / `type` / `format` checks are unchanged),
  and logs which one was returned.

---

## [server-v1.11.64] — 2026-05-27

Flexibility-based offer selection without `offerSummary` — **#223**. Bruno
collection change (OTST_V2.0.18 → OTST_V2.0.19); server in lockstep
(1.11.63 → 1.11.64).

### Fixed
- **Offer selection by flexibility no longer requires the optional `offerSummary`**
  (`library-bruno/offers.js`). Previously `selectAndSetOffer` filtered/asserted
  only on `offerSummary.overallFlexibility`, so a provider that omits it (it is
  OPTIONAL in OSDM) had **every** offer dropped → silent fallback to `offers[0]`
  with a **failing** flexibility assertion. New `offerFlexibility(offer)` returns
  `offerSummary.overallFlexibility` when present, else derives it from the offer's
  products. A clear `[INFO]` line states when the value was derived from products.
- **Correct aggregation for multi-leg offers — most restrictive wins**
  (`NON_FLEXIBLE > SEMI_FLEXIBLE > FULL_FLEXIBLE`). A journey is only as flexible
  as its least-flexible leg, e.g. **TGV `FULL_FLEXIBLE` + TER `NON_FLEXIBLE` →
  `NON_FLEXIBLE`**. The previous `validateOfferParts` consistency check used a
  *most‑flexible‑wins* heuristic that mis‑classified such offers; it now uses the
  same most‑restrictive derivation and is skipped (logged) rather than hard‑failing
  when `offerSummary` is absent. Unknown/vendor flexibility values are ignored.
- Tests: `tests/unit/bruno-offer-flexibility.test.js`.

---

## [server-v1.11.63] — 2026-05-27

OSDM `requestedInformation` — **#258 Phase 3c-2**: scenario-authoring control for
the negative probe. **Server-only; Bruno collection unchanged (OTST_V2.0.18).**

### Added
- **`RequestedInfo Probe` dropdown** in scenario authoring (`public/js/scenarios.js`):
  `requestedInformationProbe` = off (default) / omit / invalid, with an explanatory
  hint. Auto-persists through the existing `set-scenario` handler and is initialised
  to `null` on wizard-generated scenarios. The probe's behaviour + datafile schema
  shipped in 2026.90; this only makes it selectable in the UI instead of hand-editing
  the data file. No behaviour change for scenarios that leave it off.

---

## [server-v1.11.62] — 2026-05-27

OSDM `requestedInformation` — **#258 Phase 3c**: negative-flow probe + error-quality
assertions. Bruno collection change (OTST_V2.0.17 → OTST_V2.0.18); server in
lockstep (1.11.61 → 1.11.62).

### Added
- **Negative-flow probe** — a per-scenario `requestedInformationProbe` =
  `off` (default) | `omit` | `invalid` (`datafile.schema.json` + `scenarioParser.js`).
  With `omit`/`invalid`, OSCAR deliberately **withholds** or sets **invalid** values
  for the fields a provider demanded (instead of auto-feeding), so the gated step is
  submitted with bad data — then asserts the provider rejects it.
- **`Problem` (RFC 9457) validator** (`validateProblemResponse`) grading the
  rejection — **N1** client-error 4xx *(FAIL)*, **N2** Problem shape with
  `title`/`detail`/`code` *(FAIL)*, **N3** error identifies the offending field via
  `Problem.pointers` or `detail` text *(WARN)*, **N4** non-empty message.
- The **PATCH Multi Passenger** step is now probe-aware: when a probe is active and a
  field was actually withheld/corrupted it grades the rejection and stops the chain.
  **When the probe is off (default for every existing scenario) the happy path is
  byte-identical.**
- `processRequestedInformation` now takes a `mode` (`autofeed`/`omit`/`invalid`; the
  legacy `autoFeedOn` boolean is still honoured) and returns `probeTargets`; new
  `invalidValueForField` helper. Jest suite extended (invalid values, probe modes,
  Problem validator incl. `pointers`).

The scenario-authoring UI dropdown for the probe follows in a small **3c-2** PR; the
field can be set directly in the data file today (documented in the schema).

---

## [server-v1.11.61] — 2026-05-27

OSDM `requestedInformation` — **#258 Phase 3a + 3b**: auto-feed + static
conformance assertions. Bruno collection change (OTST_V2.0.16 → OTST_V2.0.17);
server in lockstep (1.11.60 → 1.11.61).

### Added
- **Auto-feed (default on).** When a provider's `requestedInformation` demands a
  field the scenario hasn't set, OSCAR now **auto-provides a valid value** so the
  happy flow completes unattended, and **documents in the report** exactly what
  it provided (field, passenger, value) and at which step. Values are filled into
  `passengerAdditionalData` (the *PATCH Multi Passenger* body) and
  `skipPatchPassengerRequest` is re-enabled so they are actually sent. Gender uses
  the OSDM enum (`MALE`/`FEMALE`/`X`); `dateOfBirth` is passenger-type-aware;
  tester-provided values are never overwritten. Fields OSCAR cannot author
  (e.g. `taxId`) are WARNed, not invented.
- **Static conformance assertions** on every `requestedInformation`
  (`library-bruno/requestedInformation.js`, wired into `offers.js` and
  `bookings.js`): **S1** type (`string` ≤ 32768), **S2** parses against the OSDM
  grammar *(FAIL)*, **S4** numeric passenger index in range *(FAIL)*, **S3** WARN
  on attributes OSCAR does not recognise.
- **P2 check:** a `[WARNING]` is raised if a booking re-requests a field OSCAR
  already provided (`requestedInformation` should shrink as data is supplied).
- New pure helpers (`staticIssues`, `sampleValueForField`, `applyAutoFeed`) plus
  a dependency-injected orchestrator `processRequestedInformation()` shared by
  both handlers; Jest suite extended with mock-sink coverage.

Auto-feed is suppressed when a negative probe is active
(`requestedInformationProbe ≠ off`) — that path (deliberately omit/invalid + grade
the provider's error) lands in **Phase 3c**.

---

## [server-v1.11.60] — 2026-05-27

OSDM `requestedInformation` evaluation — **#258 Phase 2**. Bruno collection change
(OTST_V2.0.15 → OTST_V2.0.16); server in lockstep (1.11.59 → 1.11.60).

### Added
- **Evaluate `requestedInformation` against the data OSCAR will send, and WARN on
  unmet requirements** (`library-bruno/requestedInformation.js`). Builds on the
  Phase 1 surfacing: `evaluateRequestedInformation(ast, model)` walks the boolean
  expression (`AND`/`OR`; `ANY` index ⇒ every passenger must satisfy it) and a
  leaf is met when the field is populated. Leaf resolution checks **both**
  `detail.contact.X` and the flat `detail.X`, so a 3.1+ contact demand is
  satisfied by 3.0 flat data and vice‑versa (mirrors #231).
  `buildPassengerModelFromAdditionalData()` normalises the scenario's
  `passengerAdditionalData` (`update*` fields) + `offerPassengerSpecifications`
  type into the passenger shape evaluated.
- **Wired into both flows.** `offers.js` `validateOfferParts` evaluates each
  offer part's expression against the scenario's passenger data; `bookings.js`
  `postCreateBookingResponse` evaluates the booking‑level expression against the
  booking's own passengers. When **not** satisfied, a per‑passenger `[WARNING]`
  names the exact field to set (e.g. *"missing 'phoneNumber' (phone number) for
  passenger 1"*) and notes the booking/confirmation will likely be rejected.
- Tests extended in `tests/unit/bruno-requestedinformation.test.js` (evaluator +
  model builder: single / `ANY` / `OR`, flat‑vs‑contact fallback, unmet
  reporting).

**WARN‑only by design:** a scenario may legitimately omit an optional field, so
an unmet requirement is informational (it predicts a likely downstream 400), not
a server non‑conformance; absence remains a non‑failure. Auto‑injecting the
demanded data stays a later, separate phase.

---

## [server-v1.11.59] — 2026-05-27

OSDM `requestedInformation` surfacing — **#258 Phase 1**. Bruno collection change
(OTST_V2.0.14 → OTST_V2.0.15); server in lockstep (1.11.58 → 1.11.59).

### Added
- **Surface what a provider asks for before the next step**
  (`library-bruno/requestedInformation.js`, new). OSDM lets a provider advertise,
  via the `requestedInformation` string on each offer part (`AbstractOfferPart`)
  and on the post‑booking response (`Booking`), **which passenger data must be
  populated to proceed** (provisional booking → confirmation). The value is a
  boolean expression over `passengerSpecifications[i]` paths
  (`AND`/`OR`/grouping; numeric or `ANY` index; a leaf is true when that
  attribute is set). The new pure module **parses** the expression, **describes**
  it in plain language, **maps** each leaf to the OSCAR scenario field
  (`firstName`/`lastName`/`gender`/`dateOfBirth`/`email`/`phoneNumber` — keyed on
  the last path segment so `detail.email` and `detail.contact.email` both
  resolve), and **Layer‑1 type‑checks** the raw string (`string`, ≤ 32768).
- **Wired into the offer and booking flows** (`offers.js` `validateOfferParts`
  per offer part; `bookings.js` `postCreateBookingResponse` at booking level).
  When `requestedInformation` is present, a Layer‑1 type assertion runs and a
  tester‑facing line states exactly what to set and on which passenger
  (e.g. *"set 'gender' on passenger 0 — OSDM:
  `passengerSpecifications[0].detail.gender`"*). A field the provider demands but
  OSCAR cannot yet author (e.g. `taxId`) is flagged as a gap rather than ignored.
- Unit tests `tests/unit/bruno-requestedinformation.test.js` (parser / describer
  / summariser, incl. the four verbatim spec examples).

Absence of `requestedInformation` is not a failure (it is nullable/optional).
**Unmet** requirements are *not* failed in this phase — evaluation against the
sent data + WARN is Phase 2; auto‑injecting the demanded data is a later phase.
Design note: `Documentation/Bruno_Collection/RequestedInformation_Plan_258.md`.

---

## [server-v1.11.58] — 2026-05-26

Dependency + repo cleanup (no functional behaviour change). **Bundles three
Dependabot items and removes one dependency; server 1.11.57 → 1.11.58, Bruno
collection OTST_V2.0.13 → OTST_V2.0.14, release 2026.86.**

### Removed
- **Dropped the `uuid` dependency for Node's built-in `crypto.randomUUID()`.**
  Every call site used `uuid.v4()` with no buffer, and the package could not be
  upgraded — uuid v7+ is ESM-only and breaks OSCAR's CommonJS (the documented
  PR #110 failure, `SyntaxError: Unexpected token 'export'`), so even the
  patched `11.1.1` was off-limits. Replaced
  `const { v4: uuidv4 } = require('uuid')` with
  `const { randomUUID: uuidv4 } = require('node:crypto')` across **9 `src` files
  + 10 test files** (call sites unchanged — `randomUUID()` returns an identical
  RFC-4122 v4 string), and removed `uuid` from `package.json` +
  `package-lock.json`. **Permanently resolves Dependabot alert #1** (uuid
  `< 11.1.1` buffer-bounds in v3/v5/v6 — a path OSCAR never used) and obsoletes
  Dependabot **PR #191** (uuid→14).

### Changed
- **Dependency bumps** (merged from Dependabot): `nodemailer` 8.0.7 → 8.0.9
  (patch, #192); `pino` 9.5.0 → 10.3.1 (major, #193 — `logger.js` uses only
  stable pino APIs and Node 22 satisfies pino v10's engine floor).

### Added
- **Tracked the three sibling Bruno `folder.yml` files** (`data_base`,
  `json_validator`, `library-bruno`) so collection folder ordering is
  deterministic for everyone; **gitignored** the local
  `Bruno_Collection/Dev working documents/` scratch folder.

---

## [server-v1.11.57] — 2026-05-26

Passenger contact read robustness (#231) — **Bruno collection change
(OTST_V2.0.12 → OTST_V2.0.13); server bumped in lockstep (1.11.56 → 1.11.57).**

### Fixed
- **Passenger email/phone read is now version-agnostic**
  (`library-bruno/passengers.js`). `patchMultiPassengerResponse` validated the
  PATCH/GET passenger response's echoed email/phone behind
  `parseFloat(osdmVersion) >= 3.4`, but the OSDM `PersonDetail` change actually
  landed at **3.1**: `contact` (`ContactDetail`) was added and top‑level
  `email`/`phoneNumber` were marked `deprecated` (still returned). The `>= 3.4`
  boundary false‑failed on 3.1–3.3 servers returning contact‑only, and
  `parseFloat("3.0.4")` collapsed to `3` (so the reported 3.0.4 failure read the
  wrong field). Replaced the version branch with a **contact‑first / flat‑fallback**
  read (`detail.contact?.email ?? detail.email ?? ""`, same for `phoneNumber`),
  matching the already‑robust purchaser read in `fulfillments.js`. No version
  guessing, correct across 3.0.x and 3.1+. The build side (`scenarioParser.js`,
  `DetailContact`/`Contact` vs flat `Detail` at the 3.4 boundary) is unchanged —
  flat is accepted/deprecated at 3.1–3.3 and correct at 3.0.x, so requests stay
  valid.

---

## [server-v1.11.56] — 2026-05-26

UI polish (#194) — scenario authoring + admin time displays. **Server‑only; Bruno
collection unchanged (OTST_V2.0.12).**

### Fixed
- **Scenario title shows the code verbatim** (`public/js/scenarios.js`). The row
  title ran `decodeCode(sc.code)`, which partial‑decoded codes containing
  recognised tokens (e.g. `SALE_SEARCH_BAS_PAR_2ADT_2LEG` → "Sale — 2 Adults — 2
  Legs", dropping the origin/destination) and looked like a system rename. New
  `scenarioTitle(sc)` shows the **code as entered**; the decoded/default name is
  used only when there is no code.
- **Passenger category preserved** (`public/js/scenarios.js`). `wizGenPassengers`
  (bulk create) omitted the `category` field the scenario view reads first, so a
  3‑adult / 2‑child request rendered as **5 adults** (DOBs were already
  child‑aged — only the label was wrong). It now stamps `category` like the
  single "Add Passenger" path already did. Corrected two help texts that wrongly
  claimed names are prefixed with the type.

### Added
- **Server Activity — browse earlier days + a specific day, in local time**
  (`public/admin.html`, `src/api/routes/admin.js`). The login‑events list was
  capped at the latest 50 with no date filter. Added a **date picker** (local
  day) + **Latest** button; `GET /v1/admin/activity?from=&to=` filters by the UTC
  range derived from the picked **local** day so it matches the local times
  shown; the list is now a scrollable region; empty‑state + local‑today clamp.
- **Local‑timezone reference, app‑wide** (`public/nav.js`). Timestamps render in
  the viewer's local zone but printed no zone. New shared `localTzRef()` + a
  small **clock chip in the nav bar** (e.g. `🕒 Europe/Paris (UTC+02:00)`,
  DST‑aware) gives every page's time columns an explicit reference; the Activity
  caption also names the zone.

### Operator action
None. Hard‑refresh after Watchtower promotes `:stable`.

---

## [server-v1.11.55] — 2026-05-24

Fix (#188) — booking failed with `400 "Invalid request content"` because
`placeSelections.places[]` didn't match the OSDM `SelectedPlace` schema.
Collection **OTST_V2.0.11 → OTST_V2.0.12**.

### Fixed
- **`library-bruno/requestsBuilder.js`** (`placesForPassengers`): OSDM
  `SelectedPlace` is `additionalProperties:false` and requires exactly
  `{ coachNumber, placeNumber, passengerRef }` — all **strings**, `passengerRef`
  **singular**. The builder emitted `passengerRefs` (plural array) and
  potentially numeric `coachNumber`/`placeNumber`, so the vendor rejected the
  booking with `400 "Invalid request content"`. Now emits the conformant shape
  (one entry per passenger; values coerced to strings). The legacy single-place
  branch in `accommodationAndPlaceSelection` routes through the same helper.
  Fixes both `02. POST Create Booking` and `09. POST Add Reservation` (shared).
- **`collectAvailablePlaces`**: the coach number is read from the OSDM
  `Coach.number` field (was wrongly reading `coachNumber`, which is always
  `undefined`), with `coachNumber` kept only as a fallback for non-spec vendors.
  Without this, the picked place had no coach number and the required
  `SelectedPlace.coachNumber` was missing → `400`.
- This was latent until #186 made the offer-time seat map work and `places`
  actually populate.

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.12
after Watchtower restarts.

---

## [server-v1.11.54] — 2026-05-24

Fix (#186) — plain **seat** scenarios sent an unresolved `{{reservationId}}` to
the place map, so the vendor returned **400**. Collection
**OTST_V2.0.10 → OTST_V2.0.11**.

### Fixed
- **`library-bruno/offers.js`** (`handleAccommodationAndPlaceSelection`): the
  place map (`08`/`08b`) and add-reservation (`09`) are keyed on a RESERVATION
  offer-part (`resourceType=RESERVATION`), but `reservationId`/`tripLegCoverage`
  were only set on the `COUCHETTE`/`BERTH` branch. A plain seat scenario
  (`SEATMAP_AT_OFFER` / `ADD_TO_BOOKING`, `accommodationSelection = NONE`) never
  set them, so `08`'s URL contained the literal `{{reservationId}}`
  (`%7B%7BreservationId%7D%7D`) and the vendor rejected it with `400` (seen on
  Bileto). Now, for the seat path, when place selection is enabled and
  `reservationId` isn't already set, it's derived (with `reservationIds` /
  `tripLegCoverage`) from the offer's **first `reservationOfferPart`**. Offers
  with no reservation part log "seat map not applicable".
- **`opencollection.yml`** smart-run filter: defensively **skips** any place-map
  request when `reservationId` is empty (no reservation → seat map N/A), so a
  malformed `{{reservationId}}` URL is never sent.

### Note
The earlier #182 finding ("Bileto serves no offer-time seat map") may have been
based on this same malformed request — with `reservationId` now resolving, `08`
sends a valid request, so Bileto's **real** offer-context response can finally be
observed (re-test recommended).

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.11
after Watchtower restarts.

---

## [server-v1.11.53] — 2026-05-24

Feat (#184) — availability-aware seat selection at **both** selection times:
OSCAR now picks an **available** place **per passenger** from the seat map —
pre-booking (`08. GET Place Maps`, OFFER context) **and** post-booking
(`08b. GET Place Map Post-Booking`, BOOKING context) — instead of blindly taking
the first place and seating everyone on it. Collection
**OTST_V2.0.9 → OTST_V2.0.10**.

### Added
- **`library-bruno/requestsBuilder.js`** — `collectAvailablePlaces(vehicle, count)`
  (exported, unit-tested): the OSDM place map returns the whole vehicle in one
  response, so this flattens the coaches (handles `coach.places`,
  `coach.compartments[].places`, `coach.decks[].places`, and a compartment that
  itself carries `.place`), keeps only **available** places (boolean
  `available`/`bookable` or enum `availability`/`state`/`status`; no availability
  info ⇒ treated as available so minimal vendors aren't excluded), and returns up
  to `count` `{ coachNumber, placeNumber, layoutId }`.
- **`library-bruno/requestsBuilder.js`** — `placesForPassengers(picked, refs)`
  (exported, unit-tested): maps picked places onto passengers, one `places[]`
  entry per passenger (surplus passengers reuse the last place). Shared by the
  pre- and post-booking paths.
- **`08b. GET Place Map Post-Booking`** — new request. The
  `/availabilities/place-map` endpoint is context-parametrised: `contextType` may
  be `OFFER` (pre-booking) or **`BOOKING`** (post-booking). Providers that hold
  seats against a BOOKING (e.g. Bileto — see #182) expose the seat map only
  *after* pre-booking. This runs in `ADD_TO_BOOKING` mode or as the #182 fallback,
  routed `02. POST Create Booking → 08b → 09. POST Add Reservation`. It reuses
  `collectAvailablePlaces`, then `09` carries the picks. Best-effort: a vendor
  that serves no BOOKING-context map is reported via a trackable assertion
  `[OSDM] Vendor serves a post-booking (BOOKING-context) seat map` (+ `[VENDOR
  GAP]` log) and the flow continues — `09` lets the system assign the place.

### Changed
- **`08. GET Place Maps`**: derives the passenger count, calls
  `collectAvailablePlaces`, stores `preselectedPlaces` (plus back-compat
  `preselectedCoach`/`preselectedPlace`/`layoutId`), logs the chosen seats and
  warns when fewer places are available than passengers.
- **`accommodationAndPlaceSelection`**: when `preselectedPlaces` is present, emits
  **one `places` entry per passenger** (via `placesForPassengers`). The presence
  of picks also enables place selection even when the legacy
  `requiresPlaceSelection` flag is unset, so a `SEATMAP_AT_OFFER` scenario carries
  its seats into the booking. The single-place back-compat path is preserved.
- **`09. POST Add Reservation to Booking`**: when `preselectedPlaces` is present
  (set by `08b`), the add-reservation `placeSelections` now carries `places`
  (one per passenger) instead of relying on system auto-assignment.
- **`02. POST Create Booking`** routes to `08b` before `09` when an
  add-reservation is due; **`opencollection.yml`** smart-run filter now gates the
  OFFER-context map (pre-booking) and the BOOKING-context map (post-booking,
  needs a booking, once) independently.
- `preselectedPlaces` / `__postBookingPlaceMapDone` reset between scenarios/runs
  (`opencollection.yml` + `scenarioParser.resetScenarioEnvVars`).

### Notes
- **Availability-only** (scope confirmed with the requester) — no "seat
  passengers together" optimisation.
- No sandbox tested so far serves a place map in **either** context (the vendors
  hold seats against a BOOKING — see #182), so this is built to the OSDM spec and
  unit-tested; it cannot be live-validated until a vendor serves one. For Bileto,
  whether post-booking selection is exposed as a BOOKING-context place map (vs.
  accepting `places` directly / auto-assigning) is to be confirmed on next test.

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.10
after Watchtower restarts.

---

## [server-v1.11.52] — 2026-05-24

Fix (#182) — adaptive place-selection fallback: when the pre-booking
(OFFER-context) seat map is unavailable, OSCAR selects the seat **after**
pre-booking, with a trackable vendor-gap assertion. Collection
**OTST_V2.0.8 → OTST_V2.0.9**.

### Changed
- **`08. GET Place Maps`**: when the offer-time seat map is unavailable
  (non-200 **or** 200 with no `vehicleAvailability`) and place selection is
  enabled (`salesFlow_placeSelection === 'true'`), set `__placeMapAtOfferFailed`
  and emit a clearly-named **FAILING** assertion `[OSDM] Vendor serves a
  pre-booking (OFFER-context) seat map` (+ a `[VENDOR GAP]` log). Providers such
  as Bileto hold seats against a **BOOKING**, so they expose no seat map for a
  bare OFFER — place selection then happens post-booking.
- **`02. POST Create Booking`**: the post-booking add-reservation routing
  (`_addRes`) now also fires when `__placeMapAtOfferFailed === 'true'`, so the
  seat is selected after pre-booking via `09. POST Add Reservation to Booking`
  (*"pre-book, then pick the seat"*) — even when the scenario's nominal mode was
  `SEATMAP_AT_OFFER`.
- **`opencollection.yml`**: smart-run filter `_runAddReservation` is also true
  when `__placeMapAtOfferFailed === 'true'` (so `09` is not skipped);
  `__placeMapAtOfferFailed` added to the collection-start reset list.
- **`library-bruno/scenarioParser.js`** (`resetScenarioEnvVars`):
  `__placeMapAtOfferFailed` reset between scenarios.

One-way scenarios, nominal `ADD_TO_BOOKING`, and working `SEATMAP_AT_OFFER`
scenarios are unchanged.

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.9
after Watchtower restarts.

---

## [server-v1.11.51] — 2026-05-24

Fix (#180) — return booking adapts when a vendor rejects multi-offer bookings,
with a trackable vendor-gap assertion. Collection **OTST_V2.0.7 → OTST_V2.0.8**.

### Changed
- **`02. POST Create Booking`** (return scenarios): first attempts the
  OSDM-valid **combined** booking (both offers). If the vendor rejects it with a
  multi-offer error (Bileto: `400 "Too many offers — Only one offer can be
  booked at a time, for now"`), OSCAR emits a clearly-named **FAILING** assertion
  `[OSDM] Vendor supports booking multiple offers (round trip) in one booking`
  (so the gap is easy to track/filter in the report) plus a `[VENDOR GAP]` log,
  then **falls back** to two separate bookings — `sep-out` (outbound), then
  `sep-in` (inbound) — the inbound becoming the current booking that continues
  the normal post-booking flow.
- **`library-bruno/requestsBuilder.js`** (`buildBookingRequest`): mode-aware via
  `__returnBookMode` (combined / sep-out / sep-in). One-way scenarios unchanged.
- New return env vars (`outboundBookingId`, `__returnBookMode`) reset between
  scenarios (`opencollection.yml` + `scenarioParser.resetScenarioEnvVars`).

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.8
after Watchtower restarts.

---

## [server-v1.11.50] — 2026-05-24

Feature (#178) — full two-step OSDM return trip (inward offer + round-trip
booking). Collection **OTST_V2.0.6 → OTST_V2.0.7**.

### Added
- **Inward offer step** — new request **`02-Common Requests/01b. POST Get Return
  Offer`**. After the outbound offer of a return scenario, OSCAR captures the
  chosen outbound offer (`outboundOfferId`) and fetches the **return** offers:
  `POST /offers` with the trip reversed (O&D swapped, `departureTime =
  inwardReturnDate`) and `returnSearchParameters.outwardOfferIds =
  [outboundOfferId]`, then captures `inboundOfferId`.
- **`library-bruno/requestsBuilder.js`**: `buildReturnOfferCollectionRequest()`
  builds that inward request; `buildBookingRequest()` now books **both** the
  outbound and inbound offers in one booking when a return was fetched
  (`offers: [outbound, inbound]`), otherwise the single offer as before.

### Changed
- **`01. POST Get Offer`** routes to `01b` (instead of booking) on a return
  scenario; **`opencollection.yml`** smart-run filter skips `01b` for one-way
  scenarios and resets the new return env vars. Return is detected from the
  outbound `tripSearchCriteria.returnSearchParameters.inwardReturnDate`, so
  **one-way scenarios are unchanged**. Scoped to SEARCH outbounds.

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.7
after Watchtower restarts.

---

## [server-v1.11.49] — 2026-05-23

Fix (#176) — return trips are now valid OSDM (move from a bogus
`offerSearchCriteria.inboundDate` to `tripSearchCriteria.returnSearchParameters`)
and defined as a day-offset instead of an absolute date. Collection
**OTST_V2.0.5 → OTST_V2.0.6**.

### Fixed
- **`Bruno_Collection/library-bruno/scenarioParser.js`**: the return date was
  written to `offerSearchCriteria.inboundDate`, but `inboundDate` is not an OSDM
  field and `OfferSearchCriteria` is `additionalProperties:false` — so the whole
  request was invalid and spec-strict vendors (e.g. Bileto) rejected it with
  **400**. The return is now expressed the OSDM way:
  `returnSearchParameters.inwardReturnDate` on the **tripSearchCriteria** (SEARCH)
  / **tripSpecification** (SPECIFICATION).

### Changed
- **Return trip is now a day-offset, not an absolute date.** Outbound dates are
  resolved dynamically at run time, so the return is derived:
  `inwardReturnDate = outbound departure date + N days` (default suggestion 2,
  for night trains; `0` = same day). The time mirrors the outbound departure
  time-of-day (with an optional `HH:MM` override), and the trailing timezone
  offset is mirrored from the outbound so the format matches the vendor exactly.
- **`public/js/scenarios.js`**: the scenario Offer Search Criteria editor
  replaces the "Inbound Date" date-picker with a **Return trip** day-offset field
  (empty = one-way) + an optional **Return time** override. Stored as
  `returnOffsetDays` / `returnTime` (authoring data only — routed to the trip,
  never echoed into the OSDM offerSearchCriteria).

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows OTST_V2.0.6 after
Watchtower restarts. Hard-refresh the Test Config page; re-set the return on any
scenario that used the old (broken) inbound date.

---

## [server-v1.11.48] — 2026-05-23

Enhancement (#174) — collapsible detailed run report: foldable logs, two-level
assertions, and a new request/response section.

### Added / Changed
- **`public/run-detail.html`**:
  - **Execution Log** is now a collapsible card (collapsed by default) — click
    the header to expand/collapse; the log controls hide while collapsed.
  - **Assertions** now collapse on two levels: main area (suite) → endpoint
    (request) → individual assertions. Everything starts collapsed; each level
    shows its counts (assertions / failed / pass-rate). Filters unchanged.
  - New **"HTTP Traffic — Request & Response"** card, structured the same way
    (suite → endpoint, collapsed by default). Expanding an endpoint lazily loads
    that request's **request body and response body** (pretty-printed) from
    `/v1/runs/:id/requests/:reqId`. All / Non-2xx / Failed filters.

### Operator action
None. Hard-refresh the run-detail page after Watchtower promotes :stable.

---

## [server-v1.11.47] — 2026-05-23

Fix (#171) — restore per-company concurrent runs. Enhancement (#172) — new
scenarios default to a minimal offer search (O&D + departure date only).

### Fixed
- **`src/api/routes/runs.js`**: the per-company concurrent-run limit was always
  `1`, so batch runs serialized regardless of the configured value (e.g. Bileto
  set to 3 with a global cap of 9 still ran one-by-one). The test-framework
  `config` column is **encrypted at rest** (Phase 2 of #60), but both the
  run-submit path and the queue-status path read it with a plain
  `JSON.parse(tfRow.config)` — no `colDecrypt` — so parsing the ciphertext threw
  and `concurrentSessionLimit` fell back to `1`. Both reads now `colDecrypt()`
  first (legacy plaintext still passes through). The queue's per-company
  throttle was already correct; it was simply being fed a limit of 1.

### Changed
- **`public/js/scenarios.js`** (`wizInitScenario`): a new scenario no longer
  pre-seeds the offer-search criteria (requestedOfferParts, service/travel
  classes, flexibilities, offerMode, currency) from the framework defaults.
  They start **empty**, so a search-based scenario sends only the trip (origin +
  destination + departure date) and an empty `offerSearchCriteria` — the vendor
  returns its full default offer. Every criterion remains optional and tickable
  in the wizard; fulfillment defaults (booking, not search) are unchanged.

### Operator action
None. The concurrency fix takes effect for runs submitted after Watchtower
promotes :stable. Hard-refresh the Test Config page for the scenario-default
change.

---

## [server-v1.11.46] — 2026-05-23

Enhancement (#169) — Timetable Discovery splits a route into separate train sets
by operating-days pattern (weekday vs weekend trains).

### Changed
- **`src/services/timetable-discovery.js`** (`groupAndMerge`): now tracks the
  operating days observed **per service** across the scan, then splits each
  route into separate sets by day-pattern. E.g. on Sqills BAS↔AMS the 1xx trains
  (Mon–Fri) and the 8xx trains (weekend) become two sets — "… (Mon–Fri)" and
  "… (weekend)" — each with its own accurate calendar (consistent with the
  one-calendar-per-set model from #141), instead of one set marked Mon–Sun. The
  reconcile key now includes the calendar (origin + destination + product
  category ref + sorted days), so a re-scan merges into the matching set; the
  set label carries the day-pattern. Summary gains `setsDiscovered`.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.45] — 2026-05-23

Fix (#167) — Timetable Discovery: unblock scenario creation after discovery,
discover via /offers only, and prefill object-form service classes.

### Fixed
- **`public/js/scenarios.js`**: after a discovery run the Test Scenarios section
  stayed locked ("configure Test Data first") even though a train now existed —
  discovery only re-rendered Test Data, leaving the train-count-gated Scenarios
  section stale. Discovery now calls `refreshAllSections()` (reloads resources +
  re-renders all three sections). Removed the now-unused `refreshResourcesOnly`.
- **`src/services/timetable-discovery.js`** (`harvestOfferCatalog`): service
  class is an object `{ name, type }` in some sandboxes (e.g. Sqills), not a
  string, so it was never prefilled. It now reads both forms (prefers `.type`,
  then `.name`) and also harvests `offerSummary.overallTravelClass` /
  `overallServiceClass`.

### Changed
- **`src/api/routes/company-test-resources.js`**: discovery now uses **`POST
  /offers` only** (`DISCOVERY_ENDPOINTS = ['offers']`). The offer response
  carries both the timetable (`trips[]`) and the offered classes/ancillaries
  (`offers[]`) — strictly more than `/trips-collection` — and works on every
  sandbox. Sandboxes that DO implement `/trips-collection` (e.g. Sqills) were
  served by it and so got no class/ancillary prefill; offers-only fixes that.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.44] — 2026-05-23

Enhancement (#165) — Timetable Discovery keeps the clean O&D the tester searched
with at the route endpoints, instead of a vendor's internal stop refs.

### Changed
- **`src/services/timetable-discovery.js`** (`harvestTrips`): now accepts
  `{ searchedOrigin, searchedDestination }`. Some sandboxes (e.g. Bileto) echo
  their **internal** stop refs (`urn:x_bileto:stn:<uuid>`) in the offer response,
  so a discovered set's Origin showed that UUID rather than the UIC code the
  tester typed. Harvest now substitutes the searched O&D at the route endpoints
  — the **first** timed leg's origin and the **last** timed leg's destination of
  each trip (every returned trip spans the searched O&D). Intermediate
  connection stations the sandbox resolves itself are left untouched, and
  leg-to-leg continuity is preserved (the same connection ref still chains).
- **`src/api/routes/company-test-resources.js`**: passes the normalized searched
  O&D into `harvestTrips`.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.43] — 2026-05-23

Enhancement (#163) — Timetable Discovery accepts vendor station URNs and
prefills a discovered train set's Service Configuration from the offer response.

### Added
- **`src/services/timetable-discovery.js`** (`harvestOfferCatalog`): collects the
  **travel classes**, **service classes** and **ancillary types** the sandbox
  actually offered on the searched O&D from an `OfferCollectionResponse` — a
  depth-guarded deep scan (`travelClass` / `serviceClass` anywhere in an offer;
  `ancillaryOfferParts[].type`, falling back to `.category`), so it's agnostic
  to vendor/OSDM-version offer-part nesting. `groupAndMerge()` now takes that
  catalog and **seeds** these arrays on newly created sets and **fills only
  empty** arrays on existing sets — a set the tester has already configured (or
  a class they deliberately removed) is never overwritten or re-added. A
  `/trips-collection` response has no `offers[]`, so prefill is a no-op there.
- **`src/api/routes/company-test-resources.js`**: accumulates the offer catalog
  across the searched days and passes it to `groupAndMerge`.

### Fixed
- **`public/js/scenarios.js`** (`wizValidateTrain`): the Origin/Destination
  station URN validator only accepted `urn:uic:stn:<digits>`, so a discovered
  vendor ref (e.g. Bileto's `urn:x_bileto:stn:<uuid>`) was flagged invalid and
  blocked saving. It now accepts any `urn:<scheme>:stn:<id>` — UIC codes **and**
  vendor refs.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.42] — 2026-05-23

Fix (#161) — Timetable Discovery now uses an OffsetDateTime for Bileto's trip
search, matching the Bileto exception in the Bruno run flow.

### Fixed
- **`src/api/routes/company-test-resources.js`**: discovery against the Bileto
  sandbox returned `HTTP 400 "Failed to read request"` on both `/trips-collection`
  and `/offers` while normal scenario runs worked. Cause: Bileto's deserializer
  requires the trip-search `departureTime` to be an **OffsetDateTime**, but
  discovery sent a bare LocalDateTime (`YYYY-MM-DDThh:mm:ss`). The Bruno
  `scenarioParser` already has this exact carve-out (`api_base.includes("bileto")`
  → OffsetDateTime). Discovery now applies the same rule: for Bileto it sends
  `…T00:00:00+00:00`; all other vendors keep the LocalDateTime the OSDM
  TripSearchCriteria pattern specifies.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.41] — 2026-05-23

Fix (#159) — Timetable Discovery now falls back to `POST /offers` when a sandbox
doesn't implement the optional OJP `/trips-collection` search.

### Fixed
- **`src/api/routes/company-test-resources.js`**: live-testing #157 against the
  Chaps sandbox returned `HTTP 400 "Failed to read request"` on every
  `/trips-collection` call — Chaps (like the others) doesn't implement that
  optional endpoint; OSCAR's Bruno run flow only ever uses `POST {api_base}/offers`
  with the trip search embedded. Discovery now tries `/trips-collection` first
  and **falls back to `POST /offers`** (an `OfferCollectionRequest` with the trip
  search + one anonymous passenger + empty offer criteria) when the former 4xx's
  or returns no trips. Both responses carry `trips[].legs[].timedLeg`, so the
  same `harvestTrips()` reads either. The working endpoint is locked in for the
  remaining days (no repeated probing), and the per-day breakdown now reports
  which endpoint served each day (`via`). The token is fetched server-side
  exactly as before — this was never an auth issue (that would be a 401).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable".

---

## [server-v1.11.40] — 2026-05-23

Feature (#157) — **Train Timetable Discovery**: reverse-engineer the train sets
a sandbox actually runs from `POST /trips-collection`, and auto-fill Test Data.

### Added
- **`src/services/timetable-discovery.js`** (new): pure harvest/group/merge
  logic. `harvestTrips()` reads **every timed leg** of every returned trip as a
  service on its own sub-route (start/end stop + product category + vehicle #s +
  departure/arrival + operating day). `groupAndMerge()` groups services by route
  key (origin + destination + product-category ref) and reconciles against the
  company's existing TRAIN resources: **creates** new sets, **appends** new
  services (dedup on vehicle# + departure + arrival), and **unions** the
  operating-days calendar — never overwriting manual edits (operator/product
  names are only filled when empty; catalogs like ticket types are preserved).
  `searchDates()` builds the 1–14-day scan window (default 7). Fully unit-tested
  (`tests/unit/timetable-discovery.test.js`).
- **`src/worker/access-token.js`** (new): the per-tester OAuth2/bearer token
  resolution + token cache, extracted verbatim from `runner.js` so the discovery
  endpoint and the Bruno run worker share one implementation. `runner.js` now
  delegates to it (no behaviour change to runs).
- **`POST /v1/company/test-resources/discover-timetable`** (Test-Manager only,
  tenant-scoped): given `{ originURN, destinationURN, days? }`, obtains a sandbox
  token, fires `POST {api_base}/trips-collection` for each day (local
  `YYYY-MM-DDThh:mm:ss`, `{objectType:'StopPlaceRef'}` O&D), harvests + merges,
  persists the resulting TRAIN sets, and returns a `{ summary, created, updated,
  dayResults }` report. Per-day failures are tolerated; the call only fails if
  no day succeeded.
- **`public/js/scenarios.js`**: a **🔍 Discover timetable** button in Test Data →
  Train Resources opens a modal (origin, destination, days), runs discovery, and
  shows what was created/updated plus a per-day breakdown, then refreshes the
  train list. Hidden for testers (read-only).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data → Train Resources → "Discover timetable". Requires the
company's OSDM API base + the tester's credentials to be configured.

---

## [server-v1.11.39] — 2026-05-22

Fix (#155) — scenario Offer Search Criteria now offers the full OSDM master
list, so any value can be requested (incl. for non-happy-flow scenarios).

### Fixed
- **`public/js/scenarios.js`**: a scenario's Offer Search Criteria is a free
  request filter — the tester must be able to request **any** OSDM value (travel
  class, service class, requested offer parts, flexibilities, offer mode),
  including ones the train or system-under-test doesn't support, to author
  **non-happy-flow** scenarios. Travel class is test data (per train), not a
  framework setting, so the framework/train must not restrict the options. Both
  the creation wizard (`renderWizardStep3`) and the scenario detail editor
  (`buildOfferSection`) now build each control from the **full OSDM enum**
  (`WIZ_*` / `ENUMS.*`), unioned with whatever is already selected. Framework/
  train values remain only as **defaults** (seeded into the scenario), never as
  a filter. Completes #153 (which only let an already-set value be deselected).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → a scenario's Offer Search Criteria.

---

## [server-v1.11.38] — 2026-05-22

Fix (#153) — a selected travel/service class can now always be deselected in a
scenario's Offer Search Criteria.

### Fixed
- **`public/js/scenarios.js`** (`buildOfferSection`): each Offer-Criteria
  multi-select (requested offer parts, service class, **travel class**,
  flexibilities) was rendered **only** from the framework's allowed set
  (`fwFilter(...)`). A value seeded from the train — e.g. `travelClass: ["FIRST"]`
  when the framework offer-criteria lists only `SECOND` — therefore had **no
  pill to untick**, so it couldn't be removed (it kept reaching the request as
  `offerSearchCriteria.travelClasses: ["FIRST"]`). Each list now renders the
  **union of allowed ∪ currently-selected** values, so anything already set
  always appears (checked) and is deselectable.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → the scenario's Offer Search Criteria.

---

## [server-v1.11.37] — 2026-05-22 + collection-OTST_V2.0.5

Fix (#150) — add-ancillary now sources bookable ancillaries from the booking's
additional-offers, not the pre-booking offer.

### Fixed
- Post-booking add-ancillary failed with `400 "ancillary not valid for
  bookedOfferId …"` because the request reused the **pre-booking offer's**
  `offerId`/`ancillaryOfferId`, which the booking rejects. New request
  **`02-Common Requests/11. Add Ancillary - Get Additional Offers`** does
  `GET /bookings/{id}/booked-offers/{bookedOfferId}/additional-offers` and
  captures the first additional offer's `offerId` + `ancillaryOfferParts[].id`
  (valid for *this* booking), then chains to `10. POST Add Ancillary`. If the
  provider offers nothing addable, it logs and skips (OSDM allows rejecting
  post-booking additions).
- **`10. POST Add Ancillary to Booking`** now **prefers** the additional-offers
  ids (`addAncillaryParentOfferId` / `addAncillaryOfferIds`), falling back to the
  admission-linked refs and the offer's own ancillary parts.
- **`02. POST Create Booking`** and **`09. POST Add Reservation`** route to the
  new GET step instead of straight to the POST. Smart filter gates the new step
  under the existing `add ancillary` rule; the new env vars are added to the
  per-scenario reset list.

### Changed
- **`Bruno_Collection/VERSION`**: OTST_V2.0.4 → **OTST_V2.0.5**.

### Operator action
None. Bruno collection refreshes on the VPS at merge; chip shows
**2026.65 / server-v1.11.37 / OTST_V2.0.5** after Watchtower restarts.

---

## [server-v1.11.36] — 2026-05-22 + collection-OTST_V2.0.4

Collection version bump — surface the Bruno-collection fixes that shipped on
collection 2.0.3 without a version change.

### Changed
- **`Bruno_Collection/VERSION`**: **OTST_V2.0.3 → OTST_V2.0.4**. Records two
  Bruno-collection fixes that previously refreshed onto prod without bumping the
  collection version (so the version chip looked unchanged):
  - **#147** — `library-bruno/bookings.js` captures `bookedOfferId` from the
    BookedOffer's `offerId` (the OSDM identifier) instead of a non-existent
    `.id`, so post-booking add-ancillary/add-reservation URLs are populated.
  - **#132** — `10. POST Add Ancillary to Booking` sources `ancillaryOfferIds`
    from the offer's top-level `ancillaryOfferParts` when no admission-linked
    refs exist (Sqills).
- **Process**: from now on, a Bruno-collection change bumps `Bruno_Collection/
  VERSION` and rides a server release, so the version chip and `compatibility.json`
  always reflect what's actually running. The server image is functionally
  unchanged here — this re-release exists to surface the new collection version
  on the chip (compatibility.json is read once at boot, so the chip refreshes
  when Watchtower restarts on the new :stable digest).

### Operator action
None. After Watchtower promotes :stable, the version chip shows
**2026.64 / server-v1.11.36 / OTST_V2.0.4**.

---

## [server-v1.11.35] — 2026-05-22

Offer-criteria polish (#145).

### Fixed
- **`public/js/scenarios.js`**: the new-scenario wizard's **Offer mode** can now
  be left empty (a "— none —" option). `offerSearchCriteria` and all its fields
  are optional per OSDM (verified v3.4 & v3.8: `OfferSearchCriteria` has no
  required properties, and `offerSearchCriteria` is not required on
  `OfferCollectionRequest`/`ExchangeOfferCollectionRequest`); the wizard
  previously forced a mode while every other criterion was clearable. Selecting
  "none" omits `offerMode` from the request.

### Added
- **Journey leg-continuity guard**: the journey editor now warns (amber banner,
  live) when a leg **departs before the previous leg arrives** or **starts at a
  different station** than the previous leg ends — the trap that produced an
  empty Sqills offer (OSDM_202 arrived 16:35 but OSDM_109 departed 15:00). Soft
  warning, since overnight connections are legitimate.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Scenarios.

---

## [server-v1.11.34] — 2026-05-22

Fix (#143) — the new-scenario wizard can now select a Journey (multi-leg).

### Fixed
- **`public/js/scenarios.js`** (`renderWizardStep3` / `wizGenerateScenario`): the
  scenario-creation wizard only offered **"Select train resource"** (a single
  train set), so a fresh **multi-leg** scenario built from a reusable Journey
  (#137) was unreachable — a dead end. The wizard's Train / Trip Selection now
  shows a **"Select a Journey"** dropdown (when journeys exist). Picking one sets
  `wizScenario.journeyResourceId`, hides the single-train / trip-mode controls
  (a journey is inherently a multi-leg SPECIFICATION), shows a route summary, and
  `wizGenerateScenario` builds the trip as `SPECIFICATION` with
  `legs = journeyToTripLegs(journey)` — origin/destination/times/vehicle/operator
  **and product category** resolved per leg from each train set. Single-train
  selection is unchanged when no journey is chosen.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Scenarios → New.

---

## [server-v1.11.33] — 2026-05-22

Fixes & polish (#141) — a bundle of train-set / journey usability fixes found
while testing the timetable (#136) and journeys (#137).

### Fixed
- **Journey leg picker labelled by service, not the train-set name** — each
  option now reads `route · vehicle · departure→arrival · <set name>` so it is
  clearly a *leg* (a service), not the whole set.
- **Product category was missing from the offer request** (Sqills rejected it).
  The train set now captures product category as **ref / name / shortName** (was
  a single field; the old value migrates into the ref), and all three are copied
  into the trip leg by every builder (the per-service "Apply test data" picker,
  "Apply a Journey", the new-scenario wizard, and the datafile import). Bruno
  already maps these into `service.productCategory`, so the request is now
  populated.
- **Operating-days calendar moved from per service to the train-set level** —
  one "Operating days" picker governs the whole timetable instead of editing
  every train; old per-service days migrate up to the set.
- **Saving a train no longer collapses its panel / wipes the list, and no longer
  needs a second click to re-expand.** `wizSaveTrain` / `wizSaveJourney` now
  re-render the Test Data section locally and re-open the saved panel instead of
  the heavy `refreshAllSections()` (a resource save doesn't touch the framework,
  scenarios or datafile).

### Added
- **"Save all trains"** button — persists every open/edited train at once
  (validates all panels first; a bad field blocks the batch).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data. **Re-open each Sqills train set** to confirm the migrated
product-category **ref** and fill **name / short name** from the vendor data.

---

## [server-v1.11.32] — 2026-05-22

Feature (#137) — reusable multi-leg **Journeys**. Phase 3 (final) of the
train-set/journey series (duplicate #135 → timetable #136 → journeys).

### Added
- **New `JOURNEY` test-resource type** (`src/api/routes/company-test-resources.js`
  allow-list; `src/db/schema.sql` comment). A journey's `data` is
  `{ legs: [ { trainResourceId, serviceIndex } ] }` — an ordered list of legs,
  each referencing a **train set + a chosen service** from its timetable (#136).
- **`public/js/scenarios.js`**: a **Journeys** section under Test Resources
  (replacing the old "Multimodal — coming soon" placeholder) — add/duplicate/
  delete journeys; each journey edits its ordered legs (pick train set + service
  per leg, reorder ▲▼, remove), with a live route summary
  (`BAS → AMS → PAR · 2 legs · 1 transfer`).
- **Scenario trip → "Apply a Journey"** picker: fills all trip legs from a saved
  journey in one click (sets the trip to SPECIFICATION). Define once, reuse
  across scenarios.

### Notes
- Journeys are **copied** into a scenario's legs at apply-time (not referenced),
  so deleting a journey can't orphan a scenario. No datafile-schema change — the
  generated `tripRequirement.legs[]` is exactly what the runtime already
  consumes.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data.

---

## [server-v1.11.31] — 2026-05-22

Feature (#136) — a train set is now a route + a timetable of services. Phase 2
of the train-set/journey series (duplicate #135 → timetable → journeys #137).

### Added
- **`public/js/scenarios.js`**: a train set's `data` gains a **`services[]`**
  array — each `{ vehicleNumber, departureTime, arrivalTime, daysOfWeek? }` — so
  one route (e.g. Sqills IC Basel→Amsterdam) can hold the several trains that run
  it at different hours (`OSDM_200/202/204/206`). Train Details now holds the
  shared route (label, operator, origin/destination, optional product category);
  a new **Services (timetable)** section lists the departures with **add/remove**
  rows, per-service **day-of-week** toggles, and a **paste box** that parses
  vendor tokens like `OSDM_202|OSDM_IC|2026-06-01T09:10:00+02:00|…|8500010|8400058`
  into rows (and fills empty route fields).
- The scenario trip **"Apply test data"** picker now lists **one entry per
  service**, so a scenario copies the route + the chosen departure.

### Changed
- `normalizeTrainData()` migrates legacy single-service train sets (top-level
  `vehicleNumber`/`departureTime`/`arrivalTime`) into `services[0]` on read —
  existing trains load and run unchanged. The wizard scenario generator and the
  delete-impact check use the first service / match any service's vehicle. No
  server route or datafile-schema change (train data is an opaque blob).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data.

---

## [server-v1.11.30] — 2026-05-22

Feature (#135) — duplicate a train set. Phase 1 of the train-set/journey
test-data series (duplicate → timetable #136 → journeys #137).

### Added
- **`public/js/scenarios.js`**: each train row in Test Resources gains a
  **🗐 Duplicate** button. `wizDuplicateTrain()` deep-clones the source train's
  `data` + `label` into a fresh **unsaved** placeholder with a unique "(copy)"
  label and expands it for editing — mirroring `wizAddTrain()` — so the common
  "same route, different hour" case no longer requires re-entering every field.
  The copy persists as a brand-new `test_resources` row on **Save Train**; the
  original is untouched. Hidden in tester read-only mode alongside add/delete.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Data.

---

## [server-v1.11.29] — 2026-05-22

Fix (#133) — scenario title no longer collapses to a bare "Sale" for custom codes.

### Fixed
- **`public/js/scenarios.js`** (`decodeCode()`): a scenario renamed to a code
  outside the strict OSDM test-suite convention — e.g. `SALE_SEARCH_IC_BAS_AMS_1PAX`
  — showed a bold title of just **"Sale"** because every descriptive token after
  the recognised type prefix (`SEARCH`, `IC`, `BAS`, `AMS`, `1PAX`) was silently
  dropped. `decodeCode()` now counts unrecognised tokens and, when **nothing
  beyond the bare type marker** was recognised, returns the code **verbatim** so
  the title matches the code the user typed. Genuine convention codes still decode
  to their rich human-readable label (`OTST_RFND_SRCH_CRIT_1ADT_1LEG` →
  "Refund — Search criteria — 1 Adult — 1 Leg").
- Also accept the full `COUCHETTE` token (not only the abbreviated `CCHTTE`), so
  couchette scenarios decode correctly instead of dropping the marker.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page.

---

## [server-v1.11.28] — 2026-05-22

Feature (#130) — configurable ancillary catalog at the Test Framework level.

### Added
- **`public/js/scenarios.js`**: a new **Ancillaries** section in the Test
  Framework — the OSDM standard `AncillaryType` examples as toggle pills **plus
  an "add custom" input** for vendor-specific codes (e.g. `BIKE`). OSDM
  `AncillaryType` is an x-extensible-enum (the spec lists examples), so custom
  values are spec-valid. Stored in `framework.ancillaries`.
- **Per-train reuse**: a train resource's "Ancillaries available" picker now
  draws from the **framework catalog** (`framework.ancillaries`) instead of a
  hard-coded constant — mirroring how ticket types already derive from
  `framework.rail.ticketTypes`. The picker shows the framework catalog **unioned
  with the train's existing selections**, so no previously-selected ancillary is
  lost.

### Changed
- New `emptyFramework()` seeds `ancillaries` with the OSDM standard set (was just
  `['WIFI']`). The hard-coded `WIZ_ANCILLARIES` constant is removed in favour of
  the editable framework catalog (`OSDM_ANCILLARY_TYPES` seeds the standard
  options).

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the Test Config
page → Test Framework → Ancillaries, then per train under Test Data.

---

## [server-v1.11.27] — 2026-05-22

Fix (#128) — changing a user's role to **Test Manager** no longer wipes their
company.

### Fixed
- **`src/api/routes/admin.js`** (`PATCH /v1/admin/users/:id`): `test_manager` was
  not handled as a company-bound role, so it fell into the catch-all `else` that
  reassigns to the platform company — changing a Tester to Test Manager silently
  moved them onto the OSCAR platform company. `company_user` and `test_manager`
  now **keep the user's current company** when no `company_id` is supplied, or
  move to a provided `company_id`; only `administrator` maps to the platform
  company. A company-bound role can't be left on the platform company (rejected
  with a clear 400).
- **`public/admin.html`**: the Users-tab company cell is now an editable select
  for **Test Manager** too (not a read-only "Platform" label), pre-selected to
  the current company and preserved across role changes — so an admin can keep
  *or* change the company. (Test-manager-managed user lists are unaffected — they
  stay scoped to the manager's own company.)

### Notes
- When a user *is* moved to another company, access to the previous company's
  data is **already blocked** by the per-request tenant scoping — no extra change
  needed. Deleting a company's test config/datafile when it loses its last user
  is a separate company-lifecycle policy, intentionally out of scope here.

### Operator action
None. Picked up after Watchtower promotes :stable; hard-refresh the admin console
Users tab.

---

## [server-v1.11.26] — 2026-05-22

Release of the **optional sale-flow features** initiative (collection
**OTST_V2.0.3**). Bundles the Bruno-collection work that landed after v1.11.25
into one tested, labelled version. Behaviour is **inert / zero-regression** for
every current scenario — the new steps activate only when a scenario opts in
(authorised by the Test Framework, v1.11.25 / #107).

### Added
- **OPT-PLACE Stage A** (#104) — `03. GET Place Maps` relocated from System
  Information into the sale flow (`02-Common Requests/08. GET Place Maps`), run
  as the pre-booking seat map (`SEATMAP_AT_OFFER`); `PlaceAvailabilityResponse`
  Layer-1 compliance + a no-seat-map mismatch diagnostic.
- **OPT-PLACE Stage B** (#124, issue #123) — `09. POST Add Reservation to
  Booking`: post-booking add-reservation (`ADD_TO_BOOKING`), version-aware
  endpoint (`/offer-parts` ≥3.7 else the deprecated `/reservations`);
  `BookedOfferPartResponse` compliance. `bookings.js` now captures
  `bookedOfferId`.
- **OPT-ANCILLARY** (#125/#126, issue #108) — `10. POST Add Ancillary to
  Booking` (version-aware `/offer-parts` ancillaryOfferIds ≥3.7 else
  `/ancillaries`); plus **offer-time `AncillaryOfferPart` compliance** wired into
  `01. POST Get Offer` (validates id/type/category on offers that carry
  ancillaries — e.g. Sqills; no-op otherwise).
- Optional post-booking steps **chain** in order: Create Booking → [Add
  Reservation] → [Add Ancillary] → PATCH/GET; each gated and guarded against
  re-runs.

### Changed
- Collection bumped **OTST_V2.0.2 → OTST_V2.0.3** to record the above.
- CI/housekeeping (already merged): Dependabot ignores breaking-major bumps
  (uuid/express/eslint/dotenv/node, #111/#120); SonarCloud skips-with-success on
  Dependabot PRs so safe bumps can merge (#121); production-deps minor/patch
  group bumped (#122).

### Operator action
None. Server change picked up after Watchtower promotes :stable (hard-refresh
the Test Config page). Bruno collection refreshes via the refresh-collection
workflow on merge. All new sale-flow steps stay inert until a scenario enables
them via the Test Framework.

---

## [server-v1.11.25] — 2026-05-21

Optional sale-flow features — Tier-1 test-system config (issue #107). Declares
seat-selection capability in the Test Framework and constrains what a scenario
may select. Foundation for #104 (place maps in the sale flow) and #108
(ancillaries). Behaviour-neutral at runtime: the new flags are not consumed by
any request yet.

### Added
- **Test Framework — Seat Selection capability** (`public/js/scenarios.js`,
  `emptyFramework()`): a "Seat map" toggle + a "supported modes" menu
  (`SEATMAP_AT_OFFER` / `ADD_TO_BOOKING`) under a new framework section, with
  plain-language helper text. Persists as `framework.placeSelection
  { seatMap, supportedModes }`.
- **Scenario authoring constraint (Gate 0 → Gate 1)**: the "Booking Flow
  Actions" pills are now gated by the framework — "Place selection" requires a
  reservation ticket type + seat map; "Add/Delete ancillary" require at least
  one declared ancillary. Unsupported actions render disabled with the reason.
- **Per-scenario seat-selection mode picker** (`placeSelectionMode`), limited to
  the framework's supported modes; written into the generated data file and
  validated by `json_validator/datafile.schema.json` (also adds
  `salesFlowActions`).
- **`scenarioParser.resolveSalesFlowActions()`** (tested) centralises the
  booking-flow-action defaults.

### Changed
- **Honest baseline**: the optional booking-flow actions (`placeSelection`,
  `addAncillary`, `deleteAncillary`) now default **OFF** in the runner; existing
  scenarios no longer claim to exercise unimplemented steps. `patchPassengers`
  (the only flag consumed today) and `getBooking` keep their historic default
  (ON), so behaviour is unchanged.
- `scenarioParser` reads `placeSelectionMode`; the var is added to the reset
  lists in `scenarioParser.js` and `opencollection.yml`.

### Operator action
None. Server change picked up after Watchtower promotes :stable (hard-refresh
the Test Config page to see the new Seat Selection section). Bruno collection
refreshes via the refresh-collection workflow on merge.

---

## [server-v1.11.24] — 2026-05-20

Audit P2 (issue #86) — dead-code cleanup (unused vars / imports).

### Changed
- Removed confirmed-dead locals & imports flagged by CodeQL/ESLint
  (`js/unused-local-variable`), behaviour-neutral:
  - **`src/api/routes/`** — dropped unused destructured imports
    (`isPlatformRole`/`isTestManagerOrAbove` in `company-test-framework.js` &
    `company-test-resources.js`; `isTestManagerOrAbove` in `company.js`) and the
    unused `fileHash()` helper in `company.js` (`crypto`/`fs` remain used).
  - **`Bruno_Collection/library-bruno/`** — the unused top-level
    `const x = require('./…')` bindings (`display` in scenarioParser/offers/
    refunds/validators/fulfillments/exchanges; `requestsBuilder` in offers;
    `validators`/`models` in scenarioParser) are now **bare `require('./…')`**
    calls — the binding is gone but the module's side-effect (its
    `Object.assign(globalThis, …)` exposure) is preserved, so engine behaviour
    is unchanged. Also removed a dead `expectedStatuses` local in `bookings.js`.
  - **`public/`** — removed dead `batchStatus` (`dashboard.html`) and `email`
    (`scenarios.js`) locals.

### Note
The ~140 Sonar "auto-fixable" style suggestions (optional chaining, etc.) are
SonarLint *IDE* quick-fixes, not ESLint-fixable — `eslint src/ --fix` is a
no-op on this codebase (already const/quote/semicolon-clean). They are left as
non-blocking advisories. A few unused imports in **test files** were left as-is
(ambiguous identifier, zero runtime impact).

### Operator action
None. Bruno collection refreshes via the refresh-collection workflow on merge.

---

## [server-v1.11.23] — 2026-05-20

Audit P2 (issue #87, security) — remove the hardcoded Benerail credential.

### Security
- **`Bruno_Collection/00-Access Token/Benerail Access Token.yml`** — the
  `jwt-bearer` **`assertion`** (a signed, expiring JWT) and the **`scope`**
  (effectively an account identifier) were hardcoded in the request body, i.e.
  a credential committed in source. They now reference secret env vars
  `{{benerail_assertion}}` / `{{benerail_scope}}`, matching how every other
  vendor's access-token request already sources its secrets via `{{…}}`.
- **`Bruno_Collection/environments/OTST_Benerail_Env.yml`** — declares
  `benerail_assertion` and `benerail_scope` as `secret: true` (name only, no
  value); the actual values live in Bruno's local secret store and are never
  written to the repo — same mechanism as `Ocp-Apim-Subscription-Key`,
  `requestor`, `access_token`.
- Net effect: both committed files are now credential-free, so
  `Benerail Access Token.yml` no longer needs to be excluded from commits.
  (The previously-committed JWT remains in git history and should be allowed
  to lapse / rotated on the Benerail side as hygiene.)

### Operator action
Local Bruno testers of Benerail: set the **secret** env vars
`benerail_assertion` (your current jwt-bearer assertion) and `benerail_scope`
(`uic_osdm`) in the `OTST_Benerail_Env` environment. Bruno keeps secret values
local, so they are not committed/synced. No change for OSCAR-server runs (auth
is handled server-side).

---

## [server-v1.11.22] — 2026-05-20

Audit P2 (issue #88) — fix the CodeQL HIGH file-system race.

### Fixed
- **`Bruno_Collection/library-bruno/reportGenerator.js`** — removed the
  `fs.existsSync(tmpFile)` check before reading/writing the per-run report
  accumulator (CodeQL **HIGH** `js/file-system-race`, a time-of-check-to-
  time-of-use race between the `existsSync` and the later `writeFileSync`).
  The load path now just attempts the read and treats a missing file
  (`ENOENT`) or corrupt JSON as "start fresh" — no pre-check, identical
  behaviour, race eliminated.

### Note
The ~21 `js/unused-local-variable` "note"-severity findings bundled in #88
are deferred to **#86** (the auto-fixable Sonar/eslint sweep): several are
destructured imports where only one identifier is unused, which `eslint --fix`
resolves safely — preferable to hand-editing import lines blind.

### Operator action
None. Bruno collection refreshes via the refresh-collection workflow on merge.

---

## [server-v1.11.21] — 2026-05-20

Audit P1 (issue #84) — Bruno engine: stop swallowing exceptions.

### Fixed
- **`Bruno_Collection/library-bruno/*`** — the 16 `S2486` "ignored exception"
  sites in the scenario engine no longer swallow errors silently. Each now
  **logs** the caught error (so a failure is visible in the run log) while
  preserving the **exact same** control flow / fallback:
  - 9 trailing `try { Object.assign(globalThis, …) } catch {}` module-exposure
    blocks (`envUtils`, `bookings`, `displays`, `exchanges`, `fulfillments`,
    `model`, `offers`, `passengers`, `refunds`) → log on the (near-impossible)
    failure instead of `// no-op`.
  - `envUtils.parseEnvJson` — a throwing `bru.getEnvVar` is logged before the
    fall-back to "unset".
  - `reportGenerator` — an unreadable previous tmp / missing bru context are
    logged.
  - `displays.addReportLog` — a failed report-log accumulation is logged.
  - `offers` preflight — header / body resolution failures are logged.
  - `mergeReport.prettyJson` — now checks whether a value *looks* like JSON
    before parsing, so a plain string is returned as-is instead of routing
    through an expected throw; a genuinely malformed JSON-like value is logged.
  Caller behaviour is unchanged — only error **visibility** improves. The
  existing `bruno-envutils` / `bruno-requestsbuilder` Jest suites still pass
  (the changed paths preserve their outputs). Completes the second half of #84
  (the `JSON.parse` hardening shipped in v1.11.18 / #91).
- **Clearer data-load failures** — when the data file can't be loaded,
  `getScenarioData` (network / HTTP / non-absolute `data_base`) and the
  `parseEnvJson` "required scenario variable … not set" message now name the
  `data_base` URL and suggest checking that the **data-file server is running**
  (e.g. `python -m http.server 8000` in `Bruno_Collection/data_base`). Reported
  from running the collection locally in the Bruno UI, where a failed data load
  previously surfaced only as the downstream "offerPassengerSpecifications not
  set" symptom.

### Operator action
None. Bruno collection refreshes via the refresh-collection workflow on merge.

---

## [server-v1.11.20] — 2026-05-20

Run-control — dashboard / admin **Emergency Stop**.

### Added
- **"🛑 Emergency Stop"** — a force-stop for active runs, for when a run goes
  nowhere and you don't want to wait out `RUN_TIMEOUT_MS` or hand-edit the DB.
  `POST /v1/runs/stop-all` (`src/api/routes/runs.js`):
  - `QUEUED` runs are purged from the in-memory queue (`queue.purge`) so the
    next drain can't launch them, then marked `CANCELLED`.
  - `RUNNING` runs have their Bruno child process killed —
    `runner.killRun()` sends `SIGTERM`, then `SIGKILL` after a 3 s grace —
    then marked `CANCELLED`. The runner's final status write is now guarded
    with `AND status = 'RUNNING'` so a killed run can't be resurrected from
    `CANCELLED` to `FAILED`.
  - **Scope is deliberately restrictive — only the platform admin can stop
    other users' runs:** `company_user` **and** `test_manager` stop only the
    runs **they personally launched** (red button on the dashboard Company
    Queue panel); `administrator` stops **ALL active runs across every company**
    (platform-wide, from a new control in the admin console → Server Config);
    `certification_user` is forbidden (403). Confirmation dialog + audit-logged.
  - Covered by `tests/integration/runs-stop-all.test.js` (401 / 403 / tester
    own-only / test_manager own-only / admin platform-wide cross-company /
    terminal-untouched / no-op).

### Operator action
None. After Watchtower promotes `:stable` (hard-refresh to pick up the UI): a
per-user **Emergency Stop** button appears on the dashboard Company Queue panel
when there are active runs; administrators get a separate **platform-wide**
"Stop ALL running scenarios" control in the admin console → Server Config.

---

## [server-v1.11.19] — 2026-05-20

Operational hardening — orphaned-run reconciliation on startup.

### Fixed
- **`Oscar_Server/src/worker/reconcile.js`** (new) + boot hook in
  `src/server.js` — on startup, any run still `RUNNING` or `QUEUED` in the DB
  is marked `FAILED`. The run queue (`worker/queue.js`) is an **in-memory**
  singleton, so when the process exits — a Watchtower deploy promoting
  `:stable`, a crash, the `RUN_TIMEOUT_MS` SIGTERM, or `docker restart` — every
  in-flight / pending job is lost, but the DB rows survive. Nothing ever
  advances them again: `RUNNING` rows stay `RUNNING` (their Bruno child is
  gone) and `QUEUED` rows are never dispatched (the in-memory queue is empty on
  boot). Both keep occupying the company's concurrency slots, so the **Company
  Queue wedges at its limit and no new run can start**. Observed live: a release
  auto-deployed mid-batch left 4 orphaned `RUNNING` rows pinning all 4 slots
  with 2 `QUEUED` runs unable to start. The boot reconciliation frees the slots
  and makes the dashboard reflect reality.
  - `RUNNING` → `FAILED` (process gone — unresumable).
  - `QUEUED` → `FAILED` (require resubmit). Auto-re-dispatch was **deliberately
    not** chosen: re-running would fire vendor API calls unattended after every
    deploy, possibly with stale tokens.
  - Idempotent; runs synchronously after migrations and before `app.listen`,
    so it can only ever act on genuine orphans (the queue holds nothing yet).
  - Covered by `tests/unit/reconcile.test.js` (injected-`run` unit tests +
    a real-schema test proving terminal runs are untouched and the pass is
    idempotent).

### Operator action
None. After Watchtower promotes `:stable`, any runs that were stuck `RUNNING`/
`QUEUED` from a prior restart will show as `FAILED` ("interrupted by a server
restart") and can be deleted normally; resubmit if still needed.

---

## [server-v1.11.18] — 2026-05-20

Audit P1 (issue #84) — Bruno scenario-engine error-handling hardening.

> Numbering note: assumes #90 (1.11.17 / release-2026.45) merges first.

### Fixed
- **`Bruno_Collection/library-bruno/envUtils.js`** (new) — exports
  `parseEnvJson(name[, fallback])`, a safe accessor for the scenario env
  vars set by `getScenarioData()`. The **17** `JSON.parse(bru.getEnvVar(...))`
  sites in `requestsBuilder.js` (15), `loopback.js` (1) and `offers.js` (1)
  now use it. Previously a missing/empty variable became
  `JSON.parse(undefined)` → *"Unexpected token u in JSON at position 0"*
  with no hint which variable or why (the exact cryptic failure hit when
  running a vendor locally). Now it throws an **actionable** error naming
  the variable and the likely cause (data file didn't load / no matching
  data set); malformed JSON names the variable plus a value snippet.
  - Happy path unchanged (valid JSON parses identically).
  - Required vs optional preserved: `parseEnvJson(x)` (required) vs
    `parseEnvJson(x, [])` (the old `|| '[]'` default).

### Deferred (still part of #84)
- The broader `S2486` swallowed-exception cleanup (~30 sites) is held back
  to land with the `library-bruno` Jest harness (#85), so the changes can
  be verified rather than shipped blind into a layer with no tests.

### Operator action
None. Bruno collection refreshes via the refresh-collection workflow on
merge.

---

## [server-v1.11.17] — 2026-05-20

Audit P0 follow-up (issue #82).

### Fixed
- `Oscar_Server/public/js/scenarios.js` — hardened the `esc()` HTML-entity
  encoder to also escape single quotes (`'` → `&#39;`), so interpolated
  values are safe in single-quoted attributes too (not just double-quoted
  attributes and text content). Defense-in-depth.

### Note — the 3 Sonar S5696 "DOM-XSS" BLOCKERs are false positives
Every value interpolated into `innerHTML` in `scenarios.js` already passes
through `esc()` (a correct HTML-entity encoder); composed fragments
(`ownerBadge`, `versionBadge`, `scenarioTypeBadge`) are themselves `esc()`'d
or static. Sonar's taint engine does not recognise the custom `esc()` as a
sanitiser, so it flags the sinks. These should be marked **Safe** in
SonarCloud with that justification (issue #82). No exploitable XSS exists.

### Operator action
None. Picked up after Watchtower promotes `:stable`; hard-refresh the Test
Config page.

---

## [server-v1.11.16] — 2026-05-20

Follow-up to v1.11.15. The per-report sharing feature shipped, but two
small follow-ups were committed minutes **after** #77 had already been
squash-merged, so they missed that release. This ships them.

### Fixed
- `Oscar_Server/public/dashboard.html` — clicking **Share with
  certifiers** / **Unshare** now updates just that run's share line **in
  place** (via `shareLineFor()` + a stable `data-share-line` anchor)
  instead of calling `loadRuns()`. The full re-render collapsed any
  expanded batches and jumped the scroll to the top — reported as "the
  dashboard collapses when I click share". `loadRuns()` remains only as
  a fallback when the row isn't in the DOM.

### Added
- The **"per-report certifier sharing"** news entry that was meant to
  ship with v1.11.15.

### Operator action
None. Picked up after Watchtower promotes `:stable`; hard-refresh the
dashboard.

---

## [server-v1.11.15] — 2026-05-20

Certifier report sharing is now **per-report**, decided by the
**test_manager** from the **dashboard** — replacing the company-wide
all-or-nothing toggle that lived in API Config.

> Numbering note: assumes #76 (1.11.14 / release-2026.42, auth
> rate-limit) merges first. If the order differs, renumber accordingly.

### Added
- **Dashboard per-run share control (test_manager only).** Each
  terminal-status run row now shows a **"Share with certifiers" /
  "Unshare"** link and, when shared, a green **"✓ Shared with
  certifiers"** badge (visible read-only to all roles). Wired to the
  existing `POST`/`DELETE /v1/runs/:id/share`. `Oscar_Server/public/dashboard.html`.

### Changed
- **Per-report sharing is now the SOLE certifier-visibility gate.** A
  run is visible to a certifier iff `shared_with_certifier_at IS NOT
  NULL`. Applied consistently in:
  - `api/helpers/run-access.js` (single-run access)
  - `api/routes/runs.js` (certifier list)
  - `api/routes/reports.js` (comparisons — **both** underlying runs must
    be shared, else the comparison stays hidden)
  - `api/middleware/tenant.js` (no longer refuses a certifier at the
    company boundary — they simply see only shared runs)
- The list endpoint now returns `shared_with_certifier_at` /
  `shared_with_certifier_by` to the dashboard so it can render badge +
  control.

### Removed
- **The company-wide `share_reports_with_certifier` toggle** — gone from
  the API Config UI (`profile.html`) and from `company.js`
  (GET no longer returns it; PATCH rejects it with a 400 + pointer to
  the per-report model). The dead `companyShareWithCertifier()` helper
  in `shared.js` was removed. The `companies.share_reports_with_certifier`
  DB column is **retained** (no destructive migration) but unused.

### ⚠️ Behaviour change for operators
Reports that were visible to certifiers **only** because the old company
toggle was ON are now **private until a test_manager explicitly shares
them**. The per-run share flag (`shared_with_certifier_at`) is unchanged,
so anything previously shared per-run stays shared. Worth a heads-up to
test_managers: "decide which reports to share, from the dashboard."

### Operator action
None mechanical. Picked up after Watchtower promotes `:stable`;
hard-refresh the dashboard. See the behaviour-change note above.

---

## [server-v1.11.14] — 2026-05-20

Login rate-limiter tuning. A tester hit "Too many attempts. Please try
again later." after ~10 login/logout cycles while switching between
vendor accounts — legitimate use on a conformance-testing platform, not
an attack.

> Numbering note: assumes #75 (server 1.11.13 / release-2026.41) merges
> first. If the merge order is reversed, renumber to 1.11.13 / 2026.41.

### Root cause
`authLimiter` in `Oscar_Server/src/api/routes/auth.js` allowed 20
requests per 15-minute window, keyed on IP, and the bucket was **shared**
across `/login`, `/register`, `/bootstrap` **and `/logout`**. Each
"switch user" is two requests (logout + login), so ~10 switches = 20
requests = the cap.

### Fixed
- Removed `/logout` from `authLimiter`. Logout carries no credential to
  brute-force (it just revokes the caller's own session); counting it
  halved the usable login budget during rapid switching.
- Raised the default cap 20 → 50 per 15-minute window, and made it
  env-tunable via `AUTH_RATE_LIMIT_MAX`. 50/15min is still far below a
  useful brute-force rate. `/login`, `/register`, `/bootstrap` remain
  rate-limited.

### Operator action
None required. Optional: set `AUTH_RATE_LIMIT_MAX=<n>` in
`OSCAR_Deploy/.env` to override the default of 50. Picked up after
Watchtower promotes `:stable`. To clear an active lockout immediately,
`docker compose restart oscar` (the limiter uses the in-memory store).

---

## [server-v1.11.13] — 2026-05-20

A bundle of follow-ups from the post-incident audit: tester report
visibility, a full timezone-handling sanity pass, the Grafana
false-positive fix, and Bruno env-file cleanup.

### Fixed — tester report visibility (security)
- `Oscar_Server/src/api/routes/runs.js` (`GET /v1/runs`) — a plain
  tester (`company_user`) now sees **only their own runs**, not every
  run in their company. `test_manager` and `administrator` keep
  company-wide visibility (they triage and may delete any run).
  Previously the tester list was company-scoped while delete was
  own-only, which leaked who-ran-what across the team and produced the
  confusing "Not the run owner" toast when a tester tried to delete a
  teammate's run.

### Fixed — timezone handling (full sanity pass after #67)
Background: v1.11.6 (#67) gave the `oscar` container `TZ=Europe/Paris`
(was UTC). The audit checked storage, server-side parsing, frontend
display, and Bruno.

- **Storage** — verified consistently UTC (`datetime('now')` is UTC;
  `.toISOString()` is UTC+Z; no `'localtime'` modifier anywhere). No
  change needed.
- **Server bug** — `isRunStale()` in `runs.js` parsed SQLite's TZ-less
  `started_at` with `new Date()`, which under `TZ=Europe/Paris` was
  read as Paris-local. A run started minutes ago looked 1–2h old and
  got auto-cancelled when someone tried to delete a fresh QUEUED/RUNNING
  run. Now parsed as UTC via a local `parseUtcTs()` helper.
- **Frontend** — `nav.js` gains `parseServerTs()`, which normalises
  TZ-less UTC strings to ISO+Z so the browser localises correctly to
  each viewer. Every timestamp render site now uses it:
  `dashboard.html`, `run-detail.html`, `compare.html`,
  `report-builder.html`, `run.html`, `admin.html`, `js/scenarios.js`.
  `run-detail.html` previously used an ad-hoc `+ 'Z'` hack — replaced
  with `parseServerTs`. (This is the same helper whose caller leaked
  prematurely in v1.11.11 and was reverted in v1.11.12; it now ships
  **together with its nav.js definition** as a single unit.)
- **Bruno** — `toOffsetDateTime`/`toLocalDateTime` and the
  departure-date calc in `scenarioParser.js` operate on data-file
  payloads (OSDM request formatting), not server timestamps — audited,
  correct, unchanged.

Storage stays UTC throughout; only display localises.

### Fixed — Grafana false positives
- `OSCAR_Deploy/grafana/dashboards/oscar-logs.json` — the "Errors in
  range" and "Errors only" panels now exclude
  `oscar-grafana|oscar-prometheus|oscar-loki|oscar-promtail|oscar-alertmanager`.
  They were matching Grafana's own `tsdb.loki` query logs (which embed
  the literal `error|fatal|panic` LogQL pattern), producing
  self-referential noise.

### Chore — Bruno env-file cleanup
- `OTST_Paxone_Env.yml`, `OTST_Turnit_Env.yml` — stripped
  accidentally-committed Bruno session-state vars (`__loopback`,
  `__unitaryLoadedIdx`, `OfferCollectionRequest`, passenger/trip state,
  etc.). Followup to 2026.39, which fixed only their data-file paths.
  Both are now config-only templates matching Benerail/Sqills; Paxone's
  stray pinned `scenarioTarget` was reset to empty.

### Operator action
None. Server change picked up after Watchtower promotes `:stable`
(hard-refresh the dashboard). Bruno collection + Grafana dashboards
refresh automatically on merge.

---

## [server-v1.11.12] — 2026-05-20

Critical hotfix: the dashboard was stuck on **"Loading…"** for every role
in v1.11.11 (#73).

### Root cause
`fmtDate()` in `public/dashboard.html` was calling `parseServerTs()` — a
timezone-normalisation helper that lives on the **unmerged**
`fix/v1.11.7-frontend-timestamp-tz` branch and is **not defined** in the
nav.js that actually shipped. The call leaked into #73 from an
uncommitted working-tree edit (the file was `git add`-ed while that WIP
was present). `fmtDate()` runs for every run row and batch header, so
`renderRuns()` threw `ReferenceError: parseServerTs is not defined`
before it set `el.innerHTML`. Because `loadRuns()` has no `try/catch`,
the `runs-list` placeholder was never replaced — hence the perpetual
"Loading…".

### Fixed
- `Oscar_Server/public/dashboard.html` — reverted `fmtDate()` to
  `new Date(d).toLocaleString(...)`. The dashboard renders again for all
  roles. The minor pre-v1.11.7 quirk (SQLite's TZ-less timestamps read
  as local instead of UTC) returns, and will be fixed properly when the
  v1.11.7 branch — which ships `parseServerTs` in `nav.js` alongside its
  callers — merges as a single unit.

### Lesson / guard for next time
This is the second issue caused by editing files that already had
unrelated uncommitted changes in the working tree. When committing for a
focused PR, diff each touched file against the base branch (not just
`git add` it) to confirm only the intended hunks are staged.

### Operator action
None. Watchtower picks up `:stable` after the image rebuild; hard-refresh
the dashboard once it's live.

---

## [server-v1.11.11] — 2026-05-19

Two small UX-and-config polish items, both surfaced by hands-on testing
this evening. Neither is in the same regression chain as
v1.11.10 (PR #72) — that PR fixes the actual scenario loop. These are
the cleanup items that came out of the audit.

> Numbering note: this PR pre-bumps to 1.11.11 / release-2026.39 on the
> assumption that #72 (v1.11.10 / release-2026.38) lands first. If the
> merge order is reversed, the maintainer should bump this down to
> 1.11.10 / release-2026.38.

### Fixed
- **`Oscar_Server/public/dashboard.html`** — dashboard now shows the
  submitter email on every run row and every batch-header for **every**
  role, with a small "(you)" badge next to the current user's own runs.
  Previously the subtitle was hidden from testers under the comment
  *"testers see only their own runs, so the subtitle would be redundant"*
  — but the tester branch of the list endpoint
  (`runs.js` `GET /v1/runs`) is scoped by `r.company_id`, not by
  `r.user_id`. Testers therefore did see teammates' runs, with no way
  to tell whose run was whose, then clicked Delete and got a confusing
  *"Not the run owner"* toast from the bulk-delete endpoint at
  `runs.js:415`.

- **`Oscar_Server/public/dashboard.html`** — per-row and per-batch
  delete checkboxes are now **disabled** for runs the current user is
  not authorised to delete (i.e. they're not the run owner and they're
  not a `test_manager` / `administrator`). Disabled checkboxes carry a
  tooltip naming the actual owner. Backend authorisation rule is
  unchanged; this is purely a frontend cue so the impossible action
  isn't presented as available.

- **All five vendor environment files** — repaired stale local-dev
  `data_base` and `json_schema` URLs across
  `OTST_Benerail_Env.yml`, `OTST_Bileto_Env.yml`, `OTST_Paxone_Env.yml`,
  `OTST_Sqills_Env.yml`, `OTST_Turnit_Env.yml`. Four of them still
  pointed at the pre-PR-#68 external-repo convention
  (`http://localhost:8080/collections-bruno/OTST_V2.0.1/...`), and
  Turnit had a non-matching `Bruno_Collection/` URL prefix. All five
  now follow the same
  `http://localhost:8080/data_base/<vendor>_datafile.json` pattern
  (Chaps was already on this convention and is unchanged). Local-dev
  workflow: `cd Bruno_Collection && python -m http.server 8080`.
  Production OSCAR runs are not affected — the worker's ephemeral env
  file overrides `data_base` with its internal
  `http://localhost:3001/data/...` URL.

### Chore
- **`Bruno_Collection/environments/OTST_Sqills_Env.yml`** — removed
  accidentally-committed Bruno session-state vars (`__reportInitDone`,
  `productListHasValidData`, `productListCandidateIds`). Bruno auto-writes
  these to the env file as a side effect of running requests; they
  belong in the developer's local working copy, not in `main`. The
  same cruft is present in OTST_Paxone_Env.yml and OTST_Turnit_Env.yml
  and is flagged for a follow-up cleanup PR (deferred here to keep this
  diff scoped).

### Not addressed in this PR (deliberate)
- The list endpoint's scoping inconsistency (company-wide visibility +
  per-user delete) was kept as-is — there's a reasonable case that
  testers *should* see teammates' runs (read-only audit). This PR only
  surfaces the constraint in the UI; tightening or relaxing the
  underlying authorisation is a product decision for the
  test_manager / administrator roles.

### Operator action
None. Watchtower picks up `:stable` after the image is rebuilt. Bruno
collection refreshes automatically via the refresh-collection workflow.
Dashboard change is in `public/`, so hard-refresh the dashboard page
once the new image is live.

---

## [server-v1.11.10] — 2026-05-19

Final hotfix in the #68 ("Merge Bruno Lib") regression chain. #70 prevented
the immediate `stopExecution()` halt; #71 fixed two report-side bugs that
were latent and surfaced this week. Neither addressed the underlying loop:
a 1-scenario run of `OTST_RFND_PATCH_SRCH_CRIT_1ADT_1LEG` against Sqills
executed the same scenario **27 times in ~3 minutes** before being killed
by `RUN_TIMEOUT_MS` (or manual cancel), with the terminal-step
`stopExecution()` **never** firing. That is also what was breaking the
`.bru_results_<runId>.json` artifact download — Bruno CLI was being
SIGTERM'd before it could flush its `--reporter-json` output.

### Root cause (short)
1. `Bruno_Collection/opencollection.yml`'s PR68 unitary-load wrapper re-fires
   on every non-`/versions` request in an OSCAR collection run, because
   `__unitaryLoadedIdx` is never synchronised when `/versions` (or the
   loop-back in `01. POST Get Offer`) consumes a scenario via
   `parseScenarioData()`.
2. The same wrapper's sequential-mode post-load branch wraps
   `scenariosToRunIndex` back to `0` whenever it equals
   `__scenariosList.length`. The terminal `.bru` steps and
   `loopback.js` decide between loop-back and stop by comparing
   `scenariosToRunIndex < __scenariosList.length` — which is now
   permanently true. The intended one-shot halt becomes an infinite loop.

#70's defensive clamp landed in the same wrapper. It prevented the
immediate `stopExecution()` halt by resetting the index from `length` to
`0` before `getScenarioData()`, but `getScenarioData()` then advanced
the index back to `length`, and the wrap-to-0 fired anyway — so the
clamp + wrap together converted "halt at request 3" into "loop forever".

#71's two fixes were correct in scope but addressed downstream symptoms:
`mergeReport.js` iteration-wrapper unwrap and `reportGenerator.js`
loop-back tmp-file preservation. Neither changed the runner's
termination condition.

### Fixed
- `Bruno_Collection/library-bruno/scenarioParser.js` —
  `parseScenarioData()`'s sequential-mode branch now sets
  `__unitaryLoadedIdx` to the post-advance value of `scenariosToRunIndex`
  immediately after advancing it. The wrapper's reload condition
  (`_lastUnitaryIdx !== _idxNow`) now evaluates to false on requests
  #2..N of the same scenario iteration, so the wrapper no longer fires
  spuriously in OSCAR collection mode.
- `Bruno_Collection/opencollection.yml` — removed the wrap-to-0 branch in
  the unitary-load wrapper's sequential-mode post-load block. Letting
  `scenariosToRunIndex` grow past `__scenariosList.length` is required
  for the terminal `.bru` steps (e.g. `14. GET Booking after Patch
  Refund.yml` lines 67–74) and for `loopback.js` to call
  `stopExecution()`. The "wrap so the next manual Send re-starts at 0"
  unitary-UI affordance can be reintroduced later, but only with a
  guard that distinguishes OSCAR-driven runs from Bruno-UI single-send
  runs.

### Side effect (recovered functionality)
- `.bru_results_<runId>.json` artifact download in the run-detail page
  works again. Bruno CLI now exits normally instead of being SIGTERM'd
  by `RUN_TIMEOUT_MS`, so its `--reporter-json` writer reaches its
  end-of-run flush. The `if (await fsExists(bruJsonAbsPath))` block in
  `Oscar_Server/src/worker/runner.js:762` now finds the file and
  registers the `json_results` artifact row.

### Verified against
The `run-d96e282e-logs.txt` capture supplied by the operator:
- 27 `scenariosToRun [1/1]` lines (pre-fix) → expected 1 (post-fix).
- 26 `REFUND+PATCH complete — looping` lines (pre-fix) → expected 0
  (post-fix; terminal step calls `stopExecution()` instead).
- 27 `Loading scenario for unitary run` lines (pre-fix; wrapper firing
  per request) → expected 0 (post-fix; wrapper no longer triggers in
  OSCAR mode).

### Documentation
- New: `Documentation/Bruno_Collection/PR68-loop-regression-root-cause.md`
  — full forensic trace + reproduction notes + suggested follow-ups for
  the original PR68 author.

### Unrelated (mentioned for completeness)
- Bileto `POST /api/offers` is returning HTTP 500 after ~42 s with a
  generic Spring Boot error body. This is an **upstream** problem at
  `osdm-5.platform.bileto.zone`; not in OSCAR's runtime path and not
  caused by #68. Worth pinging Bileto operators separately.

### Operator action
None. Bruno collection refreshes automatically via the
refresh-collection workflow on merge; testers see the fix on their next
run. Watchtower picks up `:stable` after the image is rebuilt.

---

## [server-v1.11.9] — 2026-05-19

Two report-side fixes in the Bruno library. Both bugs are pre-existing
latent issues — neither is caused by #68's content (audited: the merge
commit touches zero lines of report code) — but they only began surfacing
this week:

- The first surfaced because Bileto's `/offers` is currently returning
  500, triggering the Bruno loop-back retry path that exposes the latent
  `initReport()` wipe behaviour.
- The second surfaced because #69's Docker rebuild pulled a fresher
  `@usebruno/cli` whose `--reporter-json` output uses the iteration-array
  wrapper. The OSCAR server's `structureResults.js` was already prepared
  for that shape; `mergeReport.js` was not.

### Fixed
- `Bruno_Collection/library-bruno/reportGenerator.js`: `initReport()`
  now reads the existing `.report_tmp.json`'s `meta.scenarioCode` and
  compares it with the current `bru.getEnvVar('scenarioCode')` before
  unlinking. If they match (loop-back retry of the same scenario), the
  tmp file is preserved so accumulated System Information requests and
  earlier attempts of the failing OSDM call remain in the final HTML
  report. For genuinely new scenarios starting in a multi-scenario
  sequential run, codes differ and the clear still happens —
  preserving the original between-scenarios reset behaviour.
- `Bruno_Collection/library-bruno/mergeReport.js`: detect Bruno CLI's
  iteration-array wrapper (`[{ iterationIndex, results, summary }]`)
  before falling back to the legacy `Array.isArray(bruRaw)` /
  `bruRaw.results` / `bruRaw.testResults` chain. Without this, every
  merged report rendered as "1 request | 0 assertions" because the
  iteration object was being mapped as if it were a single request.

### Operator action
None. Bruno collection refreshes via the refresh-collection workflow
on merge; the next run will use the fixed scripts.

### Verified against
The Bileto run captured in the failure report (System Info: 11 requests,
POST `/offers` × 2 attempts, loop-back retry triggered between them). With
the fix, the final HTML report contains all 11 System Information rows
plus both `/offers` attempts — instead of just the retry attempt.

---

## [server-v1.11.8] — 2026-05-19

Runtime hotfix for a regression introduced by #68 ("Merge Bruno Lib").
Bruno runs on Bileto and Sqills silently truncated after the second
request (`/coach-deck-layouts`): every subsequent request in the
scenario was skipped. No error banner, no failed assertion — the
run just stopped, with only the two System Information requests
showing up in the HTML report.

### Root cause
The new unitary-run wrapper in `Bruno_Collection/opencollection.yml`
calls `getScenarioData()` whenever `scenariosToRunIndex` differs from
`__unitaryLoadedIdx`. On the first non-`/versions` request of a fresh
session, `__unitaryLoadedIdx` is empty and `scenariosToRunIndex` is
already at the end of `__scenariosList` (the `/versions` handler just
advanced it for a one-scenario list). Inside `getScenarioData()`,
`scenarioParser.js` sees `idx >= effectiveList.length` and calls
`bru.runner.stopExecution()` — halting the runner before request 3
fires. The pre-#68 wrapper avoided this by forcibly setting
`scenariosToRunIndex` to `'0'` before the load; the rewrite removed
that guard.

### Fixed
- `Bruno_Collection/opencollection.yml`: inside the unitary-load
  branch (`_needsLoad === true`, sequential mode), clamp
  `scenariosToRunIndex` to `0` when it is at or past the length of
  `__scenariosList` before calling `getScenarioData()`. The clamp is
  skipped in `scenarioTarget` mode (which looks up by name/explicit
  index and doesn't depend on `scenariosToRunIndex` being in-range).

### Operator action
None. Watchtower picks up `:stable` automatically. The Bruno
collection ships from this repo via the refresh-collection workflow
on merge, so testers see the fix on their next run with no manual
deploy.

---

## [server-v1.11.7] — 2026-05-19

Security hotfix for three Debian base-image CVEs that Trivy started
flagging after 2026-05-16 (when the previous image was last built).
None are reachable in OSCAR's runtime path — they're OS-level libraries
linked by node:22-slim — but Trivy gates the CI pipeline on HIGH/CRITICAL
findings, so every PR opened after the Debian security tracker updated
was being blocked.

### Fixed
- `Oscar_Server/Dockerfile`: runtime stage now runs `apt-get update &&
  apt-get upgrade -y` before installing Bruno CLI. Pulls in the
  Debian 12 point releases that fix:
  - **CVE-2026-0861** — glibc (`libc-bin`, `libc6`) integer overflow in
    `memalign` → heap corruption. Fixed in `2.36-9+deb12u14`.
  - **CVE-2026-4878** — `libcap2` TOCTOU race → privilege escalation.
    Fixed in `1:2.66-4+deb12u3`.
  - **CVE-2026-29111** — `systemd` (`libsystemd0`) arbitrary code
    execution / DoS. Fixed in `252.39-1~deb12u2`.
  Together with the two already-vendored fixes (axios CVEs in Bruno
  CLI, picomatch ReDoS via npm strip), Trivy now reports 0 HIGH and
  0 CRITICAL on the published image.

### Operator action
None. Watchtower picks up `:stable` automatically once `promote-release`
republishes the image after this PR merges and the `release-2026.35`
tag fires.

---

## [server-v1.11.6] — 2026-05-16

Stack-wide timezone alignment. OSCAR's canonical deployment runs in
Europe/Paris, but every container in the compose stack was using its
image-default timezone — usually UTC. Result: log lines, audit entries,
email "Sent at" headers, and run timestamps all read in UTC, which is
correct for storage but inconvenient for operators reading dashboards
in real time.

### Changed
- `OSCAR_Deploy/docker-compose.yml`: `oscar`, `autoheal`, `watchtower`
  services now set `TZ: ${OSCAR_TZ:-Europe/Paris}`. The autoheal and
  watchtower services were previously hardcoded to UTC; flipped.
- `OSCAR_Deploy/docker-compose.metrics.yml`: `prometheus`,
  `alertmanager`, `grafana`, `loki`, `promtail` likewise. Grafana
  additionally gets `GF_DATE_FORMATS_DEFAULT_TIMEZONE=browser` so
  dashboards default to the viewer's local clock.
- `OSCAR_Deploy/.env.example`: new `OSCAR_TZ` variable, documented
  with IANA zone examples.

Storage is unchanged — every timestamp in SQLite / artifact JSON /
audit log stays UTC ISO-8601, as it always has. Only the wall-clock
the processes see (and therefore the log line prefixes Pino / Loki
emit) changes.

### Operator action
After pulling the latest `OSCAR_Deploy/`:

```bash
cd /opt/OSCAR
git pull
docker compose -f OSCAR_Deploy/docker-compose.yml \
               -f OSCAR_Deploy/docker-compose.metrics.yml up -d
```

The `up -d` will recreate containers whose env vars changed (all eight
of them). To override the default, add `OSCAR_TZ=America/New_York` (or
any IANA zone) to `OSCAR_Deploy/.env` before the `up -d`.

---

## [server-v1.11.5] — 2026-05-16

Hotfix for a critical Phase 2 (issue #60) follow-up bug: three file-reader
code paths were missed during the v1.11.0 at-rest encryption rollout and
were still reading OSCAR1-encrypted artifacts directly into `JSON.parse`.
Reported by a Paxone tester after the first run worked, the test config
was saved, and the second run failed with
`Could not parse data file: Unexpected token 'O', "OSCAR1b8mF"... is not valid JSON`.

### Fixed
- **`src/api/routes/runs.js`** (parallel-mode datafile loader, ~line 173).
  The runs endpoint loaded the company's datafile via
  `JSON.parse(fs.readFileSync(company.datafile_path))`. Since v1.11.0
  the datafile is AES-256-GCM encrypted with the OSCAR1 envelope on
  disk, so the raw ciphertext was being fed to the JSON parser. Now
  goes through `utils/at-rest.decryptFromFile()`.
- **`src/reports/diff.js`** (Bruno results comparison, ~line 52). Same
  pattern — `JSON.parse(fs.readFileSync(.bru_results.json))` against an
  encrypted artifact. Replaced with `decryptFromFile`. This was the
  failure mode for the "compare two runs" dashboard action.
- **`src/reports/structureResults.js`** (Bruno raw results parser,
  ~line 255). Same pattern, same fix. This was the failure mode for
  rendering an individual run's structured report after v1.11.0.

The `decryptFromFile` helper transparently handles both
OSCAR1-encrypted files (post-v1.11.0) and legacy plaintext files
(pre-v1.11.0 backfill fall-through), so no data migration is needed.

### Operator action
None. Watchtower picks up `:stable` automatically.

---

## [server-v1.11.4] — 2026-05-16

Tiny follow-up to v1.11.3 — the submitter subtitle now also appears on
the **collapsed batch header**, not just on the expanded per-run rows.

### Fixed
- Dashboard batch headers (`Batch 16/05/2026 05:21 (7 scenarios)`)
  now carry a `👤 submitter@company` subtitle for test_manager +
  administrator viewers. Within a batch every run is submitted by
  the same user, so the header pulls `submitted_by` from the first
  child. Before this fix, you had to expand the batch to find out
  who launched it.

---

## [server-v1.11.3] — 2026-05-15

Dashboard UX adjustments that fall out of the issue #60 access-control
restructure. Test managers are the data owners for their company; the UI
now reflects that.

### Added
- **Submitter shown on dashboard** for `test_manager` and `administrator`
  roles. Renders as a small `👤 email@vendor` subtitle under each run's
  environment label. Lets a test manager see at a glance which of their
  testers kicked off each run when triaging failures or reviewing the
  queue. Testers see only their own runs so the subtitle is omitted for
  them (no redundant data).

### Changed
- **Test manager's delete is now a permanent delete** (status `DELETED`)
  instead of `DELETION_REQUESTED`. Affects both the single-run delete
  endpoint and the bulk-delete endpoint. Rationale: since v1.10.0 the
  administrator role no longer reads vendor data, so the
  soft-delete → admin-review → permanent-delete flow doesn't apply for
  intra-company cleanups. Test managers are the data owners for their
  company and decide directly. Testers still get `DELETION_REQUESTED`
  (the soft-delete safety net) since they may click by accident.
- **Delete confirmation modal is role-aware**. Test managers see a
  ⚠️ warning that the deletion is permanent and cannot be undone, with
  the confirm button labelled "Permanently Delete". Testers continue to
  see the soft-delete language ("queued for your Test Manager to
  review"). Administrators see the flagging language.

### Operator action
None. Dashboard UI change picks up on next page reload (hard-refresh
with Ctrl+Shift+R if browser cached). Existing pending
`DELETION_REQUESTED` runs remain in the administrator's lifecycle
queue.

---

## [server-v1.11.2] — 2026-05-15

Docs-only. Ships Phase 3 of issue #60 — the operational policy that
closes the part of "vendor data sovereignty" that software cannot
enforce on its own.

### Added
- **`Documentation/Server_Operations/OSCAR - Security Operations Policy.md`**
  — the policy document that defines:
  - Access tiers (Tier A platform operator with root SSH; Tier B
    OSCAR administrator; Tier C certification reviewer)
  - Strict separation rule — a person with Tier A access must not
    hold Tier B/C on the same identity
  - Key management inventory + rotation procedures for all four
    long-lived secrets (`ENCRYPTION_KEY`, `JWT_SECRET`,
    `PLATFORM_BOOTSTRAP_TOKEN`, Brevo SMTP key)
  - Backup policy: daily snapshots, 14-day rolling retention,
    quarterly cold archives, GPG-encrypted backup tarballs
  - SEV-1 → SEV-4 severity levels and target response times
  - SEV-1 incident playbook (with the verified commands that worked
    during the 2026-05-15 v19 outage)
  - Procedure when a vendor reports a data-leak suspicion
  - Periodic review cadence (weekly to yearly) with explicit owners
  - Known operational risks NOT closed by code, with mitigations
  - A worked example of the 2026-05-15 v19 migration outage —
    timeline, what worked, what didn't, four concrete action items
  - Reading guide mapping situations to docs

### Changed
- **Admin Guide § 15.5** — Phase 3 marker flipped from ⏳ to ✅;
  cross-reference to the policy doc added.

### Operator action
None. Docs-only. Watchtower picks up v1.11.2 and the recreate is a
no-op against the running v1.11.1 schema state.

### Status of issue #60
| Phase | Status |
|---|---|
| 1 — Application-level access control + per-run sharing | ✅ v1.10.0 |
| 2 — At-rest encryption (DB columns + artifact files) | ✅ v1.11.0 + v1.11.1 hotfix |
| 3 — Operational policy | ✅ v1.11.2 (this) |

Issue #60 closeable.

---

## [server-v1.11.1] — 2026-05-15

Critical hotfix. v1.11.0 shipped with a broken v19 migration that crashed
OSCAR on first boot, leaving production in a restart loop. Recovery was
pinning to the previous (`:edge`) image while this fix was prepared.

### Fixed
- **v19 migration crash** — `Provided value cannot be bound to SQLite
  parameter 2`. The migration ran `SELECT rowid, ... FROM <table>` and
  then `UPDATE ... WHERE rowid = ?`, but Node 22's built-in
  `node:sqlite` (DatabaseSync) does not surface `rowid` as a row
  property when SELECTed without an explicit alias — `r.rowid` came
  back `undefined` and the bind failed. Switched to the explicit `id`
  primary key, which exists on all four affected tables
  (`run_events`, `run_requests`, `test_frameworks`, `test_resources`).
- **Per-row error isolation** added to v19 — a single unbindable row
  (corrupt data, oversized payload, etc.) no longer aborts the whole
  table's migration. The offending row is left plaintext and gets
  encrypted on its next natural write via `colEncrypt`. Counts logged
  for operator visibility.

### Migration
Schema migration v18 was already applied during the failed v1.11.0
boot (ALTER TABLE ADD COLUMN is durable across crashes), so v1.11.1's
boot sees `schema_version = 18` and applies only the now-fixed v19.
No manual DB intervention required.

### Operator action
After Watchtower rolls over to v1.11.1, or after a manual:
```bash
sudo docker compose pull oscar
sudo docker compose up -d --force-recreate oscar
```
the migration runs cleanly. Existing plaintext rows are encrypted on
first boot, and OSCAR resumes normal operation with the full v1.11.0
feature set (per-run share, admin role tightening, at-rest encryption).

---

## [server-v1.11.0] — 2026-05-15

Minor bump — **vendor data sovereignty Phase 2 (issue #60)**:
**at-rest encryption**. Closes the gap Phase 1 deferred: the same SSH-
equipped sysadmin who could not browse vendor data through the UI could
still `sudo cat /opt/OSCAR/.../data/oscar.db | strings` and read every
log line, HTTP body, scenario, and test framework in plaintext. After
v1.11.0 the bytes on disk are AES-256-GCM ciphertext envelopes; the
plaintext exists only inside the OSCAR process while it runs.

This is **Phase 2 of three**:
- ✅ Phase 1 (v1.10.0) — application-level access control + per-run share
- ✅ Phase 2 (this) — at-rest encryption
- ⏳ Phase 3 — operational policy (who has root SSH on production)

### Added
- **`src/utils/at-rest.js`** — file-level AES-256-GCM helper. Uses the
  same `ENCRYPTION_KEY` envelope OSCAR already uses for credentials.
  Format: `OSCAR1` magic (6 B) + IV (12 B) + tag (16 B) + ciphertext.
  Sync + async variants for both buffers and files. 22 unit tests
  cover round-trip, magic-header detection, legacy plaintext fall-
  through, tampering rejection, atomic temp+rename writes.
- **`db.colEncrypt()` / `db.colDecrypt()`** — column-level wrappers
  around the existing `encrypt()`/`decrypt()` with an `enc:v1:` prefix
  marker. Mixed-state safe: any row without the prefix is treated as
  legacy plaintext and returned unchanged.

### Changed (security)
The following **content** columns and files are now encrypted at rest.
Schema, structural columns (status, timestamps, http_method, http_status,
suite_name, etc.) remain plaintext so SQL filtering / sorting / counting
keeps working without per-row decrypt cost.

| What | Where | Encrypted? |
|---|---|---|
| HTML report files | `data/artifacts/<runId>/report*.html` | ✅ new |
| JSON results files | `data/artifacts/<runId>/.bru_results.json` | ✅ new |
| Company datafiles | `data/datafiles/<slug>-datafile.json` | ✅ new |
| Log line content | `run_events.message` | ✅ new |
| HTTP request body | `run_requests.request_body` | ✅ new |
| HTTP request headers | `run_requests.request_headers` | ✅ new |
| HTTP response body | `run_requests.response_body` | ✅ new |
| HTTP response headers | `run_requests.response_headers` | ✅ new |
| Per-call context JSON | `run_requests.context` | ✅ new |
| Test framework JSON | `test_frameworks.config` | ✅ new |
| Test resources JSON | `test_resources.data` | ✅ new |
| Per-tester credentials | `users.*_enc` columns | ✅ already (v12) |
| Cached OAuth tokens | `users.cached_token_enc` | ✅ already (v11) |

### Migration
Schema migration **v19** runs automatically on first boot and encrypts
existing plaintext rows in the columns above. Per-table transactions;
rollback on failure; logs row counts. Idempotent: rows already carrying
the `enc:v1:` prefix are skipped on subsequent runs.

**Files on disk are NOT touched by the DB migration.** Existing artifact
HTML and datafile JSON files remain plaintext until they're re-written
by a new run / upload — at which point they get encrypted. This is fine
because the read helpers transparently handle both formats. An optional
one-time bulk-encrypt operator script lives at
`OSCAR_Deploy/scripts/encrypt-existing-artifacts.sh` — strictly cleanup,
not required.

### Fixed (latent bug — incidental)
- `/v1/reports/requests/:id/messages` queried four non-existent columns
  (`req_body`, `req_headers`, `resp_body`, `resp_headers`) — the real
  names are `request_*` / `response_*`. The HTTP message-chain viewer
  in Report Builder was silently empty. Fixed alongside the encryption
  work since both touch the same query.

### Search behaviour change
The `?search=...` filter on `GET /v1/runs/:id/logs` previously used
SQL `LIKE` against the message column. Now that `run_events.message`
is encrypted, server-side LIKE no longer matches ciphertext — the
endpoint fetches a wider window (5×, capped at 5000 rows) and filters
post-decrypt in Node. Query time is microseconds slower for the
post-decrypt scan; user-visible behaviour is unchanged.

### Threat coverage matrix (updated)

| Threat | v1.10 | v1.11 |
|---|---|---|
| Admin browsing UI sees vendor reports | ✅ | ✅ |
| Anonymous artifact download via UUID guess | ✅ | ✅ |
| Sysadmin `sudo cat oscar.db \| strings` reveals log + HTTP content | ❌ | ✅ |
| Sysadmin `sudo cat report.html` reveals vendor results | ❌ | ✅ |
| Sysadmin `sudo cat datafile.json` reveals scenarios | ❌ | ✅ |
| Backup tape leak (cold storage) | ❌ | ✅ |
| Sysadmin attaches debugger to running OSCAR process | ❌ | ❌ Phase 3 |

### Migration after Watchtower rolls over to v1.11.0
**No operator action required.**
- v19 migration runs on first boot
- Existing files remain readable; new writes are encrypted
- All endpoints continue to work — the read helpers are transparent
- The optional `encrypt-existing-artifacts.sh` is operator's choice

---

## [server-v1.10.0] — 2026-05-15

Minor bump — **vendor data sovereignty (Phase 1, issue #60)**. Restructures
the trust model so a company's test configuration and reports stay private
to its own testers and test_managers until the test_manager explicitly opts
in to sharing specific runs with the UIC certification team. Strips the
administrator role of all test-data read access; closes an anonymous
static-serve bypass that previously let any unauthenticated user download
an artifact knowing only the run UUID.

This is **Phase 1 of three**:
- Phase 1 (this release) — application-level access control + per-run share
- Phase 2 (next release) — at-rest DB encryption (SQLCipher)
- Phase 3 — operational policy (who has root SSH on production)

### Added
- **Per-run share-with-certifier toggle** — test_managers explicitly pick
  which terminal runs (COMPLETED / FAILED / CANCELLED) become visible to
  certifiers, via a new button on each run-detail page. Replaces the
  legacy company-wide all-or-nothing toggle as the gating mechanism.
  - `POST /v1/runs/:id/share` — share this run with certifiers
  - `DELETE /v1/runs/:id/share` — revoke certifier access to this run
  - Both audit-logged with the test_manager's email and the run id.
- **`canUserSeeRun()` helper** at `src/api/helpers/run-access.js` — single
  source of truth for "is this user allowed to see this run". Every
  endpoint that returns run-scoped data now flows through it.

### Changed (BREAKING)
- **Administrator role no longer reads test data**. The role becomes
  operations + security only — users, companies (metadata), server
  config, alerts, audit log, observability stack. Specifically removed:
  - `GET /v1/runs/:id` and all sub-endpoints (logs / artifacts /
    assertions / requests) → 404 for admin
  - `GET /v1/company/test-framework` → 403 for admin
  - `GET /v1/company/datafile` → 403 for admin
  - `GET /v1/company/test-resources` → 403 for admin
  - `GET /v1/runs` returns ONLY the data-lifecycle queue
    (DELETION_REQUESTED + DELETED_BY_ADMIN status) — metadata only,
    no per-run content. Aggregate counts still available via
    `/v1/admin/activity`.
  - `POST /v1/company/datafile`, `PUT /datafile/json`,
    `DELETE /datafile`, `PUT /test-framework`, `POST /test-resources` →
    test_manager only (was test_manager OR isPlatformRole).
- **Certifier visibility tightened**. Certifiers no longer see every run
  of a vendor that has the legacy company-wide toggle on; they see ONLY
  runs the test_manager has explicitly shared via the new per-run flag.
  The legacy `companies.share_reports_with_certifier` toggle becomes a
  master kill switch — when set to 0 it overrides every per-run share.
- **Migration v18** backfills `shared_with_certifier_at` for every
  terminal run of a company whose legacy toggle was on. Existing
  certifier workflows continue uninterrupted on rollover; the new
  per-run model applies to NEW runs going forward.

### Fixed (security)
- **`/artifacts/:runId/:filename`** — was served by `express.static` with
  no auth. Anyone able to reach OSCAR (or guess a run UUID) could
  download a vendor's HTML report or JSON results. Now gated by
  authenticated session + per-run-ownership check via `canUserSeeRun()`.
  The HTML-report `<a href>` continues to work because browsers send the
  httpOnly session cookie automatically for same-origin GETs.
- **`/data/:filename`** — same `express.static` exposure. Now requires
  authenticated session whose company owns the slug, OR a true-loopback
  request with no `X-Forwarded-For` (Bruno subprocess on the same
  host). Nginx-proxied external traffic always carries
  `X-Forwarded-For`, so the loopback path is unreachable from outside.

### Documentation
- New `Server Admin Guide § 15 — Vendor Data Sovereignty` documenting
  the trust model, the threat model (what code defends against vs. what
  requires operational policy), and the Phase 2/3 roadmap.
- Welcome news entry summarising the change for end users.

### Migration
After Watchtower rolls over to v1.10.0:
- **No operator action required.** v18 migration runs automatically on
  first boot; the backfill preserves every existing certifier workflow.
- The legacy company-wide `share_reports_with_certifier` toggle remains
  in the UI as a master kill switch.
- Test managers should familiarise themselves with the new per-run share
  button on the run-detail page.
- Administrators may notice that the "All Reports" tab now shows only
  the data-lifecycle queue, not every run on the platform — this is
  intentional (issue #60).

---

## [server-v1.9.1] — 2026-05-11

Patch release — UX polish bundling three small wins from the open-issue
backlog plus a docs-pipeline improvement.

### Fixed
- **Issue #19** — *Test Config save confirmation invisible without
  scrolling.* The `.msg` element rendered at the top of the page in
  normal document flow; admins saving from the bottom of the long Test
  Config form had no visible feedback that the save succeeded. Switched
  to a fixed-position toast pinned to the top-centre of the viewport
  regardless of scroll, with a slide-in animation. Standard 5-second
  auto-dismiss preserved. Affects every flow that calls `showMsg()` in
  `scenarios.html` (framework save, scenario save, train save, datafile
  upload, deletion confirmations, …).

### Added
- **Issue #18** — *Dashboard batch summary split into per-outcome
  counters.* The previous "X/Y done" pill was misread by users as
  "nothing has finished" when in fact every scenario had failed (the
  word "done" implied success). Replaced with up to three pills
  side-by-side: green `✓ N` (passed), red `✗ N` (failed), amber `⌛ N`
  (still running). Empty batches show a neutral em-dash. Failures are
  now immediately legible at a glance without parsing a fraction.
- **`render-docs-pdf.yml` workflow** — re-renders the Self-Hosted Quick
  Start PDF whenever its markdown source changes on `main`, commits the
  regenerated file back. Uses Python 3.12 + reportlab + xhtml2pdf, same
  toolchain that produced the initial PDF. Loop-safe (skips itself on
  github-actions[bot] commits).

### Closed
- **Issue #14** — *Requesting a new user does not work, email never
  received.* Closed with comment: root cause was misconfigured
  `SMTP_FROM` (relay-internal authentication identity used as the
  display sender). v1.9.0 already hardened this with field renaming +
  soft-validation warnings + Send test email button — no further code
  change needed.

### Migration
None — pull v1.9.1, hard-refresh the browser (Ctrl+Shift+R) to bust
cached HTML/CSS, and the new pills + sticky toast are live. No DB
change, no compose change, no operator action.

---

## [server-v1.9.0] — 2026-05-11

Minor bump — closes three operational pain points discovered during v1.8.x
rollout: scattered SMTP config, error-prone SMTP field labels, and the
"dead UI after cookie expiry" fallout from the v1.8.1 hotfix.

### Added
- **Unified SMTP / alerting config in the admin UI**. Server Config tab
  gains an Alerting card with three new keys:
  - `ALERT_RECIPIENTS` (comma- or newline-separated admin emails)
  - `ALERT_REPEAT_CRITICAL` (default `1h`)
  - `ALERT_REPEAT_WARNING` (default `4h`)
  Plus a one-click **"Apply alerting config to Alertmanager"** button
  that templates `alertmanager.yml` from current `SMTP_*` + `ALERT_*`
  values, writes it to a docker-shared volume mounted into the
  Alertmanager container at `/etc/alertmanager`, and hot-reloads via
  Alertmanager's built-in `POST /-/reload` endpoint. No SSH, no VPS
  file edits, no Docker socket exposure.
- **`POST /v1/admin/alertmanager/apply`** new admin endpoint surfacing
  the verbatim outcome of every step (file written, reload status,
  reload body) so the UI can self-diagnose partial failures.
- **Best-effort startup seed** in `server.js` — if the
  `alertmanager-config` volume is mounted (env var present) AND
  Server Config has SMTP + recipients filled in, OSCAR templates
  + reloads on boot. Eliminates the chicken-and-egg "Alertmanager
  refuses to start with empty config" problem on fresh metrics-stack
  rollouts.
- **Soft-validation warnings on SMTP_FROM** — saved-with-warning when
  the value looks like a relay-internal authentication identity
  (e.g. `*@smtp-brevo.com`, `*@smtp.sendgrid.net`) or duplicates
  `SMTP_USER`. Shown inline in the UI without blocking the save.

### Changed
- **SMTP field labels rewritten** for clarity:
  - `SMTP_USER` → "SMTP Login" (with help text: *"Authentication
    identity, often a relay-internal id like `a731f1001@smtp-brevo.com`
    — NOT the address recipients see"*)
  - `SMTP_FROM` → "Display 'From' Address" (with help text: *"Sender
    shown in the From: header, must be an address your relay has
    verified"*)
  Closes the diagnostic gap that produced the `SMTP_USER`-pasted-into-
  `SMTP_FROM` incident.
- **`docker-compose.metrics.yml` switched from host-file mount to
  shared volume** for `alertmanager.yml`. Old host file under
  `OSCAR_Deploy/alertmanager/alertmanager.yml` is no longer used and
  can be deleted after the v1.9.0 rollout.

### Fixed
- **"Dead UI" after cookie expiry** (v1.8.1 follow-up). nav.js's global
  fetch interceptor now detects 401 from any authenticated API call,
  clears stale localStorage, and bounces to login with a one-shot
  "Your session has expired" notice. The previous behaviour (silent
  button failures, no redirect) ended whenever the next page-render
  hit the legacy `oscar_user` guard, which could be never on a
  long-lived dashboard tab.

### Operations
- Single source of truth for SMTP credentials. The same Brevo / SendGrid
  / etc. login configured once in OSCAR's Server Config now drives
  password resets, email verification, test emails, AND alert delivery.
- The host-mounted `OSCAR_Deploy/alertmanager/alertmanager.yml` becomes
  legacy. Operators can delete it after the rollover; OSCAR generates
  the live config into the `alertmanager-config` named volume.

### Migration
After Watchtower rolls over to v1.9.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy

# Recreate oscar + alertmanager so they pick up the new shared volume mount.
sudo docker compose \
     -f docker-compose.yml \
     -f docker-compose.metrics.yml \
     up -d --force-recreate oscar alertmanager

# In OSCAR UI:
#   1. Server Config tab → Alerting → fill in ALERT_RECIPIENTS → Save
#   2. Click "Apply alerting config to Alertmanager"
#   3. (Optional) sudo rm OSCAR_Deploy/alertmanager/alertmanager.yml — no longer used
```

---

## [server-v1.8.1] — 2026-05-11

Hotfix — clears a redirect loop ("blinking welcome page") for users whose
session is cookie-only.

### Fixed
- **Auth guard redirect loop on cookie-only sessions** — seven web pages
  (welcome, admin, compare, dashboard, profile, run-detail, run) still
  asserted the presence of `localStorage.oscar_token` to consider the
  user logged in. The auth model migrated to an httpOnly `oscar_session`
  cookie a while back; the verify-email and forgot-password flows
  correctly write `oscar_user` to localStorage but no longer write
  `oscar_token`. Result: any freshly-verified user landing on those
  pages bounced to `/`, `/` saw `oscar_user` and bounced back to
  `/welcome.html`, repeating indefinitely (visible "blinking").
  Guards now use `oscar_user` as the client-side session-presence proxy;
  `oscar_token` is still read for legacy Bearer-header fetches when
  present. Existing administrator sessions were not affected because
  they retained `oscar_token` from before the cookie migration.

### Migration
None — Watchtower picks up the new image and the fix is live the moment
the page reloads. No DB change, no compose change, no config edit.

---

## [server-v1.8.0] — 2026-05-10

Minor bump — operational watchdog and email alerting layer on top of the
existing Prometheus + Grafana + Loki observability stack. Ships a
self-healing sidecar (autoheal) plus Alertmanager wired to admin email
through the same SMTP relay used by OSCAR itself.

### Added
- **Docker `healthcheck` on the OSCAR container** — probes `GET /health`
  every 30 s using Node's built-in `fetch` (no extra binaries needed in
  the slim image). Three failures in a row → container marked
  `unhealthy`. The `oscar` service is now labelled `autoheal=true`.
- **`willfarrell/autoheal` sidecar** in `docker-compose.yml` — watches
  the Docker socket every 30 s, restarts any `autoheal=true`-labelled
  container that goes unhealthy. ~5 MB image. Most transient hangs heal
  themselves without paging a human.
- **`prom/alertmanager` service** in `docker-compose.metrics.yml` —
  receives alerts from Prometheus, dedupes / groups, emails OSCAR
  administrators via the existing SMTP relay (Brevo, SendGrid, etc.).
  Re-pages criticals every 1 h, warnings every 4 h. Bound to
  127.0.0.1:9093.
- **Default alert ruleset** in `OSCAR_Deploy/prometheus/alerts/oscar-alerts.yml`:
  - `OscarServerDown` — `/metrics` unscrapeable for 2 min (critical)
  - `OscarRestartLoop` — > 3 container restarts in 10 min (critical)
  - `OscarQueueStuck` — queue depth > 0 + no run completed in 10 min (warning)
  - `OscarRunFailureRateHigh` — > 50 % of runs FAILED over 15 min (warning)
  - `OscarSmtpDegraded` — any SMTP failure in last 10 min (warning)
  - `OscarLoginAttackBurst` — > 50 failed logins in 5 min (warning)
  - `OscarHighMemory` — RSS > 1 GB for 15 min (warning)
  - `OscarEventLoopLag` — p99 lag > 200 ms for 10 min (warning)
- **Two news entries on welcome page**:
  - "Operational monitoring upgrade — live dashboards, centralised logs,
    and an automatic watchdog with email alerts"
  - "Three big quality-of-life features now live: credential redaction,
    self-service report deletion, and password reset by email"

### Documentation
- **`OSCAR - Server Admin Guide.md`** — new § 13 (Admin Web Tools:
  Manage Users / Companies / Server Activity / Server Config / Admin
  Dashboard tiles) + new § 14 (Operational Monitoring & Alerting:
  what's wired up, default alert table, first-time setup, end-to-end
  email-path test, silencing during planned maintenance, recipient list
  sync). § 7 also clarifies which `.env` settings are now editable at
  runtime via the Server Config tab.
- **Solution Architecture (§ 10.1)** — new "Production Observability
  and Self-Healing Stack" section covering the full Prometheus / Loki /
  Grafana / autoheal / Alertmanager topology, default alert ruleset,
  and resource budget.
- **Specification (§ 5)** — Non-Functional Requirements updated to
  mention container healthchecks + autoheal (reliability), credential
  redaction + self-service password reset (security), Prometheus +
  Grafana + Loki + Alertmanager email alerting (observability).
- **`metrics-and-monitoring.md`** — resource table updated to ~415 MB
  RAM (adds autoheal + alertmanager), four new troubleshooting rows
  for the watchdog stack.

### Migration
After Watchtower rolls over to v1.8.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy

# 1. Create the alertmanager config from the example, fill in SMTP + recipients.
sudo cp alertmanager/alertmanager.yml.example alertmanager/alertmanager.yml
sudo $EDITOR alertmanager/alertmanager.yml
#    └── set: smtp_smarthost, smtp_auth_username, smtp_auth_password, recipient `to:`

# 2. Bring the new services up. `oscar` is recreated to pick up the
#    healthcheck + autoheal label; existing data is untouched.
sudo docker compose \
     -f docker-compose.yml \
     -f docker-compose.metrics.yml \
     up -d --force-recreate oscar autoheal alertmanager prometheus

# 3. Verify.
docker ps --format 'table {{.Names}}\t{{.Status}}'
#    └── oscar should now show "(healthy)" after ~30 s
```
Smoke-test the email path with the synthetic-alert curl in
`Server Admin Guide § 14.4`.

---

## [server-v1.7.0] — 2026-05-10

Minor bump — adds Loki / Promtail to the metrics stack and bakes the
auth_request fix from v1.6.0 into source.

### Added
- **Centralised logs via Loki + Promtail** — operators click 📝 Logs
  on the Admin Dashboard → land in a pre-built "OSCAR · Logs" Grafana
  dashboard with errors-only view, full live tail (5s refresh),
  per-container filter, and ad-hoc substring search. Promtail uses
  Docker SD to discover containers, so any new container in the
  compose project is picked up automatically with zero config.
  - Loki 3.4.1 — single-binary, filesystem store, bound to localhost:3100
  - Promtail 3.4.1 — Docker SD, ships stdout/stderr to Loki
  - Loki datasource auto-provisioned in Grafana (`uid: loki`)
  - New `OSCAR · Logs` dashboard JSON provisioned alongside Overview
- **Loki tile activated** in Admin Dashboard (was disabled
  "Coming soon" placeholder in v1.6.0)

### Fixed
- **SSO `auth_request` 500 Internal Server Error** —
  `OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` now ships with the
  two extra headers required to bypass OSCAR's HTTPS-redirect
  middleware on the internal SSO check (`Host: localhost` and
  `X-Forwarded-Proto: https`). Was applied live on the VPS during the
  v1.6.0 rollout; baking into source means new deployers don't hit it.

### Operations
- `Documentation/Server_Operations/metrics-and-monitoring.md` —
  troubleshooting table now covers every gotcha hit during v1.5.0 →
  v1.7.0 rollout. Resource budget bumped to ~380 MB RAM / ~600 MB
  disk after 30d (was ~270 MB / ~550 MB without Loki+Promtail).
- `Documentation/Server_Operations/auto-deploy-setup.md` — new
  "When refresh-collection.sh fails with 'working tree dirty'"
  recovery section.

### Migration
After Watchtower rolls over to v1.7.0:
```bash
ssh ubuntu@oscar.uic.org
sudo -u ubuntu git -C /opt/OSCAR pull
cd /opt/OSCAR/OSCAR_Deploy
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d loki promtail
sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d --force-recreate grafana
```
The force-recreate of Grafana picks up the new Loki datasource. After
that, Admin Dashboard → 📝 Logs tile lands in OSCAR · Logs dashboard
with live container output streaming in.

---

## [server-v1.6.0] — 2026-05-10

Minor bump — new SSO endpoint, new public page, replaces the htpasswd
basic-auth model that v1.5.x shipped.

### Added
- **SSO into Grafana via OSCAR JWT.** New `GET /v1/auth/sso-check`
  endpoint validates the `oscar_session` cookie and returns
  `X-User-Email` + `X-User-Role` if the user is an administrator,
  401 otherwise. nginx's `auth_request` directive uses this to gate
  `/grafana/` (and `/prometheus/`, see below). Grafana auto-creates
  a matching user (Viewer role) on first visit via its `auth.proxy`
  module. No more htpasswd file to manage.
- **Prometheus web UI exposed at `/prometheus/`** behind the same SSO
  gate. Useful for raw PromQL queries and scrape-target health
  inspection. Bound to `127.0.0.1:9090` on the host; only nginx (with
  the SSO check) can reach it externally.
- **New "Admin Dashboard" nav entry** (administrator only) → page at
  `/admin-dashboard.html` with three tiles: 📈 Grafana, 🔍 Prometheus,
  📝 Logs (Loki) — the Loki tile is a disabled placeholder for the
  next iteration.

### Fixed
- **Bake post-v1.5.0 production fixes into source** —
  `GF_SERVER_DOMAIN: 'oscar.uic.org'` + hardcoded `GF_SERVER_ROOT_URL`,
  Grafana datasource `uid: prometheus`, nginx `proxy_pass http://127.0.0.1:3000;`
  (no trailing slash). These were patched on the production VPS during
  the v1.5.0 / v1.5.1 rollouts; baking them into source means
  `refresh-collection.sh` stops failing on a dirty working tree.

### Security
- **`/v1/auth/sso-check` rate-limited** 600/5min/IP (CodeQL
  `js/missing-rate-limiting`). Generous because nginx fires this on
  every proxied request to `/grafana/` or `/prometheus/`.

### Migration steps for existing deployments
After Watchtower rolls over to v1.6.0:
1. `git -C /opt/OSCAR pull` (now clean — the v1.5.1-era manual edits
   match what's in source)
2. Replace the OLD `location /grafana/` block in your nginx site config
   with the new 3-block snippet from
   `OSCAR_Deploy/nginx/oscar-metrics.conf.snippet` (one `auth_request`
   helper + `/grafana/` + `/prometheus/`)
3. `sudo nginx -t && sudo systemctl reload nginx`
4. `sudo docker compose -f docker-compose.yml -f docker-compose.metrics.yml up -d --force-recreate grafana prometheus`

The old `/etc/nginx/.htpasswd-grafana` file is no longer referenced —
leave it on disk (harmless) or `sudo rm` it.

---

## [server-v1.5.1] — 2026-05-10

### Fixed
- **`/metrics` scrape blocked in production (regression from v1.5.0).**
  PR #41 added the Prometheus endpoint, but the existing HTTPS-redirect
  middleware (PRs #7 / #23) intercepted Prometheus's plain-HTTP scrape
  from inside the Docker network — returning 400 Bad Request, or 301
  to a TLS port that doesn't exist depending on `ALLOWED_REDIRECT_HOSTS`.
  Both modes left the Grafana dashboard empty.
  Fix: skip the HTTPS-redirect middleware when `req.path === '/metrics'`.
  Endpoint is firewalled at the nginx layer for external requests
  (returns 404), so this exemption adds no security exposure.

  Operators who added `oscar` to `ALLOWED_REDIRECT_HOSTS` as a workaround
  can revert that change — no longer required. The standard
  `prometheus.yml` shipped in v1.5.0 works as-is.

---

## [server-v1.5.0] — 2026-05-09

Minor bump — new dependency (`prom-client`), new public-ish endpoint
(`/metrics`), new optional infrastructure components (Prometheus + Grafana).

### Added
- **Prometheus + Grafana integration (opt-in).** New
  `/metrics` endpoint on the server exposes Node.js process metrics
  (CPU, memory, GC, event-loop lag) plus OSCAR-specific counters:
  - `oscar_http_request_duration_seconds` (Histogram, by route + status)
  - `oscar_runs_total` (Counter, by terminal status)
  - `oscar_queue_depth` / `oscar_active_runs` (Gauges, refreshed every 5s)
  - `oscar_login_attempts_total` (Counter)
  - `oscar_smtp_send_total` (Counter)
- **Compose overlay `OSCAR_Deploy/docker-compose.metrics.yml`** — start
  Prometheus + Grafana with one extra `-f` flag, leave the existing
  `oscar` container untouched. Default deployments unaffected.
- **Auto-provisioned Grafana dashboard** ("OSCAR · Overview") with 10
  panels: live snapshots (active runs, queue depth, HTTP rate, P95
  latency), latency percentiles, status-code rate, run throughput,
  auth + SMTP rates, process memory, CPU + event-loop lag.
- **nginx snippet** (`OSCAR_Deploy/nginx/oscar-metrics.conf.snippet`)
  blocks external access to `/metrics` (returns 404) and reverse-proxies
  `/grafana/` with HTTP basic auth.
- **Operator guide**: `Documentation/Server_Operations/metrics-and-monitoring.md`
  covers architecture, one-time setup, day-to-day commands, resource
  budget (~270 MB RAM, ~550 MB disk over 15d), how to add a new metric,
  troubleshooting.

### Notes
- The `/metrics` endpoint is always-on at the app layer (no auth) but
  not externally reachable (nginx 404). Only the in-cluster Prometheus
  scrapes it.
- Grafana defaults to Anonymous Viewer mode internally, with HTTP basic
  auth at the nginx layer — operators see one auth prompt, not two.

---

## [server-v1.4.4] — 2026-05-09

### Fixed
- **Closes #34 UI gap.** Dashboard batch header rows now have a
  "select-all" checkbox. v1.4.3 unblocked the server-side permission
  for test_managers, but the dashboard still required users to expand
  every batch and tick each scenario individually before deletion —
  prohibitively tedious for batches with many scenarios. One click on
  the batch checkbox now selects all child scenarios at once. An
  indeterminate (gray dash) state appears when some children are
  selected. Applies to all roles that can delete (tester,
  test_manager, administrator).

---

## [server-v1.4.3] — 2026-05-09

### Fixed
- **Closes #34** — Test Manager can now soft-delete any run in their
  own company. Previously the soft-delete handlers
  (`POST /v1/runs/bulk-delete` and `DELETE /v1/runs/:id`) gated
  past-tenant ownership behind `role === 'administrator'`, so test
  managers were treated as regular testers and could only delete
  runs they personally started — even though they already had
  elevated privileges over user management and the privacy toggle.
  Tenant filter still enforces the company boundary; cross-company
  delete remains impossible. Bulk-admin-action (which includes
  irreversible `purge`) intentionally stays administrator-only.

---

## [server-v1.4.2] — 2026-05-09

### Security
- **Closes #17 third leak path** — `Bruno_Collection/library-bruno/reportGenerator.js`
  now redacts sensitive headers and auth-endpoint bodies before writing
  the per-scenario HTML report (`/artifacts/<runId>/report_<sc>.html`).
  Same shape as the redaction added in PR #21 (mergeReport.js) and PR
  #29 (structureResults.js). Three render paths now all consistent.
- **Migration v17** — retroactive scrub of historical `run_requests`
  rows. Re-applied here via PR #32 (was effectively missed by PR #29's
  squash-merge). Boot logs show
  `[db] migration v17 — scrubbed credentials from N of M run_requests rows`.

### Operations
- Old `report_*.html` files on disk are NOT auto-cleaned (filesystem,
  not DB; v17 scrub doesn't reach them). Optional one-time cleanup
  documented in PR #31.

---

## [server-v1.4.1] — 2026-05-09

### Security
- **Closes #17 server-side leak.** `structureResults.js` now redacts
  sensitive headers (`Authorization`, `Ocp-Apim-Subscription-Key`,
  `X-API-Key`, `Cookie`, etc.) and auth-endpoint request/response
  bodies BEFORE storing in `run_requests`. PR #21 had closed the same
  class of leak in the Bruno-side merged report — this PR closes the
  matching server-side path that fed the Report Builder UI.
- **Migration v17: retroactive scrub.** Walks every existing
  `run_requests` row and re-redacts in place using the same logic.
  Idempotent. Wraps per-row updates in a transaction so the scrub
  is atomic. Boot log shows
  `[db] migration v17 — scrubbed credentials from N of M run_requests rows`.

### Operations
- **Hands-off release deploy.** `refresh-collection.yml` now also fires
  on `compatibility.json` changes (was previously `Bruno_Collection/**`
  only). `promote-release.yml` SSHes the VPS after pushing `:stable`
  as defense in depth. Combined effect: the manual
  `ssh + git pull + restart` ritual after every release is gone —
  Watchtower's normal poll cycle handles container recreate, and the
  host file is fresh by the time it does.
- **Repo-level auto-merge enabled.** Future release PRs are armed with
  `gh pr merge --auto` so they merge as soon as CI is green; no more
  forgotten merge-button clicks.

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
