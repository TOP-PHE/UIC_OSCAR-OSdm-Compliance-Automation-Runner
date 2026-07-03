# Fare-Based Distribution — Shop / Book Design Proposal (#242)

Status: **PROPOSAL — awaiting OTST team review.** Nothing in this document has
been implemented. No code, schema, or scenario changes ship until the team
signs off and Patrick gives an explicit OK.

Issues covered: [#242](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/242)
(umbrella), [#205](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/205),
[#207](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/207),
[#243](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/243)–[#248](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/248).
Deliberately touched only lightly, flagged as follow-on work in §10:
[#206](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/206)
(refund of a booked fare) and [#255](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/255)
(BIKE passenger type on a fare reservation).

SFR reference: [Fare based distribution Shop Book Ticket](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/wiki/Fare-based-distribution-Shop-Book-Ticket)
(fetched verbatim from the wiki source for this document — quoted in §2.5).

---

## 1. Summary

OSCAR today tests only the **Product-based** distribution model: an offer's
admission/reservation/ancillary parts, each carrying a station-to-station
trip and a price, booked and fulfilled as a unit. OSDM defines a second,
parallel model — **Fare-based distribution** — where the priced object is a
`Fare` (not an `Admission`/`Reservation`/`Ancillary`), scoped not to a whole
trip but to a *section* of one, and carrying a materially different set of
required fields: regional validity, combination rules with other fares,
travel-validity constraints (excluded time ranges, trip allocation, return
constraints), and required travel-account cards. The OTST team has asked for
OSCAR to cover this model; it hasn't started (confirmed by direct grep —
zero hits for `Fare`, `regionalConstraint`, `combinationConstraint`,
`travelValidityConstraint`, or `requestedSections` anywhere in
`Bruno_Collection/library-bruno` or the datafile schema/wizard today).

This document proposes the **Shop** (offer search) and **Book** (booking →
fulfillment) portion of that coverage — the "Ticket" half of the SFR's own
"Shop/Book/Ticket" framing is the fulfillment step, which is included here
since it's the natural completion of "Book." What is **not** covered, and
why, is in §10.

The centerpiece of this proposal, per Patrick's explicit request, is **§5
(the assertion list)** and **§6 (how deep validation should go, given that
fare combinability rules can be checked at several depths, some of which
are arguably outside what a single-vendor conformance tool can honestly
verify)**. Everything else here exists to ground those two sections in the
actual spec and the actual codebase, not guesswork.

---

## 2. What OSDM says — Fare vs. the Product model OSCAR already tests

### 2.1 Fare is a parallel offer-part family, not a variant of Product

`OfferPartType` (`openapi3_0.json:15218-15231`) is the enum used everywhere
OSCAR already requests offer parts (`requestedOfferParts`):

```
ADMISSION, RESERVATION, ANCILLARY,
FARE_ADMISSION, FARE_RESERVATION, FARE_ANCILLARY,
CONTINUOUS_SERVICE, ALL
```

The `FARE_*` values are full siblings of the values OSCAR already tests —
same request mechanism, same response envelope (`offerCollectionResponse`
can contain both `admissionOfferParts`-style and fare-style parts in one
response, per the SFR: *"a response can contain both fares and products"*).
What differs is the **shape of the offer part itself**.

### 2.2 The `Fare` object (`openapi3_0.json:13044-13188`)

Required fields: `id`, `type` (`FareType`, x-extensible-enum
`ADMISSION | RESERVATION | ANCILLARY` — yes, this is a *different* enum from
`OfferPartType`, confusingly reusing the same three words for "what kind of
service this fare covers"), `prices[]`, `regionalConstraint`, `travelClass`,
`afterSalesCondition`, `combinationConstraint[]` (min 1),
`travelValidityConstraint`, `requiredCards[]` (min 1).

Optional but structurally significant: `serviceConstraint`,
`carrierConstraint`, `fulfillmentConstraint`, `availablePlaces`,
`placeSelection`, `placeAllocation`, `coveredSection`, `passengerRefs`,
`involvedTCOs[]`, `luggageConstraint`.

Three sub-schemas carry almost all of the *fare-specific* (non-Product)
logic:

| Sub-schema | Spec location | What it declares |
|---|---|---|
| `RegionalConstraint` | `:17766-17795` | `entryConnectionPoint`/`exitConnectionPoint` (both `FareConnectionPoint` — border crossings between two "fare regimes") + `regionalValidities[]` (min 1) |
| `FareCombinationModel` | `:13189-13236` | `model` (required: `SEPARATE_TICKET \| SEPARATE_CONTRACT \| CLUSTERING \| COMBINING`), `combinableCarriers[]`, `isValidOnlyWhenCombined`, `referenceCluster` (CLUSTERING only), `allowedClusters[]` (CLUSTERING only), `allowedCommonContracts[]` |
| `TravelValidity` | `:19721-19764` | `validityRange` (required) + `validTravelDates`, `excludedTimeRanges[]`, `numberOfTravelDays`, `returnConstraint`, `trainValidity`, `tripAllocationConstraint`, `tripInterruptionConstraint` |

Issue #243's screenshot names the cluster enum values a `referenceCluster`
must be one of: **`BUSINESS > FULL-FLEX > SEMI-FLEX > NON-FLEX > PROMO`**
(an ordered flexibility hierarchy — the SFR's language, not a literal OSDM
enum name in the spec text I could find; treat as the OTST team's own
codified list until confirmed against a live sandbox response).

### 2.3 Sectioning a trip: `requestedSections` (net-new to OSCAR)

Fares aren't necessarily priced for the whole journey — a passenger crossing
a border needs a domestic fare on each side plus (depending on the
combination model) something bridging them. The mechanism for asking for a
fare on *part* of a trip is `requestedSections` — a **top-level sibling**
of `tripSearchCriteria`/`tripIds`/`tripSpecifications` on the offer request
body (`openapi3_0.json:15064-15094`):

> *"If you are searching for fares you pass in the complete trip and then
> use the `requestedSections` attribute to define which part(s) you need
> fares (including virtual border points)."*

`Section` (`:18606-18632`) = `{startPlace, startLegId?, endPlace, endLegId?,
externalTripRef?}` — structurally identical to the existing
origin/destination pattern OSCAR already builds trip searches from. **When
`requestedSections` is absent, the totality of the trip is priced** — this
is the mechanism issues #244/#246/#248 test negatively (empty or
trip-covering `requestedSections` on a domestic trip → no bookable fare,
since there's no border to section around).

### 2.4 Three ways to ask, ×2 (positive/negative) — issues #243–248

The SFR splits the *offer request shape* into three independent variants,
each with its own positive + negative issue pair:

| Request shape | Positive | Negative | OSCAR support today |
|---|---|---|---|
| `tripSearchCriteria` (search by origin/destination/time) | #243 | #244 | ✅ primary path, fully built |
| `tripIds` (search by a previously-discovered `Trip.id`, e.g. from `GET /trips`) | #245 | #246 | ❌ **not built at all** — confirmed by grep, `requestsBuilder.js` never emits a `tripIds` body field |
| `tripSpecifications` (explicit origin/destination/product-category triple) | #247 | #248 | ✅ built (`requestsBuilder.js:121`, the "OSDM Trip Search Criteria" wizard panel, #359/#360) |

All three converge on the same downstream flow once offers come back —
`requestedSections` and the Fare response shape don't depend on which
request variant produced the offer.

### 2.5 The SFR's own scenario + suggested validations (verbatim)

The linked wiki page's content, in full — this is short but is the only
UIC-authored fare-specific SFR text found (the wiki has 21 pages; this is
the only one matching "fare"):

> **Scenario:** offer request with a trip specification, indicate
> `FARE_ADMISSION` in `offerSearchCriteria.offerParts`, set
> `isPartOfInternationalTrip` to `true`, add `requestedSections` from a fare
> connection point to a station. Book → fulfill → get booking → refund
> (offer, get, patch) → get booking again.
>
> **Suggested validations:**
> - one or more fares should be provided
> - the fares should cover the requested section
> - the fares should cover the requested passengers (same as in usual offers)
> - a regional validity must be provided in the fare(s)
> - combination constraints with combination model(s) must be provided
> - after-sales conditions must be provided
> - `travelValidityConstraint` must be provided
> - for rail, `involvedTCOs` must be provided
> - fare type must be `ADMISSION`
> - *(fulfillment step)* the fulfillment documents are missing or empty

That last line is worth reading twice: **the SFR itself flags an expected
provider gap** at fulfillment. This maps directly onto OSCAR's existing
Known-Deviation baseline mechanism (#398/#401) rather than a hard assertion
— see §6.4.

---

## 3. What's reusable vs. genuinely new in OSCAR

A deliberate check before proposing new code: how much of this can lean on
what already exists?

**Already there, reusable as-is:**
- `ENUMS.requestedOfferParts` at the **Test Framework** level
  (`scenarios.js:56-57`) already lists `FARE_ADMISSION`/`FARE_RESERVATION`/
  `FARE_ANCILLARY` — a company can already *declare* fare support today.
  Nothing to build here.
- The generic booking-response part-count matcher,
  `validateOfferParts(offerParts, bookedParts, partType, expectedStatus)`
  (`bookings.js:408`), takes `partType` as a plain string label used only
  for report text — it is not Product-specific in its logic (offer-part
  count vs. booked-part count, per-index equality checks). This can very
  plausibly accept `"fare"` as a fourth `partType` alongside admission/
  reservation/ancillary, once the response is parsed into a flat array —
  **the biggest single reuse win** in this whole proposal.
- Refund flow (#206's precondition) — `10-16.` requests, the schedule-aware
  effective-refundability engine (`afterSalesRules.js`, #391), the
  after-sales-conditions pairing (#390), the refund-permissibility
  cross-check (#388) are all Product-agnostic: they operate on
  `afterSalesConditions`/fulfillment IDs, fields the `Fare` object also
  carries via `afterSalesCondition`. Likely near-zero new code for #206
  once Shop/Book lands — a validation pass against a live fare refund
  would confirm this rather than assume it.
- Places API typeahead (`attachPlaceAutocomplete(input)`, #450) attaches to
  any input element — directly reusable for the new `requestedSections`
  start/end place fields (§4.2).
- `requestsBuilder.js:121` already builds `tripSpecifications`;
  `:123`/`:687` already build `tripSearchCriteria`. Two of the three
  request shapes need no new request-building code.

**Confirmed absent — genuinely new build:**
- The **scenario-level** `requestedOfferParts` picker (`WIZ_OFFER_PARTS`,
  `scenarios.js:3093` = `['RESERVATION','ADMISSION','ANCILLARY']`) does
  **not** include the `FARE_*` values, even though the framework-level enum
  does. A company could declare fare support and still have no way to
  select it on an actual scenario — a small, surgical, low-risk unlock.
- `requestedSections` — zero hits anywhere in the schema, wizard, or
  parser. Fully new: schema field, wizard section builder, request-builder
  wiring.
- `isPartOfInternationalTrip` — same, zero hits, fully new (a single
  boolean, trivial to add).
- `tripIds` as a request shape (#245/#246) — zero hits in
  `requestsBuilder.js`. New request-building branch, plus (per the SFR)
  a precursor `GET /trips` step to obtain the id to feed in.
- Any Fare-shaped response validation at all: nothing in `offers.js`
  understands `admissionOfferParts`-style parts vs. fare-style parts today;
  a new `validateFares(selectedOffer)` (offer response) analogous to the
  existing `validateAdmissions()`/`validateReservations()` is needed,
  because the *required-field set* genuinely differs (regional/combination/
  travel-validity constraints have no Product equivalent).
- A `Fare` type/`Section` type-aware `Ajv`/Layer-1 shape check, if OSCAR's
  compliance layer validates response shapes structurally before running
  business assertions (worth confirming against `osdmCompliance.js`, not
  yet checked at proposal stage).

---

## 4. Proposed scenario / datafile model (sketch, not final)

Not implemented — sketched here so the assertion list in §5 has concrete
fields to reference, and so the OTST team can react to the *shape* of the
solution, not just the assertions.

### 4.1 Requesting fares
- Scenario field `requestedOfferParts` gains `FARE_ADMISSION` /
  `FARE_RESERVATION` / `FARE_ANCILLARY` as scenario-level pickable values
  (§3's "surgical unlock").
- New boolean `isPartOfInternationalTrip` (mirrors the SFR's step 1).
- New request-shape field for `tripIds` (a third radio option alongside
  the existing implicit `tripSearchCriteria`/`tripSpecifications` choice),
  gated behind a precursor "discover trip" step when selected.

### 4.2 Requested sections
- New repeatable "Requested section" block: start place / end place (both
  wired to `attachPlaceAutocomplete`, reusing #450), optional
  `startLegId`/`endLegId`, optional `externalTripRef`. Empty list = "price
  the whole trip" (matches the spec's own default semantics, §2.3).
- A "fare connection point" is structurally just a `Place` per
  `FareConnectionPoint`'s `allOf: [Place, ...]` (`:13237-13263`) — no new
  place-picking mechanism needed beyond what already exists for
  origin/destination.

### 4.3 Everything downstream (booking, fulfillment, refund)
No new scenario fields anticipated — a fare-offer's `id` slots into the
exact same `offers[].offerId`/`passengerRefs` booking-request shape
already built (`requestsBuilder.js:145-224`); fulfillment and refund reuse
the existing flow unchanged (§3).

---

## 5. Proposed assertion list

Organised by **where** in the flow the check runs, and inside each step, by
**how confident OSCAR can be** that a failure means the provider is wrong
(vs. an ambiguous or provider-discretionary case that should WARN, not
FAIL — the same philosophy already established for accommodation/offerMode
work, #391/#436). Each row names the concrete field.

### 5.1 Offer response — structural presence (Layer-1, hard FAIL if absent)

These map straight to the `Fare` schema's own `required[]` list
(`openapi3_0.json:13048-13058`) — a provider omitting a *spec-required*
field is unambiguously non-conformant:

| # | Assertion | Field |
|---|---|---|
| 1 | Fare has an `id`, `type`, and at least one price | `id`, `type`, `prices[]` |
| 2 | `regionalConstraint` present, with ≥1 `regionalValidities` entry | `regionalConstraint.regionalValidities[]` |
| 3 | `travelClass` present | `travelClass` |
| 4 | `afterSalesCondition` present | `afterSalesCondition` |
| 5 | `combinationConstraint` present, ≥1 entry, each with a `model` from the 4-value enum | `combinationConstraint[].model` |
| 6 | `travelValidityConstraint` present, with a `validityRange` | `travelValidityConstraint.validityRange` |
| 7 | `requiredCards` present, ≥1 entry, each with a `type` | `requiredCards[].type` — **see §9.1, semantics need confirming** |

### 5.2 Offer response — coverage & consistency (generalising existing Product-flow patterns)

These are **not new concepts** — they're the exact same checks OSCAR
already runs for Product offers (#379 trip coverage, #382 reservation
spec-coverage), re-pointed at the Fare-specific fields:

| # | Assertion | Precedent this generalises |
|---|---|---|
| 8 | Fare's `coveredSection` matches a `requestedSections` entry (or the whole trip, if none was requested) | offer-covers-requested-trip check (#379) |
| 9 | Fare's `passengerRefs` count/identity matches the requested passengers | `offer.passengerRefs` count check already in `offers.js` |
| 10 | `type` (`FareType`) is `ADMISSION` for this scenario family (per the SFR's explicit expectation) — `RESERVATION`/`ANCILLARY` fares are a **different** scenario family, not a failure of this one | soft check, scenario-scoped — see §6 |
| 11 | `referenceCluster` (when the model is `CLUSTERING`) is one of the declared flexibility values | new x-extensible-enum-style soft WARNING (provider-fairness precedent, #391/#436) — not hard-FAIL, since the SFR's ordered list isn't confirmed as a literal spec enum (§2.2) |
| 12 | Negative cases (#244/#246/#248): a domestic trip, or `requestedSections` equal to the full trip, or an empty `requestedSections` on an international trip that needs no sectioning → **zero** fare offer parts returned | direct assertion, no precedent needed — simple absence check |

### 5.3 Booking response — echo & lifecycle (reusing the generic part-matcher, §3)

| # | Assertion | Mechanism |
|---|---|---|
| 13 | Every fare offered gets a corresponding booked fare (count + id/type match) | `validateOfferParts(..., "fare", ...)` — §3's reuse win |
| 14 | Booked fare's price ties out to the offered fare's price | same equality-check idiom as `validatePartPrices()` (`bookings.js:97`) already applies to admission/reservation/ancillary |
| 15 | Booked fare's `travelValidityConstraint`/`regionalConstraint` are structurally echoed (not necessarily byte-identical — providers may re-derive validity ranges at booking time; confirm equality vs. presence-only against a real response before deciding) | new, but same "does the response ever change key structural fields" audit lens as #390's window-aware pairing work |

### 5.4 Fulfillment response

| # | Assertion | Note |
|---|---|---|
| 16 | Fulfillment created for the fare booking part | standard fulfillment existence check, already generic (`validateFulfillments()`, `bookings.js:917`) |
| 17 | Fulfillment **documents** missing/empty | **the SFR itself expects this** — candidate for a Known-Deviation baseline entry (#398/#401) per company, not a universal hard assertion; see §6.4 |

### 5.5 Refund (#206, only lightly scoped here — full design deferred)

Reuse the existing refund engine unchanged; the one Fare-specific thing to
confirm once a live sandbox is available: does `afterSaleFee`/effective
refundability read correctly off a `Fare`'s `afterSalesCondition` link the
same way it reads off an `Admission`'s? If yes (likely, same schema ref),
zero new code. If no, scoped as its own small follow-up, not blocking Shop/Book.

---

## 6. How deep should validation go? (the question Patrick asked directly)

Fare's `combinationConstraint` describes **four** models:
`SEPARATE_TICKET`, `SEPARATE_CONTRACT`, `CLUSTERING`, `COMBINING`. There are
at least four distinct depths at which OSCAR could claim to "test"
combinability, each a real jump in cost and in what OSCAR can honestly
assert:

### Tier A — Declared shape only (proposed baseline, §5.1 row 5)
Confirm `combinationConstraint[]` exists and each entry's `model` is one of
the four known values, and that CLUSTERING entries carry a
`referenceCluster`. **This is checking that the provider said *something*
coherent about combinability — not that the something is correct.**

### Tier B — Self-consistency within one offer response
If a single offer response returns multiple fares in the same `CLUSTERING`
model, check their `referenceCluster`/`allowedClusters` values are mutually
sane (e.g., no fare declares another's cluster as `allowedClusters` while
that other fare's own list excludes the reverse). This is checkable from
**one** provider's one response — no second vendor, no live re-booking
needed. Moderate new logic, genuinely testable.

### Tier C — Live combination behaviour, single vendor
Actually **book two fares together** (e.g., two `SEPARATE_TICKET` fares
crossing a `FareConnectionPoint`) and confirm the provider's booking
response is consistent with what the individual offers declared. This
requires a sandbox whose test data models ≥2 combinable fare families for
the *same* vendor — not guaranteed to exist in any current OSCAR company's
datafile, and not something OSCAR can manufacture (it depends on the
vendor's own fare catalog shape).

### Tier D — Cross-carrier combination enforcement
The genuinely hard case: booking fare A from carrier X with fare B from
carrier Y and confirming the *combined* booking is accepted or rejected per
`combinableCarriers`/`allowedCommonContracts`. This requires **two
providers in one test**, which is a different category of test
(interop/settlement between two UIC members) than what OSCAR — a
per-company conformance runner — is built to exercise. My own prior
analysis of the OSDM/NeTEx boundary (cross-referenced, not re-derived here)
independently identifies exactly this multi-carrier combination layer as
the piece that exists **only** in OSDM's transaction model with no
declarative counterpart to check it against — there is no second, canonical
source of truth to assert the combination *should* have succeeded or
failed. Any "test" at this tier is really testing one specific bilateral
agreement between two named carriers, not a conformance rule.

**My recommendation:** ship Tier A now (it's simply the `Fare` object's own
required fields — no separate design decision needed, it's table stakes).
Propose Tier B as the real "did we test combinability" deliverable for this
first pass — it's honest, self-contained, and doesn't need any special test
data most vendors won't have. Explicitly **defer** Tier C pending a check of
whether any current OSCAR company's fare catalog would even support it (an
empirical question, not a design one — worth someone on the OTST team
checking a live sandbox before we plan for it). Recommend **not** attempting
Tier D inside OSCAR at all — flag it as a UIC-level interop test concern,
separate from per-vendor conformance, and say so explicitly rather than
quietly under-delivering against an implied expectation.

**This is the one section I most want the team's disagreement on** — the
Tier C/D line is a judgment call about what "conformance testing"
reasonably means for something as inherently multi-party as fare
combination, and reasonable people could draw it differently.

---

## 7. Phased delivery (proposed, pending OK)

1. **Phase 1 — Shop.** §3's genuinely-new items: `requestedSections` +
   `isPartOfInternationalTrip` scenario fields, scenario-level
   `FARE_*` unlock, `validateFares()` in `offers.js` (§5.1 + §5.2, Tier A
   depth). Covers #243/#244/#247/#248 (the `tripSearchCriteria` and
   `tripSpecifications` variants — no new request-shape code needed).
2. **Phase 2 — `tripIds` request shape.** The one missing request
   mechanism (§2.4). Covers #245/#246.
3. **Phase 3 — Book + Fulfillment.** §5.3/§5.4, reusing
   `validateOfferParts()` with a new `"fare"` partType. Covers #205/#207
   (Product-vs-Fare negative case) and closes out the core SFR scenario.
4. **Phase 4 — Tier B combinability self-consistency** (§6), if the team
   confirms it's worth a dedicated phase rather than folding into Phase 1.
5. **Phase 5 — Refund** (#206) — thin, mostly a verification pass against
   the existing refund engine per §5.5, not a rebuild.
6. **Not yet phased:** #255 (BIKE passenger type on a fare reservation) —
   orthogonal passenger-type dimension, layers on cleanly once Phase 3
   ships; needs its own short look at whether BIKE already flows through
   the existing passenger-type machinery for Fares the same way it does
   for Product (`osdmEnums.js` already lists `BICYCLE` as a passenger
   type, per #380-era work — likely low-effort once there's a Fare
   booking to hang it on).

---

## 8. Open questions for the OTST team

1. **§6 — where's the Tier C/D line?** Concretely: is there *any* vendor
   sandbox OSCAR currently has access to whose fare catalog would let us
   even attempt a live 2-fare combination booking? If the answer is "no
   vendor has this yet," Tier B is the practical ceiling regardless of
   ambition.
2. **§5.1 row 7 — `requiredCards` semantics.** The schema requires ≥1 entry
   on *every* fare. Does this mean every fare, even a plain point-to-point
   ticket, must declare a travel-account type (settlement/accounting
   metadata), or is this a spec artifact that in practice some
   implementations under-populate? Worth confirming against a real
   response before deciding whether absence is a hard FAIL or a WARNING.
3. **§2.2 — is the `BUSINESS > FULL-FLEX > SEMI-FLEX > NON-FLEX > PROMO`
   ordering a literal spec enum** or codified OTST-team convention from
   observed implementations? Changes whether row 11 is a strict `oneOf` or
   a softer "is this a plausible flexibility label" check.
4. **Scenario model — new `scenarioType`, or a flag on `SALE`?** This
   proposal assumes Fare scenarios are `SALE`-family scenarios that merely
   request `FARE_ADMISSION` instead of `ADMISSION` (§4.1) — no new
   top-level scenario type. Confirm that matches how the team thinks about
   it, since it affects the wizard's information architecture.
5. **Upstream issue #93** (referenced from #243: *"There is an issue to
   take into account if the logic of the product will be re-used for offer
   validation"*) — lives in the original `UnionInternationalCheminsdeFer/
   OSDM-testing` repo, not migrated into this one; I could not resolve its
   content. If it contains a decision already made upstream, it should
   override §3's reuse proposal where they conflict.

---

## 9. Out of scope for this document

- **Ticket-time / consumption validation** (barcode content per IRS
  90918-4/-9/-10, physical fulfillment-document structure) — a fulfillment
  *existing* is in scope (§5.4); its printed/barcoded content is not.
- **#226** (delete exchange → new offer request) — unrelated mechanism,
  not fare-specific.
- **#221** (post-refactor code review) and **#227** (offer-request
  age/gender parameters) — explicitly reserved for Patrick's own review
  per standing instruction; not touched here even tangentially.
- Any actual implementation — this entire document is the proposal to be
  reviewed, not a plan being executed.

---

## 10. References

- Umbrella: [#242](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/242) · Positive/negative pairs: [#243](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/243)/[#244](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/244), [#245](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/245)/[#246](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/246), [#247](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/247)/[#248](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/248) · Product-comparison pair: [#205](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/205)/[#207](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/207) · Follow-ons: [#206](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/206), [#255](https://github.com/TOP-PHE/UIC_OSCAR-OSdm-Compliance-Automation-Runner/issues/255)
- SFR wiki: [Fare based distribution Shop Book Ticket](https://github.com/UnionInternationalCheminsdeFer/OSDM-testing/wiki/Fare-based-distribution-Shop-Book-Ticket)
  (quoted in full, §2.5)
- Spec citations: all `openapi3_0.json` line numbers above refer to
  `Bruno_Collection/json_validator/openapi3_0.json` in this repo, current
  as of `main` at the time of writing (2026-07-03).
- Prior related work this proposal builds on: #371/#373/#379/#382 (Product
  trip/reservation coverage patterns generalised in §5.2), #388/#390/#391/
  #392/#397 (refund/effective-refundability engine reused in §5.5), #398/
  #401 (Known-Deviation baseline, referenced in §5.4/§6.4), #450 (Places
  API typeahead, reused in §4.2).
- Template: this document follows the structure of
  `RequestedInformation_Plan_258.md` and `OPT_Place_Selection_Plan_104.md`
  in this same folder.
