# Changelog

All notable changes to OSCAR (OSDM Conformance Automation Runner) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- (next cycle)

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
