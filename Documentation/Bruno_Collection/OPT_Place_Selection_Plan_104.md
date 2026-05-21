# Implementation plan — OPT-PLACE (issue #104) + optional-features architecture

> **Status:** DRAFT for review. No code changes yet. Once validated, we proceed.
> **Branch:** `feat/104-place-maps-sale-flow` (off `origin/main`).
> **Spec basis:** OSDM v3.8.0 (`OSDM-online-api-v3.8.0.yml`), findings posted on issue #104.

---

## 1. Goal (business)

Today `03. GET Place Maps` sits under **01-System Infos Requests**, but it is **transaction-scoped** (needs an OFFER + RESERVATION context) — it does not belong with reference-data endpoints. More broadly, place selection and ancillaries are **optional, offer-driven** steps with **no fixed position** in the sale flow (see issue #104 business findings).

We will model these as **optional modules** rather than fixed numbered steps, gated by the offer content and the existing scaffolding so they stay **inert (zero regression)** until a relevant scenario + supporting vendor exists.

This document covers **OPT-PLACE Stage A (pre-booking)** in full (the #104 deliverable), and sketches Stage B and OPT-ANCILLARY as follow-ups so the architecture is coherent.

---

## 2. Architecture — "optional, offer-driven modules"

> **Key design driver (spec-verified, see §2.4):** OSDM does **not** model IRT/NRT, and pins the **graphical seat map to *pre-booking*** — there is no post-booking seat-map flow. So the two place-selection variants are **two different OSDM mechanisms**, not the same call at different times. The whole solution is shaped around this.

```
                 ┌─────────────── mandatory spine ───────────────┐
   Get Offer ──▶ │ Create Booking ──▶ PATCH Pax ──▶ GET Pax ──▶ … │ ──▶ Fulfillments
       │         └───────────────────────────────────────────────┘
       │  (offer-driven gates)                       ▲
       │                                             │
       ├──▶ OPT-PLACE / PRE_BOOKING  ────────────────┘
       │       place-map (MANUAL_* flow) → chosen seats into BookingRequest.placeSelections
       │       (OSDM seat-map path — spec-pinned to before /bookings)
       │
       └──▶ OPT-PLACE / POST_BOOKING ── after Create Booking ──▶ POST …/booked-offers/{id}/offer-parts
               (add a reservation NOT in the original offer — provider-optional;
                NOT a deferred seat map. SNCF "seat after booking" maps here.)

   OPT-ANCILLARY (future sibling) — driven by offer.ancillaryOfferParts (Sqills pilot);
   same add-offer-part endpoint family.
```

### 2.1 Gating model — three configuration layers + the runtime offer

An optional module (seat map/selection, ancillaries) fires only when **all** of the following agree. The first three are *configuration* set by the test manager / scenario author; the fourth is the *live reality* returned by the system under test.

| Layer | Question | Set by | Where it lives today |
|---|---|---|---|
| **Gate 0 — Test-system capability** | Does *this system* support ancillaries / seat map / seat selection at all? | Test manager, once per test system | **The Test Framework config** (`/v1/company/test-framework`, `framework.config`). **PARTIAL** — already declares `rail.ticketTypes` (IRT / NRT_OPTIONAL_RESERVATION / NRT_NO_RESERVATION), `ancillaries[]`, `accommodations[]`, `offerCriteria.requestedOfferParts[]`, `offerCriteria.requiresPlaceSelection`. **Missing:** explicit "graphical seat map (manual selection) supported" + timing. |
| **Gate 1 — Scenario selection** | Does *this scenario* want to exercise the option? | Scenario author, per scenario | **EXISTS** — `salesFlowActions { placeSelection, addAncillary, deleteAncillary, … }` (UI "Booking Flow Actions" pills). New scenarios default **all-OFF** (`defaultSalesFlowActions`); only legacy data files (no field) backfill all-ON. So "explicit opt-in" already holds for authored scenarios. |
| **Gate 2 — Timing (WHEN)** | When does seat map/selection occur — before booking (price-affecting) or after (SNCF)? | **Scenario author** (a railway supporting both IRT and NRT picks per train/scenario), within what the framework allows | **MISSING**. The current "Booking Flow Actions" are described as *after booking* only. |
| **Runtime — the offer** | Does the *actual offer* support it? | System under test (live response) | spec fields exist: `reservationOfferParts[]` / `ancillaryOfferParts[]` present; `supportedPlaceSelectionFlows[]` = `MANUAL_*` ⇒ seat map, `AUTOMATIC_PLACE_SELECTION` ⇒ none, `AUTOMATIC_*_NEARBY`/`_PREFERENCES` ⇒ other availabilities call. Already surfaced as `NOT_APPLICABLE` rows in the **Vendor Capability Matrix**. |

**Decision logic:** `capability (Gate 0)` AND `scenario opts in (Gate 1)` decide *whether*; `Gate 2` decides *when*; the *runtime offer* decides *feasibility*. A **mismatch is itself a test result**, not a crash — exactly the existing `NOT_APPLICABLE` → Vendor Capability Matrix mechanism (a scenario asks for seat selection on a system declared capable, but the offer returns no `MANUAL_*` flow → one matrix row).

### 2.2 The two-tier authorisation model (test-system config first)

> *"Be very clear on the test-system config first, then implement the logical control of scenario execution in Bruno."*

1. **Tier 1 — Test Framework config (Gate 0) authorises.** The test manager declares, once per test system, what the SUT supports. This is the existing framework config — we extend it (not invent a parallel block).
2. **Tier 2 — Scenario (Gate 1) selects** among what Tier 1 authorised. The "Booking Flow Actions" pills must be **constrained by Gate 0**: if the framework says the system has no seat map / no ancillaries, the corresponding pill is disabled/hidden — you cannot select an unsupported option.
3. **Flow to runtime.** The framework capability + scenario selection + timing are written into the generated **data file**, which the Bruno collection (`scenarioParser`) reads and uses to gate execution. Bruno is the *executor* of an already-authorised decision.

### 2.3 Test-system config (Gate 0) — concrete proposal

Extend `framework.config` (and `emptyFramework()` / `datafile.schema.json` / framework UI section), reusing what exists:

| Capability | Reuse / add | Meaning |
|---|---|---|
| **Reservation supported** | reuse `rail.ticketTypes` | `IRT` (bundled, e.g. TGV) and/or `NRT_OPTIONAL_RESERVATION` ⇒ reservations exist; `NRT_NO_RESERVATION` only ⇒ none |
| **Seat map (manual selection) supported** | **add** `placeSelection.seatMap: boolean` | system exposes a graphical place-map (`/availabilities/(vehicle-)place-map`); maps to OSDM `MANUAL_*` flows. Distinct from "has reservations" (could be `AUTOMATIC`). |
| **Supported timings** (capability menu) | **add** `placeSelection.supportedTimings: [PRE_BOOKING, POST_BOOKING]` | which timings the system can do at all. A railway doing both IRT and NRT typically supports both. |
| **Place selection required** | reuse `offerCriteria.requiresPlaceSelection` | already present at framework + scenario level |
| **Ancillaries supported** | reuse `ancillaries[]` (non-empty ⇒ supported) | already present |

**Timing is chosen per scenario (Gate 2), not fixed per system.** The framework declares the *menu* of supported timings (capability); each scenario picks `placeSelectionTiming: PRE_BOOKING | POST_BOOKING` from that menu — because a railway running both IRT and NRT decides per train/offer whether the seat map is offered at offer level or at booking level.

**Gate 1 constraint (authoring):** the "Place selection" pill is selectable only if Gate 0 has reservations + `seatMap`; the scenario's `placeSelectionTiming` choices are limited to `placeSelection.supportedTimings`; the "Add/Delete ancillary" pills only if `ancillaries[]` is non-empty.

### 2.4 Spec nuance — OSDM does *not* model IRT/NRT, and pins the seat-map to pre-booking

Verified against v3.8.0 (matters for how Gate 2 maps to endpoints):

- **`IRT`/`NRT` are not OSDM API terms** — they don't appear in the spec. They're UIC commercial/product concepts. OSDM models *reservations* and *place-selection flows*, not ticket types. (OSCAR's framework `rail.ticketTypes` is OSCAR's own classification, fine to keep.)
- **For a graphical seat map, OSDM is prescriptive: it is pre-booking.** Every `MANUAL_*` `PlaceSelectionFlow` says *"/availabilities/vehicle-place-map must be called before the /bookings call"*; the chosen places are passed in `BookingRequest…placeSelections`. There is **no** `PlaceSelectionFlow` value for a post-booking seat map.
- **"Mandatory reservations are booked when the booking is being booked"** (`OfferSelection.optionalReservationSelections` description). So an integrated/mandatory reservation is created with the booking; manual place choice for it is pre-booking.
- **Post-booking is a different mechanism, not a deferred seat map.** Adding a reservation after booking uses `POST /bookings/{id}/booked-offers/{id}/offer-parts` (the older `…/reservations` endpoint is **deprecated**) — *"Adds a reservation not previously added from offer"*. It is open to the provider ("a provider can decide to allow or reject").

**Consequence for Gate 2:** `PRE_BOOKING` and `POST_BOOKING` are not just "when the same call happens" — they select **two different OSDM paths**: PRE = place-map → `placeSelections` in the booking; POST = book first → add a reservation/offer-part afterward. Stage A builds PRE (the spec-pinned seat-map path); Stage B builds POST (add-offer-part).

### 2.5 Naming + UX — the "grandmother test"

Because the two variants are **different mechanisms** (§2.4), `POST_BOOKING` is misleading (it sounds like a deferred seat map; it is actually *adding a reservation to an existing booking*). Rename the field from `timing` to **`placeSelectionMode`**, with self-describing values and plain-language UI labels:

| Value (data file) | UI label (no OSDM jargon) | Helper line in the UI | OSDM path |
|---|---|---|---|
| `SEATMAP_AT_OFFER` | 🪑 *Seat map at offer* | "Traveller picks a seat **before** the booking is created (seat may affect price)." | place-map → `BookingRequest.placeSelections` (Stage A) |
| `ADD_TO_BOOKING` | ➕ *Add reservation to a booking* | "A seat reservation is added **after** the booking exists (e.g. SNCF first-class TGV)." | `POST …/booked-offers/{id}/offer-parts` (Stage B) |

*(Confirmed 2026-05-21.)*

**The grandmother test — the UI must let a non-OSDM-expert set this up correctly:**
1. **Framework first, plain questions.** The Test Framework section asks, in plain toggles: *"Does the system offer seat selection?"* → *"Shown as a seat map?"* → *"When? (seat map at offer / add to an existing booking / both)"* → *"Which ancillaries?"*. No OSDM terms; map to spec under the hood.
2. **Scenario only shows what's authorised.** The "Booking Flow Actions" pills are filtered by Gate 0 — unsupported options are **hidden or disabled** with a tooltip *"Enable this in your Test Framework first"*. The mode picker only offers timings the framework allows. The test manager **cannot** build an impossible combination.
3. **One-line "what this means" per choice**, with a concrete rail example (TGV first-class = *Add to a booking*; high-speed reserved seat with seat fee = *Seat map at offer*).
4. **Sensible defaults** so the common case needs no thinking: seat selection OFF; if ON and only one timing is supported, it is preselected.

This UX is part of the **Tier-1 framework-config workstream** (it is where the test-system config is authored).

**Safety property (zero regression):** today Place Maps stays inert because the `opencollection.yml` smart filter skips `placeMap` for SALE and Get Offer routes around it. New scenarios default `salesFlowActions` all-OFF. With Gate 0's new `seatMap`/`timing` absent and no scenario selecting place selection, the module **never executes in any existing scenario**. It activates only when framework capability + scenario selection + timing all line up.

---

## 3. OPT-PLACE Stage A (pre-booking) — the #104 deliverable

### 3.1 What changes

> **Precursor — Tier 1 (separate workstream, OSCAR server).** Extend the **Test Framework config** with the new capability fields (`placeSelection.seatMap`, `placeSelection.timing`) in `emptyFramework()` + framework UI section (`Oscar_Server/public/js/scenarios.js`), constrain the Gate-1 "Booking Flow Actions" pills by Gate 0, and write the capability + `placeSelectionTiming` into the generated **data file**. This is the "test-system config" to nail first; #104 (below) consumes it. Tracked as its own issue.

| # | Change (Bruno collection — #104) | File(s) |
|---|---|---|
| A0 | **Consume Gate 0 + Gate 2 from the data file** — parse the framework-derived capability + `placeSelectionTiming` into env vars; validate in `datafile.schema.json` | `json_validator/datafile.schema.json`, `library-bruno/scenarioParser.js` |
| A1 | **Relocate** the Place Maps request from System Infos into the sale-flow folder | `01-System Infos Requests/03. GET Place Maps.yml` → `02-Common Requests/` (new name, see A3) |
| A2 | **Remove** it from System Infos (folder no longer advertises a transaction endpoint) | delete the old file |
| A3 | **Rewire the chain by explicit routing** (no renumber) | `02-Common Requests/01. POST Get Offer.yml`, the relocated Place Maps file |
| A4 | **Gate execution on all three layers** — Gate 0 capability AND Gate 1 selection (`salesFlow_placeSelection` / `requiresPlaceSelection`) decide *whether*; Gate 2 timing decides *when*. Stays inert by default. | `02-Common Requests/01. POST Get Offer.yml`, `opencollection.yml` |
| A4b | **Gate 2 — timing** — add per-scenario `placeSelectionTiming: PRE_BOOKING \| POST_BOOKING` (default `PRE_BOOKING`); only the PRE route is wired in Stage A | `json_validator/datafile.schema.json`, `library-bruno/scenarioParser.js`, `02-Common Requests/01. POST Get Offer.yml` |
| A5 | **Add Layer-1 compliance** for `PlaceAvailabilityResponse`, surfaced via `bruTest` | `library-bruno/osdmCompliance.js`, relocated Place Maps file |
| A6 | **Unit tests** for the new validator (+ parser tests for Gate 0/Gate 2) | `Oscar_Server/tests/unit/bruno-osdm-compliance.test.js`, `bruno-*` parser test |
| A7 | (deferred) **Layer-2 deep schema** — needs the schema bundle extended; see §3.6 | `library-bruno/osdmSchemas.js` |
| A8 | **Capability/offer mismatch assertion** — when Gate 0+1 ask for seat selection but the offer returns no `MANUAL_*` flow, emit a `bruTest` diagnostic (not a crash) | relocated Place Maps file / Get Offer |

### 3.2 Routing mechanic (no renumber — the agreed low-risk approach)

The sale flow already drives order with `bru.runner.setNextRequest("NN. Name")` + fall-through. We keep **all existing seq numbers** and control Place Maps purely by **explicit routing**, so its file `seq` is irrelevant to execution order. The route is decided by the combined gate `placeSelectionEnabled = systemCapabilities.seatSelection (Gate 0) AND salesFlow_placeSelection/requiresPlaceSelection (Gate 1)`:

- **When `placeSelectionEnabled` AND `placeSelectionTiming === PRE_BOOKING`** (future place-selection scenarios):
  - `01. POST Get Offer` (after-response) → `setNextRequest("<Place Maps>")`
  - `<Place Maps>` (after-response) → `setNextRequest("02. ... Create Booking")`
- **When `placeSelectionEnabled` AND `placeSelectionTiming === POST_BOOKING`** (Stage B, SNCF): Get Offer routes straight to Create Booking; the reservation is **added afterward** via `POST …/offer-parts` — *not* a deferred seat map (see §2.4 / §4).
- **When `placeSelectionEnabled` is false** (every current scenario — capability absent / `requiresPlaceSelection` unset):
  - `01. POST Get Offer` keeps its current behaviour: route straight to Create Booking + set `skipPlaceMaps=true`. Place Maps is never reached.

The `opencollection.yml` smart run filter remains the safety net: SALE scenarios skip `placeMap`; only a scenario that passes Gate 0 + Gate 1 lets it run.

### 3.3 Place-map request (unchanged contract)

`GET /availabilities/place-map?contextId={offerId}&contextType=OFFER&resourceId={reservationId}&resourceType=RESERVATION`
— `offerId`/`reservationId` are set by `offers.js` from the Get Offer response. Its outputs (`preselectedCoach` / `preselectedPlace` / `layoutId`) already feed `accommodationAndPlaceSelection()` in `requestsBuilder.js`, consumed by Create Booking's `before-request`. The existing defensive guard (no crash on empty body) is retained.

### 3.4 Compliance assertion (Layer 1)

Add `validatePlaceAvailability(body, endpoint)` to `osdmCompliance.js`, built on the existing `validateOsdmResource` style, asserting the spec shape:

- `PlaceAvailabilityResponse` = `{ warnings?, problems?[], vehicleAvailability? }`
- `vehicleAvailability` (`PlaceAvailability`) = `{ reference?, vehicle*, preSelections?[] }` — `vehicle` required when `vehicleAvailability` is present.
- `problems` must be an array when present (envelope rule, consistent with other validators).
- Convert the current raw extraction to `bruTest(...)` so results show in the report.

### 3.5 Tests

Extend `bruno-osdm-compliance.test.js` with fixtures: valid response, missing `vehicle`, empty/skip body, `problems` not-an-array. Keeps CI coverage thresholds satisfied and documents the contract.

### 3.6 Layer-2 (deep schema) — deferred within #104

The generated bundle `osdmSchemas.js` currently contains **System-Information components only** (`ApiVersion`, `CoachLayout`, `Product`, …). `PlaceAvailability` / `Vehicle` / `PlacePreSelection` are **not bundled**, and no generator script is committed (the header documents the transformation rules only). `osdmSchema.js` already degrades gracefully ("no bundled schema (skipped)"). 

**Proposal:** ship Layer 1 in #104; treat Layer-2 for place-maps as a small follow-up that (a) re-runs the documented generation to add the place components across v3.4–v3.8, then (b) adds the `validateSchema('PlaceAvailability', …)` call. This avoids hand-editing a generated file under time pressure.

### 3.7 Validation (after build)

Full sale-flow re-test per vendor (Get Offer → … → Fulfillments) to confirm **no regression** in existing scenarios (Place Maps must stay skipped). Live OPT-PLACE activation needs a real place-selection scenario + a supporting vendor — flagged as a prerequisite, not blocking the inert merge.

---

## 4. OPT-PLACE Stage B (post-booking = add-offer-part) — follow-up

**Not a deferred seat map** (OSDM has none — §2.4). For SNCF-style timing the reservation is **added to the booking after it exists**, via `POST /bookings/{bookingId}/booked-offers/{bookedOfferId}/offer-parts` (the legacy `…/reservations` endpoint is **deprecated**). The provider may accept or reject the addition. Selected via the per-scenario `placeSelectionTiming === POST_BOOKING` (only offered when the framework's `supportedTimings` includes it). Requires a real POST-booking scenario + vendor to validate. Compliance target: the response of the add-offer-part call (booked-offer reservation response), not `PlaceAvailabilityResponse`.

## 5. OPT-ANCILLARY — future sibling

Driven by `offer.ancillaryOfferParts[]`; selectable at offer time (via the booking) or added/removed post-booking via the same **add-offer-part** family (`POST …/offer-parts`, `DELETE …/ancillaries/{id}`). Add `validateAncillaryOfferPart`-style compliance. **Sqills** is the natural pilot (it returns selectable ancillaries). Tracked separately from #104.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Chain rewiring breaks the working sale flow | No renumber; only add explicit routing that is **bypassed** when `requiresPlaceSelection` is unset (every current scenario). Full per-vendor regression after. |
| Stale `setNextRequest` names (known fragility) | Reference requests by their **exact current names**; verify each route resolves (or falls through) before testing. |
| OneDrive sync corrupting files mid-edit | Close Bruno before edits/commits; data-file server rooted at `Bruno_Collection/`. |
| Layer-2 bundle hand-edit | Don't hand-edit the generated file; regenerate (separate follow-up). |
| No live place-selection scenario to validate activation | Merge as **inert** (zero regression); activation validated when a scenario + vendor exist. |

## 7. Scope of #104 (what I will actually implement now)

1. **Gate 0** — add `systemCapabilities` root block (schema + parser → env vars). Capability absent ⇒ module inert.
2. **Gate 2** — add `placeSelectionTiming` per scenario (schema + parser), default `PRE_BOOKING`; wire the PRE route only.
3. Relocate Place Maps into `02-Common Requests` + remove from System Infos.
4. Explicit routing in Get Offer + Place Maps, gated by Gate 0 + Gate 1 + Gate 2 (inert by default).
5. `validatePlaceAvailability` Layer-1 validator + `bruTest` wiring + unit tests (+ parser tests for the new fields).
6. Capability/offer mismatch diagnostic (§3.1 A8).
7. Per-vendor regression confirming existing flows are unchanged.

**Out of scope of #104 (tracked separately):** Layer-2 place-map schema (needs bundle regen), Stage B POST_BOOKING route, OPT-ANCILLARY.

---

## 8. Decisions (locked — review round, 2026-05-21)

1. **Gate 0 = extend the existing Test Framework config** (not a new block). ✅
2. **Tier-1 framework-config workstream first** (its own issue), then #104 (Bruno) consumes it. ✅
3. **Baseline OFF for the unimplemented options.** All current scenarios are set **OFF** for `placeSelection` / `addAncillary` / `deleteAncillary` (they aren't implemented yet), instead of the legacy all-ON backfill. `patchPassengers` (wired) / `getBooking` keep their historic behaviour. Plus add the **authoring constraint** (Gate 0 disables unsupported pills). ✅
   - *Implementation:* adjust `migrateLegacySalesFlowActions()` (OSCAR UI) and the `scenarioParser` default so the three optional keys default **false**, not true.
4. **Place-selection MODE, per scenario** (renamed from "timing" — `POST_BOOKING` was misleading; the second variant *adds a reservation to an existing booking*, it is not a deferred seat map). Values **`SEATMAP_AT_OFFER`** / **`ADD_TO_BOOKING`** + grandmother-test UX confirmed (§2.5). ✅
5. **Layer 1 first** in #104; Layer 2 (deep schema) is a follow-up after a bundle regen (§3.6). ✅
6. **OPT-ANCILLARY** — open its GitHub issue now (sibling of #104). ✅
