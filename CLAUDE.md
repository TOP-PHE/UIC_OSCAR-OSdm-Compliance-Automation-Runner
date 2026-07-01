# OSCAR — project memory for Claude

Working notes for picking this project back up cold. See also `README.md`
(monorepo layout), `CONTRIBUTING.md`, and each user's persistent auto-memory
(PR workflow habits, cross-session project context) — this file is the
in-repo counterpart: technical state, not personal working style.

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
- **Versioned SQLite migrations** (`db/db.js`): each migration is
  `{version, name, up()}`, applied once, tracked in `schema_version`. **Never
  edit an already-applied migration** — a column added inside one that already
  ran silently never executes on deployed DBs (the #208 outage class; guarded
  by `tests/unit/db-migrations.test.js`, which boots the real migration path
  against throwaway DBs, including an "already-versioned DB missing a column"
  regression scenario). Always add a *new* migration instead.
- **CI required checks:** Lint/audit/test, CodeQL, Trivy (image scan), Docker
  build, Gitleaks, SonarCloud scan, Bruno-collection validation, PR labeler.
  SonarCloud gained an actual **Quality Gate check step** (#452,
  `sonarqube-quality-gate-action`) — deliberately **not yet required** in
  branch protection since `main`'s gate is currently red on pre-existing
  issues (see §6). Dependabot-triggered runs skip steps needing secrets
  (GitHub withholds secrets from bot PRs) but still report the job green.
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

**Local quirk (this checkout only):** the path contains a space
(`…/UIC_New_Revenue_Management project/…`), which breaks `npx jest`'s default
glob resolution ("0 tests found" even though tests exist). Workaround:
```bash
npx jest --rootDir="$(pwd)" --testMatch="**/*.test.js"
```
Not a real project issue — CI runs plain `npm test` with no problem (no space
in the runner's path).

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
| `Oscar_Server/public/js/scenarios.js` | **the big one** (7000+ lines) — Test Config + Test Framework wizard SPA |
| `Oscar_Server/public/js/findings.js` | Test Findings & Open Points page |
| `Bruno_Collection/library-bruno/*.js` | shared validators run inside Bruno: `scenarioParser`, `requestsBuilder`, `offers`, `bookings`, `refunds`, `exchanges`, `testCapture` (`bruTest()` assertion capture), `displays` (masked logging), `reportGenerator`/`mergeReport`, `loopback`, `osdmEnums` |
| `Bruno_Collection/json_validator/datafile.schema.json` | datafile JSON-schema contract |
| `compatibility.json`, `CHANGELOG.md` | version-pairing ledger + full release history |
| `sonar-project.properties` | SonarCloud scope/exclusions + the custom "OSCAR Gate" thresholds (35% new-coverage / <4% duplication — deliberately below Sonar's stock 80%/3%, since `public/**` and `library-bruno/**` have thin/no test harnesses yet) |
| `tests/unit/db-migrations.test.js` | runs the **real** migration path against throwaway DBs — the #208 regression-class guard |

## 6. Next steps

- **Two of "the 4 issues" from this batch still open** (the other two, #447
  and #448, are done — #447 merged, #448 is PR #454, open, CI green, awaiting
  merge):
  - **#449** — User management at company level.
  - **#450** — Test Config/Test Data: use a Places API to discover stop places.
- **PR #454** (#448, fulfillment-capabilities framework section) — green,
  unmerged as of this writing.
- **SonarCloud Quality Gate** (#452/#453) is live but non-required: `main`'s
  gate is red on ~38 pre-existing accessibility issues (`<input>` missing an
  associated `<label>` across `Oscar_Server/public/*.html`) + new-code
  duplication. Clear those, confirm the gate goes green on `main`, **then**
  add `"SonarQube Quality Gate check"` to branch protection's required list.
- **Flagged, not built:** extend gating (or a parallel mechanism) so the
  unrestricted `buildFulfillmentSection` scenario editor also warns when a
  selected type/media isn't declared in the Test Framework — needs a
  different shape than `frameworkGating.js`'s current boolean-flag engine
  (fulfillment options are a list of `{type, media}` objects).
- **CHAPS**: 8 conformance findings imported, awaiting the vendor's reply.
- **Paxone**: 10 existing findings just had `scenarioCode` back-filled (via a
  one-off console script) — worth confirming it actually ran to completion.
- Background/non-code workstreams tracked in the user's cross-session memory,
  not here: OBB dossier for Marcel Koseler, NeTEx↔OSDM / EUDIT-OPI /
  InterMoD-GT6 convergence analyses.
- Long-tail scenario-authoring backlog (FARE/SNCF/night-train coverage,
  issues #198–#255ish) and a few stale/possibly-already-shipped issues (e.g.
  #325) — don't trust the open/closed state blindly; check `gh issue list`
  and cross-reference recent CHANGELOG entries before acting on an old issue
  number.
