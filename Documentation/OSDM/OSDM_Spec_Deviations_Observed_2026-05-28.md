# OSDM — Spec Deviations & Provider Quirks Observed by OSCAR

*Input document for review with OSDM architects. Snapshot: **2026-05-28** (release 2026.116 / server-v1.11.88 / collection OTST_V2.0.38).*

> **What this is.** A catalogue of every place in the OSCAR codebase where the
> code has to **deviate from a strict OSDM-spec reading** in order to
> interoperate with one or more sandbox providers — either because a provider
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

> **Anonymisation.** Provider identities are anonymised as **Vendor A**,
> **Vendor B**, **Vendor C**, **Vendor D** to keep this review focused on the
> **spec ambiguities and clarifications needed**, not on attributing
> non-conformance to any one party. The intent is a constructive technical
> discussion, not finger-pointing. Mapping is held privately by the document
> author; please raise specific clarifications, not specific providers, in
> the discussion.

> **How findings were gathered.** Every entry below was produced by grepping
> the OSCAR codebase (`Bruno_Collection/library-bruno/*.js`,
> `02-Common Requests/*.yml`) for: provider tokens, `[WARNING]` strings that
> mention deviations, comments containing "OSDM"/"non-standard"/"vendor
> extension"/"deprecated"/"spec", and `||`-fallback patterns that read
> multiple field names. Each finding cites a **file + line** where the
> adaptation lives so a reviewer can open the actual code in seconds.

> **Honesty caveats.**
> - Vendor-letter attribution reflects the in-code comments at the cited
>   file:line. Where the original comment hedged ("e.g. Vendor A", "spec-
>   strict vendors"), the same hedge applies.
> - Where the contributing comment doesn't name any provider, the finding is
>   labelled **"unspecified"** — a defensive pattern rather than a specific
>   adaptation. This is honest about uncertainty.
> - Vendors **C** and **D** had limited code-path coverage in this snapshot —
>   *absence* of an OSCAR-side branch is not evidence that the provider
>   conforms; it may simply mean nobody tested OSCAR against them for that
>   specific behaviour yet. Two additional providers run on OSCAR but had no
>   library-bruno-level branches in this snapshot at all — they are not
>   represented below.
> - Some entries are clearly **version transitions** (OSDM pre-3.x vs
>   ≥3.x) rather than provider-specific quirks — marked accordingly.
> - The cited code may itself name a provider in its inline comments (e.g.
>   in a `sandbox.includes("…")` branch). The doc text is anonymised; the
>   underlying code is not. Please focus on the deviation, not the source.

---

## Summary table

| # | Theme | Title | Spec position | Where it deviates | Provider(s) |
|---|---|---|---|---|---|
| 1 | Naming | `afterSalesConditions` (plural) | OSDM plural | Singular `afterSaleCondition` | Vendor A |
| 2 | Placement | Booking-level confirmation deadline | `Booking.confirmationTimeLimit` at root | `confirmableUntil` at root **or** only at bookingPart | Vendor A, Vendor B |
| 3 | Payload channel | FulfillmentDocument inline body | `content` or `downloadLink` | `rawData` (out-of-schema) | (unspecified) |
| 4 | Version transition | `fulfillmentDocumentRefs` (v3.8) | Sibling `fulfillmentDocuments[]` array | Pre-v3.8 nested `fulfillment.fulfillmentDocuments[]` | (pre-3.8 providers) |
| 5 | Datetime format | TripSearchCriteria start time | `LocalDateTime` | `OffsetDateTime` accepted/required | Vendor A |
| 6 | Field acceptance | `tripParameters` on TripSearchCriteria | Defined / accepted | Rejected when present | Vendor B |
| 7 | Field acceptance | Return-trip field placement | `returnSearchParameters.inwardReturnDate` | Strict provider 400s on old `inboundDate` field | Vendor A (strict) |
| 8 | Operational | Multi-offer booking | Allowed | Provider rejects "only one offer at a time" | Vendor A |
| 9 | Field acceptance | `requestedFulfillmentOptions` on offer request | Allowed (may be empty) | Rejected when empty | Vendor B |
| 10 | Field acceptance | `BookingRequest.externalRef` | Allowed | Rejected | Vendor B |
| 11 | Naming | Reservation-group field shape | `reservationGroup` (singular) | `reservationsGroup.reservationsRefs` (plural) | Vendor B (plural), Vendor C (singular) |
| 12 | Version transition | Person/purchaser contact path | `detail.contact.{email,phone}` (≥3.4) | Flat `detail.email` / `detail.phoneNumber` | Vendor C (<3.4); Vendor A/B/D (≥3.4) |
| 13 | Out of OSDM scope | OAuth token-response field name | (RFC 6749 = `access_token`) | `accessToken` / `token` | (unspecified) |
| 14 | Naming | Coach identifier | `Coach.number` | `coachNumber` | (unspecified) |
| 15 | Naming | BookedOffer identifier | `BookedOffer.offerId` | Legacy `.id` | (unspecified) |
| 16 | Shape | Offer-time seat-map availability | Defined response shape | Four shapes observed across providers | (general) |
| 17 | Strictness | `SelectedPlace` payload | `{coachNumber, placeNumber, passengerRef}` strings, singular | Providers 400 if `passengerRefs` plural or numeric coach/place | (general strict implementations) |
| 18 | Strictness | `objectType` on OfferCollectionRequest | Not a defined field | Strict implementations 400 on its presence | (strict implementations) |
| 19 | Version transition | Add-offer-part endpoint shape | `POST .../offer-parts` → `BookedOfferPartResponse` (≥3.7) | Pre-3.7 `.../reservations` → `BookedOfferReservationResponse` | (version-dependent) |
| 20 | Field presence | `Offer.ancillaryOfferParts` at offer time | Allowed | Most providers don't expose it; Vendor D does | Vendor D (exposes) |
| 21 | Provider-shape reference | Exchange-operations response | Defined | Validator built against a Vendor C–observed structure as reference | Vendor C (reference) |
| 22 | Shape | `ProductTagsResponse` dual-array | Defined | "Non-standard dual-array shape" relative to typical OSDM envelopes | (unspecified) |
| 23 | Reference identity | `appliedPassengerTypes[].passengerRef` | Reference to a passenger | Offer carries `externalRef`; booking carries internal UUID | (general — all providers) |
| 24 | Operational | Seat-map URL needs `reservationId` | URL keyed on a reservation part | Strict provider 400s when unresolved | Vendor A |
| 25 | Spec-internal naming | Offer-expiry field across offer types | One canonical name (`validUntil`) for "this offer expires at T" | `OfferPart.validUntil` + `RefundOffer.validUntil` **vs** `ExchangeOffer.preBookableUntil` — same semantic, different name across resource types | (spec-side, not provider-specific) |

**25 distinct adaptations across 4 providers explicitly named** (A–D), plus a body of "general" / "unspecified" defensive patterns. **Vendor A** and **Vendor B** account for the bulk of provider-named branches. Two further providers run on OSCAR but had no library-bruno-level branches in this snapshot.

---

## Findings — full detail

### Theme A. Field-name divergences

#### 1. `afterSalesConditions` (plural) vs `afterSaleCondition` (singular)
- **OSDM spec position.** Plural `afterSalesConditions` on offer parts and booked parts.
- **Observed deviation.** Vendor A returns the field without the trailing `s`: `afterSaleConditions`.
- **OSCAR adaptation.** Reads either field name with `||` fallback on both the offer side and the booking side, then validates intersection between the two.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:91-94`
  ```js
  // Some sandboxes use 'afterSaleConditions' (no trailing 's') → normalise both
  const offerConditions   = part.afterSalesConditions      || part.afterSaleConditions      || [];
  const bookedConditions  = bookedPart.afterSalesConditions || bookedPart.afterSaleConditions || [];
  ```
- **Suggested OSDM review.** Confirm canonical singular/plural and add a SHOULD reject clause for the wrong form, or accept both formally.

#### 11. `reservationGroup` vs `reservationsGroup`
- **OSDM spec position.** Singular `reservationGroup` / `reservationRefs`.
- **Observed deviation.** Vendor B uses **plural** `reservationsGroup.reservationsRefs`; Vendor C uses the spec-singular form.
- **OSCAR adaptation.** Validator reads either shape.
- **Code:** `Bruno_Collection/library-bruno/offers.js:869-872`
  ```js
  // Validate linkage to reservationOfferParts (handles both plural and singular variants)
  ```
- **Suggested OSDM review.** Confirm the canonical name; the fact two providers disagree on the literal is itself a signal.

#### 14. `Coach.number` vs `Coach.coachNumber`
- **OSDM spec position.** `Coach.number` is the required field.
- **Observed deviation.** Some providers emit `coachNumber`. Reading the wrong one led to a missing `SelectedPlace.coachNumber` → 400 (OSCAR issue #188).
- **OSCAR adaptation.** Read `coach.number` first, fall back to `coach.coachNumber`.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:312-317`
- **Suggested OSDM review.** Reaffirm `Coach.number` and consider a SHOULD-NOT clause on `coachNumber`.

#### 15. `BookedOffer.offerId` vs `.id`
- **OSDM spec position.** `BookedOffer.required = [offerId]`; there is **no** `id` field on `BookedOffer`. The booking mints a new id.
- **Observed deviation.** Legacy provider `.id` field observed; OSCAR issue #147 covered the resolution.
- **OSCAR adaptation.** Prefer `offerId`; fall back to `.id` for any provider still serving it.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:484-492`

---

### Theme B. Field-placement divergences

#### 2. Booking-level confirmation deadline — `confirmationTimeLimit` vs `confirmableUntil`
- **OSDM spec position.** `Booking.confirmationTimeLimit` is the canonical field at the **booking root**. `confirmableUntil` is defined only at the **bookingPart** level (PREBOOKED), with an explicit note saying *"confirmationTimeLimit in booking should be used"*.
- **Observed deviations.**
  - **Vendor A** exposes the deadline as `confirmableUntil` at the **booking root** (vendor extension at booking level).
  - **Vendor B** exposes `confirmableUntil` **only at the bookingPart level**, never at the root. (This matches the spec's own placement for that field name; but the spec also expects `confirmationTimeLimit` at the root, which Vendor B does not set.)
- **OSCAR adaptation.** Three-stage fallback resolver (`booking.confirmationTimeLimit` → `booking.confirmableUntil` → earliest `bookedOffers[].{admissions|reservations|ancillaries}[].confirmableUntil`). Each non-standard source emits a `[WARNING]` documenting which shape the provider used.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:330-396`
- **Suggested OSDM review.** Two clarifications would help:
  1. Either rename `confirmableUntil` everywhere (including bookingPart) to remove the confusion with `confirmationTimeLimit`, **or** make `confirmationTimeLimit` formally derivable from `min(parts.confirmableUntil)` and document that derivation.
  2. Add a conformance test that asserts the root-level `confirmationTimeLimit` exists when there is at least one PREBOOKED part.

#### 12. Person/purchaser contact path — flat vs nested
- **OSDM spec position.** From OSDM ≥3.4, contact details are nested as `detail.contact.{email, phoneNumber}` (`ContactDetail`).
- **Observed deviation.** Older shape uses flat `detail.email` / `detail.phoneNumber`.
- **Providers.** Vendor C (older flat shape, OSDM <3.4); Vendors A, B, D (nested ≥3.4).
- **OSCAR adaptation.** Read `contact.{…}` first, fall back to the flat fields. Applied identically in passenger, purchaser, and fulfillment validators.
- **Code:** `Bruno_Collection/library-bruno/fulfillments.js:67-70`, `passengers.js:22-30`, `requestedInformation.js:284-291`
- **Note.** This is a clean version-transition rather than a provider quirk; flagged here because OSCAR has to maintain the fallback until Vendor C upgrades.

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

### Theme D. Spec-legal payload rejected by a provider

#### 6. `tripParameters` on `TripSearchCriteria` rejected
- **OSDM spec position.** `TripSearchCriteria.tripParameters` is a defined field (carrier / vehicle filters).
- **Observed deviation.** Vendor B rejects requests carrying `tripParameters`.
- **OSCAR adaptation.** When the sandbox URL matches Vendor B, build `TripSearchCriteria` with `null` instead of `tripParameters`.
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:832-848`
  ```js
  if (sandbox.includes("…vendor-B token…")) {
    tripSearchCriteria = new TripSearchCriteria(_startDateTime, …, null);
  }
  ```

#### 9. Empty `requestedFulfillmentOptions` rejected
- **OSDM spec position.** `requestedFulfillmentOptions` is a defined field on `OfferCollectionRequest`; an empty array should be neutral.
- **Observed deviation.** Vendor B rejects/dislikes an empty array.
- **OSCAR adaptation.** Omit the field entirely when the parsed list is empty AND the sandbox matches Vendor B.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:64-76, 84-111`

#### 10. `BookingRequest.externalRef` rejected
- **OSDM spec position.** `BookingRequest.externalRef` is allowed.
- **Observed deviation.** Vendor B rejects an `externalRef` on the booking.
- **OSCAR adaptation.** Set `body.externalRef = "00001"` only when the sandbox is **not** Vendor B.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:176-179`

#### 8. Multi-offer booking rejected
- **OSDM spec position.** A booking may contain multiple offers in `offers[]`.
- **Observed deviation.** Vendor A rejects multi-offer bookings (`"Only one offer can be booked at a time"`).
- **OSCAR adaptation.** Two-step return strategy — attempt combined first; on rejection, re-run as separate outbound and inward bookings (`__returnBookMode = sep-out`, then `sep-in`).
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:130-159`
- **Suggested OSDM review.** Clarify whether providers may refuse multi-offer at booking time and, if so, what error code/shape they should return so the client can drive the fallback deterministically.

---

### Theme E. Provider-strict implementations refuse non-spec fields

#### 18. `objectType` on `OfferCollectionRequest`
- **OSDM spec position.** `OfferCollectionRequest` is `additionalProperties: false`. `objectType` is **not** a property of this object.
- **Observed deviation.** Historical/legacy code sent it; strict implementations 400 on `VALIDATION_ERROR`.
- **OSCAR adaptation.** Comment + omission in the body builder.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:93-94`

#### 17. `SelectedPlace` strict shape
- **OSDM spec position.** `SelectedPlace` is `additionalProperties: false`; requires exactly `{coachNumber, placeNumber, passengerRef}` — all **strings**, `passengerRef` **singular**.
- **Observed deviation.** Earlier OSCAR code shipped `passengerRefs` plural or numeric coach/place values → provider 400.
- **OSCAR adaptation.** Hard-coded emission of the OSDM-strict shape.
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:339-344`

#### 7. Return trip — old `inboundDate` field 400s
- **OSDM spec position.** Return trip uses `returnSearchParameters.inwardReturnDate` inside `TripSearchCriteria` / `TripSpecification`. `inboundDate` inside `offerSearchCriteria` is **not** in the spec.
- **Observed deviation.** Vendor A 400s on the old `inboundDate` shape.
- **OSCAR adaptation.** Use `inwardReturnDate`; mirror the trailing offset (`+00:00` for Vendor A, none otherwise).
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:921-928`

---

### Theme F. Datetime formats

#### 5. TripSearchCriteria datetime — LocalDateTime vs OffsetDateTime
- **OSDM spec position.** `TripSearchCriteria` start time is `LocalDateTime` (no offset, no trailing Z) — distinct from `TripSpecification` which uses `OffsetDateTime`.
- **Observed deviation.** Vendor A requires `OffsetDateTime` in `TripSearchCriteria`.
- **OSCAR adaptation.** Detects Vendor A in the `api_base` and switches the start time to `toOffsetDateTime()`. Other providers get the `LocalDateTime` form.
- **Code:** `Bruno_Collection/library-bruno/scenarioParser.js:812-830`
- **Suggested OSDM review.** The spec is clear here; the deviation looks like a provider implementation gap rather than an ambiguity. Worth raising with the provider directly.

---

### Theme G. Provider-uneven feature exposure

#### 20. `Offer.ancillaryOfferParts` at offer time
- **OSDM spec position.** `Offer.ancillaryOfferParts` is a defined optional collection.
- **Observed deviation.** Most providers don't expose ancillaries at offer time; **Vendor D** does.
- **OSCAR adaptation.** Validator is a clean no-op when absent; lights up only when present.
- **Code:** `Bruno_Collection/library-bruno/osdmCompliance.js:553-560`
- **Suggested OSDM review.** Recommend the spec gain a "Service Capabilities" mechanism so a client can know up-front whether to ask for / expect ancillaries at offer time vs only after booking.

#### 16. Offer-time seat-map availability — four observed shapes
- **OSDM spec position.** Seat-map response shape is defined.
- **Observed deviation.** As of this snapshot **no sandbox** has served an OFFER-context seat map (OSCAR issue #182). Across BOOKING-context maps, four different shapes were observed: places at coach root, in `compartments[].places`, in `decks[].places`, or `compartment === place`. Availability is sometimes a boolean (`available`/`bookable`) and sometimes a string enum (`AVAILABLE`/`FREE`/`BOOKABLE`/`OPEN`).
- **OSCAR adaptation.** `collectAvailablePlaces` walks all four shapes; treats both boolean and string forms; assumes available when no availability field is present (so minimal providers are not excluded by accident).
- **Code:** `Bruno_Collection/library-bruno/requestsBuilder.js:261-307`
- **Suggested OSDM review.** This is the single most-divergent shape in the spec right now. A canonical example response (showing exactly where places live and exactly how availability is expressed) would close all four observed variants in one document.

#### 24. Seat-map needs `reservationId` derived from a reservation offer-part
- **OSDM spec position.** Place-map URL is keyed on a reservation offer-part.
- **Observed deviation.** Vendor A 400s when `SEATMAP_AT_OFFER` / `ADD_TO_BOOKING` is requested but `reservationId` / `tripLegCoverage` haven't been set on the non-COUCHETTE/BERTH branch.
- **OSCAR adaptation.** Derive `reservationId` from the first reservationOfferPart when place selection is enabled.
- **Code:** `Bruno_Collection/library-bruno/offers.js:1278-1299`

---

### Theme H. Reference identity quirks

#### 23. `appliedPassengerTypes[].passengerRef` — offer carries externalRef, booking carries internal UUID
- **OSDM spec position.** `passengerRef` references a passenger.
- **Observed.** The OFFER response carries the client-supplied `externalRef` (e.g. `"00001"`); the BOOKING response carries the provider's internal UUID. This is consistent across **all** observed providers.
- **OSCAR adaptation.** Match offer↔booking passenger types by `type` rather than by `passengerRef`, to avoid false negatives.
- **Code:** `Bruno_Collection/library-bruno/bookings.js:158-162`
- **Suggested OSDM review.** Clarify whether `passengerRef` should be stable end-to-end, or whether the booking response is expected to *substitute* its internal id. If the latter, document it.

---

### Theme J. Spec-internal naming inconsistencies

#### 25. Offer-expiry field across offer types — `validUntil` vs `preBookableUntil`
- **OSDM spec position.** *(Observed in the spec itself, not in any one provider.)*
  - **`OfferPart.validUntil`** — *"DateTime up to which the offer can be confirmed."* Carried per-part on the regular OfferCollection (with `fareAdmissionOfferParts[].validUntil`, `fareReservationOfferParts[].validUntil`, etc.).
  - **`RefundOffer.validUntil`** — *"DateTime up to which the refund offer is valid."* Same semantic, same field name, refund context.
  - **`ExchangeOffer.preBookableUntil`** — *"DateTime up to which the exchange offer can be turned into a booking."* **Same semantic as the two above, different name** — there is no `validUntil` on `ExchangeOffer`.
- **Observed deviation.** This is **internal to the spec, not a provider quirk.** All three types describe "the latest moment this offer can still be turned into a booking", yet two use `validUntil` and one uses `preBookableUntil`. A test that generalises "wait past the offer deadline, then assert the booking is rejected" has to special-case the third name even though the underlying semantic is identical.
- **OSCAR adaptation.** The shared `expiredFlow.js` helper used by the expired-offer / expired-refund-offer / expired-exchange-offer tests reads `validUntil` for offers and refund offers, and **`preBookableUntil`** for exchange offers — the only divergence between three otherwise-identical wait-then-assert flows.
- **Code:** *(at the time of this entry: the helper is introduced in `Bruno_Collection/library-bruno/expiredFlow.js`; the offer-side capture lives in `offers.js` `postOfferResponse`. The exchange-offer wiring is the next phase of this work.)*
- **Suggested OSDM review.** Either rename `ExchangeOffer.preBookableUntil` to `validUntil` for parity with `OfferPart` / `RefundOffer`, **or** state explicitly that the three are different concepts (and clarify what the difference is). The current state forces every client testing offer expiry to keep a per-resource lookup table.

---

### Theme I. Out of OSDM scope (informational)

#### 13. OAuth token field name
- **Outside OSDM** — RFC 6749 expects `access_token` (snake_case).
- **Observed.** Some provider token endpoints return `accessToken` (camelCase) or `token`.
- **OSCAR adaptation.** Probes `['access_token', 'accessToken', 'token']` in that order.
- **Code:** `Bruno_Collection/library-bruno/auth.js:37-45`
- **Note.** Listed for completeness; not an OSDM-spec issue.

#### 21. Exchange-operations response fixture
- **OSDM spec position.** Exchange operations response is defined.
- **Observed.** The OSCAR validator references a Vendor-C–derived structure as the reference for testing.
- **Note.** This is a validator-construction artifact, not necessarily a provider deviation — flagged in case the OSDM working group has a canonical fixture they would prefer used.
- **Code:** `Bruno_Collection/library-bruno/exchanges.js:45`

---

## Per-provider concentration (anonymised)

| Provider | Adaptations explicitly attributing this provider |
|---|---|
| **Vendor A** | #1 (singular field), #2 (root-level `confirmableUntil`), #5 (OffsetDateTime in TripSearchCriteria), #7 (strict on `inboundDate`), #8 (rejects multi-offer booking), #24 (seat-map `reservationId`) — **6 items** |
| **Vendor B** | #2 (deadline only at part level), #6 (rejects `tripParameters`), #9 (rejects empty `requestedFulfillmentOptions`), #10 (rejects `BookingRequest.externalRef`), #11 (plural `reservationsGroup.reservationsRefs`) — **5 items** |
| **Vendor C** | #11 (singular `reservationGroup.reservationRefs`), #12 (flat `detail.email`/`phoneNumber`, OSDM <3.4), #21 (exchange-operations fixture reference) — **3 items** |
| **Vendor D** | #12 (nested `detail.contact.*`, OSDM ≥3.4), #20 (exposes `ancillaryOfferParts` at offer time) — **2 items** |
| **General / unspecified** | #3, #4, #13–#19, #22, #23 |
| **Spec-internal (no provider attribution)** | #25 (offer-expiry field naming across offer types) |

---

## Suggested clarifications for OSDM architects

In rough priority order — the items where a spec clarification would remove the **most** provider variance:

1. **Booking confirmation deadline placement (#2).** Either rename `confirmableUntil` to remove the conflict with `confirmationTimeLimit`, or formalize the derivation `confirmationTimeLimit ≡ min(parts.confirmableUntil)` and require root-level presence.
2. **Seat-map shape (#16).** A canonical worked example (single response showing where places live and how availability is expressed) would resolve four observed shapes in one document.
3. **Fulfillment-document `rawData` (#3).** Either explicitly deprecate the use of `rawData` (SHOULD-NOT clause) or formalize it.
4. **Singular/plural naming consistency (#1, #11, #14).** A spec-test or schema-lint that catches `afterSaleConditions` ≠ `afterSalesConditions`, `coachNumber` ≠ `Coach.number`, `reservationsGroup` ≠ `reservationGroup` would force the issue at validation time.
5. **Provider-rejection contracts (#6, #9, #10, #18).** Today some providers reject spec-legal fields (`tripParameters`, empty `requestedFulfillmentOptions`, `BookingRequest.externalRef`). Are these implementation gaps to push back on, or should the spec allow provider opt-out? A "Provider MAY refuse extension fields it does not implement, but MUST NOT 400 on a defined optional field with an empty value" clause would unblock several of these.
6. **`passengerRef` stability across offer/booking (#23).** Document whether the booking response is expected to carry the original `externalRef` or substitute its internal id.
7. **Multi-offer booking acceptance (#8).** Confirm whether a provider may refuse a multi-offer booking and, if so, the canonical error code so a client can drive a deterministic fallback.
8. **Offer-expiry field naming consistency (#25).** Rename `ExchangeOffer.preBookableUntil` to `validUntil` (for parity with `OfferPart` and `RefundOffer`), or document explicitly why the exchange flow needs a different name and what the semantic delta is.

## Caveats

- This snapshot lists **adaptations OSCAR has shipped**. It does **not** prove that any one provider is currently still in this state — some adaptations may already be unnecessary because the provider has since fixed their side; OSCAR keeps the fallback for safety. A re-test against current sandboxes would refine the list.
- Provider attributions come from in-code comments. Where the comment says "e.g. Vendor X" or "(spec-strict vendors)", the deviation may be observed in more providers than the one named.
- Vendors **C** and **D** had limited explicit code coverage in this snapshot; two further providers had no library-bruno-level branches at all. Absence of an OSCAR branch is **not** evidence of conformance.
- The cited code may itself name a provider in its inline comments. The doc text is anonymised; the underlying code is not. Reviewers are asked to **focus on the deviation, not the source.**

## How to refresh this document

Re-run the survey grep:

```bash
# Provider-named branches
grep -rin --include="*.js" --include="*.yml" -E '\b(<provider tokens>)\b' Bruno_Collection/library-bruno/ "Bruno_Collection/02-Common Requests/"

# Deviation-noting WARNINGs
grep -rin --include="*.js" -E '\[WARNING\].*(vendor|non-standard|deprecated|OSDM)' Bruno_Collection/library-bruno/

# `||`-fallback patterns (field-name alternatives)
grep -rPin --include="*.js" -E '\.\w+\s*\|\|\s*\w+\.\w+' Bruno_Collection/library-bruno/
```
