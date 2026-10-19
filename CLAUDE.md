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
  - **Return models** (#619, 1.11.236) use both: `returnModels` in the
    framework, `scenarioReturnModel()` in `frameworkGating.js` and its twin in
    `scenarios.js` (keep them alike), and a picker that keeps a scenario's own
    undeclared model, marked, rather than changing it on display. A framework
    without the key is migrated from its scenarios on first read
    (`needsFrameworkMigration`); absent = no warning, `[]` = none declared.
  - **Partial refund scopes** (#713, 1.11.271): `partialRefundScopes`
    (`FULFILLMENT` / `LEG` / `PASSENGER`) under REFUND_PARTIAL. Absent = every
    scope. A rule's `scope` in `frameworkGating.js` is checked by
    `partialRefundScopeDeclared()`, and the catalogue's `missingFor()` says
    "partial refund by …". The page's `FW_PARTIAL_REFUND_SCOPES` is pinned to
    the rule table by `ui-scripts.test.js`.
  - **Offer request forms** (#748, 1.11.289): `offerRequestForms`
    (`SEARCH` / `SPECIFICATION` / `TRIP_IDS`). Absent = every form. A
    scenario's form is `offerRequestFormOf()`: trip ids when it arms them, else
    its trip's type; it needs the datafile, so the warning
    (`offerRequestBy:<form>`) is added in `annotateDatafile()`, not in
    `scenarioWarnings()`. The catalogue gives a one-way search without the
    train filter one variant per declared form, in the order SEARCH,
    `<code>_SPEC`, `<code>_TRIPID` (#759, 1.11.294): the first declared form
    replaces the entry in place (`tripAs`), the others are twins
    (`variantOf`) right after it. `catalogueFor()` makes the entries,
    `withOfferRequestForms()` (`catalogueMatch.js`) the scenarios: a
    specification rides a one-leg trip of its own, a trip-id copy keeps the
    search trip and arms `offersByTripIds` (#602). All 29 convertible sources
    pass on the simulator by trip id. A
    specification names the train number and carrier (`DatedJourney` requires
    both), so a simulator search trip, which has neither, cannot be converted
    as it is: the copy fills the leg from the Test Data train. To run the
    converted scenarios on the simulator, give the legs a number (the check
    used `vehicleNumber: '1001'`). The exchange's offer request
    (`requestExchangeOffersBody()`) follows `TripType` since then; it sent a
    null `tripSearchCriteria` for a specification.
  - **Place selection flows** (#766, PR 1 = 1.11.297): `placeSelectionFlows`
    (OSDM `PlaceSelectionFlow`: `AUTOMATIC_PLACE_SELECTION`, `…_PREFERENCES`,
    `…_NEARBY`, `MANUAL_PLACE_SELECTION_WITHOUT_FEE`, `…_WITH_FEE`). Absent =
    every flow. A scenario's flow is its own `placeSelectionFlow`, else its
    place fields: `placeSelectionMode` = a named place, COUCHETTE/BERTH or
    `reservationBookingForm` PLACE_SELECTION = automatic, otherwise none.
    `placeSelectionFlowOf()` (server) and `flowOfScenario()`
    (`library-bruno/placeSelection.js`) must stay alike: a test runs both
    over every simulator scenario. Warning `placeSelectionBy:<flow>`;
    catalogue `missingFor()` "place selection …". Step 01 logs what the offer
    lists (`supportedPlaceSelectionFlows`, `availablePlacePreferences`), a
    WARNING only for another flow or no reservation part. PRs 3–5 send the
    other choices (named seat and compartment with or without fee, nearby,
    after the booking); the plan and grading are in #766.
    **PR 2 (1.11.298): seat preferences.** `placePreferences` (PlaceProperty
    codes, a list or "WINDOW, POWER") implies the AUTOMATIC flow and, with no
    form named, `reservationBookingForm` PLACE_SELECTION. Step 01 keeps those
    the offer lists (`choosePreferences()`; the others are a WARNING, none
    listed at all = all sent); in the PREFERENCES flow 02's before-request asks
    `GET /availabilities/preferences` once per offer (`askPlacePreferences()`,
    checks recorded by 02's after-response, as #602 does); the builder puts
    them in `placeSelections[].accommodations[].placeProperties`
    (`withSeatPreferences()` → `withPreferences()`); 07 warns when a booked
    place does not name one (`checkPreferencesGiven()`). **OSDM 3.8's
    `ReservationOfferPart.availablePlacePreferences` is a list** of
    AvailablePlacePreferences; PR 1 read it as one object, `preferenceSetsOf()`
    reads both. The simulator offers preferences on trips from `0000092` only
    (`placePreferences` in the profile, `TABLE` sold out; variant
    `ignores-place-preferences`), so no other scenario's answer changed. The
    OSDM code lists (osdm.io) were not reachable: the codes are the spec's
    examples. A catalogue entry with preferences needs `providerValues`
    `placePreferences`.
    **PR 3 (1.11.299): a named place or compartment.** A scenario whose own
    `placeSelectionFlow` is MANUAL_… (and no older `placeSelectionMode`) gets
    `namedPlaceKind` (PLACE / COMPARTMENT) from the parser; 02's before-request
    asks `POST /availabilities/vehicle-place-map` once per offer
    (`askNamedPlaces()`), `library-bruno/namedPlaces.js` (pure) chooses FREE
    seats (fee seats first in the fee flow) or a selectable compartment, the
    builder adds them (`withNamedPlaces()`), and 07 fails a place not given or
    a price that is not the offer's plus the fees (`checkNamedPlacesBooked()`).
    `validatePartPrices()` accepts offer price + fee for those reservations.
    `sendAvailabilityRequest()` takes a POST body (named `payload`: a local
    `body` shadowed it once, and every map request went out as HTTP 0).
    Simulator: `placeMap` from `0000091`, coach 7. In the same PR, from two
    real providers' runs: **`console.log` in a request file never reaches the
    HTML report** (only `validationLogger` does; a test refuses a tagged
    `console.log` now); an empty booked `appliedPassengerTypes` is a WARNING;
    a booking refused with seat preferences is sent once more without them
    (`bookingWithoutPreferences()`), to tell a refused preference (FAIL if the
    offer listed it, else WARNING) from a refused reservation.
    **PR 4 (1.11.300): near a given place.** Flow NEARBY plus
    `referencePlace` "coach/place" → env `nearbyReference`; 02 asks
    `GET /availabilities/nearby` per reservation (`askNearbyPlace()`, checks
    recorded with the others by `recordPlacePreferenceChecks()`), the builder
    adds `referencePlace` to every selection naming no place
    (`withReferencePlace()`), 07 runs `checkNearPlaceGiven()`: another coach a
    WARNING (`level: 'warn'`, logged), the reference itself a FAIL. "Near" =
    same coach, OSDM gives no distance. The catalogue's needs carry
    `providerValues` `referencePlace`, and the copy lists it to complete
    (the simulator's `7/15` means nothing elsewhere).
    **PR 5 (1.11.301): the same choices after the booking.** With
    `reservationBookingForm` ADD_LATER, 09's before-request calls
    `askPlacesAfterBooking()`: the three asks of 02 with
    `placeChoiceContext(true)` (contextType BOOKING, contextId the booking,
    ids = `reservationAddLaterSelections`, guard key `BOOKING:<id>`), then
    `laterPlaceSelections()` (`requestsBuilder.js`) applies preferences, named
    places and reference place; named choices are merged with the booking's.
    09's after-response records their checks first. `placeChoiceAfterBooking()`
    silences 02's "nothing placed" warnings when the choice comes later. The
    simulator resolves a BOOKING context to the offer that holds the
    reservation (`offerInContext()` in `app.js`); trips 17/18 are EuroCity
    (optional reservation) from the map and preference stop places.
    **The reference place from a first booking (#776, 1.11.304).** A coach
    and place belong to one train: `referencePlace` empty or `AUTO`
    (`isAutoReference()`, env `nearbyReferenceAuto`) makes
    `askNearbyPlace()` call `makeReferenceBooking()` first. It re-sends 01's
    offer request for the first passenger alone, books the offer standing
    for the chosen one (`referenceOffer()` = `matchingOffer()` among offers
    holding a reservation), and sets `nearbyReference` from the place given.
    It runs once per sale (`__referenceBookingTried`), before 02, or before
    09 with ADD_LATER. `releaseReferenceBooking()` sends `DELETE
    /bookings/{id}` at the top of 02's and 09's after-response, so A's place
    is taken while the provider places the others. Failures are WARNINGs and
    the sale goes on without a reference. The catalogue's needs leave out
    `referencePlace` for `AUTO`. Simulator 0.30.0: DELETE of an unconfirmed
    booking; on a map train, an automatic place is a free saloon seat of
    coach 7 (a reference place must be on the map there).
  - **Offer search options** (#780, PR 1 = 1.11.306): `offerSearchOptions`
    (`offerModes`, `requestedOfferParts`, `travelClasses`,
    `serviceClassTypes`), each absent = every value. Not the old
    `offerCriteria` members: no page ever showed them, so their stored
    defaults (SECOND, STANDARD…) are not declarations; only
    `offerCriteria.flexibilities` is. Warning `offerOption:<key>=<value>`
    from `annotateDatafile()`, the criteria read as the collection does
    (`scenarioOfferCriteria()`: own, else the list entry's first). After 01,
    `checkOfferSearchCriteria()` (`offerCriteria.js`) says whether the offers
    keep to each option sent: never a failure (OSDM: classes may differ),
    WARNING when no offer does, INFO when some do not. The page's
    `FW_OFFER_SEARCH_OPTIONS` is pinned to `OFFER_SEARCH_OPTIONS`.
    **PR 2 (1.11.307): probes.** `offerSearchProbe` on: those checks are tests
    (failed when no offer keeps to the option or it is ignored) and the
    scenario ends after 01. Catalogue entry `OTST_OFFER_OPTION_PROBE`
    (`probe: OFFER_OPTIONS`) becomes `OTST_OFFER_<OPTION>_<VALUE>` per value
    *explicitly* listed (`declaredOptionValues()`; "every value" probes
    nothing), copied by `withOfferOptions()`. Simulator 0.31.0: gamma keeps
    to `serviceClassTypes` (HIGH = first, STANDARD = second), flags offer
    parts without ADMISSION as ignored, and ignores the criteria from
    `0000090`.
    **PR 3 (1.11.308): random combinations.** `offerCombinations: { count,
    seed }` (1–20, 32-bit); entry `OTST_OFFER_OPTION_COMBINATIONS` becomes
    `OTST_OFFER_COMBO_<n>` (`optionsOf`), drawn when the catalogue is read
    by `drawCombinations()` (`utils/offerCombinations.js`, mulberry32): the
    same seed, the same combinations. Two or more options, one value each,
    never travel and service class together (`group`). A new seed comes from
    `crypto.getRandomValues`, never `Math.random`.
  - **Currencies** (#781, 1.11.310): `currencies: { sold, default }` in the
    framework (`utils/currencies.js`; the default is always among those sold;
    nothing declared = every currency, none tested). Warning `currency:<C>`
    from `annotateDatafile()`, not for the not-sold probe. The collection
    (`library-bruno/currencies.js`): after 01 the offers are in the currency
    asked, else the scenario's `expectedCurrency` (none in it = FAIL, some =
    WARNING); `__saleCurrency` is the chosen offer's, and refund offers (at 10)
    and exchange offers are held to it. The exchange request already sends the
    sale's `offerSearchCriteria`, currency included. `currencyExpectRejection`
    is the not-sold probe at 01 (refusal / no offer pass, offers in it FAIL,
    in another WARNING), ending the scenario. Catalogue probes `CURRENCIES`
    (`<code>_<C>` per currency, `currencyOf`), `DEFAULT_CURRENCY`
    (`expectedCurrencyOf`), `CURRENCY_NOT_SOLD` (first of
    `NOT_SOLD_CANDIDATES` not declared), copied by `withCurrencies()`.
    Simulator 0.32.0: gamma sells CZK and EUR (`otherCurrencies`, its own price
    factor), refuses others with `400 CURRENCY_NOT_SUPPORTED`; a booking,
    refund and exchange take the booking's currency (`currencyOf()`); an
    exchange asked without currency is offered in CZK, so a lost currency
    shows. No simulator scenario asked a currency before, so none moved.
  - **A mandatory reservation without a seat choice** (#793, 1.11.314):
    `mandatoryReservationForm` in the framework, `PLACE_SELECTION` (default,
    the #742 behaviour, which one provider requires) or `NONE` (named nowhere;
    another provider refuses a placeSelection that asks nothing). The run's
    copy gives it to scenarios naming none (`utils/mandatoryReservation.js`);
    the builder drops the bare mandatory selections after the choices are
    applied (`withoutBareMandatory()`, `seatReservations.js`), so a choice
    always keeps its selection. A named place also books the offer's optional
    seat-map ancillary (`seatMapAncillarySelections()`, `namedPlaces.js`, type
    containing `SEAT_MAP`). Simulator 0.33.0: variant
    `refuses-bare-place-selection`; its offers have no ancillary parts.
    The page's help under the choice (and under random combinations and
    currencies) was written out in #797 (1.11.315), pinned by
    `mandatory-reservation.test.js`: change the text there too.
  - **A reference scenario whose trip has several legs is greyed out in Copy
    scenarios** (#799, 1.11.316) when no Test Data journey has as many legs
    (`journeysMissing()`, `catalogueMatch.js`, the rule of `suggestTrip()`):
    preview field `journeyLegsMissing`, `isLocked()` in `scenario-copy.js`
    (row, "Tick all"). Catalogue only; a company-to-company copy still takes
    any journey. **The "Tick all" box sits in the scenario list**: anything
    reading the list's checkboxes must select `data-copy-action="toggle-code"`,
    or it reads the box's value `on` as a code (#802, 1.11.317).
  - **AI analysis of results** (#801; PR 1 = 1.11.318, access only; per
    provider since 1.11.320). Two locks, no switch: a Test Manager's
    `ai_access_request`, **one row per (company or provider, user)**, naming
    the commitment text accepted by version and sha256 (`utils/aiAccess.js`,
    which holds the text: change the text = bump `version`, and every approved
    Test Manager accepts again without a new approval), and the
    administrator's approve / refuse / revoke of each row (`admin.js`, reason
    required to refuse or withdraw). The Test Manager ticks the targets: the
    distributor (`topCompanyOf()`, from `req.companyId`, never
    `req.user.companyId`) and its providers that `canUseCompany()` admits
    (`targetsOf()`); a refusal for one provider leaves the others open, so
    never decide access for the distributor as a whole. A request naming one
    target already waiting or approved saves nothing (409). The 1.11.318
    administrator switch is gone; `companies.ai_analysis_enabled` (migration
    32) is dormant. PR 3 is the analysis; the plan is in #801.
    **PR 2 (1.11.325): the AI service**, per (company or provider, Test
    Manager) like the access, only where it is approved (`ai_config`,
    migration 33; the target is `req.companyId`, X-Provider-Id). Anthropic
    Messages or OpenAI-compatible Chat Completions, by plain `fetch` in
    `services/aiConnector.js` (the one place OSCAR calls an AI): address
    through `urlPolicy.js`, `redirect: 'manual'`, 256 KB answer cap, 30 s.
    A new service, address, model or key is tested before it is saved
    (`needsTest()`, 422 when it fails). A stored key goes only to the
    service and host it was typed for (`keyRefusal()`), is never returned or
    logged, and is masked in echoed errors (`maskKey()`). Tests use a local
    stub, never a real service.
    **PR 3 (1.11.326): the analysis** (`company-ai-analysis-results.js`,
    `utils/aiAnalysis.js` pure, `ai_analysis` migration 34). Preview then run:
    the run must carry the preview's `hash` (sha256 of instructions + input),
    so nothing is sent that was not shown. The input is the #735 grouping
    (`api/helpers/batchFailures.js`, shared): check and sample error through
    `checkText()`, problem *code* only (title and detail can hold names), the
    framework without `_` keys, findings' title/category/step. Two batches:
    OSCAR computes fixed / still / new by group key, the model only explains.
    Over ~50k tokens it is summarised by step. The call runs after a 202
    (`callModel()`, 5 min); one running per Test Manager; a stale `running`
    reads `interrupted`. The monthly cap is counted from `ai_analysis`
    tokens. History is read by any Test Manager `canUseCompany()` admits
    (`req.companyId`), approved or not; an answer not in the JSON asked is
    kept raw as `unreadable`.
    **#827 PR A (1.11.327): context.** The provider's filled set-up
    checklist (.docx, #795) is imported per company or provider
    (`company-ai-checklist.js`, `provider_checklist` migration 35, encrypted);
    `utils/checklistAnswers.js` (pure) reads the content controls by tag and
    **never keeps `api.*` or `meta.*`**; `contextOf()` is what the model gets
    (info/data/svc/jrn answers and `fw.*` comments, 20k chars, service
    sheets cut first). `utils/zip.js` `readZipEntry()` reads one entry with an
    inflation bound. The instructions name the declared OSDM version
    (`systemPrompt({ osdmVersion })`), and each scenario carries its
    catalogue `purpose` (`catalogueEntryOf()`: same code, else the longest
    code it extends with `_`). The tests read the simulator's alpha checklist
    in `Documentation/`: regenerating it changes their counts.
    **#827 PR B (1.11.328): OSDM references.** Each group names its
    `operation` (`utils/osdmReferences.js` `operationOf()`: the request's
    method and URL, the template whose path ends the URL's; the URL is never
    sent). `input.osdmReference` is the extract of the declared version
    (`versionFor()`: exact, else nearest, else latest; `exact` says which),
    request + 2xx responses + named schemas two levels down, level by level
    across operations, 30k chars, 12 operations. `osdm-references.json` is
    **generated** (`scripts/generate-osdm-references.js`, 3.4–3.8 from
    gh-pages, 3.8 copied from the repository first); a test pins its 3.8.
    **#827 PR C (1.11.329): questioning the test.** The 15 most failing
    groups carry `sample` { request, response } (`sampleOf` in
    `buildInput()`, read by the route from `run_requests` bodies of the
    company, never headers or URL), masked by `utils/aiMask.js`: personal
    keys (names, birth date, gender, contact, address, cards, identity
    documents…) and connection keys anywhere, URLs to `<url>`, a Problem's
    title/detail (its code kept), long text, lists of more than 3, 6k chars
    a sample. Maintainer's rule: everything else a run sends or receives is
    test data. Owners are provider / oscar / **configuration** / unclear,
    each group has an `action`; an OSCAR group can be copied as issue
    Markdown (`issueText()`, page only). The commitment text went to
    version 2 with it: what is sent changed, so every Test Manager accepts
    again (no new approval).
    **#831 (1.11.330): models, cost, spend.** `utils/aiModels.js` (pure)
    holds the Anthropic models and their list prices ($/M tokens; Haiku 5.5's
    second rate above 100K input), `costOf()`, `spendOf()` and the suggested
    limit and instruction. Change prices there only; a stored
    `ai_analysis.cost_usd` is never recomputed, older rows are priced at
    today's list. A model not listed takes the Test Manager's
    `ai_config.price_input`/`price_output`, else has no price. The analysis
    may name its `model` (`modelFor()`): the preview's `hash` includes it,
    `contentHash` (stored as `content_hash`) does not, which is how the
    history tells analyses sent the same input. `POST /config/models` asks
    the service's `GET /v1/models` through the same guarded `exchange()` as
    `callModel()` (`aiConnector.js`), the stored key under `keyRefusal()`.
    Migration 36.
    **#848 PR 1 (1.11.339): one service for all, or one per provider.**
    `ai_setup` (migration 39) holds a Test Manager's mode per distributor:
    `shared` (no row = shared, the default) uses the distributor's
    `ai_config` row for every company or provider; `per_provider` is the
    #801 behaviour. **`configOf()` is the row in use** (`serviceOwnerOf()`);
    the config routes write that row, `rowOf()` reads one company's own. A
    shared service has one monthly limit over the whole family
    (`usageScopeOf()`). Access stays per target in both modes. The migration
    gives `per_provider` to every Test Manager who already had a provider
    service, so no analysis changed service. `GET`/`PUT /ai-analysis/setup`
    (switching deletes nothing; unused services are listed `inUse: false`),
    `GET /ai-analysis/overview` (per target: access, service used, every Test
    Manager's analyses and cost via `M.totalOf()`; totals by `M.sumOf()`).
    **PR 2 (1.11.340): the page in three tabs**, Connection / Usage status /
    Analysis (`#connection`, `#status`, `#analysis`; opens on Analysis when a
    service is configured). The analysis is asked step by step, each step
    `hidden` until the one before is chosen (`step()`): target, batch,
    checklist (`checklistHtml()` asks keep or import; without one stored,
    import or go on without), send. After an import or removal the checklist
    step is drawn again from what is stored (`loadChecklist()`). The overview
    names no service where access is not approved. Checked in Chromium on a
    throwaway server: seed with `require('src/db/db')` under
    `OSCAR_DB_PATH`, sign a token with the `server_config` JWT secret, put it
    in `localStorage.oscar_token`.
    **#823 PR 1 (1.11.341): warnings and scenario versions.** The first real
    analysis (the whole simulator data file run on alpha, OSDM 3.6.0) blamed
    OSCAR for `_38` scenarios: it knew neither their version nor what the
    framework leaves undeclared. Now `warningsOfBatch()`
    (`batchFailures.js`: `run_events` level `warn`, lines holding
    `[WARNING]`, step = `request_name`, finished runs only) feeds
    `warningGroupsOf()` (`groupFailures()` over `warningText()`). A warning
    line is one whose *first* level tag is `[WARNING]` (`isWarningLine()`,
    1.11.342): the runner stores at level `warn` any line naming the tag, and
    a `[DEBUG] … skip with a [WARNING] too.` line was sent as "too.". Sent as
    `warnings` (or `warningComparison` gone / stillWarned / new), never mixed
    with the failures; too large → warnings by step first, then failures.
    `scenariosOf(id, framework)` annotates the data file, so
    `scenarios[]` carries `osdmVersion` and `notDeclaredInTestFramework`.
    That run also showed a simulator gap, closed by simulator 0.37.0 (#852):
    `…/booked-offers/{id}/reservations` (`addReservations()`, every version,
    the only form in 3.6) next to `…/offer-parts` (3.7 and later only; the
    collection picks by version).
    **#823 PR 2 (1.11.344): finding drafts.** `POST /ai-analysis/history/:id/
    groups/:index/draft` puts a group in `finding_suggestion` (#735) under
    key `ai:<analysis>:<index>` (`draftKeyOf()`; one per group, 409 after):
    `draftOfAnalysisGroup()` (pure) names analysis, model and batches, shows
    the AI's owner in `source.owner` and the evidence, and keeps `category`
    `open`, never the owner. `GET /history/:id` returns `drafts` by group
    index; Test Findings shows the origin (`draftOrigin()` in `findings.js`).
    **#867: the download.** `GET /ai-analysis/history/:id/download` (the
    history's readers, a done analysis, else 409) writes the groups and,
    for each, the failing requests of its batches at the steps and
    scenarios it names (`utils/aiAnalysisDownload.js`, pure): the first of
    each run and step, 3 a group, the later batch first, the rest counted.
    Bodies as stored, **not masked** (the company's test data; the page
    says so). Never in the file: headers (not even read), the endpoint's
    host (out of the URL, `<host>` in bodies), credentials in the query or
    in a body member named like one (`isConnectionName()`). The JSON walk
    is a loop. Fences are longer than any backtick run of the body. Body
    20 KB, file 4 MB. The page puts only a UUID (`analysisIdOf()`) in the
    button and the address.
  - **The run gets the annotation too** since 1.11.236: `/data/:filename`
    annotates on the run-secret branch only (`withFrameworkWarnings` in
    `server.js`). Before, only the browser's `GET /datafile` had it, so the
    collection's `[WARNING]` never reached a run log.
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
  - **Suggested from runs** (#735, 1.11.284): a batch's failed checks
    (`run_assertions` + the request's problem) grouped into drafts, rules
    only, no model. `utils/findingSuggestions.js` (pure): the key is step +
    check text with the run's values out (`checkText()`) + HTTP status + the
    problem code **of an error answer only** (a 200 may carry warning
    problems that have nothing to do with the failed check). Matching:
    `same` (a past draft's key, or same step and error status / problem
    code / check text) shows "still seen" and makes no draft; `maybe` (same
    step and scenario) still makes the draft, naming the finding, because one
    step of one scenario fails in several ways and a wrong "still seen" hides
    a new problem. A 2xx status never matches by itself. Drafts live in
    `finding_suggestion` (migration 31), **not** as a `finding` status, so no
    reader of `finding` has to leave them out; `draft` is encrypted. Test
    Manager only, testers and certifiers get 403. Rejected and OSCAR-issue
    keys are not suggested again; an OSCAR issue never becomes a finding.
    Accepting goes through `createFinding()` (`api/helpers/findings.js`),
    the same as "Open a finding". The route file is mounted **before**
    `company-findings.js`, whose `GET /findings/:id` would take
    "suggestions" for an id. Tuned on a real provider's batch (35 failures →
    18 groups); that data stays in the private repository. **Part 3
    (1.11.285): a draft's simulator hint** (`simulatorHint()`), from
    `src/utils/simulator-checks.json`, **generated** by
    `scripts/generate-simulator-checks.js` from `OSDM_Simulator/replay/after.json`
    (keys: `hintKey()` = `stepKey|checkText`, the grouping's own; `SIM_WRONG_*`
    left out). Regenerate it with each replay recording, as `describe` is; a
    stale table only loses hints, it never gives a wrong category. The step
    must match exactly after `stepKey()`: "GET Booking after Fulfillments" is
    not "GET Booking".
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
- **Read-only API keys (#503, PR 1 = 1.11.337).** A Test Manager makes a key
  for the company or provider of the request (`company-api-keys.js`,
  `api_key` migration 38; `utils/apiKeys.js` pure). `oscar_<8 hex>_<43
  base64url>`: the prefix finds the row, only the sha256 of the secret is
  stored, the key is answered once by the POST. **A key works under `/v1/api`
  only**: `requireAuth` refuses any `oscar_` bearer with a pointer there, and
  `routes/api.js` ends in its own 404 so a key never reaches another router or
  the page fallback. `requireApiKey` (`middleware/apiKey.js`) reads the
  Authorization header only, answers one 401 for every refusal, and checks at
  each call: not revoked, not expired, creator an active `test_manager` who
  `canUseCompany()` the key's company. The principal is `{ role: 'api_key',
  keyCompanyId }`: `canUserSeeRun()` gives it that one company's runs, not its
  providers' (`keyCompanyId`, not `companyId`, which the provider-access guard
  counts). Two rate limits: by address before the key, then per key.
  **PR 2 (1.11.338): the read routes** `runs`, `runs/:id`,
  `runs/:id/assertions`, `batches/:batchId`, `queue` (OpenAPI tag *API*).
  Every run goes through `visibleRun()` = `canUserSeeRun()` and not
  deleted / asked to delete / flagged (all three a 404, like none). Answers
  are built field by field (`runView()`), never from a row: no body, header,
  URL, log, endpoint, `error_message` or person. A query parameter that is
  not one plain value of its list is a 400 (Express 5 gives an array for a
  repeated one). Bodies and logs wait for a `bodies:read` scope.
  **PR 3: `OSCAR_MCP/`, a read-only MCP server** over stdio (own version
  0.1.0, no dependency, linted and tested in the required job like the
  simulator; not in `compatibility.json`). One tool per GET of `/v1/api`
  (`src/tools.js`), arguments checked before any call; `src/client.js` sends
  GET only, to `OSCAR_URL` only (`https`, `http` for loopback), under
  `/v1/api/` only, `redirect: 'manual'`, 4 MB / 30 s; the key is never
  written (tests check stdout and stderr). JSON-RPC by hand in
  `src/protocol.js` (initialize, ping, tools/list, tools/call), no SDK.
  **A new `/v1/api` GET needs its tool**: `mcp-end-to-end.test.js` pins the
  tools to the OpenAPI paths and runs the server against the real router.
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
- **API Config is one page for the company and all its providers; "Working on"
  is for the working pages only** (#580, v1.11.220, maintainer feedback from
  the first real set-up). Configuration is a list: one section per company or
  provider, each saved on its own. Before, the page followed the selector, and
  the company's own card did not say what its credentials were for, so a
  second provider's credentials were typed over the first. Page only, no route
  changed. What holds it together:
  - **Every request of a section names its company or provider**
    (`inTarget(card)` adds `X-Provider-Id`). `nav.js` adds the selected
    provider only to a request that names none, so a request that forgot the
    header would silently act on whatever "Working on" says.
  - **The own company is read with an empty `X-Provider-Id`.** The server
    reads `''` as "names none" (`requestedProviderId`), and an empty header
    still counts as "named" for `nav.js`. Both halves are pinned by a test;
    change either and the company's section shows the selected provider.
  - **A section's fields are found by `data-f` inside the section, never by
    id.** The section is a `<template>` copied once per target, and
    `getElementById` would return the first copy's field. The template does
    carry ids, but only to tie each label to its field: Sonar types an input
    without a static `id` and `<label for>` as a *bug*
    (`Web:InputWithoutLabelCheck`, 12 of them failed the gate on the first
    push), and tying them by script is invisible to it. `addTarget()` makes
    those ids unique in each copy *before* the copy enters the page. Tests pin
    it: every id in the template is a labelled field, the rewrite comes before
    the insertion, and the script never looks a field up by id.
  - **A save re-reads its own section only.** Text typed in another section
    stays, and stays unsaved; that section is marked "not saved" and the page
    asks before it is left.
  - **A provider's name is text, never markup**: `textContent` in the section,
    `esc()` in the summary table. Checked in a browser with a provider named
    `Alpha <b>&`.
  - **Test my credentials** (#872): `POST /v1/me/credentials/test`
    (`me-credentials.js`, members only, 10 a minute per user) tests what is
    *saved* for `req.companyId`: `resolveAccessToken(…, { forceRefresh: true
    })`, then one `GET {api_base}/versions` with the run's headers
    (`services/credentialTest.js`: `urlPolicy`, `redirect: 'manual'`, 15 s,
    64 KB). `utils/credentialTestOutcome.js` (pure) classifies the answer and
    cleans the resolver's message: cut at ` Body: ` (two adapters quote the
    token answer, which may hold a token under another name) and every saved
    secret masked. The token never leaves the service; it writes only the
    token cache, as a run does. Audit `credentials_tested:<outcome>`. The
    page saves unsaved edits first (asked), and draws the result with
    `textContent` only (`showTestResult()`).
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
  - **Scenario copy (PR 3, v1.11.218)**: `utils/scenarioCopy.js` (pure) +
    `routes/company-scenario-copy.js`. The target is the request's company, the
    source a body parameter checked with `canUseCompany()`. Trips are mapped
    once per entry and rebuilt with **`public/js/trip-apply.js`, the one
    implementation of "Apply test data"**: `scenarios.js` and the server both
    use it, so change it there only. Copied entries always get fresh ids, never
    an existing target entry (it may belong to others' hidden scenarios), and
    from `idAllocator()` (`datafileOwnership.js`, rule J, shared with the
    merge): not max+1 per list, which lands on a dangling reference. The
    write goes through `utils/datafileWrite.js`, shared with the Test Config
    save.
  - **A save from a stale load is refused (v1.11.219)**: `GET /datafile` sends
    an `ETag`, `PUT /datafile/json` takes `If-Match` / `If-None-Match: *` and
    answers 412 (`utils/datafileVersion.js`, pure). The version is of what the
    person sees: a tester's view with their run list, so colleagues' private
    saves do not conflict; `knownDeviations` left out, since the server
    rewrites it. **No header = go ahead**, for pages loaded before 1.11.219;
    do not make it required without a reason. The page sends it from
    `datafileSaveHeaders(datafileLoadedVersion)` (or the wizard's own load);
    a new save site in `scenarios.js` must too, and
    `scenarios-load-guard.test.js` counts the PUT sites. Upload, delete and the
    scenario copy are not checked, on purpose.
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
- **An upload replaces the data file and nothing else; Download JSON is the
  stored file** (#549, v1.11.221). Rules that will bite:
  - **The upload's schema check is the collection's, not JSON Schema.**
    `utils/datafileSchema.js` re-states `validateDataFileJsonWithTemplate`
    (`library-bruno/validators.js`): type, enum, min/maxLength, required,
    `properties` only when `type` is the word `"object"`, `items` only when it
    is `"array"`, and its list of field names whose null passes. No AJV, no
    `minimum`: a stricter check would refuse files every run accepts.
    `tests/unit/datafile-schema.test.js` runs both over 3,000 broken variants
    of the sample files and fails on any disagreement, so change both or
    neither. It reads the schema from `COLLECTION_PATH` at each upload (the
    collection is refreshed without a restart), the repository copy as
    fallback; a test that needs the real schema sets `COLLECTION_PATH` to the
    repository's `Bruno_Collection`, because another test file briefly writes
    a stub schema into the shared dummy one.
  - **Uploaded bytes are stored as they are**, `knownDeviations` included, so
    a Test Manager's download uploaded again leaves the hash unchanged. Do not
    re-project or re-indent on upload.
  - **A download that is not the stored file carries a root marker**
    (`__oscarPersonalView` for a tester's view, `__oscarUnsavedEdits` for the
    page's working copy) and the upload refuses it (`NOT_THE_COMPANY_FILE` in
    `company.js`). A new export of a view or of unsaved state needs one too.
  - **One previous file per company**, `{slug}-datafile.previous.json`,
    encrypted, written only by an upload and a restore (never by Save &
    Apply: the next auto-save would replace it), before the live file. Restore
    swaps the two; delete removes both.
  - **The page never writes the framework or test data on upload.** Creating
    them from a file is `offerBuildFromUpload()`, asked, and only after a 404
    framework or a Test Data list with no train (`loadForEdit`, #534). Every
    upload test sends a schema-valid file: `tests/helpers/valid-datafile.js`.
  - A parser refusal is answered by `parseUpload` (400, or 413 for size); the
    global error handler only ever sees real errors.
  - **The JSON body parser's refusals are the client's too** (#725): the
    global handler answers `entity.parse.failed` 400 and `entity.too.large`
    413, each with its reason. Before, Test Config's Save & Apply with no data
    file loaded sent `null` and saw only "500: Internal Server Error";
    `saveDatafile()` now sends nothing when `state` is not an object.
  - **Copy scenarios shows its message where it is seen** (#727): `showMsg()`
    in `scenario-copy.js` scrolls the panel's note into view, and
    `hasUnsavedEdits()` only blocks a copy when a data file is loaded. Before,
    an edited page with no file could neither save nor copy, and the refusal
    sat screens above the Copy button. `scenario-copy-page.test.js` lifts both
    helpers out of the IIFE by text.
- **A full configuration is the data file, the Test Framework and the Test
  Data in one file** (#810, 1.11.322). `utils/configurationBundle.js` (pure)
  builds and reads it (root `__oscarConfiguration: { format: 1 }`, which the
  data-file upload refuses through `NOT_THE_COMPANY_FILE`) and plans the Test
  Data (`planTestData()`: `add` skips an entry whose data the target holds,
  compared with `canonical()`; `replace` removes TRAIN and JOURNEY first).
  Routes in `company.js`: `GET /configuration/download`, `POST
  /configuration/import` (Test Manager, `uploadPolicy`, field
  `configuration`, choices as form fields, none guessed). **Only journeys name
  other resources** (`legs[].trainResourceId`): the data file holds copies of
  train values, so new ids are remapped in journeys and nowhere else; a new
  field that stores a resource id must be added to the remap. The data file
  goes through the upload's checks and `storeUpload()` with `undoable` (a
  snapshot of the two files and the company row), then the framework and Test
  Data in one `db.transaction`; a failed transaction calls the undo. The route
  calls `db.transaction` through the module so a test can make it fail. Values
  deeper than `MAX_DEPTH` are refused before anything recursive runs. The
  datafile part is stored re-indented (4 spaces), not as the source's bytes.
- **A provider's filled checklist sets up its Test Framework and Test Data**
  (#862, PR 1 = 1.11.346). `checklist_import` (migration 40) keeps every
  import: answers encrypted (never `api.*` / `meta.*`, as #827), file name,
  sha256, date, status waiting / applied / discarded; the file is not kept.
  Routes `company-checklist.js` (`/v1/company/checklists`, Test Manager,
  X-Provider-Id). **An import changes nothing**: the preview
  (`utils/checklistConfiguration.js`, pure) is set against the last applied
  import (else the AI analysis's `provider_checklist`), and the apply must
  carry its `hash` (`previewHash()`: import id, proposed framework, Test Data
  plan and rows), 409 with the new preview when anything moved. Framework =
  the current one with each answered question over it
  (`frameworkFromChecklist(answers, { base, unplaced })`, the #838 rules;
  unknown questions go to `unplaced` instead of throwing, which the
  simulator's generator still does). Test Data: a train per route of each
  `svc<n>` sheet, a journey per `jrn.<combo>` sold, planned by
  `planTestData` (add / replace). Station codes of 7 or 8 digits; times get
  the offset of the station's zone (`utils/stationZones.js`, the
  collection's table pinned by `checklist-configuration.test.js`), only for
  7-digit codes as the collection does. `storeFramework` / `storeTestData`
  live in `api/helpers/configurationStore.js` now (shared with #810/#838).
  The apply also writes `provider_checklist`. **PR 2 (1.11.349): the
  catalogue's scenarios.** `utils/checklistScenarios.js` (pure)
  `scenarioPlan()`: the entries the new framework declares everything for
  (`catalogueFor`, `missing` empty), not already in the data file by code,
  adapted (`adaptCatalogueDatafile`) and placed by `suggestTrip()`; a trip
  of several legs with no journey of as many legs, or no train at all, leaves
  its scenario out (`noJourney`, `noTestData`). The preview plans on the Test
  Data *after* the apply (`testDataAfter()`, ids `new-N`), and its hash covers
  the plan and the choice (`scenarios=copy|none`, default copy). The apply
  plans again on the stored rows and copies with `applyCopy()` under
  `withDatafileLock`, after the framework/Test Data transaction: a failed
  copy leaves them applied and answers `scenarios.error`. The reading half of
  Copy scenarios (catalogue, data file, `testDataChoices`) is
  `api/helpers/catalogueSource.js`, shared by both routes. **Ids in OSCAR are UUIDs** (`crypto.randomUUID()`): a page that
  validates an id read from an answer before putting it in a request address
  (Sonar's taint rules S8476/S5696) checks for a UUID (`checklistIdOf()`,
  `resourceIdOf()`), never `Number()`. #864 and #866 shipped a number check
  and their buttons sent nothing (#868); test such a function with a real id.
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
    `wizGenerateScenario()` now does. Since v1.11.219 the server also refuses
    a save whose `If-Match` is not the current version (#540, the provider
    bullet above).
  - **Page functions can be tested without a browser.**
    `tests/unit/scenarios-load-guard.test.js` lifts the real functions out of
    `scenarios.js` and runs them in a `vm` context with a fake `fetch` and
    `document`. It only works for top-level functions laid out with `}` at
    column 0, which is how the file is written.
- **The OSDM version is checked and follows the Test Framework** (#785,
  1.11.311). It goes in every request's `Content-Type`, and `3..0.5` once
  failed a whole batch. `utils/osdmVersion.js` (pure): digits and dots; the
  framework route answers 400, the runner refuses the run
  (`refusedOsdmVersion()`), the run's copy gives the framework's version to a
  scenario naming none (`withFrameworkVersion()`). Copies still name it (the
  schema requires it), so changing the framework's version offers the
  scenarios on the old one the new one (`offerScenarioVersionUpdate()` in
  `scenarios.js`, own scenarios only). The page's `OSDM_VERSION_PATTERN` is
  pinned to the server's by `osdm-version.test.js`.
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
- **The Bruno CLI and the base image are pinned** (#545, v1.11.222). The
  CLI comes from `Oscar_Server/bruno-cli/package.json` + `package-lock.json`
  (exact `@usebruno/cli`, 4.2.1 at that release), installed with `npm ci`
  into `/opt/bruno-cli` by the Dockerfile and by `ci-collection.yml`, so CI
  validates the collection against the engine production runs. Production
  had moved from Bruno 3 to 4 at an unremarked rebuild; that is what this
  stops. Things that will bite:
  - **`/usr/local/bin/bru` is a symlink to `node_modules/.bin/bru`**, which
    is itself one. Node resolves the chain to `bin/bru.js`, so its relative
    requires work; `BRU_CMD` in `OSCAR_Deploy` names that path. Never `COPY`
    the link out of a stage: `COPY` resolves it and copies only the shim.
  - **The hand patches of #428/#532 are `overrides` now.** They failed with
    `EOVERRIDE` before only because a global install has no root package and
    axios was a *direct* dependency of the thing installed. Here the root's
    one dependency is `@usebruno/cli`, so overriding its dependencies is
    allowed. Keep them `^` floors. nanoid has none: 4.2.1 ships 3.3.18.
  - **`--ignore-scripts`**: the one install script in the tree today is
    protobufjs's postinstall, a warning printer. When a Bruno upgrade adds a
    `hasInstallScript` to the lockfile, read that script before deciding;
    a missing native build fails at `bru --version` in the image build.
  - **Both `FROM` lines carry a digest.** Docker Hub rate-limits shared IPs
    (429); `mirror.gcr.io/v2/library/node/manifests/22-slim` and
    `public.ecr.aws` give the same index digest without an account. Read the
    index digest, not one platform's.
  - A new Bruno version is a server release (bump + `compatibility.json`),
    even though no server code changes: it is the engine of every run.
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
  - **A test that opens a file must close it before removing it, and the test
    databases are removed by Jest's global teardown** (#583). Windows does not
    let an open file be removed; Linux does, so CI never showed it. Three
    places had it wrong, and on the maintainer's PC four days of work had left
    2 GB in the temporary folder. `db-migration29.test.js` and
    `db-migrations.test.js` boot the real `db.js`, which opens its database and
    never closes it: they now call `.db.close()` on what they required (the
    migrations have run by then). The first of the two used to fail as "Test
    suite failed to run" on Windows, on every branch. `tests/setup.js` removes
    the per-file database in `process.on('exit')`, while it is still open:
    that works on Linux only. So `tests/global-setup.js` names the run
    (`OSCAR_TEST_RUN`, in the database's file name) and sweeps leftovers older
    than six hours, and `tests/global-teardown.js` removes the run's databases
    after the workers have ended. `tests/helpers/temp-files.js` holds the rule
    for "this entry is ours"; `oscar-test-collection` is not, and the test says
    so. With `--runInBand`, and when a single test file is run (Jest then runs
    it in its own process), the database is still open at teardown on Windows
    and waits for the next sweep: checked, one file left per such run. The
    simulator's tests keep their temporary folders under one root per process,
    removed at exit.
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
  that file's 373 findings. PR 4, the HTML pages, is #527 (v1.11.206). PR 5,
  the Bruno library, is #528 (1.11.345 / OTST_V2.0.188): 377 of 426. The
  gate only judges new code, so none of this blocks a release. What they
  established:
  - **#528's method, for a library rewrite:** plan rewrites from the AST
    (espree, in `Oscar_Server/node_modules`), not from text. Offsets in
    Sonar's `textRange` count UTF-16 units: a line with an emoji shifts a
    Python index. Read every `a && a.b` → `a?.b` whose value is kept or
    passed on: `null` becomes `undefined`, and `a?.b()` throws where `a` is
    `''`. Bruno's sandbox has no `structuredClone` (its globals are listed in
    `@usebruno/js/src/sandbox/node-vm/constants.js`), so S7784 stays. The
    simulator replay (`record before` from a `git archive` copy of `main`,
    so the branch can be edited while it runs) is the check for the
    library. The two HTML report writers have no tests: run old and new
    on the replay's `runs/*.json` and on random variants of a
    `.report_tmp.json`, strip the footer's clock, then break each rewritten
    line to prove the comparison sees it. In `sed`, `&` in the replacement
    is the match: that garbled the first harness.
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
  logged, not asserted (open OTST point, see §6). At those two stages an
  absent `confirmedPrice` is a WARNING (#661): OSDM requires neither member,
  and a real provider leaves it out after a full refund.
- **Offer parts and booked parts are paired by content, never by position**
  (#550, OTST_V2.0.105). OSDM gives a booked part no reference to its offer
  part and does not fix their order. `bookings.js` `pairOfferParts()` (pure)
  scores each pair on ranked criteria (id > passenger refs > passenger types >
  products / trip coverage > validity instant > price > the rest) and breaks
  ties by the parts' own text, so any order of the booking gives the same
  assertions. A missing *admission* is one failure naming it (once across
  re-reads, `recordFindingOnce`); a missing reservation or ancillary stays a
  WARNING because those parts can be optional. Any new offer↔booking
  comparison goes through the pairs, never `bookedParts[i]`.
  `tests/unit/bruno-bookings-part-pairing.test.js` runs the real validator and
  records every assertion, with `tests/helpers/bruno-chai.js` standing in for
  Bruno's chai `expect` (it covers only the chain `validateOfferParts` uses;
  extend it as needed). Exported as `validateBookedOfferParts`, because
  `offers.js` already puts a different `validateOfferParts` on `globalThis`.
  `refunds.js` `getBookingRefundResponse` is called by no request (its
  `bookedOffers[0]` / `refundOffers[0]` lookups would need the same treatment
  if it is wired in).
- **A refund can come as one refund offer per fulfillment, and every offer is
  confirmed** (#595, 1.11.225 / OTST_V2.0.110). Step 10 keeps the ids
  (`__refundOfferIds`, `__refundOfferIndex`); step 14, after checking the
  booking, makes the next one `refundOffersOfferId` and goes back to `13.
  PATCH`; when none is left, `checkFullRefundDone()` asks every fulfillment to
  be refunded (not for a partial refund that did not degrade). Providers divide
  a booking into fulfillments differently (one per booking, per direction, per
  passenger, per passenger and leg), so a partial refund *by fulfillment*
  targets first, last, outbound or inbound, never an id, and sends
  `fulfillmentIds` only: providers that refund per fulfillment refuse
  `refundSpecifications` with `bookingPartIds` / `passengerIds`. A partial
  refund is armed by any of `partialRefundArmed()`'s three flags; use it
  instead of reading the leg and passenger flags. A booking priced 0 (a
  provider's test system) skips "partial < confirmed" at INFO (#662). A
  refund by leg or by passenger names the fulfillment that holds its parts
  (`fulfillmentForScope()`, #610, OTST_V2.0.120): the only one, else the one
  whose `bookingParts` list them, else the passenger's. Parts in several
  fulfillments, or none shown, degrade to a full refund: never fall back to
  `fulfillments[0]`.
- **An overrule code is a technical cancellation: everything back, no fee**
  (#596, 1.11.227 / OTST_V2.0.111). One refund offer is compared with
  `confirmedPrice` in `validateRefundableAmount`; several (one per
  fulfillment) are added up by `checkOverruleTotal()` at step 10, each also
  checked for a zero fee. `CODE_DOES_NOT_EXIST` and `"null"` count as no code
  (`_overruleCodeSent()`). `overruleCodeExpectRejection` is the negative test:
  step 10 grades the refusal with `validateProblemResponse` and ends the
  scenario before any status check; while it is on, Test Config offers every
  listed code (`overruleCodeChoices()`), since the point is a code the
  framework does not declare. The simulator restricts codes per provider
  (`overruleCodes` in the profile, on all three since #824, so the refusal
  test passes on each).
- **A reduction card is sent, and proved applied twice** (#597, 1.11.228 /
  OTST_V2.0.112). `library-bruno/reductionCards.js` (pure) turns a
  passenger's `reductionCards` into `{ type: REDUCTION_CARD, code, issuer }`;
  the issuer is filled at request time from `__reductionCardTypes`, which step
  06 sets per run (so a request built before 06 has none). The proofs: the
  chosen offer names the card in `appliedPassengerTypes`, and step `01c`
  (only when a passenger holds a card) asks the same offers without cards and
  compares the offer of the same flexibility and travel class. 01 and 01c
  route with `routeAfterOfferStep()`; a new step after the offer must go
  through it, not copy it. `__cardPriceCompareDone` keeps 01c to once per
  scenario and is in both reset lists. A ReductionCardType is an object:
  compare code and issuer, never identity.
- **A scenario can name the product it sells** (#598, 1.11.229 /
  OTST_V2.0.113). `expectedProduct` is a code (exact) or words of the name;
  `library-bruno/products.js` (pure) lets a code match anywhere win over a
  name match. `selectAndSetOffer()` filters on it before the flexibility; no
  holder sets `__productNotOffered`, and 01 / 01b stop on it after their
  failed check (do not let a step go on to book another tariff). 07 checks
  the booking and each fulfillment through `summaryProductId` /
  `products[].productId`. The simulator's `gamma` sells named products, the
  first of which keeps the old fully flexible price so older scenarios do not
  move.
- **A group tariff is a COLLECTIVE request naming a group product** (#599,
  1.11.230 / OTST_V2.0.114). `library-bruno/groupOffers.js` (pure) checks the
  chosen offer (one COLLECTIVE admission per trip for the whole group, every
  passenger in `appliedPassengerTypes`; none given is a warning, OSDM does not
  require it) and compares its price with the same request in the INDIVIDUAL
  mode, sent by `01d`. `routeAfterOfferStep()` goes to `01d` once
  (`__groupPriceCompareDone`), so 01, 01c and 01d all end in it; a new step
  between the offer and the booking goes through it too. `expectedProductAbsent`
  is the negative test and always ends the scenario after the offer. The
  simulator's group rules live on the product (`group` in the profile); a
  group product is never offered to an INDIVIDUAL request, so the earlier
  gamma scenarios see the same offers. Offers and bookings take 19 passengers.
- **A travel class per leg is read from the products covering each leg**
  (#600, 1.11.231 / OTST_V2.0.115). `library-bruno/legClasses.js` (pure): a
  leg's class is the highest `travelClass` of the products that cover it,
  through `products[].legIds` (else the part's `coveredLegIds`), so a
  second-class admission plus an `UPGRADE_*` supplement on one leg and a
  first-class admission of its own on that leg both read as FIRST; the check
  names the form. `legTravelClasses` replaces the travel class in the request
  (`travelClasses`, every class named). The simulator read `travelClass` until
  0.10.0, so it answered every request in second class only: a simulator
  field read from a request must be the OSDM name the collection sends.
  **A part naming no legs covers the whole trip** (#762, OSDM TripCoverage;
  `legsOfPart()`): a real provider gives `coveredTripId` only, and OSCAR read
  such legs as "none". **No offer with the classes asked is a WARNING, not a
  stop** (maintainer decision: the provider sells what it has, the retailer
  decides): the sale goes on with the offer chosen as usual, and 07 holds the
  booking to the classes of that offer (`__legClassesSold`,
  `bookingClassesExpected()`). `SIM_SALE_CLASS_PER_LEG_NOT_OFFERED_1ADT_38`
  shows it.
- **A mandatory reservation is read from the admission's relations and booked
  by itself** (#601, 1.11.232 / OTST_V2.0.116). `library-bruno/seatReservations.js`
  (pure): `minGroupItemsToBeBooked` lives in `admission.reservations[]`
  (ReservationRelation), never on the admission. A mandatory one whose leg
  is known always goes in `placeSelections` (#742, `bookingSelections()`): a
  provider refused it named in `optionalReservationSelections`, though OSDM
  says a mandatory one is booked with the booking. `reservationBookingForm`
  books the optional ones (RESERVATION_SELECTION, PLACE_SELECTION, ADD_LATER);
  ADD_LATER goes through 09, and its run-filter gate is in `opencollection.yml`
  (`_addLaterForm`) as well as in 02's routing: a step a script routes to is
  still skipped when the filter says so. Bruno may give a JSON variable back
  as an object (`offer` does): read it with `fromEnv()`, never a bare
  `JSON.parse`, or a check silently sees nothing.
- **Offers by trip id are asked from 01's own script** (#602, 1.11.233 /
  OTST_V2.0.117). `library-bruno/tripIds.js` (pure) chooses the trip of
  `POST /trips-collection` (the trip's train, else the first at the time asked
  or later). The call is `bru.sendRequest` in `prepareOfferRequestByTripIds()`,
  not a request file, on purpose: nine places route straight to `01. POST Get
  Offer` (retry, loop-back, expired-flow reruns, exchange ends), and the
  next scenario is loaded in 01's before-request, so a step before 01 would
  be skipped or would see the previous scenario. Its checks are kept in
  `__tripIdsOutcome` and recorded by 01's after-response, ahead of the status
  check, because the negative test (`tripIdsExpectRejection`) expects a 4xx
  there. One-way SEARCH trips only. Its request leaves `Requestor` out when
  unset (#764, `requestorHeader()`: it sent `""`, and a real provider answered
  200 with a body that was not JSON), and a non-JSON answer is described in
  the log (`describeRawAnswer()`: type, length, first 200 characters).
- **Fulfilment documents are warnings; the refund receipt is awaited, and
  every simulator scenario is catalogued** (#603, 1.11.234 / OTST_V2.0.118).
  `library-bruno/fulfillmentDocuments.js` (pure) reads documents where the
  version puts them (nested up to 3.7; the booking's `fulfillmentDocuments` +
  `fulfillmentDocumentRefs` in 3.8). `fulfillmentSteps.js` is the glue: 06
  arms `06b. GET Fulfillment` (one read per fulfillment, an optional read under
  #488), 07 checks the documents and keeps the INFORMATION documents already
  there, 14 arms `14b. GET Booking Refund Receipt` when
  `refundReceiptMaxWaitMinutes` is set. 06b and 14b are only ever reached by a
  script, and the run filter skips them otherwise. The wait has no on/off flag:
  its `EXPIRED_FLOW_TIMERS` entry has `flag: null`. The scripts decode base64 by
  hand, because Bruno's sandbox need not give them a `Buffer`. **14b renews
  the access token before each read** (#854, OTST_V2.0.187:
  `refreshAccessTokenIfNeeded()`, not forced): beta's tokens last 120 s and
  the wait outlived them (401). A new wait in the collection needs the same.
  `Documentation/Server_Operations/OSCAR - OSDM Simulator scenarios.md` lists
  every scenario of the simulator's data file with its expected warnings.
  `datafile.test.js` fails when the two disagree, so a new scenario needs its
  row in the same change.
- **The Idempotency-Key test sends requests again from the step's script**
  (#604). `idempotencySteps.js` puts the key on 02 and 06 with `req.setHeader`
  and replays them with `bru.sendRequest`, so the flow of the scenario does not
  change. Its key comes from `require('crypto')`, which the developer sandbox
  gives. The simulator keeps a *copy* of the first answer: the booking changes
  afterwards, and a replay must not show its later state. A provider may book
  an offer only once (#693): a 4xx without a booking on the "another key"
  request is a WARNING, then the offers are asked again
  (`OfferCollectionRequest`, no key), `matchingOffer()` picks the chosen
  offer's twin and `bookingOnOffer()` drops the old offer's seat choices.
  The simulator books an offer twice, so only the unit tests reach it.
- **A return is two offer calls, in one of two models** (#594, 1.11.224 /
  OTST_V2.0.109). `library-bruno/returnJourney.js` (pure) holds the rules:
  - **SEPARATE** names the outbound offer (`outwardOfferIds`), books two
    offers; **COMBINED** names the outbound trip (`outboundTripIds`, OSDM 3.7+),
    and the chosen offer covers both trips and is booked alone, so
    `inboundOfferId` stays unset and the booking takes the one-way path.
  - **A return scenario is one with `returnInboundDate`**, set by the parser
    from `returnOffsetDays`. From 3.7 the date goes in
    `offerSearchCriteria.inboundDate`, so do not look for
    `returnSearchParameters.inwardReturnDate` on the trip to detect a return.
  - The outbound trip is taken at step 01 from the chosen offer's
    `tripCoverage` (else its first part's) into `outboundTripId`.
  - Model and version come from the OSDM 3.6/3.7/3.8 files: 3.6 has neither
    `outboundTripIds`, `inboundDate` nor `inboundTripCoverage`.
  - `admissionReservationAncillaryBookingPartsIds` holds every part of the
    booking, including those no part of the selected offer pairs with (the
    other direction of a two-offer return), each once.
- **What a real provider's first runs taught** (#644, OTST_V2.0.128). The
  simulator answers the way the collection expects, so some false failures
  only show on a real system. Rules that came out of those first runs:
  - **A deadline is checked only in the state where OSDM requires it.**
    `confirmableUntil` is ignored after PREBOOKED; step 07 logs it at INFO.
  - **"At or before now" allows `CLOCK_TOLERANCE_MS`** (2 min, `bookings.js`):
    the provider's clock is not OSCAR's. Use it for any new such check.
  - **A by-id system-information request without an id is skipped**
    (`bru.runner.skipRequest()`, the last bru call), never sent as `/null`.
  - **`purchaser` may go without an index in `requestedInformation`**; every
    other root keeps `[index]`.
  - **Compare stop places with `sameStopPlace()`** (`returnJourney.js`): a
    provider may write a UIC code without its leading zeros.
  - A provider's gateway may answer HTTP 200 with an HTML "Request Rejected"
    page: that is the provider's finding, and it stays a FAIL.
  - **A provider that stops answering must not hang a run** (#646, 1.11.240).
    A gateway blocked the server's address after repeated rejected calls;
    Bruno has no request timeout, so runs waited for ever. The runner stops a
    run whose Bruno is silent for `RUN_IDLE_TIMEOUT_MS` (5 min; off when a
    scenario arms a timer, by its flag alone since #656: without a max wait
    the collection still waits, on `RUN_TIMEOUT_MS`, silently), its timeout escalates to SIGKILL through
    `killRun()`, and `urlPolicy.js` gives the start-up DNS lookup 10 s. The
    `[runner]` lines go to the run's log in the database, not to
    `docker logs`: ask for the run's log in OSCAR when diagnosing a run.
  - **A run that gets 401 drops its token from the cache** (#680, 1.11.257).
    `dropCachedToken()` (`access-token.js`) clears the (user, company) cache
    only while it still holds the token the run sent, so a token the watchdog
    put there meanwhile stays. No retry: the run stays `TOKEN_AUTH_ERROR`.
    The simulator draws a new signing key at each restart; before this, every
    run reused the refused token until it expired (15 min on gamma).
  - **Query parameters go in the URL** (#648, OTST_V2.0.129). Bruno 4.2.1
    ignores a request file's `http.params` list; the seat map went without
    its four required parameters for months. `bruno-request-files.test.js`
    refuses a `params` list. The simulator answers 501 to `/availabilities`,
    so it cannot show such a gap: read a real provider's request URLs.
  - **After an exchange, the booking holds two sets of parts** (#649,
    OTST_V2.0.130). Step 07 keeps the part ids held before the exchange
    (`__partIdsBeforeExchange`, `exchangeParts.js`); 13/15/17 check those
    against the original offer and the others for their status
    (`checkBookingAroundExchange`). A provider may show the pre-booked
    exchange before its confirmation (the simulator does not); the pairing by
    content would otherwise take the new parts, whose passenger references
    match the offer's. Never send `age: 0` for an unknown age: it reads as a
    baby. The parts an exchange made go into
    `admissionReservationAncillaryBookingPartsIds` at 13/15, and step 14 says
    an unknown part at INFO (`deferUnknownParts`, #671): one provider gives
    them new ids on confirmation.
  - **Optional is optional** (#650, OTST_V2.0.131): a booked part's
    `afterSaleConditions` (no "s"; not required) absent is a WARNING;
    `Price.scale` absent reads as 2 (`expectScale()` in `testCapture.js`,
    which every `testCapture` mock in the tests must also provide); an
    `overallFlexibility` that one of the offer's products has passes (OSDM:
    "best represent this offer"). Read `required` in the 3.8 file before
    writing an "exists" check. An optional member compared between offer and
    booking warns only when one side has it (#744,
    `validatePartEqualityFields()`); `isReservationRequired` is on admissions
    only.
  - **A step a script routes to must not be one the run filter skips**
    (#652, OTST_V2.0.132). A skipped request runs no script, so its routing
    never happens and Bruno goes on down the folder (a skipped 08 reached
    `10. POST Refund Offers` with no booking). `setNextRequest` before
    `skipRequest()` in the filter did not help (checked with the real CLI):
    decide in the routing step, with the filter's own conditions
    (`routeAfterOfferStep()` for the seat map). The simulator scenario
    `SIM_NHF_EXPIRED_CHAIN_SEATMAP_38` holds it.
  - **One placeSelection per reservation part** (#669, OTST_V2.0.138): a
    provider may give one ReservationOfferPart per passenger on a leg; each
    passenger's seat goes under their own part (`splitByReservation()` in
    `seatReservations.js`). The simulator gives one part for everyone, so it
    cannot show this.
  - **A body template sends every `{{name}}` it holds** (#660): a branch that
    returns early must set them all, or the literal text goes out. The
    passenger sweep of step 03 sent `"type": "{{patchType}}"` for months.
  - **Action PATCH confirms an exchange** (#663, OTST_V2.0.137): an exchange
    is confirmed by its fulfilment (14); step 13 used to stop on PATCH, the
    wizard's default, so wizard-made exchanges never confirmed while every
    check passed. A REFUND without an Action asks for the refund offer only,
    on purpose (`SIM_REFUND_ONLY_OFFER_1ADT_38`).
  - **A confirmed refund offer may name other fulfillments** (#674,
    OTST_V2.0.140): one provider's PATCH answer lists new ids, CANCELLED, with
    another booking's `bookingRef`, while the booking's own are refunded.
    `recordRefundOfferStates()` fails that once at 13 and takes the refunded
    set from the offer as PROPOSED (`__refundProposed[id].fulfillmentIds`).
  - **A refund offer is held to what was asked** (#688, OTST_V2.0.142): one
    provider was asked for one passenger's fulfillment, offered all five and
    refunded another passenger's. `_proposedScope()` fails once at 10 when a
    PROPOSED offer names fulfillments the request (`requestRefundOffersBodyData`)
    did not, and keeps the asked ones as the refunded set (`widerThanAsked`),
    which the CONFIRMED branch then uses. A full refund asks for all, so it
    is never narrowed.
  - **A request object writes only the members it has** (#719,
    OTST_V2.0.154): the trip search filter sent `"lineNumbers": null` and a
    null `carrierFilter` / `vehicleFilter`, none nullable in OSDM 3.8, and a
    provider refused every such search as malformed. A new `model.js` class
    for a request must not assign unset members.
  - **A request member OSDM requires in full is sent in full or not at all**
    (#729): `productCategory` goes out only with its reference, name and short
    name (`productCategoryOf()` in `scenarioParser.js`); `{}` was refused as
    malformed. And **a member the provider says it ignored is a WARNING**:
    a PATCH answer's `PARAMETER_NOT_SUPPORTED` problems name it (`pointers`,
    else the quoted name in the title, `ignoredParameters()` in
    `passengers.js`), kept in `__passengerIgnoredFields` so that 04 grades
    alike. An empty `/trips-collection` answer is described in the log
    (`describeTripsAnswer()`), since its body is not in the report.
  - **OSCAR's own request is checked against OSDM** (#736). Two of OSCAR's
    defects read as a provider's findings until the requests were opened by
    hand. The global after-response checks each body sent to an OSDM endpoint
    (`osdmRequestSchema.js`, pure but for `recordRequestConformance()`): one
    `[OSCAR request] …` check; a failure is OSCAR's, lists paths, never values.
    The schemas (`osdmRequestSchemas.js`) are **generated**, never hand-edited:
    `Oscar_Server/scripts/generate-osdm-request-schemas.js` with
    `OSDM_SPEC_DIR` holding the 3.4–3.8 files (only 3.8 is in the repo; the
    others are on the OSDM gh-pages branch); a test pins 3.8 to the repo file.
    A new endpoint OSCAR sends a body to goes in its `OPERATIONS`. Read what
    the spec says before calling a body wrong: OSDM closes most objects
    (`additionalProperties: false`, so a member of a later version fails on an
    earlier one) and `PlaceRef` is a discriminator base, read as the subtype
    `objectType` names. A negative test that sends a wrong body on purpose
    goes in `NEGATIVE_TESTS` (method, path, the variable that arms it), or its
    check fails as OSCAR's. Script-sent requests (`bru.sendRequest`) are not
    checked yet. The raw runs of a replay (`replay/runs/*.json`) hold every
    body sent: scanning them with `checkRequestBody()` is the quick check.
  - **A reservation's leg is never sent empty, and a booking may rename
    legs** (#737). `legOfReservation()` (`seatReservations.js`): the part's
    own coverage, else the one leg of the offer's trip no other reservation
    part covers, else none. None means no `placeSelections` entry
    (PLACE_SELECTION books it through `optionalReservationSelections`,
    ADD_LATER leaves it out: 3.8's `BookedOfferPartRequest` has no other
    way). `checkBookedReservations()` matches a renamed leg by its place in
    the trip of the same id, from `__offerTripLegs` (the offer response's
    trips, kept at step 01).
  - **A search goes by place and time; the train is chosen in the answer**
    (#722). The train and operator filters (`parameters.dataFilter`) are
    optional in OSDM, and a provider that refused an operator code stopped
    every scenario at 01. They are sent only when the trip's Trip Search
    Criteria turn `trainFilter` on, and the answer is then checked
    (`checkTrainFilter()`, `library-bruno/searchTrain.js`). Otherwise
    `searchTripOffers()` (`offers.js`) keeps the offers covering the trip of
    the Test Data train, else the first at the time asked, for a one-way
    SEARCH only (not trip ids, not a return); 01c and 01d compare within the
    same trip. One trip in the answer, or offers naming no trip, are left as
    they are, so the simulator (one trip per search) gives the same checks.
  - **A SPECIFICATION trip reads `legs[]` only, a SEARCH trip `trip{}` only**
    (#749). Switching the type in Test Config goes through
    `convertTripType()` (`scenarios.js`), which copies one into the other;
    the editor draws an empty leg, never the SEARCH fields, for a
    SPECIFICATION trip without legs. The parser moves a leg's arrival to the
    next day when it is not after the departure (`arrivalAfterDeparture()`):
    both get the trip date, and a night train arrived before it left. A
    provider may support only one form of offer request: declared in the Test
    Framework since #748 (the bullet on offer request forms above).
  - **A negative probe answered 501 is "not supported"** (#751): one
    WARNING from `validateProblemResponse()` (`requestedInformation.js`), no
    FAIL and no error-body checks. Every probe that grades a refusal goes
    through it (requested information, place selection, after-sale
    refusals, limits). A real provider has no `POST …/purchaser`, and the
    four purchaser probes used to fail one after the other.
  - **No downloaded code runs, and no id comes from `Math.random`** (#758):
    `validators.js` loads AJV only as an installed module (it used to run the
    `ajvMinified` download with `new Function`, Sonar S1523); `randomUUID()`
    in `scenarioParser.js` uses `node:crypto`, else a time-and-counter value
    (S2245). `bruno-library-security.test.js` fails on `new Function(`,
    `Math.random(` or `eval(` anywhere in the library's code.
    The pages follow the same rule since #841 (1.11.336): `ui-scripts.test.js`
    refuses `Math.random(` in any `public/` page or script. Sonar's S5332 on
    the Alertmanager reload address (internal Docker network) is *Accepted*
    in Sonar with its reason, by the maintainer's decision.
  - **An unset variable in a header template goes out as text** (#692,
    OTST_V2.0.143): 47 request files carry `Requestor: {{requestor}}`, and a
    provider without a requestor got that text on every request. The
    collection's before-request removes the header then
    (`requestHeaders.js`); a request a script sends uses `requestorHeader()`.
    A new optional header template needs the same treatment.
  - **A timetable time takes the offset of the trip date** (#772,
    1.11.302): Test Data keeps the offset of the day a service was seen, so
    a run after a clock change asked for a train an hour off
    (`OFFER_TRIP_NOT_FOUND`). The parser passes each SPECIFICATION leg time
    through `onTheDay()` (`stationTimeZones.js`): the zone from the UIC
    country (first two digits of a 7-digit station code), changed only when
    the stored offset is one of the zone's two. A SEARCH sends no offset, so
    it never had the problem. **Email and phone follow the booking's version
    rule** (`personContact.js` `withContactShape()`: flat below 3.4,
    `detail.contact` from 3.4) in the passenger PATCH and the purchaser body;
    a 3.0.5 provider ignored `contact`.
  - **A reservation the provider says it ignored is "not supported"**
    (#774, 1.11.303): `reservationsIgnored()` (`seatReservations.js`) reads
    the booking's (or 09's) PARAMETER_NOT_SUPPORTED problems for
    `placeSelections` / `optionalReservationSelections`, kept per sale in
    `__reservationsIgnored`, and `checkBookedReservations()` makes that
    reservation missing a WARNING at 02, 07 and 09. Ignored members are
    parsed in one place, `ignoredParameters.js` (last segment, so
    `…placeSelections.accommodations` is not the reservation). The version
    check compares with `sameOsdmVersion()`: data file `3.8` = API `3.8.0`.
  - **Times to the second, deadlines by state, flags of refunded parts**
    (#786, 1.11.309, a 3.0.5 provider). A booking may be created in the same
    second as its offer (`checkBookingAfterOffer()`: at or after). A refund
    offer's `validUntil` is checked while PROPOSED only, like
    `confirmableUntil`. `refundable` / `exchangeable` of a REFUNDED or
    EXCHANGED part are not compared with the offer (`AFTER_SALE_DONE`). An
    answer without `offers` fails as "no offer" and quotes the provider
    (`providerReasons()`); the WarningCollection `{ warnings: [...] }` is
    OSDM's own shape, read by `envelopeWarnings()`.
  - **Each expiry sub-run sells again from a clean sale** (#658,
    OTST_V2.0.133). The queue sends the next sub-run to 01, which does not
    re-read the scenario (only `__loopback` does), so the previous booking id
    and seats stayed: the seat map was skipped and the booked seat resent.
    `clearSubRunSaleState()` (`SUBRUN_SALE_STATE` in `expiredFlow.js`) runs in
    both queue advances; a new per-sale variable goes in that list too. The
    continuation branch of `getScenarioData` is not where to do it: it never
    runs on that path. Not shown on the simulator: it has no seat map (501).
- **A check follows the specification of the version it reads, and an
  extensible list is never a FAIL** (#613, OTST_V2.0.107). A review of the
  collection against OSDM 3.8 found checks that failed conformant answers,
  checks that never ran, and two that could not fail. What it established:
  - **Most OSDM code lists are `x-extensible-enum` ("listed values are
    examples")**: PassengerType, FulfillmentSummaryStatus, service classes,
    and others. Grade them with `checkExtensibleCode()` (`osdmEnums.js`):
    FAIL only when the value is not text, WARNING when it is outside the list.
    A closed `enum` (FulfillmentStatus) is checked exactly. Read which one it
    is in the spec before writing the check.
  - **Spellings change between versions.** 3.5 (`json_validator/openapi3_0.json`)
    has `COMPANION_DOG`/`MOTORCYCLE`, 3.8 `ACCOMP_DOG`/`MOTOCYCLE`. An older
    "fix" renamed one into the other; both are listed now. Check both spec
    files before calling a value wrong.
  - **A script in the wrong place in a request file is silently dropped.**
    `11. GET Refund Offer.yml` had its after-response script under
    `http.headers` for months. `tests/unit/bruno-request-files.test.js` reads
    every request file with js-yaml and fails on that layout.
  - **The optional read-only requests are an exact-name set**,
    `OPTIONAL_READ_PROBES` in `auth.js`, as `CAPABILITY_PROBE_ENDPOINTS` is in
    the report. A 403 there does not stop the run (the #488 rule), and a 401
    still does. Add a new optional GET to that set and to the #488 classifier
    together.
  - **A refund is checked against what it covered.** `refunds.js` records the
    PROPOSED amounts per refund offer (`__refundProposed`), and the
    fulfillments a CONFIRMED offer held (`__refundedFulfillmentIds`). Step 14
    expects those REFUNDED and every other one unchanged.
    `__bookingFulfillmentIds` keeps the booking's own list, because
    `validateFulfillments` rewrites `fulfillmentIds` when it checks a refund
    offer's subset. New env vars go in both reset lists (`opencollection.yml`
    and `scenarioParser.js`).
  - **Never read a member outside `test()`** in a title or a `const` before
    it: a missing optional member then throws and aborts the step before its
    routing. Read it inside the check, or guard it.
  - **`tests/unit/bruno-osdm38-checks.test.js` runs the real validators** with
    `tests/helpers/bruno-chai.js`, now extended with `equal`, `oneOf`,
    `property`, `at.least`/`at.most`, `true`/`false`. A chain it lacks throws
    inside the check and is recorded as a failure, so assert on the check
    you mean by name.
- **Limits are declared, then tested at the limit and one past it** (#699,
  1.11.264 / OTST_V2.0.146). `maxPassengers` in the Test Framework (Passenger
  Types); a catalogue entry with `limit` (`MAX_PASSENGERS`,
  `OVER_MAX_PASSENGERS`) cannot be copied without it, and its passenger list
  is resized at copy time (`resizedPassengers()` in `catalogueMatch.js`, a
  list of its own, never the shared one). `passengerLimitExpectRejection`
  (`library-bruno/passengerLimit.js`) accepts the refusal at 01 or 02: a
  provider may price any number and enforce its limit at the booking.
  `partialRefundPaxSelection: third` refunds the last third, rounded up; a
  refund of several passengers sends one RefundSpecification per fulfillment
  (`severalPassengersScope()`), and step 10 adds up every refund offer's
  amount and fee: it read the first offer only, which a provider answering
  one offer per fulfillment always failed.
- **After-sale refusals are probes sent from the step's own script** (#700,
  1.11.265 / OTST_V2.0.147, `library-bruno/afterSaleRefusals.js`), like the
  Idempotency-Key test: `refundAgainProbe` and `exchangeRefundedProbe` at 14
  once the refund is done (the REFUNDED fulfillments only), `confirmAgainProbe`
  at 06 (no Idempotency-Key; the same fulfillments or a 4xx pass, new ones or a
  5xx fail). A probe needs no request file and no routing, so the run filter
  cannot skip it (#652). A catalogue entry with `exchangeRefundedProbe` needs
  EXCHANGE_FULL declared (`salesFlowsOf`).
- **Names are compared after the update, and an empty passenger list is a
  probe** (#703, 1.11.266 / OTST_V2.0.148). `OTST_SALE_ACCENTED_LONG_NAMES`
  relies on 03/04's `sameOrAbsent` (a different name is a FAIL); the names the
  booking itself returns are not compared, on purpose (one more check in
  every scenario). `emptyPassengersExpectRejection` empties
  `anonymousPassengerSpecifications` in 01's before-request
  (`passengerLimit.js`). OSDM gives names no maximum length.
- **A scenario can name its own departure day, and the sales horizon is
  declared** (#704, 1.11.267 / OTST_V2.0.149). `departureDaysFromToday` goes
  through `scenarioTripDate()` (`scenarioParser.js`), on the UTC calendar,
  and replaces the lead time and the weekday. `departureExpectRejection`
  (`departureLimit.js`) ends the scenario at 01 whatever the answer; a 4xx and
  "no offer" both pass. `salesHorizonDays` in the Test Framework; catalogue
  `limit` `SALES_HORIZON` / `OVER_SALES_HORIZON` sets the day at copy time.
  A 4xx counts only when its reason is about the date (#721,
  `refusalReason()`): a refusal for another reason (an unknown filter, a
  malformed request) fails "the refusal is for the departure date".
  The simulator's horizon (`salesHorizon`, station `0000094` on `gamma`)
  covers that one stop place on purpose: its tests use fixed dates, and a
  horizon or past check everywhere would make them fail once those dates
  pass. Do the same for any new date rule there.
- **A passenger can be given an age on the day of travel** (#705, 1.11.268 /
  OTST_V2.0.150). `bornYearsBeforeTravel` (+ `bornDaysAfter`) becomes the date
  of birth in the parser (`passengerAges.js` `birthDateFor()`), counted from
  `__travelDay`, which both trip branches set. `expectedPassengerType` is
  checked on the chosen offer's `appliedPassengerTypes` at 01: none given is a
  WARNING (OSDM does not require it), another type a FAIL; a younger
  passenger not cheaper than the adult is a WARNING. The catalogue's
  `AGE_RANGES` entry takes CHILD and ADULT from `passengerAgeRanges` at copy
  time (`agedPassengers()` in `catalogueMatch.js`). Do not give such a
  passenger an `updateDateOfBirth`: step 03 would change the age it was
  priced at. The simulator's age bands (`ageTariffs`) cover station `0000093`
  only, like its sales horizon.
- **What a real provider's catalogue run taught** (#709, 1.11.269 /
  OTST_V2.0.151). `passengerUpdate: false` in the Test Framework (Passenger
  Types; absent = yes) turns `patchPassengers` off in every catalogue copy:
  a provider without `PATCH …/passengers/{id}` stopped every copy at 03. It
  is handled before the change switch (`changePassengerUpdate()`), like the
  age fields: that switch is at Sonar's 30-case limit (S1479). A transfer or
  continuous leg is checked for its start and end, not a train
  (`otherLegOf()`). `PERSON` alone in `appliedPassengerTypes` is "no band
  stated" (WARNING) in `passengerAges.js`.
  **Since #809 (1.11.321) it holds in every run**: the run's copy turns
  `patchPassengers` off (`withoutUndeclaredPassengerUpdate()`,
  `utils/undeclaredSteps.js`, after the annotation that warns
  `passengerUpdate`); a provider without the route stopped every booking
  scenario at 03 and nothing after the booking was tested. Its twin
  `purchaserAfterBooking: false` (same section) refuses the catalogue's
  late-purchaser entry (`missingFor()`) and warns `bookingPurchaserMode:
  deferred`. **A trip specification leg without an operator code is sent
  without `carriers`** (OSDM requires a `ref`; `[{}]` was refused as a whole
  request), with a failed check and an `[ERROR]` only then, so other runs
  keep their check counts; the simulator's specification trips name gamma's
  carrier.
- **The scenario catalogue is the simulator's scenarios under generic codes**
  (#612, 1.11.237). `scenario_catalogue.json` holds no scenario data: each
  entry names a `SIM_…` scenario of `simulator_datafile.json` (`source`), says
  what it tests (`purpose`), how many checks it gave in the replay (`checks`)
  and may change only `…MaxWaitMinutes` fields (`set`).
  `utils/scenarioCatalogue.js` (pure) builds the data file from both and the
  requirements of each entry; the copy is the #540 one with `source_id:
  "catalogue"`, and an entry needing what the framework does not declare is
  refused (golden rule). `tests/unit/scenario-catalogue.test.js` keeps the file
  sound and schema-valid; `node scripts/replay.js catalogue` (simulator) checks
  the numbers against a recording. A scenario of the simulator that a
  catalogue entry names cannot be renamed or removed without the catalogue.
  **Each entry carries `needs`** (#681, OTST_V2.0.141): what it needs from
  the provider's data, equal to `dataNeedsOf()` of its source with
  `simulatorFacts(gamma.json)` (a test pins it; regenerate, never hand-edit).
  A reservation counts only if the scenario exercises it; an overrule code is
  a provider value, not a tariff need. Parts 2–3 of #681 use it to choose the
  train and tariff at copy time and to report what is left to complete.
  **Part 2 (1.11.255): `utils/catalogueMatch.js`, pure.** `adaptCatalogueDatafile()`
  runs in `copyContext()` on the catalogue only, so preview and copy see the
  same adapted scenarios: overrule code from `iropsCodes.refund` (a listed
  code it does *not* declare for the refusal probe), product removed,
  after-sale tariff from `offerCriteria.flexibilities` (#687,
  `afterSaleFlexibility()`: own if declared and not NON_FLEXIBLE, else the
  most flexible declared, FULL_FLEXIBLE if none). A provider may sell only
  non-flexible tariffs and refund them; never ask it for one it does not sell.
  Any other scenario with a flexibility (#691, `saleFlexibility()`): own if
  declared, else the most flexible declared, unchanged if none declared.
  The list is set in the Test Framework's 💶 Tariff Flexibility section
  (`fw-offer-pill`): before #691 no page showed it, so it was always the
  default three. `suggestTrip()` preselects a journey
  of as many legs, else the first train; Test Data carries no reservation or
  class, so those needs come back as `toCheck`, never guessed.
  **Part 3 (1.11.256): the copy report, `public/js/copy-report.js`** (browser
  global and CommonJS, like `trip-apply.js`): ready / to complete / not
  allowed, shown live in Copy scenarios and returned by the copy. A copy never
  adds to a run list; when the copier's list is "ALL" (`runsAllAfterCopy()`,
  the same reading as `POST /v1/runs`) the report warns that scenarios to
  complete would run. It does not rewrite "ALL" into a list, on purpose.
- **Find journeys is a planner over Test Data, never the provider** (#711,
  1.11.270). `public/js/journey-planner.js` (pure; browser global and
  CommonJS, needs `trip-apply.js` first) chains TRAIN services into 2- or
  3-leg JOURNEY resources. Stop places compare with `stopKey()` (leading
  zeros dropped), times in UTC from their offset. Every leg of a journey runs
  on the trip date (`trip-apply.js` gives them all `%TRIP_DATE%`), so a
  service arriving after midnight counts its arrival on the next day and
  nothing can follow it: the wait check does that, with no separate rule. The
  search has a budget (`SEARCH_BUDGET`) and reports `truncated`. A result is
  pushed as an unsaved journey; the Journeys section is drawn closed, so the
  page opens it before showing the new journey. Unsaved train sets (no id)
  are left out. Each search answers with its time and values first, and an
  empty result with its reason, from `planJourneys().stats` (#730): without
  that, a search giving the same answer as the last one looked like no click.
  **The place lookup offers Test Data's stop places first** (#733,
  `findStopPlaces()` in the same file, merged with the cache by
  `mergePlaceLookups()` in `scenarios.js`): a real provider answers
  `GET /places` with 501, so its cache stays empty. Discover timetable stores
  `originName` / `destinationName` on a new set (on an existing one only with
  another change, like every descriptive field). The refresh route's 502
  carries `vendor_status`; 501/404/405 is told as "no list", not an error.
- **Discover timetable keeps the provider's connections** (#715, 1.11.272).
  Trips of 2 or 3 timed legs become JOURNEY resources over the services
  `groupAndMerge` stored (`harvestConnections()` / `journeysFromConnections()`,
  pure, in `services/timetable-discovery.js`; the route writes them after the
  trains). A leg is found by route, product category, service key and day;
  identical legs are never stored twice. `searchWith: 'trips-collection'`
  asks the trip search first, `/offers` on a failed or empty day. The
  simulator's search gives direct trips only, so only the tests show a
  connection.
  **The offer re-probe checks each service** (#787 PR 1, 1.11.312): it
  keeps the direct trains each `/offers` answer shows (`harvestTrips`) and
  the days answered, searches once more at the time of a service no answer
  showed (`askUnseenServices()`, at most 6 per route), then adds per set
  `serviceFindings()` (pure, `timetable-discovery.js`): a number the
  provider writes otherwise (`OSDM-104` / `OSDM_104`, compared without
  punctuation or case), another train at that time, a time, day, product
  category or operator that differs; at most 8, then "… and N more".
  `classifyOfferProbe` reads OSDM's WarningCollection `{ warnings: [...] }`.
  **Trips follow a corrected set** (#787 PR 2, 1.11.313): a trip keeps no
  link to its set ("Apply test data" copies values), so saving an edited set
  (`wizSaveTrain`) calls `offerTripUpdateFromTrain()`: blocks with the set's
  route and a service's number *as before the edit* (`blocksBuiltFrom()`,
  `trip-apply.js`) that the edit would change (`tripUpdatesFromTrain()`) are
  refilled after a confirmation, except trips of a read-only scenario.
  **A journey can be probed** (#813, 1.11.323): `POST
  /test-resources/:id/probe-journey` searches first stop place → last, at the
  first departure, on the next 3 days all its trains run (`probeDates()`,
  within 14), trips-collection then `/offers` (kept once one answers), in
  sequence. `services/journeyProbe.js` (pure) compares with the legs
  (`stopKey()`, train number without punctuation, `HH:MM`): found, the
  closest trip of as many legs and what differs, or not found with what is
  offered. Writes nothing; the page shows it under the row
  (`journeyProbeHtml()`, escaped). A journey whose train set is gone is a 400.
  **A trip it finds can be kept** (#815, 1.11.324): the answer's
  `offeredTrips` (`collectOfferedTrips()`: each trip once, weekdays seen),
  and `POST /test-resources/journey-from-trip` stores the legs with
  Discover's `groupAndMerge` then `journeysFromConnections`; the trip date
  check (`fitsOneTripDate`) runs before any write. `POST
  /test-resources/probe-journey` probes legs not saved as a journey (Find
  journeys). The page keeps answers in `probeResults` by key (`j<n>` /
  `f<n>`).
  **A saved journey not offered is replaced, not patched** (#865): under a
  saved journey (`j<n>`) the page shows no per-trip button but one "Replace
  this journey with the N trip(s) offered" (`probeOffersAsDefined()` says
  when there is nothing to change). `POST /test-resources/:id/replace-journey`
  checks every trip first (`checkedTrip()`), then in one `transaction()` keeps
  each (`keepTrip()`, the #815 path) and deletes the old journey unless a
  kept one is it; train sets stay. Find journeys results keep "Use this
  trip". Train numbers compare number by number (`numbersOf()`): `382/382`
  is `382`.
- **A run goes on a day its trip's trains run** (#717, 1.11.273 /
  OTST_V2.0.153). Trips keep no calendar, so the server matches each trip
  requirement against the TRAIN resources when it serves the run's copy
  (`withTripCalendars()` in `server.js`, `utils/tripCalendar.js`): stop
  places and train number, else departure time. It writes `__operatingDays`
  and `__calendarNotes` there, never into the stored file. Test Data text in
  a note has `{{` broken up, because the run reads the file as a template.
  The collection's `tripDateFor()` (`library-bruno/tripCalendar.js`) moves an
  unnamed date forward to the first such day; a day the scenario names
  (`departureDay`, `departureDaysFromToday`) is kept and warned about.
  **A return goes on a day a train goes back** (#778, 1.11.305): the server
  also writes `__returnServices` (Test Data services from the trip's last stop
  place to its first: departure, number, days), and `dateForTrip()` takes the
  first day the outbound runs with one of those, leaving at or after the
  return time (`returnTime`, else the outbound time), `returnOffsetDays`
  later. None after that time is a WARNING with their times; no direct train
  back, or one without calendar, checks nothing.
  `POST /test-resources/fill-calendars` fills sets without days from 7 days
  of `/offers`, only when every service was seen (`calendarFromHarvest()`);
  Discovery's merge fills a calendarless twin instead of adding a set
  (`_uncalendaredTwin()`). `_vendorSession()` is the one place a route gets
  the provider's endpoint, token and headers.
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
  - **Which passengers step 03 updates is `passengerUpdateScope`** (#642,
    1.11.238): `ALL`, or `MAIN` (the first only; some providers refuse the others with
    400 `BOOKING_PASSENGER_PROPERTY_NOT_MODIFIABLE`). The parser builds
    `passengerAdditionalData` from it and `patchPassengers`: an updated
    passenger is expected with the `update*` values, any other with the
    booked ones (before 1.11.238 a scenario with `patchPassengers: false`
    failed five checks). In 03/04 a detail sent but not returned is a
    WARNING, a different one a FAIL. The simulator's `Main-Passenger-Only` /
    `Main-Names-Only` variants are what proves both.
  - **To run the real collection against it locally:** a throw-away OSCAR
    server with `ALLOW_PRIVATE_TARGETS=1` and `BRU_CMD=bru.cmd` set before
    `require('src/server.js')`. The local `Oscar_Server/.env` has
    `BRU_CMD=echo`, and dotenv does not replace a variable already set: without
    that line a run "completes" with no request made. Seed the company and a
    Test Manager, then `PATCH /v1/company`, `PATCH /v1/me/credentials`,
    `PUT /v1/company/datafile/json`, `POST /v1/runs`.
  - **One OSDM version per provider** (#614): `alpha` 3.6.0, `beta` 3.7.0,
    `gamma` 3.8.0. **Since #824 (0.34.0) the three have the same
    functions**: alpha and beta hold every optional key of gamma's profile
    with the same values, and a second currency each (alpha EUR + CHF, beta
    CHF + EUR); `tests/config.test.js` pins it, so a new function goes in all
    three files. Tests of a provider without a function use `plain`
    (`tests/fixtures/providers/`, loaded by `tests/helpers.js` only, never
    shipped). Only a COMBINED return is not run on alpha: OSDM 3.6 has no
    `outboundTripIds`. **Since #833 (0.35.0) each answers in its own
    version's shapes** (`src/osdm/versionShapes.js`, applied at send time:
    the routes still build 3.8; below 3.8 documents are held by each
    fulfilment, below 3.7 `inboundTripCoverage` & co. go). **Every answer a
    simulator test receives is checked against the OSDM response schema of
    the provider's version** (`tests/osdm-conformance.js`, from `call()`):
    a new member or answer that OSDM does not have fails a test. The schemas
    are generated (`Oscar_Server/scripts/generate-osdm-response-schemas.js`
    → `tests/fixtures/osdm-response-schemas.json`, 3.8 pinned); remove a member
    by name in `versionShapes.js` only when the earlier version has it in no
    schema. `Problem.pointers` are ProblemPointer objects; the collection
    reads both forms (`pointerText()`). Restarting a local simulator: check
    the new process did start (EADDRINUSE) before recording a replay.
    **Faults on demand (#833 PR B, 0.36.0)**: `src/osdm/faults.js`, asked by
    the header `X-Simulator-Faults` or a token scope `sim-faults:…` (claim
    `f`); unknown codes are refused. A fault changes a copy of one answer
    (after `shapeAnswer`), never the stored state; error faults change the
    Problem in `handle()`'s catch. Each entry's `expect` (step, check text,
    level) is what OSCAR must report; the detection report (PR D) reads it,
    so a fault without a reliable expectation does not belong there.
    **PR C (1.11.332 / OTST_V2.0.185): one `SIM_FAULT_<CODE>_38` scenario per
    fault** (gamma, out of the run list), field `simulatorFaults` → env var →
    header on every request (`applySimulatorFaults()`, `requestHeaders.js`,
    in the collection's before-request and 01's loop-back branch); any safe
    word goes out, so a typo is the simulator's 400, never a silent drop.
    `datafile.test.js` pins one scenario per catalogue code. The first run
    showed two OSCAR gaps: a refusal without `Problem.code` passed silently
    (now a WARNING in `validateProblemResponse()`), and an HTML answer to a
    booking read crashed the step's script ("Post-Response Script Error"):
    every GET Booking step now starts with `jsonObjectOrStop()`
    (`loopback.js`), one failed check and the scenario stops.
    **PR D (1.11.333): the detection report.** `utils/faultDetection.js`
    (pure): `detect()` matches each (run, fault) of a batch with the
    catalogue's `expect` (FAIL = a failed check of that step whose text holds
    the check; WARNING = a `[WARNING]` line of the run's log, decrypted from
    `run_events`, or a failure), `scoreAnalysis()` reads an AI analysis on the
    faults OSCAR *failed* only (warnings are never sent to it): explained =
    a provider group naming an expected step and the scenario (or none),
    misattributed = another owner, missed = no group. Owner, step and
    scenario only, never the cause's wording. `simulator-faults.json` is
    **generated** (`scripts/generate-simulator-faults.js`) from the
    simulator's `faults.js`, which is not deployed; a test fails until the
    two agree. Route `GET /ai-analysis/fault-detection?batch=&analysis=`
    (Test Manager, no model called); page buttons in the AI analysis card.
    `tests/helpers/fault-replay.json` is the replay's failures and warnings of
    the 12 SIM_FAULT scenarios: re-extract it when a fault's checks move.
    **Reference configurations (#838, PR 1 = 1.11.334 / OTST_V2.0.186):**
    `Bruno_Collection/data_base/reference/simulator-<provider>.json`, what a
    company testing that provider must hold: framework (the editor's
    `emptyFramework()`, restated as `defaultFramework()` and pinned by a test,
    with every `fw.*` answer of the provider's checklist over it; IRREGULAR
    codes always get the mandatory four; a list asked with nothing ticked is
    `[]`), Test Data (`testResourcesFromDatafile()`: a train per distinct leg,
    a journey per trip of several legs) and run list (the provider's OSDM
    version, no `SIM_WRONG_`/`SIM_FAULT_`). The scenarios are named, not
    copied: `configurationOf()` joins reference and data file in the #810
    format. **Generated** (`scripts/generate-reference-configurations.js`)
    from the checklist, the profile and the data file: a test fails until it
    is rerun after any of them changes, and a checklist question the module
    does not place stops the generator. The OSDM version is the profile's
    (`3.6.0`), checked against the checklist's (`3.6`).
    **PR 2 (1.11.335): following a reference.** `companies.reference_name`
    / `reference_version` / `reference_applied_at` (migration 37); routes
    `GET`/`PUT /v1/company/reference` and `POST /reference/apply` in
    `company.js`. The update is the #810 import with every part `replace`
    (`applyConfiguration()`, under the datafile lock), never the endpoint
    or credentials. `utils/referenceStore.js` reads a name of the fixed
    list only, from `COLLECTION_PATH/data_base` (pulled on every push to
    main: no call to GitHub), the repository copy as fallback; its
    version is sha256 of the reference + data file text, so either moving
    reads as "not up to date": in Test Config's box
    (`public/js/reference-config.js`) and on the run page
    (`referenceNoticeText()` in `run.html`), both pinned by
    `reference-config-page.test.js`. The data file
    holds each sale scenario once per version (`_36`, `_37`, `_38`), and
    `tests/datafile.test.js` keeps one pair per provider version. Below 3.8
    the collection asks `/coach-layouts` instead of `/coach-deck-layouts`;
    nothing else it sends in a sale changes.
  - **Its data file is `Bruno_Collection/data_base/simulator_datafile.json`,
    the one copy** for OSCAR and for a standalone run (#593), with
    `environments/OTST_Simulator_Env.yml` and `00-Access Token/Simulator Access
    Token.yml`; steps in `Bruno_Collection/README.md`. Two traps found running
    it with `bru` 4.2.1: a `bru run` of the whole collection leaves out
    `00-Access Token` (that folder carries its own `opencollection.yml`), so
    name the folders; and `scenarioTarget` in a collection run repeats the
    same scenario without end; one scenario is `scenario_override`, as OSCAR
    does. Standalone and through OSCAR give the same checks (171 and 230
    through OSCAR since #613), plus the two of the token request standalone. **`bru run` writes the
    run's variables back into the environment file** (secret variables
    excepted): check its size before committing it; #593's first push carried
    918 lines of run state.
  - **`node --test` takes a glob, not a directory**, on Node 22 and later
    (`node --test "tests/*.test.js"`), and its lcov reporter does not create the
    destination directory. Sonar's coverage run starts from the repository root
    so that the report's paths are `OSDM_Simulator/src/...`.
  - **A body over the limit is read to its end before the 413**, without being
    kept, up to a second limit. Answering while the caller is still sending
    closes the connection under its feet and it never sees the status.
  - **`gamma` exchanges, and has a short-deadline stop place** (#611, 0.16.0).
    Exchange state is a hidden `Symbol` on the booking (never serialised);
    with an exchange pre-booked, `POST …/fulfillments` confirms the exchange,
    not the booking. A trip from `urn:uic:stn:0000099` makes everything that
    comes from it expire after 60 s: only the `SIM_NHF_EXPIRED_*` scenarios use
    that trip, and the data-file test keeps it so. A pre-booked booking past its
    limit is read with its parts `RELEASED` (the collection checks that).
    Scenario data is appended to `simulator_datafile.json` as text, never by
    re-dumping the file (its formatting is hand-kept).
  - **Variants are chosen by a passenger's last name at booking**
    (`Simvariant-<name>`, #611, 0.17.0), because offers are anonymous; a
    variant holds for the booking's life (hidden `Symbol`). The
    `SIM_WRONG_*` scenarios fail on purpose and stay out of the run list;
    `SIM_WRONG_BOOKING_PRICE_38` fails nothing today (the collection does not
    compare `provisionalPrice` with the parts) — when such a check lands, it
    must start failing.
  - **The replay is the before/after check for `library-bruno/`** (#611,
    0.19.0): `node scripts/replay.js record before|after`, `compare`,
    `coverage`, in `OSDM_Simulator/`. Two recordings of one commit compare
    equal; anything that differs between runs on its own must be added to
    `VOLATILE` in `replay-lib.js`, never compared loosely. A full recording
    takes about 13 minutes, most of it in the expiry probes. Coverage from a
    full recording was 70.7 % of the loaded `library-bruno/` lines (#528 can
    restyle the covered lines and compare old/new functions for the rest).
    `describe` (#640, 0.21.0) writes `Documentation/Test_Coverage/OSCAR -
    Checks by scenario.md` from `replay/after.json`: every check of every
    step, values a run met shown as `N`/`…` (`checkText()`), and per scenario
    its steps and the checks at most four scenarios make. It is generated:
    record and regenerate after a collection release, never edit it. The
    reference-scenario tables of `OSCAR - What is tested.md` are pinned to
    `scenario_catalogue.json` by `tests/what-is-tested.test.js`. The failure
    counts of the `SIM_WRONG_*` rows in `OSCAR - OSDM Simulator scenarios.md`
    are not pinned: they had drifted to twice the real number (#678). Check
    them against the regenerated page when a collection change moves a check.
  - **A load test of OSCAR needs the simulator's limits raised** (#676): every
    run comes from the OSCAR server's address, about 4 requests a second
    each, against 50/s in nginx and 3,000/min in the simulator. The page's
    section 7 raises them through `deploy/docker-compose.override.yml`
    (git-ignored, so the update's `pull --ff-only` still works; applied by
    `up -d`, never by `restart`) and puts them back. OSCAR caps first: 10 per
    company (Test Framework), 20 per server (`MAX_CONCURRENT_RUNS`).
  - **Tickets per passenger or per leg are chosen by the trip's stop place**
    (#697, 0.23.0, profile `ticketing`): on `gamma` a trip from
    `urn:uic:stn:0000096` gets one ticket per passenger, one from `0000095`
    one admission per passenger and leg and one ticket per leg; only those
    bookings (and the `per-passenger` variant) accept a refund scoped by
    passenger or booking part. They are the sources of the catalogue's
    `OTST_REFUND_PARTIAL_PASSENGER_2ADT` / `_LEG_1ADT`. A variant (last name)
    cannot be a reference scenario's source: the copy would send that name
    to the provider.
  - **Its version is visible and released on its own** (#617, 0.15.0):
    `/healthz` returns `{status, version}`; a version change on `main` tags
    `simulator-<version>` with a GitHub release whose notes
    `scripts/release-notes.js` reads from the CHANGELOG (the section whose
    first line says `Simulator <version>.`; a version it does not find stops
    the workflow, and `tests/release-notes.test.js` fails first). The same
    change updates the installed simulator (`simulator-deploy.yml`, forced SSH
    command = a copy of `deploy/update.sh` outside the checkout). Only on a
    version change: a restart clears every booking and token.
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
- **Every image a page shows is served by OSCAR** (#805, 1.11.319). The
  banner's UIC and OSDM logos were loaded from uic.org and broke on every page
  when uic.org stopped serving them. They are `public/uic-logo.png` and
  `public/osdm-logo.png` (the maintainer's files; the originals are in the
  private repository), the content security policy's `imgSrc` is `'self'` and
  `data:` only, and `page-images.test.js` fails on a page loading an image
  from another site. **Since #807 (1.11.352) the banner is one script and one
  stylesheet**: a page's `<header class="uic-banner">` starts with
  `<script src="/js/banner.js"></script>` (it puts the logos in front of
  itself, element by element; `nav.js` still draws the menu bar after it),
  and `css/oscar-banner.css` is the page's first stylesheet. No page or other
  stylesheet repeats a banner rule or a logo: `shared-banner.test.js`. A new
  page copies that header, not the logos. The pages are measured by Sonar's
  copy-paste detection again.
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
| **Bruno collection / OSCAR server** | `Bruno_Collection/` (requests + `library-bruno/` validators, versioned by `Bruno_Collection/VERSION`) / `Oscar_Server/` (API, Test Config, Test Framework, versioned by its `package.json`) |
| **Reference scenario** | a generic scenario of the scenario catalogue, offered to every company and copied into a company's data file as an ordinary scenario (#612) |
| **Scenario catalogue** | `Bruno_Collection/data_base/scenario_catalogue.json`: the reference scenarios, each naming the simulator scenario that supplies its data, what it tests and its number of checks on the simulator (#612) |
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
`npx jest --rootDir="$(cd .. && pwd)" --testMatch="**/tests/**/*.test.js"`.
Since #754 Jest's `rootDir` is the repository root, not `Oscar_Server/`.)

**Claude Code worktrees (`…/oscar-monorepo/.claude/worktrees/<name>/`)** trip
over the `.claude` dot-directory twice. First, `npx jest` finds 0 tests, and so
does a positional path filter: use
`npx jest --rootDir="$(cd .. && pwd)" --testMatch="**/tests/**/*.test.js"`
(from `Oscar_Server/`; `rootDir` is the repository root since #754), and
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
| `Oscar_Server/src/utils/scenarioCopy.js` | rules of copying scenarios between providers, #540 |
| `Oscar_Server/public/js/trip-apply.js` | the one "Apply test data" implementation (browser + server), #540 |
| `Oscar_Server/public/js/journey-planner.js` | Find journeys: chains Test Data's train sets into 2- or 3-leg journeys, no provider call, #711 |
| `Oscar_Server/src/utils/datafileVersion.js` | the data file version (ETag) a Test Config save is checked against, #540 |
| `Oscar_Server/src/utils/datafileSchema.js` | the upload's data file check: the collection's run-time schema rules, re-stated and pinned to `validators.js` by a test, #549 |
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
| `Bruno_Collection/data_base/simulator_datafile.json` | the simulator's data file, two sale scenarios per OSDM version (#614), the one copy for OSCAR and for a standalone run (#593); `OSDM_Simulator/tests/datafile.test.js` keeps it valid and answerable |
| `Bruno_Collection/README.md` | running the collection standalone (Bruno desktop and `bru run`), against the simulator's `gamma` (#593) |
| `Documentation/Server_Operations/OSCAR - OSDM Simulator.md` | installing the simulator on its own host and pointing a company at it |
| `Documentation/User_Guides/OSCAR_Test_Config_Checklist.docx` | questions to a provider before its first run (Part A the whole provider, Part B one sheet per service, Part C journeys with changes) and an annex giving where each answer goes in OSCAR (#746). Since v2 (#795) every answer is a Word content control tagged with its answer name (`fw.…`, `api.…`, `data.…`, `info.…`), so a filled-in copy can be read back; it is generated from the sources kept in the private repository (`analysis/checklist-generator`), never edited by hand. Add the question and its annex row when a setting is added or moves |
| `Documentation/Test_Coverage/OSCAR - What is tested.md` | what a run tests: the simulator per provider, what each Bruno step checks, the reference scenarios with scope, needs and checks (#640) |
| `Documentation/Test_Coverage/OSCAR - Checks by scenario.md` | generated by `replay.js describe`: every check of every step, and each scenario's distinctive checks (#640) |
| `Documentation/Server_Operations/OSCAR - OSDM Simulator scenarios.md` | every scenario of the simulator's data file: what it tests, what the simulator answers, the expected result and warnings (#603); pinned to the data file by `OSDM_Simulator/tests/datafile.test.js` |

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
  Quality Gate is required + green (§2). `public/**` stays excluded from the
  coverage metric. **`library-bruno/**` is measured since #754** and is raised
  PR after PR (maintainer decision 2026-10-15). Three things made it work, all
  in `Oscar_Server/package.json`:
  - Jest's `rootDir` is the repository root, with `roots` = `Oscar_Server` +
    `Bruno_Collection/library-bruno`.
  - The provider is `v8`. The babel provider does not instrument a file
    outside `Oscar_Server/`, and v8 keeps only files under `rootDir`; with
    either missing, the report silently has no `library-bruno` line.
  - lcov paths are written from the repository root (`projectRoot: '..'`),
    as Sonar's base directory expects.

  At #754: 44 of its 48 modules reached, ~81% of their lines (v8 counts);
  `Oscar_Server/src` ~95% under v8 (it read ~93% under babel: the two count
  differently). The weakest: `displays` 19%, `afterSalesRules` 42%,
  `placeProbes` 45%, `validators` 46%, `offers` 55%, `auth` 58%.
  `exchanges` went from 55% to 99% in #756 (`bruno-exchanges.test.js`),
  which also taught `tests/helpers/bruno-chai.js` `lengthOf.at.least(n)` and
  `eql(v, message)`: a chain the stub lacks throws inside the check and is
  recorded as a failure, so a validator's check can look failed in every
  unit test for that reason alone. No test loads `loopback`, `mergeReport`, `reportGenerator` or
  `schema`; Sonar counts them as uncovered. A PR touching `library-bruno` is
  now held to the 83% new-code bar.
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
