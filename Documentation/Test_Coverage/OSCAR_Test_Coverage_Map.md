# OSCAR Test Coverage Map

*Reference document — what OSCAR tests against an OSDM-conformant provider, as of release **2026.123** (server-v1.11.95 / collection OTST_V2.0.43, 2026-05-28).*

> **Two sections.** Section 1 enumerates the happy-flow coverage: every OSDM endpoint OSCAR exercises, the inputs OSCAR can vary per scenario, and the response checks fired in each after-response. Section 2 enumerates the non-happy-flow coverage: the negative-test framework — expired-X tests, requestedInformation probes, purchaser modes, IROPS overrules, vendor-gap markers, and other refusal-expecting assertions.
>
> **Every claim is cited** to its source file:line so a reviewer can verify directly. When a field exists in the data model but no test asserts against it today, this document says so explicitly rather than claiming coverage.
>
> **How to refresh this document.** Re-run the survey grep across `Bruno_Collection/02-Common Requests/*.yml`, `Bruno_Collection/03-Refund/*.yml`, `Bruno_Collection/04-Exchange/*.yml`, `Bruno_Collection/library-bruno/*.js`, and the wizard's `Oscar_Server/public/js/scenarios.js` after any significant change. Each header in this doc gives the file:line so an audit is a focused re-read, not a full re-scan.

---

# Section 1 — HAPPY FLOW COVERAGE

OSCAR is at server `v1.11.95` / collection `OTST_V2.0.43` / release `2026.123`. Coverage is split across 5 Bruno folders. Every endpoint targets `{{api_base}}` and is gated by an OAuth Bearer token + per-vendor `Requestor` header.

## Happy SALE path (ASCII flow)

```
                     ┌────────────────────────────────────────────────────────┐
                     │  Optional pre-flow: 01-System Infos Requests (00..10)  │
                     │  /versions, /coach-(deck-)layouts[/id],                │
                     │  /passenger-categories, /promotion-codes,              │
                     │  /reduction-cards, /zones, /products[/id],             │
                     │  /product-tags  — independent suite, no chaining       │
                     └────────────────────────────────────────────────────────┘

  01 POST /offers ─┬─[return scenario]─► 01b POST /offers (inward leg)
                   │                                              │
                   │       [SEATMAP_AT_OFFER place selection]     │
                   ├──► 08 GET /availabilities/place-map ─────┐   │
                   │     (contextType=OFFER)                  │   │
                   │                                          ▼   ▼
                   └──────────────────────────────────► 02 POST /bookings
                                                              │
   [ADD_TO_BOOKING gate]   ┌──────────────────────────────────┤
                           ▼                                  │
        08b GET /availabilities/place-map                     │
            (contextType=BOOKING)                             │
                           │                                  │
                           ▼                                  │
        09 POST /bookings/{id}/booked-offers/{id}/            │
              (offer-parts | reservations)                    │
                           │                                  │
                           ▼                                  │
   [salesFlow_addAncillary gate]                              │
        11 GET .../additional-offers                          │
                           │                                  │
                           ▼                                  │
        10 POST .../booked-offers/{id}/(offer-parts|          │
              ancillaries)                                    │
                           │                                  │
                           ▼                                  ▼
                   ┌──► 03 PATCH /bookings/{id}/passengers/{id}   ◄── default
                   │       (loops per passenger)                  ──┘ when
                   ▼       └─► 04 GET /bookings/{id}/passengers/{id}  no PATCH
   [skipPatchPassengerRequest]                                      configured
                           │
   [bookingPurchaserMode=deferred|invalid]
                           ├─► 12 GET /bookings/{id}/purchaser ─┬─► 13 PATCH (exists)
                           │                                     └─► 14 POST (absent)
                           ▼
                   05 GET /bookings/{id}
                           │
                           ▼
                   06 POST /bookings/{id}/fulfillments
                           │
                           ▼
                   07 GET /bookings/{id}
                           │
            ┌──────────────┼──────────────────────┐
            ▼              ▼                      ▼
   scenarioType =     scenarioType =      SALE complete →
   REFUND →           EXCHANGE →          loop or stop
   03-Refund/10..16   04-Exchange/10..17
```

REFUND scenarios branch from 07 → `03-Refund/10..16`; EXCHANGE scenarios branch from 07 → `04-Exchange/10..17`. The collection auto-loops back to `01. POST Get Offer` to start the next scenario in `scenariosToRun`.

**Mandatory SALE steps** (always fire on a Sale-type scenario): 01 → 02 → (03 or 04) → 05 → 06 → 07. That is 6 hops.

**Conditional / branch steps**:

| Step | When it fires |
|------|---------------|
| `01b` Return Offer | TripSearchCriteria carries `returnSearchParameters.inwardReturnDate` |
| `08` Place Maps (OFFER) | `salesFlow_placeSelection === "true"` AND `placeSelectionMode === "SEATMAP_AT_OFFER"` (or legacy `requiresPlaceSelection === true`) |
| `08b` Place Map Post-Booking | `salesFlow_placeSelection === "true"` AND (`placeSelectionMode === "ADD_TO_BOOKING"` OR offer-time map failed → `__placeMapAtOfferFailed`) |
| `09` Add Reservation | Same gate as 08b (add-reservation path) |
| `10` Add Ancillary | `salesFlow_addAncillary === "true"` AND the offer/booking carries addable ancillaries |
| `11` Add Ancillary — Additional Offers | Same gate as 10, fires first to discover bookable ancillaryOfferIds |
| `03` PATCH Passenger | `salesFlow_patchPassengers !== "false"` AND `skipPatchPassengerRequest !== "true"` (default ON) |
| `04` GET Passenger | When `03` skipped (only the GET runs); otherwise runs after `03` for the last passenger |
| `12 / 13 / 14` Booking Purchaser | `bookingPurchaserMode === "deferred"` or `"invalid"`; `13` PATCH used when `12` returns 2xx, else `14` POST |

---

## 1.1 — `00-Access Token`

One file per vendor (Benerail, Bileto, Chaps, Paxone, Sqills, Turnit). Each `POST` resolves to the vendor's OAuth token endpoint (e.g. `POST {{api-host}}/oauth/v2/token` for Sqills).

| Endpoint | File | Inputs OSCAR varies | Response checks |
|---|---|---|---|
| `POST {token URL}` | `Sqills Access Token.yml` (+ 5 vendor analogues) | `{{auth.key_secret}}`, `{{agent.username}}`, `{{agent.password}}` (vendor-shaped: Basic-auth header for some, JSON body for others) | `handleAccessTokenResponse(res, {vendor})` in `library-bruno/auth.js:28-82`: asserts HTTP 2xx, extracts token from any of `access_token` / `accessToken` / `token`, stores in `access_token` env var, registers passing assertion (token value never logged); on failure emits an actionable diagnostic citing the OAuth credentials, FAILS the assertion, clears stale token, and STOPS the run so the rest of the collection does not cascade into misleading 4xx |

**Step gating**: always — runs once at the start of each collection iteration.

---

## 1.2 — `01-System Infos Requests`

Independent suite that may run before SALE. Two-layer compliance: **Layer 1** (`osdmCompliance.js` — structural shape, required fields, types, enums) + **Layer 2** (`osdmSchema.js` → `validateSchema(<Component>, body, {endpoint})` — deep AJV-style schema match against the version-matched OSDM JSON Schema). A shared `handleSystemInfoStatus()` / `classifySystemInfoStatus()` classifier (`library-bruno/osdmCompliance.js`) decides what a non-200 means: a 404 on an endpoint introduced after the declared OSDM version → `out of scope` (skip, not fail); since OTST_V2.0.98 (#488/#489, OTST field review against SBB) a **not-implemented signal** — HTTP 501, an OSDM Problem body whose code is `OPERATION_NOT_PERMITTED`, or a bare 404 — → `[INFO] … not implemented by this provider` (skip); a bare 403/405/500 with no confirming body → the same skip at `[WARNING]` level, asking the provider to answer 404 or 501 with a Problem body (per RFC 9110 those codes mean authorization refused / method not allowed / server error — accepted on field evidence only); 401 → FAIL (a token problem, never an availability signal); 406 or any other status → FAIL unless baselined as a Known Deviation (#398/#430). The same classifier is reused by `02-Common Requests/04. GET Passenger`, `03-Refund/11. GET Refund Offer` and `04-Exchange/12. GET Exchange Offer`, and mirrored by the Report Builder's Vendor Capability Matrix (`Oscar_Server/src/reports/structureResults.js::classifyVendorCapability`, exact-request-name allowlist) so those same responses show `NOT_IMPLEMENTED` rather than `ERROR`.

| # | Endpoint | File | Inputs OSCAR varies | Response checks (Layer 1 + Layer 2) |
|---|---|---|---|---|
| 00 | `GET /versions` | `00. GET System Version Check.yml` | OSDM version negotiation parameter `{{osdmVersion}}` from scenario | `handleSystemInfoStatus`; `validateApiVersions` (`osdmCompliance.js:67-120`): response is array<ApiVersion>, ≥1 entry, every entry has required non-empty `version`, optional `sunset` is ISO date-time, optional `nextVersion` is object; consistency check: expected scenario version matches one of the returned versions (mismatch = WARN, not fail); `validateSchema("ApiVersion", …)` |
| 01 | `GET /coach-layouts` OR `GET /coach-deck-layouts` (≥3.8) | `01. GET Coach.yml` | resource auto-selected via `resolveEffectiveVersion()` + `atLeast('3.8.0')` | `handleSystemInfoStatus`; body non-empty; at least one coach/layout id found via `pickCoachIds`; `validateCoachLayouts` / `validateCoachDeckLayouts` (`osdmCompliance.js:408-426`): every item has `id` (string) + `gridSize` (object) [CoachLayout] OR `id`+`name`+`dimension`+`deckLevel` [CoachDeckLayout]; optional fields type-checked; `validateSchema("CoachLayout"/"CoachDeckLayout", …)` |
| 02 | `GET /coach-(deck-)layouts/{coachId}` | `02. GET Coach By Id.yml` | `{{coachId}}` (from env / random pick from 01 response) | Status classification (`200`/`401`/`403`/`404`/`5xx`); body present; `validateCoachLayout` / `validateCoachDeckLayout` (`osdmCompliance.js:428-446`): wrapped resource under `coachLayout`/`coachDeckLayout` key, required+optional fields typed; `validateSchema("CoachLayout"/"CoachDeckLayout", …)` |
| 04 | `GET /passenger-categories` | `04. GET Passenger Categories.yml` | – | `handleSystemInfoStatus` (3.6+ gate); `validatePassengerCategories` (`osdmCompliance.js:246-254`): bare array<PassengerCategory>, every item has `title` (Text object) + `specification` (object); `base`/`additional` booleans when present; `validateSchema("PassengerCategory", …)` |
| 05 | `GET /promotion-codes` | `05. GET Promotion Codes.yml` | – | `validatePromotionCodes` (`osdmCompliance.js:236-244`): envelope object with `promotionCodes[]`; every entry has required `code` (string); optional `issuer` (string); `validateSchema("PromotionCode", …)` |
| 06 | `GET /reduction-cards` | `06. GET Reduction Cards.yml` | – | `validateReductionCards` (`osdmCompliance.js:214-223`): `reductionCardTypes[]`; every entry has `code`+`issuer` (CompanyRef URN string) + `name` (Text object); optional `shortCode`/`cardIdRequired`; `validateSchema("ReductionCardType", …)` |
| 07 | `GET /zones` | `07. GET Zones.yml` | – | `validateZones` (`osdmCompliance.js:225-234`): `zones[]`; every entry has `id` + `carrier` (CompanyRef string); optional `name`/`nutsCodes`; `validateSchema("ZoneDefinition", …)` |
| 08 | `GET /products` | `08. GET Products.yml` | – | `validateProducts` (`osdmCompliance.js:371-379`): `products[]`; every entry has `id`+`code`+`owner`+`flexibility` (CompanyRef as string); optional `type`/`summary`/`description`/`serviceClass`/`travelClass`/`isTrainBound`/`isReturnProduct`/`tariff`/`productTags`; `validateSchema("Product", …)` |
| 09 | `GET /products/{productId}` | `09. GET Product By ProductId.yml` | `{{productId}}` | `validateProduct` (`osdmCompliance.js:381-389`): wrapped resource under `product` key, same required+optional set; `validateSchema("Product", …)` |
| 10 | `GET /product-tags` | `10. GET Product Tags.yml` | – | `validateProductTags` (`osdmCompliance.js:259-309`): non-standard dual-array `ProductTagsResponse`: required `productTagNames[]` (each with `tag` string + `description` Text object) + required `productTagGroups[]` (each with `code` string + `description` Text object); `validateSchema(…)` |

**Step gating**: each runs independently — no chaining inside this folder, no scenario gating.

---

## 1.3 — `02-Common Requests` (main SALE flow)

### `01. POST /offers` — `Bruno_Collection/02-Common Requests/01. POST Get Offer.yml`

**Inputs OSCAR varies** (driven by `scenarioParser.js` + `requestsBuilder.js::buildOfferCollectionRequest`):
- Trip type — `tripType: "SEARCH"` → `tripSearchCriteria` or `"SPECIFICATION"` → `tripSpecifications` (+ leg refs, board/alight spec, dated journey, vehicleNumber, operatorCode/carrier, productCategoryRef/Name/ShortName)
- For SEARCH: origin/destination `StopPlaceRef`, departure datetime (LocalDateTime, OffsetDateTime for Bileto exception), TripParameters with optional `CarrierFilter` + `VehicleFilter`
- For SPECIFICATION: per-leg `BoardSpecification` + `AlightSpecification` + `DatedJourney` (productCategory, vehicleNumbers[], NamedCompany)
- Return trip: `returnSearchParameters.inwardReturnDate` derived from outbound + `returnOffsetDays` + optional `returnTime` (HH:MM)
- `anonymousPassengerSpecifications[]`: per passenger `externalRef`, `type` (one of 21 OSDM PassengerTypes), `dateOfBirth`, optional `gender`
- `offerSearchCriteria`: `currency` (ISO-4217 3-char), `offerMode` (`INDIVIDUAL`/`COLLECTIVE`), `requestedOfferParts[]` (`RESERVATION`/`ADMISSION`/`ANCILLARY`/`FARE_*`/`CONTINUOUS_SERVICE`/`ALL`), `flexibilities[]` (`FULL_FLEXIBLE`/`SEMI_FLEXIBLE`/`NON_FLEXIBLE`), `serviceClassTypes[]` (`STANDARD`/`BEST`/`HIGH`/`BASIC`/`ANY_CLASS`), `travelClasses[]` (`FIRST`/`SECOND`/`ANY_CLASS`), `productTags[]`, `productSelections[]`
- `requestedFulfillmentOptions[]`: `fulfillmentMedia` (`PDF_A4`/`UIC_PDF`) + `fulfillmentType` (`ETICKET`)
- Auth: `Bearer {{access_token}}`, `Content-Type: application/json;version={{osdmVersion}}`, `Requestor` header (RICS URN)
- Paxone exception: `requestedFulfillmentOptions` omitted when empty (vs other vendors that pass `[]`)

**Response checks** (`library-bruno/offers.js::postOfferResponse`):
- HTTP 200 assertion; retry up to 3× when `offers[]` is empty before skipping to next scenario
- `checkWarningsAndProblems` — surfaces `warnings` + `problems[]` (RFC-9457 fields: code/type/title/status/detail/pointers)
- Per-offer: `offerId` non-empty string; `createdOn` valid ISO datetime; `passengerRefs[]` non-empty AND count matches requested passenger count
- `validateOfferSummary` — `minimalPrice.amount` is number ≥ 0; price has `currency` + `scale`; `overallFlexibility` ∈ {`FULL_FLEXIBLE`,`SEMI_FLEXIBLE`,`NON_FLEXIBLE`}; `overallServiceClass.type` ∈ {`BEST`,`HIGH`,`STANDARD`,`BASIC`,`ANY_CLASS`}; `overallTravelClass` string; `overallAccommodationType` ∈ {`SEAT`,`COUCHETTE`,`BERTH`,`VEHICLE`,`STORAGE`}; `preBookableUntil` valid date in the future; optional `minimalOriginalPrice` structure
- `validatePassengers` — `anonymousPassengerSpecifications[]` non-empty; per passenger `externalRef`+`type` (one of the 21 OSDM PassengerType enum values in `osdmEnums.js`); `dateOfBirth` in the past (when present); `appliedReductionCardTypes[]` is an array
- `validateOfferParts` — sums admission+reservation+(referenced)ancillary prices; asserts `minimalPrice ≥ Σpart prices`; A8 currency consistency: every part's `price.currency` matches `offerSummary.minimalPrice.currency`; `tripCoverage.coveredTripId` present when `tripCoverage` exists; `coveredLegIds[]` are strings; flexibility derivation from `products[]` (most restrictive wins, #223); processes `requestedInformation` on every part (auto-feed/probe)
- `validateTripsAndLegs` — `trips[]` non-empty; per trip `startTime < endTime` (A7); `direction` ∈ {`OUT_BOUND`,`IN_BOUND`}; per leg `vehicleNumber`+`stopPlaceName` start/end defined; `coveredTripId` exists in `trips[].id`
- `validateAdmissions` — per admission: business type NRT/IRT/TLT determination; `validFrom` valid; `validUntil` in the future; `price.{amount,currency,scale}` validity; `offerMode` ∈ {INDIVIDUAL,COLLECTIVE}; `appliedPassengerTypes[].type` ∈ OSDM_PASSENGER_TYPES + `passengerRef` string; `isReusable` boolean when present; `passengerRefs[]` non-empty; cross-linkage: every `reservationRefs[].id` resolves to a `reservationOfferParts[].id`; same for `ancillaryGroup.ancillaryRefs`; `afterSalesConditions[].condition` ∈ {`REFUND`,`EXCHANGE`,`PLACE_CHANGE`} with date+fee structure; FULL_FLEXIBLE/SEMI_FLEXIBLE: `refundable="YES"` for REFUND scenarios, `exchangeable="YES"` for EXCHANGE scenarios
- `validateReservations` — per reservation: price structure; `refundable`/`exchangeable` ∈ {YES,NO,WITH_CONDITION}; `offerMode` enum; `passengerRefs[]` non-empty; `availablePlaces[].accommodationType` ∈ {SEAT,COUCHETTE,BERTH,VEHICLE,STORAGE}, `numericAvailability` numeric, `tripLegCoverage.{tripId,legId}` strings; `numericAvailability` / `numberOfPrivateCompartments` numeric when present; ancillary linkage check; afterSalesConditions structure
- `validateAncillaries` — `type` string; afterSalesConditions structure as above
- `handleAccommodationAndPlaceSelection` — selects matching `reservationOfferParts` for accommodationType (SEAT/COUCHETTE/BERTH), captures `tripLegCoverage` + `reservationId`
- `ensureYesWhenRefundOrExchangeSelected` — REFUND scenarios assert every admission `refundable === "YES"`; EXCHANGE asserts `exchangeable === "YES"`
- `validateAncillaryOfferParts` (Layer-1 OSDM, `osdmCompliance.js:561-598`) — when ancillaries present: array<AncillaryOfferPart>, each requires non-empty `id` + string `type` (AncillaryType x-extensible-enum); optional `category` string
- Captures `offerCurrency` env var for downstream H3 cross-flow currency consistency; captures earliest `OfferPart.validUntil` → `offerValidUntil` env var (feeds expired-offer test)

**Step gating**: always (step 1). Auto-skips scenario after 3 empty-offer retries.

---

### `01b. POST /offers` (inward return leg) — `01b. POST Get Return Offer.yml`

**Inputs OSCAR varies** (`requestsBuilder.js::buildReturnOfferCollectionRequest`):
- Reuses outbound `tripSearchCriteria` but swaps `origin` ↔ `destination`, sets `departureTime = inwardReturnDate`
- Adds `returnSearchParameters.outwardOfferIds = [outboundOfferId]` (+ optional `outwardOfferTag`)
- Same `anonymousPassengerSpecifications` + `offerSearchCriteria` + `requestedFulfillmentOptions` as outbound

**Response checks**: same `postOfferResponse` pipeline as 01 (every validator listed above) plus captures `inboundOfferId`.

**Step gating**: scenarios whose outbound search produced an `inwardReturnDate` AND `__returnInboundDone !== "true"`.

---

### `02. POST /bookings` — `02. POST Create Booking.yml`

**Inputs OSCAR varies** (`requestsBuilder.js::buildBookingRequest` + `accommodationAndPlaceSelection`):
- `offers[]`: one entry per booked offer — `{offerId, passengerRefs[]}`; one-way → 1 entry; return → 2 entries (combined attempt) or 1 entry per separate-leg attempt; `placeSelections[]` on outbound when seat picks available
- `placeSelections[].{reservationId, tripLegCoverage:{tripId, legId}, accommodations:[{passengerRefs, accommodationType, accommodationSubType, placeProperties}], places:[{coachNumber, placeNumber, passengerRef}]}` (one place per passenger, OSDM strict `additionalProperties:false`)
- `passengerSpecifications[]`: full passenger detail (firstName, lastName, dateOfBirth, gender, email, phoneNumber via `detail.contact` in 3.4+ or flat `detail` in 3.0-3.3)
- `purchaser` (optional, gated by `bookingPurchaserMode`): inline mode → included; deferred/omit/invalid → omitted from this body
- `externalRef` ("00001"), omitted for Paxone

**Response checks** (`library-bruno/bookings.js::postCreateBookingResponse`):
- HTTP 200 assertion; loopback on failure
- Return-trip combined-booking trackable assertion `[OSDM] Vendor books a round trip (both offers) in a single booking` (passes when 200; FAILS with the `[OSDM] Vendor supports booking multiple offers (round trip) in one booking` trackable when vendor 400s "Only one offer can be booked at a time", then falls back to two separate bookings)
- `booking` object non-empty; `booking.id` non-empty string → stored as `bookingId`; `booking.bookingCode` non-empty string when present
- `booking.createdOn > selectedOffer.createdOn` temporal check
- B2/#204 confirmation-deadline resolution: tries `confirmationTimeLimit` → `confirmableUntil` (Bileto vendor-extension) → earliest of `bookedOffers[].{admissions|reservations|ancillaries}[].confirmableUntil` (Paxone-style); asserts a valid future datetime; stores `bookingConfirmationTimeLimit` env var; emits `[WARNING]` documenting which source was used
- `booking.requestedInformation` processed via `processRequestedInformation` (booking-level passenger channel + purchaser channel; auto-feed in happy path; emits `[WARNING] [P2]` if provider still requests a field OSCAR already provided at offer step)
- `booking.bookedOffers[]` non-empty array (B3, OSDM-required)
- Captures `firstBookedOffer.offerId` (or legacy `.id`) → `bookedOfferId` for post-booking add-* flows (issue #147)
- Lifecycle-scoped price member (#375, #496 — `bookings.js::isPostConfirmationStage`): at PREBOOKED/ON_HOLD stages `provisionalPrice` must exist with `{currency, scale}`; at CONFIRMED/FULFILLED/REFUNDED/EXCHANGED stages `confirmedPrice` must (OSDM Booking schema: `confirmedPrice` = "sum of all prices of confirmed parts minus the sum of all confirmed refund amounts", `provisionalPrice` = "price of all unconfirmed pre-booked parts"). The other member is optional at every stage. `provisionalPrice.currency === confirmedPrice.currency` when both are present (B4); H3 cross-flow: `booking.provisionalPrice.currency === offerCurrency` from step 01 (when present)
- `validateOfferParts` per part-type: every booked part `status` ∈ expected (PREBOOKED/ON_HOLD/AVAILABLE on create; FULFILLED/CONFIRMED later); B6 `status` ∈ OSDM `BookingPartStatus` enum (PREBOOKED, ON_HOLD, CONFIRMED, FULFILLED, CANCELLED, RELEASED, REFUNDED, EXCHANGE_ONGOING, EXCHANGED, ERROR); price intersection between offer and booking; `isReservationRequired`/`offerMode` equality; afterSalesConditions sub-validation; appliedPassengerTypes consistency (type-only, not passengerRef — booking uses internal UUID, offer uses externalRef); reduction-card-types match
- `validateFulfillments` (when applicable; full description under step 06)
- Passenger-count assertion: `booking.passengers.length === passengerCount` (env)
- C2: `booking.fulfillmentStatus` (v3.8) ∈ `FulfillmentSummaryStatus` {UNISSUED, PARTIALLY_ISSUED, ISSUED, PARTIALLY_USED, COMPLETELY_USED, REFUNDED, CANCELLED, EXPIRED}

**Step gating**: always (step 2). Routes next to `08b → 09` (ADD_TO_BOOKING), `11 → 10` (addAncillary), `03` (PATCH), `04` (GET), or `12` (purchaser), in that priority.

---

### `03. PATCH /bookings/{bookingId}/passengers/{passengerId}` — `03. PATCH Multi Passenger.yml`

**Inputs OSCAR varies**:
- One iteration per passenger in `passengerIdList`; body carries `{id, externalRef, dateOfBirth, type:"PERSON", gender, detail:{firstName, lastName, contact:{email, phoneNumber}}}`
- Variable fields: `patchDateOfBirth`, `patchFirstName`, `patchLastName`, `patchEmail`, `patchPhoneNumber`, `patchGender` sourced from scenario's `passengerAdditionalData[i]` (the `update*` keys)

**Response checks** (`library-bruno/passengers.js::patchMultiPassengerResponse`):
- HTTP 200; loopback on failure
- `jsonData.passenger` present
- Iterates per passenger; advances `currentPassengerIndex`

**Step gating**: `salesFlow_patchPassengers !== "false"` AND `skipPatchPassengerRequest !== "true"`. Skip routes to `04. GET Passenger` instead.

---

### `04. GET /bookings/{bookingId}/passengers/{passengerId}` — `04. GET Passenger.yml`

**Inputs OSCAR varies**: bookingId + passengerId path params.

**Response checks**: HTTP 200 — a non-200 is first matched against the company's Known Deviations, then against the shared not-implemented classifier (`classifySystemInfoStatus`, see §1.2: bare 403/404/405/500, 501 or an `OPERATION_NOT_PERMITTED` Problem body → passing `not implemented by this provider (auto-detected)` row, #488/#489), and only then FAILs; `jsonData.passenger` present; runs `patchMultiPassengerResponse` for the GET shape; loops per-passenger.

**Step gating**: terminal-when-PATCH-skipped OR final pass through (after PATCH loop) → `12. GET Booking Purchaser` (when `bookingPurchaserMode ∈ {deferred,invalid}`) OR `07. GET Booking before Fulfillments`.

Wait — the routing here is in `04` (`02-Common Requests/04. GET Passenger.yml:88-91`) which jumps to `07` (not `05`). The naming `07. GET Booking before Fulfillments` (in `05. GET Booking before Fulfillments.yml`) is a known historic mismatch — `bru.runner.setNextRequest("07. GET Booking before Fulfillments")` actually refers to the request whose `info.name` is `05. GET Booking before Fulfillments` (the file is `05.*` on disk). This is documented in the source.

---

### `05. GET /bookings/{bookingId}` (before fulfillments) — `05. GET Booking before Fulfillments.yml`

**Inputs OSCAR varies**: bookingId path param.

**Response checks**: HTTP 200; `postCreateBookingResponse` again with expected status `["PREBOOKED"]` + expected fulfillment status `["ON_HOLD","AVAILABLE"]` — re-runs every booking-level validator from step 02; `displayFulFilledBooking` for reporting.

**Step gating**: always (final pre-fulfillment check).

---

### `06. POST /bookings/{bookingId}/fulfillments` — `06. POST Obtaining Fulfillments from Booking.yml`

**Inputs OSCAR varies**: body is `{}` (no inputs); bookingId path param.

**Response checks** (`library-bruno/bookings.js::validateFulfillments`):
- HTTP 200 OR 202 assertion
- `fulfillments[]` non-empty; per fulfillment: `id`, `bookingRef` non-empty (D3: matches current `bookingId`); D4: `createdOn` valid datetime at or before now; `status` ∈ expected (CONFIRMED/FULFILLED) AND ∈ OSDM `FulfillmentStatus` enum {AVAILABLE, USED, PARTIALLY_USED, RESERVED, EXCHANGED, REFUNDED, RELEASED, CANCELLED, EXPIRED, ON_HOLD, CONFIRMED} (D1); `controlNumber` non-empty string when present; `bookingParts[].id` ∈ stored `admissionReservationAncillaryBookingPartsIds`
- `fulfillmentDocuments[]`: each doc has `medium`+`type`+`format` non-empty; payload via OSDM-standard `content` (base64 inline) OR `downloadLink` URI OR vendor `rawData` (vendor extension — flagged with WARNING per #202/#254)
- D2: `fulfillmentDocumentRefs[]` (v3.8) non-empty strings; #253 integrity: each ref resolves to a sibling `FulfillmentResponse.fulfillmentDocuments[].id`

**Step gating**: always (step 6); next is `07. GET Booking after Fulfillments`.

---

### `07. GET /bookings/{bookingId}` (after fulfillments) — `07. GET Booking after Fulfillments.yml`

**Inputs OSCAR varies**: bookingId path param.

**Response checks**: HTTP 200; `postCreateBookingResponse` re-run with expected status `["FULFILLED","CONFIRMED"]` for BOTH bookedOffers AND fulfillment status, AND `requireFulfillments=true` (#250 — provider MUST keep booking object updated with fulfillments after `POST /fulfillments`); branches to refund/exchange folders or loops.

**Step gating**: always (terminal of SALE). Routes: REFUND → `10. POST Refund Offers`; EXCHANGE → `10. POST Exchange Offers`; else loop or stop.

---

### `08. GET /availabilities/place-map?contextId={offerId}&contextType=OFFER&resourceId={reservationId}&resourceType=RESERVATION` — `08. GET Place Maps.yml`

**Inputs OSCAR varies**: `offerId` + `reservationId` (offer-context query).

**Response checks** (`osdmCompliance.js::validatePlaceAvailability`):
- HTTP 200; if not → trackable failing assertion `[OSDM] Vendor serves a pre-booking (OFFER-context) seat map` AND sets `__placeMapAtOfferFailed` so the SALE flow falls back to post-booking seat selection (#182)
- `PlaceAvailabilityResponse` envelope: `problems[]` array when present; `vehicleAvailability` object when present; `vehicleAvailability.vehicle` (required) object; optional `reference` object, `preSelections[]` array
- `collectAvailablePlaces(vehicle, paxCount)` — flattens coaches/decks/compartments, picks first N AVAILABLE places (defensive about `available` boolean / `availability`/`state`/`status` enums); stores `preselectedPlaces[]` + back-compat `preselectedCoach`/`preselectedPlace`/`layoutId`

**Step gating**: `placeSelectionMode === "SEATMAP_AT_OFFER"` AND `salesFlow_placeSelection === "true"` (OR legacy `requiresPlaceSelection === true`). Routes to `02. POST Create Booking`.

---

### `08b. GET /availabilities/place-map?contextId={bookingId}&contextType=BOOKING&resourceId={reservationId}&resourceType=RESERVATION` — `08b. GET Place Map Post-Booking.yml`

**Inputs OSCAR varies**: `bookingId` + `reservationId` (booking-context query).

**Response checks**: same `validatePlaceAvailability` Layer-1 + availability-aware seat picking via `collectAvailablePlaces`. On non-200 or missing `vehicleAvailability`: trackable failing assertion `[OSDM] Vendor serves a post-booking (BOOKING-context) seat map`. Sets `__postBookingPlaceMapDone`.

**Step gating**: `salesFlow_placeSelection === "true"` AND (`placeSelectionMode === "ADD_TO_BOOKING"` OR `__placeMapAtOfferFailed === "true"`). Routes to `09`.

---

### `09. POST /bookings/{bookingId}/booked-offers/{bookedOfferId}/(offer-parts|reservations)` — `09. POST Add Reservation to Booking.yml`

**Inputs OSCAR varies**:
- Version-aware resource: `offer-parts` for OSDM ≥ 3.7, deprecated `reservations` below 3.7 (`resolveEffectiveVersion()` + `atLeast('3.7.0')`)
- Body (>=3.7 `BookedOfferPartRequest`): `{offerId, passengerRefs[], placeSelections?:[{reservationId, tripLegCoverage:{tripId,legId}, places?:[{coachNumber,placeNumber,passengerRef}]}], ancillaryOfferIds?:[]}`
- Body (<3.7 `BookedOfferReservationRequest`): `{offerId, reservationOfferId, passengerRefs[], placeSelections:[]}`
- `placeSelections.places` populated from `08b` picks when seat map available; system auto-assigns otherwise

**Response checks** (`osdmCompliance.js::validateBookedOfferPartResponse`):
- HTTP 200
- Envelope: `BookedOfferPartResponse` object; `problems[]` array when present; `bookedOffers[]` array when present; when present, non-empty (the added part is returned)

**Step gating**: `salesFlow_placeSelection === "true"` AND `placeSelectionMode === "ADD_TO_BOOKING"` (OR `__placeMapAtOfferFailed`); `__addReservationDone !== "true"`. Routes to `11 → 10` (addAncillary), `03` or `04` (passengers).

---

### `10. POST /bookings/{bookingId}/booked-offers/{bookedOfferId}/(offer-parts|ancillaries)` — `10. POST Add Ancillary to Booking.yml`

**Inputs OSCAR varies**:
- Version-aware resource: `offer-parts` ≥ 3.7 (body uses `ancillaryOfferIds[]`) vs `ancillaries` (body uses single `ancillaryOfferId`)
- `offerId` priority: `addAncillaryParentOfferId` from step 11 → original `offerId`
- `ancillaryOfferIds[]` priority: step 11's `addAncillaryOfferIds` → admission-linked `referencedAncillaryIds` → selected offer's own `ancillaryOfferParts[].id`
- `passengerRefs[]`

**Response checks**: `validateBookedOfferPartResponse` (same envelope check as 09); HTTP 200; sets `__addAncillaryDone`.

**Step gating**: `salesFlow_addAncillary === "true"` AND `__addAncillaryDone !== "true"`. Routes to `03` or `04`.

---

### `11. GET /bookings/{bookingId}/booked-offers/{bookedOfferId}/additional-offers` — `11. Add Ancillary - Get Additional Offers.yml`

**Inputs OSCAR varies**: bookingId + bookedOfferId path params.

**Response checks**: HTTP 200 logged as INFO (non-200 = no addable ancillaries, not a failure — OSDM allows providers to refuse additional offers); picks first offer carrying `ancillaryOfferParts[]` → stores `addAncillaryParentOfferId` + `addAncillaryOfferIds[]` for step 10; captures earliest `ancillaryOfferParts[].validUntil` → `addAncillaryOfferValidUntil` env (feeds Phase 5b expired test).

**Step gating**: `salesFlow_addAncillary === "true"`. Always precedes `10`.

---

### `12. GET /bookings/{bookingId}/purchaser` — `12. GET Booking Purchaser.yml`

**Inputs OSCAR varies**: bookingId path param.

**Response checks**: GET-adaptive upsert decision — `2xx` → purchaser exists → route to `13 PATCH`; non-2xx → no purchaser → route to `14 POST`. Sets `__purchaserWriteMethod`.

**Step gating**: `bookingPurchaserMode ∈ {deferred, invalid}` AND `__purchaserStepDone !== "true"`.

---

### `13. PATCH /bookings/{bookingId}/purchaser` — `13. PATCH Booking Purchaser.yml`

**Inputs OSCAR varies** (`requestsBuilder.js::buildBookingPurchaserBody`):
- Base: `bookingPurchaserSpecifications` (PurchaserContact in 3.4+ / Purchaser in 3.0-3.3)
- Overlay: `purchaserAdditionalData` `update*` overrides (`updateFirstName/Last/Email/PhoneNumber/Gender/DateOfBirth`); empty string clears the field
- Invalid-mode sweep: corrupts one of `[firstName, lastName, email, phoneNumber]` per pass — email→`not-an-email`, phoneNumber→`not-a-phone`, firstName/lastName→OMITTED (required)

**Response checks**: HTTP 2xx; `body.purchaser` present (`PurchaserResponse` envelope).

**Step gating**: chosen by `12` (path branch). Routes to `05. GET Booking before Fulfillments`.

---

### `14. POST /bookings/{bookingId}/purchaser` — `14. POST Booking Purchaser.yml`

Same body assembly as `13`; same `PurchaserResponse` envelope check; routes to `05`.

**Step gating**: chosen by `12` (path branch when no purchaser existed).

---

## 1.4 — `03-Refund` (after-sales REFUND)

Branched from step 07 when `scenarioType` contains `REFUND`.

| # | Endpoint | File | Inputs OSCAR varies | Response checks |
|---|---|---|---|---|
| 10 | `POST /bookings/{bookingId}/refund-offers` | `10. POST Refund Offers.yml` | `requestRefundOffersBody(overruleCode, refundDate)` → `{fulfillmentIds[], overruleCode?, refundDate?}` | HTTP 200; retry up to 3× on empty `refundOffers[]`; `postPatchRefundOfferResponse(jsonData, ["PROPOSED"], ["CONFIRMED","FULFILLED"])` (`refunds.js:22-74`): each offer's `id` string; `status === "PROPOSED"`; dates (createdOn past, validFrom valid, validUntil ~15min future ±2min tolerance, E1 validFrom ≤ validUntil); `appliedOverruleCode === overruleCode`; `refundableAmount.{amount,currency,scale}`; `refundFee.{amount,currency,scale}` ≥ 0; fulfillments[] non-empty (E3 OSDM minItems:1); optional `reimbursementStatus` ∈ {IMMEDIATE, DELAYED}; `refundOfferBreakDown[]` per-entry validation (refundFee + refundableAmount + bookingParts[] non-empty + fulfillmentId); fulfillments sub-validation; captures `refundOfferValidUntil` for Phase-3 expired test |
| 11 | `GET /bookings/{bookingId}/refund-offers/{refundOffersOfferId}` | `11. GET Refund Offer.yml` | refund-offer id | Non-200: Known Deviation → shared not-implemented classifier (`classifySystemInfoStatus`, #488/#489: bare 403/404/405/500, 501 or an `OPERATION_NOT_PERMITTED` Problem body → passing `not implemented by this provider (auto-detected)` row) → FAIL; on 200 the same `postPatchRefundOfferResponse` pipeline expecting `["PROPOSED"]` |
| 12 | `GET /bookings/{bookingId}?embed=ALL` | `12. GET Booking before Patch Refund.yml` | – | `postCreateBookingResponse` re-validation at stage `["FULFILLED","CONFIRMED"]` → asserts `confirmedPrice`; stores `confirmedPriceAmount` for the E2 refund identity |
| 13 | `PATCH /bookings/{bookingId}/refund-offers/{refundOffersOfferId}` body `{"status":"CONFIRMED"}` | `13. PATCH Refund Offer.yml` | Fixed `{"status":"CONFIRMED"}` body | HTTP 200; `postPatchRefundOfferResponse(…,["CONFIRMED"],["REFUNDED"])`; E2 financial identity (integer arithmetic, scale-aware): `refundFee + refundableAmount === confirmedPrice` when overruleCode valid; refundable=0 when overruleCode null or `CODE_DOES_NOT_EXIST` |
| 14 | `GET /bookings/{bookingId}?embed=ALL` | `14. GET Booking after Patch Refund.yml` | – | Re-runs booking validation at stage `["REFUNDED"]` → asserts `confirmedPrice` (NOT `provisionalPrice`, #496 — OSDM: confirmed parts minus confirmed refund amounts); logs `[INFO] confirmedPrice at stage REFUNDED: <after> — was <before>` (not asserted; open OTST point in #496 on whether providers actually reduce it) |
| 15 | `DELETE /bookings/{bookingId}/refund-offers/{refundOffersOfferId}` body `{}` | `15. DEL Refund Offer.yml` | – | If `isRefundConfirmed === true`: status === 404 (refund cannot be deleted after confirmation); else expects success |
| 16 | `GET /bookings/{bookingId}?embed=ALL` | `16. GET Booking after Delete Refund.yml` | – | `getBookingRefundResponse(response, "deleteRefund")` (`refunds.js:401-420`): `booking.refundOffers[]` is empty array; E4 after confirmed refund: every booked part's `status` ∈ {`REFUNDED`,`FULFILLED`} |

**Step gating**: all REFUND-folder steps fire sequentially when 07 routed to 10.

---

## 1.5 — `04-Exchange` (after-sales EXCHANGE)

Branched from step 07 when `scenarioType` contains `EXCHANGE`.

| # | Endpoint | File | Inputs OSCAR varies | Response checks |
|---|---|---|---|---|
| 10 | `POST /bookings/{bookingId}/exchange-offers?embed=ALL` | `10. POST Exchange Offers.yml` | `requestExchangeOffersBody(overruleCode)` → `{fulfillmentIds[], tripSearchCriteria, offerSearchCriteria, anonymousPassengerSpecifications[] (one per passenger, with gender/dateOfBirth from `update*`), overruleCode?}` | HTTP 200; retry up to 3× on empty; `postPatchExchangeOffersResponse(jsonData, ["CONFIRMED","FULFILLED"])` (`exchanges.js:21-58`): `exchangeOffers[]` non-empty; per offer `validateExchangeOfferResponse` — `offerId` string; F2 `preBookableUntil` valid future datetime; F4 `admissionOfferParts[]` non-empty; required `offerSummary`+`exchangeFee`+`exchangePrice`; `offerSummary.{overallFlexibility,minimalPrice.amount}` types; F1 financial identity: `amountToBePaid === exchangePrice + exchangeFee - confirmedPrice` (integer arithmetic); `appliedOverruleCode` match; fee/after-sales consistency; optional `refundableAmount.amount` numeric; captures `exchangeOffersOfferId` + `exchangeOfferPreBookableUntil` (Phase 4 expired test) |
| 11 | `POST /bookings/{bookingId}/exchange-operations` | `11. POST Exchange Operations.yml` | `requestExchangeOperationsBody()` → `{exchangeOffers:[{offerId, passengerRefs[]}]}` | HTTP 200; `postPatchExchangeOperationsResponse(…,["PREBOOKED"],["CONFIRMED","FULFILLED"])` (`exchanges.js:61-106`): `exchangeOperation.id` non-empty string; `status === "PREBOOKED"`; `exchangeOffers[]` non-empty; each offer re-validated; captures `exchangeOperationId` |
| 12 | `GET /bookings/{bookingId}/exchange-operations/{exchangeOperationId}` | `12. GET Exchange Offer.yml` | exchangeOperationId path | Non-200: Known Deviation → shared not-implemented classifier (#488/#489, as for `11. GET Refund Offer`) → FAIL; on 200 `postPatchExchangeOperationsResponse(…)` re-validation; also captures admission/reservation/ancillary part IDs |
| 13 | `GET /bookings/{bookingId}?embed=ALL` | `13. GET Booking before Fulfillment.yml` | – | Booking re-validation at stage `["EXCHANGE_ONGOING"]` → asserts `provisionalPrice` (the exchange operation creates new pre-booked parts, which OSDM says `provisionalPrice` includes) |
| 14 | `POST /bookings/{bookingId}/fulfillments` | `14. POST Obtaining Fulfillments from Booking.yml` | body `{}` | HTTP 200/202; `validateFulfillments` (same D1-D4 + #253 ref→id integrity as 02-Common step 06) |
| 15 | `GET /bookings/{bookingId}?embed=ALL` | `15. GET Booking after Fulfillment.yml` | – | Booking re-validation at stage `["EXCHANGED"]` → asserts `confirmedPrice` (#496, same principle as the REFUNDED stage) |
| 16 | `DELETE /bookings/{bookingId}/exchange-operations/{exchangeOperationId}` | `16. DEL Exchange Offer.yml` | – | Delete-operation response check |
| 17 | `GET /bookings/{bookingId}?embed=ALL` | `17. GET Booking after Fulfillment.yml` | – | Final booking validation at stage `["FULFILLED","CONFIRMED"]` → asserts `confirmedPrice` |

**Step gating**: all EXCHANGE-folder steps fire sequentially when 07 routed.

---

# Section 2 — NON HAPPY FLOW COVERAGE

This catalogues every test OSCAR can fire that EXPECTS the provider to REJECT the request.

## 2.1 — Expired-X negative tests (6-timer family, PR A + PR B)

Source of truth: `Bruno_Collection/library-bruno/expiredFlow.js:218-257` (`EXPIRED_FLOW_TIMERS_DEF`). All six follow the same plan-wait-grade pattern (`planExpiredFlow` → `runExpiredFlowWait` → `gradeExpiredFlowResponse`, in `expiredFlow.js:51-165`). Buffer: 15 s past deadline; post-margin: 45 s; budget priority: per-scenario `maxWaitMinutes` (1-60) → server `RUN_TIMEOUT_MS` → conservative 8-min fallback.

| # | Scenario field | 3-letter code | Deadline field watched | Request that fires after wait | Asserted | Gating |
|---|---|---|---|---|---|---|
| 1 | `expiredOfferTest` + `expiredOfferMaxWaitMinutes` | **OTO** | Earliest of `selectedOffer.{admission,reservation,ancillary,fareAdmission,fareReservation,fareAncillary}OfferParts[].validUntil` → `offerValidUntil` (`offers.js:233-263`) | `POST /bookings` (`02-Common/02. POST Create Booking.yml:36-55`) | 4xx + RFC-9457 Problem (`title`/`detail`/`code` present); auth-failure WARN distinction; `[NHF_OTO_<scenario>] Expired offer: POST /bookings is rejected with a client error (4xx)` and `error body is an RFC-9457 Problem` | Any (gate returns `true`) |
| 2 | `expiredBookingTest` + `expiredBookingMaxWaitMinutes` | **BTO** | `booking.confirmationTimeLimit` → `booking.confirmableUntil` → earliest `bookedOffers[].{admissions,reservations,ancillaries}[].confirmableUntil` (`bookings.js:330-396`) | `POST /bookings/{id}/fulfillments` (`02-Common/06. POST Obtaining Fulfillments from Booking.yml:37-59`) | 4xx + RFC-9457 Problem; auth WARN; AND `[NHF_BTO_…] Expired booking: admissions/reservations are EXPIRED/RELEASED/CANCELLED after the deadline` on the post-rejection GET (404 acceptable: provider purged the booking) | Any |
| 3 | `expiredAddReservationOfferTest` + `expiredAddReservationOfferMaxWaitMinutes` | **ARO** | Specific `selectedOffer.reservationOfferParts[id=reservationId].validUntil` → `addReservationOfferValidUntil` (`offers.js:283-299`) | `POST /bookings/{id}/booked-offers/{id}/(offer-parts|reservations)` (`02-Common/09. POST Add Reservation to Booking.yml:91-110`) | 4xx + RFC-9457 Problem; auth WARN | `salesFlow_placeSelection === "true"` AND `placeSelectionMode === "ADD_TO_BOOKING"` |
| 4 | `expiredAddAncillaryOfferTest` + `expiredAddAncillaryOfferMaxWaitMinutes` | **ATO** | Earliest of: additional-offers ancillary parts (`11.yml`) PRIMARY → selected offer's `ancillaryOfferParts[].validUntil` matching `addAncillaryOfferIds` (FALLBACK in `10.yml:82-127`) | `POST /bookings/{id}/booked-offers/{id}/(offer-parts|ancillaries)` (`02-Common/10. POST Add Ancillary to Booking.yml:82-127`) | 4xx + RFC-9457 Problem; auth WARN | `salesFlow_addAncillary === "true"` |
| 5 | `expiredRefundOfferTest` + `expiredRefundOfferMaxWaitMinutes` | **RTO** | `refundOffers[0].validUntil` from `POST /refund-offers` → `refundOfferValidUntil` (`refunds.js:55-73`) | `PATCH /bookings/{id}/refund-offers/{id}` body `{status:"CONFIRMED"}` (`03-Refund/13. PATCH Refund Offer.yml:35-54`) | 4xx + RFC-9457 Problem; auth WARN | `scenarioType === "REFUND"` |
| 6 | `expiredExchangeOfferTest` + `expiredExchangeOfferMaxWaitMinutes` | **ETO** | `exchangeOffers[0].preBookableUntil` (spec field name — NOT `validUntil`; OSDM_Spec_Deviations #25 inconsistency) → `exchangeOfferPreBookableUntil` (`exchanges.js:44-57`) | `POST /bookings/{id}/exchange-operations` (`04-Exchange/11. POST Exchange Operations.yml:39-58`) | 4xx + RFC-9457 Problem; auth WARN | `scenarioType === "EXCHANGE"` |

**Skip semantics**: each timer skips with `[WARNING]` (not a fail) when (a) the provider exposes no deadline, (b) the deadline string is malformed, OR (c) the wait would exceed the run budget (with an actionable hint: raise `maxWaitMinutes` to ≥ N min). For `BTO` only, the source-resolution log additionally records WHICH of the three deadline fields was used.

**Auto-expansion (PR B)**: when 2+ timers are armed on a single scenario, OSCAR auto-expands into N sub-runs of the same scenario, one per armed timer (`expiredFlow.js:259-313` `buildAndArmExpiredFlowQueue` + `advanceExpiredFlowQueueOrFinish:329-362`). Queue order is fixed: OTO → BTO → ARO → ATO → RTO → ETO. Gated-off timers (e.g. ARO without `placeSelectionMode=ADD_TO_BOOKING`) are dropped with `[WARNING]` per `EXPIRED_FLOW_TIMERS_DEF.gateReason`. Sub-run assertions are tagged `[NHF_<code>_<scenario>] …` (`nhfTestPrefix()` in `expiredFlow.js:374-384`); single-timer scenarios get no prefix to preserve legacy assertion names. Each sub-run forces an OAuth token refresh after the wait (`runExpiredFlowWait` `force:true`) so a long sleep doesn't expire the token and confuse the rejection grade.

---

## 2.2 — RequestedInformation negative probes (`requestedInformationProbe`)

Source: `library-bruno/requestedInformation.js:778-829` (`validateProblemResponse`), `02-Common Requests/03. PATCH Multi Passenger.yml:47-148`.

**Field values**: `off` (default — auto-feed every demanded field; happy path) / `omit` (clear required fields) / `invalid` (per-field sweep — one corrupted field per pass).

**`omit` mode**: every demanded mappable passenger field is cleared in `passengerAdditionalData` (entry[updateKey]=""), so the PATCH submits with missing data. After-response in `03. PATCH Multi Passenger.yml:153-168` runs `validateProblemResponse` expecting 4xx + Problem body.

**`invalid` mode**: SWEEP `["gender","dateOfBirth","firstName","lastName","email","phoneNumber"]` on passenger 0 — each pass corrupts exactly ONE field while keeping the rest valid (`03.yml:50-86`). Invalid values from `invalidValueForField` (`requestedInformation.js:554-562`): `gender→"ZZZ"`, `email→"not-an-email"`, `phoneNumber→"not-a-phone"`, `dateOfBirth→"not-a-date"`; firstName/lastName have no clear invalid form → OMITTED. The flow loops back to `03. PATCH` for the next field; final pass exits via `setNextRequest(null)`.

**Endpoints surfacing the probe**:
- Passenger channel: `PATCH /bookings/{id}/passengers/{id}` (steps 03 and the post-fulfillment chain)
- Purchaser channel: `PATCH /bookings/{id}/purchaser` (13) AND `POST /bookings/{id}/purchaser` (14) — same per-field sweep on `[firstName, lastName, email, phoneNumber]` (`requestsBuilder.js::buildBookingPurchaserBody:216-247`)

**N-assertions from `validateProblemResponse`** (`requestedInformation.js:778-829`):
- **N1**: provider rejects with a client error (4xx) — graded HARD when targets include an `omit` OR an `invalid` on a STRINGENT field (`gender`/`dateOfBirth`), SOFT (WARN-only) when only LENIENT (`email`/`phone`/`firstName`/`lastName`) invalids
- **N2**: error body is an RFC-9457 Problem (`title`/`detail`/`code` present) — same severity grading
- **N3**: error identifies the offending field via `Problem.pointers[]` OR by naming the field in body — always WARN (Problem.pointers optional in OSDM 3.1)

**Provider-fair grading per field stringency** (`STRINGENT_FIELDS` set, `requestedInformation.js:757`):
- `OMIT` always hard FAIL (required field missing → MUST reject per OSDM)
- `INVALID on STRINGENT` (`gender`, `dateOfBirth`) hard FAIL (OSDM enum/format → MUST reject)
- `INVALID on LENIENT` (`email`, `phoneNumber`, `firstName`, `lastName`) WARN-only (OSDM defines as unconstrained string — no format/pattern, so rejecting is RECOMMENDED, not required)

Static conformance assertions on the requestedInformation EXPRESSION itself (`requestedInformation.js::staticIssues:443-463`) — fire on every offer/booking response regardless of probe:
- **S1**: `requestedInformation` is a valid OSDM type (string, ≤32768 chars) — FAIL
- **S2**: parses against the OSDM grammar — FAIL
- **S3**: references attribute(s) OSCAR recognises — WARN (allow-list may be incomplete)
- **S4**: passenger indices are in range (`index < passengerCount`) — FAIL
- **P2**: provider should not still request a field OSCAR already provided at offer step — WARN (`bookings.js:464-473`)

---

## 2.3 — Purchaser-at-booking modes (`bookingPurchaserMode`)

Source: `library-bruno/requestsBuilder.js:117-251`, `02-Common Requests/12. GET Booking Purchaser.yml`, `13.yml`, `14.yml`.

**Field values**: `inline` (default — purchaser sent inside `POST /bookings` body, historic behaviour) / `deferred` (omit at booking, supply afterwards via POST or PATCH — exercises any purchaser `requestedInformation`) / `omit` (never supply — negative test of provider that may need it for confirmation) / `invalid` (omit at booking, then POST/PATCH a sweep of clearly-invalid purchasers).

**What each mode tests**:
- `inline` — happy path: provider accepts purchaser at booking time
- `deferred` — happy path with deferred supply: provider accepts a booking without purchaser AND accepts a later POST/PATCH
- `omit` — provider behaviour when purchaser is never supplied (some providers may need it for fulfillment confirmation; others not)
- `invalid` — negative sweep on `[firstName, lastName, email, phoneNumber]`; one field corrupted per pass; loops back through `12 → 13|14` per field

**Endpoints involved**:
- `POST /bookings` (purchaser key present or absent based on mode)
- `GET /bookings/{id}/purchaser` (step 12 — adaptive probe)
- `PATCH /bookings/{id}/purchaser` (step 13 — selected when 12 returned 2xx)
- `POST /bookings/{id}/purchaser` (step 14 — selected when 12 returned non-2xx)

**GET-adaptive upsert** (`12.yml:24-48`): `GET /bookings/{id}/purchaser` → if 2xx (purchaser materialised by provider after a purchaser-less booking) → PATCH; if non-2xx → POST. Sets `__purchaserWriteMethod`.

---

## 2.4 — IROPS / overrule codes (`overruleCode`)

Source: `scenarioParser.js:564`, `refunds.js::validateRefundAppliedOverruleCode:305-317`, `exchanges.js::validateExchangeAppliedOverruleCode:305-316`.

**Refund context**: `refundFee + refundableAmount = confirmedPrice` (E2 financial identity) is asserted ONLY when `overruleCode` is non-null AND not `CODE_DOES_NOT_EXIST`; when null/CODE_DOES_NOT_EXIST → `refundableAmount.amount === 0` is asserted (provider correctly refused). `appliedOverruleCode` in the response must equal the sent `overruleCode` (or be null when none was sent).

**Exchange context**: `exchangeOffer.appliedOverruleCode === overruleCode`; AND `exchangeFee === Σ afterSalesConditions[].afterSaleFee.amount` from all offer parts.

**Codes the wizard exposes** (via the `overruleCode` scenario string — any value the tester wants; the codebase asserts equality of `appliedOverruleCode` rather than membership in a fixed set): commonly `PAYMENT_FAILURE`, `DISRUPTION`, `CODE_DOES_NOT_EXIST` (test case for refusal), plus vendor-specific codes. There is no compile-time enum constraint in OSCAR — the wizard accepts any string, the provider grades it.

**What's asserted**:
- `appliedOverruleCode === expected` (null when none sent)
- Financial-identity preservation (refund) / fee-consistency (exchange) gated on the code being valid

---

## 2.5 — Vendor-gap "trackable failing assertions"

These are deliberately FAILING assertions that surface vendor non-conformance without halting the run — they show up red in the report and are easy to track across runs.

| Trackable assertion | Where it fires | What it signals |
|---|---|---|
| `[OSDM] Vendor serves a pre-booking (OFFER-context) seat map` | `02-Common/08. GET Place Maps.yml:88-90` — when status ≠ 200 OR no `vehicleAvailability` returned for `contextType=OFFER` and `salesFlow_placeSelection === "true"` | Provider holds seats only against a BOOKING (e.g. Bileto) and exposes no offer-time seat map; OSCAR sets `__placeMapAtOfferFailed` and falls back to post-booking (`08b → 09`) — "pre-book, then pick the seat" |
| `[OSDM] Vendor serves a post-booking (BOOKING-context) seat map` | `02-Common/08b. GET Place Map Post-Booking.yml:66-71` — when status ≠ 200 OR no `vehicleAvailability` for `contextType=BOOKING` | Provider serves no booking-context map either; OSCAR proceeds to `09. POST Add Reservation` letting the system auto-assign places. Both failures together = vendor has no seat-map endpoint at all |
| `[OSDM] Vendor supports booking multiple offers (round trip) in one booking` | `02-Common/02. POST Create Booking.yml:124-128` — when a combined return booking is rejected with 400 + body containing "too many offers" / "one offer" / "multiple offer" | Provider does not support OSDM-permitted combined round-trip bookings; OSCAR falls back to two separate bookings (`__returnBookMode = "sep-out" → "sep-in"`). Title example: Bileto's "Only one offer can be booked at a time, for now" |

---

## 2.6 — Other negative checks

Sweep of `library-bruno/*.js` and `*.yml` for `test(` blocks that expect failure or assert refusal:

| Check | Where | Asserts |
|---|---|---|
| Authentication failure | `library-bruno/auth.js::handleAccessTokenResponse:28-82` (every Access Token .yml) | On non-2xx OR missing token: FAILS assertion with actionable diagnostic naming OAuth credentials as the likely cause, clears stale token, and STOPS the run so the dead token doesn't cascade. |
| Bearer rejection on downstream requests | `library-bruno/auth.js::checkAuthRejection` (called from collection-level after-response) | First 401/403 on any post-auth request → clear message + failing assertion + run stop (covers static tokens that are present but EXPIRED/REVOKED) |
| Refund DELETE after confirmation | `03-Refund/15. DEL Refund Offer.yml:28-32` | When `isRefundConfirmed === true`: status MUST be 404 (confirmed refund cannot be deleted) — asserts `res.getStatus() === 404`; provider returning anything else FAILS |
| Empty-offers retry-then-skip | `02-Common/01. POST Get Offer.yml:100-126`, `03-Refund/10. POST Refund Offers.yml:71-111`, `04-Exchange/10. POST Exchange Offers.yml:71-95` | After 3 empty-response retries, registers a failing `Offers found in response` (or refund/exchange-offer) assertion and SKIPS to the next scenario in the loop — surfaces "vendor returned no offer" as a tracked failure without blocking the run |
| Missing booking object | `library-bruno/bookings.js::postCreateBookingResponse:280-284` | Throws on `booking` missing or not an object — surfaces as a thrown error that bubbles into the run report |
| Missing fulfillment after POST /fulfillments | `library-bruno/bookings.js::validateFulfillments:584-597` (#250) | When `requireFulfillments=true` (step 07): asserts booking embeds the generated fulfillments — empty array FAILS `Booking embeds the generated fulfillments after fulfillment (OSDM: booking must be kept updated)` |
| Loopback-or-stop on every non-200 | Every step .yml after-response (e.g. `02. POST Create Booking.yml:134`, `03. PATCH.yml:178`, `06. POST .../fulfillments.yml:96`) calls `loopbackOrStop(label)` | Failing status is registered as a failing `Status code is 200` assertion AND triggers loop-back to next scenario (or stop) so the run does not pivot into garbage |
| Out-of-range passenger index in `requestedInformation` (S4) | `library-bruno/requestedInformation.js::processRequestedInformation` (fired on every offer/booking response with RI) | `requestedInformation` referencing `passengerSpecifications[k]` where `k ≥ passengerCount` FAILS `requestedInformation passenger indices are in range` |
| Grammar parse failure on `requestedInformation` (S2) | `requestedInformation.js::summariseRequestedInformation` | FAILS `requestedInformation parses against the OSDM grammar` |
| Status classification for System-Information + the optional GETs (Passenger / Refund Offer / Exchange Offer) | `osdmCompliance.js::classifySystemInfoStatus` (`01-System Infos Requests/*`, `04. GET Passenger`, `11. GET Refund Offer`, `12. GET Exchange Offer`) | 401 → FAILING `GET <endpoint> → 401 Unauthorized`; 404 on an endpoint newer than the declared OSDM version → out-of-scope skip; 501 / `OPERATION_NOT_PERMITTED` Problem body / bare 404 → `[INFO]` skip `not implemented by this provider`; bare 403/405/500 → `[WARNING]` skip (provider asked to answer 404/501, per RFC 9110); 406 and anything else → FAILING `unexpected status <n>` unless baselined as a Known Deviation (#488/#489, standards check 2026-09-03) |
| Missing/invalid required OSDM field across collections | `osdmCompliance.js::validateOsdmCollection/Resource` (every System-Info validator) | Per-field FAILS, e.g. "Entries with missing/invalid 'version': index 0,2"; "Missing/invalid required 'gridSize'" etc. |
| Stage-scoped price member missing on booking | `library-bruno/bookings.js::isPostConfirmationStage` + the price block in `postCreateBookingResponse` | `provisionalPrice missing` at PREBOOKED/ON_HOLD stages; `confirmedPrice missing` at CONFIRMED/FULFILLED/REFUNDED/EXCHANGED stages (#375, #496) |
| Currency mismatch (B4 + H3) | `bookings.js:521-535` | FAILS when `provisional.currency ≠ confirmed.currency` OR `booking.currency ≠ offer.currency` |
| Fulfillment status not in OSDM enum (D1) / Booking part status not in enum (B6) / Fulfillment summary status not in OSDM v3.8 enum (C2) | `bookings.js:259-264, 658-664, 571-578` | FAILS when status ∉ enum |
| Fulfillment document ref → id integrity (#253) | `bookings.js:732-758` (`validateFulfillments`) | FAILS when a `fulfillmentDocumentRefs[]` value does not resolve to a sibling `fulfillmentDocuments[].id` (v3.8 only; legacy nested form skipped) |
| Exchange financial identity (F1) / Refund financial identity (E2) | `exchanges.js:167-179`, `refunds.js:291-301` | Integer-arithmetic identity check FAILS when broken |
| Multi-passenger collapse via `appliedReductionCardTypes` | `library-bruno/bookings.js:208-228` | Reduction-card array mismatch FAILS |

---

**Key source citations** (for reader verification):
- Datafile schema: `Bruno_Collection/json_validator/datafile.schema.json` (534 lines — every scenario knob the tester can turn)
- Scenario parser: `Bruno_Collection/library-bruno/scenarioParser.js:60-139` (env-var reset list) and `:483-602` (per-field assignment)
- Request builders: `Bruno_Collection/library-bruno/requestsBuilder.js` (`buildOfferCollectionRequest`, `buildBookingRequest`, `buildBookingPurchaserBody`, `requestRefundOffersBody`, `requestExchangeOffersBody`, `requestExchangeOperationsBody`)
- OSDM Layer-1 validators: `Bruno_Collection/library-bruno/osdmCompliance.js` (every System-Info + add-offer-part + place-availability validator)
- OSDM Layer-2 deep schema validation: `Bruno_Collection/library-bruno/osdmSchema.js` + `osdmSchemas.js` (2,386 lines of AJV component schemas)
- Domain validators: `offers.js` (1,449 lines), `bookings.js` (777 lines), `refunds.js` (428 lines), `exchanges.js` (323 lines)
- Negative-test machinery: `expiredFlow.js` (400 lines — 6-timer family + auto-expansion), `requestedInformation.js` (857 lines — grammar parser + auto-feed + Problem grader)
- Auth: `auth.js` (193 lines — handler + downstream rejection guard)agentId: a9abe58ee969b0a57 (use SendMessage with to: 'a9abe58ee969b0a57' to continue this agent)
<usage>total_tokens: 313341
tool_uses: 50
duration_ms: 596136</usage>