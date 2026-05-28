# OSDM — Spec Deviations & Vendor Quirks Observed by OSCAR

*Input document for review with OSDM architects. Snapshot: **2026-05-28** (release 2026.116 / server-v1.11.88 / collection OTST_V2.0.38).*

> **What this is.** A catalogue of every place in the OSCAR codebase where the
> code has to **deviate from a strict OSDM-spec reading** in order to
> interoperate with one or more sandbox providers — either because a vendor
> sends a non-spec field, expects a non-spec field, returns the spec field in
> a non-spec location, or simply rejects a spec-legal payload.
>
> **What this is not.** A bug list against any individual provider. Some of
> these are genuine implementation gaps; others are ambiguities the spec
> arguably leaves open. The goal of the doc is to surface the **list** so
> OSDM architects can decide, item by item, which is a spec clarification
> opportunity, which is a vendor non-conformance to push back on, and which
> belongs to the test runner to keep accommodating.

> **Audience.** OSDM working group / spec architects.

> **How findings were gathered.** Every entry below was produced by grepping
> the OSCAR codebase (`Bruno_Collection/library-bruno/*.js`,
> `02-Common Requests/*.yml`) for: vendor names (`paxone`/`bileto`/`turnit`/
> `chaps`/`sqills`/`benerail`), `[WARNING]` strings that mention deviations,
> comments containing "OSDM"/"non-standard"/"vendor extension"/"deprecated"/
> "spec", and `||`-fallback patterns that read multiple field names. Each
> finding cites a file + line where the adaptation lives so a reviewer can
> open the actual code in seconds.

> **Honesty caveats.**
> - Where a vendor is **named**, the code/comment names them explicitly.
> - Where the vendor is **"unspecified"**, the adaptation exists but the
>   contributing comment doesn't say which sandbox triggered it; we treat
>   it as a general defensive pattern rather than attributing blame.
> - Sqills, Chaps, Benerail had limited code-path coverage in this
>   snapshot — *absence* of an OSCAR-side branch is not evidence that the
>   provider conforms; it may simply mean nobody tested OSCAR against them
>   for that specific behaviour yet.
> - Some entries are clearly **version transitions** (OSDM pre-3.x vs
>   ≥3.x) rather than vendor-specific quirks — marked accordingly.

---

## Summary table

| # | Theme | Title | Spec position | Where it deviates | Vendor(s) |
|---|---|---|---|---|---|
| 1 | Naming | `afterSalesConditions` (plural) | OSDM plural | Singular `afterSaleCondition` | Bileto |
| 2 | Placement | Booking-level confirmation deadline | `Booking.confirmationTimeLimit` at root | `confirmableUntil` at root **or** only at bookingPart | Bileto, Paxone |
| 3 | Payload channel | FulfillmentDocument inline body | `content` or `downloadLink` | `rawData` (out-of-schema) | (unspecified) |
| 4 | Version transition | `fulfillmentDocumentRefs` (v3.8) | Sibling `fulfillmentDocuments[]` array | Pre-v3.8 nested `fulfillment.fulfillmentDocuments[]` | (pre-3.8 vendors) |
| 5 | Datetime format | TripSearchCriteria start time | `LocalDateTime` | `OffsetDateTime` accepted/required | Bileto |
| 6 | Field acceptance | `tripParameters` on TripSearchCriteria | Defined / accepted | Rejected when present | Paxone |
| 7 | Field acceptance | Return-trip field placement | `returnSearchParameters.inwardReturnDate` | Strict vendor 400s on old `inboundDate` field | Bileto (strict) |
| 8 | Operational | Multi-offer booking | Allowed | Vendor rejects "only one offer at a time" | Bileto |
| 9 | Field acceptance | `requestedFulfillmentOptions` on offer request | Allowed (may be empty) | Rejected when empty | Paxone |
| 10 | Field acceptance | `BookingRequest.externalRef` | Allowed | Rejected | Paxone |
| 11 | Naming | Reservation-group field shape | `reservationGroup` (singular) | `reservationsGroup.reservationsRefs` (plural) | Paxone (plural), Turnit (singular) |
| 12 | Version transition | Person/purchaser contact path | `detail.contact.{email,phone}` (≥3.4) | Flat `detail.email` / `detail.phoneNumber` | Turnit (<3.4); Paxone/Bileto/Sqills (≥3.4) |
| 13 | Out of OSDM scope | OAuth token-response field name | (RFC 6749 = `access_token`) | `accessToken` / `token` | (unspecified) |
| 14 | Naming | Coach identifier | `Coach.number` | `coachNumber` | (unspecified) |
| 15 | Naming | BookedOffer identifier | `BookedOffer.offerId` | Legacy `.id` | (unspecified) |
| 16 | Shape | Offer-time seat-map availability | Defined response shape | Four shapes observed across vendors | (general) |
| 17 | Strictness | `SelectedPlace` payload | `{coachNumber, placeNumber, passengerRef}` strings, singular | Vendors 400 if `passengerRefs` plural or numeric coach/place | (general strict implementations) |
| 18 | Strictness | `objectType` on OfferCollectionRequest | Not a defined field | Strict implementations 400 on its presence | (strict implementations) |
| 19 | Version transition | Add-offer-part endpoint shape | `POST .../offer-parts` → `BookedOfferPartResponse` (≥3.7) | Pre-3.7 `.../reservations` → `BookedOfferReservationResponse` | (version-dependent) |
| 20 | Field presence | `Offer.ancillaryOfferParts` at offer time | Allowed | Most vendors don't expose it; Sqills does | Sqills (exposes) |
| 21 | Vendor-shape reference | Exchange-operations response | Defined | Validator built against a Turnit-observed structure as reference | Turnit (reference) |
| 22 | Shape | `ProductTagsResponse` dual-array | Defined | "Non-standard dual-array shape" relative to typical OSDM envelopes | (unspecified) |
| 23 | Reference identity | `appliedPassengerTypes[].passengerRef` | Reference to a passenger | Offer carries `externalRef`; booking carries internal UUID | (general — all sandboxes) |
| 24 | Operational | Seat-map URL needs `reservationId` | URL keyed on a reservation part | Strict vendor 400s when unresolved | Bileto |

24 distinct adaptations across 6 sandboxes (Bileto, Paxone, Turnit, Sqills + "general" / "unspecified" defensive patterns). **Bileto** and **Paxone** account for the bulk of explicit vendor-named branches. Chaps and Benerail have no library-bruno-level branches in this snapshot.

---

## Findings — full detail

### Theme A. Field-name divergences

#### 1. `afterSalesConditions` (plural) vs `afterSaleCondition` (singular)
- **OSDM spec position.** Plural `afterSalesConditions` on offer parts and booked parts.
- **Observed deviation.** Bileto returns the field without the trailing `s`: `afterSaleConditions`.
- **OSCAR adaptation.** Reads either field name with `||` fallback on both the offer side and the booking side, then validates intersection between the two.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:91-94`
  ```js
  // Some sandboxes (e.g. Bileto) use 'afterSaleConditions' (no trailing 's') → normalise both
  const offerConditions   = part.afterSalesConditions      || part.afterSaleConditions      || [];
  const bookedConditions  = bookedPart.afterSalesConditions || bookedPart.afterSaleConditions || [];
  ```
- **Suggested OSDM review.** Confirm canonical singular/plural and add a SHOULD reject clause for the wrong form, or accept both formally.

#### 11. `reservationGroup` vs `reservationsGroup`
- **OSDM spec position.** Singular `reservationGroup` / `reservationRefs`.
- **Observed deviation.** Paxone uses **plural** `reservationsGroup.reservationsRefs`; Turnit uses the spec-singular form.
- **OSCAR adaptation.** Validator reads either shape.
- **Code:** `Bruno_Collection/library-bruno/offers.js:869-872`
  ```js
  // Validate linkage to reservationOfferParts (handles both Paxone:
  // reservationsGroup.reservationsRefs and Turnit: reservationGroup.reservationRefs)
  ```
- **Suggested OSDM review.** Confirm the canonical name; possibly publish a spec-test that two providers disagree on.

#### 14. `Coach.number` vs `Coach.coachNumber`
- **OSDM spec position.** `Coach.number` is the required field.
- **Observed deviation.** Some vendors emit `coachNumber`. Reading the wrong one led to a missing `SelectedPlace.coachNumber` → 400 (OSCAR issue #188).
- **OSCAR adaptation.** Read `coach.number` first, fall back to `coach.coachNumber`.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:312-317`
- **Suggested OSDM review.** Reaffirm `Coach.number` and consider a SHOULD-NOT clause on `coachNumber`.

#### 15. `BookedOffer.offerId` vs `.id`
- **OSDM spec position.** `BookedOffer.required = [offerId]`; there is **no** `id` field on `BookedOffer`. The booking mints a new id.
- **Observed deviation.** Legacy vendor `.id` field observed; OSCAR issue #147 covered the resolution.
- **OSCAR adaptation.** Prefer `offerId`; fall back to `.id` for any vendor still serving it.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:484-492`

---

### Theme B. Field-placement divergences

#### 2. Booking-level confirmation deadline — `confirmationTimeLimit` vs `confirmableUntil`
- **OSDM spec position.** `Booking.confirmationTimeLimit` is the canonical field at the **booking root**. `confirmableUntil` is defined only at the **bookingPart** level (PREBOOKED), with an explicit note saying *"confirmationTimeLimit in booking should be used"*.
- **Observed deviations.**
  - **Bileto** exposes the deadline as `confirmableUntil` at the **booking root** (vendor extension at booking level).
  - **Paxone** exposes `confirmableUntil` **only at the bookingPart level**, never at the root. (This matches the spec's own placement for that field name; but the spec also expects `confirmationTimeLimit` at the root, which Paxone does not set.)
- **OSCAR adaptation.** Three-stage fallback resolver (`booking.confirmationTimeLimit` → `booking.confirmableUntil` → earliest `bookedOffers[].{admissions|reservations|ancillaries}[].confirmableUntil`). Each non-standard source emits a `[WARNING]` documenting which shape the provider used.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:330-396`
- **Suggested OSDM review.** Two clarifications would help:
  1. Either rename `confirmableUntil` everywhere (including bookingPart) to remove the confusion with `confirmationTimeLimit`, **or** make `confirmationTimeLimit` formally derivable from `min(parts.confirmableUntil)` and document that derivation.
  2. Add a conformance test that asserts the root-level `confirmationTimeLimit` exists when there is at least one PREBOOKED part.

#### 12. Person/purchaser contact path — flat vs nested
- **OSDM spec position.** From OSDM ≥3.4, contact details are nested as `detail.contact.{email, phoneNumber}` (`ContactDetail`).
- **Observed deviation.** Older shape uses flat `detail.email` / `detail.phoneNumber`.
- **Providers.** Turnit (older flat shape, OSDM <3.4); Paxone, Bileto, Sqills (nested ≥3.4).
- **OSCAR adaptation.** Read `contact.{…}` first, fall back to the flat fields. Applied identically in passenger, purchaser, and fulfillment validators.
- **Code:** `Bruno_Collection/library-bruno/fulfillments.js:67-70`, `passengers.js:22-30`, `requestedInformation.js:284-291`
- **Note.** This is a clean version-transition rather than a vendor quirk; flagged here because OSCAR has to maintain the fallback until Turnit upgrades.

#### 4. v3.8 `fulfillmentDocumentRefs` vs deprecated nested `fulfillmentDocuments[]`
- **OSDM spec position (v3.8).** `Fulfillment.fulfillmentDocumentRefs[]` references sibling `FulfillmentResponse.fulfillmentDocuments[]` / `Booking.fulfillmentDocuments[]`. The nested `fulfillment.fulfillmentDocuments[]` form is deprecated.
- **Observed deviation.** Pre-v3.8 providers still emit the nested form.
- **OSCAR adaptation.** Detects both shapes. The new ref-to-id integrity check runs only when the sibling array is supplied; the legacy nested form is accepted silently.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:729-766`

---

### Theme C. Payload-channel divergences

#### 3. FulfillmentDocument inline payload — `content` vs `rawData`
- **OSDM spec position.** A FulfillmentDocument carries the inline payload via **`content`** (base64) or **`downloadLink`** (URI) — both are spec-defined. There is **no `rawData`** field.
- **Observed deviation.** Some providers deliver the document only via `rawData`, an out-of-schema vendor extension.
- **OSCAR adaptation.** Accept `rawData` as a payload channel (so the test does not fail a retrievable document), but tag it `VENDOR EXTENSION (not in the OSDM FulfillmentDocument schema)` in the report and emit a `[WARNING]`.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:688-723`
- **Suggested OSDM review.** Two options: (a) deprecate the practice via a clear SHOULD-NOT clause and a SonarQube-style detection rule, (b) formalize `rawData` if there is a use case the existing two channels don't cover.

---

### Theme D. Spec-legal payload rejected by a vendor

#### 6. `tripParameters` on `TripSearchCriteria` rejected
- **OSDM spec position.** `TripSearchCriteria.tripParameters` is a defined field (carrier / vehicle filters).
- **Observed deviation.** Paxone rejects requests carrying `tripParameters`.
- **OSCAR adaptation.** When the sandbox URL contains `paxone`, build `TripSearchCriteria` with `null` instead of `tripParameters`.
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:832-848`
  ```js
  if (sandbox.includes("paxone")) {
    tripSearchCriteria = new TripSearchCriteria(_startDateTime, …, null);
  }
  ```

#### 9. Empty `requestedFulfillmentOptions` rejected
- **OSDM spec position.** `requestedFulfillmentOptions` is a defined field on `OfferCollectionRequest`; an empty array should be neutral.
- **Observed deviation.** Paxone rejects/dislikes an empty array.
- **OSCAR adaptation.** Omit the field entirely when the parsed list is empty AND the sandbox is Paxone.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:64-76, 84-111`

#### 10. `BookingRequest.externalRef` rejected
- **OSDM spec position.** `BookingRequest.externalRef` is allowed.
- **Observed deviation.** Paxone rejects an `externalRef` on the booking.
- **OSCAR adaptation.** Set `body.externalRef = "00001"` only when the sandbox is **not** Paxone.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:176-179`

#### 8. Multi-offer booking rejected
- **OSDM spec position.** A booking may contain multiple offers in `offers[]`.
- **Observed deviation.** Bileto rejects multi-offer bookings (`"Only one offer can be booked at a time"`).
- **OSCAR adaptation.** Two-step return strategy — attempt combined first; on rejection, re-run as separate outbound and inward bookings (`__returnBookMode = sep-out`, then `sep-in`).
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:130-159`
- **Suggested OSDM review.** Clarify whether providers may refuse multi-offer at booking time and, if so, what error code/shape they should return so the client can drive the fallback deterministically.

---

### Theme E. Vendor-strict implementations refuse non-spec fields

#### 18. `objectType` on `OfferCollectionRequest`
- **OSDM spec position.** `OfferCollectionRequest` is `additionalProperties: false`. `objectType` is **not** a property of this object.
- **Observed deviation.** Historical/legacy code sent it; strict implementations 400 on `VALIDATION_ERROR`.
- **OSCAR adaptation.** Comment + omission in the body builder.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:93-94`

#### 17. `SelectedPlace` strict shape
- **OSDM spec position.** `SelectedPlace` is `additionalProperties: false`; requires exactly `{coachNumber, placeNumber, passengerRef}` — all **strings**, `passengerRef` **singular**.
- **Observed deviation.** Earlier OSCAR code shipped `passengerRefs` plural or numeric coach/place values → vendor 400.
- **OSCAR adaptation.** Hard-coded emission of the OSDM-strict shape.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:339-344`

#### 7. Return trip — old `inboundDate` field 400s
- **OSDM spec position.** Return trip uses `returnSearchParameters.inwardReturnDate` inside `TripSearchCriteria` / `TripSpecification`. `inboundDate` inside `offerSearchCriteria` is **not** in the spec.
- **Observed deviation.** Bileto 400s on the old `inboundDate` shape.
- **OSCAR adaptation.** Use `inwardReturnDate`; mirror the trailing offset (`+00:00` for Bileto, none otherwise).
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:921-928`

---

### Theme F. Datetime formats

#### 5. TripSearchCriteria datetime — LocalDateTime vs OffsetDateTime
- **OSDM spec position.** `TripSearchCriteria` start time is `LocalDateTime` (no offset, no trailing Z) — distinct from `TripSpecification` which uses `OffsetDateTime`.
- **Observed deviation.** Bileto requires `OffsetDateTime` in `TripSearchCriteria`.
- **OSCAR adaptation.** Detects `bileto` in `api_base` and switches the start time to `toOffsetDateTime()`. Other vendors get the `LocalDateTime` form.
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:812-830`
- **Suggested OSDM review.** The spec is clear here; the deviation looks like a vendor implementation gap rather than an ambiguity. Worth raising with Bileto.

---

### Theme G. Vendor-uneven feature exposure

#### 20. `Offer.ancillaryOfferParts` at offer time
- **OSDM spec position.** `Offer.ancillaryOfferParts` is a defined optional collection.
- **Observed deviation.** Most vendors don't expose ancillaries at offer time; **Sqills** does.
- **OSCAR adaptation.** Validator is a clean no-op when absent; lights up only when present.
- **Code:** `Bruno_Collection/library-bruno/osdmCompliance.js:553-560`
- **Suggested OSDM review.** Recommend the spec gain a "Service Capabilities" mechanism so a client can know up-front whether to ask for / expect ancillaries at offer time vs only after booking.

#### 16. Offer-time seat-map availability — four observed shapes
- **OSDM spec position.** Seat-map response shape is defined.
- **Observed deviation.** As of this snapshot **no sandbox** has served an OFFER-context seat map (OSCAR issue #182). Across BOOKING-context maps, four different shapes were observed: places at coach root, in `compartments[].places`, in `decks[].places`, or `compartment === place`. Availability is sometimes a boolean (`available`/`bookable`) and sometimes a string enum (`AVAILABLE`/`FREE`/`BOOKABLE`/`OPEN`).
- **OSCAR adaptation.** `collectAvailablePlaces` walks all four shapes; treats both boolean and string forms; assumes available when no availability field is present (so minimal vendors are not excluded by accident).
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:261-307`
- **Suggested OSDM review.** This is the single most-divergent shape in the spec right now. A canonical example response (showing exactly where places live and exactly how availability is expressed) would close all four observed variants in one document.

#### 24. Bileto seat-map needs `reservationId` derived from a reservation offer-part
- **OSDM spec position.** Place-map URL is keyed on a reservation offer-part.
- **Observed deviation.** Bileto 400s when `SEATMAP_AT_OFFER` / `ADD_TO_BOOKING` is requested but `reservationId` / `tripLegCoverage` haven't been set on the non-COUCHETTE/BERTH branch.
- **OSCAR adaptation.** Derive `reservationId` from the first reservationOfferPart when place selection is enabled.
- **Code:** `Bruno_Collection/library-bruno/offers.js:1278-1299`

---

### Theme H. Reference identity quirks

#### 23. `appliedPassengerTypes[].passengerRef` — offer carries externalRef, booking carries internal UUID
- **OSDM spec position.** `passengerRef` references a passenger.
- **Observed.** The OFFER response carries the client-supplied `externalRef` (e.g. `"00001"`); the BOOKING response carries the provider's internal UUID. This is consistent across **all** observed sandboxes.
- **OSCAR adaptation.** Match offer↔booking passenger types by `type` rather than by `passengerRef`, to avoid false negatives.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:158-162`
- **Suggested OSDM review.** Clarify whether `passengerRef` should be stable end-to-end, or whether the booking response is expected to *substitute* its internal id. If the latter, document it.

---

### Theme I. Out of OSDM scope (informational)

#### 13. OAuth token field name
- **Outside OSDM** — RFC 6749 expects `access_token` (snake_case).
- **Observed.** Some vendor token endpoints return `accessToken` (camelCase) or `token`.
- **OSCAR adaptation.** Probes `['access_token', 'accessToken', 'token']` in that order.
- **Code:** `Bruno_Collection/library-bruno/auth.js:37-45`
- **Note.** Listed for completeness; not an OSDM-spec issue.

#### 21. Exchange-operations response fixture
- **OSDM spec position.** Exchange operations response is defined.
- **Observed.** The OSCAR validator references a Turnit-derived structure (`11_turnit_exchange.json`) as the reference for testing.
- **Note.** This is a validator-construction artifact, not necessarily a vendor deviation — flagged in case the OSDM working group has a canonical fixture they would prefer used.
- **Code:** `Bruno_Collection/library-bruno/exchanges.js:45`

---

## Per-vendor concentration

| Vendor | Adaptations explicitly attributing this vendor |
|---|---|
| **Bileto** | #1 (singular field), #2 (root-level `confirmableUntil`), #5 (OffsetDateTime in TripSearchCriteria), #7 (strict on `inboundDate`), #8 (rejects multi-offer booking), #24 (seat-map `reservationId`) |
| **Paxone** | #2 (deadline only at part level), #6 (rejects `tripParameters`), #9 (rejects empty `requestedFulfillmentOptions`), #10 (rejects `BookingRequest.externalRef`), #11 (plural `reservationsGroup.reservationsRefs`) |
| **Turnit** | #11 (singular `reservationGroup.reservationRefs`), #12 (flat `detail.email`/`phoneNumber`, OSDM <3.4), #21 (exchange-operations fixture reference) |
| **Sqills** | #12 (nested `detail.contact.*`, OSDM ≥3.4), #20 (exposes `ancillaryOfferParts` at offer time) |
| **Chaps, Benerail** | No library-bruno-level branches in this snapshot. Their env files are referenced but no vendor-specific code path was found. |
| **General / unspecified** | #3, #4, #13–#19, #22, #23 |

---

## Suggested clarifications for OSDM architects

In rough priority order — the items where a spec clarification would remove the **most** vendor variance:

1. **Booking confirmation deadline placement (#2).** Either rename `confirmableUntil` to remove the conflict with `confirmationTimeLimit`, or formalize the derivation `confirmationTimeLimit ≡ min(parts.confirmableUntil)` and require root-level presence.
2. **Seat-map shape (#16).** A canonical worked example (single response showing where places live and how availability is expressed) would resolve four observed shapes in one document.
3. **Fulfillment-document `rawData` (#3).** Either explicitly deprecate the use of `rawData` (SHOULD-NOT clause) or formalize it.
4. **Singular/plural naming consistency (#1, #11, #14).** A spec-test or schema-lint that catches `afterSaleConditions` ≠ `afterSalesConditions`, `coachNumber` ≠ `Coach.number`, `reservationsGroup` ≠ `reservationGroup` would force the issue at validation time.
5. **Vendor-rejection contracts (#6, #9, #10, #18).** Today some vendors reject spec-legal fields (`tripParameters`, empty `requestedFulfillmentOptions`, `BookingRequest.externalRef`). Are these implementation gaps to push back on, or should the spec allow vendor opt-out? A "Vendor MAY refuse extension fields it does not implement, but MUST NOT 400 on a defined optional field with an empty value" clause would unblock several of these.
6. **`passengerRef` stability across offer/booking (#23).** Document whether the booking response is expected to carry the original `externalRef` or substitute its internal id.
7. **Multi-offer booking acceptance (#8).** Confirm whether a provider may refuse a multi-offer booking and, if so, the canonical error code so a client can drive a deterministic fallback.

## Caveats

- This snapshot lists **adaptations OSCAR has shipped**. It does **not** prove that any one vendor is currently still in this state — some adaptations may already be unnecessary because the vendor has since fixed their side; OSCAR keeps the fallback for safety. A re-test against current sandboxes would refine the list.
- The vendor attributions come from the in-code comments. Where the comment says "e.g. Bileto" or "(spec-strict vendors)", the deviation may be observed in more providers than the one named.
- Sqills, Chaps, Benerail had limited explicit code coverage in this snapshot. Absence of an OSCAR branch is **not** evidence of conformance.

## How to refresh this document

Re-run the survey grep:

```bash
# Vendor-named branches
grep -rin --include="*.js" --include="*.yml" -E '\b(paxone|bileto|turnit|chaps|sqills|benerail)\b' Bruno_Collection/library-bruno/ "Bruno_Collection/02-Common Requests/"

# Deviation-noting WARNINGs
grep -rin --include="*.js" -E '\[WARNING\].*(vendor|non-standard|deprecated|OSDM)' Bruno_Collection/library-bruno/

# `||`-fallback patterns (field-name alternatives)
grep -rPin --include="*.js" -E '\.\w+\s*\|\|\s*\w+\.\w+' Bruno_Collection/library-bruno/
```
