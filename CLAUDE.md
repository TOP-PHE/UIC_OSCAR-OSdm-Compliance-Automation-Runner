# OSCAR — project memory for Claude

Working notes for picking this project back up cold. See also `README.md`
(monorepo layout), `CONTRIBUTING.md`, and each user's persistent auto-memory
(PR workflow habits, cross-session project context) — this file is the
in-repo counterpart: technical state, not personal working style.

**Checkout warning (read this first).** If you were handed a working
directory that looks like a *flat* layout (`src/`, `public/`, `tests/` at
the repo root, no `Oscar_Server/`/`Bruno_Collection/` split), **stop** —
that's a stale, pre-migration checkout with git history **unrelated** to
this repo (`git merge-base HEAD origin/main` returns nothing). This
happened once already (2026-07-02): the fix was cloning a fresh copy of
`TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner` as a sibling
directory and working there instead. Check `ls` for the `Oscar_Server/` +
`Bruno_Collection/` split before doing anything else.

## 1. Purpose & scope

**OSCAR** (OSDM Conformance Automation Runner) is a multi-tenant platform that
runs [Bruno](https://www.usebruno.com/)-driven conformance test scenarios
against vendors' **OSDM** (Open Sale Distribution Model — the UIC rail-ticketing
interop API spec, versions 3.5.0–3.9.0 seen across vendors) implementations,
and turns the results into structured pass/fail reports a certifier can act on.

Each vendor/operator (SBB, CHAPS/ČD, Paxone, ÖBB, Bileto, Turnit, SNCF, Sqills…)
is a **company** (tenant): its own users, encrypted per-tester OSDM credentials,
a **Test Framework** (what OSDM capabilities it declares support for) and a
**datafile** (the actual test scenarios to run against it). A **Test Manager**
configures both; **testers** (`company_user`) run scenarios and read reports;
**certifiers** (`certification_user`) get a read-only view (unless the company
turns that off); an OSCAR **administrator** manages tenants, not test content.

## 2. Architecture decisions already made

- **Two halves in one repo.** `Oscar_Server/` is the Node.js control plane
  (auth, REST API, SQLite, run orchestration, the admin/tester web UI).
  `Bruno_Collection/` is the actual OSDM test content — `.bru` requests +
  `library-bruno/` (shared JS validators executed *inside* Bruno's sandbox).
  They version independently (see §4) but are released as tested-together
  pairs recorded in `compatibility.json`.
- **Stack:** Node 22+, built-in `node:sqlite` (no native compile step),
  `@usebruno/cli` as the actual HTTP-execution engine (spawned as a child
  process by `worker/runner.js`). Vanilla JS + template-literal HTML on the
  frontend — no framework, event delegation keyed on `data-action`.
- **"Framework declares → scenario may exercise" golden rule (#218).** A Test
  Framework config declares supported capabilities (sales flows, transport
  modes, passenger types, seat-selection modes, ancillaries, offer criteria,
  fulfillment type/media — #448). Enforcement is **not unified** — two
  different mechanisms depending on the capability's shape:
  - boolean scenario flag vs. a `salesFlows` declaration → server-side
    `utils/frameworkGating.js` rule table → soft `[WARNING]`
    (`__featureNotDeclaredWarnings` annotated onto the served datafile, never
    a hard fail);
  - array-membership (e.g. fulfillment type/media) → client-side `fwFilter()`
    narrows the *available* picker options in the scenario editor to what's
    declared. One scenario-fulfillment editor (`buildFulfillmentSection`,
    shared `requestedFulfillmentOptionsList`) was deliberately left
    **unrestricted** since #436 (a stale filter was locking every new company
    to ETICKET/PDF_A4) — extending gating there is an open follow-up, see §6.
- **Known-deviation baseline (#398).** Per-company "Test Findings & Open
  Points" register (`finding`/`finding_comment`): a threaded conformance
  dialogue, not a bug tracker — OSCAR opens a finding (observation + spec
  reading), the vendor's team replies/classifies (`provider_deviation` /
  `oscar_issue` / `not_supported` / `spec_question`). A finding marked
  `baseline_in_run=1` with a `step` + numeric `expected_status` projects into
  the served datafile's `knownDeviations[]`, so that *exact* documented HTTP
  status reports as a passing "known deviation" (still logged as a
  `[WARNING]`) instead of a hard FAIL. Any *other* status still fails — this
  can't be used to hide a regression. Extended (#447) with `scenario_code`,
  linking a finding to the scenario that revealed it.
- **Auth-profile dispatcher** (`worker/auth-profiles.js`): pluggable
  token-fetch adapters per vendor quirk — `oauth2_basic`, `oauth2_post`,
  `paxone_json`, `sqills_extension`, `custom` (user JSON template,
  case-insensitive `{{client_id}}`-style placeholders, optional
  `body_format:"raw"` for vendors whose token endpoint chokes on
  form-urlencoding special characters like `%`, #442). All credential fields
  are `.trim()`-ed both on store and at use-time (#440) — untrimmed
  paste-whitespace was a real, hard-to-diagnose 401 (CHAPS incident). Every
  token request is logged with a **default-deny secret mask** (#437): only an
  explicit allowlist of structural fields shows its value, everything else
  renders `***` / `(empty)`.
- **Self-registration is Test-Manager-gated, not email-domain-gated** (#449,
  2026-07-01). The old rule ("email must contain a fragment of the company
  name") is gone — it broke the moment a company was renamed after its slug
  was set (real incident: "Paxone" renamed from something with slug
  `paxone-gmbh`; `makeSlug('Paxone')` ≠ `'paxone-gmbh'`, so registration
  against it 400'd as "unknown company" — the registration dropdown's
  `<option>` value is now the company's **slug**, submitted verbatim,
  never re-derived from the display name). Instead: the dropdown only lists
  real, existing companies; a confirmed registration lands as
  `users.status = 'pending'` and cannot log in (403) until a Test Manager
  of that company (or an administrator, cross-company fallback) approves it
  via `POST /v1/company/users/:id/approve` (mirrored at `/v1/admin/users`).
  Every Test Manager is emailed on confirmation (`sendPendingApprovalEmail`,
  `mailer.js`) — but email is fire-and-forget; the "Pending" badge + Approve
  button on `admin.html`'s User Directory is the reliable signal regardless
  of SMTP delivery. `denyAdminAndCertifier`/`requireTestManager` (the
  test-data role guards, previously duplicated per-route) now live once in
  `api/helpers/shared.js`.
- **Stop-place lookup via a cached OSDM `GET /places` bulk download** (#450,
  2026-07-01). `places_cache` (one row/company, plaintext JSON — places are
  public reference data, not credentials) is populated on demand by
  `POST /v1/company/places/refresh` (test_manager only), which pages the
  vendor's `/places` endpoint via a new shared `utils/osdm-client.js`
  (`osdmGet` + `buildTesterHeaders`, factored out of the pre-existing
  discover-timetable vendor-call pattern in `company-test-resources.js`).
  `GET /v1/company/places?q=` does server-side ranked full-text filtering
  (name-prefix first). The scenario editor's `attachPlaceAutocomplete()`
  (lazily wired via a single delegated `focusin` listener on
  `[data-place-lookup]`) drives a typeahead on every origin/destination URN
  field — selecting fills the field with the place's URN; manual typing
  still always works, this is a pure assist.
- **Versioned SQLite migrations** (`db/db.js`): each migration is
  `{version, name, up()}`, applied once, tracked in `schema_version`. **Never
  edit an already-applied migration** — a column added inside one that already
  ran silently never executes on deployed DBs (the #208 outage class; guarded
  by `tests/unit/db-migrations.test.js`, which boots the real migration path
  against throwaway DBs, including an "already-versioned DB missing a column"
  regression scenario). Always add a *new* migration instead.
- **CI required checks:** Lint/audit/test, CodeQL, Trivy (image scan), Docker
  build, Gitleaks, SonarCloud scan, Bruno-collection validation, PR labeler,
  **`SonarQube Quality Gate check`** (added to required list 2026-07-02 via
  #460, once the pre-existing accessibility/duplication backlog that kept
  `main`'s gate red was cleared — it's live, required, and green now).
  Dependabot-triggered runs skip steps needing secrets (GitHub withholds
  secrets from bot PRs) but still report the job green.
- **SonarQube Cloud GitHub App is installed** (2026-07-02) — the repo was
  previously wired via the CI-token upload path only (`SONAR_TOKEN` +
  `sonarcloud-github-action`), which posts a plain pass/fail check but no PR
  decoration. Installing the App at github.com/apps/sonarqubecloud (SonarCloud
  rebranded from "SonarCloud" — the old `github.com/apps/sonarcloud` URL
  404s) added a second, distinct `sonarqubecloud`-app check plus an actual
  bot PR comment (Quality Gate verdict + issue/coverage summary). Both
  integration paths now coexist and both need to stay green.
- **Test coverage was a deliberate, ratcheted push** (2026-07-02, 6 PRs:
  #461–#466) from ~50% to ~88% line coverage on `Oscar_Server/src`, biggest
  gaps first: the 3 previously-untested route files → `runs.js`/`admin.js`/
  `company.js` → `mailer.js`/`middleware/auth.js`/`worker/auth-profiles.js`
  → `worker/runner.js` (the Bruno orchestrator, hardest — `child_process`
  fully mocked, never a real subprocess) → `src/server.js` (the app entry
  point — real side effects at require-time: `process.exit(1)` on missing
  env, a real `app.listen()`). `sonar-project.properties` documents the
  `new_coverage` gate-floor ratchet history (35%→83%) — bump it again next
  time a batch meaningfully raises the overall number. **Hard-won lessons
  for writing more tests here, all learned the expensive way:**
  - Never emit synthetic events on a mocked `child_process` after a fixed
    `setImmediate`/sleep tick — the code under test may do several real
    `await`s before it actually calls `spawn()`; poll `spawn.mock.calls.length`
    instead, or the event fires before the listener is attached and the test
    hangs forever.
  - Never pick a "distinctive" fixed port for a test that calls a real
    `app.listen()` — it *will* eventually collide with something already
    bound on some CI runner. Use `PORT=0` (OS picks a free ephemeral port)
    instead; supertest wraps the exported Express `app` directly and never
    dials the real port anyway.
  - `runs.company_id` cascades on delete; `runs.user_id` does **not** — a
    test's own cleanup must delete `companies` before `users`, or a still-
    referencing `runs` row throws a foreign-key error.
  - Any new `os.tmpdir()` usage in a NEW test file must go through
    `fs.mkdtempSync(...)`, never a bare/predictable path — CodeQL
    (`js/insecure-temporary-file`) flags it as high severity, scoped to the
    PR's diff only (pre-existing code with the same shape isn't re-flagged).
  - Never build `new RegExp(someDynamicString)` to check if a string
    contains/matches something (even with manual `.replace()` escaping) —
    CodeQL (`js/incomplete-url-substring-sanitization`) flags it regardless
    of context. Use plain `.includes()`/`.toContain()` instead.
  - CodeQL notes (not just failures) on a PR's own diff block merging too,
    separately from the check-run status, if branch protection has "all
    conversations must be resolved" — an unused-import note is exactly the
    kind of thing that silently blocks merge behind a green checklist.
- **Deploy:** VPS Docker image; `Bruno_Collection/` + `compatibility.json` are
  **bind-mounted, not baked into the image** — a `refresh-collection.yml`
  workflow `git pull`s the VPS on every push to `main`.

## 3. OSCAR/OSDM conventions & terminology

| Term | Meaning |
|---|---|
| **OSDM** | Open Sale Distribution Model — the API spec under test |
| **Scenario** | one Bruno-driven test case, keyed by a `code` (e.g. `OTST_SALE_PATCH_SRCH_CRIT_1ADT_1LEG`) |
| **`OTST_` / `NHF_` prefix** | standard happy-path test / "**N**ot **H**appy **F**low" negative probe (should be rejected) |
| **Datafile** | per-company JSON: `scenarios[]` + shared resource lists (trips, passengers, purchasers, fulfillment options); AES-256-GCM encrypted at rest |
| **Test Framework** | per-company *declared-capability* config — separate from the datafile |
| **Finding** | one entry in Test Findings & Open Points; category ∈ `{open, provider_deviation, oscar_issue, not_supported, spec_question}`, severity ∈ `{major, minor, not_supported}`, status ∈ `{open→discussing→resolved}` |
| **Known deviation / baseline** | a finding promoted into the run engine's `knownDeviations[]` |
| **golden rule** | "what's not declared in the framework can't be tested" (#218) |
| **`wizData`** | the frontend's in-browser working copy of `{framework, resources, datafile}`, edited by `scenarios.js`, persisted via debounced auto-save |
| **`fw-*` actions** | the generic `data-action="fw-*"` convention for Test-Framework pill/toggle clicks (e.g. `fw-pill` → `fwTogglePill(el, modeKey, subKey, value)`) |
| **run / batch** | one Bruno CLI execution of one scenario is a *run*; a set submitted together is a *batch* |

## 4. Build / test / run

From `Oscar_Server/`:
```bash
npm install
npm start          # node src/server.js
npm run dev        # node --watch src/server.js (auto-reload)
npm run lint       # eslint src/ && node scripts/lint-inline-scripts.js
npm test           # jest (tests/unit + tests/integration)
```
Node 22+ required (built-in `node:sqlite`).

**Local checkout path (since 2026-08):**
`…\TrackOnPath\Contract\UIC\projets\OSDM\OTST\UIC-OSCAR\oscar-monorepo` — no
space in it, so plain `npm test` / `npx jest` work locally exactly as in CI.
(The previous checkout lived under `…/UIC_New_Revenue_Management project/…`;
the space broke `npx jest`'s default glob resolution — "0 tests found". If a
checkout ever lands in a path with a space again, the workaround is
`npx jest --rootDir="$(pwd)" --testMatch="**/*.test.js"`.)

**Version bookkeeping — bump per functional PR:**
- `Oscar_Server/package.json` (`version`) — server semver, bump on any
  `Oscar_Server/` change.
- `Bruno_Collection/VERSION` — bump **only** when `Bruno_Collection/` files
  change.
- `compatibility.json` — add a `releases[]` entry (server + collection pair,
  `min_collection`/`max_collection`, human `notes[]`) and update
  `current_release`.
- Pure CI/workflow-only changes (`.github/workflows/*.yml`) do **not** bump
  any of the three (established precedent, e.g. `695117a`, `a96aeb8`).

## 5. Key files

| File | Role |
|---|---|
| `Oscar_Server/src/db/schema.sql` + `db/db.js` | schema + versioned migration runner |
| `Oscar_Server/src/api/routes/company.js` | datafile CRUD; `GET /datafile` serves the decrypted, gating-annotated datafile to Bruno |
| `Oscar_Server/src/api/routes/company-findings.js` | Test Findings CRUD + comments + baseline projection trigger |
| `Oscar_Server/src/api/routes/company-test-framework.js` | Test Framework CRUD + legacy migration |
| `Oscar_Server/src/api/routes/me-credentials.js` | per-tester OAuth/bearer credential storage (trims on store) |
| `Oscar_Server/src/worker/auth-profiles.js` | pluggable OAuth adapters + masked request-log helper |
| `Oscar_Server/src/worker/access-token.js` | resolves/caches a usable access token per tester |
| `Oscar_Server/src/worker/runner.js` | Bruno CLI run orchestrator |
| `Oscar_Server/src/utils/frameworkGating.js` | golden-rule rule engine + datafile annotator |
| `Oscar_Server/src/utils/knownDeviationProjection.js` | projects baselined findings into `knownDeviations[]` |
| `Oscar_Server/src/utils/osdm-client.js` | shared vendor-call helper (`osdmGet` + `buildTesterHeaders`), #450 |
| `Oscar_Server/src/api/routes/company-places.js` | Places API cache: `POST /places/refresh` (paginated download) + `GET /places?q=` (ranked search), #450 |
| `Oscar_Server/public/js/scenarios.js` | **the big one** (7000+ lines) — Test Config + Test Framework wizard SPA, incl. `attachPlaceAutocomplete()` |
| `Oscar_Server/public/js/findings.js` | Test Findings & Open Points page |
| `Bruno_Collection/library-bruno/*.js` | shared validators run inside Bruno: `scenarioParser`, `requestsBuilder`, `offers`, `bookings`, `refunds`, `exchanges`, `testCapture` (`bruTest()` assertion capture), `displays` (masked logging), `reportGenerator`/`mergeReport`, `loopback`, `osdmEnums` |
| `Bruno_Collection/json_validator/datafile.schema.json` | datafile JSON-schema contract |
| `compatibility.json`, `CHANGELOG.md` | version-pairing ledger + full release history |
| `sonar-project.properties` | SonarCloud scope/exclusions + the custom "OSCAR Gate" thresholds (ratcheted 35%→83% new-coverage / <4% duplication as the coverage push landed — see §2) |
| `tests/unit/db-migrations.test.js` | runs the **real** migration path against throwaway DBs — the #208 regression-class guard |
| `tests/unit/runner.test.js` | `worker/runner.js` coverage — `child_process.spawn` fully mocked via a `makeFakeProc()` EventEmitter + `waitForSpawnCalls()` polling helper (never a fixed sleep) |
| `tests/unit/server.test.js` | `src/server.js` coverage — supertest against the real exported `app`; one isolated `NODE_ENV=production` re-require covers the HTTPS-redirect middleware |
| `tests/integration/company-places.test.js` | Places API: refresh pagination/dedupe (stubbed `fetch`), ranked `?q=` search, role gating |

## 6. Next steps

- **#447–#450 (the prior batch) are all done.** #447/#448 merged earlier;
  **#449** (Test-Manager-gated registration) and **#450** (Places API lookup)
  both shipped 2026-07-01/02 — see the §2 bullets above. Nothing left open
  from that batch.
- **Coverage initiative (2026-07-02, PRs #461–#466) is substantially
  complete**: ~50% → ~88% line coverage on `Oscar_Server/src`, SonarQube
  Quality Gate is required + green (§2). Not chased further because the two
  remaining gaps are both deliberately excluded from the coverage metric
  (`public/**`, `library-bruno/**` — see `sonar-project.properties`), not
  because anything is left half-done. If coverage work resumes, that's where
  it resumes — `library-bruno/` in particular has real logic
  (`requestsBuilder`, `offers`, `reportGenerator`) and zero Jest harness.
- **Issue backlog was swept and cross-checked against the code 2026-07-02**
  (the list below is freshly verified, not inherited guesswork — re-check
  with `gh issue list --state open` if much time has passed):
  - **Closed as already-implemented**, each updated with the exact PR/commit
    that did it: **#325** (PR #326, `dea4fcf`) and **#335** (duplicate of
    #336, itself closed via PR #337, `21d502b`) — both were implemented but
    never auto-linked, so they sat open; **#349** (logging-doctrine tracking
    issue — its own "remaining cleanup" checklist is now 100% resolved,
    verified item-by-item against current `Bruno_Collection/`, no single PR).
  - **Confirmed still genuinely open, real remaining work:**
    - **#306** — ephemeral Bruno env-yml carries the OAuth token in
      plaintext on disk (`worker/runner.js`). Security-relevant, unfixed.
    - **#239**, **#222**, **#211** — scenario-authoring gaps
      (`optionalReservationSelections`, collective booking, night-train
      sales/refund).
    - **#198/#199/#200** — SNCF-specific scenarios (PRM/IRT, claims,
      exchange).
    - **All "fare" issues** (**#205, #206, #207, #242–#248, #255**) — fare
      distribution (Shop/Book/Ticket) scenario coverage hasn't started at
      all yet; a big, self-contained subject to come, not a small follow-up.
  - **Explicitly reserved for the user's own review — do NOT close these:**
    **#226** (exchange → new offer request), **#227** (optional offer-request
    parameters, e.g. age vs. birth date / gender for night trains), **#221**
    (post-refactor code/comment review before merging to master). The user
    is handling these personally; leave them alone unless asked.
- **Flagged, not built:** extend gating (or a parallel mechanism) so the
  unrestricted `buildFulfillmentSection` scenario editor also warns when a
  selected type/media isn't declared in the Test Framework — needs a
  different shape than `frameworkGating.js`'s current boolean-flag engine
  (fulfillment options are a list of `{type, media}` objects).
- **CHAPS**: 8 conformance findings imported, awaiting the vendor's reply.
- **Paxone**: 10 existing findings had `scenarioCode` back-filled (one-off
  console script) — confirmed complete.
- Background/non-code workstreams tracked in the user's cross-session memory,
  not here: OBB dossier for Marcel Koseler, NeTEx↔OSDM / EUDIT-OPI /
  InterMoD-GT6 convergence analyses.
