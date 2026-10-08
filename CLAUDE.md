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
  **Express 5** (since 2026-09-05, #492 — see the migration bullet below),
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
- **`canUserSeeRun()` is the only run-visibility rule — route every new
  run-scoped read through it** (`src/api/helpers/run-access.js`, v1.10.0/#60,
  enforced everywhere as of v1.11.194). It returns the run row or `null`;
  `null` means answer **404**, never 403 — several run id spaces are guessable
  (`run_requests.id` is a plain `AUTOINCREMENT` integer), so a 403 confirms
  existence and makes enumeration worth doing. Policy: administrator → always
  `null` (operations role, no test-data read); `certification_user` → only runs
  with `shared_with_certifier_at` set (the company-wide
  `share_reports_with_certifier` toggle was removed in v1.11.15 and is dead
  schema); tester/test_manager → own company; unknown role → fail closed.
  **The failure mode to watch for is a second copy of the policy.** `reports.js`
  grew its own — five handlers branching on `isPlatformRole()` or on the literal
  string `'certification_user'` — and each one was a bypass: findings S1/S4 of
  the 2026-09-05 external assessment, fixed in v1.11.194 (PR-01). A literal role
  comparison in a data-read path is the smell; `isPlatformRole()` is for
  *routing* decisions (which query shape to run), never for *authorisation*.
  Note that `canUserSeeRun` returns `SELECT *`, so project the row before
  returning it or the response silently widens.
- **Authorise before you parse — and testers keep the datafile save, on
  purpose** (S2/S3, v1.11.195). `company.js` `authorizeDatafileWrite(policy)`
  runs as middleware *ahead of* any body parser. For the multipart upload that
  ordering is the fix: multer used to run first with a `diskStorage` whose
  filename was the live `{slug}-datafile.json`, so a refused upload had already
  replaced the file (and a failed validation then deleted it). Uploads now use
  `memoryStorage`; nothing reaches disk until authorised and validated. Any
  future upload route: guard first, parse second, never let a parser's storage
  target be the live artifact. Two policies — `uploadPolicy` (POST, whole-file
  replace) is Test-Manager-only; `savePolicy` (`PUT /datafile/json`, the Test
  Config **Save & Apply**) refuses administrators and certifiers but **admits
  testers**, because Test Config is on the tester menu and it is how testers
  author scenarios and set `scenariosToRun`, which `POST /v1/runs` reads. The
  2026-09-05 audit and our own remediation tracker both said "make PUT
  Test-Manager-only"; that would have stopped every tester from running
  anything but the Test Manager's selection. Do not "fix" it that way. What
  testers may change *within* that save is the next bullet.
- **A tester's save only touches their own scenarios; run lists are personal**
  (v1.11.197; maintainer decision 2026-09-11). `utils/datafileOwnership.js`,
  pure functions: **owned** = not shared and `created_by` is the tester's email;
  **visible** = owned, shared, or no `created_by` (old company scenarios —
  hiding those would empty old datafiles for testers). `GET /datafile` gives a
  tester `viewForTester`: others' private scenarios and the resource entries
  only they use are removed, and `scenariosToRun` is replaced by the tester's
  personal list. `PUT` runs `mergeTesterSave`: owned scenarios are replaced,
  added or deleted; everything else, including every company-level key, is kept
  as stored. Edits to read-only scenarios come back as `read_only_ignored`.
  A new scenario whose code someone else's already uses gets the next free
  code (`renamed`), so it is never dropped and never a 409. A stale copy of a
  scenario the TM deleted or un-shared is discarded, never revived as the
  tester's. **An independent review (4 lenses, every finding reproduced)
  broke the first version 16 ways; the fixes are pinned as lettered tests in
  `tests/unit/datafile-ownership.test.js`.** Things that will bite if
  forgotten:
  - **A tester never writes a company-level key**, first save included; only
    `osdmVersion`/`collection` strings from the editor's skeleton get through.
    Bruno's `setSystemInfoParameters` turns *every* `systemInfoParameters` key
    into an env var for every run, and every request is `{{api_base}}/…`, so a
    planted key sends colleagues' runs, and their bearer tokens, anywhere.
  - **`/data/:filename` is Test-Manager-only for sessions.** It serves the raw
    file. Bruno takes the loopback branch; nothing in `public/` calls it.
  - **Bruno reads `purchaserList[0]` for every scenario** and ignores
    `purchaserListId`, so entry 0 is everyone's and a tester cannot change or
    remove it. The real fix is in the collection (honour `purchaserListId`).
  - **A new link from an own scenario to an entry only hidden scenarios use
    is cut**; otherwise pointing at an id would reveal the entry in the view.
    Links a tester's stored scenario already had are kept, because they come
    from old aliasing, from before anything was hidden.
  - **Read-only comparison tolerates exactly the editor's two backfills**
    (`salesFlowActions` all-true, `offerSearchCriteria` `{}`). Anything wider
    hides real edits; anything narrower makes every save report false edits.
  - **Resource ids are minted in the browser** as max+1 over what the tester
    *sees*, so they can clash with a hidden scenario's entry. The merge never
    lets a tester's entry replace one another scenario references: it
    copies it to a fresh id (copy-on-write). Don't "simplify" this to an id
    match.
  - **Compare scenarios with `canonical()`**, which sorts keys and drops `__`
    keys: `GET` annotates `__featureNotDeclaredWarnings`, so an untouched
    scenario echoed back is not byte-equal.
  - **Every datafile writer takes `withDatafileLock(companyId)`**
    (`utils/datafileLock.js`): save, upload, and `reprojectDatafile`. The merge
    is read-modify-write across `await`s; without the lock, two overlapping
    saves lose one. It is in-process — correct for the single container, not
    for more than one.
  - **Personal run lists live in `run_selections`** (migration 26), not in the
    file: a Test Manager upload must not wipe them, and Bruno's file must not
    carry per-user state. `POST /v1/runs` expands a tester's batch from it,
    limited to what they can see; Test Managers use the file's
    `scenariosToRun`, which is now only the company default. Bruno still gets
    one `scenario_override` per run, and `/data/:filename` stays unfiltered.
  - **The editor applies the same rule, from one file** (v1.11.203, #515).
    `public/js/scenario-access.js` (`OscarScenarioAccess`, loaded before
    `scenarios.js`) holds `isOwnedBy` / `isVisibleTo`, and
    `tests/unit/scenario-access.test.js` pins them to the server's, so change
    both or neither. `isMine` / `isReadOnlyForMe` in `scenarios.js` just
    delegate. A read-only card is locked by two default-deny layers:
    `renderScenarioDetail()` disables every control whose `data-action` is not
    on the view-only allowlist (`READ_ONLY_CARD_ACTIONS`), and
    `isLockedControl()` makes the click/change/input delegates refuse such a
    control. **Draw a card only through `renderScenarioDetail()`**: the pre-#515
    lock lived in `toggleDetail()` and vanished on the first in-place re-render.
    **Add to the allowlist only an action that changes neither the scenario nor
    its resource entries.** A resource-entry edit to a read-only scenario is
    dropped by the merge *without* a `read_only_ignored` line, so the editor
    lock is the only feedback a tester gets. **Drawing must not write to the
    model:** `buildPurchaserSection` used to create an entry for a dangling
    `purchaserListId`, which made the next save report an untouched scenario
    as not kept. That lookup now lives in `purchaserEntryForCard()`, which
    returns before any write for a read-only scenario.
- **The company's OSDM endpoint is the Test Manager's to change** (#544,
  v1.11.207). `companies.api_base` is company-wide: every run of every tester
  goes to it with that tester's token, and `PATCH /v1/company` used to take it
  from any member. The rule is `companyEndpointChange()` in
  `api/helpers/shared.js`, a pure function. It names `test_manager` and
  `administrator` itself: `isPlatformRole()` is also true for a certifier, who
  is only stopped earlier on that route by `resolveCompanyScope`. A tester who
  sends back exactly the stored value gets 200 with nothing written, because
  the page before 1.11.207 did that on every credential save and a page left
  open across an upgrade still does; keep that when touching the route. The
  audit event names the fields sent, not their values, and before this release
  every save by any role wrote one, so the log cannot show a past change.
  `tests/unit/profile-endpoint.test.js` runs an HTML page's own functions and
  `const` lines in a `vm`, the way `scenarios-load-guard.test.js` does for a
  script file.
- **Providers: one company, several OSDM systems** (#540, PR 1 = v1.11.216;
  PR 2 the UI, PR 3 scenario copy with trip re-mapping). A provider is a child
  company (`companies.parent_id`) and reuses every per-company table by its own
  id; users only ever belong to top-level companies. Rules that will bite:
  - **One access rule, `canUseCompany()`** (`api/helpers/provider-access.js`):
    own company for every member; a child of it for the distributor's Test
    Managers, and for testers in `provider_access`. `enforceTenant` sets
    `req.companyId` from it and `canUserSeeRun` calls it. **Routes read
    `req.companyId`, never `req.user.companyId`**: `tests/unit/provider-access.test.js`
    counts every direct read in `src/` and fails on a new one; extend its
    allow-list only with a reason (user directory, `/me`, provider management).
  - **The provider travels with each request** (`X-Provider-Id` or
    `?provider_id=`), never in the body; there is no session-level "active
    provider". Absent = own company. Unknown or refused = 404.
  - **Credentials are per (user, company)** in `tester_credentials`
    (`utils/testerCredentials.js`); the token cache is written back to the same
    row. The `users.*` credential columns are dormant since migration 29 and are
    to be dropped by a later migration. Test fixtures that insert users with
    credentials call `credentialsAsMigrated()` (`tests/helpers/credentials.js`).
  - **The runner re-checks** (`refusedRunScope`): job company = run company, and
    the user may still use it. The run secret stays bound to the run's company.
  - A provider's endpoint goes through `companyEndpointChange()` like any
    company's; a duplicate within the family needs `allow_duplicate_endpoint`
    (audited). Deleting a provider is not built; deleting a distributor that has
    providers is refused.
  - **The pages (PR 2, v1.11.217) choose the provider per browser tab.**
    `nav.js` keeps it in `sessionStorage` (`oscar_provider`) and its fetch
    wrapper adds `X-Provider-Id` to a member's same-origin `/v1/` calls, except
    `UNSCOPED_PREFIXES` (`/v1/auth/`, `/v1/admin`, `/v1/company/users`,
    `/v1/company/providers`); a header the caller set wins. A 404 whose detail
    is exactly `Provider not found.` clears the choice and reloads. A new page
    needs nothing: any `fetch` through `nav.js` follows the selector. A request
    that does not go through `fetch` (a plain link to `/v1/...`) does not, so
    download routes must stay company-agnostic (`canUserSeeRun`) or be fetched.
    Pinned by `tests/unit/nav-provider.test.js`. `providers.html` is the Test
    Manager's page; it names the provider explicitly on each call.
- **Nothing reaches a run's child processes or its environment file
  unfiltered** (tracker PR-03 = NEW-01 + NEW-02, v1.11.208 / OTST_V2.0.102).
  `worker/runner.js` starts two children: the Bruno CLI, and the collection's
  `mergeReport.js`. A `spawn` with no `env` option inherits `process.env`,
  which is how `mergeReport.js` was handed `ENCRYPTION_KEY`. Values were pasted
  into the Bruno env yml between quotes; a scenario code is free text a tester
  stores, and one with a quote and a line break added a second `api_base`.
  Bruno uses the last one, so the run went there with the token of whoever ran
  it, and a Test Manager's "ALL" includes testers' private scenarios. Rules:
  - **Any child process gets `env: childBaseEnv()`** (`CHILD_ENV_ALLOWLIST`),
    plus what it must have. `runner.test.js` fails if a child receives a
    variable that is not on the list, so a new server secret is not passed on.
    This stops inheritance; it is not isolation. Collection code runs as the
    server's OS user and could read `/proc/<ppid>/environ` or the data
    directory. Do not describe the allowlist as protecting against a hostile
    collection.
  - **Write a variable with `envVar(name, value)`, a scalar with
    `yamlQuoted()`. Never interpolate into that file**, not even a number or a
    server-side value. `yamlQuoted` gives a one-line double-quoted scalar of
    printable ASCII: JSON escapes, plus `\uXXXX` from DEL upwards because some
    YAML parsers break lines on U+0085, U+2028 and U+2029.
  - **`tests/helpers/env-yml.js` is a strict reader** that accepts the four
    line shapes and nothing else. `runner.test.js` reads the file `executeRun`
    writes through it; a line pasted by hand fails there.
  - **The proof that Bruno reads back the same value** is `js-yaml` in the unit
    tests (the parser Bruno 4.2.1 uses), and a scratch run of Bruno's own
    loader, `parseEnvironment` in `@usebruno/filestore`, over generated files.
    Running the real `bru` on a three-file collection with two local listeners
    is what showed "the last `api_base` wins".
  - **`js-yaml` is a devDependency and the override is `"$js-yaml"`.** npm
    refuses a direct dependency whose range differs from its override
    (`EOVERRIDE`), so the override follows the dependency.
  - **Escaping is not the end of it: Bruno expands `{{...}}` in a value when a
    script reads it** (`bru.getEnvVar`), and `{{process.env.OSCAR_ACCESS_TOKEN}}`
    is the run's token. Checked with the real CLI. A scenario code holding
    `{{` is therefore refused in `executeRun` before the token is resolved (a
    FAILED run, nothing spawned). Bruno has no literal form for `{{`. The
    dedicated headers keep their templates on purpose (Test Manager only).
    The rule is `refusedScenarioCode()`; it also refuses a code that is not
    text. `POST /v1/runs` leaves non-text codes out of a batch: an object
    cannot be bound to the runs table, and one tester's scenario used to turn
    the Test Manager's "ALL" into a 500. **A run whose `executeRun` throws is
    never marked FAILED** (the queue only logs it), so refuse, do not throw.
    The rest of a scenario's text is the next bullet (NEW-10).
  - A base URL or requestor holding a `"` no longer fails the run with
    `TOKEN_FORMAT_ERROR`. The detection stays as a safety net.
  - The collection counts the datafile's codes instead of listing them when a
    `scenario_override` is missing: the run log belongs to whoever started the
    run, and the file holds everyone's scenarios.
- **Datafile text is never a template** (tracker NEW-10, v1.11.209). Bruno
  fills in `{{...}}` wherever a value is used, and `{{access_token}}` is
  the token of whoever runs. **The collection hands the whole datafile to
  Bruno before every run**: `getScenarioData` stores it as the variable
  `data_base_tmp` and reads it back with `bru.getEnvVar`, which stringifies an
  object, fills in every template and parses it again, and the schema check
  then prints the value of any field that is not in its enum. So a template a
  tester typed into one of their own scenarios showed the token of whoever ran
  *any* scenario, in the run log, readable by the whole company. Both steps
  were checked with the real CLI. Bruno has no literal form for `{{`.
  `utils/datafileTemplates.js`, pure, holds two rules:
  - **A save may not add it** (`templatesAddedBy`): the tester's merged save,
    the Test Manager's whole-file save and the upload answer 400 naming the
    place. A template counts as stored when the same text is at the same
    place, or failing that anywhere; one more copy is new. Nothing else about
    the file is compared, so the editor's backfilled fields, `__` keys and
    reordering never make old text look new.
  - **No run starts while the datafile holds it** (`templatesInDatafile`,
    called from `refusedDatafileText()` in the runner, before the token is
    resolved): every scenario, every entry of every root list, every other
    root key, except `systemInfoParameters` and `knownDeviations`.
  - **Whole file, not "the scenario being run".** The first version looked at
    the running scenario and the entries it points to. An independent review
    showed three holes in that (ids that are missing on both sides match in
    the collection, a save could re-point a clean scenario at an old entry,
    root `osdmVersion`), and reading `getScenarioData` showed it was the wrong
    shape altogether. Do not narrow it again.
  - **Nothing in that module recurses or compares every place with every
    other.** The same review stalled the first version for 17 s with a 195 KB
    save (a quadratic de-duplication) and crashed it with 3,000 levels of
    nesting (a recursive comparison). Sizes and depths are the client's choice.
  - **The runner fails closed:** a datafile that is there but cannot be read
    refuses the run. A missing one is left to the step that already reports it.
    Runner tests therefore seed a real datafile, not "any file that exists".
    The check sits inside the same `try`, so anything that goes wrong in it is
    a refusal too: a thrown `executeRun` leaves the run unmarked.
  - **`viewForTester` threw on a `null` scenario**, which a Test Manager's save
    can store: `GET /datafile` answered 500 to every tester, and the new check
    would have thrown with it. Found by running the first committed rule and
    the final one side by side on 150,000 random files (same places, counts
    and refusals), which is also how the rework was shown to change nothing.
    A fixture with odd scenarios needs a resource list as well, or the line
    that throws is never reached.
  - **What the person running is told** (`templatesForRunner`): a Test
    Manager, every place. A tester, the places in their `viewForTester` view,
    and for the rest one sentence, "in a part of the data file that you cannot
    see": no code, no field, no entry position, no count. A first attempt that
    only masked scenario codes still gave all of those away.
  - **The walk is a generator that reads one child at a time, and the looking
    stops at 1,000** (`STOP_AFTER`; the message then ends "and many more").
    A million templates in a 5 MB body are refused in a few milliseconds. An
    earlier version pushed every child of a list before reading the first and
    took 2.4 s for the same file; one before that built a text for every place
    and used 480 MB. A caller that stops early must not have paid for the
    whole value: keep `lookAtNext()` lazy. What still costs about a second is
    a save over a file that already *stores* several hundred thousand, which
    no save or upload can create any more.
  - **Left alone on purpose:** dedicated headers (templates are their
    documented use) and the two root keys only a Test Manager writes.
  - Two test files cover the routes because `datafileMutationLimiter` allows
    twenty writes per app instance: a test file that makes more gets 429.
- **In the browser, only a 404 means "nothing there yet"** (#534, v1.11.201).
  Test Config read the datafile, the Test Framework and the test data with
  `if (res.ok) use it`, and treated every other outcome as "none". A network
  fault, a 429 from the read limiter or a 500 then looked like a new company,
  and the scenario wizard saved a fresh file over the stored one: reproduced
  on a throwaway server, 16 scenarios → 1 after a single injected 429. Rules
  that came out of it:
  - **Load through `loadForEdit(url, what)`** in `scenarios.js`. It returns
    `loaded`, `none` (404), `signedOut` (401) or `failed` with a sentence the
    page can show. Never write `if (res.ok) x = await res.json()` in front of
    code that can save.
  - **Check every load before replacing anything.** `refreshAllSections()`
    throws on a failed load, before it touches `state` or `wizData`; all its
    callers already show `e.message`. Keep that order when adding a read.
  - **Anything that reads-then-writes must stop on `failed`**, as
    `wizGenerateScenario()` now does. The server still accepts the write; a
    server-side "the client saw the current file" check would be the stronger
    guard and has not been built.
  - **Page functions can be tested without a browser.**
    `tests/unit/scenarios-load-guard.test.js` lifts the real functions out of
    `scenarios.js` and runs them in a `vm` context with a fake `fetch` and
    `document`. It only works for top-level functions laid out with `}` at
    column 0, which is how the file is written.
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
- **An exact-version `overrides` entry is a ceiling, and will silently block
  Dependabot** (2026-09-05, #492 follow-up). `Oscar_Server/package.json`
  pinned `overrides: { "js-yaml": "4.2.0" }`; overrides outrank every
  dependency's own range, so two high-severity js-yaml advisories (#7 merge-key
  quadratic CPU, #18 `!!omap` quadratic CPU — patched in 4.3.0/4.3.1) could
  not be cleared no matter what Dependabot opened. Now `^4.3.1`, which keeps
  the original intent (one deduped js-yaml, floored at a patched version)
  without re-freezing it. If an override must pin an exact version, comment
  why, and revisit it whenever an advisory names that package. Symptom to
  recognise: a Dependabot alert that stays open with no PR, or a PR that
  changes nothing in the lockfile.
- **Several Dependabot npm PRs open at once: combine them** (2026-10-06, #547).
  `main` requires a branch to be up to date before merging, and every npm
  update touches `package-lock.json`, so five PRs mean five rounds of rebase
  and CI. Dependabot rebases its npm PRs about three minutes after the
  lockfile changes on `main`, and sometimes fails to ("tried to update this
  pull request, but something went wrong"). Instead: cherry-pick Dependabot's
  commits, unchanged, onto one branch from `main`, check `npm ci --dry-run`,
  and open one PR. It runs the full CI, which Dependabot's own runs do not
  (they skip the steps that need secrets), and Dependabot closes its PRs by
  itself once the combined one is on `main`. A dependency-only merge does not deploy: it needs
  a release entry of its own if it should ship (1.11.205 / 2026.230).
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
  - **`at-rest.js` retries its rename, and a test that writes files should not
    need to** (v1.11.196). On Windows, OneDrive, Defender and the indexer
    briefly lock a freshly written file. The atomic temp+rename in
    `encryptToFile` / `encryptToFileAsync` then failed with `EPERM` and left a
    `*.tmp.<hex>` behind: 14 of 400 back-to-back rewrites on this
    OneDrive-hosted checkout, which is why the local full suite used to flake.
    Both writers now retry the rename, and the cleanup `unlink`, on
    `EPERM`/`EBUSY`/`EACCES`: 10 attempts, 940 ms total. They remove the temp on
    final failure. This is on every platform, so Linux CI exercises the path.
    If a local full-suite failure still shows `EPERM`, the lock lasted over a
    second — that is new information, not the old flake. Tests that need to
    inject it mock `fs.renameSync` / `fs.promises.rename` (see
    `tests/unit/at-rest-rename-retry.test.js`), and read the schedule from the
    exported `RENAME_RETRY_DELAYS_MS` rather than restating it.
  - **Mutation-check any test written as a regression guard** — assert it
    actually fails against the bug it claims to catch, before trusting it.
    Live example (#492): a `GET /` test written to catch the wrong SPA
    wildcard passed under *both* spellings, because `express.static` is
    mounted first and answers `/` out of `index.html` before the fallback
    route is ever consulted. The guard looked right, ran green, and proved
    nothing. The real discriminator was the route pattern itself
    (`app.router.stack` → `layer.route.path` / `layer.match('/')`) — a
    deliberate, documented coupling to an Express internal, because it is
    the only place the difference is observable.
- **Sonar code-smell backlog: five behaviour-neutral PRs, tracked in #523**
  (started 2026-10-05; 1,333 smells on `main`, 0 bugs, gate green). PR 1,
  server code, is #524 (v1.11.199, merged). PR 2, the "possible defect"
  findings in the UI and the Bruno library, is #525 (v1.11.202 /
  OTST_V2.0.101). PR 3, `public/js/scenarios.js`, is #526 (v1.11.204): 340 of
  that file's 373 findings. PR 4, the HTML pages, is #527 (v1.11.206). The
  gate only judges new code, so none of this blocks a release. What they
  established, for #528 (the Bruno library), which is the one left:
  - **The findings are public.** No token is needed:
    `https://sonarcloud.io/api/issues/search?componentKeys=TOP-PHE_UIC_OSCAR_Temporary&branch=main&resolved=false&ps=500`
    (add `&pullRequest=N` instead of `branch` for a PR). Each issue carries an
    exact `textRange`, so a rename-type rule can be applied by range and
    asserted against the text it expects.
  - **`isNaN(x)` → `Number.isNaN(x)` is not a rename.** `Number.isNaN` does
    not convert its argument: on a `Date` it is always false. Test
    `date.getTime()`. `parseInt` and `NaN`, by contrast, are the same objects
    under `Number`.
  - **`a && a.b` → `a?.b` only differs when `a` is `0`, `''` or `false`**, and
    then only if the value is stored or passed on. Read those sites; the ones
    in a condition, a `||` fallback or a `!!` need no thought.
  - **What Sonar accepts for an ignored exception (S2486)**, worked out from
    which catches it flags: it only looks at a `try` with two or more
    statements whose catch parameter is unused. `catch { … }` with no binding
    passes; so does an empty block that holds a comment. A comment next to a
    statement, with an unused `(_)`, does not.
  - **A super-linear regex (S8786) is fixed by leaving one way to match**, not
    by tuning quantifiers, and proved by running old and new over every string
    on a small alphabet (7–10 characters, a few million inputs, seconds in
    Node). Trailing-run trims (`/x+$/`) become a loop.
  - **Not everything Sonar asks for is taken.** `for…of` over a `Buffer`
    measured 5× slower than the indexed loop (`zip.js`, S4138), so it stays.
    Code inside an already-applied migration is not restyled either. A finding
    left open on purpose is named in the CHANGELOG entry with its reason.
  - **The pages have a compile check now** (`tests/unit/ui-scripts.test.js`,
    #525). ESLint ignores `public/` and the inline-script lint only looks for
    a stray closing script tag, so a syntax error in a page used to reach
    `main` unnoticed. The same file runs page helpers in a bare `vm` context:
    `loadFunction(file, name)` lifts a top-level function out of a page by its
    `function name(` line and the next `}` at column 0. Use it for any pure
    helper touched in PRs 3 and 4.
  - **A trim after a collapse needs no quantifier.** `/^_+|_+$/g` right after
    `.replace(/_+/g, '_')` only ever meets one character at each end, so
    `/^_|_$/g` is the same thing and cannot backtrack. It is not the same
    where underscores the user typed survive (the ancillary code in
    `scenarios.js`): that one needs a real trim.
  - **Check the lines you touch for other findings first.** A pre-existing
    smell on a line you rewrite is reported on the PR as new. Sonar's
    newer rules also matter here: 20 un-awaited promises in `scenarios.js`
    (S9383) were typed as *bugs*, and a PR that rewrites such a line fails
    the gate. #526 fixed them first, before any restyling. Check for a new
    bug-typed rule the same way before PRs 4 and 5.
  - **Reading "ignored exception" findings found a real defect, #534:** Test
    Config treated any failed datafile load as "no datafile yet", and the
    scenario wizard then saved a fresh file over the stored one. It was fixed
    on its own (v1.11.201, the `loadForEdit` bullet above), not inside the
    clean-up PR. Reading a finding is worth more than clearing it.
  - **A linear-time test should fail in seconds, not minutes.** Size the input
    so the old pattern takes a few seconds (60,000 digits for `parseVersion`).
    At 100,000 a regression would have held CI for minutes before failing.
  - **An action nothing awaits ends in `.catch(reportActionError)`** (#526).
    The click, change and timer handlers of `scenarios.js` are not async, so
    a bare `saveDatafile();` loses any rejection. `reportActionError` logs it
    and shows the reason as a toast. `ui-scripts.test.js` reads the source
    for a top-level async function called as a bare statement; a new one
    fails it.
  - **Flatten a nested conditional without touching the template.** Either
    `let x = ''; if (cond) { x = <the same template>; }`, or work the inner
    piece out in a variable before the template. The text of the template
    does not change, so neither does the HTML. Sonar does not look across a
    function boundary: a condition inside an arrow function inside a template
    is not "nested".
  - **Compare the old and the new page in a browser, by hash.** With no DOM
    harness for `public/`, this is the check that a restyling of a render
    function changed nothing: on a throwaway server, capture what the page
    builds and draws (every card, the framework editor, the wizard, the file
    the wizard would save with `Math.random` fixed), put
    `git show main:…/scenarios.js` over the file, reload, capture again,
    compare. #526 compared 86 captures. Restore the file with
    `git checkout --` and check `git status` straight after.
  - **A commit that only renames can be proved.** Undo the rename in both the
    old and the new text with the same regex and compare: any other change
    shows. Used for `Number.parseInt` and `replaceAll`.
  - **`esc()` keeps `replace()` with a global regex, in every page.** Sonar
    (S7781) asks for `replaceAll('<', ...)`. #526 did that in `scenarios.js`
    and CodeQL stopped recognising the encoder: it reported three escaped
    values reaching `innerHTML` as XSS. The data-flow paths in the SARIF
    (`gh api repos/.../code-scanning/analyses/<id>` with
    `Accept: application/sarif+json`) run straight through the `replaceAll`
    chain. The security scanner wins; the five findings stay open. PR 4 will
    meet the same encoder copied into the HTML pages: leave it alone there
    too.
  - **A large diff in a file makes CodeQL report that file's old alerts as
    new.** #541's check failed with 16 alerts, 13 of them open on `main`
    since May. `gh api .../code-scanning/alerts?ref=refs/heads/main` tells
    old from new. The 12 high ones (`Math.random()` feeding fields CodeQL
    reads as personal data) were fixed for real with `randomInt()` on
    `crypto.getRandomValues()` (#542). The `CodeQL` results check is not in
    the required list (`Analyze (javascript-typescript)` is), so GitHub would
    have merged with it red: read the checks, not only the merge state.
  - **Left open in `scenarios.js` on purpose (33):** the 5 in `esc()`; 20 functions over the
    complexity limit (S3776) and the 72-case switch (S1479), not planned; 4
    sequential `await`s in a loop (S9382); 2 TODO comments (S1135);
    `e.returnValue` in the unsaved-changes prompt (S1874), which older
    browsers need.
  - **PR 4, the pages, is #527 (v1.11.206): 90 of 113.** Five HTML pages changed.
    What it added to the method:
    - **A page can be compared with itself without a browser.** Run the
      page's inline script from `main` and from the branch inside
      `with (proxy) { … }`, where the proxy answers every unknown name with a
      stub and a fake `document` records each write (`innerHTML`, text,
      `checked`, Blob content, fetch calls, dialogs). A closing
      `proxy.__hook = c => eval(c)` inside the block lets the test set the
      page's `let` state and call its functions. Same scenarios against both,
      and the two recordings must be equal. Scratch work, not in the repo.
    - **Then prove the comparison reaches the changed lines:** break each
      changed expression in turn and check that it reports a difference. The
      first run missed nine sites (a function never called, a `fetch` that
      never answered, a fake element without the attribute it was selected
      by). A comparison that says "identical" has shown nothing until this is
      done.
    - **`getAttribute('data-x')` and `dataset.x` differ for a missing
      attribute:** `null` against `undefined`. Harmless when the page writes
      the attribute itself, but read each site.
    - **Do not rewrite a read that feeds an open code-scanning alert.**
      `switchHttpTab()` in `report-builder.html` keeps `getAttribute`: the
      value is the source of alert 37, and `dataset` might hide the flow from
      CodeQL without fixing it. `gh api …/code-scanning/alerts?state=open`
      lists the lines to stay off.
    - **`word-break:break-word` → `overflow-wrap:anywhere`** is the same
      rendering by definition (CSS Text 3). Checked by measuring 1,600 layouts
      in Chromium, with a control showing the measurement tells other wrapping
      rules apart. `overflow-wrap:break-word` is *not* the same in table cells
      and min-content boxes.
    - **`<\/script>` inside an inline script is not a needless escape**
      (S6535), whatever Sonar says: the HTML parser needs it.
    - **Take a nested conditional out as a top-level function** when it
      depends only on its inputs. `loadFunction()` can then test it, and the
      host function's complexity does not go up.
    - **Left open on purpose (23):** 21 `replace(/x/g)` in the pages' encoders,
      the one `getAttribute` above, the one `<\/script>`. Three tests in
      `ui-scripts.test.js` pin them. Out of scope: 97 contrast and 8 other
      accessibility findings (decision pending), 15 functions over the
      complexity limit.
- **Express 5 since 2026-09-05 (#492).** Arrived as a Dependabot bump —
  express 4.22.2 → 5.2.1 — because express 4 pins `qs: ~6.15.1`, so qs
  could not move to 6.16.0 without it. The whole migration was **one line**:
  the SPA fallback in `src/server.js`. Express 5 ships path-to-regexp v8,
  where a bare `'*'` route is a hard **parse error at require-time**
  (`TypeError: Missing parameter name at index 1: *`) — it does not fail a
  request, it fails `require('src/server.js')`, so `tests/unit/server.test.js`
  died as "Test suite failed to run" with **0 failed tests**, and CI reported
  `1343 passed` while silently never running that file's 30 tests. A suite
  count that drops while the test count stays green is the signature.
  - **Use `/{*splat}`, not `/*splat`.** The Express 5 migration guide's
    headline suggestion, `/*splat`, is *not* equivalent to Express 4's
    `'*'`: it matches every path **except** the root `/`. Only the braced
    `/{*splat}` matches the root too. Both load without error.
  - Nothing else needed changing — swept and verified: no other wildcard or
    regex route paths, no `:param?` optionals, no `req.query` assignment, no
    `req.param()`, no `res.send(<status>)`, no `res.redirect('back')`, no
    `app.del()`, no `req.host`. All 21 `req.body` destructuring sites already
    used `req.body || {}`, which matters because **Express 5 leaves
    `req.body` `undefined`** (not `{}`) when there is no body or the
    Content-Type doesn't match — verified empirically. The two unguarded
    `req.body.<prop>` reads (`admin.js:756`, `auth.js:357`) sit behind
    `express-validator` `validate([...])`, which 400s before the handler.
  - Peer deps were already Express-5-ready at their existing pins:
    express-rate-limit 8, express-validator 7, helmet 8, multer 2.3,
    swagger-ui-express 5.
  - **Touching the fallback line re-opened a dormant CodeQL alert.** The
    handler's `fs.existsSync`/`res.sendFile` had always been there, but
    CodeQL scopes to the PR's diff — editing line 573 made the whole handler
    "changed code" and `js/missing-rate-limiting` fired high-severity. Same
    trap as the §2 coverage-push notes: a one-line edit can inherit an alert
    for code you didn't write. Fixed per this repo's standing convention (a
    real limiter, never a suppression) with a dedicated `spaShellLimiter` —
    its own bucket, not `fileDownloadLimiter`'s, because the SPA shell is the
    unauthenticated entry point for every navigation and must not consume the
    report-download budget.
- **"Not implemented" is a skip, not a failure — but only on the optional,
  read-only GETs** (#488/#489, 2026-09-03). `osdmCompliance.js`
  `classifySystemInfoStatus()` (all 10 `01-System Infos Requests` files via
  `handleSystemInfoStatus()`, plus `04. GET Passenger`, `11. GET Refund
  Offer`, `12. GET Exchange Offer`) treats HTTP 501, an OSDM Problem body
  with `OPERATION_NOT_PERMITTED`, or a bare 404 as "not implemented by this
  provider" (INFO, passing row), and a bare 403/405/500 the same way at
  WARNING level; 401 always fails; 406 and anything else fail unless
  baselined as a Known Deviation. Standards basis (verified 2026-09-03
  against osdm.io/spec/errors-problems + RFC 9110): OSDM defines no
  endpoint-level not-implemented signal of its own — only 501/404/405 mean
  it per HTTP; 403/500 are accepted on SBB field evidence only, which is why
  they are WARNING-tier and the provider-facing text cites RFC 9110, never
  "OSDM expects". The Report Builder's Vendor Capability Matrix
  (`reports/structureResults.js` `classifyVendorCapability`) mirrors this
  through an **exact-request-name allowlist** (`CAPABILITY_PROBE_ENDPOINTS`)
  — never a blanket status-code rule, which would relabel NHF probes that
  deliberately expect those codes. Mutation endpoints (POST/PATCH/DELETE)
  keep their strict checks.
- **Booking price members are lifecycle-scoped** (#375, #496).
  `bookings.js` `isPostConfirmationStage()` decides which member a
  GET-Booking step asserts: PREBOOKED/ON_HOLD → `provisionalPrice`
  ("unconfirmed pre-booked parts"); CONFIRMED/FULFILLED/REFUNDED/EXCHANGED →
  `confirmedPrice` ("confirmed parts minus confirmed refund amounts");
  EXCHANGE_ONGOING deliberately stays provisional (the exchange creates new
  pre-booked parts). The other member is optional at every stage. At
  REFUNDED/EXCHANGED an `[INFO]` line shows confirmedPrice before/after —
  logged, not asserted (open OTST point, see §6).
- **`OSDM_Simulator/` is a stub OSDM provider for testing OSCAR, not a third
  half of the product** (#575, 2026-10-08, written for the external security
  test). It issues its own tokens and answers a basic sale; everything else is
  501. No dependency, own `package.json`, not in `compatibility.json`, not
  deployed with the server: it runs on a host of its own behind nginx, because
  `urlPolicy.js` (S5) only lets a run go to https on a public address and that
  rule must not be loosened for it. Three providers, `alpha` / `beta` /
  `gamma`, named by the first path segment, so OSCAR needs no change (one
  endpoint per company, one per provider under #540). What to keep in mind:
  - **The provider check and the client check are two guards, and only a
    client id that exists on two providers tells them apart.** The first tests
    passed with `claims.provider === provider.key` removed, because no id was
    shared. `tests/helpers.js` has `same-id` on alpha and beta for that.
  - **The collection sends a search's `departureTime` without an offset**
    (`2026-10-18T08:00:00`). It is read in the provider's `utcOffset`, and the
    answer always carries an offset.
  - **`04. GET Passenger` compares with the `update*` values even when the
    scenario turned the PATCH step off**, so a scenario with
    `patchPassengers: false` fails five checks on any provider. The ready-made
    scenarios keep it on.
  - **To run the real collection against it locally:** a throw-away OSCAR
    server with `ALLOW_PRIVATE_TARGETS=1` and `BRU_CMD=bru.cmd` set before
    `require('src/server.js')`. The local `Oscar_Server/.env` has
    `BRU_CMD=echo`, and dotenv does not replace a variable already set: without
    that line a run "completes" with no request made. Seed the company and a
    Test Manager, then `PATCH /v1/company`, `PATCH /v1/me/credentials`,
    `PUT /v1/company/datafile/json`, `POST /v1/runs`.
  - **`node --test` takes a glob, not a directory**, on Node 22 and later
    (`node --test "tests/*.test.js"`), and its lcov reporter does not create the
    destination directory. Sonar's coverage run starts from the repository root
    so that the report's paths are `OSDM_Simulator/src/...`.
  - **A body over the limit is read to its end before the 413**, without being
    kept, up to a second limit. Answering while the caller is still sending
    closes the connection under its feet and it never sees the status.
  - It is linted and tested in the required `Lint, audit, test` job (a new
    workflow would not be a required check), with the ESLint that
    `Oscar_Server` installs.
  - **Three scanners stopped its first push, each on something the tests could
    not see.** Gitleaks (`curl-auth-user`) fires on a `curl` example that
    passes a quoted name and secret with its user option, in a document and
    even when the secret is a placeholder, and it scans every commit of the
    PR, so a later commit does not clear it: write the example with the
    credentials in the body and shell variables, and amend. CodeQL
    (`js/user-controlled-bypass`) fires on `match && tokens.verify(match[1])`:
    a call named *verify* that the caller's input can skip; call it always and
    let it refuse what is not a token. Sonar (S8707) counts a command-line
    argument that reaches a file path as a vulnerability, and one
    vulnerability fails the gate like one bug does: `make-clients.js` now
    writes to one of two fixed places.
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

**Claude Code worktrees (`…/oscar-monorepo/.claude/worktrees/<name>/`)** trip
over the `.claude` dot-directory twice. First, `npx jest` finds 0 tests, and so
does a positional path filter: use
`npx jest --rootDir="$(pwd)" --testMatch="**/tests/**/*.test.js"`, and
`--testPathPatterns=<name>` to narrow. Second, `server.test.js` › *SPA fallback
› an unmatched deep GET…* fails with 500. Express's `send` refuses any absolute
path containing a dot-segment, so `res.sendFile(public/index.html)` 404s
internally. That one failure is the path, not the code: it passes in CI and in
the main checkout. Run the full suite from a dot-free path before calling a PR
green. What works:
`git archive <commit> | tar -x -C <short dir>`, then `npm ci && npx jest` in its
`Oscar_Server/`. Don't `git worktree add` into the session scratchpad: its path
is too long for git on Windows (`'$GIT_DIR' too big`), and too long for
`node_modules` too.

From `OSDM_Simulator/` (no install step, it has no dependency):
```bash
npm test           # node --test "tests/*.test.js"
node ../Oscar_Server/node_modules/eslint/bin/eslint.js . --max-warnings 0
```

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
- `OSDM_Simulator/` has its own `package.json` version and bumps none of the
  three either: it is not part of a server/collection release (#575).

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
| `Oscar_Server/src/utils/datafileOwnership.js` | what a tester sees (`viewForTester`) and may change (`mergeTesterSave`) in the company datafile — pure, v1.11.197 |
| `Oscar_Server/src/api/helpers/provider-access.js` | `canUseCompany()`, the one rule for which company (own or provider) a member may act in, #540 |
| `Oscar_Server/src/api/routes/company-providers.js` | provider list/create/rename and tester access list, #540 |
| `Oscar_Server/public/providers.html` | Providers page (Test Managers): add/rename, endpoint, tester access, #540 |
| `Oscar_Server/src/utils/testerCredentials.js` | a tester's OSDM credentials per (user, company), #540 |
| `Oscar_Server/src/utils/runSelections.js` | a tester's personal run list (`run_selections` table), v1.11.197 |
| `Oscar_Server/src/utils/datafileLock.js` | per-company lock every datafile writer takes, v1.11.197 |
| `Oscar_Server/src/api/routes/company-places.js` | Places API cache: `POST /places/refresh` (paginated download) + `GET /places?q=` (ranked search), #450 |
| `Oscar_Server/public/js/scenarios.js` | **the big one** (7000+ lines) — Test Config + Test Framework wizard SPA, incl. `attachPlaceAutocomplete()` |
| `Oscar_Server/public/js/scenario-access.js` | the editor's read-only rule (`OscarScenarioAccess`): ownership pinned to `datafileOwnership.js`, plus the view-only allowlist for read-only cards — browser global and CommonJS, v1.11.203 (#515) |
| `tests/unit/scenario-access.test.js` | client/server ownership parity + default-deny lock + `scenarios.js` wiring checks (no DOM harness exists for `public/`) |
| `Oscar_Server/public/js/findings.js` | Test Findings & Open Points page |
| `Bruno_Collection/library-bruno/*.js` | shared validators run inside Bruno: `scenarioParser`, `requestsBuilder`, `offers`, `bookings`, `refunds`, `exchanges`, `testCapture` (`bruTest()` assertion capture), `displays` (masked logging), `reportGenerator`/`mergeReport`, `loopback`, `osdmEnums` |
| `Bruno_Collection/json_validator/datafile.schema.json` | datafile JSON-schema contract |
| `compatibility.json`, `CHANGELOG.md` | version-pairing ledger + full release history |
| `sonar-project.properties` | SonarCloud scope/exclusions + the custom "OSCAR Gate" thresholds (ratcheted 35%→83% new-coverage / <4% duplication as the coverage push landed — see §2) |
| `tests/unit/db-migrations.test.js` | runs the **real** migration path against throwaway DBs — the #208 regression-class guard |
| `tests/unit/runner.test.js` | `worker/runner.js` coverage — `child_process.spawn` fully mocked via a `makeFakeProc()` EventEmitter + `waitForSpawnCalls()` polling helper (never a fixed sleep) |
| `tests/unit/server.test.js` | `src/server.js` coverage — supertest against the real exported `app`; one isolated `NODE_ENV=production` re-require covers the HTTPS-redirect middleware; the `SPA fallback` block guards the Express 5 `/{*splat}` route pattern (#492) |
| `tests/integration/company-places.test.js` | Places API: refresh pagination/dedupe (stubbed `fetch`), ranked `?q=` search, role gating |
| `OSDM_Simulator/src/app.js` | the simulator's routing: provider from the path, token endpoint, Bearer check, per-client scope, 501 for what it does not provide (#575) |
| `OSDM_Simulator/src/osdm/offers.js`, `bookings.js` | the simulated answers: a trip built from the request, three offers, PREBOOKED → FULFILLED |
| `OSDM_Simulator/oscar/datafile.json` | ready-made data file, two sale scenarios; `tests/datafile.test.js` keeps it valid and answerable |
| `Documentation/Server_Operations/OSCAR - OSDM Simulator.md` | installing the simulator on its own host and pointing a company at it |

## 6. Next steps

- **Open OTST point (#496, 2026-09-03):** OSDM defines `confirmedPrice` as
  net of confirmed refund amounts, but SBB INT still showed the pre-refund
  amount after REFUNDED. OSCAR only logs before/after at INFO; turning it
  into an assertion (or a per-company Known Deviation) waits for OTST/SBB to
  say whether that run was a partial refund or a deviation.
- **Left open by the v1.11.197 review (known, 2026-09-11):**
  - *Personal run lists are keyed by scenario code.* A Test Manager renaming a
    shared scenario drops it from every tester's personal list, and they must
    tick it again. There is no stable scenario id to key on; adding one is the
    real fix.
  - *Bruno ignores `purchaserListId`* and uses `purchaserList[0]` for every
    scenario (`library-bruno/scenarioParser.js`). The merge protects entry 0,
    but the collection should resolve the purchaser by id like the other lists.
  - (*Scenario codes reaching the Bruno env YAML unescaped*, and the run log
    listing codes, were fixed by tracker PR-03 in v1.11.208 / OTST_V2.0.102;
    see the §2 bullet on a run's child processes and environment file.)
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
  it resumes. `library-bruno/` is only partly tested: twelve
  `tests/unit/bruno-*.test.js` files reach about half of its 28 modules
  (`requestsBuilder`, `scenarioParser`, `osdmCompliance`, `partialRefund`…);
  `reportGenerator`, `mergeReport`, `refunds`, `exchanges`, `fulfillments`
  and `validators` have none (checked 2026-10-05).
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
    - (**#306**, the OAuth token in plaintext in the ephemeral Bruno env-yml,
      was listed here as unfixed. It was fixed the next day by PR #468 and
      closed on 2026-07-03; checked 2026-10-06.)
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
